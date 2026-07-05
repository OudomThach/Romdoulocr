import { useMemo, useRef, useState } from 'react';
import { useHistory } from '@/hooks/useHistory';
import { downloadText } from '@/lib/utils';
import { docText } from '@/lib/documentExport';
import { resultToMarkdown } from '@/lib/exporters';
import { normalizeOcrResponse, type DocumentResult, type OcrImageResponse, type TableResult } from '@/types/api';
import type { CompareRecord, StoredRun, TabKind } from '@/lib/storage';
import { MarkdownView } from '@/components/MarkdownView';
import { BoundingBoxViewer } from '@/components/BoundingBoxViewer';
import { ConfidenceDashboard } from '@/components/ConfidenceDashboard';
import { PageNavigator } from '@/components/PageNavigator';
import { ResultPreviewTabs } from '@/components/ResultPreviewTabs';
import { ResultsToolbar } from '@/components/ResultsToolbar';
import { TableGrid } from '@/components/TableGrid';
import { JsonTree } from '@/components/JsonTree';
import { ZoomableImage } from '@/components/PagePreview';
import { useReuseSettings } from '@/hooks/useReuseSettings';

type DateFilter = 'all' | 'today' | '7d' | '30d';
type TabFilter = 'all' | TabKind;

const TAB_LABELS: Record<TabKind, string> = {
  document: 'Parse Document',
  translated: 'Parse + Translate',
  ocr: 'OCR Image',
  table: 'Parse Table',
  compare: 'Compare',
  history: 'History',
};

