import { z } from 'zod';
import { IsoDate, text } from './common.js';

/** Province as Rasid stores it ("Punjab"); defaults to the business's own. */
export const Province = text(64).min(1, 'Choose a province');
export const HsCode = z.string().regex(/^\d{4}\.\d{4}$/, 'HS code must look like 0000.0000');

export const ListKind = z.enum(['provinces', 'doctypecode', 'uom', 'transtypecode', 'sroitemcode'], { message: 'Unknown reference list' });

export const RatesQuery = z.object({ saleType: text(100).min(1).optional(), province: Province.optional(), date: IsoDate.optional() });

export const HsSearchQuery = z.object({
  q: text(100).min(2, 'Type at least 2 characters'),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const UomForHsQuery = z.object({ hs: HsCode });

/** Comma-separated HS codes, 1 to 100, duplicates removed. */
export const HsCheckQuery = z.object({
  codes: z.string().max(1100).transform(s => [...new Set(s.split(',').map(c => c.trim()).filter(Boolean))])
    .pipe(z.array(HsCode).min(1, 'Give at least one HS code').max(100, 'At most 100 HS codes per request')),
});

export const SroQuery = z.object({ rateId: z.coerce.number().int().positive(), province: Province.optional(), date: IsoDate.optional() });
export const SroItemsQuery = z.object({ sroId: z.coerce.number().int().positive(), date: IsoDate.optional() });
