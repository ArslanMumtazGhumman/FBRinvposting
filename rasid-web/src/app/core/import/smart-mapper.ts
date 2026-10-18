import { Business, Invoice, LineItem, RegistrationType } from '../models';
import { PROVINCES, SALE_TYPES, UOMS, saleTypeDef } from '../fbr-reference';
import { cleanNtn, computeLine, emptyLine, normaliseRate } from '../tax';
import { norm, nowIso, similarity, uid } from '../util';

/** Target fields a sheet column can map to. */
export interface TargetField {
  key: string;
  label: string;
  level: 'invoice' | 'line';
  required?: boolean;
  synonyms: string[];
  /** Content sniffer: share of sample values that look like this field (0..1). */
  sniff?: (values: unknown[]) => number;
}

const share = (values: unknown[], test: (s: string) => boolean) => {
  const v = values.map(x => String(x ?? '').trim()).filter(Boolean);
  return v.length ? v.filter(test).length / v.length : 0;
};

export const TARGET_FIELDS: TargetField[] = [
  { key: 'invoiceNo', label: 'Invoice no. (groups lines)', level: 'invoice',
    synonyms: ['invoice no', 'invoice number', 'inv no', 'inv', 'invoice', 'bill no', 'bill number', 'voucher no', 'doc no', 'document no', 'ref no', 'reference'] },
  { key: 'invoiceDate', label: 'Invoice date', level: 'invoice', required: true,
    synonyms: ['date', 'invoice date', 'inv date', 'bill date', 'posting date', 'document date'],
    sniff: v => share(v, s => /^\d{4}-\d{2}-\d{2}$/.test(s) || /^\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}$/.test(s) || /^\d{1,2}-[a-z]{3}-\d{2,4}$/i.test(s) || /^4\d{4}$/.test(s)) },
  { key: 'invoiceType', label: 'Invoice type', level: 'invoice', synonyms: ['invoice type', 'type', 'doc type', 'document type'] },
  { key: 'buyerNTNCNIC', label: 'Buyer NTN / CNIC', level: 'invoice',
    synonyms: ['buyer ntn', 'customer ntn', 'ntn', 'ntn cnic', 'cnic', 'buyer cnic', 'strn', 'registration no', 'buyer registration no', 'party ntn'],
    sniff: v => share(v, s => /^(\d{7}|\d{9}|\d{13})$/.test(cleanNtn(s)) && s.replace(/[^0-9]/g, '').length >= 7) },
  { key: 'buyerBusinessName', label: 'Buyer name', level: 'invoice', required: true,
    synonyms: ['buyer name', 'customer name', 'customer', 'buyer', 'party name', 'party', 'client', 'client name', 'account name', 'sold to'] },
  { key: 'buyerProvince', label: 'Buyer province', level: 'invoice',
    synonyms: ['buyer province', 'province', 'state', 'region', 'destination'],
    sniff: v => share(v, s => PROVINCES.some(p => similarity(norm(p), norm(s)) > 0.8)) },
  { key: 'buyerAddress', label: 'Buyer address', level: 'invoice', synonyms: ['buyer address', 'customer address', 'address', 'city', 'location'] },
  { key: 'buyerRegistrationType', label: 'Buyer registration type', level: 'invoice',
    synonyms: ['registration type', 'reg type', 'buyer type', 'buyer registration type', 'registered unregistered'],
    sniff: v => share(v, s => /^(un)?registered$/i.test(s)) },
  { key: 'invoiceRefNo', label: 'Original FBR invoice no. (debit notes)', level: 'invoice', synonyms: ['invoice ref no', 'original invoice', 'reference invoice', 'fbr ref'] },

  { key: 'hsCode', label: 'HS code', level: 'line', required: true,
    synonyms: ['hs code', 'hscode', 'hs', 'pct code', 'pct', 'tariff code', 'h s code'],
    sniff: v => share(v, s => /^\d{4}\.?\d{4}$/.test(s)) },
  { key: 'productDescription', label: 'Product description', level: 'line', required: true,
    synonyms: ['description', 'product description', 'item description', 'item', 'item name', 'product', 'product name', 'particulars', 'goods', 'details'] },
  { key: 'uoM', label: 'Unit of measure', level: 'line', synonyms: ['uom', 'unit', 'units', 'unit of measure', 'measurement'],
    sniff: v => share(v, s => UOMS.some(u => norm(u) === norm(s)) || /^(kg|pcs|nos|ltr|liter|mtr|meter|dozen|ton)$/i.test(s)) },
  { key: 'quantity', label: 'Quantity', level: 'line', required: true, synonyms: ['qty', 'quantity', 'pcs', 'no of units', 'units sold'] },
  { key: 'unitPrice', label: 'Unit price', level: 'line', synonyms: ['unit price', 'price', 'rate per unit', 'unit rate', 'rate unit', 'price per unit'] },
  { key: 'valueSalesExcludingST', label: 'Value excl. sales tax', level: 'line',
    synonyms: ['value excl st', 'value excluding sales tax', 'value excl tax', 'excl tax', 'net amount', 'amount', 'taxable value', 'value of sales', 'sales value', 'gross amount'] },
  { key: 'rate', label: 'Tax rate', level: 'line',
    synonyms: ['tax rate', 'st rate', 'gst rate', 'sales tax rate', 'rate %', 'gst %', 'st %', 'rate'],
    sniff: v => share(v, s => /^\d{1,2}(\.\d+)?\s*%$/.test(s) || /^0?\.\d+$/.test(s)) },
  { key: 'salesTaxApplicable', label: 'Sales tax amount', level: 'line', synonyms: ['sales tax', 'st amount', 'gst', 'gst amount', 'tax amount', 'sales tax amount', 'tax'] },
  { key: 'furtherTax', label: 'Further tax', level: 'line', synonyms: ['further tax', 'ft', 'further tax amount'] },
  { key: 'extraTax', label: 'Extra tax', level: 'line', synonyms: ['extra tax'] },
  { key: 'fedPayable', label: 'FED payable', level: 'line', synonyms: ['fed', 'fed payable', 'federal excise', 'federal excise duty'] },
  { key: 'discount', label: 'Discount', level: 'line', synonyms: ['discount', 'disc'] },
  { key: 'fixedNotifiedValueOrRetailPrice', label: 'Retail price (3rd schedule)', level: 'line', synonyms: ['retail price', 'mrp', 'printed price', 'notified value', 'fixed value'] },
  { key: 'saleType', label: 'Sale type', level: 'line', synonyms: ['sale type', 'transaction type', 'supply type', 'type of sale'],
    sniff: v => share(v, s => SALE_TYPES.some(t => similarity(norm(t.name), norm(s)) > 0.75)) },
  { key: 'sroScheduleNo', label: 'SRO / schedule no.', level: 'line', synonyms: ['sro', 'sro no', 'sro schedule', 'schedule no', 'sro schedule no'] },
  { key: 'sroItemSerialNo', label: 'SRO item serial', level: 'line', synonyms: ['sro item', 'sro serial', 'item serial', 'sro item serial no'] },
  { key: 'salesTaxWithheldAtSource', label: 'ST withheld at source', level: 'line', synonyms: ['st withheld', 'withheld', 'stwh', 'sales tax withheld'] },
];

