import { z } from 'zod';
import { IsoDate, text } from './common.js';

export const Province = text(64).min(1, 'Choose a province');
export const HsCode = z.string().regex(/^\d{4}\.\d{4}$/, 'HS code must look like 0000.0000');

export const SaleTypesQuery = z.object({ province: Province, date: IsoDate.optional() });

export const HsSearchQuery = z.object({
  q: text(100).min(2, 'Type at least 2 characters'),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const SroSchedulesQuery = z.object({ rateId: z.coerce.number().int().positive(), province: Province, date: IsoDate.optional() });
export const SroItemsQuery = z.object({ sroId: z.coerce.number().int().positive(), date: IsoDate.optional() });
