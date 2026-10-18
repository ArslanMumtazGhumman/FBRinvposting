/**
 * Invoice persistence shared by the REST routes and (from step 4) the posting
 * worker. Every function takes a transaction opened with withBusiness(), so
 * row-level security limits it to one business.
 */
import crypto from 'node:crypto';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import { businesses, invoiceItems, invoices, type HistoryEntry, type InvoiceStatus } from '../db/schema.js';
import type { InvoiceCreate, InvoiceUpdate } from '../schemas/invoice.js';

export type InvoiceRow = typeof invoices.$inferSelect;
export type LineRow = typeof invoiceItems.$inferSelect;

/** FBR never saw these, so they may still be edited or deleted. */
export const EDITABLE: InvoiceStatus[] = ['draft', 'validated', 'failed'];

const LINE_CHUNK = 1000; // 21 columns per line keeps each insert well under Postgres' 65535 parameters

/** Shape of Invoice in rasid-web/src/app/core/models.ts. */
export function toInvoiceDto(inv: InvoiceRow, lines: LineRow[]) {
  return {
    id: inv.id,
    businessId: inv.businessId,
    localRef: inv.localRef,
    invoiceType: inv.invoiceType,
    invoiceDate: inv.invoiceDate,
    buyer: inv.buyer,
    items: lines.map(({ invoiceId: _i, businessId: _b, lineNo: _n, ...item }) => item),
    invoiceRefNo: inv.invoiceRefNo,
    scenarioId: inv.scenarioId ?? undefined,
    environment: inv.environment,
    status: inv.status,
    issues: inv.issues,
    fbrInvoiceNumber: inv.fbrInvoiceNumber ?? undefined,
    fbrItemNumbers: inv.fbrItemNumbers ?? undefined,
    fbrDated: inv.fbrDated ?? undefined,
    attempts: inv.attempts,
    batchId: inv.batchId ?? undefined,
    createdAt: inv.createdAt.toISOString(),
    updatedAt: inv.updatedAt.toISOString(),
    history: inv.history,
  };
}
export type InvoiceDto = ReturnType<typeof toInvoiceDto>;

export async function linesFor(tx: Tx, invoiceIds: string[]): Promise<Map<string, LineRow[]>> {
  const byInvoice = new Map<string, LineRow[]>(invoiceIds.map(id => [id, []]));
  if (!invoiceIds.length) return byInvoice;
  const rows = await tx.select().from(invoiceItems).where(inArray(invoiceItems.invoiceId, invoiceIds))
    .orderBy(asc(invoiceItems.invoiceId), asc(invoiceItems.lineNo));
  for (const r of rows) byInvoice.get(r.invoiceId)?.push(r);
  return byInvoice;
}

export async function loadInvoice(tx: Tx, id: string): Promise<InvoiceDto | null> {
  const [inv] = await tx.select().from(invoices).where(eq(invoices.id, id));
  if (!inv) return null;
  return toInvoiceDto(inv, (await linesFor(tx, [id])).get(id) ?? []);
}

/** Reserves `count` consecutive invoice numbers (prefix + 5 digits, as the web app formats them). */
export async function allocateLocalRefs(tx: Tx, businessId: string, count: number): Promise<string[]> {
  if (count === 0) return [];
  const [r] = await tx.update(businesses)
    .set({ nextInvoiceNo: sql`${businesses.nextInvoiceNo} + ${count}`, updatedAt: new Date() })
    .where(eq(businesses.id, businessId))
    .returning({ prefix: businesses.invoicePrefix, next: businesses.nextInvoiceNo });
  if (!r) throw new Error('Business not found');
  return Array.from({ length: count }, (_, i) => `${r.prefix}${String(r.next - count + i).padStart(5, '0')}`);
}

async function insertLines(tx: Tx, rows: (typeof invoiceItems.$inferInsert)[]) {
  for (let i = 0; i < rows.length; i += LINE_CHUNK) await tx.insert(invoiceItems).values(rows.slice(i, i + LINE_CHUNK));
}

const lineRows = (invoiceId: string, businessId: string, items: InvoiceCreate['items']) =>
  items.map((item, i) => ({ ...item, invoiceId, businessId, lineNo: i + 1 }));

