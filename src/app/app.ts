import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { filter } from 'rxjs';
import { AuthService } from './auth/auth.service';
import { SalesService } from './sales/sales.service';

@Component({
  selector: 'app-root',
  imports: [RouterLink, RouterLinkActive, RouterOutlet],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  protected readonly auth = inject(AuthService);
  private readonly sales = inject(SalesService);
  protected readonly isHome = signal(this.router.url === '/');

  constructor() {
    this.router.events
      .pipe(
        filter((event): event is NavigationEnd => event instanceof NavigationEnd),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((event) => this.isHome.set(event.urlAfterRedirects === '/'));
  }

  protected readonly currentDate = new Intl.DateTimeFormat('en-PK', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date());

  protected readonly fullDate = new Intl.DateTimeFormat('en-PK', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(new Date()).toUpperCase();

  protected get businessName(): string {
    return this.auth.currentUser()?.memberships?.[0]?.business.name ?? 'Your business';
  }

  protected get userName(): string {
    return this.auth.currentUser()?.name ?? 'Shop owner';
  }

  protected get userInitials(): string {
    return this.userName.split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase()).join('');
  }

  protected readonly inventorySummary = computed(() => {
    const products = this.sales.products();
    return {
      total: products.length,
      low: products.filter((product) =>
        product.stock > 0 && product.stock <= product.lowStockThreshold,
      ).length,
      out: products.filter((product) => product.stock === 0).length,
    };
  });
}
