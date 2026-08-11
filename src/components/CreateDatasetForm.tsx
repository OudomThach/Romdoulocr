import { useEffect, useRef, useState } from 'react';

/**
 * "Create New Public Dataset" form — the post-OCR publishing step.
 *
 * Collects the public-dataset metadata (name, managed by, frequency, coverage,
 * categories, collection, source URL, description), an uploaded data file, and
 * a UI validation pass ("Data and validation"). Nothing here talks to a dataset
 * API — the payload is saved onto the extraction record (`data.dataset`) and the
 * uploaded file is recorded as metadata (name/size/type) until a dataset
 * backend exists.
 *
 * Created / Last updated are read-only, sourced from the record's audit trail.
 */

export interface DatasetFile {
  name: string;
  size: number;
  type: string;
}

export interface DatasetPayload {
  name?: string | null;
  managed_by?: string | null;
  frequency?: string | null;
  coverage_start?: string | null;
  coverage_end?: string | null;
  categories?: string | null;
  collection?: string | null;
  url?: string | null;
  description?: string | null;
  file?: DatasetFile | null;
  /** Raw bytes of the uploaded data file, base64 — only when ≤ EMBED_MAX bytes. */
  file_base64?: string | null;
}

const ACCEPTED_EXT = ['.csv', '.geojson', '.kml', '.pdf', '.parquet', '.orc', '.xlsx', '.xls', '.xlsm'];
const FREQUENCIES = ['Daily', 'Weekly', 'Monthly', 'Quarterly', 'Yearly', 'Irregular'];
const DESC_MAX = 1500;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Files up to this size are embedded in the record (base64) so they can be
 * downloaded from the portal; bigger ones keep name/size only. */
const EMBED_MAX = 5 * 1024 * 1024;

function fmtStamp(v?: string): string {
  if (!v) return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
}

function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i).toLowerCase();
}

function fmtSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

// --------------------------------------------------------------------------- #
// OCR-text → dataset suggestions. Best-effort heuristics; every rule only
// fills a field the user has NOT already typed, so nothing is overwritten.
// --------------------------------------------------------------------------- #
const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
const ORG_RE = /(ABA\s*Bank|ACLEDA\s*Bank|Wing\s*(?:Cambodia)?|Bakong|Canadia\s*Bank|PRASAC|Vattanac\s*Bank|Sathapana\s*Bank|Bank\s*of\s*Cambodia)/i;

function toIso(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Dates found in the text, normalized to ISO (yyyy-mm-dd), sorted. */
function detectDates(raw: string): string[] {
  const hits: string[] = [];
  const monthRe = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})\b/gi;
  let m: RegExpExecArray | null;
  while ((m = monthRe.exec(raw)) !== null) hits.push(m[0]);
  const isoRe = /\b(\d{4})[-/](\d{1,2})[-/](\d{1,2})\b/g;
  while ((m = isoRe.exec(raw)) !== null) hits.push(m[0]);
  const dmyRe = /\b(\d{1,2})[-/](\d{1,2})[-/](\d{4})\b/g;
  while ((m = dmyRe.exec(raw)) !== null) hits.push(m[0]);

  const out: string[] = [];
  for (const h of hits) {
    const mm = h.match(/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})$/i);
    if (mm) {
      out.push(toIso(Number(mm[3]), MONTHS[mm[1].slice(0, 3).toLowerCase()], Number(mm[2])));
      continue;
    }
    const iso = h.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
    if (iso) {
      out.push(toIso(Number(iso[1]), Number(iso[2]), Number(iso[3])));
      continue;
    }
    const dmy = h.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
    if (dmy) out.push(toIso(Number(dmy[3]), Number(dmy[2]), Number(dmy[1])));
  }
  return [...new Set(out)].sort();
}

