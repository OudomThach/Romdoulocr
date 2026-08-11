import { useState, type CSSProperties } from 'react';
import { useMetadataStore } from '@/lib/metadataStore';
import { useMetaAuth } from '@/lib/useMetaAuth';
import { metaClient } from '@/lib/metaClient';
import { useToastStore } from '@/hooks/useToastStore';

/**
 * Inline editor for the OCR text result: display the extracted text with an
 * "Edit text" toggle; saving PATCHes the record's `full_text` (the record is
 * auto-saved as `raw` right after OCR, so this is the correction step before
 * publishing). Viewers without an editor role see the plain text only.
 */
export function EditableOcrText({
  filename,
  text,
  fontStyle,
}: {
  filename: string | null;
  text: string;
  fontStyle?: CSSProperties;
}) {
  const last = useMetadataStore((s) => s.get(filename ?? null));
  const patchSummary = useMetadataStore((s) => s.patchSummary);
  const toast = useToastStore((s) => s.push);
  const { user } = useMetaAuth();
  const canEdit = user?.role === 'admin' || user?.role === 'editor';
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const startEdit = () => {
    setDraft(text);
    setError(null);
    setEditing(true);
  };

  const save = async () => {
    if (!last) return;
    setSaving(true);
    setError(null);
    try {
      const rec = await metaClient.getRecord(last.id);
      const prevData = { ...rec.data };
      await metaClient.patchRecord(last.id, { data: { ...prevData, full_text: draft } });
      patchSummary(last.id, { status: 'edited' });
      toast('OCR text saved — status: edited', 'success', {
        label: 'Undo',
        run: () => {
          void metaClient.patchRecord(last.id, { data: prevData }).then(() => {
            patchSummary(last.id, { status: 'raw' });
            toast('Reverted — OCR text restored', 'info');
          }).catch(() => toast('Undo failed', 'error'));
        },
      });
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  if (editing && last && canEdit) {
    return (
      <div className="space-y-2">
        <textarea
          className="min-h-56 w-full resize-y rounded-lg border border-slate-200 bg-slate-50 p-3 text-base leading-relaxed focus:border-accent focus:outline-none"
          style={fontStyle}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          spellCheck={false}
          autoFocus
        />
        {error && <p className="text-xs text-red-500">{error}</p>}
        <div className="flex items-center gap-2">
          <button type="button" className="btn-primary px-3 py-1.5 text-xs" onClick={() => void save()} disabled={saving}>
            {saving ? 'Saving…' : 'Save changes'}
          </button>
          <button type="button" className="btn-ghost px-3 py-1.5 text-xs" onClick={() => setEditing(false)} disabled={saving}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="relative">
      {canEdit && last && (
        <button
          type="button"
          onClick={startEdit}
          className="absolute -top-9 right-0 z-10 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-semibold text-slate-600 shadow-sm hover:bg-slate-50 hover:text-slate-950"
          title="Correct the OCR text before publishing"
        >
          Edit text
        </button>
      )}
      <div className="whitespace-pre-wrap text-base leading-relaxed" style={fontStyle}>
        {text}
      </div>
    </div>
  );
}
