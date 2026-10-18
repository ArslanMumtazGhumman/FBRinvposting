/**
 * Refreshes the reference cache from PRAL. Runs nightly in the worker
 * (queue/reference.ts) and on demand from `reference-cli refresh`.
 *
 *   1. provinces, uom, transtypecode, itemdesccode (HS codes)
 *   2. SaleTypeToRate for every Rasid sale type × province, for `date`
 *   3. SroSchedule for every rate found, then SROItem for every schedule
 *   4. HS_UOM again for each HS code someone has looked up
 *   5. dated copies older than `keepDays` are dropped
 *
 * Each list is fetched and stored on its own, so one failure keeps the last
 * good copy of that list and doesn't stop the rest. A list that comes back
 * empty, or an HS list less than half the size of the cached one, is treated
 * as a failure rather than replacing good data. A 401 stops the run.
 */
import { fbr, FbrHttpError } from '../lib/fbr-client.js';
import { KNOWN_SALE_TYPES } from '../lib/fbr-payload.js';
import {
  looseKey, requests, rowsOf, todayPk, toHsCodes, toProvinces, toRates, toSroItems, toSroSchedules, toTransTypes, toUoms, type RefRequest, type TransType,
} from './pral.js';
import { cachedParams, hsCodeCount, pruneDated, readList, replaceHsCodes, writeList } from './store.js';

export interface RefreshOptions { token: string; date?: string; concurrency?: number; keepDays?: number }
export interface RefreshSummary {
  date: string;
  /** Rows stored per list. */
  counts: Record<string, number>;
  failed: { list: string; error: string }[];
  calls: number;
  stoppedBy401: boolean;
  ms: number;
}

/** Rasid's sale types (lower case) → PRAL transaction type, matched on letters and digits. */
export function matchSaleTypes(transTypes: TransType[]): Map<string, TransType> {
  const byKey = new Map(transTypes.map(t => [looseKey(t.desc), t]));
  const out = new Map<string, TransType>();
  for (const name of KNOWN_SALE_TYPES) {
    const t = byKey.get(looseKey(name));
    if (t) out.set(name, t);
  }
  return out;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/Bearer\s+\S+/g, 'Bearer [redacted]').slice(0, 200);

export async function refreshReference(opts: RefreshOptions): Promise<RefreshSummary> {
  const started = Date.now();
  const date = opts.date ?? todayPk();
  const concurrency = opts.concurrency ?? 4;
  const s: RefreshSummary = { date, counts: {}, failed: [], calls: 0, stoppedBy401: false, ms: 0 };

  const get = async (r: RefRequest) => {
    if (s.stoppedBy401) throw new Error('stopped: FBR rejected the reference token');
    s.calls++;
    try { return (await fbr.reference(opts.token, r.kind, r.query)).json as unknown; }
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
    ['uom', requests.uom(), toUoms],
    ['transtypecode', requests.transTypes(), toTransTypes],
  ];
  for (const [list, req, parse] of globals) {
    try {
      const json = await get(req);
      const n = parse(json).length;
      if (!n) throw new Error('FBR returned an empty list; kept the cached copy');
      await writeList(req, rowsOf(json));
      s.counts[list] = n;
    } catch (e) { s.failed.push({ list, error: message(e) }); }
  }
  try {
    const list = toHsCodes(await get(requests.hsCodes()));
    const cached = await hsCodeCount();
    if (!list.length || list.length < cached / 2) {
      throw new Error(`FBR returned ${list.length} HS codes (cached: ${cached}); kept the cached copy`);
    }
    s.counts.itemdesccode = await replaceHsCodes(list);
  } catch (e) { s.failed.push({ list: 'itemdesccode', error: message(e) }); }

  // 2. Rates, from whichever copy of provinces / transaction types is cached now.
  const provinces = toProvinces((await readList(requests.provinces()))?.data);
  const saleTypes = matchSaleTypes(toTransTypes((await readList(requests.transTypes()))?.data));
  s.counts.saleTypesMatched = saleTypes.size;
  const rateJobs = [...saleTypes.values()].flatMap(t => provinces.map(p => ({ province: p.code, req: requests.rates(t.id, p.code, date) })));
  const schedules = new Map<string, RefRequest>();
  let rates = 0;
  await each('SaleTypeToRate', rateJobs, async ({ province, req }) => {
    const json = await get(req);
    await writeList(req, rowsOf(json));
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
    await writeList(req, rowsOf(json));
    for (const x of toSroSchedules(json)) { sros++; items.set(x.id, requests.sroItems(x.id, date)); }
  });
  s.counts.SroSchedule = sros;
  let sroItems = 0;
  await each('SROItem', [...items.values()], async req => {
    const json = await get(req);
    await writeList(req, rowsOf(json));
    sroItems += toSroItems(json).length;
  });
  s.counts.SROItem = sroItems;

  // 4. UOMs of HS codes already looked up (HS_UOM is per code; fetching all ~12k nightly isn't worth it).
  const looked = (await cachedParams('HS_UOM')).map(p => p.replace(/^hs=/, ''));
  await each('HS_UOM', looked, async code => {
    const req = requests.hsUom(code);
    await writeList(req, rowsOf(await get(req)));
  });
  s.counts.HS_UOM = looked.length;

  // 5. Prune.
  const keep = new Date(`${date}T00:00:00Z`);
  keep.setUTCDate(keep.getUTCDate() - (opts.keepDays ?? 35));
  s.counts.pruned = await pruneDated(keep.toISOString().slice(0, 10));

  s.ms = Date.now() - started;
  return s;
}
