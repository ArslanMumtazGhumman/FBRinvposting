import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { eq as eqId } from 'drizzle-orm';
import { startTestDb, type TestDb } from './helpers/db.js';

const tdb: TestDb = await startTestDb();

const { encrypt, decrypt } = await import('../src/lib/vault.js');
const { audit, verifyChain } = await import('../src/lib/audit.js');
const { hashPassword, verifyPassword } = await import('../src/lib/auth.js');
const { db, withBusiness, withUser, assertRlsEnforced, closeDb } = await import('../src/db/client.js');
const s = await import('../src/db/schema.js');

/** Postgres error from a rejected promise, unwrapping Drizzle's query wrapper. */
async function pgError(p: Promise<unknown>): Promise<{ code?: string; message: string }> {
  try { await p; } catch (e) {
    const err = e as { cause?: { code?: string; message: string }; code?: string; message: string };
    return err.cause ?? err;
  }
  throw new Error('expected the query to fail');
}

const A = { tenant: 't_a', user: 'u_a', biz: 'b_a' };
const B = { tenant: 't_b', user: 'u_b', biz: 'b_b' };

before(async () => {
  const { admin } = tdb;
  for (const x of [A, B]) {
    await admin.insert(s.tenants).values({ id: x.tenant, name: x.tenant });
    await admin.insert(s.users).values({ id: x.user, tenantId: x.tenant, email: `${x.user}@x.pk`, name: x.user, role: 'owner', passwordHash: 'x' });
    await admin.insert(s.businesses).values({ id: x.biz, tenantId: x.tenant, name: x.biz, ntnCnic: '1234567', province: 'Punjab', activity: 'Other', sector: 'Other' });
    await admin.insert(s.memberships).values({ userId: x.user, businessId: x.biz, role: 'owner' });
    await admin.insert(s.customers).values({ id: `c_${x.biz}`, businessId: x.biz, ntnCnic: '7654321', name: `Customer of ${x.biz}`, province: 'Sindh', registrationType: 'Registered' });
  }
});

after(async () => { await closeDb(); await tdb.stop(); });

test('vault round-trips and binds ciphertext to its business', () => {
  const sealed = encrypt('secret-token-value-123', 'b1:sandbox');
  assert.equal(decrypt(sealed, 'b1:sandbox'), 'secret-token-value-123');
  assert.throws(() => decrypt(sealed, 'b2:sandbox'));
});

test('password hashing', () => {
  const h = hashPassword('correct horse battery');
  assert.equal(verifyPassword('correct horse battery', h), true);
  assert.equal(verifyPassword('wrong', h), false);
});

test('API role cannot bypass row-level security; the owner would', async () => {
  await assertRlsEnforced();
  await assert.rejects(assertRlsEnforced(tdb.admin), /bypasses row-level security/);
});

test('audit chain verifies, survives concurrent appends and detects tampering', async () => {
  await audit({ actor: 'u1', action: 'a' });
  await Promise.all(Array.from({ length: 10 }, (_, i) => audit({ actor: 'u1', action: `parallel-${i}`, attempts: i })));
  await withBusiness(A.user, A.biz, tx => audit({ actor: A.user, action: 'scoped', businessId: A.biz, env: 'sandbox' }, tx));
  assert.equal(await verifyChain(tdb.admin), true);

  // Even the owner cannot edit the log while the trigger is on.
  assert.match((await pgError(tdb.adminSql`update audit_log set action = 'changed' where id = 1`)).message, /append-only/);
  await tdb.adminSql`alter table audit_log disable trigger audit_log_append_only`;
  await tdb.adminSql`update audit_log set action = 'changed' where id = 1`;
  await tdb.adminSql`alter table audit_log enable trigger audit_log_append_only`;
  assert.equal(await verifyChain(tdb.admin), false);
});

test('API role can append to audit_log but not read or change it', async () => {
  assert.equal((await pgError(db.select().from(s.auditLog))).code, '42501');
  assert.equal((await pgError(db.update(s.auditLog).set({ action: 'x' }))).code, '42501');
  // A business event may only be written in that business's context.
  assert.equal((await pgError(withBusiness(A.user, A.biz, tx => audit({ actor: A.user, action: 'x', businessId: B.biz }, tx)))).code, '42501');
});

