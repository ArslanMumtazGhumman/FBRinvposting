/**
 * PRAL reference lists (Technical Specification v1.12, section 5): which
 * request fetches each one, and how Rasid reads the rows. PRAL's field names
 * have odd casing (hS_CODE, ratE_DESC), so fields are matched
 * case-insensitively; a casing change on their side won't empty a list.
 */

type Row = Record<string, unknown>;

/** One cacheable PRAL request. `params` (no date) and `asOf` form the cache key in ref_lists. */
export interface RefRequest {
  kind: 'provinces' | 'doctypecode' | 'uom' | 'itemdesccode' | 'transtypecode' | 'sroitemcode' | 'SaleTypeToRate' | 'HS_UOM' | 'SroSchedule' | 'SROItem';
  query: string;
  params: string;
  asOf: string;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** 2026-10-18 → 18-Oct-2026, the date format most PRAL reference APIs take. */
export const pralDate = (iso: string) => {
  const [y, m, d] = iso.split('-');
  return `${d}-${MONTHS[Number(m) - 1]}-${y}`;
};

/** Today in Pakistan, YYYY-MM-DD. */
export const todayPk = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi' }).format(now);

export const requests = {
  provinces: (): RefRequest => ({ kind: 'provinces', query: '', params: '', asOf: '' }),
  docTypes: (): RefRequest => ({ kind: 'doctypecode', query: '', params: '', asOf: '' }),
  uom: (): RefRequest => ({ kind: 'uom', query: '', params: '', asOf: '' }),
  sroItemCodes: (): RefRequest => ({ kind: 'sroitemcode', query: '', params: '', asOf: '' }),
  hsCodes: (): RefRequest => ({ kind: 'itemdesccode', query: '', params: '', asOf: '' }),
  transTypes: (): RefRequest => ({ kind: 'transtypecode', query: '', params: '', asOf: '' }),
  rates: (transTypeId: number, province: number, date: string): RefRequest => ({
    kind: 'SaleTypeToRate', query: `?date=${pralDate(date)}&transTypeId=${transTypeId}&originationSupplier=${province}`,
    params: `province=${province}&transTypeId=${transTypeId}`, asOf: date,
  }),
  /** annexure_id 3 = sales (spec 5.9). */
  hsUom: (hsCode: string): RefRequest => ({
    kind: 'HS_UOM', query: `?hs_code=${encodeURIComponent(hsCode)}&annexure_id=3`, params: `hs=${hsCode}`, asOf: '',
  }),
  sroSchedules: (rateId: number, province: number, date: string): RefRequest => ({
    kind: 'SroSchedule', query: `?rate_id=${rateId}&date=${pralDate(date)}&origination_supplier_csv=${province}`,
    params: `province=${province}&rateId=${rateId}`, asOf: date,
  }),
  /** SROItem takes an ISO date, unlike the others (spec 5.10). */
  sroItems: (sroId: number, date: string): RefRequest => ({
    kind: 'SROItem', query: `?date=${date}&sro_id=${sroId}`, params: `sroId=${sroId}`, asOf: date,
  }),
};

/* ---------------- reading rows ---------------- */

export const rowsOf = (json: unknown): Row[] =>
  Array.isArray(json) ? json.filter((r): r is Row => !!r && typeof r === 'object' && !Array.isArray(r)) : [];

function field(row: Row, name: string): unknown {
  if (Object.hasOwn(row, name)) return row[name];
  const lower = name.toLowerCase();
  const key = Object.keys(row).find(k => k.toLowerCase() === lower);
  return key === undefined ? undefined : row[key];
}
const str = (row: Row, name: string) => {
  const v = field(row, name);
  return v === null || v === undefined ? '' : String(v).trim();
};
const int = (row: Row, name: string) => {
  const v = field(row, name);
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isInteger(n) ? n : null;
};

export interface Province { code: number; desc: string }
export interface DocType { id: number; desc: string }
export interface Uom { id: number; description: string }
export interface HsCode { code: string; description: string }
export interface TransType { id: number; desc: string }
export interface Rate { id: number; desc: string; value: number | null }
export interface SroSchedule { id: number; serNo: number | null; desc: string }
export interface SroItem { id: number; desc: string }


export const toProvinces = (json: unknown): Province[] => rowsOf(json)
  .map(r => ({ code: int(r, 'stateProvinceCode'), desc: str(r, 'stateProvinceDesc') })).filter((p): p is Province => p.code !== null && p.desc !== '');
export const toDocTypes = (json: unknown): DocType[] => rowsOf(json)
  .map(r => ({ id: int(r, 'docTypeId'), desc: str(r, 'docDescription') })).filter((d): d is DocType => d.id !== null && d.desc !== '');
export const toUoms = (json: unknown): Uom[] => rowsOf(json)
  .map(r => ({ id: int(r, 'uoM_ID'), description: str(r, 'description') })).filter((u): u is Uom => u.id !== null && u.description !== '');
export const toHsCodes = (json: unknown): HsCode[] => rowsOf(json)
  .map(r => ({ code: str(r, 'hS_CODE'), description: str(r, 'description') })).filter(h => h.code !== '');
export const toTransTypes = (json: unknown): TransType[] => rowsOf(json)
  .map(r => ({ id: int(r, 'transactioN_TYPE_ID'), desc: str(r, 'transactioN_DESC') })).filter((t): t is TransType => t.id !== null && t.desc !== '');
export const toRates = (json: unknown): Rate[] => rowsOf(json).map(r => {
  const v = Number(field(r, 'ratE_VALUE'));
  return { id: int(r, 'ratE_ID'), desc: str(r, 'ratE_DESC'), value: Number.isFinite(v) ? v : null };
}).filter((x): x is Rate => x.id !== null && x.desc !== '');
export const toSroSchedules = (json: unknown): SroSchedule[] => rowsOf(json)
  .map(r => ({ id: int(r, 'srO_ID'), serNo: int(r, 'serNo'), desc: str(r, 'srO_DESC') })).filter((x): x is SroSchedule => x.id !== null);
export const toSroItems = (json: unknown): SroItem[] => rowsOf(json)
  .map(r => ({ id: int(r, 'srO_ITEM_ID'), desc: str(r, 'srO_ITEM_DESC') })).filter((x): x is SroItem => x.id !== null);

/** sroitemcode (spec 5.6) has the same fields as SROItem. */
export const toSroItemCodes = (json: unknown): SroItem[] => toSroItems(json);

/** Lookups with parameters (rates, HS→UOM, SRO) expire after REFERENCE_TTL_HOURS; plain lists change only nightly. */
export const isParameterised = (r: RefRequest) => r.params !== '';

/** Letters and digits only, lower case: "Processing/ Conversion of Goods" matches "Processing/Conversion of goods". */
export const looseKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
