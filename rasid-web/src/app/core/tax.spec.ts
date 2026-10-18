import { Business, Buyer, Invoice, LineItem } from './models';
import { cleanNtn, computeLine, emptyLine, invoiceTotals, normaliseRate, rateValue, round2, toPayload, validateInvoice } from './tax';

const SELLER: Business = {
  id: 'b1', name: 'Al-Noor Traders', ntnCnic: '123-4567', province: 'Punjab', address: 'Lahore', activity: 'Distributor', sector: 'FMCG',
  environment: 'sandbox', hasSandboxToken: true, hasProductionToken: false, defaultSaleType: 'Goods at standard rate (default)',
  furtherTaxRate: 4, invoicePrefix: 'ANT-', nextInvoiceNo: 1,
};
const REGISTERED: Buyer = { ntnCnic: '4410235', name: 'Metro', province: 'Sindh', address: 'Karachi', registrationType: 'Registered' };
const UNREGISTERED: Buyer = { ntnCnic: '3520212345671', name: 'Walk-in', province: 'Punjab', address: 'Lahore', registrationType: 'Unregistered' };

const line = (over: Partial<LineItem> = {}): LineItem => ({ ...emptyLine('Goods at standard rate (default)'), hsCode: '1701.9910', productDescription: 'Sugar', uoM: 'KG', quantity: 10, unitPrice: 155, ...over });
const invoice = (over: Partial<Invoice> = {}, buyer = REGISTERED): Invoice => ({
  id: 'i1', businessId: 'b1', localRef: 'ANT-00001', invoiceType: 'Sale Invoice', invoiceDate: '2026-10-18', buyer,
  items: [computeLine(line(), buyer, 4)], invoiceRefNo: '', environment: 'sandbox', status: 'draft', issues: [], attempts: 0,
  createdAt: '', updatedAt: '', history: [], ...over,
});
const codes = (inv: Invoice, seller = SELLER) => validateInvoice(inv, seller).map(i => i.code);

describe('rates', () => {
  it.each([['18%', 18], ['0%', 0], ['Exempt', 0], ['1.43%', 1.43], ['18% along with rupees 60 per kilogram', 18], ['', 0]])('rateValue(%s) = %s', (r, v) => expect(rateValue(r)).toBe(v));
  it.each<[unknown, string]>([[18, '18%'], [0.18, '18%'], ['18', '18%'], ['18 %', '18%'], ['17.5%', '17.5%'], ['exempt', 'Exempt'], ['', ''], ['n/a', 'n/a']])(
    'normaliseRate(%s) = %s', (input, out) => expect(normaliseRate(input)).toBe(out));
  it('round2 rounds half up at 2 decimals', () => {
    expect(round2(1.005)).toBe(1.01);
    expect(round2(2.675)).toBe(2.68);
    expect(round2(279)).toBe(279);
  });
});

