/// <reference lib="webworker" />
/**
 * Parses spreadsheets off the main thread so 20k-row files never freeze the UI.
 * Input: { buffer: ArrayBuffer, sheet?: string }
 * Output: ParsedSheet ({ sheets, sheet, headers, rows }) or { error }
 */
import { parseSheet } from './parse-sheet';

addEventListener('message', ({ data }: MessageEvent<{ buffer: ArrayBuffer; sheet?: string }>) => {
  try {
    postMessage(parseSheet(data.buffer, data.sheet));
  } catch (e) {
    postMessage({ error: (e as Error).message || 'Could not read this file' });
  }
});
