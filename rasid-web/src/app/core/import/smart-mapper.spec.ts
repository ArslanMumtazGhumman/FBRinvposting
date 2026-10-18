import * as XLSX from 'xlsx';
import { Business } from '../models';
import { validateInvoice } from '../tax';
import { parseSheet } from './parse-sheet';
import { sampleSheet } from './sample-sheet';
import { buildInvoices, headerSignature, suggestMapping, toIsoDate } from './smart-mapper';

const BIZ: Business = {
  id: 'b1', name: 'Al-Noor Traders', ntnCnic: '1234567', province: 'Punjab', address: 'Lahore', activity: 'Distributor', sector: 'FMCG',
  environment: 'sandbox', hasSandboxToken: true, hasProductionToken: false, defaultSaleType: 'Goods at standard rate (default)',
  furtherTaxRate: 4, invoicePrefix: 'ANT-', nextInvoiceNo: 1,
};

/** Rows → .xlsx bytes → parseSheet, exactly what the upload path does. */
function roundTrip(aoa: unknown[][]) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'October sales');
  return parseSheet(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer);
}
const mapOf = (headers: string[], rows: Record<string, unknown>[]) =>
  Object.fromEntries(suggestMapping(headers, rows).filter(s => s.header).map(s => [s.field, s.header]));

describe('header matching on the sample sheet', () => {
  const sheet = roundTrip(sampleSheet());
  const map = mapOf(sheet.headers, sheet.rows);

  it('reads the header row and every data row', () => {
    expect(sheet.headers).toEqual(['Bill #', 'Bill Date', 'Party Name', 'NTN', 'Province', 'City', 'PCT Code', 'Item Name', 'Unit', 'Qty', 'Rate/Unit', 'GST %', 'GST Amount']);
    expect(sheet.rows.length).toBe(61);
  });

  it('maps every column of the sample to the right FBR field', () => {
    expect(map).toEqual({
      invoiceNo: 'Bill #',
      invoiceDate: 'Bill Date',
      buyerBusinessName: 'Party Name',
      buyerNTNCNIC: 'NTN',
      buyerProvince: 'Province',
      buyerAddress: 'City',
      hsCode: 'PCT Code',
      productDescription: 'Item Name',
      uoM: 'Unit',
      quantity: 'Qty',
      unitPrice: 'Rate/Unit',
      rate: 'GST %',
      salesTaxApplicable: 'GST Amount',
    });
  });

  it('is confident about exact synonyms', () => {
    const conf = Object.fromEntries(suggestMapping(sheet.headers, sheet.rows).map(s => [s.field, s.confidence]));
    expect(conf['quantity']).toBe(1);   // "Qty"
    expect(conf['uoM']).toBe(1);        // "Unit"
    expect(conf['buyerNTNCNIC']).toBe(1);
  });

  it('uses each column once', () => {
    const used = Object.values(map);
    expect(new Set(used).size).toBe(used.length);
  });

  it('recognises columns by their content when the header says nothing', () => {
    const aoa = [['Col A', 'Col B', 'Col C', 'Col D'],
      ['2026-10-01', '4410235', '1701.9910', '18%'], ['2026-10-02', '3820114', '1006.3090', '18%'], ['2026-10-03', '5129903', '3923.2100', '18%']];
    const s = roundTrip(aoa);
    const m = mapOf(s.headers, s.rows);
    expect(m['invoiceDate']).toBe('Col A');
    expect(m['buyerNTNCNIC']).toBe('Col B');
    expect(m['hsCode']).toBe('Col C');
    expect(m['rate']).toBe('Col D');
  });

  it('skips title rows above the table and numbers duplicate headers', () => {
    const s = roundTrip([['October sales report'], ['Al-Noor Traders'], [], ['Invoice No', 'Date', 'Customer', 'Amount', 'Amount'], ['INV-1', '01/10/2026', 'Metro', 100, 18]]);
    expect(s.headers).toEqual(['Invoice No', 'Date', 'Customer', 'Amount', 'Amount (2)']);
    expect(s.rows).toEqual([{ 'Invoice No': 'INV-1', Date: '01/10/2026', Customer: 'Metro', Amount: 100, 'Amount (2)': 18 }]);
  });

  it('remembers a layout regardless of column order and spelling', () => {
    expect(headerSignature(['Bill #', 'NTN', 'Qty'])).toBe(headerSignature(['qty', ' ntn ', 'BILL #']));
    expect(headerSignature(['Bill #', 'NTN'])).not.toBe(headerSignature(['Bill #', 'STRN']));
  });
});

describe('DD/MM/YYYY and other dates', () => {
  it.each([
    ['05/10/2026', '2026-10-05'],   // Pakistani default: day first
    ['5/1/2026', '2026-01-05'],
    ['31.12.2026', '2026-12-31'],
    ['01-02-26', '2026-02-01'],
    ['2026-10-5', '2026-10-05'],
    ['2026-10-05T00:00:00', '2026-10-05'],
    ['17-Oct-26', '2026-10-17'],
    ['17 October 2026', '2026-10-17'],
    [46313, '2026-10-18'],          // Excel serial
    [45658, '2025-01-01'],
    ['', ''],
  ])('%s → %s', (input, iso) => expect(toIsoDate(input)).toBe(iso));

  it('leaves text it cannot read unchanged, so validation flags it', () => {
    expect(toIsoDate('next Tuesday')).toBe('next Tuesday');
  });

  it('sample sheet dates arrive as DD/MM/YYYY text and become ISO dates', () => {
    const sheet = roundTrip(sampleSheet());
    expect(sheet.rows[0]!['Bill Date']).toBe('01/10/2026');
    const { invoices } = buildInvoices(sheet.rows, mapOf(sheet.headers, sheet.rows), BIZ, 'bt_test');
    expect(invoices[0]!.invoiceDate).toBe('2026-10-01');
    expect(invoices.every(i => /^\d{4}-\d{2}-\d{2}$/.test(i.invoiceDate))).toBe(true);
  });

  it('real Excel date cells become ISO dates', () => {
    const s = roundTrip([['Invoice No', 'Date', 'Customer'], ['INV-1', new Date(2026, 9, 18), 'Metro']]);
    expect(s.rows[0]!['Date']).toBe('2026-10-18');
  });
});

