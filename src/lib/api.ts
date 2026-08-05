import type {
  DocumentResult,
  HealthCheckResponse,
  OcrImageResponse,
  TableResult,
} from '@/types/api';
import { getBaseUrl, baseUrlFor, getBackend, getRenderDpi, type BackendId } from '@/lib/backend';
import { useMetadataStore, type MetaSummary } from '@/lib/metadataStore';

// The API base is resolved at call time (not module load) so the in-app
// backend toggle can switch between the default upstream ("/api", proxied to
// Modal) and the local vLLM adapter ("/api-vllm") without a reload. Both
// prefixes are same-origin and reverse-proxied by nginx (prod) or Vite (dev).
// See src/lib/backend.ts for the selection logic.

// CTC decoder is the default and recommended decoder. The autoregressive
// decoder can produce repetition loops on noisy Khmer images (e.g.
// "នៅលើ នៅលើ នៅលើ..."), which is why CTC is on by default. The OCR Image
// and Parse + Translate tabs expose a toggle so users can disable it when
// needed; parse-pdf and parse-table keep it forced on for stability.
const USE_CTC_DEFAULT = 'true';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

// --------------------------------------------------------------------------- //
// Metadata service reporting (fire-and-forget)
//
// When VITE_METADATA_URL is set (e.g. /api-meta or http://localhost:8095),
// every successful parse also posts an extraction record to the metadata
// service. Deliberately invisible to the caller: a 5s cap + swallowed errors
// mean the pipeline can never be slowed or broken by the reporter. Returns the
// created record summary (or null when disabled / failed) so tabs can show an
// inline "Metadata saved" panel.
// --------------------------------------------------------------------------- //
const METADATA_URL = (import.meta.env.VITE_METADATA_URL ?? '').replace(/\/$/, '');
const METADATA_PIPELINE = import.meta.env.VITE_METADATA_PIPELINE ?? 'romdoul-spa';

async function postExtraction(payload: {
  type: string;
  source: { filename?: string; model: string };
  data: { filename?: string };
}, extraHeaders?: Record<string, string>): Promise<MetaSummary | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5_000);
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', ...extraHeaders };
    const res = await fetch(`${METADATA_URL}/api/v1/records`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { id?: string; type?: string; status?: string };
    return {
      id: body.id ?? '',
      type: body.type ?? payload.type ?? '',
      status: body.status ?? 'raw',
      model: payload.source.model ?? '',
      filename: payload.source.filename ?? payload.data.filename ?? '',
      justCreated: true,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function reportExtraction(
  type: string,
  filename: string | undefined,
  result: unknown,
  backend: BackendId | undefined,
  sourceFile?: File | null,
): void {
  if (!METADATA_URL) return;
  const data = (result ?? {}) as Record<string, unknown>;
  const pages = Array.isArray(data.pages) ? data.pages : [];
  const fullText =
    typeof data.full_text === 'string'
      ? data.full_text.slice(0, 50_000)
      : typeof data.text === 'string'
        ? data.text.slice(0, 50_000)
        : undefined;
  const resolved = backend ?? getBackend();
  const ext = filename && filename.includes('.') ? filename.split('.').pop()?.toLowerCase() ?? null : null;

  const buildPayload = (thumbnailBase64?: string) => ({
    type,
    source: {
      filename,
      file_type: ext,
      thumbnail_base64: thumbnailBase64 ?? null,
      model: resolved,
      source_system: 'khmer-parser-ui',
      extracted_at: new Date().toISOString(),
    },
    pipeline: { version: METADATA_PIPELINE },
    business: { tags: [resolved], domain: 'documents' },
    data: {
      filename,
      document_name: filename ?? null,
      num_pages: typeof data.num_pages === 'number' ? data.num_pages : pages.length,
      pages: pages.map((p: Record<string, unknown>) => ({
        page_number: p.page_number,
        width: p.width,
        height: p.height,
        region_count: Array.isArray(p.regions) ? p.regions.length : 0,
      })),
      ...(fullText !== undefined ? { full_text: fullText } : {}),
      ...(typeof data.num_rows === 'number' ? { num_rows: data.num_rows } : {}),
      ...(typeof data.num_cols === 'number' ? { num_cols: data.num_cols } : {}),
    },
  });

  const doPost = (payload: ReturnType<typeof buildPayload>) => {
    // Send the user's session token if signed in, so the metadata record
    // carries proper attribution (created_by = the person who parsed).
    const token = (() => {
      try { return localStorage.getItem('metadata_token'); } catch { return null; }
    })();
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers['X-Session-Token'] = token;
    return postExtraction(payload, headers).then((summary) => {
      if (summary) useMetadataStore.getState().add(summary);
    });
  };

  const tryWithThumbnail = async () => {
    let thumbnail: string | undefined;
    if (sourceFile && sourceFile.type.startsWith('image/')) {
      try {
        thumbnail = await readThumbnail(sourceFile);
      } catch { /* skip thumbnail on failure */ }
    }
    const payload = buildPayload(thumbnail);
    // Fire + one retry on first failure (still fully fire-and-forget).
    void doPost(payload).then(() => {});
    void doPost(payload).catch(() => {});
  };

  void tryWithThumbnail();
}

/** Generate a small (200px wide) JPEG thumbnail from a File. */
function readThumbnail(file: File): Promise<string | undefined> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const w = Math.min(img.width, 200);
      const h = Math.round((img.height / img.width) * w);
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) { resolve(undefined); return; }
      ctx.drawImage(img, 0, 0, w, h);
      canvas.toBlob((blob) => {
        if (!blob) { resolve(undefined); return; }
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => resolve(undefined);
        reader.readAsDataURL(blob);
      }, 'image/jpeg', 0.6);
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(undefined); };
    img.src = url;
  });
}

