import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService } from '../../core/auth';
import { environment } from '../../../environments/environment';

@Component({
  selector: 'app-login',
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <div class="wrap">
    <section class="pitch" aria-hidden="true">
      <div class="brand"><span class="mark">ر</span> Rasid</div>
      <div class="sheet">
        <div class="sheet-row head"><span>Invoice</span><span>Buyer</span><span class="num">Value</span><span>FBR</span></div>
        <div class="sheet-row"><span>ANT-01041</span><span>Metro Cash & Carry</span><span class="num">48,360</span><span class="ok">Posted</span></div>
        <div class="sheet-row"><span>ANT-01042</span><span>Imtiaz Super Market</span><span class="num">112,200</span><span class="ok">Posted</span></div>
        <div class="sheet-row"><span>ANT-01043</span><span>Hamid & Sons</span><span class="num">27,900</span><span class="ok">Posted</span></div>
        <div class="stamp big">
          <span class="stamp-label">FBR Digital Invoice</span>
          <span class="stamp-no">1234567DI1792305239</span>
          <span class="stamp-date">Verified 17 Oct 2026</span>
        </div>
      </div>
      <h2>Your Excel sheet in. FBR numbers out.</h2>
      <p>Map any sheet layout once, fix rejections on the exact cell, and post hundreds of invoices to FBR Digital Invoicing in one go.</p>
    </section>

    <section class="form-side">
      <form class="card" (ngSubmit)="submit()" #f="ngForm">
        <div class="brand mobile-brand"><span class="mark">ر</span> Rasid</div>
        <h1>Sign in</h1>
        <p class="muted">Use your work email.</p>

        <div class="field">
          <label for="email">Email</label>
          <input id="email" class="input" type="email" name="email" [(ngModel)]="email" required autocomplete="username" />
        </div>
        <div class="field">
          <label for="pw">Password</label>
          <input id="pw" class="input" type="password" name="password" [(ngModel)]="password" required minlength="8" autocomplete="current-password" />
        </div>
        @if (needOtp()) {
          <div class="field">
            <label for="otp">Authenticator code</label>
            <input id="otp" class="input" inputmode="numeric" maxlength="6" name="otp" [(ngModel)]="otp" autocomplete="one-time-code" />
          </div>
        }
        @if (error()) { <div class="banner danger" role="alert">{{ error() }}</div> }
        <button class="btn btn-primary full" [disabled]="busy() || f.invalid">{{ busy() ? 'Signing in…' : 'Sign in' }}</button>
        @if (demo) {
          <p class="subtle">Demo build: any email and a password of 8+ characters signs you in with sample data.</p>
        }
      </form>
    </section>
  </div>`,
  styles: [`
    .wrap { min-height: 100vh; display: grid; grid-template-columns: 1.1fr 1fr; }
    .pitch { background: var(--sidebar); color: #c9d6cf; padding: 48px 56px; display: flex; flex-direction: column; justify-content: center; gap: 24px; }
    .brand { display: flex; align-items: center; gap: 10px; color: #fff; font-weight: 800; font-size: 1.4rem; }
    .mark { width: 36px; height: 36px; display: grid; place-items: center; border-radius: 8px; background: var(--accent); font-size: 22px; padding-bottom: 4px; }
    .pitch h2 { color: #fff; font-size: 2rem; font-weight: 800; max-width: 18ch; letter-spacing: -0.02em; }
    .pitch p { max-width: 46ch; font-size: var(--fs-m); }
    .sheet { position: relative; background: #f6f7f5; color: #14211c; border-radius: 10px; padding: 8px 0 28px; max-width: 520px; font-size: var(--fs-s); }
    .sheet-row { display: grid; grid-template-columns: 90px 1fr 80px 70px; gap: 12px; padding: 8px 16px; border-bottom: 1px solid #dde3df; }
    .sheet-row.head { font-weight: 700; color: #4a5a53; }
    .ok { color: #0b6e4f; font-weight: 700; }
    .stamp.big { position: absolute; right: -18px; bottom: -26px; background: #f6f7f5; --stamp: #2b4fa8; transform: rotate(-6deg); }
    .form-side { display: grid; place-items: center; padding: 32px 20px; }
    .card { width: 100%; max-width: 380px; display: flex; flex-direction: column; gap: 16px; }
    .full { width: 100%; height: 42px; }
    .mobile-brand { display: none; color: var(--ink); }
    @media (max-width: 900px) { .wrap { grid-template-columns: 1fr; } .pitch { display: none; } .mobile-brand { display: flex; margin-bottom: 12px; } .mobile-brand .mark { color: #fff; } }
  `],
})
export class LoginComponent {
  private auth = inject(AuthService);
  private router = inject(Router);
  protected demo = !environment.useApi;
  protected email = '';
  protected password = '';
  protected otp = '';
  protected busy = signal(false);
  protected error = signal('');
  protected needOtp = signal(false);

  async submit() {
    this.busy.set(true); this.error.set('');
    try {
      await this.auth.login(this.email.trim(), this.password, this.otp || undefined);
      this.router.navigateByUrl('/dashboard');
    } catch (e: unknown) {
      const msg = (e as { error?: { code?: string; message?: string }; message?: string });
      if (msg.error?.code === 'OTP_REQUIRED') { this.needOtp.set(true); this.error.set('Enter the 6-digit code from your authenticator app.'); }
      else this.error.set(msg.error?.message ?? msg.message ?? 'Email or password is incorrect.');
    } finally { this.busy.set(false); }
  }
}
