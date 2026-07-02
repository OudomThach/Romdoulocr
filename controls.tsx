import { useEffect, useRef } from 'react';

/**
 * How many requests can be in-flight at once.
 *
 * - 1 = strictly sequential (safest for limited bandwidth / strict rate limits)
 * - 2-3 = balanced (default)
 * - 4 = aggressive (use when the upstream is fast and the network is good)
 */
export function ConcurrencyControl({
  value,
  onChange,
  disabled,
}: {
  value: number;
  onChange: (v: number) => void;
  disabled?: boolean;
}) {
  return (
    <div className="grid gap-1 text-sm">
      <div className="flex items-center justify-between text-xs">
        <span className="text-ink-200">Parallel requests</span>
        <span className="font-mono text-ink-400">{value}</span>
      </div>
      <input
        type="range"
        min={1}
        max={4}
        step={1}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        disabled={disabled}
        className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-ink-800 accent-accent disabled:opacity-50"
      />
      <div className="flex justify-between text-[10px] text-ink-500">
        <span>1 · sequential</span>
        <span>4 · parallel</span>
      </div>
    </div>
  );
}

/**
 * Global keyboard shortcuts:
 *   Ctrl/Cmd+Enter  → submit (call onSubmit)
 *   Esc             → cancel (call onCancel) if a request is in flight
 *
 * Skips activation when the user is typing in a text input, contenteditable,
 * textarea, or select — we never want to hijack a typing session.
 */
export function useKeyboardShortcuts({
  onSubmit,
  onCancel,
  enabled,
}: {
  onSubmit: () => void;
  onCancel: () => void;
  enabled: boolean;
}) {
  // Keep latest callbacks in refs so the effect doesn't re-subscribe on every render.
  const submitRef = useRef(onSubmit);
  const cancelRef = useRef(onCancel);
  submitRef.current = onSubmit;
  cancelRef.current = onCancel;

  useEffect(() => {
    if (!enabled) return;
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) {
          return;
        }
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        submitRef.current();
      } else if (e.key === 'Escape') {
        cancelRef.current();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [enabled]);
}
