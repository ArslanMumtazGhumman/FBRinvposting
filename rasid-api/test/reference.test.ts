/**
 * PRAL reference data: the CLI stores Rasid's token sealed, the worker's
 * nightly job fills the Postgres cache from a fake PRAL, and the lookup
 * endpoints serve it (with read-through, fallback and no customer token).
 */
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { RedisContainer } from '@testcontainers/redis';
import { eq, sql } from 'drizzle-orm';
import { startTestDb, type TestDb } from './helpers/db.js';

/* ---------- fake PRAL reference APIs ---------- */
const REF_TOKEN = 'rasid-platform-reference-token-0123456789';
const mode = { down: false, unauthorized: false, shortHsList: false, slowHsUom: false };
const seen: { auth: string; path: string; query: URLSearchParams }[] = [];
const HS = [
  { hS_CODE: '1701.9910', description: 'REFINED SUGAR, CANE OR BEET' },
  { hS_CODE: '1701.1400', description: 'Other cane sugar, raw' },
  { hS_CODE: '2716.0000', description: 'Electrical energy' },
  { hS_CODE: '8471.3020', description: 'Laptops and notebooks' },
  { hS_CODE: '9999.0001', description: '100% cotton, other' },
  ...Array.from({ length: 300 }, (_, i) => ({ hS_CODE: `5${String(i).padStart(3, '0')}.0000`, description: `Textile item ${i}` })),
];
const RATES: Record<string, Record<string, { ratE_ID: number; ratE_DESC: string; ratE_VALUE: number }[]>> = {
  '75': { '7': [{ ratE_ID: 734, ratE_DESC: '18%', ratE_VALUE: 18 }], '8': [{ ratE_ID: 735, ratE_DESC: '18% along with rupees 60 per kilogram', ratE_VALUE: 18 }] },
  '24': { '7': [{ ratE_ID: 280, ratE_DESC: '5%', ratE_VALUE: 5 }, { ratE_ID: 281, ratE_DESC: '10%', ratE_VALUE: 10 }], '8': [] },
  '111': { '7': [{ ratE_ID: 290, ratE_DESC: '5%', ratE_VALUE: 5 }], '8': [{ ratE_ID: 290, ratE_DESC: '5%', ratE_VALUE: 5 }] },
};
const fake = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://fake');
  seen.push({ auth: req.headers.authorization ?? '', path: url.pathname, query: url.searchParams });
  const send = (body: unknown, status = 200) => { res.statusCode = status; res.end(JSON.stringify(body)); };
  if (mode.unauthorized) return send({ message: 'unauthorized' }, 401);
  if (mode.down) return send({ message: 'down' }, 503);
  if (req.headers.authorization !== `Bearer ${REF_TOKEN}`) return send({ message: 'unauthorized' }, 401);
  const q = (k: string) => url.searchParams.get(k) ?? '';
  switch (url.pathname) {
    case '/pdi/v1/provinces': return send([{ stateProvinceCode: 7, stateProvinceDesc: 'PUNJAB' }, { stateProvinceCode: 8, stateProvinceDesc: 'SINDH' }]);
    case '/pdi/v1/uom': return send([{ uoM_ID: 13, description: 'KG' }, { uoM_ID: 69, description: 'Numbers, pieces, units' }, { uoM_ID: 99, description: 'KWH' }]);
    case '/pdi/v1/transtypecode': return send([
      { transactioN_TYPE_ID: 75, transactioN_DESC: 'Goods at standard rate (default)' },
      { transactioN_TYPE_ID: 24, transactioN_DESC: 'Goods at Reduced Rate' },
      { transactioN_TYPE_ID: 82, transactioN_DESC: 'DTRE goods' },
      { transactioN_TYPE_ID: 111, transactioN_DESC: 'Processing/Conversion of Goods' },
    ]);
    case '/pdi/v1/itemdesccode': return send(mode.shortHsList ? HS.slice(0, 10) : HS);
    case '/pdi/v2/SaleTypeToRate': return send(RATES[q('transTypeId')]?.[q('originationSupplier')] ?? []);
    case '/pdi/v1/SroSchedule': return send(q('rate_id') === '280' ? [{ srO_ID: 389, serNo: 1, srO_DESC: 'EIGHTH SCHEDULE Table 1' }] : []);
    case '/pdi/v2/SROItem': return send(q('sro_id') === '389' ? [{ srO_ITEM_ID: 17853, srO_ITEM_DESC: '50' }] : []);
    case '/pdi/v2/HS_UOM': {
      const body = q('hs_code') === '2716.0000' ? [{ uoM_ID: 99, description: 'KWH' }] : [{ uoM_ID: 13, description: 'KG' }];
      return mode.slowHsUom ? setTimeout(() => send(body), 6000) : send(body);
    }
    default: return send({ message: 'not found' }, 404);
  }
}).listen(0);
await new Promise(r => fake.once('listening', r));

