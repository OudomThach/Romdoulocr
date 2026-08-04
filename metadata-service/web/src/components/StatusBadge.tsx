const styles: Record<string, string> = {
  raw: "border-slate-200 bg-white text-slate-500",
  edited: "border-accent2/40 bg-accent2/10 text-accent2",
  verified: "border-accent/40 bg-accent/10 text-accent",
};

export default function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`badge ${styles[status] ?? styles.raw}`}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {status}
    </span>
  );
}
