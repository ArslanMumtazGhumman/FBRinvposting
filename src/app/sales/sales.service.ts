import { HttpClient } from '@angular/common/http';
import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../auth/auth.service';
import { environment } from '../../environments/environment';
import { Customer, PaymentMethod, Product, ProductCategory, Sale, SaleItem, SaleStatus, StockMovement, StockMovementType } from './sales.models';

const STORAGE_KEY = 'dukaanos.shop-state.v1';

@Injectable({ providedIn: 'root' })
export class SalesService {
  private readonly auth = inject(AuthService);
  private readonly http = inject(HttpClient);
  private activeBusinessId = '';
  private activeStorageKey = '';
  readonly products = signal<Product[]>([]);
  readonly categories = signal<ProductCategory[]>([]);
  readonly loadingProducts = signal(false);
  readonly catalogError = signal('');
  readonly lastMovement = signal<StockMovement | null>(null);
  readonly customers = signal<Customer[]>([]);
  readonly cart = signal<SaleItem[]>([]);
  readonly sales = signal<Sale[]>([]);
  readonly selectedCustomer = signal<Customer | null>(null);
  readonly subtotal = computed(() => this.cart().reduce((sum, item) => sum + item.lineTotal, 0));
  readonly total = this.subtotal;

  constructor() {
    effect(() => {
      const businessId = this.auth.currentUser()?.memberships?.[0]?.business.id ?? '';
      if (businessId !== this.activeBusinessId) {
        untracked(() => this.loadWorkspace(businessId));
      }
    });
  }

  getSale(id: string): Sale | undefined {
    return this.sales().find((sale) => sale.id === id);
  }

  searchProducts(query: string, category: string): Product[] {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return this.products().filter((product) => {
      const matchesCategory = category === 'All' || product.category === category;
      const matchesQuery = !normalizedQuery
        || product.name.toLocaleLowerCase().includes(normalizedQuery)
        || product.category.toLocaleLowerCase().includes(normalizedQuery);
      return matchesCategory && matchesQuery;
    });
  }

  addToCart(product: Product): void {
    if (product.stock <= 0) {
      return;
    }

    this.cart.update((items) => {
      const existing = items.find((item) => item.productId === product.id);
      const nextQty = (existing?.quantity ?? 0) + 1;
      if (nextQty > product.stock) {
        return items;
      }

      if (existing) {
        return items.map((item) => item.productId === product.id
          ? this.withQuantity(item, nextQty)
          : item);
      }

      return [...items, {
        productId: product.id,
        name: product.name,
        category: product.category,
        quantity: 1,
        unitPrice: product.salePrice,
        lineTotal: product.salePrice,
      }];
    });
  }

  changeQuantity(productId: string, change: number): void {
    const product = this.products().find((item) => item.id === productId);
    if (!product) {
      return;
    }

    this.cart.update((items) => {
      const current = items.find((item) => item.productId === productId);
      const nextQty = (current?.quantity ?? 0) + change;
      if (nextQty < 0) {
        return items.filter((item) => item.productId !== productId);
      }
      if (nextQty > product.stock) {
        return items;
      }

      return items
        .map((item) => item.productId === productId
          ? this.withQuantity(item, nextQty)
          : item)
        .filter((item) => item.quantity > 0);
    });
  }

  removeFromCart(productId: string): void {
    this.cart.update((items) => items.filter((item) => item.productId !== productId));
  }

  async createProduct(input: {
    name: string;
    categoryName: string;
    sku?: string;
    unit: string;
    purchasePrice: number;
    salePrice: number;
    openingStock: number;
    lowStockThreshold: number;
  }): Promise<Product> {
    const product = await firstValueFrom(this.http.post<Product>(`${environment.apiUrl}/products`, input));
    this.products.update((products) => [...products, product].sort((left, right) => left.name.localeCompare(right.name)));
    await this.refreshCategories();
    return product;
  }

  async updateProduct(
    productId: string,
    input: {
      name: string;
      categoryName: string;
      sku?: string;
      unit: string;
      purchasePrice: number;
      salePrice: number;
      lowStockThreshold: number;
    },
  ): Promise<Product> {
    const product = await firstValueFrom(this.http.patch<Product>(
      `${environment.apiUrl}/products/${productId}`,
      input,
    ));
    this.products.update((products) => products
      .map((item) => item.id === productId ? product : item)
      .sort((left, right) => left.name.localeCompare(right.name)));
    await this.refreshCategories();
    return product;
  }

