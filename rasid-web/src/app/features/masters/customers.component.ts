import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { FbrGatewayService } from '../../core/fbr-gateway.service';
import { PROVINCES } from '../../core/fbr-reference';
import { Customer } from '../../core/models';
import { StoreService } from '../../core/store.service';
import { cleanNtn } from '../../core/tax';
import { UiService } from '../../core/ui.service';
import { uid } from '../../core/util';
import { IconComponent } from '../../shared/icon.component';

@Component({
  selector: 'app-customers',
  imports: [FormsModule, IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <div class="page">
    <div class="page-header">
      <div><h1>Customers</h1><p class="lead">Saved buyers fill the invoice form in one pick. NTNs are checked against FBR's registration list.</p></div>
      <button class="btn btn-primary" (click)="edit(null)"><app-icon name="plus" /> Add customer</button>
    </div>

    @if (draft(); as d) {
      <section class="panel form">
        <div class="panel-head"><h2>{{ d.id ? 'Edit customer' : 'New customer' }}</h2><button class="btn btn-ghost btn-icon" (click)="draft.set(null)" aria-label="Close"><app-icon name="x" /></button></div>
        <div class="panel-body grid">
          <div class="field span2"><label for="cn">Name</label><input id="cn" class="input" [(ngModel)]="d.name" /></div>
          <div class="field"><label for="cntn">NTN or CNIC</label>
            <div class="with-btn"><input id="cntn" class="input" [(ngModel)]="d.ntnCnic" (blur)="d.ntnCnic = clean(d.ntnCnic)" /><button class="btn" (click)="check(d)">Check</button></div>
          </div>
          <div class="field"><label>Registration</label>
            <div class="segmented"><button [class.on]="d.registrationType === 'Registered'" (click)="d.registrationType = 'Registered'">Registered</button><button [class.on]="d.registrationType === 'Unregistered'" (click)="d.registrationType = 'Unregistered'">Unregistered</button></div>
          </div>
          <div class="field"><label for="cp">Province</label><select id="cp" class="select" [(ngModel)]="d.province">@for (p of provinces; track p) { <option>{{ p }}</option> }</select></div>
          <div class="field span2"><label for="ca">Address</label><input id="ca" class="input" [(ngModel)]="d.address" /></div>
          <div class="field"><label for="ce">Email for invoices</label><input id="ce" class="input" type="email" [(ngModel)]="d.email" /></div>
        </div>
        <div class="panel-body row end"><button class="btn" (click)="draft.set(null)">Cancel</button><button class="btn btn-primary" (click)="save(d)" [disabled]="!d.name">Save customer</button></div>
      </section>
    }

    <div class="panel">
      <div class="panel-head"><input class="input search" placeholder="Search name or NTN" [ngModel]="q()" (ngModelChange)="q.set($event)" aria-label="Search customers" /><span class="subtle">{{ rows().length }} customers</span></div>
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>Name</th><th>NTN / CNIC</th><th>Registration</th><th>Province</th><th>FBR status</th><th></th></tr></thead>
          <tbody>
            @for (c of rows(); track c.id) {
              <tr>
                <td><b>{{ c.name }}</b><div class="subtle">{{ c.address }}</div></td>
                <td>{{ c.ntnCnic || '—' }}</td><td>{{ c.registrationType }}</td><td>{{ c.province }}</td>
                <td><span class="chip" [class.posted]="c.activeStatus === 'Active'" [class.failed]="c.activeStatus === 'In-Active'">{{ c.activeStatus ?? 'Unknown' }}</span></td>
                <td class="num"><button class="btn btn-sm btn-ghost" (click)="edit(c)">Edit</button><button class="btn btn-sm btn-ghost btn-danger" (click)="remove(c)">Delete</button></td>
              </tr>
            } @empty { <tr><td colspan="6"><div class="empty"><h3>No customers yet</h3><p>Add one here, or they are offered for saving after you post invoices.</p></div></td></tr> }
          </tbody>
        </table>
      </div>
    </div>
  </div>`,
  styles: [`
    .form { margin-bottom: 16px; }
    .grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; }
    .span2 { grid-column: span 2; }
    .with-btn { display: flex; gap: 6px; }
    .end { justify-content: flex-end; border-top: 1px solid var(--line); }
    .search { max-width: 320px; height: 34px; }
    @media (max-width: 800px) { .grid { grid-template-columns: 1fr; } .span2 { grid-column: auto; } }
  `],
})
export class CustomersComponent {
  protected store = inject(StoreService);
  private fbr = inject(FbrGatewayService);
  private ui = inject(UiService);
  protected provinces = PROVINCES;
  protected q = signal('');
  protected draft = signal<Customer | null>(null);
  protected clean = cleanNtn;

  protected rows = computed(() => {
    const q = this.q().toLowerCase();
    return this.store.bizCustomers().filter(c => !q || c.name.toLowerCase().includes(q) || c.ntnCnic.includes(q));
  });

  edit(c: Customer | null) {
    const b = this.store.business()!;
    this.draft.set(c ? { ...c } : { id: '', businessId: b.id, name: '', ntnCnic: '', province: b.province, address: '', registrationType: 'Registered', activeStatus: 'Unknown' });
  }
  save(d: Customer) {
    this.store.upsertCustomer({ ...d, id: d.id || uid('c_'), ntnCnic: cleanNtn(d.ntnCnic) });
    this.draft.set(null);
    this.ui.toast('Customer saved');
  }
  remove(c: Customer) { if (confirm(`Delete ${c.name}? Existing invoices keep their buyer details.`)) this.store.deleteCustomer(c.id); }
  async check(d: Customer) {
    const t = await this.fbr.registrationType(this.store.business()!.id, cleanNtn(d.ntnCnic));
    if (t !== 'Unknown') { d.registrationType = t; d.activeStatus = 'Active'; this.draft.set({ ...d }); this.ui.toast(`FBR lists this buyer as ${t}`, 'info'); }
    else this.ui.toast('FBR could not confirm this number.', 'error');
  }
}
