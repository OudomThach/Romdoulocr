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
import { useBatchProcessor } from '@/hooks/useBatchProcessor';
import { useHistoryAutoSave } from '@/hooks/useHistoryAutoSave';
import { usePagePreviews } from '@/hooks/usePagePreviews';
import { usePdfPageSelection } from '@/hooks/usePdfPageSelection';
import { pageToMarkdown, resultToMarkdown } from '@/lib/exporters';
import {
  countDocumentTables,
  documentHasText,
  downloadAllFormatsAsZip,
  downloadDocumentCsvs,
  downloadDocumentDocx,
  downloadDocumentHtml,
  downloadDocumentJson,
  downloadDocumentMarkdown,
  downloadDocumentText,
  downloadDocumentXlsx,
  downloadSingleTableCsv,
  downloadSingleTableXlsx,
  extractTableCells,
  singlePageDocument,
  tableToTsv,
} from '@/lib/documentExport';
import { getPdfPageCount, imageFileToThumbnail, renderPdfPages, renderPdfThumbnails } from '@/lib/pdfProcessing';
import { processImage } from '@/lib/imageProcessing';
import { copyToClipboard, downloadText, isImage, isPdf } from '@/lib/utils';
import { api } from '@/lib/api';
import { useSettingsStore } from '@/hooks/useSettingsStore';
import { preprocessOpts, rasterFor } from '@/lib/extractionConfig';
import { mergeFullPageText } from '@/lib/mergeFullPage';
import { ExtractionSettingsCard } from '@/components/ExtractionSettingsCard';
import type { DocumentResult, PageResult } from '@/types/api';

interface PreparedFile {
  id: string;
  source: File;
  pages: File[];
  totalPages: number;
}

type ResultView = 'preview' | 'markdown' | 'csv';
type MarkdownMode = 'preview' | 'source';

