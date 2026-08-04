export default function StatCard({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="panel px-5 py-4">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold tracking-tight text-slate-950 dark:text-slate-100">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-slate-500">{sub}</div>}
    </div>
  );
}
