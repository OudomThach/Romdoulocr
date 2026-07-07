import { useCallback, useEffect, useMemo, useState } from 'react';
import { useKeyboardShortcuts } from '@/components/controls';
import { ErrorBanner } from '@/components/ErrorBanner';
import { FileDropzone } from '@/components/FileDropzone';
import { FileReadyPanel } from '@/components/FileReadyPanel';
import { MarkdownView } from '@/components/MarkdownView';
import { LowConfidencePanel } from '@/components/LowConfidencePanel';
import { DocumentSearch } from '@/components/DocumentSearch';
import { PagePreview } from '@/components/PagePreview';
import { ProgressBar } from '@/components/ProgressBar';
import { ResultStepper } from '@/components/ResultStepper';
import { useBatchProcessor } from '@/hooks/useBatchProcessor';
import { useHistoryAutoSave } from '@/hooks/useHistoryAutoSave';
import { usePagePreviews } from '@/hooks/usePagePreviews';
import { usePdfPageSelection } from '@/hooks/usePdfPageSelection';
import { pageToMarkdown, resultToMarkdown, resultToSearchablePdf } from '@/lib/exporters';
import { getPdfPageCount, imageFileToThumbnail, renderPdfPages, renderPdfThumbnails } from '@/lib/pdfProcessing';
import { api } from '@/lib/api';
import { useSettingsStore } from '@/hooks/useSettingsStore';
import { preprocessOpts, rasterFor } from '@/lib/extractionConfig';
import { mergeFullPageText } from '@/lib/mergeFullPage';
import { ExtractionSettingsCard } from '@/components/ExtractionSettingsCard';
import {
  countDocumentTables,
  docText,
  documentHasText,
  downloadAllFormatsAsZip,
  downloadDocumentCsvs,
  downloadDocumentDocx,
  downloadDocumentHtml,
  downloadDocumentJson,

  downloadDocumentText,
  downloadDocumentXlsx,
  downloadSingleTableCsv,
  downloadSingleTableXlsx,
  extractTableCells,
  singlePageDocument,
  tableToTsv,
} from '@/lib/documentExport';
import { type ZipEntry } from '@/lib/zipExport';
import { copyToClipboard, downloadText, isImage, isPdf } from '@/lib/utils';
import { processImage } from '@/lib/imageProcessing';
import type { DocumentResult, PageResult } from '@/types/api';

interface PreparedFile {
  id: string;
  source: File;
  pages: File[];
  totalPages: number;
}

type ResultView = 'preview' | 'markdown' | 'csv';
type MarkdownMode = 'preview' | 'source';

