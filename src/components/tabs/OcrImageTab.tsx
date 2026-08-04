import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ErrorBanner } from '@/components/ErrorBanner';
import { SimpleCrop } from '@/components/SimpleCrop';
import { FileDropzone } from '@/components/FileDropzone';
import { PagePreview } from '@/components/PagePreview';
import { ProgressBar } from '@/components/ProgressBar';
import { SettingToggle } from '@/components/ExtractionSettingsCard';
import { useBatchProcessor } from '@/hooks/useBatchProcessor';
import { useHistoryAutoSave } from '@/hooks/useHistoryAutoSave';
import { getPdfPageCount, imageFileToThumbnail, renderPdfPages } from '@/lib/pdfProcessing';
import { api } from '@/lib/api';
import { copyToClipboard, isPdf } from '@/lib/utils';
import { ResultsToolbar } from '@/components/ResultsToolbar';
import { VerificationNotice } from '@/components/VerificationNotice';
import { processImage } from '@/lib/imageProcessing';
import { useSettingsStore } from '@/hooks/useSettingsStore';
import { minimalPreprocessOpts, rasterFor } from '@/lib/extractionConfig';
import { useLocale } from '@/lib/i18n';
import type { DocumentResult, OcrImageResponse } from '@/types/api';
import { MetadataSavedPanel } from '@/components/MetadataSavedPanel';

interface PreparedFile {
  id: string;
  source: File;
  totalPages: number;
}

/**
 * OCR Image — mobile-first "scanner" flow: ONE upload, and OCR starts
 * AUTOMATICALLY the moment it is dropped / picked / photographed / pasted. No
 * run button. The other tabs keep the full multi-file workflow.
 *
 * A PDF is accepted too — it is rasterized locally and every page is enqueued as
 * its own request, with the page texts joined for display. Refusing PDFs here
 * just looked like the tab was broken, since every other tab takes them.
 */
