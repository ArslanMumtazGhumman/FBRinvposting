import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HS_SAMPLE, SALE_TYPES, UOMS, saleTypeDef } from '../../core/fbr-reference';
import { Product } from '../../core/models';
import { StoreService } from '../../core/store.service';
import { UiService } from '../../core/ui.service';
import { formatPkr, uid } from '../../core/util';
import { IconComponent } from '../../shared/icon.component';

@Component({
  selector: 'app-products',
  imports: [FormsModule, IconComponent],
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
          <div class="field span2 hs-field">
            <label for="ph">HS code</label>
            <input id="ph" class="input" [(ngModel)]="d.hsCode" (ngModelChange)="hsQuery.set($event)" placeholder="Type a code or words like 'sugar'" autocomplete="off" />
            @if (hsMatches().length && hsQuery()) {
              <ul class="hs-list" role="listbox">
                @for (h of hsMatches(); track h.code) {
                  <li role="option" (mousedown)="pickHs(d, h.code, h.uom)"><b>{{ h.code }}</b> {{ h.desc }}</li>
                }
              </ul>
            }
            <span class="hint">Search covers a sample list offline; the live app searches FBR's full HS code list.</span>
          </div>
          <div class="field"><label for="pu">Unit</label><select id="pu" class="select" [(ngModel)]="d.uoM">@for (u of uoms; track u) { <option>{{ u }}</option> }</select></div>
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
                <td class="num"><button class="btn btn-sm btn-ghost" (click)="edit(p)">Edit</button><button class="btn btn-sm btn-ghost btn-danger" (click)="store.deleteProduct(p.id)">Delete</button></td></tr>
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
    .hs-field { position: relative; }
    .hs-list { position: absolute; top: 68px; left: 0; right: 0; z-index: 10; list-style: none; margin: 0; padding: 4px; background: var(--surface);
      border: 1px solid var(--line-strong); border-radius: var(--radius-s); box-shadow: var(--shadow-pop); max-height: 240px; overflow: auto; }
    .hs-list li { padding: 7px 10px; border-radius: 4px; cursor: pointer; font-size: var(--fs-s); }
    .hs-list li:hover { background: var(--accent-soft); }
    @media (max-width: 800px) { .grid { grid-template-columns: 1fr; } .span2 { grid-column: auto; } }
  `],
})
export class ProductsComponent {
  protected store = inject(StoreService);
  private ui = inject(UiService);
  protected uoms = UOMS;
  protected saleTypes = SALE_TYPES;
  protected fmt = formatPkr;
  protected draft = signal<Product | null>(null);
  protected hsQuery = signal('');
  protected hsMatches = computed(() => {
    const q = this.hsQuery().toLowerCase().trim();
    if (!q || /^\d{4}\.\d{4}$/.test(q)) return [];
    const words = q.split(/\s+/);
    return HS_SAMPLE.filter(h => h.code.startsWith(q) || words.every(w => h.desc.toLowerCase().includes(w))).slice(0, 8);
  });
  protected rates = (st: string) => saleTypeDef(st)?.rates ?? ['18%'];

  edit(p: Product | null) {
    const b = this.store.business()!;
    this.hsQuery.set('');
    this.draft.set(p ? { ...p } : { id: '', businessId: b.id, name: '', hsCode: '', uoM: UOMS[0], saleType: b.defaultSaleType, rate: this.rates(b.defaultSaleType)[0], unitPrice: 0 });
  }
  pickHs(d: Product, code: string, uom: string) { d.hsCode = code; d.uoM = uom; this.hsQuery.set(''); this.draft.set({ ...d }); }
  save(d: Product) { this.store.upsertProduct({ ...d, id: d.id || uid('p_') }); this.draft.set(null); this.ui.toast('Product saved'); }
}
