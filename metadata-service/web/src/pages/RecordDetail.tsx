import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../api/client";
import StatusBadge from "../components/StatusBadge";

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

export default function RecordDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [dataJson, setDataJson] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const { data: rec, isLoading } = useQuery({
    queryKey: ["record", id],
    queryFn: () => api.getRecord(id!),
  });

  const patch = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patchRecord(id!, body),
    onSuccess: () => {
      setSaved(true);
      qc.invalidateQueries({ queryKey: ["record", id] });
      qc.invalidateQueries({ queryKey: ["records"] });
      qc.invalidateQueries({ queryKey: ["stats"] });
      setTimeout(() => setSaved(false), 2000);
    },
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

  const editData = () => {
    try {
      const parsed = JSON.parse(dataJson ?? "");
      patch.mutate({ data: parsed });
    } catch {
      setSaved(false);
      alert("Invalid JSON");
    }
  };

  return (
    <div className="p-6 max-w-5xl">
      <div className="flex items-center gap-3 mb-5">
        <Link to="/records" className="btn-ghost">← Records</Link>
        <h1 className="display break-all">{rec.type}</h1>
        <StatusBadge status={rec.status} />
        <code className="text-xs text-slate-500 break-all">{rec.id}</code>
      </div>

      <div className="grid md:grid-cols-2 gap-4 mb-4">
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

      <Section title="Data payload">
        <pre className="font-mono text-xs text-slate-700 dark:text-slate-200 bg-slate-50 dark:bg-white/5 rounded-lg p-3 overflow-auto max-h-96 whitespace-pre-wrap break-all">
          {JSON.stringify(rec.data, null, 2)}
        </pre>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button className="btn-secondary" onClick={() => setDataJson(JSON.stringify(rec.data, null, 2))}>Edit data</button>
          {dataJson !== null && (
            <>
              <textarea
                className="input font-mono text-xs w-full min-h-32 mt-2"
                value={dataJson}
                onChange={(e) => setDataJson(e.target.value)}
                spellCheck={false}
              />
              <button className="btn-primary" onClick={editData}>Save changes</button>
              <button className="btn-ghost" onClick={() => setDataJson(null)}>Cancel</button>
            </>
          )}
          {saved && <span className="self-center text-xs font-medium text-accent2">Saved — audit updated, status → edited</span>}
        </div>
      </Section>

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
