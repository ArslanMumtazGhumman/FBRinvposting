import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { StoreService } from '../../core/store.service';
import { invoiceTotals } from '../../core/tax';
import { formatPkr } from '../../core/util';
import { IconComponent } from '../../shared/icon.component';
import { StatusChipComponent } from '../../shared/status-chip.component';

interface MonthBar { key: string; label: string; tax: number; count: number; }

@Component({
  selector: 'app-dashboard',
  imports: [RouterLink, IconComponent, StatusChipComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <div class="page">
    <div class="page-header">
      <div>
        <h1>{{ greeting() }}, {{ firstName() }}</h1>
        <p class="lead">{{ store.business()?.name }}, {{ monthName }} to date</p>
      </div>
      <div class="row">
        <a class="btn" routerLink="/import"><app-icon name="upload" /> Import Excel</a>
        <a class="btn btn-primary" routerLink="/invoices/new"><app-icon name="plus" /> New invoice</a>
      </div>
    </div>

    <section class="kpis">
      <div class="kpi hero">
        <span class="k-label">Sales tax reported to FBR this month</span>
        <span class="k-value">Rs {{ fmt(month().salesTax) }}</span>
        <span class="k-sub">on Rs {{ fmt(month().value) }} of sales across {{ month().posted }} posted {{ month().posted === 1 ? 'invoice' : 'invoices' }}</span>
      </div>
      <a class="kpi" routerLink="/invoices" [queryParams]="{ status: 'failed' }" [class.alert]="counts().failed > 0">
        <span class="k-label">Rejected, need fixing</span>
        <span class="k-value">{{ counts().failed }}</span>
        <span class="k-sub">{{ counts().failed ? 'Open to see the exact cell' : 'Nothing to fix' }}</span>
      </a>
      <a class="kpi" routerLink="/invoices" [queryParams]="{ status: 'draft' }">
        <span class="k-label">Not yet posted</span>
        <span class="k-value">{{ counts().draft + counts().validated + counts().queued }}</span>
        <span class="k-sub">{{ counts().validated }} validated and ready</span>
      </a>
    </section>

    <div class="cols">
      <section class="panel chart-panel">
        <div class="panel-head">
          <h2>Sales tax posted, last 6 months</h2>
          <span class="subtle">PKR</span>
        </div>
        <div class="panel-body">
          <svg [attr.viewBox]="'0 0 ' + W + ' ' + H" class="chart" role="img" [attr.aria-label]="chartLabel()">
            @for (t of ticks(); track t) {
              <line [attr.x1]="padL" [attr.x2]="W - 8" [attr.y1]="y(t)" [attr.y2]="y(t)" class="grid" />
              <text [attr.x]="padL - 8" [attr.y]="y(t) + 4" text-anchor="end" class="axis">{{ short(t) }}</text>
            }
            @for (b of bars(); track b.key; let i = $index) {
              <g (mouseenter)="hover.set(i)" (mouseleave)="hover.set(-1)" (focus)="hover.set(i)" (blur)="hover.set(-1)" tabindex="0">
                <rect [attr.x]="bx(i) - 6" [attr.y]="padT" [attr.width]="bw + 12" [attr.height]="plotH" fill="transparent" />
                <path [attr.d]="barPath(i, b.tax)" class="bar" [class.dim]="hover() !== -1 && hover() !== i" />
                <text [attr.x]="bx(i) + bw / 2" [attr.y]="H - 10" text-anchor="middle" class="axis">{{ b.label }}</text>
              </g>
            }
            @if (hover() !== -1) {
              @let b = bars()[hover()];
              <g class="tip" [attr.transform]="'translate(' + tipX(hover()) + ',' + (y(b.tax) - 52) + ')'">
                <rect width="150" height="44" rx="6" />
                <text x="10" y="18" class="tip-t">{{ b.label }}</text>
                <text x="10" y="35" class="tip-v">Rs {{ fmt(b.tax) }}, {{ b.count }} invoices</text>
              </g>
            }
          </svg>
          <details class="table-view">
            <summary>Show as table</summary>
            <table class="table">
              <thead><tr><th>Month</th><th class="num">Sales tax (PKR)</th><th class="num">Posted invoices</th></tr></thead>
              <tbody>@for (b of bars(); track b.key) { <tr><td>{{ b.label }}</td><td class="num">{{ fmt(b.tax) }}</td><td class="num">{{ b.count }}</td></tr> }</tbody>
            </table>
          </details>
        </div>
      </section>

      <section class="panel">
        <div class="panel-head"><h2>Needs attention</h2><a routerLink="/invoices" [queryParams]="{ status: 'failed' }" class="subtle">All rejected</a></div>
        @if (attention().length) {
          <ul class="att">
            @for (i of attention(); track i.id) {
              <li>
                <a [routerLink]="['/invoices', i.id, 'edit']">
                  <div class="row"><b>{{ i.localRef }}</b><span class="spacer"></span><app-status-chip [status]="i.status" /></div>
                  <span class="subtle">{{ i.buyer.name }}</span>
                  @if (i.issues[0]; as is) { <span class="err">{{ is.code }} — {{ is.hint || is.message }}</span> }
                </a>
              </li>
            }
          </ul>
        } @else {
          <div class="empty"><h3>All clear</h3><p>Every invoice you created has been accepted by FBR.</p></div>
        }
      </section>
    </div>

    <section class="panel recent">
      <div class="panel-head"><h2>Recently posted</h2><a routerLink="/invoices" class="subtle">All invoices</a></div>
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>Invoice</th><th>Buyer</th><th>Date</th><th>FBR invoice no.</th><th class="num">Total (PKR)</th></tr></thead>
          <tbody>
            @for (i of recent(); track i.id) {
              <tr class="clickable" [routerLink]="['/invoices', i.id]">
                <td><b>{{ i.localRef }}</b></td><td>{{ i.buyer.name }}</td><td>{{ i.invoiceDate }}</td>
                <td class="irn">{{ i.fbrInvoiceNumber }}</td><td class="num">{{ fmt(totals(i).total) }}</td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    </section>
  </div>`,
  styles: [`
    .kpis { display: grid; grid-template-columns: 2fr 1fr 1fr; gap: 16px; margin-bottom: 16px; }
    .kpi { display: flex; flex-direction: column; gap: 4px; padding: 18px 20px; background: var(--surface); border: 1px solid var(--line);
      border-radius: var(--radius-m); color: inherit; text-decoration: none; }
    a.kpi:hover { border-color: var(--line-strong); }
    .kpi.hero { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
    .kpi.hero .k-label, .kpi.hero .k-sub { color: inherit; opacity: .85; }
    .kpi.alert .k-value { color: var(--danger); }
    .k-label { font-size: var(--fs-s); font-weight: 600; color: var(--ink-2); }
    .k-value { font-size: var(--fs-xxl); font-weight: 800; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; }
    .kpi.hero .k-value { font-size: 2.5rem; }
    .k-sub { font-size: var(--fs-s); color: var(--ink-3); }
    .cols { display: grid; grid-template-columns: 1.6fr 1fr; gap: 16px; margin-bottom: 16px; }
    .chart { width: 100%; height: auto; display: block; overflow: visible; }
    .grid { stroke: var(--line); stroke-width: 1; }
    .axis { fill: var(--ink-3); font-size: 11px; }
    .bar { fill: var(--accent); transition: opacity .12s; }
    .bar.dim { opacity: .35; }
    g[tabindex]:focus { outline: none; }
    g[tabindex]:focus .bar { stroke: var(--ink); stroke-width: 2; }
    .tip rect { fill: var(--ink); }
    .tip-t { fill: var(--paper); font-size: 11px; opacity: .8; }
    .tip-v { fill: var(--paper); font-size: 12.5px; font-weight: 700; }
    .table-view summary { cursor: pointer; font-size: var(--fs-s); color: var(--ink-2); margin-top: 8px; }
    .att { list-style: none; margin: 0; padding: 0; }
    .att li + li { border-top: 1px solid var(--line); }
    .att a { display: flex; flex-direction: column; gap: 3px; padding: 12px 18px; color: inherit; text-decoration: none; }
    .att a:hover { background: var(--surface-2); }
    .err { font-size: var(--fs-xs); color: var(--danger); }
    .irn { color: var(--stamp); font-weight: 600; font-variant-numeric: tabular-nums; }
    @media (max-width: 1000px) { .kpis, .cols { grid-template-columns: 1fr; } }
  `],
})
export class DashboardComponent {
  protected store = inject(StoreService);
  protected fmt = formatPkr;
  protected totals = (i: { items: Parameters<typeof invoiceTotals>[0] }) => invoiceTotals(i.items);
  protected hover = signal(-1);
  protected monthName = new Date().toLocaleString('en-GB', { month: 'long' });

  protected firstName = computed(() => (this.store.user()?.name ?? '').split(' ')[0]);
  protected greeting = computed(() => { const h = new Date().getHours(); return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'; });

  protected counts = computed(() => {
    const c = { draft: 0, validated: 0, queued: 0, posting: 0, posted: 0, failed: 0 };
    this.store.bizInvoices().forEach(i => c[i.status]++);
    return c;
  });

  protected month = computed(() => {
    const ym = new Date().toISOString().slice(0, 7);
    const posted = this.store.bizInvoices().filter(i => i.status === 'posted' && i.invoiceDate.startsWith(ym));
    const t = invoiceTotals(posted.flatMap(i => i.items));
    return { posted: posted.length, salesTax: t.salesTax + t.furtherTax, value: t.value };
  });

  protected attention = computed(() => this.store.bizInvoices().filter(i => i.status === 'failed').slice(0, 5));
  protected recent = computed(() => this.store.bizInvoices().filter(i => i.status === 'posted').slice(0, 6));

  protected bars = computed<MonthBar[]>(() => {
    const now = new Date();
    const out: MonthBar[] = [];
    for (let k = 5; k >= 0; k--) {
      const d = new Date(now.getFullYear(), now.getMonth() - k, 1);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      out.push({ key, label: d.toLocaleString('en-GB', { month: 'short' }), tax: 0, count: 0 });
    }
    this.store.bizInvoices().filter(i => i.status === 'posted').forEach(i => {
      const m = out.find(b => i.invoiceDate.startsWith(b.key));
      if (!m) return;
      const t = invoiceTotals(i.items);
      m.tax += t.salesTax + t.furtherTax; m.count++;
    });
    return out;
  });

  /* chart geometry */
  protected readonly W = 560; protected readonly H = 240; protected readonly padL = 52; protected readonly padT = 12;
  protected readonly plotH = this.H - this.padT - 30;
  protected readonly bw = 44;
  private max = computed(() => {
    const m = Math.max(1, ...this.bars().map(b => b.tax));
    const step = Math.pow(10, Math.floor(Math.log10(m)));
    return Math.ceil(m / step) * step;
  });
  protected ticks = computed(() => [0, 0.25, 0.5, 0.75, 1].map(f => this.max() * f));
  protected y = (v: number) => this.padT + this.plotH - (v / this.max()) * this.plotH;
  protected bx = (i: number) => this.padL + 20 + i * ((this.W - this.padL - 40) / 6);
  protected tipX = (i: number) => Math.min(this.bx(i) - 50, this.W - 150);
  protected barPath(i: number, v: number) {
    const x = this.bx(i), y0 = this.y(0), h = Math.max(0, y0 - this.y(v)), r = Math.min(4, h);
    if (h <= 0) return '';
    return `M${x},${y0}V${y0 - h + r}Q${x},${y0 - h} ${x + r},${y0 - h}H${x + this.bw - r}Q${x + this.bw},${y0 - h} ${x + this.bw},${y0 - h + r}V${y0}Z`;
  }
  protected short = (v: number) => v >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : v >= 1e3 ? Math.round(v / 1e3) + 'k' : String(Math.round(v));
  protected chartLabel = computed(() => 'Sales tax posted by month: ' + this.bars().map(b => `${b.label} Rs ${formatPkr(b.tax)}`).join(', '));
}
