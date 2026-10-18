/**
 * Rasid's own PRAL token for reference lists. Customers' tokens are never used
 * for this: they belong to the customer and FBR attributes calls to them.
 * Sealed like customer tokens; the plaintext lives for one refresh or lookup.
 */
import { eq } from 'drizzle-orm';
import { db, type Executor } from '../db/client.js';
import { referenceCredential } from '../db/schema.js';
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
