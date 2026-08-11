import { useToastStore } from '@/hooks/useToastStore';

// Mounted once at the app root. Renders the toast queue as a fixed stack
// near the bottom-center of the viewport. Each toast auto-dismisses via the
// store's timer; clicking one dismisses it immediately. Toasts with an
// `action` (e.g. Undo) render an action button that runs and dismisses.

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
        <div
          key={it.id}
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
          {it.action && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                it.action?.run();
                dismiss(it.id);
              }}
              className={`ml-1 rounded-md px-2 py-0.5 text-xs font-semibold transition-colors ${
                it.variant === 'success'
                  ? 'bg-emerald-600 text-white hover:bg-emerald-700'
                  : it.variant === 'error'
                    ? 'bg-rose-600 text-white hover:bg-rose-700'
                    : 'bg-white/15 text-white hover:bg-white/25'
              }`}
            >
              {it.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
