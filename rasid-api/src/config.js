const req = (name) => {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable ${name}`);
  return v;
};

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  port: Number(process.env.PORT ?? 3000),
  sessionSecret: req('SESSION_SECRET'),
  vaultKeys: Object.fromEntries(
    Object.entries(process.env)
      .filter(([k]) => k.startsWith('VAULT_KEY_'))
      .map(([k, v]) => [k.slice('VAULT_KEY_'.length).toLowerCase(), Buffer.from(v, 'base64')]),
  ),
  vaultActiveKey: process.env.VAULT_ACTIVE_KEY ?? 'v1',
  corsOrigins: (process.env.CORS_ORIGINS ?? 'http://localhost:4200').split(',').map(s => s.trim()),
  fbrBaseUrl: process.env.FBR_BASE_URL ?? 'https://gw.fbr.gov.pk',
  fbrTimeoutMs: Number(process.env.FBR_TIMEOUT_MS ?? 30000),
  dataDir: process.env.DATA_DIR ?? './data',
};

if (!config.vaultKeys[config.vaultActiveKey] || config.vaultKeys[config.vaultActiveKey].length !== 32) {
  throw new Error(`VAULT_KEY_${config.vaultActiveKey.toUpperCase()} must be 32 bytes, base64-encoded`);
}
