import { Router } from 'express';
import { requireAuth } from '../lib/auth.js';
import { filter, find } from '../lib/db.js';

export const businessRoutes = Router();

/** Businesses the signed-in user belongs to, with token status (never the token). */
businessRoutes.get('/', requireAuth, (req, res) => {
  const ids = new Set(filter('memberships', m => m.userId === req.user.id).map(m => m.businessId));
  res.json(filter('businesses', b => ids.has(b.id)).map(b => {
    const sb = find('credentials', c => c.businessId === b.id && c.env === 'sandbox');
    const pr = find('credentials', c => c.businessId === b.id && c.env === 'production');
    return { ...b, hasSandboxToken: !!sb, tokenHintSandbox: sb?.hint, hasProductionToken: !!pr, tokenHintProduction: pr?.hint };
  }));
});
