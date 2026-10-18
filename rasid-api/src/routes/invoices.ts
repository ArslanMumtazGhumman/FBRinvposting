/**
 * /api/businesses/:businessId/invoices
 * Posted invoices are immutable (enforced again by database triggers);
 * corrections are new Debit Notes that reference the original IRN.
 */
import { and, desc, eq, gte, ilike, inArray, lte, or, sql, type SQL } from 'drizzle-orm';
import { Router } from 'express';
import { requireAuth, requireBusiness, requireRole } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { businessIdOf, check, inBusiness, notFound, parse, pgCode, PG, type FieldError, param } from '../lib/http.js';
import { invoices } from '../db/schema.js';
import { deleteInvoice, insertInvoices, linesFor, loadInvoice, toInvoiceDto, updateInvoice } from '../repos/invoices.js';
import { InvoiceBulk, InvoiceCreate, InvoiceListQuery, InvoiceUpdate } from '../schemas/invoice.js';

export const invoiceRoutes = Router({ mergeParams: true });
invoiceRoutes.use(requireAuth, requireBusiness);
const canWrite = requireRole('owner', 'accountant');

/* ---------- cursor: (created_at, id) of the last row, created_at as Postgres text for full precision ---------- */
const encodeCursor = (ts: string, id: string) => Buffer.from(JSON.stringify([ts, id])).toString('base64url');
function decodeCursor(c: string): [string, string] | null {
  try {
    const v = JSON.parse(Buffer.from(c, 'base64url').toString('utf8'));
    return Array.isArray(v) && v.length === 2 && v.every(x => typeof x === 'string') ? [v[0] as string, v[1] as string] : null;
  } catch { return null; }
}
const escapeLike = (s: string) => s.replace(/[\\%_]/g, m => '\\' + m);

/** Newest first. ?status=draft,validated &environment &invoiceType &from &to (invoice date) &batchId &q &limit &cursor */
invoiceRoutes.get('/', async (req, res) => {
  const q = parse(InvoiceListQuery, req.query, res); if (!q) return;
  const cursor = q.cursor ? decodeCursor(q.cursor) : null;
  if (q.cursor && !cursor) return res.status(400).json({ code: 'VALIDATION', message: 'Invalid cursor.' });

  const conds: SQL[] = [eq(invoices.businessId, businessIdOf(req))];
  if (q.status?.length) conds.push(inArray(invoices.status, q.status));
  if (q.environment) conds.push(eq(invoices.environment, q.environment));
  if (q.invoiceType) conds.push(eq(invoices.invoiceType, q.invoiceType));
  if (q.from) conds.push(gte(invoices.invoiceDate, q.from));
  if (q.to) conds.push(lte(invoices.invoiceDate, q.to));
  if (q.batchId) conds.push(eq(invoices.batchId, q.batchId));
  if (q.q) {
    const like = `%${escapeLike(q.q)}%`;
    conds.push(or(
      ilike(invoices.localRef, like), ilike(invoices.fbrInvoiceNumber, like),
      ilike(sql`${invoices.buyer}->>'name'`, like), ilike(sql`${invoices.buyer}->>'ntnCnic'`, like),
    )!);
  }
  if (cursor) conds.push(sql`(${invoices.createdAt}, ${invoices.id}) < (${cursor[0]}::timestamptz, ${cursor[1]})`);

  const page = await inBusiness(req, async tx => {
    const rows = await tx.select({ inv: invoices, ts: sql<string>`${invoices.createdAt}::text` }).from(invoices)
      .where(and(...conds)).orderBy(desc(invoices.createdAt), desc(invoices.id)).limit(q.limit + 1);
    const more = rows.length > q.limit;
    const pageRows = rows.slice(0, q.limit);
    const lines = await linesFor(tx, pageRows.map(r => r.inv.id));
    const last = pageRows[pageRows.length - 1];
    return {
      items: pageRows.map(r => toInvoiceDto(r.inv, lines.get(r.inv.id) ?? [])),
      nextCursor: more && last ? encodeCursor(last.ts, last.inv.id) : null,
    };
  });
  res.json(page);
});

invoiceRoutes.get('/:id', async (req, res) => {
  const inv = await inBusiness(req, tx => loadInvoice(tx, param(req, 'id')));
  return inv ? res.json(inv) : notFound(res, 'Invoice');
});

