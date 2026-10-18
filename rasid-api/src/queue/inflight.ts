/**
 * Which job is posting an invoice right now. Set (inside the row-locked
 * transaction) just before the invoice moves to `posting`, cleared after the
 * outcome is recorded, and expires on its own if the worker dies.
 *
 * A job that finds an invoice already in `posting` asks who holds it:
 *   - another live job → leave it alone, that job records the result;
 *   - itself (BullMQ re-ran it after a crash) or nobody → the post may have
 *     reached FBR, so the invoice becomes outcome_unknown.
 * Without this, a duplicate job on the queue could mark a post that is still in
 * flight as outcome_unknown, inviting a person to post it again.
 */
import type { Redis } from 'ioredis';

const RELEASE = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`;

export class InflightPosts {
  constructor(private redis: Redis, private ttlMs: number) {}

  private key = (invoiceId: string) => `rasid:posting:${invoiceId}`;

  claim(invoiceId: string, jobId: string) { return this.redis.set(this.key(invoiceId), jobId, 'PX', this.ttlMs); }
  holder(invoiceId: string) { return this.redis.get(this.key(invoiceId)); }
  async release(invoiceId: string, jobId: string) { await this.redis.eval(RELEASE, 1, this.key(invoiceId), jobId); }
}
