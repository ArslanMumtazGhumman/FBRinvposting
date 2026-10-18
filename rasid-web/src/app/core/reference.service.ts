import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../environments/environment';
import { HS_SAMPLE, HS_UOM_RULES, UOMS, saleTypeDef } from './fbr-reference';
import { Store } from './store';
import { todayIso } from './util';

export interface HsOption { code: string; desc: string }
export interface LiveRate { id: number; desc: string; value: number | null }
export interface SroOption { id: number; desc: string }

/** `source: 'none'`: the API has no PRAL copy of this list; use the bundled one. */
type Source = 'pral' | 'none';
interface SaleTypesResponse { source: Source; saleTypes: { saleType: string; rates: LiveRate[]; asOf: string | null }[] }
interface UomsResponse { source: Source; uoms: { id: number; description: string }[] }
interface HsResponse { source: Source; results: { code: string; description: string }[] }
interface HsUomResponse { source: Source; uoms: string[] }

/**
 * PRAL reference data for the forms. With the API, rates, UOMs, HS codes and
 * HS→UOM rules come from Rasid's nightly PRAL cache (rasid-api /api/reference),
 * for the active business's province. Offline, or for anything the API has no
 * PRAL copy of, the bundled lists in fbr-reference.ts are used.
 */
@Injectable({ providedIn: 'root' })
export class ReferenceService {
  private store = inject(Store);
  private http = inject(HttpClient);

  /** Lower-case sale type → PRAL rates for the seller's province, today. */
  private live = signal(new Map<string, LiveRate[]>());
  private liveUoms = signal<string[]>([]);
  /** HS code → allowed UOMs (null = PRAL has no rule for it). */
  private hsUomRules = signal(new Map<string, string[] | null>());
  private hsUomPending = new Map<string, Promise<string[] | null>>();
  /** Date of the PRAL rates in use, or null when the bundled defaults are shown. */
  readonly ratesAsOf = signal<string | null>(null);
  private loadedFor: string | null = null;

  /** UOMs to offer: PRAL's list when known. */
  uoms(): string[] {
    this.ensureLoaded();
    const live = this.liveUoms();
    return live.length ? live : UOMS;
  }

  /**
   * Loads rates and UOMs the first time they're read, and again when the
   * business, its province or the day changes. Lazy, so services that only
   * check HS→UOM rules (PostingService) don't trigger requests.
   */
  private ensureLoaded() {
    const b = this.store.business();
    if (this.store.mode !== 'api' || !b) return;
    const key = `${b.id}|${b.province}|${todayIso()}`;
    if (key === this.loadedFor) return;
    this.loadedFor = key;
    const province = b.province;
    queueMicrotask(() => void this.load(province));
  }

  private get<T>(path: string, params: Record<string, string | number> = {}): Promise<T> {
    return firstValueFrom(this.http.get<T>(environment.apiBaseUrl + '/reference' + path, { params }));
  }

  private async load(province: string) {
    const [types, uoms] = await Promise.allSettled([
      this.get<SaleTypesResponse>('/sale-types', { province, date: todayIso() }),
      this.get<UomsResponse>('/uoms'),
    ]);
    if (types.status === 'fulfilled' && types.value.source === 'pral') {
      this.live.set(new Map(types.value.saleTypes.filter(s => s.rates.length).map(s => [s.saleType.toLowerCase(), s.rates])));
      this.ratesAsOf.set(types.value.saleTypes.find(s => s.asOf)?.asOf ?? null);
    } else {
      this.live.set(new Map());
      this.ratesAsOf.set(null);
    }
    this.liveUoms.set(uoms.status === 'fulfilled' && uoms.value.source === 'pral' ? uoms.value.uoms.map(u => u.description) : []);
  }