export function DocumentParserTab() {
  const [files, setFiles] = useState<File[]>([]);
  const [progress, setProgress] = useState<number | null>(null);
  const [pageInResult, setPageInResult] = useState<number>(0);
  const [resultView, setResultView] = useState<ResultView>('preview');
  const [markdownMode, setMarkdownMode] = useState<MarkdownMode>('preview');

  const { pageSelections, pageThumbnails, thumbLoading, onPageSelectionChange } =
    usePdfPageSelection(files, fileKey);

  const useCtc = true;
  const extraction = useSettingsStore((s) => s.extraction);
  const setExtraction = useSettingsStore((s) => s.setExtraction);

  const [prepared, setPrepared] = useState<PreparedFile[]>([]);
  const [preparingMsg, setPreparingMsg] = useState<string | null>(null);
  const [pdfError, setPdfError] = useState<string | null>(null);

  const previewUrl = useMemo(() => {
    if (files.length !== 1) return undefined;
    const f = files[0];
    if (isImage(f.name)) return URL.createObjectURL(f);
    return undefined;
  }, [files]);
  // Revoke the blob URL when it changes / on unmount (avoid leaking on re-upload).
  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);

  const batch = useBatchProcessor<
    { fileKey: string; files: File[]; detectLayout: boolean; detectLines: boolean; useCtc: boolean; fullPageOcr: boolean; sourcePages: number[] },
    DocumentResult
  >({
    concurrency: 2,
    run: async (args, signal) => {
      const a = args as { files: File[]; detectLayout: boolean; detectLines: boolean; fullPageOcr: boolean };
      const primary = await api.parsePdf(
        a.files,
        { detectLayout: a.detectLayout, detectLines: a.detectLines },
        { signal, onProgress: setProgress },
      );
      if (!a.fullPageOcr) return primary;
      // Second pass over the whole page (no layout gating) to recover any text
      // the layout boxes missed (margins, headers/footers, stamps).
      try {
        const full = await api.parsePdf(
          a.files,
          { detectLayout: false, detectLines: a.detectLines },
          { signal },
        );
        return mergeFullPageText(primary, full);
      } catch {
        return primary;
      }
    },
  });

  // Compact JPEG thumbnails (keyed by result page_number) saved with each run
  // so History can show the page photo behind the boxes.
  const captureHistoryPreviews = useCallback(
    async (item: { args?: unknown }, prep: PreparedFile): Promise<Record<number, string> | undefined> => {
      try {
        if (isPdf(prep.source.name)) {
          const sourcePages = (item.args as { sourcePages?: number[] } | undefined)?.sourcePages ?? [];
          if (sourcePages.length === 0) return undefined;
          const thumbs = await renderPdfThumbnails(prep.source, sourcePages);
          const out: Record<number, string> = {};
          sourcePages.forEach((sp, i) => {
            const u = thumbs.get(sp);
            if (u) out[i + 1] = u; // result pages are renumbered 1..n in order
          });
          return out;
        }
        return { 1: await imageFileToThumbnail(prep.source) };
      } catch {
        return undefined;
      }
    },
    [],
  );

  useHistoryAutoSave<PreparedFile>(
    'document',
    batch,
    prepared,
    { detectLayout: true, detectLines: true, useCtc, concurrency: 2 },
    captureHistoryPreviews,
  );

  useEffect(() => {
    let cancelled = false;
    setPdfError(null);

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
            setPdfError(`${f.name}: ${e instanceof Error ? e.message : 'PDF read failed'}`);
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
      const items: { fileKey: string; files: File[]; detectLayout: boolean; detectLines: boolean; useCtc: boolean; fullPageOcr: boolean; sourcePages: number[] }[] = [];
      for (const p of prepared) {
        if (isPdf(p.source.name)) {
          const key = fileKey(p.source);
          const selectedPages = pageSelections[key] ?? Array.from({ length: p.totalPages }, (_, i) => i + 1);
          const pages = selectedPages.length > 0 ? selectedPages : Array.from({ length: p.totalPages }, (_, i) => i + 1);
          if (pages.length === 0) {
            setPdfError(`No pages selected for ${p.source.name}`);
            setPreparingMsg(null);
            return;
          }
          setPreparingMsg(`Rasterizing ${p.source.name} (${pages.length} pages)...`);
          const rendered = await renderPdfPages(p.source, pages, rasterFor(extraction.highRes).dpi);
          const rasterizedFiles = rendered.map((r) => r.file);
          // Single enqueue with all page images (multi-file POST). Keep the
          // ACTUAL source page numbers in order — the API renumbers its result
          // pages from 1, so without this the preview can't map a result page
          // back to the right source page (e.g. extracting only p34 would show
          // the cover instead).
          const idKey = fileKey(p.source);
          if (!doneKeys.has(idKey)) {
            items.push({
              fileKey: idKey,
              files: rasterizedFiles,
              detectLayout: true,
              detectLines: true,
              useCtc,
              fullPageOcr: extraction.fullPageOcr,
              sourcePages: rendered.map((r) => r.pageNumber),
            });
          }
        } else {
          setPreparingMsg(`Preprocessing ${p.source.name}...`);
          const processed = await Promise.all(
            p.pages.map((f) => processImage(f, preprocessOpts(extraction.highRes))),
          );
          if (!doneKeys.has(p.id)) {
            items.push({
              fileKey: p.id,
              files: processed,
              detectLayout: true,
              detectLines: true,
              useCtc,
              fullPageOcr: extraction.fullPageOcr,
              sourcePages: p.pages.map((_, i) => i + 1),
            });
          }
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
      setPdfError(e instanceof Error ? e.message : 'Rasterization failed');
    }
  };

  // Only the visible tab should react to Ctrl+Enter / Esc — all tabs stay
  // mounted now, so without this every tab's shortcut would fire at once.
  const isActiveTab = useSettingsStore((s) => s.activeTab === 'document');
  useKeyboardShortcuts({
    onSubmit,
    onCancel: () => batch.cancel(),
    enabled: isActiveTab,
  });

  const buildAllZip = async (): Promise<ZipEntry[]> => {
    const entries: ZipEntry[] = [];
    const doneItems = batch.items.filter((it) => it.status === 'done' && it.result);
    for (let i = 0; i < doneItems.length; i++) {
      const it = doneItems[i];
      const r = it.result!;
      const key = (it.args as { fileKey: string }).fileKey;
      const prep = prepared.find((p) => p.id === key);
      const base = sanitizeFilename(r.filename.replace(/\.[^.]+$/, ''));
      const dir = `${String(i + 1).padStart(2, '0')}_${base}`;
      entries.push({ name: `${dir}/${base}.txt`, text: docText(r) });
      entries.push({ name: `${dir}/${base}.md`, text: resultToMarkdown(r) });
      entries.push({ name: `${dir}/${base}.json`, text: JSON.stringify(r, null, 2) });
      try {
        const pdfBytes = await resultToSearchablePdf(r);
        entries.push({ name: `${dir}/${base}.pdf`, bytes: pdfBytes });
      } catch {
        // Skip PDF if this one result cannot be serialized.
      }
      if (prep?.source) {
        try {
          const bytes = new Uint8Array(await prep.source.arrayBuffer());
          entries.push({ name: `sources/${prep.source.name}`, bytes });
        } catch {
          // The browser may revoke file handles; keep the rest of the archive.
        }
      }
    }
    return entries;
  };

  if (typeof window !== 'undefined') {
    (window as unknown as { __downloadAllZip?: () => Promise<void> }).__downloadAllZip = async () => {
      const { downloadZip } = await import('@/lib/zipExport');
      await downloadZip(`results-${new Date().toISOString().slice(0, 10)}.zip`, await buildAllZip());
    };
  }

  // All finished results (one per processed file/page). A stepper lets you page
  // back and forth through them; a new run jumps to the newest.
  const doneItems = useMemo(() => batch.items.filter((it) => it.status === 'done' && it.result), [batch.items]);
  const [resultIdx, setResultIdx] = useState(0);
  useEffect(() => {
    if (doneItems.length > 0) setResultIdx(doneItems.length - 1);
  }, [doneItems.length]);
  const safeResultIdx = Math.min(Math.max(0, resultIdx), Math.max(0, doneItems.length - 1));
  useEffect(() => setPageInResult(0), [safeResultIdx]);
  const currentResultItem = doneItems[safeResultIdx] ?? batch.items.find((it) => it.result) ?? null;

  const currentResult = currentResultItem?.result ?? null;
  const currentResultKey =
    currentResultItem ? (currentResultItem.args as { fileKey: string }).fileKey : null;
  const currentPrep = currentResultKey ? prepared.find((p) => p.id === currentResultKey) : null;

  const pageIdx = currentResult
    ? Math.min(Math.max(0, pageInResult), currentResult.pages.length - 1)
    : 0;
  const currentPage = useMemo(() => {
    if (!currentResult || currentResult.pages.length === 0) return null;
    return currentResult.pages[pageIdx];
  }, [currentResult, pageIdx]);

  // Actual 1-based SOURCE page numbers that were extracted, in result order.
  // Lets us map a result page back to the page the user really selected.
  const currentSourcePages = useMemo(
    () => (currentResultItem?.args as { sourcePages?: number[] } | undefined)?.sourcePages ?? [],
    [currentResultItem],
  );

  // New document → jump back to its first page, but KEEP the user's chosen
  // view (Preview / Markdown / CSV) and markdown sub-mode so it's remembered
  // across extractions instead of snapping back every time.
  useEffect(() => {
    setPageInResult(0);
  }, [currentResult?.filename]);

  const currentMarkdownSource = useMemo(
    () => (currentResult ? resultToMarkdown(currentResult) : ''),
    [currentResult],
  );

  const currentIsPdf = currentPrep?.source?.name.toLowerCase().endsWith('.pdf') ?? false;
  // Render previews for the SOURCE pages actually extracted (falls back to the
  // result's own page numbers for older runs that predate sourcePages).
  const previewPageNumbers = useMemo(
    () =>
      currentSourcePages.length > 0
        ? currentSourcePages
        : currentResult?.pages.map((p) => p.page_number) ?? [],
    [currentSourcePages, currentResult],
  );
  const { previews: currentPagePreviews } = usePagePreviews(
    currentIsPdf ? (currentPrep?.source ?? null) : null,
    previewPageNumbers,
    1200,
  );
  const effectivePagePreview = useMemo(() => {
    if (!currentResult) return undefined;
    if (currentIsPdf && currentPage) {
      // Map this result page (index pageIdx) to its real source page number.
      const srcPage = currentSourcePages[pageIdx] ?? currentPage.page_number;
      return currentPagePreviews.get(srcPage);
    }
    if (currentPrep?.pages?.[0]) return URL.createObjectURL(currentPrep.pages[0]);
    return previewUrl;
  }, [currentResult, currentIsPdf, currentPage, pageIdx, currentSourcePages, currentPagePreviews, currentPrep, previewUrl]);
  // Only object URLs (blob:) need revoking — page previews are data: URLs.
  useEffect(() => () => {
    if (effectivePagePreview?.startsWith('blob:') && effectivePagePreview !== previewUrl) {
      URL.revokeObjectURL(effectivePagePreview);
    }
  }, [effectivePagePreview, previewUrl]);

  const cleanText = currentResult ? docText(currentResult) : '';
  const tableCount = currentResult ? countDocumentTables(currentResult) : 0;

  return (
    <div className="min-h-[calc(100vh-116px)] text-slate-950">
      <div className="grid gap-6 lg:grid-cols-[minmax(360px,420px)_minmax(0,1fr)]">
        <div className="grid min-w-0 grid-cols-1 content-start gap-6">
          <UploadDocumentCard
            files={files}
            onFilesChange={setFiles}
            disabled={batch.isRunning}
            isRunning={batch.isRunning}
            hasResult={!!currentResult}
            filename={currentResult?.filename}
            tableCount={tableCount}
            preparingMsg={preparingMsg}
            onCopyCleanText={() => {
              void copyToClipboard(cleanText);
            }}
          />
          <ExtractionSettingsCard
            highRes={extraction.highRes}
            fullPageOcr={extraction.fullPageOcr}
            onHighResChange={(v) => setExtraction({ highRes: v })}
            onFullPageOcrChange={(v) => setExtraction({ fullPageOcr: v })}
            disabled={batch.isRunning}
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
          <ExtractionResultsCard
            result={currentResult}
            currentPage={currentPage}
            pageIndex={pageInResult}
            onPageChange={setPageInResult}
            imageUrl={effectivePagePreview}
            markdownSource={currentMarkdownSource}
            resultView={resultView}
            onResultViewChange={setResultView}
            markdownMode={markdownMode}
            onMarkdownModeChange={setMarkdownMode}
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
            actionLabel={(selected) => `Extract ${selected} selected page${selected === 1 ? '' : 's'}`}
            runningLabel="Preparing file..."
            emptyTitle="No extraction yet"
            emptyDescription="Upload a PDF or image, then select the pages to process."
            readyDescription="File uploaded successfully. Click below to convert to Markdown and extract tables."
          />
        )}
      </div>

      <div className="mt-4 grid gap-2">
        {preparingMsg && <ProgressBar value={null} label={preparingMsg} />}
        {pdfError && <ErrorBanner error={new Error(pdfError)} />}
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
        {batch.hasErrors &&
          batch.items.some((it) => it.status === 'error' && it.error) && (
            <ErrorBanner error={batch.items.find((it) => it.status === 'error' && it.error)?.error} />
          )}
      </div>
    </div>
  );
}

