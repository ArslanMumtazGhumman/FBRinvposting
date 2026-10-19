/**
 * Rasid sale type → PRAL transaction type (sale_types table). The match is
 * made only when it's certain: exactly one transtypecode description equals
 * the sale type's name, compared on letters and digits ("Processing/ Conversion
 * of Goods" = "Processing/Conversion of goods"). No match, or several, leaves
 * trans_type_id empty with needs_review and a note; that sale type keeps its
 * bundled rates until an operator confirms a mapping (reference-cli map-sale-type).
 */
import { asc, isNotNull, isNull, sql } from 'drizzle-orm';
import { db, type Executor } from '../db/client.js';
import { saleTypes } from '../db/schema.js';
import { looseKey, type TransType } from './pral.js';

export interface SaleTypeMatch { transTypeId: number | null; pralDesc: string | null; needsReview: boolean; reviewNote: string }

export function matchSaleType(name: string, transTypes: TransType[]): SaleTypeMatch {
  const key = looseKey(name);
  const hits = [...new Map(transTypes.filter(t => looseKey(t.desc) === key).map(t => [t.id, t])).values()];
  if (hits.length === 1) return { transTypeId: hits[0]!.id, pralDesc: hits[0]!.desc, needsReview: false, reviewNote: '' };
  const reviewNote = hits.length
    ? `Several transaction types match: ${hits.map(t => `${t.id} "${t.desc}"`).join(', ')}.`
    : `No transaction type in transtypecode matches "${name}".`;
  return { transTypeId: null, pralDesc: null, needsReview: true, reviewNote };
}

/**
 * Matches every unconfirmed row against PRAL's transtypecode list and stores
 * the result. Rows an operator confirmed are left alone. Returns the names
 * that need review.
 */
export async function mapSaleTypes(transTypes: TransType[], executor: Executor = db): Promise<string[]> {
  if (!transTypes.length) return []; // no list to match against: keep what's stored
  const rows = await executor.select({ name: saleTypes.name }).from(saleTypes).where(isNull(saleTypes.confirmedAt));
  const review: string[] = [];
  const now = new Date();
  for (const { name } of rows) {
    const m = matchSaleType(name, transTypes);
    if (m.needsReview) review.push(name);
    await executor.update(saleTypes).set({ ...m, checkedAt: now, updatedAt: now })
      .where(sql`${saleTypes.name} = ${name} and ${saleTypes.confirmedAt} is null`);
  }
  return review.sort();
}

/** True until the automatic match has run once for every unconfirmed row (e.g. right after the seed). */
export async function saleTypesUnchecked(executor: Executor = db): Promise<boolean> {
  const [row] = await executor.select({ name: saleTypes.name }).from(saleTypes)
    .where(sql`${saleTypes.checkedAt} is null and ${saleTypes.confirmedAt} is null`).limit(1);
  return !!row;
}

/** Sale types with a PRAL transaction type; the rest keep bundled rates. */
export async function mappedSaleTypes(executor: Executor = db) {
  return executor.select({ name: saleTypes.name, transTypeId: saleTypes.transTypeId, pralDesc: saleTypes.pralDesc })
    .from(saleTypes).where(isNotNull(saleTypes.transTypeId)).orderBy(asc(saleTypes.name))
    .then(rows => rows.map(r => ({ name: r.name, transTypeId: r.transTypeId!, pralDesc: r.pralDesc ?? '' })));
}

export async function allSaleTypes(executor: Executor = db) {
  return executor.select().from(saleTypes).orderBy(asc(saleTypes.scenarioId));
}

export async function saleTypesNeedingReview(executor: Executor = db): Promise<string[]> {
  const rows = await executor.select({ name: saleTypes.name }).from(saleTypes).where(sql`${saleTypes.needsReview}`).orderBy(asc(saleTypes.name));
  return rows.map(r => r.name);
}
