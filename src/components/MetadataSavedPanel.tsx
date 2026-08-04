import { useState } from 'react';
import { useMetadataStore } from '@/lib/metadataStore';
import { useMetaAuth } from '@/lib/useMetaAuth';
import { metaClient } from '@/lib/metaClient';
import { LoginModal } from '@/components/LoginModal';
import { DataFormEditor } from '@/components/DataFormEditor';
import { useSettingsStore } from '@/hooks/useSettingsStore';
import { useToastStore } from '@/hooks/useToastStore';

/**
 * Inline "Metadata saved" panel shown in a tab's results area after a parse.
 * Only renders when the saved record's filename matches the displayed result.
 *
 * "Edit" expands an inline form right here — no tab hopping — so the user can
 * fix the generated data immediately. Saving PATCHes the record (audit stamps
 * the user, status → edited). "Open full record" jumps to the Metadata tab.
 */
export function MetadataSavedPanel({ filename }: { filename?: string | null }) {
  const last = useMetadataStore((s) => s.get(filename ?? null));
  const patchSummary = useMetadataStore((s) => s.patchSummary);
  const openRecord = useMetadataStore((s) => s.openRecord);
  const setActiveTab = useSettingsStore((s) => s.setActiveTab);
  const toast = useToastStore((s) => s.push);
  const { signedIn } = useMetaAuth();
  const [loginOpen, setLoginOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [data, setData] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!last) return null;

  const startEdit = async () => {
    setEditing(true);
    setError(null);
    if (data) return;
    setLoading(true);
    try {
      const rec = await metaClient.getRecord(last.id);
      setData(rec.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load record');
    } finally {
      setLoading(false);
    }
  };

  const save = async (next: Record<string, unknown>) => {
    setSaving(true);
    setError(null);
    try {
      await metaClient.patchRecord(last.id, { data: next });
      setData(next);
      patchSummary(last.id, { status: 'edited' });
      toast('Saved — status: edited', 'success');
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const openFull = () => {
    openRecord(last.id);
    setActiveTab('metadata');
  };

  return (
    <div className="panel-sunken overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 px-4 py-3">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-accent/10 text-accent">
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <ellipse cx="12" cy="5" rx="9" ry="3" />
            <path d="M3 5v14a9 3 0 0 0 18 0V5" />
            <path d="M3 12a9 3 0 0 0 18 0" />
          </svg>
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium text-slate-950">Extraction saved</span>
            <span className="badge border-slate-200 bg-white text-slate-600">{last.type}</span>
            <span className="badge border-accent/30 bg-accent/10 text-accent">{last.status}</span>
            <span className="badge border-slate-200 bg-white text-slate-600">{last.model}</span>
          </div>
          <div className="mt-0.5 truncate font-mono text-[11px] text-slate-500">{last.id}</div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {signedIn ? (
            <button type="button" className="btn-secondary px-3 py-1.5 text-xs" onClick={() => void startEdit()} disabled={saving}>
              {editing ? 'Close editor' : 'Edit'}
            </button>
          ) : (
            <button type="button" className="btn-secondary px-3 py-1.5 text-xs" onClick={() => setLoginOpen(true)}>
              Sign in to edit
            </button>
          )}
          <button type="button" className="btn-ghost px-3 py-1.5 text-xs" onClick={openFull}>
            Open full record
          </button>
        </div>
      </div>

      {editing && (
        <div className="border-t border-slate-200 bg-white/60 px-4 py-3">
          {loading && <p className="text-sm text-slate-500">Loading…</p>}
          {error && <p className="mb-2 text-sm text-red-500">{error}</p>}
          {data && !loading && (
            <DataFormEditor
              key={last.status}
              data={data}
              onChange={(d) => {
                void save(d);
              }}
            />
          )}
        </div>
      )}

      {loginOpen && (
        <LoginModal
          onClose={() => setLoginOpen(false)}
          onSuccess={() => {
            setLoginOpen(false);
            void startEdit();
          }}
        />
      )}
    </div>
  );
}
