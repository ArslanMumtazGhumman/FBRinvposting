/**
 * Invoice bodies. Item field names are the FBR v1.12 names from
 * rasid-web/src/app/core/models.ts; LineItem adds unitPrice.
 * These check shape and bounds only. Tax rules are checked by the web app
 * (tax.ts) and by FBR, because drafts may legitimately be incomplete.
 */
import { z } from 'zod';
import { FbrEnv, Id, InvoiceType, IsoDate, money, NtnCnic, RegistrationType, SellerNtnCnic, text } from './common.js';

export const FbrItem = z.object({
  hsCode: text(20),
  productDescription: text(500),
  rate: text(40),
  uoM: text(100),
  quantity: money,
  totalValues: money,
  valueSalesExcludingST: money,
  fixedNotifiedValueOrRetailPrice: money,
  salesTaxApplicable: money,
  salesTaxWithheldAtSource: money,
  extraTax: money,
  furtherTax: money,
  sroScheduleNo: text(100),
  fedPayable: money,
  discount: money,
  saleType: text(200),
  sroItemSerialNo: text(100),
});

export const LineItem = FbrItem.extend({ unitPrice: money });

export const Buyer = z.object({
  ntnCnic: NtnCnic,
  name: text(200),
  province: text(100),
  address: text(500),
  registrationType: RegistrationType,
});

export const FieldIssue = z.object({
  code: text(20),
  message: text(500),
  hint: text(1000).optional(),
  field: text(60).optional(),
  itemIndex: z.number().int().min(0).max(499).optional(),
  source: z.enum(['local', 'fbr']),
});

const debitNoteNeedsIrn = (v: { invoiceType: string; invoiceRefNo: string }) => v.invoiceType !== 'Debit Note' || v.invoiceRefNo.length > 0;
const debitNoteMessage = { message: 'A debit note must reference the original invoice IRN.', path: ['invoiceRefNo'] };

/** What a client may set. Status is limited to pre-posting states; FBR fields and history are server-owned. */
const InvoiceFields = z.object({
  localRef: text(60).min(1).optional(),
  invoiceType: InvoiceType,
  invoiceDate: IsoDate,
  buyer: Buyer,
  items: z.array(LineItem).min(1, 'Add at least one line.').max(500, 'An invoice can have at most 500 lines.'),
  invoiceRefNo: text(60).default(''),
  scenarioId: text(10).optional(),
  environment: FbrEnv,
  status: z.enum(['draft', 'validated']).default('draft'),
  issues: z.array(FieldIssue).max(1000).default([]),
});

export const InvoiceCreate = InvoiceFields.extend({ id: Id.optional() }).refine(debitNoteNeedsIrn, debitNoteMessage);
export const InvoiceUpdate = InvoiceFields.refine(debitNoteNeedsIrn, debitNoteMessage);
export type InvoiceCreate = z.infer<typeof InvoiceCreate>;
export type InvoiceUpdate = z.infer<typeof InvoiceUpdate>;

/** Bulk import: validated row by row so one bad invoice doesn't reject the chunk. */
export const InvoiceBulk = z.object({ invoices: z.array(z.unknown()).min(1).max(500) });

/** POST /invoices/:id/post. An outcome_unknown invoice is posted again only after a person checked IRIS. */
export const PostOne = z.object({ confirmNotInIris: z.boolean().optional() });

/** POST /invoices/post-batch */
export const PostBatch = z.object({ ids: z.array(Id).min(1).max(5000) });

const STATUSES = ['draft', 'validated', 'queued', 'posting', 'posted', 'failed', 'outcome_unknown'] as const;
export const InvoiceStatus = z.enum(STATUSES);

export const InvoiceListQuery = z.object({
  status: z.string().optional()
    .transform(s => (s ? s.split(',').map(x => x.trim()).filter(Boolean) : undefined))
    .pipe(z.array(InvoiceStatus).optional()),
  environment: FbrEnv.optional(),
  invoiceType: InvoiceType.optional(),
  from: IsoDate.optional(),
  to: IsoDate.optional(),
  batchId: Id.optional(),
  q: text(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(200).optional(),
});

/** Exact FBR postinvoicedata / validateinvoicedata body. */
export const FbrInvoicePayload = z.object({
  invoiceType: InvoiceType,
  invoiceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'invoiceDate must be YYYY-MM-DD.'),
  sellerNTNCNIC: SellerNtnCnic,
  sellerBusinessName: text(200),
  sellerProvince: text(100),
  sellerAddress: text(500),
  buyerNTNCNIC: z.string().max(13),
  buyerBusinessName: text(200),
  buyerProvince: text(100),
  buyerAddress: text(500),
  buyerRegistrationType: RegistrationType,
  invoiceRefNo: text(60),
  scenarioId: text(10).optional(),
  items: z.array(FbrItem).min(1, 'Invoice must have 1 to 500 items.').max(500, 'Invoice must have 1 to 500 items.'),
});
export type FbrInvoicePayload = z.infer<typeof FbrInvoicePayload>;
