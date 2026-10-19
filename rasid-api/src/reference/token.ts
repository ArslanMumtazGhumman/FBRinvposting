/**
 * The PRAL token used for reference lists. Rasid's own token first. Only when
 * it isn't set, a customer's token that passed its last test is used instead
 * (production first), because FBR attributes calls to the token's owner.
 * Either way the plaintext lives for one refresh or lookup and stays on the server.
 */
import { eq, sql } from 'drizzle-orm';
import { db, type Executor } from '../db/client.js';
import { referenceCredential, type FbrEnv, type ReferenceSource } from '../db/schema.js';
import { decrypt, encrypt, hint } from '../lib/vault.js';

const AAD = 'platform:reference';

export async function loadReferenceToken(executor: Executor = db): Promise<string | null> {
  const [row] = await executor.select({ keyVersion: referenceCredential.keyVersion, ciphertext: referenceCredential.ciphertext })
    .from(referenceCredential).where(eq(referenceCredential.id, 'pral'));
  return row ? decrypt({ version: row.keyVersion, data: row.ciphertext }, AAD) : null;
}

/** Row to store; only the table owner can write it (reference-cli). */
export function sealReferenceToken(token: string) {
  const sealed = encrypt(token, AAD);
  return { id: 'pral', keyVersion: sealed.version, ciphertext: sealed.data, hint: hint(token), updatedAt: new Date() };
}

export async function hasReferenceToken(executor: Executor = db): Promise<boolean> {
  const [row] = await executor.select({ id: referenceCredential.id }).from(referenceCredential);
  return !!row;
}

export interface ReferenceToken {
  token: string;
  source: ReferenceSource;
  /** Set for a customer's token, so a 401 can retire it (see rejectReferenceToken). */
  businessId?: string;
}

/** Rasid's token, else a customer's tested token (production first), else null. */
export async function referenceToken(executor: Executor = db): Promise<ReferenceToken | null> {
  const own = await loadReferenceToken(executor);
  if (own) return { token: own, source: 'platform' };
  const [row] = await executor.execute<{ business_id: string; env: FbrEnv; key_version: string; ciphertext: string }>(
    sql`select * from reference_fallback_credential()`);
  if (!row) return null;
  // Same AAD as routes/credentials.ts, so a ciphertext moved to another business won't open.
  const token = decrypt({ version: row.key_version, data: row.ciphertext }, `${row.business_id}:${row.env}`);
  return { token, source: row.env, businessId: row.business_id };
}

/** FBR answered 401: a customer's token stops being a fallback until its owner tests it again. */
export async function rejectReferenceToken(t: ReferenceToken, executor: Executor = db) {
  if (t.source === 'platform' || !t.businessId) return;
  await executor.execute(sql`select reference_fallback_rejected(${t.businessId}, ${t.source})`);
}

/** Whether lookups can reach PRAL at all: Rasid's token, or a fallback. */
export async function referenceTokenSource(executor: Executor = db): Promise<ReferenceSource | null> {
  if (await hasReferenceToken(executor)) return 'platform';
  const [row] = await executor.execute<{ env: FbrEnv }>(sql`select env from reference_fallback_credential()`);
  return row?.env ?? null;
}
