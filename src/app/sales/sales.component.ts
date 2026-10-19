import { CommonModule } from '@angular/common';
import { Component, DestroyRef, HostListener, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { NavigationEnd, Router, RouterLink } from '@angular/router';
import { filter } from 'rxjs';
import { Customer, PaymentMethod, Product, Sale, SalesPeriod } from './sales.models';
import { SalesService } from './sales.service';

type SalesPage = 'list' | 'new' | 'details' | 'success';
type SheetMode = 'sale' | 'receive';

@Component({
  selector: 'app-sales',
  imports: [CommonModule, FormsModule, RouterLink],
  templateUrl: './sales.component.html',
  styleUrl: './sales.component.css',
})
export class SalesComponent {
  protected readonly service = inject(SalesService);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  protected readonly categories = computed(() => [
    'All',
    ...this.service.categories().map((category) => category.name),
  ]);
  protected readonly page = signal<SalesPage>(this.pageFromUrl());
  protected readonly category = signal('All');
  protected readonly searchQuery = signal('');
  protected readonly customerQuery = signal('');
  protected readonly period = signal<SalesPeriod>('today');
  protected readonly showCustomerSheet = signal(false);
  protected readonly showPaymentSheet = signal(false);
  protected readonly showNewCustomerForm = signal(false);
  protected readonly returnToPayment = signal(false);
  protected readonly paymentMethod = signal<PaymentMethod>('cash');
  protected readonly sheetMode = signal<SheetMode>('sale');
  protected readonly amountReceived = signal(0);
  protected readonly customerName = signal('');
  protected readonly customerPhone = signal('');
  protected readonly errorMessage = signal('');
  protected readonly paymentError = signal('');
  protected readonly successSaleId = signal('');

  protected readonly filteredProducts = computed(() =>
    this.service.searchProducts(this.searchQuery(), this.category()));
  protected readonly filteredCustomers = computed(() => {
    const query = this.customerQuery().trim().toLocaleLowerCase();
    if (!query) {
      return this.service.customers();
    }
    return this.service.customers().filter((customer) =>
      customer.name.toLocaleLowerCase().includes(query)
      || customer.phone?.includes(query));
  });
  protected readonly visibleSales = computed(() => {
    const allSales = this.service.sales();
    const now = new Date();
    const start = new Date(now);
    if (this.period() === 'today') {
      start.setHours(0, 0, 0, 0);
    } else if (this.period() === 'week') {
      start.setDate(start.getDate() - 7);
    } else {
      start.setDate(start.getDate() - 30);
    }
    return allSales.filter((sale) => sale.createdAt >= start);
  });
  protected readonly summary = computed(() => {
    const sales = this.visibleSales();
    return {
      total: sales.reduce((sum, sale) => sum + sale.total, 0),
      transactions: sales.length,
      credit: sales
        .filter((sale) => sale.status === 'CREDIT')
        .reduce((sum, sale) => sum + sale.total, 0),
      received: sales
        .flatMap((sale) => sale.payments)
        .filter((payment) => payment.method === 'cash')
        .reduce((sum, payment) => sum + payment.amount, 0),
    };
  });

  constructor() {
    this.router.events
      .pipe(
        filter((event): event is NavigationEnd => event instanceof NavigationEnd),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((event) => {
        this.page.set(this.pageFromUrl(event.urlAfterRedirects));
        this.successSaleId.set(this.idFromUrl(event.urlAfterRedirects));
        this.errorMessage.set('');
      });
    this.successSaleId.set(this.idFromUrl(this.router.url));
  }

  protected get currentSale(): Sale | undefined {
    return this.service.getSale(this.idFromUrl(this.router.url));
  }

  protected get total(): number {
    return this.page() === 'details' ? (this.currentSale?.total ?? 0) : this.service.total();
  }

  protected get receiveQuickAmounts(): number[] {
    const balance = this.currentSale?.balance ?? 0;
    return [...new Set([5000, 10000, balance].filter((amount) => amount > 0 && amount <= balance))];
  }

  protected currency(amount: number): string {
    return `Rs ${new Intl.NumberFormat('en-PK').format(amount)}`;
  }

  protected time(date: Date): string {
    return new Intl.DateTimeFormat('en-PK', { hour: 'numeric', minute: '2-digit' }).format(date);
  }

  protected dateTime(date: Date): string {
    return new Intl.DateTimeFormat('en-PK', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(date);
  }

  protected chooseCategory(value: string): void {
    this.category.set(value);
  }

  protected addProduct(product: Product): void {
    this.service.addToCart(product);
    this.errorMessage.set('');
  }

  protected startSale(): void {
    this.service.resetCart();
    this.searchQuery.set('');
    this.category.set('All');
    this.errorMessage.set('');
    void this.router.navigateByUrl('/sales/new');
  }

  protected setPeriod(period: SalesPeriod): void {
    this.period.set(period);
  }

  protected openCustomerSheet(): void {
    this.customerQuery.set('');
    this.showNewCustomerForm.set(false);
    this.errorMessage.set('');
    this.showCustomerSheet.set(true);
  }

  protected closeCustomerSheet(): void {
    this.showCustomerSheet.set(false);
    this.returnToPayment.set(false);
  }

  protected selectCustomer(customer: Customer | null): void {
    this.service.setCustomer(customer);
    this.showCustomerSheet.set(false);
    if (this.returnToPayment()) {
      this.returnToPayment.set(false);
      this.showPaymentSheet.set(true);
    }
  }

  protected chooseCustomerForPayment(): void {
    this.returnToPayment.set(true);
    this.showPaymentSheet.set(false);
    this.openCustomerSheet();
  }

  protected saveNewCustomer(): void {
    try {
      const customer = this.service.createCustomer(this.customerName(), this.customerPhone());
      this.customerName.set('');
      this.customerPhone.set('');
      this.showNewCustomerForm.set(false);
      this.showCustomerSheet.set(false);
      this.paymentError.set('');
      this.selectCustomer(customer);
    } catch (error) {
      this.errorMessage.set(error instanceof Error ? error.message : 'Could not save this customer.');
    }
  }

  protected openPaymentSheet(): void {
    if (this.service.cart().length === 0) {
      this.errorMessage.set('Add a product before completing the sale.');
      return;
    }
    this.sheetMode.set('sale');
    this.paymentMethod.set('cash');
    this.amountReceived.set(this.total);
    this.paymentError.set('');
    this.errorMessage.set('');
    this.showPaymentSheet.set(true);
  }

  protected openReceivePayment(): void {
    const sale = this.currentSale;
    if (!sale || sale.balance <= 0) {
      return;
    }
    this.sheetMode.set('receive');
    this.paymentMethod.set('cash');
    this.amountReceived.set(sale.balance);
    this.paymentError.set('');
    this.showPaymentSheet.set(true);
  }

  protected choosePaymentMethod(method: PaymentMethod): void {
    this.paymentMethod.set(method);
    if (method === 'credit') {
      this.amountReceived.set(0);
    } else if (method !== 'partial' || this.amountReceived() === 0) {
      this.amountReceived.set(this.sheetMode() === 'receive' ? (this.currentSale?.balance ?? 0) : this.total);
    }
    this.paymentError.set('');
  }

  protected useFullAmount(): void {
    this.amountReceived.set(this.sheetMode() === 'receive' ? (this.currentSale?.balance ?? 0) : this.total);
  }

  protected get remainingAmount(): number {
    const cap = this.sheetMode() === 'receive' ? (this.currentSale?.balance ?? 0) : this.total;
    return Math.max(0, cap - this.amountReceived());
  }

  protected saveSale(): void {
    try {
      const sale = this.service.saveSale(this.paymentMethod(), this.amountReceived());
      this.showPaymentSheet.set(false);
      this.successSaleId.set(sale.id);
      void this.router.navigate(['/sales/success', sale.id]);
    } catch (error) {
      this.paymentError.set(error instanceof Error ? error.message : 'Could not save this sale.');
    }
  }

  protected saveReceivedPayment(): void {
    const sale = this.currentSale;
    if (!sale) {
      this.paymentError.set('This sale could not be found.');
      return;
    }
    try {
      this.service.receivePayment(sale.id, this.amountReceived(), this.paymentMethod());
      this.showPaymentSheet.set(false);
      this.paymentError.set('');
    } catch (error) {
      this.paymentError.set(error instanceof Error ? error.message : 'Could not record this payment.');
    }
  }

  protected statusText(status: Sale['status']): string {
    return status === 'PAID' ? 'Paid' : status === 'CREDIT' ? 'Credit' : 'Partial';
  }

  @HostListener('document:keydown.escape')
  protected closeSheets(): void {
    this.showCustomerSheet.set(false);
    this.showPaymentSheet.set(false);
    this.showNewCustomerForm.set(false);
    this.returnToPayment.set(false);
  }

  @HostListener('document:keydown.enter', ['$event'])
  protected addSingleSearchResult(event: Event): void {
    if (!(event instanceof KeyboardEvent)) {
      return;
    }
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || target.type !== 'search' || this.page() !== 'new') {
      return;
    }
    const matches = this.filteredProducts();
    if (matches.length === 1) {
      event.preventDefault();
      this.addProduct(matches[0]);
    }
  }

  private pageFromUrl(url = this.router.url): SalesPage {
    if (url.includes('/success/')) {
      return 'success';
    }
    if (url.endsWith('/new')) {
      return 'new';
    }
    if (/\/sales\/[^/]+/.test(url)) {
      return 'details';
    }
    return 'list';
  }

  private idFromUrl(url: string): string {
    return url.split('?')[0].split('/').pop() ?? '';
  }
}
