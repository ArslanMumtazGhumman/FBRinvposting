import { computed, signal } from '@angular/core';
import { AuditEntry, Business, Customer, ImportMapping, Invoice, LineItem, Product, User } from './models';
import { nowIso, uid } from './util';

/** Result of saving many invoices at once (bulk import). */
export interface BulkSaveResult {
  saved: Invoice[];
  errors: { index: number; localRef?: string; message: string }[];
}

/**
 * Client-side state. Components read the signals and call the methods; they
 * never know where data lives. app.config.ts picks the implementation from
 * environment.useApi:
 *   - StoreService: offline demo, persisted to localStorage.
 *   - ApiStoreService: the signals are a cache of the Rasid API; writes are
 *     applied to the cache at once and sent to the API, and undone if it refuses.
 * Writes return promises that reject with the API's message when it refuses.
 *
 * FBR tokens are NEVER stored here; Business only carries hasXToken flags and
 * the last-4 hint returned by the API.
 */
export abstract class Store {
  abstract readonly mode: 'local' | 'api';

  readonly user = signal<User | null>(null);
  readonly businesses = signal<Business[]>([]);
  readonly activeBusinessId = signal<string | null>(null);
  readonly invoices = signal<Invoice[]>([]);
  readonly customers = signal<Customer[]>([]);
  readonly products = signal<Product[]>([]);
  readonly mappings = signal<ImportMapping[]>([]);
  /** True while the active business's data is being fetched. */
  readonly loading = signal(false);
  /** Business whose invoices, customers and products are in the signals (API store). */
  protected loadedBusiness = signal<string | null>(null);

  readonly business = computed<Business | null>(() => this.businesses().find(b => b.id === this.activeBusinessId()) ?? this.businesses()[0] ?? null);
  readonly bizInvoices = computed(() => {
    const id = this.business()?.id;
    return this.invoices().filter(i => i.businessId === id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  });
  readonly bizCustomers = computed(() => this.customers().filter(c => c.businessId === this.business()?.id));
  readonly bizProducts = computed(() => this.products().filter(p => p.businessId === this.business()?.id));
  /** The active business's data is available (always, offline). Pages that look records up by id wait for this. */
  readonly ready = computed(() => {
    const b = this.business();
    return !!b && (this.mode === 'local' || this.loadedBusiness() === b.id);
  });

  /** Resolves true when a user is signed in (the API store asks the server once). */
  abstract restoreSession(): Promise<boolean>;

  /* ---------- invoices ---------- */
  abstract upsertInvoice(inv: Invoice): Promise<Invoice>;
  /** New invoices from bulk import (the API store sends them in chunks of 500). */
  abstract upsertMany(invs: Invoice[], onProgress?: (done: number, total: number) => void): Promise<BulkSaveResult>;
  abstract deleteInvoice(id: string): Promise<void>;
  invoiceById(id: string) { return this.invoices().find(i => i.id === id); }

  /**
   * Updates the cached copy only. The local store persists it; with the API,
   * posting results come from the server and this just shows them.
   */
  patchInvoice(id: string, patch: Partial<Invoice>, audit?: Omit<AuditEntry, 'at' | 'actor'>) {
    this.invoices.update(list => list.map(i => i.id !== id ? i : {
      ...i, ...patch, updatedAt: nowIso(),
      history: audit ? [...i.history, { at: nowIso(), actor: this.user()?.name ?? 'system', ...audit }] : i.history,
    }));
  }

  /** Puts an invoice into the cache (insert or replace). */
  protected cacheInvoice(inv: Invoice) {
    this.invoices.update(list => {
      const i = list.findIndex(x => x.id === inv.id);
      if (i === -1) return [inv, ...list];
      const copy = list.slice(); copy[i] = inv; return copy;
    });
  }

  /**
   * Next invoice number shown in a new invoice. The API store only moves its
   * cached counter; the server moves its own when the invoice is saved.
   */
  nextLocalRef(): string {
    const b = this.business();
    if (!b) return uid('INV-');
    const ref = `${b.invoicePrefix}${String(b.nextInvoiceNo).padStart(5, '0')}`;
    this.businesses.update(l => l.map(x => x.id === b.id ? { ...x, nextInvoiceNo: x.nextInvoiceNo + 1 } : x));
    this.onCounterMoved();
    return ref;
  }
  protected onCounterMoved() { /* the local store persists businesses through an effect */ }

  /* ---------- business and masters ---------- */
  abstract updateBusiness(b: Business): Promise<Business>;
  abstract addBusiness(b: Business): Promise<Business>;
  abstract upsertCustomer(c: Customer): Promise<Customer>;
  abstract deleteCustomer(id: string): Promise<void>;
  abstract upsertProduct(p: Product): Promise<Product>;
  abstract deleteProduct(id: string): Promise<void>;
  abstract saveMapping(m: ImportMapping): Promise<ImportMapping>;
  abstract deleteMapping(id: string): Promise<void>;

  /** Remember HS code / UOM / price per product name after an invoice posts. Best effort. */
  async learnProducts(items: LineItem[]) {
    const b = this.business(); if (!b) return;
    const existing = new Set(this.bizProducts().map(p => p.name.toLowerCase()));
    for (const it of items) {
      const name = it.productDescription?.trim();
      if (!name || existing.has(name.toLowerCase())) continue;
      existing.add(name.toLowerCase());
      try {
        await this.upsertProduct({ id: uid('p_'), businessId: b.id, name, hsCode: it.hsCode, uoM: it.uoM, saleType: it.saleType, rate: it.rate, unitPrice: it.unitPrice });
      } catch { /* learning is optional */ }
    }
  }

  /** Clears the local demo data (local store only). */
  resetDemo() { /* nothing to reset when the data lives on the server */ }

  /** Forget everything cached for the signed-in user (sign-out). */
  clear() {
    this.user.set(null);
    this.businesses.set([]); this.activeBusinessId.set(null);
    this.invoices.set([]); this.customers.set([]); this.products.set([]); this.mappings.set([]);
    this.loadedBusiness.set(null);
  }
}
