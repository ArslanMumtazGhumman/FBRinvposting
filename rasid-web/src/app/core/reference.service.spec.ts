import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { next, signedIn } from '../../testing/api-fixtures';
import { ApiStoreService } from './api-store.service';
import { CacheEntry, REFERENCE_CACHE_BACKEND, ReferenceCache, ReferenceCacheBackend } from './reference-cache';
import { ReferenceService } from './reference.service';
import { Store } from './store';
import { StoreService } from './store.service';
import { validateInvoice } from './tax';
import { todayIso } from './util';
import { invoice } from '../../testing/api-fixtures';

/** IndexedDB stand-in that outlives one TestBed, like the browser's does across page loads. */
class MemoryBackend implements ReferenceCacheBackend {
  readonly entries = new Map<string, CacheEntry>();
  async get(key: string) { return this.entries.get(key); }
  async set(key: string, entry: CacheEntry) { this.entries.set(key, entry); }
}

function setup(store: typeof ApiStoreService | typeof StoreService, backend: ReferenceCacheBackend | null = null) {
  localStorage.clear();
  TestBed.configureTestingModule({
    providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([{ path: 'login', children: [] }]), { provide: Store, useClass: store },
      { provide: REFERENCE_CACHE_BACKEND, useValue: backend }],
  });
  return { store: TestBed.inject(Store), ref: TestBed.inject(ReferenceService), http: TestBed.inject(HttpTestingController) };
}

