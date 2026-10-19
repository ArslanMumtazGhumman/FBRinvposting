import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { next, signedIn } from '../../testing/api-fixtures';
import { ApiStoreService } from './api-store.service';
import { ReferenceService } from './reference.service';
import { Store } from './store';
import { StoreService } from './store.service';
import { todayIso } from './util';

function setup(store: typeof ApiStoreService | typeof StoreService) {
  localStorage.clear();
  TestBed.configureTestingModule({
    providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([{ path: 'login', children: [] }]), { provide: Store, useClass: store }],
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
    (await next(http, '/api/businesses/b1/reference/uom')).flush({ source: 'pral', items: [{ id: 13, description: 'KG' }] });
    await vi.waitFor(() => expect(ref.rates('Goods at Reduced Rate')).toEqual(['12%']));
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
    expect(await ref.sroSchedules('Goods at standard rate (default)', '18%', '2026-10-18')).toEqual([]); // bundled rate: no id
    const sched = ref.sroSchedules('Goods at Reduced Rate', '5%', '2026-10-18');
    (await next(http, '/api/businesses/b1/reference/sro?rateId=280&province=Punjab&date=2026-10-18')).flush({ source: 'pral', schedules: [{ id: 389, serNo: 1, desc: 'EIGHTH SCHEDULE Table 1' }] });
    expect(await sched).toEqual([{ id: 389, desc: 'EIGHTH SCHEDULE Table 1' }]);
    const items = ref.sroItems(389, '2026-10-18');
    (await next(http, '/api/businesses/b1/reference/sro-items?sroId=389&date=2026-10-18')).flush({ source: 'pral', items: [{ id: 17853, desc: '50' }] });
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
