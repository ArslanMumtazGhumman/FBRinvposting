/**
 * Application database handle. Connects as the API login role (member of
 * rasid_app, not the table owner), so row-level security applies to every
 * query. Business data is only reachable inside withBusiness(), which opens a
 * transaction and sets app.user_id / app.business_id for its duration.
 */
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { config } from '../config.js';
import * as schema from './schema.js';

const client = postgres(config.databaseUrl, { max: config.dbPoolMax, onnotice: () => {} });
export const db = drizzle(client, { schema });

export type Db = typeof db;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type Executor = Db | Tx;

async function withContext<T>(userId: string, businessId: string | null, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async tx => {
    await tx.execute(sql`select set_config('app.user_id', ${userId}, true), set_config('app.business_id', ${businessId ?? ''}, true)`);
    return fn(tx);
  });
}

/** Rows of one business, visible only while userId is a member of it. */
export const withBusiness = <T>(userId: string, businessId: string, fn: (tx: Tx) => Promise<T>) => withContext(userId, businessId, fn);

/** The user's own memberships and businesses; no business-scoped rows. */
export const withUser = <T>(userId: string, fn: (tx: Tx) => Promise<T>) => withContext(userId, null, fn);

/**
 * Refuse to run as a role that would bypass row-level security
 * (superuser, BYPASSRLS, or the owner of the tables).
 */
export async function assertRlsEnforced(executor: Executor = db) {
  const rows = await executor.execute<{ bypass: boolean; owner: boolean }>(sql`
    select (r.rolsuper or r.rolbypassrls) as bypass, pg_get_userbyid(c.relowner) = current_user as owner
    from pg_roles r, pg_class c
    where r.rolname = current_user and c.oid = 'public.invoices'::regclass`);
  const row = rows[0];
  if (!row) throw new Error('Database is not migrated: run `npm run db:migrate`.');
  if (row.bypass || row.owner) {
    throw new Error('DATABASE_URL connects as a role that bypasses row-level security. Use the API login role (see .env.example).');
  }
}

export const closeDb = () => client.end({ timeout: 5 });
