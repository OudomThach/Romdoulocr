import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api, type QueryParams } from "../api/client";
import StatusBadge from "../components/StatusBadge";
import { getUser } from "../api/client";

const PAGE_SIZE = 25;
const SAVED_KEY = "metadata_saved_filters";

function SkeletonRows({ count }: { count: number }) {
  return (
    <>
      {Array.from({ length: count }).map((_, i) => (
        <tr key={i} className="border-b border-slate-100 last:border-0 animate-pulse">
          <td className="td py-3"><div className="h-8 w-8 rounded-md bg-slate-100" /></td>
          <td className="td"><div className="h-3 w-32 rounded bg-slate-100" /></td>
          <td className="td"><div className="h-3 w-16 rounded bg-slate-100" /></td>
          <td className="td"><div className="h-3 w-12 rounded bg-slate-100" /></td>
          <td className="td"><div className="h-3 w-16 rounded bg-slate-100" /></td>
          <td className="td"><div className="h-3 w-20 rounded bg-slate-100" /></td>
          <td className="td"><div className="h-3 w-12 rounded bg-slate-100" /></td>
        </tr>
      ))}
    </>
  );
}

export default function Records() {
  const [filters, setFilters] = useState<QueryParams>({ page: 1, page_size: PAGE_SIZE, sort: "created_at:desc" });
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const qc = useQueryClient();
  const user = getUser();
  const isAdmin = user?.role === "admin";

  const { data: meta } = useQuery({ queryKey: ["meta"], queryFn: api.meta });
  const { data: page, isLoading } = useQuery({
    queryKey: ["records", filters],
    queryFn: () => api.listRecords(filters),
  });

  const apply = (patch: Partial<QueryParams>) => {
    setFilters((f) => ({ ...f, ...patch, page: 1 }));
    setSelected(new Set());
  };

  // ── saved filters ────────────────
  const savedFilters: { label: string; params: QueryParams }[] = (() => {
    try {
      return JSON.parse(localStorage.getItem(SAVED_KEY) || "[]");
    } catch { return []; }
  })();

  const saveFilter = () => {
    const label = window.prompt("Name this filter:")?.trim();
    if (!label) return;
    const existing = savedFilters.filter((f) => f.label !== label);
    const updated = [...existing, { label, params: { ...filters, page: 1 } }];
    localStorage.setItem(SAVED_KEY, JSON.stringify(updated));
    qc.invalidateQueries({ queryKey: ["meta"] }); // trigger re-render
  };

  const loadFilter = (params: QueryParams) => {
    setFilters({ ...params, page: 1 });
    setSelected(new Set());
  };

  const deleteFilter = (label: string) => {
    const updated = savedFilters.filter((f) => f.label !== label);
    localStorage.setItem(SAVED_KEY, JSON.stringify(updated));
    qc.invalidateQueries({ queryKey: ["meta"] }); // trigger re-render
  };

  // ── bulk delete ──────────────────
  const bulkDelete = async () => {
    if (!isAdmin || selected.size === 0) return;
    if (!window.confirm(`Delete ${selected.size} selected record(s)?`)) return;
    setDeleting(true);
    let ok = 0;
    for (const id of selected) {
      try { await api.deleteRecord(id); ok++; } catch { /* skip */ }
    }
    setDeleting(false);
    setSelected(new Set());
    qc.invalidateQueries({ queryKey: ["records"] });
    qc.invalidateQueries({ queryKey: ["stats"] });
    window.alert(`Deleted ${ok} of ${selected.size} records.`);
  };

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (!page) return;
    if (selected.size === page.items.length) setSelected(new Set());
    else setSelected(new Set(page.items.map((r) => r.id)));
  };

  // ── copy as curl ────────────────
  const curlCmd = () => {
    const params = new URLSearchParams();
    if (filters.type) params.set("type", filters.type);
    if (filters.status) params.set("status", filters.status);
    if (filters.tag) params.set("tag", filters.tag);
    if (filters.page) params.set("page", String(filters.page));
    if (filters.page_size) params.set("page_size", String(filters.page_size));
    const url = `${window.location.origin}/api-meta/api/v1/records${params.toString() ? `?${params}` : ""}`;
    return `curl -H "X-Session-Token: <your-token>" "${url}"`;
  };

  const copyCurl = () => { void navigator.clipboard.writeText(curlCmd()); };

  return (
    <div className="p-6 max-w-7xl">
      <div className="flex items-center justify-between gap-3 mb-3">
        <div>
          <h1 className="display">Records</h1>
          <p className="mt-0.5 text-sm text-slate-600 dark:text-slate-400">Every extraction with its envelope</p>
        </div>
        <div className="flex gap-2">
          <button type="button" className="btn-ghost px-3 py-1.5 text-xs" onClick={copyCurl} title="Copy API query as curl">
            📋 curl
          </button>
          <button type="button" className="btn-ghost px-3 py-1.5 text-xs" onClick={saveFilter}>
            🔖 Save filter
          </button>
          <a className="btn-secondary" href={api.exportUrl("csv", filters)}>CSV</a>
          <a className="btn-secondary" href={api.exportUrl("json", filters)}>JSON</a>
        </div>
      </div>

      {/* saved filter pills */}
      {savedFilters.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <span className="text-xs text-slate-500">Saved:</span>
          {savedFilters.map((sf) => (
            <span key={sf.label} className="chip gap-1">
              <button type="button" className="text-slate-600 hover:text-slate-950" onClick={() => loadFilter(sf.params)}>{sf.label}</button>
              <button type="button" className="text-slate-400 hover:text-red-500" onClick={() => deleteFilter(sf.label)}>×</button>
            </span>
          ))}
        </div>
      )}

      {/* filter bar */}
      <div className="panel p-3 mb-3 flex flex-wrap gap-2">
        <input className="input w-52" placeholder="Search data…" value={search}
               onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") apply({ q: search }); }} />
        <select className="input w-36" value={filters.type ?? ""} onChange={(e) => apply({ type: e.target.value || undefined })}>
          <option value="">All types</option>
          {(meta?.types ?? []).map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <select className="input w-36" value={filters.status ?? ""} onChange={(e) => apply({ status: e.target.value || undefined })}>
          <option value="">All statuses</option>
          <option value="raw">raw</option><option value="edited">edited</option><option value="verified">verified</option>
        </select>
        <select className="input w-36" value={filters.tag ?? ""} onChange={(e) => apply({ tag: e.target.value || undefined })}>
          <option value="">All models</option>
          <option value="default">default</option><option value="vllm">vllm</option><option value="lens">lens</option>
        </select>
        <input type="date" className="input w-36" value={filters.business_from ?? ""} onChange={(e) => apply({ business_from: e.target.value || undefined })} />
        <span className="self-center text-sm text-slate-500">→</span>
        <input type="date" className="input w-36" value={filters.business_to ?? ""} onChange={(e) => apply({ business_to: e.target.value || undefined })} />
        <button type="button" className="btn-ghost" onClick={() => { setSearch(""); setFilters({ page: 1, page_size: PAGE_SIZE, sort: "created_at:desc" }); setSelected(new Set()); }}>Reset</button>
      </div>

      {/* bulk actions bar */}
      {isAdmin && selected.size > 0 && (
        <div className="flex items-center gap-3 mb-3 rounded-lg bg-slate-950 px-3 py-2 text-white text-sm">
          <span>{selected.size} selected</span>
          <button type="button" className="rounded-md bg-red-500/20 px-3 py-1 text-xs font-medium text-red-300 hover:bg-red-500/30" onClick={bulkDelete} disabled={deleting}>
            {deleting ? "Deleting…" : `Delete ${selected.size}`}
          </button>
          <button type="button" className="rounded-md bg-white/10 px-3 py-1 text-xs text-slate-300 hover:bg-white/20" onClick={() => setSelected(new Set())}>
            Clear selection
          </button>
        </div>
      )}

      {/* table */}
      <div className="panel overflow-x-auto">
        <table className="w-full">
          <thead className="border-b border-slate-200 bg-slate-50/60 dark:bg-white/5">
            <tr>
              {isAdmin && (
                <th className="th w-10">
                  <input type="checkbox" onChange={toggleAll} checked={page ? page.items.length > 0 && selected.size === page.items.length : false} className="rounded border-slate-300" />
                </th>
              )}
              <th className="th w-12"></th>
              <th className="th w-48">Document</th>
              <th className="th">Type</th>
              <th className="th">Model</th>
              <th className="th">Status</th>
              <th className="th">Date</th>
              <th className="th">Edited</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && <SkeletonRows count={8} />}
            {!isLoading && page?.items.length === 0 && (
              <tr><td className="td text-slate-500" colSpan={isAdmin ? 8 : 7}>No records match the filters.</td></tr>
            )}
            {!isLoading && page?.items.map((r) => {
              const docName = (r.data?.document_name as string) || (r.source?.filename as string) || "—";
              const thumb = (r.source?.thumbnail_base64 as string) || null;
              return (
              <tr key={r.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50/60 dark:border-white/5 dark:hover:bg-white/5">
                {isAdmin && (
                  <td className="td py-1.5" onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" checked={selected.has(r.id)} onChange={() => toggleSelect(r.id)} className="rounded border-slate-300" />
                  </td>
                )}
                <td className="td py-1.5">
                  {thumb ? (
                    <img src={thumb} alt="" className="h-10 w-10 rounded-md border border-slate-200 dark:border-white/10 object-cover" />
                  ) : (
                    <span className="grid h-10 w-10 place-items-center rounded-md border border-dashed border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-white/5 text-slate-300">
                      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.5">
                        <rect x="3" y="3" width="18" height="14" rx="2" /><path d="M3 13l5-5 3 3 4-4 6 6" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </span>
                  )}
                </td>
                <td className="td max-w-52 truncate font-medium text-slate-900 dark:text-slate-100" title={docName}>
                  <Link to={`/records/${r.id}`} className="text-accent hover:underline dark:drop-shadow-[0_0_6px_rgba(0,229,255,0.5)]">{docName}</Link>
                </td>
                <td className="td text-slate-600 dark:text-slate-300">{r.type}</td>
                <td className="td text-slate-500">{r.source_model ?? "—"}</td>
                <td className="td"><StatusBadge status={r.status} /></td>
                <td className="td text-slate-500">{r.business_date ?? r.created_at?.slice(0, 10) ?? "—"}</td>
                <td className="td text-slate-500">{r.edit_count > 0 ? `×${r.edit_count} ${r.edited_at?.slice(0, 10) ?? ""}` : "—"}</td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {page && page.total_pages > 1 && (
        <div className="flex items-center justify-between mt-3 text-sm text-slate-500">
          <span>{page.total} records · page {page.page}/{page.total_pages}</span>
          <div className="flex gap-2">
            <button type="button" className="btn-secondary px-3 py-1.5 text-xs" disabled={page.page <= 1} onClick={() => setFilters((f) => ({ ...f, page: f.page! - 1 }))}>Prev</button>
            <button type="button" className="btn-secondary px-3 py-1.5 text-xs" disabled={page.page >= page.total_pages} onClick={() => setFilters((f) => ({ ...f, page: f.page! + 1 }))}>Next</button>
          </div>
        </div>
      )}
    </div>
  );
}
