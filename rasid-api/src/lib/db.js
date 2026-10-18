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

fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
const cache = new Map();

function file(name) { return path.join(config.dataDir, `${name}.json`); }

export function all(name) {
  if (!cache.has(name)) {
    const f = file(name);
    cache.set(name, fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : []);
  }
  return cache.get(name);
}

function flush(name) {
  const tmp = file(name) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cache.get(name)), { mode: 0o600 });
  fs.renameSync(tmp, file(name));
}

export const find = (name, pred) => all(name).find(pred);
export const filter = (name, pred) => all(name).filter(pred);

export function insert(name, row) { all(name).push(row); flush(name); return row; }

export function upsert(name, pred, row) {
  const list = all(name);
  const i = list.findIndex(pred);
  if (i === -1) list.push(row); else list[i] = { ...list[i], ...row };
  flush(name);
  return row;
}