const headerFields = (input: InvoiceUpdate) => ({
  invoiceType: input.invoiceType,
  invoiceDate: input.invoiceDate,
  buyer: input.buyer,
  invoiceRefNo: input.invoiceRefNo,
  scenarioId: input.scenarioId ?? null,
  environment: input.environment,
  status: input.status,
  issues: input.issues,
});

/**
 * Inserts invoices with their lines. Rows whose id or invoice number already
 * exists are skipped and returned in `skipped` (by input index).
 */
export async function insertInvoices(tx: Tx, businessId: string, inputs: InvoiceCreate[], actor: { id: string; name: string }) {
  const refs = await allocateLocalRefs(tx, businessId, inputs.filter(i => !i.localRef).length);
  const at = new Date();
  const history: HistoryEntry[] = [{ at: at.toISOString(), actor: actor.name, action: 'Created' }];
  const rows = inputs.map(input => ({
    ...headerFields(input),
    id: input.id ?? 'i_' + crypto.randomUUID(),
    businessId,
    localRef: input.localRef ?? refs.shift()!,
    history,
    createdBy: actor.id,
    createdAt: at,
    updatedAt: at,
  }));
  const inserted = rows.length
    ? await tx.insert(invoices).values(rows).onConflictDoNothing().returning()
    : [];
  const insertedIds = new Set(inserted.map(r => r.id));
  const lines = rows.flatMap((r, i) => (insertedIds.has(r.id) ? lineRows(r.id, businessId, inputs[i]!.items) : []));
  await insertLines(tx, lines);

  const linesById = new Map<string, LineRow[]>();
  for (const l of lines) linesById.set(l.invoiceId, [...(linesById.get(l.invoiceId) ?? []), l as LineRow]);
  const byId = new Map(inserted.map(r => [r.id, r]));
  return {
    created: rows.flatMap((r, index) => { const row = byId.get(r.id); return row ? [{ index, invoice: toInvoiceDto(row, linesById.get(r.id) ?? []) }] : []; }),
    skipped: rows.flatMap((r, index) => (insertedIds.has(r.id) ? [] : [{ index, id: r.id, localRef: r.localRef }])),
  };
}

/**
 * Replaces header and lines of an editable invoice. Returns null when it does
 * not exist (in this business) and the current status when it is no longer editable.
 */
export async function updateInvoice(tx: Tx, id: string, input: InvoiceUpdate, actorName: string):
  Promise<{ ok: true; invoice: InvoiceDto } | { ok: false; status: InvoiceStatus | null }> {
  const entry: HistoryEntry = { at: new Date().toISOString(), actor: actorName, action: 'Edited' };
  const [row] = await tx.update(invoices)
    .set({
      ...headerFields(input),
      ...(input.localRef ? { localRef: input.localRef } : {}),
      history: sql`${invoices.history} || ${JSON.stringify([entry])}::jsonb`,
      updatedAt: new Date(),
    })
    .where(and(eq(invoices.id, id), inArray(invoices.status, EDITABLE)))
    .returning();
  if (!row) {
    const [cur] = await tx.select({ status: invoices.status }).from(invoices).where(eq(invoices.id, id));
    return { ok: false, status: cur?.status ?? null };
  }
  await tx.delete(invoiceItems).where(eq(invoiceItems.invoiceId, id));
  const lines = lineRows(id, row.businessId, input.items);
  await insertLines(tx, lines);
  return { ok: true, invoice: toInvoiceDto(row, lines as LineRow[]) };
}

/** Deletes an invoice FBR never saw; same return convention as updateInvoice. */
export async function deleteInvoice(tx: Tx, id: string):
  Promise<{ ok: true; localRef: string } | { ok: false; status: InvoiceStatus | null }> {
  const [row] = await tx.delete(invoices).where(and(eq(invoices.id, id), inArray(invoices.status, EDITABLE)))
    .returning({ localRef: invoices.localRef });
  if (row) return { ok: true, localRef: row.localRef };
  const [cur] = await tx.select({ status: invoices.status }).from(invoices).where(eq(invoices.id, id));
  return { ok: false, status: cur?.status ?? null };
}
