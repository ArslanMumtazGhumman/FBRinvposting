import { HttpClient } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../environments/environment';
import { toApiError } from './api';
import type { ApiStoreService } from './api-store.service';
import { FbrAuthError, FbrGatewayService, FbrUnknownOutcomeError, TransientFbrError } from './fbr-gateway.service';
import { FBR_ERROR_HELP } from './fbr-reference';
import { FbrResponse, FieldIssue, Invoice } from './models';
import { Store } from './store';
import { toPayload, validateInvoice } from './tax';
import { nowIso, sleep } from './util';

export type Outcome =
  | { ok: true; invoice: Invoice }
  | { ok: false; invoice: Invoice; reason: 'invalid' | 'auth' | 'transient' | 'unknown'; message?: string };

export interface BatchProgress {
  total: number;
  done: number;
  posted: number;
  failed: number;
  /** Not queued because they were already posted, in flight, or need an IRIS check. */
  skipped: number;
  retrying: number;
  running: boolean;
  paused: boolean;
}

/** GET /invoices/batches/:id and the SSE `progress` / `done` events. */
interface ServerProgress { total: number; queued: number; posting: number; posted: number; failed: number; outcomeUnknown: number; done: number; running: boolean }
/** SSE `invoice` event. */
type ServerInvoiceUpdate = Pick<Invoice, 'id' | 'status' | 'issues' | 'attempts' | 'fbrInvoiceNumber' | 'fbrItemNumbers' | 'fbrDated'>;

const RETRY_DELAYS_MS = [1000, 3000, 8000];   // offline demo only; the server worker has its own rules
const CONCURRENCY = 3;                         // per business; FBR is the bottleneck
const BATCH_REQUEST_MAX = 5000;                // ids per POST /post-batch
const POLL_MS = 2000;                          // fallback when the event stream is unavailable

const IRIS_HINT = 'FBR may have recorded this invoice. Search for it in IRIS before posting again, to avoid a duplicate.';

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

/** Server issues carry no hint; add the same help text the simulator path shows. */
const withHints = (issues: FieldIssue[]) => issues.map(i => (i.hint || !FBR_ERROR_HELP[i.code] ? i : { ...i, hint: FBR_ERROR_HELP[i.code] }));

/** Why a post did not end in `posted`, from the invoice the server returned. */
function reasonFor(inv: Invoice): 'invalid' | 'auth' | 'transient' | 'unknown' {
  if (inv.status === 'outcome_unknown') return 'unknown';
  const code = inv.issues[0]?.code ?? '';
  if (code === '0401') return 'auth';
  return code.startsWith('L-5') ? 'transient' : 'invalid';
}

/**
 * Validate → post orchestration.
 *  - Offline demo (environment.useApi = false): a browser-side queue against
 *    the simulator, with bounded concurrency and retries on transient errors only.
 *  - With the API: posting runs on the server queue (BullMQ worker, 3 at a
 *    time per business). This service queues invoices, then follows the batch
 *    over Server-Sent Events and updates the store as results arrive.
 */
@Injectable({ providedIn: 'root' })
export class PostingService {
  private store = inject(Store);
  private fbr = inject(FbrGatewayService);
  private http = inject(HttpClient);
  /** Follows the store: the offline demo posts from the browser, the API store through the server queue. */
  private get useApi() { return this.store.mode === 'api'; }
  /** The server queue cannot be paused per batch; the buttons are hidden then. */
  get canPause() { return !this.useApi; }

  readonly progress = signal<BatchProgress>({ total: 0, done: 0, posted: 0, failed: 0, skipped: 0, retrying: 0, running: false, paused: false });
  readonly percent = computed(() => {
    const p = this.progress();
    return p.total ? Math.round((p.done / p.total) * 100) : 0;
  });
  private cancelled = false;

  /** Local + FBR validation without posting. Saves the result. */
  async validate(inv: Invoice): Promise<Invoice> {
    const biz = this.store.business()!;
    const local = validateInvoice(inv, biz);
    if (local.length) return this.store.upsertInvoice({ ...inv, issues: local, status: 'draft' });
    const res = await this.fbr.validate({ businessId: biz.id, environment: biz.environment, payload: toPayload(inv, biz), idempotencyKey: inv.localRef });
    const issues = issuesFromResponse(res);
    return this.store.upsertInvoice({
      ...inv, issues, status: issues.length ? 'draft' : 'validated',
      history: [...inv.history, { at: nowIso(), actor: this.store.user()?.name ?? 'system', action: issues.length ? 'Validation failed' : 'Validated with FBR', detail: issues.map(i => i.code).join(', ') || undefined }],
    });
  }