describe('NTN cleanup and buyer details', () => {
  const sheet = roundTrip(sampleSheet());
  const { invoices } = buildInvoices(sheet.rows, mapOf(sheet.headers, sheet.rows), BIZ, 'bt_test');
  const byBuyer = (name: string) => invoices.find(i => i.buyer.name === name)!;

  it('strips dashes from a CNIC and treats a 13-digit CNIC as unregistered', () => {
    expect(byBuyer('Usman Kiryana').buyer).toMatchObject({ ntnCnic: '3520212345671', registrationType: 'Unregistered' });
  });

  it('treats a 7-digit NTN as registered', () => {
    expect(byBuyer('Metro Cash & Carry').buyer).toMatchObject({ ntnCnic: '4410235', registrationType: 'Registered' });
  });

  it('an explicit registration type column wins over the NTN length', () => {
    const rows = [{ No: 'A', NTN: '4410235', Type: 'Unregistered', Name: 'X' }];
    const [inv] = buildInvoices(rows, { invoiceNo: 'No', buyerNTNCNIC: 'NTN', buyerRegistrationType: 'Type', buyerBusinessName: 'Name' }, BIZ, 'bt').invoices;
    expect(inv!.buyer.registrationType).toBe('Unregistered');
  });

  it('normalises provinces, units and HS codes', () => {
    const kp = byBuyer('Peshawar Wholesale Mart');
    expect(kp.buyer.province).toBe('Khyber Pakhtunkhwa');                     // "KPK"
    expect(byBuyer('Imtiaz Super Market').buyer.address).toBe('Karachi');
    const sugar = invoices.flatMap(i => i.items).find(l => l.productDescription === 'Refined sugar 50kg')!;
    expect(sugar.hsCode).toBe('1701.9910');                                     // "17019910"
    expect(sugar.uoM).toBe('KG');                                               // "KGS"
    const rice = invoices.flatMap(i => i.items).find(l => l.productDescription === 'Basmati rice 25kg')!;
    expect(rice.uoM).toBe('KG');                                                // "kg"
  });

  it('a missing buyer province falls back to the business province', () => {
    const [inv] = buildInvoices([{ No: 'A', Name: 'X' }], { invoiceNo: 'No', buyerBusinessName: 'Name' }, BIZ, 'bt').invoices;
    expect(inv!.buyer.province).toBe('Punjab');
  });
});

describe('row grouping', () => {
  const sheet = roundTrip(sampleSheet());
  const map = mapOf(sheet.headers, sheet.rows);
  const { invoices, rowToInvoice } = buildInvoices(sheet.rows, map, BIZ, 'bt_test');

  it('rows sharing a bill number become lines of one invoice', () => {
    expect(invoices.length).toBe(31);                                   // SB-2400…SB-2429 (2 rows each) + SB-2430
    expect(invoices.filter(i => i.items.length === 2).length).toBe(30);
    const first = invoices.find(i => i.localRef === 'SB-2400')!;
    expect(first.items.map(l => l.productDescription)).toEqual(['Refined sugar 50kg', 'Basmati rice 25kg']);
  });

  it('keeps the sheet order of invoices and lines, and maps every row back to its invoice', () => {
    expect(invoices.slice(0, 3).map(i => i.localRef)).toEqual(['SB-2400', 'SB-2401', 'SB-2402']);
    expect(rowToInvoice.length).toBe(61);
    expect(rowToInvoice.slice(0, 4)).toEqual([0, 0, 1, 1]);
    expect(rowToInvoice[60]).toBe(30);
  });

  it('each row is its own invoice when no invoice number column is mapped', () => {
    const { invoiceNo: _drop, ...noGroup } = map;
    const r = buildInvoices(sheet.rows, noGroup, BIZ, 'bt_abcd');
    expect(r.invoices.length).toBe(61);
    expect(r.invoices[0]!.localRef).toBe('ANT-IMP-ABCD-1');
    expect(new Set(r.invoices.map(i => i.localRef)).size).toBe(61);
  });

  it('a blank bill number does not merge rows', () => {
    const rows = [{ No: '', Name: 'A' }, { No: '', Name: 'B' }, { No: 'X', Name: 'C' }];
    expect(buildInvoices(rows, { invoiceNo: 'No', buyerBusinessName: 'Name' }, BIZ, 'bt').invoices.length).toBe(3);
  });

  it('computes value from qty × unit price and keeps the sheet tax so mistakes surface', () => {
    const line = invoices[0]!.items[0]!;                                // 20 kg × 155
    expect(line.quantity).toBe(20);
    expect(line.valueSalesExcludingST).toBe(3100);
    expect(line.salesTaxApplicable).toBe(558);
    expect(line.totalValues).toBe(3658);
  });

  it('the three deliberate mistakes are caught, and only those', () => {
    const problems = invoices.map(inv => ({ ref: inv.localRef, codes: validateInvoice(inv, BIZ).map(i => i.code) })).filter(p => p.codes.length);
    expect(problems).toEqual([
      { ref: 'SB-2403', codes: ['0019'] },   // row 8: HS "1701"
      { ref: 'SB-2407', codes: ['0104'] },   // row 16: tax at 17%
      { ref: 'SB-2430', codes: ['0010'] },   // no buyer name
    ]);
  });
});
