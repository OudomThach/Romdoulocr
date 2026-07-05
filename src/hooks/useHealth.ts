import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { HealthCheckResponse } from '@/types/api';
import { baseUrlFor, VLLM_ENABLED, type BackendId } from '@/lib/backend';

/**
 * Probe a specific backend's /health, with a hard 20s timeout so a slow/cold
 * upstream (the Modal API can take ~20s on a cold start) can't leave the query
 * pending forever.
 */
/** Health payload plus the measured round-trip latency of the probe itself —
 * a live "connection speed" signal shown in the header badge. */
export type HealthWithLatency = HealthCheckResponse & { latencyMs: number };

async function fetchHealth(backend: BackendId, signal?: AbortSignal): Promise<HealthWithLatency> {
  const ctrl = new AbortController();
  const timer = window.setTimeout(() => ctrl.abort(), 20_000);
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
  return {
    default: useBackendHealth('default'),
    vllm: useBackendHealth('vllm'),
  };
}
