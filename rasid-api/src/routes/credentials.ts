/**
 * FBR token management. Tokens are write-only: they can be saved, tested
 * and replaced, but never read back by any client.
 */
import { and, eq } from 'drizzle-orm';
import { Router } from 'express';
import { requireAuth, requireBusiness, requireRole } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { fbr, FbrHttpError } from '../lib/fbr-client.js';
import { decrypt, encrypt, hint } from '../lib/vault.js';
import { withBusiness, type Tx } from '../db/client.js';
import { fbrCredentials } from '../db/schema.js';
import type { FbrEnv } from '../types/models.js';

type Params = { businessId: string; env: string };

export const credentialRoutes = Router({ mergeParams: true });
const ENVS = new Set<string>(['sandbox', 'production']);
const isEnv = (env: string): env is FbrEnv => ENVS.has(env);

credentialRoutes.put<Params>('/:env', requireAuth, requireBusiness, requireRole('owner'), async (req, res) => {
  const { env } = req.params;
  const token = String(req.body?.token ?? '').trim().replace(/^Bearer\s+/i, '');
  if (!isEnv(env)) return res.status(400).json({ message: 'Unknown environment' });
  if (token.length < 16 || token.length > 4096 || /\s/.test(token)) return res.status(400).json({ message: 'That does not look like a valid token.' });
  const businessId = req.params.businessId;
  const sealed = encrypt(token, `${businessId}:${env}`);
  const row = { keyVersion: sealed.version, ciphertext: sealed.data, hint: hint(token), updatedAt: new Date(), updatedBy: req.user.id };
  await withBusiness(req.user.id, businessId, async tx => {
    await tx.insert(fbrCredentials).values({ businessId, env, ...row })
      .onConflictDoUpdate({ target: [fbrCredentials.businessId, fbrCredentials.env], set: row });
    await audit({ actor: req.user.id, action: 'token_saved', businessId, detail: env }, tx);
  });
  res.json({ hint: hint(token) });
});

credentialRoutes.post<Params>('/:env/test', requireAuth, requireBusiness, requireRole('owner', 'accountant'), async (req, res) => {
  const { businessId, env } = req.params;
  if (!isEnv(env)) return res.status(404).json({ message: 'No token saved for this environment.' });
  const token = await withBusiness(req.user.id, businessId, tx => loadToken(tx, businessId, env));
  if (!token) return res.status(404).json({ message: 'No token saved for this environment.' });
  try {
    await fbr.reference(token, 'provinces');
    await withBusiness(req.user.id, businessId, tx => tx.update(fbrCredentials).set({ lastOkAt: new Date() })
      .where(and(eq(fbrCredentials.businessId, businessId), eq(fbrCredentials.env, env))));
    res.json({ ok: true });
  } catch (e) {
    res.status(e instanceof FbrHttpError && e.status === 401 ? 401 : 502).json({ message: (e as Error).message });
  }
});

/**
 * Only the FBR call paths use this, inside the business's transaction;
 * the plaintext lives for one request and is never logged or returned.
 */
export async function loadToken(tx: Tx, businessId: string, env: FbrEnv): Promise<string | null> {
  const [c] = await tx.select({ keyVersion: fbrCredentials.keyVersion, ciphertext: fbrCredentials.ciphertext }).from(fbrCredentials)
    .where(and(eq(fbrCredentials.businessId, businessId), eq(fbrCredentials.env, env)));
  return c ? decrypt({ version: c.keyVersion, data: c.ciphertext }, `${businessId}:${env}`) : null;
}
