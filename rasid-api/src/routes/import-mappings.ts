/**
 * /api/businesses/:businessId/import-mappings
 * Saved column mappings for bulk import, one per header signature: saving a
 * mapping for a signature that already has one replaces it (as StoreService.saveMapping does).
 */
import crypto from 'node:crypto';
import { desc, eq } from 'drizzle-orm';
import { Router } from 'express';
import { requireAuth, requireBusiness, requireRole } from '../lib/auth.js';
import { businessIdOf, inBusiness, notFound, parse, param } from '../lib/http.js';
import { importMappings } from '../db/schema.js';
import { ImportMappingInput } from '../schemas/masters.js';

export const importMappingRoutes = Router({ mergeParams: true });
importMappingRoutes.use(requireAuth, requireBusiness);
const canWrite = requireRole('owner', 'accountant');

type Row = typeof importMappings.$inferSelect;
const toDto = (m: Row) => ({ id: m.id, businessId: m.businessId, name: m.name, signature: m.signature, map: m.map, createdAt: m.createdAt.toISOString() });

importMappingRoutes.get('/', async (req, res) => {
  const rows = await inBusiness(req, tx => tx.select().from(importMappings).orderBy(desc(importMappings.createdAt)));
  res.json(rows.map(toDto));
});

importMappingRoutes.post('/', canWrite, async (req, res) => {
  const body = parse(ImportMappingInput, req.body, res); if (!body) return;
  const [row] = await inBusiness(req, tx => tx.insert(importMappings)
    .values({ id: body.id ?? 'm_' + crypto.randomUUID(), businessId: businessIdOf(req), name: body.name, signature: body.signature, map: body.map })
    .onConflictDoUpdate({ target: [importMappings.businessId, importMappings.signature], set: { name: body.name, map: body.map, createdAt: new Date() } })
    .returning());
  res.json(toDto(row!));
});

importMappingRoutes.delete('/:id', canWrite, async (req, res) => {
  const rows = await inBusiness(req, tx => tx.delete(importMappings).where(eq(importMappings.id, param(req, 'id'))).returning({ id: importMappings.id }));
  return rows.length ? res.status(204).end() : notFound(res, 'Import mapping');
});
