/**
 * PRAL reference data, the same for every tenant: any signed-in user may read
 * it. Served from the Postgres cache that the worker refreshes nightly
 * (src/reference/). No customer token is used.
 */
import { Router, type Response } from 'express';
import { requireAuth } from '../lib/auth.js';
import { param, parse } from '../lib/http.js';
import * as ref from '../reference/lookup.js';
import { todayPk } from '../reference/pral.js';
import { cacheStatus } from '../reference/store.js';
import { hasReferenceToken } from '../reference/token.js';
import { HsCode, HsSearchQuery, SaleTypesQuery, SroItemsQuery, SroSchedulesQuery } from '../schemas/reference.js';

export const referenceRoutes = Router();

/** The lists change at most daily; let the browser reuse an answer for 5 minutes. */
const send = (res: Response, body: unknown) => res.set('Cache-Control', 'private, max-age=300').json(body);

referenceRoutes.get('/provinces', requireAuth, async (_req, res) => send(res, await ref.provinces()));

referenceRoutes.get('/uoms', requireAuth, async (_req, res) => send(res, await ref.uoms()));

referenceRoutes.get('/sale-types', requireAuth, async (req, res) => {
  const q = parse(SaleTypesQuery, req.query, res); if (!q) return;
  send(res, await ref.saleTypeRates(q.province, q.date ?? todayPk()));
});

referenceRoutes.get('/hs-codes', requireAuth, async (req, res) => {
  const q = parse(HsSearchQuery, req.query, res); if (!q) return;
  send(res, await ref.hsSearch(q.q, q.limit));
});

referenceRoutes.get('/hs-codes/:code/uoms', requireAuth, async (req, res) => {
  const code = parse(HsCode, param(req, 'code'), res); if (!code) return;
  send(res, await ref.hsUoms(code));
});

referenceRoutes.get('/sro-schedules', requireAuth, async (req, res) => {
  const q = parse(SroSchedulesQuery, req.query, res); if (!q) return;
  send(res, await ref.sroSchedules(q.rateId, q.province, q.date ?? todayPk()));
});

referenceRoutes.get('/sro-items', requireAuth, async (req, res) => {
  const q = parse(SroItemsQuery, req.query, res); if (!q) return;
  send(res, await ref.sroItems(q.sroId, q.date ?? todayPk()));
});

/** How fresh the cache is, and whether Rasid's reference token is set (never the token itself). */
referenceRoutes.get('/status', requireAuth, async (_req, res) => {
  res.set('Cache-Control', 'no-store').json({ tokenConfigured: await hasReferenceToken(), ...(await cacheStatus()) });
});
