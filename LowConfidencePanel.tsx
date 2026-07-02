import { useMemo, useState } from 'react';
import type { DocumentResult } from '@/types/api';
import { fmtPct } from '@/lib/utils';

const THRESHOLD = 0.6;

interface FlaggedRegion {
  page: number;
  type: string;
  text: string;
  confidence: number;
}

/**
 * Collapsible "needs review" panel: surfaces every region the OCR scored below
 * 60% confidence so the user can proofread the shaky parts instead of re-reading
 * the whole document. Hidden contents until expanded; shows a green all-clear
 * when nothing is flagged.
 */
export function LowConfidencePanel({ result }: { result: DocumentResult }) {
  const [open, setOpen] = useState(false);

  const flagged = useMemo<FlaggedRegion[]>(() => {
    const out: FlaggedRegion[] = [];
    for (const page of result.pages) {
      for (const r of page.regions) {
        const text = (r.text ?? '').trim();
        if (!text) continue;
        if ((r.confidence ?? 1) < THRESHOLD) {
          out.push({ page: page.page_number, type: r.region_type, text, confidence: r.confidence ?? 0 });
        }
      }
    }
    return out.sort((a, b) => a.confidence - b.confidence);
  }, [result]);

  if (flagged.length === 0) {
    return (
      <div className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2 text-xs font-medium text-emerald-700">
        ✓ No low-confidence regions — every block scored ≥ {Math.round(THRESHOLD * 100)}%.
      </div>
    );
  }

  return (
    <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-4 py-2 text-left"
      >
        <span className="text-sm font-semibold text-amber-800">
          ⚠ {flagged.length} low-confidence region{flagged.length === 1 ? '' : 's'} to review
        </span>
        <span className="text-xs font-semibold text-amber-700">{open ? 'Hide' : 'Show'}</span>
      </button>
      {open && (
        <ul className="max-h-64 space-y-1.5 overflow-auto border-t border-amber-200 px-4 py-3">
          {flagged.map((f, i) => (
            <li key={i} className="flex items-start gap-3 text-xs">
              <span className="mt-0.5 shrink-0 rounded bg-amber-200 px-1.5 py-0.5 font-mono font-semibold text-amber-900">
                {fmtPct(f.confidence)}
              </span>
              <span className="min-w-0 flex-1 break-words text-slate-700">
                <span className="text-slate-400">p{f.page} · {f.type}</span> — {f.text}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
