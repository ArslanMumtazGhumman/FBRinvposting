/**
 * FBR gateway: validate, post, reference lists and buyer checks.
 * Idempotency: a successful post is recorded in api_calls under
 * (businessId, env, Idempotency-Key); repeating the same key returns the
 * stored response instead of posting twice.
 *
 * No transaction is held open across an FBR call: context is read in one
 * withBusiness() transaction and the outcome is written in another.
 */
import { and, eq } from 'drizzle-orm';
import { Router, type Request, type Response } from 'express';
import { requireAuth, requireBusiness, requireRole } from '../lib/auth.js';
import { audit, hashPayload } from '../lib/audit.js';
import { fbr, FbrHttpError, type FbrJson } from '../lib/fbr-client.js';
import { withBusiness } from '../db/client.js';
import { apiCalls, businesses } from '../db/schema.js';
import type { FbrEnv } from '../types/models.js';
import { loadToken } from './credentials.js';

type Params = { businessId: string };
type Req = Request<Params>;
type KindParams = Params & { kind: string };

export const fbrRoutes = Router({ mergeParams: true });

const inflight = new Set<string>();
const statusOf = (e: unknown) => (e instanceof FbrHttpError ? e.status : undefined);
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Token for the requested environment plus the business's NTN, or a 401 response. */
async function context(req: Req, res: Response): Promise<{ env: FbrEnv; token: string; sellerNtn: string } | null> {
  const env: FbrEnv = req.body?.environment === 'production' ? 'production' : 'sandbox';
  const { businessId } = req.params;
  const found = await withBusiness(req.user.id, businessId, async tx => {
    const [biz] = await tx.select({ ntnCnic: businesses.ntnCnic }).from(businesses).where(eq(businesses.id, businessId));
    return { token: await loadToken(tx, businessId, env), sellerNtn: biz?.ntnCnic ?? '' };
  });
  if (!found.token) { res.status(401).json({ message: `No ${env} token saved. Add it in Settings.` }); return null; }
  return { env, token: found.token, sellerNtn: found.sellerNtn };
}

/** Production token if saved, else sandbox; for read-only lookups. */
async function anyToken(req: Req): Promise<string | null> {
  const { businessId } = req.params;
  return withBusiness(req.user.id, businessId, async tx =>
    (await loadToken(tx, businessId, 'production')) ?? (await loadToken(tx, businessId, 'sandbox')));
}

/** Light structural check so obviously bad payloads never reach FBR. */
function checkPayload(p: FbrJson): string | null {
  if (!p || typeof p !== 'object' || !Array.isArray(p.items) || !p.items.length || p.items.length > 500) return 'Invoice must have 1 to 500 items.';
  if (!/^(\d{7}|\d{13})$/.test(p.sellerNTNCNIC ?? '')) return 'Seller NTN/CNIC must be 7 or 13 digits.';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.invoiceDate ?? '')) return 'invoiceDate must be YYYY-MM-DD.';
  return null;
}

fbrRoutes.post<Params>('/validate', requireAuth, requireBusiness, requireRole('owner', 'accountant'), async (req, res) => {
  const ctx = await context(req, res); if (!ctx) return;
  const payload = req.body?.payload;
  const bad = checkPayload(payload); if (bad) return res.status(400).json({ message: bad });
  if (ctx.sellerNtn !== payload.sellerNTNCNIC) return res.status(403).json({ message: 'Seller NTN does not match this business.' });
  try {
    const r = await fbr.validate(ctx.token, ctx.env, payload);
    res.json(r.json);
  } catch (e) { res.status(statusOf(e) === 401 ? 401 : 503).json({ message: messageOf(e) }); }
});

