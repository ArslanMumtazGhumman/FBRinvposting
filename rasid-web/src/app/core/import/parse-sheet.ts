import * as XLSX from 'xlsx';

export interface ParsedSheet {
  sheets: string[];
  sheet: string;
  headers: string[];
  rows: Record<string, unknown>[];
}

/**
 * Reads a workbook into header-keyed rows (run by excel.worker.ts, off the main thread).
 * The header row is the first of the top 15 with at least 3 text cells, so title rows above
 * the table are skipped. Duplicate headers get " (2)", " (3)"; empty rows are dropped;
 * real Excel dates become YYYY-MM-DD.
 */
export function parseSheet(buffer: ArrayBuffer, sheet?: string): ParsedSheet {
  const wb = XLSX.read(buffer, { type: 'array', cellDates: true });
  const sheetName = sheet && wb.SheetNames.includes(sheet) ? sheet : wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, defval: '' });

  let headerIdx = 0;
  for (let i = 0; i < Math.min(matrix.length, 15); i++) {
    const textCells = (matrix[i] ?? []).filter(c => typeof c === 'string' && c.trim().length > 0).length;
    if (textCells >= 3) { headerIdx = i; break; }
  }
  const rawHeaders = (matrix[headerIdx] ?? []).map((h, i) => String(h ?? '').trim() || `Column ${i + 1}`);
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
  return { sheets: wb.SheetNames, sheet: sheetName, headers, rows };
}