  /** Rates to offer for a sale type, PRAL's when known; the first is the default. */
  rates(saleType: string): string[] {
    this.ensureLoaded();
    const live = this.live().get(saleType.trim().toLowerCase());
    return live ? live.map(r => r.desc) : (saleTypeDef(saleType)?.offlineRates ?? []);
  }
  defaultRate(saleType: string): string { return this.rates(saleType)[0] ?? '18%'; }

  /** PRAL's id for a rate (needed for SRO schedule lookups), when the rate came from PRAL. */
  rateId(saleType: string, rate: string): number | undefined {
    this.ensureLoaded();
    return this.live().get(saleType.trim().toLowerCase())?.find(r => r.desc === rate)?.id;
  }

  /** HS codes by code prefix or description words. */
  async searchHs(q: string, limit = 20): Promise<HsOption[]> {
    const text = q.trim();
    if (text.length < 2) return [];
    if (this.store.mode === 'api') {
      try {
        const r = await this.get<HsResponse>('/hs-codes', { q: text, limit });
        if (r.source === 'pral') return r.results.map(h => ({ code: h.code, desc: h.description }));
      } catch { /* fall back to the bundled sample */ }
    }
    const digits = text.replace(/\./g, '');
    const words = text.toLowerCase().split(/\s+/);
    return HS_SAMPLE.filter(h => (/^\d+$/.test(digits) && h.code.replace('.', '').startsWith(digits)) || words.every(w => h.desc.toLowerCase().includes(w)))
      .slice(0, limit).map(h => ({ code: h.code, desc: h.desc }));
  }

  /** Allowed UOMs for an HS code once looked up (see hsUoms), else the bundled rule; undefined = no rule known. */
  allowedUoms(hsCode: string): string[] | undefined {
    const live = this.hsUomRules().get(hsCode);
    if (live !== undefined) return live ?? undefined;
    const fixed = HS_UOM_RULES[hsCode];
    return fixed ? [fixed] : undefined;
  }

  /** Looks up (once per code) which UOMs PRAL allows for an HS code. */
  hsUoms(hsCode: string): Promise<string[] | null> {
    if (!/^\d{4}\.\d{4}$/.test(hsCode)) return Promise.resolve(null);
    if (this.store.mode !== 'api') return Promise.resolve(this.allowedUoms(hsCode) ?? null);
    if (this.hsUomRules().has(hsCode)) return Promise.resolve(this.hsUomRules().get(hsCode) ?? null);
    let p = this.hsUomPending.get(hsCode);
    if (!p) {
      p = this.get<HsUomResponse>(`/hs-codes/${hsCode}/uoms`)
        .then(r => (r.source === 'pral' && r.uoms.length ? r.uoms : null))
        .catch(() => undefined)
        .then(list => {
          if (list === undefined) return this.allowedUoms(hsCode) ?? null; // API unreachable: try again next time
          this.hsUomRules.update(m => new Map(m).set(hsCode, list ?? (HS_UOM_RULES[hsCode] ? [HS_UOM_RULES[hsCode]] : null)));
          return this.allowedUoms(hsCode) ?? null;
        })
        .finally(() => this.hsUomPending.delete(hsCode));
      this.hsUomPending.set(hsCode, p);
    }
    return p;
  }

  /** SRO schedules PRAL lists for a rate in the seller's province (API only). */
  async sroSchedules(saleType: string, rate: string, date: string): Promise<SroOption[]> {
    const rateId = this.rateId(saleType, rate);
    const province = this.store.business()?.province;
    if (this.store.mode !== 'api' || !rateId || !province) return [];
    try {
      const r = await this.get<{ schedules: { id: number; desc: string }[] }>('/sro-schedules', { rateId, province, date });
      return r.schedules.map(s => ({ id: s.id, desc: s.desc }));
    } catch { return []; }
  }

  async sroItems(sroId: number, date: string): Promise<SroOption[]> {
    if (this.store.mode !== 'api') return [];
    try { return (await this.get<{ items: SroOption[] }>('/sro-items', { sroId, date })).items; } catch { return []; }
  }
}
