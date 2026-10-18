/**
 * Posts queued invoices to FBR. Runs in its own process (src/worker.ts) with
 * the API's database role, acting as the user who queued each invoice, so
 * row-level security still applies.
 *
 * Retry rules (unchanged from the request-time gateway):
 * - fbr-client retries a post only when the request provably did not reach
 *   FBR (connection failure, 502/503/504).
 * - A timeout is never retried: the invoice becomes outcome_unknown and a
 *   person checks IRIS before posting it again.
 * - The invoice moves to `posting` before FBR is called. A job that finds it
 *   already in `posting` (worker crashed, or a write failed after the call)
 *   marks it outcome_unknown instead of posting twice.
 */
import { DelayedError, Worker, type Job } from 'bullmq';
import { and, eq, inArray } from 'drizzle-orm';
import { config } from '../config.js';
import { withBusiness, type Tx } from '../db/client.js';
import { apiCalls, businesses, invoices, type FieldIssue, type InvoiceStatus } from '../db/schema.js';
import { audit, hashPayload } from '../lib/audit.js';
import { fbr, FbrHttpError, type FbrJson, type FbrResult } from '../lib/fbr-client.js';
import { issuesFromResponse, toPayload } from '../lib/fbr-payload.js';
import { pgCode, PG } from '../lib/http.js';
import { linesFor, toInvoiceDto } from '../repos/invoices.js';
import { appendHistory } from '../repos/posting.js';
import { loadToken } from '../routes/credentials.js';
import { FbrInvoicePayload } from '../schemas/invoice.js';
import type { FbrEnv } from '../types/models.js';
import { POST_QUEUE, type PostJob } from './posting.js';
import { redisConnection } from './redis.js';
import { BusinessSlots } from './slots.js';

const UNKNOWN_HINT = 'FBR may have recorded this invoice. Search for it in IRIS before posting again, to avoid a duplicate.';

type Prepared =
  | { kind: 'post'; token: string; env: FbrEnv; payload: FbrInvoicePayload; localRef: string }
  | { kind: 'settled' };

/** Writes a final status, guarded by the status the invoice must still be in. */
async function settle(tx: Tx, id: string, from: InvoiceStatus[],
  set: Partial<typeof invoices.$inferInsert>, history: { actor: string; action: string; detail?: string }) {
  await tx.update(invoices).set({ ...set, updatedAt: new Date(), history: appendHistory(history) })
    .where(and(eq(invoices.id, id), inArray(invoices.status, from)));
}

async function prepare(job: PostJob): Promise<Prepared> {
  const { businessId, invoiceId, actor } = job;
  return withBusiness(actor, businessId, async tx => {
    const [row] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId)).for('update');
    if (!row) return { kind: 'settled' }; // deleted, or the user lost access to the business
    if (row.status === 'posting') {
      await settle(tx, invoiceId, ['posting'], {
        status: 'outcome_unknown',
        issues: [{ code: 'L-504', message: 'Posting was interrupted after the invoice was sent to FBR.', hint: UNKNOWN_HINT, source: 'fbr' }],
      }, { actor: 'system', action: 'Post outcome unknown', detail: 'Interrupted while posting' });
      await audit({ actor, action: 'fbr_outcome_unknown', businessId, detail: row.localRef, env: row.environment }, tx);
      return { kind: 'settled' };
    }
    if (row.status !== 'queued') return { kind: 'settled' };

    const env = row.environment;
    // Idempotency: this invoice was already accepted by FBR (for example, recorded by an earlier run).
    const [done] = await tx.select({ response: apiCalls.response, irn: apiCalls.fbrInvoiceNumber }).from(apiCalls)
      .where(and(eq(apiCalls.businessId, businessId), eq(apiCalls.env, env), eq(apiCalls.idempotencyKey, invoiceId),
        eq(apiCalls.endpoint, 'post'), eq(apiCalls.outcome, 'ok')));
    if (done?.irn) {
      await settle(tx, invoiceId, ['queued'], postedFields(done.response, done.irn, row.attempts),
        { actor: 'system', action: 'Posted to FBR', detail: done.irn });
      return { kind: 'settled' };
    }

    const token = await loadToken(tx, businessId, env);
    if (!token) {
      await settle(tx, invoiceId, ['queued'], {
        status: 'failed', issues: [{ code: '0401', message: `No ${env} token saved. Add it in Settings.`, field: 'seller', source: 'fbr' }],
      }, { actor: 'system', action: 'Post failed', detail: `No ${env} token` });
      return { kind: 'settled' };
    }

    const [biz] = await tx.select({ ntnCnic: businesses.ntnCnic, name: businesses.name, province: businesses.province, address: businesses.address })
      .from(businesses).where(eq(businesses.id, businessId));
    const lines = (await linesFor(tx, [invoiceId])).get(invoiceId) ?? [];
    const parsed = FbrInvoicePayload.safeParse(toPayload(toInvoiceDto(row, lines), biz!));
    if (!parsed.success) {
      const issues: FieldIssue[] = parsed.error.issues.slice(0, 20).map(i => ({
        code: 'L-400', message: `${i.path.join('.')}: ${i.message}`, source: 'local',
        ...(i.path[0] === 'items' && typeof i.path[1] === 'number' ? { itemIndex: i.path[1] } : {}),
      }));
      await settle(tx, invoiceId, ['queued'], { status: 'failed', issues },
        { actor: 'system', action: 'Post failed', detail: 'Invoice is incomplete' });
      return { kind: 'settled' };
    }

    await settle(tx, invoiceId, ['queued'], { status: 'posting', issues: [] }, { actor: job.actorName, action: 'Posting to FBR' });
    return { kind: 'post', token, env, payload: parsed.data, localRef: row.localRef };
  });
}

