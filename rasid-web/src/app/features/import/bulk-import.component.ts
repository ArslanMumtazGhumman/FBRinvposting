import { ScrollingModule } from '@angular/cdk/scrolling';
import { ChangeDetectionStrategy, Component, OnDestroy, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { errorMessage } from '../../core/api';
import { FbrGatewayService } from '../../core/fbr-gateway.service';
import { sampleSheet } from '../../core/import/sample-sheet';
import { TARGET_FIELDS, buildInvoices, headerSignature, suggestMapping } from '../../core/import/smart-mapper';
import { FieldIssue, Invoice, LineItem } from '../../core/models';
import { PostingService, issuesFromResponse } from '../../core/posting.service';
import { ReferenceService } from '../../core/reference.service';
import { Store } from '../../core/store';
import { cleanNtn, computeLine, normaliseRate, taxContext, toPayload, validateInvoice } from '../../core/tax';
import { UiService } from '../../core/ui.service';
import { formatPkr, nowIso, uid } from '../../core/util';
import { IconComponent } from '../../shared/icon.component';

type Step = 1 | 2 | 3 | 4;
interface Parsed { name: string; sheets: string[]; sheet: string; headers: string[]; rows: Record<string, unknown>[]; buffer: ArrayBuffer; }
interface GridRow { inv: number; line: number; first: boolean; }

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_ROWS = 50000;

@Component({
  selector: 'app-bulk-import',
  imports: [FormsModule, RouterLink, ScrollingModule, IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <div class="page">
    <div class="page-header">
      <div>
        <h1>Bulk import</h1>
        <p class="lead">Bring invoices from any Excel or CSV layout. Columns are matched for you, each problem is shown on its cell, and valid invoices post to FBR in one run.</p>
      </div>
      @if (step() > 1 && step() < 4) { <button class="btn btn-ghost" (click)="reset()">Start over</button> }
    </div>

    <ol class="steps" aria-label="Import steps">
      @for (s of stepNames; track $index; let i = $index) {
        <li [class.on]="step() === i + 1" [class.done]="step() > i + 1"><span>{{ i + 1 }}</span>{{ s }}</li>
      }
    </ol>

    <!-- STEP 1 -->
    @if (step() === 1) {
      <section class="panel">
        <label class="drop" [class.over]="dragOver()" (dragover)="$event.preventDefault(); dragOver.set(true)" (dragleave)="dragOver.set(false)" (drop)="onDrop($event)">
          <input type="file" accept=".xlsx,.xls,.csv" (change)="onFile($any($event.target).files?.[0])" class="sr-only" />
          <app-icon name="table" [size]="36" />
          <b>{{ parsing() ? 'Reading your file…' : 'Drop an Excel or CSV file here, or click to choose' }}</b>
          <span class="subtle">.xlsx, .xls or .csv up to 10 MB and 50,000 rows. One row per invoice line; rows with the same invoice no. become one invoice.</span>
        </label>
        <div class="panel-body row tpl">
          <span class="muted">No sheet yet? Start from our template with every FBR column.</span>
          <button class="btn btn-sm" (click)="downloadTemplate()"><app-icon name="download" /> Download template</button>
          <button class="btn btn-sm btn-ghost" (click)="loadSample()">Try with sample data</button>
        </div>
      </section>
    }

    <!-- STEP 2 -->
    @if (step() === 2 && file(); as f) {
      <section class="panel">
        <div class="panel-head">
          <div><h2>Match columns</h2><span class="subtle">{{ f.name }}, {{ f.rows.length }} rows</span></div>
          @if (f.sheets.length > 1) {
            <label class="row">Sheet <select class="select sheet" [ngModel]="f.sheet" (ngModelChange)="switchSheet($event)">@for (s of f.sheets; track s) { <option>{{ s }}</option> }</select></label>
          }
        </div>
        @if (templateUsed()) { <div class="banner ok m">Applied your saved layout "{{ templateUsed() }}". Check and continue.</div> }
        <div class="table-wrap">
          <table class="table map">
            <thead><tr><th>FBR field</th><th>Your column</th><th>Match</th><th>Sample values</th></tr></thead>
            <tbody>
              @for (t of visibleFields(); track t.key) {
                <tr [class.req-miss]="t.required && !mapping()[t.key]">
                  <td><b>{{ t.label }}</b>@if (t.required) { <span class="req">required</span> }<div class="subtle">{{ t.level === 'invoice' ? 'Per invoice' : 'Per line' }}</div></td>
                  <td>
                    <select class="select" [ngModel]="mapping()[t.key] ?? ''" (ngModelChange)="setMap(t.key, $event)" [attr.aria-label]="'Column for ' + t.label">
                      <option value="">Not in my sheet</option>
                      @for (h of f.headers; track h) { <option [value]="h">{{ h }}</option> }
                    </select>
                  </td>
                  <td>
                    @if (mapping()[t.key]) {
                      @let c = confidence()[t.key];
                      <span class="conf" [class.hi]="c >= .85" [class.mid]="c >= .65 && c < .85" [class.lo]="c < .65">{{ c >= .85 ? 'Sure' : c >= .65 ? 'Likely' : 'Check' }}</span>
                    } @else if (autoNote(t.key); as n) { <span class="subtle">{{ n }}</span> }
                  </td>
                  <td class="samples">{{ samples(t.key) }}</td>
                </tr>
              }
            </tbody>
          </table>
        </div>
        @if (hiddenCount()) {
          <button class="btn btn-ghost more-fields" (click)="showAllFields.set(true)"><app-icon name="chevron" /> Show {{ hiddenCount() }} more optional fields (further tax, FED, SRO, retail price…)</button>
        }
        <div class="panel-body row foot">
          <label class="row chk"><input type="checkbox" [(ngModel)]="saveTemplate" /> Remember this layout for {{ store.business()?.name }}</label>
          <span class="spacer"></span>
          @if (missingRequired().length) { <span class="bad-text">Match {{ missingRequired().join(', ') }} to continue</span> }
          <button class="btn btn-primary" [disabled]="missingRequired().length" (click)="toReview()">Continue to review <app-icon name="right" /></button>
        </div>
      </section>
    }

    <!-- STEP 3 -->
    @if (step() === 3) {
      <div class="summary">
        <div class="s"><b>{{ invoices().length }}</b><span>invoices</span></div>
        <div class="s"><b>{{ gridRows().length }}</b><span>lines</span></div>
        <div class="s ok"><b>{{ readyCount() }}</b><span>ready to post</span></div>
        <div class="s bad"><b>{{ invoices().length - readyCount() }}</b><span>need fixes</span></div>
        <div class="s"><b>Rs {{ fmt(totalTax()) }}</b><span>sales tax</span></div>
      </div>

      <section class="panel">
        <div class="panel-head">
          <div class="row">
            <div class="segmented">
              <button [class.on]="!onlyProblems()" (click)="onlyProblems.set(false)">All lines</button>
              <button [class.on]="onlyProblems()" (click)="onlyProblems.set(true)">Only problems</button>
            </div>
            <button class="btn btn-sm" (click)="recalcAll()" title="Recompute sales and further tax from each line's rate"><app-icon name="wand" /> Recalculate tax</button>
          </div>
          <div class="row">
            <button class="btn btn-sm" (click)="validateAll()" [disabled]="validating() || refChecking()"><app-icon name="check" /> {{ refChecking() ? 'Checking HS codes and rates…' : validating() ? 'Validating ' + validated() + '/' + readyCount() : 'Validate with FBR' }}</button>
          </div>
        </div>

        <div class="grid-wrap">
          <div class="g-row g-head">
            <span></span><span>Invoice no.</span><span>Date</span><span>Buyer</span><span>NTN/CNIC</span><span>HS code</span><span>Description</span>
            <span class="r">Qty</span><span class="r">Value excl. ST</span><span>Rate</span><span class="r">Sales tax</span>
          </div>
          <cdk-virtual-scroll-viewport itemSize="40" class="vp" [style.height.px]="vpHeight()">
            <div *cdkVirtualFor="let r of shownRows(); trackBy: trackRow" class="g-row" [class.first]="r.first" [class.bad-row]="rowIssues(r).length">
              @let v = invoices()[r.inv];
              @let l = v.items[r.line];
              <span class="st" [title]="rowTitle(r)">
                @if (rowIssues(r).length) { <app-icon name="alert" [size]="15" /> } @else { <app-icon name="check" [size]="15" /> }
              </span>
              <span class="ro">{{ r.first ? v.localRef : '' }}</span>
              <input [class.bad]="bad(r, 'invoiceDate', true)" [title]="tip(r, 'invoiceDate', true)" [value]="v.invoiceDate" (change)="editInv(r.inv, 'invoiceDate', $any($event.target).value)" [disabled]="!r.first" aria-label="Date" />
              <input [class.bad]="bad(r, 'name', true)" [title]="tip(r, 'name', true)" [value]="v.buyer.name" (change)="editBuyer(r.inv, 'name', $any($event.target).value)" [disabled]="!r.first" aria-label="Buyer" />
              <input [class.bad]="bad(r, 'ntnCnic', true)" [title]="tip(r, 'ntnCnic', true)" [value]="v.buyer.ntnCnic" (change)="editBuyer(r.inv, 'ntnCnic', $any($event.target).value)" [disabled]="!r.first" aria-label="NTN or CNIC" />
              <input [class.bad]="bad(r, 'hsCode') || bad(r, 'uoM')" [title]="tip(r, 'hsCode') || tip(r, 'uoM')" [value]="l.hsCode" (change)="editLine(r, 'hsCode', $any($event.target).value)" aria-label="HS code" />
              <input [class.bad]="bad(r, 'productDescription')" [value]="l.productDescription" (change)="editLine(r, 'productDescription', $any($event.target).value)" aria-label="Description" />
              <input class="r" [class.bad]="bad(r, 'quantity')" [value]="l.quantity" (change)="editLine(r, 'quantity', +$any($event.target).value)" aria-label="Quantity" />
              <input class="r" [class.bad]="bad(r, 'valueSalesExcludingST')" [value]="l.valueSalesExcludingST" (change)="editLine(r, 'valueSalesExcludingST', +$any($event.target).value)" aria-label="Value excluding sales tax" />
              <input [class.bad]="bad(r, 'rate')" [title]="tip(r, 'rate')" [value]="l.rate" (change)="editLine(r, 'rate', $any($event.target).value)" aria-label="Rate" />
              <input class="r" [class.bad]="bad(r, 'salesTaxApplicable')" [title]="tip(r, 'salesTaxApplicable')" [value]="l.salesTaxApplicable" (change)="editLine(r, 'salesTaxApplicable', +$any($event.target).value)" aria-label="Sales tax" />
            </div>
          </cdk-virtual-scroll-viewport>
          @if (!shownRows().length) { <div class="empty"><h3>No problems left</h3><p>Every invoice passes the local checks.</p></div> }
        </div>

        <p class="subtle hover-hint">Hover a red cell to see the FBR error code and how to fix it.</p>
        <div class="panel-body row foot">
          <label class="row chk"><input type="checkbox" [(ngModel)]="keepInvalid" /> Also save the {{ invoices().length - readyCount() }} invoices with problems as drafts</label>
          <span class="spacer"></span>
          <button class="btn btn-primary" [disabled]="!readyCount()" (click)="postAll()"><app-icon name="send" /> Post {{ readyCount() }} invoices to FBR</button>
        </div>
      </section>
    }

    <!-- STEP 4 -->
    @if (step() === 4) {
      <section class="panel post-panel">
        <div class="panel-body">
          @let p = posting.progress();
          @if (saving(); as s) {
          <div class="row"><h2>Saving invoices…</h2></div>
          <div class="progress big"><div [style.width.%]="s.total ? (s.done / s.total) * 100 : 0"></div></div>
          <div class="counters"><div><b>{{ s.done }}</b> of {{ s.total }} saved</div></div>
          } @else {
          @if (saveErrors().length) {
            <div class="save-errors">
              <b>{{ saveErrors().length }} invoice(s) could not be saved and were not posted</b>
              <ul>@for (e of saveErrors().slice(0, 20); track $index) { <li>{{ e }}</li> }</ul>
            </div>
          }
          <div class="row">
            <h2>{{ p.running ? 'Posting to FBR…' : 'Import finished' }}</h2>
            <span class="spacer"></span>
            @if (p.running && posting.canPause) {
              @if (p.paused) { <button class="btn" (click)="posting.resume()"><app-icon name="play" /> Resume</button> }
              @else { <button class="btn" (click)="posting.pause()"><app-icon name="pause" /> Pause</button> }
              <button class="btn btn-ghost btn-danger" (click)="posting.cancel()">Stop</button>
            }
          </div>
          <div class="progress big"><div [style.width.%]="posting.percent()"></div></div>
          <div class="counters">
            <div><b>{{ p.done }}</b> of {{ p.total }} processed</div>
            <div class="ok"><b>{{ p.posted }}</b> posted with FBR numbers</div>
            <div class="bad"><b>{{ p.failed }}</b> rejected</div>
            @if (p.retrying) { <div class="subtle">{{ p.retrying }} automatic retries after FBR timeouts</div> }
          </div>
          @if (!p.running) {
            <div class="row actions">
              <button class="btn btn-primary" (click)="downloadResult()"><app-icon name="download" /> Download sheet with FBR numbers</button>
              @if (p.failed) { <a class="btn" routerLink="/invoices" [queryParams]="{ status: 'failed' }">Fix {{ p.failed }} rejected</a> }
              <a class="btn" routerLink="/invoices">View invoices</a>
              <button class="btn btn-ghost" (click)="reset()">Import another file</button>
            </div>
          }
          }
        </div>
      </section>
    }
  </div>`,
  styles: [`
    .steps { display: flex; gap: 8px; list-style: none; padding: 0; margin: 0 0 20px; flex-wrap: wrap; }
    .steps li { display: flex; align-items: center; gap: 8px; padding: 6px 14px 6px 6px; border-radius: 999px; background: var(--surface); border: 1px solid var(--line); color: var(--ink-3); font-size: var(--fs-s); font-weight: 600; }
    .steps li span { width: 24px; height: 24px; border-radius: 50%; display: grid; place-items: center; background: var(--surface-2); font-size: 12px; }
    .steps li.on { color: var(--ink); border-color: var(--accent); }
    .steps li.on span { background: var(--accent); color: var(--accent-ink); }
    .steps li.done { color: var(--accent); }
    .steps li.done span { background: var(--accent-soft); }
    .drop { display: flex; flex-direction: column; align-items: center; gap: 10px; text-align: center; padding: 56px 24px; margin: 18px;
      border: 2px dashed var(--line-strong); border-radius: var(--radius-m); cursor: pointer; color: var(--ink-2); }
    .drop:hover, .drop.over { border-color: var(--accent); background: var(--accent-soft); color: var(--accent); }
    .drop b { color: var(--ink); font-size: var(--fs-l); }
    .tpl { border-top: 1px solid var(--line); }
    .sheet { width: 200px; height: 34px; }
    .m { margin: 12px 18px 0; }
    .map td { vertical-align: top; }
    .map .select { min-width: 200px; height: 34px; }
    .req { margin-left: 6px; font-size: 11px; color: var(--warn); font-weight: 600; }
    .req-miss td { background: var(--warn-soft); }
    .conf { font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 999px; }
    .conf.hi { background: var(--accent-soft); color: var(--accent); }
    .conf.mid { background: var(--info-soft); color: var(--info); }
    .conf.lo { background: var(--warn-soft); color: var(--warn); }
    .samples { color: var(--ink-2); max-width: 280px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .more-fields { margin: 8px 12px; }
    .foot { border-top: 1px solid var(--line); }
    .chk { font-size: var(--fs-s); gap: 8px; }
    .bad-text { color: var(--danger); font-size: var(--fs-s); }
    .summary { display: grid; grid-template-columns: repeat(5, 1fr); gap: 12px; margin-bottom: 16px; }
    .summary .s { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius-m); padding: 12px 16px; display: flex; flex-direction: column; }
    .summary b { font-size: var(--fs-xl); font-weight: 800; font-variant-numeric: tabular-nums; }
    .summary span { color: var(--ink-2); font-size: var(--fs-s); }
    .summary .ok b { color: var(--accent); } .summary .bad b { color: var(--danger); }
    .grid-wrap { overflow-x: auto; }
    .g-row { display: grid; grid-template-columns: 28px 100px 96px minmax(140px, 1.4fr) 118px 100px minmax(140px, 1.4fr) 64px 100px 70px 90px; gap: 2px; align-items: center; height: 40px; padding: 0 10px; min-width: 1080px; font-size: var(--fs-s); border-bottom: 1px solid var(--line); }
    .g-row.first { border-top: 1px solid var(--line-strong); }
    .g-head { font-weight: 600; color: var(--ink-2); background: var(--surface-2); height: 36px; }
    .g-row .r { text-align: right; }
    .vp { min-width: 1080px; }
    .g-row input { width: 100%; height: 30px; border: 1px solid transparent; border-radius: 4px; background: transparent; color: var(--ink); font: inherit; padding: 0 6px; }
    .g-row input:hover:not(:disabled) { border-color: var(--line); }
    .g-row input:focus { outline: none; border-color: var(--accent); background: var(--surface); }
    .g-row input:disabled { color: transparent; }
    .g-row input.bad { border-color: var(--danger); background: var(--danger-soft); color: var(--danger); }
    .st { color: var(--accent); display: grid; place-items: center; }
    .bad-row .st { color: var(--danger); }
    .ro { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .hover-hint { padding: 8px 18px 0; }
    .post-panel .panel-body { display: flex; flex-direction: column; gap: 18px; padding: 28px; }
    .progress.big { height: 12px; }
    .counters { display: flex; gap: 28px; flex-wrap: wrap; font-size: var(--fs-m); }
    .counters .ok b { color: var(--accent); } .counters .bad b { color: var(--danger); }
    .actions { gap: 10px; }
    .save-errors { margin-bottom: 16px; padding: 10px 12px; border-radius: 8px; background: var(--danger-soft); color: var(--danger); font-size: var(--fs-s); }
    .save-errors ul { margin: 6px 0 0; padding-left: 18px; }
    @media (max-width: 900px) { .summary { grid-template-columns: repeat(2, 1fr); } }
  `],
})
export class BulkImportComponent implements OnDestroy {
  protected store = inject(Store);
  protected posting = inject(PostingService);
  private fbr = inject(FbrGatewayService);
  private ui = inject(UiService);
  private ref = inject(ReferenceService);

  protected stepNames = ['Upload', 'Match columns', 'Review and fix', 'Post'];
  protected fields = TARGET_FIELDS;
  protected step = signal<Step>(1);
  protected dragOver = signal(false);
  protected parsing = signal(false);
  protected file = signal<Parsed | null>(null);
  protected mapping = signal<Record<string, string | null>>({});
  protected confidence = signal<Record<string, number>>({});
  protected templateUsed = signal('');
  protected saveTemplate = true;
  protected keepInvalid = true;

  protected invoices = signal<Invoice[]>([]);
  protected fbrIssues = signal<Map<number, FieldIssue[]>>(new Map());
  protected onlyProblems = signal(false);
  protected validating = signal(false);
  protected validated = signal(0);
  protected batchId = '';
  /** Saving to the store before posting (the API store sends chunks of 500). */
  protected saving = signal<{ done: number; total: number } | null>(null);
  protected saveErrors = signal<string[]>([]);
  protected fmt = (n: number) => formatPkr(n);
  private worker?: Worker;

  ngOnDestroy() { this.worker?.terminate(); }

  /* ------------------------------ step 1 ------------------------------ */
  onDrop(e: DragEvent) { e.preventDefault(); this.dragOver.set(false); this.onFile(e.dataTransfer?.files?.[0]); }

  async onFile(f?: File | null) {
    if (!f) return;
    if (!/\.(xlsx|xls|csv)$/i.test(f.name)) { this.ui.toast('Choose an .xlsx, .xls or .csv file.', 'error'); return; }
    if (f.size > MAX_BYTES) { this.ui.toast('File is larger than 10 MB. Split it into smaller files.', 'error'); return; }
    this.parse(f.name, await f.arrayBuffer());
  }

  private parse(name: string, buffer: ArrayBuffer, sheet?: string) {
    this.parsing.set(true);
    this.worker?.terminate();
    this.worker = new Worker(new URL('../../core/import/excel.worker', import.meta.url), { type: 'module' });
    this.worker.onmessage = ({ data }) => {
      this.parsing.set(false);
      if (data.error) { this.ui.toast(`Could not read the file: ${data.error}`, 'error'); return; }
      if (!data.rows.length) { this.ui.toast('That sheet has no data rows.', 'error'); return; }
      if (data.rows.length > MAX_ROWS) { this.ui.toast(`Too many rows (${data.rows.length}). The limit is ${MAX_ROWS}.`, 'error'); return; }
      this.file.set({ name, buffer, ...data });
      this.autoMap();
      this.step.set(2);
    };
    this.worker.onerror = () => { this.parsing.set(false); this.ui.toast('Could not read the file.', 'error'); };
    // Copy so the original buffer stays usable for sheet switching.
    this.worker.postMessage({ buffer: buffer.slice(0), sheet });
  }

  switchSheet(sheet: string) { const f = this.file(); if (f) this.parse(f.name, f.buffer, sheet); }

  /* ------------------------------ step 2 ------------------------------ */
  private autoMap() {
    const f = this.file()!; const biz = this.store.business()!;
    const sig = headerSignature(f.headers);
    const saved = this.store.mappings().find(m => m.businessId === biz.id && m.signature === sig);
    if (saved) {
      this.mapping.set({ ...saved.map });
      this.confidence.set(Object.fromEntries(Object.keys(saved.map).map(k => [k, 1])));
      this.templateUsed.set(saved.name);
      return;
    }
    this.templateUsed.set('');
    const sug = suggestMapping(f.headers, f.rows);
    this.mapping.set(Object.fromEntries(sug.map(s => [s.field, s.header])));
    this.confidence.set(Object.fromEntries(sug.map(s => [s.field, s.confidence])));
  }

  setMap(field: string, header: string) {
    this.mapping.update(m => {
      const next = { ...m };
      // A column can feed only one field.
      Object.keys(next).forEach(k => { if (header && next[k] === header) next[k] = null; });
      next[field] = header || null;
      return next;
    });
    this.confidence.update(c => ({ ...c, [field]: 1 }));
  }

  protected showAllFields = signal(false);
  protected visibleFields = computed(() => {
    const m = this.mapping();
    return this.showAllFields() ? TARGET_FIELDS : TARGET_FIELDS.filter(f => f.required || m[f.key] || ['invoiceNo', 'buyerNTNCNIC', 'valueSalesExcludingST', 'unitPrice', 'rate', 'saleType'].includes(f.key));
  });
  protected hiddenCount = computed(() => TARGET_FIELDS.length - this.visibleFields().length);

  protected missingRequired = computed(() => {
    const m = this.mapping();
    const miss = TARGET_FIELDS.filter(f => f.required && !m[f.key]).map(f => f.label);
    if (!m['valueSalesExcludingST'] && !m['unitPrice']) miss.push('Value or Unit price');
    return miss;
  });

  protected autoNote(key: string): string {
    const m = this.mapping();
    switch (key) {
      case 'invoiceNo': return 'Each row becomes its own invoice';
      case 'buyerProvince': return `Uses ${this.store.business()?.province}`;
      case 'buyerRegistrationType': return 'From NTN length';
      case 'rate': return 'Default rate of sale type';
      case 'salesTaxApplicable': return 'Calculated from rate';
      case 'saleType': return 'Business default';
      case 'uoM': return 'Numbers, pieces, units';
      case 'valueSalesExcludingST': return m['unitPrice'] ? 'Qty × unit price' : '';
      default: return '';
    }
  }

  protected samples(key: string) {
    const h = this.mapping()[key]; const f = this.file();
    if (!h || !f) return '';
    return f.rows.slice(0, 4).map(r => String(r[h] ?? '')).filter(Boolean).join(', ');
  }

  toReview() {
    const f = this.file()!; const biz = this.store.business()!;
    if (this.saveTemplate && !this.templateUsed()) {
      this.store.saveMapping({ id: uid('m_'), businessId: biz.id, name: f.name.replace(/\.[^.]+$/, ''), signature: headerSignature(f.headers), map: this.mapping() as Record<string, string>, createdAt: nowIso() })
        .catch(e => this.ui.toast(errorMessage(e, 'Could not save the column layout'), 'error'));
    }
    this.batchId = uid('bt_');
    const { invoices } = buildInvoices(f.rows, this.mapping(), biz, this.batchId, st => this.ref.defaultRate(st));
    // Avoid clashing with existing invoice numbers (idempotency keys).
    const existing = new Set(this.store.bizInvoices().map(i => i.localRef));
    invoices.forEach(i => { if (existing.has(i.localRef)) i.localRef = `${i.localRef}-R${this.batchId.slice(-3)}`; });
    this.invoices.set(invoices);
    this.fbrIssues.set(new Map());
    this.step.set(3);
    this.refCheck = this.runRefChecks(invoices);
  }

  /**
   * Checks the sheet against Rasid's PRAL cache before anything goes to FBR:
   * HS codes (0052) and their units (0096/0099) in one hs-check call per 100
   * codes, and rates per sale type for each invoice date (0046). localIssues
   * picks the results up as they arrive. Offline there's nothing to check.
   */
  protected refChecking = signal(false);
  private refCheck: Promise<void> = Promise.resolve();
  private async runRefChecks(invoices: Invoice[]) {
    if (this.store.mode !== 'api') return;
    this.refChecking.set(true);
    try {
      const dates = [...new Set(invoices.map(v => v.invoiceDate))].filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d));
      await Promise.all([this.ref.checkHs(invoices.flatMap(v => v.items.map(l => l.hsCode))), ...dates.map(d => this.ref.loadRates(d))]);
    } finally { this.refChecking.set(false); }
  }

  /* ------------------------------ step 3 ------------------------------ */
  protected localIssues = computed(() => {
    const biz = this.store.business()!;
    return this.invoices().map(inv => validateInvoice(inv, biz, this.ref.checks()));
  });
  private issuesFor = (i: number) => [...(this.fbrIssues().get(i) ?? []), ...this.localIssues()[i]];
  protected readyCount = computed(() => this.localIssues().filter((l, i) => !l.length && !(this.fbrIssues().get(i)?.length)).length);
  protected totalTax = computed(() => this.invoices().reduce((s, i) => s + i.items.reduce((t, l) => t + l.salesTaxApplicable + l.furtherTax, 0), 0));

  protected gridRows = computed<GridRow[]>(() => this.invoices().flatMap((v, inv) => v.items.map((_, line) => ({ inv, line, first: line === 0 }))));
  protected shownRows = computed(() => {
    this.localIssues(); this.fbrIssues();
    return this.onlyProblems() ? this.gridRows().filter(r => this.issuesFor(r.inv).length) : this.gridRows();
  });
  protected vpHeight = computed(() => Math.max(80, Math.min(this.shownRows().length * 40, 560)));
  protected trackRow = (_: number, r: GridRow) => `${r.inv}:${r.line}`;

  protected rowIssues(r: GridRow) { return this.issuesFor(r.inv).filter(e => e.itemIndex === undefined || e.itemIndex === r.line); }
  protected rowTitle(r: GridRow) { return this.rowIssues(r).map(e => `${e.code}: ${e.hint ?? e.message}`).join('\n') || 'Ready'; }
  private find(r: GridRow, field: string, header = false) {
    return this.issuesFor(r.inv).find(e => e.field === field && (header ? e.itemIndex === undefined : e.itemIndex === r.line));
  }
  protected bad(r: GridRow, field: string, header = false) { return header && !r.first ? false : !!this.find(r, field, header); }
  protected tip(r: GridRow, field: string, header = false) { const e = this.find(r, field, header); return e ? `${e.code}: ${e.hint ?? e.message}` : ''; }

  private mutate(inv: number, fn: (v: Invoice) => Invoice) {
    this.invoices.update(list => { const c = list.slice(); c[inv] = fn(c[inv]); return c; });
    this.fbrIssues.update(m => { const n = new Map(m); n.delete(inv); return n; });
  }
  editInv(inv: number, k: 'invoiceDate', val: string) {
    this.mutate(inv, v => ({ ...v, [k]: val.trim() }));
    void this.ref.loadRates(val.trim());
  }
  /** Further tax on the invoice's date, PRAL's numeric rates when loaded. */
  private ctx(v: Invoice) { return taxContext(this.store.business()!, v.invoiceDate, this.ref.checks().rateValue); }
  editBuyer(inv: number, k: 'name' | 'ntnCnic', val: string) {
    this.mutate(inv, v => {
      const buyer = { ...v.buyer, [k]: k === 'ntnCnic' ? cleanNtn(val) : val.trim() };
      if (k === 'ntnCnic') buyer.registrationType = buyer.ntnCnic.length === 7 || buyer.ntnCnic.length === 9 ? 'Registered' : 'Unregistered';
      return { ...v, buyer, items: v.items.map(l => computeLine(l, buyer, this.ctx(v))) };
    });
  }
  editLine(r: GridRow, k: keyof LineItem, val: unknown) {
    this.mutate(r.inv, v => {
      const items = v.items.slice();
      let l = { ...items[r.line], [k]: k === 'rate' ? normaliseRate(val) : val } as LineItem;
      if (k === 'valueSalesExcludingST') l.unitPrice = l.quantity ? (val as number) / l.quantity : 0;
      if (k !== 'salesTaxApplicable') l = computeLine(l, v.buyer, this.ctx(v));
      else l.totalValues = Math.round((l.valueSalesExcludingST + l.salesTaxApplicable + l.furtherTax + l.extraTax + l.fedPayable - l.discount) * 100) / 100;
      items[r.line] = l;
      return { ...v, items };
    });
    if (k === 'hsCode') void this.ref.checkHs([String(val)]);
  }
  recalcAll() {
    this.invoices.update(list => list.map(v => ({ ...v, items: v.items.map(l => computeLine(l, v.buyer, this.ctx(v))) })));
    this.fbrIssues.set(new Map());
    this.ui.toast('Sales tax and totals recalculated from rates');
  }

  async validateAll() {
    await this.refCheck; // the cache checks come first, so FBR only sees invoices that pass them
    const biz = this.store.business()!;
    const targets = this.invoices().map((v, i) => ({ v, i })).filter(({ i }) => !this.localIssues()[i].length);
    this.validating.set(true); this.validated.set(0);
    const queue = [...targets];
    const work = async () => {
      while (queue.length) {
        const t = queue.shift()!;
        try {
          const res = await this.fbr.validate({ businessId: biz.id, environment: biz.environment, payload: toPayload(t.v, biz), idempotencyKey: t.v.localRef });
          const iss = issuesFromResponse(res);
          if (iss.length) this.fbrIssues.update(m => new Map(m).set(t.i, iss));
        } catch { /* transient: leave as-is, post will retry */ }
        this.validated.update(n => n + 1);
      }
    };
    await Promise.all([work(), work(), work(), work()]);
    this.validating.set(false);
    const bad = this.fbrIssues().size;
    this.ui.toast(bad ? `FBR flagged ${bad} invoice(s). Filter by problems to fix them.` : 'FBR accepted every invoice. Ready to post.', bad ? 'info' : 'ok');
  }

  /* ------------------------------ step 4 ------------------------------ */
  async postAll() {
    const ready: Invoice[] = []; const rest: Invoice[] = [];
    this.invoices().forEach((v, i) => (this.issuesFor(i).length ? rest : ready).push(v));
    const toSave = this.keepInvalid ? [...ready, ...rest.map((v, k) => ({ ...v, issues: this.issuesFor(this.invoices().indexOf(rest[k])) }))] : ready;
    this.step.set(4);
    this.saveErrors.set([]);
    this.saving.set({ done: 0, total: toSave.length });
    let saved: Set<string>;
    try {
      const r = await this.store.upsertMany(toSave, (done, total) => this.saving.set({ done, total }));
      saved = new Set(r.saved.map(v => v.id));
      this.saveErrors.set(r.errors.map(e => `${e.localRef ?? `Invoice ${e.index + 1}`}: ${e.message}`));
    } finally { this.saving.set(null); }
    const toPost = ready.filter(v => saved.has(v.id)).map(v => v.id);
    try {
      await this.posting.postBatch(toPost);
      const p = this.posting.progress();
      this.ui.toast(`${p.posted} invoices posted to FBR`, p.failed || this.saveErrors().length ? 'info' : 'ok');
    } catch (e) { this.ui.toast(errorMessage(e, 'Could not start posting'), 'error'); }
  }

  async downloadResult() {
    const XLSX = await import('xlsx');
    const f = this.file()!;
    const { rowToInvoice } = buildInvoices(f.rows, this.mapping(), this.store.business()!, this.batchId, st => this.ref.defaultRate(st));
    const ids = this.invoices().map(v => v.id);
    const out = f.rows.map((r, i) => {
      const inv = this.store.invoiceById(ids[rowToInvoice[i]]);
      return {
        ...r,
        'Rasid invoice no': inv?.localRef ?? '',
        'FBR status': inv?.status === 'posted' ? 'Posted' : inv?.status === 'failed' ? 'Rejected' : inv ? 'Not posted' : 'Skipped',
        'FBR invoice no': inv?.fbrInvoiceNumber ?? '',
        'FBR error': inv?.issues.map(e => `${e.code} ${e.message}`).join('; ') ?? '',
      };
    });
    const ws = XLSX.utils.json_to_sheet(out);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'FBR results');
    XLSX.writeFile(wb, f.name.replace(/\.[^.]+$/, '') + '-fbr-results.xlsx');
  }

  /* ------------------------------ helpers ------------------------------ */
  reset() {
    this.showAllFields.set(false);
    this.step.set(1); this.file.set(null); this.invoices.set([]); this.fbrIssues.set(new Map());
    this.mapping.set({}); this.templateUsed.set(''); this.saveErrors.set([]);
  }

  async downloadTemplate() {
    const XLSX = await import('xlsx');
    const ws = XLSX.utils.aoa_to_sheet([
      ['Invoice No', 'Invoice Date', 'Invoice Type', 'Buyer Name', 'Buyer NTN/CNIC', 'Buyer Province', 'Buyer Address', 'Registration Type',
        'HS Code', 'Description', 'UOM', 'Quantity', 'Unit Price', 'Value Excl ST', 'Tax Rate', 'Sales Tax', 'Sale Type', 'Retail Price', 'Discount', 'FED', 'Extra Tax', 'SRO Schedule No', 'SRO Item Serial'],
      ['INV-001', '2026-10-17', 'Sale Invoice', 'Metro Cash & Carry Pakistan', '4410235', 'Punjab', 'Thokar Niaz Baig, Lahore', 'Registered',
        '1701.9910', 'Refined sugar', 'KG', 500, 155, 77500, '18%', 13950, 'Goods at standard rate (default)', '', '', '', '', '', ''],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Invoices');
    XLSX.writeFile(wb, 'rasid-fbr-import-template.xlsx');
  }

  /** Messy, realistic sheet: different headers, DD/MM/YYYY dates, a few deliberate errors (see sample-sheet.ts). */
  async loadSample() {
    const XLSX = await import('xlsx');
    const rows = sampleSheet();
    const ws = XLSX.utils.aoa_to_sheet(rows);
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'October sales');
    const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
    this.parse('october-sales-sample.xlsx', buf);
  }
}
