import { useEffect, useMemo, useState } from 'react';
import { ConcurrencyControl, useKeyboardShortcuts } from '@/components/controls';
import { ErrorBanner } from '@/components/ErrorBanner';
import { FileDropzone } from '@/components/FileDropzone';
import { FileReadyPanel } from '@/components/FileReadyPanel';
import { MarkdownView } from '@/components/MarkdownView';
import { ProgressBar } from '@/components/ProgressBar';
import { TableGrid } from '@/components/TableGrid';
import { ZoomableImage } from '@/components/PagePreview';
import { ResultStepper } from '@/components/ResultStepper';
import { useBatchProcessor } from '@/hooks/useBatchProcessor';
import { useHistoryAutoSave } from '@/hooks/useHistoryAutoSave';
import { usePdfPageSelection } from '@/hooks/usePdfPageSelection';
import { api } from '@/lib/api';
import { tableToCsv } from '@/lib/exporters';
import { parsePipeTable, tableToCsvString } from '@/lib/tableExport';
import { exportSingleTableToXlsx } from '@/lib/documentExport';
import { copyToClipboard, downloadBytes, downloadJson, downloadText, isPdf } from '@/lib/utils';
import { getPdfPageCount, renderPdfPages } from '@/lib/pdfProcessing';
import { processImage } from '@/lib/imageProcessing';
import { useSettingsStore } from '@/hooks/useSettingsStore';
import { preprocessOpts, rasterFor } from '@/lib/extractionConfig';
import { ExtractionSettingsCard } from '@/components/ExtractionSettingsCard';
import type { TableResult } from '@/types/api';

interface PreparedFile {
  id: string;
  source: File;
  pages: File[];
  totalPages: number;
}

type ResultView = 'preview' | 'markdown' | 'csv';
type MarkdownMode = 'preview' | 'source';

