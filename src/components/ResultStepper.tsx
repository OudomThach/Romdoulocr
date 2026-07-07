/**
 * ◀ N / M ▶ stepper for paging between multiple finished results (one per
 * processed file / page) after a batch run. Renders nothing for a single item.
 */
export function ResultStepper({
  index,
  count,
  onChange,
  label = 'Result',
}: {
  index: number;
  count: number;
  onChange: (i: number) => void;
  label?: string;
}) {
  if (count <= 1) return null;
  const btn =
    'grid h-7 w-7 place-items-center rounded-lg border border-slate-200 bg-white text-slate-600 shadow-sm transition-colors hover:bg-slate-50 hover:text-slate-950 disabled:cursor-not-allowed disabled:opacity-40';
  return (
    <div className="flex items-center gap-1.5 text-xs" role="group" aria-label={`${label} navigation`}>
      <button type="button" className={btn} onClick={() => onChange(Math.max(0, index - 1))} disabled={index <= 0} aria-label="Previous">
        ◀
      </button>
      <span className="tabular-nums font-medium text-slate-600">
        {label} {index + 1} / {count}
      </span>
      <button type="button" className={btn} onClick={() => onChange(Math.min(count - 1, index + 1))} disabled={index >= count - 1} aria-label="Next">
        ▶
      </button>
    </div>
  );
}
