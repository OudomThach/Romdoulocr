import { useEffect, useRef, useState } from 'react';
import { transformToTidy, type TidyResult } from '@/lib/tidy';
import { copyToClipboard, downloadText } from '@/lib/utils';

/**
 * "Transform to tidy" panel for the Table results card.
 *
 * Self-contained: takes the current Markdown table, calls the tidy-adapter on
 * demand, and renders the reshaped tidy table (grid + notes) with copy/download.
 * Independent of the OCR backend toggle — it's a post-extraction LLM transform.
 */
export function TidyPanel({ markdown, filenameBase }: { markdown: string; filenameBase: string }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<TidyResult | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // A new extraction (new markdown) invalidates a previous tidy result.
  useEffect(() => {
    setResult(null);
    setError(null);
  }, [markdown]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const run = async () => {
    const source = markdown.trim();
    if (!source) {
      setError('No table to transform yet.');
      return;
    }
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);
    setError(null);
    try {
      const res = await transformToTidy(source, { signal: ctrl.signal });
      setResult(res);
    } catch (e) {
      if (!ctrl.signal.aborted) {
        setError(e instanceof Error ? e.message : 'Tidy transform failed');
      }
    } finally {
      if (abortRef.current === ctrl) {
        abortRef.current = null;
        setLoading(false);
      }
    }
  };

  return (
    <div className="flex min-h-[520px] flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-slate-950">✨ Transform to tidy data</div>
          <div className="text-xs text-slate-500">
            Reshapes wide / matrix tables into tidy long format (one observation per row) with an LLM.
          </div>
        </div>
        <button
          type="button"
          onClick={() => void run()}
          disabled={loading || !markdown.trim()}
          className="inline-flex items-center gap-2 rounded-lg bg-slate-950 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? (
            <>
              <Spinner className="h-4 w-4 animate-spin" /> Transforming…
            </>
          ) : (
            <>✨ {result ? 'Transform again' : 'Transform to tidy'}</>
          )}
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {error}
        </div>
      )}

      {!result && !loading && !error && (
        <div className="grid flex-1 place-items-center rounded-lg border border-dashed border-slate-300 bg-slate-50 text-center">
          <div className="max-w-sm px-6">
            <div className="text-sm font-semibold text-slate-950">No tidy transform yet</div>
            <p className="mt-1 text-sm text-slate-500">
              Click <span className="font-medium">Transform to tidy</span> to unpivot this table into
              analysis-ready rows. The original extraction is left untouched.
            </p>
          </div>
        </div>
      )}

      {loading && !result && (
        <div className="grid flex-1 place-items-center rounded-lg border border-dashed border-slate-300 bg-slate-50 text-center">
          <div className="flex items-center gap-2 text-sm text-slate-500">
            <Spinner className="h-4 w-4 animate-spin" /> Asking the model to tidy this table…
          </div>
        </div>
      )}

      {result && (
        <>
          {result.notes && (
            <div className="rounded-lg border border-sky-200 bg-sky-50 px-4 py-2 text-xs text-sky-800">
              <span className="font-semibold">What changed:</span> {result.notes}
            </div>
          )}

          <div className="flex flex-wrap items-center justify-end gap-2">
            <TidyButton
              label="Copy CSV"
              onClick={() => void copyToClipboard(result.tidy_csv)}
            />
            <TidyButton
              label="Copy Markdown"
              onClick={() => void copyToClipboard(result.tidy_markdown)}
            />
            <TidyButton
              label="Download CSV"
              onClick={() =>
                downloadText(`${filenameBase}-tidy.csv`, '﻿' + result.tidy_csv, 'text/csv;charset=utf-8')
              }
            />
            <TidyButton
              label="Download MD"
              onClick={() =>
                downloadText(`${filenameBase}-tidy.md`, result.tidy_markdown, 'text/markdown;charset=utf-8')
              }
            />
          </div>

          <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-slate-200 bg-white">
            <table className="w-full border-collapse text-sm">
              <thead className="sticky top-0 bg-slate-100">
                <tr>
                  {result.columns.map((c, i) => (
                    <th
                      key={i}
                      className="border-b border-slate-200 px-3 py-2 text-left font-semibold text-slate-950"
                    >
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.rows.map((row, ri) => (
                  <tr key={ri} className={ri % 2 ? 'bg-slate-50' : 'bg-white'}>
                    {result.columns.map((_, ci) => (
                      <td
                        key={ci}
                        className="border-b border-slate-100 px-3 py-1.5 align-top text-slate-800"
                      >
                        {row[ci] ?? ''}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="text-[11px] text-slate-400">
            {result.rows.length} rows × {result.columns.length} columns · via {result.model}
          </div>
        </>
      )}
    </div>
  );
}

function TidyButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-950 shadow-sm hover:bg-slate-50"
    >
      {label}
    </button>
  );
}

function Spinner({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 3a9 9 0 1 0 9 9" strokeLinecap="round" />
    </svg>
  );
}
