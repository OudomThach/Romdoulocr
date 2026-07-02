import { useEffect, useMemo, useState } from 'react';
import { ErrorBanner } from '@/components/ErrorBanner';
import { DocumentScanner } from '@/components/DocumentScanner';
import { FileDropzone } from '@/components/FileDropzone';
import { FileReadyPanel } from '@/components/FileReadyPanel';
import { PagePreview } from '@/components/PagePreview';
import { ProgressBar } from '@/components/ProgressBar';
import { SettingToggle } from '@/components/ExtractionSettingsCard';
import { useBatchProcessor } from '@/hooks/useBatchProcessor';
import { useHistoryAutoSave } from '@/hooks/useHistoryAutoSave';
import { usePdfPageSelection } from '@/hooks/usePdfPageSelection';
import { api } from '@/lib/api';
import { getPdfPageCount, renderPdfPages } from '@/lib/pdfProcessing';
import { copyToClipboard, isPdf } from '@/lib/utils';
import { ResultsToolbar } from '@/components/ResultsToolbar';
import { processImage } from '@/lib/imageProcessing';
import { useSettingsStore } from '@/hooks/useSettingsStore';
import { preprocessOpts, rasterFor } from '@/lib/extractionConfig';
import { ExtractionSettingsCard } from '@/components/ExtractionSettingsCard';
import type { OcrImageResponse } from '@/types/api';
import { normalizeOcrResponse } from '@/types/api';

interface PreparedFile {
  id: string;
  source: File;
  totalPages: number;
}