  /**
   * Post one invoice (already saved in the store) and wait for the result.
   * `confirmNotInIris` is required to post an outcome_unknown invoice again (API only).
   */
  post(inv: Invoice, opts: { onRetry?: () => void; confirmNotInIris?: boolean } = {}): Promise<Outcome> {
    return this.useApi ? this.postViaQueue(inv, opts.confirmNotInIris === true) : this.postLocally(inv, opts.onRetry);
  }

  /** Post many invoices with live progress. */
  postBatch(ids: string[]): Promise<void> {
    if (!ids.length) {
      this.progress.set({ total: 0, done: 0, posted: 0, failed: 0, skipped: 0, retrying: 0, running: false, paused: false });
      return Promise.resolve();
    }
    return this.useApi ? this.postBatchViaQueue(ids) : this.postBatchLocally(ids);
  }

  pause() { if (this.canPause) this.progress.update(p => ({ ...p, paused: true })); }
  resume() { this.progress.update(p => ({ ...p, paused: false })); }
  cancel() { this.cancelled = true; }

  /* ================================ API ================================ */

  private get api() { return this.store as ApiStoreService; }
  private base() { return `${environment.apiBaseUrl}/businesses/${this.store.business()!.id}/invoices`; }

  private async postViaQueue(inv: Invoice, confirmNotInIris: boolean): Promise<Outcome> {
    const biz = this.store.business()!;
    if (inv.status === 'posted') return { ok: true, invoice: inv };
    const local = validateInvoice(inv, biz);
    try {
      if (local.length) {
        return { ok: false, invoice: await this.store.upsertInvoice({ ...inv, issues: local, status: 'draft' }), reason: 'invalid' };
      }
      const r = await firstValueFrom(this.http.post<{ batchId: string; invoice: Invoice }>(`${this.base()}/${inv.id}/post`, confirmNotInIris ? { confirmNotInIris } : {}));
      this.api.applyServerInvoice(r.invoice);
      await this.followBatch(r.batchId);
    } catch (e) {
      const err = toApiError(e);
      return { ok: false, invoice: this.store.invoiceById(inv.id) ?? inv, reason: err.status === 409 && err.code === 'NOT_POSTABLE' ? 'invalid' : 'transient', message: err.message };
    }
    const final = this.store.invoiceById(inv.id)!;
    if (final.status === 'posted') {
      void this.store.learnProducts(final.items);
      return { ok: true, invoice: final };
    }
    const reason = reasonFor(final);
    return { ok: false, invoice: final, reason, message: reason === 'invalid' ? undefined : final.issues[0]?.message };
  }

  private async postBatchViaQueue(ids: string[]): Promise<void> {
    this.progress.set({ total: ids.length, done: 0, posted: 0, failed: 0, skipped: 0, retrying: 0, running: true, paused: false });
    let offset = { total: 0, done: 0, posted: 0, failed: 0 }; // finished chunks, when a batch is larger than one request
    try {
      for (let i = 0; i < ids.length; i += BATCH_REQUEST_MAX) {
        const r = await firstValueFrom(this.http.post<{ batchId: string | null; queued: string[]; skipped: { id: string; message: string }[] }>(
          `${this.base()}/post-batch`, { ids: ids.slice(i, i + BATCH_REQUEST_MAX) }));
        r.queued.forEach(id => this.store.patchInvoice(id, { status: 'queued' }));
        this.progress.update(p => ({ ...p, skipped: p.skipped + r.skipped.length, total: p.total - r.skipped.length }));
        if (!r.batchId) continue;
        const base = offset;
        const last = await this.followBatch(r.batchId, s => this.progress.update(p => ({
          ...p, done: base.done + s.done, posted: base.posted + s.posted, failed: base.failed + s.failed + s.outcomeUnknown,
        })));
        offset = { total: base.total + last.total, done: base.done + last.done, posted: base.posted + last.posted, failed: base.failed + last.failed + last.outcomeUnknown };
      }
    } catch (e) {
      throw toApiError(e);
    } finally {
      this.progress.update(p => ({ ...p, running: false }));
    }
  }