describe('computeLine', () => {
  it('standard rate: value = qty × price, tax 18%, total', () => {
    expect(computeLine(line(), REGISTERED, 4)).toMatchObject({ valueSalesExcludingST: 1550, salesTaxApplicable: 279, furtherTax: 0, totalValues: 1829 });
  });

  it('unregistered buyer pays further tax on the value', () => {
    expect(computeLine(line(), UNREGISTERED, 4)).toMatchObject({ salesTaxApplicable: 279, furtherTax: 62, totalValues: 1891 });
  });

  it('no further tax on exempt or zero-rated goods', () => {
    expect(computeLine(line({ saleType: 'Exempt Goods', rate: 'Exempt' }), UNREGISTERED, 4)).toMatchObject({ salesTaxApplicable: 0, furtherTax: 0, totalValues: 1550 });
    expect(computeLine(line({ saleType: 'Goods at zero-rate', rate: '0%' }), UNREGISTERED, 4)).toMatchObject({ salesTaxApplicable: 0, furtherTax: 0 });
  });

  it('3rd schedule goods: tax on the printed retail price', () => {
    const l = computeLine(line({ saleType: '3rd Schedule Goods', quantity: 72, unitPrice: 80, fixedNotifiedValueOrRetailPrice: 7200 }), REGISTERED, 4);
    expect(l.valueSalesExcludingST).toBe(5760);
    expect(l.salesTaxApplicable).toBe(1296);   // 18% of 7200, not of 5760
  });

  it('reduced rate', () => {
    expect(computeLine(line({ saleType: 'Goods at Reduced Rate', rate: '5%' }), REGISTERED, 4).salesTaxApplicable).toBe(77.5);
  });

  it('extra tax and FED add to the total, discount subtracts', () => {
    expect(computeLine(line({ extraTax: 10, fedPayable: 20, discount: 50 }), REGISTERED, 4).totalValues).toBe(1829 + 10 + 20 - 50);
  });

  it('keeps a typed value when there is no unit price', () => {
    expect(computeLine(line({ unitPrice: 0, valueSalesExcludingST: 1000 }), REGISTERED, 4)).toMatchObject({ valueSalesExcludingST: 1000, salesTaxApplicable: 180 });
  });

  it('rounds to paisa', () => {
    expect(computeLine(line({ quantity: 3, unitPrice: 33.333 }), REGISTERED, 4)).toMatchObject({ valueSalesExcludingST: 100, salesTaxApplicable: 18 });
    expect(computeLine(line({ quantity: 7, unitPrice: 12.345 }), REGISTERED, 4).salesTaxApplicable).toBe(15.56);
  });

  it('invoiceTotals sums every line', () => {
    const items = [computeLine(line(), UNREGISTERED, 4), computeLine(line({ quantity: 1, unitPrice: 100, discount: 5 }), UNREGISTERED, 4)];
    expect(invoiceTotals(items)).toEqual({ value: 1650, salesTax: 297, furtherTax: 66, other: -5, total: 2008 });
  });
});

describe('validateInvoice (client-side FBR rules)', () => {
  it('a correct invoice has no issues', () => {
    expect(validateInvoice(invoice(), SELLER)).toEqual([]);
    expect(validateInvoice(invoice({}, UNREGISTERED), SELLER)).toEqual([]);
  });

  it.each<[string, Partial<Invoice>, string]>([
    ['date not ISO', { invoiceDate: '18/10/2026' }, '0005'],
    ['buyer name missing', { buyer: { ...REGISTERED, name: ' ' } }, '0010'],
    ['registered buyer without NTN', { buyer: { ...REGISTERED, ntnCnic: '' } }, '0009'],
    ['NTN with wrong length', { buyer: { ...REGISTERED, ntnCnic: '12345' } }, '0002'],
    ['self-invoicing', { buyer: { ...REGISTERED, ntnCnic: '1234567' } }, '0058'],
    ['unknown province', { buyer: { ...REGISTERED, province: 'Atlantis' } }, '0074'],
    ['debit note without the original IRN', { invoiceType: 'Debit Note', invoiceRefNo: '' }, '0026'],
    ['no lines', { items: [] }, 'L-001'],
  ])('%s → %s', (_label, over, code) => expect(codes(invoice(over))).toContain(code));

  it.each<[string, Partial<LineItem>, string]>([
    ['HS code not 0000.0000', { hsCode: '1701' }, '0019'],
    ['unknown sale type', { saleType: 'Magic' }, '0013'],
    ['no description', { productDescription: '' }, 'L-002'],
    ['no quantity', { quantity: 0 }, '0098'],
    ['no value', { valueSalesExcludingST: 0 }, '0021'],
    ['tax off by more than Rs 1', { salesTaxApplicable: 270 }, '0104'],
  ])('line: %s → %s', (_label, over, code) => {
    const inv = invoice();
    inv.items = [{ ...inv.items[0]!, ...over }];
    const issues = validateInvoice(inv, SELLER);
    expect(issues.map(i => i.code)).toContain(code);
    expect(issues.find(i => i.code === code)?.itemIndex).toBe(0);
  });

  it('tax within Rs 1 of the expected amount is accepted (FBR tolerance)', () => {
    const inv = invoice();
    inv.items = [{ ...inv.items[0]!, salesTaxApplicable: 278.5 }];
    expect(codes(inv)).toEqual([]);
  });

  it('a seller without a valid NTN cannot post', () => {
    expect(codes(invoice(), { ...SELLER, ntnCnic: '12' })).toContain('0401');
  });

  it('issues carry the field and help text for the cell highlight', () => {
    const issue = validateInvoice(invoice({ buyer: { ...REGISTERED, ntnCnic: '12345' } }), SELLER)[0]!;
    expect(issue).toMatchObject({ code: '0002', field: 'ntnCnic', source: 'local' });
    expect(issue.hint).toBeTruthy();
  });
});

