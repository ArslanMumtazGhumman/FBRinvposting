/** Row shapes persisted by the store (src/lib/db.ts). */

export type Role = 'owner' | 'accountant' | 'viewer';
export type FbrEnv = 'sandbox' | 'production';

export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
  passwordHash: string;
  totpSecret?: string | null;
  fails?: number;
  lockedUntil?: string | null;
  lastLoginAt?: string;
  createdAt: string;
}

export interface Business {
  id: string;
  name: string;
  ntnCnic: string;
  province: string;
  address: string;
  activity: string;
  sector: string;
  environment: FbrEnv;
}

export interface Membership {
  userId: string;
  businessId: string;
  role: Role;
}

export interface Sealed {
  version: string;
  data: string;
}

export interface Credential {
  businessId: string;
  env: FbrEnv;
  sealed: Sealed;
  hint: string;
  updatedAt: string;
  updatedBy: string;
  lastOkAt?: string;
}

export interface Posting {
  businessId: string;
  env: FbrEnv;
  key: string;
  response: unknown;
  at: string;
}

export interface AuditRow {
  at: string;
  actor: string;
  action: string;
  businessId?: string;
  detail?: string;
  ip?: string;
  payloadHash?: string;
  attempts?: number;
  latencyMs?: number;
  env?: FbrEnv;
  prev: string;
  hash: string;
}

export interface Collections {
  users: User;
  businesses: Business;
  memberships: Membership;
  credentials: Credential;
  postings: Posting;
  audit: AuditRow;
}
