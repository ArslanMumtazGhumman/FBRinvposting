/**
 * Operator commands for PRAL reference data (same env as the API; set-token
 * and clear-token also need MIGRATION_DATABASE_URL, the table owner):
 *
 *   node dist/reference-cli.js set-token     # reads the token from stdin, hidden when typed
 *   node dist/reference-cli.js clear-token
 *   node dist/reference-cli.js refresh [YYYY-MM-DD]
 *   node dist/reference-cli.js status
 *   node dist/reference-cli.js sale-types
 *   node dist/reference-cli.js map-sale-type "<sale type>" <transTypeId|auto>   # needs MIGRATION_DATABASE_URL
 *
 * The token is Rasid's own PRAL token (any valid one; reference lists are the
 * same for everyone). It is stored sealed, never printed, and never sent
 * anywhere but FBR. Without it, refresh and lookups fall back to a customer's
 * tested token (src/reference/token.ts).
 */
import readline from 'node:readline';
import { Writable } from 'node:stream';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { eq } from 'drizzle-orm';
import { closeDb, db } from './db/client.js';
import * as schema from './db/schema.js';
import { audit } from './lib/audit.js';
import { fbr } from './lib/fbr-client.js';
import { refreshReference } from './reference/refresh.js';
import { requests, toTransTypes } from './reference/pral.js';
import { allSaleTypes, matchSaleType, saleTypesNeedingReview } from './reference/sale-types.js';
import { cacheStatus, readList } from './reference/store.js';
import { hasReferenceToken, referenceToken, referenceTokenSource, rejectReferenceToken, sealReferenceToken } from './reference/token.js';

const [command, arg] = process.argv.slice(2);

/** One line from stdin; not echoed when typed at a terminal. */
async function readSecret(prompt: string): Promise<string> {
  const tty = process.stdin.isTTY;
  if (tty) process.stdout.write(prompt);
  const rl = readline.createInterface({ input: process.stdin, output: new Writable({ write: (_c, _e, cb) => cb() }), terminal: !!tty });
  const line = await new Promise<string>(resolve => { rl.once('line', resolve); rl.once('close', () => resolve('')); });
  rl.close();
  if (tty) process.stdout.write('\n');
  return line;
}

/** Writes as the table owner: the API role can only read reference_credential. */
async function asOwner(fn: (tx: Parameters<Parameters<ReturnType<typeof drizzle<typeof schema>>['transaction']>[0]>[0]) => Promise<void>) {
  const ownerUrl = process.env.MIGRATION_DATABASE_URL;
  if (!ownerUrl) throw new Error('Set MIGRATION_DATABASE_URL (table owner) for this command.');
  const sql = postgres(ownerUrl, { max: 1, onnotice: () => {} });
  try { await drizzle(sql, { schema }).transaction(fn); } finally { await sql.end(); }
}

async function main() {
  switch (command) {
    case 'set-token': {
      const token = (await readSecret('Rasid PRAL token (input hidden): ')).trim().replace(/^Bearer\s+/i, '');
      if (token.length < 16 || token.length > 4096 || /\s/.test(token)) throw new Error('That does not look like a valid token.');
      try { await fbr.reference(token, 'provinces', '', { retry: false, timeoutMs: 15_000 }); }
      catch (e) { throw new Error(`FBR did not accept the token, so it was not saved: ${(e as Error).message}`); }
      const row = sealReferenceToken(token);
      await asOwner(async tx => {
        await tx.insert(schema.referenceCredential).values(row).onConflictDoUpdate({ target: schema.referenceCredential.id, set: row });
        await audit({ actor: 'cli', action: 'reference_token_saved', detail: row.hint }, tx);
      });
      console.log(`Saved (${row.hint}). The worker uses it from its next refresh; run "refresh" to fill the cache now.`);
      break;
    }
    case 'clear-token':
      await asOwner(async tx => {
        await tx.delete(schema.referenceCredential);
        await audit({ actor: 'cli', action: 'reference_token_cleared' }, tx);
      });
      console.log('Removed. Cached lists stay until the next successful refresh.');
      break;
    case 'refresh': {
      if (arg && !/^\d{4}-\d{2}-\d{2}$/.test(arg)) throw new Error('Date must be YYYY-MM-DD.');
      const t = await referenceToken();
      if (!t) throw new Error('No reference token, and no customer token has passed a test. Run set-token first.');
      const summary = await refreshReference({ token: t.token, source: t.source, date: arg });
      if (summary.stoppedBy401) await rejectReferenceToken(t);
      console.log(JSON.stringify(summary, null, 2));
      if (summary.failed.length) process.exitCode = 2;
      break;
    }
    case 'status':
      console.log(JSON.stringify({
        tokenConfigured: await hasReferenceToken(), tokenSource: await referenceTokenSource(),
        saleTypesNeedingReview: await saleTypesNeedingReview(), ...(await cacheStatus()),
      }, null, 2));
      break;
    case 'sale-types':
      console.log(JSON.stringify(await allSaleTypes(), null, 2));
      break;
    case 'map-sale-type': {
      // map-sale-type "<sale type>" <transTypeId>: confirm a mapping by hand; "auto" hands it back to the automatic match.
      const name = arg ?? '';
      const target = process.argv[4] ?? '';
      const [row] = await db.select().from(schema.saleTypes).where(eq(schema.saleTypes.name, name));
      if (!row) throw new Error(`No sale type named "${name}". Run "sale-types" for the list.`);
      const types = toTransTypes((await readList(requests.transTypes()))?.data);
      let set: Partial<typeof schema.saleTypes.$inferInsert>;
      if (target === 'auto') {
        set = types.length
          ? { ...matchSaleType(name, types), confirmedAt: null, checkedAt: new Date() }
          : { transTypeId: null, pralDesc: null, needsReview: true, reviewNote: 'Not matched yet: waits for PRAL’s transtypecode list.', confirmedAt: null, checkedAt: null };
      } else {
        if (!/^\d+$/.test(target)) throw new Error('Give a transaction type id (number) or "auto".');
        const id = Number(target);
        const known = types.find(t => t.id === id);
        if (types.length && !known) throw new Error(`${id} is not in PRAL's cached transtypecode list. Refresh first if PRAL added it.`);
        set = { transTypeId: id, pralDesc: known?.desc ?? null, needsReview: false, reviewNote: 'Confirmed by an operator.', confirmedAt: new Date() };
      }
      await asOwner(async tx => {
        await tx.update(schema.saleTypes).set({ ...set, updatedAt: new Date() }).where(eq(schema.saleTypes.name, name));
        await audit({ actor: 'cli', action: 'sale_type_mapped', detail: `${name} → ${target}` }, tx);
      });
      const [after] = await db.select().from(schema.saleTypes).where(eq(schema.saleTypes.name, name));
      console.log(JSON.stringify(after, null, 2));
      break;
    }
    default:
      console.error('Usage: reference-cli set-token | clear-token | refresh [YYYY-MM-DD] | status | sale-types | map-sale-type "<name>" <id|auto>');
      process.exitCode = 1;
  }
}

main()
  .catch(e => { console.error((e instanceof Error ? e.message : String(e)).replace(/Bearer\s+\S+/g, 'Bearer [redacted]')); process.exitCode = 1; })
  .finally(() => closeDb());
