/**
 * PRAL Digital Invoicing API client (Technical Specification v1.12).
 * - Sandbox and production share hosts; the token decides routing, and
 *   post/validate use the "_sb" suffix in sandbox.
 * - Retries only transient failures (network, timeout, 5xx). Validation
 *   errors come back as HTTP 200 with statusCode "01" and are never retried.
 * - The token is passed in, used for one request and never logged.
 */
import { config } from '../config.js';
import type { FbrEnv } from '../types/models.js';

const PATHS = {
  post: '/di_data/v1/di/postinvoicedata',
  validate: '/di_data/v1/di/validateinvoicedata',
  provinces: '/pdi/v1/provinces',
  doctypecode: '/pdi/v1/doctypecode',
  itemdesccode: '/pdi/v1/itemdesccode',
  sroitemcode: '/pdi/v1/sroitemcode',
  transtypecode: '/pdi/v1/transtypecode',
  uom: '/pdi/v1/uom',
  SroSchedule: '/pdi/v1/SroSchedule',
  SaleTypeToRate: '/pdi/v2/SaleTypeToRate',
  HS_UOM: '/pdi/v2/HS_UOM',
  SROItem: '/pdi/v2/SROItem',
  statl: '/dist/v1/statl',
  regType: '/dist/v1/Get_Reg_Type',
} as const;
type PathKind = keyof typeof PATHS;
const RETRY_MS = [1000, 4000, 10000];

/** status: HTTP status, 0 = network failure, -1 = timed out. */
export class FbrHttpError extends Error {
  attempts?: number;
  constructor(readonly status: number, message: string) { super(message); }
}

// FBR responses are loosely shaped; callers read the fields they need.
export type FbrJson = any;
export interface FbrResult { json: FbrJson; attempt: number; latencyMs: number }

async function once(method: string, url: string, token: string, body: unknown, timeoutMs: number): Promise<FbrJson> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json: FbrJson; try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text.slice(0, 500) }; }
    if (res.status === 401) throw new FbrHttpError(401, 'FBR rejected the token (401).');
    if (res.status >= 500) throw new FbrHttpError(res.status, `FBR server error ${res.status}`);
    if (!res.ok) throw new FbrHttpError(res.status, `FBR returned ${res.status}`);
    return json;
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') throw new FbrHttpError(-1, 'FBR did not respond in time');
    if (e instanceof FbrHttpError) throw e;
    throw new FbrHttpError(0, `Network error reaching FBR: ${e instanceof Error ? e.message : String(e)}`);
  } finally { clearTimeout(timer); }
}

/**
 * FBR has no idempotency key or lookup-by-reference, so a POST that timed out
 * may or may not have been recorded. For postinvoicedata we therefore retry
 * only when the request provably did not complete (connection failure, 502/503/504)
 * and surface timeouts as "unknown" for a human to check in IRIS before re-posting.
 */
async function call(method: string, path: string, token: string, body?: unknown,
  { retry = true, safeToRepeat = true, timeoutMs = config.fbrTimeoutMs } = {}): Promise<FbrResult> {
  const url = config.fbrBaseUrl + path;
  for (let attempt = 0; ; attempt++) {
    const started = Date.now();
    try {
      const json = await once(method, url, token, body, timeoutMs);
      return { json, attempt: attempt + 1, latencyMs: Date.now() - started };
    } catch (err) {
      const e = err as FbrHttpError;
      const transient = safeToRepeat ? (e.status <= 0 || e.status >= 500) : (e.status === 0 || [502, 503, 504].includes(e.status));
      if (!retry || !transient || attempt >= RETRY_MS.length) { e.attempts = attempt + 1; throw e; }
      await new Promise(r => setTimeout(r, RETRY_MS[attempt]));
    }
  }
}

export const fbr = {
  post: (token: string, env: FbrEnv, payload: unknown) => call('POST', PATHS.post + (env === 'sandbox' ? '_sb' : ''), token, payload, { safeToRepeat: false }),
  validate: (token: string, env: FbrEnv, payload: unknown) => call('POST', PATHS.validate + (env === 'sandbox' ? '_sb' : ''), token, payload),
  /** Request-time lookups pass { retry: false, timeoutMs } so a slow FBR can't stall the page. */
  reference: (token: string, kind: string, query = '', opts: { retry?: boolean; timeoutMs?: number } = {}) => {
    if (!Object.hasOwn(PATHS, kind) || ['post', 'validate', 'statl', 'regType'].includes(kind)) throw new Error('Unknown reference list');
    return call('GET', PATHS[kind as PathKind] + query, token, undefined, opts);
  },
  regType: (token: string, registrationNo: string) => call('POST', PATHS.regType, token, { Registration_No: registrationNo }),
  statl: (token: string, regno: string, date: string) => call('POST', PATHS.statl, token, { regno, date }),
};
