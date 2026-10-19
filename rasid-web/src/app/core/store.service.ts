import { Injectable, effect } from '@angular/core';
import { Business, Customer, ImportMapping, Invoice, Product } from './models';
import { BulkSaveResult, Store } from './store';
import { FURTHER_TAX_DEFAULT } from './fbr-reference';
import { computeLine, taxContext } from './tax';
import { nowIso, uid } from './util';

const KEY = 'rasid:v1:';

function load<T>(name: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(KEY + name);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function save(name: string, value: unknown) {
  try { localStorage.setItem(KEY + name, JSON.stringify(value)); } catch { /* storage full or blocked */ }
}

/**
 * Offline demo store (environment.useApi = false): everything persists to
 * localStorage and a demo business is seeded on first run. Writes always succeed.
 */
@Injectable()
export class StoreService extends Store {
  readonly mode = 'local' as const;

  constructor() {
    super();
    this.user.set(load('user', null));
    this.businesses.set(load('businesses', []));
    this.activeBusinessId.set(load('activeBusiness', null));
    this.invoices.set(load('invoices', []));
    this.customers.set(load('customers', []));
    this.products.set(load('products', []));
    this.mappings.set(load('mappings', []));
    if (!this.businesses().length) this.seed();
    effect(() => save('user', this.user()));
    effect(() => save('businesses', this.businesses()));
    effect(() => save('activeBusiness', this.activeBusinessId()));
    effect(() => save('invoices', this.invoices()));
    effect(() => save('customers', this.customers()));
    effect(() => save('products', this.products()));
    effect(() => save('mappings', this.mappings()));
  }

  async restoreSession() { return !!this.user(); }

  /* ---------- invoices ---------- */
  async upsertInvoice(inv: Invoice) {
    inv = { ...inv, updatedAt: nowIso() };
    this.cacheInvoice(inv);
    return inv;
  }
  async upsertMany(invs: Invoice[], onProgress?: (done: number, total: number) => void): Promise<BulkSaveResult> {
    const at = nowIso();
    const byId = new Map(invs.map(i => [i.id, { ...i, updatedAt: at }]));
    this.invoices.update(list => [...byId.values(), ...list.filter(i => !byId.has(i.id))]);
    onProgress?.(invs.length, invs.length);
    return { saved: [...byId.values()], errors: [] };
  }
  async deleteInvoice(id: string) { this.invoices.update(l => l.filter(i => i.id !== id)); }

  /* ---------- business and masters ---------- */
  async updateBusiness(b: Business) { this.businesses.update(l => l.map(x => x.id === b.id ? b : x)); return b; }
  async addBusiness(b: Business) { this.businesses.update(l => [...l, b]); this.activeBusinessId.set(b.id); return b; }
  async upsertCustomer(c: Customer) {
    this.customers.update(l => l.some(x => x.id === c.id) ? l.map(x => x.id === c.id ? c : x) : [c, ...l]);
    return c;
  }
  async deleteCustomer(id: string) { this.customers.update(l => l.filter(c => c.id !== id)); }
  async upsertProduct(p: Product) {
    this.products.update(l => l.some(x => x.id === p.id) ? l.map(x => x.id === p.id ? p : x) : [p, ...l]);
    return p;
  }
  async deleteProduct(id: string) { this.products.update(l => l.filter(p => p.id !== id)); }
  async saveMapping(m: ImportMapping) {
    this.mappings.update(l => [m, ...l.filter(x => !(x.businessId === m.businessId && x.signature === m.signature))]);
    return m;
  }
  async deleteMapping(id: string) { this.mappings.update(l => l.filter(m => m.id !== id)); }

  override resetDemo() {
    Object.keys(localStorage).filter(k => k.startsWith(KEY)).forEach(k => localStorage.removeItem(k));
    location.reload();
  }

  /** Sign-out keeps the demo data. */
  override clear() { this.user.set(null); }

  /* ---------- demo seed ---------- */
  private seed() {
    const bizId = 'b_demo';
    const biz: Business = {
      id: bizId, name: 'Al-Noor Traders (Pvt) Ltd', ntnCnic: '1234567', province: 'Punjab',
      address: '14-B Gulberg III, Lahore', activity: 'Distributor', sector: 'FMCG', environment: 'sandbox',
      hasSandboxToken: true, hasProductionToken: false, tokenHintSandbox: '••••9f2a',
      defaultSaleType: 'Goods at standard rate (default)', furtherTaxRate: FURTHER_TAX_DEFAULT,
      invoicePrefix: 'ANT-', nextInvoiceNo: 1043,
    };
    const second: Business = {
      ...biz, id: 'b_demo2', name: 'Faisal Textile Mills', ntnCnic: '7654321', province: 'Punjab',
      address: 'Sargodha Road, Faisalabad', activity: 'Manufacturer', sector: 'Textile',
      hasSandboxToken: false, tokenHintSandbox: undefined, invoicePrefix: 'FTM-', nextInvoiceNo: 1,
    };
    const customers: Customer[] = [
      { id: 'c1', businessId: bizId, ntnCnic: '4410235', name: 'Metro Cash & Carry Pakistan', province: 'Punjab', address: 'Thokar Niaz Baig, Lahore', registrationType: 'Registered', activeStatus: 'Active' },
      { id: 'c2', businessId: bizId, ntnCnic: '3820114', name: 'Imtiaz Super Market', province: 'Sindh', address: 'Gulshan-e-Iqbal, Karachi', registrationType: 'Registered', activeStatus: 'Active' },
      { id: 'c3', businessId: bizId, ntnCnic: '5129903', name: 'Hamid & Sons General Store', province: 'Punjab', address: 'Kotwali Road, Faisalabad', registrationType: 'Registered', activeStatus: 'Active' },
      { id: 'c4', businessId: bizId, ntnCnic: '3520212345671', name: 'Usman Kiryana', province: 'Punjab', address: 'Model Town, Gujranwala', registrationType: 'Unregistered', activeStatus: 'Unknown' },
      { id: 'c5', businessId: bizId, ntnCnic: '2287741', name: 'Peshawar Wholesale Mart', province: 'Khyber Pakhtunkhwa', address: 'Saddar Road, Peshawar', registrationType: 'Registered', activeStatus: 'Active' },
    ];
    const products: Product[] = [
      { id: 'p1', businessId: bizId, name: 'Refined sugar 50kg bag', hsCode: '1701.9910', uoM: 'KG', saleType: 'Goods at standard rate (default)', rate: '18%', unitPrice: 155 },
      { id: 'p2', businessId: bizId, name: 'Basmati rice 25kg', hsCode: '1006.3090', uoM: 'KG', saleType: 'Goods at standard rate (default)', rate: '18%', unitPrice: 340 },
      { id: 'p3', businessId: bizId, name: 'Beauty soap 100g (carton of 72)', hsCode: '3401.1100', uoM: 'Numbers, pieces, units', saleType: '3rd Schedule Goods', rate: '18%', unitPrice: 6200 },
      { id: 'p4', businessId: bizId, name: 'Polythene shopping bags', hsCode: '3923.2100', uoM: 'KG', saleType: 'Goods at standard rate (default)', rate: '18%', unitPrice: 410 },
    ];

    const invoices: Invoice[] = [];
    const statuses: Invoice['status'][] = ['posted', 'posted', 'posted', 'posted', 'posted', 'posted', 'failed', 'draft', 'validated'];
    const now = new Date();
    for (let n = 0; n < 42; n++) {
      const d = new Date(now.getTime() - (n * 4.3 + (n % 3)) * 86400000);
      const date = d.toISOString().slice(0, 10);
      const c = customers[n % customers.length];
      const p = products[n % 3 === 2 ? 1 : n % 2];
      const qty = 40 + ((n * 37) % 260);
      const buyer = { ntnCnic: c.ntnCnic, name: c.name, province: c.province, address: c.address, registrationType: c.registrationType };
      const line = computeLine({
        hsCode: p.hsCode, productDescription: p.name, rate: p.rate, uoM: p.uoM, quantity: qty, unitPrice: p.unitPrice,
        totalValues: 0, valueSalesExcludingST: 0, fixedNotifiedValueOrRetailPrice: 0, salesTaxApplicable: 0,
        salesTaxWithheldAtSource: 0, extraTax: 0, furtherTax: 0, sroScheduleNo: '', fedPayable: 0, discount: 0,
        saleType: p.saleType, sroItemSerialNo: '',
      }, buyer, taxContext(biz, date));
      const status = n < 3 ? (['draft', 'failed', 'validated'] as const)[n] : statuses[n % statuses.length];
      const posted = status === 'posted';
      const irn = posted ? `${biz.ntnCnic}DI${d.getTime()}` : undefined;
      invoices.push({
        id: uid('i_'), businessId: bizId, localRef: `ANT-${String(1042 - n).padStart(5, '0')}`,
        invoiceType: 'Sale Invoice', invoiceDate: date, buyer, items: [line], invoiceRefNo: '',
        environment: 'sandbox', status,
        issues: status === 'failed' ? [{ code: '0052', message: 'Provide proper HS code with sale type', hint: 'This HS code does not fit the selected sale type.', field: 'hsCode', itemIndex: 0, source: 'fbr' }] : [],
        fbrInvoiceNumber: irn, fbrItemNumbers: irn ? [`${irn}-1`] : undefined,
        fbrDated: posted ? `${date} ${String(9 + (n % 8)).padStart(2, '0')}:${String((n * 7) % 60).padStart(2, '0')}:12` : undefined,
        attempts: posted ? 1 : 0, createdAt: d.toISOString(), updatedAt: d.toISOString(),
        history: [{ at: d.toISOString(), actor: 'Ayesha Khan', action: 'Created' }, ...(posted ? [{ at: d.toISOString(), actor: 'system', action: 'Posted to FBR', detail: irn }] : [])],
      });
    }
    this.businesses.set([biz, second]);
    this.activeBusinessId.set(bizId);
    this.customers.set(customers);
    this.products.set(products);
    this.invoices.set(invoices);
  }
}