export interface MappingSuggestion {
  field: string;
  header: string | null;
  confidence: number; // 0..1
}

/** Stable signature for remembering a sheet layout. */
export function headerSignature(headers: string[]): string {
  return headers.map(norm).filter(Boolean).sort().join('|');
}

/**
 * Score every (field, header) pair from name similarity + content sniffing,
 * then assign greedily so each header is used once.
 */
export function suggestMapping(headers: string[], rows: Record<string, unknown>[]): MappingSuggestion[] {
  const sample = rows.slice(0, 50);
  const pairs: { field: string; header: string; score: number }[] = [];

  for (const f of TARGET_FIELDS) {
    for (const h of headers) {
      const nh = norm(h);
      let name = 0;
      for (const syn of f.synonyms) {
        if (nh === syn) { name = 1; break; }
        const sim = similarity(nh, syn);
        const contains = nh.includes(syn) || syn.includes(nh) ? 0.82 * Math.min(nh.length, syn.length) / Math.max(nh.length, syn.length) + 0.1 : 0;
        name = Math.max(name, sim * 0.9, contains);
      }
      const content = f.sniff ? f.sniff(sample.map(r => r[h])) : 0;
      const score = f.sniff ? Math.max(name, name * 0.6 + content * 0.5, content * 0.75) : name;
      if (score >= 0.55) pairs.push({ field: f.key, header: h, score: Math.min(1, score) });
    }
  }
  pairs.sort((a, b) => b.score - a.score);
  const usedH = new Set<string>(), usedF = new Set<string>();
  const result = new Map<string, MappingSuggestion>();
  for (const p of pairs) {
    if (usedH.has(p.header) || usedF.has(p.field)) continue;
    usedH.add(p.header); usedF.add(p.field);
    result.set(p.field, { field: p.field, header: p.header, confidence: p.score });
  }
  return TARGET_FIELDS.map(f => result.get(f.key) ?? { field: f.key, header: null, confidence: 0 });
}

