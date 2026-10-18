/**
 * Posting through the queue: API enqueues, an in-process worker posts to a
 * fake FBR. Postgres and Redis run in containers.
 */
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { RedisContainer } from '@testcontainers/redis';
import { and, eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { startTestDb, type TestDb } from './helpers/db.js';

/* ---------- fake FBR: behaviour chosen by the buyer name ---------- */
interface Seen { auth: string; path: string; body: any }
const seen: Seen[] = [];
const inFlight = new Map<string, number>();  // by token
const maxInFlight = new Map<string, number>();
let maxTotal = 0;
let irnSeq = 0;
const fake = http.createServer((req, res) => {
  let raw = '';
  req.on('data', c => { raw += c; });
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : null;
    const auth = req.headers.authorization ?? '';
    seen.push({ auth, path: req.url ?? '', body });
    const n = (inFlight.get(auth) ?? 0) + 1;
    inFlight.set(auth, n);
    maxInFlight.set(auth, Math.max(maxInFlight.get(auth) ?? 0, n));
    maxTotal = Math.max(maxTotal, [...inFlight.values()].reduce((a, b) => a + b, 0));
    const name: string = body?.buyerBusinessName ?? '';
    const delay = name === 'SLOW' ? 1500 : name === 'BUSY' ? 150 : 20;
    setTimeout(() => {
      inFlight.set(auth, (inFlight.get(auth) ?? 1) - 1);
      if (name === 'REJECT') {
        return res.end(JSON.stringify({ dated: '2026-10-18 10:00:00', validationResponse: { statusCode: '01', status: 'Invalid', errorCode: null,
          invoiceStatuses: [{ itemSNo: '1', statusCode: '01', status: 'Invalid', errorCode: '0019', error: 'Please provide valid HS Code' }] } }));
      }
      const irn = name === 'DUPIRN' ? 'IRN-DUP' : `IRN${String(++irnSeq).padStart(6, '0')}`;
      res.end(JSON.stringify({ invoiceNumber: irn, dated: '2026-10-18 10:00:00',
        validationResponse: { statusCode: '00', status: 'Valid', invoiceStatuses: [{ itemSNo: '1', statusCode: '00', status: 'Valid', invoiceNo: `${irn}-1` }] } }));
    }, delay);
  });
}).listen(0);
await new Promise(r => fake.once('listening', r));

const redisC = await new RedisContainer('redis:7-alpine').start();
process.env.REDIS_URL = redisC.getConnectionUrl();
process.env.FBR_BASE_URL = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
process.env.FBR_TIMEOUT_MS = '400';
process.env.BATCH_POLL_MS = '50';
const tdb: TestDb = await startTestDb();

const { startApp, createTenant, signIn, invoiceBody } = await import('./helpers/http.js');
const { closeDb } = await import('../src/db/client.js');
const { closeQueue, enqueuePosts } = await import('../src/queue/posting.js');
const { startPostWorker } = await import('../src/queue/worker.js');
const s = await import('../src/db/schema.js');

const app = await startApp();
const worker = startPostWorker({ concurrency: 10, perBusiness: 3 });
const A = await createTenant(tdb, 'alpha');
const B = await createTenant(tdb, 'bravo');
const V = await createTenant(tdb, 'viewer', { role: 'viewer' });
await tdb.admin.insert(s.memberships).values({ userId: V.userId, businessId: A.businessId, role: 'viewer' });
const a = await signIn(app.base, A);
const b = await signIn(app.base, B);
const v = await signIn(app.base, V);
const TOKEN_A = 'sandbox-token-alpha-0123456789';
const TOKEN_B = 'sandbox-token-bravo-0123456789';
assert.equal((await a.put(`/businesses/${A.businessId}/credentials/sandbox`, { token: TOKEN_A })).status, 200);
assert.equal((await b.put(`/businesses/${B.businessId}/credentials/sandbox`, { token: TOKEN_B })).status, 200);

after(async () => {
  await worker.close(); await closeQueue(); await app.close(); await closeDb(); await tdb.stop(); await redisC.stop(); fake.close();
});

