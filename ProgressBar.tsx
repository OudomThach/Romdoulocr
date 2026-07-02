export interface ProgressBarProps {
  /** 0..100. Hides when null/undefined. */
  value: number | null;
  label?: string;
}

export function ProgressBar({ value, label }: ProgressBarProps) {
  if (value === null || value === undefined) return null;
  const clamped = Math.max(0, Math.min(100, value));
  return (
    <div className="w-full">
      {label && <div className="mb-1 text-xs text-ink-400">{label}</div>}
      <div className="h-2 w-full overflow-hidden rounded-full bg-ink-800">
        <div
          className="h-full rounded-full bg-accent transition-[width] duration-150"
          style={{ width: `${clamped}%` }}
        />
      </div>
      <div className="mt-1 text-right text-[11px] text-ink-500">{clamped}%</div>
    </div>
  );
}
