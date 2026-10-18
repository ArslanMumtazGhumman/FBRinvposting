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
  bigserial, check, date, foreignKey, index, integer, jsonb, numeric, pgTable, primaryKey, text, timestamp, unique, uniqueIndex,
} from 'drizzle-orm/pg-core';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const created = () => ts('created_at').notNull().defaultNow();
const updated = () => ts('updated_at').notNull().defaultNow();
const money = (name: string) => numeric(name, { mode: 'number' }).notNull().default(0);

export type Role = 'owner' | 'accountant' | 'viewer';
export type FbrEnv = 'sandbox' | 'production';
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
  furtherTaxRate: numeric('further_tax_rate', { mode: 'number' }).notNull().default(4),
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
