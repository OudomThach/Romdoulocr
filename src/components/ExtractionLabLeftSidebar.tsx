// Left sidebar for the Extraction Lab workbench layout.
//
// Shows INPUT (dropzone) always. Advanced sections (SCOPE, PAGE, MODE, DPI,
// CONCURRENCY, FILE OPTIONS) are behind a collapsible expander, closed by
// default. Run / Cancel button at the bottom.

import { useState } from 'react';
import { ConcurrencyControl } from '@/components/controls';
import { FileDropzone } from '@/components/FileDropzone';
import { ImageEnhancer } from '@/components/ImageEnhancer';
import { PageRangeInput } from '@/components/PageRangeInput';
import { DEFAULT_ENHANCE, type EnhanceOptions } from '@/lib/imageProcessing';
import { fmtBytes, isImage, isPdf } from '@/lib/utils';

export type ExtractionMode =
  | 'full-page-ocr' // HTML + structure
  | 'layout-json'   // bounding boxes
  | 'block-ocr'     // cropped blocks only
  | 'table-simple'  // simple grid
  | 'table-full';   // full HTML

export const MODE_LABELS: Record<ExtractionMode, { label: string; tag: string }> = {
  'full-page-ocr': { label: 'Full-page OCR', tag: 'HTML' },
  'layout-json': { label: 'Layout JSON', tag: 'BOXES' },
  'block-ocr': { label: 'Block OCR', tag: 'CROPS' },
  'table-simple': { label: 'Table simple', tag: 'GRID' },
  'table-full': { label: 'Table full', tag: 'HTML' },
};

export type DpiPreset = 'fast' | 'balanced' | 'sharp';

export const DPI_PRESETS: Record<DpiPreset, { label: string; dpi: number }> = {
  fast: { label: 'Fast', dpi: 150 },
  balanced: { label: 'Balanced', dpi: 200 },
  sharp: { label: 'Sharp', dpi: 300 },
};

export type ScopeMode = 'single' | 'batch';

export interface ExtractionLabLeftSidebarProps {
  files: File[];
  onFilesChange: (f: File[]) => void;
  disabled?: boolean;

  scope: ScopeMode;
  onScopeChange: (s: ScopeMode) => void;

  pageNum: number;
  numPages: number;
  onPageChange: (p: number) => void;

  mode: ExtractionMode;
  onModeChange: (m: ExtractionMode) => void;

  dpiPreset: DpiPreset;
  onDpiPresetChange: (p: DpiPreset) => void;
  dpiCustom: number;
  onDpiCustomChange: (n: number) => void;

  concurrency: number;
  onConcurrencyChange: (n: number) => void;
  concurrencyDisabled?: boolean;

  // Per-file image enhancement + page-range, surfaced only when those files
  // are present. The parent decides whether to render them.
  enhanceByFile?: Record<string, EnhanceOptions>;
  onEnhanceChange?: (key: string, opts: EnhanceOptions) => void;
  pdfOptsByFile?: Record<string, { range: string; dpi: number }>;
  onPdfOptsChange?: (key: string, opts: { range: string; dpi: number }) => void;

  // Run / Cancel action wired from parent.
  isRunning?: boolean;
  canRun?: boolean;
  runLabel?: string;
  onRun?: () => void;
  onCancel?: () => void;

  // Export button (e.g. opens export modal).
  onExport?: () => void;
  exportEnabled?: boolean;
}

