/**
 * FBR gateway: validate, post, reference lists and buyer checks.
 * Idempotency: a successful post is stored under (businessId, Idempotency-Key);
 * repeating the same key returns the stored response instead of posting twice.
 */
import { Router, type Request, type Response } from 'express';
import { requireAuth, requireBusiness, requireRole } from '../lib/auth.js';
import { audit, hashPayload } from '../lib/audit.js';
import { find, insert } from '../lib/db.js';
import { fbr, FbrHttpError, type FbrJson } from '../lib/fbr-client.js';
import type { FbrEnv } from '../types/models.js';
import { loadToken } from './credentials.js';

type Params = { businessId: string };
type Req = Request<Params>;
type KindParams = Params & { kind: string };

export const fbrRoutes = Router({ mergeParams: true });

const inflight = new Set<string>();
const statusOf = (e: unknown) => (e instanceof FbrHttpError ? e.status : undefined);
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

function envAndToken(req: Req, res: Response): { env: FbrEnv; token: string } | null {
  const env: FbrEnv = req.body?.environment === 'production' ? 'production' : 'sandbox';
  const token = loadToken(req.params.businessId, env);
  if (!token) { res.status(401).json({ message: `No ${env} token saved. Add it in Settings.` }); return null; }
  return { env, token };
}

/** Light structural check so obviously bad payloads never reach FBR. */
function checkPayload(p: FbrJson): string | null {
  if (!p || typeof p !== 'object' || !Array.isArray(p.items) || !p.items.length || p.items.length > 500) return 'Invoice must have 1 to 500 items.';
  if (!/^(\d{7}|\d{13})$/.test(p.sellerNTNCNIC ?? '')) return 'Seller NTN/CNIC must be 7 or 13 digits.';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.invoiceDate ?? '')) return 'invoiceDate must be YYYY-MM-DD.';
  return null;
}

function sellerMatches(req: Req, payload: FbrJson): boolean {
  const biz = find('businesses', b => b.id === req.params.businessId);
  return !!biz && biz.ntnCnic === payload.sellerNTNCNIC;
}

fbrRoutes.post<Params>('/validate', requireAuth, requireBusiness, requireRole('owner', 'accountant'), async (req, res) => {
  const ctx = envAndToken(req, res); if (!ctx) return;
  const payload = req.body?.payload;
  const bad = checkPayload(payload); if (bad) return res.status(400).json({ message: bad });
  if (!sellerMatches(req, payload)) return res.status(403).json({ message: 'Seller NTN does not match this business.' });
  try {
    const r = await fbr.validate(ctx.token, ctx.env, payload);
    res.json(r.json);
  } catch (e) { res.status(statusOf(e) === 401 ? 401 : 503).json({ message: messageOf(e) }); }
});

fbrRoutes.post<Params>('/post', requireAuth, requireBusiness, requireRole('owner', 'accountant'), async (req, res) => {
  const ctx = envAndToken(req, res); if (!ctx) return;
  const businessId = req.params.businessId;
  const key = String(req.get('Idempotency-Key') ?? '').slice(0, 120);
  if (!key) return res.status(400).json({ message: 'Idempotency-Key header is required.' });
  const payload = req.body?.payload;
  const bad = checkPayload(payload); if (bad) return res.status(400).json({ message: bad });
  if (!sellerMatches(req, payload)) return res.status(403).json({ message: 'Seller NTN does not match this business.' });

  const done = find('postings', p => p.businessId === businessId && p.env === ctx.env && p.key === key);
  if (done) return res.json(done.response);
  const lock = `${businessId}:${ctx.env}:${key}`;
  if (inflight.has(lock)) return res.status(409).json({ message: 'This invoice is already being posted.' });
  inflight.add(lock);

  try {
    const r = await fbr.post(ctx.token, ctx.env, payload);
    const ok = !!r.json?.invoiceNumber;
    audit({ actor: req.user.id, action: ok ? 'fbr_posted' : 'fbr_rejected', businessId, detail: ok ? r.json.invoiceNumber : r.json?.validationResponse?.errorCode, payloadHash: hashPayload(payload), attempts: r.attempt, latencyMs: r.latencyMs, env: ctx.env });
    if (ok) insert('postings', { businessId, env: ctx.env, key, response: r.json, at: new Date().toISOString() });
    res.json(r.json);
  } catch (e) {
    audit({ actor: req.user.id, action: 'fbr_error', businessId, detail: messageOf(e), payloadHash: hashPayload(payload), attempts: (e as FbrHttpError).attempts, env: ctx.env });
    if (statusOf(e) === -1) return res.status(504).json({ code: 'OUTCOME_UNKNOWN', message: 'FBR timed out. Check IRIS for this invoice before posting it again.' });
    res.status(statusOf(e) === 401 ? 401 : 503).json({ message: messageOf(e) });
  } finally { inflight.delete(lock); }
});

const REF_CACHE = new Map<string, { at: number; json: FbrJson }>(); // kind+query -> { at, json }
const REF_TTL_MS = 12 * 3600e3;

fbrRoutes.get<KindParams>('/reference/:kind', requireAuth, requireBusiness, async (req, res) => {
  const token = loadToken(req.params.businessId, 'production') ?? loadToken(req.params.businessId, 'sandbox');
  if (!token) return res.status(401).json({ message: 'Add an FBR token first.' });
  const q = new URLSearchParams(Object.entries(req.query).map(([k, v]): [string, string] => [k, String(v)])).toString();
  const cacheKey = `${req.params.kind}?${q}`;
  const hit = REF_CACHE.get(cacheKey);
  if (hit && Date.now() - hit.at < REF_TTL_MS) return res.json(hit.json);
  try {
    const r = await fbr.reference(token, req.params.kind, q ? `?${q}` : '');
    REF_CACHE.set(cacheKey, { at: Date.now(), json: r.json });
    res.set('Cache-Control', 'private, max-age=3600').json(r.json);
  } catch (e) {
    if (hit) return res.json(hit.json); // serve stale when FBR is down
    res.status(messageOf(e) === 'Unknown reference list' ? 404 : 503).json({ message: messageOf(e) });
  }
});

fbrRoutes.post<Params>('/reg-type', requireAuth, requireBusiness, async (req, res) => {
  const token = loadToken(req.params.businessId, 'production') ?? loadToken(req.params.businessId, 'sandbox');
  if (!token) return res.status(401).json({ message: 'Add an FBR token first.' });
  const no = String(req.body?.Registration_No ?? '').replace(/\D/g, '');
  if (!/^(\d{7}|\d{9}|\d{13})$/.test(no)) return res.status(400).json({ message: 'Enter a 7-digit NTN or 13-digit CNIC.' });
  try { res.json((await fbr.regType(token, no)).json); }
  catch (e) { res.status(503).json({ message: messageOf(e) }); }
});