export function TranslatedTab() {
  const [files, setFiles] = useState<File[]>([]);
  const [sourceLang, setSourceLang] = useState('km');
  const [targetLang, setTargetLang] = useState('en');
  const [detectLayout, setDetectLayout] = useState(true);
  const [detectLines, setDetectLines] = useState(true);
  const useCtc = useSettingsStore((s) => s.translated.useCtc);
  const setTranslated = useSettingsStore((s) => s.setTranslated);
  const extraction = useSettingsStore((s) => s.extraction);
  const setExtraction = useSettingsStore((s) => s.setExtraction);
  const [progress, setProgress] = useState<number | null>(null);
  const [pageInResult, setPageInResult] = useState(0);
  const [resultView, setResultView] = useState<ResultView>('preview');
  const [markdownMode, setMarkdownMode] = useState<MarkdownMode>('preview');
  const [bilingual, setBilingual] = useState(false);

  const { pageSelections, pageThumbnails, thumbLoading, onPageSelectionChange } =
    usePdfPageSelection(files, fileKey);

  const [prepared, setPrepared] = useState<PreparedFile[]>([]);
  const [preparingMsg, setPreparingMsg] = useState<string | null>(null);
  const [pdfError, setPdfError] = useState<string | null>(null);

  const previewUrl = useMemo(() => {
    if (files.length !== 1) return undefined;
    const f = files[0];
    if (isImage(f.name)) return URL.createObjectURL(f);
    return undefined;
  }, [files]);
  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);

  const batch = useBatchProcessor<
    {
      fileKey: string;
      files: File[];
      sourceLang: string;
      targetLang: string;
      detectLayout: boolean;
      detectLines: boolean;
      useCtc: boolean;
      fullPageOcr: boolean;
      sourcePages: number[];
    },
    DocumentResult
  >({
    concurrency: 2,
    run: async (args, signal) => {
      const a = args as {
        files: File[];
        sourceLang: string;
        targetLang: string;
        detectLayout: boolean;
        detectLines: boolean;
        useCtc: boolean;
        fullPageOcr: boolean;
      };
      const primary = await api.parsePdfTranslated(
        a.files,
        { sourceLang: a.sourceLang, targetLang: a.targetLang, detectLayout: a.detectLayout, detectLines: a.detectLines, useCtc: a.useCtc },
        { signal, onProgress: setProgress },
      );
      if (!a.fullPageOcr) return primary;
      // Whole-page pass (no layout gating) to recover text the boxes missed.
      try {
        const full = await api.parsePdfTranslated(
          a.files,
          { sourceLang: a.sourceLang, targetLang: a.targetLang, detectLayout: false, detectLines: a.detectLines, useCtc: a.useCtc },
          { signal },
        );
        return mergeFullPageText(primary, full);
      } catch {
        return primary;
      }
    },
  });

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
            if (u) out[i + 1] = u;
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
    'translated',
    batch,
    prepared,
    { sourceLang, targetLang, detectLayout, detectLines, useCtc, concurrency: 2 },
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
      if (!cancelled) setPrepared(out);
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
      batch.items.filter((it) => it.status === 'done').map((it) => (it.args as { fileKey: string }).fileKey),
    );

    try {
      const items: {
        fileKey: string;
        files: File[];
        sourceLang: string;
        targetLang: string;
        detectLayout: boolean;
        detectLines: boolean;
        useCtc: boolean;
        fullPageOcr: boolean;
        sourcePages: number[];
      }[] = [];
      for (const p of prepared) {
        if (isPdf(p.source.name)) {
          const key = fileKey(p.source);
          if (doneKeys.has(key)) continue;
          const selectedPages = pageSelections[key] ?? Array.from({ length: p.totalPages }, (_, i) => i + 1);
          const pages = selectedPages.length > 0 ? selectedPages : Array.from({ length: p.totalPages }, (_, i) => i + 1);
          if (pages.length === 0) {
            setPdfError(`No pages selected for ${p.source.name}`);
            setPreparingMsg(null);
            return;
          }
          setPreparingMsg(`Rasterizing ${p.source.name} (${pages.length} pages)...`);
          const rendered = await renderPdfPages(p.source, pages, rasterFor(extraction.highRes).dpi);
          items.push({
            fileKey: key,
            files: rendered.map((r) => r.file),
            sourceLang,
            targetLang,
            detectLayout,
            detectLines,
            useCtc,
            fullPageOcr: extraction.fullPageOcr,
            // Real source page numbers so the preview maps result→source page
            // correctly when only a subset is extracted.
            sourcePages: rendered.map((r) => r.pageNumber),
          });
        } else {
          if (doneKeys.has(p.id)) continue;
          setPreparingMsg(`Preprocessing ${p.source.name}...`);
          const processed = await Promise.all(p.pages.map((f) => processImage(f, preprocessOpts(extraction.highRes))));
          items.push({
            fileKey: p.id,
            files: processed,
            sourceLang,
            targetLang,
            detectLayout,
            detectLines,
            useCtc,
            fullPageOcr: extraction.fullPageOcr,
            sourcePages: p.pages.map((_, i) => i + 1),
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
      setPdfError(e instanceof Error ? e.message : 'Rasterization failed');
    }
  };

  const isActiveTab = useSettingsStore((s) => s.activeTab === 'translated');
  useKeyboardShortcuts({ onSubmit, onCancel: () => batch.cancel(), enabled: isActiveTab });

  const currentResultItem = useMemo(() => {
    const doneItems = batch.items.filter((it) => it.status === 'done' && it.result);
    if (doneItems.length > 0) return doneItems[doneItems.length - 1];
    return batch.items.find((it) => it.result) ?? null;
  }, [batch.items]);

  const currentResult = currentResultItem?.result ?? null;
  const currentResultKey = currentResultItem ? (currentResultItem.args as { fileKey: string }).fileKey : null;
  const currentPrep = currentResultKey ? prepared.find((p) => p.id === currentResultKey) : null;

  const pageIdx = currentResult
    ? Math.min(Math.max(0, pageInResult), currentResult.pages.length - 1)
    : 0;
  const currentPage = useMemo(() => {
    if (!currentResult || currentResult.pages.length === 0) return null;
    return currentResult.pages[pageIdx];
  }, [currentResult, pageIdx]);

  // Real source page numbers extracted, in result order (see DocumentParserTab).
  const currentSourcePages = useMemo(
    () => (currentResultItem?.args as { sourcePages?: number[] } | undefined)?.sourcePages ?? [],
    [currentResultItem],
  );

  useEffect(() => {
    // Keep the user's chosen view across extractions; only reset the page.
    setPageInResult(0);
  }, [currentResult?.filename]);

  const translatedMarkdown = useMemo(
    () => (currentResult ? resultToMarkdown(currentResult, { translated: true }) : ''),
    [currentResult],
  );
  const bilingualMarkdown = useMemo(() => {
    if (!currentResult) return '';
    return `${resultToMarkdown(currentResult)}\n\n---\n\n${resultToMarkdown(currentResult, { translated: true })}`;
  }, [currentResult]);
  const markdownSource = bilingual ? bilingualMarkdown : translatedMarkdown;

  const currentIsPdf = currentPrep?.source?.name.toLowerCase().endsWith('.pdf') ?? false;
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
      const srcPage = currentSourcePages[pageIdx] ?? currentPage.page_number;
      return currentPagePreviews.get(srcPage);
    }
    if (currentPrep?.pages?.[0]) return URL.createObjectURL(currentPrep.pages[0]);
    return previewUrl;
  }, [currentResult, currentIsPdf, currentPage, pageIdx, currentSourcePages, currentPagePreviews, currentPrep, previewUrl]);
  useEffect(() => () => {
    if (effectivePagePreview?.startsWith('blob:') && effectivePagePreview !== previewUrl) {
      URL.revokeObjectURL(effectivePagePreview);
    }
  }, [effectivePagePreview, previewUrl]);

  const translatedFullText = useMemo(() => {
    if (!currentResult) return '';
    return (
      currentResult.translated_text ??
      currentResult.pages
        .map(
          (p) =>
            `--- Page ${p.page_number} ---\n` +
            p.regions.map((r) => r.english_text || r.text).filter(Boolean).join('\n'),
        )
        .join('\n\n')
    );
  }, [currentResult]);

  const tableCount = currentResult ? countDocumentTables(currentResult) : 0;

  return (
    <div className="min-h-[calc(100vh-116px)] text-slate-950">
      <div className="grid gap-6 lg:grid-cols-[minmax(360px,420px)_minmax(0,1fr)]">
        <div className="grid min-w-0 grid-cols-1 content-start gap-6">
          <UploadCard
            files={files}
            onFilesChange={setFiles}
            disabled={batch.isRunning}
            isRunning={batch.isRunning}
            hasResult={!!currentResult}
            filename={currentResult?.filename}
            sourceLang={sourceLang}
            targetLang={targetLang}
            preparingMsg={preparingMsg}
            onCopyTranslation={() => void copyToClipboard(translatedFullText)}
          />
          <LanguageCard
            sourceLang={sourceLang}
            targetLang={targetLang}
            onSourceChange={setSourceLang}
            onTargetChange={setTargetLang}
            detectLayout={detectLayout}
            detectLines={detectLines}
            onDetectLayoutChange={setDetectLayout}
            onDetectLinesChange={setDetectLines}
            useCtc={useCtc}
            onUseCtcChange={(v) => setTranslated({ useCtc: v })}
            disabled={batch.isRunning}
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
          <ExtractionResultsCard
            result={currentResult}
            currentPage={currentPage}
            pageIndex={pageInResult}
            onPageChange={setPageInResult}
            imageUrl={effectivePagePreview}
            markdownSource={markdownSource}
            translatedFullText={translatedFullText}
            bilingual={bilingual}
            onBilingualChange={setBilingual}
            resultView={resultView}
            onResultViewChange={setResultView}
            markdownMode={markdownMode}
            onMarkdownModeChange={setMarkdownMode}
            sourceLang={sourceLang}
            targetLang={targetLang}
            tableCount={tableCount}
          />
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
              `Parse + translate ${selected} selected page${selected === 1 ? '' : 's'}`
            }
            runningLabel="Preparing translation..."
            emptyTitle="No translation yet"
            emptyDescription="Upload a PDF or image, then select the pages to translate."
            readyDescription="File uploaded successfully. Click below to convert to Markdown and translate."
          />
        )}
      </div>

      <div className="mt-4 grid gap-2">
        {preparingMsg && <ProgressBar value={null} label={preparingMsg} />}
        {pdfError && <ErrorBanner error={new Error(pdfError)} />}
        {batch.isRunning &&
          (batch.progress.active <= 1 && progress !== null ? (
            <ProgressBar value={progress} label="Uploading to API..." />
          ) : (
            <ProgressBar value={null} label={`Translating ${batch.progress.active} files... (${batch.progress.done} done)`} />
          ))}
        {batch.hasErrors && batch.items.some((it) => it.status === 'error' && it.error) && (
          <ErrorBanner error={batch.items.find((it) => it.status === 'error' && it.error)?.error} />
        )}
      </div>
    </div>
  );
}

