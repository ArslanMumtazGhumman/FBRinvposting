/**
 * Reference lookups for the API (routes/reference.ts), served from the
 * Postgres cache. On a miss the list is fetched from PRAL with Rasid's token
 * (5 s, no retries) and cached; if that fails, dated lists fall back to the
 * nearest cached date. `source: 'none'` means Rasid has no PRAL copy at all,
 * and the web app uses its offline list instead.
 */
import { fbr } from '../lib/fbr-client.js';
import {
  looseKey, requests, rowsOf, toProvinces, toRates, toSroItems, toSroSchedules, toTransTypes, toUoms, type Province, type RefRequest,
} from './pral.js';
import { matchSaleTypes } from './refresh.js';
import { hsCodeCount, readList, readNearest, searchHsCodes, writeList, type CachedList } from './store.js';
import { loadReferenceToken } from './token.js';

const LOOKUP_TIMEOUT_MS = 5000;
/** After a failed live fetch, don't ask PRAL for the same list again for a minute. */
const RETRY_AFTER_MS = 60_000;
const failedUntil = new Map<string, number>();
const pending = new Map<string, Promise<CachedList | null>>();
const cacheKey = (r: RefRequest) => `${r.kind}?${r.params}@${r.asOf}`;

async function fetchLive(r: RefRequest): Promise<CachedList | null> {
  const k = cacheKey(r);
  if ((failedUntil.get(k) ?? 0) > Date.now()) return null;
  let p = pending.get(k);
  if (!p) {
    p = (async () => {
      const token = await loadReferenceToken();
      if (!token) return null;
      try {
        const data = rowsOf((await fbr.reference(token, r.kind, r.query, { retry: false, timeoutMs: LOOKUP_TIMEOUT_MS })).json);
        await writeList(r, data);
        return { data, asOf: r.asOf, fetchedAt: new Date() };
      } catch {
        failedUntil.set(k, Date.now() + RETRY_AFTER_MS);
        return null;
      }
    })().finally(() => pending.delete(k));
    pending.set(k, p);
  }
  return p;
}

/** Cached copy for exactly this request, else live, else (dated lists) the nearest cached date. */
async function lookup(r: RefRequest): Promise<CachedList | null> {
  return (await readList(r)) ?? (await fetchLive(r)) ?? (r.asOf ? await readNearest(r) : null);
}

export const meta = (hit: CachedList | null) =>
  hit ? { source: 'pral' as const, asOf: hit.asOf || null, fetchedAt: hit.fetchedAt.toISOString() } : { source: 'none' as const };

export async function provinces() {
  const hit = await lookup(requests.provinces());
  return { ...meta(hit), provinces: hit ? toProvinces(hit.data) : [] };
}

/** PRAL's province for a name as Rasid stores it ("Punjab" matches "PUNJAB"). */
async function province(name: string): Promise<Province | undefined> {
  const hit = await lookup(requests.provinces());
  return hit ? toProvinces(hit.data).find(p => looseKey(p.desc) === looseKey(name)) : undefined;
}

export async function uoms() {
  const hit = await lookup(requests.uom());
  return { ...meta(hit), uoms: hit ? toUoms(hit.data) : [] };
}

/**
 * Rates for each Rasid sale type that PRAL has a transaction type for, in the
 * seller's province on `date`. Sale types PRAL doesn't list are left out.
 */
export async function saleTypeRates(provinceName: string, date: string) {
  const [prov, types] = await Promise.all([province(provinceName), lookup(requests.transTypes())]);
  const matched = types ? [...matchSaleTypes(toTransTypes(types.data))] : [];
  if (!prov || !matched.length) return { source: 'none' as const, saleTypes: [] };
  const saleTypes = await mapLimit(matched, 5, async ([saleType, t]) => {
    const hit = await lookup(requests.rates(t.id, prov.code, date));
    return { saleType, transTypeId: t.id, transTypeDesc: t.desc, rates: hit ? toRates(hit.data) : [], asOf: hit?.asOf ?? null };
  });
  return { source: 'pral' as const, province: prov, date, saleTypes };
}

export async function hsSearch(q: string, limit: number) {
  if (!(await hsCodeCount())) return { source: 'none' as const, results: [] };
  return { source: 'pral' as const, results: await searchHsCodes(q, limit) };
}

export async function hsUoms(hsCode: string) {
  const hit = await lookup(requests.hsUom(hsCode));
  return { ...meta(hit), uoms: hit ? toUoms(hit.data).map(u => u.description) : [] };
}

export async function sroSchedules(rateId: number, provinceName: string, date: string) {
  const prov = await province(provinceName);
  const hit = prov ? await lookup(requests.sroSchedules(rateId, prov.code, date)) : null;
  return { ...meta(hit), schedules: hit ? toSroSchedules(hit.data) : [] };
}

export async function sroItems(sroId: number, date: string) {
  const hit = await lookup(requests.sroItems(sroId, date));
  return { ...meta(hit), items: hit ? toSroItems(hit.data) : [] };
}

async function mapLimit<T, R>(items: T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]!); }
  }));
  return out;
}

/** For tests. */
export const resetLookupState = () => { failedUntil.clear(); pending.clear(); };
