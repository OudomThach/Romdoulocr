import { useState, useEffect } from 'react';
import { useMetadataStore } from '@/lib/metadataStore';
import { useMetaAuth } from '@/lib/useMetaAuth';
import { metaClient } from '@/lib/metaClient';
import { LoginModal } from '@/components/LoginModal';
import { DataFormEditor } from '@/components/DataFormEditor';
import { useSettingsStore } from '@/hooks/useSettingsStore';
import { useToastStore } from '@/hooks/useToastStore';

/**
 * Inline panel after a parse: shows saved status + [Edit] to expand a dynamic
 * editor right here. Edit the extraction data AND the business metadata
 * (domain, tags, date) — no tab hopping. Saving PATCHes both at once.
 */
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
  const [domain, setDomain] = useState('');
  const [tags, setTags] = useState('');
  const [date, setDate] = useState('');
  const [docName, setDocName] = useState('');
  const [owner, setOwner] = useState('');
  const [category, setCategory] = useState('');
  const [subCategory, setSubCategory] = useState('');
  const [desc, setDesc] = useState('');
  const [published, setPublished] = useState(false);
  const [imageUrl, setImageUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!last) return null;

  const startEdit = async () => {
    setEditing(!editing);
    if (editing || data) return;
    setLoading(true);
    setError(null);
    try {
      const rec = await metaClient.getRecord(last.id);
      setData(rec.data);
      setDomain((rec.business?.domain as string) ?? '');
      setTags(((rec.business?.tags as string[]) ?? []).join(', '));
      setDate((rec.business?.date as string) ?? '');
      setDocName((rec.data?.document_name as string) ?? (rec.source?.filename as string) ?? '');
      setOwner((rec.business?.owner as string) ?? '');
      setCategory((rec.business?.category as string) ?? '');
      setSubCategory((rec.business?.sub_category as string) ?? '');
      setDesc((rec.business?.description as string) ?? '');
      setPublished(Boolean(rec.business?.published));
      setImageUrl((rec.data?.image_url as string) ?? '');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load record');
    } finally {
      setLoading(false);
    }
  };

  // Auto-expand the fill-in form on freshly-extracted records so users can
  // complete the metadata (domain, tags, date, data corrections) right after
  // extraction without an extra click.
  useEffect(() => {
    if (last?.justCreated && canEdit) {
      markOpened(last.id);
      setEditing(true);
      if (!data) {
        setLoading(true);
        metaClient.getRecord(last.id).then((rec) => {
          setData(rec.data);
          setDomain((rec.business?.domain as string) ?? '');
          setTags(((rec.business?.tags as string[]) ?? []).join(', '));
          setDate((rec.business?.date as string) ?? '');
          setDocName((rec.data?.document_name as string) ?? (rec.source?.filename as string) ?? '');
          setOwner((rec.business?.owner as string) ?? '');
          setCategory((rec.business?.category as string) ?? '');
          setSubCategory((rec.business?.sub_category as string) ?? '');
          setDesc((rec.business?.description as string) ?? '');
          setPublished(Boolean(rec.business?.published));
          setImageUrl((rec.data?.image_url as string) ?? '');
        }).catch(() => {})
          .finally(() => setLoading(false));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [last?.id, canEdit]);

  const save = async (nextData: Record<string, unknown>) => {
    setSaving(true);
    setError(null);
    const biz: Record<string, unknown> = {
      owner: owner.trim() || null,
      category: category.trim() || null,
      sub_category: subCategory.trim() || null,
      description: desc.trim() || null,
      domain: domain.trim() || null,
      tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
      date: date || null,
      published: published || null,
      published_at: published ? new Date().toISOString() : null,
    };
    const extras: Record<string, unknown> = {
      ...nextData,
      document_name: docName || null,
      image_url: imageUrl || null,
    };
    try {
      await metaClient.patchRecord(last.id, { data: extras, business: biz });
      setData(nextData);
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
          {loading && <p className="text-sm text-slate-500">Loading…</p>}
          {error && <p className="text-sm text-red-500">{error}</p>}
          {data && !loading && (
            <>
              <div className="flex flex-wrap gap-2">
                <div>
                  <label className="mb-0.5 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">Document</label>
                  <input className="input w-48" value={docName} onChange={(e) => setDocName(e.target.value)} placeholder="e.g. report-aug-2026.pdf" />
                </div>
                <div>
                  <label className="mb-0.5 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">Owner</label>
                  <input className="input w-40" value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="e.g. Oudom" />
                </div>
                <div>
                  <label className="mb-0.5 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">Category</label>
                  <input className="input w-36" value={category} onChange={(e) => setCategory(e.target.value)} placeholder="e.g. receipt" />
                </div>
                <div>
                  <label className="mb-0.5 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">Sub-category</label>
                  <input className="input w-36" value={subCategory} onChange={(e) => setSubCategory(e.target.value)} placeholder="e.g. food" />
                </div>
                <div>
                  <label className="mb-0.5 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">Domain</label>
                  <input className="input w-40" value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="e.g. logistics" />
                </div>
                <div>
                  <label className="mb-0.5 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">Tags</label>
                  <input className="input w-48" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="import, warehouse" />
                </div>
                <div>
                  <label className="mb-0.5 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">Date</label>
                  <input className="input w-36" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
                </div>
              </div>
              <div>
                <label className="mb-0.5 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">Notes</label>
                <textarea className="input min-h-16" value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Any notes about this extraction…" rows={2} />
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => setPublished((p) => !p)}
                  className="flex items-center gap-2"
                  aria-pressed={published}
                >
                  <span className={`h-5 w-9 rounded-full p-0.5 transition-colors ${published ? 'bg-accent' : 'bg-slate-300'}`}>
                    <span className={`block h-4 w-4 rounded-full bg-white shadow transition-transform ${published ? 'translate-x-4' : ''}`} />
                  </span>
                  <span className="text-sm text-slate-700">{published ? 'Published' : 'Not published'}</span>
                </button>
                <div>
                  <label className="mb-0.5 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">Image URL</label>
                  <input className="input w-48" value={imageUrl} onChange={(e) => setImageUrl(e.target.value)} placeholder="https://…" />
                </div>
              </div>
              <DataFormEditor key={last.status} data={data} onChange={save} />
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
