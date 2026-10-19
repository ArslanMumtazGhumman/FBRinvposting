import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { errorMessage } from '../../core/api';
import { FbrGatewayService } from '../../core/fbr-gateway.service';
import { ACTIVITIES, SCENARIOS, SECTORS, applicableScenarios, saleTypeDef } from '../../core/fbr-reference';
import { Invoice, LineItem } from '../../core/models';
import { PostingService, issuesFromResponse } from '../../core/posting.service';
import { Store } from '../../core/store';
import { computeLine, emptyLine, taxContext, toPayload } from '../../core/tax';
import { UiService } from '../../core/ui.service';
import { nowIso, todayIso, uid } from '../../core/util';
import { IconComponent } from '../../shared/icon.component';

interface Result { status: 'pass' | 'fail' | 'running'; irn?: string; error?: string; at?: string; }

const HS_FOR: Record<string, [string, string]> = {
  'Steel Melting and re-rolling': ['7214.2000', 'KG'], 'Ship breaking': ['7204.4100', 'KG'], 'Toll Manufacturing': ['7214.2000', 'KG'],
  'Cotton Ginners': ['5201.0000', 'KG'], 'Telecommunication services': ['9812.1100', 'Numbers, pieces, units'],
  'Petroleum Products': ['2710.1210', 'Liter'], 'Electricity Supply to Retailers': ['2716.0000', 'KWH'], 'Gas to CNG stations': ['2711.2100', 'MMBTU'],
  'Mobile Phones': ['8517.1219', 'Numbers, pieces, units'], 'Electric Vehicle': ['8703.8090', 'Numbers, pieces, units'],
  'Cement /Concrete Block': ['2523.2900', 'KG'], 'Services': ['9815.0000', 'Numbers, pieces, units'], 'Services (FED in ST Mode)': ['9815.0000', 'Numbers, pieces, units'],
  '3rd Schedule Goods': ['3401.1100', 'Numbers, pieces, units'], 'Non-Adjustable Supplies': ['3004.9099', 'Numbers, pieces, units'],
};