const actorOf = (req: { user: { id: string; name: string } }) => ({ id: req.user.id, name: req.user.name });

invoiceRoutes.post('/', canWrite, async (req, res) => {
  const body = parse(InvoiceCreate, req.body, res); if (!body) return;
  const businessId = businessIdOf(req);
  const result = await inBusiness(req, async tx => {
    const r = await insertInvoices(tx, businessId, [body], actorOf(req));
    const created = r.created[0];
    if (created) await audit({ actor: req.user.id, action: 'invoice_created', businessId, detail: created.invoice.localRef }, tx);
    return r;
  });
  const created = result.created[0];
  if (created) return res.status(201).json(created.invoice);
  const skipped = result.skipped[0]!; // one input: either created or skipped
  const message = body.id && skipped.id === body.id && !body.localRef ? 'An invoice with this id already exists.' : `Invoice ${skipped.localRef} already exists.`;
  res.status(409).json({ code: 'CONFLICT', message });
});

/**
 * Bulk import (up to 500 per request). Each invoice is validated on its own;
 * valid ones are inserted together, the rest come back in `errors` by index.
 */
invoiceRoutes.post('/bulk', canWrite, async (req, res) => {
  const body = parse(InvoiceBulk, req.body, res); if (!body) return;
  const businessId = businessIdOf(req);
  const errors: { index: number; localRef?: string; issues: FieldError[] }[] = [];
  const valid: { index: number; value: InvoiceCreate }[] = [];
  body.invoices.forEach((raw, index) => {
    const r = check(InvoiceCreate, raw);
    if (r.ok) valid.push({ index, value: r.value });
    else errors.push({ index, localRef: (raw as { localRef?: string })?.localRef, issues: r.issues });
  });

  const created = await inBusiness(req, async tx => {
    const r = await insertInvoices(tx, businessId, valid.map(v => v.value), actorOf(req));
    for (const s of r.skipped) {
      errors.push({ index: valid[s.index]!.index, localRef: s.localRef, issues: [{ path: 'localRef', message: `Invoice ${s.localRef} already exists.` }] });
    }
    if (r.created.length) await audit({ actor: req.user.id, action: 'invoices_imported', businessId, detail: String(r.created.length) }, tx);
    return r.created.map(c => ({ index: valid[c.index]!.index, invoice: c.invoice }));
  });
  errors.sort((a, b) => a.index - b.index);
  res.json({ created, errors });
});

/** Full replace of an invoice FBR has not seen (draft, validated or failed). */
invoiceRoutes.put('/:id', canWrite, async (req, res) => {
  const body = parse(InvoiceUpdate, req.body, res); if (!body) return;
  const businessId = businessIdOf(req);
  try {
    const r = await inBusiness(req, async tx => {
      const u = await updateInvoice(tx, param(req, 'id'), body, req.user.name);
      if (u.ok) await audit({ actor: req.user.id, action: 'invoice_updated', businessId, detail: u.invoice.localRef }, tx);
      return u;
    });
    if (r.ok) return res.json(r.invoice);
    if (!r.status) return notFound(res, 'Invoice');
    res.status(409).json({ code: 'NOT_EDITABLE', message: notEditable(r.status) });
  } catch (e) {
    if (pgCode(e) === PG.uniqueViolation) return res.status(409).json({ code: 'CONFLICT', message: `Invoice ${body.localRef} already exists.` });
    throw e;
  }
});

/** Only invoices FBR has not seen; posted ones need a debit note instead. */
invoiceRoutes.delete('/:id', canWrite, async (req, res) => {
  const businessId = businessIdOf(req);
  const r = await inBusiness(req, async tx => {
    const d = await deleteInvoice(tx, param(req, 'id'));
    if (d.ok) await audit({ actor: req.user.id, action: 'invoice_deleted', businessId, detail: d.localRef }, tx);
    return d;
  });
  if (r.ok) return res.status(204).end();
  if (!r.status) return notFound(res, 'Invoice');
  res.status(409).json({ code: 'NOT_DELETABLE', message: notEditable(r.status) });
});

function notEditable(status: string): string {
  switch (status) {
    case 'posted': return 'This invoice is posted to FBR and cannot be changed. Issue a debit note against its IRN instead.';
    case 'outcome_unknown': return 'FBR may have recorded this invoice. Check IRIS before changing it.';
    default: return 'This invoice is being posted to FBR. Wait for the result.';
  }
}
