import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { startTestDb, type TestDb } from './helpers/db.js';

const tdb: TestDb = await startTestDb();
const { startApp, createTenant, signIn, invoiceBody } = await import('./helpers/http.js');
const { closeDb } = await import('../src/db/client.js');
const s = await import('../src/db/schema.js');

const app = await startApp();
const A = await createTenant(tdb, 'alpha', { prefix: 'ANT-' });
const B = await createTenant(tdb, 'bravo');
const a = await signIn(app.base, A);
const b = await signIn(app.base, B);
const inv = (f: { businessId: string }, rest = '') => `/businesses/${f.businessId}/invoices${rest}`;

/** Marks an invoice posted the way the worker will (as the owner, bypassing the API). */
const markPosted = (id: string, irn: string) =>
  tdb.admin.update(s.invoices).set({ status: 'posted', fbrInvoiceNumber: irn, postedAt: new Date() }).where(eq(s.invoices.id, id));

after(async () => { await app.close(); await closeDb(); await tdb.stop(); });

describe('invoices', () => {
  test('create allocates the next invoice number and returns the web Invoice shape', async () => {
    const r = await a.post(inv(A), invoiceBody());
    assert.equal(r.status, 201, r.text);
    assert.equal(r.body.localRef, 'ANT-00001');
    assert.equal(r.body.status, 'draft');
    assert.equal(r.body.businessId, A.businessId);
    assert.equal(r.body.items.length, 1);
    assert.equal(r.body.items[0].valueSalesExcludingST, 1550);
    assert.equal(r.body.items[0].unitPrice, 155);
    assert.equal(r.body.items[0].lineNo, undefined);
    assert.deepEqual(r.body.history.map((h: { action: string }) => h.action), ['Created']);

    const got = await a.get(inv(A, `/${r.body.id}`));
    assert.deepEqual(got.body, r.body);
    assert.equal((await a.post(inv(A), invoiceBody())).body.localRef, 'ANT-00002');
  });

  test('client ids and invoice numbers are kept; duplicates are 409', async () => {
    const r = await a.post(inv(A), invoiceBody({ id: 'i_client1', localRef: 'MANUAL-1' }));
    assert.equal(r.status, 201, r.text);
    assert.equal(r.body.id, 'i_client1');
    assert.equal((await a.post(inv(A), invoiceBody({ localRef: 'MANUAL-1' }))).status, 409);
    const dupId = await a.post(inv(A), invoiceBody({ id: 'i_client1' }));
    assert.equal(dupId.status, 409);
    assert.match(dupId.body.message, /id already exists/);
  });

  test('bodies are validated with field paths', async () => {
    const r = await a.post(inv(A), invoiceBody({ invoiceDate: '01/10/2026', items: [{ ...invoiceBody().items[0], quantity: 'ten' }] }));
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'VALIDATION');
    const paths = r.body.issues.map((i: { path: string }) => i.path);
    assert.ok(paths.includes('invoiceDate') && paths.includes('items.0.quantity'), JSON.stringify(paths));

    const dn = await a.post(inv(A), invoiceBody({ invoiceType: 'Debit Note', invoiceRefNo: '' }));
    assert.equal(dn.status, 400);
    assert.equal(dn.body.issues[0].path, 'invoiceRefNo');
    assert.equal((await a.post(inv(A), invoiceBody({ items: [] }))).status, 400);
    assert.equal((await a.post(inv(A), invoiceBody({ status: 'posted' }))).status, 400);
  });

  test('list filters and pages with a stable cursor', async () => {
    const C = await createTenant(tdb, 'charlie');
    const c = await signIn(app.base, C);
    for (let i = 0; i < 7; i++) {
      const r = await c.post(inv(C), invoiceBody({
        invoiceDate: `2026-09-0${i + 1}`,
        buyer: { ...invoiceBody().buyer, name: i % 2 ? 'Imtiaz Super Market' : 'Metro Cash & Carry' },
        status: i < 2 ? 'validated' : 'draft',
      }));
      assert.equal(r.status, 201);
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const r: { body: { items: { id: string; createdAt: string }[]; nextCursor: string | null } } =
        await c.get(inv(C, `?limit=3${cursor ? `&cursor=${cursor}` : ''}`));
      seen.push(...r.body.items.map(i => i.id));
      cursor = r.body.nextCursor;
      pages++;
    } while (cursor);
    assert.equal(pages, 3);
    assert.equal(new Set(seen).size, 7);

    const all = (await c.get(inv(C, '?limit=200'))).body.items as { id: string; createdAt: string }[];
    assert.deepEqual(seen, all.map(i => i.id)); // same order: newest first
    assert.ok(all.every((x, i) => i === 0 || all[i - 1]!.createdAt >= x.createdAt));

    assert.equal((await c.get(inv(C, '?status=validated'))).body.items.length, 2);
    assert.equal((await c.get(inv(C, '?status=draft,validated'))).body.items.length, 7);
    assert.equal((await c.get(inv(C, '?q=imtiaz'))).body.items.length, 3);
    assert.equal((await c.get(inv(C, '?q=100%25'))).body.items.length, 0); // % is literal, not a wildcard
    assert.equal((await c.get(inv(C, '?from=2026-09-03&to=2026-09-05'))).body.items.length, 3);
    assert.equal((await c.get(inv(C, '?status=bogus'))).status, 400);
    assert.equal((await c.get(inv(C, '?cursor=not-a-cursor'))).status, 400);
  });

  test('drafts can be edited; posted invoices cannot be edited or deleted', async () => {
    const created = (await a.post(inv(A), invoiceBody())).body;
    const edited = await a.put(inv(A, `/${created.id}`), invoiceBody({ buyer: { ...invoiceBody().buyer, name: 'Hamid & Sons' }, status: 'validated' }));
    assert.equal(edited.status, 200, edited.text);
    assert.equal(edited.body.buyer.name, 'Hamid & Sons');
    assert.equal(edited.body.localRef, created.localRef);
    assert.deepEqual(edited.body.history.map((h: { action: string }) => h.action), ['Created', 'Edited']);

    await markPosted(created.id, '1234567DI1760000000001');
    const put = await a.put(inv(A, `/${created.id}`), invoiceBody());
    assert.equal(put.status, 409);
    assert.equal(put.body.code, 'NOT_EDITABLE');
    assert.match(put.body.message, /debit note/);
    assert.equal((await a.del(inv(A, `/${created.id}`))).status, 409);

    // The correction path: a debit note referencing the IRN.
    const dn = await a.post(inv(A), invoiceBody({ invoiceType: 'Debit Note', invoiceRefNo: '1234567DI1760000000001' }));
    assert.equal(dn.status, 201, dn.text);
  });

  test('invoices in flight or with an unknown outcome cannot be changed', async () => {
    const created = (await a.post(inv(A), invoiceBody())).body;
    await tdb.admin.update(s.invoices).set({ status: 'outcome_unknown' }).where(eq(s.invoices.id, created.id));
    const r = await a.del(inv(A, `/${created.id}`));
    assert.equal(r.status, 409);
    assert.match(r.body.message, /IRIS/);
  });

  test('delete removes a draft and its lines', async () => {
    const created = (await a.post(inv(A), invoiceBody())).body;
    assert.equal((await a.del(inv(A, `/${created.id}`))).status, 204);
    assert.equal((await a.get(inv(A, `/${created.id}`))).status, 404);
    assert.equal((await a.del(inv(A, `/${created.id}`))).status, 404);
    assert.equal((await tdb.admin.select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, created.id))).length, 0);
  });

  test('bulk import inserts valid invoices and reports the rest by index', async () => {
    const D = await createTenant(tdb, 'delta', { prefix: 'D-' });
    const d = await signIn(app.base, D);
    const r = await d.post(inv(D, '/bulk'), {
      invoices: [
        invoiceBody({ localRef: 'X-1' }),
        invoiceBody({ invoiceDate: 'yesterday' }),
        invoiceBody({ localRef: 'X-1' }), // duplicate within the chunk
        invoiceBody(),
        invoiceBody({ items: Array.from({ length: 3 }, () => invoiceBody().items[0]) }),
      ],
    });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.body.created.map((c: { index: number }) => c.index), [0, 3, 4]);
    assert.deepEqual(r.body.errors.map((e: { index: number }) => e.index), [1, 2]);
    assert.equal(r.body.errors[0].issues[0].path, 'invoiceDate');
    assert.match(r.body.errors[1].issues[0].message, /X-1 already exists/);
    assert.deepEqual(r.body.created.map((c: { invoice: { localRef: string } }) => c.invoice.localRef), ['X-1', 'D-00001', 'D-00002']);
    assert.equal(r.body.created[2].invoice.items.length, 3);
    assert.equal((await d.get(inv(D))).body.items.length, 3);
  });

  test('bulk import takes 500 invoices in one request', async () => {
    const E = await createTenant(tdb, 'echo');
    const e = await signIn(app.base, E);
    const r = await e.post(inv(E, '/bulk'), { invoices: Array.from({ length: 500 }, () => invoiceBody({ items: [invoiceBody().items[0], invoiceBody().items[0]] })) });
    assert.equal(r.status, 200, r.text.slice(0, 300));
    assert.equal(r.body.created.length, 500);
    assert.equal(r.body.errors.length, 0);
    assert.equal((await e.post(inv(E, '/bulk'), { invoices: Array.from({ length: 501 }, () => invoiceBody()) })).status, 400);
  });
});