describe('ReferenceService with the API', () => {
  let store: Store, ref: ReferenceService, http: HttpTestingController;
  beforeEach(() => ({ store, ref, http } = setup(ApiStoreService)));
  afterEach(() => http.verify());

  const RATES = {
    source: 'pral', province: { code: 7, desc: 'PUNJAB' }, date: todayIso(),
    saleTypes: [
      { saleType: 'goods at reduced rate', transTypeId: 24, transTypeDesc: 'Goods at Reduced Rate', asOf: todayIso(), rates: [{ id: 280, desc: '5%', value: 5 }, { id: 281, desc: '10%', value: 10 }] },
      { saleType: 'goods at zero-rate', transTypeId: 30, transTypeDesc: 'Goods at zero-rate', asOf: todayIso(), rates: [] },
    ],
  };

  async function loaded(sale: object = RATES, uoms: object = { source: 'pral', items: [{ id: 13, description: 'KG' }, { id: 99, description: 'KWH' }] }) {
    await signedIn(http, store);
    ref.rates('Goods at Reduced Rate'); // first read starts the load
    (await next(http, `/api/businesses/b1/reference/rates?province=Punjab&date=${todayIso()}`)).flush(sale);
    (await next(http, '/api/businesses/b1/reference/uom')).flush(uoms);
    await vi.waitFor(() => expect(ref.uoms()).not.toContain('Dozen'));
  }

  it('offers PRAL rates for the seller’s province; sale types PRAL has no rates for keep the bundled ones', async () => {
    await loaded();
    expect(ref.rates('Goods at Reduced Rate')).toEqual(['5%', '10%']);
    expect(ref.defaultRate('goods at reduced rate')).toBe('5%');
    expect(ref.rateId('Goods at Reduced Rate', '10%')).toBe(281);
    expect(ref.rates('Goods at zero-rate')).toEqual(['0%']); // empty from PRAL → bundled
    expect(ref.rates('Goods at standard rate (default)')).toEqual(['18%']); // not listed → bundled
    expect(ref.rateId('Goods at standard rate (default)', '18%')).toBeUndefined();
    expect(ref.ratesAsOf()).toBe(todayIso());
    expect(ref.uoms()).toEqual(['KG', 'KWH']);
    ref.rates('Services'); ref.uoms(); // already loaded for this business and day: no new requests
  });

  it('source "none" (no PRAL copy on the server) keeps the bundled lists', async () => {
    await signedIn(http, store);
    ref.uoms();
    (await next(http, `/api/businesses/b1/reference/rates?province=Punjab&date=${todayIso()}`)).flush({ source: 'none', saleTypes: [] });
    (await next(http, '/api/businesses/b1/reference/uom')).flush({ source: 'none', items: [] });
    await Promise.resolve();
    expect(ref.rates('Goods at Reduced Rate')).toEqual(['1%', '5%', '10%', '12%', '15%', '16%']);
    expect(ref.ratesAsOf()).toBeNull();
    expect(ref.uoms()).toContain('Dozen');
  });

  it('reloads when the business moves to another province', async () => {
    await loaded();
    store.businesses.update(bs => bs.map(b => ({ ...b, province: 'Sindh' })));
    ref.rates('Goods at Reduced Rate');
    (await next(http, `/api/businesses/b1/reference/rates?province=Sindh&date=${todayIso()}`)).flush({ ...RATES, saleTypes: [{ ...RATES.saleTypes[0], rates: [{ id: 300, desc: '12%', value: 12 }] }] });
    await vi.waitFor(() => expect(ref.rates('Goods at Reduced Rate')).toEqual(['12%']));
    expect(ref.uoms()).toEqual(['KG', 'KWH']); // the unit list is the same everywhere: not asked again
  });

  it('rates follow the invoice date: another date is loaded on first read', async () => {
    await loaded();
    expect(ref.rates('Goods at Reduced Rate', '2026-09-01')).toEqual(['1%', '5%', '10%', '12%', '15%', '16%']); // bundled until loaded
    (await next(http, '/api/businesses/b1/reference/rates?province=Punjab&date=2026-09-01')).flush({ ...RATES, saleTypes: [{ ...RATES.saleTypes[0], rates: [{ id: 270, desc: '7%', value: 7 }] }] });
    await vi.waitFor(() => expect(ref.rates('Goods at Reduced Rate', '2026-09-01')).toEqual(['7%']));
    expect(ref.rates('Goods at Reduced Rate')).toEqual(['5%', '10%']); // today's are separate
    expect(ref.rateInfo('Goods at Reduced Rate', '7%', '2026-09-01')).toEqual({ id: 270, desc: '7%', value: 7 });
  });

  it('checkHs asks once per 100 codes; validateInvoice then flags unknown codes (0052), wrong units (0099) and rates PRAL does not allow (0046)', async () => {
    await loaded();
    const done = ref.checkHs(['1701.9910', '0000.0001', '1701.9910', 'not a code']);
    (await next(http, '/api/businesses/b1/reference/hs-check?codes=1701.9910,0000.0001')).flush({
      source: 'pral', codes: { '1701.9910': { known: true, description: 'Sugar', uoms: ['KG', 'Ton'] }, '0000.0001': { known: false, uoms: null } },
    });
    await done;
    expect([ref.hsKnown('1701.9910'), ref.hsKnown('0000.0001'), ref.hsKnown('2716.0000')]).toEqual([true, false, undefined]);
    expect(ref.allowedUoms('1701.9910')).toEqual(['KG', 'Ton']);
    await ref.checkHs(['1701.9910']); // already checked: no request

    const base = invoice('x', { invoiceDate: todayIso() });
    const line = { ...base.items[0]!, saleType: 'Goods at Reduced Rate', rate: '5%', hsCode: '1701.9910', uoM: 'KG', valueSalesExcludingST: 1000, salesTaxApplicable: 50 };
    const codes = (over: object) => validateInvoice({ ...base, items: [{ ...line, ...over }] }, store.business()!, ref.checks()).map(i => i.code);
    expect(codes({})).toEqual([]);
    expect(codes({ hsCode: '0000.0001' })).toContain('0052');
    expect(codes({ uoM: 'Liter' })).toContain('0099');
    expect(codes({ rate: '12%', salesTaxApplicable: 120 })).toContain('0046');
    expect(codes({ saleType: 'Goods at standard rate (default)', rate: '17%', salesTaxApplicable: 170 })).not.toContain('0046'); // no PRAL list: not checked
  });

  it('HS search uses the API, and the bundled sample when the API has no copy or fails', async () => {
    await signedIn(http, store); // reference routes are scoped to the active business
    const search = ref.searchHs('sugar');
    (await next(http, '/api/businesses/b1/reference/hs?q=sugar&limit=20')).flush({ source: 'pral', results: [{ code: '1701.1400', description: 'Cane sugar, raw' }] });
    expect(await search).toEqual([{ code: '1701.1400', desc: 'Cane sugar, raw' }]);

    const none = ref.searchHs('1701');
    (await next(http, '/api/businesses/b1/reference/hs?q=1701&limit=20')).flush({ source: 'none', results: [] });
    expect((await none).map(h => h.code)).toEqual(['1701.9910']);

    const down = ref.searchHs('rice');
    (await next(http, '/api/businesses/b1/reference/hs?q=rice&limit=20')).flush({ message: 'down' }, { status: 503, statusText: 'Unavailable' });
    expect((await down).map(h => h.code)).toEqual(['1006.3090']);

    expect(await ref.searchHs('s')).toEqual([]); // too short: no request
  });

  it('HS→UOM is asked once per code and then used by allowedUoms', async () => {
    await signedIn(http, store);
    expect(ref.allowedUoms('1701.9910')).toBeUndefined();
    const [a, b] = [ref.hsUoms('1701.9910'), ref.hsUoms('1701.9910')];
    (await next(http, '/api/businesses/b1/reference/uom-for-hs?hs=1701.9910')).flush({ source: 'pral', uoms: ['KG', 'Ton'] });
    expect(await a).toEqual(['KG', 'Ton']);
    expect(await b).toEqual(['KG', 'Ton']);
    expect(ref.allowedUoms('1701.9910')).toEqual(['KG', 'Ton']);
    expect(await ref.hsUoms('1701.9910')).toEqual(['KG', 'Ton']); // cached
    expect(await ref.hsUoms('17019910')).toBeNull(); // not an HS code: no request
  });

  it('HS→UOM: no PRAL rule falls back to the bundled one; a failed request is tried again later', async () => {
    await signedIn(http, store);
    const kwh = ref.hsUoms('2716.0000');
    (await next(http, '/api/businesses/b1/reference/uom-for-hs?hs=2716.0000')).flush({ source: 'none', uoms: [] });
    expect(await kwh).toEqual(['KWH']);

    const failed = ref.hsUoms('8471.3020');
    (await next(http, '/api/businesses/b1/reference/uom-for-hs?hs=8471.3020')).flush({}, { status: 503, statusText: 'Unavailable' });
    expect(await failed).toBeNull();
    const retry = ref.hsUoms('8471.3020');
    (await next(http, '/api/businesses/b1/reference/uom-for-hs?hs=8471.3020')).flush({ source: 'pral', uoms: ['Numbers, pieces, units'] });
    expect(await retry).toEqual(['Numbers, pieces, units']);
  });

  it('SRO schedules need a PRAL rate id; items are looked up by schedule', async () => {
    await loaded();
    const today = todayIso();
    expect(await ref.sroSchedules('Goods at standard rate (default)', '18%', today)).toEqual([]); // bundled rate: no id
    const sched = ref.sroSchedules('Goods at Reduced Rate', '5%', today);
    (await next(http, `/api/businesses/b1/reference/sro?rateId=280&province=Punjab&date=${today}`)).flush({ source: 'pral', schedules: [{ id: 389, serNo: 1, desc: 'EIGHTH SCHEDULE Table 1' }] });
    expect(await sched).toEqual([{ id: 389, desc: 'EIGHTH SCHEDULE Table 1' }]);
    const items = ref.sroItems(389, today);
    (await next(http, `/api/businesses/b1/reference/sro-items?sroId=389&date=${today}`)).flush({ source: 'pral', items: [{ id: 17853, desc: '50' }] });
    expect(await items).toEqual([{ id: 17853, desc: '50' }]);
  });
});

