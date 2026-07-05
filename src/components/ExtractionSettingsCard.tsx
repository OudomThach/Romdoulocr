// Shared "Extraction Quality" card — the runtime toggles for OCR recall.
// Used by the Document, Translate, Table and OCR tabs so the controls (and the
// ability to revert) look and behave identically everywhere. State lives in
// useSettingsStore so the toggles are shared across tabs.

export function ExtractionSettingsCard({
  highRes,
  fullPageOcr,
  onHighResChange,
  onFullPageOcrChange,
  disabled,
  showFullPage = true,
}: {
  highRes: boolean;
  fullPageOcr: boolean;
  onHighResChange: (v: boolean) => void;
  onFullPageOcrChange: (v: boolean) => void;
  disabled: boolean;
  showFullPage?: boolean;
}) {
  return (
    <section className="panel p-6">
      <h2 className="mb-1 text-sm font-semibold text-slate-950">Extraction Quality</h2>
      <p className="mb-4 text-xs text-slate-500">Maximize how much text is captured. Turn off to revert.</p>
      <div className="grid gap-3 text-sm text-slate-700">
        <SettingToggle
          label="High resolution"
          hint="300 DPI · sharper, catches small text"
          checked={highRes}
          onChange={onHighResChange}
          disabled={disabled}
        />
        {showFullPage && (
          <SettingToggle
            label="Full-page OCR fallback"
            hint="Extra pass to catch margins & headers (slower)"
            checked={fullPageOcr}
            onChange={onFullPageOcrChange}
            disabled={disabled}
          />
        )}
      </div>
    </section>
  );
}

export function SettingToggle({
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label
      className={`flex items-center justify-between gap-3 rounded-lg border px-3 py-2 transition-all ${
        checked
          ? 'border-accent/50 bg-accent/10 dark:shadow-[0_0_16px_-4px_rgb(0_229_255_/_0.5)]'
          : 'border-slate-200 bg-white'
      } ${disabled ? 'opacity-60' : 'cursor-pointer'}`}
    >
      <span className="min-w-0">
        <span className={`block font-medium ${checked ? 'text-accent' : 'text-slate-950'}`}>{label}</span>
        <span className="block text-xs text-slate-500">{hint}</span>
      </span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        disabled={disabled}
        className="h-4 w-4 shrink-0 rounded border-slate-300 focus:ring-accent/40"
        style={{ accentColor: 'rgb(var(--c-accent))' }}
      />
    </label>
  );
}
