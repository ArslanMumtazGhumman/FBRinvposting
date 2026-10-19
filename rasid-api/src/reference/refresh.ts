/**
 * Refreshes the reference cache from PRAL. Runs nightly in the worker
 * (queue/reference.ts) and on demand from `reference-cli refresh`.
 *
 *   1. provinces, doctypecode, uom, transtypecode, sroitemcode, itemdesccode (HS codes)
 *   2. Rasid's sale types matched to transaction types (sale-types.ts), then
 *      SaleTypeToRate for every matched sale type × province, for `date`
 *   3. SroSchedule for every rate found, then SROItem for every schedule
 *   4. HS_UOM again for each HS code someone has looked up
 *   5. dated copies older than `keepDays` are dropped
 *
 * Each list is fetched and stored on its own, so one failure keeps the last
 * good copy of that list and doesn't stop the rest. A list that comes back
 * empty, or an HS list less than half the size of the cached one, is treated
 * as a failure rather than replacing good data. A 401 stops the run.
 *
 * `source` records whose token fetched the data: Rasid's ('platform') or a
 * customer's fallback token ('production' / 'sandbox'); see token.ts.
 */
import { fbr, FbrHttpError } from '../lib/fbr-client.js';
import {
  requests, rowsOf, todayPk, toDocTypes, toHsCodes, toProvinces, toRates, toSroItemCodes, toSroItems, toSroSchedules, toTransTypes, toUoms,
  type RefRequest,
} from './pral.js';
import type { ReferenceSource } from '../db/schema.js';
import { mapSaleTypes, mappedSaleTypes } from './sale-types.js';
import { cachedParams, hsCodeCount, pruneDated, readList, replaceHsCodes, writeList } from './store.js';

export interface RefreshOptions {
  token: string;
  source?: ReferenceSource;
  date?: string;
  concurrency?: number;
  keepDays?: number;
  /** Retry a call on 5xx or network failure (fbr-client's back-off). Default true. */
  retry?: boolean;
}
export interface RefreshSummary {
  date: string;
  source: ReferenceSource;
  /** Rows stored per list. */
  counts: Record<string, number>;
  failed: { list: string; error: string }[];
  calls: number;
  stoppedBy401: boolean;
  /** Sale types with no certain PRAL transaction type (sale_types.needs_review). */
  saleTypesNeedingReview: string[];
  ms: number;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/Bearer\s+\S+/g, 'Bearer [redacted]').slice(0, 200);

export async function refreshReference(opts: RefreshOptions): Promise<RefreshSummary> {
  const started = Date.now();
  const date = opts.date ?? todayPk();
  const concurrency = opts.concurrency ?? 4;
  const source = opts.source ?? 'platform';
  const s: RefreshSummary = { date, source, counts: {}, failed: [], calls: 0, stoppedBy401: false, saleTypesNeedingReview: [], ms: 0 };

  const get = async (r: RefRequest) => {
    if (s.stoppedBy401) throw new Error('stopped: FBR rejected the reference token');
    s.calls++;
    try { return (await fbr.reference(opts.token, r.kind, r.query, { retry: opts.retry ?? true })).json as unknown; }
    catch (e) { if (e instanceof FbrHttpError && e.status === 401) s.stoppedBy401 = true; throw e; }
  };

  /** Runs fn over items, `concurrency` at a time; failures are counted per list, not thrown. */
  async function each<T>(list: string, items: T[], fn: (item: T) => Promise<void>) {
    let next = 0, failures = 0, first = '';
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length && !s.stoppedBy401) {
        const item = items[next++]!;
        try { await fn(item); } catch (e) { failures++; first ||= message(e); }
      }
    }));
    if (failures) s.failed.push({ list, error: `${failures} of ${items.length} failed: ${first}` });
  }

  // 1. Lists without parameters.
  const globals: [string, RefRequest, (json: unknown) => unknown[]][] = [
    ['provinces', requests.provinces(), toProvinces],
    ['doctypecode', requests.docTypes(), toDocTypes],
    ['uom', requests.uom(), toUoms],
    ['transtypecode', requests.transTypes(), toTransTypes],
    ['sroitemcode', requests.sroItemCodes(), toSroItemCodes],
  ];
  for (const [list, req, parse] of globals) {
    try {
      const json = await get(req);
      const n = parse(json).length;
      if (!n) throw new Error('FBR returned an empty list; kept the cached copy');
      await writeList(req, rowsOf(json), source);
      s.counts[list] = n;
    } catch (e) { s.failed.push({ list, error: message(e) }); }
  }
  try {
    const list = toHsCodes(await get(requests.hsCodes()));
    const cached = await hsCodeCount();
    if (!list.length || list.length < cached / 2) {
      throw new Error(`FBR returned ${list.length} HS codes (cached: ${cached}); kept the cached copy`);
    }
    s.counts.itemdesccode = await replaceHsCodes(list, source);
  } catch (e) { s.failed.push({ list: 'itemdesccode', error: message(e) }); }

  // 2. Sale types → transaction types (sale_types), then rates, from whichever copies of
  //    provinces and transaction types are cached now.
  s.saleTypesNeedingReview = await mapSaleTypes(toTransTypes((await readList(requests.transTypes()))?.data));
  const provinces = toProvinces((await readList(requests.provinces()))?.data);
  const saleTypes = await mappedSaleTypes();
  s.counts.saleTypesMatched = saleTypes.length;
  const rateJobs = saleTypes.flatMap(t => provinces.map(p => ({ province: p.code, req: requests.rates(t.transTypeId, p.code, date) })));
  const schedules = new Map<string, RefRequest>();
  let rates = 0;
  await each('SaleTypeToRate', rateJobs, async ({ province, req }) => {
    const json = await get(req);
    await writeList(req, rowsOf(json), source);
    for (const r of toRates(json)) {
      rates++;
      const sro = requests.sroSchedules(r.id, province, date);
      schedules.set(sro.params, sro);
    }
  });
  s.counts.SaleTypeToRate = rates;

  // 3. SRO schedules for those rates, then the items of each schedule.
  const items = new Map<number, RefRequest>();
  let sros = 0;
  await each('SroSchedule', [...schedules.values()], async req => {
    const json = await get(req);
    await writeList(req, rowsOf(json), source);
    for (const x of toSroSchedules(json)) { sros++; items.set(x.id, requests.sroItems(x.id, date)); }
  });
  s.counts.SroSchedule = sros;
  let sroItems = 0;
  await each('SROItem', [...items.values()], async req => {
    const json = await get(req);
    await writeList(req, rowsOf(json), source);
    sroItems += toSroItems(json).length;
  });
  s.counts.SROItem = sroItems;

  // 4. UOMs of HS codes already looked up (HS_UOM is per code; fetching all ~12k nightly isn't worth it).
  const looked = (await cachedParams('HS_UOM')).map(p => p.replace(/^hs=/, ''));
  await each('HS_UOM', looked, async code => {
    const req = requests.hsUom(code);
    await writeList(req, rowsOf(await get(req)), source);
  });
  s.counts.HS_UOM = looked.length;

  // 5. Prune.
  const keep = new Date(`${date}T00:00:00Z`);
  keep.setUTCDate(keep.getUTCDate() - (opts.keepDays ?? 35));
  s.counts.pruned = await pruneDated(keep.toISOString().slice(0, 10));

  s.ms = Date.now() - started;
  return s;
}
