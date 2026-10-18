/**
 * Per-business concurrency limit shared by every worker process: at most
 * `limit` FBR posts in flight for one business. Each slot is a lease in a
 * sorted set scored by its expiry, so a crashed worker's slot frees itself.
 * Time comes from the Redis server, not the worker's clock.
 */
import type { Redis } from 'ioredis';

const ACQUIRE = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
if redis.call('ZSCORE', KEYS[1], ARGV[3]) or redis.call('ZCARD', KEYS[1]) < tonumber(ARGV[1]) then
  redis.call('ZADD', KEYS[1], now + tonumber(ARGV[2]), ARGV[3])
  redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[2]))
  return 1
end
return 0`;

export class BusinessSlots {
  constructor(private redis: Redis, private limit: number, private leaseMs: number) {}

  private key = (businessId: string) => `rasid:post-slots:${businessId}`;

  /** True when `holder` now holds (or already held) one of the business's slots. */
  async acquire(businessId: string, holder: string): Promise<boolean> {
    return (await this.redis.eval(ACQUIRE, 1, this.key(businessId), this.limit, this.leaseMs, holder)) === 1;
  }

  async release(businessId: string, holder: string): Promise<void> {
    await this.redis.zrem(this.key(businessId), holder);
  }
}
