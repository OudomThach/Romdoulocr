import { useSyncExternalStore } from 'react';
import { useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { useBackendsHealth } from '@/hooks/useHealth';
import { toast } from '@/hooks/useToastStore';
import type { HealthCheckResponse } from '@/types/api';
import { getBackend, setBackend, subscribeBackend, VLLM_ENABLED, type BackendId } from '@/lib/backend';

/**
 * Segmented control that switches the inference backend between the default
 * (Modal khparser API) and the local vLLM adapter. Persisted in localStorage
 * via src/lib/backend.ts. Switching invalidates cached queries so the health
 * badge and any in-flight results re-fetch against the newly selected backend,
 * and fires a toast so the change is acknowledged.
 *
 * Each option carries a live health dot (green ready / amber degraded / red
 * offline / pulsing while checking) — both backends are probed, so you can see
 * which one is up BEFORE switching to it.
 */
const OPTIONS: { id: BackendId; label: string; title: string }[] = [
  { id: 'default', label: 'Default', title: 'Cloud Modal API (default)' },
  { id: 'vllm', label: 'vLLM', title: 'Local vLLM OCR backend' },
  { id: 'lens', label: 'Google Lens', title: 'Google Lens OCR (free, via the lens adapter)' },
];

function statusDot(q: UseQueryResult<HealthCheckResponse>): string {
  if (q.isLoading) return 'bg-slate-400 animate-pulse';
  if (q.isError || !q.data) return 'bg-rose-500';
  return q.data.status === 'ok' && q.data.models_loaded ? 'bg-emerald-500' : 'bg-amber-500';
}

export function BackendToggle() {
  const backend = useSyncExternalStore(subscribeBackend, getBackend, () => 'default' as BackendId);
  const queryClient = useQueryClient();
  const health = useBackendsHealth();

  // Hosted builds (VITE_VLLM_ENABLED=false) can't reach the local GPU stack —
  // hide the whole toggle rather than show guests a permanently-dead option.
  if (!VLLM_ENABLED) return null;

  const select = (id: BackendId) => {
    if (id === backend) return;
    setBackend(id);
    // Re-validate anything fetched from the previous backend.
    queryClient.invalidateQueries({ queryKey: ['health'] });
    toast.info(
      id === 'vllm'
        ? 'Switched to Surya OCR 2 (vLLM) backend'
        : id === 'lens'
          ? 'Switched to Google Lens backend'
          : 'Switched to Khmer Parsing API backend',
    );
  };

  return (
    <div
      role="group"
      aria-label="Inference backend"
      className="flex items-center rounded-lg border border-slate-200 bg-white p-0.5 shadow-sm"
      title="Choose which OCR backend to use"
    >
      {OPTIONS.map((opt) => {
        const active = backend === opt.id;
        return (
          <button
            key={opt.id}
            type="button"
            onClick={() => select(opt.id)}
            aria-pressed={active}
            title={opt.title}
            className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
              active
                ? 'bg-slate-950 text-white'
                : 'text-slate-500 hover:bg-slate-50 hover:text-slate-950'
            }`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${statusDot(health[opt.id])}`} />
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