function fmtDate(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function relativeDate(ts: number): string {
  const ms = Date.now() - ts;
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return fmtDate(ts);
}

function summaryFor(run: StoredRun): string {
  if (run.tab === 'document' || run.tab === 'translated') {
    const r = run.result as DocumentResult;
    const regions = r.pages?.reduce((s, p) => s + p.regions.length, 0) ?? 0;
    return `${r.num_pages ?? 0} page(s) · ${regions} region(s)`;
  }
  if (run.tab === 'ocr') {
    const r = run.result as OcrImageResponse;
    const len = (r.text ?? '').length;
    return `${len} char(s)`;
  }
  if (run.tab === 'table') {
    const r = run.result as TableResult;
    return `${r.num_rows ?? 0} × ${r.num_cols ?? 0} · ${r.cells?.length ?? 0} cell(s)`;
  }
  if (run.tab === 'compare') {
    const r = run.result as CompareRecord;
    return `Compare · ${r.mode}${r.preferred ? ` · preferred: ${r.preferred === 'vllm' ? 'Surya OCR 2' : r.preferred === 'default' ? 'Khmer Parsing API' : 'tie'}` : ''}`;
  }
  return '';
}

function ComparePaneView({ mode, data }: { mode: CompareRecord['mode']; data: CompareRecord['panes'][number]['data'] }) {
  if (mode === 'table') {
    const r = data as TableResult;
    return <TableGrid cells={r.cells} rows={r.num_rows} cols={r.num_cols} compact />;
  }
  if (mode === 'document') {
    const r = data as DocumentResult;
    return <MarkdownView source={resultToMarkdown(r)} maxHeight="300px" showCopy={true} />;
  }
  const r = normalizeOcrResponse(data);
  return (
    <pre className="max-h-64 overflow-auto whitespace-pre-wrap font-sans text-sm text-slate-800">{r.text || '(no text)'}</pre>
  );
}

function CompareResultDetail({ result }: { result: CompareRecord }) {
  const label = (b: string) => (b === 'vllm' ? 'Surya OCR 2 · vLLM' : 'Khmer Parsing API');
  return (
    <div className="grid gap-3">
      <div className="text-xs text-slate-400">
        Compare · {result.mode}
        {result.preferred ? ` · preferred: ${result.preferred === 'vllm' ? 'Surya OCR 2 · vLLM' : result.preferred === 'default' ? 'Khmer Parsing API' : 'tie'}` : ''}
      </div>
      {result.sourcePreview && (
        <img src={result.sourcePreview} alt="source" className="max-h-44 w-auto rounded-lg border border-slate-200" />
      )}
      <div className="grid gap-3 md:grid-cols-2">
        {result.panes.map((p, i) => (
          <div key={i} className="rounded-lg border border-slate-200 p-2.5">
            <div className="mb-1.5 text-xs font-semibold text-slate-950">
              {label(p.backend)} <span className="font-normal text-slate-500">· {(p.ms / 1000).toFixed(1)}s</span>
            </div>
            <ComparePaneView mode={result.mode} data={p.data} />
          </div>
        ))}
      </div>
    </div>
  );
}

export function HistoryTab() {
  const { runs, info, deleteRun, clearAll, exportJson, importJson, updateRun } = useHistory();
  const [search, setSearch] = useState('');
  const [tabFilter, setTabFilter] = useState<TabFilter>('all');
  const [dateFilter, setDateFilter] = useState<DateFilter>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [importStatus, setImportStatus] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const reuser = useReuseSettings();
  // (reuser is wired into each RunRow below; we just need the hook mounted)

  const filtered = useMemo(() => {
    const now = Date.now();
    const cutoff =
      dateFilter === 'today'
        ? now - 24 * 60 * 60 * 1000
        : dateFilter === '7d'
          ? now - 7 * 24 * 60 * 60 * 1000
          : dateFilter === '30d'
            ? now - 30 * 24 * 60 * 60 * 1000
            : 0;
    const q = search.trim().toLowerCase();
    return runs
      .filter((r) => {
        if (tabFilter !== 'all' && r.tab !== tabFilter) return false;
        if (cutoff && r.timestamp < cutoff) return false;
        if (q && !`${r.filename} ${r.notes} ${r.tags.join(' ')}`.toLowerCase().includes(q)) return false;
        return true;
      })
      .sort((a, b) => {
        // Favorites first, then by timestamp desc
        if (a.favorite && !b.favorite) return -1;
        if (!a.favorite && b.favorite) return 1;
        return b.timestamp - a.timestamp;
      });
  }, [runs, search, tabFilter, dateFilter]);

  const usedPct = Math.min(100, Math.round((info.used / info.available) * 100));
  const usedKB = (info.used / 1024).toFixed(1);
  const availMB = (info.available / (1024 * 1024)).toFixed(1);

  const onExport = () => {
    const json = exportJson();
    downloadText(
      `khmer-parser-history-${new Date().toISOString().slice(0, 10)}.json`,
      json,
      'application/json;charset=utf-8',
    );
  };

  const onImportFile = async (file: File) => {
    try {
      const text = await file.text();
      const r = importJson(text, 'merge');
      setImportStatus(`Imported ${r.added} run(s)${r.skipped ? `, skipped ${r.skipped} duplicate(s)` : ''}.`);
    } catch (e) {
      setImportStatus(`Import failed: ${e instanceof Error ? e.message : 'unknown error'}`);
    }
  };

  return (
    <div className="grid gap-6">
      <div className="card p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-sm font-medium text-slate-950">Run history</div>
            <div className="text-xs text-slate-500">
              {info.runCount} run(s) saved locally · {usedKB} KB / {availMB} MB used ({usedPct}%)
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button onClick={onExport} className="btn-secondary" disabled={runs.length === 0}>
              Export .json
            </button>
            <button
              onClick={() => fileInputRef.current?.click()}
              className="btn-secondary"
            >
              Import
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="application/json,.json"
              className="sr-only"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) onImportFile(f);
                e.target.value = '';
              }}
            />
            <button
              onClick={() => {
                if (confirm(`Delete all ${runs.length} saved run(s)? This cannot be undone.`)) clearAll();
              }}
              className="btn-ghost text-xs"
              disabled={runs.length === 0}
            >
              Clear all
            </button>
          </div>
        </div>
        {importStatus && (
          <div className="mt-3 rounded-md border border-slate-200 bg-slate-100/60 px-3 py-1.5 text-xs text-slate-400">
            {importStatus}
          </div>
        )}

        <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-slate-200">
          <div
            className={`h-full transition-[width] ${usedPct > 80 ? 'bg-amber-400' : 'bg-accent'}`}
            style={{ width: `${usedPct}%` }}
          />
        </div>
      </div>

      <div className="card p-4">
        <div className="grid gap-3 md:grid-cols-[1fr_auto_auto]">
          <input
            type="search"
            className="input"
            placeholder="Search by filename, note, or tag…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <select className="input md:w-44" value={tabFilter} onChange={(e) => setTabFilter(e.target.value as TabFilter)}>
            <option value="all">All tabs</option>
            <option value="document">Parse Document</option>
            <option value="translated">Parse + Translate</option>
            <option value="ocr">OCR Image</option>
            <option value="table">Parse Table</option>
          </select>
          <select className="input md:w-36" value={dateFilter} onChange={(e) => setDateFilter(e.target.value as DateFilter)}>
            <option value="all">All time</option>
            <option value="today">Last 24h</option>
            <option value="7d">Last 7 days</option>
            <option value="30d">Last 30 days</option>
          </select>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="card p-6 text-center text-sm text-slate-500">
          {runs.length === 0
            ? 'No runs saved yet. Results you get from any tab will appear here automatically.'
            : 'No runs match your filters.'}
        </div>
      ) : (
        <ul className="grid gap-2">
          {filtered.map((r) => (
            <RunRow
              key={r.id}
              run={r}
              isOpen={selectedId === r.id}
              onToggle={() => setSelectedId((cur) => (cur === r.id ? null : r.id))}
              onDelete={() => {
                if (confirm(`Delete run "${r.filename}"?`)) deleteRun(r.id);
              }}
              onReuse={() => reuser.apply(r)}
              onUpdate={(patch) => updateRun(r.id, patch)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function RunRow({
  run,
  isOpen,
  onToggle,
  onDelete,
  onReuse,
  onUpdate,
}: {
  run: StoredRun;
  isOpen: boolean;
  onToggle: () => void;
  onDelete: () => void;
  onReuse: () => void;
  onUpdate: (patch: Partial<StoredRun>) => void;
}) {
  const summary = summaryFor(run);
  const sizeStr = run.fileSize ? ` · ${(run.fileSize / 1024).toFixed(1)} KB` : '';

  return (
    <li className="card overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 p-3">
        <button
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
          aria-expanded={isOpen}
        >
          <span className={`h-2 w-2 shrink-0 rounded-full ${isOpen ? 'bg-accent' : 'bg-slate-400'}`} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium text-slate-950">{run.filename}</div>
            <div className="truncate text-[11px] text-slate-500">
              {TAB_LABELS[run.tab]} · {relativeDate(run.timestamp)} ({fmtDate(run.timestamp)}) · {summary}
              {sizeStr}
            </div>
          </div>
        </button>
        <div className="flex shrink-0 items-center gap-1">
          {run.notes && <span className="badge border-slate-300 bg-slate-200/60 text-slate-400" title={run.notes}>📝</span>}
          {run.tags.length > 0 && (
            <span className="badge border-slate-300 bg-slate-200/60 text-slate-400">{run.tags.length} tag(s)</span>
          )}
          <button
            onClick={() => onUpdate({ favorite: !run.favorite })}
            className="p-1 rounded hover:bg-slate-200 transition-colors"
            title={run.favorite ? 'Remove from favorites' : 'Add to favorites'}
            aria-label={run.favorite ? 'Remove from favorites' : 'Add to favorites'}
          >
            <svg
              className={`h-4 w-4 transition-colors ${run.favorite ? 'text-red-400 fill-current' : 'text-slate-500'}`}
              viewBox="0 0 24 24"
              fill={run.favorite ? 'currentColor' : 'none'}
              stroke="currentColor"
              strokeWidth={run.favorite ? 0 : 2}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
            </svg>
          </button>
          <button onClick={onReuse} className="btn-ghost text-xs" title="Load these settings into the current tab">
            Re-use settings
          </button>
          <button onClick={onDelete} className="btn-ghost text-xs text-rose-400" title="Delete this run">
            Delete
          </button>
        </div>
      </div>

      {isOpen && (
        <div className="border-t border-slate-200 p-3">
          <RunDetails run={run} onUpdate={onUpdate} />
        </div>
      )}
    </li>
  );
}

function RunDetails({
  run,
  onUpdate,
}: {
  run: StoredRun;
  onUpdate: (patch: Partial<StoredRun>) => void;
}) {
  return (
    <div className="grid gap-3">
      {/* Settings snapshot */}
      <div className="grid gap-2 rounded-lg border border-slate-200 bg-slate-100/40 p-3 text-xs">
        <div className="text-[10px] uppercase tracking-wide text-slate-500">Settings used</div>
        <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-[11px] text-slate-400">
          {JSON.stringify(run.settings, null, 2)}
        </pre>
      </div>

      {/* Notes + tags editor */}
      <div className="grid gap-2 rounded-lg border border-slate-200 bg-slate-100/40 p-3">
        <div>
          <label className="text-[10px] uppercase tracking-wide text-slate-500">Notes</label>
          <textarea
            className="input mt-1 min-h-[60px] text-sm"
            placeholder="Anything you want to remember about this run…"
            value={run.notes}
            onChange={(e) => onUpdate({ notes: e.target.value })}
          />
        </div>
        <div>
          <label className="text-[10px] uppercase tracking-wide text-slate-500">Tags (comma-separated)</label>
          <input
            className="input mt-1 text-sm"
            placeholder="invoice, legal, q4-2025"
            value={run.tags.join(', ')}
            onChange={(e) =>
              onUpdate({
                tags: e.target.value
                  .split(',')
                  .map((t) => t.trim())
                  .filter(Boolean),
              })
            }
          />
        </div>
      </div>

      {/* Inline result render for the relevant tab */}
      {run.tab === 'document' || run.tab === 'translated' ? (
        <DocumentResultDetail result={run.result as DocumentResult} run={run} onUpdate={onUpdate} />
      ) : run.tab === 'ocr' ? (
        <OcrResultDetail result={run.result as OcrImageResponse} filename={run.filename} run={run} onUpdate={onUpdate} />
      ) : run.tab === 'compare' ? (
        <CompareResultDetail result={run.result as CompareRecord} />
      ) : (
        <TableResultDetail result={run.result as TableResult} run={run} onUpdate={onUpdate} />
      )}
    </div>
  );
}

function DocumentResultDetail({ result, run, onUpdate }: { result: DocumentResult; run: StoredRun; onUpdate: (patch: Partial<StoredRun>) => void }) {
  const [pageIdx, setPageIdx] = useState(0);
  const current = result.pages?.[pageIdx];
  const fullText = docText(result);
  const perPageText = useMemo(
    () =>
      current
        ? `--- Page ${current.page_number} ---\n` +
          current.regions
            .map((rg) => rg.text?.trim() ?? '')
            .filter((t) => t.length > 0)
            .join('\n\n')
        : '',
    [current],
  );
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs text-slate-400">
          {result.num_pages} page(s) · {result.pages?.reduce((s, p) => s + p.regions.length, 0)} region(s)
        </div>
        <div className="flex items-center gap-2">
          <ResultsToolbar
            filenameBase={result.filename.replace(/\.[^.]+$/, '')}
            text={fullText}
            json={result}
            documentResult={result}
            markdownSource={resultToMarkdown(result)}
            perPageText={perPageText}
          />
          <button
            onClick={() => onUpdate({ favorite: !run.favorite })}
            className="p-1 rounded hover:bg-slate-200 transition-colors"
            title={run.favorite ? 'Remove from favorites' : 'Add to favorites'}
          >
            <svg
              className={run.favorite ? 'h-4 w-4 text-red-400 fill-current' : 'h-4 w-4 text-slate-500'}
              viewBox="0 0 24 24"
              fill={run.favorite ? 'currentColor' : 'none'}
              stroke="currentColor"
              strokeWidth={run.favorite ? 0 : 2}
            >
              <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
            </svg>
          </button>
        </div>
      </div>
      <ConfidenceDashboard result={result} />
      {result.pages && result.pages.length > 1 && (
        <div className="mb-2">
          <PageNavigator
            currentIndex={pageIdx}
            totalPages={result.pages.length}
            pageNumbers={result.pages.map((p) => p.page_number)}
            onChange={setPageIdx}
          />
        </div>
      )}
      {current && (
        <BoundingBoxViewer
          page={current}
          imageUrl={run.pagePreviews?.[current.page_number]}
          fullText={fullText}
          markdownSource={resultToMarkdown(result)}
          jsonSource={JSON.stringify(result, null, 2)}
          tableCrops={result.table_crops}
          figureCrops={result.figure_crops}
          imageCrops={result.image_crops}
        />
      )}
    </div>
  );
}

function OcrResultDetail({ result, filename, run, onUpdate }: { result: OcrImageResponse; filename: string; run: StoredRun; onUpdate: (patch: Partial<StoredRun>) => void }) {
  // Saved source-image thumbnail (added 2026-07-05); older runs are text-only.
  const sourceImage = run.pagePreviews?.[1];
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs text-slate-400">{(result.text ?? '').length} character(s)</div>
        <ResultsToolbar
          filenameBase={filename.replace(/\.[^.]+$/, '')}
          text={result.text ?? ''}
          json={result}
        />
        <button
          onClick={() => onUpdate({ favorite: !run.favorite })}
          className="p-1 rounded hover:bg-slate-200 transition-colors"
          title={run.favorite ? 'Remove from favorites' : 'Add to favorites'}
          aria-label={run.favorite ? 'Remove from favorites' : 'Add to favorites'}
        >
          <svg
            className={`h-4 w-4 transition-colors ${run.favorite ? 'text-red-400 fill-current' : 'text-slate-500'}`}
            viewBox="0 0 24 24"
            fill={run.favorite ? 'currentColor' : 'none'}
            stroke="currentColor"
            strokeWidth={run.favorite ? 0 : 2}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
          </svg>
        </button>
      </div>
      {sourceImage ? (
        // Image + text side-by-side (stacked on phones), like the live OCR tab.
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1.2fr)_minmax(260px,0.8fr)]">
          <ZoomableImage imageUrl={sourceImage} alt={filename} minHeightClass="min-h-[280px]" enableKeyboard={false} />
          <pre className="max-h-96 overflow-auto rounded-lg border border-slate-200 bg-slate-50 p-4 font-mono text-sm whitespace-pre-wrap text-slate-700">
            {result.text || <span className="italic text-slate-500">(no text)</span>}
          </pre>
        </div>
      ) : (
        <pre className="max-h-96 overflow-auto rounded-lg border border-slate-200 bg-slate-50 p-4 font-mono text-sm whitespace-pre-wrap text-slate-700">
          {result.text || <span className="italic text-slate-500">(no text)</span>}
        </pre>
      )}
    </div>
  );
}

function TableResultDetail({ result, run, onUpdate }: { result: TableResult; run: StoredRun; onUpdate: (patch: Partial<StoredRun>) => void }) {
  // Prefer the compact saved page thumbnail; fall back to the result's
  // debug_image (raw base64) so the source photo is always available here.
  const sourceImage =
    run.pagePreviews?.[1] ??
    (result.debug_image ? `data:image/png;base64,${result.debug_image}` : undefined);

  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs text-slate-400">
          {result.num_rows} × {result.num_cols} · {result.cells?.length} cells
        </div>
        <div className="flex items-center gap-2">
          <ResultsToolbar
            filenameBase={result.filename.replace(/\.[^.]+$/, '')}
            text={result.structured_text}
            json={result}
          />
          <button
            onClick={() => onUpdate({ favorite: !run.favorite })}
            className="p-1 rounded hover:bg-slate-200 transition-colors"
            title={run.favorite ? 'Remove from favorites' : 'Add to favorites'}
          >
            <svg
              className={run.favorite ? 'h-4 w-4 text-red-400 fill-current' : 'h-4 w-4 text-slate-500'}
              viewBox="0 0 24 24"
              fill={run.favorite ? 'currentColor' : 'none'}
              stroke="currentColor"
              strokeWidth={run.favorite ? 0 : 2}
            >
              <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
            </svg>
          </button>
        </div>
      </div>
      <ResultPreviewTabs
        defaultTab="grid"
        tabs={[
          {
            id: 'grid',
            label: 'Grid',
            content: (
              <TableGrid cells={result.cells ?? []} rows={result.num_rows} cols={result.num_cols} compact />
            ),
          },
          {
            id: 'image',
            label: 'Image',
            content: sourceImage ? (
              <ZoomableImage
                imageUrl={sourceImage}
                alt={`${result.filename} source`}
                minHeightClass="min-h-[300px]"
                enableKeyboard={false}
              />
            ) : (
              <div className="grid h-48 place-items-center rounded-lg border border-dashed border-slate-300 bg-slate-50 text-sm text-slate-500">
                No source image saved for this run.
              </div>
            ),
          },
          {
            id: 'source',
            label: 'Source',
            copyText: result.structured_text,
            copyHint: 'Raw structured text · what gets saved to .txt',
            content: (
              <pre className="max-h-64 overflow-auto rounded-lg border border-slate-200 bg-slate-50 p-3 font-mono text-xs whitespace-pre-wrap text-slate-600">
                {result.structured_text}
              </pre>
            ),
          },
          {
            id: 'json',
            label: 'JSON',
            copyText: JSON.stringify(result, null, 2),
            copyHint: 'Formatted JSON · what gets saved to .json',
            content: <JsonTree data={result} maxHeight="360px" />,
          },
        ]}
      />
    </div>
  );
}

