import type {
  DocumentResult,
  HealthCheckResponse,
  OcrImageResponse,
  TableResult,
} from '@/types/api';

// Default to a relative "/api" base so the browser makes same-origin requests.
// In production this is reverse-proxied by nginx (see Dockerfile + nginx.conf);
// in dev/preview it's handled by the Vite proxy (see vite.config.ts). Both
// rewrite /api/<path> → /<path> on the upstream.
//
// Override by setting VITE_API_URL to a full URL (e.g. when pointing at an
// upstream that DOES send proper CORS headers).
const BASE_URL = (import.meta.env.VITE_API_URL ?? '/api').replace(/\/$/, '');

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

async function request<T>(path: string, init: RequestInit, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, { ...init, signal });
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
}

export const api = {
  baseUrl: BASE_URL,

  health(opts: CallOptions = {}): Promise<HealthCheckResponse> {
    return request<HealthCheckResponse>('/health', { method: 'GET' }, opts.signal);
  },

  /**
   * POST /parse-pdf — multipart upload of one or more PDF/image files.
   * Returns structured layout regions with OCR text.
   */
  parsePdf(
    files: File[],
    opts: { detectLayout?: boolean; detectLines?: boolean } = {},
    progress: { onProgress?: (pct: number) => void; signal?: AbortSignal } = {},
  ): Promise<DocumentResult> {
    const fd = new FormData();
    for (const f of files) fd.append('files', f, f.name);
    const qs = new URLSearchParams();
    if (opts.detectLayout !== undefined) qs.set('detect_layout', String(opts.detectLayout));
    if (opts.detectLines !== undefined) qs.set('detect_lines', String(opts.detectLines));
    qs.set('use_ctc', USE_CTC_DEFAULT);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return uploadWithProgress<DocumentResult>(`/parse-pdf${suffix}`, fd, progress);
  },

  /**
   * POST /parse-pdf-translated — same as parse-pdf plus Khmer→target translation.
   */
  parsePdfTranslated(
    files: File[],
    opts: { sourceLang?: string; targetLang?: string; detectLayout?: boolean; detectLines?: boolean; useCtc?: boolean } = {},
    progress: { onProgress?: (pct: number) => void; signal?: AbortSignal } = {},
  ): Promise<DocumentResult> {
    const fd = new FormData();
    for (const f of files) fd.append('files', f, f.name);
    const qs = new URLSearchParams();
    if (opts.sourceLang) qs.set('source_lang', opts.sourceLang);
    if (opts.targetLang) qs.set('target_lang', opts.targetLang);
    if (opts.detectLayout !== undefined) qs.set('detect_layout', String(opts.detectLayout));
    if (opts.detectLines !== undefined) qs.set('detect_lines', String(opts.detectLines));
    qs.set('use_ctc', opts.useCtc === false ? 'false' : USE_CTC_DEFAULT);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return uploadWithProgress<DocumentResult>(`/parse-pdf-translated${suffix}`, fd, progress);
  },

  /**
   * POST /ocr-image — single image OCR. Returns text + confidence.
   */
  ocrImage(
    file: File,
    opts: { useCtc?: boolean } = {},
    progress: { onProgress?: (pct: number) => void; signal?: AbortSignal } = {},
  ): Promise<OcrImageResponse> {
    const fd = new FormData();
    fd.append('file', file, file.name);
    const qs = new URLSearchParams();
    qs.set('use_ctc', opts.useCtc === false ? 'false' : USE_CTC_DEFAULT);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return uploadWithProgress<OcrImageResponse>(`/ocr-image${suffix}`, fd, { ...progress, rawFallback: true });
  },

  /**
   * POST /parse-table — extract table structure (rows/cols/cells).
   */
  parseTable(
    file: File,
    opts: { rowTolerance?: number } = {},
    progress: { onProgress?: (pct: number) => void; signal?: AbortSignal } = {},
  ): Promise<TableResult> {
    const fd = new FormData();
    fd.append('file', file, file.name);
    const qs = new URLSearchParams();
    qs.set('use_ctc', USE_CTC_DEFAULT);
    if (opts.rowTolerance !== undefined) qs.set('row_tolerance', String(opts.rowTolerance));
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
  { onProgress, signal, rawFallback }: { onProgress?: (pct: number) => void; signal?: AbortSignal; rawFallback?: boolean } = {},
): Promise<T> {
  if (!onProgress && !signal) {
    return request<T>(path, { method: 'POST', body }, undefined);
  }

  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${BASE_URL}${path}`);

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
