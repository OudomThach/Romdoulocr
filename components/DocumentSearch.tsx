import { useMemo, useState } from 'react';
import type { DocumentResult } from '@/types/api';

interface Match {
  pageIndex: number;
  pageNumber: number;
  type: string;
  snippet: string;
}

const MAX_RESULTS = 100;

/**
 * Find-in-document: searches every region's text for the query and lists the
 * matches with a snippet + page. Clicking a result jumps the preview to that
 * page. Case-insensitive substring (Khmer is caseless, so this is exact).
 */
export function DocumentSearch({
  result,
  onJump,
}: {
  result: DocumentResult;
  onJump: (pageIndex: number) => void;
}) {
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();

  const matches = useMemo<Match[]>(() => {
    if (!q) return [];
    const out: Match[] = [];
    for (let pi = 0; pi < result.pages.length; pi++) {
      const page = result.pages[pi];
      for (const r of page.regions) {
        const text = (r.text ?? '').replace(/\s+/g, ' ').trim();
        if (!text) continue;
        const idx = text.toLowerCase().indexOf(q);
        if (idx < 0) continue;
        const start = Math.max(0, idx - 30);
        const end = Math.min(text.length, idx + q.length + 50);
        const snippet = (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
        out.push({ pageIndex: pi, pageNumber: page.page_number, type: r.region_type, snippet });
        if (out.length >= MAX_RESULTS) return out;
      }
    }
    return out;
  }, [q, result]);

  return (
    <div className="mt-3">
      <div className="relative">
        <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Find in document…"
          className="w-full rounded-lg border border-slate-200 bg-white py-2 pl-9 pr-3 text-sm text-slate-800 placeholder:text-slate-400 focus:border-slate-400 focus:outline-none"
        />
      </div>
      {q && (
        <div className="mt-2 rounded-lg border border-slate-200 bg-white">
          <div className="border-b border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-500">
            {matches.length === 0
              ? 'No matches'
              : `${matches.length}${matches.length >= MAX_RESULTS ? '+' : ''} match${matches.length === 1 ? '' : 'es'}`}
          </div>
          {matches.length > 0 && (
            <ul className="max-h-56 divide-y divide-slate-100 overflow-auto">
              {matches.map((m, i) => (
                <li key={i}>
                  <button
                    type="button"
                    onClick={() => onJump(m.pageIndex)}
                    className="flex w-full items-start gap-2 px-3 py-2 text-left text-xs hover:bg-slate-50"
                  >
                    <span className="mt-0.5 shrink-0 rounded bg-slate-100 px-1.5 py-0.5 font-semibold text-slate-500">
                      p{m.pageNumber}
                    </span>
                    <span className="min-w-0 flex-1 break-words text-slate-700">{m.snippet}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function SearchIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}
