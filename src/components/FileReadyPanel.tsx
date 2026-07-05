import { useEffect, useMemo, useState } from 'react';
import { RomdoulLogo } from '@/components/RomdoulLogo';
import { fmtBytes, isImage, isPdf } from '@/lib/utils';
import { pageRangeToString, parsePageRangeFromString } from '@/hooks/usePdfPageThumbnails';

export interface ReadyFile {
  id: string;
  source: File;
  totalPages: number;
}

export interface FileReadyPanelProps {
  files: ReadyFile[];
  pageSelections: Record<string, number[]>;
  pageThumbnails: Record<string, string[]>;
  thumbLoading: Set<string>;
  onPageSelectionChange: (fileKey: string, pages: number[]) => void;
  isRunning: boolean;
  preparingMsg: string | null;
  onRun: () => void;
  onCancel: () => void;
  actionLabel: (selectedCount: number, totalCount: number) => string;
  runningLabel: string;
  emptyTitle: string;
  emptyDescription: string;
  readyDescription: string;
}

export function FileReadyPanel({
  files,
  pageSelections,
  pageThumbnails,
  thumbLoading,
  onPageSelectionChange,
  isRunning,
  preparingMsg,
  onRun,
  onCancel,
  actionLabel,
  runningLabel,
  emptyTitle,
  emptyDescription,
  readyDescription,
}: FileReadyPanelProps) {
  const pdfFiles = files.filter((file) => isPdf(file.source.name));
  const imageFiles = files.filter((file) => !isPdf(file.source.name));
  const totalCount = files.reduce((sum, file) => sum + (isPdf(file.source.name) ? file.totalPages : 1), 0);
  const selectedCount = files.reduce((sum, file) => {
    if (!isPdf(file.source.name)) return sum + 1;
    return sum + getSelectedPages(file, pageSelections, pageThumbnails).length;
  }, 0);

  const fileLine = useMemo(() => {
    if (files.length === 0) return '';
    if (files.length === 1) return files[0].source.name;
    return `${files.length} files selected`;
  }, [files]);

  const selectAll = () => {
    for (const file of pdfFiles) {
      onPageSelectionChange(file.id, allPages(pageTotal(file, pageThumbnails)));
    }
  };

  const clearAll = () => {
    for (const file of pdfFiles) {
      onPageSelectionChange(file.id, []);
    }
  };

  if (files.length === 0) {
    return (
      <section className="panel-raised rise-in flex min-h-[720px] flex-col p-6">
        <div className="hero-glow grid flex-1 place-items-center rounded-2xl text-center">
          <div className="max-w-md px-6">
            {/* Branded watermark — the Angkor mark establishes identity before
                any file is uploaded, instead of a generic gray doc icon. */}
            <div className="mx-auto mb-6 grid h-24 w-24 place-items-center rounded-3xl bg-accent/10 text-accent ring-1 ring-accent/30 backdrop-blur">
              <RomdoulLogo className="h-14 w-14 drop-shadow-[0_0_20px_rgba(0,229,255,0.5)]" />
            </div>
            <h2 className="display">{emptyTitle}</h2>
            <p className="mx-auto mt-2 max-w-sm text-sm text-slate-500">{emptyDescription}</p>
            <div className="temple-ridge mx-auto mt-6 w-40" />
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="panel-raised rise-in flex min-h-[720px] flex-col p-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-slate-950">File Ready for Processing</h2>
          <p className="truncate text-sm text-slate-500">{fileLine}</p>
        </div>
        {pdfFiles.length > 0 && (
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={selectAll}
              disabled={isRunning}
              className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-950 shadow-sm hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Select all
            </button>
            <button
              type="button"
              onClick={clearAll}
              disabled={isRunning}
              className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-950 shadow-sm hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Clear
            </button>
          </div>
        )}
      </header>

      <div className="grid flex-1 content-start gap-5 pt-8">
        <div className="text-center">
          <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-2xl bg-accent/10 text-accent ring-1 ring-accent/30">
            <DocumentIcon className="h-7 w-7" />
          </div>
          <p className="text-sm text-slate-700">{readyDescription}</p>
          <p className="mt-4 text-sm font-semibold text-slate-950">
            {pdfFiles.length > 0
              ? `Pages selected: ${selectedCount} of ${totalCount}`
              : `${imageFiles.length} image${imageFiles.length === 1 ? '' : 's'} selected`}
          </p>
          {pdfFiles.length > 0 && (
            <p className="text-xs text-slate-500">Each checked page is processed separately.</p>
          )}
        </div>

        <div className="space-y-5">
          {pdfFiles.map((file) => (
            <PdfFileGrid
              key={file.id}
              file={file}
              selectedPages={getSelectedPages(file, pageSelections, pageThumbnails)}
              thumbnails={pageThumbnails[file.id] ?? []}
              loading={thumbLoading.has(file.id)}
              disabled={isRunning}
              onPageSelectionChange={onPageSelectionChange}
            />
          ))}

          {imageFiles.length > 0 && (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {imageFiles.map((file, index) => (
                <ReadyImageCard key={file.id} file={file.source} index={index} />
              ))}
            </div>
          )}
        </div>
      </div>

      <footer className="mt-6 flex justify-center border-t border-slate-200 pt-5">
        <button
          type="button"
          onClick={isRunning ? onCancel : onRun}
          disabled={!isRunning && selectedCount === 0}
          className={`min-h-11 w-full max-w-sm px-5 py-3 ${
            isRunning
              ? 'btn border border-rose-200 bg-white text-rose-700 hover:bg-rose-50'
              : 'btn-primary'
          }`}
        >
          {isRunning ? 'Cancel' : preparingMsg ? runningLabel : actionLabel(selectedCount, totalCount)}
        </button>
      </footer>
    </section>
  );
}

function PdfFileGrid({
  file,
  selectedPages,
  thumbnails,
  loading,
  disabled,
  onPageSelectionChange,
}: {
  file: ReadyFile;
  selectedPages: number[];
  thumbnails: string[];
  loading: boolean;
  disabled: boolean;
  onPageSelectionChange: (fileKey: string, pages: number[]) => void;
}) {
  const total = pageTotal(file, { [file.id]: thumbnails });
  const loaded = thumbnails.filter(Boolean).length;

  // Bidirectional page-range text input. The user can type "1-3, 5, 10-11"
  // to select pages, or click checkboxes to update the text. We keep a local
  // string so typing feels live (no round-trip through state on each keystroke)
  // and reconcile from the checkbox-derived selection when it changes
  // externally (e.g. Select all / Clear, or another component).
  const [rangeText, setRangeText] = useState(() => pageRangeToString(selectedPages));
  // Suppress the external→text sync while the user is actively editing, so we
  // don't clobber "1-3, 5" with "1, 2, 3, 5" mid-typing.
  const [editing, setEditing] = useState(false);

  // External selection → text (when not editing).
  useEffect(() => {
    if (editing) return;
    setRangeText(pageRangeToString(selectedPages));
  }, [selectedPages, editing]);

  const onRangeChange = (text: string) => {
    setRangeText(text);
    const pages = parsePageRangeFromString(text, total);
    onPageSelectionChange(file.id, pages);
  };

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[200px] flex-1">
          <input
            type="text"
            value={rangeText}
            onChange={(e) => onRangeChange(e.target.value)}
            onFocus={() => setEditing(true)}
            onBlur={() => {
              setEditing(false);
              setRangeText(pageRangeToString(selectedPages));
            }}
            placeholder={`e.g. 1-3, 5, ${Math.max(1, total)}`}
            spellCheck={false}
            disabled={disabled || total === 0}
            className="input py-1.5 text-xs"
            aria-label="Page range"
          />
        </div>
        <span className="shrink-0 text-xs font-medium text-slate-500">
          {selectedPages.length} of {total} pages
        </span>
      </div>
      {loading && loaded < total && (
        <div className="mb-3 flex items-center gap-2 text-xs text-slate-500">
          <SpinnerIcon className="h-3.5 w-3.5 animate-spin" />
          {loaded > 0 ? `Loading page previews: ${loaded}/${total}` : 'Loading page previews...'}
        </div>
      )}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {allPages(total).map((pageNum) => {
          const selected = selectedPages.includes(pageNum);
          const thumb = thumbnails[pageNum - 1];
          return (
            <label
              key={pageNum}
              className={`group cursor-pointer overflow-hidden rounded-lg border transition-colors ${
                selected
                  ? 'border-slate-950 bg-white'
                  : 'border-slate-200 bg-white opacity-70 hover:border-slate-400 hover:opacity-100'
              }`}
            >
              <input
                type="checkbox"
                checked={selected}
                disabled={disabled}
                onChange={() => {
                  const next = selected
                    ? selectedPages.filter((page) => page !== pageNum)
                    : [...selectedPages, pageNum];
                  onPageSelectionChange(file.id, next);
                }}
                className="sr-only"
              />
              <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-4 py-3">
                <span className="text-sm font-semibold text-slate-950">Page {pageNum}</span>
                <span
                  className={`grid h-4 w-4 place-items-center rounded border ${
                    selected ? 'border-slate-950 bg-white text-slate-950' : 'border-slate-300 bg-white text-transparent'
                  }`}
                  aria-hidden="true"
                >
                  <CheckIcon className="h-3 w-3" />
                </span>
              </div>
              <div className="grid aspect-[4/3] place-items-center bg-white">
                {thumb ? (
                  <img
                    src={thumb}
                    alt={`Page ${pageNum} preview`}
                    className="h-full w-full object-contain"
                    loading="lazy"
                  />
                ) : (
                  <div className="h-full w-full animate-pulse bg-slate-100" />
                )}
              </div>
            </label>
          );
        })}
      </div>
    </div>
  );
}

