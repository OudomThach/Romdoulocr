// Small dropdown button that replaces the single "Copy text" button. Each
// menu item has its own onClick handler so we don't bake copy logic into the
// menu itself — the caller passes whichever text variants it has available.
//
// We deliberately keep this as a small custom popover (rather than pulling in
// a Radix/Headless UI dropdown) because the surface is tiny and we want zero
// new deps.

import { useEffect, useRef, useState } from 'react';

export interface CopyMenuItem {
  /** Stable id, used as menu key + to dedupe selection feedback. */
  id: string;
  /** Visible label. */
  label: string;
  /** Short hint shown on the right (e.g. char count). */
  hint?: string;
  /** Click handler. Should return a promise that resolves on success. */
  onSelect: () => void | Promise<void>;
}

export interface CopyMenuProps {
  /** Primary label on the trigger button (e.g. "Copy text"). */
  label: string;
  /** Items shown in the dropdown. */
  items: CopyMenuItem[];
  /** Optional icon-less variant for tighter toolbar use. */
  compact?: boolean;
}

export function CopyMenu({ label, items, compact }: CopyMenuProps) {
  const [open, setOpen] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  // Auto-dismiss feedback.
  useEffect(() => {
    if (!feedback) return;
    const t = window.setTimeout(() => setFeedback(null), 1200);
    return () => window.clearTimeout(t);
  }, [feedback]);

  const onPick = async (it: CopyMenuItem) => {
    setOpen(false);
    try {
      await it.onSelect();
      setFeedback(`Copied ${it.label.toLowerCase()}`);
    } catch {
      setFeedback('Copy failed');
    }
  };

  return (
    <div ref={wrapRef} className="relative inline-flex">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`btn-secondary inline-flex items-center gap-1.5 ${compact ? 'px-2 py-1 text-[11px]' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span>{feedback ?? label}</span>
        <svg
          aria-hidden="true"
          width="10"
          height="10"
          viewBox="0 0 10 10"
          className={`transition-transform ${open ? 'rotate-180' : ''}`}
        >
          <path d="M2 3.5l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-20 mt-1.5 min-w-[200px] overflow-hidden rounded-md border border-ink-700 bg-ink-900/95 shadow-xl backdrop-blur"
        >
          {items.map((it) => (
            <button
              key={it.id}
              role="menuitem"
              onClick={() => onPick(it)}
              className="flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left text-xs text-ink-200 hover:bg-ink-800/80 hover:text-ink-50"
            >
              <span>{it.label}</span>
              {it.hint && <span className="font-mono text-[10px] text-ink-500">{it.hint}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
