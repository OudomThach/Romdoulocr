import { useState, useEffect } from 'react';
import { useMetadataStore } from '@/lib/metadataStore';
import { useMetaAuth } from '@/lib/useMetaAuth';
import { metaClient } from '@/lib/metaClient';
import { LoginModal } from '@/components/LoginModal';
import { CreateDatasetForm, type DatasetPayload } from '@/components/CreateDatasetForm';
import { buildCsv, buildMarkdown } from '@/lib/datasetArtifacts';
import { useSettingsStore } from '@/hooks/useSettingsStore';
import { useToastStore } from '@/hooks/useToastStore';

/**
 * Inline panel after a parse: the forced Review & Save gate.
 *
 * The extraction is auto-saved as a `raw` draft the moment OCR finishes (with
 * markdown/csv/json artifacts â€” see lib/api.ts reportExtraction); this panel
 * makes the user VERIFY before the record counts:
 *   â‘  review/correct the OCR text,
 *   â‘¡ confirm the dataset metadata,
 *   â‘¢ tick "I verified the text and metadata" â€” Save stays blocked until then.
 *
 * On save the record is PATCHed with the CORRECTED text plus regenerated
 * `markdown` and `csv` of the final text (original if nothing was edited), and
 * the audit trail flips status raw â†’ edited.
 */

// --------------------------------------------------------------------------- #
// Line-level diff (LCS) for the review step: shows what the user changed
// compared to the original OCR text. Word-level would blow up the DP table on
// long pages; line-level is cheap and honest for "you changed these lines".
// --------------------------------------------------------------------------- #
type DiffLine = { kind: 'same' | 'del' | 'add'; text: string };

