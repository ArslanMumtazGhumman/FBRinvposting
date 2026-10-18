/**
 * FBR token management. Tokens are write-only: they can be saved, tested
 * and replaced, but never read back by any client.
 */
import { Router } from 'express';
import { requireAuth, requireBusiness, requireRole } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { find, upsert } from '../lib/db.js';
import { fbr, FbrHttpError } from '../lib/fbr-client.js';
import { decrypt, encrypt, hint } from '../lib/vault.js';
import type { FbrEnv } from '../types/models.js';

type Params = { businessId: string; env: string };

export const credentialRoutes = Router({ mergeParams: true });
const ENVS = new Set<string>(['sandbox', 'production']);
const isEnv = (env: string): env is FbrEnv => ENVS.has(env);

credentialRoutes.put<Params>('/:env', requireAuth, requireBusiness, requireRole('owner'), (req, res) => {
  const { env } = req.params;
  const token = String(req.body?.token ?? '').trim().replace(/^Bearer\s+/i, '');
  if (!isEnv(env)) return res.status(400).json({ message: 'Unknown environment' });
  if (token.length < 16 || token.length > 4096 || /\s/.test(token)) return res.status(400).json({ message: 'That does not look like a valid token.' });
  const businessId = req.params.businessId;
  const sealed = encrypt(token, `${businessId}:${env}`);
  upsert('credentials', c => c.businessId === businessId && c.env === env,
    { businessId, env, sealed, hint: hint(token), updatedAt: new Date().toISOString(), updatedBy: req.user.id });
  audit({ actor: req.user.id, action: 'token_saved', businessId, detail: env });
  res.json({ hint: hint(token) });
});

credentialRoutes.post<Params>('/:env/test', requireAuth, requireBusiness, requireRole('owner', 'accountant'), async (req, res) => {
  const { businessId, env } = req.params;
  const token = isEnv(env) ? loadToken(businessId, env) : null;
  if (!token) return res.status(404).json({ message: 'No token saved for this environment.' });
  try {
    await fbr.reference(token, 'provinces');
    upsert('credentials', c => c.businessId === businessId && c.env === env, { lastOkAt: new Date().toISOString() });
    res.json({ ok: true });
  } catch (e) {
    res.status(e instanceof FbrHttpError && e.status === 401 ? 401 : 502).json({ message: (e as Error).message });
  }
});

/** Only the posting path calls this; the plaintext lives for one request. */
export function loadToken(businessId: string, env: FbrEnv): string | null {
  const c = find('credentials', x => x.businessId === businessId && x.env === env);
  return c ? decrypt(c.sealed, `${businessId}:${env}`) : null;
}
