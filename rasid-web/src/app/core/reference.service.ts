import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../environments/environment';
import { HS_SAMPLE, HS_UOM_RULES, UOMS, saleTypeDef } from './fbr-reference';
import { ReferenceCache } from './reference-cache';
import { Store } from './store';
import type { ReferenceChecks } from './tax';
import { todayIso } from './util';

export interface HsOption { code: string; desc: string }
/** A PRAL rate: `value` is the percentage PRAL gives with it (null if none). */
export interface LiveRate { id: number; desc: string; value: number | null }
export interface SroOption { id: number; desc: string }

/** `source: 'none'`: the API has no PRAL copy of this list; use the bundled one. */
type Source = 'pral' | 'none';
interface SaleTypesResponse { source: Source; saleTypes: { saleType: string; rates: LiveRate[]; asOf: string | null }[] }
interface UomsResponse { source: Source; items: { id: number; description: string }[] }
interface HsResponse { source: Source; results: { code: string; description: string }[] }
interface HsUomResponse { source: Source; uoms: string[] }
interface HsCheckResponse { source: Source; codes: Record<string, { known: boolean; description?: string; uoms: string[] | null }> }

const HS_RE = /^\d{4}\.\d{4}$/;
const bundledUoms = (hs: string) => (HS_UOM_RULES[hs] ? [HS_UOM_RULES[hs]] : null);

/**
 * PRAL reference data for the forms. With the API, rates, UOMs, HS codes and
 * HS→UOM rules come from Rasid's PRAL cache (rasid-api /api/businesses/:id/reference),
 * for the active business's province and the invoice's date. Answers are kept
 * in memory and IndexedDB for 24 hours (ReferenceCache). Offline, or for
 * anything the API has no PRAL copy of, the bundled lists in fbr-reference.ts are used.
 */
@Injectable({ providedIn: 'root' })
export class ReferenceService {
  private store = inject(Store);
  private http = inject(HttpClient);
  private cache = inject(ReferenceCache);

  /** "province|date" → lower-case sale type → PRAL rates. */
  private live = signal(new Map<string, Map<string, LiveRate[]>>());
  private liveUoms = signal<string[]>([]);
  /** HS code → allowed UOMs (null = PRAL has no rule for it). */
  private hsUomRules = signal(new Map<string, string[] | null>());
  /** HS code → whether FBR's HS list has it, from searches and hs-check. */
  private hsKnownMap = signal(new Map<string, boolean>());
  private hsUomPending = new Map<string, Promise<string[] | null>>();
  /** Date of today's PRAL rates, or null when the bundled defaults are shown. */
  readonly ratesAsOf = signal<string | null>(null);
  private ratesRequested = new Map<string, Promise<void>>();
  private uomsRequested = false;

  /** UOMs to offer: PRAL's list when known. */
  uoms(): string[] {
    this.ensureLoaded(todayIso());
    const live = this.liveUoms();
    return live.length ? live : UOMS;
  }

  private ratesKey(date: string) { return `${this.store.business()?.province ?? ''}|${date}`; }

  /**
   * Loads rates (for the seller's province on `date`) and the UOM list the first
   * time they're read. Lazy, so services that only check rules (PostingService)
   * don't trigger requests.
   */
  private ensureLoaded(date: string) {
    if (this.store.mode !== 'api' || !this.store.business()) return;
    if (!this.uomsRequested) { this.uomsRequested = true; queueMicrotask(() => void this.loadUoms()); }
    if (!this.ratesRequested.has(this.ratesKey(date))) queueMicrotask(() => void this.loadRates(date));
  }

