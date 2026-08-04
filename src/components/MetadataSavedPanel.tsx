import { useState } from 'react';
import { useMetadataStore } from '@/lib/metadataStore';
import { useMetaAuth } from '@/lib/useMetaAuth';
import { LoginModal } from '@/components/LoginModal';
import { useSettingsStore } from '@/hooks/useSettingsStore';

/**
 * Inline "Metadata saved" panel shown in a tab's results area after a parse.
 * Only renders when the saved record's filename matches the displayed result
 * (so stale panels never appear for other documents).
 *
 * "Edit" opens the record in the Metadata tab's full editor (form + history)
 * via the shared metadata store + tab switcher.
 */
export function MetadataSavedPanel({ filename }: { filename?: string | null }) {
  const last = useMetadataStore((s) => s.get(filename ?? null));
  const openRecord = useMetadataStore((s) => s.openRecord);
  const setActiveTab = useSettingsStore((s) => s.setActiveTab);
  const { signedIn } = useMetaAuth();
  const [loginOpen, setLoginOpen] = useState(false);

  if (!last) return null;

  const openEditor = () => {
    openRecord(last.id);
    setActiveTab('metadata');
  };

  return (
    <div className="panel-sunken flex flex-wrap items-center gap-3 px-4 py-3">
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-accent/10 text-accent">
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <ellipse cx="12" cy="5" rx="9" ry="3" />
          <path d="M3 5v14a9 3 0 0 0 18 0V5" />
          <path d="M3 12a9 3 0 0 0 18 0" />
        </svg>
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-medium text-slate-950">Metadata saved</span>
          <span className="badge border-slate-200 bg-white text-slate-600">{last.type}</span>
          <span className="badge border-accent/30 bg-accent/10 text-accent">{last.status}</span>
          <span className="badge border-slate-200 bg-white text-slate-600">{last.model}</span>
        </div>
        <div className="mt-0.5 truncate font-mono text-[11px] text-slate-500">{last.id}</div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {signedIn ? (
          <button type="button" className="btn-secondary px-3 py-1.5 text-xs" onClick={openEditor}>
            Edit & history
          </button>
        ) : (
          <button type="button" className="btn-secondary px-3 py-1.5 text-xs" onClick={() => setLoginOpen(true)}>
            Sign in to edit
          </button>
        )}
        <a href="/portal" target="_blank" rel="noreferrer" className="btn-ghost px-3 py-1.5 text-xs">
          Open in portal ↗
        </a>
      </div>

      {loginOpen && <LoginModal onClose={() => setLoginOpen(false)} />}
    </div>
  );
}
