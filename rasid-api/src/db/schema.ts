/**
 * PostgreSQL schema (Drizzle). Every business-scoped table carries
 * business_id and is protected by row-level security; the policies,
 * the append-only triggers and the app role live in drizzle/0001_rls.sql.
 *
 * TS property names on invoice_items match the FBR v1.12 field names in
 * rasid-web/src/app/core/models.ts exactly (hsCode, uoM, ...).
 */
import { sql } from 'drizzle-orm';
import {
  bigserial, boolean, check, customType, date, foreignKey, index, integer, jsonb, numeric, pgTable, primaryKey, text, timestamp, unique, uniqueIndex,
} from 'drizzle-orm/pg-core';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const created = () => ts('created_at').notNull().defaultNow();
const updated = () => ts('updated_at').notNull().defaultNow();
const money = (name: string) => numeric(name, { mode: 'number' }).notNull().default(0);
const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' });

export type Role = 'owner' | 'accountant' | 'viewer';
export type FbrEnv = 'sandbox' | 'production';
export type ReferenceSource = 'platform' | FbrEnv;
export interface FurtherTaxRate { rate: number; from: string }
export type InvoiceStatus = 'draft' | 'validated' | 'queued' | 'posting' | 'posted' | 'failed' | 'outcome_unknown';
export type InvoiceType = 'Sale Invoice' | 'Debit Note';
export type RegistrationType = 'Registered' | 'Unregistered';

export interface Buyer {
  ntnCnic: string;
  name: string;
  province: string;
  address: string;
  registrationType: RegistrationType;
}
export interface FieldIssue {
  code: string;
  message: string;
  hint?: string;
  field?: string;
  itemIndex?: number;
  source: 'local' | 'fbr';
}
export interface HistoryEntry { at: string; actor: string; action: string; detail?: string }

/* ---------------- identity ---------------- */

export const tenants = pgTable('tenants', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  createdAt: created(),
});

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  tenantId: text('tenant_id').notNull().references(() => tenants.id),
  email: text('email').notNull(),
  name: text('name').notNull(),
  role: text('role').$type<Role>().notNull(),
  passwordHash: text('password_hash').notNull(),
  totpSecret: text('totp_secret'),
  fails: integer('fails').notNull().default(0),
  lockedUntil: ts('locked_until'),
  lastLoginAt: ts('last_login_at'),
  createdAt: created(),
}, t => [
  uniqueIndex('users_email_key').on(t.email),
  check('users_email_lower', sql`${t.email} = lower(${t.email})`),
]);

export const businesses = pgTable('businesses', {
  id: text('id').primaryKey(),
  tenantId: text('tenant_id').notNull().references(() => tenants.id),
  name: text('name').notNull(),
  ntnCnic: text('ntn_cnic').notNull(),
  province: text('province').notNull(),
  address: text('address').notNull().default(''),
  activity: text('activity').notNull(),
  sector: text('sector').notNull(),
  environment: text('environment').$type<FbrEnv>().notNull().default('sandbox'),
  defaultSaleType: text('default_sale_type').notNull().default('Goods at standard rate (default)'),
  /** Further tax (%) before the first dated change. The default 4 is still to be confirmed (DECISIONS.md). */
  furtherTaxRate: numeric('further_tax_rate', { mode: 'number' }).notNull().default(4),
  /** Dated changes: [{ rate, from: 'YYYY-MM-DD' }], sorted by from; the latest on or before an invoice's date applies. */
  furtherTaxRates: jsonb('further_tax_rates').$type<FurtherTaxRate[]>().notNull().default(sql`'[]'::jsonb`),
  invoicePrefix: text('invoice_prefix').notNull().default('INV-'),
  nextInvoiceNo: integer('next_invoice_no').notNull().default(1),
  createdAt: created(),
  updatedAt: updated(),
}, t => [index('businesses_tenant_idx').on(t.tenantId)]);

export const memberships = pgTable('memberships', {
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  businessId: text('business_id').notNull().references(() => businesses.id, { onDelete: 'cascade' }),
  role: text('role').$type<Role>().notNull(),
  createdAt: created(),
}, t => [
  primaryKey({ columns: [t.userId, t.businessId] }),
  index('memberships_business_idx').on(t.businessId),
]);

