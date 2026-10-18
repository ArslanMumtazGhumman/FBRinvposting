/**
 * Append-only, hash-chained audit log. Each entry stores the SHA-256 of the
 * previous entry, so any edit or deletion breaks the chain (verifyChain()).
 * Tokens and full payloads are never logged here; payloads are hashed.
 */
import crypto from 'node:crypto';
import { all, insert } from './db.js';
import type { AuditRow } from '../types/models.js';

export type AuditEntry = Omit<AuditRow, 'at' | 'prev' | 'hash'>;

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

export function audit(entry: AuditEntry): AuditRow {
  const list = all('audit');
  const prev = list.length ? list[list.length - 1]!.hash : 'genesis';
  const row = { at: new Date().toISOString(), ...entry, prev } as AuditRow;
  row.hash = sha(prev + JSON.stringify({ ...row, hash: undefined }));
  insert('audit', row);
  return row;
}

export function verifyChain(): boolean {
  let prev = 'genesis';
  for (const row of all('audit')) {
    const expect = sha(prev + JSON.stringify({ ...row, hash: undefined }));
    if (row.prev !== prev || row.hash !== expect) return false;
    prev = row.hash;
  }
  return true;
}

export const hashPayload = (obj: unknown) => sha(JSON.stringify(obj));
