import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api, type QueryParams } from "../api/client";
import StatusBadge from "../components/StatusBadge";

const PAGE_SIZE = 25;

export default function Records() {
  const [filters, setFilters] = useState<QueryParams>({ page: 1, page_size: PAGE_SIZE, sort: "created_at:desc" });
  const [search, setSearch] = useState("");

  const { data: meta } = useQuery({ queryKey: ["meta"], queryFn: api.meta });
  const { data: page, isLoading, isFetching } = useQuery({
    queryKey: ["records", filters],
    queryFn: () => api.listRecords(filters),
  });

  const apply = (patch: Partial<QueryParams>) => setFilters((f) => ({ ...f, ...patch, page: 1 }));

  return (
    <div className="p-6 max-w-7xl">
      <div className="flex items-center justify-between gap-3 mb-4">
        <div>
          <h1 className="display">Records</h1>
          <p className="mt-0.5 text-sm text-slate-600 dark:text-slate-400">Every extraction with its envelope</p>
        </div>
        <div className="flex gap-2">
          <a className="btn-secondary" href={api.exportUrl("csv", filters)}>CSV</a>
          <a className="btn-secondary" href={api.exportUrl("json", filters)}>JSON</a>
        </div>
      </div>

      <div className="panel p-3 mb-4 flex flex-wrap gap-2">
        <input
          className="input w-64"
          placeholder="Search data…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") apply({ q: search });
          }}
        />
        <select className="input w-40" value={filters.type ?? ""} onChange={(e) => apply({ type: e.target.value || undefined })}>
          <option value="">All types</option>
          {(meta?.types ?? []).map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
        <select className="input w-40" value={filters.domain ?? ""} onChange={(e) => apply({ domain: e.target.value || undefined })}>
          <option value="">All domains</option>
          {(meta?.domains ?? []).map((d) => (
            <option key={d} value={d}>{d}</option>
          ))}
        </select>
        <select className="input w-40" value={filters.status ?? ""} onChange={(e) => apply({ status: e.target.value || undefined })}>
          <option value="">All statuses</option>
          <option value="raw">raw</option>
          <option value="edited">edited</option>
          <option value="verified">verified</option>
        </select>
        <input type="date" className="input w-40" value={filters.business_from ?? ""}
               onChange={(e) => apply({ business_from: e.target.value || undefined })} />
        <span className="self-center text-sm text-slate-500">→</span>
        <input type="date" className="input w-40" value={filters.business_to ?? ""}
               onChange={(e) => apply({ business_to: e.target.value || undefined })} />
        <button
          className="btn-ghost"
          onClick={() => {
            setSearch("");
            setFilters({ page: 1, page_size: PAGE_SIZE, sort: "created_at:desc" });
          }}
        >
          Reset
        </button>
        {isFetching && <span className="self-center text-xs text-slate-500">…</span>}
      </div>

      <div className="panel overflow-x-auto">
        <table className="w-full">
          <thead className="border-b border-slate-200 bg-slate-50/60 dark:bg-white/5">
            <tr>
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
            {isLoading && (
              <tr><td className="td text-slate-500" colSpan={7}>Loading…</td></tr>
            )}
            {page?.items.length === 0 && (
              <tr><td className="td text-slate-500" colSpan={7}>No records match the filters.</td></tr>
            )}
            {page?.items.map((r) => {
              const docName = (r.data?.document_name as string) || (r.source?.filename as string) || '—';
              const thumb = (r.source?.thumbnail_base64 as string) || null;
              return (
              <tr key={r.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50/60 dark:border-white/5 dark:hover:bg-white/5">
                <td className="td py-1.5">
                  {thumb ? (
                    <img src={thumb} alt="" className="h-10 w-10 rounded-md border border-slate-200 dark:border-white/10 object-cover" />
                  ) : (
                    <span className="grid h-10 w-10 place-items-center rounded-md border border-dashed border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-white/5 text-slate-300">
                      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.5">
                        <rect x="3" y="3" width="18" height="14" rx="2" />
                        <path d="M3 13l5-5 3 3 4-4 6 6" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </span>
                  )}
                </td>
                <td className="td max-w-52 truncate font-medium text-slate-900 dark:text-slate-100" title={docName}>
                  <Link to={`/records/${r.id}`} className="text-accent hover:underline dark:drop-shadow-[0_0_6px_rgba(0,229,255,0.5)]">
                    {docName}
                  </Link>
                </td>
                <td className="td text-slate-600 dark:text-slate-300">{r.type}</td>
                <td className="td text-slate-500">{r.source_model ?? '—'}</td>
                <td className="td"><StatusBadge status={r.status} /></td>
                <td className="td text-slate-500">{r.business_date ?? r.created_at?.slice(0, 10) ?? '—'}</td>
                <td className="td text-slate-500">
                  {r.edit_count > 0 ? `×${r.edit_count} ${r.edited_at?.slice(0, 10) ?? ''}` : '—'}
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {page && page.total_pages > 1 && (
        <div className="flex items-center justify-between mt-4 text-sm text-slate-500">
          <span>
            {page.total} records · page {page.page}/{page.total_pages}
          </span>
          <div className="flex gap-2">
            <button className="btn-secondary" disabled={page.page <= 1} onClick={() => setFilters((f) => ({ ...f, page: f.page! - 1 }))}>
              Prev
            </button>
            <button className="btn-secondary" disabled={page.page >= page.total_pages} onClick={() => setFilters((f) => ({ ...f, page: f.page! + 1 }))}>
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