describe('customers, products, import mappings', () => {
  const path = (rest: string) => `/businesses/${A.businessId}${rest}`;

  test('customer PUT creates then replaces; validation; delete', async () => {
    const c = { ntnCnic: '3820114', name: 'Imtiaz', province: 'Sindh', address: 'Karachi', registrationType: 'Registered' };
    const created = await a.put(path('/customers/c_1'), c);
    assert.equal(created.status, 200, created.text);
    assert.equal((await a.put(path('/customers/c_1'), { ...c, name: 'Imtiaz Super Market', phone: '021-1234567' })).body.phone, '021-1234567');
    const list = (await a.get(path('/customers'))).body;
    assert.deepEqual(list.map((x: { id: string; name: string }) => [x.id, x.name]), [['c_1', 'Imtiaz Super Market']]);

    const bad = await a.put(path('/customers/c_2'), { ...c, ntnCnic: '' });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.issues[0].path, 'ntnCnic');
    assert.equal((await a.put(path('/customers/c_3'), { ...c, ntnCnic: '' , registrationType: 'Unregistered' })).status, 200);
    assert.equal((await a.put(path('/customers/bad id!'), c)).status, 400);

    const posted = await a.post(path('/customers'), c);
    assert.equal(posted.status, 201);
    assert.match(posted.body.id, /^c_/);

    assert.equal((await a.del(path('/customers/c_1'))).status, 204);
    assert.equal((await a.get(path('/customers/c_1'))).status, 404);
  });

  test('an id used by another business cannot be taken over', async () => {
    await b.put(`/businesses/${B.businessId}/products/p_shared`, { name: 'B product', hsCode: '1', uoM: 'KG', saleType: 'x', rate: '18%', unitPrice: 1 });
    const r = await a.put(path('/products/p_shared'), { name: 'A product', hsCode: '1', uoM: 'KG', saleType: 'x', rate: '18%', unitPrice: 2 });
    assert.equal(r.status, 409);
    assert.equal((await b.get(`/businesses/${B.businessId}/products/p_shared`)).body.name, 'B product');
  });

  test('products CRUD', async () => {
    const p = { name: 'Basmati rice 25kg', hsCode: '1006.3090', uoM: 'KG', saleType: 'Goods at standard rate (default)', rate: '18%', unitPrice: 340 };
    assert.equal((await a.put(path('/products/p_1'), p)).status, 200);
    assert.equal((await a.get(path('/products/p_1'))).body.unitPrice, 340);
    assert.equal((await a.put(path('/products/p_1'), { ...p, unitPrice: 'cheap' })).status, 400);
    assert.equal((await a.del(path('/products/p_1'))).status, 204);
  });

  test('import mappings are unique per header signature', async () => {
    const m = { name: 'Sales March', signature: 'date|customer|qty|rate', map: { invoiceDate: 'Date', buyerName: 'Customer' } };
    const first = await a.post(path('/import-mappings'), { ...m, id: 'm_1' });
    assert.equal(first.status, 200, first.text);
    const second = await a.post(path('/import-mappings'), { ...m, id: 'm_2', name: 'Sales April', map: { invoiceDate: 'Inv Date' } });
    assert.equal(second.body.id, 'm_1'); // replaced in place
    const list = (await a.get(path('/import-mappings'))).body;
    assert.equal(list.length, 1);
    assert.equal(list[0].name, 'Sales April');
    assert.deepEqual(list[0].map, { invoiceDate: 'Inv Date' });
    assert.equal((await a.del(path('/import-mappings/m_1'))).status, 204);
    assert.equal((await a.del(path('/import-mappings/m_1'))).status, 404);
  });
});

