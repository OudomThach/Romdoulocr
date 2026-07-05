// Right-side Analysis Output panel for CSV / Text / JSON views.
//
// The Document tab is present for switching but its content is rendered
// in the main workbench area (full-width page image + overlays).

import { useMemo, useState } from 'react';
import type { DocumentResult } from '@/types/api';
import { copyToClipboard } from '@/lib/utils';
import { docText } from '@/lib/documentExport';
import { JsonTree } from '@/components/JsonTree';

export type OutputView = 'document' | 'csv' | 'text' | 'json';

export const OUTPUT_TABS: { id: OutputView; label: string }[] = [
  { id: 'document', label: 'Document' },
  { id: 'csv', label: 'CSV' },
  { id: 'text', label: 'Text' },
  { id: 'json', label: 'JSON' },
];

export interface ExtractionLabOutputPanelProps {
  result: DocumentResult | null;
  subtitle?: string;
  view?: OutputView;
  onViewChange?: (v: OutputView) => void;
}

export function ExtractionLabOutputPanel({
  result,
  subtitle,
  view: viewProp,
  onViewChange,
}: ExtractionLabOutputPanelProps) {
  const [internalView, setInternalView] = useState<OutputView>('document');
  const view = viewProp ?? internalView;
  const setView = (v: OutputView) => {
    if (onViewChange) onViewChange(v);
    else setInternalView(v);
  };
  const [copied, setCopied] = useState<string | null>(null);

  // Blank-aware: full_text can arrive as "" — docText falls back to region text.
  const fullText = useMemo(() => (result ? docText(result) : ''), [result]);
  const csv = useMemo(() => {
    if (!result) return '';
    const tableRegions = result.pages
      .flatMap((p) => p.regions)
      .filter((r) => r.region_type === 'table');
    if (tableRegions.length === 0) return 'No tables detected.';
    return tableRegions.map((r) => r.text).join('\n\n');
  }, [result]);
  const json = useMemo(() => (result ? JSON.stringify(result, null, 2) : ''), [result]);

  const copyView = async () => {
    let text = '';
    if (view === 'document') text = fullText;
    else if (view === 'csv') text = csv;
    else if (view === 'text') text = fullText;
    else if (view === 'json') text = json;
    await copyToClipboard(text);
    flashCopied('view');
  };

  function flashCopied(kind: string) {
    setCopied(kind);
    window.setTimeout(() => setCopied(null), 1500);
  }

  // When Document tab is active, the parent renders the page preview
  // in the main workbench area. Here we show a minimal hint.
  if (view === 'document') {
    return (
      <section className="card flex min-h-0 flex-1 flex-col overflow-hidden">
        <Header
          subtitle={subtitle}
          view={view}
          setView={setView}
          copied={copied}
          copyView={copyView}
        />
        <div className="flex-1 grid place-items-center text-xs text-ink-500">
          Document view active — see main panel
        </div>
      </section>
    );
  }

  return (
    <section className="card flex min-h-0 flex-1 flex-col overflow-hidden">
      <Header
        subtitle={subtitle}
        view={view}
        setView={setView}
        copied={copied}
        copyView={copyView}
      />
      <div className="flex-1 overflow-auto p-3">
        {!result ? (
          <EmptyState />
        ) : view === 'csv' ? (
          <pre className="max-h-full overflow-auto whitespace-pre-wrap rounded-md border border-ink-800 bg-ink-950/60 p-3 font-mono text-[12px] leading-relaxed text-ink-100">
            {csv || <span className="italic text-ink-500">(empty)</span>}
          </pre>
        ) : view === 'text' ? (
          <pre className="max-h-full overflow-auto whitespace-pre-wrap rounded-md border border-ink-800 bg-ink-950/60 p-3 text-sm leading-relaxed text-ink-100">
            {fullText || <span className="italic text-ink-500">(empty)</span>}
          </pre>
        ) : view === 'json' ? (
          <JsonTree data={JSON.parse(json)} maxHeight="100%" />
        ) : null}
      </div>
    </section>
  );
}

function Header({
  subtitle,
  view,
  setView,
  copied,
  copyView,
}: {
  subtitle?: string;
  view: OutputView;
  setView: (v: OutputView) => void;
  copied: string | null;
  copyView: () => void;
}) {
  return (
    <header className="border-b border-ink-800 px-3 py-2">
      <div className="flex items-baseline justify-between gap-2">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-400">
          Analysis Output
        </div>
        <div className="font-mono text-[10px] text-ink-500">{subtitle ?? '—'}</div>
      </div>

      <div
        role="tablist"
        aria-label="Output view"
        className="mt-2 inline-flex flex-wrap overflow-hidden rounded-md border border-ink-700 bg-ink-900/50 text-[11px]"
      >
        {OUTPUT_TABS.map((t) => {
          const active = view === t.id;
          return (
            <button
              key={t.id}
              role="tab"
              aria-selected={active}
              onClick={() => setView(t.id)}
              className={`px-2.5 py-1 transition-colors ${
                active ? 'bg-ink-700 text-ink-50' : 'text-ink-300 hover:bg-ink-800/60 hover:text-ink-50'
              }`}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      <div className="mt-2">
        <button
          onClick={copyView}
          className="rounded-md border border-ink-700 bg-ink-900/60 px-2.5 py-0.5 text-[11px] text-ink-200 hover:bg-ink-800 hover:text-ink-50"
        >
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>
    </header>
  );
}

function EmptyState() {
  return (
    <div className="grid h-full place-items-center text-center text-sm text-ink-500">
      <div>
        <div className="mb-2 text-base text-ink-300">No analysis yet</div>
        <div>
          Drop a PDF or image on the left, then click{' '}
          <span className="text-accent">Run Full-page OCR</span>.
        </div>
      </div>
    </div>
  );
}