export function ExtractionLabLeftSidebar({
  files,
  onFilesChange,
  disabled,
  scope,
  onScopeChange,
  pageNum,
  numPages,
  onPageChange,
  mode,
  onModeChange,
  dpiPreset,
  onDpiPresetChange,
  dpiCustom,
  onDpiCustomChange,
  concurrency,
  onConcurrencyChange,
  concurrencyDisabled,
  enhanceByFile,
  onEnhanceChange,
  pdfOptsByFile,
  onPdfOptsChange,
  isRunning,
  canRun,
  runLabel = 'Run Full-page OCR',
  onRun,
  onCancel,
  onExport,
  exportEnabled,
}: ExtractionLabLeftSidebarProps) {
  const [advancedOpen, setAdvancedOpen] = useState(false);

  return (
    <aside className="flex flex-col gap-2 overflow-auto pr-1">
      {/* INPUT — always visible */}
      <SectionCard label="INPUT" sub={files[0]?.name}>
        <FileDropzone
          multiple
          accept="pdf-or-image"
          files={files}
          onChange={onFilesChange}
          disabled={disabled}
        />
        <div className="mt-2 text-[10px] text-ink-500">PDF, PNG, JPG, JPEG, GIF, WEBP</div>
      </SectionCard>

      {/* Advanced expander */}
      <button
        onClick={() => setAdvancedOpen((o) => !o)}
        className="flex items-center justify-between rounded-lg border border-ink-700 bg-ink-900/40 px-3 py-2 text-[11px] text-ink-300 hover:bg-ink-800/60 hover:text-ink-50 transition-colors"
      >
        <span className="font-semibold uppercase tracking-wider">Settings</span>
        <span className="text-ink-500">{advancedOpen ? '▴' : '▾'}</span>
      </button>

      {advancedOpen && (
        <>
          {/* SCOPE */}
          <SectionCard label="SCOPE" sub={scope === 'single' ? 'SINGLE' : 'BATCH'}>
            <SegmentedToggle
              options={[
                { id: 'single', label: 'Single page' },
                { id: 'batch', label: 'Batch range' },
              ]}
              value={scope}
              onChange={(v) => onScopeChange(v as ScopeMode)}
            />
          </SectionCard>

          {/* PAGE */}
          <SectionCard label="PAGE" sub={`${numPages || '—'} PAGES`}>
            <div className="flex items-center gap-1">
              <PageBtn onClick={() => onPageChange(Math.max(1, pageNum - 1))} disabled={pageNum <= 1}>
                ‹
              </PageBtn>
              <div className="flex-1 rounded-md border border-ink-700 bg-ink-900/60 px-2 py-1.5 text-center text-sm font-mono tabular-nums text-ink-100">
                {numPages > 0 ? `${pageNum} / ${numPages}` : '— / —'}
              </div>
              <PageBtn
                onClick={() => onPageChange(Math.min(numPages || 1, pageNum + 1))}
                disabled={pageNum >= numPages}
              >
                ›
              </PageBtn>
            </div>
          </SectionCard>

          {/* MODE */}
          <SectionCard label="MODE" sub={MODE_LABELS[mode].tag}>
            <div className="grid gap-1">
              {(Object.keys(MODE_LABELS) as ExtractionMode[]).map((m) => (
                <button
                  key={m}
                  onClick={() => onModeChange(m)}
                  className={`flex items-center justify-between rounded-md border px-2.5 py-1.5 text-left text-xs transition-colors ${
                    mode === m
                      ? 'border-accent bg-accent/10 text-ink-50'
                      : 'border-ink-700 bg-ink-900/40 text-ink-200 hover:bg-ink-800/60'
                  }`}
                >
                  <span>{MODE_LABELS[m].label}</span>
                  <span className="font-mono text-[10px] text-ink-400">{MODE_LABELS[m].tag}</span>
                </button>
              ))}
            </div>
          </SectionCard>

          {/* DPI */}
          <SectionCard label="DPI" sub={dpiPreset.toUpperCase()}>
            <SegmentedToggle
              options={(Object.keys(DPI_PRESETS) as DpiPreset[]).map((p) => ({
                id: p,
                label: DPI_PRESETS[p].label,
              }))}
              value={dpiPreset}
              onChange={(v) => onDpiPresetChange(v as DpiPreset)}
            />
            <div className="mt-2 flex items-center gap-2">
              <input
                type="range"
                min={100}
                max={400}
                step={50}
                value={dpiCustom}
                onChange={(e) => onDpiCustomChange(Number(e.target.value))}
                className="flex-1 accent-accent"
              />
              <span className="w-12 rounded border border-ink-700 bg-ink-900/60 px-1.5 py-0.5 text-center font-mono text-[11px] text-ink-200">
                {dpiCustom}
              </span>
            </div>
          </SectionCard>

          {/* CONCURRENCY */}
          <SectionCard label="CONCURRENCY" sub={`${concurrency} parallel`}>
            <ConcurrencyControl
              value={concurrency}
              onChange={onConcurrencyChange}
              disabled={concurrencyDisabled}
            />
          </SectionCard>

          {/* Per-file options (page range for PDFs, image enhance for images). */}
          {files.length > 0 && (onPdfOptsChange || onEnhanceChange) && (
            <SectionCard label="FILE OPTIONS" sub={`${files.length} file(s)`}>
              <div className="grid gap-2">
                {files.map((f) => {
                  const key = `${f.name}|${f.size}|${f.lastModified}`;
                  if (isPdf(f.name) && pdfOptsByFile && onPdfOptsChange) {
                    const opts = pdfOptsByFile[key] ?? { range: '', dpi: dpiCustom };
                    return (
                      <div key={key} className="rounded-md border border-ink-800 bg-ink-950/40 p-2">
                        <div className="mb-1 truncate text-[10px] text-ink-400">
                          📄 {f.name} · {fmtBytes(f.size)}
                        </div>
                        <PageRangeInput
                          file={f}
                          value={opts.range}
                          onChange={(range) => onPdfOptsChange(key, { ...opts, range })}
                          onValidRangeChange={() => {}}
                        />
                      </div>
                    );
                  }
                  if (isImage(f.name) && enhanceByFile && onEnhanceChange) {
                    const opts = enhanceByFile[key] ?? DEFAULT_ENHANCE;
                    return (
                      <div key={key} className="rounded-md border border-ink-800 bg-ink-950/40 p-2">
                        <div className="mb-1 truncate text-[10px] text-ink-400">
                          🖼 {f.name} · {fmtBytes(f.size)}
                        </div>
                        <ImageEnhancer file={f} value={opts} onChange={(o) => onEnhanceChange(key, o)} />
                      </div>
                    );
                  }
                  return null;
                })}
              </div>
            </SectionCard>
          )}
        </>
      )}

      {/* Action buttons */}
      <div className="flex flex-col gap-2 pt-1">
        {onRun && (
          <button
            onClick={isRunning ? onCancel : onRun}
            disabled={!isRunning && !canRun}
            className={`btn w-full ${
              isRunning
                ? 'border border-rose-700 bg-rose-900/30 text-rose-200 hover:bg-rose-900/50'
                : 'bg-accent text-ink-50 hover:bg-accent-hover'
            } px-4 py-2 text-sm font-semibold`}
          >
            {isRunning ? 'Cancel' : runLabel}
          </button>
        )}
        {onExport && exportEnabled && (
          <button
            onClick={onExport}
            className="btn border border-ink-700 bg-ink-800/60 text-ink-200 hover:bg-ink-700/70 w-full px-4 py-1.5 text-xs"
          >
            Export As…
          </button>
        )}
      </div>
    </aside>
  );
}

function SectionCard({
  label,
  sub,
  children,
}: {
  label: string;
  sub?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="card p-3">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-400">{label}</div>
        {sub && (
          <div className="font-mono text-[10px] uppercase tracking-wider text-ink-500">{sub}</div>
        )}
      </div>
      {children}
    </section>
  );
}

function SegmentedToggle<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { id: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="inline-flex w-full overflow-hidden rounded-md border border-ink-700 bg-ink-900/50 text-xs">
      {options.map((o) => {
        const active = o.id === value;
        return (
          <button
            key={o.id}
            onClick={() => onChange(o.id)}
            className={`flex-1 px-2 py-1.5 transition-colors ${
              active
                ? 'bg-accent text-ink-50'
                : 'text-ink-300 hover:bg-ink-800/60 hover:text-ink-50'
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function PageBtn({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="grid h-8 w-8 place-items-center rounded-md border border-ink-700 bg-ink-900/60 text-sm text-ink-200 hover:bg-ink-800 disabled:opacity-40"
    >
      {children}
    </button>
  );
}
