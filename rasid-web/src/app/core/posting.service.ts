import { Injectable, computed, inject, signal } from '@angular/core';
import { FbrAuthError, FbrGatewayService, FbrUnknownOutcomeError, TransientFbrError } from './fbr-gateway.service';
import { FBR_ERROR_HELP } from './fbr-reference';
import { FbrResponse, FieldIssue, Invoice } from './models';
import { StoreService } from './store.service';
import { toPayload, validateInvoice } from './tax';
import { sleep } from './util';

export type Outcome = { ok: true; invoice: Invoice } | { ok: false; invoice: Invoice; reason: 'invalid' | 'auth' | 'transient' };

export interface BatchProgress {
  total: number;
  done: number;
  posted: number;
  failed: number;
  retrying: number;
  running: boolean;
  paused: boolean;
}

const RETRY_DELAYS_MS = [1000, 3000, 8000];   // production worker: 5s, 30s, 2m, 10m, 30m
const CONCURRENCY = 3;                         // per business; FBR is the bottleneck

/** Turns FBR responses into cell-level issues. */
export function issuesFromResponse(res: FbrResponse): FieldIssue[] {
  const v = res.validationResponse;
  const out: FieldIssue[] = [];
  if (v.errorCode) out.push({ code: v.errorCode, message: v.error || 'Invalid', hint: FBR_ERROR_HELP[v.errorCode], source: 'fbr', field: fieldForCode(v.errorCode) });
  (v.invoiceStatuses ?? []).forEach(s => {
    if (s.statusCode !== '00' && s.errorCode) {
      out.push({ code: s.errorCode, message: s.error || 'Invalid', hint: FBR_ERROR_HELP[s.errorCode], source: 'fbr', itemIndex: Number(s.itemSNo) - 1, field: fieldForCode(s.errorCode) });
    }
  });
  return out;
}

function fieldForCode(code: string): FieldIssue['field'] {
  const map: Record<string, FieldIssue['field']> = {
    '0002': 'ntnCnic', '0009': 'ntnCnic', '0010': 'name', '0012': 'registrationType', '0005': 'invoiceDate',
    '0013': 'saleType', '0019': 'hsCode', '0044': 'hsCode', '0052': 'hsCode', '0046': 'rate', '0020': 'rate',
    '0096': 'uoM', '0097': 'uoM', '0099': 'uoM', '0102': 'salesTaxApplicable', '0104': 'salesTaxApplicable',
    '0105': 'salesTaxApplicable', '0090': 'fixedNotifiedValueOrRetailPrice', '0026': 'invoiceRefNo', '0401': 'seller',
  };
  return map[code];
}

/**
 * Validate → post orchestration. The browser-side queue mirrors the server
 * worker (BullMQ) contract: bounded concurrency, idempotency by localRef,
 * exponential retry on transient errors only, never on FBR validation errors.
 */
@Injectable({ providedIn: 'root' })
export class PostingService {
  private store = inject(StoreService);
  private fbr = inject(FbrGatewayService);

  readonly progress = signal<BatchProgress>({ total: 0, done: 0, posted: 0, failed: 0, retrying: 0, running: false, paused: false });
  readonly percent = computed(() => {
    const p = this.progress();
    return p.total ? Math.round((p.done / p.total) * 100) : 0;
  });
  private cancelled = false;

  /** Local + FBR validation without posting. */
  async validate(inv: Invoice): Promise<Invoice> {
    const biz = this.store.business()!;
    const local = validateInvoice(inv, biz);
    if (local.length) {
      const updated = { ...inv, issues: local, status: 'draft' as const };
      this.store.upsertInvoice(updated);
      return updated;
    }
    const res = await this.fbr.validate({ businessId: biz.id, environment: biz.environment, payload: toPayload(inv, biz), idempotencyKey: inv.localRef });
    const issues = issuesFromResponse(res);
    const updated: Invoice = { ...inv, issues, status: issues.length ? 'draft' : 'validated' };
    this.store.upsertInvoice(updated);
    this.store.patchInvoice(inv.id, {}, { action: issues.length ? 'Validation failed' : 'Validated with FBR', detail: issues.map(i => i.code).join(', ') || undefined });
    return this.store.invoiceById(inv.id)!;
  }

