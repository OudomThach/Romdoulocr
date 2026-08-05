import { useMemo, useState } from "react";

// Fully dynamic field editor for a record's `data` object.
// - Rename fields, change types, add/remove freely
// - Changes preview: shows what fields will change before saving
// - Form / JSON toggle for power users

type FieldType = 'string' | 'number' | 'boolean' | 'json';

interface Field {
  key: string;
  type: FieldType;
  value: string;
}

function detectType(v: unknown): FieldType {
  if (typeof v === 'number') return 'number';
  if (typeof v === 'boolean') return 'boolean';
  if (v === null || typeof v === 'object') return 'json';
  return 'string';
}

function toText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function convertValue(v: string, fromType: FieldType, toType: FieldType): string {
  if (fromType === toType) return v;
  if (toType === 'string') return v;
  if (toType === 'number') {
    const n = Number(v);
    return Number.isNaN(n) ? v : String(n);
  }
  if (toType === 'boolean') return v !== '' && v !== '0' && v !== 'false' ? 'true' : 'false';
  if (toType === 'json') {
    try { return JSON.stringify(JSON.parse(v)); } catch { return JSON.stringify(v); }
  }
  return v;
}

export default function DataFormEditor({
  data,
  onChange,
}: {
  data: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const [viewMode, setViewMode] = useState<'form' | 'table' | 'json'>('form');
  const [showPreview, setShowPreview] = useState(false);
  const [jsonText, setJsonText] = useState<string>(() => JSON.stringify(data, null, 2));
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [fields, setFields] = useState<Field[]>(() =>
    Object.entries(data).map(([key, v]) => ({ key, type: detectType(v), value: v === null ? '' : toText(v) })),
  );
  const [renameKey, setRenameKey] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [newKey, setNewKey] = useState('');
  const [newType, setNewType] = useState<FieldType>('string');
  const [newValue, setNewValue] = useState('');

  const fieldErrors = useMemo(() => {
    const e: Record<string, string> = {};
    for (const f of fields) {
      if (f.type === 'number' && f.value !== '' && Number.isNaN(Number(f.value))) e[f.key] = 'Must be a number';
      if (f.type === 'json' && f.value !== '') {
        try { JSON.parse(f.value); } catch { e[f.key] = 'Invalid JSON'; }
      }
    }
    return e;
  }, [fields]);

  const keys = useMemo(() => fields.map((f) => f.key), [fields]);
  const valid = Object.keys(fieldErrors).length === 0 && (viewMode === 'json' ? !jsonError : true);

  // ── changes preview ────────────────
  const changes = useMemo(() => {
    const result: { key: string; was: unknown; now: unknown; action: 'changed' | 'added' | 'removed' }[] = [];
    const originalKeys = Object.keys(data);
    const currentKeys = fields.map((f) => f.key);

    // changed / removed
    for (const k of originalKeys) {
      const orig = data[k];
      const curr = fields.find((f) => f.key === k);
      if (!curr) {
        result.push({ key: k, was: orig, now: null, action: 'removed' });
      } else {
        const built = curr.type === 'number' ? Number(curr.value) : curr.type === 'boolean' ? curr.value === 'true' : curr.value;
        const builtStr = JSON.stringify(built), origStr = JSON.stringify(orig);
        if (builtStr !== origStr) {
          result.push({ key: k, was: orig, now: built, action: 'changed' });
        }
      }
    }
    // added
    for (const k of currentKeys) {
      if (!originalKeys.includes(k)) {
        const f = fields.find((f) => f.key === k)!;
        const built = f.type === 'number' ? Number(f.value) : f.type === 'boolean' ? f.value === 'true' : f.value;
        result.push({ key: k, was: null, now: built, action: 'added' });
      }
    }
    return result;
  }, [data, fields]);

  const updateField = (key: string, patch: Partial<Field>) =>
    setFields((fs) => fs.map((f) => (f.key === key ? { ...f, ...patch } : f)));

  const removeField = (key: string) => {
    setFields((fs) => fs.filter((f) => f.key !== key));
    setErrors((e) => { const n = { ...e }; delete n[key]; return n; });
  };

  const startRename = (key: string) => { setRenameKey(key); setRenameValue(key); };

  const confirmRename = () => {
    if (!renameKey || !renameValue.trim()) return;
    const trimmed = renameValue.trim();
    if (trimmed === renameKey) { setRenameKey(null); return; }
    if (keys.some((k) => k !== renameKey && k === trimmed)) {
      setErrors((e) => ({ ...e, [renameKey]: 'Name already used' }));
      return;
    }
    setFields((fs) => fs.map((f) => (f.key === renameKey ? { ...f, key: trimmed } : f)));
    setErrors((e) => { const n = { ...e }; delete n[renameKey]; return n; });
    setRenameKey(null);
  };

  const addField = () => {
    const key = newKey.trim();
    if (!key) return;
    if (fields.some((f) => f.key === key)) {
      setErrors((e) => ({ ...e, _add: 'Name already exists' }));
      return;
    }
    setFields((fs) => [...fs, { key, type: newType, value: newValue }]);
    setNewKey(''); setNewValue('');
  };

  const buildData = (): Record<string, unknown> | null => {
    if (viewMode === 'json') {
      if (jsonError) return null;
      try { return JSON.parse(jsonText) as Record<string, unknown>; } catch { setJsonError('Invalid JSON'); return null; }
    }
    const out: Record<string, unknown> = {};
    for (const f of fields) {
      if (f.type === 'number') out[f.key] = f.value === '' ? null : Number(f.value);
      else if (f.type === 'boolean') out[f.key] = f.value === 'true';
      else if (f.type === 'json') out[f.key] = f.value === '' ? null : JSON.parse(f.value);
      else out[f.key] = f.value;
    }
    return out;
  };

  // csv renderer
  const csvRows = useMemo(() => {
    const rows = [["Field", "Type", "Value"]];
    for (const f of fields) {
      rows.push([f.key, f.type, f.value]);
    }
    return rows;
  }, [fields]);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white p-0.5 shadow-sm">
          <button type="button" onClick={() => { setViewMode('form'); }} className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${viewMode === 'form' ? 'bg-slate-100 text-slate-950' : 'text-slate-500'}`}>Form</button>
          <button type="button" onClick={() => { setViewMode('table'); }} className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${viewMode === 'table' ? 'bg-slate-100 text-slate-950' : 'text-slate-500'}`}>Table</button>
          <button type="button" onClick={() => { setViewMode('json'); }} className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${viewMode === 'json' ? 'bg-slate-100 text-slate-950' : 'text-slate-500'}`}>JSON</button>
        </div>
        <div className="flex items-center gap-2">
          {Object.keys(fieldErrors).length > 0 && <span className="text-xs text-red-500">Fix field error(s)</span>}
          {changes.length > 0 && (
            <button type="button" className={`rounded-md px-2 py-1 text-xs font-medium transition-colors ${showPreview ? 'bg-accent2/10 text-accent2' : 'bg-slate-100 text-slate-600 hover:text-slate-950'}`}
              onClick={() => setShowPreview(!showPreview)}>
              {showPreview ? 'Hide changes' : `Changes (${changes.length})`}
            </button>
          )}
        </div>
      </div>

      {/* changes preview */}
      {showPreview && changes.length > 0 && (
        <div className="rounded-lg border border-accent2/30 bg-accent2/5 px-3 py-2">
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-accent2">Changes preview</div>
          <div className="space-y-1">
            {changes.map((ch) => (
              <div key={ch.key} className="flex items-center gap-2 text-xs">
                <span className={`badge border-transparent ${ch.action === 'added' ? 'bg-emerald-500/10 text-emerald-600' : ch.action === 'removed' ? 'bg-red-500/10 text-red-500' : 'bg-amber-500/10 text-amber-600'}`}>
                  {ch.action === 'added' ? '+' : ch.action === 'removed' ? '−' : '~'}
                </span>
                <code className="font-mono text-slate-700">{ch.key}</code>
                {ch.action === 'changed' && (
                  <span className="text-slate-500">
                    <span className="text-red-500 line-through">{trunc(JSON.stringify(ch.was))}</span>
                    {' → '}
                    <span className="text-emerald-600">{trunc(JSON.stringify(ch.now))}</span>
                  </span>
                )}
                {ch.action === 'added' && <span className="text-emerald-600">{trunc(JSON.stringify(ch.now))}</span>}
                {ch.action === 'removed' && <span className="text-red-500 line-through">{trunc(JSON.stringify(ch.was))}</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {viewMode === 'json' ? (
        <div>
          <textarea className="input min-h-64 font-mono text-xs" value={jsonText}
            onChange={(e) => { setJsonText(e.target.value); try { JSON.parse(e.target.value); setJsonError(null); } catch { setJsonError('Invalid JSON'); } }} spellCheck={false} />
          {jsonError && <p className="mt-1 text-xs text-red-500">{jsonError}</p>}
        </div>
      ) : viewMode === 'table' ? (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50">
                {csvRows[0].map((h, i) => <th key={i} className="px-2 py-1.5 text-left font-semibold text-slate-600">{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {csvRows.slice(1).map((r, ri) => (
                <tr key={ri} className="border-b border-slate-100 last:border-0 hover:bg-slate-50/60">
                  {r.map((c, ci) => (
                    <td key={ci} className={`px-2 py-1.5 font-mono whitespace-pre-wrap max-w-xs truncate ${ci === 0 ? 'text-slate-700 font-medium' : 'text-slate-500'}`}>
                      {c}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="space-y-2">
          {fields.map((f) => (
            <div key={f.key} className="flex items-start gap-2">
              <div className="w-36 shrink-0 pt-2">
                {renameKey === f.key ? (
                  <input className="input font-mono text-[11px] py-0.5" value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') confirmRename(); if (e.key === 'Escape') setRenameKey(null); }}
                    onBlur={confirmRename} autoFocus />
                ) : (
                  <button type="button"
                    className="break-all font-mono text-[11px] font-medium text-slate-600 hover:text-accent text-left"
                    onClick={() => startRename(f.key)} title="Click to rename">
                    {f.key}
                  </button>
                )}
              </div>
              <div className="w-20 shrink-0 pt-2">
                <select className="input py-1 text-[11px]" value={f.type}
                  onChange={(e) => { const t = e.target.value as FieldType; updateField(f.key, { type: t, value: convertValue(f.value, f.type, t) }); }}>
                  <option value="string">text</option>
                  <option value="number">number</option>
                  <option value="boolean">yes/no</option>
                  <option value="json">object</option>
                </select>
              </div>
              <div className="min-w-0 flex-1">
                {f.type === 'boolean' ? (
                  <button type="button" onClick={() => updateField(f.key, { value: f.value === 'true' ? 'false' : 'true' })}
                    className="flex items-center gap-2 pt-2" aria-pressed={f.value === 'true'}>
                    <span className={`h-5 w-9 rounded-full p-0.5 transition-colors ${f.value === 'true' ? 'bg-accent' : 'bg-slate-300'}`}>
                      <span className={`block h-4 w-4 rounded-full bg-white shadow transition-transform ${f.value === 'true' ? 'translate-x-4' : ''}`} />
                    </span>
                    <span className="text-sm text-slate-700">{f.value === 'true' ? 'true' : 'false'}</span>
                  </button>
                ) : f.type === 'json' ? (
                  <textarea className="input pt-2 font-mono text-xs" rows={Math.min(6, (f.value || '').split('\n').length + 1)}
                    value={f.value} onChange={(e) => updateField(f.key, { value: e.target.value })} spellCheck={false} />
                ) : (
                  <input className="input pt-2" type={f.type === 'number' ? 'number' : 'text'}
                    value={f.value} onChange={(e) => updateField(f.key, { value: e.target.value })} />
                )}
                {fieldErrors[f.key] && <p className="mt-1 text-xs text-red-500">{fieldErrors[f.key]}</p>}
              </div>
              <button type="button" onClick={() => removeField(f.key)}
                className="mt-1.5 rounded-md px-2 py-1 text-xs text-slate-400 hover:bg-red-50 hover:text-red-500" title={`Remove ${f.key}`}>✕</button>
            </div>
          ))}

          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-dashed border-slate-300 bg-white/60 px-3 py-2">
            <input className="input w-36" placeholder="field name" value={newKey}
              onChange={(e) => setNewKey(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addField()} />
            <select className="input w-24" value={newType} onChange={(e) => setNewType(e.target.value as FieldType)}>
              <option value="string">text</option><option value="number">number</option><option value="boolean">yes/no</option><option value="json">object</option>
            </select>
            {newType === 'boolean' ? (
              <select className="input w-20" value={newValue} onChange={(e) => setNewValue(e.target.value)}>
                <option value="true">true</option><option value="false">false</option>
              </select>
            ) : (
              <input className="input w-48" placeholder={newType === 'json' ? '{"…"}' : 'value'} value={newValue}
                onChange={(e) => setNewValue(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addField()} />
            )}
            <button type="button" className="btn-secondary px-3 py-1.5 text-xs" onClick={addField}>+ Add</button>
          </div>
          {errors._add && <p className="text-xs text-red-500">{errors._add}</p>}
        </div>
      )}

      <div className="flex justify-end gap-2 pt-1">
        <button type="button" className="btn-primary" onClick={() => { const n = buildData(); if (n) onChange(n); }} disabled={!valid}>
          Save changes
        </button>
      </div>
    </div>
  );
}

function trunc(s: string, max = 40) { return s.length > max ? s.slice(0, max) + '…' : s; }