function diffLines(a: string, b: string): DiffLine[] {
  const al = a.split('\n');
  const bl = b.split('\n');
  const n = al.length;
  const m = bl.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = al[i] === bl[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (al[i] === bl[j]) {
      out.push({ kind: 'same', text: al[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ kind: 'del', text: al[i] });
      i++;
    } else {
      out.push({ kind: 'add', text: bl[j] });
      j++;
    }
  }
  while (i < n) out.push({ kind: 'del', text: al[i++] });
  while (j < m) out.push({ kind: 'add', text: bl[j++] });
  return out;
}

export function MetadataSavedPanel({ filename }: { filename?: string | null }) {
  const last = useMetadataStore((s) => s.get(filename ?? null));
  const patchSummary = useMetadataStore((s) => s.patchSummary);
  const markOpened = useMetadataStore((s) => s.markOpened);
  const openRecord = useMetadataStore((s) => s.openRecord);
  const setActiveTab = useSettingsStore((s) => s.setActiveTab);
  const toast = useToastStore((s) => s.push);
  const { signedIn, user } = useMetaAuth();
  const canEdit = user?.role === 'admin' || user?.role === 'editor';
  const [loginOpen, setLoginOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [data, setData] = useState<Record<string, unknown> | null>(null);
  const [dataset, setDataset] = useState<Record<string, unknown> | null>(null);
  const [reviewText, setReviewText] = useState('');
  const [originalText, setOriginalText] = useState('');
  const [verifyChecked, setVerifyChecked] = useState(false);
  const [createdAt, setCreatedAt] = useState('');
  const [updatedAt, setUpdatedAt] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showDiff, setShowDiff] = useState(false);
  const [draftSavedAt, setDraftSavedAt] = useState('');

  const applyRecord = (rec: { data?: Record<string, unknown>; created_at?: string; audit?: { edited_at?: string } | null }) => {
    const fullText = ((rec.data?.full_text as string) ?? '').trim();
    setData(rec.data ?? {});
    setDataset((rec.data?.dataset as Record<string, unknown>) ?? {});
    setReviewText(fullText);
    setOriginalText(fullText);
    setCreatedAt(rec.created_at ?? '');
    setUpdatedAt(rec.audit?.edited_at ?? '');
    setDraftSavedAt(rec.audit?.edited_at ?? rec.created_at ?? '');
  };

  // Auto-expand the review gate on freshly-extracted records so users verify
  // right after extraction. MUST be before the conditional return.
  useEffect(() => {
    if (!last || !last.justCreated || !canEdit) return;
    markOpened(last.id);
    setEditing(true);
    if (!data) {
      setLoading(true);
      metaClient.getRecord(last.id).then(applyRecord).catch(() => {})
        .finally(() => setLoading(false));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [last?.id, canEdit]);

  if (!last) return null;

  const startEdit = async () => {
    setEditing(!editing);
    if (editing || data) return;
    setLoading(true);
    setError(null);
    try {
      applyRecord(await metaClient.getRecord(last.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load record');
    } finally {
      setLoading(false);
    }
  };

  // The single save path for the whole review gate. Blocked until the user
  // has ticked the verification checkbox.
  const save = async (payload: DatasetPayload) => {
    if (!verifyChecked) {
      setError('Please tick "I verified the text and metadata" before saving.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const finalText = reviewText.trim() || originalText;
      const prevData = { ...(data ?? {}) };
      const nextData: Record<string, unknown> = {
        ...prevData,
        full_text: finalText,
        markdown: buildMarkdown(finalText),
        csv: buildCsv(finalText),
        dataset: { ...(dataset ?? {}), ...payload },
      };
      const rec = await metaClient.patchRecord(last.id, { data: nextData });
      setData(rec.data);
      setDataset((rec.data?.dataset as Record<string, unknown>) ?? {});
      setUpdatedAt((rec.audit?.edited_at as string) ?? '');
      patchSummary(last.id, { status: 'edited' });
      toast('Saved â€” CSV + Markdown generated, status: edited', 'success', {
        label: 'Undo',
        run: () => {
          void metaClient.patchRecord(last.id, { data: prevData }).then(() => {
            patchSummary(last.id, { status: 'raw' });
            toast('Reverted â€” draft restored', 'info');
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
          {canEdit && !editing && last.status === 'raw' && (
            <button
              type="button"
              className="btn-secondary px-3 py-1.5 text-xs"
              onClick={() => void startEdit()}
              title={draftSavedAt ? `Draft saved ${draftSavedAt.replace('T', ' ').slice(0, 16)} â€” resume the review` : 'Resume the verification review'}
            >
              âŽ Resume review
            </button>
          )}
          {canEdit ? (
            <button type="button" className="btn-secondary px-3 py-1.5 text-xs" onClick={() => void startEdit()} disabled={saving}>
              {editing ? 'Close' : 'Edit'}
            </button>
          ) : signedIn ? (
            <span className="text-xs text-slate-400 italic">view only (editor role needed)</span>
          ) : (
            <button type="button" className="btn-secondary px-3 py-1.5 text-xs" onClick={() => setLoginOpen(true)}>
              Sign in to edit
            </button>
          )}
          <button type="button" className="btn-ghost px-3 py-1.5 text-xs" onClick={openFull}>
            Full record
          </button>
        </div>
      </div>

      {editing && (
        <div className="border-t border-slate-200 bg-white/60 px-4 py-3 space-y-3">
          {loading && <p className="text-sm text-slate-500">Loadingâ€¦</p>}
          {error && <p className="text-sm text-red-500">{error}</p>}
          {data && !loading && (
            <>
              {/* â‘  Review / correct the OCR text */}
              <div className="rounded-xl border border-slate-200 bg-white/70 p-4">
                <div className="mb-1 flex items-center justify-between gap-2">
                  <div className="text-sm font-semibold text-slate-900">Review OCR text</div>
                  <div className="flex items-center gap-2">
                    {reviewText !== originalText && (
                      <button
                        type="button"
                        className={`rounded-md px-2 py-1 text-xs font-medium transition-colors ${showDiff ? 'bg-accent2/10 text-accent2' : 'bg-slate-100 text-slate-600 hover:text-slate-950'}`}
                        onClick={() => setShowDiff(!showDiff)}
                      >
                        {showDiff ? 'Hide changes' : `Show changes (${diffLines(originalText, reviewText).filter((l) => l.kind !== 'same').length})`}
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn-ghost px-2 py-0.5 text-[11px]"
                      onClick={() => setReviewText(originalText)}
                      disabled={reviewText === originalText}
                    >
                      Restore original
                    </button>
                  </div>
                </div>
                <p className="mb-2 text-xs text-slate-500">Correct any misreads before saving â€” numbers, dates, names and totals.</p>
                {showDiff && reviewText !== originalText ? (
                  <div className="max-h-64 overflow-auto rounded-lg border border-slate-200 bg-slate-50 p-3 font-mono text-xs leading-relaxed">
                    {diffLines(originalText, reviewText).map((line, idx) => {
                      if (line.kind === 'same') {
                        return <div key={idx} className="text-slate-400">{line.text || ' '}</div>;
                      }
                      if (line.kind === 'del') {
                        return <div key={idx} className="bg-red-50 text-red-600 line-through dark:bg-red-500/10">{line.text || ' '}</div>;
                      }
                      return <div key={idx} className="bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10">{line.text || ' '}</div>;
                    })}
                  </div>
                ) : (
                  <textarea
                    className="input min-h-32 w-full resize-y text-sm leading-relaxed"
                    style={{ fontFamily: "'Noto Sans Khmer', 'Khmer OS Siemreap', 'Segoe UI', sans-serif" }}
                    value={reviewText}
                    onChange={(e) => setReviewText(e.target.value)}
                    spellCheck={false}
                    placeholder="OCR textâ€¦"
                  />
                )}
                <div className="mt-1 flex justify-end text-[11px] text-slate-400">
                  {reviewText === originalText ? 'original (unchanged)' : `${reviewText.length} chars â€” edited`}
                </div>
              </div>

              {/* â‘¡ Dataset metadata */}
              <CreateDatasetForm
                initial={dataset}
                text={reviewText}
                createdAt={createdAt}
                updatedAt={updatedAt}
                saving={saving}
                onSave={save}
              />

              {/* â‘¢ Verification gate */}
              <div className={`rounded-xl border p-4 ${verifyChecked ? 'border-emerald-300 bg-emerald-50/60' : 'border-slate-300 bg-amber-50/60'}`}>
                <label className="flex cursor-pointer items-start gap-2">
                  <input
                    type="checkbox"
                    checked={verifyChecked}
                    onChange={(e) => { setVerifyChecked(e.target.checked); setError(null); }}
                    className="mt-0.5 rounded border-slate-300"
                  />
                  <span className="text-sm text-slate-700">
                    <span className="font-semibold text-slate-900">I verified the OCR text and metadata</span>
                    <span className="ml-1 text-red-500">*</span>
                    <span className="block text-xs text-slate-500">
                      Recheck the text against the original before saving â€” OCR can misread stacked Khmer consonants,
                      faint scans and table cells. Pay closest attention to numbers, dates, names and totals.
                    </span>
                  </span>
                </label>
              </div>

              <div className="flex justify-end">
                <button
                  type="button"
                  className="btn-primary px-4 py-2 text-sm"
                  disabled={!verifyChecked || saving}
                  onClick={() => void save({})}
                  title={verifyChecked ? 'Save corrected text + metadata (auto-generates CSV & Markdown)' : 'Tick the verification box first'}
                >
                  {saving ? 'Savingâ€¦' : 'Verify & Save'}
                </button>
              </div>
            </>
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
