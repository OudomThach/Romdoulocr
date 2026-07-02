import { useSyncExternalStore } from 'react';
import { useBackendsHealth } from '@/hooks/useHealth';
import { getBackend, subscribeBackend, type BackendId } from '@/lib/backend';

// Human label for the active backend so the badge says WHICH service is being
// reported — a momentary vLLM blip should read as "vLLM offline", not as the
// whole app being down (which is what a generic "Service offline" implied).
const BACKEND_LABEL: Record<BackendId, string> = {
  default: 'Khmer Parsing API',
  vllm: 'Surya OCR 2',
};

export function HealthStatus() {
  const backend = useSyncExternalStore(subscribeBackend, getBackend, () => 'default' as BackendId);
  const { data, isLoading, isError } = useBackendsHealth()[backend];
  const name = BACKEND_LABEL[backend];

  if (isLoading) {
    return (
      <span className="badge border-slate-200 bg-slate-100 text-slate-600" title={`Checking ${name} backend…`}>
        <span className="h-2 w-2 animate-pulse rounded-full bg-slate-400" />
        Checking…
      </span>
    );
  }

  if (isError || !data) {
    return (
      <span
        className="badge border-rose-200 bg-rose-50 text-rose-700"
        title={
          backend === 'vllm'
            ? 'The local Surya OCR 2 (vLLM) backend is unreachable. Is the GPU stack running? You can switch to Khmer Parsing API above.'
            : 'The Khmer Parsing API is unreachable.'
        }
      >
        <span className="h-2 w-2 rounded-full bg-rose-500" />
        {name} offline
      </span>
    );
  }

  const ok = data.status === 'ok' && data.models_loaded;
  return (
    <span
      className={`badge ${
        ok
          ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
          : 'border-amber-200 bg-amber-50 text-amber-700'
      }`}
      title={data.message ?? `${name} backend`}
    >
      <span className={`h-2 w-2 rounded-full ${ok ? 'bg-emerald-500' : 'bg-amber-500'}`} />
      {ok ? `${name} ready` : `${name}: ${data.status}`}
    </span>
  );
}
