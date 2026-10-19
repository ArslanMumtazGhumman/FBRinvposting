import { Injectable, InjectionToken, inject } from '@angular/core';

/** One cached reference response and when it was fetched (ms since epoch). */
export interface CacheEntry { at: number; value: unknown }

/** Where responses outlive the page. IndexedDB in the browser; tests pass their own. */
export interface ReferenceCacheBackend {
  get(key: string): Promise<CacheEntry | undefined>;
  set(key: string, entry: CacheEntry): Promise<void>;
}

/** IndexedDB store "responses" in database "rasid-reference". Any failure behaves like a miss. */
export class IndexedDbBackend implements ReferenceCacheBackend {
  private db?: Promise<IDBDatabase | null>;

  private open(): Promise<IDBDatabase | null> {
    this.db ??= new Promise(resolve => {
      try {
        const req = indexedDB.open('rasid-reference', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('responses');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      } catch { resolve(null); }
    });
    return this.db;
  }

  async get(key: string): Promise<CacheEntry | undefined> {
    const db = await this.open();
    if (!db) return undefined;
    return new Promise(resolve => {
      try {
        const req = db.transaction('responses').objectStore('responses').get(key);
        req.onsuccess = () => resolve(req.result as CacheEntry | undefined);
        req.onerror = () => resolve(undefined);
      } catch { resolve(undefined); }
    });
  }

  async set(key: string, entry: CacheEntry): Promise<void> {
    const db = await this.open();
    if (!db) return;
    await new Promise<void>(resolve => {
      try {
        const tx = db.transaction('responses', 'readwrite');
        tx.objectStore('responses').put(entry, key);
        tx.oncomplete = tx.onerror = tx.onabort = () => resolve();
      } catch { resolve(); }
    });
  }
}

export const REFERENCE_CACHE_BACKEND = new InjectionToken<ReferenceCacheBackend | null>('REFERENCE_CACHE_BACKEND', {
  providedIn: 'root',
  factory: () => (typeof indexedDB === 'undefined' ? null : new IndexedDbBackend()),
});

/** Reference responses are reused for 24 hours; the server refreshes PRAL nightly. */
export const REFERENCE_CACHE_TTL_MS = 24 * 3600_000;

/**
 * Memory, then IndexedDB, then the network. Only answers `keep` accepts are
 * stored (the reference service keeps PRAL data, not `source: "none"`), and
 * failed requests aren't cached, so they're tried again on the next read.
 */
@Injectable({ providedIn: 'root' })
export class ReferenceCache {
  private backend = inject(REFERENCE_CACHE_BACKEND);
  private memory = new Map<string, CacheEntry>();
  private pending = new Map<string, Promise<unknown>>();
  /** For tests. */
  now = () => Date.now();

  get<T>(key: string, load: () => Promise<T>, keep: (value: T) => boolean): Promise<T> {
    const fresh = (e?: CacheEntry) => !!e && this.now() - e.at < REFERENCE_CACHE_TTL_MS;
    const mem = this.memory.get(key);
    if (fresh(mem)) return Promise.resolve(mem!.value as T);
    let p = this.pending.get(key) as Promise<T> | undefined;
    if (!p) {
      p = (async () => {
        const stored = await this.backend?.get(key).catch(() => undefined);
        if (fresh(stored)) { this.memory.set(key, stored!); return stored!.value as T; }
        const value = await load();
        if (keep(value)) {
          const entry = { at: this.now(), value };
          this.memory.set(key, entry);
          await this.backend?.set(key, entry).catch(() => undefined);
        }
        return value;
      })().finally(() => this.pending.delete(key));
      this.pending.set(key, p);
    }
    return p;
  }
}