@Component({
  selector: 'app-scenarios',
  imports: [FormsModule, RouterLink, IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <div class="page">
    <div class="page-header">
      <div><h1>Sandbox scenarios</h1>
        <p class="lead">FBR switches a business to production only after its applicable test scenarios pass in the sandbox. Run them here with ready-made sample invoices.</p></div>
      <div class="row">
        <button class="btn" (click)="exportReport()" [disabled]="!passed()"><app-icon name="download" /> Certification report</button>
        <button class="btn btn-primary" (click)="runAll()" [disabled]="running() || !canRun()"><app-icon name="play" /> Run all {{ applicable().length }}</button>
      </div>
    </div>

    @if (!canRun()) {
      <div class="banner warn mb">Add your sandbox token in <a routerLink="/settings">Settings</a> and switch to Sandbox mode to run scenarios.</div>
    }

    <section class="panel mb">
      <div class="panel-body cfg">
        <div class="field"><label for="act">Business activity</label><select id="act" class="select" [ngModel]="activity()" (ngModelChange)="setProfile($event, sector())">@for (a of activities; track a) { <option>{{ a }}</option> }</select></div>
        <div class="field"><label for="sec">Sector</label><select id="sec" class="select" [ngModel]="sector()" (ngModelChange)="setProfile(activity(), $event)">@for (s of sectors; track s) { <option>{{ s }}</option> }</select></div>
        <div class="score">
          <b>{{ passed() }} / {{ applicable().length }}</b><span>passed</span>
          <div class="progress"><div [style.width.%]="applicable().length ? passed() / applicable().length * 100 : 0"></div></div>
        </div>
      </div>
    </section>

    <section class="panel">
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>Scenario</th><th>What it tests</th><th>Sale type</th><th>Result</th><th></th></tr></thead>
          <tbody>
            @for (s of rows(); track s.id) {
              @let r = results()[s.id];
              <tr>
                <td><b>{{ s.id }}</b></td><td>{{ s.description }}</td><td class="subtle">{{ s.saleType }}</td>
                <td>
                  @switch (r?.status) {
                    @case ('pass') { <span class="chip posted">Passed</span> <span class="irn">{{ r!.irn }}</span> }
                    @case ('fail') { <span class="chip failed">Failed</span> <div class="err">{{ r!.error }}</div> }
                    @case ('running') { <span class="chip queued">Running</span> }
                    @default { <span class="chip">Not run</span> }
                  }
                </td>
                <td class="num"><button class="btn btn-sm" (click)="run(s.id)" [disabled]="running() || !canRun()">{{ r ? 'Run again' : 'Run' }}</button></td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    </section>
  </div>`,
  styles: [`
    .mb { margin-bottom: 16px; }
    .cfg { display: grid; grid-template-columns: 1fr 1fr 1.2fr; gap: 16px; align-items: end; }
    .score { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px; }
    .score b { font-size: var(--fs-xl); font-weight: 800; }
    .score .progress { flex-basis: 100%; }
    .irn { margin-left: 8px; color: var(--stamp); font-size: var(--fs-xs); font-weight: 600; }
    .err { color: var(--danger); font-size: var(--fs-xs); margin-top: 3px; }
    @media (max-width: 800px) { .cfg { grid-template-columns: 1fr; } }
  `],
})
export class ScenariosComponent {
  private store = inject(Store);
  private fbr = inject(FbrGatewayService);
  private ui = inject(UiService);
  private posting = inject(PostingService);

  protected activities = ACTIVITIES;
  protected sectors = SECTORS;
  protected activity = computed(() => this.store.business()?.activity ?? 'Other');
  protected sector = computed(() => this.store.business()?.sector ?? 'All Other Sectors');
  protected applicable = computed(() => applicableScenarios(this.activity(), this.sector()));
  protected rows = computed(() => SCENARIOS.filter(s => this.applicable().includes(s.id)));
  protected canRun = computed(() => { const b = this.store.business(); return !!b && b.environment === 'sandbox' && b.hasSandboxToken; });
  protected running = signal(false);
  protected results = signal<Record<string, Result>>({});
  protected passed = computed(() => this.applicable().filter(id => this.results()[id]?.status === 'pass').length);

  private key = computed(() => `rasid:v1:scenarios:${this.store.business()?.id}`);
  constructor() {
    effect(() => { try { this.results.set(JSON.parse(localStorage.getItem(this.key()) ?? '{}')); } catch { this.results.set({}); } });
  }
  private persist() { try { localStorage.setItem(this.key(), JSON.stringify(this.results())); } catch { /* ignore */ } }

  setProfile(activity: string, sector: string) {
    const b = this.store.business();
    if (b) this.store.updateBusiness({ ...b, activity, sector }).catch(e => this.ui.toast(errorMessage(e, 'Could not save the profile'), 'error'));
  }

  private sampleInvoice(id: string): Invoice {
    const b = this.store.business()!; const sc = SCENARIOS.find(s => s.id === id)!;
    const def = saleTypeDef(sc.saleType)!;
    const unreg = sc.buyerType === 'Unregistered';
    const buyer = unreg
      ? { ntnCnic: '3520212345671', name: 'Walk-in customer', province: b.province, address: b.address, registrationType: 'Unregistered' as const }
      : { ntnCnic: '4410235', name: 'Sample Registered Buyer', province: 'Sindh', address: 'Karachi', registrationType: 'Registered' as const };
    const [hs, uom] = HS_FOR[sc.saleType] ?? ['1701.9910', 'KG'];
    let line: LineItem = { ...emptyLine(sc.saleType), hsCode: hs, uoM: uom, productDescription: `${sc.description} (test)`, quantity: 10, unitPrice: 100 };
    if (def.usesRetailPrice) line.fixedNotifiedValueOrRetailPrice = 1300;
    line = computeLine(line, buyer, taxContext(b, todayIso()));
    const at = nowIso();
    return { id: uid('i_'), businessId: b.id, localRef: `TEST-${id}-${Date.now()}`, invoiceType: 'Sale Invoice', invoiceDate: todayIso(), buyer, items: [line],
      invoiceRefNo: '', scenarioId: id, environment: 'sandbox', status: 'draft', issues: [], attempts: 0, createdAt: at, updatedAt: at, history: [] };
  }

  async run(id: string) {
    const b = this.store.business()!;
    this.results.update(r => ({ ...r, [id]: { status: 'running' } }));
    const inv = this.sampleInvoice(id);
    try {
      if (this.store.mode === 'api') {
        // Through the server queue, like any other invoice; the test invoice stays in the sandbox list.
        const out = await this.posting.post(await this.store.upsertInvoice(inv));
        this.results.update(r => ({ ...r, [id]: out.ok
          ? { status: 'pass', irn: out.invoice.fbrInvoiceNumber, at: nowIso() }
          : { status: 'fail', error: out.message ?? (out.invoice.issues.map(i => `${i.code} ${i.message}`).join('; ') || 'Not posted'), at: nowIso() } }));
        this.persist();
        return;
      }
      const res = await this.fbr.post({ businessId: b.id, environment: 'sandbox', payload: toPayload(inv, b), idempotencyKey: inv.localRef });
      const issues = issuesFromResponse(res);
      this.results.update(r => ({ ...r, [id]: issues.length || !res.invoiceNumber
        ? { status: 'fail', error: issues.map(i => `${i.code} ${i.message}`).join('; ') || 'No invoice number returned', at: nowIso() }
        : { status: 'pass', irn: res.invoiceNumber, at: nowIso() } }));
    } catch (e) {
      this.results.update(r => ({ ...r, [id]: { status: 'fail', error: (e as Error).message, at: nowIso() } }));
    }
    this.persist();
  }

  async runAll() {
    this.running.set(true);
    for (const id of this.applicable()) await this.run(id);
    this.running.set(false);
    const failed = this.applicable().length - this.passed();
    this.ui.toast(failed ? `${failed} scenario(s) failed. Run them again; FBR's sandbox is sometimes slow.` : 'All scenarios passed. Ask PRAL to enable production.', failed ? 'info' : 'ok');
  }

  exportReport() {
    const b = this.store.business()!;
    const lines = [`Business,${b.name}`, `NTN,${b.ntnCnic}`, `Activity,${this.activity()}`, `Sector,${this.sector()}`, '', 'Scenario,Result,FBR invoice no,Time,Error',
      ...this.applicable().map(id => { const r = this.results()[id]; return [id, r?.status ?? 'not run', r?.irn ?? '', r?.at ?? '', `"${(r?.error ?? '').replace(/"/g, '""')}"`].join(','); })];
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
    a.download = `sandbox-certification-${b.ntnCnic}.csv`; a.click(); URL.revokeObjectURL(a.href);
  }
}
