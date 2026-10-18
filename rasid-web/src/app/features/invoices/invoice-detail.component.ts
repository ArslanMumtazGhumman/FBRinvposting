import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import QRCode from 'qrcode';
import { Invoice } from '../../core/models';
import { StoreService } from '../../core/store.service';
import { invoiceTotals, toPayload } from '../../core/tax';
import { UiService } from '../../core/ui.service';
import { formatPkr, nowIso, todayIso, uid } from '../../core/util';
import { IconComponent } from '../../shared/icon.component';
import { StatusChipComponent } from '../../shared/status-chip.component';

@Component({
  selector: 'app-invoice-detail',
  imports: [RouterLink, IconComponent, StatusChipComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  @if (inv(); as v) {
  <div class="page">
    <div class="page-header no-print">
      <div>
        <a routerLink="/invoices" class="back subtle"><app-icon name="left" [size]="14" /> Invoices</a>
        <div class="row"><h1>{{ v.localRef }}</h1><app-status-chip [status]="v.status" /></div>
      </div>
      <div class="row">
        <button class="btn" (click)="downloadJson()"><app-icon name="download" /> FBR payload</button>
        @if (v.status === 'posted') {
          <button class="btn" (click)="debitNote()">Create debit note</button>
        } @else {
          <a class="btn" [routerLink]="['/invoices', v.id, 'edit']">Edit</a>
        }
        <button class="btn" (click)="duplicate()"><app-icon name="copy" /> Duplicate</button>
        <button class="btn btn-primary" (click)="print()"><app-icon name="printer" /> Print</button>
      </div>
    </div>

    <div class="layout">
      <article class="paper" aria-label="Invoice preview">
        <header class="p-head">
          <div>
            <h2 class="seller">{{ biz()?.name }}</h2>
            <p>{{ biz()?.address }}, {{ biz()?.province }}</p>
            <p>NTN/CNIC {{ biz()?.ntnCnic }}</p>
          </div>
          <div class="doc">
            <h1>{{ v.invoiceType === 'Debit Note' ? 'Debit note' : 'Sales tax invoice' }}</h1>
            <table class="meta">
              <tr><th>Invoice no.</th><td>{{ v.localRef }}</td></tr>
              <tr><th>Date</th><td>{{ v.invoiceDate }}</td></tr>
              @if (v.invoiceRefNo) { <tr><th>Against FBR no.</th><td>{{ v.invoiceRefNo }}</td></tr> }
            </table>
          </div>
        </header>

        <section class="bill">
          <h3>Bill to</h3>
          <p><b>{{ v.buyer.name }}</b></p>
          <p>{{ v.buyer.address }}, {{ v.buyer.province }}</p>
          <p>{{ v.buyer.registrationType }}{{ v.buyer.ntnCnic ? ', NTN/CNIC ' + v.buyer.ntnCnic : '' }}</p>
        </section>

        <table class="items">
          <thead><tr><th>#</th><th>Description</th><th>HS code</th><th class="num">Qty</th><th>Unit</th><th class="num">Value excl. ST</th><th class="num">Rate</th><th class="num">Sales tax</th><th class="num">Total</th></tr></thead>
          <tbody>
            @for (l of v.items; track $index; let i = $index) {
              <tr><td>{{ i + 1 }}</td><td>{{ l.productDescription }}</td><td>{{ l.hsCode }}</td><td class="num">{{ l.quantity }}</td><td>{{ l.uoM }}</td>
                <td class="num">{{ fmt(l.valueSalesExcludingST, 2) }}</td><td class="num">{{ l.rate }}</td><td class="num">{{ fmt(l.salesTaxApplicable + l.furtherTax, 2) }}</td><td class="num">{{ fmt(l.totalValues, 2) }}</td></tr>
            }
          </tbody>
        </table>

        <footer class="p-foot">
          <div class="fbr-block">
            @if (v.status === 'posted') {
              <div class="logo-slot" title="Replace with the official FBR Digital Invoicing System logo supplied by PRAL">FBR Digital Invoicing System logo</div>
              @if (qr()) { <img [src]="qr()" alt="FBR verification QR code" class="qr" /> }
              <div class="stamp">
                <span class="stamp-label">FBR invoice no.</span>
                <span class="stamp-no">{{ v.fbrInvoiceNumber }}</span>
                <span class="stamp-date">Reported {{ v.fbrDated }}</span>
              </div>
            } @else {
              <div class="not-posted">Not yet reported to FBR. This document is not a valid tax invoice until it is posted.</div>
            }
          </div>
          <dl class="sum">
            <dt>Value excl. sales tax</dt><dd>{{ fmt(totals().value, 2) }}</dd>
            <dt>Sales tax</dt><dd>{{ fmt(totals().salesTax, 2) }}</dd>
            @if (totals().furtherTax) { <dt>Further tax</dt><dd>{{ fmt(totals().furtherTax, 2) }}</dd> }
            @if (totals().other) { <dt>FED, extra tax, discount</dt><dd>{{ fmt(totals().other, 2) }}</dd> }
            <dt class="g">Total (PKR)</dt><dd class="g">{{ fmt(totals().total, 2) }}</dd>
          </dl>
        </footer>
      </article>

      <aside class="no-print side">
        @if (v.environment === 'sandbox') { <div class="banner warn">Posted to the FBR sandbox: for testing only, not a legal invoice.</div> }
        <section class="panel">
          <div class="panel-head"><h3>FBR response</h3></div>
          <div class="panel-body small">
            @if (v.fbrInvoiceNumber) {
              <p>Accepted {{ v.fbrDated }} after {{ v.attempts }} attempt(s).</p>
              @for (n of v.fbrItemNumbers ?? []; track $index) { <p class="subtle">Line {{ $index + 1 }}: {{ n }}</p> }
            } @else if (v.issues.length) {
              @for (e of v.issues; track $index) { <p class="err"><b>{{ e.code }}</b> {{ e.message }}</p> }
            } @else { <p class="subtle">Not posted yet.</p> }
          </div>
        </section>
        <section class="panel">
          <div class="panel-head"><h3>History</h3></div>
          <ol class="hist">
            @for (h of history(); track $index) {
              <li><b>{{ h.action }}</b><span class="subtle">{{ h.actor }}, {{ when(h.at) }}</span>@if (h.detail) { <span class="subtle d">{{ h.detail }}</span> }</li>
            }
          </ol>
        </section>
      </aside>
    </div>
  </div>
  } @else {
    <div class="page"><div class="empty"><h3>Invoice not found</h3><a class="btn" routerLink="/invoices">Back to invoices</a></div></div>
  }`,
  styles: [`
    .back { display: inline-flex; align-items: center; gap: 4px; text-decoration: none; margin-bottom: 6px; }
    .layout { display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: 20px; align-items: start; }
    .paper { background: #fff; color: #14211c; border: 1px solid var(--line); border-radius: var(--radius-m); padding: 40px 44px; font-size: 13px; }
    .p-head { display: flex; justify-content: space-between; gap: 24px; padding-bottom: 20px; border-bottom: 2px solid #14211c; }
    .seller { font-size: 18px; font-weight: 800; margin-bottom: 4px; }
    .p-head p, .bill p { color: #4a5a53; }
    .doc { text-align: right; }
    .doc h1 { font-size: 20px; margin-bottom: 8px; }
    .meta th { text-align: right; font-weight: 600; color: #4a5a53; padding: 1px 10px 1px 0; }
    .meta td { text-align: right; font-weight: 600; }
    .bill { padding: 18px 0; }
    .bill h3 { font-size: 12px; color: #4a5a53; margin-bottom: 4px; }
    .items { width: 100%; border-collapse: collapse; }
    .items th { text-align: left; border-bottom: 1px solid #c4cec8; padding: 6px; font-size: 12px; color: #4a5a53; }
    .items td { padding: 7px 6px; border-bottom: 1px solid #eef2ef; }
    .items .num { text-align: right; }
    .p-foot { display: flex; justify-content: space-between; align-items: flex-end; gap: 24px; margin-top: 24px; }
    .fbr-block { display: flex; align-items: center; gap: 18px; flex-wrap: wrap; }
    .qr { width: 1in; height: 1in; image-rendering: pixelated; }
    .logo-slot { width: 1in; height: 1in; border: 1px dashed #7b8a83; color: #7b8a83; font-size: 9px; display: grid; place-items: center; text-align: center; padding: 4px; }
    .stamp { --stamp: #2b4fa8; }
    .not-posted { max-width: 280px; font-size: 12px; color: #9a6408; background: #fbf1dc; padding: 10px 12px; border-radius: 6px; }
    .sum { display: grid; grid-template-columns: auto auto; gap: 4px 20px; margin: 0; min-width: 240px; }
    .sum dt { color: #4a5a53; } .sum dd { margin: 0; text-align: right; font-variant-numeric: tabular-nums; }
    .sum .g { font-weight: 800; font-size: 15px; color: #14211c; border-top: 2px solid #14211c; padding-top: 6px; }
    .side { display: flex; flex-direction: column; gap: 16px; position: sticky; top: 16px; }
    .small { font-size: var(--fs-s); display: flex; flex-direction: column; gap: 4px; }
    .err { color: var(--danger); }
    .hist { list-style: none; margin: 0; padding: 10px 18px; display: flex; flex-direction: column; gap: 12px; font-size: var(--fs-s); }
    .hist li { display: flex; flex-direction: column; border-left: 2px solid var(--line); padding-left: 10px; }
    .hist .d { word-break: break-all; }
    @media (max-width: 1000px) { .layout { grid-template-columns: 1fr; } .paper { padding: 24px 18px; } .p-head, .p-foot { flex-direction: column; align-items: flex-start; } .doc { text-align: left; } }
    @media print {
      .page { padding: 0; max-width: none; }
      .layout { display: block; }
      .paper { border: 0; padding: 0; }
    }
  `],
})
export class InvoiceDetailComponent {
  private store = inject(StoreService);
  private ui = inject(UiService);
  private router = inject(Router);
  readonly id = input.required<string>();

  protected biz = this.store.business;
  protected inv = computed(() => this.store.invoiceById(this.id()));
  protected totals = computed(() => invoiceTotals(this.inv()?.items ?? []));
  protected history = computed(() => [...(this.inv()?.history ?? [])].reverse());
  protected qr = signal<string>('');
  protected fmt = formatPkr;
  protected when = (iso: string) => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

  constructor() {
    effect(() => {
      const irn = this.inv()?.fbrInvoiceNumber;
      if (!irn) { this.qr.set(''); return; }
      // PRAL spec: QR version 2 (25×25), printed at 1 × 1 inch. Fall back to L correction for 28-char CNIC-based numbers.
      const make = (level: 'M' | 'L') => QRCode.toDataURL(irn, { version: 2, errorCorrectionLevel: level, margin: 1, width: 300 });
      make('M').catch(() => make('L')).then(url => this.qr.set(url)).catch(() => this.qr.set(''));
    });
  }

  print() { window.print(); }

  downloadJson() {
    const v = this.inv(); const b = this.biz(); if (!v || !b) return;
    const blob = new Blob([JSON.stringify(toPayload(v, b), null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `${v.localRef}.json`; a.click(); URL.revokeObjectURL(a.href);
  }

  private clone(v: Invoice, patch: Partial<Invoice>) {
    const at = nowIso();
    const copy: Invoice = {
      ...structuredClone(v), id: uid('i_'), localRef: this.store.nextLocalRef(), invoiceDate: todayIso(), status: 'draft',
      issues: [], fbrInvoiceNumber: undefined, fbrItemNumbers: undefined, fbrDated: undefined, attempts: 0, batchId: undefined,
      environment: this.biz()!.environment, createdAt: at, updatedAt: at,
      history: [{ at, actor: this.store.user()?.name ?? 'user', action: 'Created', detail: `From ${v.localRef}` }], ...patch,
    };
    this.store.upsertInvoice(copy);
    this.router.navigate(['/invoices', copy.id, 'edit']);
  }
  duplicate() { const v = this.inv(); if (v) { this.clone(v, { invoiceType: 'Sale Invoice', invoiceRefNo: '' }); this.ui.toast('Copy created as a draft'); } }
  debitNote() { const v = this.inv(); if (v) { this.clone(v, { invoiceType: 'Debit Note', invoiceRefNo: v.fbrInvoiceNumber ?? '' }); this.ui.toast('Debit note started against this invoice'); } }
}