export function TableParserTab() {
  const [files, setFiles] = useState<File[]>([]);
  const useCtc = true;
  const extraction = useSettingsStore((s) => s.extraction);
  const setExtraction = useSettingsStore((s) => s.setExtraction);
  const [rowTolerance, setRowTolerance] = useState(20);
  const [concurrency, setConcurrency] = useState(2);
  const [progress, setProgress] = useState<number | null>(null);
  const [prepared, setPrepared] = useState<PreparedFile[]>([]);
  const [prepError, setPrepError] = useState<string | null>(null);
  const [preparingMsg, setPreparingMsg] = useState<string | null>(null);
  const [resultView, setResultView] = useState<ResultView>('preview');
  const [markdownMode, setMarkdownMode] = useState<MarkdownMode>('preview');

  const { pageSelections, pageThumbnails, thumbLoading, onPageSelectionChange } =
    usePdfPageSelection(files, fileKey);

  useEffect(() => {
    let cancelled = false;
    setPrepError(null);

    if (files.length === 0) {
      setPrepared([]);
      setPreparingMsg(null);
      return;
    }

    (async () => {
      const out: PreparedFile[] = [];
      for (const f of files) {
        if (cancelled) return;
        const key = fileKey(f);
        if (isPdf(f.name)) {
          try {
            const totalPages = await getPdfPageCount(f);
            if (cancelled) return;
            out.push({ id: key, source: f, pages: [], totalPages });
          } catch (e) {
            if (cancelled) return;
            setPrepError(`${f.name}: ${e instanceof Error ? e.message : 'PDF read failed'}`);
            out.push({ id: key, source: f, pages: [f], totalPages: 1 });
          }
        } else {
          out.push({ id: key, source: f, pages: [f], totalPages: 1 });
        }
      }
      if (!cancelled) {
        setPrepared(out);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [files]);

  const batch = useBatchProcessor<
    { fileKey: string; file: File; useCtc: boolean; rowTolerance: number; pageLabel?: string },
    TableResult
  >({
    concurrency,
    run: (args, signal) => {
      const a = args as { file: File; rowTolerance: number };
      return api.parseTable(
        a.file,
        { rowTolerance: a.rowTolerance },
        { signal, onProgress: setProgress },
      );
    },
  });

  useHistoryAutoSave<PreparedFile>('table', batch, prepared, {
    useCtc,
    rowTolerance,
    concurrency,
  });

  const onSubmit = async () => {
    if (prepared.length === 0) return;
    setProgress(0);
    setPreparingMsg('Preparing files...');
    const doneKeys = new Set(
      batch.items
        .filter((it) => it.status === 'done')
        .map((it) => (it.args as { fileKey: string }).fileKey),
    );

    try {
      const items: { fileKey: string; file: File; useCtc: boolean; rowTolerance: number; pageLabel?: string }[] = [];
      for (const p of prepared) {
        if (isPdf(p.source.name)) {
          const key = fileKey(p.source);
          const selectedPages = pageSelections[key] ?? Array.from({ length: p.totalPages }, (_, i) => i + 1);
          const pages = selectedPages.length > 0 ? selectedPages : Array.from({ length: p.totalPages }, (_, i) => i + 1);
          if (pages.length === 0) {
            setPrepError(`No pages selected for ${p.source.name}`);
            setPreparingMsg(null);
            return;
          }
          setPreparingMsg(`Rasterizing ${p.source.name} (${pages.length} pages)...`);
          const rendered = await renderPdfPages(p.source, pages, rasterFor(extraction.highRes).dpi);
          for (let pi = 0; pi < rendered.length; pi++) {
            const key = rendered.length > 1 ? `${p.id}-p${pi + 1}` : p.id;
            if (doneKeys.has(key)) continue;
            items.push({
              fileKey: key,
              file: rendered[pi].file,
              useCtc,
              rowTolerance,
              pageLabel: rendered.length > 1 ? ` (page ${pi + 1}/${rendered.length})` : undefined,
            });
          }
        } else {
          if (doneKeys.has(p.id)) continue;
          setPreparingMsg(`Preprocessing ${p.source.name}...`);
          const processed = await processImage(p.source, preprocessOpts(extraction.highRes));
          items.push({
            fileKey: p.id,
            file: processed,
            useCtc,
            rowTolerance,
          });
        }
      }
      if (items.length === 0) {
        setPreparingMsg(null);
        return;
      }
      batch.enqueueMany(items);
      setPreparingMsg(null);
    } catch (e) {
      setPreparingMsg(null);
      setPrepError(e instanceof Error ? e.message : 'Rasterization failed');
    }
  };

  const isActiveTab = useSettingsStore((s) => s.activeTab === 'table');
  useKeyboardShortcuts({
    onSubmit,
    onCancel: () => batch.cancel(),
    enabled: isActiveTab,
  });

  const doneItems = useMemo(() => batch.items.filter((it) => it.status === 'done' && it.result), [batch.items]);
  const [resultIdx, setResultIdx] = useState(0);
  useEffect(() => {
    if (doneItems.length > 0) setResultIdx(doneItems.length - 1);
  }, [doneItems.length]);
  const safeResultIdx = Math.min(Math.max(0, resultIdx), Math.max(0, doneItems.length - 1));
  const currentResultItem = doneItems[safeResultIdx] ?? batch.items.find((it) => it.result) ?? null;

  const currentResult = currentResultItem?.result ?? null;
  const currentResultKey =
    currentResultItem ? (currentResultItem.args as { fileKey: string }).fileKey : null;
  const currentPrep = useMemo(() => {
    if (!currentResultKey) return prepared[0] ?? undefined;
    const match = prepared.find((p) => p.id === currentResultKey);
    if (match) return match;
    for (const p of prepared) {
      if (currentResultKey.startsWith(p.id + '-')) return p;
    }
    return prepared[0] ?? undefined;
  }, [currentResultKey, prepared]);

  // The exact image that was OCR'd lives in the result item's args — for a PDF
  // that's the rasterized page, for an image the processed file. Using it means
  // the preview always matches the result (PDFs no longer show "no preview").
  const sentFile = (currentResultItem?.args as { file?: File } | undefined)?.file;
  const uploadPreviewUrl = useMemo(() => {
    if (sentFile) return URL.createObjectURL(sentFile);
    const source = currentPrep?.source ?? files[0];
    if (source && !isPdf(source.name)) return URL.createObjectURL(source);
    return undefined;
  }, [sentFile, currentPrep, files]);
  useEffect(() => {
    return () => {
      if (uploadPreviewUrl) URL.revokeObjectURL(uploadPreviewUrl);
    };
  }, [uploadPreviewUrl]);

  const markdownSource = useMemo(
    () => (currentResult ? tableResultToMarkdown(currentResult) : ''),
    [currentResult],
  );
  const filenameBase = currentResult
    ? sanitizeFilename(currentResult.filename.replace(/\.[^.]+$/, ''))
    : 'table';

  const totalPageCount = prepared.reduce((sum, p) => sum + p.totalPages, 0);

  return (
    <div className="min-h-[calc(100vh-116px)] text-slate-950">
      <div className="grid gap-6 lg:grid-cols-[minmax(360px,420px)_minmax(0,1fr)]">
        <div className="grid min-w-0 grid-cols-1 content-start gap-6">
          <UploadTableCard
            files={files}
            onFilesChange={setFiles}
            disabled={batch.isRunning}
            isRunning={batch.isRunning}
            hasResult={!!currentResult}
            filename={currentResult?.filename}
            preparingMsg={preparingMsg}
            pageCount={totalPageCount}
            onCopyCleanText={() => {
              void copyToClipboard(markdownSource || currentResult?.structured_text || '');
            }}
          />
          <TableSettingsCard
            rowTolerance={rowTolerance}
            onRowToleranceChange={setRowTolerance}
            concurrency={concurrency}
            onConcurrencyChange={setConcurrency}
            disabled={batch.isRunning}
          />
          <ExtractionSettingsCard
            highRes={extraction.highRes}
            fullPageOcr={extraction.fullPageOcr}
            onHighResChange={(v) => setExtraction({ highRes: v })}
            onFullPageOcrChange={(v) => setExtraction({ fullPageOcr: v })}
            disabled={batch.isRunning}
            showFullPage={false}
          />
          <HowToUseCard />
        </div>

        {currentResult ? (
          <div className="min-w-0">
            <div className="mb-2 flex items-center justify-between gap-2">
              <ResultStepper index={safeResultIdx} count={doneItems.length} onChange={setResultIdx} label="Result" />
              <button
                type="button"
                onClick={() => batch.reset()}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 shadow-sm hover:bg-slate-50"
                title="Go back to your files — files and page selections are kept, so you can tweak settings and run again"
              >
                <span aria-hidden>↺</span> Back · run again
              </button>
            </div>
          <TableExtractionResultsCard
            result={currentResult}
            uploadPreviewUrl={uploadPreviewUrl}
            markdownSource={markdownSource}
            resultView={resultView}
            onResultViewChange={setResultView}
            markdownMode={markdownMode}
            onMarkdownModeChange={setMarkdownMode}
            filenameBase={filenameBase}
          />
          </div>
        ) : (
          <FileReadyPanel
            files={prepared}
            pageSelections={pageSelections}
            pageThumbnails={pageThumbnails}
            thumbLoading={thumbLoading}
            onPageSelectionChange={onPageSelectionChange}
            isRunning={batch.isRunning}
            preparingMsg={preparingMsg}
            onRun={onSubmit}
            onCancel={() => batch.cancel()}
            actionLabel={(selected) =>
              `Convert ${selected} selected page${selected === 1 ? '' : 's'} to Markdown`
            }
            runningLabel="Preparing table extraction..."
            emptyTitle="No table extraction yet"
            emptyDescription="Upload a PDF or table image, then select the pages to process."
            readyDescription="File uploaded successfully. Click below to convert tables to Markdown."
          />
        )}
      </div>

      <div className="mt-4 grid gap-2">
        {preparingMsg && <ProgressBar value={null} label={preparingMsg} />}
        {batch.isRunning && (
          batch.progress.active <= 1 && progress !== null ? (
            <ProgressBar value={progress} label="Uploading to API..." />
          ) : (
            <ProgressBar
              value={null}
              label={`Processing ${batch.progress.active} files... (${batch.progress.done} done)`}
            />
          )
        )}
        {prepError && <ErrorBanner error={new Error(prepError)} />}
        {batch.hasErrors && batch.items.some((it) => it.status === 'error' && it.error) && (
          <ErrorBanner error={batch.items.find((it) => it.status === 'error' && it.error)?.error} />
        )}
      </div>
    </div>
  );
}

function UploadTableCard({
  files,
  onFilesChange,
  disabled,
  isRunning,
  hasResult,
  filename,
  preparingMsg,
  pageCount,
  onCopyCleanText,
}: {
  files: File[];
  onFilesChange: (files: File[]) => void;
  disabled: boolean;
  isRunning: boolean;
  hasResult: boolean;
  filename?: string;
  preparingMsg: string | null;
  pageCount: number;
  onCopyCleanText: () => void;
}) {
  const stateLabel = hasResult
    ? '✓ Extraction Complete'
    : isRunning
    ? 'Extracting table…'
    : preparingMsg
    ? 'Preparing file…'
    : files.length > 0
    ? 'Ready to extract'
    : 'No file uploaded';

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <h2 className="mb-5 text-lg font-semibold tracking-tight text-slate-950">Upload Document</h2>

      <FileDropzone
        multiple
        accept="pdf-or-image"
        files={files}
        onChange={onFilesChange}
        disabled={disabled}
      />
      {(files.length > 0 || hasResult || isRunning || preparingMsg) && (
      <div className="mt-4 rounded-lg border border-slate-300 bg-slate-100 px-4 py-4 text-sm text-slate-700">
        <div className="flex items-center gap-2">
          <span
            className={`inline-block h-2 w-2 rounded-full ${
              hasResult ? 'bg-emerald-500' : isRunning || preparingMsg ? 'animate-pulse bg-amber-500' : files.length > 0 ? 'bg-slate-400' : 'bg-slate-300'
            }`}
          />
          <span className="font-semibold text-slate-950">{stateLabel}</span>
        </div>
        <div className="mt-1 text-xs text-slate-600">
          {preparingMsg
            ? preparingMsg
            : hasResult
            ? `Markdown: ${filename ? `${sanitizeFilename(filename.replace(/\.[^.]+$/, ''))}.md` : 'table.md'} · CSV Tables: 1`
            : files.length > 0
            ? `${files.length} file${files.length === 1 ? '' : 's'} selected${pageCount > files.length ? ` (${pageCount} pages total)` : ''}`
            : 'Drop a PDF or table image to begin.'}
        </div>
        {hasResult ? (
          <button
            type="button"
            onClick={onCopyCleanText}
            className="mt-3 inline-flex items-center gap-1.5 rounded bg-slate-950 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-slate-800"
          >
            <CopyIcon className="h-3.5 w-3.5" />
            Copy Clean Text
          </button>
        ) : null}
      </div>
      )}
    </section>
  );
}

function TableSettingsCard({
  rowTolerance,
  onRowToleranceChange,
  concurrency,
  onConcurrencyChange,
  disabled,
}: {
  rowTolerance: number;
  onRowToleranceChange: (value: number) => void;
  concurrency: number;
  onConcurrencyChange: (value: number) => void;
  disabled: boolean;
}) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <h2 className="mb-4 text-sm font-semibold text-slate-950">Table Settings</h2>
      <div className="grid gap-4 text-sm text-slate-700">
        <div className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
          <span>
            <span className="block font-medium text-slate-950">Use CTC decoder</span>
            <span className="block text-xs text-slate-500">Always on for every request</span>
          </span>
          <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-700">
            On
          </span>
        </div>
        <label>
          <span className="block font-medium text-slate-950">Row tolerance</span>
                    <input
                      type="number"
                      min={1}
                      step={1}
                      value={rowTolerance}
                      onChange={(event) => onRowToleranceChange(Number(event.target.value) || 1)}
            className="input mt-2"
            disabled={disabled}
          />
        </label>
        <ConcurrencyControl value={concurrency} onChange={onConcurrencyChange} disabled={disabled} />
      </div>
    </section>
  );
}

function HowToUseCard() {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <h2 className="mb-4 text-sm font-semibold text-slate-950">How to Use</h2>
      <ol className="space-y-3 text-sm text-slate-600">
        <li>1. Upload a PDF or table image file</li>
        <li>2. Click "Convert to Markdown" button</li>
        <li>3. Wait for processing to complete</li>
        <li>4. Copy clean text or download results</li>
      </ol>
    </section>
  );
}

