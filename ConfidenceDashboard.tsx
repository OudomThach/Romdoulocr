import { useMemo } from 'react';
import type { DocumentResult } from '@/types/api';
import { fmtPct } from '@/lib/utils';

export interface ConfidenceDashboardProps {
  result: DocumentResult;
  /** Optional callback when a bucket is clicked — for filtering regions. */
  onBucketSelect?: (bucket: 'low' | 'medium' | 'high') => void;
}

interface BucketStats {
  count: number;
  totalLines: number;
  pct: number; // 0..1
}

/**
 * Summarizes OCR confidence across all pages × regions × lines and shows a
 * distribution in three buckets. Useful as a trust signal: if a page has a
 * lot of <60% lines, the user should review the extracted text rather than
 * pasting it into a downstream pipeline.
 */
export function ConfidenceDashboard({ result, onBucketSelect }: ConfidenceDashboardProps) {
  const stats = useMemo(() => {
    const buckets: Record<'low' | 'medium' | 'high', BucketStats> = {
      low: { count: 0, totalLines: 0, pct: 0 },
      medium: { count: 0, totalLines: 0, pct: 0 },
      high: { count: 0, totalLines: 0, pct: 0 },
    };
    const allConfs: number[] = [];
    let totalRegions = 0;

    for (const page of result.pages) {
      for (const region of page.regions) {
        totalRegions++;
        // Roll region confidence up into the line-level view too — most users
        // care about per-line OCR confidence, not the layout region's score.
        for (const line of region.lines) {
          allConfs.push(line.confidence);
          const b = bucketFor(line.confidence);
          buckets[b].count++;
          buckets[b].totalLines++;
        }
      }
    }

    const total = allConfs.length;
    if (total > 0) {
      buckets.low.pct = buckets.low.count / total;
      buckets.medium.pct = buckets.medium.count / total;
      buckets.high.pct = buckets.high.count / total;
    }
    const avg = total ? allConfs.reduce((s, c) => s + c, 0) / total : 0;
    const min = total ? Math.min(...allConfs) : 0;
    const max = total ? Math.max(...allConfs) : 0;
    return { buckets, total, totalRegions, avg, min, max };
  }, [result]);

  if (stats.total === 0) return null;

  return (
    <div className="card p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="text-xs uppercase tracking-wide text-ink-400">Confidence</div>
        <div className="text-xs text-ink-500">
          {stats.total} line(s) · {stats.totalRegions} region(s)
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-[1fr_auto] md:items-center">
        <div>
          <div className="mb-1.5 flex h-3 w-full overflow-hidden rounded-full border border-ink-800 bg-ink-900">
            <BucketBar
              pct={stats.buckets.low.pct}
              color="bg-rose-500"
              label={`Low ${fmtPct(stats.buckets.low.pct)}`}
              onClick={() => onBucketSelect?.('low')}
            />
            <BucketBar
              pct={stats.buckets.medium.pct}
              color="bg-amber-400"
              label={`Medium ${fmtPct(stats.buckets.medium.pct)}`}
              onClick={() => onBucketSelect?.('medium')}
            />
            <BucketBar
              pct={stats.buckets.high.pct}
              color="bg-emerald-500"
              label={`High ${fmtPct(stats.buckets.high.pct)}`}
              onClick={() => onBucketSelect?.('high')}
            />
          </div>
          <div className="flex justify-between text-[11px] text-ink-500">
            <span>
              <span className="mr-1 inline-block h-2 w-2 rounded-full bg-rose-500 align-middle" />
              Low (&lt;60%)
            </span>
            <span>
              <span className="mr-1 inline-block h-2 w-2 rounded-full bg-amber-400 align-middle" />
              Medium
            </span>
            <span>
              <span className="mr-1 inline-block h-2 w-2 rounded-full bg-emerald-500 align-middle" />
              High (&gt;85%)
            </span>
          </div>
        </div>

        <dl className="grid grid-cols-3 gap-3 text-center md:gap-5">
          <Stat label="Avg" value={fmtPct(stats.avg)} />
          <Stat label="Min" value={fmtPct(stats.min)} tone={tone(stats.min)} />
          <Stat label="Max" value={fmtPct(stats.max)} tone="good" />
        </dl>
      </div>
    </div>
  );
}

function bucketFor(c: number): 'low' | 'medium' | 'high' {
  if (c < 0.6) return 'low';
  if (c < 0.85) return 'medium';
  return 'high';
}

function tone(c: number): 'good' | 'warn' | 'bad' {
  if (c >= 0.85) return 'good';
  if (c >= 0.6) return 'warn';
  return 'bad';
}

function BucketBar({
  pct,
  color,
  label,
  onClick,
}: {
  pct: number;
  color: string;
  label: string;
  onClick?: () => void;
}) {
  if (pct <= 0) return null;
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={`h-full ${color} transition-opacity hover:opacity-80`}
      style={{ width: `${pct * 100}%` }}
    />
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'warn' | 'bad' }) {
  const color =
    tone === 'good' ? 'text-emerald-400' : tone === 'warn' ? 'text-amber-400' : tone === 'bad' ? 'text-rose-400' : 'text-ink-50';
  return (
    <div>
      <div className={`font-mono text-sm font-semibold ${color}`}>{value}</div>
      <div className="mt-0.5 text-[10px] uppercase tracking-wide text-ink-500">{label}</div>
    </div>
  );
}
