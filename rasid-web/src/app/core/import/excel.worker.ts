/// <reference lib="webworker" />
/**
 * Parses spreadsheets off the main thread so 20k-row files never freeze the UI.
 * Input: { buffer: ArrayBuffer, sheet?: string }
 * Output: { sheets: string[], sheet: string, headers: string[], rows: Record<string, unknown>[] }
 */
import * as XLSX from 'xlsx';

addEventListener('message', ({ data }: MessageEvent<{ buffer: ArrayBuffer; sheet?: string }>) => {
  try {
    const wb = XLSX.read(data.buffer, { type: 'array', cellDates: true });
    const sheetName = data.sheet && wb.SheetNames.includes(data.sheet) ? data.sheet : wb.SheetNames[0];
    const ws = wb.Sheets[sheetName];
    const matrix = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, defval: '' });

    // Find the header row: first row within the top 15 with ≥3 non-empty text cells.
    let headerIdx = 0;
    for (let i = 0; i < Math.min(matrix.length, 15); i++) {
      const textCells = (matrix[i] ?? []).filter(c => typeof c === 'string' && c.trim().length > 0).length;
      if (textCells >= 3) { headerIdx = i; break; }
    }
    const rawHeaders = (matrix[headerIdx] ?? []).map((h, i) => String(h ?? '').trim() || `Column ${i + 1}`);
    // De-duplicate headers.
    const seen = new Map<string, number>();
    const headers = rawHeaders.map(h => {
      const n = (seen.get(h) ?? 0) + 1; seen.set(h, n);
      return n > 1 ? `${h} (${n})` : h;
    });

    const rows: Record<string, unknown>[] = [];
    for (let r = headerIdx + 1; r < matrix.length; r++) {
      const line = matrix[r] ?? [];
      if (line.every(c => c === '' || c === null || c === undefined)) continue;
      const obj: Record<string, unknown> = {};
      headers.forEach((h, i) => {
        const v = line[i];
        obj[h] = v instanceof Date
          ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`
          : v;
      });
      rows.push(obj);
    }
    postMessage({ sheets: wb.SheetNames, sheet: sheetName, headers, rows });
  } catch (e) {
    postMessage({ error: (e as Error).message || 'Could not read this file' });
  }
});