function TableExtractionResultsCard({
  result,
  uploadPreviewUrl,
  markdownSource,
  resultView,
  onResultViewChange,
  markdownMode,
  onMarkdownModeChange,
  filenameBase,
}: {
  result: TableResult | null;
  uploadPreviewUrl?: string;
  markdownSource: string;
  resultView: ResultView;
  onResultViewChange: (view: ResultView) => void;
  markdownMode: MarkdownMode;
  onMarkdownModeChange: (mode: MarkdownMode) => void;
  filenameBase: string;
}) {
  const [editedMarkdown, setEditedMarkdown] = useState(markdownSource);

  // Reset ONLY when a new result loads — resetting on mode switches wiped the
  // user's edits (edit → Apply → Edit again lost everything).
  useEffect(() => {
    setEditedMarkdown(markdownSource);
  }, [markdownSource]);
  const isEdited = editedMarkdown !== markdownSource;
  // Round-trip: if the edited markdown still parses as a pipe table, CSV/XLSX
  // exports are rebuilt FROM THE EDITS instead of the original cells.
  const editedTable = useMemo(
    () => (isEdited ? parsePipeTable(editedMarkdown.trim()) : null),
    [isEdited, editedMarkdown],
  );
  return (
    <section className="flex min-h-[720px] flex-col rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-slate-950">Extraction Results</h2>
          <p className="truncate text-sm text-slate-500">
            {result?.filename ?? 'Upload a table image to see markdown output'}
          </p>
        </div>
        {result && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="mr-1 self-center text-[11px] font-medium uppercase tracking-wide text-slate-500">
              Export
            </span>
            {editedTable && (
              <span
                className="rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700"
                title="Your markdown edits parse as a table — CSV and XLSX export the EDITED table. Word/HTML/JSON/flagged-XLSX use the original extraction (they need cell confidence/coords)."
              >
                edited → CSV/XLSX
              </span>
            )}
            <ExportButton
              label="CSV"
              onClick={() =>
                downloadText(
                  `${filenameBase}.csv`,
                  '﻿' + (editedTable ? tableToCsvString(editedTable) : tableToCsv(result)),
                  'text/csv;charset=utf-8',
                )
              }
            />
            <ExportButton
              label="XLSX"
              onClick={() => {
                if (editedTable) {
                  void exportSingleTableToXlsx(editedTable).then((bytes) =>
                    downloadBytes(`${filenameBase}.xlsx`, bytes, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
                  );
                } else {
                  void downloadTableXlsx(result, filenameBase);
                }
              }}
            />
            <ExportButton
              label="XLSX ⚠ flagged"
              onClick={() => downloadTableHighlightedXls(result, filenameBase)}
            />
            <ExportButton
              label="Word"
              onClick={() => {
                void downloadTableDocx(result, filenameBase);
              }}
            />
            <ExportButton label="HTML" onClick={() => downloadText(`${filenameBase}.html`, tableResultToHtml(result), 'text/html;charset=utf-8')} />
            <ExportButton label="JSON" onClick={() => downloadJson(`${filenameBase}.json`, result)} />
          </div>
        )}
      </header>

      <div
        role="tablist"
        aria-label="Extraction result view"
        className="mt-8 inline-flex w-fit rounded-2xl bg-slate-100 p-0.5 text-sm font-semibold text-slate-950"
      >
        <ResultTab
          active={resultView === 'preview'}
          icon={<ImageIcon className="h-4 w-4" />}
          label="Preview"
          onClick={() => onResultViewChange('preview')}
        />
        <ResultTab
          active={resultView === 'markdown'}
          icon={<DocumentIcon className="h-4 w-4" />}
          label="Markdown"
          onClick={() => onResultViewChange('markdown')}
        />
        <ResultTab
          active={resultView === 'csv'}
          icon={<GridIcon className="h-4 w-4" />}
          label={`CSV Tables (${result ? 1 : 0})`}
          onClick={() => onResultViewChange('csv')}
        />
      </div>

      <div className="mt-6 rounded-lg border border-slate-200 bg-white px-3 py-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-sm font-semibold text-slate-950">Copy by page</div>
            <div className="text-xs text-slate-500">Copy OCR output one page at a time.</div>
          </div>
          <button
            type="button"
            disabled={!result}
            onClick={() => {
              void copyToClipboard(markdownSource || result?.structured_text || '');
            }}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-950 shadow-sm hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <CopyIcon className="h-4 w-4" />
            Document
          </button>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 pb-4">
        {resultView === 'markdown' ? (
          <div className="inline-flex rounded-2xl bg-slate-100 p-0.5 text-sm font-semibold">
            <SubTab
              active={markdownMode === 'preview'}
              icon={<EyeIcon className="h-4 w-4" />}
              label="Preview"
              onClick={() => onMarkdownModeChange('preview')}
            />
            <SubTab
              active={markdownMode === 'source'}
              icon={<EditIcon className="h-4 w-4" />}
              label="Source"
              onClick={() => onMarkdownModeChange('source')}
            />
          </div>
        ) : (
          <div className="text-sm font-semibold text-slate-950">
            {resultView === 'csv' ? 'Table Grid' : 'Image Preview'}
          </div>
        )}

        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={!result}
            onClick={() => {
              if (resultView === 'markdown') {
                void copyToClipboard(editedMarkdown);
              } else if (resultView === 'csv') {
                void copyToClipboard(editedTable ? tableToCsvString(editedTable) : tableToCsv(result!));
              } else {
                void copyToClipboard(result?.structured_text ?? '');
              }
            }}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-950 shadow-sm hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <CopyIcon className="h-4 w-4" />
            Copy
          </button>
          <button
            type="button"
            disabled={!result}
            onClick={() => {
              if (resultView === 'markdown') {
                downloadText(`${filenameBase}.md`, editedMarkdown, 'text/markdown;charset=utf-8');
              } else if (resultView === 'csv') {
                downloadText(
                  `${filenameBase}.csv`,
                  '﻿' + (editedTable ? tableToCsvString(editedTable) : tableToCsv(result!)),
                  'text/csv;charset=utf-8',
                );
              } else {
                downloadText(`${filenameBase}.txt`, result?.structured_text ?? '');
              }
            }}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-950 shadow-sm hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <DownloadIcon className="h-4 w-4" />
            Download
          </button>
          <button
            type="button"
            disabled={!result || resultView !== 'markdown'}
            onClick={() => onMarkdownModeChange(markdownMode === 'source' ? 'preview' : 'source')}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-950 shadow-sm hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
            title={markdownMode === 'source' ? 'Apply edits and return to preview' : 'Edit the markdown source'}
          >
            {markdownMode === 'source' ? <CheckIcon className="h-4 w-4" /> : <EditIcon className="h-4 w-4" />}
            {markdownMode === 'source' ? 'Apply' : 'Edit'}
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 pt-4">
        {!result ? (
          <EmptyResults />
        ) : resultView === 'preview' ? (
          <PreviewPane result={result} uploadPreviewUrl={uploadPreviewUrl} />
        ) : (
          // Grid / Markdown views: keep the SOURCE IMAGE alongside the data so
          // the photo is always visible, not hidden behind the Preview tab.
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,340px)]">
            <div className="min-w-0">
              {resultView === 'markdown' ? (
                markdownMode === 'preview' ? (
                  <MarkdownView source={editedMarkdown} maxHeight="596px" showCopy={true} />
                ) : (
                  <textarea
                    value={editedMarkdown}
                    onChange={(e) => setEditedMarkdown(e.target.value)}
                    className="max-h-[596px] min-h-[300px] w-full resize-y overflow-auto whitespace-pre-wrap rounded-lg border border-slate-200 bg-slate-50 p-4 font-mono text-xs leading-relaxed text-slate-800 focus:border-slate-400 focus:outline-none"
                    spellCheck={false}
                  />
                )
              ) : (
                <div className="max-h-[596px] overflow-auto rounded-lg border border-slate-200 bg-white p-4">
                  <TableGrid cells={result.cells} rows={result.num_rows} cols={result.num_cols} />
                </div>
              )}
            </div>
            <aside className="min-w-0">
              <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                Source image
              </div>
              <PreviewPane result={result} uploadPreviewUrl={uploadPreviewUrl} minHeightClass="min-h-[300px]" />
            </aside>
          </div>
        )}
      </div>
    </section>
  );
}

