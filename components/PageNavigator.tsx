import { useCallback, useEffect, useMemo } from 'react';

export interface PageNavigatorProps {
  currentIndex: number;
  totalPages: number;
  pageNumbers: number[];
  onChange: (index: number) => void;
}

function pagePills(total: number, current: number): (number | '...')[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i);
  const out: (number | '...')[] = [];
  out.push(0);
  if (current > 3) out.push('...');
  const start = Math.max(1, current - 1);
  const end = Math.min(total - 2, current + 1);
  for (let i = start; i <= end; i++) out.push(i);
  if (current < total - 4) out.push('...');
  out.push(total - 1);
  return out;
}

export function PageNavigator({ currentIndex, totalPages, pageNumbers, onChange }: PageNavigatorProps) {
  const pills = useMemo(() => pagePills(totalPages, currentIndex), [totalPages, currentIndex]);

  const goPrev = useCallback(() => {
    if (currentIndex > 0) onChange(currentIndex - 1);
  }, [currentIndex, onChange]);

  const goNext = useCallback(() => {
    if (currentIndex < totalPages - 1) onChange(currentIndex + 1);
  }, [currentIndex, totalPages, onChange]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) return;
      }
      if (e.key === 'ArrowLeft') goPrev();
      else if (e.key === 'ArrowRight') goNext();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [goPrev, goNext]);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        onClick={goPrev}
        disabled={currentIndex === 0}
        className="btn-ghost px-2 py-1 text-xs disabled:opacity-30"
        title="Previous page (Left arrow)"
      >
        ← Prev
      </button>

      <span className="text-xs text-ink-400 tabular-nums">
        Page {pageNumbers[currentIndex]} of {pageNumbers[totalPages - 1]}
      </span>

      {pills.map((p, i) =>
        p === '...' ? (
          <span key={`dot-${i}`} className="px-1 text-xs text-ink-600">
            …
          </span>
        ) : (
          <button
            key={p}
            onClick={() => onChange(p)}
            className={`btn px-2 py-1 text-xs ${
              p === currentIndex
                ? 'bg-accent text-ink-50'
                : 'border border-ink-700 bg-ink-800/60 text-ink-200 hover:bg-ink-700/70'
            }`}
          >
            {pageNumbers[p]}
          </button>
        ),
      )}

      <button
        onClick={goNext}
        disabled={currentIndex >= totalPages - 1}
        className="btn-ghost px-2 py-1 text-xs disabled:opacity-30"
        title="Next page (Right arrow)"
      >
        Next →
      </button>
    </div>
  );
}
