/**
 * Append-only, hash-chained audit log. Each entry stores the SHA-256 of the
 * previous entry, so any edit or deletion breaks the chain (verifyChain()).
 * Tokens and full payloads are never logged here; payloads are hashed.
 *
 * Appends are serialised with a transaction-level advisory lock so the chain
 * stays linear across API and worker processes. The API role can append but
 * not read the log; it only sees the latest hash through audit_tip().
 */
import crypto from 'node:crypto';
import { asc, gt, sql } from 'drizzle-orm';
import { db, type Executor, type Tx } from '../db/client.js';
import { auditLog } from '../db/schema.js';
import type { FbrEnv } from '../types/models.js';

export interface AuditEntry {
  actor: string;
  action: string;
  businessId?: string;
  detail?: string;
  ip?: string;
  payloadHash?: string;
  attempts?: number;
  latencyMs?: number;
  env?: FbrEnv;
}
type Chained = AuditEntry & { at: string; prev: string };

const AUDIT_LOCK = 0x72617369; // "rasi"
const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

/** Keys sorted, empty fields dropped, so a row read back from Postgres hashes the same as when written. */
function canonical(row: Chained): string {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(row).sort()) {
    const v = row[k as keyof Chained];
    if (v !== undefined && v !== null) out[k] = v;
  }
  return JSON.stringify(out);
}
const chainHash = (row: Chained) => sha(row.prev + canonical(row));

/** Appends inside `tx` when given (business events must use their withBusiness transaction). */
export async function audit(entry: AuditEntry, tx?: Tx): Promise<void> {
  const append = async (t: Tx) => {
    await t.execute(sql`select pg_advisory_xact_lock(${AUDIT_LOCK})`);
    const [tip] = await t.execute<{ hash: string | null }>(sql`select audit_tip() as hash`);
    const at = new Date();
    const row: Chained = { ...entry, at: at.toISOString(), prev: tip?.hash ?? 'genesis' };
    await t.insert(auditLog).values({ ...entry, at, prev: row.prev, hash: chainHash(row) });
  };
  return tx ? append(tx) : db.transaction(append);
}

/** Walks the whole chain. Needs a connection that can read audit_log (the owner), not the API role. */
export async function verifyChain(admin: Executor): Promise<boolean> {
  let prev = 'genesis';
  let lastId = 0;
  for (;;) {
    const rows = await admin.select().from(auditLog).where(gt(auditLog.id, lastId)).orderBy(asc(auditLog.id)).limit(1000);
    if (!rows.length) return true;
    for (const r of rows) {
      const row: Chained = {
        actor: r.actor, action: r.action, businessId: r.businessId ?? undefined, detail: r.detail ?? undefined,
        ip: r.ip ?? undefined, payloadHash: r.payloadHash ?? undefined, attempts: r.attempts ?? undefined,
        latencyMs: r.latencyMs ?? undefined, env: r.env ?? undefined, at: r.at.toISOString(), prev: r.prev,
      };
      if (r.prev !== prev || r.hash !== chainHash(row)) return false;
      prev = r.hash;
      lastId = r.id;
    }
  }
}

export const hashPayload = (obj: unknown) => sha(JSON.stringify(obj));