fbrRoutes.post<Params>('/post', requireAuth, requireBusiness, requireRole('owner', 'accountant'), async (req, res) => {
  const ctx = await context(req, res); if (!ctx) return;
  const { businessId } = req.params;
  const actor = req.user.id;
  const key = String(req.get('Idempotency-Key') ?? '').slice(0, 120);
  if (!key) return res.status(400).json({ message: 'Idempotency-Key header is required.' });
  const payload = req.body?.payload;
  const bad = checkPayload(payload); if (bad) return res.status(400).json({ message: bad });
  if (ctx.sellerNtn !== payload.sellerNTNCNIC) return res.status(403).json({ message: 'Seller NTN does not match this business.' });

  const [done] = await withBusiness(actor, businessId, tx => tx.select({ response: apiCalls.response }).from(apiCalls)
    .where(and(eq(apiCalls.businessId, businessId), eq(apiCalls.env, ctx.env), eq(apiCalls.idempotencyKey, key),
      eq(apiCalls.endpoint, 'post'), eq(apiCalls.outcome, 'ok'))));
  if (done) return res.json(done.response);
  // Single-process guard; step 4 moves posting to a queue with a database lock.
  const lock = `${businessId}:${ctx.env}:${key}`;
  if (inflight.has(lock)) return res.status(409).json({ message: 'This invoice is already being posted.' });
  inflight.add(lock);

  const payloadHash = hashPayload(payload);
  try {
    const r = await fbr.post(ctx.token, ctx.env, payload);
    const irn: string | undefined = r.json?.invoiceNumber || undefined;
    const errorCode: string | undefined = r.json?.validationResponse?.errorCode ?? undefined;
    await withBusiness(actor, businessId, async tx => {
      await tx.insert(apiCalls).values({
        businessId, env: ctx.env, endpoint: 'post', idempotencyKey: key, outcome: irn ? 'ok' : 'rejected', httpStatus: 200,
        fbrInvoiceNumber: irn, errorCode, response: r.json, payloadHash, attempts: r.attempt, latencyMs: r.latencyMs, actor,
      }).onConflictDoNothing();
      await audit({ actor, action: irn ? 'fbr_posted' : 'fbr_rejected', businessId, detail: irn ?? errorCode, payloadHash, attempts: r.attempt, latencyMs: r.latencyMs, env: ctx.env }, tx);
    });
    res.json(r.json);
  } catch (e) {
    const status = statusOf(e);
    const attempts = (e as FbrHttpError).attempts ?? 1;
    await withBusiness(actor, businessId, async tx => {
      await tx.insert(apiCalls).values({
        businessId, env: ctx.env, endpoint: 'post', idempotencyKey: key, outcome: status === -1 ? 'timeout' : 'error',
        httpStatus: status !== undefined && status > 0 ? status : null, errorMessage: messageOf(e), payloadHash, attempts, actor,
      });
      await audit({ actor, action: 'fbr_error', businessId, detail: messageOf(e), payloadHash, attempts, env: ctx.env }, tx);
    });
    if (status === -1) return res.status(504).json({ code: 'OUTCOME_UNKNOWN', message: 'FBR timed out. Check IRIS for this invoice before posting it again.' });
    res.status(status === 401 ? 401 : 503).json({ message: messageOf(e) });
  } finally { inflight.delete(lock); }
});

const REF_CACHE = new Map<string, { at: number; json: FbrJson }>(); // kind+query -> { at, json }
const REF_TTL_MS = 12 * 3600e3;

fbrRoutes.get<KindParams>('/reference/:kind', requireAuth, requireBusiness, async (req, res) => {
  const token = await anyToken(req);
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
  const token = await anyToken(req);
  if (!token) return res.status(401).json({ message: 'Add an FBR token first.' });
  const no = String(req.body?.Registration_No ?? '').replace(/\D/g, '');
  if (!/^(\d{7}|\d{9}|\d{13})$/.test(no)) return res.status(400).json({ message: 'Enter a 7-digit NTN or 13-digit CNIC.' });
  try { res.json((await fbr.regType(token, no)).json); }
  catch (e) { res.status(503).json({ message: messageOf(e) }); }
});
