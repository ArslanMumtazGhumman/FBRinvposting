/**
 * PRAL reference data for a business's forms. The data is the same for every
 * tenant (src/reference/), but the routes are business-scoped so that province
 * and date default to the business's own and only members can read them.
 * Read-only: no route here writes, and no token is returned.
 */
import { Router, type Request, type Response } from 'express';
import { eq } from 'drizzle-orm';
import { withBusiness } from '../db/client.js';
import { businesses } from '../db/schema.js';
import { requireAuth, requireBusiness } from '../lib/auth.js';
import { businessIdOf, parse } from '../lib/http.js';
import * as ref from '../reference/lookup.js';
import { todayPk } from '../reference/pral.js';
import { saleTypesNeedingReview } from '../reference/sale-types.js';
import { cacheStatus } from '../reference/store.js';
import { hasReferenceToken, referenceTokenSource } from '../reference/token.js';
import { HsSearchQuery, ListKind, RatesQuery, SroItemsQuery, SroQuery, UomForHsQuery } from '../schemas/reference.js';

export const referenceRoutes = Router({ mergeParams: true });
referenceRoutes.use(requireAuth, requireBusiness);

/** The lists change at most daily; let the browser reuse an answer for 5 minutes. */
const send = (res: Response, body: unknown) => res.set('Cache-Control', 'private, max-age=300').json(body);

async function businessProvince(req: Request): Promise<string> {
  const businessId = businessIdOf(req);
  const [b] = await withBusiness(req.user.id, businessId, tx =>
    tx.select({ province: businesses.province }).from(businesses).where(eq(businesses.id, businessId)));
  return b?.province ?? '';
}

referenceRoutes.get('/rates', async (req, res) => {
  const q = parse(RatesQuery, req.query, res); if (!q) return;
  send(res, await ref.saleTypeRates(q.province ?? await businessProvince(req), q.date ?? todayPk(), q.saleType));
});

referenceRoutes.get('/hs', async (req, res) => {
  const q = parse(HsSearchQuery, req.query, res); if (!q) return;
  send(res, await ref.hsSearch(q.q, q.limit));
});

referenceRoutes.get('/uom-for-hs', async (req, res) => {
  const q = parse(UomForHsQuery, req.query, res); if (!q) return;
  send(res, await ref.hsUoms(q.hs));
});

referenceRoutes.get('/sro', async (req, res) => {
  const q = parse(SroQuery, req.query, res); if (!q) return;
  send(res, await ref.sroSchedules(q.rateId, q.province ?? await businessProvince(req), q.date ?? todayPk()));
});

referenceRoutes.get('/sro-items', async (req, res) => {
  const q = parse(SroItemsQuery, req.query, res); if (!q) return;
  send(res, await ref.sroItems(q.sroId, q.date ?? todayPk()));
});

/** How fresh the cache is, which token lookups would use (never the token itself), and unmatched sale types. */
referenceRoutes.get('/status', async (_req, res) => {
  res.set('Cache-Control', 'no-store').json({
    tokenConfigured: await hasReferenceToken(), tokenSource: await referenceTokenSource(),
    saleTypesNeedingReview: await saleTypesNeedingReview(), ...(await cacheStatus()),
  });
});

/** Lists without parameters: provinces, doctypecode, uom, transtypecode, sroitemcode. Last, so the paths above win. */
referenceRoutes.get('/:kind', async (req, res) => {
  const kind = parse(ListKind, req.params.kind, res); if (!kind) return;
  send(res, await ref.list(kind));
});