function PreviewPane({
  result,
  uploadPreviewUrl,
  minHeightClass,
}: {
  result: TableResult;
  uploadPreviewUrl?: string;
  minHeightClass?: string;
}) {
  const imageUrl = result.debug_image ? `data:image/png;base64,${result.debug_image}` : uploadPreviewUrl;

  return (
    <ZoomableImage
      imageUrl={imageUrl}
      alt={`${result.filename} preview`}
      emptyMessage="No image preview available."
      minHeightClass={minHeightClass}
    />
  );
}

function EmptyResults() {
  return (
    <div className="grid h-[520px] place-items-center rounded-lg border border-dashed border-slate-300 bg-slate-50 text-center">
      <div>
        <div className="text-sm font-semibold text-slate-950">No extraction yet</div>
        <p className="mt-1 text-sm text-slate-500">Upload a table image, then convert it to Markdown.</p>
      </div>
    </div>
  );
}

function ResultTab({
  active,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`inline-flex items-center gap-2 rounded-2xl px-7 py-2 transition-colors ${
        active ? 'bg-white shadow-sm' : 'text-slate-700 hover:bg-white/60'
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

function SubTab({
  active,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-2 rounded-2xl px-3 py-1.5 transition-colors ${
        active ? 'bg-white shadow-sm' : 'text-slate-700 hover:bg-white/60'
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

function ExportButton({
  label,
  onClick,
  disabled,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-950 shadow-sm hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
    >
      <DownloadIcon className="h-4 w-4" />
      {label}
    </button>
  );
}

function tableResultToGrid(result: TableResult): string[][] {
  const grid = Array.from({ length: result.num_rows }, () =>
    Array.from({ length: result.num_cols }, () => ''),
  );
  for (const cell of result.cells) {
    if (cell.row < grid.length && cell.col < grid[cell.row].length) {
      grid[cell.row][cell.col] = cell.text ?? '';
    }
  }
  return grid;
}

function tableResultToMarkdown(result: TableResult): string {
  const grid = tableResultToGrid(result);
  const headers = (grid[0] ?? []).map((cell, index) => markdownCell(cell || `Column ${index + 1}`));
  const body = grid.slice(1);
  const lines = [`# ${result.filename}`, '', `| ${headers.join(' | ')} |`];
  lines.push(`| ${headers.map(() => '---').join(' | ')} |`);
  for (const row of body) {
    lines.push(`| ${row.map(markdownCell).join(' | ')} |`);
  }
  return `${lines.join('\n')}\n`;
}

function tableResultToHtml(result: TableResult): string {
  const grid = tableResultToGrid(result);
  const headers = grid[0] ?? [];
  const rows = grid.slice(1);
  const th = headers.map((cell) => `<th>${escapeHtml(cell)}</th>`).join('');
  const tr = rows
    .map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`)
    .join('\n');
  return `<!DOCTYPE html>
<html lang="km">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(result.filename)}</title>
<style>
body { font-family: "Segoe UI", "Noto Sans Khmer", sans-serif; margin: 32px; color: #0f172a; }
table { border-collapse: collapse; width: 100%; }
th, td { border: 1px solid #cbd5e1; padding: 8px 10px; vertical-align: top; }
th { background: #f1f5f9; text-align: left; font-weight: 600; }
tr:nth-child(even) { background: #f8fafc; }
</style>
</head>
<body>
<h1>${escapeHtml(result.filename)}</h1>
<table><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table>
</body>
</html>`;
}

async function downloadTableXlsx(result: TableResult, filenameBase: string): Promise<void> {
  const XLSX = await import('xlsx');
  const grid = tableResultToGrid(result);
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(grid);
  ws['!cols'] = Array.from({ length: result.num_cols }, (_, colIndex) => {
    const maxLen = Math.max(10, ...grid.map((row) => row[colIndex]?.length ?? 0));
    return { wch: Math.min(60, maxLen + 2) };
  });
  XLSX.utils.book_append_sheet(wb, ws, 'Table');
  const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as Uint8Array;
  downloadBytes(`${filenameBase}.xlsx`, out, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
}

/**
 * Excel export that tints low-confidence cells (<60%) so the user sees exactly
 * which figures to double-check. Uses an HTML-table .xls — Excel opens it and
 * honours inline cell backgrounds, which the community SheetJS build can't write.
 */
function tableResultToHighlightedXls(result: TableResult): string {
  const textGrid = tableResultToGrid(result);
  const confGrid: number[][] = Array.from({ length: result.num_rows }, () =>
    Array.from({ length: result.num_cols }, () => 1),
  );
  for (const cell of result.cells) {
    if (cell.row < confGrid.length && cell.col < confGrid[cell.row].length) {
      confGrid[cell.row][cell.col] = cell.confidence ?? 1;
    }
  }
  const rowsHtml = textGrid
    .map((row, ri) => {
      const cells = row
        .map((cell, ci) => {
          const conf = confGrid[ri]?.[ci] ?? 1;
          const low = conf > 0 && conf < 0.6;
          const tag = ri === 0 ? 'th' : 'td';
          const bg = low ? '#fecaca' : ri === 0 ? '#f1f5f9' : '';
          const style = bg ? ` style="background-color:${bg}"` : '';
          return `<${tag}${style}>${escapeHtml(cell)}</${tag}>`;
        })
        .join('');
      return `<tr>${cells}</tr>`;
    })
    .join('');
  return `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta charset="UTF-8"></head><body><table border="1">${rowsHtml}</table></body></html>`;
}

function downloadTableHighlightedXls(result: TableResult, filenameBase: string): void {
  const html = tableResultToHighlightedXls(result);
  // Leading UTF-8 BOM so Excel decodes Khmer correctly (it ignores the charset
  // hint on a double-clicked file). Harmless for English.
  downloadBytes(`${filenameBase}-flagged.xls`, new TextEncoder().encode('﻿' + html), 'application/vnd.ms-excel');
}

async function downloadTableDocx(result: TableResult, filenameBase: string): Promise<void> {
  const docx = await import('docx');
  const { Document, Packer, Paragraph, Table, TableRow, TableCell, TextRun, WidthType } = docx;
  const grid = tableResultToGrid(result);
  const table = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: grid.map(
      (row, rowIndex) =>
        new TableRow({
          children: row.map(
            (cell) =>
              new TableCell({
                children: [
                  new Paragraph({
                    children: [new TextRun({ text: cell, bold: rowIndex === 0, font: 'Noto Sans Khmer' })],
                  }),
                ],
              }),
          ),
        }),
    ),
  });
  const document = new Document({
    sections: [
      {
        properties: {},
        children: [
          new Paragraph({
            children: [new TextRun({ text: result.filename, bold: true, font: 'Noto Sans Khmer' })],
          }),
          table,
        ],
      },
    ],
  });
  const blob = await Packer.toBlob(document);
  downloadBytes(
    `${filenameBase}.docx`,
    new Uint8Array(await blob.arrayBuffer()),
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  );
}

function markdownCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>').trim();
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fileKey(f: File): string {
  return `${f.name}|${f.size}|${f.lastModified}`;
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-z0-9._-]+/gi, '_').slice(0, 80);
}

function DownloadIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 3v11" strokeLinecap="round" />
      <path d="m8 10 4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M5 19h14" strokeLinecap="round" />
    </svg>
  );
}

function CopyIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function ImageIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <circle cx="9" cy="9" r="2" />
      <path d="m20 16-4-4-5 5-2-2-5 5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
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

function GridIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M4 5h16M4 12h16M4 19h16M8 5v14M16 5v14" />
    </svg>
  );
}

function EyeIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function EditIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 20h9" strokeLinecap="round" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" strokeLinejoin="round" />
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
