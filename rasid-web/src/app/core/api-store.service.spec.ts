import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { BIZ, invoice, next, signedIn } from '../../testing/api-fixtures';
import { ApiStoreService } from './api-store.service';
import { Invoice } from './models';
import { Store } from './store';

describe('ApiStoreService', () => {
  let store: Store;
  let http: HttpTestingController;

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([{ path: 'login', children: [] }]), { provide: Store, useClass: ApiStoreService }],
    });
    store = TestBed.inject(Store);
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => http.verify());

  it('restores the session, then loads businesses and pages through invoices', async () => {
    expect(store.ready()).toBe(false);
    const session = store.restoreSession();
    (await next(http, '/api/auth/me')).flush({ id: 'u1', name: 'Ayesha', email: 'a@x.pk', role: 'owner' });
    expect(await session).toBe(true);
    TestBed.tick();
    (await next(http, '/api/businesses')).flush([BIZ]);
    TestBed.tick();
    (await next(http, '/api/businesses/b1/customers')).flush([{ id: 'c1', businessId: 'b1', name: 'Metro', ntnCnic: '4410235', province: 'Punjab', address: '', registrationType: 'Registered' }]);
    (await next(http, '/api/businesses/b1/products')).flush([]);
    (await next(http, '/api/businesses/b1/import-mappings')).flush([]);
    (await next(http, '/api/businesses/b1/invoices?limit=200')).flush({ items: [invoice('i1')], nextCursor: 'CUR' });
    (await next(http, '/api/businesses/b1/invoices?limit=200&cursor=CUR')).flush({ items: [invoice('i2')], nextCursor: null });
    await vi.waitFor(() => expect(store.ready()).toBe(true));
    expect(store.business()?.id).toBe('b1');
    expect(store.bizInvoices().map(i => i.id).sort()).toEqual(['i1', 'i2']);
    expect(store.bizCustomers().length).toBe(1);
  });

  it('no session: restoreSession resolves false', async () => {
    const session = store.restoreSession();
    (await next(http, '/api/auth/me')).flush({ message: 'Sign in' }, { status: 401, statusText: 'Unauthorized' });
    expect(await session).toBe(false);
  });

  it('creates with POST, then updates with PUT; the server copy replaces the cached one', async () => {
    await signedIn(http, store);
    const created = store.upsertInvoice(invoice('i_new', { status: 'failed', localRef: 'ANT-00007' }));
    expect(store.invoiceById('i_new')).toBeTruthy(); // shown at once
    const post = await next(http, '/api/businesses/b1/invoices', 'POST');
    expect(post.request.body.id).toBe('i_new');
    expect(post.request.body.status).toBe('draft'); // the client cannot set failed/posted
    expect(post.request.body.history).toBeUndefined();
    post.flush(invoice('i_new', { history: [{ at: 'x', actor: 'Ayesha', action: 'Created' }] }));
    expect((await created).history.length).toBe(1);

    const updated = store.upsertInvoice({ ...store.invoiceById('i_new')!, invoiceDate: '2026-10-19' });
    const put = await next(http, '/api/businesses/b1/invoices/i_new', 'PUT');
    expect(put.request.body.invoiceDate).toBe('2026-10-19');
    put.flush(invoice('i_new', { invoiceDate: '2026-10-19' }));
    await updated;
  });

  it('writes to one invoice reach the server in order', async () => {
    await signedIn(http, store);
    const first = store.upsertInvoice(invoice('i_seq'));
    const second = store.upsertInvoice(invoice('i_seq', { invoiceDate: '2026-10-20' }));
    const post = await next(http, '/api/businesses/b1/invoices', 'POST');
    expect(http.match({ method: 'PUT' }).length).toBe(0); // waits for the create
    post.flush(invoice('i_seq'));
    await first;
    (await next(http, '/api/businesses/b1/invoices/i_seq', 'PUT')).flush(invoice('i_seq', { invoiceDate: '2026-10-20' }));
    expect((await second).invoiceDate).toBe('2026-10-20');
  });

  it('a refused edit is undone and rejects with the server message', async () => {
    await signedIn(http, store, [invoice('i1', { invoiceDate: '2026-10-01' })]);
    const p = store.upsertInvoice(invoice('i1', { invoiceDate: '2026-10-05' }));
    expect(store.invoiceById('i1')?.invoiceDate).toBe('2026-10-05');
    (await next(http, '/api/businesses/b1/invoices/i1', 'PUT'))
      .flush({ code: 'NOT_EDITABLE', message: 'This invoice is posted to FBR and cannot be changed.' }, { status: 409, statusText: 'Conflict' });
    await expect(p).rejects.toThrow('posted to FBR');
    expect(store.invoiceById('i1')?.invoiceDate).toBe('2026-10-01');
  });

  it('a refused delete puts the invoice back', async () => {
    await signedIn(http, store, [invoice('i1')]);
    const p = store.deleteInvoice('i1');
    expect(store.invoiceById('i1')).toBeUndefined();
    (await next(http, '/api/businesses/b1/invoices/i1', 'DELETE')).flush({ message: 'Being posted' }, { status: 409, statusText: 'Conflict' });
    await expect(p).rejects.toThrow('Being posted');
    expect(store.invoiceById('i1')).toBeTruthy();
  });

  it('bulk save sends chunks of 500 and reports errors by original index', async () => {
    await signedIn(http, store);
    const invs = Array.from({ length: 1200 }, (_, k) => invoice(`i${k}`));
    const progress: number[] = [];
    const p = store.upsertMany(invs, done => progress.push(done));
    for (const size of [500, 500, 200]) {
      const req = await next(http, '/api/businesses/b1/invoices/bulk', 'POST');
      expect(req.request.body.invoices.length).toBe(size);
      const body = req.request.body.invoices as Invoice[];
      req.flush({
        created: body.slice(1).map((b, k) => ({ index: k + 1, invoice: invoice(b.id) })),
        errors: [{ index: 0, localRef: body[0]!.localRef, issues: [{ path: 'buyer.ntnCnic', message: 'Bad NTN' }] }],
      });
    }
    const r = await p;
    expect(r.saved.length).toBe(1197);
    expect(r.errors.map(e => e.index)).toEqual([0, 500, 1000]);
    expect(r.errors[0]!.message).toBe('buyer.ntnCnic: Bad NTN');
    expect(progress).toEqual([500, 1000, 1200]);
    expect(store.bizInvoices().length).toBe(1197);
  });

  it('an expired session signs the user out', async () => {
    await signedIn(http, store);
    const p = store.upsertCustomer({ id: 'c9', businessId: 'b1', name: 'X', ntnCnic: '', province: 'Punjab', address: '', registrationType: 'Unregistered' });
    (await next(http, '/api/businesses/b1/customers/c9', 'PUT')).flush({ message: 'Sign in' }, { status: 401, statusText: 'Unauthorized' });
    await expect(p).rejects.toThrow();
    expect(store.user()).toBeNull();
    expect(store.bizCustomers().length).toBe(0);
  });

  it('import mappings drop unmapped (null) fields before saving', async () => {
    await signedIn(http, store);
    const p = store.saveMapping({ id: 'm1', businessId: 'b1', name: 'Oct', signature: 'a|b', map: { invoiceNo: 'Bill #', hsCode: null as unknown as string }, createdAt: '' });
    const req = await next(http, '/api/businesses/b1/import-mappings', 'POST');
    expect(req.request.body.map).toEqual({ invoiceNo: 'Bill #' });
    req.flush({ id: 'm1', businessId: 'b1', name: 'Oct', signature: 'a|b', map: { invoiceNo: 'Bill #' }, createdAt: '2026-10-18T00:00:00Z' });
    await p;
    expect(store.mappings().length).toBe(1);
  });

  it('nextLocalRef moves only the cached counter', async () => {
    await signedIn(http, store);
    expect(store.nextLocalRef()).toBe('ANT-00007');
    expect(store.nextLocalRef()).toBe('ANT-00008');
    expect(store.business()?.nextInvoiceNo).toBe(9);
    // no request: http.verify() in afterEach
  });
});