/* ---------------- business-scoped ---------------- */

/** Sealed with the vault (AES-256-GCM, AAD = businessId:env). Never selected by read endpoints. */
export const fbrCredentials = pgTable('fbr_credentials', {
  businessId: text('business_id').notNull().references(() => businesses.id, { onDelete: 'cascade' }),
  env: text('env').$type<FbrEnv>().notNull(),
  keyVersion: text('key_version').notNull(),
  ciphertext: text('ciphertext').notNull(),
  hint: text('hint').notNull(),
  updatedAt: updated(),
  updatedBy: text('updated_by').notNull().references(() => users.id),
  lastOkAt: ts('last_ok_at'),
}, t => [primaryKey({ columns: [t.businessId, t.env] })]);

export const customers = pgTable('customers', {
  id: text('id').primaryKey(),
  businessId: text('business_id').notNull().references(() => businesses.id, { onDelete: 'cascade' }),
  ntnCnic: text('ntn_cnic').notNull(),
  name: text('name').notNull(),
  province: text('province').notNull(),
  address: text('address').notNull().default(''),
  registrationType: text('registration_type').$type<RegistrationType>().notNull(),
  phone: text('phone'),
  email: text('email'),
  activeStatus: text('active_status').$type<'Active' | 'In-Active' | 'Unknown'>(),
  createdAt: created(),
  updatedAt: updated(),
}, t => [index('customers_business_idx').on(t.businessId, t.name)]);

