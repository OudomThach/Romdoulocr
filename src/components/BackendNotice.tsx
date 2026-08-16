import { useSyncExternalStore } from 'react';
import {
  getBackend,
  isFallbackActive,
  subscribeBackend,
  subscribeFallback,
  type BackendId,
} from '@/lib/backend';

/**
 * Inline notice shown on the Parse + Translate tab when the vLLM backend is
 * active. The local vLLM OCR model has no translation step, so that tab returns
 * OCR (original text) only. Surfacing this prevents the silent-degradation
 * confusion of getting untranslated output with no explanation.
 */
export function TranslateBackendNotice() {
  const backend = useSyncExternalStore(subscribeBackend, getBackend, () => 'default' as BackendId);
  if (backend !== 'vllm') return null;

  return (
    <div
      role="status"
      className="mb-4 flex items-start gap-2.5 rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-sm text-amber-800"
    >
      <svg viewBox="0 0 24 24" className="mt-0.5 h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
        <line x1="12" y1="9" x2="12" y2="13" />
        <line x1="12" y1="17" x2="12.01" y2="17" />
      </svg>
      <span>
        <strong className="font-semibold">Surya OCR 2 (vLLM) backend:</strong> translation isn’t available here — you’ll get
        OCR (original text) only. Switch to <strong className="font-semibold">Khmer Parsing API</strong> (top-right) for
        translation.
      </span>
    </div>
  );
}

/**
 * Banner shown while auto-fallback is active: the local GPU backend is
 * unreachable, so requests are being routed through the cloud API until it
 * recovers. Explains why the header toggle shows a different backend than the
 * one the user picked.
 */
export function FallbackNotice() {
  const fallback = useSyncExternalStore(subscribeFallback, isFallbackActive, () => false);
  if (!fallback) return null;

  return (
    <div
      role="status"
      className="mb-4 flex items-start gap-2.5 rounded-lg border border-sky-200 bg-sky-50 px-3.5 py-2.5 text-sm text-sky-800"
    >
      <svg viewBox="0 0 24 24" className="mt-0.5 h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" />
        <path d="M12 16v-4" />
        <path d="M12 8h.01" />
      </svg>
      <span>
        <strong className="font-semibold">GPU offline — using cloud API:</strong> the local Surya OCR 2 backend isn’t
        reachable right now, so requests are running on the cloud engine. It will switch back automatically when the GPU
        recovers.
      </span>
    </div>
  );
}