describe('access', () => {
  test('another tenant\'s business is invisible: list, read, write, delete', async () => {
    const theirs = (await b.post(inv(B), invoiceBody())).body;
    assert.equal((await a.get(inv(B))).status, 404);
    assert.equal((await a.get(inv(B, `/${theirs.id}`))).status, 404);
    assert.equal((await a.put(inv(B, `/${theirs.id}`), invoiceBody())).status, 404);
    assert.equal((await a.del(inv(B, `/${theirs.id}`))).status, 404);
    assert.equal((await a.post(inv(B), invoiceBody())).status, 404);
    // Through A's own business path the id is filtered out by RLS.
    assert.equal((await a.get(inv(A, `/${theirs.id}`))).status, 404);
    assert.equal((await a.del(inv(A, `/${theirs.id}`))).status, 404);
    assert.equal((await b.get(inv(B, `/${theirs.id}`))).status, 200);
  });

  test('viewers can read but not write', async () => {
    const V = await createTenant(tdb, 'viewer', { role: 'viewer' });
    const v = await signIn(app.base, V);
    assert.equal((await v.get(inv(V))).status, 200);
    assert.equal((await v.post(inv(V), invoiceBody())).status, 403);
    assert.equal((await v.put(`/businesses/${V.businessId}/customers/c_x`, {})).status, 403);
  });

  test('writes need the CSRF header; reads need a session', async () => {
    const r = await a.req('POST', inv(A), invoiceBody(), { 'X-CSRF-Token': 'wrong' });
    assert.equal(r.status, 403);
    assert.equal((await fetch(`${app.base}${inv(A)}`)).status, 401);
  });
});