export const products = pgTable('products', {
  id: text('id').primaryKey(),
  businessId: text('business_id').notNull().references(() => businesses.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  hsCode: text('hs_code').notNull(),
  uoM: text('uom').notNull(),
  saleType: text('sale_type').notNull(),
  rate: text('rate').notNull(),
  unitPrice: money('unit_price'),
  createdAt: created(),
  updatedAt: updated(),
}, t => [index('products_business_idx').on(t.businessId, t.name)]);

/** Header; lines are in invoice_items. Buyer is a snapshot at the time of invoicing. */
export const invoices = pgTable('invoices', {
  id: text('id').primaryKey(),
  businessId: text('business_id').notNull().references(() => businesses.id, { onDelete: 'restrict' }),
  localRef: text('local_ref').notNull(),
  invoiceType: text('invoice_type').$type<InvoiceType>().notNull(),
  invoiceDate: date('invoice_date', { mode: 'string' }).notNull(),
  buyer: jsonb('buyer').$type<Buyer>().notNull(),
  /** Original IRN for debit notes. */
  invoiceRefNo: text('invoice_ref_no').notNull().default(''),
  scenarioId: text('scenario_id'),
  environment: text('environment').$type<FbrEnv>().notNull(),
  status: text('status').$type<InvoiceStatus>().notNull().default('draft'),
  issues: jsonb('issues').$type<FieldIssue[]>().notNull().default([]),
  fbrInvoiceNumber: text('fbr_invoice_number'),
  fbrItemNumbers: jsonb('fbr_item_numbers').$type<string[]>(),
  fbrDated: text('fbr_dated'),
  attempts: integer('attempts').notNull().default(0),
  batchId: text('batch_id'),
  history: jsonb('history').$type<HistoryEntry[]>().notNull().default([]),
  createdBy: text('created_by').references(() => users.id),
  createdAt: created(),
  updatedAt: updated(),
  postedAt: ts('posted_at'),
}, t => [
  // Target for invoice_items' composite FK, so a line can never point at another business's invoice.
  unique('invoices_id_business_key').on(t.id, t.businessId),
  uniqueIndex('invoices_business_local_ref_key').on(t.businessId, t.localRef),
  uniqueIndex('invoices_irn_key').on(t.fbrInvoiceNumber).where(sql`${t.fbrInvoiceNumber} is not null`),
  index('invoices_business_created_idx').on(t.businessId, t.createdAt.desc(), t.id.desc()),
  index('invoices_business_status_idx').on(t.businessId, t.status),
  index('invoices_business_date_idx').on(t.businessId, t.invoiceDate),
  index('invoices_business_batch_idx').on(t.businessId, t.batchId).where(sql`${t.batchId} is not null`),
  check('invoices_debit_note_ref', sql`${t.invoiceType} <> 'Debit Note' or ${t.invoiceRefNo} <> ''`),
  check('invoices_posted_has_irn', sql`${t.status} <> 'posted' or ${t.fbrInvoiceNumber} is not null`),
]);

export const invoiceItems = pgTable('invoice_items', {
  invoiceId: text('invoice_id').notNull(),
  businessId: text('business_id').notNull(),
  lineNo: integer('line_no').notNull(),
  hsCode: text('hs_code').notNull(),
  productDescription: text('product_description').notNull(),
  rate: text('rate').notNull(),
  uoM: text('uom').notNull(),
  quantity: money('quantity'),
  unitPrice: money('unit_price'),
  totalValues: money('total_values'),
  valueSalesExcludingST: money('value_sales_excluding_st'),
  fixedNotifiedValueOrRetailPrice: money('fixed_notified_value_or_retail_price'),
  salesTaxApplicable: money('sales_tax_applicable'),
  salesTaxWithheldAtSource: money('sales_tax_withheld_at_source'),
  extraTax: money('extra_tax'),
  furtherTax: money('further_tax'),
  sroScheduleNo: text('sro_schedule_no').notNull().default(''),
  fedPayable: money('fed_payable'),
  discount: money('discount'),
  saleType: text('sale_type').notNull(),
  sroItemSerialNo: text('sro_item_serial_no').notNull().default(''),
}, t => [
  primaryKey({ columns: [t.invoiceId, t.lineNo] }),
  foreignKey({ name: 'invoice_items_invoice_fk', columns: [t.invoiceId, t.businessId], foreignColumns: [invoices.id, invoices.businessId] }).onDelete('cascade'),
  index('invoice_items_business_idx').on(t.businessId),
]);

export const importMappings = pgTable('import_mappings', {
  id: text('id').primaryKey(),
  businessId: text('business_id').notNull().references(() => businesses.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  signature: text('signature').notNull(),
  map: jsonb('map').$type<Record<string, string>>().notNull(),
  createdAt: created(),
}, t => [uniqueIndex('import_mappings_business_signature_key').on(t.businessId, t.signature)]);

/* ---------------- PRAL reference data (shared by all tenants, no RLS) ---------------- */

/**
 * Cached PRAL reference responses, as returned by FBR. `params` is the canonical
 * query without the date; `as_of` is the date the list was asked for
 * (YYYY-MM-DD, '' for lists that take no date). Written by the nightly job
 * (src/reference/refresh.ts) and by read-through lookups.
 */
export const refLists = pgTable('ref_lists', {
  kind: text('kind').notNull(),
  params: text('params').notNull().default(''),
  asOf: text('as_of').notNull().default(''),
  data: jsonb('data').$type<unknown[]>().notNull(),
  fetchedAt: ts('fetched_at').notNull().defaultNow(),
  /** Whose token fetched it: 'platform' (Rasid's own) or a customer's 'production' / 'sandbox' token. */
  sourceEnv: text('source_env').$type<ReferenceSource>().notNull().default('platform'),
}, t => [primaryKey({ columns: [t.kind, t.params, t.asOf] })]);

/** /pdi/v1/itemdesccode, one row per HS code, for search. */
export const hsCodes = pgTable('hs_codes', {
  code: text('code').primaryKey(),
  description: text('description').notNull(),
  fetchedAt: ts('fetched_at').notNull().defaultNow(),
  sourceEnv: text('source_env').$type<ReferenceSource>().notNull().default('platform'),
  /** Words of the code and description ('simple': no stemming, PRAL's descriptions mix English and trade terms). */
  search: tsvector('search').notNull().generatedAlwaysAs(sql`to_tsvector('simple', code || ' ' || description)`),
}, t => [
  index('hs_codes_search_idx').using('gin', t.search),
  index('hs_codes_digits_idx').on(sql`replace(${t.code}, '.', '') text_pattern_ops`),
]);

/**
 * Rasid's sale types and PRAL's transaction type for each (seeded in
 * drizzle/0006_sale_types.sql from src/lib/sale-types.ts). trans_type_id is
 * filled from transtypecode when exactly one description matches the name;
 * otherwise it stays null with needs_review and a note, and the sale type keeps
 * its bundled rates. A row an operator confirmed (confirmed_at, reference-cli
 * map-sale-type) is never changed by the automatic match.
 */
export const saleTypes = pgTable('sale_types', {
  name: text('name').primaryKey(),
  scenarioId: text('scenario_id').notNull(),
  usesRetailPrice: boolean('uses_retail_price').notNull().default(false),
  exempt: boolean('exempt').notNull().default(false),
  transTypeId: integer('trans_type_id'),
  /** PRAL's description for trans_type_id, as transtypecode returned it. */
  pralDesc: text('pral_desc'),
  needsReview: boolean('needs_review').notNull().default(true),
  reviewNote: text('review_note').notNull().default(''),
  /** When the automatic match last ran for this row. */
  checkedAt: ts('checked_at'),
  confirmedAt: ts('confirmed_at'),
  updatedAt: updated(),
}, t => [
  check('sale_types_scenario', sql`${t.scenarioId} ~ '^SN0[0-2][0-9]$'`),
  check('sale_types_mapped_or_review', sql`${t.transTypeId} is not null or ${t.needsReview}`),
]);

/**
 * Rasid's own PRAL token, used only to read reference lists. Sealed with the
 * vault (AAD = 'platform:reference'); set with `reference-cli set-token`,
 * which connects as the table owner. The API role can read the ciphertext only.
 */
export const referenceCredential = pgTable('reference_credential', {
  id: text('id').primaryKey().default('pral'),
  keyVersion: text('key_version').notNull(),
  ciphertext: text('ciphertext').notNull(),
  hint: text('hint').notNull(),
  updatedAt: updated(),
}, t => [check('reference_credential_single', sql`${t.id} = 'pral'`)]);

/* ---------------- append-only ---------------- */

/**
 * One row per completed FBR call. Successful posts double as the idempotency
 * record: (business_id, env, idempotency_key) is unique where outcome = 'ok'.
 * Never stores the token; the payload is hashed.
 */
export const apiCalls = pgTable('api_calls', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  businessId: text('business_id').notNull().references(() => businesses.id, { onDelete: 'restrict' }),
  invoiceId: text('invoice_id'),
  env: text('env').$type<FbrEnv>().notNull(),
  endpoint: text('endpoint').$type<'post' | 'validate'>().notNull(),
  idempotencyKey: text('idempotency_key'),
  outcome: text('outcome').$type<'ok' | 'rejected' | 'error' | 'timeout'>().notNull(),
  httpStatus: integer('http_status'),
  fbrInvoiceNumber: text('fbr_invoice_number'),
  errorCode: text('error_code'),
  errorMessage: text('error_message'),
  response: jsonb('response'),
  payloadHash: text('payload_hash').notNull(),
  attempts: integer('attempts').notNull(),
  latencyMs: integer('latency_ms'),
  actor: text('actor').notNull(),
  createdAt: created(),
}, t => [
  uniqueIndex('api_calls_idempotency_key').on(t.businessId, t.env, t.idempotencyKey)
    .where(sql`${t.endpoint} = 'post' and ${t.outcome} = 'ok' and ${t.idempotencyKey} is not null`),
  index('api_calls_business_created_idx').on(t.businessId, t.createdAt),
  index('api_calls_invoice_idx').on(t.invoiceId),
]);

/** Hash-chained; see src/lib/audit.ts. business_id is null for account-level events (login). */
export const auditLog = pgTable('audit_log', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  at: ts('at').notNull(),
  actor: text('actor').notNull(),
  action: text('action').notNull(),
  businessId: text('business_id'),
  ip: text('ip'),
  detail: text('detail'),
  payloadHash: text('payload_hash'),
  attempts: integer('attempts'),
  latencyMs: integer('latency_ms'),
  env: text('env').$type<FbrEnv>(),
  prev: text('prev').notNull(),
  hash: text('hash').notNull(),
}, t => [
  uniqueIndex('audit_log_hash_key').on(t.hash),
  index('audit_log_business_idx').on(t.businessId, t.id),
]);
