/**
 * Nightly PRAL reference refresh, run by the worker process. A BullMQ job
 * scheduler adds one job per tick however many workers run, and the queue
 * hands it to one of them. On start, a worker also queues a run if the cache
 * has never been filled, so a new deployment doesn't wait for the night.
 */
import { Queue, Worker } from 'bullmq';
import { config } from '../config.js';
import { refreshReference, type RefreshSummary } from '../reference/refresh.js';
import { hsCodeCount } from '../reference/store.js';
import { referenceToken, rejectReferenceToken } from '../reference/token.js';
import { redisConnection } from './redis.js';

export const REFERENCE_QUEUE = 'reference-refresh';

const log = (o: Record<string, unknown>) => console.log(JSON.stringify({ at: new Date().toISOString(), ...o }));

/** One refresh; skipped (not failed) when there's no token to use (token.ts). */
export async function runReferenceRefresh(): Promise<RefreshSummary | { skipped: string }> {
  const t = await referenceToken();
  if (!t) return { skipped: 'No reference token, and no customer token has passed a test. Set one with: node dist/reference-cli.js set-token' };
  const summary = await refreshReference({ token: t.token, source: t.source });
  if (summary.stoppedBy401) await rejectReferenceToken(t);
  return summary;
}

export interface ReferenceWorkerOptions { cron?: string; runNowIfEmpty?: boolean }

export async function startReferenceWorker(opts: ReferenceWorkerOptions = {}) {
  const queueRedis = redisConnection({ maxRetriesPerRequest: null });
  const workerRedis = redisConnection({ maxRetriesPerRequest: null });
  const queue = new Queue(REFERENCE_QUEUE, {
    connection: queueRedis,
    defaultJobOptions: { attempts: 2, backoff: { type: 'fixed', delay: 15 * 60_000 }, removeOnComplete: { count: 30 }, removeOnFail: { count: 30 } },
  });
  // Upsert, so every worker can call this and a changed cron replaces the old one.
  await queue.upsertJobScheduler('nightly', { pattern: opts.cron ?? config.referenceRefreshCron, tz: 'Asia/Karachi' }, { name: 'refresh' });
  if ((opts.runNowIfEmpty ?? true) && (await hsCodeCount()) === 0) {
    // Fixed id: workers starting together queue it once.
    await queue.add('refresh', {}, { jobId: 'initial-fill', removeOnComplete: true, removeOnFail: true });
  }

  const worker = new Worker(REFERENCE_QUEUE, async () => {
    const result = await runReferenceRefresh();
    log({ event: 'reference_refresh', ...result });
    // The cached copy of each failed list is kept; say so where operators look.
    for (const f of 'failed' in result ? result.failed : []) console.warn(JSON.stringify({ at: new Date().toISOString(), level: 'warn', event: 'reference_list_kept', ...f }));
    if ('stoppedBy401' in result && result.stoppedBy401) throw new Error('FBR rejected the reference token (401)');
    return result;
  }, { connection: workerRedis, concurrency: 1 });
  worker.on('failed', (_job, err) => log({ event: 'reference_refresh_failed', error: err.message.slice(0, 200) }));
  worker.on('error', err => log({ event: 'reference_worker_error', error: err.message.slice(0, 200) }));

  return {
    worker,
    queue,
    async close() {
      await worker.close();
      await queue.close();
      workerRedis.disconnect();
      queueRedis.disconnect();
    },
  };
}
