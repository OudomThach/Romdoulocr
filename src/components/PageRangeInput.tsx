import { useEffect, useMemo, useState } from 'react';
import { getPdfPageCount, parsePageRange } from '@/lib/pdfProcessing';

export interface PageRangeInputProps {
  file: File;
  value: string;
  onChange: (value: string) => void;
  onValidRangeChange: (pages: number[]) => void;
}

/**
 * Text input for "1-3, 5, 7-9" style page ranges with live validation.
 *
 * - Empty input = all pages.
 * - Out-of-range values (e.g. "1-50" on a 5-page PDF) are CLAMPED, not
 *   rejected — the user gets a hint that explains what will actually be
 *   parsed, instead of an error that blocks them from running.
 * - Malformed input (e.g. "abc") surfaces an inline error.
 */
export function PageRangeInput({ file, value, onChange, onValidRangeChange }: PageRangeInputProps) {
  const [totalPages, setTotalPages] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resolved, setResolved] = useState<number[] | null>(null);
  const [wasClamped, setWasClamped] = useState(false);

  // Read total page count once per file.
  useEffect(() => {
    let cancelled = false;
    setTotalPages(null);
    setError(null);
    setResolved(null);
    setWasClamped(false);
    getPdfPageCount(file)
      .then((n) => {
        if (!cancelled) setTotalPages(n);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to read PDF');
      });
    return () => {
      cancelled = true;
    };
  }, [file]);

  // Re-validate the user's range whenever the input or page count changes.
  useEffect(() => {
    if (totalPages === null) return;
    try {
      const pages = parsePageRange(value, totalPages);
      setError(null);
      setResolved(pages);
      onValidRangeChange(pages);
      // Detect clamping: if any token the user wrote referenced a
      // number > totalPages or < 1, we clamped it. Cheap heuristic.
      const raw = value.trim();
      if (raw) {
        const written = new Set<number>();
        for (const part of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
          const m = /^(\d+)\s*-\s*(\d+)$/.exec(part);
          if (m) {
            const a = parseInt(m[1], 10);
            const b = parseInt(m[2], 10);
            for (let i = Math.min(a, b); i <= Math.max(a, b); i++) written.add(i);
          } else if (/^\d+$/.test(part)) {
            written.add(parseInt(part, 10));
          }
        }
        const outOfRange = [...written].some((n) => n < 1 || n > totalPages);
        setWasClamped(outOfRange);
      } else {
        setWasClamped(false);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Invalid range');
      setResolved(null);
      setWasClamped(false);
    }
  }, [value, totalPages, onValidRangeChange]);

  // Compact summary: show first few pages + "and N more" for long lists.
  const summary = useMemo(() => {
    if (!resolved || resolved.length === 0) return null;
    const head = resolved.slice(0, 6).join(', ');
    const tail = resolved.length > 6 ? `, … +${resolved.length - 6} more` : '';
    return `${head}${tail}`;
  }, [resolved]);

  const placeholder = totalPages ? `e.g. 1-3, 5, ${totalPages}` : 'loading…';

  return (
    <div className="grid gap-1.5 text-sm">
      <div className="flex items-center justify-between">
        <label htmlFor="page-range" className="text-ink-200">
          Pages
        </label>
        {totalPages !== null && (
          <span className="text-[11px] text-ink-500">
            {resolved ? `${resolved.length} of ${totalPages}` : `${totalPages} total`}
          </span>
        )}
      </div>
      <input
        id="page-range"
        type="text"
        className="input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
      />
      <div className="flex items-center justify-between text-[11px]">
        <span className="text-ink-500">
          {value.trim() === ''
            ? 'empty = all pages'
            : wasClamped
              ? 'out-of-range values clamped'
              : 'comma-separated ranges ok'}
        </span>
        <button
          type="button"
          className="btn-ghost px-1.5 py-0.5 text-[11px]"
          onClick={() => onChange('')}
          disabled={value === ''}
        >
          all
        </button>
      </div>
      {error && <div className="text-[11px] text-rose-400">{error}</div>}
      {!error && summary && wasClamped && (
        <div className="text-[11px] text-amber-400">
          Will parse: {summary}
        </div>
      )}
    </div>
  );
}