describe('businesses', () => {
  const profile = (over: Record<string, unknown> = {}) => ({
    name: 'Second Co', ntnCnic: '7654321', province: 'Sindh', address: 'Karachi', activity: 'Wholesaler', sector: 'FMCG',
    environment: 'sandbox', defaultSaleType: 'Goods at standard rate (default)', furtherTaxRate: 4, invoicePrefix: 'SEC-', nextInvoiceNo: 1, ...over,
  });

  test('an owner adds a business and becomes its owner; others cannot see it', async () => {
    const r = await a.post('/businesses', profile({ id: 'b_alpha_second' }));
    assert.equal(r.status, 201, r.text);
    assert.equal(r.body.id, 'b_alpha_second');
    assert.equal(r.body.hasSandboxToken, false);
    const mine = (await a.get('/businesses')).body.map((x: { id: string }) => x.id);
    assert.ok(mine.includes('b_alpha_second'));
    assert.ok(!(await b.get('/businesses')).body.some((x: { id: string }) => x.id === 'b_alpha_second'));
    assert.equal((await a.post(inv({ businessId: 'b_alpha_second' }), invoiceBody())).body.localRef, 'SEC-00001');
    assert.equal((await a.post('/businesses', profile({ id: 'b_alpha_second' }))).status, 409);
    assert.equal((await a.post('/businesses', profile({ ntnCnic: '12' }))).status, 400);
  });

  test('only owners update; switching environment is audited', async () => {
    const r = await a.put(`/businesses/${A.businessId}`, profile({ name: 'Alpha Renamed', invoicePrefix: 'ANT-', nextInvoiceNo: 500, environment: 'production' }));
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.name, 'Alpha Renamed');
    assert.equal(r.body.environment, 'production');
    const [row] = await tdb.admin.select().from(s.auditLog).where(eq(s.auditLog.action, 'environment_production'));
    assert.equal(row?.businessId, A.businessId);
    assert.equal((await b.put(`/businesses/${A.businessId}`, profile())).status, 404);
    const V = await createTenant(tdb, 'acct', { role: 'accountant' });
    await tdb.admin.insert(s.memberships).values({ userId: V.userId, businessId: A.businessId, role: 'accountant' });
    const acct = await signIn(app.base, V);
    assert.equal((await acct.put(`/businesses/${A.businessId}`, profile())).status, 403);
    assert.equal((await acct.post('/businesses', profile())).status, 403);
    await a.put(`/businesses/${A.businessId}`, profile({ name: 'Alpha', invoicePrefix: 'ANT-', nextInvoiceNo: 500 }));
  });

  test('further tax: dated changes are stored sorted, one per date, and kept on create', async () => {
    const changes = [{ rate: 5, from: '2027-07-01' }, { rate: 4, from: '2026-07-01' }];
    const r = await a.put(`/businesses/${A.businessId}`, profile({ name: 'Alpha', invoicePrefix: 'ANT-', nextInvoiceNo: 500, furtherTaxRates: changes }));
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.body.furtherTaxRates, [{ rate: 4, from: '2026-07-01' }, { rate: 5, from: '2027-07-01' }]);
    assert.deepEqual((await a.get('/businesses')).body.find((x: { id: string }) => x.id === A.businessId).furtherTaxRates, r.body.furtherTaxRates);
    assert.equal((await a.put(`/businesses/${A.businessId}`, profile({ furtherTaxRates: [{ rate: 4, from: '2026-07-01' }, { rate: 5, from: '2026-07-01' }] }))).status, 400);
    assert.equal((await a.put(`/businesses/${A.businessId}`, profile({ furtherTaxRates: [{ rate: 101, from: '2026-07-01' }] }))).status, 400);
    assert.equal((await a.put(`/businesses/${A.businessId}`, profile({ furtherTaxRates: [{ rate: 4, from: '2026-02-30' }] }))).status, 400);
    const created = await a.post('/businesses', profile({ id: 'b_alpha_third', furtherTaxRates: [{ rate: 3, from: '2026-01-01' }] }));
    assert.deepEqual(created.body.furtherTaxRates, [{ rate: 3, from: '2026-01-01' }]);
    assert.deepEqual((await a.post('/businesses', profile({ id: 'b_alpha_fourth' }))).body.furtherTaxRates, [], 'optional');
    await a.put(`/businesses/${A.businessId}`, profile({ name: 'Alpha', invoicePrefix: 'ANT-', nextInvoiceNo: 500 }));
  });

  test('numbers the browser assigned move the counter past them', async () => {
    assert.equal((await a.post(inv(A), invoiceBody({ localRef: 'ANT-00510' }))).status, 201);
    assert.equal((await a.post(inv(A), invoiceBody({ localRef: 'OTHER-99999' }))).status, 201);
    assert.equal((await a.post(inv(A), invoiceBody())).body.localRef, 'ANT-00511');
    const biz = (await a.get('/businesses')).body.find((x: { id: string }) => x.id === A.businessId);
    assert.equal(biz.nextInvoiceNo, 512);
  });
});
