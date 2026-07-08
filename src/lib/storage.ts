// Run history persistence.
//
// Storage model: an in-memory cache is the SYNCHRONOUS source of truth (so the
// React layer stays simple — no async refactor), and it is persisted to
// IndexedDB, which has a far larger quota than localStorage's ~5 MB. This lets
// us keep an effectively uncapped history (Compare runs especially are heavy:
// a source preview plus two full results). On first load we hydrate the cache
// from IndexedDB and one-time-migrate any runs from the old localStorage key,
// then notify subscribers via onHistoryReady().

import type { DocumentResult, OcrImageResponse, TableResult } from '@/types/api';

export type TabKind = 'document' | 'translated' | 'ocr' | 'table' | 'history' | 'compare';

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
  // Compare
  mode?: 'ocr' | 'table' | 'document';
}

/** One backend's output within a Compare run. */
export interface ComparePane {
  backend: 'default' | 'vllm' | 'lens';
  ms: number;
  data: DocumentResult | OcrImageResponse | TableResult;
  /** Per-page latency when document mode timed each page individually. */
  pageMs?: { page: number; ms: number }[];
}

/** Compare run payload — both backends' results for the same input. */
export interface CompareRecord {
  kind: 'compare';
  mode: 'ocr' | 'table' | 'document';
  panes: ComparePane[];
  preferred?: 'default' | 'tie' | 'vllm' | 'lens';
  /** Compact data-URL preview of the source image (downscaled). */
  sourcePreview?: string;
}

export type RunResultPayload =
  | DocumentResult
  | OcrImageResponse
  | TableResult
  | CompareRecord;

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
  result: RunResultPayload;
  /**
   * Compact JPEG page thumbnails keyed by result page_number (1-based), so the
   * History viewer can show the page photo behind the region boxes. Optional —
   * older runs and lightweight saves won't have it.
   */
  pagePreviews?: Record<number, string>;
  notes: string;
  tags: string[];
  favorite: boolean;
  /** "Transform to tidy" output saved alongside a table run (Table tab). */
  tidy?: TidyRecord;
}

/** A saved tidy-transform result (LLM-reshaped table), stored on a table run. */
export interface TidyRecord {
  columns: string[];
  rows: string[][];
  tidy_markdown: string;
  tidy_csv: string;
  notes: string;
  model: string;
}

// --------------------------------------------------------------------------- //
// In-memory cache (sync source of truth)
// --------------------------------------------------------------------------- //
let cache: StoredRun[] = [];
let hydrated = false;
const readyListeners = new Set<() => void>();

// --------------------------------------------------------------------------- //
// IndexedDB wrapper (best-effort; degrades to in-memory-only if unavailable)
// --------------------------------------------------------------------------- //
const DB_NAME = 'khmer-parser';
const STORE = 'runs';
const OLD_LS_KEY = 'khmer-parser-runs.v1';
let dbp: Promise<IDBDatabase | null> | null = null;

function openDB(): Promise<IDBDatabase | null> {
  if (dbp) return dbp;
  dbp = new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbp;
}

async function idbAll(): Promise<StoredRun[]> {
  const d = await openDB();
  if (!d) return [];
  return new Promise((resolve) => {
    try {
      const req = d.transaction(STORE, 'readonly').objectStore(STORE).getAll();
      req.onsuccess = () => resolve((req.result as StoredRun[]) ?? []);
      req.onerror = () => resolve([]);
    } catch {
      resolve([]);
    }
  });
}

async function idbPut(runs: StoredRun[]): Promise<void> {
  const d = await openDB();
  if (!d) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = d.transaction(STORE, 'readwrite');
      const s = tx.objectStore(STORE);
      for (const r of runs) s.put(r);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

async function idbDelete(id: string): Promise<void> {
  const d = await openDB();
  if (!d) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = d.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

async function idbClear(): Promise<void> {
  const d = await openDB();
  if (!d) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = d.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

async function hydrate(): Promise<void> {
  if (hydrated) return;
  const d = await openDB();
  let runs: StoredRun[] = d ? await idbAll() : [];
  // One-time migration from the old localStorage store.
  try {
    const raw = localStorage.getItem(OLD_LS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const seen = new Set(runs.map((r) => r.id));
        const extra = (parsed as StoredRun[]).filter(
          (r) => r && typeof r === 'object' && 'id' in r && !seen.has(r.id),
        );
        if (extra.length) {
          runs = [...runs, ...extra];
          if (d) await idbPut(extra);
        }
      }
      if (d) localStorage.removeItem(OLD_LS_KEY); // only drop once safely in IDB
    }
  } catch {
    // ignore migration errors
  }
  cache = runs;
  hydrated = true;
  readyListeners.forEach((l) => l());
}
void hydrate();

/** Subscribe to the one-time async hydration so the UI can refresh once the
 *  cache is populated from IndexedDB. Fires immediately if already hydrated. */
export function onHistoryReady(cb: () => void): () => void {
  if (hydrated) {
    cb();
    return () => {};
  }
  readyListeners.add(cb);
  return () => readyListeners.delete(cb);
}

// --------------------------------------------------------------------------- //
// Public API — synchronous (cache-backed), persisted to IDB in the background
// --------------------------------------------------------------------------- //
export function listRuns(): StoredRun[] {
  return [...cache].sort((a, b) => b.timestamp - a.timestamp);
}

export function getRun(id: string): StoredRun | undefined {
  return cache.find((r) => r.id === id);
}

export function addRun(run: StoredRun): void {
  cache = [...cache, run];
  void idbPut([run]);
}

export function updateRun(id: string, patch: Partial<StoredRun>): void {
  const i = cache.findIndex((r) => r.id === id);
  if (i < 0) return;
  const next = { ...cache[i], ...patch };
  cache = [...cache.slice(0, i), next, ...cache.slice(i + 1)];
  void idbPut([next]);
}

export function deleteRun(id: string): void {
  cache = cache.filter((r) => r.id !== id);
  void idbDelete(id);
}

export function clearRuns(): void {
  cache = [];
  void idbClear();
}

export function storageInfo(): { used: number; available: number; runCount: number } {
  let used = 0;
  try {
    used = JSON.stringify(cache).length;
  } catch {
    used = 0;
  }
  // IndexedDB-backed: effectively uncapped vs localStorage's ~5 MB. Report a
  // generous ceiling so the History meter reflects "plenty of room".
  return { used, available: 1024 * 1024 * 1024, runCount: cache.length };
}

export function exportRuns(): string {
  return JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), runs: cache }, null, 2);
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
    cache = valid;
    void idbClear().then(() => idbPut(valid));
    return { added: valid.length, skipped: 0 };
  }
  // merge: dedupe by id
  const seen = new Set(cache.map((r) => r.id));
  let added = 0;
  let skipped = 0;
  const fresh: StoredRun[] = [];
  for (const r of valid) {
    if (seen.has(r.id)) {
      skipped++;
    } else {
      seen.add(r.id);
      fresh.push(r);
      added++;
    }
  }
  if (fresh.length) {
    cache = [...cache, ...fresh];
    void idbPut(fresh);
  }
  return { added, skipped };
}
