import type { Page, Route } from '@playwright/test';

/**
 * The Rasid API, faked per test with page.route: one signed-in owner, one
 * sandbox business, an in-memory invoice store, PRAL reference data that
 * differs from the bundled lists (so a test can tell which one the app used),
 * and a posting gateway that "posts" every invoice it's handed.
 */
export const BUSINESS = {
  id: 'b1', name: 'Al-Noor Traders', ntnCnic: '1234567', province: 'Punjab', address: 'Lahore', activity: 'Distributor', sector: 'FMCG',
  environment: 'sandbox', hasSandboxToken: true, hasProductionToken: false, defaultSaleType: 'Goods at standard rate (default)',
  furtherTaxRate: 4, furtherTaxRates: [], invoicePrefix: 'ANT-', nextInvoiceNo: 1,
};

/** PRAL's rates for Punjab. The reduced rate is 7.5%, which the bundled offline list doesn't have. */
const RATES = [
  { saleType: 'goods at standard rate (default)', transTypeId: 75, rates: [{ id: 734, desc: '18%', value: 18 }] },
  { saleType: 'goods at reduced rate', transTypeId: 24, rates: [{ id: 281, desc: '7.5%', value: 7.5 }] },
];
const HS = [
  { code: '1701.1400', description: 'Other cane sugar, raw' },
  { code: '1701.9910', description: 'Refined sugar, cane or beet' },
  { code: '2716.0000', description: 'Electrical energy' },
];
const UOM_FOR_HS: Record<string, string[]> = { '1701.9910': ['KG'], '1701.1400': ['KG', 'MT'], '2716.0000': ['KWH'] };

export interface FakeApi {
  /** Every request the app made, as "METHOD /path?query". */
  calls: string[];
  /** Invoices as the app saved them (the request bodies), by id. */
  saved: Map<string, Record<string, unknown>>;
  /** Payloads handed to the posting gateway. */
  posted: Record<string, unknown>[];
}

export async function fakeApi(page: Page): Promise<FakeApi> {
  const api: FakeApi = { calls: [], saved: new Map(), posted: [] };
  const invoices = new Map<string, Record<string, unknown>>();
  let irn = 1;

  await page.route('**/api/**', async (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace(/^\/api/, '');
    const q = (k: string) => url.searchParams.get(k) ?? '';
    api.calls.push(`${req.method()} ${path}${url.search}`);
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    const ref = /^\/businesses\/b1\/reference\/(.+)$/.exec(path)?.[1];

    if (path === '/auth/me') return json({ id: 'u1', name: 'Ayesha Khan', email: 'ayesha@alnoor.pk', role: 'owner' });
    if (path === '/businesses') return json([BUSINESS]);
    if (/^\/businesses\/b1\/(customers|products|import-mappings)$/.test(path)) return json([]);

    if (ref === 'rates') return json({ source: 'pral', province: { code: 7, desc: 'PUNJAB' }, date: q('date'),
      saleTypes: RATES.map(r => ({ ...r, transTypeDesc: r.saleType, asOf: q('date') })) });
    if (ref === 'uom') return json({ source: 'pral', kind: 'uom', items: ['KG', 'MT', 'KWH', 'Numbers, pieces, units'].map((d, i) => ({ id: i + 1, description: d })) });
    if (ref === 'hs') {
      const text = q('q').toLowerCase();
      return json({ source: 'pral', results: HS.filter(h => h.code.replace('.', '').startsWith(text.replace('.', '')) || h.description.toLowerCase().includes(text)) });
    }
    if (ref === 'hs-check') {
      const codes = q('codes').split(',');
      return json({ source: 'pral', codes: Object.fromEntries(codes.map(c => {
        const h = HS.find(x => x.code === c);
        return [c, h ? { known: true, description: h.description, uoms: UOM_FOR_HS[c] ?? null } : { known: false, uoms: null }];
      })) });
    }
    if (ref === 'uom-for-hs') return json({ source: 'pral', uoms: UOM_FOR_HS[q('hs')] ?? [] });
    if (ref === 'sro') return json({ source: 'pral', schedules: q('rateId') === '281' ? [{ id: 389, serNo: 1, desc: 'EIGHTH SCHEDULE Table 1' }] : [] });
    if (ref === 'sro-items') return json({ source: 'pral', items: q('sroId') === '389' ? [{ id: 17853, desc: '50' }, { id: 17854, desc: '51' }] : [] });

    const inv = /^\/businesses\/b1\/invoices(?:\/([^/]+))?$/.exec(path);
    if (inv && req.method() === 'GET' && !inv[1]) {
      const batch = q('batchId');
      return json({ items: [...invoices.values()].filter(i => !batch || i['batchId'] === batch), nextCursor: null });
    }
    if (inv && (req.method() === 'POST' || req.method() === 'PUT')) {
      const body = req.postDataJSON() as Record<string, unknown>;
      const id = (inv[1] ?? body['id']) as string;
      const now = new Date().toISOString();
      const stored = { ...invoices.get(id), ...body, id, businessId: 'b1', status: body['status'] ?? 'draft', issues: [], attempts: 0,
        createdAt: invoices.get(id)?.['createdAt'] ?? now, updatedAt: now, history: [] };
      invoices.set(id, stored);
      api.saved.set(id, body);
      return json(stored, inv[1] ? 200 : 201);
    }

    // Posting gateway: queue, then report the invoice posted with an IRN.
    const post = /^\/businesses\/b1\/invoices\/([^/]+)\/post$/.exec(path);
    if (post) {
      const stored = invoices.get(post[1]!)!;
      api.posted.push(stored);
      const posted = { ...stored, status: 'posted', batchId: 'bt1', fbrInvoiceNumber: `1234567DI${Date.now()}${irn++}`, fbrPostedAt: new Date().toISOString() };
      invoices.set(post[1]!, posted);
      return json({ batchId: 'bt1', invoice: { ...stored, status: 'queued', batchId: 'bt1' } }, 202);
    }
    if (path === '/businesses/b1/invoices/batches/bt1/events') {
      const done = [...invoices.values()].filter(i => i['batchId'] === 'bt1');
      const events = done.map(i => `event: invoice\ndata: ${JSON.stringify({ id: i['id'], status: i['status'], fbrInvoiceNumber: i['fbrInvoiceNumber'], issues: [] })}\n\n`).join('')
        + `event: done\ndata: ${JSON.stringify({ total: done.length, queued: 0, posting: 0, posted: done.length, failed: 0, outcomeUnknown: 0, done: done.length, running: false })}\n\n`;
      return route.fulfill({ status: 200, contentType: 'text/event-stream', body: events });
    }
    if (path === '/businesses/b1/invoices/batches/bt1') {
      return json({ total: 1, queued: 0, posting: 0, posted: 1, failed: 0, outcomeUnknown: 0, done: 1, running: false });
    }
    return json({ message: `Not faked: ${req.method()} ${path}` }, 404);
  });
  return api;
}