describe('toPayload', () => {
  const FBR_ITEM_FIELDS = ['hsCode', 'productDescription', 'rate', 'uoM', 'quantity', 'totalValues', 'valueSalesExcludingST', 'fixedNotifiedValueOrRetailPrice',
    'salesTaxApplicable', 'salesTaxWithheldAtSource', 'extraTax', 'furtherTax', 'sroScheduleNo', 'fedPayable', 'discount', 'saleType', 'sroItemSerialNo'];

  it('uses the exact v1.12 field names and drops unitPrice', () => {
    const p = toPayload(invoice(), SELLER);
    expect(Object.keys(p).sort()).toEqual(['buyerAddress', 'buyerBusinessName', 'buyerNTNCNIC', 'buyerProvince', 'buyerRegistrationType', 'invoiceDate',
      'invoiceRefNo', 'invoiceType', 'items', 'scenarioId', 'sellerAddress', 'sellerBusinessName', 'sellerNTNCNIC', 'sellerProvince']);
    expect(Object.keys(p.items[0]!).sort()).toEqual([...FBR_ITEM_FIELDS].sort());
  });

  it('cleans NTNs and takes the seller from the business', () => {
    const p = toPayload(invoice({}, { ...REGISTERED, ntnCnic: '441-0235' }), SELLER);
    expect(p.sellerNTNCNIC).toBe('1234567');
    expect(p.buyerNTNCNIC).toBe('4410235');
    expect(p.sellerBusinessName).toBe('Al-Noor Traders');
  });

  it('scenarioId only in sandbox: explicit, else from the sale type', () => {
    expect(toPayload(invoice({ scenarioId: 'SN026' }), SELLER).scenarioId).toBe('SN026');
    const reduced = invoice();
    reduced.items = [computeLine(line({ saleType: 'Goods at Reduced Rate', rate: '5%' }), REGISTERED, 4)];
    expect(toPayload(reduced, SELLER).scenarioId).toBe('SN005');
    expect('scenarioId' in toPayload(invoice({ environment: 'production', scenarioId: 'SN001' }), SELLER)).toBe(false);
  });

  it('rounds amounts to 2 decimals and quantity to 4', () => {
    const inv = invoice();
    inv.items = [{ ...inv.items[0]!, quantity: 1.234567, valueSalesExcludingST: 10.005, salesTaxApplicable: 1.8049, totalValues: 11.8099 }];
    const it = toPayload(inv, SELLER).items[0]!;
    expect(it).toMatchObject({ quantity: 1.2346, valueSalesExcludingST: 10.01, salesTaxApplicable: 1.8, totalValues: 11.81 });
  });

  it('cleanNtn keeps digits only', () => {
    expect(cleanNtn('35202-1234567-1')).toBe('3520212345671');
    expect(cleanNtn(' 441 0235 ')).toBe('4410235');
    expect(cleanNtn(undefined as unknown as string)).toBe('');
  });
});
