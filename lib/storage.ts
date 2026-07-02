// localStorage-backed run history with quota handling.
//
// Why localStorage and not IndexedDB? IndexedDB is the "right" answer for
// multi-MB data, but it adds a lot of complexity (async, transactions, schema
// migrations) for a feature the user asked for. localStorage is sync, simple,
// and good enough for "the last 50 OCR runs" — a typical entry is 10-50 KB
// of structured result JSON, so we can fit ~100-200 runs in the typical
// 5-10 MB browser quota. We auto-trim the oldest when we get close to the
// limit so the user never sees a quota error mid-session.

import type { DocumentResult, OcrImageResponse, TableResult } from '@/types/api';

export type TabKind = 'document' | 'translated' | 'ocr' | 'table' | 'history';

/** Settings snapshot — captured at run time so the run is fully reproducible. */
export interface RunSettings {
  // Common
  useCtc?: boolean;
  concurrency?: number;
  // Document + Translated
  detectLayout?: boolean;
  detectLines?: boolean;
  // Translated
  sourceLang?: string;
  targetLang?: string;
  // Table
  rowTolerance?: number;
  // Document (PDF)
  pdfRange?: string;
  pdfDpi?: number;
  // Image enhancement (one entry per file)
  enhanceByFile?: Record<string, unknown>;
}

export interface StoredRun {
  id: string;
  /** Unix ms when the run completed. */
  timestamp: number;
  tab: TabKind;
  /** Original filename, as reported by the API. */
  filename: string;
  /** File size in bytes when uploaded. */
  fileSize?: number;
  settings: RunSettings;
  result: DocumentResult | OcrImageResponse | TableResult;
  /**
   * Compact JPEG page thumbnails keyed by result page_number (1-based), so the
   * History viewer can show the page photo behind the region boxes. Optional —
   * older runs and lightweight saves won't have it.
   */
  pagePreviews?: Record<number, string>;
  notes: string;
  tags: string[];
  favorite: boolean;
}

const KEY = 'khmer-parser-runs.v1';

function readRaw(): StoredRun[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as StoredRun[];
  } catch {
    return [];
  }
}

function writeRaw(runs: StoredRun[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(runs));
  } catch (e) {
    // QuotaExceededError: trim the oldest half and retry once.
    if (runs.length > 1) {
      const trimmed = runs.slice(Math.floor(runs.length / 2));
      try {
        localStorage.setItem(KEY, JSON.stringify(trimmed));
      } catch {
        // If even the trimmed version doesn't fit, give up silently.
        // The user can still see results in the current tab; we just
        // couldn't persist them.
        console.warn('history persistence failed', e);
      }
    } else {
      console.warn('history persistence failed', e);
    }
  }
}

export function listRuns(): StoredRun[] {
  return readRaw().sort((a, b) => b.timestamp - a.timestamp);
}

export function getRun(id: string): StoredRun | undefined {
  return readRaw().find((r) => r.id === id);
}

export function addRun(run: StoredRun): void {
  const all = readRaw();
  all.push(run);
  // No fixed run cap — keep everything. writeRaw() still auto-trims the oldest
  // half only if the browser localStorage quota is actually exceeded, so we
  // never lose runs until we genuinely run out of room.
  writeRaw(all);
}

export function updateRun(id: string, patch: Partial<StoredRun>): void {
  const all = readRaw();
  const i = all.findIndex((r) => r.id === id);
  if (i < 0) return;
  all[i] = { ...all[i], ...patch };
  writeRaw(all);
}

export function deleteRun(id: string): void {
  writeRaw(readRaw().filter((r) => r.id !== id));
}

export function clearRuns(): void {
  writeRaw([]);
}

export function storageInfo(): { used: number; available: number; runCount: number } {
  const runs = readRaw();
  // Approximate: localStorage values are stored as strings; size in chars ≈ bytes.
  const raw = localStorage.getItem(KEY) ?? '';
  const used = raw.length;
  // Most browsers expose 5-10 MB per origin. Use 5 MB as a safe lower bound.
  const available = 5 * 1024 * 1024;
  return { used, available, runCount: runs.length };
}

export function exportRuns(): string {
  return JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), runs: readRaw() }, null, 2);
}

export function importRuns(json: string, mode: 'merge' | 'replace' = 'merge'): { added: number; skipped: number } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('Invalid JSON');
  }
  const incoming = (parsed && typeof parsed === 'object' && 'runs' in parsed
    ? (parsed as { runs: unknown }).runs
    : parsed) as unknown;
  if (!Array.isArray(incoming)) throw new Error('Expected an array of runs');

  const valid: StoredRun[] = [];
  for (const r of incoming) {
    if (r && typeof r === 'object' && 'id' in r && 'timestamp' in r && 'result' in r) {
      valid.push(r as StoredRun);
    }
  }

  if (mode === 'replace') {
    writeRaw(valid);
    return { added: valid.length, skipped: 0 };
  }
  // merge: dedupe by id, keep both
  const existing = readRaw();
  const seen = new Set(existing.map((r) => r.id));
  let added = 0;
  let skipped = 0;
  for (const r of valid) {
    if (seen.has(r.id)) {
      skipped++;
    } else {
      existing.push(r);
      seen.add(r.id);
      added++;
    }
  }
  writeRaw(existing);
  return { added, skipped };
}
