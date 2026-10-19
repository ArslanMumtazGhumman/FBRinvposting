/**
 * The three guarantees from the brief, checked against every endpoint:
 *  1. FBR tokens never leave the server (no response body or header carries a token or its ciphertext).
 *  2. Tenant isolation: user A cannot read, change or post business B's data.
 *  3. Posting is idempotent: one FBR call per invoice, however often or concurrently it is posted.
 * Endpoints are enumerated from ROUTERS, so a new route without a case here fails the suite.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { RedisContainer } from '@testcontainers/redis';
import { eq } from 'drizzle-orm';
import { startTestDb, type TestDb } from './helpers/db.js';

/* ---------- fake FBR ---------- */
interface Seen { auth: string; path: string; buyer?: string }
const seen: Seen[] = [];
let irn = 0;
const fake = http.createServer((req, res) => {
  let raw = '';
  req.on('data', c => { raw += c; });
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : {};
    seen.push({ auth: req.headers.authorization ?? '', path: req.url ?? '', buyer: body.buyerBusinessName });
    const url = req.url ?? '';
    if (url.includes('postinvoicedata')) {
      const n = ++irn;
      return setTimeout(() => res.end(JSON.stringify({ invoiceNumber: `SEC${String(n).padStart(8, '0')}`, dated: '2026-10-18 10:00:00',
        validationResponse: { statusCode: '00', status: 'Valid', invoiceStatuses: [{ itemSNo: '1', statusCode: '00', invoiceNo: `SEC${n}-1` }] } })), 60);
    }
    if (url.includes('validateinvoicedata')) return res.end(JSON.stringify({ validationResponse: { statusCode: '00', status: 'Valid', invoiceStatuses: [] } }));
    if (url.includes('Get_Reg_Type')) return res.end(JSON.stringify({ REGISTRATION_TYPE: 'Registered' }));
    res.end('[]');
  });
}).listen(0);
await new Promise(r => fake.once('listening', r));

const redisC = await new RedisContainer('redis:7-alpine').start();
process.env.REDIS_URL = redisC.getConnectionUrl();
process.env.FBR_BASE_URL = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
process.env.FBR_TIMEOUT_MS = '2000';
process.env.BATCH_POLL_MS = '50';
const tdb: TestDb = await startTestDb();

const { startApp, createTenant, signIn, invoiceBody, Client } = await import('./helpers/http.js');
const { ROUTERS } = await import('../src/app.js');
const { closeDb } = await import('../src/db/client.js');
const { closeQueue, enqueuePosts } = await import('../src/queue/posting.js');
const { startPostWorker } = await import('../src/queue/worker.js');
const { sealReferenceToken } = await import('../src/reference/token.js');
const s = await import('../src/db/schema.js');

const app = await startApp();
const worker = startPostWorker({ concurrency: 10, perBusiness: 3 });
const A = await createTenant(tdb, 'alpha');
const B = await createTenant(tdb, 'bravo');
const a = await signIn(app.base, A);
const b = await signIn(app.base, B);

const TOKENS = {
  aSandbox: 'alpha-sandbox-token-7f3a9c2e5b1d4068',
  aProduction: 'alpha-production-token-1c8e4b7a2f9d3065',
  bSandbox: 'bravo-sandbox-token-9d2c6f1a8e3b5074',
};
/** Rasid's own PRAL token for reference lists (set by reference-cli in real deployments). */
const REFERENCE_TOKEN = 'rasid-reference-token-4e8b1f6a9c2d7035';
await tdb.admin.insert(s.referenceCredential).values(sealReferenceToken(REFERENCE_TOKEN));
for (const [client, f, env, token] of [[a, A, 'sandbox', TOKENS.aSandbox], [a, A, 'production', TOKENS.aProduction], [b, B, 'sandbox', TOKENS.bSandbox]] as const) {
  assert.equal((await client.put(`/businesses/${f.businessId}/credentials/${env}`, { token })).status, 200);
}

after(async () => {
  await worker.close(); await closeQueue(); await app.close(); await closeDb(); await tdb.stop(); await redisC.stop(); fake.close();
});

