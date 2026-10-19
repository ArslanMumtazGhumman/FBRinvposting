const req = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable ${name}`);
  return v;
};

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  port: Number(process.env.PORT ?? 3000),
  sessionSecret: req('SESSION_SECRET'),
  /** API login role (member of rasid_app). Never the table owner: RLS would not apply. */
  databaseUrl: req('DATABASE_URL'),
  dbPoolMax: Number(process.env.DB_POOL_MAX ?? 10),
  vaultKeys: Object.fromEntries(
    Object.entries(process.env)
      .filter((e): e is [string, string] => e[0].startsWith('VAULT_KEY_') && !!e[1])
      .map(([k, v]) => [k.slice('VAULT_KEY_'.length).toLowerCase(), Buffer.from(v, 'base64')]),
  ) as Record<string, Buffer>,
  vaultActiveKey: process.env.VAULT_ACTIVE_KEY ?? 'v1',
  corsOrigins: (process.env.CORS_ORIGINS ?? 'http://localhost:4200').split(',').map(s => s.trim()),
  fbrBaseUrl: process.env.FBR_BASE_URL ?? 'https://gw.fbr.gov.pk',
  fbrTimeoutMs: Number(process.env.FBR_TIMEOUT_MS ?? 30000),
  /** BullMQ posting queue. The API only enqueues; `node dist/worker.js` posts. */
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
  /** Jobs one worker process runs at once, across all businesses. */
  postWorkerConcurrency: Number(process.env.POST_WORKER_CONCURRENCY ?? 12),
  /** FBR calls in flight per business, across all worker processes. */
  postConcurrencyPerBusiness: Number(process.env.POST_CONCURRENCY_PER_BUSINESS ?? 3),
  /** How often a batch progress stream (SSE) checks for changes. */
  batchPollMs: Number(process.env.BATCH_POLL_MS ?? 1000),
  /** When the worker refreshes PRAL reference lists (cron, Pakistan time). */
  referenceRefreshCron: process.env.REFERENCE_REFRESH_CRON ?? '0 2 * * *',
  /** How long a cached parameterised lookup (rates, HS→UOM, SRO) is served before PRAL is asked again. */
  referenceTtlHours: Number(process.env.REFERENCE_TTL_HOURS ?? 12),
};

if (config.vaultKeys[config.vaultActiveKey]?.length !== 32) {
  throw new Error(`VAULT_KEY_${config.vaultActiveKey.toUpperCase()} must be 32 bytes, base64-encoded`);
}
