import { HttpErrorResponse } from '@angular/common/http';

/** An API refusal with the server's own message (zod field issues included for 400s). */
export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string, readonly issues: { path: string; message: string }[] = []) {
    super(message);
  }
}

export function toApiError(e: unknown): ApiError {
  if (e instanceof ApiError) return e;
  if (e instanceof HttpErrorResponse) {
    const body = (e.error && typeof e.error === 'object' ? e.error : {}) as { message?: string; code?: string; issues?: { path: string; message: string }[] };
    const fallback = e.status === 0 ? 'Cannot reach Rasid. Check your connection and try again.'
      : e.status >= 500 ? 'Something went wrong on our side. Try again.'
      : `Request failed (${e.status}).`;
    return new ApiError(body.message ?? fallback, e.status, body.code, body.issues ?? []);
  }
  return new ApiError(e instanceof Error ? e.message : String(e), 0);
}

/** A message fit for a toast. */
export const errorMessage = (e: unknown, fallback = 'Something went wrong. Try again.') =>
  (e instanceof Error && e.message) || fallback;
