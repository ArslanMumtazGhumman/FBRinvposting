/**
 * Minimal persistent store for development and single-node pilots:
 * one JSON file per collection, written atomically (tmp + rename).
 *
 * Production: replace with PostgreSQL (tables in the product plan) with
 * row-level security on business_id. The function signatures here are the
 * repository interface the routes depend on, so the swap is local to this file.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import type { Collections } from '../types/models.js';

type Name = keyof Collections;

fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
const cache = new Map<Name, unknown[]>();

function file(name: Name) { return path.join(config.dataDir, `${name}.json`); }

export function all<N extends Name>(name: N): Collections[N][] {
  if (!cache.has(name)) {
    const f = file(name);
    cache.set(name, fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : []);
  }
  return cache.get(name) as Collections[N][];
}

function flush(name: Name) {
  const tmp = file(name) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cache.get(name)), { mode: 0o600 });
  fs.renameSync(tmp, file(name));
}

export const find = <N extends Name>(name: N, pred: (row: Collections[N]) => boolean) => all(name).find(pred);
export const filter = <N extends Name>(name: N, pred: (row: Collections[N]) => boolean) => all(name).filter(pred);

export function insert<N extends Name>(name: N, row: Collections[N]) { all(name).push(row); flush(name); return row; }

/** Merges `row` into the first match; inserts it when there is none. */
export function upsert<N extends Name>(name: N, pred: (row: Collections[N]) => boolean, row: Partial<Collections[N]>) {
  const list = all(name);
  const i = list.findIndex(pred);
  if (i === -1) list.push(row as Collections[N]); else list[i] = { ...list[i]!, ...row };
  flush(name);
  return row;
}