/** Best-effort dataset fields from the OCR text. */
function suggestFromText(raw: string): Partial<DatasetPayload> {
  const out: Partial<DatasetPayload> = {};
  const text = raw || '';
  if (!text.trim()) return out;

  const dates = detectDates(text);
  if (dates.length) out.coverage_start = dates[0];
  if (dates.length > 1) out.coverage_end = dates[dates.length - 1];

  const org = text.match(ORG_RE);
  if (org) out.managed_by = org[1];

  if (/KHQR|QR|transfer|transaction|payment|deposit|withdraw/i.test(text)) {
    out.categories = 'receipt, bank transfer';
  } else if (/invoice|bill|tax/i.test(text)) {
    out.categories = 'invoice';
  } else if (/report|survey|yearbook|index|statistic/i.test(text)) {
    out.categories = 'report';
  }

  const url = text.match(/https?:\/\/\S+/);
  if (url) out.url = url[0];

  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const firstLine = lines[0];
  if (firstLine && firstLine.length <= 90) out.name = firstLine;

  if (lines.length >= 2) {
    out.description = lines.slice(0, 2).join(' ');
  } else if (lines.length === 1) {
    out.description = lines[0];
  }
  if (out.description && out.description.length > 300) {
    out.description = `${out.description.slice(0, 300)}…`;
  }
  return out;
}

