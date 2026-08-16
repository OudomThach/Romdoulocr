import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { HealthCheckResponse } from '@/types/api';
import { applyAutoFallback, baseUrlFor, preferredBackend, VLLM_ENABLED, type BackendId } from '@/lib/backend';

/**
 * Probe a specific backend's /health, with a hard timeout so a slow/cold
 * upstream can't leave the query pending forever.
 *
 * The timeout MUST stay comfortably above the Modal cold start. It used to be
 * 20s, which was right at the edge: a measured cold start took 22.0s, so the
 * probe aborted a backend that was about to answer 200 and the header badge
 * reported "offline" — the #1 cause of "the site is down" reports when the
 * whole stack was actually healthy. 60s leaves real headroom; a genuinely dead
 * backend fails fast (connection refused) and never waits this long anyway.
 */
const HEALTH_TIMEOUT_MS = 60_000;
/** Health payload plus the measured round-trip latency of the probe itself —
 * a live "connection speed" signal shown in the header badge. */
export type HealthWithLatency = HealthCheckResponse & { latencyMs: number };

async function fetchHealth(backend: BackendId, signal?: AbortSignal): Promise<HealthWithLatency> {
  const ctrl = new AbortController();
  const timer = window.setTimeout(() => ctrl.abort(), HEALTH_TIMEOUT_MS);
  const onAbort = () => ctrl.abort();
  signal?.addEventListener('abort', onAbort);
  const t0 = performance.now();
  try {
    const res = await fetch(`${baseUrlFor(backend)}/health`, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`health ${res.status}`);
    const data = (await res.json()) as HealthCheckResponse;
    return { ...data, latencyMs: Math.round(performance.now() - t0) };
  } finally {
    window.clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

function useBackendHealth(backend: BackendId) {
  return useQuery({
    queryKey: ['health', backend],
    queryFn: ({ signal }) => fetchHealth(backend, signal),
    refetchInterval: 30_000,
    refetchOnWindowFocus: false,
    retry: 1,
    // Hosted builds hide the vLLM backend entirely — don't waste a failing
    // probe on it every 30s.
    enabled: backend !== 'vllm' || VLLM_ENABLED,
  });
}

export type BackendsHealth = Record<BackendId, UseQueryResult<HealthWithLatency>>;

/**
 * Polls BOTH backends' health so the UI can show each one's status (e.g. a dot
 * per option on the backend toggle) — not just the active one. React Query
 * dedupes by queryKey, so multiple consumers share one poll per backend.
 */
export function useBackendsHealth(): BackendsHealth {
  const health = {
    default: useBackendHealth('default'),
    vllm: useBackendHealth('vllm'),
    lens: useBackendHealth('lens'),
  };

  // Auto-fallback: when the preferred backend (vLLM by default) is down but
  // the cloud engine is up, route through the cloud and let the UI flag it.
  // Runs on every poll tick (the hook re-renders when query data changes).
  const preferred = preferredBackend();
  const preferredOk =
    (health[preferred].data?.status === 'ok' && health[preferred].data?.models_loaded !== false) ?? false;
  const cloudOk = health.default.data?.status === 'ok' ?? false;
  applyAutoFallback(preferred, preferredOk, cloudOk);

  return health;
}
