import { Buyer, FbrInvoicePayload, FbrItem, FieldIssue, Invoice, LineItem, Business } from './models';
import { FBR_ERROR_HELP, HS_UOM_RULES, PROVINCES, SaleTypeDef, saleTypeDef } from './fbr-reference';
import { parseRate, perUnitTax } from './rate';

export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** The percentage part of a rate: "18%" → 18, "Exempt" → 0, "18% along with rupees 60 per kilogram" → 18 (see rate.ts). */
export function rateValue(rate: string): number {
  return parseRate(rate).percent;
}

/** What a line's tax depends on besides the line itself. */
export interface TaxContext {
  /** Further tax (%) for unregistered buyers, on the invoice date (furtherTaxRateOn). */
  furtherTaxRate: number;
  /** PRAL's numeric percentage for the line's rate when the API gave one; the rate text is parsed otherwise. */
  ratePercent?: (saleType: string, rate: string) => number | undefined;
}

/**
 * The business's further-tax rate on `date`: the latest change effective on or
 * before it (Business.furtherTaxRates), else the business's base rate.
 */
export function furtherTaxRateOn(biz: Pick<Business, 'furtherTaxRate' | 'furtherTaxRates'>, date: string): number {
  const change = (biz.furtherTaxRates ?? []).filter(r => r.from <= date).sort((a, b) => b.from.localeCompare(a.from))[0];
  return change ? change.rate : biz.furtherTaxRate;
}

/** The context for an invoice of `biz` dated `date`; pass ReferenceService.checks().rateValue for PRAL's numbers. */
export function taxContext(biz: Pick<Business, 'furtherTaxRate' | 'furtherTaxRates'>, date: string,
  rateValueOf?: (saleType: string, rate: string, date: string) => number | undefined): TaxContext {
  return { furtherTaxRate: furtherTaxRateOn(biz, date), ratePercent: rateValueOf && ((st, r) => rateValueOf(st, r, date)) };
}

/**
 * Sales tax on a line: base × percentage, plus any fixed amount per unit
 * ("18% along with rupees 60 per kilogram" on 10 KG adds Rs 600). Base is the
 * retail price for 3rd schedule goods, else the value excluding tax.
 */