  async recordStockAdjustment(
    productId: string,
    type: Exclude<StockMovementType, 'OPENING' | 'SALE' | 'SALE_RETURN'>,
    quantity: number,
    note?: string,
  ): Promise<void> {
    const response = await firstValueFrom(this.http.post<{ movement: StockMovement; stock: number }>(
      `${environment.apiUrl}/products/${productId}/stock/adjust`,
      { type, quantity, note },
    ));
    this.products.update((products) => products.map((product) => product.id === productId
      ? { ...product, stock: response.stock }
      : product));
    this.lastMovement.set(response.movement);
  }

  async archiveProduct(productId: string): Promise<void> {
    await firstValueFrom(this.http.delete<{ id: string; isActive: boolean }>(
      `${environment.apiUrl}/products/${productId}`,
    ));
    this.products.update((products) => products.filter((product) => product.id !== productId));
  }

  async listStockMovements(productId: string): Promise<StockMovement[]> {
    return firstValueFrom(this.http.get<StockMovement[]>(
      `${environment.apiUrl}/products/${productId}/stock-history`,
    ));
  }

  async refreshCategories(): Promise<void> {
    this.categories.set(await firstValueFrom(
      this.http.get<ProductCategory[]>(`${environment.apiUrl}/categories`),
    ));
  }

  async createCategory(name: string): Promise<ProductCategory> {
    const category = await firstValueFrom(this.http.post<ProductCategory>(
      `${environment.apiUrl}/categories`,
      { name },
    ));
    this.categories.update((categories) =>
      [...categories, category].sort((left, right) => left.name.localeCompare(right.name)),
    );
    return category;
  }

  setCustomer(customer: Customer | null): void {
    this.selectedCustomer.set(customer);
  }

  createCustomer(name: string, phone?: string): Customer {
    const normalizedName = name.trim();
    if (!normalizedName) {
      throw new Error('Enter the customer name.');
    }
    const customer: Customer = {
      id: `customer-${crypto.randomUUID()}`,
      name: normalizedName,
      phone: phone?.trim() || undefined,
      balance: 0,
      totalPurchases: 0,
    };
    this.customers.update((customers) => [customer, ...customers]);
    this.persistState();
    this.selectedCustomer.set(customer);
    return customer;
  }

  saveSale(method: PaymentMethod, amountReceived: number): Sale {
    const items = this.cart();
    if (items.length === 0) {
      throw new Error('Add at least one product to the sale.');
    }

    const total = this.total();
    const paid = method === 'credit' ? 0 : amountReceived;
    if (!Number.isFinite(paid) || paid < 0 || paid > total) {
      throw new Error('Enter an amount between Rs 0 and the sale total.');
    }
    if ((method === 'credit' || method === 'partial' || paid < total) && !this.selectedCustomer()) {
      throw new Error('Choose a customer for a credit or partial payment.');
    }

    const customer = this.selectedCustomer();
    const balance = total - paid;
    const status: SaleStatus = balance === 0 ? 'PAID' : paid === 0 ? 'CREDIT' : 'PARTIAL';
    const createdAt = new Date();
    const number = this.nextSaleNumber();
    const sale: Sale = {
      id: `sale-${number}`,
      number,
      createdAt,
      customerId: customer?.id ?? null,
      customerName: customer?.name ?? 'Walk-in Customer',
      items: items.map((item) => ({ ...item })),
      subtotal: total,
      total,
      paid,
      balance,
      status,
      payments: paid > 0
        ? [{ method: method === 'partial' ? 'cash' : method, amount: paid, receivedAt: createdAt }]
        : [],
    };

    this.sales.update((sales) => [sale, ...sales]);
    if (customer) {
      this.customers.update((customers) => customers.map((item) => item.id === customer.id
        ? { ...item, balance: item.balance + balance, totalPurchases: item.totalPurchases + total }
        : item));
    }
    this.persistState();
    this.resetCart();
    return sale;
  }