export function CreateDatasetForm({
  initial,
  text,
  createdAt,
  updatedAt,
  saving,
  onSave,
}: {
  initial?: Record<string, unknown> | null;
  text?: string;
  createdAt?: string;
  updatedAt?: string;
  saving?: boolean;
  onSave: (payload: DatasetPayload) => void;
}) {
  const [name, setName] = useState('');
  const [managedBy, setManagedBy] = useState('');
  const [frequency, setFrequency] = useState('');
  const [coverageStart, setCoverageStart] = useState('');
  const [coverageEnd, setCoverageEnd] = useState('');
  const [categories, setCategories] = useState('');
  const [collection, setCollection] = useState('');
  const [url, setUrl] = useState('');
  const [description, setDescription] = useState('');
  const [file, setFile] = useState<DatasetFile | null>(null);
  const [fileBase64, setFileBase64] = useState<string | null>(null);
  const [embedNote, setEmbedNote] = useState<string | null>(null);
  const [dropError, setDropError] = useState<string | null>(null);
  const [validation, setValidation] = useState<{ ok: boolean; issues: string[] } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const d = initial || {};
    setName(String(d.name ?? ''));
    setManagedBy(String(d.managed_by ?? ''));
    setFrequency(String(d.frequency ?? ''));
    setCoverageStart(String(d.coverage_start ?? ''));
    setCoverageEnd(String(d.coverage_end ?? ''));
    setCategories(Array.isArray(d.categories) ? (d.categories as string[]).join(', ') : String(d.categories ?? ''));
    setCollection(String(d.collection ?? ''));
    setUrl(String(d.url ?? ''));
    setDescription(String(d.description ?? ''));
    setFile((d.file as DatasetFile | null) ?? null);
    setFileBase64(String(d.file_base64 ?? '') || null);
    setEmbedNote((d.file as DatasetFile | null) ? (String(d.file_base64 ?? '') ? null : 'not embedded (larger than 5 MB)') : null);
  }, [initial]);

  const readFileBase64 = (f: File, cb: (b64: string | null, note: string | null) => void) => {
    if (f.size > EMBED_MAX) {
      cb(null, 'too large to embed (name/size saved only)');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result ?? '');
      cb(dataUrl.includes(',') ? dataUrl.split(',', 2)[1] : dataUrl, null);
    };
    reader.onerror = () => cb(null, 'could not read file bytes');
    reader.readAsDataURL(f);
  };

  const acceptFile = (f: File | undefined | null) => {
    setDropError(null);
    if (!f) return;
    if (!ACCEPTED_EXT.includes(extOf(f.name))) {
      setDropError(`Only ${ACCEPTED_EXT.join(' ')} files are accepted`);
      return;
    }
    setFile({ name: f.name, size: f.size, type: f.type });
    setFileBase64(null);
    setEmbedNote(null);
    setValidation(null);
    readFileBase64(f, (b64, note) => { setFileBase64(b64); setEmbedNote(note); });
  };

  const runValidation = () => {
    const issues: string[] = [];
    if (!name.trim()) issues.push('Dataset name is required.');
    if (!managedBy.trim()) issues.push('Managed by is required.');
    if (!frequency) issues.push('Frequency is required.');
    if (!coverageStart) issues.push('Coverage start is required.');
    else if (!DATE_RE.test(coverageStart)) issues.push('Coverage start must be a valid date (MM/DD/YYYY).');
    if (coverageEnd && (!DATE_RE.test(coverageEnd) || coverageEnd < coverageStart)) {
      issues.push('Coverage end must be a valid date on or after coverage start.');
    }
    if (!categories.trim()) issues.push('Categories are required.');
    if (description.length > DESC_MAX) issues.push(`Description exceeds the ${DESC_MAX} character limit (${description.length}).`);
    if (url.trim() && !/^https?:\/\/\S+\.\S+/.test(url.trim())) issues.push('URL / Source link must be a valid http(s) link.');
    if (!file) issues.push('Upload a data file.');
    setValidation({ ok: issues.length === 0, issues });
  };

  // Fill ONLY fields the user has not typed yet — never overwrite an edit.
  const applySuggestions = () => {
    const s = suggestFromText(text ?? '');
    if (!name.trim() && s.name) setName(s.name);
    if (!managedBy.trim() && s.managed_by) setManagedBy(s.managed_by);
    if (!coverageStart && s.coverage_start) setCoverageStart(s.coverage_start);
    if (!coverageEnd && s.coverage_end) setCoverageEnd(s.coverage_end);
    if (!categories.trim() && s.categories) setCategories(s.categories);
    if (!url.trim() && s.url) setUrl(s.url);
    if (!description.trim() && s.description) setDescription(s.description);
    setValidation(null);
  };

  // Auto-suggest once on first open when nothing was typed yet.
  const autoSuggested = useRef(false);
  useEffect(() => {
    if (autoSuggested.current) return;
    if (!text?.trim()) return;
    const anyFilled = name.trim() || managedBy.trim() || coverageStart || categories.trim();
    if (anyFilled) return;
    autoSuggested.current = true;
    applySuggestions();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  const save = () => {
    const payload: DatasetPayload = {
      name: name.trim() || null,
      managed_by: managedBy.trim() || null,
      frequency: frequency || null,
      coverage_start: coverageStart || null,
      coverage_end: coverageEnd || null,
      categories: categories.trim() || null,
      collection: collection.trim() || null,
      url: url.trim() || null,
      description: description.trim() || null,
      file,
      file_base64: fileBase64,
    };
    onSave(payload);
  };

  return (
    <div className="rounded-xl border border-slate-200 bg-white/70 p-4">
      <div className="mb-1 flex items-center justify-between gap-2">
        <div>
          <div className="text-sm font-semibold text-slate-900">Create New Public Dataset</div>
          <div className="text-xs text-slate-500">Create a new open dataset for public access.</div>
        </div>
        {text?.trim() && (
          <button
            type="button"
            onClick={applySuggestions}
            className="btn-secondary px-3 py-1.5 text-xs"
            title="Fill empty fields from the OCR text"
          >
            ✨ Suggest from OCR
          </button>
        )}
      </div>

      <div className="flex flex-wrap gap-3">
        <div className="w-full">
          <label className="mb-0.5 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">Dataset name *</label>
          <input className="input w-full" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Cambodia CPI Reports 1994–2025" />
        </div>
        <div>
          <label className="mb-0.5 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">Managed by *</label>
          <input className="input w-56" value={managedBy} onChange={(e) => setManagedBy(e.target.value)} placeholder="e.g. GDDE, MEF" />
        </div>
        <div>
          <label className="mb-0.5 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">Frequency *</label>
          <select className="input w-36" value={frequency} onChange={(e) => setFrequency(e.target.value)}>
            <option value="">Select…</option>
            {FREQUENCIES.map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
        </div>
        <div>
          <label className="mb-0.5 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">Coverage start *</label>
          <input className="input w-36" type="date" value={coverageStart} onChange={(e) => setCoverageStart(e.target.value)} />
        </div>
        <div>
          <label className="mb-0.5 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">Coverage end</label>
          <input className="input w-36" type="date" value={coverageEnd} onChange={(e) => setCoverageEnd(e.target.value)} />
        </div>
        <div>
          <label className="mb-0.5 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">Categories *</label>
          <input className="input w-48" value={categories} onChange={(e) => setCategories(e.target.value)} placeholder="Search by collection name" />
        </div>
        <div>
          <label className="mb-0.5 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">Collection</label>
          <input className="input w-48" value={collection} onChange={(e) => setCollection(e.target.value)} placeholder="e.g. NIS Publications" />
        </div>
        <div className="w-full">
          <label className="mb-0.5 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">URL / Source link</label>
          <input className="input w-full" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" />
        </div>
      </div>

      <div className="mt-3">
        <label className="mb-0.5 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          Description <span className="normal-case text-slate-400">({description.length}/{DESC_MAX})</span>
        </label>
        <textarea
          className="input min-h-20 w-full"
          value={description}
          onChange={(e) => setDescription(e.target.value.slice(0, DESC_MAX))}
          placeholder="Describe the dataset…"
          rows={3}
        />
      </div>

      <div className="mt-3">
        <label className="mb-0.5 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">Data and validation</label>
        <p className="mb-2 text-xs text-slate-500">Ensure display formats, and details are accurately filled. Start the validation when you're ready.</p>
        <div className="flex items-center gap-2">
          <button type="button" className="btn-secondary px-3 py-1.5 text-xs" onClick={runValidation}>
            Start the validation
          </button>
          {validation && (
            <span className={`text-xs ${validation.ok ? 'text-emerald-600' : 'text-red-500'}`}>
              {validation.ok ? 'Validation passed — ready to publish.' : `${validation.issues.length} issue(s) found.`}
            </span>
          )}
        </div>
        {validation && !validation.ok && (
          <ul className="mt-2 space-y-0.5">
            {validation.issues.map((issue, i) => (
              <li key={i} className="text-xs text-red-500">• {issue}</li>
            ))}
          </ul>
        )}
      </div>

      <div className="mt-3">
        <label className="mb-0.5 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">Upload a data file *</label>
        <div
          tabIndex={0}
          onDragOver={(e) => { e.preventDefault(); }}
          onDrop={(e) => { e.preventDefault(); acceptFile(e.dataTransfer.files?.[0]); }}
          onPaste={(e) => acceptFile(e.clipboardData.files?.[0])}
          onClick={() => fileInput.current?.click()}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') fileInput.current?.click(); }}
          className="cursor-pointer rounded-xl border border-dashed border-slate-300 bg-white/60 px-4 py-5 text-center outline-none transition-colors hover:border-accent focus:border-accent"
        >
          {file ? (
            <div className="text-sm">
              <span className="font-medium text-slate-900">{file.name}</span>
              <span className="ml-2 text-xs text-slate-500">{fmtSize(file.size)}</span>
              <span className={`ml-2 text-xs ${embedNote ? 'text-amber-600' : 'text-emerald-600'}`}>
                {embedNote ?? 'embedded — downloadable from the portal'}
              </span>
              <button
                type="button"
                className="ml-3 text-xs text-red-500 hover:underline"
                onClick={(e) => { e.stopPropagation(); setFile(null); setFileBase64(null); setEmbedNote(null); }}
              >
                remove
              </button>
            </div>
          ) : (
            <div className="text-sm text-slate-500">
              Drop file here, Click or press Ctrl + V to upload.
              <div className="mt-1 text-[11px] text-slate-400">Only {ACCEPTED_EXT.join(' ')} formats are accepted</div>
            </div>
          )}
        </div>
        <input
          ref={fileInput}
          type="file"
          className="hidden"
          accept={ACCEPTED_EXT.join(',')}
          onChange={(e) => { acceptFile(e.target.files?.[0]); e.target.value = ''; }}
        />
        {dropError && <p className="mt-1 text-xs text-red-500">{dropError}</p>}
      </div>

      <div className="mt-3 flex items-center justify-between border-t border-slate-200 pt-3">
        <span className="text-[11px] text-slate-400">
          Created: {fmtStamp(createdAt)} · Updated: {fmtStamp(updatedAt)}
        </span>
        <button type="button" className="btn-primary px-4 py-1.5 text-xs" onClick={save} disabled={saving}>
          {saving ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </div>
  );
}
