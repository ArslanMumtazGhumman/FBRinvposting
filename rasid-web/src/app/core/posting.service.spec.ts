import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { API, invoice, next, signedIn } from '../../testing/api-fixtures';
import { ApiStoreService } from './api-store.service';
import { PostingService } from './posting.service';
import { Store } from './store';

/** Stands in for the browser's EventSource; tests push server events into it. */
class FakeEventSource {
  static last: FakeEventSource | null = null;
  readonly listeners = new Map<string, ((e: MessageEvent) => void)[]>();
  onerror: (() => void) | null = null;
  closed = false;
  constructor(readonly url: string, readonly init?: EventSourceInit) { FakeEventSource.last = this; }
  addEventListener(type: string, fn: (e: MessageEvent) => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]); }
  close() { this.closed = true; }
  emit(type: string, data: unknown) { for (const fn of this.listeners.get(type) ?? []) fn(new MessageEvent(type, { data: JSON.stringify(data) })); }
}

const progress = (over: object) => ({ total: 2, queued: 0, posting: 0, posted: 0, failed: 0, outcomeUnknown: 0, done: 0, running: true, ...over });

describe('PostingService with the API', () => {
  let store: Store;
  let posting: PostingService;
  let http: HttpTestingController;

  beforeEach(() => {
    localStorage.clear();
    FakeEventSource.last = null;
    vi.stubGlobal('EventSource', FakeEventSource);
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([{ path: 'login', children: [] }]), { provide: Store, useClass: ApiStoreService }],
    });
    store = TestBed.inject(Store);
    posting = TestBed.inject(PostingService);
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => { http.verify(); vi.unstubAllGlobals(); });

  it('queues a batch, follows it over SSE and reloads the batch at the end', async () => {
    await signedIn(http, store, [invoice('i1'), invoice('i2'), invoice('i3', { status: 'posted', fbrInvoiceNumber: 'IRN0' })]);
    expect(posting.canPause).toBe(false);
    const done = posting.postBatch(['i1', 'i2', 'i3']);

    const req = await next(http, '/api/businesses/b1/invoices/post-batch', 'POST');
    expect(req.request.body).toEqual({ ids: ['i1', 'i2', 'i3'] });
    req.flush({ batchId: 'bt_1', queued: ['i1', 'i2'], skipped: [{ id: 'i3', status: 'posted', message: 'Already posted' }] });

    await vi.waitFor(() => expect(FakeEventSource.last).toBeTruthy());
    const es = FakeEventSource.last!;
    expect(es.url).toBe(`${API}/businesses/b1/invoices/batches/bt_1/events`);
    expect(es.init?.withCredentials).toBe(true);
    expect(store.invoiceById('i1')?.status).toBe('queued');
    expect(posting.progress()).toMatchObject({ total: 2, skipped: 1, running: true });

    es.emit('progress', progress({ posting: 2 }));
    es.emit('invoice', { id: 'i1', status: 'posted', issues: [], attempts: 1, fbrInvoiceNumber: 'IRN1', fbrItemNumbers: ['IRN1-1'], fbrDated: 'd' });
    es.emit('invoice', { id: 'i2', status: 'failed', issues: [{ code: '0019', message: 'Bad HS', source: 'fbr', itemIndex: 0, field: 'hsCode' }], attempts: 1 });
    expect(store.invoiceById('i1')?.fbrInvoiceNumber).toBe('IRN1');
    expect(store.invoiceById('i2')?.issues[0]?.hint).toBeTruthy(); // help text added from the code
    es.emit('done', progress({ posted: 1, failed: 1, done: 2, running: false }));
    expect(es.closed).toBe(true);

    (await next(http, '/api/businesses/b1/invoices?limit=200&batchId=bt_1'))
      .flush({ items: [invoice('i1', { status: 'posted', fbrInvoiceNumber: 'IRN1', history: [{ at: 'x', actor: 'system', action: 'Posted to FBR' }] }),
        invoice('i2', { status: 'failed' })], nextCursor: null });
    // learnProducts may add the posted line's product
    const learn = await vi.waitFor(() => { const r = http.match({ method: 'PUT' }); if (!r.length) throw new Error('waiting'); return r; }).catch(() => []);
    learn.forEach(r => r.flush({ ...r.request.body, businessId: 'b1' }));
    await done;
    expect(posting.progress()).toMatchObject({ total: 2, done: 2, posted: 1, failed: 1, skipped: 1, running: false });
    expect(store.invoiceById('i1')?.history.at(-1)?.action).toBe('Posted to FBR');
  });

  it('posting one invoice: a timeout comes back as outcome unknown', async () => {
    await signedIn(http, store, [invoice('i1')]);
    const out = posting.post(store.invoiceById('i1')!);
    const req = await next(http, '/api/businesses/b1/invoices/i1/post', 'POST');
    expect(req.request.body).toEqual({});
    req.flush({ batchId: 'bt_2', invoice: invoice('i1', { status: 'queued' }) });
    await vi.waitFor(() => expect(FakeEventSource.last?.url).toContain('bt_2'));
    const es = FakeEventSource.last!;
    es.emit('invoice', { id: 'i1', status: 'outcome_unknown', issues: [{ code: 'L-504', message: 'FBR did not respond in time', source: 'fbr' }], attempts: 1 });
    es.emit('done', progress({ total: 1, outcomeUnknown: 1, done: 1, running: false }));
    (await next(http, '/api/businesses/b1/invoices?limit=200&batchId=bt_2'))
      .flush({ items: [invoice('i1', { status: 'outcome_unknown', issues: [{ code: 'L-504', message: 'FBR did not respond in time', source: 'fbr' }] })], nextCursor: null });
    const r = await out;
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe('unknown');
  });

  it('posting again after an IRIS check sends confirmNotInIris', async () => {
    await signedIn(http, store, [invoice('i1', { status: 'outcome_unknown' })]);
    const out = posting.post(store.invoiceById('i1')!, { confirmNotInIris: true });
    const req = await next(http, '/api/businesses/b1/invoices/i1/post', 'POST');
    expect(req.request.body).toEqual({ confirmNotInIris: true });
    req.flush({ code: 'NOT_POSTABLE', message: 'Already posted' }, { status: 409, statusText: 'Conflict' });
    const r = await out;
    expect(r.ok === false && r.message).toBe('Already posted');
  });

  it('falls back to polling when the event stream fails', async () => {
    await signedIn(http, store, [invoice('i1')]);
    const done = posting.postBatch(['i1']);
    (await next(http, '/api/businesses/b1/invoices/post-batch', 'POST')).flush({ batchId: 'bt_3', queued: ['i1'], skipped: [] });
    await vi.waitFor(() => expect(FakeEventSource.last?.url).toContain('bt_3'));
    FakeEventSource.last!.onerror?.();
    expect(FakeEventSource.last!.closed).toBe(true);
    (await next(http, '/api/businesses/b1/invoices/batches/bt_3')).flush(progress({ total: 1, posted: 1, done: 1, running: false }));
    (await next(http, '/api/businesses/b1/invoices?limit=200&batchId=bt_3')).flush({ items: [invoice('i1', { status: 'posted', fbrInvoiceNumber: 'IRN9' })], nextCursor: null });
    const learn = await vi.waitFor(() => { const r = http.match({ method: 'PUT' }); if (!r.length) throw new Error('waiting'); return r; }).catch(() => []);
    learn.forEach(r => r.flush({ ...r.request.body, businessId: 'b1' }));
    await done;
    expect(posting.progress()).toMatchObject({ done: 1, posted: 1, running: false });
    expect(store.invoiceById('i1')?.fbrInvoiceNumber).toBe('IRN9');
  });
});