  /** Rates for `date` (default today); resolves when they're loaded or known to be unavailable. */
  loadRates(date = todayIso()): Promise<void> {
    const b = this.store.business();
    if (this.store.mode !== 'api' || !b || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return Promise.resolve();
    const key = this.ratesKey(date);
    let p = this.ratesRequested.get(key);
    if (!p) {
      p = this.get<SaleTypesResponse>('/rates', { province: b.province, date }).then(r => {
        if (r.source !== 'pral') return;
        const byType = new Map(r.saleTypes.filter(s => s.rates.length).map(s => [s.saleType.toLowerCase(), s.rates]));
        this.live.update(m => new Map(m).set(key, byType));
        if (date === todayIso()) this.ratesAsOf.set(r.saleTypes.find(s => s.asOf)?.asOf ?? null);
      }).catch(() => undefined);
      this.ratesRequested.set(key, p);
    }
    return p;
  }

  private async loadUoms() {
    try {
      const r = await this.get<UomsResponse>('/uom');
      this.liveUoms.set(r.source === 'pral' ? r.items.map(u => u.description) : []);
    } catch { this.liveUoms.set([]); }
  }

  /** Reference endpoints are scoped to the active business; answers go through the 24 h cache. */
  private get<T>(path: string, params: Record<string, string | number> = {}): Promise<T> {
    const id = this.store.business()?.id;
    if (!id) return Promise.reject(new Error('No active business'));
    const key = `${path}?${new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]))}`;
    return this.cache.get(key,
      () => firstValueFrom(this.http.get<T>(`${environment.apiBaseUrl}/businesses/${encodeURIComponent(id)}/reference${path}`, { params })),
      value => (value as { source?: Source }).source === 'pral');
  }

  /** PRAL's rates for a sale type on `date` (no request), or undefined when there's no PRAL list for it. */
  liveRates(saleType: string, date = todayIso()): LiveRate[] | undefined {
    return this.live().get(this.ratesKey(date))?.get(saleType.trim().toLowerCase());
  }

  /** Rates to offer for a sale type on `date`, PRAL's when known; the first is the default. */
  rates(saleType: string, date = todayIso()): string[] {
    this.ensureLoaded(date);
    const live = this.liveRates(saleType, date);
    return live ? live.map(r => r.desc) : (saleTypeDef(saleType)?.offlineRates ?? []);
  }
  defaultRate(saleType: string, date = todayIso()): string { return this.rates(saleType, date)[0] ?? '18%'; }

  /** The PRAL rate behind a rate string (its id for SRO lookups, its numeric value for tax). */
  rateInfo(saleType: string, rate: string, date = todayIso()): LiveRate | undefined {
    this.ensureLoaded(date);
    return this.liveRates(saleType, date)?.find(r => r.desc === rate);
  }
  rateId(saleType: string, rate: string, date = todayIso()): number | undefined { return this.rateInfo(saleType, rate, date)?.id; }

  /** HS codes by code prefix or description words. */
  async searchHs(q: string, limit = 20): Promise<HsOption[]> {
    const text = q.trim();
    if (text.length < 2) return [];
    if (this.store.mode === 'api') {
      try {
        const r = await this.get<HsResponse>('/hs', { q: text, limit });
        if (r.source === 'pral') {
          this.hsKnownMap.update(m => { const n = new Map(m); r.results.forEach(h => n.set(h.code, true)); return n; });
          return r.results.map(h => ({ code: h.code, desc: h.description }));
        }
      } catch { /* fall back to the bundled sample */ }
    }
    const digits = text.replace(/\./g, '');
    const words = text.toLowerCase().split(/\s+/);
    return HS_SAMPLE.filter(h => (/^\d+$/.test(digits) && h.code.replace('.', '').startsWith(digits)) || words.every(w => h.desc.toLowerCase().includes(w)))
      .slice(0, limit).map(h => ({ code: h.code, desc: h.desc }));
  }

  /** Whether FBR's HS list has the code: true / false once checked (API only), undefined before. */
  hsKnown(hsCode: string): boolean | undefined { return this.hsKnownMap().get(hsCode); }

  /**
   * Checks HS codes against FBR's list and loads the units each allows, 100 per
   * request (bulk import, typed codes). Codes already checked are skipped.
   */
  async checkHs(codes: readonly string[]): Promise<void> {
    if (this.store.mode !== 'api') return;
    const todo = [...new Set(codes.map(c => c.trim()))].filter(c => HS_RE.test(c) && !(this.hsKnownMap().has(c) && this.hsUomRules().has(c)));
    for (let i = 0; i < todo.length; i += 100) {
      const chunk = todo.slice(i, i + 100);
      try {
        const r = await this.get<HsCheckResponse>('/hs-check', { codes: chunk.join(',') });
        if (r.source !== 'pral') continue;
        this.hsKnownMap.update(m => { const n = new Map(m); for (const c of chunk) if (r.codes[c]) n.set(c, r.codes[c]!.known); return n; });
        this.hsUomRules.update(m => {
          const n = new Map(m);
          for (const c of chunk) if (r.codes[c]?.known) n.set(c, r.codes[c]!.uoms ?? bundledUoms(c));
          return n;
        });
      } catch { /* unchecked codes stay unknown: FBR's validate is the final check */ }
    }
  }

  /** Allowed UOMs for an HS code once looked up (see hsUoms), else the bundled rule; undefined = no rule known. */
  allowedUoms(hsCode: string): string[] | undefined {
    const live = this.hsUomRules().get(hsCode);
    if (live !== undefined) return live ?? undefined;
    return bundledUoms(hsCode) ?? undefined;
  }

  /** Looks up (once per code) which UOMs PRAL allows for an HS code. */
  hsUoms(hsCode: string): Promise<string[] | null> {
    if (!HS_RE.test(hsCode)) return Promise.resolve(null);
    if (this.store.mode !== 'api') return Promise.resolve(this.allowedUoms(hsCode) ?? null);
    if (this.hsUomRules().has(hsCode)) return Promise.resolve(this.hsUomRules().get(hsCode) ?? null);
    let p = this.hsUomPending.get(hsCode);
    if (!p) {
      p = this.get<HsUomResponse>('/uom-for-hs', { hs: hsCode })
        .then(r => (r.source === 'pral' && r.uoms.length ? r.uoms : null))
        .catch(() => undefined)
        .then(list => {
          if (list === undefined) return this.allowedUoms(hsCode) ?? null; // API unreachable: try again next time
          this.hsUomRules.update(m => new Map(m).set(hsCode, list ?? bundledUoms(hsCode)));
          return this.allowedUoms(hsCode) ?? null;
        })
        .finally(() => this.hsUomPending.delete(hsCode));
      this.hsUomPending.set(hsCode, p);
    }
    return p;
  }

  /** What validateInvoice checks against: HS→UOM rules, FBR's HS list and PRAL rates. Reads only; no requests. */
  checks(): ReferenceChecks {
    return {
      allowedUoms: hs => this.allowedUoms(hs),
      hsKnown: hs => this.hsKnown(hs),
      liveRates: (saleType, date) => this.liveRates(saleType, date)?.map(r => r.desc),
      rateValue: (saleType, rate, date) => this.liveRates(saleType, date)?.find(r => r.desc === rate)?.value ?? undefined,
    };
  }

  /** SRO schedules PRAL lists for a rate in the seller's province (API only). */
  async sroSchedules(saleType: string, rate: string, date: string): Promise<SroOption[]> {
    await this.loadRates(date);
    const rateId = this.rateId(saleType, rate, date);
    const province = this.store.business()?.province;
    if (this.store.mode !== 'api' || !rateId || !province) return [];
    try {
      const r = await this.get<{ source: Source; schedules: { id: number; desc: string }[] }>('/sro', { rateId, province, date });
      return r.schedules.map(s => ({ id: s.id, desc: s.desc }));
    } catch { return []; }
  }

  async sroItems(sroId: number, date: string): Promise<SroOption[]> {
    if (this.store.mode !== 'api') return [];
    try { return (await this.get<{ source: Source; items: SroOption[] }>('/sro-items', { sroId, date })).items; } catch { return []; }
  }
}
