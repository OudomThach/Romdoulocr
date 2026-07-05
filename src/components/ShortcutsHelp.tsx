import { useEffect, useState } from 'react';

interface Shortcut {
  keys: string[];
  desc: string;
}

const SHORTCUTS: Shortcut[] = [
  { keys: ['Ctrl', 'Enter'], desc: 'Extract / run the current tab' },
  { keys: ['Esc'], desc: 'Cancel a running extraction' },
  { keys: ['←', '→'], desc: 'Previous / next page in the preview' },
  { keys: ['+', '−', '0'], desc: 'Zoom in / out / fit the page image' },
  { keys: ['Ctrl', 'scroll'], desc: 'Zoom the page image with the wheel' },
  { keys: ['Ctrl', 'V'], desc: 'Paste an image straight into the active tab' },
  { keys: ['?'], desc: 'Open this shortcuts list' },
];

/**
 * Global keyboard-shortcut cheat sheet. A floating "?" button (bottom-right)
 * and the "?" key both open it; Esc or a backdrop click closes it. Shortcuts
 * here aren't otherwise discoverable, so this is the single source of truth.
 */
export function ShortcutsHelp() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
      if (e.key === '?' && !typing) {
        e.preventDefault();
        setOpen((v) => !v);
      } else if (e.key === 'Escape' && open) {
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <>
      {/* Desktop-only: keyboard shortcuts mean nothing on touch, and the FAB
          was covering the mobile bottom-nav's History item. Phones get the
          settings gear in this corner instead (see App.tsx). */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Keyboard shortcuts (?)"
        aria-label="Keyboard shortcuts"
        className="fixed bottom-4 right-4 z-30 hidden h-10 w-10 place-items-center rounded-full border border-slate-200 bg-white text-base font-bold text-slate-600 shadow-md transition-colors hover:bg-slate-50 hover:text-slate-950 sm:grid"
      >
        ?
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-slate-950/60 p-4 backdrop-blur-sm"
          onClick={() => setOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-base font-semibold text-slate-950">Keyboard shortcuts</h2>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-lg px-2 py-1 text-sm font-semibold text-slate-500 hover:bg-slate-100 hover:text-slate-950"
              >
                Close
              </button>
            </div>
            <ul className="grid gap-2.5">
              {SHORTCUTS.map((s) => (
                <li key={s.desc} className="flex items-center justify-between gap-4">
                  <span className="text-sm text-slate-700">{s.desc}</span>
                  <span className="flex shrink-0 items-center gap-1">
                    {s.keys.map((k) => (
                      <kbd
                        key={k}
                        className="rounded-md border border-slate-300 bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-700 shadow-sm"
                      >
                        {k}
                      </kbd>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </>
  );
}
