/**
 * FBR payload field names must match rasid-web/src/app/core/models.ts exactly
 * (PRAL v1.12). Reads the interfaces from the web source and compares them with
 * the API's zod schema and the worker's payload builder.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { toPayload } from '../src/lib/fbr-payload.js';
import type { InvoiceDto } from '../src/repos/invoices.js';
import { FbrInvoicePayload, FbrItem } from '../src/schemas/invoice.js';

const models = fs.readFileSync(fileURLToPath(new URL('../../rasid-web/src/app/core/models.ts', import.meta.url)), 'utf8');

/** Field names of `export interface <name> { ... }`, with ? marking optional ones. */
function fields(name: string): { required: string[]; optional: string[] } {
  const body = new RegExp(`export interface ${name} \\{([\\s\\S]*?)\\n\\}`).exec(models)?.[1];
  assert.ok(body, `interface ${name} not found in models.ts`);
  const names = [...body.matchAll(/^\s+(\w+)(\??):/gm)];
  return { required: names.filter(m => !m[2]).map(m => m[1]!).sort(), optional: names.filter(m => m[2]).map(m => m[1]!).sort() };
}
const keys = (o: object) => Object.keys(o).sort();

test('zod FbrItem has exactly the FbrItem fields of models.ts', () => {
  const web = fields('FbrItem');
  assert.equal(web.optional.length, 0);
  assert.deepEqual(keys(FbrItem.shape), web.required);
});

test('zod FbrInvoicePayload has exactly the FbrInvoicePayload fields of models.ts', () => {
  const web = fields('FbrInvoicePayload');
  assert.deepEqual(keys(FbrInvoicePayload.shape), [...web.required, ...web.optional].sort());
  assert.deepEqual(web.optional, ['scenarioId']);
});

test("the worker's payload builder emits exactly those fields, and nothing else", () => {
  const inv = {
    invoiceType: 'Sale Invoice', invoiceDate: '2026-10-18', invoiceRefNo: '', environment: 'sandbox', scenarioId: undefined,
    buyer: { ntnCnic: '441-0235', name: 'Metro', province: 'Sindh', address: 'Karachi', registrationType: 'Registered' },
    items: [{ hsCode: '1701.9910', productDescription: 'Sugar', rate: '18%', uoM: 'KG', quantity: 10, unitPrice: 155, totalValues: 1829,
      valueSalesExcludingST: 1550, fixedNotifiedValueOrRetailPrice: 0, salesTaxApplicable: 279, salesTaxWithheldAtSource: 0, extraTax: 0,
      furtherTax: 0, sroScheduleNo: '', fedPayable: 0, discount: 0, saleType: 'Goods at Reduced Rate', sroItemSerialNo: '' }],
  } as unknown as InvoiceDto;
  const p = toPayload(inv, { ntnCnic: '123-4567', name: 'Al-Noor', province: 'Punjab', address: 'Lahore' });
  const web = fields('FbrInvoicePayload');
  assert.deepEqual(keys(p), [...web.required, ...web.optional].sort());
  assert.deepEqual(keys(p.items[0]!), fields('FbrItem').required);
  assert.equal(p.sellerNTNCNIC, '1234567');
  assert.equal(p.buyerNTNCNIC, '4410235');
  assert.equal(p.scenarioId, 'SN005');
  assert.ok(FbrInvoicePayload.safeParse(p).success);

  const prod = toPayload({ ...inv, environment: 'production' } as InvoiceDto, { ntnCnic: '1234567', name: 'A', province: 'Punjab', address: 'L' });
  assert.equal('scenarioId' in prod, false);
});

test("the API's sale types (sale_types seed) match rasid-web's SALE_TYPES: names, scenarios and flags", async () => {
  const { SALE_TYPE_SEED } = await import('../src/lib/sale-types.js');
  const ref = fs.readFileSync(fileURLToPath(new URL('../../rasid-web/src/app/core/fbr-reference.ts', import.meta.url)), 'utf8');
  const block = /export const SALE_TYPES[^=]*= \[([\s\S]*?)\n\];/.exec(ref)?.[1];
  assert.ok(block, 'SALE_TYPES not found in fbr-reference.ts');
  const web = block.split('\n').filter(l => l.includes('name:')).map(l => ({
    name: /name: '([^']+)'/.exec(l)![1]!,
    scenarioId: /scenario: '(SN\d{3})'/.exec(l)![1]!,
    usesRetailPrice: /usesRetailPrice: true/.test(l),
    exempt: /exempt: true/.test(l),
  }));
  assert.equal(web.length, 24);
  assert.deepEqual(SALE_TYPE_SEED.map(t => ({ name: t.name, scenarioId: t.scenarioId, usesRetailPrice: !!t.usesRetailPrice, exempt: !!t.exempt })), web);
});
