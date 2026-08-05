import { useMemo, useState } from 'react';

// Fully dynamic field editor for a record's `data` object.
// - Rename fields: click the key label → inline input, Enter/Blur to confirm
// - Change types: per-row dropdown (text / number / yes-no / object list)
//   with smart value conversion
// - Add/remove fields freely
// - Power-user JSON toggle with live validation

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
  const [jsonMode, setJsonMode] = useState(false);
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
  const valid = Object.keys(fieldErrors).length === 0 && (!jsonMode || !jsonError);

  const updateField = (key: string, patch: Partial<Field>) =>
    setFields((fs) => fs.map((f) => (f.key === key ? { ...f, ...patch } : f)));

  const removeField = (key: string) => {
    setFields((fs) => fs.filter((f) => f.key !== key));
    setErrors((e) => { const n = { ...e }; delete n[key]; return n; });
  };

  const startRename = (key: string) => {
    setRenameKey(key);
    setRenameValue(key);
  };

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
    setNewKey('');
    setNewValue('');
  };

  const buildData = (): Record<string, unknown> | null => {
    if (jsonMode) {
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

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white p-0.5 shadow-sm">
          <button type="button" onClick={() => setJsonMode(false)} className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${!jsonMode ? 'bg-slate-100 text-slate-950' : 'text-slate-500'}`}>Form</button>
          <button type="button" onClick={() => setJsonMode(true)} className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${jsonMode ? 'bg-slate-100 text-slate-950' : 'text-slate-500'}`}>JSON</button>
        </div>
        {Object.keys(fieldErrors).length > 0 && <span className="text-xs text-red-500">Fix field error(s)</span>}
      </div>

      {jsonMode ? (
        <div>
          <textarea className="input min-h-64 font-mono text-xs" value={jsonText}
            onChange={(e) => { setJsonText(e.target.value); try { JSON.parse(e.target.value); setJsonError(null); } catch { setJsonError('Invalid JSON'); } }} spellCheck={false} />
          {jsonError && <p className="mt-1 text-xs text-red-500">{jsonError}</p>}
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
        <button type="button" className="btn-primary" onClick={() => { const n = buildData(); if (n) onChange(n); }} disabled={!valid}>Save changes</button>
      </div>
    </div>
  );
}