export function lineSalesTax(line: Pick<LineItem, 'rate' | 'saleType' | 'uoM' | 'quantity' | 'valueSalesExcludingST' | 'fixedNotifiedValueOrRetailPrice'>, def: SaleTypeDef | undefined, ratePercent?: TaxContext['ratePercent']): { salesTax: number; taxable: boolean } {
  const parsed = parseRate(line.rate);
  if (def?.exempt || parsed.exempt) return { salesTax: 0, taxable: false };
  const pct = ratePercent?.(line.saleType, line.rate) ?? parsed.percent;
  const base = def?.usesRetailPrice ? (Number(line.fixedNotifiedValueOrRetailPrice) || 0) : (Number(line.valueSalesExcludingST) || 0);
  const fixed = perUnitTax(parsed.perUnit, line.uoM, Number(line.quantity) || 0);
  return { salesTax: round2(base * pct / 100 + fixed), taxable: pct > 0 || fixed > 0 };
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
 * value = qty × unitPrice (if unitPrice given), sales tax from the rate (PRAL's
 * number when the context has one), further tax for unregistered buyers on
 * taxable goods, total incl. taxes. A plain number is the further-tax rate.
 */
export function computeLine(line: LineItem, buyer: Buyer, ctx: TaxContext | number): LineItem {
  const { furtherTaxRate, ratePercent } = typeof ctx === 'number' ? { furtherTaxRate: ctx, ratePercent: undefined } : ctx;
  const def = saleTypeDef(line.saleType);
  const qty = Number(line.quantity) || 0;
  let value = Number(line.valueSalesExcludingST) || 0;
  if (line.unitPrice && qty) value = round2(qty * line.unitPrice);

  const { salesTax, taxable } = lineSalesTax({ ...line, valueSalesExcludingST: value }, def, ratePercent);
  const further = buyer.registrationType === 'Unregistered' && taxable ? round2(value * furtherTaxRate / 100) : 0;
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

/** A blank line. Pass the rate from ReferenceService (PRAL); the bundled default is the offline fallback. */
export function emptyLine(saleType: string, rate?: string): LineItem {
  const def = saleTypeDef(saleType);
  return {
    hsCode: '', productDescription: '', rate: rate ?? def?.offlineRates[0] ?? '18%', uoM: 'Numbers, pieces, units',
    quantity: 1, unitPrice: 0, totalValues: 0, valueSalesExcludingST: 0, fixedNotifiedValueOrRetailPrice: 0,
    salesTaxApplicable: 0, salesTaxWithheldAtSource: 0, extraTax: 0, furtherTax: 0, sroScheduleNo: '',
    fedPayable: 0, discount: 0, saleType, sroItemSerialNo: '',
  };
}

const NTN_RE = /^(\d{7}|\d{9}|\d{13})$/;
export const cleanNtn = (v: string) => String(v ?? '').replace(/[^0-9]/g, '');

/** UOMs FBR accepts for an HS code; undefined when no rule is known. */
export type HsUomLookup = (hsCode: string) => readonly string[] | undefined;
const bundledHsUom: HsUomLookup = hs => (HS_UOM_RULES[hs] ? [HS_UOM_RULES[hs]] : undefined);

/**
 * PRAL reference data the checks can use (ReferenceService.checks() in the app).
 * Each answers undefined when it has no data, and that check is skipped.
 */
export interface ReferenceChecks {
  /** UOMs FBR accepts for an HS code (HS_UOM). */
  allowedUoms?: HsUomLookup;
  /** Whether FBR's HS code list has the code. */
  hsKnown?: (hsCode: string) => boolean | undefined;
  /** PRAL's rates for a sale type in the seller's province on the invoice date. */
  liveRates?: (saleType: string, date: string) => readonly string[] | undefined;
  /** PRAL's numeric percentage for a rate, when PRAL gave one. */
  rateValue?: (saleType: string, rate: string, date: string) => number | undefined;
}

/**
 * Client-side pre-validation mirroring FBR rules, so most rejections are
 * caught before a network call. FBR validate is still the final check.
 * Pass ReferenceService.checks() (or just an HS→UOM lookup) for the PRAL checks.
 */
export function validateInvoice(inv: Invoice, seller: Business, ref: ReferenceChecks | HsUomLookup = { allowedUoms: bundledHsUom }): FieldIssue[] {
  const checks: ReferenceChecks = typeof ref === 'function' ? { allowedUoms: ref } : ref;
  const allowedUoms = checks.allowedUoms ?? bundledHsUom;
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
    if (/^\d{4}\.\d{4}$/.test(it.hsCode?.trim() ?? '') && checks.hsKnown?.(it.hsCode.trim()) === false) {
      add('0052', `HS code ${it.hsCode.trim()} is not in FBR's HS code list`, 'hsCode', i);
    }
    if (!it.rate) add('0046', 'Provide rate', 'rate', i);
    const allowedRates = it.rate && def ? checks.liveRates?.(it.saleType, inv.invoiceDate) : undefined;
    if (allowedRates?.length && !allowedRates.includes(it.rate)) {
      add('0046', `Rate ${it.rate} is not allowed for this sale type on ${inv.invoiceDate}. FBR allows: ${allowedRates.join(', ')}`, 'rate', i);
    }
    if (!it.uoM) add('0099', 'Provide UOM', 'uoM', i);
    const uoms = it.uoM ? allowedUoms(it.hsCode) : undefined;
    if (uoms?.length && !uoms.includes(it.uoM)) {
      if (uoms.length === 1) add('0096', `For this HS code only ${uoms[0]} UOM is allowed`, 'uoM', i);
      else add('0099', `UOM for this HS code must be one of: ${uoms.join(', ')}`, 'uoM', i);
    }
    if (!(it.quantity > 0)) add('0098', 'Provide quantity', 'quantity', i);
    if (!(it.valueSalesExcludingST > 0) && !def?.usesRetailPrice) add('0021', 'Provide value of sales excl. ST', 'valueSalesExcludingST', i);
    if (def?.usesRetailPrice && !(it.fixedNotifiedValueOrRetailPrice > 0)) add('0090', 'Provide retail price', 'fixedNotifiedValueOrRetailPrice', i);

    const r = checks.rateValue?.(it.saleType, it.rate, inv.invoiceDate) ?? rateValue(it.rate);
    const expected = lineSalesTax(it, def, () => r).salesTax;
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
