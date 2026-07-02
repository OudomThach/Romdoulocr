import type {
  DocumentResult,
  HealthCheckResponse,
  OcrImageResponse,
  TableResult,
} from '@/types/api';
import { getBaseUrl, baseUrlFor, getBackend, getRenderDpi, type BackendId } from '@/lib/backend';

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

/** Distinguish a user-initiated abort from a real network/HTTP failure. */
export class AbortError extends Error {
  constructor() {
    super('Request was cancelled');
    this.name = 'AbortError';
  }
}

async function request<T>(
  path: string,
  init: RequestInit,
  signal?: AbortSignal,
  backend?: BackendId,
): Promise<T> {
  const res = await fetch(`${baseUrlFor(backend ?? getBackend())}${path}`, { ...init, signal });
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
    opts: { detectLayout?: boolean; detectLines?: boolean } = {},
    progress: UploadOptions = {},
  ): Promise<DocumentResult> {
    const fd = new FormData();
    for (const f of files) fd.append('files', f, f.name);
    const qs = new URLSearchParams();
    if (opts.detectLayout !== undefined) qs.set('detect_layout', String(opts.detectLayout));
    if (opts.detectLines !== undefined) qs.set('detect_lines', String(opts.detectLines));
    qs.set('use_ctc', USE_CTC_DEFAULT);
    withBackendParams(qs, progress.backend);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return uploadWithProgress<DocumentResult>(`/parse-pdf${suffix}`, fd, progress);
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
    return uploadWithProgress<DocumentResult>(`/parse-pdf-translated${suffix}`, fd, progress);
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
    return uploadWithProgress<OcrImageResponse>(`/ocr-image${suffix}`, fd, { ...progress, rawFallback: true });
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
    return uploadWithProgress<TableResult>(`/parse-table${suffix}`, fd, progress);
  },
};

/**
 * XHR upload with progress + optional AbortSignal. We use XHR (instead of fetch)
 * because fetch doesn't expose upload-progress events and its AbortController
 * can only abort before the body starts streaming reliably.
 */
function uploadWithProgress<T>(
  path: string,
  body: FormData,
  { onProgress, signal, rawFallback, backend }: UploadOptions & { rawFallback?: boolean } = {},
): Promise<T> {
  if (!onProgress && !signal) {
    return request<T>(path, { method: 'POST', body }, undefined, backend);
  }

  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${baseUrlFor(backend ?? getBackend())}${path}`);

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
