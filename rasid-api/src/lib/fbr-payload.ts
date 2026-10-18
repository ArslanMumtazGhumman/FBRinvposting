/**
 * Server-side twins of toPayload() and issuesFromResponse() in rasid-web
 * (core/tax.ts, core/posting.service.ts), so the worker posts exactly what
 * the browser would. Field names follow PRAL v1.12 / rasid-web models.ts.
 */
import type { FieldIssue } from '../db/schema.js';
import type { InvoiceDto } from '../repos/invoices.js';
import type { FbrInvoicePayload } from '../schemas/invoice.js';
import type { FbrJson } from './fbr-client.js';

export const cleanNtn = (v: string) => String(v ?? '').replace(/[^0-9]/g, '');
export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Primary sandbox scenario per sale type (rasid-web fbr-reference.ts SALE_TYPES). */
const SCENARIO_BY_SALE_TYPE: Record<string, string> = {
  'goods at standard rate (default)': 'SN001',
  'steel melting and re-rolling': 'SN003',
  'ship breaking': 'SN004',
  'goods at reduced rate': 'SN005',
  'exempt goods': 'SN006',
  'goods at zero-rate': 'SN007',
  '3rd schedule goods': 'SN008',
  'cotton ginners': 'SN009',
  'telecommunication services': 'SN010',
  'toll manufacturing': 'SN011',
  'petroleum products': 'SN012',
  'electricity supply to retailers': 'SN013',
  'gas to cng stations': 'SN014',
  'mobile phones': 'SN015',
  'processing/ conversion of goods': 'SN016',
  'goods (fed in st mode)': 'SN017',
  'services (fed in st mode)': 'SN018',
  'services': 'SN019',
  'electric vehicle': 'SN020',
  'cement /concrete block': 'SN021',
  'potassium chlorate': 'SN022',
  'cng sales': 'SN023',
  'goods as per sro.297(|)/2023': 'SN024',
  'non-adjustable supplies': 'SN025',
};

export interface Seller { ntnCnic: string; name: string; province: string; address: string }

export function toPayload(inv: InvoiceDto, seller: Seller): FbrInvoicePayload {
  const payload: FbrInvoicePayload = {
    invoiceType: inv.invoiceType,
    invoiceDate: inv.invoiceDate,
    sellerNTNCNIC: cleanNtn(seller.ntnCnic),
    sellerBusinessName: seller.name,
    sellerProvince: seller.province,
    sellerAddress: seller.address,
    buyerNTNCNIC: cleanNtn(inv.buyer.ntnCnic),
    buyerBusinessName: inv.buyer.name,
    buyerProvince: inv.buyer.province,
    buyerAddress: inv.buyer.address,
    buyerRegistrationType: inv.buyer.registrationType,
    invoiceRefNo: inv.invoiceRefNo ?? '',
    items: inv.items.map(({ unitPrice: _unitPrice, ...fbr }) => ({
      ...fbr,
      quantity: +(+fbr.quantity).toFixed(4),
      valueSalesExcludingST: round2(fbr.valueSalesExcludingST),
      salesTaxApplicable: round2(fbr.salesTaxApplicable),
      totalValues: round2(fbr.totalValues),
    })),
  };
  if (inv.environment === 'sandbox') {
    payload.scenarioId = inv.scenarioId || SCENARIO_BY_SALE_TYPE[(inv.items[0]?.saleType ?? '').trim().toLowerCase()] || 'SN001';
  }
  return payload;
}

const FIELD_FOR_CODE: Record<string, string> = {
  '0002': 'ntnCnic', '0009': 'ntnCnic', '0010': 'name', '0012': 'registrationType', '0005': 'invoiceDate',
  '0013': 'saleType', '0019': 'hsCode', '0044': 'hsCode', '0052': 'hsCode', '0046': 'rate', '0020': 'rate',
  '0096': 'uoM', '0097': 'uoM', '0099': 'uoM', '0102': 'salesTaxApplicable', '0104': 'salesTaxApplicable',
  '0105': 'salesTaxApplicable', '0090': 'fixedNotifiedValueOrRetailPrice', '0026': 'invoiceRefNo', '0401': 'seller',
};

/** FBR validation errors as cell-level issues (hints are added by the web app from the code). */
export function issuesFromResponse(res: FbrJson): FieldIssue[] {
  const v = res?.validationResponse ?? {};
  const out: FieldIssue[] = [];
  const field = (code: string) => FIELD_FOR_CODE[code];
  if (v.errorCode) out.push({ code: String(v.errorCode), message: String(v.error || 'Invalid'), source: 'fbr', field: field(v.errorCode) });
  for (const s of (Array.isArray(v.invoiceStatuses) ? v.invoiceStatuses : [])) {
    if (s?.statusCode !== '00' && s?.errorCode) {
      out.push({ code: String(s.errorCode), message: String(s.error || 'Invalid'), source: 'fbr', itemIndex: Number(s.itemSNo) - 1, field: field(s.errorCode) });
    }
  }
  return out;
}
