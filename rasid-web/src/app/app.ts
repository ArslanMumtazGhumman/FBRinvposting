import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { UiService } from './core/ui.service';
import { IconComponent } from './shared/icon.component';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <router-outlet />
    <div class="toasts" aria-live="polite">
      @for (t of ui.toasts(); track t.id) {
        <div class="toast" [class]="t.kind" role="status">
          <app-icon [name]="t.kind === 'error' ? 'alert' : t.kind === 'ok' ? 'check' : 'file'" />
          <span>{{ t.text }}</span>
          <button class="btn btn-ghost btn-icon btn-sm" (click)="ui.dismiss(t.id)" aria-label="Dismiss"><app-icon name="x" [size]="14" /></button>
        </div>
      }
    </div>`,
  styles: [`
    .toasts { position: fixed; right: 20px; bottom: 20px; display: flex; flex-direction: column; gap: 8px; z-index: 1000; }
    .toast { display: flex; align-items: center; gap: 10px; min-width: 280px; max-width: 420px; padding: 10px 10px 10px 14px;
      background: var(--ink); color: var(--paper); border-radius: var(--radius-s); box-shadow: var(--shadow-pop); font-size: var(--fs-s);
      animation: rise .18s ease-out; }
    .toast span { flex: 1; }
    .toast .btn { color: inherit; }
    .toast.error app-icon { color: #ff9b91; }
    .toast.ok app-icon { color: #7fd9b4; }
    @keyframes rise { from { transform: translateY(8px); opacity: 0; } }
  `],
})
export class App {
  protected ui = inject(UiService);
}