const settled = async (id: string) => {
  for (let i = 0; i < 200; i++) {
    const [row] = await tdb.admin.select().from(s.invoices).where(eq(s.invoices.id, id));
    if (row && !['queued', 'posting'].includes(row.status)) return row;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error(`invoice ${id} did not settle`);
};
const withBuyer = (name: string, over: Record<string, unknown> = {}) => {
  const body = invoiceBody(over);
  return { ...body, buyer: { ...body.buyer, name } };
};
const profile = (over: Record<string, unknown> = {}) => ({
  name: 'Biz', ntnCnic: '1234567', province: 'Punjab', address: 'Lahore', activity: 'Other', sector: 'Other', environment: 'sandbox',
  defaultSaleType: 'Goods at standard rate (default)', furtherTaxRate: 4, invoicePrefix: 'INV-', nextInvoiceNo: 1, ...over,
});
const fbrPayload = {
  invoiceType: 'Sale Invoice', invoiceDate: '2026-10-18', sellerNTNCNIC: '1234567', sellerBusinessName: 'Biz', sellerProvince: 'Punjab', sellerAddress: 'Lahore',
  buyerNTNCNIC: '4410235', buyerBusinessName: 'Metro', buyerProvince: 'Sindh', buyerAddress: 'Karachi', buyerRegistrationType: 'Registered', invoiceRefNo: '',
  items: [{ hsCode: '1701.9910', productDescription: 'Sugar', rate: '18%', uoM: 'KG', quantity: 1, totalValues: 118, valueSalesExcludingST: 100, fixedNotifiedValueOrRetailPrice: 0,
    salesTaxApplicable: 18, salesTaxWithheldAtSource: 0, extraTax: 0, furtherTax: 0, sroScheduleNo: '', fedPayable: 0, discount: 0, saleType: 'Goods at standard rate (default)', sroItemSerialNo: '' }],
};

/** Every route as "METHOD /api/path", from the app's own router list. */
const ROUTES = ROUTERS.flatMap(([mount, router]) => (router.stack as { route?: { path: string; methods: Record<string, boolean> } }[])
  .flatMap(l => (l.route ? Object.keys(l.route.methods).map(m => `${m.toUpperCase()} ${mount}${l.route!.path === '/' ? '' : l.route!.path}`) : [])));

/* ---------- business B's data, as a target for A ---------- */
interface Ids { invoice: string; posted: string; customer: string; product: string; mapping: string; batch: string }
async function seedData(client: InstanceType<typeof Client>, f: { businessId: string }, tag: string): Promise<Ids> {
  const base = `/businesses/${f.businessId}`;
  const invoice = (await client.post(`${base}/invoices`, withBuyer(`${tag} draft`))).body.id;
  const toPost = (await client.post(`${base}/invoices`, withBuyer(`${tag} posted`))).body.id;
  const queued = await client.post(`${base}/invoices/${toPost}/post`);
  await settled(toPost);
  const customer = (await client.post(`${base}/customers`, { ntnCnic: '4410235', name: `${tag} customer`, province: 'Punjab', registrationType: 'Registered' })).body.id;
  const product = (await client.post(`${base}/products`, { name: `${tag} product`, hsCode: '1701.9910', uoM: 'KG', saleType: 'Goods at standard rate (default)', rate: '18%', unitPrice: 155 })).body.id;
  const mapping = (await client.post(`${base}/import-mappings`, { name: tag, signature: `${tag}|sig`, map: { invoiceNo: 'Bill #' } })).body.id;
  return { invoice, posted: toPost, customer, product, mapping, batch: queued.body.batchId };
}

/** A snapshot of everything stored for a business (to prove nothing changed). */
async function snapshot(businessId: string) {
  const [inv, items, cus, pro, map, cred, biz] = await Promise.all([
    tdb.admin.select().from(s.invoices).where(eq(s.invoices.businessId, businessId)),
    tdb.admin.select().from(s.invoiceItems).where(eq(s.invoiceItems.businessId, businessId)),
    tdb.admin.select().from(s.customers).where(eq(s.customers.businessId, businessId)),
    tdb.admin.select().from(s.products).where(eq(s.products.businessId, businessId)),
    tdb.admin.select().from(s.importMappings).where(eq(s.importMappings.businessId, businessId)),
    tdb.admin.select().from(s.fbrCredentials).where(eq(s.fbrCredentials.businessId, businessId)),
    tdb.admin.select().from(s.businesses).where(eq(s.businesses.id, businessId)),
  ]);
  const sorted = (rows: object[]) => rows.map(r => JSON.stringify(r)).sort();
  return JSON.stringify(([inv, items, cus, pro, map, cred, biz] as object[][]).map(sorted));
}

let idsB: Ids;
before(async () => { idsB = await seedData(b, B, 'B'); });

describe('1. FBR tokens never leave the server', () => {
  test('no endpoint returns a token or its ciphertext, in the body or the headers', async () => {
    const creds = await tdb.admin.select().from(s.fbrCredentials);
    const [refCred] = await tdb.admin.select().from(s.referenceCredential);
    const secrets = [...Object.values(TOKENS), REFERENCE_TOKEN, ...creds.map(c => c.ciphertext), refCred!.ciphertext];
    assert.equal(creds.length, 3);
    for (const c of creds) assert.ok(!Object.values(TOKENS).some(t => c.ciphertext.includes(t)), 'stored sealed, not plain');

    const ids = await seedData(a, A, 'A');
    const base = `/businesses/${A.businessId}`;
    const id = (key: keyof Ids) => ids[key];
    let created = '';
    // One real call per route; order matters only for deletes and logout.
    const cases: [string, () => Promise<{ status: number; text: string; headers?: Headers }>][] = [
      ['POST /api/auth/login', () => new Client(app.base).post('/auth/login', { email: A.email, password: A.password })],
      ['GET /api/auth/me', () => a.get('/auth/me')],
      ['GET /api/businesses', () => a.get('/businesses')],
      ['POST /api/businesses', () => a.post('/businesses', profile({ id: 'b_alpha_extra', name: 'Alpha Extra' }))],
      ['PUT /api/businesses/:businessId', () => a.put(base, profile({ name: 'Alpha', nextInvoiceNo: 900 }))],
      ['PUT /api/businesses/:businessId/credentials/:env', () => a.put(`${base}/credentials/sandbox`, { token: TOKENS.aSandbox })],
      ['POST /api/businesses/:businessId/credentials/:env/test', () => a.post(`${base}/credentials/sandbox/test`)],
      ['POST /api/businesses/:businessId/invoices', async () => { const r = await a.post(`${base}/invoices`, withBuyer('A created')); created = r.body.id; return r; }],
      ['POST /api/businesses/:businessId/invoices/bulk', () => a.post(`${base}/invoices/bulk`, { invoices: [withBuyer('A bulk 1'), withBuyer('A bulk 2')] })],
      ['GET /api/businesses/:businessId/invoices', () => a.get(`${base}/invoices`)],
      ['GET /api/businesses/:businessId/invoices/:id', () => a.get(`${base}/invoices/${id('posted')}`)],
      ['PUT /api/businesses/:businessId/invoices/:id', () => a.put(`${base}/invoices/${id('invoice')}`, withBuyer('A edited'))],
      ['POST /api/businesses/:businessId/invoices/:id/post', async () => { const r = await a.post(`${base}/invoices/${created}/post`); await settled(created); return r; }],
      ['POST /api/businesses/:businessId/invoices/post-batch', async () => { const r = await a.post(`${base}/invoices/post-batch`, { ids: [id('invoice')] }); await settled(id('invoice')); return r; }],
      ['GET /api/businesses/:businessId/invoices/batches/:batchId', () => a.get(`${base}/invoices/batches/${id('batch')}`)],
      ['GET /api/businesses/:businessId/invoices/batches/:batchId/events', async () => {
        const r = await a.events(`${base}/invoices/batches/${id('batch')}/events`);
        return { status: r.status, text: JSON.stringify(r.events) };
      }],
      ['GET /api/businesses/:businessId/customers', () => a.get(`${base}/customers`)],
      ['POST /api/businesses/:businessId/customers', () => a.post(`${base}/customers`, { ntnCnic: '', name: 'Walk-in', province: 'Punjab', registrationType: 'Unregistered' })],
      ['GET /api/businesses/:businessId/customers/:id', () => a.get(`${base}/customers/${id('customer')}`)],
      ['PUT /api/businesses/:businessId/customers/:id', () => a.put(`${base}/customers/${id('customer')}`, { ntnCnic: '4410235', name: 'Metro', province: 'Sindh', registrationType: 'Registered' })],
      ['GET /api/businesses/:businessId/products', () => a.get(`${base}/products`)],
      ['POST /api/businesses/:businessId/products', () => a.post(`${base}/products`, { name: 'Rice', hsCode: '1006.3090', uoM: 'KG', saleType: 'Goods at standard rate (default)', rate: '18%', unitPrice: 340 })],
      ['GET /api/businesses/:businessId/products/:id', () => a.get(`${base}/products/${id('product')}`)],
      ['PUT /api/businesses/:businessId/products/:id', () => a.put(`${base}/products/${id('product')}`, { name: 'Sugar', hsCode: '1701.9910', uoM: 'KG', saleType: 'Goods at standard rate (default)', rate: '18%', unitPrice: 160 })],
      ['GET /api/businesses/:businessId/import-mappings', () => a.get(`${base}/import-mappings`)],
      ['POST /api/businesses/:businessId/import-mappings', () => a.post(`${base}/import-mappings`, { name: 'Oct', signature: 'oct|sig', map: { invoiceNo: 'Bill #' } })],
      ['POST /api/fbr/:businessId/validate', () => a.post(`/fbr/${A.businessId}/validate`, { environment: 'sandbox', payload: fbrPayload })],
      ['GET /api/businesses/:businessId/reference/:kind', () => a.get(`${base}/reference/uom`)],
      ['GET /api/businesses/:businessId/reference/rates', () => a.get(`${base}/reference/rates`)],
      ['GET /api/businesses/:businessId/reference/hs', () => a.get(`${base}/reference/hs?q=sugar`)],
      ['GET /api/businesses/:businessId/reference/uom-for-hs', () => a.get(`${base}/reference/uom-for-hs?hs=1701.9910`)],
      ['GET /api/businesses/:businessId/reference/sro', () => a.get(`${base}/reference/sro?rateId=280`)],
      ['GET /api/businesses/:businessId/reference/sro-items', () => a.get(`${base}/reference/sro-items?sroId=389`)],
      ['GET /api/businesses/:businessId/reference/status', () => a.get(`${base}/reference/status`)],
      ['POST /api/fbr/:businessId/reg-type', () => a.post(`/fbr/${A.businessId}/reg-type`, { Registration_No: '4410235' })],
      ['DELETE /api/businesses/:businessId/invoices/:id', async () => {
        const fresh = (await a.post(`${base}/invoices`, withBuyer('A to delete'))).body.id;
        return a.del(`${base}/invoices/${fresh}`);
      }],
      ['DELETE /api/businesses/:businessId/customers/:id', () => a.del(`${base}/customers/${id('customer')}`)],
      ['DELETE /api/businesses/:businessId/products/:id', () => a.del(`${base}/products/${id('product')}`)],
      ['DELETE /api/businesses/:businessId/import-mappings/:id', () => a.del(`${base}/import-mappings/${id('mapping')}`)],
      ['POST /api/auth/logout', async () => { const c = await signIn(app.base, A); return c.post('/auth/logout'); }],
    ];

    assert.deepEqual(cases.map(c => c[0]).sort(), [...ROUTES].sort(), 'every route needs a case here (and only real routes)');
    for (const [key, run] of cases) {
      const r = await run();
      assert.ok(r.status >= 200 && r.status < 300, `${key} → ${r.status} ${r.text.slice(0, 200)}`);
      const headers = r.headers ? JSON.stringify([...r.headers]) : '';
      for (const secret of secrets) {
        assert.ok(!r.text.includes(secret) && !headers.includes(secret), `${key} leaked a token or ciphertext`);
      }
      assert.ok(!/bearer\s+\S{8}/i.test(r.text), `${key} returned a bearer value`);
    }
  });

  test('the token is only ever sent to FBR, as the bearer of the right business', () => {
    const used = new Set(seen.map(x => x.auth));
    assert.ok(used.has(`Bearer ${TOKENS.aSandbox}`) && used.has(`Bearer ${TOKENS.bSandbox}`));
    assert.ok([...used].every(h => h === '' || [...Object.values(TOKENS), REFERENCE_TOKEN].some(t => h === `Bearer ${t}`)), [...used].join(', '));
    // Rasid's reference token only reads reference lists, and the reference endpoints never use a customer's token.
    const refCalls = seen.filter(x => x.auth === `Bearer ${REFERENCE_TOKEN}`);
    assert.ok(refCalls.length > 0 && refCalls.every(x => x.path.startsWith('/pdi/')), refCalls.map(x => x.path).join(', '));
    assert.ok(!seen.some(x => /SaleTypeToRate|HS_UOM|SroSchedule|SROItem|uom/.test(x.path) && x.auth !== `Bearer ${REFERENCE_TOKEN}`));
  });

  test('stored data holds no plaintext token: credentials, audit log, api_calls, invoices, reference cache', async () => {
    const dump = JSON.stringify(await Promise.all([
      tdb.admin.select().from(s.fbrCredentials), tdb.admin.select().from(s.auditLog), tdb.admin.select().from(s.apiCalls), tdb.admin.select().from(s.invoices),
      tdb.admin.select().from(s.referenceCredential), tdb.admin.select().from(s.refLists),
    ]));
    for (const t of [...Object.values(TOKENS), REFERENCE_TOKEN]) assert.ok(!dump.includes(t));
    const hints = (await tdb.admin.select({ hint: s.fbrCredentials.hint }).from(s.fbrCredentials)).map(h => h.hint);
    assert.ok(hints.every(h => h.length <= 8), 'only a short hint is kept in clear');
  });
});

describe('2. tenant isolation', () => {
  test("user A gets 404 on every route of business B, and B's data does not change", async () => {
    const before = await snapshot(B.businessId);
    const fbrCallsBefore = seen.length;
    const bb = `/businesses/${B.businessId}`;
    const fill = (route: string) => route
      .replace('/api', '')
      .replace(':businessId', B.businessId)
      .replace(':env', 'sandbox')
      .replace(':kind', 'provinces')
      .replace(':batchId', idsB.batch)
      .replace(/invoices\/:id/, `invoices/${idsB.invoice}`)
      .replace(/customers\/:id/, `customers/${idsB.customer}`)
      .replace(/products\/:id/, `products/${idsB.product}`)
      .replace(/import-mappings\/:id/, `import-mappings/${idsB.mapping}`);
    const bodyFor = (route: string): unknown => {
      if (route.includes('/credentials/')) return { token: 'attacker-token-0123456789abcdef' };
      if (route.endsWith('/invoices/bulk')) return { invoices: [withBuyer('X')] };
      if (route.endsWith('/post-batch')) return { ids: [idsB.invoice] };
      if (route.includes('/invoices')) return withBuyer('X');
      if (route.includes('/customers')) return { ntnCnic: '', name: 'X', province: 'Punjab', registrationType: 'Unregistered' };
      if (route.includes('/products')) return { name: 'X', hsCode: '1', uoM: 'KG', saleType: 'x', rate: '18%', unitPrice: 1 };
      if (route.includes('/import-mappings')) return { name: 'X', signature: 'x', map: {} };
      if (route.endsWith('/validate')) return { payload: fbrPayload };
      if (route.endsWith('/reg-type')) return { Registration_No: '4410235' };
      return profile();
    };
    const scoped = ROUTES.filter(r => r.includes(':businessId'));
    assert.ok(scoped.length >= 28);
    for (const route of scoped) {
      const [method, path] = route.split(' ') as [string, string];
      const url = fill(path);
      const r = method === 'GET' && url.endsWith('/events')
        ? await a.events(url).then(x => ({ status: x.status, text: JSON.stringify(x.events) }))
        : await a.req(method, url, method === 'GET' || method === 'DELETE' ? undefined : bodyFor(path));
      assert.equal(r.status, 404, `${route} as A on B → ${r.status} ${r.text.slice(0, 120)}`);
      assert.ok(!r.text.includes('B draft') && !r.text.includes('B customer'), `${route} leaked B's data`);
    }

    // Through A's own business, with B's record ids.
    const ab = `/businesses/${A.businessId}`;
    const viaOwn: [string, string, unknown?][] = [
      ['GET', `${ab}/invoices/${idsB.invoice}`], ['PUT', `${ab}/invoices/${idsB.invoice}`, withBuyer('X')], ['DELETE', `${ab}/invoices/${idsB.invoice}`],
      ['POST', `${ab}/invoices/${idsB.invoice}/post`], ['GET', `${ab}/invoices/batches/${idsB.batch}`],
      ['GET', `${ab}/customers/${idsB.customer}`], ['DELETE', `${ab}/customers/${idsB.customer}`],
      ['GET', `${ab}/products/${idsB.product}`], ['DELETE', `${ab}/products/${idsB.product}`],
      ['DELETE', `${ab}/import-mappings/${idsB.mapping}`],
    ];
    for (const [method, url, body] of viaOwn) {
      const r = await a.req(method, url, body);
      assert.equal(r.status, 404, `${method} ${url} → ${r.status}`);
    }
    // Upserts and creates that reuse B's ids are refused without touching B.
    assert.equal((await a.put(`${ab}/customers/${idsB.customer}`, bodyFor('/customers'))).status, 409);
    assert.equal((await a.put(`${ab}/products/${idsB.product}`, bodyFor('/products'))).status, 409);
    assert.equal((await a.post(`${ab}/invoices`, { ...withBuyer('X'), id: idsB.invoice })).status, 409);
    const batch = await a.post(`${ab}/invoices/post-batch`, { ids: [idsB.invoice, idsB.posted] });
    assert.equal(batch.status, 202);
    assert.deepEqual(batch.body.queued, []);
    assert.deepEqual(batch.body.skipped.map((x: { status: unknown }) => x.status), [null, null], 'B ids look like they do not exist');
    assert.equal((await a.events(`${ab}/invoices/batches/${idsB.batch}/events`)).status, 404);
    assert.ok(!(await a.get('/businesses')).text.includes(B.businessId));

    await new Promise(r => setTimeout(r, 300)); // give a wrongly queued job time to reach FBR
    assert.equal(await snapshot(B.businessId), before, "B's rows are byte-for-byte unchanged");
    assert.ok(!seen.slice(fbrCallsBefore).some(x => x.auth === `Bearer ${TOKENS.bSandbox}`), "B's token was not used");
  });
});

describe('3. idempotent posting', () => {
  const base = `/businesses/${A.businessId}/invoices`;
  const callsFor = (buyer: string) => seen.filter(x => x.buyer === buyer && x.path.includes('postinvoicedata')).length;

  test('20 concurrent posts of one invoice: one is queued, FBR sees one call', async () => {
    const id = (await a.post(base, withBuyer('idem-concurrent'))).body.id;
    const results = await Promise.all(Array.from({ length: 20 }, () => a.post(`${base}/${id}/post`)));
    assert.deepEqual(results.map(r => r.status).sort(), [202, ...Array(19).fill(409)]);
    assert.equal((await settled(id)).status, 'posted');
    await new Promise(r => setTimeout(r, 300));
    assert.equal(callsFor('idem-concurrent'), 1);
    const okRows = await tdb.admin.select().from(s.apiCalls).where(eq(s.apiCalls.invoiceId, id));
    assert.deepEqual(okRows.map(r => r.outcome), ['ok']);
  });

  test('overlapping batches with repeated ids queue each invoice once', async () => {
    const x = (await a.post(base, withBuyer('idem-x'))).body.id;
    const y = (await a.post(base, withBuyer('idem-y'))).body.id;
    const results = await Promise.all(Array.from({ length: 5 }, () => a.post(`${base}/post-batch`, { ids: [x, x, y, y] })));
    const queued = results.flatMap(r => r.body.queued as string[]);
    assert.deepEqual(queued.sort(), [x, y].sort());
    await settled(x); await settled(y);
    await new Promise(r => setTimeout(r, 300));
    assert.equal(callsFor('idem-x'), 1);
    assert.equal(callsFor('idem-y'), 1);
  });

  test('duplicate jobs for one invoice on the queue: FBR still sees one call', async () => {
    const id = (await a.post(base, withBuyer('idem-dupjob'))).body.id;
    assert.equal((await a.post(`${base}/${id}/post`)).status, 202);
    const job = { businessId: A.businessId, invoiceId: id, batchId: 'bt_dup', actor: A.userId, actorName: 'test' };
    await enqueuePosts([job, job, job]);
    const done = await settled(id);
    assert.equal(done.status, 'posted', JSON.stringify(done.history));
    await new Promise(r => setTimeout(r, 500));
    assert.equal(callsFor('idem-dupjob'), 1);
  });

  test('a posted invoice cannot be posted again by any route', async () => {
    const id = (await a.post(base, withBuyer('idem-again'))).body.id;
    await a.post(`${base}/${id}/post`);
    const row = await settled(id);
    assert.equal((await a.post(`${base}/${id}/post`)).status, 409);
    assert.equal((await a.post(`${base}/${id}/post`, { confirmNotInIris: true })).status, 409);
    assert.equal((await a.post(`${base}/post-batch`, { ids: [id] })).body.skipped[0].status, 'posted');
    assert.equal((await a.put(`${base}/${id}`, withBuyer('idem-again'))).status, 409);
    assert.equal((await a.del(`${base}/${id}`)).status, 409);
    await new Promise(r => setTimeout(r, 300));
    assert.equal(callsFor('idem-again'), 1);
    const [after] = await tdb.admin.select().from(s.invoices).where(eq(s.invoices.id, id));
    assert.equal(after?.fbrInvoiceNumber, row.fbrInvoiceNumber);
  });
});