function postedFields(res: FbrJson, irn: string, attempts: number): Partial<typeof invoices.$inferInsert> {
  const statuses: { invoiceNo?: string | null }[] = Array.isArray(res?.validationResponse?.invoiceStatuses) ? res.validationResponse.invoiceStatuses : [];
  return {
    status: 'posted', fbrInvoiceNumber: irn, fbrDated: res?.dated ? String(res.dated) : null,
    fbrItemNumbers: statuses.map(s => s.invoiceNo ?? ''), issues: [], attempts, postedAt: new Date(),
  };
}

async function record(job: PostJob, p: Extract<Prepared, { kind: 'post' }>, result: { r: FbrResult } | { e: unknown }) {
  const { businessId, invoiceId, actor } = job;
  const payloadHash = hashPayload(p.payload);
  const base = { businessId, invoiceId, env: p.env, endpoint: 'post' as const, idempotencyKey: invoiceId, payloadHash, actor };

  await withBusiness(actor, businessId, async tx => {
    if ('r' in result) {
      const { r } = result;
      const issues = issuesFromResponse(r.json);
      const irn: string | undefined = r.json?.invoiceNumber || undefined;
      const errorCode: string | undefined = r.json?.validationResponse?.errorCode ?? issues[0]?.code ?? undefined;
      const ok = !!irn && !issues.length;
      await tx.insert(apiCalls).values({
        ...base, outcome: ok ? 'ok' : 'rejected', httpStatus: 200, fbrInvoiceNumber: irn, errorCode,
        response: r.json, attempts: r.attempt, latencyMs: r.latencyMs,
      }).onConflictDoNothing();
      if (ok) {
        try {
          // Savepoint, so a refused update still leaves FBR's response in api_calls.
          // Also from outcome_unknown: a stalled duplicate run may have marked it while this call was in flight.
          await tx.transaction(sp => settle(sp, invoiceId, ['posting', 'outcome_unknown'], postedFields(r.json, irn, r.attempt),
            { actor: 'system', action: 'Posted to FBR', detail: irn }));
        } catch (e) {
          if (pgCode(e) !== PG.uniqueViolation) throw e;
          // FBR returned an invoice number Rasid already holds on another invoice: a person must look at IRIS.
          await settle(tx, invoiceId, ['posting', 'outcome_unknown'], {
            status: 'outcome_unknown',
            issues: [{ code: 'L-409', message: `FBR answered with invoice number ${irn}, which another invoice in Rasid already has.`, hint: UNKNOWN_HINT, source: 'fbr' }],
          }, { actor: 'system', action: 'Post outcome unknown', detail: `Duplicate FBR number ${irn}` });
        }
      } else {
        await settle(tx, invoiceId, ['posting'], { status: 'failed', issues, attempts: r.attempt },
          { actor: 'system', action: 'Rejected by FBR', detail: issues.map(i => `${i.code} ${i.message}`).join('; ') });
      }
      await audit({ actor, action: ok ? 'fbr_posted' : 'fbr_rejected', businessId, detail: irn ?? errorCode ?? p.localRef,
        payloadHash, attempts: r.attempt, latencyMs: r.latencyMs, env: p.env }, tx);
      return;
    }

    const e = result.e;
    const status = e instanceof FbrHttpError ? e.status : undefined;
    const attempts = (e as FbrHttpError).attempts ?? 1;
    const message = e instanceof Error ? e.message : String(e);
    const timedOut = status === -1;
    await tx.insert(apiCalls).values({
      ...base, outcome: timedOut ? 'timeout' : 'error', httpStatus: status !== undefined && status > 0 ? status : null,
      errorMessage: message, attempts,
    });
    const issue: FieldIssue = timedOut
      ? { code: 'L-504', message, hint: UNKNOWN_HINT, source: 'fbr' }
      : status === 401
        ? { code: '0401', message, field: 'seller', source: 'fbr' }
        : { code: 'L-500', message, hint: 'FBR did not respond after several attempts. Post again later.', source: 'fbr' };
    await settle(tx, invoiceId, ['posting'], { status: timedOut ? 'outcome_unknown' : 'failed', issues: [issue], attempts },
      { actor: 'system', action: timedOut ? 'Post outcome unknown' : 'Post failed', detail: message });
    await audit({ actor, action: 'fbr_error', businessId, detail: message, payloadHash, attempts, env: p.env }, tx);
  });
}

