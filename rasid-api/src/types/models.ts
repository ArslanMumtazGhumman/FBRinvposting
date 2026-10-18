/** Row types derived from the Drizzle schema (src/db/schema.ts). */
import type * as s from '../db/schema.js';

export type { FbrEnv, Role } from '../db/schema.js';

export type User = typeof s.users.$inferSelect;
export type Business = typeof s.businesses.$inferSelect;
export type Membership = typeof s.memberships.$inferSelect;

/** Vault output: key version + base64(iv | tag | ciphertext). */
export interface Sealed {
  version: string;
  data: string;
}