describe('ReferenceService offline', () => {
  it('uses the bundled lists and never calls the API', async () => {
    const { ref, http } = setup(StoreService);
    expect(ref.rates('Goods at Reduced Rate')[0]).toBe('1%');
    expect(ref.uoms()).toContain('KG');
    expect((await ref.searchHs('laptop')).map(h => h.code)).toEqual(['8471.3020']);
    expect((await ref.searchHs('8471.30')).map(h => h.code)).toEqual(['8471.3020']);
    expect(await ref.hsUoms('2716.0000')).toEqual(['KWH']);
    expect(await ref.hsUoms('1701.9910')).toBeNull();
    expect(await ref.sroSchedules('Goods at Reduced Rate', '5%', '2026-10-18')).toEqual([]);
    http.verify();
  });
});

describe('ReferenceCache (memory + IndexedDB, 24 h)', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('a PRAL answer is reused for 24 hours, also after a reload; source "none" and failures are not kept', async () => {
    const backend = new MemoryBackend();
    let { store, ref, http } = setup(ApiStoreService, backend);
    await signedIn(http, store);
    const first = ref.searchHs('sugar');
    (await next(http, '/api/businesses/b1/reference/hs?q=sugar&limit=20')).flush({ source: 'pral', results: [{ code: '1701.9910', description: 'Sugar' }] });
    expect(await first).toEqual([{ code: '1701.9910', desc: 'Sugar' }]);
    expect([...backend.entries.keys()]).toEqual(['/hs?q=sugar&limit=20']);
    const none = ref.searchHs('rice');
    (await next(http, '/api/businesses/b1/reference/hs?q=rice&limit=20')).flush({ source: 'none', results: [] });
    await none;
    expect(backend.entries.has('/hs?q=rice&limit=20')).toBe(false);

    // A new page load: memory is empty, IndexedDB still has the answer.
    TestBed.resetTestingModule();
    ({ store, ref, http } = setup(ApiStoreService, backend));
    await signedIn(http, store);
    expect(await ref.searchHs('sugar')).toEqual([{ code: '1701.9910', desc: 'Sugar' }]); // no request

    // A day later it's fetched again.
    TestBed.resetTestingModule();
    ({ store, ref, http } = setup(ApiStoreService, backend));
    TestBed.inject(ReferenceCache).now = () => Date.now() + 24 * 3600_000 + 1;
    await signedIn(http, store);
    const again = ref.searchHs('sugar');
    (await next(http, '/api/businesses/b1/reference/hs?q=sugar&limit=20')).flush({ source: 'pral', results: [] });
    expect(await again).toEqual([]);
  });
});
