/**
 * Domain models. Field names on FbrItem / FbrInvoicePayload match
 * PRAL "Technical Specification for DI API" v1.12 exactly, so a payload
 * can be sent to postinvoicedata / validateinvoicedata without mapping.
 */

export type InvoiceType = 'Sale Invoice' | 'Debit Note';
export type RegistrationType = 'Registered' | 'Unregistered';
export type FbrEnvironment = 'sandbox' | 'production';
export type InvoiceStatus = 'draft' | 'validated' | 'queued' | 'posting' | 'posted' | 'failed';
export type Role = 'owner' | 'accountant' | 'viewer';

export interface FbrItem {
  hsCode: string;
  productDescription: string;
  rate: string;               // e.g. "18%" — string per spec (ratE_DESC)
  uoM: string;                // uom description from reference API
  quantity: number;
  totalValues: number;        // value incl. taxes
  valueSalesExcludingST: number;
  fixedNotifiedValueOrRetailPrice: number;
  salesTaxApplicable: number;
  salesTaxWithheldAtSource: number;
  extraTax: number;
  furtherTax: number;
  sroScheduleNo: string;
  fedPayable: number;
  discount: number;
  saleType: string;
  sroItemSerialNo: string;
}

export interface FbrInvoicePayload {
  invoiceType: InvoiceType;
  invoiceDate: string;        // YYYY-MM-DD
  sellerNTNCNIC: string;
  sellerBusinessName: string;
  sellerProvince: string;
  sellerAddress: string;
  buyerNTNCNIC: string;
  buyerBusinessName: string;
  buyerProvince: string;
  buyerAddress: string;
  buyerRegistrationType: RegistrationType;
  invoiceRefNo: string;
  scenarioId?: string;        // sandbox only
  items: FbrItem[];
}

export interface FbrItemStatus {
  itemSNo: string;
  statusCode: string;         // "00" valid, "01" invalid
  status: string;
  invoiceNo?: string | null;
  errorCode?: string | null;
  error?: string;
}

export interface FbrResponse {
  invoiceNumber?: string;
  dated: string;
  validationResponse: {
    statusCode: string;
    status: string;
    errorCode?: string | null;
    error?: string;
    invoiceStatuses: FbrItemStatus[] | null;
  };
}

/** A problem attached to a header field or a specific line cell. */
export interface FieldIssue {
  code: string;               // FBR error code or local "L-xxx"
  message: string;
  hint?: string;
  field?: keyof FbrItem | keyof Buyer | 'invoiceDate' | 'invoiceRefNo' | 'invoiceType' | 'seller';
  itemIndex?: number;         // 0-based line; undefined = header
  source: 'local' | 'fbr';
}

export interface Buyer {
  ntnCnic: string;
  name: string;
  province: string;
  address: string;
  registrationType: RegistrationType;
}

/** UI line: adds unitPrice which FBR doesn't carry; value = qty × unitPrice. */
export interface LineItem extends FbrItem {
  unitPrice: number;
}

export interface Invoice {
  id: string;
  businessId: string;
  localRef: string;           // our idempotency key / invoice no on paper
  invoiceType: InvoiceType;
  invoiceDate: string;
  buyer: Buyer;
  items: LineItem[];
  invoiceRefNo: string;       // original IRN for debit notes
  scenarioId?: string;
  environment: FbrEnvironment;
  status: InvoiceStatus;
  issues: FieldIssue[];
  fbrInvoiceNumber?: string;
  fbrItemNumbers?: string[];
  fbrDated?: string;
  attempts: number;
  batchId?: string;
  createdAt: string;
  updatedAt: string;
  history: AuditEntry[];
}

export interface AuditEntry {
  at: string;
  actor: string;
  action: string;
  detail?: string;
}

export interface Business {
  id: string;
  name: string;
  ntnCnic: string;
  province: string;
  address: string;
  activity: string;
  sector: string;
  environment: FbrEnvironment;
  hasSandboxToken: boolean;
  hasProductionToken: boolean;
  tokenHintSandbox?: string;
  tokenHintProduction?: string;
  defaultSaleType: string;
  furtherTaxRate: number;     // percent, configurable
  invoicePrefix: string;
  nextInvoiceNo: number;
}

export interface Customer extends Buyer {
  id: string;
  businessId: string;
  phone?: string;
  email?: string;
  activeStatus?: 'Active' | 'In-Active' | 'Unknown';
}

export interface Product {
  id: string;
  businessId: string;
  name: string;
  hsCode: string;
  uoM: string;
  saleType: string;
  rate: string;
  unitPrice: number;
}

export interface User {
  id: string;
  name: string;
  email: string;
  role: Role;
}

export interface ImportMapping {
  id: string;
  businessId: string;
  name: string;
  signature: string;          // normalized header signature
  map: Record<string, string>; // targetField -> source header
  createdAt: string;
}