const redisC = await new RedisContainer('redis:7-alpine').start();
process.env.REDIS_URL = redisC.getConnectionUrl();
process.env.FBR_BASE_URL = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
const tdb: TestDb = await startTestDb();

const { startApp, createTenant, signIn, Client } = await import('./helpers/http.js');
const { closeDb } = await import('../src/db/client.js');
const { startReferenceWorker } = await import('../src/queue/reference.js');
const { refreshReference } = await import('../src/reference/refresh.js');
const { resetLookupState } = await import('../src/reference/lookup.js');
const { todayPk } = await import('../src/reference/pral.js');
const s = await import('../src/db/schema.js');

const app = await startApp();
const A = await createTenant(tdb, 'alpha');
const a = await signIn(app.base, A);
const TODAY = todayPk();
const fbrCalls = () => seen.filter(x => x.auth !== '').length;
const callsTo = (path: string) => seen.filter(x => x.path === path);

let refWorker: Awaited<ReturnType<typeof startReferenceWorker>> | undefined;
after(async () => {
  await refWorker?.close(); await app.close(); await closeDb(); await tdb.stop(); await redisC.stop(); fake.close();
});

/** Runs src/reference-cli.ts in a child process, as an operator would. */
function cli(args: string[], stdin = ''): Promise<{ code: number; out: string }> {
  const root = fileURLToPath(new URL('..', import.meta.url));
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--import', 'tsx', 'src/reference-cli.ts', ...args], { cwd: root, env: process.env });
    let out = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { out += d; });
    p.on('error', reject);
    p.on('close', code => resolve({ code: code ?? -1, out }));
    p.stdin.end(stdin);
  });
}

async function waitFor<T>(fn: () => Promise<T | undefined | false>, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise(r => setTimeout(r, 100));
  }
}

describe('before Rasid has a reference token', () => {
  test('lookups answer source "none" without calling FBR', async () => {
    assert.equal((await a.get('/reference/sale-types?province=Punjab')).body.source, 'none');
    assert.deepEqual((await a.get('/reference/hs-codes?q=sugar')).body, { source: 'none', results: [] });
    assert.deepEqual((await a.get('/reference/hs-codes/2716.0000/uoms')).body, { source: 'none', uoms: [] });
    assert.equal((await a.get('/reference/status')).body.tokenConfigured, false);
    assert.equal(fbrCalls(), 0);
  });

  test('the endpoints need a signed-in user and validate their input', async () => {
    const anon = new Client(app.base);
    for (const path of ['/reference/provinces', '/reference/uoms', '/reference/sale-types?province=Punjab', '/reference/hs-codes?q=sugar',
      '/reference/hs-codes/2716.0000/uoms', '/reference/sro-schedules?rateId=1&province=Punjab', '/reference/sro-items?sroId=1', '/reference/status']) {
      assert.equal((await anon.get(path)).status, 401, path);
    }
    assert.equal((await a.get('/reference/hs-codes?q=s')).status, 400);
    assert.equal((await a.get('/reference/hs-codes?q=sugar&limit=500')).status, 400);
    assert.equal((await a.get('/reference/hs-codes/2716/uoms')).status, 400);
    assert.equal((await a.get('/reference/sale-types')).status, 400);
    assert.equal((await a.get('/reference/sale-types?province=Punjab&date=2026-02-30')).status, 400);
    assert.equal((await a.get('/reference/sro-items?sroId=abc')).status, 400);
  });

  test('the old per-business proxy is gone', async () => {
    assert.equal((await a.get(`/fbr/${A.businessId}/reference/provinces`)).status, 404);
  });
});