/** Distinguish a user-initiated abort from a real network/HTTP failure. */
export class AbortError extends Error {
  constructor() {
    super('Request was cancelled');
    this.name = 'AbortError';
  }
}

/** Hard ceiling for any single API call. Long OCR jobs run per-page (each page
 * is its own request), so nothing legitimate should exceed this — beyond it,
 * fail fast with a clear message instead of leaving the UI hanging. */
const REQUEST_TIMEOUT_MS = 300_000;

/**
 * Statuses worth one more try, and why this exists at all.
 *
 * The cloud engine scales to zero, so the FIRST call after a quiet spell pays a
 * ~22s cold start — and the hosted path cuts a request off at ~26s, so a cold
 * call lands close enough to that ceiling to lose the race and come back 504.
 * The user saw "Request failed with status 504" and a dead end, even though the
 * failed attempt had just WARMED the engine: a retry a moment later succeeds in
 * a couple of seconds. Retrying turns a hard failure into a short delay.
 *
 * Deliberately narrow — 4xx is the caller's fault and would fail identically,
 * and a burnt retry on 429 only spends more of the rate-limit budget.
 */
const RETRY_STATUSES = new Set([502, 503, 504]);
const RETRY_ATTEMPTS = 2;      // 3 tries total
const RETRY_BASE_MS = 1200;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** True when another attempt is worth making. A user-cancelled request never is. */
function shouldRetry(e: unknown, attempt: number, signal?: AbortSignal): boolean {
  if (attempt >= RETRY_ATTEMPTS || signal?.aborted) return false;
  if (e instanceof AbortError) return false;
  if (e instanceof ApiError) {
    // status 0 is a transport failure (dropped connection / client timeout) —
    // exactly what a request killed at the gateway ceiling looks like.
    return e.status === 0 || RETRY_STATUSES.has(e.status);
  }
  return false;
}