/* ------------------------------ transforms ------------------------------ */

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** Accepts Excel serials, YYYY-MM-DD, DD/MM/YYYY (Pakistani default), DD-MMM-YY. */
export function toIsoDate(v: unknown): string {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'number' && v > 20000 && v < 80000) {
    const d = new Date(Math.round((v - 25569) * 86400000));
    return d.toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(s);
  if (m) {
    const y = m[3].length === 2 ? '20' + m[3] : m[3];
    return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  m = /^(\d{1,2})[-\s]([a-z]{3})[a-z]*[-\s,]+(\d{2,4})$/i.exec(s);
  if (m) {
    const mo = MONTHS.indexOf(m[2].toLowerCase()) + 1;
    const y = m[3].length === 2 ? '20' + m[3] : m[3];
    if (mo) return `${y}-${String(mo).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  return s;
}

const num = (v: unknown): number => {
  if (typeof v === 'number') return v;
  const n = parseFloat(String(v ?? '').replace(/[,\s]|rs\.?|pkr/gi, ''));
  return isNaN(n) ? 0 : n;
};

function matchProvince(v: unknown, fallback: string): string {
  const s = norm(v);
  if (!s) return fallback;
  const aliases: Record<string, string> = { kpk: 'Khyber Pakhtunkhwa', kp: 'Khyber Pakhtunkhwa', ict: 'Capital Territory', islamabad: 'Capital Territory', ajk: 'Azad Jammu and Kashmir', gb: 'Gilgit Baltistan', lahore: 'Punjab', karachi: 'Sindh' };
  if (aliases[s]) return aliases[s];
  let best = fallback, score = 0;
  for (const p of PROVINCES) {
    const sc = similarity(norm(p), s);
    if (sc > score) { score = sc; best = p; }
  }
  return score > 0.6 ? best : fallback;
}

function matchUom(v: unknown): string {
  const s = norm(v);
  if (!s) return 'Numbers, pieces, units';
  const aliases: Record<string, string> = { pcs: 'Numbers, pieces, units', pc: 'Numbers, pieces, units', nos: 'Numbers, pieces, units', no: 'Numbers, pieces, units', units: 'Numbers, pieces, units', unit: 'Numbers, pieces, units', kgs: 'KG', kg: 'KG', ltr: 'Liter', litre: 'Liter', ltrs: 'Liter', mtr: 'Meter', m: 'Meter', sqm: 'Square Metre', dzn: 'Dozen', kwh: 'KWH' };
  if (aliases[s]) return aliases[s];
  return UOMS.find(u => norm(u) === s) ?? UOMS.reduce((a, u) => similarity(norm(u), s) > similarity(norm(a), s) ? u : a, UOMS[0]);
}

function matchSaleType(v: unknown, fallback: string): string {
  const s = norm(v);
  if (!s) return fallback;
  let best = fallback, score = 0;
  for (const t of SALE_TYPES) {
    const sc = similarity(norm(t.name), s);
    if (sc > score) { score = sc; best = t.name; }
  }
  return score > 0.55 ? best : fallback;
}

function hs(v: unknown): string {
  const d = String(v ?? '').replace(/[^0-9]/g, '');
  return d.length === 8 ? `${d.slice(0, 4)}.${d.slice(4)}` : String(v ?? '').trim();
}

export interface BuildResult {
  invoices: Invoice[];
  rowToInvoice: number[]; // source row index → invoice index
}

/** Turn mapped rows into invoices; rows sharing an invoice no. become lines of one invoice. */
export function buildInvoices(rows: Record<string, unknown>[], map: Record<string, string | null>, biz: Business, batchId: string): BuildResult {
  const get = (r: Record<string, unknown>, key: string) => { const h = map[key]; return h ? r[h] : undefined; };
  const groups = new Map<string, number[]>();
  rows.forEach((r, i) => {
    const key = map['invoiceNo'] ? String(get(r, 'invoiceNo') ?? '').trim() || `__row${i}` : `__row${i}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(i);
  });

  const invoices: Invoice[] = [];
  const rowToInvoice: number[] = new Array(rows.length);
  let auto = 0;
  for (const [key, idxs] of groups) {
    const first = rows[idxs[0]];
    const ntn = cleanNtn(String(get(first, 'buyerNTNCNIC') ?? ''));
    const regRaw = norm(get(first, 'buyerRegistrationType'));
    const registrationType: RegistrationType = regRaw.startsWith('un') ? 'Unregistered'
      : regRaw.startsWith('reg') ? 'Registered'
      : ntn.length === 7 || ntn.length === 9 ? 'Registered' : 'Unregistered';
    const buyer = {
      ntnCnic: ntn,
      name: String(get(first, 'buyerBusinessName') ?? '').trim(),
      province: matchProvince(get(first, 'buyerProvince'), biz.province),
      address: String(get(first, 'buyerAddress') ?? '').trim() || '-',
      registrationType,
    };
    const typeRaw = norm(get(first, 'invoiceType'));
    const items: LineItem[] = idxs.map(ri => {
      const r = rows[ri];
      const saleType = matchSaleType(get(r, 'saleType'), biz.defaultSaleType);
      const base = emptyLine(saleType);
      const rateIn = get(r, 'rate');
      const line: LineItem = {
        ...base,
        hsCode: hs(get(r, 'hsCode')),
        productDescription: String(get(r, 'productDescription') ?? '').trim(),
        uoM: matchUom(get(r, 'uoM')),
        quantity: num(get(r, 'quantity')) || 1,
        unitPrice: num(get(r, 'unitPrice')),
        valueSalesExcludingST: num(get(r, 'valueSalesExcludingST')),
        rate: rateIn !== undefined && rateIn !== '' ? normaliseRate(rateIn) : base.rate,
        extraTax: num(get(r, 'extraTax')),
        fedPayable: num(get(r, 'fedPayable')),
        discount: num(get(r, 'discount')),
        fixedNotifiedValueOrRetailPrice: num(get(r, 'fixedNotifiedValueOrRetailPrice')),
        sroScheduleNo: String(get(r, 'sroScheduleNo') ?? '').trim(),
        sroItemSerialNo: String(get(r, 'sroItemSerialNo') ?? '').trim(),
        salesTaxWithheldAtSource: num(get(r, 'salesTaxWithheldAtSource')),
      };
      if (!line.unitPrice && line.valueSalesExcludingST && line.quantity) line.unitPrice = line.valueSalesExcludingST / line.quantity;
      const computed = computeLine(line, buyer, biz.furtherTaxRate);
      // Keep sheet-provided tax amounts when present so mismatches surface instead of being silently overwritten.
      const stIn = get(r, 'salesTaxApplicable');
      if (map['salesTaxApplicable'] && stIn !== '' && stIn !== undefined) computed.salesTaxApplicable = num(stIn);
      const ftIn = get(r, 'furtherTax');
      if (map['furtherTax'] && ftIn !== '' && ftIn !== undefined) computed.furtherTax = num(ftIn);
      computed.totalValues = Math.round((computed.valueSalesExcludingST + computed.salesTaxApplicable + computed.furtherTax + computed.extraTax + computed.fedPayable - computed.discount) * 100) / 100;
      if (!saleTypeDef(computed.saleType)) computed.saleType = biz.defaultSaleType;
      return computed;
    });
    const invIndex = invoices.length;
    idxs.forEach(ri => rowToInvoice[ri] = invIndex);
    const at = nowIso();
    invoices.push({
      id: uid('i_'), businessId: biz.id,
      localRef: key.startsWith('__row') ? `${biz.invoicePrefix}IMP-${batchId.slice(-4).toUpperCase()}-${++auto}` : key,
      invoiceType: typeRaw.includes('debit') ? 'Debit Note' : 'Sale Invoice',
      invoiceDate: toIsoDate(get(first, 'invoiceDate')),
      buyer, items, invoiceRefNo: String(get(first, 'invoiceRefNo') ?? '').trim(),
      environment: biz.environment, status: 'draft', issues: [], attempts: 0, batchId,
      createdAt: at, updatedAt: at, history: [{ at, actor: 'import', action: 'Imported from spreadsheet' }],
    });
  }
  return { invoices, rowToInvoice };
}
