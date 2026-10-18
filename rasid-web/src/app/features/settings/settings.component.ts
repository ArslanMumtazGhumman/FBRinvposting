import { HttpClient } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../../environments/environment';
import { ACTIVITIES, PROVINCES, SALE_TYPES, SECTORS } from '../../core/fbr-reference';
import { Business, FbrEnvironment } from '../../core/models';
import { StoreService } from '../../core/store.service';
import { cleanNtn } from '../../core/tax';
import { UiService } from '../../core/ui.service';
import { sleep, uid } from '../../core/util';
import { IconComponent } from '../../shared/icon.component';

type Tab = 'business' | 'fbr' | 'defaults' | 'team' | 'add';

@Component({
  selector: 'app-settings',
  imports: [FormsModule, IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <div class="page">
    <div class="page-header"><div><h1>Settings</h1><p class="lead">{{ store.business()?.name }}</p></div></div>

    <div class="layout">
      <nav class="tabs" aria-label="Settings sections">
        @for (t of tabs; track t.key) {
          <button [class.on]="tab() === t.key" (click)="tab.set(t.key)"><app-icon [name]="t.icon" [size]="16" /> {{ t.label }}</button>
        }
      </nav>

      <div class="content">
        @if (draft(); as d) {
        @switch (tab()) {
          @case ('business') {
            <section class="panel">
              <div class="panel-head"><h2>Business profile</h2></div>
              <div class="panel-body grid">
                <div class="field span2"><label for="bn">Registered name</label><input id="bn" class="input" [(ngModel)]="d.name" /></div>
                <div class="field"><label for="bntn">NTN or CNIC</label><input id="bntn" class="input" [(ngModel)]="d.ntnCnic" /><span class="hint">Must match the NTN your FBR token was issued for.</span></div>
                <div class="field"><label for="bp">Province</label><select id="bp" class="select" [(ngModel)]="d.province">@for (p of provinces; track p) { <option>{{ p }}</option> }</select></div>
                <div class="field span2"><label for="ba">Address</label><input id="ba" class="input" [(ngModel)]="d.address" /></div>
                <div class="field"><label for="bact">Business activity</label><select id="bact" class="select" [(ngModel)]="d.activity">@for (a of activities; track a) { <option>{{ a }}</option> }</select></div>
                <div class="field"><label for="bsec">Sector</label><select id="bsec" class="select" [(ngModel)]="d.sector">@for (s of sectors; track s) { <option>{{ s }}</option> }</select></div>
              </div>
              <div class="panel-body end"><button class="btn btn-primary" (click)="saveBiz(d)">Save profile</button></div>
            </section>
          }
          @case ('fbr') {
            <section class="panel">
              <div class="panel-head"><h2>FBR connection</h2></div>
              <div class="panel-body stack">
                <div class="field">
                  <label>Where invoices go</label>
                  <div class="segmented">
                    <button [class.on]="d.environment === 'sandbox'" (click)="setEnv('sandbox')">Sandbox (testing)</button>
                    <button [class.on]="d.environment === 'production'" (click)="setEnv('production')" [disabled]="!d.hasProductionToken">Production (live)</button>
                  </div>
                  <span class="hint">Production unlocks after you save a production token. Invoices posted in production are legal tax invoices.</span>
                </div>

                <ol class="howto">
                  <li>Sign in to <b>iris.fbr.gov.pk</b> with the business's credentials.</li>
                  <li>Open Digital Invoicing, then Integration Mode, and choose PRAL as your licensed integrator.</li>
                  <li>Copy the sandbox token now; the production token appears once your scenarios pass.</li>
                </ol>

                @for (env of envs; track env) {
                  <div class="token">
                    <div class="row">
                      <app-icon name="key" />
                      <b>{{ env === 'sandbox' ? 'Sandbox token' : 'Production token' }}</b>
                      @if (env === 'sandbox' ? d.hasSandboxToken : d.hasProductionToken) {
                        <span class="chip posted">Saved {{ env === 'sandbox' ? d.tokenHintSandbox : d.tokenHintProduction }}</span>
                      } @else { <span class="chip">Not set</span> }
                    </div>
                    <div class="row">
                      <input class="input" type="password" autocomplete="off" spellcheck="false" placeholder="Paste the bearer token"
                             [ngModel]="tokenInput()[env]" (ngModelChange)="setTokenInput(env, $event)" [attr.aria-label]="env + ' token'" />
                      <button class="btn btn-primary" (click)="saveToken(env)" [disabled]="!tokenInput()[env] || savingToken()">Save</button>
                      @if (env === 'sandbox' ? d.hasSandboxToken : d.hasProductionToken) {
                        <button class="btn" (click)="testToken(env)" [disabled]="testing()">{{ testing() ? 'Testing…' : 'Test connection' }}</button>
                      }
                    </div>
                  </div>
                }
                <div class="banner info"><app-icon name="shield" /><span>Tokens are encrypted with AES-256-GCM on our servers and are never shown again or sent to your browser. Only the posting service decrypts them, for each call to FBR.</span></div>
              </div>
            </section>
          }
          @case ('defaults') {
            <section class="panel">
              <div class="panel-head"><h2>Invoice defaults</h2></div>
              <div class="panel-body grid">
                <div class="field span2"><label for="dst">Default sale type</label><select id="dst" class="select" [(ngModel)]="d.defaultSaleType">@for (s of saleTypes; track s.name) { <option [value]="s.name">{{ s.name }}</option> }</select></div>
                <div class="field"><label for="dft">Further tax for unregistered buyers (%)</label><input id="dft" class="input" type="number" step="0.5" min="0" [(ngModel)]="d.furtherTaxRate" /><span class="hint">Confirm the current rate with your tax adviser.</span></div>
                <div class="field"><label for="dpre">Invoice number prefix</label><input id="dpre" class="input" [(ngModel)]="d.invoicePrefix" /></div>
                <div class="field"><label for="dnext">Next invoice number</label><input id="dnext" class="input" type="number" min="1" [(ngModel)]="d.nextInvoiceNo" /></div>
              </div>
              <div class="panel-body end"><button class="btn btn-primary" (click)="saveBiz(d)">Save defaults</button></div>
            </section>
            <section class="panel mt">
              <div class="panel-head"><h2>Saved import layouts</h2></div>
              <div class="table-wrap">
                <table class="table">
                  <thead><tr><th>Name</th><th>Columns</th><th>Saved</th><th></th></tr></thead>
                  <tbody>
                    @for (m of layouts(); track m.id) {
                      <tr><td><b>{{ m.name }}</b></td><td class="subtle">{{ mappedCount(m.map) }} matched</td><td>{{ m.createdAt.slice(0, 10) }}</td>
                        <td class="num"><button class="btn btn-sm btn-ghost btn-danger" (click)="deleteLayout(m.id)">Forget</button></td></tr>
                    } @empty { <tr><td colspan="4" class="subtle">Layouts are saved when you import a sheet with "Remember this layout" ticked.</td></tr> }
                  </tbody>
                </table>
              </div>
            </section>
          }
          @case ('team') {
            <section class="panel">
              <div class="panel-head"><h2>Team and security</h2><button class="btn btn-sm" (click)="invite()"><app-icon name="plus" /> Invite</button></div>
              <div class="table-wrap">
                <table class="table">
                  <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Two-factor</th></tr></thead>
                  <tbody>
                    <tr><td><b>{{ store.user()?.name }}</b> (you)</td><td>{{ store.user()?.email }}</td><td>Owner</td><td><span class="chip posted">On</span></td></tr>
                  </tbody>
                </table>
              </div>
              <div class="panel-body roles">
                <p><b>Owner</b> manages tokens, billing and users. <b>Accountant</b> creates, imports and posts invoices. <b>Viewer</b> sees invoices and reports only.</p>
                <p class="subtle">Owners must use an authenticator app. Sessions end after 12 hours or 30 minutes idle.</p>
              </div>
            </section>
            <section class="panel mt">
              <div class="panel-head"><h2>Demo data</h2></div>
              <div class="panel-body row"><span class="muted">Clears everything stored in this browser and reloads the sample business.</span><span class="spacer"></span><button class="btn btn-danger" (click)="store.resetDemo()">Reset demo data</button></div>
            </section>
          }
          @case ('add') {
            <section class="panel">
              <div class="panel-head"><h2>Add a business</h2></div>
              <div class="panel-body grid">
                <div class="field span2"><label for="nn">Registered name</label><input id="nn" class="input" [(ngModel)]="newBiz.name" /></div>
                <div class="field"><label for="nntn">NTN or CNIC</label><input id="nntn" class="input" [(ngModel)]="newBiz.ntnCnic" /></div>
                <div class="field"><label for="np">Province</label><select id="np" class="select" [(ngModel)]="newBiz.province">@for (p of provinces; track p) { <option>{{ p }}</option> }</select></div>
                <div class="field span2"><label for="na">Address</label><input id="na" class="input" [(ngModel)]="newBiz.address" /></div>
                <div class="field"><label for="nact">Business activity</label><select id="nact" class="select" [(ngModel)]="newBiz.activity">@for (a of activities; track a) { <option>{{ a }}</option> }</select></div>
                <div class="field"><label for="nsec">Sector</label><select id="nsec" class="select" [(ngModel)]="newBiz.sector">@for (s of sectors; track s) { <option>{{ s }}</option> }</select></div>
              </div>
              <div class="panel-body end"><button class="btn btn-primary" (click)="addBiz()" [disabled]="!newBiz.name || !newBiz.ntnCnic">Add business</button></div>
            </section>
          }
        }
        }
      </div>
    </div>
  </div>`,
  styles: [`
    .layout { display: grid; grid-template-columns: 220px minmax(0, 1fr); gap: 20px; align-items: start; }
    .tabs { display: flex; flex-direction: column; gap: 2px; position: sticky; top: 16px; }
    .tabs button { display: flex; align-items: center; gap: 10px; border: 0; background: transparent; text-align: left; padding: 9px 12px; border-radius: var(--radius-s);
      font: 500 var(--fs-s) var(--font); color: var(--ink-2); cursor: pointer; }
    .tabs button:hover { background: var(--surface-2); }
    .tabs button.on { background: var(--surface); color: var(--ink); font-weight: 600; box-shadow: inset 3px 0 0 var(--accent); }
    .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
    .span2 { grid-column: span 2; }
    .end { display: flex; justify-content: flex-end; border-top: 1px solid var(--line); }
    .stack { display: flex; flex-direction: column; gap: 20px; }
    .howto { margin: 0; padding-left: 20px; color: var(--ink-2); font-size: var(--fs-s); display: flex; flex-direction: column; gap: 4px; }
    .token { display: flex; flex-direction: column; gap: 10px; padding: 14px; border: 1px solid var(--line); border-radius: var(--radius-s); }
    .token .input { flex: 1; min-width: 220px; }
    .roles { display: flex; flex-direction: column; gap: 8px; font-size: var(--fs-s); border-top: 1px solid var(--line); }
    .mt { margin-top: 16px; }
    @media (max-width: 800px) { .layout { grid-template-columns: 1fr; } .tabs { flex-direction: row; overflow-x: auto; position: static; } .grid { grid-template-columns: 1fr; } .span2 { grid-column: auto; } }
  `],
})
export class SettingsComponent {
  protected store = inject(StoreService);
  private ui = inject(UiService);
  private http = inject(HttpClient);

  protected tabs: { key: Tab; label: string; icon: string }[] = [
    { key: 'business', label: 'Business profile', icon: 'building' },
    { key: 'fbr', label: 'FBR connection', icon: 'key' },
    { key: 'defaults', label: 'Invoice defaults', icon: 'file' },
    { key: 'team', label: 'Team and security', icon: 'shield' },
    { key: 'add', label: 'Add a business', icon: 'plus' },
  ];
  protected tab = signal<Tab>('fbr');
  protected envs: FbrEnvironment[] = ['sandbox', 'production'];
  protected provinces = PROVINCES; protected activities = ACTIVITIES; protected sectors = SECTORS; protected saleTypes = SALE_TYPES;
  protected draft = signal<Business | null>(null);
  protected tokenInput = signal<Record<FbrEnvironment, string>>({ sandbox: '', production: '' });
  protected savingToken = signal(false);
  protected testing = signal(false);
  protected newBiz = this.blankBiz();

  constructor() {
    effect(() => { const b = this.store.business(); this.draft.set(b ? { ...b } : null); });
  }

  protected layouts = () => this.store.mappings().filter(m => m.businessId === this.store.business()?.id);
  protected mappedCount = (m: Record<string, string>) => Object.values(m).filter(Boolean).length;
  deleteLayout(id: string) { this.store.mappings.update(l => l.filter(m => m.id !== id)); }

  saveBiz(d: Business) {
    this.store.updateBusiness({ ...d, ntnCnic: cleanNtn(d.ntnCnic), furtherTaxRate: Number(d.furtherTaxRate) || 0, nextInvoiceNo: Math.max(1, Math.floor(d.nextInvoiceNo)) });
    this.ui.toast('Saved');
  }

  setEnv(env: FbrEnvironment) {
    const b = this.store.business()!;
    if (env === 'production' && !confirm('Switch to production? Invoices you post from now on are reported to FBR as real tax invoices.')) return;
    this.store.updateBusiness({ ...b, environment: env });
    this.ui.toast(env === 'production' ? 'Production mode on' : 'Sandbox mode on', 'info');
  }

  setTokenInput(env: FbrEnvironment, v: string) { this.tokenInput.update(t => ({ ...t, [env]: v })); }

  async saveToken(env: FbrEnvironment) {
    const token = this.tokenInput()[env].trim().replace(/^Bearer\s+/i, '');
    if (token.length < 16) { this.ui.toast('That does not look like a full token. Paste the whole value from IRIS.', 'error'); return; }
    const b = this.store.business()!;
    this.savingToken.set(true);
    try {
      let hint = '••••' + token.slice(-4);
      if (!environment.mockFbr) {
        const r = await firstValueFrom(this.http.put<{ hint: string }>(`${environment.apiBaseUrl}/businesses/${b.id}/credentials/${env}`, { token }));
        hint = r.hint;
      } else { await sleep(300); }
      // The token itself is dropped here; only the hint is kept client-side.
      this.store.updateBusiness(env === 'sandbox' ? { ...b, hasSandboxToken: true, tokenHintSandbox: hint } : { ...b, hasProductionToken: true, tokenHintProduction: hint });
      this.setTokenInput(env, '');
      this.ui.toast(`${env === 'sandbox' ? 'Sandbox' : 'Production'} token saved`);
    } catch (e) {
      this.ui.toast((e as { error?: { message?: string } }).error?.message ?? 'Could not save the token', 'error');
    } finally { this.savingToken.set(false); }
  }

  async testToken(env: FbrEnvironment) {
    const b = this.store.business()!;
    this.testing.set(true);
    try {
      if (environment.mockFbr) await sleep(600);
      else await firstValueFrom(this.http.post(`${environment.apiBaseUrl}/businesses/${b.id}/credentials/${env}/test`, {}));
      this.ui.toast('FBR accepted the token');
    } catch { this.ui.toast('FBR did not accept the token. Generate a new one in IRIS.', 'error'); }
    finally { this.testing.set(false); }
  }

  invite() { this.ui.toast('Invitations are sent by email once the API is connected.', 'info'); }

  private blankBiz(): Business {
    return { id: '', name: '', ntnCnic: '', province: 'Punjab', address: '', activity: 'Wholesaler', sector: 'All Other Sectors', environment: 'sandbox',
      hasSandboxToken: false, hasProductionToken: false, defaultSaleType: 'Goods at standard rate (default)', furtherTaxRate: 4, invoicePrefix: 'INV-', nextInvoiceNo: 1 };
  }
  addBiz() {
    this.store.addBusiness({ ...this.newBiz, id: uid('b_'), ntnCnic: cleanNtn(this.newBiz.ntnCnic) });
    this.newBiz = this.blankBiz();
    this.tab.set('fbr');
    this.ui.toast('Business added. Now connect it to FBR.');
  }
}
