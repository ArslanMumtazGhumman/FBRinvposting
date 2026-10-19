/**
 * Reference lookups for the API (routes/reference.ts), served from the
 * Postgres cache. On a miss, or when a parameterised lookup is older than
 * REFERENCE_TTL_HOURS, the list is fetched from PRAL (5 s, no retries) with
 * the reference token (token.ts) and cached. If that fails, the cached copy is
 * served even if stale, and dated lists fall back to the nearest cached date.
 * `source: 'none'` means Rasid has no PRAL copy at all, and the web app uses
 * its offline list instead.
 */
import { config } from '../config.js';
import { fbr, FbrHttpError } from '../lib/fbr-client.js';
import {
  isParameterised, looseKey, requests, rowsOf, toDocTypes, toProvinces, toRates, toSroItemCodes, toSroItems, toSroSchedules, toTransTypes, toUoms,
  type Province, type RefRequest,
} from './pral.js';
import { mappedSaleTypes, mapSaleTypes, saleTypesUnchecked } from './sale-types.js';
import { findHsCodes, hsCodeCount, readList, readNearest, searchHsCodes, writeList, type CachedList } from './store.js';
import { referenceToken, rejectReferenceToken } from './token.js';

const LOOKUP_TIMEOUT_MS = 5000;
/** After a failed live fetch, don't ask PRAL for the same list again for a minute. */
const RETRY_AFTER_MS = 60_000;
const failedUntil = new Map<string, number>();
const pending = new Map<string, Promise<CachedList | null>>();
const cacheKey = (r: RefRequest) => `${r.kind}?${r.params}@${r.asOf}`;

const warn = (o: Record<string, unknown>) => console.warn(JSON.stringify({ at: new Date().toISOString(), level: 'warn', ...o }));

async function fetchLive(r: RefRequest): Promise<CachedList | null> {
  const k = cacheKey(r);
  if ((failedUntil.get(k) ?? 0) > Date.now()) return null;
  let p = pending.get(k);
  if (!p) {
    p = (async () => {
      const t = await referenceToken();
      if (!t) return null;
      try {
        const data = rowsOf((await fbr.reference(t.token, r.kind, r.query, { retry: false, timeoutMs: LOOKUP_TIMEOUT_MS })).json);
        if (!(await writeList(r, data, t.source))) {
          warn({ event: 'reference_empty_kept', list: k });
          failedUntil.set(k, Date.now() + RETRY_AFTER_MS);
          return null;
        }
        if (r.kind === 'transtypecode') await mapSaleTypes(toTransTypes(data));
        return { data, asOf: r.asOf, fetchedAt: new Date(), sourceEnv: t.source };
      } catch (e) {
        if (e instanceof FbrHttpError && e.status === 401) await rejectReferenceToken(t);
        warn({ event: 'reference_lookup_failed', list: k, source: t.source, error: e instanceof Error ? e.message.slice(0, 200) : String(e) });
        failedUntil.set(k, Date.now() + RETRY_AFTER_MS);
        return null;
      }
    })().finally(() => pending.delete(k));
    pending.set(k, p);
  }
  return p;
}

const expired = (r: RefRequest, hit: CachedList) =>
  isParameterised(r) && Date.now() - hit.fetchedAt.getTime() > config.referenceTtlHours * 3600_000;

/** Fresh cached copy, else live, else the stale copy, else (dated lists) the nearest cached date. */
async function lookup(r: RefRequest): Promise<CachedList | null> {
  const cached = await readList(r);
  if (cached && !expired(r, cached)) return cached;
  return (await fetchLive(r)) ?? cached ?? (r.asOf ? await readNearest(r) : null);
}

export const meta = (hit: CachedList | null) =>
  hit ? { source: 'pral' as const, asOf: hit.asOf || null, fetchedAt: hit.fetchedAt.toISOString() } : { source: 'none' as const };

/** Lists that take no parameters, by PRAL's name. itemdesccode (~12k rows) is searched instead (hsSearch). */
const LISTS = {
  provinces: [requests.provinces, toProvinces],
  doctypecode: [requests.docTypes, toDocTypes],
  uom: [requests.uom, toUoms],
  transtypecode: [requests.transTypes, toTransTypes],
  sroitemcode: [requests.sroItemCodes, toSroItemCodes],
} as const satisfies Record<string, readonly [() => RefRequest, (json: unknown) => unknown[]]>;
export type ListKind = keyof typeof LISTS;
export const LIST_KINDS = Object.keys(LISTS) as ListKind[];

export async function list(kind: ListKind) {
  const [request, parse] = LISTS[kind];
  const hit = await lookup(request());
  return { ...meta(hit), kind, items: hit ? parse(hit.data) : [] };
}

/** PRAL's province for a name as Rasid stores it ("Punjab" matches "PUNJAB"). */
async function province(name: string): Promise<Province | undefined> {
  const hit = await lookup(requests.provinces());
  return hit ? toProvinces(hit.data).find(p => looseKey(p.desc) === looseKey(name)) : undefined;
}

/**
 * Rates for each Rasid sale type with a PRAL transaction type (sale_types), or
 * just `saleType`, in the seller's province on `date`. Sale types without one
 * (needs review) are left out, and the web app keeps their bundled rates.
 */
export async function saleTypeRates(provinceName: string, date: string, saleType?: string) {
  // Right after the seed, or with a cache filled before sale_types existed: match once from transtypecode.
  if (await saleTypesUnchecked()) {
    const types = await lookup(requests.transTypes());
    if (types) await mapSaleTypes(toTransTypes(types.data));
  }
  const [prov, mapped] = await Promise.all([province(provinceName), mappedSaleTypes()]);
  const matched = saleType ? mapped.filter(t => t.name.toLowerCase() === saleType.trim().toLowerCase()) : mapped;
  if (!prov || !matched.length) return { source: 'none' as const, saleTypes: [] };
  const saleTypes = await mapLimit(matched, 5, async t => {
    const hit = await lookup(requests.rates(t.transTypeId, prov.code, date));
    return { saleType: t.name.toLowerCase(), transTypeId: t.transTypeId, transTypeDesc: t.pralDesc, rates: hit ? toRates(hit.data) : [], asOf: hit?.asOf ?? null };
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

/**
 * For bulk import: which of `codes` FBR's HS list has, and the units each known
 * code allows (null when PRAL has no rule or couldn't be reached). One call per
 * sheet chunk instead of one search and one HS_UOM request per code.
 */
export async function hsCheck(codes: string[]) {
  if (!(await hsCodeCount())) return { source: 'none' as const, codes: {} };
  const known = new Map((await findHsCodes(codes)).map(h => [h.code, h.description]));
  const out: Record<string, { known: boolean; description?: string; uoms: string[] | null }> = {};
  await mapLimit(codes, 6, async code => {
    const description = known.get(code);
    if (description === undefined) { out[code] = { known: false, uoms: null }; return; }
    const u = await hsUoms(code);
    out[code] = { known: true, description, uoms: u.source === 'pral' && u.uoms.length ? u.uoms : null };
  });
  return { source: 'pral' as const, codes: out };
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
