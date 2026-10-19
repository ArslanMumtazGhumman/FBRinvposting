import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, throwError } from 'rxjs';
import { environment } from '../../environments/environment';
import { AuthService } from './auth.service';

export const authInterceptor: HttpInterceptorFn = (request, next) => {
  const auth = inject(AuthService);
  const token = auth.accessToken;
  if (!token || !request.url.startsWith(environment.apiUrl)) {
    return next(request);
  }
  return next(request.clone({
    setHeaders: { Authorization: `Bearer ${token}` },
  })).pipe(catchError((error: unknown) => {
    if (error instanceof HttpErrorResponse && error.status === 401
      && !request.url.endsWith('/auth/login') && !request.url.endsWith('/auth/register')) {
      auth.expireSession();
    }
    return throwError(() => error);
  }));
};
