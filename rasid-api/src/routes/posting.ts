/**
 * /api/businesses/:businessId/invoices — posting to FBR through the queue.
 *   POST /:id/post             queue one invoice
 *   POST /post-batch           queue many
 *   GET  /batches/:batchId     progress snapshot
 *   GET  /batches/:batchId/events   progress as Server-Sent Events
 * The worker process does the posting; these routes never see the FBR token.
 * Middleware is attached per route (not router.use) because invoiceRoutes is
 * mounted on the same path and runs its own.
 */
import crypto from 'node:crypto';
import { and, eq, gte } from 'drizzle-orm';
import { Router, type Request, type Response } from 'express';
import { config } from '../config.js';
import { requireAuth, requireBusiness, requireRole } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { businessIdOf, inBusiness, notFound, param, parse } from '../lib/http.js';
import { invoices } from '../db/schema.js';
import { enqueuePosts } from '../queue/posting.js';
import { loadInvoice } from '../repos/invoices.js';
import { batchInvoiceFields, batchProgress, failQueued, queueInvoices, type BatchProgress } from '../repos/posting.js';
import { PostBatch, PostOne } from '../schemas/invoice.js';

export const postingRoutes = Router({ mergeParams: true });
const canPost = [requireAuth, requireBusiness, requireRole('owner', 'accountant')];
const canRead = [requireAuth, requireBusiness];

/** Status → queued in the database, then jobs on the queue; if Redis refuses, back to failed. */
async function queue(req: Request, res: Response, ids: string[], allowUnknown: boolean) {
  const businessId = businessIdOf(req);
  const batchId = 'bt_' + crypto.randomUUID();
  const { queued, skipped } = await inBusiness(req, async tx => {
    const r = await queueInvoices(tx, ids, batchId, req.user.name, { allowUnknown });
    if (r.queued.length) await audit({ actor: req.user.id, action: 'invoices_queued', businessId, detail: `${batchId} ${r.queued.length}` }, tx);
    return r;
  });
  if (!queued.length) return { batchId: null, queued, skipped };
  try {
    await enqueuePosts(queued.map(q => ({ businessId, invoiceId: q.id, batchId, actor: req.user.id, actorName: req.user.name })));
  } catch {
    await inBusiness(req, tx => failQueued(tx, queued.map(q => q.id), batchId,
      { code: 'L-500', message: 'The posting queue is unavailable. Post again in a minute.', source: 'local' }));
    res.status(503).json({ code: 'QUEUE_UNAVAILABLE', message: 'The posting queue is unavailable. Nothing was sent to FBR; post again in a minute.' });
    return null;
  }
  return { batchId, queued, skipped };
}

postingRoutes.post('/post-batch', ...canPost, async (req, res) => {
  const body = parse(PostBatch, req.body, res); if (!body) return;
  const r = await queue(req, res, [...new Set(body.ids)], false);
  if (!r) return;
  res.status(202).json({ batchId: r.batchId, queued: r.queued.map(q => q.id), skipped: r.skipped });
});

postingRoutes.post('/:id/post', ...canPost, async (req, res) => {
  const body = parse(PostOne, req.body ?? {}, res); if (!body) return;
  const id = param(req, 'id');
  const r = await queue(req, res, [id], body.confirmNotInIris === true);
  if (!r) return;
  const skip = r.skipped[0];
  if (skip) return skip.status ? res.status(409).json({ code: 'NOT_POSTABLE', status: skip.status, message: skip.message }) : notFound(res, 'Invoice');
  res.status(202).json({ batchId: r.batchId, invoice: await inBusiness(req, tx => loadInvoice(tx, id)) });
});

postingRoutes.get('/batches/:batchId', ...canRead, async (req, res) => {
  const p = await inBusiness(req, tx => batchProgress(tx, param(req, 'batchId')));
  return p.total ? res.json(p) : notFound(res, 'Batch');
});

/**
 * Server-Sent Events while a batch runs:
 *   event: progress  BatchProgress (whenever the counts change)
 *   event: invoice   one invoice's new status / IRN / issues
 *   event: done      final BatchProgress, then the stream closes
 * Reads the database every BATCH_POLL_MS, so it works with any number of
 * API and worker processes. Reconnecting replays the current state.
 */
postingRoutes.get('/batches/:batchId/events', ...canRead, async (req, res) => {
  const batchId = param(req, 'batchId');
  const first = await inBusiness(req, tx => batchProgress(tx, batchId));
  if (!first.total) return notFound(res, 'Batch');

  res.status(200).set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // nginx: don't buffer the stream
  });
  res.flushHeaders();
  let open = true;
  req.on('close', () => { open = false; });
  const send = (event: string, data: unknown) => { if (open) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };

  const sent = new Map<string, string>(); // invoice id -> "status|updatedAt" already sent
  let since = 0;                          // newest updated_at seen (ms)
  let lastProgress = '';
  let lastWrite = Date.now();
  try {
    while (open) {
      const { progress, changed } = await inBusiness(req, async tx => {
        const conds = [eq(invoices.batchId, batchId)];
        // 10 s overlap: a transaction that started earlier can commit an older updated_at after we read.
        if (since) conds.push(gte(invoices.updatedAt, new Date(since - 10_000)));
        const changed = await tx.select(batchInvoiceFields).from(invoices).where(and(...conds));
        return { progress: await batchProgress(tx, batchId), changed };
      });
      for (const inv of changed) {
        const key = `${inv.status}|${inv.updatedAt.getTime()}`;
        if (sent.get(inv.id) === key) continue;
        sent.set(inv.id, key);
        since = Math.max(since, inv.updatedAt.getTime());
        send('invoice', { ...inv, fbrInvoiceNumber: inv.fbrInvoiceNumber ?? undefined, fbrItemNumbers: inv.fbrItemNumbers ?? undefined, fbrDated: inv.fbrDated ?? undefined, updatedAt: inv.updatedAt.toISOString() });
        lastWrite = Date.now();
      }
      const key = JSON.stringify(progress);
      if (key !== lastProgress) { lastProgress = key; send('progress', progress); lastWrite = Date.now(); }
      if (!progress.running) { send('done', progress satisfies BatchProgress); break; }
      if (Date.now() - lastWrite > 15_000) { if (open) res.write(': keep-alive\n\n'); lastWrite = Date.now(); }
      await new Promise(r => setTimeout(r, config.batchPollMs));
    }
  } catch (e) {
    console.error(JSON.stringify({ at: new Date().toISOString(), path: req.path, error: String((e as Error).message).slice(0, 300) }));
    send('error', { message: 'Progress updates stopped. Reload to see the latest status.' });
  }
  res.end();
});
