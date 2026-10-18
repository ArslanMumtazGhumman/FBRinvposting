/** Fixtures shared by the API store and posting specs. */
import { HttpTestingController, TestRequest } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { expect, vi } from 'vitest';
import { environment } from '../environments/environment';
import { Business, Invoice } from '../app/core/models';
import { Store } from '../app/core/store';

export const BIZ: Business = {
  id: 'b1', name: 'Al-Noor', ntnCnic: '1234567', province: 'Punjab', address: 'Lahore', activity: 'Distributor', sector: 'FMCG',
  environment: 'sandbox', hasSandboxToken: true, hasProductionToken: false, defaultSaleType: 'Goods at standard rate (default)',
  furtherTaxRate: 4, invoicePrefix: 'ANT-', nextInvoiceNo: 7,
};

export function invoice(id: string, over: Partial<Invoice> = {}): Invoice {
  return {
    id, businessId: 'b1', localRef: `ANT-${id}`, invoiceType: 'Sale Invoice', invoiceDate: '2026-10-18',
    buyer: { ntnCnic: '4410235', name: 'Metro', province: 'Punjab', address: 'Lahore', registrationType: 'Registered' },
    items: [{ hsCode: '1701.9910', productDescription: 'Sugar', rate: '18%', uoM: 'KG', quantity: 10, unitPrice: 155, totalValues: 1829,
      valueSalesExcludingST: 1550, fixedNotifiedValueOrRetailPrice: 0, salesTaxApplicable: 279, salesTaxWithheldAtSource: 0, extraTax: 0,
      furtherTax: 0, sroScheduleNo: '', fedPayable: 0, discount: 0, saleType: 'Goods at standard rate (default)', sroItemSerialNo: '' }],
    invoiceRefNo: '', environment: 'sandbox', status: 'draft', issues: [], attempts: 0,
    createdAt: '2026-10-18T10:00:00.000Z', updatedAt: '2026-10-18T10:00:00.000Z', history: [], ...over,
  };
}

/** Base URL in the environment the tests are built with; paths below are written as '/api/...'. */
export const API = environment.apiBaseUrl;
const full = (path: string) => API + path.slice('/api'.length);

/** Waits for the next request matching url (+ method), since the store issues them after awaits. */
export async function next(http: HttpTestingController, url: string | RegExp, method = 'GET'): Promise<TestRequest> {
  return vi.waitFor(() => {
    const [r] = http.match(req => req.method === method && (typeof url === 'string' ? req.urlWithParams === full(url) : url.test(req.urlWithParams)));
    if (!r) throw new Error(`no ${method} ${url}`);
    return r;
  });
}

/** Signs in and loads business b1 with the given invoices. */
export async function signedIn(http: HttpTestingController, store: Store, invoices: Invoice[] = []) {
  const session = store.restoreSession();
  (await next(http, '/api/auth/me')).flush({ id: 'u1', name: 'Ayesha', email: 'a@x.pk', role: 'owner' });
  expect(await session).toBe(true);
  TestBed.tick();
  (await next(http, '/api/businesses')).flush([BIZ]);
  TestBed.tick();
  (await next(http, '/api/businesses/b1/customers')).flush([]);
  (await next(http, '/api/businesses/b1/products')).flush([]);
  (await next(http, '/api/businesses/b1/import-mappings')).flush([]);
  (await next(http, '/api/businesses/b1/invoices?limit=200')).flush({ items: invoices, nextCursor: null });
  await vi.waitFor(() => expect(store.ready()).toBe(true));
}
