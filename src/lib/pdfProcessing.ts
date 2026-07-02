// Client-side PDF utilities.
//
// We render selected pages to PNGs at a chosen DPI so the user can:
//   1. Process only the pages they care about (saves time + cost).
//   2. Control rasterization quality (DPI) independently of the source PDF.
//   3. Apply the same image enhancement pipeline that works on raster inputs.
//
// The output PNGs are then uploaded as a multi-file POST to /parse-pdf,
// which already accepts an array of image files (PDFs and images are
// interchangeable from the upstream's point of view).

import * as pdfjsLib from 'pdfjs-dist';
// Vite's `?worker` import bundles the file as a regular Web Worker (not a
// module worker). The Worker is loaded via `new Worker(url)` which is more
// lenient about MIME than the dynamic-import path we tried earlier — and
// because the worker URL is content-hashed by Vite, browser cache invalidation
// works automatically across deploys.
import PdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?worker';

// pdfjs 4.x requires GlobalWorkerOptions.workerSrc to be set. We assign a
// Vite-bundled Worker instance. If anything goes wrong at construction time
// (e.g. browser doesn't support workers), we fall through to the next
// line — the user will see a clear error from pdfjs.
pdfjsLib.GlobalWorkerOptions.workerPort = new PdfWorker();

export interface RenderedPage {
  index: number;       // 0-based
  pageNumber: number;  // 1-based for display
  file: File;          // PNG file ready to upload
  width: number;       // pixels
  height: number;      // pixels
}

/**
 * Parse a human page-range expression like "1-3, 5, 7-9" into a sorted,
 * deduped list of 1-based page numbers. Empty / undefined = all pages.
 *
 * Throws on malformed input so the UI can surface a useful error rather
 * than silently uploading everything.
 */
export function parsePageRange(input: string, totalPages: number): number[] {
  const trimmed = input.trim();
  if (!trimmed) return range(1, totalPages);

  const out = new Set<number>();
  const parts = trimmed.split(',').map((s) => s.trim()).filter(Boolean);
  for (const part of parts) {
    const m = /^(\d+)\s*-\s*(\d+)$/.exec(part);
    if (m) {
      const a = clamp(parseInt(m[1], 10), 1, totalPages);
      const b = clamp(parseInt(m[2], 10), 1, totalPages);
      const [lo, hi] = a <= b ? [a, b] : [b, a];
      for (let i = lo; i <= hi; i++) out.add(i);
    } else if (/^\d+$/.test(part)) {
      out.add(clamp(parseInt(part, 10), 1, totalPages));
    } else {
      throw new Error(`Cannot parse page "${part}"`);
    }
  }
  return [...out].sort((a, b) => a - b);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function range(lo: number, hi: number): number[] {
  return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
}

/**
 * Render selected pages of a PDF to PNG files at the requested DPI.
 * The original PDF metadata is preserved per-page (page number).
 *
 * DPI math: pdf.js exposes a `viewport` at scale 1.0 = 72 DPI by convention,
 * so scale = targetDpi / 72.
 */
export async function renderPdfPages(
  file: File,
  pages: number[],
  targetDpi: number,
  onProgress?: (done: number, total: number) => void,
): Promise<RenderedPage[]> {
  const buf = await file.arrayBuffer();
  const loadingTask = pdfjsLib.getDocument({ data: buf, isEvalSupported: true });
  const doc = await loadingTask.promise;

  try {
    const scale = Math.max(1, targetDpi / 72);
    const out: RenderedPage[] = [];
    for (let i = 0; i < pages.length; i++) {
      const pageNum = pages[i];
      const page = await doc.getPage(pageNum);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Canvas 2D context unavailable');

      await page.render({ canvasContext: ctx, viewport }).promise;

      const blob: Blob = await new Promise((resolve, reject) =>
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('canvas.toBlob failed'))), 'image/png'),
      );
      const name = `${stripExt(file.name)}_p${pageNum}.png`;
      out.push({
        index: i,
        pageNumber: pageNum,
        file: new File([blob], name, { type: 'image/png' }),
        width: canvas.width,
        height: canvas.height,
      });
      onProgress?.(i + 1, pages.length);
    }
    return out;
  } finally {
    // pdf.js documents hold GPU/canvas resources; release promptly.
    await doc.cleanup();
    await doc.destroy();
  }
}

function stripExt(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(0, i) : name;
}

/**
 * Quick probe to read the total page count of a PDF without rendering.
 * Useful so the UI can show "out of N total" hints.
 *
 * IMPORTANT: cleanup() and destroy() must be awaited. pdf.js runs the real
 * work on a shared Web Worker; if we fire-and-forget destroy() and then
 * immediately open another document on the same worker, the two operations
 * race and the new document can come back broken (empty/failed page renders).
 */
export async function getPdfPageCount(file: File): Promise<number> {
  const buf = await file.arrayBuffer();
  const doc = await pdfjsLib.getDocument({ data: buf }).promise;
  const n = doc.numPages;
  await doc.cleanup();
  await doc.destroy();
  return n;
}