test('RLS: a user sees only the business in context, and only when a member', async () => {
  const mine = await withBusiness(A.user, A.biz, tx => tx.select().from(s.customers));
  assert.deepEqual(mine.map(c => c.businessId), [A.biz]);

  // A names B's business: not a member, so nothing is visible or writable.
  assert.equal((await withBusiness(A.user, B.biz, tx => tx.select().from(s.customers))).length, 0);
  const err = await pgError(withBusiness(A.user, B.biz, tx => tx.insert(s.customers)
    .values({ id: 'c_evil', businessId: B.biz, ntnCnic: '1', name: 'x', province: 'x', registrationType: 'Registered' })));
  assert.equal(err.code, '42501');
  const updated = await withBusiness(A.user, A.biz, tx => tx.update(s.customers).set({ name: 'hijacked' })
    .where(eqId(s.customers.id, `c_${B.biz}`)).returning());
  assert.equal(updated.length, 0);

  // No context at all: nothing.
  assert.equal((await db.select().from(s.customers)).length, 0);
  assert.equal((await db.select().from(s.businesses)).length, 0);

  // Business list covers the user's own memberships only.
  assert.deepEqual((await withUser(A.user, tx => tx.select().from(s.businesses))).map(b => b.id), [A.biz]);
});

test('invoice lines cannot point at another business\'s invoice', async () => {
  await tdb.admin.insert(s.invoices).values({ id: 'i_b', businessId: B.biz, localRef: 'B-1', invoiceType: 'Sale Invoice', invoiceDate: '2026-10-18', buyer: buyer(), environment: 'sandbox' });
  const err = await pgError(withBusiness(A.user, A.biz, tx => tx.insert(s.invoiceItems).values({ ...line(), invoiceId: 'i_b', businessId: A.biz })));
  assert.equal(err.code, '23503'); // composite FK (invoice_id, business_id)
});

test('posted invoices and their lines are immutable; debit notes need the IRN', async () => {
  await withBusiness(A.user, A.biz, async tx => {
    await tx.insert(s.invoices).values({ id: 'i_a', businessId: A.biz, localRef: 'A-1', invoiceType: 'Sale Invoice', invoiceDate: '2026-10-18', buyer: buyer(), environment: 'sandbox' });
    await tx.insert(s.invoiceItems).values({ ...line(), invoiceId: 'i_a', businessId: A.biz });
    await tx.update(s.invoices).set({ status: 'posted', fbrInvoiceNumber: '1234567DI1' }).where(eqId(s.invoices.id, 'i_a'));
  });
  for (const attempt of [
    () => withBusiness(A.user, A.biz, tx => tx.update(s.invoices).set({ status: 'draft' }).where(eqId(s.invoices.id, 'i_a'))),
    () => withBusiness(A.user, A.biz, tx => tx.delete(s.invoices).where(eqId(s.invoices.id, 'i_a'))),
    () => withBusiness(A.user, A.biz, tx => tx.update(s.invoiceItems).set({ quantity: 99 }).where(eqId(s.invoiceItems.invoiceId, 'i_a'))),
    () => withBusiness(A.user, A.biz, tx => tx.insert(s.invoiceItems).values({ ...line(), lineNo: 2, invoiceId: 'i_a', businessId: A.biz })),
  ]) assert.match((await pgError(attempt())).message, /posted to FBR/);

  const dn = await pgError(withBusiness(A.user, A.biz, tx => tx.insert(s.invoices)
    .values({ id: 'i_dn', businessId: A.biz, localRef: 'A-2', invoiceType: 'Debit Note', invoiceDate: '2026-10-18', buyer: buyer(), environment: 'sandbox' })));
  assert.equal(dn.code, '23514');
});

test('api_calls is append-only for everyone', async () => {
  await withBusiness(A.user, A.biz, tx => tx.insert(s.apiCalls).values({ businessId: A.biz, env: 'sandbox', endpoint: 'post', outcome: 'ok', payloadHash: 'h', attempts: 1, actor: A.user }));
  assert.equal((await pgError(withBusiness(A.user, A.biz, tx => tx.delete(s.apiCalls)))).code, '42501');
  assert.match((await pgError(tdb.adminSql`delete from api_calls`)).message, /append-only/);
  assert.match((await pgError(tdb.adminSql`truncate api_calls`)).message, /append-only/);
});

/* ---------- fixtures ---------- */
function buyer() { return { ntnCnic: '7654321', name: 'Buyer', province: 'Sindh', address: '', registrationType: 'Registered' as const }; }
function line() {
  return { lineNo: 1, hsCode: '0101.2100', productDescription: 'x', rate: '18%', uoM: 'KG', quantity: 1, unitPrice: 100, totalValues: 118,
    valueSalesExcludingST: 100, salesTaxApplicable: 18, saleType: 'Goods at standard rate (default)' };
}