/** One invoice: prepare (DB), call FBR (no transaction open), record the outcome (DB). */
export async function postInvoice(job: PostJob): Promise<void> {
  const p = await prepare(job);
  if (p.kind !== 'post') return;
  let result: { r: FbrResult } | { e: unknown };
  try { result = { r: await fbr.post(p.token, p.env, p.payload) }; } catch (e) { result = { e }; }
  await record(job, p, result);
}

/** A job that ran out of attempts: never leave its invoice stuck in queued/posting. */
async function abandon(job: PostJob, err: Error) {
  await withBusiness(job.actor, job.businessId, async tx => {
    const [row] = await tx.select({ status: invoices.status }).from(invoices).where(eq(invoices.id, job.invoiceId)).for('update');
    if (row?.status === 'queued') {
      await settle(tx, job.invoiceId, ['queued'], {
        status: 'failed', issues: [{ code: 'L-500', message: 'Posting failed inside Rasid. Post again.', source: 'local' }],
      }, { actor: 'system', action: 'Post failed', detail: err.message.slice(0, 200) });
    } else if (row?.status === 'posting') {
      await settle(tx, job.invoiceId, ['posting'], {
        status: 'outcome_unknown', issues: [{ code: 'L-504', message: 'Posting was interrupted after the invoice was sent to FBR.', hint: UNKNOWN_HINT, source: 'fbr' }],
      }, { actor: 'system', action: 'Post outcome unknown', detail: err.message.slice(0, 200) });
    }
  });
}

const redact = (s: string) => s.replace(/Bearer\s+\S+/g, 'Bearer [redacted]').slice(0, 300);
const log = (o: Record<string, unknown>) => console.log(JSON.stringify({ at: new Date().toISOString(), ...o }));

export interface PostWorkerOptions { concurrency?: number; perBusiness?: number }

export function startPostWorker(opts: PostWorkerOptions = {}) {
  const slotRedis = redisConnection();
  // Longer than the worst case for one post: 4 attempts at the timeout plus 15 s of backoff.
  const slots = new BusinessSlots(slotRedis, opts.perBusiness ?? config.postConcurrencyPerBusiness, 4 * config.fbrTimeoutMs + 60_000);

  const workerRedis = redisConnection({ maxRetriesPerRequest: null });
  const worker = new Worker<PostJob>(POST_QUEUE, async (job: Job<PostJob>, token?: string) => {
    const holder = String(job.id);
    if (!(await slots.acquire(job.data.businessId, holder))) {
      // This business already has its share of FBR calls in flight: try again shortly.
      await job.moveToDelayed(Date.now() + 300 + Math.floor(Math.random() * 700), token);
      throw new DelayedError();
    }
    try { await postInvoice(job.data); }
    finally { await slots.release(job.data.businessId, holder); }
  }, {
    connection: workerRedis,
    concurrency: opts.concurrency ?? config.postWorkerConcurrency,
  });

  worker.on('failed', (job, err) => {
    if (!job) return;
    log({ event: 'post_job_failed', jobId: job.id, invoiceId: job.data.invoiceId, attempt: job.attemptsMade, error: redact(err.message) });
    if (job.attemptsMade >= (job.opts.attempts ?? 1)) {
      abandon(job.data, err).catch(e => log({ event: 'post_abandon_failed', invoiceId: job.data.invoiceId, error: redact(String(e)) }));
    }
  });
  worker.on('error', err => log({ event: 'worker_error', error: redact(err.message) }));

  return {
    worker,
    async close() {
      await worker.close();
      workerRedis.disconnect();
      slotRedis.disconnect();
    },
  };
}
