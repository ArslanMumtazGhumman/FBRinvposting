import { ChangeDetectionStrategy, Component, HostListener, computed, inject, signal } from '@angular/core';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { AuthService } from '../core/auth';
import { StoreService } from '../core/store.service';
import { UiService } from '../core/ui.service';
import { IconComponent } from '../shared/icon.component';

@Component({
  selector: 'app-shell',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <div class="shell" [class.nav-open]="navOpen()">
    <aside class="side" aria-label="Main navigation">
      <div class="brand">
        <span class="mark" aria-hidden="true">ر</span>
        <span class="word">Rasid</span>
      </div>

      <label class="biz">
        <span class="sr-only">Active business</span>
        <select [value]="store.business()?.id" (change)="switchBiz($any($event.target).value)">
          @for (b of store.businesses(); track b.id) { <option [value]="b.id">{{ b.name }}</option> }
        </select>
        <small>NTN {{ store.business()?.ntnCnic }}</small>
      </label>

      <nav>
        <a routerLink="/invoices/new" class="new-btn"><app-icon name="plus" /> New invoice</a>
        @for (n of nav; track n.path) {
          <a [routerLink]="n.path" routerLinkActive="active" [routerLinkActiveOptions]="{ exact: n.exact ?? false }" (click)="navOpen.set(false)">
            <app-icon [name]="n.icon" /> <span>{{ n.label }}</span>
            @if (n.path === '/invoices' && failedCount()) { <em class="count">{{ failedCount() }}</em> }
          </a>
        }
      </nav>

      <div class="side-foot">
        <button class="env" [class.prod]="isProd()" (click)="router.navigateByUrl('/settings')" title="Change FBR environment in Settings">
          <i></i>{{ isProd() ? 'Production' : 'Sandbox' }}
        </button>
        <div class="me">
          <div class="avatar">{{ initials() }}</div>
          <div class="who"><b>{{ store.user()?.name }}</b><small>{{ store.user()?.role }}</small></div>
          <button class="ibtn" (click)="ui.toggleTheme()" aria-label="Toggle dark mode"><app-icon name="moon" [size]="16" /></button>
          <button class="ibtn" (click)="auth.logout()" aria-label="Sign out"><app-icon name="logout" [size]="16" /></button>
        </div>
      </div>
    </aside>

    <div class="scrim" (click)="navOpen.set(false)"></div>

    <div class="main">
      <header class="topbar no-print">
        <button class="btn btn-ghost btn-icon" (click)="navOpen.set(true)" aria-label="Open menu"><app-icon name="menu" /></button>
        <span class="word">Rasid</span>
        <span class="spacer"></span>
        <span class="env-pill" [class.prod]="isProd()">{{ isProd() ? 'Production' : 'Sandbox' }}</span>
      </header>
      @if (!isProd()) {
        <div class="sandbox-strip no-print">Sandbox mode — invoices go to FBR's test system and are not legally issued.</div>
      }
      <main id="content"><router-outlet /></main>
    </div>
  </div>`,
  styles: [`
    .shell { display: grid; grid-template-columns: 248px 1fr; min-height: 100vh; }
    .side { position: sticky; top: 0; height: 100vh; display: flex; flex-direction: column; gap: 18px;
      background: var(--sidebar); color: var(--sidebar-ink); padding: 20px 14px; overflow-y: auto; }
    .brand { display: flex; align-items: center; gap: 10px; padding: 0 6px; }
    .mark { width: 32px; height: 32px; display: grid; place-items: center; border-radius: 8px;
      background: var(--accent); color: #fff; font-size: 20px; font-weight: 700; line-height: 1; padding-bottom: 4px; }
    .word { font-weight: 800; font-size: 1.25rem; color: #fff; letter-spacing: -0.02em; }
    .biz { display: flex; flex-direction: column; gap: 4px; padding: 10px; border-radius: var(--radius-s); background: var(--sidebar-active); }
    .biz select { background: transparent; color: #fff; border: 0; font: 600 var(--fs-s) var(--font); width: 100%; cursor: pointer; }
    .biz select option { color: #14211c; }
    .biz small { color: var(--sidebar-ink); opacity: .8; font-size: var(--fs-xs); }
    nav { display: flex; flex-direction: column; gap: 2px; }
    nav a { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: var(--radius-s);
      color: var(--sidebar-ink); text-decoration: none; font-size: var(--fs-s); font-weight: 500; }
    nav a:hover { background: var(--sidebar-active); color: #fff; }
    nav a.active { background: var(--sidebar-active); color: #fff; box-shadow: inset 3px 0 0 var(--accent); }
    nav a span { flex: 1; }
    .new-btn { background: var(--accent); color: var(--accent-ink) !important; font-weight: 600 !important; margin-bottom: 10px; justify-content: center; }
    .new-btn:hover { background: var(--accent-hover) !important; }
    .count { font-style: normal; font-size: 11px; font-weight: 700; background: #b42318; color: #fff; border-radius: 999px; padding: 0 7px; }
    .side-foot { margin-top: auto; display: flex; flex-direction: column; gap: 12px; }
    .env { display: flex; align-items: center; gap: 8px; border: 1px solid #3a4f45; background: transparent; color: #f0c674;
      border-radius: var(--radius-s); padding: 7px 10px; font: 600 var(--fs-xs) var(--font); cursor: pointer; }
    .env i { width: 8px; height: 8px; border-radius: 50%; background: currentColor; }
    .env.prod { color: #7fd9b4; }
    .me { display: flex; align-items: center; gap: 8px; }
    .avatar { width: 32px; height: 32px; border-radius: 50%; background: #2c463b; color: #fff; display: grid; place-items: center; font-size: 12px; font-weight: 700; }
    .who { flex: 1; min-width: 0; display: flex; flex-direction: column; }
    .who b { color: #fff; font-size: var(--fs-s); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .who small { font-size: 11px; text-transform: capitalize; }
    .ibtn { border: 0; background: transparent; color: var(--sidebar-ink); padding: 6px; border-radius: 6px; cursor: pointer; }
    .ibtn:hover { background: var(--sidebar-active); color: #fff; }
    .main { min-width: 0; }
    .topbar { display: none; }
    .sandbox-strip { background: var(--warn-soft); color: var(--warn); font-size: var(--fs-xs); font-weight: 600; padding: 6px 32px; }
    .scrim { display: none; }
    @media (max-width: 900px) {
      .shell { grid-template-columns: 1fr; }
      .side { position: fixed; z-index: 50; left: 0; width: 272px; transform: translateX(-100%); transition: transform .2s ease; }
      .nav-open .side { transform: none; }
      .nav-open .scrim { display: block; position: fixed; inset: 0; background: rgba(0,0,0,.4); z-index: 40; }
      .topbar { display: flex; align-items: center; gap: 8px; padding: 8px 12px; background: var(--surface); border-bottom: 1px solid var(--line); position: sticky; top: 0; z-index: 30; }
      .topbar .word { color: var(--ink); }
      .sandbox-strip { padding: 6px 16px; }
    }
    .env-pill { font-size: var(--fs-xs); font-weight: 700; color: var(--warn); background: var(--warn-soft); padding: 2px 8px; border-radius: 999px; }
    .env-pill.prod { color: var(--accent); background: var(--accent-soft); }
    @media print { .shell { display: block; } .side, .sandbox-strip { display: none; } }
  `],
})
export class ShellComponent {
  protected store = inject(StoreService);
  protected ui = inject(UiService);
  protected auth = inject(AuthService);
  protected router = inject(Router);
  protected navOpen = signal(false);

  protected nav = [
    { path: '/dashboard', label: 'Dashboard', icon: 'home', exact: true },
    { path: '/invoices', label: 'Invoices', icon: 'file', exact: true },
    { path: '/import', label: 'Bulk import', icon: 'upload' },
    { path: '/customers', label: 'Customers', icon: 'users' },
    { path: '/products', label: 'Products', icon: 'box' },
    { path: '/scenarios', label: 'Sandbox scenarios', icon: 'flask' },
    { path: '/settings', label: 'Settings', icon: 'settings' },
  ];

  protected isProd = computed(() => this.store.business()?.environment === 'production');
  protected failedCount = computed(() => this.store.bizInvoices().filter(i => i.status === 'failed').length);
  protected initials = computed(() => (this.store.user()?.name ?? '?').split(' ').map(s => s[0]).slice(0, 2).join('').toUpperCase());

  switchBiz(id: string) { this.store.activeBusinessId.set(id); }

  @HostListener('document:keydown', ['$event'])
  onKey(e: KeyboardEvent) {
    if (e.altKey && e.key.toLowerCase() === 'n') { e.preventDefault(); this.router.navigateByUrl('/invoices/new'); }
    if (e.altKey && e.key.toLowerCase() === 'i') { e.preventDefault(); this.router.navigateByUrl('/import'); }
  }
}
