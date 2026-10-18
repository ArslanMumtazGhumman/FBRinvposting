import { z } from 'zod';
import { FbrEnv, Id, money, NtnCnic, RegistrationType, SellerNtnCnic, text } from './common.js';

export const CustomerInput = z.object({
  id: Id.optional(),
  ntnCnic: NtnCnic,
  name: text(200).min(1, 'Name is required.'),
  province: text(100),
  address: text(500).default(''),
  registrationType: RegistrationType,
  phone: text(30).optional(),
  email: z.union([z.email().max(254), z.literal('')]).optional(),
  activeStatus: z.enum(['Active', 'In-Active', 'Unknown']).optional(),
}).refine(c => c.registrationType !== 'Registered' || c.ntnCnic.length > 0,
  { message: 'A registered buyer needs an NTN or CNIC.', path: ['ntnCnic'] });

export const ProductInput = z.object({
  id: Id.optional(),
  name: text(500).min(1, 'Name is required.'),
  hsCode: text(20),
  uoM: text(100),
  saleType: text(200),
  rate: text(40),
  unitPrice: money,
});

export const ImportMappingInput = z.object({
  id: Id.optional(),
  name: text(200).min(1),
  signature: text(2000).min(1),
  map: z.record(text(100), text(300)).refine(m => Object.keys(m).length <= 100, 'Too many mapped fields.'),
});

export type CustomerInput = z.infer<typeof CustomerInput>;
export type ProductInput = z.infer<typeof ProductInput>;
export type ImportMappingInput = z.infer<typeof ImportMappingInput>;

/** POST /api/businesses and PUT /api/businesses/:businessId (Business in rasid-web models.ts, minus token flags). */
export const BusinessInput = z.object({
  id: Id.optional(),
  name: text(200).min(1, 'Name is required.'),
  ntnCnic: SellerNtnCnic,
  province: text(100).min(1),
  address: text(500).default(''),
  activity: text(100).min(1),
  sector: text(100).min(1),
  environment: FbrEnv,
  defaultSaleType: text(200).min(1),
  furtherTaxRate: z.number().finite().min(0).max(100),
  invoicePrefix: z.string().max(20).regex(/^[A-Za-z0-9/_-]*$/, 'Use letters, digits, - / or _.'),
  nextInvoiceNo: z.number().int().min(1).max(99_999_999),
});
