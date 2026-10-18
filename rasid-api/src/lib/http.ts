/** Small helpers shared by the route modules. */
import type { Request, Response } from 'express';
import type { z } from 'zod';
import { withBusiness, type Tx } from '../db/client.js';

export interface FieldError { path: string; message: string }

/** Parses `data` with `schema`; on failure sends 400 with per-field messages and returns undefined. */
export function parse<S extends z.ZodType>(schema: S, data: unknown, res: Response): z.infer<S> | undefined {
  const r = schema.safeParse(data);
  if (r.success) return r.data;
  const issues: FieldError[] = r.error.issues.slice(0, 50).map(i => ({ path: i.path.join('.'), message: i.message }));
  res.status(400).json({ code: 'VALIDATION', message: issues[0]?.message ?? 'Check the highlighted fields.', issues });
  return undefined;
}

/** Same as parse(), without responding: for bulk rows that are reported individually. */
export function check<S extends z.ZodType>(schema: S, data: unknown): { ok: true; value: z.infer<S> } | { ok: false; issues: FieldError[] } {
  const r = schema.safeParse(data);
  return r.success
    ? { ok: true, value: r.data }
    : { ok: false, issues: r.error.issues.slice(0, 20).map(i => ({ path: i.path.join('.'), message: i.message })) };
}

/** Business id from a route mounted under /api/businesses/:businessId. */
export const businessIdOf = (req: Request) => String((req.params as Record<string, string>).businessId);

/** Runs fn in the request's business context (RLS: this business, while the user is a member). */
export const inBusiness = <T>(req: Request, fn: (tx: Tx) => Promise<T>) => withBusiness(req.user.id, businessIdOf(req), fn);

/** SQLSTATE of a Postgres error, unwrapping Drizzle's query wrapper. */
export function pgCode(e: unknown): string | undefined {
  const err = e as { code?: unknown; cause?: { code?: unknown } };
  const code = typeof err?.cause?.code === 'string' ? err.cause.code : err?.code;
  return typeof code === 'string' ? code : undefined;
}

export const PG = { uniqueViolation: '23505', checkViolation: '23514', foreignKeyViolation: '23503' } as const;

export const notFound = (res: Response, what: string) => res.status(404).json({ code: 'NOT_FOUND', message: `${what} not found.` });

/** A single route parameter as a string (Express 5 types allow string[] for wildcards). */
export const param = (req: Request, name: string) => String((req.params as Record<string, unknown>)[name] ?? '');
