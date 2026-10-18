import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { InvoiceStatus } from '../../core/models';
import { PostingService } from '../../core/posting.service';
import { StoreService } from '../../core/store.service';
import { invoiceTotals } from '../../core/tax';
import { UiService } from '../../core/ui.service';
import { formatPkr } from '../../core/util';
import { IconComponent } from '../../shared/icon.component';
import { StatusChipComponent } from '../../shared/status-chip.component';

type Filter = 'all' | 'draft' | 'failed' | 'posted';
const PAGE = 50;

@Component({
  selector: 'app-invoice-list',
  imports: [FormsModule, RouterLink, IconComponent, StatusChipComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <div class="page">
    <div class="page-header">
      <div>
        <h1>Invoices</h1>
        <p class="lead">{{ store.bizInvoices().length }} invoices for {{ store.business()?.name }}</p>
      </div>
      <div class="row">
        <button class="btn" (click)="exportCsv()"><app-icon name="download" /> Export CSV</button>
        <a class="btn btn-primary" routerLink="/invoices/new"><app-icon name="plus" /> New invoice</a>
      </div>
    </div>

    <div class="toolbar">
      <div class="segmented" role="tablist" aria-label="Filter by status">
        @for (f of filters; track f.key) {
          <button role="tab" [class.on]="filter() === f.key" [attr.aria-selected]="filter() === f.key" (click)="setFilter(f.key)">
            {{ f.label }} <span class="n">{{ count(f.key) }}</span>
          </button>
        }
      </div>
      <label class="search">
        <app-icon name="search" [size]="16" />
        <input class="input" placeholder="Search invoice no., buyer, NTN or FBR no." [ngModel]="q()" (ngModelChange)="q.set($event); page.set(0)" aria-label="Search invoices" />
      </label>
      <input class="input date" type="month" [ngModel]="month()" (ngModelChange)="month.set($event); page.set(0)" aria-label="Filter by month" />
    </div>

    @if (selected().size) {
      <div class="bulkbar">
        <b>{{ selected().size }} selected</b>
        <span class="spacer"></span>
        <button class="btn btn-sm" (click)="validateSelected()" [disabled]="busy()"><app-icon name="check" /> Validate with FBR</button>
        <button class="btn btn-sm btn-primary" (click)="postSelected()" [disabled]="busy() || !postable().length">
          <app-icon name="send" /> Post {{ postable().length }} to FBR
        </button>
        <button class="btn btn-sm btn-ghost btn-danger" (click)="deleteSelected()" [disabled]="busy() || !deletable().length">Delete {{ deletable().length }} unposted</button>
        <button class="btn btn-sm btn-ghost" (click)="clearSelection()">Clear</button>
      </div>
    }
    @if (posting.progress().running) {
      <div class="panel prog">
        <div class="row"><b>Posting to FBR</b><span class="subtle">{{ posting.progress().done }} of {{ posting.progress().total }}</span>
          <span class="spacer"></span>
          <span class="ok">{{ posting.progress().posted }} posted</span>
          <span class="bad">{{ posting.progress().failed }} rejected</span>
          @if (posting.progress().paused) { <button class="btn btn-sm" (click)="posting.resume()"><app-icon name="play" /> Resume</button> }
          @else { <button class="btn btn-sm" (click)="posting.pause()"><app-icon name="pause" /> Pause</button> }
        </div>
        <div class="progress"><div [style.width.%]="posting.percent()"></div></div>
      </div>
    }

    <div class="panel">
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th style="width:36px"><input type="checkbox" [checked]="allChecked()" (change)="toggleAll()" aria-label="Select all on this page" /></th>
              <th>Invoice</th><th>Date</th><th>Buyer</th><th>Status</th><th>FBR invoice no.</th>
              <th class="num">Sales tax</th><th class="num">Total (PKR)</th>
            </tr>
          </thead>
          <tbody>
            @for (i of pageRows(); track i.id) {
              <tr class="clickable" (click)="open(i.id, i.status)">
                <td (click)="$event.stopPropagation()"><input type="checkbox" [checked]="selected().has(i.id)" (change)="toggle(i.id)" [attr.aria-label]="'Select ' + i.localRef" /></td>
                <td><b>{{ i.localRef }}</b>@if (i.invoiceType === 'Debit Note') { <span class="tag">Debit note</span> }</td>
                <td>{{ i.invoiceDate }}</td>
                <td><div class="buyer">{{ i.buyer.name }}</div><small class="subtle">{{ i.buyer.ntnCnic || 'Unregistered' }}</small></td>
                <td>
                  <app-status-chip [status]="i.status" />
                  @if (i.status === 'failed' && i.issues[0]) { <div class="why">{{ i.issues[0].code }} {{ i.issues[0].message }}</div> }
                </td>
                <td class="irn">{{ i.fbrInvoiceNumber || '—' }}</td>
                <td class="num">{{ fmt(tot(i).salesTax + tot(i).furtherTax) }}</td>
                <td class="num"><b>{{ fmt(tot(i).total) }}</b></td>
              </tr>
            } @empty {
              <tr><td colspan="8">
                <div class="empty">
                  <h3>No invoices match</h3>
                  <p>Change the filters, or create your first invoice.</p>
                  <a class="btn btn-primary" routerLink="/invoices/new">New invoice</a>
                </div>
              </td></tr>
            }
          </tbody>
        </table>
      </div>
      @if (pages() > 1) {
        <div class="pager">
          <span class="subtle">Showing {{ page() * 50 + 1 }}–{{ min((page() + 1) * 50, rows().length) }} of {{ rows().length }}</span>
          <span class="spacer"></span>
          <button class="btn btn-sm" [disabled]="page() === 0" (click)="page.set(page() - 1)"><app-icon name="left" /></button>
          <button class="btn btn-sm" [disabled]="page() >= pages() - 1" (click)="page.set(page() + 1)"><app-icon name="right" /></button>
        </div>
      }
    </div>
  </div>`,
  styles: [`
    .table td { white-space: nowrap; }
    .toolbar { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; margin-bottom: 16px; }
    .segmented .n { color: var(--ink-3); font-weight: 500; margin-left: 4px; }
    .search { position: relative; flex: 1; min-width: 240px; }
    .search app-icon { position: absolute; left: 12px; top: 11px; color: var(--ink-3); }
    .search .input { padding-left: 36px; }
    .date { width: 170px; }
    .bulkbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 10px 14px; margin-bottom: 12px;
      background: var(--accent-soft); border-radius: var(--radius-s); }
    .prog { padding: 14px 18px; margin-bottom: 12px; display: flex; flex-direction: column; gap: 10px; }
    .ok { color: var(--accent); font-weight: 600; font-size: var(--fs-s); }
    .bad { color: var(--danger); font-weight: 600; font-size: var(--fs-s); }
    .buyer { max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .why { font-size: var(--fs-xs); color: var(--danger); margin-top: 3px; max-width: 220px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .irn { color: var(--stamp); font-weight: 600; font-variant-numeric: tabular-nums; }
    .tag { margin-left: 6px; font-size: 11px; color: var(--info); background: var(--info-soft); padding: 1px 6px; border-radius: 4px; }
    .pager { display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-top: 1px solid var(--line); }
  `],
})
export class InvoiceListComponent {
  protected store = inject(StoreService);
  protected posting = inject(PostingService);
  private ui = inject(UiService);
  private router = inject(Router);

  /** Bound from ?status= query param. */
  readonly status = input<string>();

  protected filters: { key: Filter; label: string }[] = [
    { key: 'all', label: 'All' }, { key: 'draft', label: 'Not posted' }, { key: 'failed', label: 'Rejected' }, { key: 'posted', label: 'Posted' },
  ];
  protected filter = signal<Filter>('all');
  protected q = signal('');
  protected month = signal('');
  protected page = signal(0);
  protected selected = signal(new Set<string>());
  protected busy = signal(false);
  protected fmt = (n: number) => formatPkr(n);
  protected min = Math.min;
  protected readonly Set = Set;

  constructor() {
    effect(() => {
      const s = this.status();
      if (s === 'failed' || s === 'posted') this.filter.set(s);
      else if (s === 'draft' || s === 'validated') this.filter.set('draft');
    });
  }

  private matches(s: InvoiceStatus, f: Filter) {
    return f === 'all' || (f === 'draft' ? ['draft', 'validated', 'queued', 'posting'].includes(s) : s === f);
  }
  protected count = (f: Filter) => this.store.bizInvoices().filter(i => this.matches(i.status, f)).length;

  protected rows = computed(() => {
    const q = this.q().trim().toLowerCase(); const m = this.month(); const f = this.filter();
    return this.store.bizInvoices().filter(i =>
      this.matches(i.status, f) &&
      (!m || i.invoiceDate.startsWith(m)) &&
      (!q || [i.localRef, i.buyer.name, i.buyer.ntnCnic, i.fbrInvoiceNumber ?? ''].some(v => v.toLowerCase().includes(q))));
  });
  protected pages = computed(() => Math.ceil(this.rows().length / PAGE));
  protected pageRows = computed(() => this.rows().slice(this.page() * PAGE, (this.page() + 1) * PAGE));
  protected allChecked = computed(() => this.pageRows().length > 0 && this.pageRows().every(r => this.selected().has(r.id)));

  private selectedInvoices = computed(() => this.store.bizInvoices().filter(i => this.selected().has(i.id)));
  protected postable = computed(() => this.selectedInvoices().filter(i => i.status !== 'posted' && i.status !== 'posting'));
  protected deletable = computed(() => this.selectedInvoices().filter(i => i.status !== 'posted'));

  private totalsCache = new WeakMap<object, ReturnType<typeof invoiceTotals>>();
  protected tot(i: { items: Parameters<typeof invoiceTotals>[0] }) {
    let t = this.totalsCache.get(i.items);
    if (!t) { t = invoiceTotals(i.items); this.totalsCache.set(i.items, t); }
    return t;
  }

  clearSelection() { this.selected.set(new Set()); }
  setFilter(f: Filter) { this.filter.set(f); this.page.set(0); this.selected.set(new Set()); }
  toggle(id: string) { this.selected.update(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; }); }
  toggleAll() {
    const all = this.allChecked();
    this.selected.update(s => { const n = new Set(s); this.pageRows().forEach(r => all ? n.delete(r.id) : n.add(r.id)); return n; });
  }
  open(id: string, status: InvoiceStatus) {
    this.router.navigate(status === 'posted' ? ['/invoices', id] : ['/invoices', id, 'edit']);
  }

  async validateSelected() {
    this.busy.set(true);
    let ok = 0, bad = 0;
    for (const inv of this.postable()) {
      try { const r = await this.posting.validate(inv); r.issues.length ? bad++ : ok++; } catch { bad++; }
    }
    this.busy.set(false);
    this.ui.toast(`${ok} valid, ${bad} with problems`, bad ? 'info' : 'ok');
  }

  async postSelected() {
    const ids = this.postable().map(i => i.id);
    this.busy.set(true); this.selected.set(new Set());
    await this.posting.postBatch(ids);
    this.busy.set(false);
    const p = this.posting.progress();
    this.ui.toast(`${p.posted} posted to FBR${p.failed ? `, ${p.failed} rejected` : ''}`, p.failed ? 'info' : 'ok');
  }

  deleteSelected() {
    const list = this.deletable();
    if (!confirm(`Delete ${list.length} unposted invoice(s)? Posted invoices are kept.`)) return;
    list.forEach(i => this.store.deleteInvoice(i.id));
    this.selected.set(new Set());
    this.ui.toast(`Deleted ${list.length} invoice(s)`);
  }

  exportCsv() {
    const esc = (v: unknown) => {
      let s = String(v ?? '');
      if (/^[=+\-@]/.test(s)) s = "'" + s;   // block CSV formula injection
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const head = ['Invoice no', 'Date', 'Type', 'Buyer', 'Buyer NTN/CNIC', 'Status', 'FBR invoice no', 'Value excl ST', 'Sales tax', 'Further tax', 'Total'];
    const lines = this.rows().map(i => {
      const t = invoiceTotals(i.items);
      return [i.localRef, i.invoiceDate, i.invoiceType, i.buyer.name, i.buyer.ntnCnic, i.status, i.fbrInvoiceNumber, t.value, t.salesTax, t.furtherTax, t.total].map(esc).join(',');
    });
    const blob = new Blob([[head.join(','), ...lines].join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = `invoices-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
    URL.revokeObjectURL(a.href);
  }
}
