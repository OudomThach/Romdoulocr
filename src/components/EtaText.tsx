import { useEffect, useRef, useState } from 'react';

/**
 * "~2m 14s left" estimate for batch progress. Measures the per-item rate from
 * the first render with progress (done>0) and projects the remainder. Hides
 * itself until there is enough signal (8s) to be meaningful.
 */
export function EtaText({ done, total }: { done: number; total: number }) {
  const startedAt = useRef<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 5000);
    return () => window.clearInterval(id);
  }, []);

  if (done <= 0 || done >= total) return null;
  if (startedAt.current === null) startedAt.current = now;
  const elapsed = (now - startedAt.current) / 1000;
  if (elapsed < 8) return null; // too early for a stable estimate

  const remaining = Math.round((elapsed / done) * (total - done));
  if (remaining <= 0) return null;
  const m = Math.floor(remaining / 60);
  const s = remaining % 60;
  return (
    <span className="text-xs text-slate-400" title="Estimated from the current per-page rate">
      · ~{m > 0 ? `${m}m ` : ''}{s}s left
    </span>
  );
}