  /**
   * Follows a server batch until nothing in it is queued or posting. Uses the
   * event stream; if that drops, polls the progress endpoint instead. Finally
   * reloads the batch's invoices so history and IRNs match the server exactly.
   */
  private followBatch(batchId: string, onProgress?: (p: ServerProgress) => void): Promise<ServerProgress> {
    const url = `${this.base()}/batches/${batchId}`;
    return new Promise<ServerProgress>(resolve => {
      let finished = false;
      let latest: ServerProgress = { total: 0, queued: 0, posting: 0, posted: 0, failed: 0, outcomeUnknown: 0, done: 0, running: true };
      const seen = (p: ServerProgress) => { latest = p; onProgress?.(p); };
      const finish = async () => {
        if (finished) return;
        finished = true;
        es.close();
        try { await this.api.refreshBatch(batchId); } catch { /* the streamed fields are already in the store */ }
        for (const inv of this.store.bizInvoices()) if (inv.batchId === batchId && inv.status === 'posted') void this.store.learnProducts(inv.items);
        resolve(latest);
      };
      const poll = async () => {
        while (!finished) {
          try {
            const p = await firstValueFrom(this.http.get<ServerProgress>(url));
            seen(p);
            if (!p.running) return void finish();
          } catch (e) {
            if (toApiError(e).status === 404) return void finish();
          }
          await sleep(POLL_MS);
        }
      };

      const es = new EventSource(`${url}/events`, { withCredentials: true });
      es.addEventListener('invoice', ev => {
        const d = JSON.parse((ev as MessageEvent).data) as ServerInvoiceUpdate;
        const { id, ...fields } = d;
        this.store.patchInvoice(id, { ...fields, issues: withHints(fields.issues), batchId });
      });
      es.addEventListener('progress', ev => seen(JSON.parse((ev as MessageEvent).data)));
      es.addEventListener('done', ev => { seen(JSON.parse((ev as MessageEvent).data)); void finish(); });
      es.addEventListener('interrupted', () => { es.close(); void poll(); });
      // Network drop or proxy without streaming: stop the browser's auto-reconnect and poll instead.
      es.onerror = () => { if (!finished) { es.close(); void poll(); } };
    });
  }

  /* ============================ offline demo ============================ */

  private async postLocally(inv: Invoice, onRetry?: () => void): Promise<Outcome> {
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
          void this.store.learnProducts(inv.items);
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
          : unknown ? IRIS_HINT
          : 'FBR did not respond after several attempts. Post again later.';
        this.store.patchInvoice(inv.id, {
          status: 'failed', attempts: attempt + 1,
          issues: [{ code: reason === 'auth' ? '0401' : unknown ? 'L-504' : 'L-500', message: (e as Error).message, hint, source: 'fbr' }],
        }, { action: 'Post failed', detail: (e as Error).message });
        return { ok: false, invoice: this.store.invoiceById(inv.id)!, reason };
      }
    }
  }

  private async postBatchLocally(ids: string[]): Promise<void> {
    this.cancelled = false;
    ids.forEach(id => this.store.patchInvoice(id, { status: 'queued' }));
    this.progress.set({ total: ids.length, done: 0, posted: 0, failed: 0, skipped: 0, retrying: 0, running: true, paused: false });
    const queue = [...ids];

    const worker = async () => {
      while (queue.length && !this.cancelled) {
        while (this.progress().paused && !this.cancelled) await sleep(200);
        const id = queue.shift(); if (!id) break;
        const inv = this.store.invoiceById(id); if (!inv) continue;
        const r = await this.postLocally(inv, () => this.progress.update(p => ({ ...p, retrying: p.retrying + 1 })));
        this.progress.update(p => ({ ...p, done: p.done + 1, posted: p.posted + (r.ok ? 1 : 0), failed: p.failed + (r.ok ? 0 : 1) }));
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, ids.length) }, worker));
    if (this.cancelled) queue.forEach(id => this.store.patchInvoice(id, { status: 'validated' }));
    this.progress.update(p => ({ ...p, running: false, paused: false }));
  }
}
