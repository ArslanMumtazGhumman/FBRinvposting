import { Buyer, FbrInvoicePayload, FbrItem, FieldIssue, Invoice, LineItem, Business } from './models';
import { FBR_ERROR_HELP, HS_UOM_RULES, PROVINCES, saleTypeDef } from './fbr-reference';

export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** "18%" → 18, "Exempt" → 0, "18% along with rupees 60 per kilogram" → 18 */
export function rateValue(rate: string): number {
  const m = /(-?\d+(?:\.\d+)?)\s*%/.exec(rate ?? '');
  return m ? parseFloat(m[1]) : 0;
}

/** Normalise user rate input: 18 / 0.18 / "18" / "18 %" → "18%". */
export function normaliseRate(input: unknown): string {
  if (input === null || input === undefined || input === '') return '';
  if (typeof input === 'number') {
    const pct = input > 0 && input < 1 ? input * 100 : input;
    return `${round2(pct)}%`;
  }
  const s = String(input).trim();
  if (/exempt/i.test(s)) return 'Exempt';
  const n = parseFloat(s.replace('%', ''));
  if (isNaN(n)) return s;
  return normaliseRate(n);
}

/**
 * Recompute derived values of a line.
 * value = qty × unitPrice (if unitPrice given), sales tax from rate,
 * further tax for unregistered buyers on taxable goods, total incl. taxes.
 */
export function computeLine(line: LineItem, buyer: Buyer, furtherTaxRate: number): LineItem {
  const def = saleTypeDef(line.saleType);
  const qty = Number(line.quantity) || 0;
  let value = Number(line.valueSalesExcludingST) || 0;
  if (line.unitPrice && qty) value = round2(qty * line.unitPrice);

  const r = rateValue(line.rate);
  const base = def?.usesRetailPrice ? (Number(line.fixedNotifiedValueOrRetailPrice) || 0) : value;
  const salesTax = def?.exempt ? 0 : round2(base * r / 100);
  const further = buyer.registrationType === 'Unregistered' && r > 0 && !def?.exempt
    ? round2(value * furtherTaxRate / 100) : 0;
  const total = round2(value + salesTax + further + (+line.extraTax || 0) + (+line.fedPayable || 0) - (+line.discount || 0));

  return { ...line, valueSalesExcludingST: value, salesTaxApplicable: salesTax, furtherTax: further, totalValues: total };
}

export function invoiceTotals(items: FbrItem[]) {
  return items.reduce((t, i) => ({
    value: round2(t.value + (+i.valueSalesExcludingST || 0)),
    salesTax: round2(t.salesTax + (+i.salesTaxApplicable || 0)),
    furtherTax: round2(t.furtherTax + (+i.furtherTax || 0)),
    other: round2(t.other + (+i.extraTax || 0) + (+i.fedPayable || 0) - (+i.discount || 0)),
    total: round2(t.total + (+i.totalValues || 0)),
  }), { value: 0, salesTax: 0, furtherTax: 0, other: 0, total: 0 });
}

export function emptyLine(saleType: string): LineItem {
  const def = saleTypeDef(saleType);
  return {
    hsCode: '', productDescription: '', rate: def?.rates[0] ?? '18%', uoM: 'Numbers, pieces, units',
    quantity: 1, unitPrice: 0, totalValues: 0, valueSalesExcludingST: 0, fixedNotifiedValueOrRetailPrice: 0,
    salesTaxApplicable: 0, salesTaxWithheldAtSource: 0, extraTax: 0, furtherTax: 0, sroScheduleNo: '',
    fedPayable: 0, discount: 0, saleType, sroItemSerialNo: '',
  };
}

const NTN_RE = /^(\d{7}|\d{9}|\d{13})$/;
export const cleanNtn = (v: string) => String(v ?? '').replace(/[^0-9]/g, '');

/**
 * Client-side pre-validation mirroring FBR rules, so most rejections are
 * caught before a network call. FBR validate is still the final check.
 */
