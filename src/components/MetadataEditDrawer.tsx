import { useEffect, useState } from 'react';
import { metaClient } from '@/lib/metaClient';
import { useToastStore } from '@/hooks/useToastStore';

/**
 * Drawer that loads a metadata record and lets the signed-in user edit its
 * `data` payload (JSON). Saving PATCHes the record — the service bumps
 * edit_count, stamps edited_at/edited_by and flips status to "edited".
 */
export function MetadataEditDrawer({ recordId, onClose }: { recordId: string; onClose: () => void }) {
  const toast = useToastStore((s) => s.push);
  const [json, setJson] = useState<string>('');
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    metaClient
      .getRecord(recordId)
      .then((rec) => {
        if (!cancelled) {
          setJson(JSON.stringify(rec.data, null, 2));
          setLoaded(true);
        }
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load record'));
    return () => {
      cancelled = true;
    };
  }, [recordId]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const parsed = JSON.parse(json);
      await metaClient.patchRecord(recordId, { data: parsed });
      toast('Record updated — status: edited', 'success');
      onClose();
    } catch (err) {
      if (err instanceof SyntaxError) setError('Invalid JSON — check the braces and commas.');
      else setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-950/40 backdrop-blur-sm" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="panel-raised flex h-full w-full max-w-xl flex-col rounded-none rounded-l-[22px] p-5" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="display text-lg">Edit record data</h2>
          <button type="button" className="btn-ghost px-3 py-1.5 text-sm" onClick={onClose}>
            ✕
          </button>
        </div>
        <p className="mt-1 truncate font-mono text-[11px] text-slate-500">{recordId}</p>
        <p className="mt-2 text-xs text-slate-500">
          Saving bumps <code className="font-mono">edit_count</code>, stamps <code className="font-mono">edited_by</code> and sets status to{' '}
          <span className="font-medium text-accent2">edited</span>.
        </p>

        <textarea
          className="input mt-3 min-h-0 flex-1 grow-0 font-mono text-xs"
          style={{ minHeight: '40vh' }}
          value={json}
          onChange={(e) => setJson(e.target.value)}
          spellCheck={false}
          placeholder={loaded ? undefined : 'Loading…'}
          disabled={!loaded}
        />
        {error && <p className="mt-2 text-sm text-red-500">{error}</p>}

        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn-primary" onClick={save} disabled={saving || !loaded}>
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </div>
    </div>
  );
}
