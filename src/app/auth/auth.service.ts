import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../environments/environment';

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  createdAt: string;
  memberships?: Array<{
    id: string;
    role: 'OWNER' | 'ADMIN' | 'STAFF';
    business: { id: string; name: string; phone: string | null; address: string | null };
  }>;
}

interface AuthResponse {
  accessToken: string;
  tokenType: 'Bearer';
  user: AuthUser;
}

const TOKEN_KEY = 'dukaanos.access-token';

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  private initialized = false;
  readonly currentUser = signal<AuthUser | null>(null);
  readonly error = signal('');

  get isAuthenticated(): boolean {
    return this.currentUser() !== null;
  }

  get accessToken(): string | null {
    return typeof localStorage === 'undefined' ? null : localStorage.getItem(TOKEN_KEY);
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    this.initialized = true;
    if (!this.accessToken) {
      return;
    }

    try {
      await this.loadCurrentUser();
    } catch (error) {
      if (error instanceof HttpErrorResponse && (error.status === 401 || error.status === 403)) {
        this.clearSession();
        return;
      }
      this.error.set('Could not verify your session. Make sure the DukaanOS server is available and try again.');
      console.error('Failed to restore the DukaanOS session.', error);
    }
  }

  async login(email: string, password: string): Promise<void> {
    await this.authenticate('login', { email, password });
  }

  async register(name: string, email: string, password: string, businessName: string): Promise<void> {
    await this.authenticate('register', { name, email, password, businessName });
  }

  async logout(): Promise<void> {
    this.clearSession();
    await this.router.navigateByUrl('/login');
  }

  expireSession(): void {
    this.clearSession();
    void this.router.navigateByUrl('/login');
  }

  private async authenticate(path: string, body: object): Promise<void> {
    this.error.set('');
    const response = await firstValueFrom(
      this.http.post<AuthResponse>(`${environment.apiUrl}/auth/${path}`, body),
    );
    localStorage.setItem(TOKEN_KEY, response.accessToken);
    try {
      await this.loadCurrentUser();
    } catch (error) {
      this.clearSession();
      throw error;
    }
  }

  private async loadCurrentUser(): Promise<void> {
    const user = await firstValueFrom(
      this.http.get<AuthUser>(`${environment.apiUrl}/auth/me`),
    );
    this.currentUser.set(user);
  }

  private clearSession(): void {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(TOKEN_KEY);
    }
    this.currentUser.set(null);
  }
}
