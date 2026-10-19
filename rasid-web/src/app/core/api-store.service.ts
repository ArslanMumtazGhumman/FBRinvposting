import { HttpClient } from '@angular/common/http';
import { Injectable, computed, effect, inject, untracked } from '@angular/core';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../environments/environment';
import { toApiError } from './api';
import { Business, Customer, ImportMapping, Invoice, Product, User } from './models';
import { BulkSaveResult, Store } from './store';
import { nowIso } from './util';

/** Newest invoices kept in the browser per business (the list view filters this cache). */
const MAX_CACHED_INVOICES = 5000;
const BULK_CHUNK = 500;
const ACTIVE_KEY = 'rasid:api:activeBusiness';

/** Body for POST/PUT /invoices: the client owns content, the server owns posting state and history. */
const invoiceBody = (i: Invoice) => ({
  id: i.id, localRef: i.localRef, invoiceType: i.invoiceType, invoiceDate: i.invoiceDate, buyer: i.buyer, items: i.items,
  invoiceRefNo: i.invoiceRefNo ?? '', scenarioId: i.scenarioId || undefined, environment: i.environment,
  status: i.status === 'validated' ? 'validated' : 'draft', issues: i.issues,
});
const businessBody = (b: Business) => ({
  id: b.id || undefined, name: b.name, ntnCnic: b.ntnCnic, province: b.province, address: b.address, activity: b.activity, sector: b.sector,
  environment: b.environment, defaultSaleType: b.defaultSaleType, furtherTaxRate: b.furtherTaxRate,
  furtherTaxRates: b.furtherTaxRates ?? [], invoicePrefix: b.invoicePrefix, nextInvoiceNo: b.nextInvoiceNo,
});
const customerBody = ({ businessId: _b, ...c }: Customer) => c;
const productBody = ({ businessId: _b, ...p }: Product) => p;

/**
 * Store backed by the Rasid API (environment.useApi = true). The signals cache
 * the signed-in user's businesses and the active business's data. Writes are
 * shown at once, sent to the API, replaced by the server's copy, and undone if
 * the API refuses (the promise then rejects with its message). Writes to the
 * same record are sent one after another, so a quick save-then-edit can't
 * reach the server out of order.
 */
@Injectable()
export class ApiStoreService extends Store {
  readonly mode = 'api' as const;
  private http = inject(HttpClient);
  private router = inject(Router);
  private session?: Promise<boolean>;
  /** Invoice ids the server already has (PUT) as opposed to new ones (POST). */
  private persisted = new Set<string>();
  private chains = new Map<string, Promise<unknown>>();
  private loadedFor: string | null = null;
  private activeId = computed(() => this.business()?.id ?? null);

  constructor() {
    super();
    try { this.activeBusinessId.set(localStorage.getItem(ACTIVE_KEY)); } catch { /* storage blocked */ }
    effect(() => { if (this.user()) untracked(() => void this.loadBusinesses()); });
    effect(() => {
      const id = this.activeId();
      try { if (id) localStorage.setItem(ACTIVE_KEY, id); } catch { /* storage blocked */ }
      if (id && id !== this.loadedFor) untracked(() => void this.loadBusinessData(id));
    });
  }

