import { useMemo, useState } from 'react';

// Typed, per-field editor for a record's `data` object. Non-technical friendly:
// strings → text, numbers → number inputs, booleans → toggles, objects/arrays
// → collapsible JSON mini-fields with inline validation. Power users can flip
// to a raw JSON view with the toggle.

type FieldType = 'string' | 'number' | 'boolean' | 'json';

interface Field {
  key: string;
  type: FieldType;
  value: string | boolean; // strings/numbers stored as text; booleans native
}

function detectType(v: unknown): FieldType {
  if (typeof v === 'number') return 'number';
  if (typeof v === 'boolean') return 'boolean';
  if (v === null || typeof v === 'object') return 'json';
  return 'string';
}

function toText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v, null, 2);
  return String(v);
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
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [newKey, setNewKey] = useState('');
  const [newType, setNewType] = useState<FieldType>('string');
  const [newValue, setNewValue] = useState('');

  const fieldErrors = useMemo(() => {
    const e: Record<string, string> = {};
    for (const f of fields) {
      if (f.type === 'number' && f.value !== '' && Number.isNaN(Number(f.value))) {
        e[f.key] = 'Must be a number';
      }
      if (f.type === 'json' && f.value !== '') {
        try {
          JSON.parse(f.value as string);
        } catch {
          e[f.key] = 'Invalid JSON';
        }
      }
    }
    return e;
  }, [fields]);

  const valid = Object.keys(fieldErrors).length === 0 && (!jsonMode || !jsonError);

  const updateField = (key: string, patch: Partial<Field>) =>
    setFields((fs) => fs.map((f) => (f.key === key ? { ...f, ...patch } : f)));

  const removeField = (key: string) => {
    setFields((fs) => fs.filter((f) => f.key !== key));
    setErrors((e) => {
      const next = { ...e };
      delete next[key];
      return next;
    });
  };

  const addField = () => {
    const key = newKey.trim();
    if (!key) return;
    if (fields.some((f) => f.key === key)) {
      setErrors((e) => ({ ...e, [key]: 'Key already exists' }));
      return;
    }
    let value: string | boolean = newValue;
    if (newType === 'boolean') value = newValue === 'true';
    setFields((fs) => [...fs, { key, type: newType, value }]);
    setNewKey('');
    setNewValue('');
  };

  const buildData = (): Record<string, unknown> | null => {
    if (jsonMode) {
      if (jsonError) return null;
      try {
        const parsed = JSON.parse(jsonText);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          setJsonError('Data must be a JSON object');
          return null;
        }
        return parsed as Record<string, unknown>;
      } catch {
        setJsonError('Invalid JSON');
        return null;
      }
    }
    const out: Record<string, unknown> = {};
    for (const f of fields) {
      if (f.type === 'number') out[f.key] = f.value === '' ? null : Number(f.value);
      else if (f.type === 'boolean') out[f.key] = f.value;
      else if (f.type === 'json') out[f.key] = f.value === '' ? null : JSON.parse(f.value as string);
      else out[f.key] = f.value;
    }
    return out;
  };

  const save = () => {
    const next = buildData();
    if (next === null) return;
    onChange(next);
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white p-0.5 shadow-sm">
          <button
            type="button"
            onClick={() => setJsonMode(false)}
            className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${!jsonMode ? 'bg-slate-100 text-slate-950' : 'text-slate-500 hover:text-slate-800'}`}
          >
            Form
          </button>
          <button
            type="button"
            onClick={() => setJsonMode(true)}
            className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${jsonMode ? 'bg-slate-100 text-slate-950' : 'text-slate-500 hover:text-slate-800'}`}
          >
            JSON
          </button>
        </div>
        {Object.keys(fieldErrors).length > 0 && (
          <span className="text-xs text-red-500">Fix {Object.keys(fieldErrors).length} field error(s)</span>
        )}
      </div>

      {jsonMode ? (
        <div>
          <textarea
            className="input min-h-64 font-mono text-xs"
            value={jsonText}
            onChange={(e) => {
              setJsonText(e.target.value);
              try {
                JSON.parse(e.target.value);
                setJsonError(null);
              } catch {
                setJsonError('Invalid JSON');
              }
            }}
            spellCheck={false}
          />
          {jsonError && <p className="mt-1 text-xs text-red-500">{jsonError}</p>}
        </div>
      ) : (
        <div className="space-y-2">
          {fields.map((f) => (
            <div key={f.key} className="flex items-start gap-2">
              <div className="w-36 shrink-0 pt-2">
                <span className="break-all font-mono text-[11px] font-medium text-slate-600">{f.key}</span>
              </div>
              <div className="min-w-0 flex-1">
                {f.type === 'boolean' ? (
                  <button
                    type="button"
                    onClick={() => updateField(f.key, { value: !(f.value as boolean) })}
                    className="flex items-center gap-2"
                    aria-pressed={f.value as boolean}
                  >
                    <span
                      className={`h-5 w-9 rounded-full p-0.5 transition-colors ${f.value ? 'bg-accent' : 'bg-slate-300'}`}
                    >
                      <span className={`block h-4 w-4 rounded-full bg-white shadow transition-transform ${f.value ? 'translate-x-4' : ''}`} />
                    </span>
                    <span className="text-sm text-slate-700">{f.value ? 'true' : 'false'}</span>
                  </button>
                ) : f.type === 'json' ? (
                  <textarea
                    className="input font-mono text-xs"
                    rows={Math.min(6, (f.value as string).split('\n').length + 1)}
                    value={f.value as string}
                    onChange={(e) => updateField(f.key, { value: e.target.value })}
                    spellCheck={false}
                  />
                ) : (
                  <input
                    className="input"
                    type={f.type === 'number' ? 'number' : 'text'}
                    value={f.value as string}
                    onChange={(e) => updateField(f.key, { value: e.target.value })}
                  />
                )}
                {fieldErrors[f.key] && <p className="mt-1 text-xs text-red-500">{fieldErrors[f.key]}</p>}
              </div>
              <button
                type="button"
                onClick={() => removeField(f.key)}
                className="mt-1.5 rounded-md px-2 py-1 text-xs text-slate-400 hover:bg-slate-100 hover:text-red-500"
                title={`Remove ${f.key}`}
              >
                ✕
              </button>
            </div>
          ))}

          {/* Add field */}
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-dashed border-slate-300 bg-white/60 px-3 py-2">
            <input
              className="input w-36"
              placeholder="field name"
              value={newKey}
              onChange={(e) => setNewKey(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addField()}
            />
            <select className="input w-28" value={newType} onChange={(e) => setNewType(e.target.value as FieldType)}>
              <option value="string">text</option>
              <option value="number">number</option>
              <option value="boolean">yes/no</option>
              <option value="json">object/list</option>
            </select>
            {newType === 'boolean' ? (
              <select className="input w-28" value={newValue} onChange={(e) => setNewValue(e.target.value)}>
                <option value="true">true</option>
                <option value="false">false</option>
              </select>
            ) : (
              <input
                className="input w-48"
                placeholder={newType === 'json' ? '{"…"}' : 'value'}
                value={newValue}
                onChange={(e) => setNewValue(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && addField()}
              />
            )}
            <button type="button" className="btn-secondary px-3 py-1.5 text-xs" onClick={addField}>
              + Add field
            </button>
          </div>
          {errors && Object.keys(errors).length > 0 && (
            <p className="text-xs text-red-500">{Object.values(errors)[0]}</p>
          )}
        </div>
      )}

      <div className="flex justify-end gap-2 pt-1">
        <button type="button" className="btn-primary" onClick={save} disabled={!valid}>
          Save changes
        </button>
      </div>
    </div>
  );
}