/**
 * Render a single PDF page to a low-DPI PNG data URL. Intended for the
 * BoundingBoxViewer background so the user can see the boxes overlaid on
 * the actual page content (the high-DPI rasterization goes to the API; we
 * only need a small preview for display).
 *
 * `maxDim` is the longer edge in pixels; the aspect ratio is preserved.
 * Default 480 is plenty for a side panel — bigger just wastes memory.
 *
 * Note: this opens and destroys a pdfjs document per call. When you need
 * several pages from the same file, prefer `renderPdfPagePreviews` below —
 * it parses the PDF once and reuses the document handle for every page,
 * which is dramatically faster for multi-page files (one parse vs. N).
 */
export async function renderPdfPagePreview(
  file: File,
  pageNumber: number,
  maxDim = 480,
): Promise<string> {
  const buf = await file.arrayBuffer();
  const doc = await pdfjsLib.getDocument({ data: buf }).promise;
  try {
    return await renderPagePreview(doc, pageNumber, maxDim);
  } finally {
    await doc.cleanup();
    await doc.destroy();
  }
}

/**
 * Render multiple pages of the same PDF to low-DPI PNG data URLs in a single
 * pass. The PDF is parsed exactly once and the document handle is reused for
 * every page, so this is O(1) parses + O(N) renders instead of O(N) parses.
 *
 * Pages render SEQUENTIALLY. We tried rendering 3 pages concurrently on the
 * same pdfjs document for speed, but pdf.js does not reliably support
 * concurrent page.render() calls against one document — renders fail
 * silently and produce blank output. Sequential rendering is reliable and
 * still much faster than the old per-page code (which re-parsed the whole
 * PDF for every page).
 *
 * Each page is emitted via `onPage` as soon as it finishes so callers can
 * fill the UI progressively. The returned Map contains all pages once done.
 *
 * `maxDim` is the longer edge in pixels; aspect ratios are preserved.
 */
export async function renderPdfPagePreviews(
  file: File,
  pageNumbers: number[],
  maxDim = 480,
  onPage?: (pageNumber: number, url: string) => void,
): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (pageNumbers.length === 0) return out;

  const buf = await file.arrayBuffer();
  const doc = await pdfjsLib.getDocument({ data: buf }).promise;
  try {
    for (const pageNum of pageNumbers) {
      // Per-page resilience: a single corrupt/odd page shouldn't abort the
      // whole batch. Emit an empty string and keep going, matching the old
      // per-page .catch(() => '') behavior callers relied on.
      try {
        const url = await renderPagePreview(doc, pageNum, maxDim);
        out.set(pageNum, url);
        onPage?.(pageNum, url);
      } catch (err) {
        // Log so failures are visible in the console instead of silently
        // turning into blank thumbnails that look like a "hung" UI.
        console.warn(`[pdfProcessing] Failed to render page ${pageNum}:`, err);
        out.set(pageNum, '');
        onPage?.(pageNum, '');
      }
    }
    return out;
  } finally {
    await doc.cleanup();
    await doc.destroy();
  }
}

/**
 * Shared inner renderer: draws one page of an already-open pdfjs document
 * to a canvas at a scale that keeps the longer edge at `maxDim` pixels,
 * then returns a PNG data URL. The caller owns the document lifecycle.
 */
async function renderPagePreview(
  doc: pdfjsLib.PDFDocumentProxy,
  pageNumber: number,
  maxDim: number,
  mime: string = 'image/png',
  quality?: number,
): Promise<string> {
  const page = await doc.getPage(pageNumber);
  const baseVp = page.getViewport({ scale: 1 });
  const scale = maxDim / Math.max(baseVp.width, baseVp.height);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');
  // JPEG over a transparent canvas comes out black; paint white first.
  if (mime === 'image/jpeg') {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  await page.render({ canvasContext: ctx, viewport }).promise;
  return canvas.toDataURL(mime, quality);
}

/**
 * Compact JPEG page thumbnails for persisting in history (keyed by SOURCE page
 * number). Small + lossy on purpose so a run stays well under the localStorage
 * budget. Returns a Map<sourcePage, dataURL>; failed pages are omitted.
 */
export async function renderPdfThumbnails(
  file: File,
  pageNumbers: number[],
  maxDim = 1000,
  quality = 0.62,
): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (pageNumbers.length === 0) return out;
  const buf = await file.arrayBuffer();
  const doc = await pdfjsLib.getDocument({ data: buf }).promise;
  try {
    for (const pageNum of pageNumbers) {
      try {
        out.set(pageNum, await renderPagePreview(doc, pageNum, maxDim, 'image/jpeg', quality));
      } catch (err) {
        console.warn(`[pdfProcessing] thumbnail failed for page ${pageNum}:`, err);
      }
    }
    return out;
  } finally {
    await doc.cleanup();
    await doc.destroy();
  }
}

/** Compact JPEG thumbnail of a raster image File (for non-PDF history runs). */
export async function imageFileToThumbnail(file: Blob, maxDim = 1000, quality = 0.62): Promise<string> {
  const bmp = await createImageBitmap(file);
  try {
    const scale = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bmp, 0, 0, w, h);
    return canvas.toDataURL('image/jpeg', quality);
  } finally {
    bmp.close();
  }
}
