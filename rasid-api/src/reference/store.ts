/**
 * Reference cache in Postgres (ref_lists, hs_codes). These tables hold the
 * same data for every tenant and have no RLS, so they're read and written
 * outside withBusiness().
 */
import { and, asc, count, desc, eq, lt, lte, max, ne, sql } from 'drizzle-orm';
import { db, type Executor } from '../db/client.js';
import { hsCodes, refLists, type ReferenceSource } from '../db/schema.js';
import type { HsCode, RefRequest } from './pral.js';

export interface CachedList { data: unknown[]; asOf: string; fetchedAt: Date; sourceEnv: ReferenceSource }

const key = (r: RefRequest) => and(eq(refLists.kind, r.kind), eq(refLists.params, r.params));
const cols = { data: refLists.data, asOf: refLists.asOf, fetchedAt: refLists.fetchedAt, sourceEnv: refLists.sourceEnv };

export async function readList(r: RefRequest): Promise<CachedList | null> {
  const [row] = await db.select(cols).from(refLists).where(and(key(r), eq(refLists.asOf, r.asOf)));
  return row ?? null;
}

/** For dated lists: the newest copy on or before r.asOf, else the newest of all. */
export async function readNearest(r: RefRequest): Promise<CachedList | null> {
  const [before] = await db.select(cols).from(refLists).where(and(key(r), lte(refLists.asOf, r.asOf)))
    .orderBy(desc(refLists.asOf)).limit(1);
  if (before) return before;
  const [any] = await db.select(cols).from(refLists).where(key(r)).orderBy(desc(refLists.asOf)).limit(1);
  return any ?? null;
}

/**
 * Stores PRAL's answer. An empty answer never replaces a non-empty copy (FBR
 * has returned [] while degraded); it's stored only when nothing was cached.
 * Returns false when the cached copy was kept.
 */
export async function writeList(r: RefRequest, data: unknown[], sourceEnv: ReferenceSource, executor: Executor = db) {
  const fetchedAt = new Date();
  const rows = await executor.insert(refLists).values({ kind: r.kind, params: r.params, asOf: r.asOf, data, fetchedAt, sourceEnv })
    .onConflictDoUpdate({
      target: [refLists.kind, refLists.params, refLists.asOf],
      set: { data, fetchedAt, sourceEnv },
      setWhere: sql`jsonb_array_length(excluded.data) > 0 or jsonb_array_length(${refLists.data}) = 0`,
    }).returning({ kind: refLists.kind });
  return rows.length > 0;
}

/** `params` of every cached copy of a kind (for HS_UOM: the HS codes people have looked up). */
export async function cachedParams(kind: RefRequest['kind']): Promise<string[]> {
  const rows = await db.selectDistinct({ params: refLists.params }).from(refLists).where(eq(refLists.kind, kind));
  return rows.map(r => r.params);
}

/** Drops dated copies older than `beforeIso`. Undated lists ('' as_of) are kept. */
export async function pruneDated(beforeIso: string) {
  const gone = await db.delete(refLists).where(and(ne(refLists.asOf, ''), lt(refLists.asOf, beforeIso))).returning({ kind: refLists.kind });
  return gone.length;
}

/** Makes hs_codes equal to `list` in one transaction: upserts in chunks, then removes codes PRAL no longer lists. */
export async function replaceHsCodes(list: HsCode[], sourceEnv: ReferenceSource) {
  const seen = new Map(list.map(h => [h.code, h])); // PRAL has been known to repeat a code
  const rows = [...seen.values()];
  await db.transaction(async tx => {
    const runAt = new Date((await tx.execute<{ now: string }>(sql`select now()::text as now`))[0]!.now);
    for (let i = 0; i < rows.length; i += 1000) {
      await tx.insert(hsCodes).values(rows.slice(i, i + 1000).map(h => ({ ...h, fetchedAt: runAt, sourceEnv })))
        .onConflictDoUpdate({ target: hsCodes.code, set: { description: sql`excluded.description`, fetchedAt: runAt, sourceEnv } });
    }
    await tx.delete(hsCodes).where(lt(hsCodes.fetchedAt, runAt));
  });
  return rows.length;
}

export async function hsCodeCount() {
  const [row] = await db.select({ n: count() }).from(hsCodes);
  return row?.n ?? 0;
}

/**
 * Digits (with or without the dot) match the start of the code: "1701", "1701.99", "170199".
 * Otherwise every word must start a word of the code or description (tsvector, "simple"
 * config: "sug" finds "SUGAR"), best match first.
 */
export async function searchHsCodes(q: string, limit: number): Promise<HsCode[]> {
  const digits = q.trim().replace(/\./g, '');
  // Only letters and digits reach to_tsquery, so its operators (& | ! : *) can't be injected.
  const words = q.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).slice(0, 6);
  const query = db.select({ code: hsCodes.code, description: hsCodes.description }).from(hsCodes).limit(limit);
  if (/^\d+$/.test(digits)) {
    const byCode = sql`replace(${hsCodes.code}, '.', '') like ${digits + '%'}`;
    return query.where(byCode).orderBy(asc(hsCodes.code));
  }
  if (!words.length) return [];
  const tsq = sql`to_tsquery('simple', ${words.map(w => w + ':*').join(' & ')})`;
  return query.where(sql`${hsCodes.search} @@ ${tsq}`).orderBy(sql`ts_rank(${hsCodes.search}, ${tsq}) desc`, asc(hsCodes.code));
}

/** Per kind: how many cached copies and when the newest was fetched. */
export async function cacheStatus() {
  const lists = await db.select({ kind: refLists.kind, copies: count(), fetchedAt: max(refLists.fetchedAt) })
    .from(refLists).groupBy(refLists.kind).orderBy(refLists.kind);
  const [hs] = await db.select({ n: count(), fetchedAt: max(hsCodes.fetchedAt) }).from(hsCodes);
  return { lists, hsCodes: { count: hs?.n ?? 0, fetchedAt: hs?.fetchedAt ?? null } };
}