const inv = (f: { businessId: string }, rest = '') => `/businesses/${f.businessId}/invoices${rest}`;
const callsFor = (token: string) => seen.filter(x => x.auth === `Bearer ${token}`);
async function create(client = a, f = A, buyerName = 'Metro Cash & Carry') {
  const body = invoiceBody();
  const r = await client.post(inv(f), { ...body, buyer: { ...body.buyer, name: buyerName } });
  assert.equal(r.status, 201, r.text);
  return r.body as { id: string; localRef: string };
}
async function settled(id: string, timeoutMs = 10_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const [row] = await tdb.admin.select().from(s.invoices).where(eq(s.invoices.id, id));
    if (row && !['queued', 'posting'].includes(row.status)) return row;
    if (Date.now() > until) throw new Error(`invoice ${id} still ${row?.status}`);
    await new Promise(r => setTimeout(r, 50));
  }
}

describe('posting queue', () => {
  test('post one: queued, posted by the worker with the exact FBR payload, idempotency key recorded', async () => {
    const i = await create();
    const before = callsFor(TOKEN_A).length;
    const r = await a.post(inv(A, `/${i.id}/post`));
    assert.equal(r.status, 202, r.text);
    assert.match(r.body.batchId, /^bt_/);
    assert.ok(['queued', 'posting', 'posted'].includes(r.body.invoice.status));

    const row = await settled(i.id);
    assert.equal(row.status, 'posted');
    assert.match(row.fbrInvoiceNumber!, /^IRN/);
    assert.deepEqual(row.fbrItemNumbers, [`${row.fbrInvoiceNumber}-1`]);
    assert.ok(row.postedAt);

    const calls = callsFor(TOKEN_A).slice(before);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.path, '/di_data/v1/di/postinvoicedata_sb');
    const p = calls[0]!.body;
    assert.deepEqual(Object.keys(p).sort(), ['buyerAddress', 'buyerBusinessName', 'buyerNTNCNIC', 'buyerProvince', 'buyerRegistrationType',
      'invoiceDate', 'invoiceRefNo', 'invoiceType', 'items', 'scenarioId', 'sellerAddress', 'sellerBusinessName', 'sellerNTNCNIC', 'sellerProvince']);
    assert.equal(p.sellerNTNCNIC, '1234567');
    assert.equal(p.scenarioId, 'SN001');
    assert.equal(p.items[0].unitPrice, undefined);
    assert.equal(p.items[0].valueSalesExcludingST, 1550);

    const [call] = await tdb.admin.select().from(s.apiCalls).where(eq(s.apiCalls.invoiceId, i.id));
    assert.equal(call?.outcome, 'ok');
    assert.equal(call?.idempotencyKey, i.id);
    const got = await a.get(inv(A, `/${i.id}`));
    assert.equal(got.body.status, 'posted');
    assert.deepEqual(got.body.history.map((h: { action: string }) => h.action), ['Created', 'Queued for FBR', 'Posting to FBR', 'Posted to FBR']);
  });

  test('posting twice is refused while queued and after posting; FBR sees one call', async () => {
    const i = await create();
    const before = callsFor(TOKEN_A).length;
    const [r1, r2] = await Promise.all([a.post(inv(A, `/${i.id}/post`)), a.post(inv(A, `/${i.id}/post`))]);
    assert.deepEqual([r1.status, r2.status].sort(), [202, 409]);
    await settled(i.id);
    const again = await a.post(inv(A, `/${i.id}/post`));
    assert.equal(again.status, 409);
    assert.equal(again.body.code, 'NOT_POSTABLE');
    assert.equal(callsFor(TOKEN_A).length - before, 1);
  });

  test('FBR rejection: failed with cell-level issues, can be fixed and posted again', async () => {
    const i = await create(a, A, 'REJECT');
    await a.post(inv(A, `/${i.id}/post`));
    const row = await settled(i.id);
    assert.equal(row.status, 'failed');
    assert.deepEqual(row.issues, [{ code: '0019', message: 'Please provide valid HS Code', source: 'fbr', itemIndex: 0, field: 'hsCode' }]);
    const [call] = await tdb.admin.select().from(s.apiCalls).where(eq(s.apiCalls.invoiceId, i.id));
    assert.equal(call?.outcome, 'rejected');

    const fixed = invoiceBody();
    assert.equal((await a.put(inv(A, `/${i.id}`), fixed)).status, 200);
    assert.equal((await a.post(inv(A, `/${i.id}/post`))).status, 202);
    assert.equal((await settled(i.id)).status, 'posted');
  });

  test('timeout: outcome_unknown, never retried; posting again needs confirmNotInIris', async () => {
    const i = await create(a, A, 'SLOW');
    const before = callsFor(TOKEN_A).length;
    await a.post(inv(A, `/${i.id}/post`));
    const row = await settled(i.id);
    assert.equal(row.status, 'outcome_unknown');
    assert.equal(row.issues[0]?.code, 'L-504');
    await new Promise(r => setTimeout(r, 1500)); // no BullMQ or client retry follows
    assert.equal(callsFor(TOKEN_A).length - before, 1);
    const [call] = await tdb.admin.select().from(s.apiCalls).where(eq(s.apiCalls.invoiceId, i.id));
    assert.equal(call?.outcome, 'timeout');

    const plain = await a.post(inv(A, `/${i.id}/post`));
    assert.equal(plain.status, 409);
    assert.match(plain.body.message, /IRIS/);
    assert.equal((await a.post(inv(A, '/post-batch'), { ids: [i.id] })).body.skipped[0].status, 'outcome_unknown');
    assert.equal((await a.put(inv(A, `/${i.id}`), invoiceBody())).status, 409);

    // A person found nothing in IRIS, fixed the buyer and confirmed.
    await tdb.admin.update(s.invoices).set({ buyer: { ...row.buyer, name: 'Metro' } }).where(eq(s.invoices.id, i.id));
    assert.equal((await a.post(inv(A, `/${i.id}/post`), { confirmNotInIris: true })).status, 202);
    assert.equal((await settled(i.id)).status, 'posted');
  });

  test('no token for the environment: failed with 0401, FBR not called', async () => {
    const before = seen.length;
    const body = invoiceBody({ environment: 'production' });
    const i = (await a.post(inv(A), body)).body;
    await a.post(inv(A, `/${i.id}/post`));
    const row = await settled(i.id);
    assert.equal(row.status, 'failed');
    assert.equal(row.issues[0]?.code, '0401');
    assert.equal(seen.length, before);
  });

  test('a job that finds its invoice already posting marks it outcome_unknown without calling FBR', async () => {
    const i = await create();
    const before = seen.length;
    await tdb.admin.update(s.invoices).set({ status: 'posting' }).where(eq(s.invoices.id, i.id));
    await enqueuePosts([{ businessId: A.businessId, invoiceId: i.id, batchId: 'bt_x', actor: A.userId, actorName: 'test' }]);
    const row = await settled(i.id);
    assert.equal(row.status, 'outcome_unknown');
    assert.equal(seen.length, before);
  });

  test('an invoice FBR already accepted (api_calls ok) is marked posted without a second call', async () => {
    const i = await create();
    const before = seen.length;
    await tdb.admin.insert(s.apiCalls).values({ businessId: A.businessId, invoiceId: i.id, env: 'sandbox', endpoint: 'post', idempotencyKey: i.id,
      outcome: 'ok', httpStatus: 200, fbrInvoiceNumber: 'IRN-EARLIER', payloadHash: 'h', attempts: 1, actor: A.userId, response: { invoiceNumber: 'IRN-EARLIER', dated: 'd', validationResponse: { invoiceStatuses: [] } } });
    await a.post(inv(A, `/${i.id}/post`));
    const row = await settled(i.id);
    assert.equal(row.status, 'posted');
    assert.equal(row.fbrInvoiceNumber, 'IRN-EARLIER');
    assert.equal(seen.length, before);
  });

  test('FBR answering with an invoice number Rasid already has: outcome_unknown, response kept', async () => {
    const first = await create(a, A, 'DUPIRN');
    await a.post(inv(A, `/${first.id}/post`));
    assert.equal((await settled(first.id)).status, 'posted');
    const second = await create(a, A, 'DUPIRN');
    await a.post(inv(A, `/${second.id}/post`));
    const row = await settled(second.id);
    assert.equal(row.status, 'outcome_unknown');
    assert.equal(row.issues[0]?.code, 'L-409');
    const [call] = await tdb.admin.select().from(s.apiCalls).where(eq(s.apiCalls.invoiceId, second.id));
    assert.equal(call?.outcome, 'ok');
    assert.equal(call?.fbrInvoiceNumber, 'IRN-DUP');
  });

  test('batch: at most 3 FBR calls per business at once, other businesses keep moving, progress over SSE', async () => {
    maxInFlight.clear(); maxTotal = 0;
    const ids = [];
    for (let k = 0; k < 9; k++) ids.push((await create(a, A, 'BUSY')).id);
    const bIds = [];
    for (let k = 0; k < 3; k++) bIds.push((await create(b, B, 'BUSY')).id);

    const r = await a.post(inv(A, '/post-batch'), { ids: [...ids, ids[0], 'i_missing'] });
    assert.equal(r.status, 202, r.text);
    assert.deepEqual(r.body.queued.sort(), [...ids].sort());
    assert.deepEqual(r.body.skipped, [{ id: 'i_missing', status: null, message: 'Invoice not found.' }]);
    const stream = a.events(inv(A, `/batches/${r.body.batchId}/events`));
    const rb = await b.post(inv(B, '/post-batch'), { ids: bIds });
    assert.equal(rb.status, 202);

    const { status, events } = await stream;
    assert.equal(status, 200);
    const done = events.at(-1)!;
    assert.equal(done.event, 'done');
    assert.equal(done.data.total, 9);
    assert.equal(done.data.posted, 9);
    assert.equal(done.data.running, false);
    const posted = new Set(events.filter(e => e.event === 'invoice' && e.data.status === 'posted').map(e => e.data.id));
    assert.equal(posted.size, 9);
    assert.ok(events.some(e => e.event === 'progress' && e.data.running), 'saw progress while running');
    for (const e of events) assert.ok(!JSON.stringify(e).includes('token'), 'no token in events');

    for (const id of bIds) assert.equal((await settled(id)).status, 'posted');
    assert.equal(maxInFlight.get(`Bearer ${TOKEN_A}`), 3);
    assert.ok((maxInFlight.get(`Bearer ${TOKEN_B}`) ?? 0) <= 3);
    assert.ok(maxTotal > 3, `business B ran alongside A (max total in flight ${maxTotal})`);

    const snap = await a.get(inv(A, `/batches/${r.body.batchId}`));
    assert.equal(snap.body.posted, 9);
  });

  test('access: viewers cannot post, other tenants cannot post or watch', async () => {
    const i = await create();
    assert.equal((await v.post(inv(A, `/${i.id}/post`))).status, 403);
    assert.equal((await b.post(inv(A, `/${i.id}/post`))).status, 404);
    assert.equal((await b.post(inv(B, `/${i.id}/post`))).status, 404);
    assert.deepEqual((await b.post(inv(B, '/post-batch'), { ids: [i.id] })).body.skipped[0].status, null);
    const r = await a.post(inv(A, `/${i.id}/post`));
    assert.equal((await b.get(inv(A, `/batches/${r.body.batchId}`))).status, 404);
    assert.equal((await b.get(inv(B, `/batches/${r.body.batchId}`))).status, 404);
    assert.equal((await b.events(inv(B, `/batches/${r.body.batchId}/events`))).status, 404);
    assert.equal((await v.get(inv(A, `/batches/${r.body.batchId}`))).status, 200);
    await settled(i.id);
    const [row] = await tdb.admin.select({ status: s.invoices.status }).from(s.invoices).where(and(eq(s.invoices.id, i.id)));
    assert.equal(row?.status, 'posted');
  });

  test('tokens never reach the queue, Redis or job data', async () => {
    const redis = new Redis(process.env.REDIS_URL!);
    try {
      const keys = await redis.keys('*');
      assert.ok(keys.some(k => k.startsWith('bull:fbr-post:')));
      let dump = '';
      for (const k of keys) {
        const type = await redis.type(k);
        if (type === 'hash') dump += JSON.stringify(await redis.hgetall(k));
        else if (type === 'string') dump += await redis.get(k);
        else if (type === 'list') dump += (await redis.lrange(k, 0, -1)).join();
        else if (type === 'zset') dump += (await redis.zrange(k, 0, -1)).join();
        else if (type === 'stream') dump += JSON.stringify(await redis.xrange(k, '-', '+'));
      }
      assert.ok(dump.includes(A.businessId));
      assert.ok(!dump.includes(TOKEN_A) && !dump.includes(TOKEN_B));
    } finally { redis.disconnect(); }
  });
});