  /* ---------- transport ---------- */
  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    try {
      return await firstValueFrom(this.http.request<T>(method, environment.apiBaseUrl + path, { body }));
    } catch (e) {
      const err = toApiError(e);
      if (err.status === 401 && this.user()) { // session expired
        this.clear();
        void this.router.navigateByUrl('/login');
      }
      throw err;
    }
  }

  /** Runs writes for one record in order. */
  private serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const next = (this.chains.get(key) ?? Promise.resolve()).catch(() => undefined).then(fn);
    this.chains.set(key, next);
    void next.catch(() => undefined).finally(() => { if (this.chains.get(key) === next) this.chains.delete(key); });
    return next;
  }

  /* ---------- session and loading ---------- */
  restoreSession(): Promise<boolean> {
    if (this.user()) return Promise.resolve(true);
    return (this.session ??= this.req<User>('GET', '/auth/me')
      .then(u => { this.user.set(u); return true; })
      .catch(() => false)
      .finally(() => { this.session = undefined; }));
  }

  /** Reloads businesses (for example after saving a token, to pick up the new hint). */
  async loadBusinesses() {
    const list = await this.req<Business[]>('GET', '/businesses');
    this.businesses.set(list);
    if (!list.some(b => b.id === this.activeBusinessId())) this.activeBusinessId.set(list[0]?.id ?? null);
  }

  private async loadBusinessData(businessId: string) {
    this.loadedFor = businessId;
    this.loading.set(true);
    try {
      const base = `/businesses/${businessId}`;
      const [customers, products, mappings, invoices] = await Promise.all([
        this.req<Customer[]>('GET', `${base}/customers`),
        this.req<Product[]>('GET', `${base}/products`),
        this.req<ImportMapping[]>('GET', `${base}/import-mappings`),
        this.fetchInvoices(base, ''),
      ]);
      if (this.loadedFor !== businessId) return; // switched business meanwhile
      this.customers.set(customers);
      this.products.set(products);
      this.mappings.set(mappings);
      this.invoices.set(invoices);
      this.persisted = new Set(invoices.map(i => i.id));
      this.loadedBusiness.set(businessId);
    } catch (e) {
      if (this.loadedFor === businessId) this.loadedFor = null; // allow a retry on the next switch
      console.error('Could not load business data', e);
    } finally {
      if (this.loadedFor === businessId || this.loadedFor === null) this.loading.set(false);
    }
  }

  /** Pages through GET /invoices (newest first) up to the cache limit. */
  private async fetchInvoices(base: string, query: string, limit = MAX_CACHED_INVOICES): Promise<Invoice[]> {
    const out: Invoice[] = [];
    let cursor: string | null = null;
    do {
      const page: { items: Invoice[]; nextCursor: string | null } = await this.req('GET',
        `${base}/invoices?limit=200${query}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      out.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor && out.length < limit);
    return out;
  }

  /** Replaces cached invoices of a posting batch with the server's full copies (history included). */
  async refreshBatch(batchId: string) {
    const b = this.business(); if (!b) return;
    const fresh = await this.fetchInvoices(`/businesses/${b.id}`, `&batchId=${encodeURIComponent(batchId)}`, Infinity);
    fresh.forEach(i => { this.persisted.add(i.id); this.cacheInvoice(i); });
  }

  /** Puts a server copy of an invoice into the cache. */
  applyServerInvoice(inv: Invoice) { this.persisted.add(inv.id); this.cacheInvoice(inv); }

  /* ---------- invoices ---------- */
  upsertInvoice(inv: Invoice): Promise<Invoice> {
    const prev = this.invoiceById(inv.id);
    this.cacheInvoice({ ...inv, updatedAt: nowIso() });
    return this.serial(inv.id, async () => {
      try {
        const base = `/businesses/${inv.businessId}/invoices`;
        const saved = this.persisted.has(inv.id)
          ? await this.req<Invoice>('PUT', `${base}/${inv.id}`, invoiceBody(inv))
          : await this.req<Invoice>('POST', base, invoiceBody(inv));
        this.applyServerInvoice(saved);
        return saved;
      } catch (e) {
        if (prev) this.cacheInvoice(prev); else this.invoices.update(l => l.filter(i => i.id !== inv.id));
        throw e;
      }
    });
  }

  async upsertMany(invs: Invoice[], onProgress?: (done: number, total: number) => void): Promise<BulkSaveResult> {
    const result: BulkSaveResult = { saved: [], errors: [] };
    const fresh = invs.map((inv, index) => ({ inv, index })).filter(x => !this.persisted.has(x.inv.id));
    // Already on the server (rare for an import): save one by one.
    for (const { inv, index } of invs.map((inv, index) => ({ inv, index })).filter(x => this.persisted.has(x.inv.id))) {
      try { result.saved.push(await this.upsertInvoice(inv)); }
      catch (e) { result.errors.push({ index, localRef: inv.localRef, message: (e as Error).message }); }
    }
    let done = invs.length - fresh.length;
    for (let i = 0; i < fresh.length; i += BULK_CHUNK) {
      const chunk = fresh.slice(i, i + BULK_CHUNK);
      try {
        const r = await this.req<{ created: { index: number; invoice: Invoice }[]; errors: { index: number; localRef?: string; issues: { path: string; message: string }[] }[] }>(
          'POST', `/businesses/${chunk[0]!.inv.businessId}/invoices/bulk`, { invoices: chunk.map(x => invoiceBody(x.inv)) });
        for (const c of r.created) { this.applyServerInvoice(c.invoice); result.saved.push(c.invoice); }
        for (const e of r.errors) {
          result.errors.push({ index: chunk[e.index]!.index, localRef: e.localRef, message: e.issues.map(x => (x.path ? `${x.path}: ` : '') + x.message).join('; ') });
        }
      } catch (e) {
        chunk.forEach(x => result.errors.push({ index: x.index, localRef: x.inv.localRef, message: (e as Error).message }));
      }
      done += chunk.length;
      onProgress?.(done, invs.length);
    }
    result.errors.sort((a, b) => a.index - b.index);
    return result;
  }

  deleteInvoice(id: string): Promise<void> {
    const prev = this.invoiceById(id);
    this.invoices.update(l => l.filter(i => i.id !== id));
    if (!prev || !this.persisted.has(id)) return Promise.resolve();
    return this.serial(id, async () => {
      try {
        await this.req('DELETE', `/businesses/${prev.businessId}/invoices/${id}`);
        this.persisted.delete(id);
      } catch (e) { this.cacheInvoice(prev); throw e; }
    });
  }

  /* ---------- business and masters ---------- */
  updateBusiness(b: Business): Promise<Business> {
    const prev = this.businesses().find(x => x.id === b.id);
    this.businesses.update(l => l.map(x => x.id === b.id ? b : x));
    return this.serial(b.id, async () => {
      try {
        const saved = await this.req<Business>('PUT', `/businesses/${b.id}`, businessBody(b));
        this.businesses.update(l => l.map(x => x.id === b.id ? saved : x));
        return saved;
      } catch (e) {
        if (prev) this.businesses.update(l => l.map(x => x.id === b.id ? prev : x));
        throw e;
      }
    });
  }

  async addBusiness(b: Business): Promise<Business> {
    const saved = await this.req<Business>('POST', '/businesses', businessBody(b));
    this.businesses.update(l => [...l, saved]);
    this.activeBusinessId.set(saved.id);
    return saved;
  }

  upsertCustomer(c: Customer): Promise<Customer> {
    return this.optimistic(this.customers, c, () => this.req<Customer>('PUT', `/businesses/${c.businessId}/customers/${c.id}`, customerBody(c)));
  }
  deleteCustomer(id: string): Promise<void> {
    const c = this.customers().find(x => x.id === id);
    return this.optimisticDelete(this.customers, id, () => this.req('DELETE', `/businesses/${c?.businessId}/customers/${id}`));
  }
  upsertProduct(p: Product): Promise<Product> {
    return this.optimistic(this.products, p, () => this.req<Product>('PUT', `/businesses/${p.businessId}/products/${p.id}`, productBody(p)));
  }
  deleteProduct(id: string): Promise<void> {
    const p = this.products().find(x => x.id === id);
    return this.optimisticDelete(this.products, id, () => this.req('DELETE', `/businesses/${p?.businessId}/products/${id}`));
  }

  async saveMapping(m: ImportMapping): Promise<ImportMapping> {
    // Unmapped fields are kept as null in the editor; the API stores mapped ones only.
    const map = Object.fromEntries(Object.entries(m.map).filter(([, v]) => !!v));
    const saved = await this.req<ImportMapping>('POST', `/businesses/${m.businessId}/import-mappings`, { id: m.id, name: m.name, signature: m.signature, map });
    this.mappings.update(l => [saved, ...l.filter(x => !(x.businessId === saved.businessId && x.signature === saved.signature))]);
    return saved;
  }
  deleteMapping(id: string): Promise<void> {
    const m = this.mappings().find(x => x.id === id);
    return this.optimisticDelete(this.mappings, id, () => this.req('DELETE', `/businesses/${m?.businessId}/import-mappings/${id}`));
  }

  override clear() {
    super.clear();
    this.loadedFor = null;
    this.persisted.clear();
  }

  /* ---------- helpers for simple records ---------- */
  private optimistic<T extends { id: string }>(list: { (): T[]; update(fn: (l: T[]) => T[]): void }, item: T, send: () => Promise<T>): Promise<T> {
    const prev = list().find(x => x.id === item.id);
    const put = (v: T) => list.update(l => l.some(x => x.id === v.id) ? l.map(x => x.id === v.id ? v : x) : [v, ...l]);
    put(item);
    return this.serial(item.id, async () => {
      try { const saved = await send(); put(saved); return saved; }
      catch (e) { if (prev) put(prev); else list.update(l => l.filter(x => x.id !== item.id)); throw e; }
    });
  }

  private optimisticDelete<T extends { id: string }>(list: { (): T[]; update(fn: (l: T[]) => T[]): void }, id: string, send: () => Promise<unknown>): Promise<void> {
    const prev = list().find(x => x.id === id);
    if (!prev) return Promise.resolve();
    list.update(l => l.filter(x => x.id !== id));
    return this.serial(id, async () => {
      try { await send(); } catch (e) { list.update(l => [prev, ...l]); throw e; }
    });
  }
}