function ReadyImageCard({ file, index }: { file: File; index: number }) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!isImage(file.name)) return;
    const nextUrl = URL.createObjectURL(file);
    setUrl(nextUrl);
    return () => URL.revokeObjectURL(nextUrl);
  }, [file]);

  return (
    <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
      <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-4 py-3">
        <span className="text-sm font-semibold text-slate-950">Image {index + 1}</span>
        <span className="text-xs text-slate-500">{fmtBytes(file.size)}</span>
      </div>
      <div className="grid aspect-[4/3] place-items-center bg-white">
        {url ? (
          <img src={url} alt={file.name} className="h-full w-full object-contain" />
        ) : (
          <div className="text-xs text-slate-500">{file.name}</div>
        )}
      </div>
    </div>
  );
}

function getSelectedPages(
  file: ReadyFile,
  pageSelections: Record<string, number[]>,
  pageThumbnails: Record<string, string[]>,
): number[] {
  const total = pageTotal(file, pageThumbnails);
  return pageSelections[file.id] ?? allPages(total);
}

function pageTotal(file: ReadyFile, pageThumbnails: Record<string, string[]>): number {
  return Math.max(file.totalPages, pageThumbnails[file.id]?.length ?? 0);
}

function allPages(total: number): number[] {
  return Array.from({ length: Math.max(0, total) }, (_, i) => i + 1);
}

function DocumentIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M6 3h8l4 4v14H6z" />
      <path d="M14 3v5h4" />
      <path d="M9 13h6M9 17h6" strokeLinecap="round" />
    </svg>
  );
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="3">
      <path d="m5 12 4 4L19 6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SpinnerIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 3a9 9 0 1 1-9 9" strokeLinecap="round" />
    </svg>
  );
}