  receivePayment(saleId: string, amount: number, method: PaymentMethod): Sale {
    let updatedSale: Sale | undefined;
    this.sales.update((sales) => sales.map((sale) => {
      if (sale.id !== saleId) {
        return sale;
      }
      if (!Number.isFinite(amount) || amount <= 0 || amount > sale.balance) {
        throw new Error('Enter an amount greater than Rs 0 and no more than the remaining balance.');
      }
      const receivedAt = new Date();
      updatedSale = {
        ...sale,
        paid: sale.paid + amount,
        balance: sale.balance - amount,
        status: sale.balance - amount === 0 ? 'PAID' : 'PARTIAL',
        payments: [...sale.payments, { method, amount, receivedAt }],
      };
      return updatedSale;
    }));
    if (!updatedSale) {
      throw new Error('This sale could not be found.');
    }
    if (updatedSale.customerId) {
      this.customers.update((customers) => customers.map((customer) => customer.id === updatedSale?.customerId
        ? { ...customer, balance: Math.max(0, customer.balance - amount) }
        : customer));
    }
    this.persistState();
    return updatedSale;
  }

  resetCart(): void {
    this.cart.set([]);
    this.selectedCustomer.set(null);
  }

  private readStoredState(): { customers: Customer[]; sales: Sale[] } {
    if (typeof window === 'undefined' || !window.localStorage) {
      return { customers: [], sales: [] };
    }

    try {
      const raw = window.localStorage.getItem(this.activeStorageKey);
      if (!raw) {
        return { customers: [], sales: [] };
      }
      const parsed = JSON.parse(raw) as Partial<{ customers: Customer[]; sales: Sale[] }>;
      return {
        customers: Array.isArray(parsed.customers) ? parsed.customers : [],
        sales: Array.isArray(parsed.sales) ? parsed.sales.map((sale) => ({
          ...sale,
          createdAt: new Date(sale.createdAt),
          payments: sale.payments.map((payment) => ({
            ...payment,
            receivedAt: new Date(payment.receivedAt),
          })),
        })) : [],
      };
    } catch {
      return { customers: [], sales: [] };
    }
  }

  private persistState(): void {
    if (typeof window === 'undefined' || !window.localStorage || !this.activeBusinessId) {
      return;
    }

    const state = {
      customers: this.customers(),
      sales: this.sales(),
    };
    window.localStorage.setItem(this.activeStorageKey, JSON.stringify(state));
  }

  private loadWorkspace(businessId: string): void {
    this.activeBusinessId = businessId;
    this.activeStorageKey = businessId ? `${STORAGE_KEY}:${businessId}` : '';
    this.products.set([]);
    this.categories.set([]);
    this.cart.set([]);
    this.customers.set([]);
    this.sales.set([]);
    this.selectedCustomer.set(null);
    this.catalogError.set('');
    if (!businessId) {
      this.loadingProducts.set(false);
      return;
    }
    const storedState = this.readStoredState();
    this.customers.set(storedState.customers);
    this.sales.set(storedState.sales);
    this.persistState();
    void this.loadCatalog(businessId);
  }

  private async loadCatalog(businessId: string): Promise<void> {
    this.loadingProducts.set(true);
    this.catalogError.set('');
    try {
      const [products, categories] = await Promise.all([
        firstValueFrom(this.http.get<Product[]>(`${environment.apiUrl}/products`)),
        firstValueFrom(this.http.get<ProductCategory[]>(`${environment.apiUrl}/categories`)),
      ]);
      if (businessId !== this.activeBusinessId) {
        return;
      }
      this.products.set(products);
      this.categories.set(categories);
    } catch (error) {
      if (businessId === this.activeBusinessId) {
        this.catalogError.set('Could not load your products. Check the connection and try again.');
        console.error('Failed to load the business product catalog.', error);
      }
    } finally {
      if (businessId === this.activeBusinessId) {
        this.loadingProducts.set(false);
      }
    }
  }

  private withQuantity(item: SaleItem, quantity: number): SaleItem {
    return { ...item, quantity, lineTotal: item.unitPrice * quantity };
  }

  private nextSaleNumber(): number {
    return Math.max(1024, ...this.sales().map((sale) => sale.number)) + 1;
  }
}