export function OcrImageTab() {
  const [files, setFiles] = useState<File[]>([]);
  const extraction = useSettingsStore((s) => s.extraction);
  const setExtraction = useSettingsStore((s) => s.setExtraction);
  const useCtc = useSettingsStore((s) => s.ocr.useCtc);
  const setOcr = useSettingsStore((s) => s.setOcr);
  const [localError, setLocalError] = useState<string | null>(null);
  const [preparingMsg, setPreparingMsg] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  // File currently open in the CamScanner-style crop modal.
  const [scanFile, setScanFile] = useState<File | null>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const { t } = useLocale();

  const batch = useBatchProcessor<
    { fileKey: string; file: File; useCtc: boolean },
    OcrImageResponse
  >({
    concurrency: 1,
    run: async (args, signal) => {
      const a = args as { file: File; useCtc: boolean };
      // Pass 1 — layout-aware (same engine as Parse Document): detect regions,
      // OCR each. Best for real documents; the single-line /ocr-image endpoint
      // garbles multi-line paragraphs. We reshape the DocumentResult into the
      // OcrImageResponse this tab renders.
      const doc = await api.parsePdf(
        [a.file],
        { detectLayout: true, detectLines: true, useCtc: a.useCtc },
        { signal, onProgress: setProgress },
      );
      let text = pickDocText(doc);
      let confidence = avgConfidence(doc);
      let decoder = a.useCtc ? 'layout+ctc' : 'layout';
      // Pass 2 — the layout pass found nothing readable. Happens on signs /
      // photos / screenshots where the detector classifies the text area as a
      // PICTURE region (confidence but no text). Re-read the WHOLE image with
      // no layout gating — same fallback the Document tab (full-page OCR) and
      // the vLLM adapter use. Best-effort: never lose the pass-1 result.
      if (!text.trim()) {
        try {
          const full = await api.parsePdf(
            [a.file],
            { detectLayout: false, detectLines: true, useCtc: a.useCtc },
            { signal },
          );
          const fullText = pickDocText(full);
          if (fullText.trim()) {
            text = fullText;
            confidence = avgConfidence(full) || confidence;
            decoder = a.useCtc ? 'full-page+ctc' : 'full-page';
          }
        } catch {
          // fall through with the (empty) layout-pass result
        }
      }
      return { text, confidence, filename: a.file.name, decoder };
    },
  });

  // History integration expects the prepared-files shape used by other tabs.
  const prepared = useMemo<PreparedFile[]>(
    () => files.map((f) => ({ id: fileKey(f), source: f, totalPages: 1 })),
    [files],
  );
  // Save a compact thumbnail of the user's original (or cropped) image with
  // each run so History shows the photo next to the text, like the other tabs.
  const captureHistoryPreview = useCallback(
    async (_item: { args?: unknown }, prep: PreparedFile): Promise<Record<number, string> | undefined> => {
      try {
        return { 1: await imageFileToThumbnail(prep.source) };
      } catch {
        return undefined; // degrade to a text-only history entry
      }
    },
    [],
  );
  useHistoryAutoSave<PreparedFile>('ocr', batch, prepared, { useCtc, concurrency: 1 }, captureHistoryPreview);

  // ── Auto-OCR ──────────────────────────────────────────────────────────────
  // The moment a (new) image lands, preprocess and enqueue it. lastRunKey
  // guards against re-fires for the same file; "Run again" clears it and
  // re-sets files to retrigger. Settings changes alone do NOT auto re-run
  // (deps are [files] on purpose — t/extraction/useCtc are read fresh but a
  // toggle flip shouldn't restart a finished scan uninvited).
  const lastRunKey = useRef<string | null>(null);
  useEffect(() => {
    const f = files[0];
    if (!f) return;
    const key = fileKey(f);
    if (lastRunKey.current === key) return;
    lastRunKey.current = key;
    let cancelled = false;
    (async () => {
      batch.reset();
      setLocalError(null);
      setPreparingMsg(t('ocr.preparing'));
      try {
        if (isPdf(f.name)) {
          // A PDF used to be silently ignored here, which read as the tab being
          // broken. /ocr-image only speaks images, so rasterize every page and
          // enqueue them — one request per page, the same shape the rest of the
          // app uses, so a slow page never blocks the others and one bad page
          // doesn't sink the scan. The texts are joined for display below.
          const pageCount = await getPdfPageCount(f);
          if (cancelled) return;
          setPreparingMsg(t('ocr.preparing'));
          const pages = Array.from({ length: pageCount }, (_, i) => i + 1);
          const rendered = await renderPdfPages(f, pages, rasterFor(extraction.highRes).dpi);
          if (cancelled) return;
          setProgress(0);
          batch.enqueueMany(
            rendered.map((r, i) => ({
              fileKey: rendered.length > 1 ? `${key}-p${i + 1}` : key,
              file: r.file,
              useCtc,
            })),
          );
          return;
        }
        // Minimal preprocessing: resolution normalization + JPEG encode ONLY —
        // no grayscale/contrast/deskew/etc. silently editing the user's image.
        const processed = await processImage(f, minimalPreprocessOpts(extraction.highRes));
        if (cancelled) return;
        setProgress(0);
        batch.enqueueMany([{ fileKey: key, file: processed, useCtc }]);
      } catch (e) {
        if (!cancelled) {
          setLocalError(
            e instanceof Error ? e.message : isPdf(f.name) ? 'PDF rasterization failed' : 'Image preprocessing failed',
          );
        }
      } finally {
        if (!cancelled) setPreparingMsg(null);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see comment above
  }, [files]);

  const runAgain = () => {
    const f = files[0];
    if (!f) return;
    lastRunKey.current = null;
    setFiles([f]); // fresh array retriggers the auto-run effect
  };

  const resetAll = () => {
    batch.cancel();
    batch.reset();
    setFiles([]);
    lastRunKey.current = null;
    setLocalError(null);
    setProgress(null);
  };

  const currentResultItem = batch.items.find((it) => it.status === 'done' && it.result) ?? null;
  const currentResult = currentResultItem?.result ?? null;
  // A rasterized PDF enqueues one item per page, so the text of the FIRST result
  // is only the first page — taking it alone would silently drop the rest of the
  // document from copy, export and the preview. Join every finished page in
  // enqueue order (which is page order).
  const cleanText = useMemo(() => {
    const texts = batch.items
      .filter((it) => it.status === 'done' && it.result)
      .map((it) => (it.result as OcrImageResponse).text ?? '');
    if (texts.length <= 1) return texts[0] ?? '';
    return texts
      .map((txt, i) => (txt.trim() ? `--- page ${i + 1} ---\n${txt}` : `--- page ${i + 1} ---`))
      .join('\n\n');
  }, [batch.items]);
  const busy = batch.isRunning || preparingMsg !== null;

  // The user's ORIGINAL upload (or their crop) — shown while running AND in
  // the result view. We deliberately do NOT show the engine-side file so the
  // preview always matches what the user gave us.
  const pickedUrl = useMemo(() => (files[0] ? URL.createObjectURL(files[0]) : undefined), [files]);
  useEffect(() => () => { if (pickedUrl) URL.revokeObjectURL(pickedUrl); }, [pickedUrl]);

  const onCameraPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) setFiles([f]);
    e.target.value = ''; // allow re-shooting the same file
  };

  return (
    // Mobile-first: one centered column; comfortable thumb targets throughout.
    <div className="mx-auto w-full max-w-3xl text-slate-950">
      {/* Hidden camera input — `capture` opens the rear camera directly on phones. */}
      <input
        ref={cameraRef}
        type="file"
        accept="image/*"
        capture="environment"
        onChange={onCameraPick}
        className="sr-only"
        aria-hidden="true"
        tabIndex={-1}
      />

      {!currentResult && !busy && (
        <section className="panel-raised rise-in p-5 sm:p-8">
          <h2 className="display">{t('ocr.title')}</h2>
          <p className="mt-1 text-sm text-slate-500">{t('ocr.subtitle')}</p>

          <div className="mt-5">
            <FileDropzone
              accept="pdf-or-image"
              files={files}
              onChange={setFiles}
              disabled={busy}
              labels={{
                title: t('ocr.drop.title'),
                replaceTitle: t('ocr.drop.title'),
                hint: t('ocr.drop.hint'),
                accepted: t('ocr.drop.accepted'),
              }}
            />
          </div>

          <button
            type="button"
            onClick={() => cameraRef.current?.click()}
            className="btn-primary mt-4 min-h-12 w-full sm:w-auto"
          >
            <CameraIcon className="h-5 w-5" />
            {t('ocr.takePhoto')}
          </button>

          <details className="group mt-6">
            <summary className="cursor-pointer select-none text-xs font-semibold uppercase tracking-wider text-slate-500 hover:text-accent">
              {t('ocr.settings')}
            </summary>
            <div className="mt-3 grid gap-3 text-sm text-slate-700">
              <SettingToggle
                label={t('ocr.highRes')}
                hint={t('ocr.highRes.hint')}
                checked={extraction.highRes}
                onChange={(v) => setExtraction({ highRes: v })}
                disabled={busy}
              />
              <SettingToggle
                label={t('ocr.ctc')}
                hint={t('ocr.ctc.hint')}
                checked={useCtc}
                onChange={(v) => setOcr({ useCtc: v })}
                disabled={busy}
              />
            </div>
          </details>
        </section>
      )}

      {busy && !currentResult && (
        <section className="panel-raised rise-in p-5 sm:p-8">
          <div className="flex items-center gap-4">
            {pickedUrl && (
              <img
                src={pickedUrl}
                alt=""
                className="h-20 w-20 shrink-0 rounded-lg border border-slate-200 object-cover"
              />
            )}
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold">{files[0]?.name}</div>
              <div className="mt-1 text-xs text-accent">
                {preparingMsg ?? (progress !== null && progress < 100 ? t('ocr.uploading') : t('ocr.running'))}
              </div>
            </div>
          </div>
          <div className="mt-5">
            <ProgressBar
              value={batch.isRunning && progress !== null && progress < 100 ? progress : null}
              label={preparingMsg ?? t('ocr.running')}
            />
          </div>
          <button type="button" onClick={resetAll} className="btn-secondary mt-5 min-h-11 w-full sm:w-auto">
            {t('common.cancel')}
          </button>
        </section>
      )}

      {currentResult && (
        <section className="panel-raised rise-in flex flex-col p-5 sm:p-8">
          <header className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-lg font-semibold tracking-tight">{t('ocr.result')}</h2>
              <p className="truncate text-sm text-slate-500">{currentResult.filename ?? ''}</p>
            </div>
            <div className="flex items-center gap-2">
              {currentResult.confidence > 0 && (
                <span className="badge border-accent/40 bg-accent/10 text-accent">
                  {t('ocr.confidence')} {Math.round(currentResult.confidence * 100)}%
                </span>
              )}
            </div>
          </header>

          <div className="mt-4">
            <VerificationNotice />
          </div>

          <div className="mt-4">
            <MetadataSavedPanel filename={currentResult.filename ?? null} />
          </div>

          {/* Action row — thumb-sized, copy is the hero action. */}
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => { void copyToClipboard(cleanText); }}
              disabled={!cleanText.trim()}
              className="btn-primary min-h-12 flex-1 sm:flex-none"
            >
              <CopyIcon className="h-4 w-4" />
              {t('ocr.copy')}
            </button>
            <button
              type="button"
              onClick={() => setScanFile(files[0] ?? null)}
              className="btn-secondary min-h-12"
              disabled={!files[0]}
            >
              <CameraIcon className="h-4 w-4" />
              {t('ocr.crop')}
            </button>
            <button type="button" onClick={runAgain} className="btn-ghost min-h-12">
              ↺ {t('ocr.rerun')}
            </button>
            <button type="button" onClick={resetAll} className="btn-ghost min-h-12">
              {t('ocr.newImage')}
            </button>
          </div>

          <div className="mt-4 flex justify-end">
            <ResultsToolbar
              text={cleanText}
              filenameBase={sanitizeFilename((currentResult.filename ?? 'ocr').replace(/\.[^.]+$/, ''))}
              json={currentResult}
              markdownSource={cleanText}
            />
          </div>

          <div className="mt-4 min-h-0 flex-1">
            <PagePreview
              imageUrl={pickedUrl}
              alt={currentResult.filename ?? 'OCR page'}
              pageIndex={0}
              numPages={1}
              onPageChange={() => {}}
              outputLabel={t('ocr.text')}
              emptyImageMessage={t('ocr.noImage')}
              output={
                cleanText.trim() ? (
                  <div
                    className="whitespace-pre-wrap text-base leading-relaxed"
                    style={{ fontFamily: "'Noto Sans Khmer', 'Khmer OS Siemreap', 'Segoe UI', sans-serif" }}
                  >
                    {cleanText}
                  </div>
                ) : (
                  <div className="grid gap-1.5 text-sm">
                    <span className="font-medium text-amber-600">{t('ocr.noText')}</span>
                    <span className="text-slate-500">{t('ocr.noText.hint')}</span>
                  </div>
                )
              }
            />
          </div>
        </section>
      )}

      <div className="mt-4 grid gap-2">
        {localError && <ErrorBanner error={new Error(localError)} />}
        {batch.hasErrors && batch.items.some((it) => it.status === 'error' && it.error) && (
          <ErrorBanner error={batch.items.find((it) => it.status === 'error' && it.error)?.error} />
        )}
      </div>

      {scanFile && (
        <SimpleCrop
          file={scanFile}
          onDone={(cropped) => {
            setScanFile(null);
            setFiles([cropped]); // new fileKey → auto-OCR re-fires on the cropped area
          }}
          onCancel={() => setScanFile(null)}
        />
      )}
    </div>
  );
}

function fileKey(f: File): string { return `${f.name}|${f.size}|${f.lastModified}`; }
function sanitizeFilename(name: string): string { return name.replace(/[^a-z0-9._-]+/gi, '_').slice(0, 80); }

/** Single-image text pick: non-blank full_text, else joined region text (no
 * page headers — this tab is always one page). full_text can arrive as "". */
function pickDocText(doc: DocumentResult): string {
  const joined = doc.pages
    .flatMap((p) => p.regions.map((r) => (r.text ?? '').trim()))
    .filter(Boolean)
    .join('\n');
  return doc.full_text?.trim() ? doc.full_text : joined;
}

function avgConfidence(doc: DocumentResult): number {
  const confs = doc.pages.flatMap((p) => p.regions.map((r) => r.confidence)).filter((c) => c > 0);
  return confs.length ? confs.reduce((s, c) => s + c, 0) / confs.length : 0;
}

function CopyIcon({ className }: { className?: string }) {
  return <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>;
}
function CameraIcon({ className }: { className?: string }) {
  return <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 8a2 2 0 0 1 2-2h2l1.5-2h7L19 6h0a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" strokeLinejoin="round" /><circle cx="12" cy="12.5" r="3.5" /></svg>;
}