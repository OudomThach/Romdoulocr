import { useHealth } from '@/hooks/useHealth';

export function HealthStatus() {
  const { data, isLoading, isError } = useHealth();

  if (isLoading) {
    return (
      <span className="badge border-slate-200 bg-slate-100 text-slate-600">
        <span className="h-2 w-2 animate-pulse rounded-full bg-slate-400" />
        Checking...
      </span>
    );
  }

  if (isError || !data) {
    return (
      <span className="badge border-rose-200 bg-rose-50 text-rose-700">
        <span className="h-2 w-2 rounded-full bg-rose-500" />
        Service offline
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
      title={data.message ?? ''}
    >
      <span className={`h-2 w-2 rounded-full ${ok ? 'bg-emerald-500' : 'bg-amber-500'}`} />
      {ok ? 'Service ready' : data.status}
    </span>
  );
}
