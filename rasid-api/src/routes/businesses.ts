import { Router } from 'express';
import { asc } from 'drizzle-orm';
import { requireAuth } from '../lib/auth.js';
import { withBusiness, withUser } from '../db/client.js';
import { businesses, fbrCredentials } from '../db/schema.js';
import type { Business } from '../types/models.js';

export const businessRoutes = Router();

/** Public shape of a business (matches Business in rasid-web models.ts, minus token flags). */
export const toBusinessDto = (b: Business) => ({
  id: b.id, name: b.name, ntnCnic: b.ntnCnic, province: b.province, address: b.address, activity: b.activity,
  sector: b.sector, environment: b.environment, defaultSaleType: b.defaultSaleType, furtherTaxRate: b.furtherTaxRate,
  invoicePrefix: b.invoicePrefix, nextInvoiceNo: b.nextInvoiceNo,
});

/** Businesses the signed-in user belongs to, with token status (never the token). */
businessRoutes.get('/', requireAuth, async (req, res) => {
  const userId = req.user.id;
  const list = await withUser(userId, tx => tx.select().from(businesses).orderBy(asc(businesses.name)));
  const out = [];
  for (const b of list) {
    // Credentials are business-scoped, so each business is read in its own context.
    const creds = await withBusiness(userId, b.id, tx => tx.select({ env: fbrCredentials.env, hint: fbrCredentials.hint }).from(fbrCredentials));
    const sb = creds.find(c => c.env === 'sandbox');
    const pr = creds.find(c => c.env === 'production');
    out.push({ ...toBusinessDto(b), hasSandboxToken: !!sb, tokenHintSandbox: sb?.hint, hasProductionToken: !!pr, tokenHintProduction: pr?.hint });
  }
  res.json(out);
});
