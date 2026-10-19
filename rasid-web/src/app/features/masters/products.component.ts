import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { errorMessage } from '../../core/api';
import { HS_SAMPLE, SALE_TYPES } from '../../core/fbr-reference';
import { Product } from '../../core/models';
import { ReferenceService } from '../../core/reference.service';
import { Store } from '../../core/store';
import { UiService } from '../../core/ui.service';
import { formatPkr, uid } from '../../core/util';
import { HsTypeaheadComponent } from '../../shared/hs-typeahead.component';
import { IconComponent } from '../../shared/icon.component';

@Component({
  selector: 'app-products',
  imports: [FormsModule, IconComponent, HsTypeaheadComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <div class="page">
    <div class="page-header">
      <div><h1>Products</h1><p class="lead">Each product remembers its HS code, unit, sale type and rate, so lines fill themselves. Products are also learned from invoices you post.</p></div>
      <button class="btn btn-primary" (click)="edit(null)"><app-icon name="plus" /> Add product</button>
    </div>

    @if (draft(); as d) {
      <section class="panel form">
        <div class="panel-head"><h2>{{ d.id ? 'Edit product' : 'New product' }}</h2><button class="btn btn-ghost btn-icon" (click)="draft.set(null)" aria-label="Close"><app-icon name="x" /></button></div>
        <div class="panel-body grid">
          <div class="field span2"><label for="pn">Name</label><input id="pn" class="input" [(ngModel)]="d.name" /></div>
          <div class="field span2">
            <label for="ph">HS code</label>
            <app-hs-typeahead inputId="ph" [value]="d.hsCode" placeholder="Type a code or words like 'sugar'" ariaLabel="HS code"
                              (valueChange)="d.hsCode = $event" (picked)="pickHs(d, $event.code)" />
            <span class="hint">Searches FBR's HS code list, refreshed nightly. The offline demo searches a sample.</span>
          </div>
          <div class="field"><label for="pu">Unit</label><select id="pu" class="select" [(ngModel)]="d.uoM">@for (u of uomsFor(d.uoM, d.hsCode); track u) { <option>{{ u }}</option> }</select></div>
          <div class="field"><label for="ps">Sale type</label><select id="ps" class="select" [(ngModel)]="d.saleType" (ngModelChange)="d.rate = rates(d.saleType)[0]">@for (s of saleTypes; track s.name) { <option [value]="s.name">{{ s.name }}</option> }</select></div>
          <div class="field"><label for="pr">Rate</label><select id="pr" class="select" [(ngModel)]="d.rate">@for (r of rates(d.saleType); track r) { <option>{{ r }}</option> }</select></div>
          <div class="field"><label for="pp">Unit price (PKR, excl. tax)</label><input id="pp" class="input" type="number" min="0" step="any" [(ngModel)]="d.unitPrice" /></div>
        </div>
        <div class="panel-body row end"><button class="btn" (click)="draft.set(null)">Cancel</button><button class="btn btn-primary" (click)="save(d)" [disabled]="!d.name || !d.hsCode">Save product</button></div>
      </section>
    }

    <div class="panel">
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>Product</th><th>HS code</th><th>Unit</th><th>Sale type</th><th>Rate</th><th class="num">Unit price</th><th></th></tr></thead>
          <tbody>
            @for (p of store.bizProducts(); track p.id) {
              <tr><td><b>{{ p.name }}</b></td><td>{{ p.hsCode }}</td><td>{{ p.uoM }}</td><td>{{ p.saleType }}</td><td>{{ p.rate }}</td><td class="num">{{ fmt(p.unitPrice, 2) }}</td>
                <td class="num"><button class="btn btn-sm btn-ghost" (click)="edit(p)">Edit</button><button class="btn btn-sm btn-ghost btn-danger" (click)="remove(p)">Delete</button></td></tr>
            } @empty { <tr><td colspan="7"><div class="empty"><h3>No products yet</h3><p>Add your common items to fill invoice lines faster.</p></div></td></tr> }
          </tbody>
        </table>
      </div>
    </div>
  </div>`,
  styles: [`
    .form { margin-bottom: 16px; }
    .grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; }
    .span2 { grid-column: span 2; }
    .end { justify-content: flex-end; border-top: 1px solid var(--line); }
    @media (max-width: 800px) { .grid { grid-template-columns: 1fr; } .span2 { grid-column: auto; } }
  `],
})
export class ProductsComponent {
  protected store = inject(Store);
  private ui = inject(UiService);
  private ref = inject(ReferenceService);
  protected saleTypes = SALE_TYPES;
  protected fmt = formatPkr;
  protected draft = signal<Product | null>(null);
  protected rates = (st: string) => { const r = this.ref.rates(st); return r.length ? r : ['18%']; };
  /** The units FBR allows for the product's HS code when known, else every unit. */
  protected uomsFor = (current: string, hsCode: string) => {
    const u = this.ref.allowedUoms(hsCode.trim()) ?? this.ref.uoms();
    return current && !u.includes(current) ? [current, ...u] : u;
  };

  edit(p: Product | null) {
    const b = this.store.business()!;
    this.draft.set(p ? { ...p } : { id: '', businessId: b.id, name: '', hsCode: '', uoM: this.ref.uoms()[0], saleType: b.defaultSaleType, rate: this.rates(b.defaultSaleType)[0], unitPrice: 0 });
  }
  /** Picks an HS code and the unit FBR expects for it (PRAL's HS_UOM; the sample's unit offline). */
  async pickHs(d: Product, code: string) {
    d.hsCode = code;
    this.draft.set({ ...d });
    const allowed = await this.ref.hsUoms(code);
    const uom = allowed?.[0] ?? (this.store.mode === 'local' ? HS_SAMPLE.find(h => h.code === code)?.uom : undefined);
    const cur = this.draft();
    if (uom && cur?.hsCode === code && !allowed?.includes(cur.uoM)) this.draft.set({ ...cur, uoM: uom });
  }
  remove(p: Product) {
    this.store.deleteProduct(p.id).catch(e => this.ui.toast(errorMessage(e, 'Could not delete the product'), 'error'));
  }
  async save(d: Product) {
    try {
      await this.store.upsertProduct({ ...d, id: d.id || uid('p_') });
      this.draft.set(null);
      this.ui.toast('Product saved');
    } catch (e) { this.ui.toast(errorMessage(e, 'Could not save the product'), 'error'); }
  }
}
