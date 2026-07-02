import { useToastStore } from '@/hooks/useToastStore';

// Mounted once at the app root. Renders the toast queue as a fixed stack
// near the bottom-center of the viewport. Each toast auto-dismisses via the
// store's timer; clicking one dismisses it immediately.

export function Toaster() {
  const items = useToastStore((s) => s.items);
  const dismiss = useToastStore((s) => s.dismiss);

  if (items.length === 0) return null;

  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-6 z-[100] flex flex-col items-center gap-2 px-4"
      aria-live="polite"
      aria-atomic="false"
    >
      {items.map((it) => (
        <button
          key={it.id}
          type="button"
          onClick={() => dismiss(it.id)}
          className={`toast-in pointer-events-auto flex items-center gap-2.5 rounded-xl px-4 py-2.5 text-sm font-medium shadow-lg ring-1 transition-colors ${
            it.variant === 'success'
              ? 'bg-emerald-50 text-emerald-800 ring-emerald-200'
              : it.variant === 'error'
                ? 'bg-rose-50 text-rose-800 ring-rose-200'
                : 'bg-slate-900 text-white ring-slate-700'
          }`}
        >
          <span className="text-base leading-none">
            {it.variant === 'success' ? '✓' : it.variant === 'error' ? '✕' : 'ℹ'}
          </span>
          <span>{it.message}</span>
        </button>
      ))}
    </div>
  );
}