function UploadCard({
  files,
  onFilesChange,
  disabled,
  isRunning,
  hasResult,
  filename,
  sourceLang,
  targetLang,
  preparingMsg,
  onCopyTranslation,
}: {
  files: File[];
  onFilesChange: (files: File[]) => void;
  disabled: boolean;
  isRunning: boolean;
  hasResult: boolean;
  filename?: string;
  sourceLang: string;
  targetLang: string;
  preparingMsg: string | null;
  onCopyTranslation: () => void;
}) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <h2 className="mb-5 text-lg font-semibold tracking-tight text-slate-950">Upload Document</h2>
      <FileDropzone multiple accept="pdf-or-image" files={files} onChange={onFilesChange} disabled={disabled} />

      {(files.length > 0 || hasResult || isRunning || preparingMsg) && (
        <div className="mt-4 rounded-lg border border-slate-300 bg-slate-100 px-4 py-4 text-sm text-slate-700">
          {hasResult ? (
            <>
              <div className="font-semibold text-slate-950">&#10003; Translation Complete</div>
              <div className="mt-2 space-y-1 break-all text-xs">
                <div>&bull; Source: {filename ?? 'document'}</div>
                <div>
                  &bull; {sourceLang} &rarr; {targetLang}
                </div>
              </div>
              <button
                type="button"
                onClick={onCopyTranslation}
                className="mt-3 inline-flex items-center gap-1.5 rounded bg-slate-950 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-slate-800"
              >
                <CopyIcon className="h-3.5 w-3.5" />
                Copy Translation
              </button>
            </>
          ) : (
            <>
              <div className="font-semibold text-slate-950">
                {isRunning ? 'Translating document...' : preparingMsg ? 'Preparing file...' : 'Ready to translate'}
              </div>
              <div className="mt-1 text-xs text-slate-600">
                {preparingMsg ?? `${files.length} file${files.length === 1 ? '' : 's'} selected · ${sourceLang} → ${targetLang}`}
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}

function LanguageCard({
  sourceLang,
  targetLang,
  onSourceChange,
  onTargetChange,
  detectLayout,
  detectLines,
  onDetectLayoutChange,
  onDetectLinesChange,
  useCtc,
  onUseCtcChange,
  disabled,
}: {
  sourceLang: string;
  targetLang: string;
  onSourceChange: (v: string) => void;
  onTargetChange: (v: string) => void;
  detectLayout: boolean;
  detectLines: boolean;
  onDetectLayoutChange: (v: boolean) => void;
  onDetectLinesChange: (v: boolean) => void;
  useCtc: boolean;
  onUseCtcChange: (v: boolean) => void;
  disabled: boolean;
}) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <h2 className="mb-4 text-sm font-semibold text-slate-950">Translation Settings</h2>
      <div className="grid gap-4 text-sm text-slate-700">
        <div className="grid grid-cols-2 gap-3">
          <label>
            <span className="block font-medium text-slate-950">Source</span>
            <input
              value={sourceLang}
              onChange={(e) => onSourceChange(e.target.value.trim())}
              className="input mt-2"
              spellCheck={false}
              disabled={disabled}
            />
          </label>
          <label>
            <span className="block font-medium text-slate-950">Target</span>
            <input
              value={targetLang}
              onChange={(e) => onTargetChange(e.target.value.trim())}
              className="input mt-2"
              spellCheck={false}
              disabled={disabled}
            />
          </label>
        </div>
        <ToggleRow label="Detect layout regions" checked={detectLayout} onChange={onDetectLayoutChange} disabled={disabled} />
        <ToggleRow label="Detect lines" checked={detectLines} onChange={onDetectLinesChange} disabled={disabled} />
        <ToggleRow label="Use CTC decoder" checked={useCtc} onChange={onUseCtcChange} disabled={disabled} />
      </div>
    </section>
  );
}

function ToggleRow({
  label,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
      <span className="font-medium text-slate-950">{label}</span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        disabled={disabled}
        className="h-4 w-4 rounded border-slate-300 text-slate-950 focus:ring-slate-400"
      />
    </label>
  );
}

function HowToUseCard() {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <h2 className="mb-4 text-sm font-semibold text-slate-950">How to Use</h2>
      <ol className="space-y-3 text-sm text-slate-600">
        <li>1. Upload a PDF or image file</li>
        <li>2. Set source and target languages</li>
        <li>3. Click "Parse + Translate"</li>
        <li>4. Copy or download the translation</li>
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
  translatedFullText,
  bilingual,
  onBilingualChange,
  resultView,
  onResultViewChange,
  markdownMode,
  onMarkdownModeChange,
  sourceLang,
  targetLang,
  tableCount,
}: {
  result: DocumentResult | null;
  currentPage: PageResult | null;
  pageIndex: number;
  onPageChange: (page: number) => void;
  imageUrl?: string;
  markdownSource: string;
  translatedFullText: string;
  bilingual: boolean;
  onBilingualChange: (v: boolean) => void;
  resultView: ResultView;
  onResultViewChange: (view: ResultView) => void;
  markdownMode: MarkdownMode;
  onMarkdownModeChange: (mode: MarkdownMode) => void;
  sourceLang: string;
  targetLang: string;
  tableCount: number;
}) {
  const [editedMarkdown, setEditedMarkdown] = useState(markdownSource);
  const [exportScope, setExportScope] = useState<'page' | 'doc'>('doc');
  const filenameBase = result ? `${sanitizeFilename(result.filename.replace(/\.[^.]+$/, ''))}-translated` : 'translated';

  // Translated markdown for just the page on screen (tables/headings formatted).
  const pageMarkdown = useMemo(
    () => (result && currentPage ? pageToMarkdown(result, currentPage.page_number, { translated: true }) : ''),
    [result, currentPage],
  );

  // Content-aware, scope-aware export target (mirrors Parse Document).
  const exportTarget = useMemo(() => {
    if (!result) return null;
    return exportScope === 'page' && currentPage
      ? singlePageDocument(result, currentPage.page_number)
      : result;
  }, [result, exportScope, currentPage]);
  const exportBase = exportScope === 'page' && currentPage ? `${filenameBase}-page-${currentPage.page_number}` : filenameBase;
  const targetHasTables = exportTarget ? countDocumentTables(exportTarget) > 0 : false;
  const targetHasText = exportTarget ? documentHasText(exportTarget) : false;

  useEffect(() => {
    setEditedMarkdown(markdownSource);
  }, [markdownSource]);

  return (
    <section className="flex min-h-[720px] flex-col rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-slate-950">Translation Results</h2>
          <p className="truncate text-sm text-slate-500">
            {result ? `${result.filename} · ${sourceLang} → ${targetLang}` : 'Upload a file to see the translation'}
          </p>
        </div>
        {result && exportTarget && (
          <div className="flex flex-wrap items-center gap-2">
            {result.num_pages > 1 && (
              <div className="mr-1 inline-flex rounded-lg bg-slate-100 p-0.5 text-[11px] font-semibold">
                <ScopeBtn label="This page" active={exportScope === 'page'} onClick={() => setExportScope('page')} />
                <ScopeBtn label="Whole doc" active={exportScope === 'doc'} onClick={() => setExportScope('doc')} />
              </div>
            )}
            {targetHasTables && (
              <div className="flex items-center gap-1.5">
                <span className="text-[11px] font-medium uppercase tracking-wide text-slate-500">Tables</span>
                <ExportButton label="CSV" onClick={() => downloadDocumentCsvs(exportTarget, exportBase)} />
                <ExportButton label="XLSX" onClick={() => void downloadDocumentXlsx(exportTarget, exportBase)} />
              </div>
            )}
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
        aria-label="Translation result view"
        className="mt-8 inline-flex w-fit rounded-2xl bg-slate-100 p-0.5 text-sm font-semibold text-slate-950"
      >
        <ResultTab active={resultView === 'preview'} icon={<ImageIcon className="h-4 w-4" />} label="Preview" onClick={() => onResultViewChange('preview')} />
        <ResultTab active={resultView === 'markdown'} icon={<DocumentIcon className="h-4 w-4" />} label="Translation" onClick={() => onResultViewChange('markdown')} />
        <ResultTab active={resultView === 'csv'} icon={<GridIcon className="h-4 w-4" />} label={`CSV Tables (${tableCount})`} onClick={() => onResultViewChange('csv')} />
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
            <div className="text-sm font-semibold text-slate-950">Copy translation</div>
            <div className="text-xs text-slate-500">Copy the full translated text in one click.</div>
          </div>
          <button
            type="button"
            disabled={!result}
            onClick={() => void copyToClipboard(translatedFullText)}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-950 shadow-sm hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <CopyIcon className="h-4 w-4" />
            Document
          </button>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 pb-4">
        {resultView === 'markdown' ? (
          <div className="flex flex-wrap items-center gap-3">
            <div className="inline-flex rounded-2xl bg-slate-100 p-0.5 text-sm font-semibold">
              <SubTab active={markdownMode === 'preview'} icon={<EyeIcon className="h-4 w-4" />} label="Preview" onClick={() => onMarkdownModeChange('preview')} />
              <SubTab active={markdownMode === 'source'} icon={<EditIcon className="h-4 w-4" />} label="Source" onClick={() => onMarkdownModeChange('source')} />
            </div>
            <label className="inline-flex cursor-pointer items-center gap-2 text-xs font-medium text-slate-600">
              <input
                type="checkbox"
                checked={bilingual}
                onChange={(e) => onBilingualChange(e.target.checked)}
                className="h-4 w-4 rounded border-slate-300 text-slate-950 focus:ring-slate-400"
              />
              Bilingual (original + translation)
            </label>
          </div>
        ) : (
          // Preview has its own page controls; CSV isn't paged.
          <div />
        )}

        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={!result}
            onClick={() => {
              if (resultView === 'markdown') void copyToClipboard(markdownMode === 'source' ? editedMarkdown : markdownSource);
              else if (resultView === 'csv') {
                const csvTables = extractTableCells(result!);
                void copyToClipboard(csvTables.map((t) => [t.headers, ...t.rows].map((r) => r.join(',')).join('\n')).join('\n\n'));
              } else void copyToClipboard(translatedFullText);
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
              if (resultView === 'markdown') downloadText(`${filenameBase}.md`, markdownSource, 'text/markdown;charset=utf-8');
              else if (resultView === 'csv') downloadDocumentCsvs(result!, filenameBase);
              else downloadDocumentMarkdown(result!, filenameBase);
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
            <MarkdownView source={editedMarkdown} maxHeight="596px" showCopy={true} />
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
          <PreviewPane result={result} currentPage={currentPage} pageMarkdown={pageMarkdown} pageIndex={pageIndex} onPageChange={onPageChange} imageUrl={imageUrl} />
        )}
      </div>
    </section>
  );
}

function PreviewPane({
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
      outputLabel="Translated Page"
      // Render the translated page as markdown so tables/headings format
      // properly beside the image (parity with Parse Document).
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
                      <td key={colIndex} className="border-b border-r border-slate-200 px-3 py-2 align-top text-slate-800 last:border-r-0">
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

function EmptyResults() {
  return (
    <div className="grid h-[520px] place-items-center rounded-lg border border-dashed border-slate-300 bg-slate-50 text-center">
      <div>
        <div className="text-sm font-semibold text-slate-950">No translation yet</div>
        <p className="mt-1 text-sm text-slate-500">Upload a PDF or image, then click Parse + Translate.</p>
      </div>
    </div>
  );
}

function ResultTab({ active, icon, label, onClick }: { active: boolean; icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`inline-flex items-center gap-2 rounded-2xl px-7 py-2 transition-colors ${active ? 'bg-white shadow-sm' : 'text-slate-700 hover:bg-white/60'}`}
    >
      {icon}
      {label}
    </button>
  );
}

function SubTab({ active, icon, label, onClick }: { active: boolean; icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-2 rounded-2xl px-3 py-1.5 transition-colors ${active ? 'bg-white shadow-sm' : 'text-slate-700 hover:bg-white/60'}`}
    >
      {icon}
      {label}
    </button>
  );
}

function ExportButton({ label, onClick, disabled }: { label: string; onClick: () => void; disabled?: boolean }) {
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