async function requestOnce<T>(
  path: string,
  init: RequestInit,
  signal?: AbortSignal,
  backend?: BackendId,
): Promise<T> {
  // If the caller didn't pass its own AbortSignal, apply the default timeout so
  // a dead upstream can't hang the UI forever.
  const effectiveSignal = signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${baseUrlFor(backend ?? getBackend())}${path}`, { ...init, signal: effectiveSignal });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'TimeoutError') {
      throw new ApiError(0, null, `Request timed out after ${REQUEST_TIMEOUT_MS / 60000} minutes`);
    }
    throw e;
  }
  if (!res.ok) {
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      try {
        body = await res.text();
      } catch {
        // ignore
      }
    }
    const detail =
      (body && typeof body === 'object' && 'detail' in body
        ? String((body as { detail: unknown }).detail)
        : null) ?? `Request failed with status ${res.status}`;
    throw new ApiError(res.status, body, detail);
  }
  return (await res.json()) as T;
}

export interface CallOptions {
  signal?: AbortSignal;
  /** Force a specific backend for THIS call (e.g. the Compare tab runs both),
   *  overriding the global toggle. Defaults to the active backend. */
  backend?: BackendId;
}

/** Per-call progress + abort + backend override, shared by the upload methods. */
export interface UploadOptions {
  onProgress?: (pct: number) => void;
  signal?: AbortSignal;
  backend?: BackendId;
}

/**
 * Append vLLM-only query params. The render-quality DPI applies only to the
 * local vLLM backend (the Modal default rasterizes server-side and ignores it),
 * so we gate on the resolved backend. Mutates and returns the same params.
 */
function withBackendParams(qs: URLSearchParams, backend?: BackendId): URLSearchParams {
  if ((backend ?? getBackend()) === 'vllm') qs.set('dpi', String(getRenderDpi()));
  return qs;
}

/** Retrying wrapper — see RETRY_STATUSES for why this exists. */
async function request<T>(
  path: string,
  init: RequestInit,
  signal?: AbortSignal,
  backend?: BackendId,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await requestOnce<T>(path, init, signal, backend);
    } catch (e) {
      if (!shouldRetry(e, attempt, signal)) throw e;
      await sleep(RETRY_BASE_MS * 2 ** attempt);
    }
  }
}

/**
 * Retrying wrapper for uploads. The body is a FormData built from a File, which
 * is re-readable, so re-sending it is safe — and cheap relative to losing the
 * whole page to a cold-start 504. onProgress is reset to 0 on a fresh attempt so
 * the bar cannot appear to run backwards.
 */
async function uploadWithProgress<T>(
  path: string,
  body: FormData,
  opts: UploadOptions & { rawFallback?: boolean } = {},
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await uploadOnce<T>(path, body, opts);
    } catch (e) {
      if (!shouldRetry(e, attempt, opts.signal)) throw e;
      await sleep(RETRY_BASE_MS * 2 ** attempt);
      opts.onProgress?.(0);
    }
  }
}

export const api = {
  get baseUrl() {
    return getBaseUrl();
  },

  health(opts: CallOptions = {}): Promise<HealthCheckResponse> {
    return request<HealthCheckResponse>('/health', { method: 'GET' }, opts.signal, opts.backend);
  },

  /**
   * POST /parse-pdf — multipart upload of one or more PDF/image files.
   * Returns structured layout regions with OCR text.
   */
  parsePdf(
    files: File[],
    opts: { detectLayout?: boolean; detectLines?: boolean; useCtc?: boolean } = {},
    progress: UploadOptions = {},
  ): Promise<DocumentResult> {
    const fd = new FormData();
    for (const f of files) fd.append('files', f, f.name);
    const qs = new URLSearchParams();
    if (opts.detectLayout !== undefined) qs.set('detect_layout', String(opts.detectLayout));
    if (opts.detectLines !== undefined) qs.set('detect_lines', String(opts.detectLines));
    // Default CTC on; callers (e.g. OCR Image tab's decoder toggle) can override.
    qs.set('use_ctc', opts.useCtc === false ? 'false' : USE_CTC_DEFAULT);
    withBackendParams(qs, progress.backend);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return uploadWithProgress<DocumentResult>(`/parse-pdf${suffix}`, fd, progress).then((r) => {
      reportExtraction('document', r.filename, r, progress.backend, files[0]);
      return r;
    });
  },

  /**
   * POST /parse-pdf-translated — same as parse-pdf plus Khmer→target translation.
   */
  parsePdfTranslated(
    files: File[],
    opts: { sourceLang?: string; targetLang?: string; detectLayout?: boolean; detectLines?: boolean; useCtc?: boolean } = {},
    progress: UploadOptions = {},
  ): Promise<DocumentResult> {
    const fd = new FormData();
    for (const f of files) fd.append('files', f, f.name);
    const qs = new URLSearchParams();
    if (opts.sourceLang) qs.set('source_lang', opts.sourceLang);
    if (opts.targetLang) qs.set('target_lang', opts.targetLang);
    if (opts.detectLayout !== undefined) qs.set('detect_layout', String(opts.detectLayout));
    if (opts.detectLines !== undefined) qs.set('detect_lines', String(opts.detectLines));
    qs.set('use_ctc', opts.useCtc === false ? 'false' : USE_CTC_DEFAULT);
    withBackendParams(qs, progress.backend);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return uploadWithProgress<DocumentResult>(`/parse-pdf-translated${suffix}`, fd, progress).then((r) => {
      reportExtraction('document_translated', r.filename, r, progress.backend, files[0]);
      return r;
    });
  },

  /**
   * POST /ocr-image — single image OCR. Returns text + confidence.
   */
  ocrImage(
    file: File,
    opts: { useCtc?: boolean } = {},
    progress: UploadOptions = {},
  ): Promise<OcrImageResponse> {
    const fd = new FormData();
    fd.append('file', file, file.name);
    const qs = new URLSearchParams();
    qs.set('use_ctc', opts.useCtc === false ? 'false' : USE_CTC_DEFAULT);
    withBackendParams(qs, progress.backend);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return uploadWithProgress<OcrImageResponse>(`/ocr-image${suffix}`, fd, { ...progress, rawFallback: true }).then((r) => {
      reportExtraction('ocr_image', r.filename, r, progress.backend, file);
      return r;
    });
  },

  /**
   * POST /parse-table — extract table structure (rows/cols/cells).
   */
  parseTable(
    file: File,
    opts: { rowTolerance?: number } = {},
    progress: UploadOptions = {},
  ): Promise<TableResult> {
    const fd = new FormData();
    fd.append('file', file, file.name);
    const qs = new URLSearchParams();
    qs.set('use_ctc', USE_CTC_DEFAULT);
    if (opts.rowTolerance !== undefined) qs.set('row_tolerance', String(opts.rowTolerance));
    withBackendParams(qs, progress.backend);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return uploadWithProgress<TableResult>(`/parse-table${suffix}`, fd, progress).then((r) => {
      reportExtraction('table', r.filename, r, progress.backend, file);
      return r;
    });
  },
};

/**
 * XHR upload with progress + optional AbortSignal. We use XHR (instead of fetch)
 * because fetch doesn't expose upload-progress events and its AbortController
 * can only abort before the body starts streaming reliably.
 */
function uploadOnce<T>(
  path: string,
  body: FormData,
  { onProgress, signal, rawFallback, backend }: UploadOptions & { rawFallback?: boolean } = {},
): Promise<T> {
  if (!onProgress && !signal) {
    return requestOnce<T>(path, { method: 'POST', body }, undefined, backend);
  }

  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${baseUrlFor(backend ?? getBackend())}${path}`);
    // Fail fast instead of hanging: same ceiling as request().
    xhr.timeout = REQUEST_TIMEOUT_MS;
    xhr.addEventListener('timeout', () => {
      signal?.removeEventListener('abort', onAbort);
      reject(new ApiError(0, null, `Request timed out after ${REQUEST_TIMEOUT_MS / 60000} minutes`));
    });

    if (onProgress) {
      xhr.upload.addEventListener('progress', (ev) => {
        if (ev.lengthComputable) onProgress(Math.round((ev.loaded / ev.total) * 100));
      });
    }

    // Bridge AbortSignal → xhr.abort(). The promise rejection distinguishes
    // user-cancel (AbortError) from network/HTTP failures (ApiError).
    const onAbort = () => {
      xhr.abort();
      reject(new AbortError());
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    xhr.addEventListener('load', () => {
      signal?.removeEventListener('abort', onAbort);
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText) as T);
        } catch {
          if (rawFallback) {
            resolve(xhr.responseText as unknown as T);
          } else {
            reject(new ApiError(xhr.status, xhr.responseText, 'Invalid JSON in response'));
          }
        }
      } else {
        let parsed: unknown = xhr.responseText;
        try {
          parsed = JSON.parse(xhr.responseText);
        } catch {
          // leave as raw text
        }
        const detail =
          (parsed && typeof parsed === 'object' && 'detail' in parsed
            ? String((parsed as { detail: unknown }).detail)
            : null) ?? `Request failed with status ${xhr.status}`;
        reject(new ApiError(xhr.status, parsed, detail));
      }
    });

    xhr.addEventListener('error', () => {
      signal?.removeEventListener('abort', onAbort);
      // Browsers fire 'error' for both network failures AND aborted requests.
      // We disambiguate by checking the signal state.
      if (signal?.aborted) reject(new AbortError());
      else reject(new ApiError(0, null, 'Network error'));
    });

    xhr.addEventListener('abort', () => {
      signal?.removeEventListener('abort', onAbort);
      reject(new AbortError());
    });

    xhr.send(body);
  });
}
