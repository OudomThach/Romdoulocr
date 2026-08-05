import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { metaClient, type MetaQuery, type MetaRecord } from '@/lib/metaClient';
import { useMetaAuth } from '@/lib/useMetaAuth';
import { LoginModal } from '@/components/LoginModal';
import { DataFormEditor } from '@/components/DataFormEditor';
import { useMetadataStore } from '@/lib/metadataStore';
import { useToastStore } from '@/hooks/useToastStore';

const PAGE_SIZE = 25;

const STATUS_TONE: Record<string, string> = {
  raw: 'border-slate-200 bg-white text-slate-500',
  edited: 'border-accent2/40 bg-accent2/10 text-accent2',
  verified: 'border-accent/40 bg-accent/10 text-accent',
};

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`badge ${STATUS_TONE[status] ?? STATUS_TONE.raw}`}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {status}
    </span>
  );
}

function KV({ obj }: { obj: Record<string, unknown> | null | undefined }) {
  if (!obj || Object.keys(obj).length === 0) return <div className="text-xs text-slate-500">—</div>;
  return (
    <dl className="grid grid-cols-[150px_1fr] gap-x-3 gap-y-1.5">
      {Object.entries(obj).map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-xs text-slate-500 break-all">{k}</dt>
          <dd className="text-sm text-slate-700 break-all">{typeof v === 'object' ? JSON.stringify(v) : String(v)}</dd>
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
        active ? 'bg-slate-100 text-slate-950' : 'text-slate-500 hover:text-slate-800'
      }`}
    >
      {children}
    </button>
  );
}

function HistoryTimeline({ recordId }: { recordId: string }) {
  const { data: events, isLoading, isError } = useQuery({
    queryKey: ['meta-history', recordId],
    queryFn: () => metaClient.recordHistory(recordId),
  });
  const [expanded, setExpanded] = useState<number | null>(null);

  if (isLoading) return <div className="text-sm text-slate-500">Loading history…</div>;
  if (isError || !events) return <div className="text-sm text-red-500">Could not load history.</div>;
  if (events.length === 0) return <div className="text-sm text-slate-500">No history yet.</div>;

  return (
    <ol className="relative space-y-4 border-l border-slate-200 pl-4">
      {events.map((ev) => (
        <li key={ev.id} className="relative">
          <span className="absolute -left-[21px] top-1.5 h-2.5 w-2.5 rounded-full border-2 border-white bg-accent shadow" />
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span
              className={`badge ${
                ev.action === 'create'
                  ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600'
                  : ev.action === 'delete'
                    ? 'border-red-500/30 bg-red-500/10 text-red-500'
                    : 'border-accent2/30 bg-accent2/10 text-accent2'
              }`}
            >
              {ev.action}
            </span>
            <span className="font-mono text-xs text-slate-600">{ev.actor}</span>
            <span className="text-xs text-slate-400">{new Date(ev.at).toLocaleString()}</span>
            <button
              type="button"
              className="ml-auto text-xs text-slate-400 hover:text-slate-700"
              onClick={() => setExpanded(expanded === ev.id ? null : ev.id)}
            >
              {expanded === ev.id ? 'hide snapshot' : 'view snapshot'}
            </button>
          </div>
          {expanded === ev.id && (
            <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-slate-50 p-3 font-mono text-[11px]">
              {JSON.stringify(ev.snapshot, null, 2)}
            </pre>
          )}
        </li>
      ))}
    </ol>
  );
}

function RecordDetail({
  rec,
  onBack,
  onDelete,
  canDelete,
  canEdit,
  onSaved,
}: {
  rec: MetaRecord;
  onBack: () => void;
  onDelete: () => void;
  canDelete: boolean;
  canEdit: boolean;
  onSaved: () => void;
}) {
  const [tab, setTab] = useState<'data' | 'details' | 'history'>('data');
  const qc = useQueryClient();
  const toast = useToastStore((s) => s.push);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [localDomain, setLocalDomain] = useState((rec.business?.domain as string) ?? '');
  const [localTags, setLocalTags] = useState(((rec.business?.tags as string[]) ?? []).join(', '));
  const [localDate, setLocalDate] = useState((rec.business?.date as string) ?? '');

  const save = async (data: Record<string, unknown>) => {
    setSaving(true);
    setSaveError(null);
    const biz = {
      domain: localDomain.trim() || null,
      tags: localTags.split(',').map((t) => t.trim()).filter(Boolean),
      date: localDate || null,
    };
    try {
      await metaClient.patchRecord(rec.id, { data, business: biz });
      toast('Record updated — status: edited', 'success');
      qc.invalidateQueries({ queryKey: ['meta-records'] });
      qc.invalidateQueries({ queryKey: ['record', rec.id] });
      qc.invalidateQueries({ queryKey: ['meta-history', rec.id] });
      onSaved();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className="btn-ghost px-3 py-1.5 text-sm" onClick={onBack}>
          ← Records
        </button>
        <span className="text-base font-semibold tracking-tight text-slate-950">{rec.type}</span>
        <StatusBadge status={rec.status} />
        <code className="truncate font-mono text-[11px] text-slate-500">{rec.id}</code>
        {canDelete && (
          <button type="button" className="btn-ghost ml-auto px-3 py-1.5 text-sm text-red-500" onClick={onDelete}>
            Delete
          </button>
        )}
      </div>

      <div className="flex items-center gap-1 rounded-lg border border-slate-200 bg-white p-0.5 shadow-sm w-fit">
        <TabButton active={tab === 'data'} onClick={() => setTab('data')}>
          Edit data
        </TabButton>
        <TabButton active={tab === 'details'} onClick={() => setTab('details')}>
          Details
        </TabButton>
        <TabButton active={tab === 'history'} onClick={() => setTab('history')}>
          History
        </TabButton>
      </div>

      {tab === 'details' && (
        <div className="grid gap-3 md:grid-cols-2">
          <div className="panel p-4">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Source</div>
            <KV obj={rec.source} />
            <div className="mt-2 text-xs text-slate-500">model: {rec.source_model ?? '—'} · system: {rec.source_system ?? '—'}</div>
          </div>
          <div className="panel p-4">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Audit</div>
            <KV obj={rec.audit} />
            <div className="mt-2 text-xs text-slate-500">
              created_by: {rec.created_by} · edited_by: {rec.edited_by ?? '—'} · edits: {rec.edit_count}
            </div>
          </div>
          <div className="panel p-4">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Pipeline</div>
            <KV obj={rec.pipeline} />
          </div>
          <div className="panel p-4">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Business</div>
            <KV obj={rec.business} />
          </div>
        </div>
      )}

      {tab === 'data' && (
        <div className="space-y-4">
          <div className="panel p-4">
            <div className="mb-3 flex flex-wrap gap-3">
              <div>
                <label className="mb-0.5 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">Domain</label>
                <input className="input w-44" value={localDomain} onChange={(e) => setLocalDomain(e.target.value)} placeholder="e.g. logistics" />
              </div>
              <div>
                <label className="mb-0.5 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">Tags</label>
                <input className="input w-48" value={localTags} onChange={(e) => setLocalTags(e.target.value)} placeholder="import, warehouse" />
              </div>
              <div>
                <label className="mb-0.5 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">Date</label>
                <input className="input w-36" type="date" value={localDate} onChange={(e) => setLocalDate(e.target.value)} />
              </div>
            </div>
            <div className="flex flex-wrap gap-1 mb-3">
              {localTags.split(',').map((t) => t.trim()).filter(Boolean).map((tag) => (
                <span key={tag} className="chip">{tag}</span>
              ))}
            </div>
          </div>
          <div className="panel p-4">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Data fields</div>
            {canEdit ? (
              <DataFormEditor key={rec.edit_count} data={rec.data} onChange={(d) => void save(d)} />
            ) : (
              <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-slate-50 p-3 font-mono text-xs">
                {JSON.stringify(rec.data, null, 2)}
              </pre>
            )}
          </div>
          {saving && <p className="text-xs text-slate-500">Saving…</p>}
          {saveError && <p className="text-xs text-red-500">{saveError}</p>}
        </div>
      )}

      {tab === 'history' && (
        <div className="panel p-4">
          <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-500">Edit history</div>
          <HistoryTimeline recordId={rec.id} />
        </div>
      )}
    </div>
  );
}

export function MetadataTab() {
  const { signedIn, user } = useMetaAuth();
  const qc = useQueryClient();
  const toast = useToastStore((s) => s.push);
  const pendingRecordId = useMetadataStore((s) => s.pendingRecordId);
  const consumePendingRecord = useMetadataStore((s) => s.consumePendingRecord);
  const [filters, setFilters] = useState<MetaQuery>({ page: 1, page_size: PAGE_SIZE, sort: 'created_at:desc' });
  const [search, setSearch] = useState('');
  const [loginOpen, setLoginOpen] = useState(false);
  const [selected, setSelected] = useState<MetaRecord | null>(null);

  // Auto-open a record when another tab's "Edit & history" button fired.
  // Subscribes to pendingRecordId so it also fires when ALREADY mounted.
  useEffect(() => {
    if (!signedIn || !pendingRecordId) return;
    const id = consumePendingRecord();
    if (!id) return;
    metaClient
      .getRecord(id)
      .then((rec) => setSelected(rec))
      .catch(() => toast('Could not open record', 'error'));
  }, [signedIn, pendingRecordId, consumePendingRecord, toast]);

  const { data: meta, isError: metaError } = useQuery({
    queryKey: ['meta-meta'],
    queryFn: metaClient.meta,
    enabled: signedIn,
  });
  const { data: page, isLoading, isFetching, isError, error } = useQuery({
    queryKey: ['meta-records', filters],
    queryFn: () => metaClient.listRecords(filters),
    enabled: signedIn,
  });

  const apply = (patch: Partial<MetaQuery>) => setFilters((f) => ({ ...f, ...patch, page: 1 }));

  const remove = async (rec: MetaRecord) => {
    if (!window.confirm(`Delete record ${rec.id}?`)) return;
    try {
      await metaClient.deleteRecord(rec.id);
      toast('Record deleted', 'success');
      qc.invalidateQueries({ queryKey: ['meta-records'] });
      setSelected(null);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Delete failed', 'error');
    }
  };

  if (!signedIn) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center p-8">
        <div className="panel-raised w-full max-w-sm p-8 text-center">
          <div className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-2xl bg-accent/10 text-accent">
            <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <ellipse cx="12" cy="5" rx="9" ry="3" />
              <path d="M3 5v14a9 3 0 0 0 18 0V5" />
              <path d="M3 12a9 3 0 0 0 18 0" />
            </svg>
          </div>
          <h2 className="text-lg font-semibold tracking-tight text-slate-950">Extraction records</h2>
          <p className="mt-1 text-sm text-slate-600">Sign in to browse, edit and export every saved extraction.</p>
          <button type="button" className="btn-primary mt-5 w-full" onClick={() => setLoginOpen(true)}>
            Sign in
          </button>
        </div>
        {loginOpen && <LoginModal onClose={() => setLoginOpen(false)} />}
      </div>
    );
  }

  if (selected) {
    return (
      <div className="p-4 sm:p-6">
        <RecordDetail
          rec={selected}
          onBack={() => setSelected(null)}
          onDelete={() => void remove(selected)}
          canDelete={user?.role === 'admin'}
          canEdit={user?.role === 'admin' || user?.role === 'editor'}
          onSaved={() => {
            // Refresh the selected record so the form + audit reflect the save.
            void metaClient.getRecord(selected.id).then(setSelected).catch(() => {});
          }}
        />
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-slate-950">Your extraction records</h1>
          <p className="text-xs text-slate-500">
            Every document you parse is saved here — click a row to view or edit it.
          </p>
        </div>
        <div className="flex gap-2">
          <a className="btn-secondary px-3 py-1.5 text-xs" href={metaClient.exportUrl('csv', filters)}>
            CSV
          </a>
          <a className="btn-secondary px-3 py-1.5 text-xs" href={metaClient.exportUrl('json', filters)}>
            JSON
          </a>
        </div>
      </div>

      <div className="panel mt-4 flex flex-wrap gap-2 p-3">
        <input
          className="input w-52"
          placeholder="Search data…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') apply({ q: search });
          }}
        />
        <select className="input w-36" value={filters.type ?? ''} onChange={(e) => apply({ type: e.target.value || undefined })}>
          <option value="">All types</option>
          {(meta?.types ?? []).map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
        <select className="input w-36" value={filters.status ?? ''} onChange={(e) => apply({ status: e.target.value || undefined })}>
          <option value="">All statuses</option>
          <option value="raw">raw</option>
          <option value="edited">edited</option>
          <option value="verified">verified</option>
        </select>
        <select className="input w-36" value={filters.tag ?? ''} onChange={(e) => apply({ tag: e.target.value || undefined })}>
          <option value="">All models</option>
          <option value="default">default</option>
          <option value="vllm">vllm</option>
          <option value="lens">lens</option>
        </select>
        <button
          type="button"
          className="btn-ghost px-3 py-1.5 text-xs"
          onClick={() => {
            setSearch('');
            setFilters({ page: 1, page_size: PAGE_SIZE, sort: 'created_at:desc' });
          }}
        >
          Reset
        </button>
        {isFetching && <span className="self-center text-xs text-slate-500">…</span>}
      </div>

      <div className="panel mt-3 overflow-x-auto">
        {(isError || metaError) && (
          <div className="m-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
            <span className="font-semibold">Could not load records.</span>{' '}
            {error instanceof Error ? error.message : 'Check the connection and try again.'}{' '}
            <button type="button" className="underline" onClick={() => qc.invalidateQueries({ queryKey: ['meta-records'] })}>
              Retry
            </button>
          </div>
        )}
        <table className="w-full">
          <thead className="border-b border-slate-200 bg-slate-50/60">
            <tr>
              <th className="th">Type</th>
              <th className="th">Status</th>
              <th className="th">Model</th>
              <th className="th">Date</th>
              <th className="th">Created</th>
              <th className="th">Edited</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr>
                <td className="td text-slate-500" colSpan={6}>Loading…</td>
              </tr>
            )}
            {page?.items.length === 0 && (
              <tr>
                <td className="td text-slate-500" colSpan={6}>
                  No records yet — parse a document and it will be saved here automatically.
                </td>
              </tr>
            )}
            {page?.items.map((r) => (
              <tr
                key={r.id}
                className="cursor-pointer border-b border-slate-100 last:border-0 hover:bg-slate-50/60"
                onClick={() => setSelected(r)}
              >
                <td className="td font-medium text-accent">{r.type}</td>
                <td className="td"><StatusBadge status={r.status} /></td>
                <td className="td text-slate-600">{r.source_model ?? '—'}</td>
                <td className="td text-slate-500">{r.business_date ?? '—'}</td>
                <td className="td text-slate-500">{r.created_at?.slice(0, 10)}</td>
                <td className="td text-slate-500">
                  {r.edit_count > 0 ? `×${r.edit_count} ${r.edited_at?.slice(0, 10) ?? ''}` : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {page && page.total_pages > 1 && (
        <div className="mt-3 flex items-center justify-between text-sm text-slate-500">
          <span>
            {page.total} records · page {page.page}/{page.total_pages}
          </span>
          <div className="flex gap-2">
            <button type="button" className="btn-secondary px-3 py-1.5 text-xs" disabled={page.page <= 1} onClick={() => setFilters((f) => ({ ...f, page: f.page! - 1 }))}>
              Prev
            </button>
            <button type="button" className="btn-secondary px-3 py-1.5 text-xs" disabled={page.page >= page.total_pages} onClick={() => setFilters((f) => ({ ...f, page: f.page! + 1 }))}>
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
