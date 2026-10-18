/**
 * Runs the real Express app on an ephemeral port and signs users in through
 * /api/auth/login, so tests exercise cookies, CSRF and RLS end to end.
 * Import after startTestDb() (the app reads config at import time).
 */
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { TestDb } from './db.js';
import * as s from '../../src/db/schema.js';
import { createApp } from '../../src/app.js';
import { hashPassword } from '../../src/lib/auth.js';

export interface Res<T = any> { status: number; body: T; text: string }

export class Client {
  private cookies = new Map<string, string>();
  constructor(private base: string) {}

  async req<T = any>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res<T>> {
    const r = await fetch(this.base + path, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: {
        'Content-Type': 'application/json',
        Cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '),
        'X-CSRF-Token': this.cookies.get('rasid_csrf') ?? '',
        ...headers,
      },
    });
    for (const c of r.headers.getSetCookie()) {
      const [kv = ''] = c.split(';');
      const i = kv.indexOf('=');
      this.cookies.set(kv.slice(0, i), kv.slice(i + 1));
    }
    const text = await r.text();
    let parsed: unknown = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    return { status: r.status, body: parsed as T, text };
  }
  /** Reads a Server-Sent Events stream until it closes (or timeoutMs passes). */
  async events(path: string, timeoutMs = 20_000): Promise<{ status: number; events: { event: string; data: any }[] }> {
    const r = await fetch(this.base + path, {
      headers: { Accept: 'text/event-stream', Cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ') },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok || !r.body) return { status: r.status, events: [] };
    const events: { event: string; data: any }[] = [];
    let buf = '';
    for await (const chunk of r.body.pipeThrough(new TextDecoderStream())) {
      buf += chunk;
      let end;
      while ((end = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, end);
        buf = buf.slice(end + 2);
        const field = (name: string) => block.split('\n').find(l => l.startsWith(name + ': '))?.slice(name.length + 2);
        const event = field('event');
        const data = field('data');
        if (event && data) events.push({ event, data: JSON.parse(data) });
      }
    }
    return { status: r.status, events };
  }
  get = <T = any>(p: string) => this.req<T>('GET', p);
  post = <T = any>(p: string, b?: unknown, h?: Record<string, string>) => this.req<T>('POST', p, b ?? {}, h);
  put = <T = any>(p: string, b: unknown) => this.req<T>('PUT', p, b);
  del = <T = any>(p: string) => this.req<T>('DELETE', p);
}

export async function startApp(): Promise<{ base: string; server: Server; close(): Promise<void> }> {
  const server = createApp().listen(0);
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  return { base, server, close: () => new Promise(r => server.close(() => r())) };
}

export interface Fixture { tenantId: string; userId: string; businessId: string; email: string; password: string }

/** Tenant + user + business + membership, created as the owner (no TOTP, so login needs no code). */
export async function createTenant(tdb: TestDb, key: string, opts: { role?: s.Role; prefix?: string } = {}): Promise<Fixture> {
  const f = { tenantId: `t_${key}`, userId: `u_${key}`, businessId: `b_${key}`, email: `${key}@test.pk`, password: `password-${key}-123` };
  await tdb.admin.insert(s.tenants).values({ id: f.tenantId, name: key });
  await tdb.admin.insert(s.users).values({ id: f.userId, tenantId: f.tenantId, email: f.email, name: `User ${key}`, role: opts.role ?? 'owner', passwordHash: hashPassword(f.password) });
  await tdb.admin.insert(s.businesses).values({ id: f.businessId, tenantId: f.tenantId, name: `Biz ${key}`, ntnCnic: '1234567', province: 'Punjab', activity: 'Other', sector: 'Other', invoicePrefix: opts.prefix ?? 'INV-' });
  await tdb.admin.insert(s.memberships).values({ userId: f.userId, businessId: f.businessId, role: opts.role ?? 'owner' });
  return f;
}

export async function signIn(base: string, f: Pick<Fixture, 'email' | 'password'>): Promise<Client> {
  const c = new Client(base);
  const r = await c.post('/auth/login', { email: f.email, password: f.password });
  if (r.status !== 200) throw new Error(`login failed: ${r.status} ${r.text}`);
  return c;
}

/** A valid invoice body (InvoiceCreate) with one standard-rate line. */
export function invoiceBody(over: Record<string, unknown> = {}) {
  return {
    invoiceType: 'Sale Invoice',
    invoiceDate: '2026-10-01',
    buyer: { ntnCnic: '4410235', name: 'Metro Cash & Carry', province: 'Punjab', address: 'Lahore', registrationType: 'Registered' },
    items: [{
      hsCode: '1701.9910', productDescription: 'Refined sugar 50kg', rate: '18%', uoM: 'KG', quantity: 10, unitPrice: 155,
      totalValues: 1829, valueSalesExcludingST: 1550, fixedNotifiedValueOrRetailPrice: 0, salesTaxApplicable: 279,
      salesTaxWithheldAtSource: 0, extraTax: 0, furtherTax: 0, sroScheduleNo: '', fedPayable: 0, discount: 0,
      saleType: 'Goods at standard rate (default)', sroItemSerialNo: '',
    }],
    invoiceRefNo: '',
    environment: 'sandbox',
    ...over,
  };
}
