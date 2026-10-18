import { ChangeDetectionStrategy, Component, HostListener, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { errorMessage } from '../../core/api';
import { FbrGatewayService } from '../../core/fbr-gateway.service';
import { HS_SAMPLE, PROVINCES, SALE_TYPES, SCENARIOS, saleTypeDef } from '../../core/fbr-reference';
import { FieldIssue, Invoice, LineItem } from '../../core/models';
import { PostingService } from '../../core/posting.service';
import { HsOption, ReferenceService, SroOption } from '../../core/reference.service';
import { Store } from '../../core/store';
import { cleanNtn, computeLine, emptyLine, invoiceTotals, validateInvoice } from '../../core/tax';
import { UiService } from '../../core/ui.service';
import { formatPkr, nowIso, todayIso, uid } from '../../core/util';
import { IconComponent } from '../../shared/icon.component';
import { StatusChipComponent } from '../../shared/status-chip.component';

@Component({
  selector: 'app-invoice-editor',
  imports: [FormsModule, RouterLink, IconComponent, StatusChipComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  @if (inv(); as v) {
  <div class="page">
    <div class="page-header">
      <div>
        <a routerLink="/invoices" class="back subtle"><app-icon name="left" [size]="14" /> Invoices</a>
        <div class="row"><h1>{{ isNew ? 'New invoice' : v.localRef }}</h1><app-status-chip [status]="v.status" /></div>
      </div>
      <div class="row">
        <button class="btn" (click)="saveDraft()" [disabled]="busy()">Save draft <span class="kbd">Ctrl S</span></button>
        <button class="btn" (click)="validate()" [disabled]="busy()"><app-icon name="check" /> Validate with FBR</button>
        <button class="btn btn-primary" (click)="post()" [disabled]="busy()"><app-icon name="send" /> {{ busy() === 'post' ? 'Posting…' : 'Post to FBR' }} <span class="kbd on-accent">Ctrl ↵</span></button>
      </div>
    </div>

    <div class="layout">
      <div class="main-col">
        <!-- Buyer -->
        <section class="panel">
          <div class="panel-head"><h2>Buyer</h2>
            <label class="pick">
              <app-icon name="search" [size]="15" />
              <input class="input" list="customers" placeholder="Pick a saved customer" (change)="pickCustomer($any($event.target).value); $any($event.target).value = ''" aria-label="Pick a saved customer" />
              <datalist id="customers">@for (c of store.bizCustomers(); track c.id) { <option [value]="c.name">{{ c.ntnCnic }}</option> }</datalist>
            </label>
          </div>
          <div class="panel-body grid-buyer">
            <div class="field">
              <label for="bname">Buyer name</label>
              <input id="bname" class="input" [class.invalid]="err('name')" [ngModel]="v.buyer.name" (ngModelChange)="setBuyer('name', $event)" />
              @if (err('name'); as e) { <span class="error-text">{{ e.hint || e.message }}</span> }
            </div>
            <div class="field">
              <label for="bntn">NTN or CNIC</label>
              <div class="with-btn">
                <input id="bntn" class="input" inputmode="numeric" placeholder="7-digit NTN or 13-digit CNIC" [class.invalid]="err('ntnCnic')"
                       [ngModel]="v.buyer.ntnCnic" (ngModelChange)="setBuyer('ntnCnic', $event)" />
                <button class="btn" (click)="checkBuyer()" [disabled]="!v.buyer.ntnCnic || checking()" title="Check registration type with FBR">{{ checking() ? 'Checking…' : 'Check' }}</button>
              </div>
              @if (err('ntnCnic'); as e) { <span class="error-text">{{ e.hint || e.message }}</span> }
            </div>
            <div class="field">
              <label>Registration</label>
              <div class="segmented">
                <button type="button" [class.on]="v.buyer.registrationType === 'Registered'" (click)="setBuyer('registrationType', 'Registered')">Registered</button>
                <button type="button" [class.on]="v.buyer.registrationType === 'Unregistered'" (click)="setBuyer('registrationType', 'Unregistered')">Unregistered</button>
              </div>
              @if (v.buyer.registrationType === 'Unregistered') { <span class="hint">Further tax of {{ biz()?.furtherTaxRate }}% is added on taxable lines.</span> }
            </div>
            <div class="field">
              <label for="bprov">Province</label>
              <select id="bprov" class="select" [class.invalid]="err('province')" [ngModel]="v.buyer.province" (ngModelChange)="setBuyer('province', $event)">
                @for (p of provinces; track p) { <option [value]="p">{{ p }}</option> }
              </select>
            </div>
            <div class="field span2">
              <label for="baddr">Address</label>
              <input id="baddr" class="input" [ngModel]="v.buyer.address" (ngModelChange)="setBuyer('address', $event)" />
            </div>
          </div>
        </section>

        <!-- Invoice -->
        <section class="panel">
          <div class="panel-head"><h2>Invoice details</h2></div>
          <div class="panel-body grid-inv">
            <div class="field">
              <label>Type</label>
              <div class="segmented">
                <button type="button" [class.on]="v.invoiceType === 'Sale Invoice'" (click)="set('invoiceType', 'Sale Invoice')">Sale invoice</button>
                <button type="button" [class.on]="v.invoiceType === 'Debit Note'" (click)="set('invoiceType', 'Debit Note')">Debit note</button>
              </div>
            </div>
            <div class="field">
              <label for="date">Date</label>
              <input id="date" class="input" type="date" [class.invalid]="err('invoiceDate')" [ngModel]="v.invoiceDate" (ngModelChange)="set('invoiceDate', $event)" />
            </div>
            <div class="field">
              <label for="ref">Your invoice no.</label>
              <input id="ref" class="input" [ngModel]="v.localRef" (ngModelChange)="set('localRef', $event)" [disabled]="v.status === 'posted'" />
            </div>
            @if (v.invoiceType === 'Debit Note') {
              <div class="field">
                <label for="orig">Original FBR invoice no.</label>
                <input id="orig" class="input" list="posted" [class.invalid]="err('invoiceRefNo')" [ngModel]="v.invoiceRefNo" (ngModelChange)="set('invoiceRefNo', $event)" placeholder="e.g. 1234567DI1747119701593" />
                <datalist id="posted">@for (p of postedRefs(); track p) { <option [value]="p"></option> }</datalist>
              </div>
            }
            @if (biz()?.environment === 'sandbox') {
              <div class="field">
                <label for="scn">Sandbox scenario</label>
                <select id="scn" class="select" [ngModel]="v.scenarioId || autoScenario()" (ngModelChange)="set('scenarioId', $event)">
                  @for (s of scenarios; track s.id) { <option [value]="s.id">{{ s.id }} {{ s.description }}</option> }
                </select>
              </div>
            }
          </div>
        </section>

      </div>

      <!-- Side -->
      <aside class="side-col">
        <section class="panel totals">
          <div class="panel-body">
            <dl>
              <dt>Value excl. sales tax</dt><dd>{{ fmt(totals().value, 2) }}</dd>
              <dt>Sales tax</dt><dd>{{ fmt(totals().salesTax, 2) }}</dd>
              @if (totals().furtherTax) { <dt>Further tax</dt><dd>{{ fmt(totals().furtherTax, 2) }}</dd> }
              @if (totals().other) { <dt>Other (FED, extra, discount)</dt><dd>{{ fmt(totals().other, 2) }}</dd> }
            </dl>
            <div class="grand"><span>Total</span><b>Rs {{ fmt(totals().total, 2) }}</b></div>
          </div>
        </section>

        <section class="panel">
          <div class="panel-head"><h3>Checks</h3><span class="subtle">{{ liveIssues().length ? liveIssues().length + ' to fix' : 'Ready' }}</span></div>
          @if (liveIssues().length) {
            <ul class="issues">
              @for (e of liveIssues(); track $index) {
                <li [class.fbr]="e.source === 'fbr'">
                  <span class="code">{{ e.code }}</span>
                  <div><b>{{ e.itemIndex !== undefined ? 'Line ' + (e.itemIndex + 1) + ': ' : '' }}{{ e.message }}</b>
                  @if (e.hint && e.hint !== e.message) { <p>{{ e.hint }}</p> }</div>
                </li>
              }
            </ul>
          } @else {
            <div class="panel-body ready"><app-icon name="check" /> All local checks pass. Validate with FBR or post.</div>
          }
        </section>
      </aside>
    </div>
        <!-- Lines -->
    <section class="panel items-panel">
          <div class="panel-head"><h2>Items</h2><span class="subtle">Tax is calculated from the rate; edit any amount if your figures differ.</span></div>
          <div class="table-wrap">
            <table class="lines">
              <thead><tr>
                <th>#</th><th class="w-desc">Product</th><th>HS code</th><th>Unit</th><th>Sale type</th><th>Rate</th>
                <th class="num">Qty</th><th class="num">Unit price</th><th class="num">Value excl. ST</th><th class="num">Sales tax</th><th></th>
              </tr></thead>
              <tbody>
                @for (l of v.items; track $index; let i = $index) {
                  <tr [class.has-err]="lineHasErr(i)">
                    <td class="idx">{{ i + 1 }}</td>
                    <td><input class="cell" list="products" [class.invalid]="err('productDescription', i)" [ngModel]="l.productDescription" (ngModelChange)="setLine(i, 'productDescription', $event)" (change)="fillFromProduct(i)" placeholder="Description" [attr.aria-label]="'Line ' + (i+1) + ' product'" /></td>
                    <td><input class="cell hs" list="hs" [class.invalid]="err('hsCode', i)" [title]="errText('hsCode', i)" [ngModel]="l.hsCode" (ngModelChange)="setLine(i, 'hsCode', $event)" placeholder="0000.0000" [attr.aria-label]="'Line ' + (i+1) + ' HS code'" /></td>
                    <td><select class="cell" [class.invalid]="err('uoM', i)" [title]="errText('uoM', i)" [ngModel]="l.uoM" (ngModelChange)="setLine(i, 'uoM', $event)" [attr.aria-label]="'Line ' + (i+1) + ' unit'">@for (u of uomsFor(l.uoM); track u) { <option [value]="u">{{ u }}</option> }</select></td>
                    <td><select class="cell st" [class.invalid]="err('saleType', i)" [ngModel]="l.saleType" (ngModelChange)="setSaleType(i, $event)" [attr.aria-label]="'Line ' + (i+1) + ' sale type'">@for (s of saleTypes; track s.name) { <option [value]="s.name">{{ s.name }}</option> }</select></td>
                    <td><select class="cell rate" [class.invalid]="err('rate', i)" [ngModel]="l.rate" (ngModelChange)="setLine(i, 'rate', $event)" [attr.aria-label]="'Line ' + (i+1) + ' rate'">@for (r of ratesFor(l.saleType, l.rate); track r) { <option [value]="r">{{ r }}</option> }</select></td>
                    <td><input class="cell num" type="number" min="0" step="any" [class.invalid]="err('quantity', i)" [ngModel]="l.quantity" (ngModelChange)="setLine(i, 'quantity', +$event)" [attr.aria-label]="'Line ' + (i+1) + ' quantity'" /></td>
                    <td><input class="cell num" type="number" min="0" step="any" [ngModel]="l.unitPrice" (ngModelChange)="setLine(i, 'unitPrice', +$event)" (keydown.enter)="i === v.items.length - 1 && addLine()" [attr.aria-label]="'Line ' + (i+1) + ' unit price'" /></td>
                    <td class="num ro">{{ fmt(l.valueSalesExcludingST, 2) }}</td>
                    <td><input class="cell num" type="number" step="any" [class.invalid]="err('salesTaxApplicable', i)" [title]="errText('salesTaxApplicable', i)" [ngModel]="l.salesTaxApplicable" (ngModelChange)="overrideTax(i, +$event)" [attr.aria-label]="'Line ' + (i+1) + ' sales tax'" /></td>
                    <td class="actions">
                      <button class="btn btn-ghost btn-icon btn-sm" (click)="toggleMore(i)" [attr.aria-expanded]="more().has(i)" aria-label="More fields"><app-icon name="chevron" [size]="15" /></button>
                      <button class="btn btn-ghost btn-icon btn-sm" (click)="removeLine(i)" [disabled]="v.items.length === 1" aria-label="Remove line"><app-icon name="trash" [size]="15" /></button>
                    </td>
                  </tr>
                  @if (more().has(i) || needsMore(l)) {
                    <tr class="more"><td></td><td colspan="10">
                      <div class="more-grid">
                        <label class="field"><span>Retail price (3rd schedule)</span><input class="input" type="number" step="any" [class.invalid]="err('fixedNotifiedValueOrRetailPrice', i)" [ngModel]="l.fixedNotifiedValueOrRetailPrice" (ngModelChange)="setLine(i, 'fixedNotifiedValueOrRetailPrice', +$event)" /></label>
                        <label class="field"><span>Discount</span><input class="input" type="number" step="any" [ngModel]="l.discount" (ngModelChange)="setLine(i, 'discount', +$event)" /></label>
                        <label class="field"><span>Extra tax</span><input class="input" type="number" step="any" [ngModel]="l.extraTax" (ngModelChange)="setLine(i, 'extraTax', +$event)" /></label>
                        <label class="field"><span>FED payable</span><input class="input" type="number" step="any" [ngModel]="l.fedPayable" (ngModelChange)="setLine(i, 'fedPayable', +$event)" /></label>
                        <label class="field"><span>ST withheld at source</span><input class="input" type="number" step="any" [ngModel]="l.salesTaxWithheldAtSource" (ngModelChange)="setLine(i, 'salesTaxWithheldAtSource', +$event)" /></label>
                        <label class="field"><span>SRO / schedule no.</span><input class="input" [attr.list]="'sro-' + i" (focus)="loadSro(i)" [ngModel]="l.sroScheduleNo" (ngModelChange)="setLine(i, 'sroScheduleNo', $event)" /></label>
                        <datalist [id]="'sro-' + i">@for (o of sro()[i]?.schedules ?? []; track o.id) { <option [value]="o.desc"></option> }</datalist>
                        <label class="field"><span>SRO item serial</span><input class="input" [attr.list]="'sroi-' + i" (focus)="loadSroItems(i)" [ngModel]="l.sroItemSerialNo" (ngModelChange)="setLine(i, 'sroItemSerialNo', $event)" /></label>
                        <datalist [id]="'sroi-' + i">@for (o of sro()[i]?.items ?? []; track o.id) { <option [value]="o.desc"></option> }</datalist>
                        <div class="field"><span>Further tax</span><div class="ro-box">{{ fmt(l.furtherTax, 2) }}</div></div>
                      </div>
                      @if (saleNote(l.saleType); as n) { <p class="subtle">{{ n }}</p> }
                    </td></tr>
                  }
                }
              </tbody>
            </table>
            <datalist id="products">@for (p of store.bizProducts(); track p.id) { <option [value]="p.name">{{ p.hsCode }}</option> }</datalist>
            <datalist id="hs">@for (h of hsOptions(); track h.code) { <option [value]="h.code">{{ h.desc }}</option> }</datalist>
          </div>
          <div class="add-row"><button class="btn btn-ghost" (click)="addLine()"><app-icon name="plus" /> Add line</button><span class="subtle">Press Enter in the last unit price to add a line.</span></div>
        </section>
  </div>
  }`,
  styles: [`
    .back { display: inline-flex; align-items: center; gap: 4px; text-decoration: none; margin-bottom: 6px; }
    .kbd.on-accent { background: transparent; color: inherit; border-color: rgba(255,255,255,.4); }
    .layout { display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: 16px; align-items: start; }
    .main-col { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
    .side-col { position: sticky; top: 16px; display: flex; flex-direction: column; gap: 16px; }
    .grid-buyer { display: grid; grid-template-columns: 1.6fr 1.2fr auto; gap: 14px; }
    .items-panel { margin-top: 16px; }
    .segmented { white-space: nowrap; }
    .grid-inv { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 14px; }
    .span2 { grid-column: span 2; }
    .with-btn { display: flex; gap: 6px; }
    .pick { position: relative; width: 260px; }
    .pick app-icon { position: absolute; left: 10px; top: 11px; color: var(--ink-3); }
    .pick .input { padding-left: 32px; height: 34px; }
    .lines { width: 100%; border-collapse: collapse; font-size: var(--fs-s); }
    .lines th { text-align: left; font-weight: 600; color: var(--ink-2); padding: 8px 6px; border-bottom: 1px solid var(--line); white-space: nowrap; }
    .lines th.num { text-align: right; }
    .lines td { padding: 4px 3px; border-bottom: 1px solid var(--line); }
    .lines tr.has-err td.idx { color: var(--danger); font-weight: 700; }
    .idx { color: var(--ink-3); text-align: center; width: 28px; }
    .w-desc { min-width: 200px; }
    .cell { width: 100%; height: 34px; padding: 0 8px; border: 1px solid transparent; border-radius: 5px; background: transparent; color: var(--ink); font: inherit; }
    .cell:hover { border-color: var(--line); }
    .cell:focus { outline: none; border-color: var(--accent); background: var(--surface); box-shadow: 0 0 0 3px var(--accent-soft); }
    .cell.invalid { border-color: var(--danger); background: var(--danger-soft); }
    .cell.num { text-align: right; min-width: 90px; }
    .cell.hs { min-width: 116px; font-variant-numeric: tabular-nums; }
    .cell.st { min-width: 150px; max-width: 200px; }
    .cell.rate { min-width: 80px; }
    select.cell { appearance: auto; padding: 0 4px; min-width: 120px; }
    .ro { color: var(--ink-2); padding-right: 12px; }
    .actions { white-space: nowrap; }
    .more td { background: var(--surface-2); }
    .more-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; padding: 8px 0; }
    .more-grid .field span { font-size: var(--fs-xs); font-weight: 600; color: var(--ink-2); }
    .ro-box { height: 38px; display: flex; align-items: center; color: var(--ink-2); }
    .add-row { display: flex; align-items: center; gap: 12px; padding: 8px 10px; }
    .totals dl { display: grid; grid-template-columns: 1fr auto; gap: 8px 12px; margin: 0; font-size: var(--fs-s); }
    .totals dt { color: var(--ink-2); }
    .totals dd { margin: 0; text-align: right; font-variant-numeric: tabular-nums; }
    .grand { display: flex; justify-content: space-between; align-items: baseline; border-top: 1px solid var(--line); margin-top: 14px; padding-top: 14px; }
    .grand b { font-size: var(--fs-xl); font-weight: 800; font-variant-numeric: tabular-nums; }
    .issues { list-style: none; margin: 0; padding: 6px 0; max-height: 50vh; overflow: auto; }
    .issues li { display: flex; gap: 10px; padding: 8px 16px; font-size: var(--fs-s); }
    .issues b { font-weight: 600; }
    .issues p { color: var(--ink-2); font-size: var(--fs-xs); margin-top: 2px; }
    .code { flex: none; font-size: 11px; font-weight: 700; color: var(--danger); background: var(--danger-soft); border-radius: 4px; padding: 1px 6px; height: fit-content; }
    .issues li.fbr .code { color: #fff; background: var(--danger); }
    .ready { display: flex; gap: 8px; color: var(--accent); font-size: var(--fs-s); }
    @media (max-width: 1100px) { .layout { grid-template-columns: 1fr; } .side-col { position: static; } }
    @media (max-width: 700px) { .grid-buyer { grid-template-columns: 1fr; } .span2 { grid-column: auto; } .more-grid { grid-template-columns: 1fr 1fr; } }
  `],
})
export class InvoiceEditorComponent {
  protected store = inject(Store);
  private posting = inject(PostingService);
  private fbr = inject(FbrGatewayService);
  private ui = inject(UiService);
  private router = inject(Router);
  private ref = inject(ReferenceService);

  readonly id = input<string>();
  protected isNew = true;
  protected inv = signal<Invoice | null>(null);
  protected busy = signal<false | 'save' | 'validate' | 'post'>(false);
  protected checking = signal(false);
  protected more = signal(new Set<number>());

  protected biz = this.store.business;
  protected provinces = PROVINCES;
  protected saleTypes = SALE_TYPES;
  protected scenarios = SCENARIOS;
  /** Suggestions for the HS code cells: PRAL search results as the user types (bundled sample offline). */
  protected hsOptions = signal<HsOption[]>(HS_SAMPLE.map(h => ({ code: h.code, desc: h.desc })));
  /** SRO schedule and item suggestions per line, loaded when the field gets focus. */
  protected sro = signal<Record<number, { schedules?: SroOption[]; items?: SroOption[] }>>({});
  private hsTimer?: ReturnType<typeof setTimeout>;
  protected fmt = formatPkr;

  protected totals = computed(() => invoiceTotals(this.inv()?.items ?? []));
  /** Local checks re-run as the user types; FBR issues are kept until the next validate/post. */
  protected liveIssues = computed<FieldIssue[]>(() => {
    const v = this.inv(); const b = this.biz();
    if (!v || !b) return [];
    const local = validateInvoice(v, b, hs => this.ref.allowedUoms(hs));
    const fbr = v.issues.filter(i => i.source === 'fbr');
    return [...fbr, ...local.filter(l => !fbr.some(f => f.code === l.code && f.itemIndex === l.itemIndex))];
  });
  protected autoScenario = computed(() => saleTypeDef(this.inv()?.items[0]?.saleType ?? '')?.scenario ?? 'SN001');
  protected postedRefs = computed(() => this.store.bizInvoices().filter(i => i.fbrInvoiceNumber).slice(0, 50).map(i => i.fbrInvoiceNumber!));

  private started = false;
  constructor() {
    // With the API, a reload lands here before the business's invoices arrive: wait for them.
    effect(() => { if (!this.started && this.store.ready()) { this.started = true; untracked(() => this.init()); } });
    // PRAL rates can arrive after a new invoice is set up: move lines still on the bundled default to PRAL's.
    // Runs when the rates arrive, not on every edit, so a rate the user picks is left alone.
    effect(() => {
      if (!this.ref.ratesAsOf()) return;
      untracked(() => this.isNew && this.inv.update(v => {
        if (!v) return v;
        let changed = false;
        const items = v.items.map(l => {
          const live = this.ref.rates(l.saleType);
          if (live.includes(l.rate) || l.rate !== saleTypeDef(l.saleType)?.offlineRates[0]) return l;
          changed = true;
          return computeLine({ ...l, rate: live[0] ?? l.rate }, v.buyer, this.biz()?.furtherTaxRate ?? 0);
        });
        return changed ? { ...v, items } : v;
      }));
    });
  }

  private init() {
    const id = this.id();
    const existing = id ? this.store.invoiceById(id) : undefined;
    if (existing) {
      // Only invoices FBR has not seen can be edited; the rest open read-only.
      if (!['draft', 'validated', 'failed'].includes(existing.status)) { this.router.navigate(['/invoices', existing.id]); return; }
      this.isNew = false;
      this.inv.set(structuredClone(existing));
      this.attempted.set(existing.issues.length > 0);
      return;
    }
    const b = this.biz()!;
    const at = nowIso();
    this.inv.set({
      id: uid('i_'), businessId: b.id, localRef: this.store.nextLocalRef(), invoiceType: 'Sale Invoice', invoiceDate: todayIso(),
      buyer: { ntnCnic: '', name: '', province: b.province, address: '', registrationType: 'Registered' },
      items: [emptyLine(b.defaultSaleType, this.ref.defaultRate(b.defaultSaleType))], invoiceRefNo: '', environment: b.environment, status: 'draft', issues: [],
      attempts: 0, createdAt: at, updatedAt: at, history: [{ at, actor: this.store.user()?.name ?? 'user', action: 'Created' }],
    });
  }

  /* ---------- issue lookup ---------- */
  /** Cells turn red only after the first validate/post attempt (or for FBR rejections), not while typing a fresh form. */
  protected attempted = signal(false);
  protected err(field: string, itemIndex?: number): FieldIssue | undefined {
    return this.liveIssues().find(e => e.field === field && e.itemIndex === itemIndex && (this.attempted() || e.source === 'fbr'));
  }
  protected errText(field: string, i: number) { const e = this.err(field, i); return e ? `${e.code}: ${e.hint ?? e.message}` : ''; }
  protected lineHasErr(i: number) { return this.attempted() && this.liveIssues().some(e => e.itemIndex === i); }

  /* ---------- mutations ---------- */
  private recompute(v: Invoice): Invoice {
    const rate = this.biz()?.furtherTaxRate ?? 0;
    return { ...v, items: v.items.map(l => computeLine(l, v.buyer, rate)) };
  }
  protected set<K extends keyof Invoice>(k: K, val: Invoice[K]) { this.inv.update(v => v && ({ ...v, [k]: val })); }
  protected setBuyer(k: keyof Invoice['buyer'], val: string) {
    this.inv.update(v => {
      if (!v) return v;
      const buyer = { ...v.buyer, [k]: k === 'ntnCnic' ? cleanNtn(val) : val };
      return this.recompute({ ...v, buyer });
    });
  }
  protected setLine(i: number, k: keyof LineItem, val: unknown) {
    this.inv.update(v => {
      if (!v) return v;
      const items = v.items.slice();
      let line = { ...items[i], [k]: val } as LineItem;
      if (k === 'hsCode') {
        const code = String(val);
        const allowed = this.ref.allowedUoms(code);
        const sample = this.store.mode === 'local' ? HS_SAMPLE.find(h => h.code === code) : undefined;
        if (allowed?.length && !allowed.includes(line.uoM)) line.uoM = allowed[0]; else if (sample) line.uoM = sample.uom;
        this.findHs(code);
        void this.applyHsUoms(i, code);
      }
      line = computeLine(line, v.buyer, this.biz()?.furtherTaxRate ?? 0);
      items[i] = line;
      return { ...v, items };
    });
  }
  /** Debounced HS search for the datalist. */
  private findHs(q: string) {
    clearTimeout(this.hsTimer);
    this.hsTimer = setTimeout(async () => {
      const found = await this.ref.searchHs(q);
      if (found.length) this.hsOptions.set(found);
    }, 200);
  }
  /** Once PRAL says which UOMs an HS code takes, switch the line to one of them if needed. */
  private async applyHsUoms(i: number, code: string) {
    const allowed = await this.ref.hsUoms(code);
    if (!allowed?.length) return;
    this.inv.update(v => {
      const l = v?.items[i];
      if (!v || !l || l.hsCode !== code || allowed.includes(l.uoM)) return v;
      const items = v.items.slice();
      items[i] = computeLine({ ...l, uoM: allowed[0] }, v.buyer, this.biz()?.furtherTaxRate ?? 0);
      return { ...v, items };
    });
  }
  protected setSaleType(i: number, saleType: string) {
    this.inv.update(v => {
      if (!v) return v;
      const items = v.items.slice();
      items[i] = computeLine({ ...items[i], saleType, rate: this.ref.defaultRate(saleType) }, v.buyer, this.biz()?.furtherTaxRate ?? 0);
      return { ...v, items };
    });
  }
  /** User typed their own tax figure: keep it (FBR will check it). */
  protected overrideTax(i: number, tax: number) {
    this.inv.update(v => {
      if (!v) return v;
      const items = v.items.slice(); const l = items[i];
      items[i] = { ...l, salesTaxApplicable: tax, totalValues: Math.round((l.valueSalesExcludingST + tax + l.furtherTax + l.extraTax + l.fedPayable - l.discount) * 100) / 100 };
      return { ...v, items };
    });
  }
  protected fillFromProduct(i: number) {
    const v = this.inv(); if (!v) return;
    const p = this.store.bizProducts().find(x => x.name.toLowerCase() === v.items[i].productDescription.trim().toLowerCase());
    if (!p) return;
    this.inv.update(cur => {
      if (!cur) return cur;
      const items = cur.items.slice();
      items[i] = computeLine({ ...items[i], hsCode: p.hsCode, uoM: p.uoM, saleType: p.saleType, rate: p.rate, unitPrice: p.unitPrice }, cur.buyer, this.biz()?.furtherTaxRate ?? 0);
      return { ...cur, items };
    });
  }
  protected addLine() {
    const st = this.inv()?.items.at(-1)?.saleType ?? this.biz()!.defaultSaleType;
    this.inv.update(v => v && ({ ...v, items: [...v.items, emptyLine(st, this.ref.defaultRate(st))] }));
    setTimeout(() => (document.querySelectorAll<HTMLInputElement>('.lines input[list="products"]').item(this.inv()!.items.length - 1))?.focus());
  }
  protected removeLine(i: number) { this.inv.update(v => v && ({ ...v, items: v.items.filter((_, k) => k !== i) })); }
  protected toggleMore(i: number) { this.more.update(s => { const n = new Set(s); n.has(i) ? n.delete(i) : n.add(i); return n; }); }
  protected needsMore(l: LineItem) { return !!saleTypeDef(l.saleType)?.usesRetailPrice; }
  protected saleNote(st: string) { return saleTypeDef(st)?.note; }
  protected ratesFor(st: string, current: string) {
    const r = this.ref.rates(st);
    return current && !r.includes(current) ? [current, ...r] : r;
  }
  protected uomsFor(current: string) {
    const u = this.ref.uoms();
    return current && !u.includes(current) ? [current, ...u] : u;
  }
  protected async loadSro(i: number) {
    const v = this.inv(); const l = v?.items[i];
    if (!v || !l) return;
    const schedules = await this.ref.sroSchedules(l.saleType, l.rate, v.invoiceDate);
    this.sro.update(m => ({ ...m, [i]: { ...m[i], schedules } }));
  }
  protected async loadSroItems(i: number) {
    const v = this.inv(); const l = v?.items[i];
    const sched = this.sro()[i]?.schedules?.find(s => s.desc === l?.sroScheduleNo);
    if (!v || !sched) return;
    const items = await this.ref.sroItems(sched.id, v.invoiceDate);
    this.sro.update(m => ({ ...m, [i]: { ...m[i], items } }));
  }

  protected pickCustomer(name: string) {
    const c = this.store.bizCustomers().find(x => x.name === name);
    if (!c) return;
    this.inv.update(v => v && this.recompute({ ...v, buyer: { ntnCnic: c.ntnCnic, name: c.name, province: c.province, address: c.address, registrationType: c.registrationType } }));
  }

  async checkBuyer() {
    const v = this.inv(); if (!v) return;
    this.checking.set(true);
    try {
      const t = await this.fbr.registrationType(this.biz()!.id, v.buyer.ntnCnic);
      if (t === 'Unknown') this.ui.toast('FBR could not confirm this number. Check the digits.', 'error');
      else { this.setBuyer('registrationType', t); this.ui.toast(`FBR lists this buyer as ${t}`, 'info'); }
    } catch { this.ui.toast('Could not reach FBR to check the buyer.', 'error'); }
    finally { this.checking.set(false); }
  }

  /* ---------- actions ---------- */
  private async persist(): Promise<Invoice> {
    const v = this.inv()!;
    const saved = await this.store.upsertInvoice({ ...v, environment: this.biz()!.environment, scenarioId: v.scenarioId || this.autoScenario() });
    this.isNew = false;
    return saved;
  }

  async saveDraft() {
    if (this.busy()) return;
    this.busy.set('save');
    try {
      await this.persist();
      this.ui.toast('Draft saved');
    } catch (e) { this.ui.toast(errorMessage(e, 'Could not save the draft'), 'error'); }
    finally { this.busy.set(false); }
  }

  async validate() {
    this.attempted.set(true);
    this.busy.set('validate');
    try {
      const r = await this.posting.validate(await this.persist());
      this.inv.set(structuredClone(r));
      this.ui.toast(r.issues.length ? `${r.issues.length} problem(s) to fix` : 'FBR accepted the data. Ready to post.', r.issues.length ? 'error' : 'ok');
    } catch (e) { this.ui.toast((e as Error).message || 'Validation failed', 'error'); }
    finally { this.busy.set(false); }
  }

  async post() {
    this.attempted.set(true);
    if (this.liveIssues().some(i => i.source === 'local')) { this.ui.toast('Fix the highlighted fields before posting.', 'error'); return; }
    this.busy.set('post');
    try {
      const r = await this.posting.post(await this.persist());
      if (r.ok) {
        this.ui.toast(`Posted. FBR invoice no. ${r.invoice.fbrInvoiceNumber}`);
        this.router.navigate(['/invoices', r.invoice.id]);
      } else if (r.reason === 'unknown') {
        this.ui.toast('FBR did not answer in time. Check IRIS for this invoice before posting it again.', 'error', 8000);
        this.router.navigate(['/invoices', r.invoice.id]);
      } else {
        this.inv.set(structuredClone(r.invoice));
        this.ui.toast(r.reason === 'invalid' && !r.message ? 'FBR rejected the invoice. See the highlighted fields.' : r.message ?? r.invoice.issues[0]?.message ?? 'Post failed', 'error');
      }
    } catch (e) { this.ui.toast(errorMessage(e, 'Could not save the invoice'), 'error'); }
    finally { this.busy.set(false); }
  }

  @HostListener('document:keydown', ['$event'])
  onKey(e: KeyboardEvent) {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); this.saveDraft(); }
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); this.post(); }
  }
}
