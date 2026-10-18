/**
 * Posting state transitions. The database status is the lock: an invoice is
 * handed to the queue only by moving it to `queued` here, so a double click or
 * two browser tabs can never queue it twice.
 *
 *   draft | validated | failed  --queue-->  queued  --worker-->  posting
 *   posting --> posted | failed | outcome_unknown
 *   outcome_unknown --queue (person confirmed it is not in IRIS)--> queued
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import { invoices, type FieldIssue, type HistoryEntry, type InvoiceStatus } from '../db/schema.js';

/** FBR has not recorded these, so they may be posted. */
export const POSTABLE: InvoiceStatus[] = ['draft', 'validated', 'failed'];

export const appendHistory = (entry: Omit<HistoryEntry, 'at'>) =>
  sql`${invoices.history} || ${JSON.stringify([{ at: new Date().toISOString(), ...entry }])}::jsonb`;

export interface Skipped { id: string; status: InvoiceStatus | null; message: string }

export function notPostable(status: InvoiceStatus | null): string {
  switch (status) {
    case null: return 'Invoice not found.';
    case 'posted': return 'This invoice is already posted to FBR.';
    case 'outcome_unknown': return 'FBR may have recorded this invoice. Check IRIS; if it is not there, post it on its own and confirm.';
    default: return 'This invoice is already being posted.';
  }
}

/** Moves postable invoices to `queued` under one batch id; returns the ones moved and why the rest were not. */
export async function queueInvoices(tx: Tx, ids: string[], batchId: string, actorName: string, { allowUnknown = false } = {}) {
  const from = allowUnknown ? [...POSTABLE, 'outcome_unknown' as const] : POSTABLE;
  const queued = await tx.update(invoices)
    .set({ status: 'queued', batchId, updatedAt: new Date(), history: appendHistory({ actor: actorName, action: 'Queued for FBR' }) })
    .where(and(inArray(invoices.id, ids), inArray(invoices.status, from)))
    .returning({ id: invoices.id, localRef: invoices.localRef });
  const moved = new Set(queued.map(q => q.id));
  const rest = ids.filter(id => !moved.has(id));
  const found = rest.length
    ? await tx.select({ id: invoices.id, status: invoices.status }).from(invoices).where(inArray(invoices.id, rest))
    : [];
  const statusOf = new Map(found.map(f => [f.id, f.status]));
  const skipped: Skipped[] = rest.map(id => {
    const status = statusOf.get(id) ?? null;
    return { id, status, message: notPostable(status) };
  });
  return { queued, skipped };
}

/** The queue could not take them: put them back as failed so they can be posted again. */
export async function failQueued(tx: Tx, ids: string[], batchId: string, issue: FieldIssue) {
  await tx.update(invoices)
    .set({ status: 'failed', issues: [issue], updatedAt: new Date(), history: appendHistory({ actor: 'system', action: 'Post failed', detail: issue.message }) })
    .where(and(inArray(invoices.id, ids), eq(invoices.status, 'queued'), eq(invoices.batchId, batchId)));
}

export interface BatchProgress {
  batchId: string;
  total: number;
  queued: number;
  posting: number;
  posted: number;
  failed: number;
  outcomeUnknown: number;
  done: number;
  running: boolean;
}

export async function batchProgress(tx: Tx, batchId: string): Promise<BatchProgress> {
  const rows = await tx.select({ status: invoices.status, n: sql<number>`count(*)::int` }).from(invoices)
    .where(eq(invoices.batchId, batchId)).groupBy(invoices.status);
  const n = (s: InvoiceStatus) => rows.find(r => r.status === s)?.n ?? 0;
  const total = rows.reduce((t, r) => t + r.n, 0);
  const inFlight = n('queued') + n('posting');
  return {
    batchId, total, queued: n('queued'), posting: n('posting'), posted: n('posted'), failed: n('failed'),
    outcomeUnknown: n('outcome_unknown'), done: total - inFlight, running: inFlight > 0,
  };
}

/** Per-invoice result fields streamed to the browser while a batch runs. */
export const batchInvoiceFields = {
  id: invoices.id,
  localRef: invoices.localRef,
  status: invoices.status,
  issues: invoices.issues,
  attempts: invoices.attempts,
  fbrInvoiceNumber: invoices.fbrInvoiceNumber,
  fbrItemNumbers: invoices.fbrItemNumbers,
  fbrDated: invoices.fbrDated,
  updatedAt: invoices.updatedAt,
};