  /** Post one invoice with retries. */
  async post(inv: Invoice, onRetry?: () => void): Promise<Outcome> {
    const biz = this.store.business()!;
    if (inv.status === 'posted') return { ok: true, invoice: inv };
    const local = validateInvoice(inv, biz);
    if (local.length) {
      this.store.patchInvoice(inv.id, { issues: local, status: 'failed' });
      return { ok: false, invoice: this.store.invoiceById(inv.id)!, reason: 'invalid' };
    }
    this.store.patchInvoice(inv.id, { status: 'posting', issues: [] });
    const payload = toPayload(inv, biz);

    for (let attempt = 0; ; attempt++) {
      try {
        const res = await this.fbr.post({ businessId: biz.id, environment: biz.environment, payload, idempotencyKey: inv.localRef });
        const issues = issuesFromResponse(res);
        if (res.invoiceNumber && !issues.length) {
          this.store.patchInvoice(inv.id, {
            status: 'posted', fbrInvoiceNumber: res.invoiceNumber, fbrDated: res.dated, attempts: attempt + 1, issues: [],
            fbrItemNumbers: (res.validationResponse.invoiceStatuses ?? []).map(s => s.invoiceNo ?? ''),
          }, { action: 'Posted to FBR', detail: res.invoiceNumber });
          this.store.learnProducts(inv.items);
          return { ok: true, invoice: this.store.invoiceById(inv.id)! };
        }
        this.store.patchInvoice(inv.id, { status: 'failed', issues, attempts: attempt + 1 },
          { action: 'Rejected by FBR', detail: issues.map(i => `${i.code} ${i.message}`).join('; ') });
        return { ok: false, invoice: this.store.invoiceById(inv.id)!, reason: 'invalid' };
      } catch (e) {
        if (e instanceof TransientFbrError && attempt < RETRY_DELAYS_MS.length) {
          onRetry?.();
          this.store.patchInvoice(inv.id, { status: 'queued', attempts: attempt + 1 }, { action: `FBR unavailable, retry ${attempt + 1}`, detail: e.message });
          await sleep(RETRY_DELAYS_MS[attempt]);
          continue;
        }
        const reason = e instanceof FbrAuthError ? 'auth' : 'transient';
        const unknown = e instanceof FbrUnknownOutcomeError;
        const hint = reason === 'auth' ? FBR_ERROR_HELP['0401']
          : unknown ? 'FBR may have recorded this invoice. Search for it in IRIS before posting again, to avoid a duplicate.'
          : 'FBR did not respond after several attempts. Post again later.';
        this.store.patchInvoice(inv.id, {
          status: 'failed', attempts: attempt + 1,
          issues: [{ code: reason === 'auth' ? '0401' : unknown ? 'L-504' : 'L-500', message: (e as Error).message, hint, source: 'fbr' }],
        }, { action: 'Post failed', detail: (e as Error).message });
        return { ok: false, invoice: this.store.invoiceById(inv.id)!, reason };
      }
    }
  }

  /** Post many invoices with bounded concurrency and live progress. */
  async postBatch(ids: string[]): Promise<void> {
    this.cancelled = false;
    ids.forEach(id => this.store.patchInvoice(id, { status: 'queued' }));
    this.progress.set({ total: ids.length, done: 0, posted: 0, failed: 0, retrying: 0, running: true, paused: false });
    const queue = [...ids];

    const worker = async () => {
      while (queue.length && !this.cancelled) {
        while (this.progress().paused && !this.cancelled) await sleep(200);
        const id = queue.shift(); if (!id) break;
        const inv = this.store.invoiceById(id); if (!inv) continue;
        const r = await this.post(inv, () => this.progress.update(p => ({ ...p, retrying: p.retrying + 1 })));
        this.progress.update(p => ({ ...p, done: p.done + 1, posted: p.posted + (r.ok ? 1 : 0), failed: p.failed + (r.ok ? 0 : 1) }));
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, ids.length) }, worker));
    if (this.cancelled) queue.forEach(id => this.store.patchInvoice(id, { status: 'validated' }));
    this.progress.update(p => ({ ...p, running: false, paused: false }));
  }

  pause() { this.progress.update(p => ({ ...p, paused: true })); }
  resume() { this.progress.update(p => ({ ...p, paused: false })); }
  cancel() { this.cancelled = true; }
}
