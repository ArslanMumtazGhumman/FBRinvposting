import { HttpClient, HttpInterceptorFn } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../environments/environment';
import { User } from './models';
import { Store } from './store';
import { sleep } from './util';

/**
 * Session auth. The API issues an httpOnly, SameSite=strict session cookie
 * (JS cannot read it) plus a readable CSRF cookie echoed in a header.
 * No JWT is ever kept in localStorage.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private http = inject(HttpClient);
  private store = inject(Store);
  private router = inject(Router);

  async login(email: string, password: string, otp?: string): Promise<void> {
    if (!environment.useApi) {
      await sleep(400);
      if (password.length < 8) throw new Error('Password must be at least 8 characters.');
      const name = email.split('@')[0].replace(/[._]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      this.store.user.set({ id: 'u_demo', name: name || 'Demo user', email, role: 'owner' });
      return;
    }
    const user = await firstValueFrom(this.http.post<User>(`${environment.apiBaseUrl}/auth/login`, { email, password, otp }));
    this.store.user.set(user);
  }

  async logout() {
    if (environment.useApi) {
      try { await firstValueFrom(this.http.post(`${environment.apiBaseUrl}/auth/logout`, {})); } catch { /* ignore */ }
    }
    this.store.clear();
    this.router.navigateByUrl('/login');
  }
}

/** With the API, a page reload asks the server whether the session cookie is still valid. */
export const authGuard: CanActivateFn = async () => {
  const store = inject(Store);
  const router = inject(Router);
  return (await store.restoreSession()) ? true : router.parseUrl('/login');
};

/** Sends cookies to the API and echoes the CSRF token on state-changing requests. */
export const apiInterceptor: HttpInterceptorFn = (req, next) => {
  if (!req.url.startsWith(environment.apiBaseUrl)) return next(req);
  const csrf = document.cookie.split('; ').find(c => c.startsWith('rasid_csrf='))?.split('=')[1];
  const headers = csrf && req.method !== 'GET' ? req.headers.set('X-CSRF-Token', decodeURIComponent(csrf)) : req.headers;
  return next(req.clone({ withCredentials: true, headers }));
};
