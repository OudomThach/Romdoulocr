import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, type AuditEventOut } from "../api/client";
import StatusBadge from "../components/StatusBadge";
import DataFormEditor from "../components/DataFormEditor";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="panel p-4">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</div>
      {children}
    </div>
  );
}

function KV({ obj }: { obj: Record<string, unknown> | null | undefined }) {
  if (!obj || Object.keys(obj).length === 0) return <div className="text-xs text-slate-500">—</div>;
  return (
    <dl className="grid grid-cols-[160px_1fr] gap-x-3 gap-y-1.5">
      {Object.entries(obj).map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-xs text-slate-500 break-all">{k}</dt>
          <dd className="text-sm text-slate-700 dark:text-slate-200 break-all">{typeof v === "object" ? JSON.stringify(v) : String(v)}</dd>
        </div>
      ))}
    </dl>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
        active ? "bg-slate-100 text-slate-950" : "text-slate-500 hover:text-slate-800"
      }`}
    >
      {children}
    </button>
  );
}

function HistoryTimeline({ recordId }: { recordId: string }) {
  const { data: events, isLoading, isError } = useQuery({
    queryKey: ["history", recordId],
    queryFn: () => api.recordHistory(recordId),
  });
  const [expanded, setExpanded] = useState<number | null>(null);

  if (isLoading) return <div className="text-sm text-slate-500">Loading history…</div>;
  if (isError || !events) return <div className="text-sm text-red-500">Could not load history.</div>;
  if (events.length === 0) return <div className="text-sm text-slate-500">No history yet.</div>;

  const tone: Record<string, string> = {
    create: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    delete: "border-red-500/30 bg-red-500/10 text-red-500",
    update: "border-accent2/30 bg-accent2/10 text-accent2",
  };

  return (
    <ol className="relative space-y-4 border-l border-slate-200 dark:border-white/10 pl-4">
      {events.map((ev: AuditEventOut) => (
        <li key={ev.id} className="relative">
          <span className="absolute -left-[21px] top-1.5 h-2.5 w-2.5 rounded-full border-2 border-white dark:border-base-800 bg-accent shadow" />
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className={`badge ${tone[ev.action] ?? tone.update}`}>{ev.action}</span>
            <span className="font-mono text-xs text-slate-600 dark:text-slate-300">{ev.actor}</span>
            <span className="text-xs text-slate-400">{new Date(ev.at).toLocaleString()}</span>
            <button
              type="button"
              className="ml-auto text-xs text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
              onClick={() => setExpanded(expanded === ev.id ? null : ev.id)}
            >
              {expanded === ev.id ? "hide snapshot" : "view snapshot"}
            </button>
          </div>
          {expanded === ev.id && (
            <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-slate-50 dark:bg-white/5 p-3 font-mono text-[11px]">
              {JSON.stringify(ev.snapshot, null, 2)}
            </pre>
          )}
        </li>
      ))}
    </ol>
  );
}

export default function RecordDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [tab, setTab] = useState<"data" | "details" | "history">("data");
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const { data: rec, isLoading } = useQuery({
    queryKey: ["record", id],
    queryFn: () => api.getRecord(id!),
  });

  const patch = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patchRecord(id!, body),
    onSuccess: () => {
      setSaved(true);
      setSaveError(null);
      qc.invalidateQueries({ queryKey: ["record", id] });
      qc.invalidateQueries({ queryKey: ["records"] });
      qc.invalidateQueries({ queryKey: ["stats"] });
      qc.invalidateQueries({ queryKey: ["history", id] });
      setTimeout(() => setSaved(false), 2000);
    },
    onError: (err: Error) => setSaveError(err.message),
  });

  const remove = useMutation({
    mutationFn: () => api.deleteRecord(id!),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["records"] });
      qc.invalidateQueries({ queryKey: ["stats"] });
      navigate("/records");
    },
  });

  if (isLoading || !rec) return <div className="p-8 text-slate-500">Loading…</div>;

  return (
    <div className="p-6 max-w-5xl">
      <div className="flex items-center gap-3 mb-4">
        <Link to="/records" className="btn-ghost">← Records</Link>
        <h1 className="display break-all">{rec.type}</h1>
        <StatusBadge status={rec.status} />
        <code className="text-xs text-slate-500 break-all">{rec.id}</code>
      </div>

      <div className="flex items-center gap-1 rounded-lg border border-slate-200 bg-white dark:bg-white/5 p-0.5 shadow-sm w-fit mb-4">
        <TabButton active={tab === "data"} onClick={() => setTab("data")}>Edit data</TabButton>
        <TabButton active={tab === "details"} onClick={() => setTab("details")}>Details</TabButton>
        <TabButton active={tab === "history"} onClick={() => setTab("history")}>History</TabButton>
      </div>

      {tab === "details" && (
        <div className="grid md:grid-cols-2 gap-4">
          <Section title="Source">
            <KV obj={rec.source} />
            <div className="mt-2 text-xs text-slate-500">model: {rec.source_model ?? "—"} · system: {rec.source_system ?? "—"}</div>
          </Section>
          <Section title="Audit">
            <KV obj={rec.audit} />
            <div className="mt-2 text-xs text-slate-500">
              created_by: {rec.created_by} · edited_by: {rec.edited_by ?? "—"} · edits: {rec.edit_count}
            </div>
          </Section>
          <Section title="Pipeline">
            <KV obj={rec.pipeline} />
          </Section>
          <Section title="Business">
            <KV obj={rec.business} />
          </Section>
          <Section title="Record / validation">
            <KV obj={rec.record} />
          </Section>
        </div>
      )}

      {tab === "data" && (
        <Section title="Data payload — edit the extraction result">
          <DataFormEditor key={rec.edit_count} data={rec.data} onChange={(d) => patch.mutate({ data: d })} />
          {saved && <span className="mt-2 block text-xs font-medium text-accent2">Saved — audit updated, status → edited</span>}
          {saveError && <span className="mt-2 block text-xs text-red-500">{saveError}</span>}
        </Section>
      )}

      {tab === "history" && (
        <Section title="Edit history">
          <HistoryTimeline recordId={rec.id} />
        </Section>
      )}

      <div className="mt-4 flex justify-end">
        <button
          className="btn-ghost text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10"
          onClick={() => {
            if (confirm("Delete this record?")) remove.mutate();
          }}
        >
          Delete record
        </button>
      </div>
    </div>
  );
}
