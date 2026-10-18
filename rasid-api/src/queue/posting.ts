/**
 * The FBR posting queue (BullMQ on Redis). The API adds one job per invoice;
 * the worker process (src/worker.ts) posts them. Jobs carry ids only: the
 * worker loads the invoice and decrypts the token itself.
 */
import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { redisConnection } from './redis.js';

export const POST_QUEUE = 'fbr-post';

export interface PostJob {
  businessId: string;
  invoiceId: string;
  batchId: string;
  /** User who queued it; the worker acts with their row-level access. */
  actor: string;
  actorName: string;
}

/**
 * Up to 3 runs per job, but only for failures before FBR was called: a job
 * that finds its invoice already in `posting` marks it outcome_unknown instead
 * of posting again (see worker.ts).
 */
export const POST_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5000 },
  removeOnComplete: { age: 3600, count: 5000 },
  removeOnFail: { age: 7 * 24 * 3600 },
} as const;

let connection: Redis | undefined;
let queue: Queue<PostJob> | undefined;

function postQueue(): Queue<PostJob> {
  // Fail an enqueue within seconds when Redis is down instead of hanging the request.
  connection ??= redisConnection({ maxRetriesPerRequest: 2 });
  return (queue ??= new Queue<PostJob>(POST_QUEUE, { connection, defaultJobOptions: POST_JOB_OPTIONS }));
}

/** The invoices' status is already `queued` in the database; this hands them to the worker. */
export async function enqueuePosts(jobs: PostJob[]): Promise<void> {
  if (!jobs.length) return;
  await postQueue().addBulk(jobs.map(data => ({ name: 'post', data })));
}

export async function closeQueue(): Promise<void> {
  await queue?.close();
  connection?.disconnect();
  queue = undefined;
  connection = undefined;
}
