/**
 * PRAL Digital Invoicing API client (Technical Specification v1.12).
 * - Sandbox and production share hosts; the token decides routing, and
 *   post/validate use the "_sb" suffix in sandbox.
 * - Retries only transient failures (network, timeout, 5xx). Validation
 *   errors come back as HTTP 200 with statusCode "01" and are never retried.
 * - The token is passed in, used for one request and never logged.
 */
import { config } from '../config.js';

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
};
const RETRY_MS = [1000, 4000, 10000];

export class FbrHttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function once(method, url, token, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), config.fbrTimeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json; try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text.slice(0, 500) }; }
    if (res.status === 401) throw new FbrHttpError(401, 'FBR rejected the token (401).');
    if (res.status >= 500) throw new FbrHttpError(res.status, `FBR server error ${res.status}`);
    if (!res.ok) throw new FbrHttpError(res.status, `FBR returned ${res.status}`);
    return json;
  } catch (e) {
    if (e.name === 'AbortError') throw new FbrHttpError(-1, 'FBR did not respond in time');
    if (e instanceof FbrHttpError) throw e;
    throw new FbrHttpError(0, `Network error reaching FBR: ${e.message}`);
  } finally { clearTimeout(timer); }
}

/**
 * FBR has no idempotency key or lookup-by-reference, so a POST that timed out
 * may or may not have been recorded. For postinvoicedata we therefore retry
 * only when the request provably did not complete (connection failure, 502/503/504)
 * and surface timeouts as "unknown" for a human to check in IRIS before re-posting.
 */
async function call(method, path, token, body, { retry = true, safeToRepeat = true } = {}) {
  const url = config.fbrBaseUrl + path;
  for (let attempt = 0; ; attempt++) {
    const started = Date.now();
    try {
      const json = await once(method, url, token, body);
      return { json, attempt: attempt + 1, latencyMs: Date.now() - started };
    } catch (e) {
      const transient = safeToRepeat ? (e.status <= 0 || e.status >= 500) : (e.status === 0 || [502, 503, 504].includes(e.status));
      if (!retry || !transient || attempt >= RETRY_MS.length) { e.attempts = attempt + 1; throw e; }
      await new Promise(r => setTimeout(r, RETRY_MS[attempt]));
    }
  }
}

export const fbr = {
  post: (token, env, payload) => call('POST', PATHS.post + (env === 'sandbox' ? '_sb' : ''), token, payload, { safeToRepeat: false }),
  validate: (token, env, payload) => call('POST', PATHS.validate + (env === 'sandbox' ? '_sb' : ''), token, payload),
  reference: (token, kind, query = '') => {
    if (!PATHS[kind] || ['post', 'validate', 'statl', 'regType'].includes(kind)) throw new Error('Unknown reference list');
    return call('GET', PATHS[kind] + query, token);
  },
  regType: (token, registrationNo) => call('POST', PATHS.regType, token, { Registration_No: registrationNo }),
  statl: (token, regno, date) => call('POST', PATHS.statl, token, { regno, date }),
};
