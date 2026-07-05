/**
 * Inference backend selection.
 *
 * The SPA can talk to one of two backends, chosen at runtime via a header
 * toggle (no rebuild needed):
 *
 *   - 'default' — the baked VITE_API_URL (normally "/api"), reverse-proxied by
 *     nginx to the public Modal khparser API. This is the original behavior.
 *   - 'vllm'    — "/api-vllm", reverse-proxied by nginx to the local vllm-adapter
 *     sidecar, which drives the on-prem vLLM OCR service.
 *
 * The choice is persisted in localStorage so it survives reloads. A tiny
 * subscribe/getSnapshot pair lets React components react to changes via
 * useSyncExternalStore.
 */

export type BackendId = 'default' | 'vllm';

/**
 * Build-time switch: hosted builds (e.g. Netlify) set VITE_VLLM_ENABLED=false
 * because the local GPU stack is unreachable from the public internet — the
 * toggle would only ever show "offline" to guests. Unset / any other value =
 * enabled, so Docker/home builds are unchanged.
 */
export const VLLM_ENABLED = import.meta.env.VITE_VLLM_ENABLED !== 'false';

const STORAGE_KEY = 'ocr.backend';

// Baked default base (e.g. "/api"). The vLLM base is a sibling path that nginx
// routes to the adapter.
const DEFAULT_BASE = (import.meta.env.VITE_API_URL ?? '/api').replace(/\/$/, '');
const VLLM_BASE = '/api-vllm';

function read(): BackendId {
  if (!VLLM_ENABLED) return 'default'; // clamp stale localStorage on hosted builds
  try {
    return localStorage.getItem(STORAGE_KEY) === 'vllm' ? 'vllm' : 'default';
  } catch {
    return 'default';
  }
}

let current: BackendId = read();
const listeners = new Set<() => void>();

export function getBackend(): BackendId {
  return current;
}

/** Base URL prefix for a specific backend (used to probe both for health). */
export function baseUrlFor(backend: BackendId): string {
  return backend === 'vllm' ? VLLM_BASE : DEFAULT_BASE;
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
  listeners.forEach((l) => l());
}

export function subscribeBackend(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

// --------------------------------------------------------------------------- //
// Render quality (vLLM only)
//
// surya-ocr-2 resolves dense tables/text better at higher render DPI. This is a
// per-request knob the SPA appends (as ?dpi=) to vLLM calls only — the Modal
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