describe('reference-cli set-token', () => {
  test('refuses a token FBR rejects, and stores nothing', async () => {
    const r = await cli(['set-token'], 'not-the-right-token-0123456789\n');
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /not saved/);
    assert.equal((await tdb.admin.select().from(s.referenceCredential)).length, 0);
    assert.ok(!r.out.includes('not-the-right-token'), 'the token is not echoed');
  });

  test('stores the token sealed, audits it, and never prints it', async () => {
    const r = await cli(['set-token'], `Bearer ${REF_TOKEN}\n`);
    assert.equal(r.code, 0, r.out);
    assert.ok(!r.out.includes(REF_TOKEN));
    const [row] = await tdb.admin.select().from(s.referenceCredential);
    assert.ok(row && !row.ciphertext.includes(REF_TOKEN) && row.hint === '••••' + REF_TOKEN.slice(-4));
    const audit = await tdb.admin.select().from(s.auditLog).where(eq(s.auditLog.action, 'reference_token_saved'));
    assert.equal(audit.length, 1);
    assert.ok(!JSON.stringify(audit).includes(REF_TOKEN));
  });

  test('the API role can read the ciphertext but not change it', async () => {
    const appSql = (await import('postgres')).default(tdb.appUrl, { max: 1, onnotice: () => {} });
    try {
      assert.equal((await appSql`select count(*)::int as n from reference_credential`)[0]!.n, 1);
      await assert.rejects(appSql`update reference_credential set hint = 'x'`, /permission denied/);
      await assert.rejects(appSql`delete from reference_credential`, /permission denied/);
    } finally { await appSql.end(); }
  });
});

describe('nightly refresh', () => {
  test('the worker registers the nightly schedule and fills an empty cache at once', async () => {
    refWorker = await startReferenceWorker({ cron: '30 2 * * *' });
    const schedulers = await refWorker.queue.getJobSchedulers();
    assert.deepEqual(schedulers.map(x => [x.key, x.pattern, x.tz]), [['nightly', '30 2 * * *', 'Asia/Karachi']]);

    await waitFor(async () => (await tdb.admin.select({ n: sql<number>`count(*)::int` }).from(s.hsCodes))[0]!.n === HS.length);
    await waitFor(async () => (await tdb.admin.select().from(s.refLists).where(eq(s.refLists.kind, 'SROItem'))).length > 0);
    assert.ok(seen.filter(x => !x.auth.includes('not-the-right-token')).every(x => x.auth === `Bearer ${REF_TOKEN}`), 'only Rasid’s reference token is used');

    // Every sale type × province was asked for today's date, in PRAL's date format.
    const rateCalls = callsTo('/pdi/v2/SaleTypeToRate');
    assert.equal(rateCalls.length, 3 * 2, 'three matched sale types, two provinces');
    const [y, m, d] = TODAY.split('-');
    const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m) - 1];
    assert.ok(rateCalls.every(c => c.query.get('date') === `${d}-${month}-${y}`));
    assert.deepEqual(callsTo('/pdi/v2/SROItem').map(c => c.query.get('date')), [TODAY]);

    // Restarting a worker doesn't queue another fill once the cache is full.
    const before = callsTo('/pdi/v1/itemdesccode').length;
    const second = await startReferenceWorker({ cron: '30 2 * * *' });
    await new Promise(r => setTimeout(r, 500));
    await second.close();
    assert.equal(callsTo('/pdi/v1/itemdesccode').length, before);
    assert.equal((await refWorker.queue.getJobSchedulers()).length, 1);
  });

  test('a short or empty list from FBR does not replace the cached one', async () => {
    mode.shortHsList = true;
    try {
      const r = await refreshReference({ token: REF_TOKEN });
      assert.match(r.failed.find(f => f.list === 'itemdesccode')?.error ?? '', /kept the cached copy/);
      assert.equal(r.counts.SaleTypeToRate, 6, 'the other lists still refreshed');
      assert.equal((await tdb.admin.select({ n: sql<number>`count(*)::int` }).from(s.hsCodes))[0]!.n, HS.length);
    } finally { mode.shortHsList = false; }
  });

  test('a 401 stops the run early and keeps the cache', async () => {
    mode.unauthorized = true;
    const callsBefore = seen.length;
    try {
      const r = await refreshReference({ token: REF_TOKEN });
      assert.equal(r.stoppedBy401, true);
      assert.ok(seen.length - callsBefore <= 5, `made ${seen.length - callsBefore} calls`);
      assert.ok((await a.get('/reference/hs-codes?q=sugar')).body.results.length > 0);
    } finally { mode.unauthorized = false; }
  });

  test('dated copies older than keepDays are pruned; undated lists stay', async () => {
    await tdb.admin.insert(s.refLists).values({ kind: 'SaleTypeToRate', params: 'province=7&transTypeId=75', asOf: '2020-01-01', data: [] });
    const r = await refreshReference({ token: REF_TOKEN });
    assert.ok(r.counts.pruned! >= 1);
    const old = await tdb.admin.select().from(s.refLists).where(eq(s.refLists.asOf, '2020-01-01'));
    assert.equal(old.length, 0);
    assert.equal((await tdb.admin.select().from(s.refLists).where(eq(s.refLists.kind, 'provinces'))).length, 1);
  });
});