export function OcrImageTab() {
  const [files, setFiles] = useState<File[]>([]);
  const extraction = useSettingsStore((s) => s.extraction);
  const setExtraction = useSettingsStore((s) => s.setExtraction);
  const useCtc = useSettingsStore((s) => s.ocr.useCtc);
  const setOcr = useSettingsStore((s) => s.setOcr);
  const [prepared, setPrepared] = useState<PreparedFile[]>([]);
  const [pdfError, setPdfError] = useState<string | null>(null);
  const [preparingMsg, setPreparingMsg] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  // File currently open in the CamScanner-style crop modal (single image only).
  const [scanFile, setScanFile] = useState<File | null>(null);

  const singleImage = files.length === 1 && !isPdf(files[0].name);

  const { pageSelections, pageThumbnails, thumbLoading, onPageSelectionChange } =
    usePdfPageSelection(files, fileKey);

  useEffect(() => {
    let cancelled = false;
    setPdfError(null);
    if (files.length === 0) { setPrepared([]); return; }
    (async () => {
      const out: PreparedFile[] = [];
      for (const f of files) {
        if (cancelled) return;
        const key = fileKey(f);
        if (isPdf(f.name)) {
          try {
            const totalPages = await getPdfPageCount(f);
            if (cancelled) return;
            out.push({ id: key, source: f, totalPages });
          } catch (e) {
            if (cancelled) return;
            setPdfError(`${f.name}: ${e instanceof Error ? e.message : 'PDF read failed'}`);
            out.push({ id: key, source: f, totalPages: 1 });
          }
        } else {
          out.push({ id: key, source: f, totalPages: 1 });
        }
      }
      if (!cancelled) setPrepared(out);
    })();
    return () => { cancelled = true; };
  }, [files]);

  const batch = useBatchProcessor<
    { fileKey: string; file: File; useCtc: boolean },
    OcrImageResponse
  >({
    concurrency: 2,
    run: async (args, signal) => {
      const a = args as { file: File; useCtc: boolean };
      const raw = await api.ocrImage(a.file, { useCtc: a.useCtc }, { signal, onProgress: setProgress });
      return normalizeOcrResponse(raw as unknown ?? raw);
    },
  });

  useHistoryAutoSave<PreparedFile>('ocr', batch, prepared, { useCtc, concurrency: 2 });

  const onSubmit = async () => {
    if (prepared.length === 0) return;
    setProgress(0);
    setPreparingMsg('Preparing files...');
    const doneKeys = new Set(
      batch.items.filter((it) => it.status === 'done').map((it) => (it.args as { fileKey: string }).fileKey),
    );
    try {
      const items: { fileKey: string; file: File; useCtc: boolean }[] = [];
      for (const p of prepared) {
        if (isPdf(p.source.name)) {
          const key = fileKey(p.source);
          const selected = pageSelections[key] ?? Array.from({ length: p.totalPages }, (_, i) => i + 1);
          const pages = selected.length > 0 ? selected : Array.from({ length: p.totalPages }, (_, i) => i + 1);
          if (pages.length === 0) { setPdfError(`No pages selected for ${p.source.name}`); setPreparingMsg(null); return; }
          setPreparingMsg(`Rasterizing ${p.source.name} (${pages.length} pages)...`);
          const rendered = await renderPdfPages(p.source, pages, rasterFor(extraction.highRes).dpi);
          for (let pi = 0; pi < rendered.length; pi++) {
            const idx = pages.length > 1 ? `${key}-p${pi + 1}` : key;
            if (!doneKeys.has(idx)) items.push({ fileKey: idx, file: rendered[pi].file, useCtc });
          }
        } else {
          if (!doneKeys.has(p.id)) {
            setPreparingMsg(`Preprocessing ${p.source.name}...`);
            const processed = await processImage(p.source, preprocessOpts(extraction.highRes));
            items.push({ fileKey: p.id, file: processed, useCtc });
          }
        }
      }
      if (items.length === 0) { setPreparingMsg(null); return; }
      batch.enqueueMany(items);
      setPreparingMsg(null);
    } catch (e) {
      setPreparingMsg(null);
      setPdfError(e instanceof Error ? e.message : 'Rasterization failed');
    }
  };

  // Each OCR'd page is its own batch item. Track which one is shown so the
  // user can page through them with the same prev/next controls as the
  // other tabs.
  const doneItems = useMemo(
    () => batch.items.filter((it) => it.status === 'done' && it.result),
    [batch.items],
  );
  const [ocrIndex, setOcrIndex] = useState(0);
  // New batch of results → jump to the latest page.
  useEffect(() => {
    if (doneItems.length > 0) setOcrIndex(doneItems.length - 1);
  }, [doneItems.length]);
  const safeOcrIndex = Math.min(Math.max(0, ocrIndex), Math.max(0, doneItems.length - 1));
  const currentResultItem = doneItems[safeOcrIndex] ?? batch.items.find((it) => it.result) ?? null;

  const currentResult = currentResultItem?.result ?? null;
  const cleanText = currentResult?.text ?? '';

  // Source image for the page currently shown (the rasterized/processed file
  // that was sent to OCR), revoked when it changes to avoid leaks.
  const currentImageUrl = useMemo(() => {
    const f = (currentResultItem?.args as { file?: File } | undefined)?.file;
    return f ? URL.createObjectURL(f) : undefined;
  }, [currentResultItem]);
  useEffect(() => {
    return () => {
      if (currentImageUrl) URL.revokeObjectURL(currentImageUrl);
    };
  }, [currentImageUrl]);

  return (
    <div className="min-h-[calc(100vh-116px)] text-slate-950">
      <div className="grid gap-6 lg:grid-cols-[minmax(360px,420px)_minmax(0,1fr)]">
        <div className="grid min-w-0 grid-cols-1 content-start gap-6">
          <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <h2 className="mb-5 text-lg font-semibold tracking-tight text-slate-950">Upload Image</h2>
            <FileDropzone
              multiple
              accept="pdf-or-image"
              files={files}
              onChange={setFiles}
              disabled={batch.isRunning}
            />
            {singleImage && !currentResult && !batch.isRunning && (
              <button
                type="button"
                onClick={() => setScanFile(files[0])}
                className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm font-semibold text-slate-950 shadow-sm hover:bg-slate-50"
              >
                <CameraIcon className="h-4 w-4" />
                Scan document — auto-crop, de-skew &amp; clean
              </button>
            )}
            {(files.length > 0 || !!currentResult || batch.isRunning) && (
              <div className="mt-4 rounded-lg border border-slate-300 bg-slate-100 px-4 py-4 text-sm text-slate-700">
                {currentResult ? (
                  <>
                    <div className="font-semibold text-slate-950">&#10003; OCR Complete</div>
                    <div className="mt-2 space-y-1 text-xs">
                      {/* /ocr-image doesn't return a confidence; only show it
                          when the value is real (>0) to avoid a bogus "0%". */}
                      {currentResult.confidence > 0 && (
                        <div>&bull; Confidence: {Math.round(currentResult.confidence * 100)}%</div>
                      )}
                      <div>&bull; Decoder: {currentResult.decoder ?? 'ctc'}</div>
                    </div>
                    <button
                      type="button"
                      onClick={() => { void copyToClipboard(cleanText); }}
                      className="mt-3 inline-flex items-center gap-1.5 rounded bg-slate-950 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-slate-800"
                    >
                      <CopyIcon className="h-3.5 w-3.5" />
                      Copy Clean Text
                    </button>
                  </>
                ) : (
                  <>
                    <div className="font-semibold text-slate-950">
                      {batch.isRunning ? 'Running OCR...' : preparingMsg ? 'Preparing file...' : 'Ready to run OCR'}
                    </div>
                    <div className="mt-1 text-xs text-slate-600">
                      {preparingMsg ?? `${files.length} file${files.length === 1 ? '' : 's'} selected`}
                    </div>
                  </>
                )}
              </div>
            )}
          </section>

          <ExtractionSettingsCard
            highRes={extraction.highRes}
            fullPageOcr={extraction.fullPageOcr}
            onHighResChange={(v) => setExtraction({ highRes: v })}
            onFullPageOcrChange={(v) => setExtraction({ fullPageOcr: v })}
            disabled={batch.isRunning}
            showFullPage={false}
          />

          <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <h2 className="mb-1 text-sm font-semibold text-slate-950">Decoder</h2>
            <p className="mb-4 text-xs text-slate-500">CTC is recommended for Khmer. Turn off to use the autoregressive decoder.</p>
            <SettingToggle
              label="Use CTC decoder"
              hint="On = faster, fewer repetition loops"
              checked={useCtc}
              onChange={(v) => setOcr({ useCtc: v })}
              disabled={batch.isRunning}
            />
          </section>

          <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <h2 className="mb-4 text-sm font-semibold text-slate-950">How to Use</h2>
            <ol className="space-y-3 text-sm text-slate-600">
              <li>1. Upload a PDF or image file</li>
              <li>2. Click "Run OCR" button</li>
              <li>3. View extracted text and copy or download</li>
            </ol>
          </section>
        </div>

        {currentResult ? (
          <section className="flex min-h-[720px] flex-col rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <header className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0">
                <h2 className="text-base font-semibold text-slate-950">OCR Result</h2>
                <p className="truncate text-sm text-slate-500">{currentResult.filename ?? 'OCR complete'}</p>
              </div>
              <ResultsToolbar
                text={cleanText}
                filenameBase={sanitizeFilename((currentResult.filename ?? 'ocr').replace(/\.[^.]+$/, ''))}
                json={currentResult}
                markdownSource={cleanText}
              />
            </header>

            <div className="mb-4 mt-4 flex items-center gap-4 rounded-lg border border-slate-200 bg-slate-50 px-4 py-2 text-xs text-slate-600">
              {currentResult.confidence > 0 && (
                <span>Confidence: <strong>{Math.round(currentResult.confidence * 100)}%</strong></span>
              )}
              <span>Decoder: <strong>{currentResult.decoder ?? 'ctc'}</strong></span>
              <span>Filename: <strong>{currentResult.filename ?? '-'}</strong></span>
              <div className="ml-auto">
                <button
                  type="button"
                  onClick={() => {
                    void copyToClipboard(cleanText);
                  }}
                  className="inline-flex items-center gap-1.5 rounded bg-slate-950 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-slate-800"
                >
                  <CopyIcon className="h-3.5 w-3.5" />
                  Copy Text
                </button>
              </div>
            </div>

            <div className="min-h-0 flex-1">
              <PagePreview
                imageUrl={currentImageUrl}
                alt={currentResult.filename ?? 'OCR page'}
                pageIndex={safeOcrIndex}
                numPages={doneItems.length}
                onPageChange={setOcrIndex}
                outputLabel="OCR Text"
                emptyImageMessage="No source image available."
                output={
                  <div
                    className="whitespace-pre-wrap"
                    style={{ fontFamily: "'Noto Sans Khmer', 'Khmer OS Siemreap', 'Segoe UI', sans-serif" }}
                  >
                    {cleanText}
                  </div>
                }
              />
            </div>
          </section>
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
            actionLabel={(selected) => `Run OCR on ${selected} selected page${selected === 1 ? '' : 's'}`}
            runningLabel="Preparing OCR..."
            emptyTitle="No OCR yet"
            emptyDescription="Upload a PDF or image, then select the pages to process."
            readyDescription="File uploaded successfully. Click below to run OCR on the selected pages."
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
            <ProgressBar value={null} label={`Processing ${batch.progress.active} files... (${batch.progress.done} done)`} />
          )
        )}
        {batch.hasErrors && batch.items.some((it) => it.status === 'error' && it.error) && (
          <ErrorBanner error={batch.items.find((it) => it.status === 'error' && it.error)?.error} />
        )}
      </div>

      {scanFile && (
        <DocumentScanner
          file={scanFile}
          onDone={(scanned) => {
            setFiles([scanned]);
            setScanFile(null);
          }}
          onCancel={() => setScanFile(null)}
        />
      )}
    </div>
  );
}

function fileKey(f: File): string { return `${f.name}|${f.size}|${f.lastModified}`; }
function sanitizeFilename(name: string): string { return name.replace(/[^a-z0-9._-]+/gi, '_').slice(0, 80); }

function CopyIcon({ className }: { className?: string }) {
  return <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>;
}
function CameraIcon({ className }: { className?: string }) {
  return <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 8a2 2 0 0 1 2-2h2l1.5-2h7L19 6h0a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" strokeLinejoin="round" /><circle cx="12" cy="12.5" r="3.5" /></svg>;
}
