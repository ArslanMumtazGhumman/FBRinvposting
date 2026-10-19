import { CommonModule } from '@angular/common';
import { Component, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { Router } from '@angular/router';
import { AuthService } from '../auth/auth.service';
import { Product, StockMovement, StockMovementType } from '../sales/sales.models';
import { SalesService } from '../sales/sales.service';

export type StockFilter = 'all' | 'low' | 'out';

@Component({
  selector: 'app-stock',
  imports: [CommonModule, FormsModule],
  templateUrl: './stock.component.html',
  styleUrl: './stock.component.css',
})
export class StockComponent {
  protected readonly service = inject(SalesService);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  protected readonly products = this.service.products;
  protected readonly query = signal('');
  protected readonly filter = signal<StockFilter>('all');
  protected readonly categoryFilter = signal('All');
  protected readonly selectedProductId = signal<string | null>(this.service.products()[0]?.id ?? null);
  protected readonly showProductForm = signal(false);
  protected readonly showMovementForm = signal(false);
  protected readonly saving = signal(false);
  protected readonly errorMessage = signal('');
  protected readonly successMessage = signal('');
  protected readonly movementHistory = signal<StockMovement[]>([]);
  protected readonly editingProductId = signal<string | null>(null);
  protected readonly productName = signal('');
  protected readonly categoryName = signal('');
  protected readonly categoryDraft = signal('');
  protected readonly sku = signal('');
  protected readonly unit = signal('unit');
  protected readonly purchasePrice = signal(0);
  protected readonly salePrice = signal(0);
  protected readonly openingStock = signal(0);
  protected readonly lowStockThreshold = signal(0);
  protected readonly movementType = signal<Exclude<StockMovementType, 'OPENING' | 'SALE' | 'SALE_RETURN'>>('PURCHASE');
  protected readonly movementDelta = signal(1);
  protected readonly movementNote = signal('');
  private historyProductId = '';
  private historyRequest = 0;

  protected readonly filteredProducts = computed(() => {
    const search = this.query().trim().toLocaleLowerCase();
    return this.products().filter((product) => {
      const matchesQuery = !search
        || product.name.toLocaleLowerCase().includes(search)
        || product.category.toLocaleLowerCase().includes(search);
      const matchesCategory = this.categoryFilter() === 'All' || product.category === this.categoryFilter();

      const matchesFilter =
        this.filter() === 'all'
          || (this.filter() === 'low' && product.stock > 0 && product.stock <= (product.lowStockThreshold ?? 8))
          || (this.filter() === 'out' && product.stock === 0);

      return matchesQuery && matchesFilter && matchesCategory;
    });
  });

  protected readonly selectedProduct = computed(() => {
    const active = this.filteredProducts().find((product) => product.id === this.selectedProductId());
    return active ?? this.filteredProducts()[0] ?? null;
  });

  protected readonly totalProducts = computed(() => this.products().length);
  protected readonly lowStockCount = computed(() => this.products().filter((product) => product.stock > 0 && product.stock <= (product.lowStockThreshold ?? 8)).length);
  protected readonly outOfStockCount = computed(() => this.products().filter((product) => product.stock === 0).length);
  protected readonly inventoryValue = computed(() => this.products().reduce((sum, product) => sum + product.stock * (product.purchasePrice ?? 0), 0));
  protected readonly canManageProducts = computed(() => {
    const role = this.auth.currentUser()?.memberships?.[0]?.role;
    return role === 'OWNER' || role === 'ADMIN';
  });

  constructor() {
    effect(() => {
      const productId = this.selectedProduct()?.id;
      if (productId && productId !== this.historyProductId) {
        void this.selectProductHistory(productId);
      }
    });
  }

  protected setCategoryFilter(category: string): void {
    this.categoryFilter.set(category);
    const nextSelection = this.filteredProducts()[0];
    this.selectedProductId.set(nextSelection?.id ?? null);
  }

  protected setFilter(filter: StockFilter): void {
    this.filter.set(filter);
    const nextSelection = this.filteredProducts()[0];
    this.selectedProductId.set(nextSelection?.id ?? null);
  }

  protected async selectProduct(product: Product): Promise<void> {
    this.selectedProductId.set(product.id);
    this.showMovementForm.set(false);
    this.errorMessage.set('');
    await this.selectProductHistory(product.id, true);
  }

  protected addStock(product: Product): void {
    this.selectedProductId.set(product.id);
    this.movementType.set('PURCHASE');
    this.movementDelta.set(1);
    this.movementNote.set('');
    this.showProductForm.set(false);
    this.showMovementForm.set(true);
    void this.selectProductHistory(product.id, true);
  }

  protected addStockFromHeader(): void {
    const product = this.selectedProduct();
    if (product) {
      this.addStock(product);
    } else if (this.canManageProducts()) {
      this.openProductForm();
    } else {
      this.errorMessage.set('No products are available for stock operations.');
    }
  }

  protected openProductForm(): void {
    this.errorMessage.set('');
    this.successMessage.set('');
    this.showMovementForm.set(false);
    this.editingProductId.set(null);
    this.resetProductForm();
    this.showProductForm.update((show) => !show);
  }

  protected editProduct(product: Product): void {
    this.errorMessage.set('');
    this.successMessage.set('');
    this.showMovementForm.set(false);
    this.editingProductId.set(product.id);
    this.productName.set(product.name);
    this.categoryName.set(product.category);
    this.sku.set(product.sku ?? '');
    this.unit.set(product.unit ?? 'unit');
    this.purchasePrice.set(product.purchasePrice);
    this.salePrice.set(product.salePrice);
    this.openingStock.set(product.stock);
    this.lowStockThreshold.set(product.lowStockThreshold);
    this.showProductForm.set(true);
  }

  protected async saveProduct(): Promise<void> {
    if (this.saving()) {
      return;
    }
    this.saving.set(true);
    this.errorMessage.set('');
    this.successMessage.set('');
    try {
      const input = {
        name: this.productName(),
        categoryName: this.categoryName(),
        sku: this.sku().trim() || undefined,
        unit: this.unit(),
        purchasePrice: this.purchasePrice(),
        salePrice: this.salePrice(),
        lowStockThreshold: this.lowStockThreshold(),
      };
      const editingProductId = this.editingProductId();
      const product = editingProductId
        ? await this.service.updateProduct(editingProductId, input)
        : await this.service.createProduct({ ...input, openingStock: this.openingStock() });
      this.selectedProductId.set(product.id);
      this.editingProductId.set(null);
      this.resetProductForm();
      this.showProductForm.set(false);
      this.successMessage.set(`${product.name} ${editingProductId ? 'updated' : 'added'}.`);
      await this.selectProductHistory(product.id, true);
    } catch (error) {
      this.errorMessage.set(this.errorText(error, 'Could not save this product.'));
    } finally {
      this.saving.set(false);
    }
  }

  protected async saveMovement(): Promise<void> {
    const productId = this.selectedProductId();
    if (!productId || this.saving()) {
      return;
    }
    this.saving.set(true);
    this.errorMessage.set('');
    this.successMessage.set('');
    try {
      const quantity = this.movementDelta();
      await this.service.recordStockAdjustment(
        productId,
        this.movementType(),
        quantity,
        this.movementNote().trim() || undefined,
      );
      this.successMessage.set('Stock movement recorded.');
      await this.selectProductHistory(productId, true);
    } catch (error) {
      this.errorMessage.set(this.errorText(error, 'Could not record this stock movement.'));
    } finally {
      this.saving.set(false);
    }
  }

  protected async archiveProduct(product: Product): Promise<void> {
    if (!this.canManageProducts() || !window.confirm(`Archive ${product.name}? Its stock history will be kept.`)) {
      return;
    }
    this.errorMessage.set('');
    this.successMessage.set('');
    try {
      await this.service.archiveProduct(product.id);
      this.selectedProductId.set(this.filteredProducts()[0]?.id ?? null);
      this.movementHistory.set([]);
      this.historyProductId = '';
      this.successMessage.set(`${product.name} archived. Its stock history is retained.`);
    } catch (error) {
      this.errorMessage.set(this.errorText(error, 'Could not archive this product.'));
    }
  }

  protected async saveCategory(): Promise<void> {
    const name = this.categoryDraft().trim();
    if (!name) {
      this.errorMessage.set('Enter a category name.');
      return;
    }
    try {
      await this.service.createCategory(name);
      this.categoryName.set(name);
      this.categoryDraft.set('');
      this.successMessage.set(`${name} category added.`);
      this.errorMessage.set('');
    } catch (error) {
      this.errorMessage.set(this.errorText(error, 'Could not create this category.'));
    }
  }

  protected setMovementType(type: Exclude<StockMovementType, 'OPENING' | 'SALE' | 'SALE_RETURN'>): void {
    this.movementType.set(type);
  }

  protected movementDescription(movement: StockMovement): string {
    return movement.type === 'OPENING'
      ? 'Opening stock'
      : movement.type === 'PURCHASE'
        ? 'Stock added'
        : movement.type === 'DAMAGE'
          ? 'Damaged stock'
          : movement.type === 'PURCHASE_RETURN'
            ? 'Returned to supplier'
          : movement.type === 'ADJUSTMENT_IN'
            ? 'Adjustment in'
            : movement.type === 'ADJUSTMENT_OUT'
              ? 'Adjustment out'
              : movement.type;
  }

  protected openSale(): void {
    void this.router.navigate(['/sales/new']);
  }

  private async selectProductHistory(productId: string, force = false): Promise<void> {
    if (this.historyProductId === productId && !force) {
      return;
    }
    const requestId = ++this.historyRequest;
    this.historyProductId = productId;
    try {
      const movements = await this.service.listStockMovements(productId);
      if (requestId === this.historyRequest) {
        this.movementHistory.set(movements);
      }
    } catch (error) {
      if (requestId === this.historyRequest) {
        this.errorMessage.set(this.errorText(error, 'Could not load stock movement history.'));
      }
    }
  }

  private errorText(error: unknown, fallback: string): string {
    if (error instanceof HttpErrorResponse) {
      return error.error?.message ?? fallback;
    }
    return error instanceof Error ? error.message : fallback;
  }

  private resetProductForm(): void {
    this.productName.set('');
    this.categoryName.set('');
    this.sku.set('');
    this.unit.set('unit');
    this.purchasePrice.set(0);
    this.salePrice.set(0);
    this.openingStock.set(0);
    this.lowStockThreshold.set(0);
  }

  protected currency(value: number): string {
    return `Rs ${new Intl.NumberFormat('en-PK').format(value)}`;
  }

  protected stockTone(product: Product): 'low' | 'out' | 'healthy' {
    if (product.stock === 0) { return 'out'; }
    if (product.stock <= (product.lowStockThreshold ?? 8)) { return 'low'; }
    return 'healthy';
  }
}
