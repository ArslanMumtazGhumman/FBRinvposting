/**
 * FBR gateway: validate and buyer checks, called during the
 * request. Posting goes through the queue (routes/posting.ts, queue/worker.ts);
 * reference lists are served from the cache (routes/reference.ts).
 * No transaction is held open across an FBR call.
 */
import { eq } from 'drizzle-orm';
import { Router, type Request, type Response } from 'express';
import { requireAuth, requireBusiness, requireRole } from '../lib/auth.js';
import { fbr, FbrHttpError } from '../lib/fbr-client.js';
import { parse } from '../lib/http.js';
import { FbrCallBody, RegTypeBody } from '../schemas/auth.js';
import { withBusiness } from '../db/client.js';
import { businesses } from '../db/schema.js';
import type { FbrEnv } from '../types/models.js';
import { loadToken } from './credentials.js';

type Params = { businessId: string };
type Req = Request<Params>;

export const fbrRoutes = Router({ mergeParams: true });

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

fbrRoutes.post<Params>('/validate', requireAuth, requireBusiness, requireRole('owner', 'accountant'), async (req, res) => {
  const ctx = await context(req, res); if (!ctx) return;
  // Shape check (FbrInvoicePayload) so obviously bad payloads never reach FBR; unknown fields are dropped.
  const body = parse(FbrCallBody, req.body, res); if (!body) return;
  const { payload } = body;
  if (ctx.sellerNtn !== payload.sellerNTNCNIC) return res.status(403).json({ message: 'Seller NTN does not match this business.' });
  try {
    const r = await fbr.validate(ctx.token, ctx.env, payload);
    res.json(r.json);
  } catch (e) { res.status(statusOf(e) === 401 ? 401 : 503).json({ message: messageOf(e) }); }
});

fbrRoutes.post<Params>('/reg-type', requireAuth, requireBusiness, async (req, res) => {
  const token = await anyToken(req);
  if (!token) return res.status(401).json({ message: 'Add an FBR token first.' });
  const body = parse(RegTypeBody, req.body, res); if (!body) return;
  const no = body.Registration_No.replace(/\D/g, '');
  if (!/^(\d{7}|\d{9}|\d{13})$/.test(no)) return res.status(400).json({ message: 'Enter a 7-digit NTN or 13-digit CNIC.' });
  try { res.json((await fbr.regType(token, no)).json); }
  catch (e) { res.status(503).json({ message: messageOf(e) }); }
});
