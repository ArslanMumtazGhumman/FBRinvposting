import { z } from 'zod';
import { Id, money, NtnCnic, RegistrationType, text } from './common.js';

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