function UploadDocumentCard({
  files,
  onFilesChange,
  disabled,
  isRunning,
  hasResult,
  filename,
  tableCount,
  preparingMsg,
  onCopyCleanText,
}: {
  files: File[];
  onFilesChange: (files: File[]) => void;
  disabled: boolean;
  isRunning: boolean;
  hasResult: boolean;
  filename?: string;
  tableCount: number;
  preparingMsg: string | null;
  onCopyCleanText: () => void;
}) {
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
          {hasResult ? (
            <>
              <div className="font-semibold text-slate-950">&#10003; Extraction Complete</div>
              <div className="mt-2 space-y-1 break-all text-xs">
                <div>&bull; Markdown: {filename ? `${sanitizeFilename(filename.replace(/\.[^.]+$/, ''))}.md` : 'document.md'}</div>
                <div>&bull; CSV Tables: {tableCount}</div>
              </div>
              <button
                type="button"
                onClick={onCopyCleanText}
                className="mt-3 inline-flex items-center gap-1.5 rounded bg-slate-950 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-slate-800"
              >
                <CopyIcon className="h-3.5 w-3.5" />
                Copy Clean Text
              </button>
            </>
          ) : (
            <>
              <div className="font-semibold text-slate-950">
                {isRunning ? 'Extracting document...' : preparingMsg ? 'Preparing file...' : 'File uploaded'}
              </div>
              <div className="mt-1 text-xs text-slate-600">
                {preparingMsg ??
                  `${files.length} file${files.length === 1 ? '' : 's'} ready. Select pages in the preview panel.`}
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}

function HowToUseCard() {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <h2 className="mb-4 text-sm font-semibold text-slate-950">How to Use</h2>
      <ol className="space-y-3 text-sm text-slate-600">
        <li>1. Upload a PDF or image file</li>
        <li>2. Select the pages you want to process</li>
        <li>3. Click "Extract selected pages"</li>
        <li>4. Copy clean text or download results</li>
      </ol>
    </section>
  );
}

function ExtractionResultsCard({
  result,
  currentPage,
  pageIndex,
  onPageChange,
  imageUrl,
  markdownSource,
  resultView,
  onResultViewChange,
  markdownMode,
  onMarkdownModeChange,
}: {
  result: DocumentResult | null;
  currentPage: PageResult | null;
  pageIndex: number;
  onPageChange: (page: number) => void;
  imageUrl?: string;
  markdownSource: string;
  resultView: ResultView;
  onResultViewChange: (view: ResultView) => void;
  markdownMode: MarkdownMode;
  onMarkdownModeChange: (mode: MarkdownMode) => void;
}) {
  const [editedMarkdown, setEditedMarkdown] = useState(markdownSource);

  // Hero stats for the header chips — data as the hero, at a glance.
  const heroStats = useMemo(() => {
    if (!result) return null;
    const regions = result.pages.reduce((s, p) => s + p.regions.length, 0);
    const confs = result.pages.flatMap((p) => p.regions.map((r) => r.confidence));
    const avg = confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : 0;
    return { regions, avg };
  }, [result]);
  // Markdown preview scope: 'page' keeps the rendered markdown locked to the
  // page currently shown in the image preview (so picking a page updates both
  // the picture and the text together); 'all' shows the whole document.
  const [mdScope, setMdScope] = useState<'page' | 'all'>('page');
  // Export scope: whole document vs just the page on screen.
  const [exportScope, setExportScope] = useState<'page' | 'doc'>('doc');
  const tableCount = result ? countDocumentTables(result) : 0;
  const filenameBase = result ? sanitizeFilename(result.filename.replace(/\.[^.]+$/, '')) : 'document';
  const pageText = currentPage ? pageToPlainText(currentPage) : '';

  // What an export actually covers, given the scope toggle. Content-aware
  // buttons (CSV/XLSX vs Word/TXT) key off THIS, so a text-only page won't
  // offer spreadsheet exports and vice-versa.
  const exportTarget = useMemo(() => {
    if (!result) return null;
    return exportScope === 'page' && currentPage
      ? singlePageDocument(result, currentPage.page_number)
      : result;
  }, [result, exportScope, currentPage]);
  const exportBase = exportScope === 'page' && currentPage ? `${filenameBase}-page-${currentPage.page_number}` : filenameBase;
  const targetHasTables = exportTarget ? countDocumentTables(exportTarget) > 0 : false;
  const targetHasText = exportTarget ? documentHasText(exportTarget) : false;

  // Markdown for just the page on screen — matches the page image beside it.
  const pageMarkdown = useMemo(
    () => (result && currentPage ? pageToMarkdown(result, currentPage.page_number) : ''),
    [result, currentPage],
  );

  // Sync edited markdown ONLY when a new result loads. Deliberately NOT on
  // mode switches — resetting when re-entering Source mode wiped the user's
  // edits (edit → Apply → Edit again lost everything).
  useEffect(() => {
    setEditedMarkdown(markdownSource);
  }, [markdownSource]);
  const isEdited = editedMarkdown !== markdownSource;

  return (
    <section className="flex min-h-[720px] flex-col rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-slate-950">Extraction Results</h2>
          <p className="truncate text-sm text-slate-500">
            {result?.filename ?? 'Upload a file, then extract selected pages'}
          </p>
          {result && heroStats && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <HeroStat value={String(result.num_pages)} label={result.num_pages === 1 ? 'page' : 'pages'} />
              <HeroStat value={String(heroStats.regions)} label="regions" />
              {tableCount > 0 && <HeroStat value={String(tableCount)} label={tableCount === 1 ? 'table' : 'tables'} />}
              {heroStats.avg > 0 && (
                <HeroStat
                  value={`${Math.round(heroStats.avg * 100)}%`}
                  label="avg conf"
                  tone={heroStats.avg >= 0.8 ? 'good' : 'warn'}
                />
              )}
            </div>
          )}
        </div>
        {result && exportTarget && (
          <div className="flex flex-wrap items-center gap-2">
            {result.num_pages > 1 && (
              <div className="mr-1 inline-flex rounded-lg bg-slate-100 p-0.5 text-[11px] font-semibold">
                <ScopeBtn label="This page" active={exportScope === 'page'} onClick={() => setExportScope('page')} />
                <ScopeBtn label="Whole doc" active={exportScope === 'doc'} onClick={() => setExportScope('doc')} />
              </div>
            )}

            {/* Tabular content → spreadsheet formats (only when tables exist). */}
            {targetHasTables && (
              <div className="flex items-center gap-1.5">
                <span className="text-[11px] font-medium uppercase tracking-wide text-slate-500">Tables</span>
                <ExportButton label="CSV" onClick={() => downloadDocumentCsvs(exportTarget, exportBase)} />
                <ExportButton label="XLSX" onClick={() => void downloadDocumentXlsx(exportTarget, exportBase)} />
              </div>
            )}

            {/* Prose content → document formats (only when text exists). */}
            {targetHasText && (
              <div className="flex items-center gap-1.5">
                <span className="text-[11px] font-medium uppercase tracking-wide text-slate-500">Text</span>
                <ExportButton label="Word" onClick={() => void downloadDocumentDocx(exportTarget, exportBase)} />
                <ExportButton label="TXT" onClick={() => downloadDocumentText(exportTarget, exportBase)} />
                <ExportButton label="HTML" onClick={() => downloadDocumentHtml(exportTarget, exportBase)} />
              </div>
            )}

            <ExportButton label="JSON" onClick={() => downloadDocumentJson(exportTarget, exportBase)} />
            <ExportButton label="ZIP (all)" onClick={() => void downloadAllFormatsAsZip(exportTarget, exportBase)} />
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
          label={`CSV Tables (${tableCount})`}
          onClick={() => onResultViewChange('csv')}
        />
      </div>

      {result && (
        <DocumentSearch
          result={result}
          onJump={(pi) => {
            onResultViewChange('preview');
            onPageChange(pi);
          }}
        />
      )}
      {result && <LowConfidencePanel result={result} />}

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
              // "Copy by page" → the current page only, in whichever form is on
              // screen (markdown for the Markdown view, plain text otherwise).
              void copyToClipboard(resultView === 'markdown' ? pageMarkdown : pageText);
            }}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-950 shadow-sm hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <CopyIcon className="h-4 w-4" />
            Page
          </button>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 pb-4">
        {resultView === 'markdown' ? (
          <div className="flex flex-wrap items-center gap-2">
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
            {markdownMode === 'preview' && result && result.num_pages > 1 && (
              <div className="inline-flex rounded-2xl bg-slate-100 p-0.5 text-sm font-semibold">
                <SubTab
                  active={mdScope === 'page'}
                  icon={<ImageIcon className="h-4 w-4" />}
                  label="This page"
                  onClick={() => setMdScope('page')}
                />
                <SubTab
                  active={mdScope === 'all'}
                  icon={<DocumentIcon className="h-4 w-4" />}
                  label="All pages"
                  onClick={() => setMdScope('all')}
                />
              </div>
            )}
          </div>
        ) : (
          // Preview has its own page controls inside PagePreview; CSV isn't
          // paged. Empty spacer keeps the Copy/Download buttons right-aligned.
          <div />
        )}

        <div className="flex items-center gap-2">
          {isEdited && resultView === 'markdown' && (
            <span
              className="rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700"
              title="Copy and .md/.txt use your edited markdown. CSV/XLSX/Word/HTML exports rebuild from the original extraction."
            >
              edited
            </span>
          )}
          <button
            type="button"
            disabled={!result}
            onClick={() => {
              if (resultView === 'markdown') {
                // Always the edited markdown — it's what the preview shows.
                void copyToClipboard(editedMarkdown);
              } else if (resultView === 'csv') {
                const csvTables = extractTableCells(result!);
                const csvText = csvTables.map((t) => [t.headers, ...t.rows].map((r) => r.join(',')).join('\n')).join('\n\n');
                void copyToClipboard(csvText || '');
              } else {
                void copyToClipboard(pageText);
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
              // .md download honors the user's edits (round-trip fix); CSV and
              // page-text paths are unedited structured/derived data.
              if (resultView === 'markdown') downloadText(`${filenameBase}.md`, editedMarkdown, 'text/markdown;charset=utf-8');
              else if (resultView === 'csv') downloadDocumentCsvs(result!, filenameBase);
              else downloadText(`${filenameBase}-page-${pageIndex + 1}.txt`, pageText);
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
        ) : resultView === 'markdown' ? (
          markdownMode === 'preview' ? (
            mdScope === 'page' && result.num_pages > 1 ? (
              <PagePreview
                imageUrl={imageUrl}
                alt={`Page ${currentPage?.page_number ?? pageIndex + 1}`}
                pageIndex={pageIndex}
                numPages={result.num_pages}
                onPageChange={onPageChange}
                outputLabel="Page Markdown"
                output={<MarkdownView source={pageMarkdown} maxHeight="none" showCopy={false} />}
              />
            ) : (
              <MarkdownView source={editedMarkdown} maxHeight="596px" showCopy={true} />
            )
          ) : (
            <textarea
              value={editedMarkdown}
              onChange={(e) => setEditedMarkdown(e.target.value)}
              className="max-h-[596px] min-h-[300px] w-full resize-y overflow-auto whitespace-pre-wrap rounded-lg border border-slate-200 bg-slate-50 p-4 font-mono text-xs leading-relaxed text-slate-800 focus:border-slate-400 focus:outline-none"
              spellCheck={false}
            />
          )
        ) : resultView === 'csv' ? (
          <CsvTablesView result={result} filenameBase={filenameBase} />
        ) : (
          <DocumentPreviewPane
            result={result}
            currentPage={currentPage}
            pageMarkdown={pageMarkdown}
            pageIndex={pageIndex}
            onPageChange={onPageChange}
            imageUrl={imageUrl}
          />
        )}
      </div>
    </section>
  );
}

function EmptyResults() {
  return (
    <div className="grid h-[520px] place-items-center rounded-lg border border-dashed border-slate-300 bg-slate-50 text-center">
      <div>
        <div className="text-sm font-semibold text-slate-950">No extraction yet</div>
        <p className="mt-1 text-sm text-slate-500">Upload a PDF or image, then extract selected pages.</p>
      </div>
    </div>
  );
}

function DocumentPreviewPane({
  result,
  currentPage,
  pageMarkdown,
  pageIndex,
  onPageChange,
  imageUrl,
}: {
  result: DocumentResult;
  currentPage: PageResult | null;
  pageMarkdown: string;
  pageIndex: number;
  onPageChange: (page: number) => void;
  imageUrl?: string;
}) {
  return (
    <PagePreview
      imageUrl={imageUrl}
      alt={`Page ${currentPage?.page_number ?? pageIndex + 1}`}
      pageIndex={pageIndex}
      numPages={result.num_pages}
      onPageChange={onPageChange}
      outputLabel="Page"
      // Render the page as markdown so tables/headings/lists format properly
      // next to the image instead of showing raw pipe text.
      output={
        currentPage ? (
          <MarkdownView source={pageMarkdown} maxHeight="none" showCopy={false} />
        ) : (
          <div className="text-slate-500">No page data.</div>
        )
      }
    />
  );
}

function CsvTablesView({ result, filenameBase }: { result: DocumentResult; filenameBase: string }) {
  const tables = extractTableCells(result);

  if (tables.length === 0) {
    return (
      <div className="grid h-[520px] place-items-center rounded-lg border border-dashed border-slate-300 bg-slate-50 text-sm text-slate-500">
        No parseable CSV tables were detected.
      </div>
    );
  }

  return (
    <div className="max-h-[596px] space-y-5 overflow-auto pr-1">
      {tables.map((table, index) => (
        <section key={index} className="overflow-hidden rounded-lg border border-slate-200 bg-white">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-slate-50 px-4 py-2">
            <h3 className="text-sm font-semibold text-slate-950">Table {index + 1}</h3>
            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-500">
                {table.rows.length} rows · {table.headers.length} columns
              </span>
              <div className="flex items-center gap-1">
                <TableChip label="CSV" onClick={() => downloadSingleTableCsv(table, `${filenameBase}-table${index + 1}`)} />
                <TableChip label="XLSX" onClick={() => void downloadSingleTableXlsx(table, `${filenameBase}-table${index + 1}`)} />
                <TableChip label="Copy TSV" onClick={() => void copyToClipboard(tableToTsv(table))} />
              </div>
            </div>
          </div>
          <div className="overflow-auto">
            <table className="min-w-full border-collapse text-sm">
              <thead>
                <tr>
                  {table.headers.map((header, headerIndex) => (
                    <th
                      key={headerIndex}
                      className="border-b border-r border-slate-200 bg-slate-100 px-3 py-2 text-left font-semibold text-slate-950 last:border-r-0"
                    >
                      {header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {table.rows.map((row, rowIndex) => (
                  <tr key={rowIndex} className="odd:bg-white even:bg-slate-50">
                    {table.headers.map((_, colIndex) => (
                      <td
                        key={colIndex}
                        className="border-b border-r border-slate-200 px-3 py-2 align-top text-slate-800 last:border-r-0"
                      >
                        {row[colIndex] ?? ''}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
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

function TableChip({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] font-semibold text-slate-700 shadow-sm hover:bg-slate-50"
    >
      {label}
    </button>
  );
}

function ScopeBtn({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-lg px-2.5 py-1 transition-colors ${
        active ? 'bg-white text-slate-950 shadow-sm' : 'text-slate-600 hover:bg-white/60'
      }`}
    >
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

function fileKey(f: File): string {
  return `${f.name}|${f.size}|${f.lastModified}`;
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-z0-9._-]+/gi, '_').slice(0, 80);
}

/** Compact "big number" chip — value first, tiny label after (data as hero). */
function HeroStat({ value, label, tone }: { value: string; label: string; tone?: 'good' | 'warn' }) {
  const toneCls = tone === 'good' ? 'text-emerald-600' : tone === 'warn' ? 'text-amber-600' : 'text-slate-950';
  return (
    <span className="inline-flex items-baseline gap-1 rounded-full border border-slate-200 bg-white/70 px-2.5 py-1">
      <span className={`text-sm font-semibold leading-none ${toneCls}`}>{value}</span>
      <span className="text-[9px] font-medium uppercase tracking-wider text-slate-500">{label}</span>
    </span>
  );
}

function pageToPlainText(page: PageResult): string {
  return page.regions
    .map((region) => (region.text ?? '').trim())
    .filter(Boolean)
    .join('\n\n');
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
