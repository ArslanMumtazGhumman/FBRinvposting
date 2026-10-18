import { Redis, type RedisOptions } from 'ioredis';
import { config } from '../config.js';

/** A new connection to REDIS_URL. Callers own it and must quit() it. */
export const redisConnection = (opts: RedisOptions = {}) => new Redis(config.redisUrl, opts);
