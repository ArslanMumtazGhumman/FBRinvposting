import { Injectable, effect, signal } from '@angular/core';

export interface Toast { id: number; kind: 'ok' | 'error' | 'info'; text: string; }

/** Toasts + theme preference. */
@Injectable({ providedIn: 'root' })
export class UiService {
  readonly toasts = signal<Toast[]>([]);
  readonly theme = signal<'light' | 'dark' | 'system'>(this.loadTheme());
  private n = 0;

  constructor() {
    effect(() => {
      const t = this.theme();
      const root = document.documentElement;
      if (t === 'system') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', t);
      try { localStorage.setItem('rasid:theme', t); } catch { /* ignore */ }
    });
  }

  toast(text: string, kind: Toast['kind'] = 'ok', ms = 4000) {
    const id = ++this.n;
    this.toasts.update(l => [...l, { id, kind, text }]);
    setTimeout(() => this.dismiss(id), ms);
  }
  dismiss(id: number) { this.toasts.update(l => l.filter(t => t.id !== id)); }

  toggleTheme() {
    const dark = this.theme() === 'dark' || (this.theme() === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
    this.theme.set(dark ? 'light' : 'dark');
  }

  private loadTheme(): 'light' | 'dark' | 'system' {
    try { return (localStorage.getItem('rasid:theme') as 'light' | 'dark' | null) ?? 'system'; } catch { return 'system'; }
  }
}