export function validateInvoice(inv: Invoice, seller: Business): FieldIssue[] {
  const out: FieldIssue[] = [];
  const add = (code: string, message: string, field?: FieldIssue['field'], itemIndex?: number) =>
    out.push({ code, message, field, itemIndex, hint: FBR_ERROR_HELP[code], source: 'local' });

  if (!/^\d{4}-\d{2}-\d{2}$/.test(inv.invoiceDate)) add('0005', 'Invoice date is not in YYYY-MM-DD format', 'invoiceDate');
  if (!NTN_RE.test(cleanNtn(seller.ntnCnic))) add('0401', 'Seller NTN/CNIC is not 7 or 13 digits', 'seller');

  const b = inv.buyer;
  const bNtn = cleanNtn(b.ntnCnic);
  if (!b.name?.trim()) add('0010', 'Provide buyer name', 'name');
  if (!b.registrationType) add('0012', 'Provide buyer registration type', 'registrationType');
  if (b.registrationType === 'Registered' && !bNtn) add('0009', 'Provide buyer registration no.', 'ntnCnic');
  if (bNtn && !NTN_RE.test(bNtn)) add('0002', 'Invalid buyer registration no. or NTN', 'ntnCnic');
  if (bNtn && bNtn === cleanNtn(seller.ntnCnic)) add('0058', 'Self-invoicing not allowed', 'ntnCnic');
  if (!PROVINCES.includes(b.province as typeof PROVINCES[number])) add('0074', 'Provide destination of supply (buyer province)', 'province');
  if (inv.invoiceType === 'Debit Note' && !inv.invoiceRefNo?.trim()) add('0026', 'Invoice reference no. is required', 'invoiceRefNo');

  if (!inv.items.length) add('L-001', 'Add at least one line item');

  inv.items.forEach((it, i) => {
    const def = saleTypeDef(it.saleType);
    if (!def) add('0013', 'Provide valid sale type', 'saleType', i);
    if (!/^\d{4}\.\d{4}$/.test(it.hsCode?.trim() ?? '')) add('0019', 'Provide HS code in 0000.0000 format', 'hsCode', i);
    if (!it.productDescription?.trim()) add('L-002', 'Add a product description', 'productDescription', i);
    if (!it.rate) add('0046', 'Provide rate', 'rate', i);
    if (!it.uoM) add('0099', 'Provide UOM', 'uoM', i);
    const fixedUom = HS_UOM_RULES[it.hsCode];
    if (fixedUom && it.uoM !== fixedUom) add('0096', `For this HS code only ${fixedUom} UOM is allowed`, 'uoM', i);
    if (!(it.quantity > 0)) add('0098', 'Provide quantity', 'quantity', i);
    if (!(it.valueSalesExcludingST > 0) && !def?.usesRetailPrice) add('0021', 'Provide value of sales excl. ST', 'valueSalesExcludingST', i);
    if (def?.usesRetailPrice && !(it.fixedNotifiedValueOrRetailPrice > 0)) add('0090', 'Provide retail price', 'fixedNotifiedValueOrRetailPrice', i);

    const r = rateValue(it.rate);
    const base = def?.usesRetailPrice ? it.fixedNotifiedValueOrRetailPrice : it.valueSalesExcludingST;
    const expected = def?.exempt ? 0 : round2(base * r / 100);
    if (Math.abs(expected - it.salesTaxApplicable) > 1) {
      add(def?.usesRetailPrice ? '0102' : '0104', `Sales tax should be ${expected.toFixed(2)}`, 'salesTaxApplicable', i);
    }
    if (r === 5 && it.valueSalesExcludingST > 20000 && def?.name === 'Goods at Reduced Rate') {
      add('0079', 'Rate 5% not allowed when value exceeds 20,000', 'rate', i);
    }
  });
  return out;
}

export function toPayload(inv: Invoice, seller: Business): FbrInvoicePayload {
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
    items: inv.items.map(({ unitPrice, ...fbr }) => ({
      ...fbr,
      quantity: +(+fbr.quantity).toFixed(4),
      valueSalesExcludingST: round2(fbr.valueSalesExcludingST),
      salesTaxApplicable: round2(fbr.salesTaxApplicable),
      totalValues: round2(fbr.totalValues),
    })),
  };
  if (inv.environment === 'sandbox') payload.scenarioId = inv.scenarioId || saleTypeDef(inv.items[0]?.saleType ?? '')?.scenario || 'SN001';
  return payload;
}