describe('lookups', () => {
  test('sale-type rates come from PRAL for the seller’s province', async () => {
    const calls = fbrCalls();
    const punjab = (await a.get('/reference/sale-types?province=Punjab')).body;
    assert.equal(punjab.source, 'pral');
    assert.deepEqual(punjab.province, { code: 7, desc: 'PUNJAB' });
    const rates = (st: { saleType: string; rates: { desc: string }[] }[], name: string) => st.find(x => x.saleType === name)?.rates.map(r => r.desc);
    assert.deepEqual(rates(punjab.saleTypes, 'goods at standard rate (default)'), ['18%']);
    assert.deepEqual(rates(punjab.saleTypes, 'goods at reduced rate'), ['5%', '10%']);
    assert.deepEqual(rates(punjab.saleTypes, 'processing/ conversion of goods'), ['5%'], 'matched on letters and digits');
    assert.equal(punjab.saleTypes.length, 3, 'sale types PRAL does not list are left out');
    assert.ok(punjab.saleTypes.every((x: { asOf: string }) => x.asOf === TODAY));

    const sindh = (await a.get('/reference/sale-types?province=sindh')).body;
    assert.deepEqual(rates(sindh.saleTypes, 'goods at standard rate (default)'), ['18% along with rupees 60 per kilogram']);
    assert.deepEqual(rates(sindh.saleTypes, 'goods at reduced rate'), []);
    assert.equal(fbrCalls(), calls, 'served from the cache');
    assert.equal((await a.get('/reference/sale-types?province=Balochistan')).body.source, 'none');
  });

  test('another date is fetched once, then cached', async () => {
    const before = callsTo('/pdi/v2/SaleTypeToRate').length;
    const r = (await a.get('/reference/sale-types?province=Punjab&date=2026-09-01')).body;
    assert.ok(r.saleTypes.every((x: { asOf: string }) => x.asOf === '2026-09-01'));
    assert.equal(callsTo('/pdi/v2/SaleTypeToRate').length, before + 3);
    assert.ok(callsTo('/pdi/v2/SaleTypeToRate').slice(-3).every(c => c.query.get('date') === '01-Sep-2026'));
    await a.get('/reference/sale-types?province=Punjab&date=2026-09-01');
    assert.equal(callsTo('/pdi/v2/SaleTypeToRate').length, before + 3);
  });

  test('when FBR is down, an uncached date falls back to the nearest cached one, and FBR is not retried for a minute', async () => {
    resetLookupState();
    mode.down = true;
    try {
      const before = seen.length;
      const r = (await a.get('/reference/sale-types?province=Punjab&date=2026-09-15')).body;
      assert.equal(r.source, 'pral');
      assert.ok(r.saleTypes.every((x: { asOf: string }) => x.asOf === '2026-09-01'), 'nearest earlier date');
      assert.equal(seen.length - before, 3);
      await a.get('/reference/sale-types?province=Punjab&date=2026-09-15');
      assert.equal(seen.length - before, 3, 'not asked again');
    } finally { mode.down = false; resetLookupState(); }
  });

  test('HS search by code prefix (with or without the dot) and by words', async () => {
    const codes = async (q: string) => (await a.get(`/reference/hs-codes?q=${encodeURIComponent(q)}`)).body.results.map((h: { code: string }) => h.code);
    assert.deepEqual(await codes('1701'), ['1701.1400', '1701.9910']);
    assert.deepEqual(await codes('1701.99'), ['1701.9910']);
    assert.deepEqual(await codes('17019910'), ['1701.9910']);
    assert.deepEqual(await codes('sugar'), ['1701.1400', '1701.9910']);
    assert.deepEqual(await codes('SUGAR refined'), ['1701.9910']);
    assert.deepEqual(await codes('100%'), ['9999.0001'], '% is matched literally');
    assert.deepEqual(await codes('__'), []);
    assert.equal((await a.get('/reference/hs-codes?q=textile&limit=5')).body.results.length, 5);
    const r = await a.get('/reference/hs-codes?q=laptop');
    assert.deepEqual(r.body, { source: 'pral', results: [{ code: '8471.3020', description: 'Laptops and notebooks' }] });
    assert.equal(r.headers.get('cache-control'), 'private, max-age=300');
  });

  test('HS UOM is looked up once, then cached and refreshed nightly', async () => {
    const before = callsTo('/pdi/v2/HS_UOM').length;
    const r = (await a.get('/reference/hs-codes/2716.0000/uoms')).body;
    assert.deepEqual([r.source, r.uoms], ['pral', ['KWH']]);
    assert.deepEqual((await a.get('/reference/hs-codes/2716.0000/uoms')).body.uoms, ['KWH']);
    assert.equal(callsTo('/pdi/v2/HS_UOM').length, before + 1);
    assert.equal(callsTo('/pdi/v2/HS_UOM').at(-1)!.query.get('annexure_id'), '3');

    const summary = await refreshReference({ token: REF_TOKEN });
    assert.equal(summary.counts.HS_UOM, 1);
    assert.equal(callsTo('/pdi/v2/HS_UOM').length, before + 2);
  });

  test('a slow FBR does not hold a lookup past 5 seconds', { timeout: 15_000 }, async () => {
    mode.slowHsUom = true;
    try {
      const t = Date.now();
      const r = (await a.get('/reference/hs-codes/1701.9910/uoms')).body;
      assert.equal(r.source, 'none');
      assert.ok(Date.now() - t < 6000, `took ${Date.now() - t} ms`);
    } finally { mode.slowHsUom = false; resetLookupState(); }
  });

  test('SRO schedules and items for a rate, from the nightly cache', async () => {
    const calls = fbrCalls();
    const sched = (await a.get('/reference/sro-schedules?rateId=280&province=Punjab')).body;
    assert.deepEqual(sched.schedules, [{ id: 389, serNo: 1, desc: 'EIGHTH SCHEDULE Table 1' }]);
    assert.deepEqual((await a.get('/reference/sro-items?sroId=389')).body.items, [{ id: 17853, desc: '50' }]);
    assert.deepEqual((await a.get('/reference/sro-schedules?rateId=734&province=Punjab')).body.schedules, []);
    assert.equal(fbrCalls(), calls);
  });

  test('provinces and UOMs', async () => {
    assert.deepEqual((await a.get('/reference/provinces')).body.provinces, [{ code: 7, desc: 'PUNJAB' }, { code: 8, desc: 'SINDH' }]);
    assert.deepEqual((await a.get('/reference/uoms')).body.uoms.map((u: { description: string }) => u.description), ['KG', 'Numbers, pieces, units', 'KWH']);
  });

  test('no response, header or cached row contains the token', async () => {
    const paths = ['/reference/provinces', '/reference/uoms', '/reference/sale-types?province=Punjab', '/reference/hs-codes?q=sugar',
      '/reference/hs-codes/2716.0000/uoms', '/reference/sro-schedules?rateId=280&province=Punjab', '/reference/sro-items?sroId=389', '/reference/status'];
    const [cred] = await tdb.admin.select().from(s.referenceCredential);
    for (const p of paths) {
      const r = await a.get(p);
      assert.equal(r.status, 200, p);
      const all = r.text + JSON.stringify([...r.headers]);
      assert.ok(!all.includes(REF_TOKEN) && !all.includes(cred!.ciphertext), p);
    }
    const status = (await a.get('/reference/status')).body;
    assert.equal(status.tokenConfigured, true);
    assert.equal(status.hsCodes.count, HS.length);
    const dump = JSON.stringify(await Promise.all([tdb.admin.select().from(s.refLists), tdb.admin.select().from(s.auditLog)]));
    assert.ok(!dump.includes(REF_TOKEN));
  });

  test('reference-cli status and refresh', async () => {
    const st = await cli(['status']);
    assert.equal(st.code, 0, st.out);
    assert.equal(JSON.parse(st.out).tokenConfigured, true);
    const r = await cli(['refresh', '2026-10-01']);
    assert.equal(r.code, 0, r.out);
    assert.equal(JSON.parse(r.out).date, '2026-10-01');
    assert.ok(!r.out.includes(REF_TOKEN));
    assert.equal((await cli(['refresh', 'yesterday'])).code, 1);
  });
});
