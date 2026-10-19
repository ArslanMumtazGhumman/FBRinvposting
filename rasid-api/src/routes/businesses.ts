import crypto from 'node:crypto';
import { Router } from 'express';
import { asc, eq, sql } from 'drizzle-orm';
import { requireAuth, requireBusiness, requireRole } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { businessIdOf, inBusiness, parse, pgCode, PG } from '../lib/http.js';
import { withBusiness, withUser } from '../db/client.js';
import { businesses, fbrCredentials } from '../db/schema.js';
import { BusinessInput } from '../schemas/masters.js';
import type { Business } from '../types/models.js';

export const businessRoutes = Router();

/** Public shape of a business (matches Business in rasid-web models.ts, minus token flags). */
export const toBusinessDto = (b: Business) => ({
  id: b.id, name: b.name, ntnCnic: b.ntnCnic, province: b.province, address: b.address, activity: b.activity,
  sector: b.sector, environment: b.environment, defaultSaleType: b.defaultSaleType, furtherTaxRate: b.furtherTaxRate, furtherTaxRates: b.furtherTaxRates,
  invoicePrefix: b.invoicePrefix, nextInvoiceNo: b.nextInvoiceNo,
});

/** The business plus token status (never the token). Credentials are business-scoped, so this reads in its context. */
async function withTokenFlags(userId: string, b: Business) {
  const creds = await withBusiness(userId, b.id, tx => tx.select({ env: fbrCredentials.env, hint: fbrCredentials.hint }).from(fbrCredentials));
  const sb = creds.find(c => c.env === 'sandbox');
  const pr = creds.find(c => c.env === 'production');
  return { ...toBusinessDto(b), hasSandboxToken: !!sb, tokenHintSandbox: sb?.hint, hasProductionToken: !!pr, tokenHintProduction: pr?.hint };
}

/** Businesses the signed-in user belongs to. */
businessRoutes.get('/', requireAuth, async (req, res) => {
  const userId = req.user.id;
  const list = await withUser(userId, tx => tx.select().from(businesses).orderBy(asc(businesses.name)));
  const out = [];
  for (const b of list) out.push(await withTokenFlags(userId, b));
  res.json(out);
});

/** Adds a business to the user's tenant with the user as owner (tenant owners only; see create_business()). */
businessRoutes.post('/', requireAuth, async (req, res) => {
  const body = parse(BusinessInput, req.body, res); if (!body) return;
  if (req.user.role !== 'owner') return res.status(403).json({ code: 'FORBIDDEN', message: 'Only owners can add a business.' });
  const id = body.id ?? 'b_' + crypto.randomUUID();
  try {
    await withUser(req.user.id, tx => tx.execute(sql`select create_business(${JSON.stringify({ ...body, id })}::jsonb)`));
  } catch (e) {
    if (pgCode(e) === PG.uniqueViolation) return res.status(409).json({ code: 'CONFLICT', message: 'This id is already in use.' });
    throw e;
  }
  const b = await withBusiness(req.user.id, id, async tx => {
    await audit({ actor: req.user.id, action: 'business_created', businessId: id, detail: body.name }, tx);
    const [row] = await tx.select().from(businesses).where(eq(businesses.id, id));
    return row!;
  });
  res.status(201).json(await withTokenFlags(req.user.id, b));
});

/** Profile, environment and invoice defaults. Owners only; switching to production is audited. */
businessRoutes.put('/:businessId', requireAuth, requireBusiness, requireRole('owner'), async (req, res) => {
  const body = parse(BusinessInput, req.body, res); if (!body) return;
  const businessId = businessIdOf(req);
  const { id: _id, ...fields } = body;
  const row = await inBusiness(req, async tx => {
    const [before] = await tx.select({ environment: businesses.environment }).from(businesses).where(eq(businesses.id, businessId));
    const [after] = await tx.update(businesses).set({ ...fields, updatedAt: new Date() }).where(eq(businesses.id, businessId)).returning();
    await audit({ actor: req.user.id, action: before?.environment !== fields.environment ? `environment_${fields.environment}` : 'business_updated', businessId }, tx);
    return after!;
  });
  res.json(await withTokenFlags(req.user.id, row));
});
