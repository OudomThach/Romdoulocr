/**
 * Inference backend selection.
 *
 * The SPA can talk to one of three backends, chosen at runtime via a header
 * toggle (no rebuild needed):
 *
 *   - 'vllm'    - "/api-vllm", reverse-proxied by nginx to the local vllm-adapter
 *     sidecar, which drives the on-prem vLLM OCR service. THIS IS THE DEFAULT
 *     for fresh visitors (auto-falls back to the cloud when the GPU is down).
 *   - 'default' - the baked VITE_API_URL (normally "/api"), reverse-proxied by
 *     nginx to the public Modal khparser API. Fallback engine.
 *   - 'lens'    - "/api-lens", Google Lens via the lens-adapter sidecar.
 *
 * The choice is persisted in localStorage so it survives reloads. A tiny
 * subscribe/getSnapshot pair lets React components react to changes via
 * useSyncExternalStore.
 */

export type BackendId = 'default' | 'vllm' | 'lens';

/**
 * Build-time switch: hosted builds (e.g. Netlify) set VITE_VLLM_ENABLED=false
 * because the local GPU stack is unreachable from the public internet - the
 * toggle would only ever show "offline" to guests. Unset / any other value =
 * enabled, so Docker/home builds are unchanged.
 */
export const VLLM_ENABLED = import.meta.env.VITE_VLLM_ENABLED !== 'false';

const STORAGE_KEY = 'ocr.backend';

// Baked default base (e.g. "/api"). The vLLM base is a sibling path that nginx
// routes to the adapter - or, on hosted builds, an ABSOLUTE public tunnel URL
// (VITE_VLLM_URL) that the browser calls directly (the adapter sends CORS
// headers, and going direct dodges Netlify's ~26s proxy timeout, which long
// OCR inference would exceed).
const DEFAULT_BASE = (import.meta.env.VITE_API_URL ?? '/api').replace(/\/$/, '');
const VLLM_BASE = (import.meta.env.VITE_VLLM_URL ?? '/api-vllm').replace(/\/$/, '');
// Google Lens adapter - same pattern: relative /api-lens via nginx at home, or
// an absolute funnel URL (VITE_LENS_URL) on the hosted build.
const LENS_BASE = (import.meta.env.VITE_LENS_URL ?? '/api-lens').replace(/\/$/, '');

function read(): BackendId {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'vllm' && VLLM_ENABLED) return 'vllm';
    if (v === 'lens') return 'lens';
    if (v === 'default') return 'default';
  } catch {
    // storage blocked -> default
  }
  // Fresh visitors (no saved choice) default to the local vLLM backend when
  // it is built in; hosted builds without vLLM fall back to the cloud API.
  return VLLM_ENABLED ? 'vllm' : 'default';
}

let current: BackendId = read();
const listeners = new Set<() => void>();

// --------------------------------------------------------------------------- //
// Auto-fallback (GPU down -> cloud)
//
// When the user's chosen backend (normally vLLM) is unhealthy and the cloud
// backend is healthy, the active backend is temporarily switched to 'default'
// and fallbackActive is set so the UI can explain why. Health polling calls
// applyAutoFallback() with each probe result; the switch back happens
// automatically once the preferred backend answers health again.
// --------------------------------------------------------------------------- //
let fallbackActive = false;
const fallbackListeners = new Set<() => void>();

export function getBackend(): BackendId {
  return current;
}

/** True when the active backend was chosen by auto-fallback (GPU down). */
export function isFallbackActive(): boolean {
  return fallbackActive;
}

export function subscribeFallback(cb: () => void): () => void {
  fallbackListeners.add(cb);
  return () => fallbackListeners.delete(cb);
}

function setFallback(active: boolean): void {
  if (fallbackActive === active) return;
  fallbackActive = active;
  fallbackListeners.forEach((l) => l());
}

/** Base URL prefix for a specific backend (used to probe both for health). */
export function baseUrlFor(backend: BackendId): string {
  if (backend === 'vllm') return VLLM_BASE;
  if (backend === 'lens') return LENS_BASE;
  return DEFAULT_BASE;
}

/** Base URL prefix the API client should use for the current backend. */
export function getBaseUrl(): string {
  return baseUrlFor(current);
}

export function setBackend(next: BackendId): void {
  if (next === 'vllm' && !VLLM_ENABLED) return;
  if (next === current) return;
  current = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // ignore (private mode / disabled storage)
  }
  setFallback(false); // a manual choice always clears the fallback flag
  listeners.forEach((l) => l());
}

/**
 * Health-driven fallback. Called by the health poller with the probe results.
 *
 * - preferredOk: the user's preferred backend (vLLM/Lens) is healthy
 * - cloudOk: the cloud Modal backend is healthy
 *
 * When preferred is down and cloud is up, route through the cloud and flag it.
 * When preferred recovers, switch back automatically.
 */
export function applyAutoFallback(preferred: BackendId, preferredOk: boolean, cloudOk: boolean): void {
  if (preferred === 'default') {
    setFallback(false);
    return;
  }
  if (preferredOk) {
    if (fallbackActive && current === 'default') {
      // Preferred recovered — restore it.
      current = preferred;
      try {
        localStorage.setItem(STORAGE_KEY, preferred);
      } catch {
        // ignore
      }
      listeners.forEach((l) => l());
    }
    setFallback(false);
    return;
  }
  // Preferred is down; fall back to cloud only when cloud is actually up.
  if (!fallbackActive && cloudOk && current === preferred) {
    current = 'default';
    setFallback(true);
    listeners.forEach((l) => l());
  }
}

/** The backend the user prefers when health allows it (ignores fallback). */
export function preferredBackend(): BackendId {
  const stored = read();
  return stored === 'vllm' || stored === 'lens' ? stored : 'default';
}

export function subscribeBackend(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

// --------------------------------------------------------------------------- //
// Render quality (vLLM only)
//
// surya-ocr-2 resolves dense tables/text better at higher render DPI. This is a
// per-request knob the SPA appends (as ?dpi=) to vLLM calls only - the Modal
// default backend rasterizes server-side and ignores it. Persisted separately.
// --------------------------------------------------------------------------- //
export type RenderQuality = 'low' | 'balanced' | 'high';

const QUALITY_KEY = 'ocr.quality';
const QUALITY_DPI: Record<RenderQuality, number> = { low: 96, balanced: 150, high: 300 };

function readQuality(): RenderQuality {
  try {
    const v = localStorage.getItem(QUALITY_KEY);
    return v === 'low' || v === 'balanced' || v === 'high' ? v : 'balanced';
  } catch {
    return 'balanced';
  }
}

let currentQuality: RenderQuality = readQuality();
const qualityListeners = new Set<() => void>();

export function getRenderQuality(): RenderQuality {
  return currentQuality;
}

/** DPI for the current render-quality setting, for ?dpi= on vLLM requests. */
export function getRenderDpi(): number {
  return QUALITY_DPI[currentQuality];
}

export function setRenderQuality(next: RenderQuality): void {
  if (next === currentQuality) return;
  currentQuality = next;
  try {
    localStorage.setItem(QUALITY_KEY, next);
  } catch {
    // ignore
  }
  qualityListeners.forEach((l) => l());
}

export function subscribeRenderQuality(cb: () => void): () => void {
  qualityListeners.add(cb);
  return () => qualityListeners.delete(cb);
}
