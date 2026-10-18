export const uid = (prefix = '') =>
  prefix + (crypto.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36)).replace(/-/g, '').slice(0, 16);

export const todayIso = () => {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};

export const nowIso = () => new Date().toISOString();

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export function formatPkr(n: number, decimals = 0): string {
  return (n ?? 0).toLocaleString('en-PK', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

/** Normalise a header / label for fuzzy comparison. */
export function norm(s: unknown): string {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9%]+/g, ' ').trim();
}

/** Levenshtein similarity 0..1 */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return 1 - prev[n] / Math.max(m, n);
}
