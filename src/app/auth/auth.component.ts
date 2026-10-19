import { CommonModule } from '@angular/common';
import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { AuthService } from './auth.service';

@Component({
  selector: 'app-auth',
  imports: [CommonModule, FormsModule, RouterLink],
  templateUrl: './auth.component.html',
  styleUrl: './auth.component.css',
})
export class AuthComponent {
  protected readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  protected readonly name = signal('');
  protected readonly email = signal('');
  protected readonly password = signal('');
  protected readonly businessName = signal('');
  protected readonly errorMessage = signal('');
  protected readonly submitting = signal(false);

  protected get isRegister(): boolean {
    return this.router.url.startsWith('/register');
  }

  protected async submit(): Promise<void> {
    if (this.submitting()) {
      return;
    }
    this.errorMessage.set('');
    this.submitting.set(true);
    try {
      if (this.isRegister) {
        await this.auth.register(this.name(), this.email(), this.password(), this.businessName());
      } else {
        await this.auth.login(this.email(), this.password());
      }
      const returnUrl = this.route.snapshot.queryParamMap.get('returnUrl');
      await this.router.navigateByUrl(returnUrl?.startsWith('/') ? returnUrl : '/');
    } catch (error) {
      this.errorMessage.set(
        error instanceof HttpErrorResponse
          ? error.error?.message ?? 'Could not connect to DukaanOS. Check that the server is running.'
          : 'Unable to sign in right now. Please try again.',
      );
    } finally {
      this.submitting.set(false);
    }
  }
}
