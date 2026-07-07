import { useEffect, useMemo, useRef, useState, type ReactNode, type UIEvent } from 'react';
import { api } from '@/lib/api';
import type { BackendId } from '@/lib/backend';
import { FileDropzone } from '@/components/FileDropzone';
import { TableGrid } from '@/components/TableGrid';
import { MarkdownView } from '@/components/MarkdownView';
import { ZoomableImage } from '@/components/PagePreview';
import { PageImageWithBoxes } from '@/components/PageImageWithBoxes';
import { pageToMarkdown } from '@/lib/exporters';
import { renderPdfPagePreview, renderPdfPages, getPdfPageCount, parsePageRange } from '@/lib/pdfProcessing';
import { normalizeOcrResponse, type DocumentResult, type PageResult, type TableResult } from '@/types/api';
import { toast } from '@/hooks/useToastStore';
import { useHistory } from '@/hooks/useHistory';
import { downloadText, downloadBytes, isPdf, orientedBboxToRect, colorForRegion } from '@/lib/utils';
import { buildCompareHtml, buildBatchCompareHtml } from '@/lib/compareExport';
import { buildCompareDocx, buildGroundTruthTxt, buildOutputsJson, type CompareDocxItem, type CompareDocxPageImage } from '@/lib/compareDocx';
import { readParquetDataset } from '@/lib/parquetDataset';
import { cer, pct } from '@/lib/textMetrics';
import type { ComparePane, CompareRecord } from '@/lib/storage';

/**
 * Compare tab — runs the SAME input through both backends (Khmer Parsing API + Surya OCR 2/vLLM)
 * in parallel, shows them side-by-side with per-side latency, and lets you vote
 * which looks better. Votes accumulate into a per-mode tally in localStorage.
 *
 * This tab is self-contained: it never touches the global backend toggle (it
 * uses the per-call `backend` override in api.ts), so the other tabs are
 * unaffected by anything done here. CER/WER scoring is intentionally out of
 * scope for now — this is human-judged.
 */
type Mode = 'ocr' | 'table' | 'document';
type Choice = 'default' | 'tie' | 'vllm';

interface Pane {
  ms: number;
  data?: unknown;
  error?: string;
  /** Per-page latency (document mode runs each page as its own timed request). */
  pageMs?: { page: number; ms: number }[];
}
interface RunResult {
  default: Pane;
  vllm: Pane;
}

const MODES: { id: Mode; label: string }[] = [
  { id: 'ocr', label: 'OCR image' },
  { id: 'table', label: 'Table' },
  { id: 'document', label: 'Document' },
];

const BACKEND_NAME: Record<'default' | 'vllm', string> = { default: 'Khmer Parsing API', vllm: 'Surya OCR 2 · vLLM' };

// DPI used to rasterize selected PDF pages before sending. Both backends get
// the SAME pixels (fairer than letting each rasterize the PDF its own way), and
// rasterizing client-side is what makes page selection possible. 200 matches
// STANDARD_RASTER — bump if dense tables need more.
const COMPARE_DPI = 200;

/** A short, current sub-step shown while a comparison is in flight. */
interface Stage {
  label: string;
  done?: number;
  total?: number;
}

// --- preference tally (per mode), persisted ------------------------------- //
type Tally = Record<string, Record<Choice, number>>;
const TALLY_KEY = 'ocr.compare.tally';
function readTally(): Tally {
  try {
    return JSON.parse(localStorage.getItem(TALLY_KEY) || '{}') as Tally;
  } catch {
    return {};
  }
}
function bumpTally(mode: Mode, choice: Choice): Tally {
  const t = readTally();
  const m = t[mode] ?? { default: 0, tie: 0, vllm: 0 };
  m[choice] += 1;
  t[mode] = m;
  try {
    localStorage.setItem(TALLY_KEY, JSON.stringify(t));
  } catch {
    // ignore
  }
  return t;
}

function fmtLatency(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** Downscaled JPEG data-URL of an image file, for a compact History preview. */
async function makePreview(file: File): Promise<string | undefined> {
  if (!file.type.startsWith('image/')) return undefined;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 800 / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    if (!ctx) return undefined;
    ctx.drawImage(bmp, 0, 0, w, h);
    return c.toDataURL('image/jpeg', 0.72);
  } catch {
    return undefined;
  }
}

/** Full-resolution data-URL (for box overlays in the exported HTML). */
function fileToDataUrl(file: File): Promise<string | undefined> {
  if (!file.type.startsWith('image/')) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const fr = new FileReader();
    fr.onload = () => resolve(typeof fr.result === 'string' ? fr.result : undefined);
    fr.onerror = () => resolve(undefined);
    fr.readAsDataURL(file);
  });
}

function preferredLabel(vote: Choice | null): string | undefined {
  if (!vote) return undefined;
  return vote === 'vllm' ? 'Surya OCR 2 · vLLM' : vote === 'default' ? 'Khmer Parsing API' : 'tie';
}

/** Plain extracted text for a result, used to score against ground truth. */
function textOf(mode: Mode, data: unknown): string {
  // Blank-aware: full_text can arrive as "" — fall back to region text so
  // scoring/exports don't see an empty document.
  if (mode === 'document') {
    const doc = data as DocumentResult;
    return doc.full_text?.trim() ? doc.full_text : regionsText(doc);
  }
  if (mode === 'table') return (data as TableResult).structured_text ?? '';
  return normalizeOcrResponse(data).text;
}

/** Merge per-page DocumentResults into one, renumbering pages 1..n in order
 * (and the same on any region crops) so the rest of the UI lines up. */
function mergeDocResults(parts: DocumentResult[]): DocumentResult {
  const pages = parts.flatMap((p) => p.pages ?? []);
  pages.forEach((pg, i) => {
    pg.page_number = i + 1;
  });
  // table/figure/image crops, each renumbered to their part's merged page index.
  const crops = (key: 'table_crops' | 'figure_crops' | 'image_crops') =>
    parts.flatMap((p, i) => (p[key] ?? []).map((c) => ({ ...c, page_number: i + 1 })));
  return {
    filename: parts[0]?.filename ?? '',
    num_pages: pages.length,
    pages,
    full_text: parts.map((p) => (p.full_text?.trim() ? p.full_text : regionsText(p))).filter(Boolean).join('\n\n') || null,
    translated_text: null,
    table_crops: crops('table_crops'),
    figure_crops: crops('figure_crops'),
    image_crops: crops('image_crops'),
  };
}

/** Flatten a DocumentResult's region text (fallback when full_text is absent). */
function regionsText(doc: DocumentResult): string {
  return (doc.pages ?? [])
    .flatMap((p) => p.regions.map((r) => (r.text ?? '').trim()).filter(Boolean))
    .join('\n');
}

/** Stack multiple pages' TableResults into one grid — each page's rows appended
 * below the previous, num_cols = the widest page. structured_text is joined with
 * a per-page header. */
function mergeTableResults(results: TableResult[], pages: number[]): TableResult {
  const cells: TableResult['cells'] = [];
  let rowOffset = 0;
  let maxCols = 0;
  const st: string[] = [];
  results.forEach((r, i) => {
    maxCols = Math.max(maxCols, r.num_cols);
    for (const c of r.cells) cells.push({ ...c, row: c.row + rowOffset });
    rowOffset += r.num_rows;
    st.push(`## Page ${pages[i] ?? i + 1}\n${r.structured_text ?? ''}`);
  });
  return {
    filename: results[0]?.filename ?? '',
    num_rows: rowOffset,
    num_cols: maxCols,
    cells,
    structured_text: st.join('\n\n'),
    width: results[0]?.width ?? 0,
    height: results[0]?.height ?? 0,
    debug_image: results[0]?.debug_image ?? null,
  };
}

function paneStat(mode: Mode, pane: Pane): string {
  if (pane.error || pane.data === undefined) return '';
  if (mode === 'table') {
    const r = pane.data as TableResult;
    return `${r.num_rows}×${r.num_cols}`;
  }
  if (mode === 'document') {
    const r = pane.data as DocumentResult;
    return `${r.num_pages}p`;
  }
  return `${normalizeOcrResponse(pane.data).text.length} chars`;
}

export function CompareTab() {
  const [mode, setMode] = useState<Mode>('ocr');
  const [files, setFiles] = useState<File[]>([]);
  const [activeIdx, setActiveIdx] = useState(0);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [stage, setStage] = useState<Stage | null>(null);
  // Per-backend page progress during document-mode runs (each page is its own
  // timed request, so we can show "Cloud 3/10 · vLLM 2/10" live).
  const [docProg, setDocProg] = useState<{ default: number; vllm: number; total: number } | null>(null);
  const [exporting, setExporting] = useState(false);
  // PDF page handling (document mode): total page count + the user's chosen
  // range string + the page numbers actually sent on the last run, all keyed by
  // file index so a batch keeps each file's selection independent.
  const [pdfPageCounts, setPdfPageCounts] = useState<Record<number, number>>({});
  const [pageRanges, setPageRanges] = useState<Record<number, string>>({});
  const [runPages, setRunPages] = useState<Record<number, number[]>>({});
  // Results + votes keyed by file index (so a batch keeps every item's output).
  const [results, setResults] = useState<Record<number, RunResult>>({});
  const [votes, setVotes] = useState<Record<number, Choice>>({});
  const [docView, setDocView] = useState<'markdown' | 'boxes'>('markdown');
  const [pageIdx, setPageIdx] = useState(0);
  // Preview UX: collapse the source column to give the two text panes full
  // width; A- / A+ text zoom; synchronized scrolling between the two panes.
  const [showSource, setShowSource] = useState(true);
  const [paneZoom, setPaneZoom] = useState(1);
  const paneScrollRefs = useRef<Record<'default' | 'vllm', HTMLElement | null>>({ default: null, vllm: null });
  const syncingScroll = useRef(false);
  const onPaneScroll = (which: 'default' | 'vllm') => (e: UIEvent<HTMLElement>) => {
    if (syncingScroll.current) return;
    const other = paneScrollRefs.current[which === 'default' ? 'vllm' : 'default'];
    const self = e.currentTarget;
    if (!other) return;
    syncingScroll.current = true;
    // Proportional so different-length outputs stay roughly aligned.
    const denom = Math.max(1, self.scrollHeight - self.clientHeight);
    other.scrollTop = (self.scrollTop / denom) * Math.max(1, other.scrollHeight - other.clientHeight);
    requestAnimationFrame(() => {
      syncingScroll.current = false;
    });
  };
  const [pdfPageUrl, setPdfPageUrl] = useState<string | undefined>(undefined);
  const [pdfLoading, setPdfLoading] = useState(false);
  const [tally, setTally] = useState<Tally>(() => readTally());
  // Dataset (parquet) input — labels aligned with `files` by index.
  const [inputMode, setInputMode] = useState<'images' | 'dataset'>('images');
  const [labels, setLabels] = useState<string[]>([]);
  const [parquetFile, setParquetFile] = useState<File | null>(null);
  const [sampleCount, setSampleCount] = useState(250);
  const [loadingDs, setLoadingDs] = useState(false);
  const [dsError, setDsError] = useState<string | null>(null);
  const history = useHistory();

  const file = files[activeIdx];
  const activeLabel = labels[activeIdx];
  const result = results[activeIdx] ?? null;
  const vote = votes[activeIdx] ?? null;
  // PDFs are accepted in EVERY mode. For OCR/Table (single-image ops) a PDF is
  // rasterized to its selected page before sending; Document handles multi-page.
  const accept = 'pdf-or-image';
  const isImage = !!file && file.type.startsWith('image/');
  const isPdfFile = (f?: File): boolean => !!f && !f.type.startsWith('image/') && isPdf(f.name);

  // Resolve the user's range string for a file into actual 1-based page numbers
  // (empty / invalid → all pages).
  const resolvePages = (idx: number, total: number): number[] => {
    try {
      return parsePageRange(pageRanges[idx] ?? '', total);
    } catch {
      return Array.from({ length: total }, (_, i) => i + 1);
    }
  };

  // Object URL for the active source preview (images only).
  const sourceUrl = useMemo(() => {
    if (isImage && file) return URL.createObjectURL(file);
    return undefined;
  }, [isImage, file]);
  useEffect(() => () => {
    if (sourceUrl) URL.revokeObjectURL(sourceUrl);
  }, [sourceUrl]);

  // Reset to page 1 whenever the active item or mode changes.
  useEffect(() => setPageIdx(0), [activeIdx, mode]);

  // Read the active PDF's page count so the page-range control can show "N total"
  // and validate the selection (any mode — PDFs are allowed everywhere).
  useEffect(() => {
    let cancelled = false;
    if (file && isPdfFile(file) && pdfPageCounts[activeIdx] === undefined) {
      getPdfPageCount(file)
        .then((n) => {
          if (!cancelled) setPdfPageCounts((prev) => ({ ...prev, [activeIdx]: n }));
        })
        .catch(() => undefined);
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, file, activeIdx]);

  // Render the selected PDF page to a data URL for the Source preview (and so
  // document-mode boxes overlay on the actual page). Images use their object URL.
  useEffect(() => {
    let cancelled = false;
    if (file && isPdfFile(file)) {
      setPdfLoading(true);
      // Document: the viewed page (result pages renumbered 1..n → map back).
      // OCR/Table: the first selected page (the single page that gets sent).
      const total = pdfPageCounts[activeIdx];
      const srcPage =
        mode === 'document'
          ? runPages[activeIdx]?.[pageIdx] ?? pageIdx + 1
          : runPages[activeIdx]?.[0] ?? (total ? resolvePages(activeIdx, total)[0] : 1) ?? 1;
      renderPdfPagePreview(file, srcPage, 1100)
        .then((url) => {
          if (!cancelled) setPdfPageUrl(url);
        })
        .catch(() => {
          if (!cancelled) setPdfPageUrl(undefined);
        })
        .finally(() => {
          if (!cancelled) setPdfLoading(false);
        });
    } else {
      setPdfPageUrl(undefined);
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, file, isImage, pageIdx, activeIdx, runPages, pdfPageCounts, pageRanges]);

  const displayImageUrl = isImage ? sourceUrl : pdfPageUrl;
  const docPageCount = (pane?: Pane): number =>
    mode === 'document' && pane?.data ? (pane.data as DocumentResult).pages?.length ?? 0 : 0;
  const pageCount = result ? Math.max(docPageCount(result.default), docPageCount(result.vllm)) : 0;

  const counts = tally[mode] ?? { default: 0, tie: 0, vllm: 0 };

  // Changing files or mode clears prior results (index/mode no longer aligned).
  const resetRuns = () => {
    setResults({});
    setVotes({});
    setActiveIdx(0);
  };
  const onFilesChange = (f: File[]) => {
    setFiles(f);
    setLabels([]);
    setPdfPageCounts({});
    setPageRanges({});
    setRunPages({});
    resetRuns();
  };

  const loadDataset = async (all: boolean) => {
    if (!parquetFile) return;
    setLoadingDs(true);
    setDsError(null);
    try {
      const { samples, total } = await readParquetDataset(parquetFile, all ? 'all' : sampleCount);
      setFiles(samples.map((s) => s.file));
      setLabels(samples.map((s) => s.label));
      setResults({});
      setVotes({});
      setActiveIdx(0);
      setMode('ocr'); // dataset rows are images → OCR-text eval
      toast.success(`Loaded ${samples.length} of ${total} samples`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'error';
      // eslint-disable-next-line no-console
      console.error('[parquet] load failed:', e);
      setDsError(msg);
      toast.error('Could not read parquet — see details below');
    }
    setLoadingDs(false);
  };

  // Turn a source file into the file(s) sent to the backends. PDFs are
  // rasterized to ONE PNG per SELECTED page (once, shared by both backends),
  // reporting per-page progress — for EVERY mode now. Images pass through.
  const prepareSend = async (
    f: File,
    idx: number,
    onPage?: (done: number, total: number) => void,
  ): Promise<{ files: File[]; pages: number[] }> => {
    if (isPdfFile(f)) {
      const total = pdfPageCounts[idx] ?? (await getPdfPageCount(f));
      const pages = resolvePages(idx, total);
      if (!pages.length) return { files: [], pages: [] };
      const rendered = await renderPdfPages(f, pages, COMPARE_DPI, onPage);
      return { files: rendered.map((r) => r.file), pages };
    }
    return { files: [f], pages: [] };
  };

  const shortName = (n: string) => (n.length > 22 ? n.slice(0, 20) + '…' : n);

  // A per-page runner: processes each selected page as its OWN timed request
  // (real seconds-per-page + live progress) and combines the results. One shape
  // for all three modes: (files, pages, backend, onPageDone) → Pane.
  type PaneRunner = (
    sendFiles: File[],
    pages: number[],
    backend: BackendId,
    onPageDone?: (done: number) => void,
  ) => Promise<Pane>;

  // Document: merge per-page DocumentResults (pages renumbered 1..n).
  const runPaneDocument: PaneRunner = async (sendFiles, pages, backend, onPageDone) => {
    const parts: DocumentResult[] = [];
    const pageMs: { page: number; ms: number }[] = [];
    let totalMs = 0;
    for (let i = 0; i < sendFiles.length; i++) {
      const t0 = performance.now();
      try {
        const data = (await api.parsePdf([sendFiles[i]], {}, { backend })) as DocumentResult;
        const ms = performance.now() - t0;
        totalMs += ms;
        parts.push(data);
        pageMs.push({ page: pages[i] ?? i + 1, ms });
      } catch (e) {
        return { ms: totalMs, error: e instanceof Error ? e.message : 'Failed', pageMs };
      }
      onPageDone?.(i + 1);
    }
    return { ms: totalMs, data: mergeDocResults(parts), pageMs };
  };

  // OCR: concatenate each page's text (with page separators for multi-page).
  const runPaneOcr: PaneRunner = async (sendFiles, pages, backend, onPageDone) => {
    const texts: string[] = [];
    const pageMs: { page: number; ms: number }[] = [];
    let totalMs = 0;
    let confSum = 0;
    for (let i = 0; i < sendFiles.length; i++) {
      const t0 = performance.now();
      try {
        const data = await api.ocrImage(sendFiles[i], {}, { backend });
        const ms = performance.now() - t0;
        totalMs += ms;
        const norm = normalizeOcrResponse(data);
        texts.push(norm.text);
        confSum += norm.confidence;
        pageMs.push({ page: pages[i] ?? i + 1, ms });
      } catch (e) {
        return { ms: totalMs, error: e instanceof Error ? e.message : 'Failed', pageMs };
      }
      onPageDone?.(i + 1);
    }
    const text =
      sendFiles.length > 1
        ? texts.map((t, i) => `--- Page ${pages[i] ?? i + 1} ---\n${t}`).join('\n\n')
        : texts[0] ?? '';
    return { ms: totalMs, data: { text, confidence: texts.length ? confSum / texts.length : 0 }, pageMs };
  };

  // Table: stack each page's rows into one grid (num_cols = max across pages).
  const runPaneTable: PaneRunner = async (sendFiles, pages, backend, onPageDone) => {
    const results: TableResult[] = [];
    const pageMs: { page: number; ms: number }[] = [];
    let totalMs = 0;
    for (let i = 0; i < sendFiles.length; i++) {
      const t0 = performance.now();
      try {
        const data = (await api.parseTable(sendFiles[i], {}, { backend })) as TableResult;
        const ms = performance.now() - t0;
        totalMs += ms;
        results.push(data);
        pageMs.push({ page: pages[i] ?? i + 1, ms });
      } catch (e) {
        return { ms: totalMs, error: e instanceof Error ? e.message : 'Failed', pageMs };
      }
      onPageDone?.(i + 1);
    }
    const data = results.length === 1 ? results[0] : mergeTableResults(results, pages);
    return { ms: totalMs, data, pageMs };
  };

  const paneRunnerFor = (m: Mode): PaneRunner =>
    m === 'document' ? runPaneDocument : m === 'table' ? runPaneTable : runPaneOcr;

  const runPair = async (f: File, idx: number): Promise<RunResult> => {
    const { files: send, pages } = await prepareSend(f, idx, (done, total) =>
      setStage({ label: `Rasterizing ${shortName(f.name)}`, done, total }),
    );
    if (pages.length) setRunPages((prev) => ({ ...prev, [idx]: pages }));
    if (isPdfFile(f) && !send.length) {
      const err = { ms: 0, error: 'No pages selected' };
      return { default: err, vllm: err };
    }
    const pageNums = pages.length ? pages : [1]; // a plain image = one page
    if (!pages.length) setRunPages((prev) => ({ ...prev, [idx]: pageNums }));
    const runner = paneRunnerFor(mode);
    setStage(null);
    setDocProg({ default: 0, vllm: 0, total: send.length });
    const [d, v] = await Promise.all([
      runner(send, pageNums, 'default', (n) => setDocProg((p) => (p ? { ...p, default: n } : p))),
      runner(send, pageNums, 'vllm', (n) => setDocProg((p) => (p ? { ...p, vllm: n } : p))),
    ]);
    setDocProg(null);
    return { default: d, vllm: v };
  };

  // Run / re-run the active item.
  const runActive = async () => {
    if (!file) return;
    setRunning(true);
    setVotes((prev) => {
      const n = { ...prev };
      delete n[activeIdx];
      return n;
    });
    try {
      const r = await runPair(file, activeIdx);
      setResults((prev) => ({ ...prev, [activeIdx]: r }));
    } finally {
      setRunning(false);
      setStage(null);
      setDocProg(null);
    }
  };

  // Re-run a single backend for the active item.
  const runSide = async (backend: BackendId) => {
    if (!file) return;
    setRunning(true);
    try {
      const { files: send, pages } = await prepareSend(file, activeIdx, (done, total) =>
        setStage({ label: `Rasterizing ${shortName(file.name)}`, done, total }),
      );
      if (pages.length) setRunPages((prev) => ({ ...prev, [activeIdx]: pages }));
      if (isPdfFile(file) && !send.length) {
        toast.error('No pages selected');
        return;
      }
      const pageNums = pages.length ? pages : [1];
      if (!pages.length) setRunPages((prev) => ({ ...prev, [activeIdx]: pageNums }));
      setStage(null);
      setDocProg({ default: 0, vllm: 0, total: send.length });
      const pane = await paneRunnerFor(mode)(send, pageNums, backend, (n) =>
        setDocProg((p) => (p ? { ...p, [backend]: n } : p)),
      );
      setDocProg(null);
      setResults((prev) => {
        const cur = prev[activeIdx] ?? { default: { ms: 0 }, vllm: { ms: 0 } };
        return { ...prev, [activeIdx]: { ...cur, [backend]: pane } };
      });
    } finally {
      setRunning(false);
      setStage(null);
      setDocProg(null);
    }
  };

  // Batch over a specific list of file indices with bounded concurrency. vLLM
  // does continuous batching (max-num-seqs 6), so a few in flight is ~2-2.5x
  // faster than sequential and safe; Modal auto-scales. Cap at 4 items
  // (= 4 vLLM + 4 Cloud).
  const runIndices = async (idxs: number[]) => {
    if (!idxs.length) return;
    setRunning(true);
    setProgress({ done: 0, total: idxs.length });
    let done = 0;
    let cursor = 0;
    const CAP = Math.min(4, idxs.length);
    const worker = async () => {
      while (cursor < idxs.length) {
        const i = idxs[cursor++];
        const r = await runPair(files[i], i);
        setResults((prev) => ({ ...prev, [i]: r }));
        done += 1;
        setProgress({ done, total: idxs.length });
      }
    };
    try {
      await Promise.all(Array.from({ length: CAP }, worker));
    } finally {
      setRunning(false);
      setProgress(null);
      setStage(null);
      setDocProg(null);
    }
    toast.success(`Ran ${idxs.length} comparison(s)`);
  };

  const runAll = () => runIndices(files.map((_, i) => i));
  // Only the files that haven't completed yet — so a partial batch (some items
  // failed / were interrupted) finishes without re-running the whole set.
  const runRemaining = () => runIndices(files.map((_, i) => i).filter((i) => !paneOk(results[i])));

  const onVote = (choice: Choice) => {
    setVotes((prev) => ({ ...prev, [activeIdx]: choice }));
    setTally(bumpTally(mode, choice));
    toast.info(choice === 'tie' ? 'Marked as tie' : `Preferred ${BACKEND_NAME[choice]}`);
  };

  const paneOk = (r?: RunResult) => !!r && r.default.data !== undefined && r.vllm.data !== undefined;
  const bothOk = paneOk(result);
  const doneIdxs = files.map((_, i) => i).filter((i) => paneOk(results[i]));

  // CER scorecard across labeled + completed items (CER is the right metric for
  // Khmer; WER is English-oriented, so it's intentionally not shown).
  const scoredIdxs = doneIdxs.filter((i) => labels[i]);
  const nScored = scoredIdxs.length;
  const score = scoredIdxs.reduce(
    (a, i) => {
      const r = results[i];
      const truth = labels[i];
      const cd = cer(truth, textOf(mode, r.default.data));
      const cv = cer(truth, textOf(mode, r.vllm.data));
      a.cerD += cd;
      a.cerV += cv;
      if (cv < cd) a.winV += 1;
      else if (cd < cv) a.winD += 1;
      else a.tie += 1;
      return a;
    },
    { cerD: 0, cerV: 0, winD: 0, winV: 0, tie: 0 },
  );

  // Per-backend CER for the active labeled item (shown in pane headers).
  // Compare only ever pits the two original backends against each other, so the
  // key is the RunResult shape ('default' | 'vllm'), not the wider BackendId.
  const activeCer = (backend: 'default' | 'vllm'): number | null => {
    if (!activeLabel || !result || result[backend].data === undefined) return null;
    return cer(activeLabel, textOf(mode, result[backend].data));
  };

  const panesOf = (r: RunResult): ComparePane[] => [
    { backend: 'default', ms: r.default.ms, data: r.default.data as ComparePane['data'], pageMs: r.default.pageMs },
    { backend: 'vllm', ms: r.vllm.ms, data: r.vllm.data as ComparePane['data'], pageMs: r.vllm.pageMs },
  ];

  const saveToHistory = async () => {
    if (!bothOk || !file || !result) return;
    const sourcePreview = await makePreview(file);
    const rec: CompareRecord = { kind: 'compare', mode, panes: panesOf(result), preferred: vote ?? undefined, sourcePreview };
    history.addRun({ tab: 'compare', filename: file.name, fileSize: file.size, settings: { mode }, result: rec });
    toast.success('Saved comparison to History');
  };

  const saveAll = async () => {
    let n = 0;
    for (const i of doneIdxs) {
      const r = results[i];
      const f = files[i];
      if (!r || !f) continue;
      const sourcePreview = await makePreview(f);
      const rec: CompareRecord = { kind: 'compare', mode, panes: panesOf(r), preferred: votes[i] ?? undefined, sourcePreview };
      history.addRun({ tab: 'compare', filename: f.name, fileSize: f.size, settings: { mode }, result: rec });
      n++;
    }
    toast.success(`Saved ${n} comparison(s) to History`);
  };

  const downloadActive = async () => {
    if (!bothOk || !file || !result) return;
    const imgDataUrl = await fileToDataUrl(file);
    const html = buildCompareHtml({
      filename: file.name,
      mode,
      panes: panesOf(result),
      preferred: preferredLabel(vote),
      imgDataUrl,
      generatedAt: new Date().toLocaleString(),
    });
    downloadText(`${file.name.replace(/\.[^.]+$/, '')}-comparison.html`, html, 'text/html;charset=utf-8');
    toast.success('Downloaded comparison');
  };

  const downloadAll = async () => {
    const items = [];
    for (const i of doneIdxs) {
      const r = results[i];
      const f = files[i];
      if (!r || !f) continue;
      items.push({
        filename: f.name,
        mode,
        panes: panesOf(r),
        preferred: preferredLabel(votes[i] ?? null),
        imgDataUrl: await fileToDataUrl(f),
      });
    }
    if (!items.length) return;
    const html = buildBatchCompareHtml({ items, generatedAt: new Date().toLocaleString() });
    downloadText(`batch-comparison-${items.length}.html`, html, 'text/html;charset=utf-8');
    toast.success(`Downloaded ${items.length}-item comparison`);
  };

  // --- DOCX benchmark export ------------------------------------------------ //
  const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  // Markdown is compared for ALL pages; box-overlay images are heavier (a PDF
  // re-raster per page), so bound them generously rather than uncapped.
  const MAX_BOX_PAGES = 50;

  const loadImg = (src: string): Promise<HTMLImageElement> =>
    new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });

  // Base page image: rasterize the PDF page (or decode the image file).
  const loadPageImage = async (f: File, srcPage: number): Promise<HTMLImageElement | ImageBitmap | null> => {
    try {
      if (isPdfFile(f)) return await loadImg(await renderPdfPagePreview(f, srcPage, 1100));
      return await createImageBitmap(f);
    } catch {
      return null;
    }
  };

  const bmpDims = (bmp: HTMLImageElement | ImageBitmap) => ({
    w: (bmp as ImageBitmap).width || (bmp as HTMLImageElement).naturalWidth,
    h: (bmp as ImageBitmap).height || (bmp as HTMLImageElement).naturalHeight,
  });

  // Draw one backend's detected regions over the page image → PNG data-URL.
  const drawBoxes = (
    bmp: HTMLImageElement | ImageBitmap,
    page: PageResult,
    maxDim = 1000,
  ): { dataUrl: string; w: number; h: number } | null => {
    const pw = page.width || 1;
    const ph = page.height || 1;
    const scale = Math.min(1, maxDim / Math.max(pw, ph));
    const cw = Math.max(1, Math.round(pw * scale));
    const ch = Math.max(1, Math.round(ph * scale));
    const c = document.createElement('canvas');
    c.width = cw;
    c.height = ch;
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(bmp, 0, 0, cw, ch);
    ctx.lineWidth = Math.max(1.5, cw / 400);
    for (const r of page.regions) {
      const rect = orientedBboxToRect(r.bbox);
      ctx.strokeStyle = colorForRegion(r.region_type);
      ctx.strokeRect(rect.x * scale, rect.y * scale, rect.w * scale, rect.h * scale);
    }
    return { dataUrl: c.toDataURL('image/png'), w: cw, h: ch };
  };

  // Draw a table's detected CELL boxes over the page image → PNG data-URL. Cells
  // are in the result's width×height space; degenerate/out-of-page cells (e.g.
  // the vLLM text fallback with zero bboxes) are skipped. null if nothing drawn.
  const drawTableCells = (
    bmp: HTMLImageElement | ImageBitmap,
    table: TableResult,
    maxDim = 1000,
  ): { dataUrl: string; w: number; h: number } | null => {
    const pw = table.width || bmpDims(bmp).w || 1;
    const ph = table.height || bmpDims(bmp).h || 1;
    const scale = Math.min(1, maxDim / Math.max(pw, ph));
    const cw = Math.max(1, Math.round(pw * scale));
    const ch = Math.max(1, Math.round(ph * scale));
    const c = document.createElement('canvas');
    c.width = cw;
    c.height = ch;
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(bmp, 0, 0, cw, ch);
    ctx.lineWidth = Math.max(1, cw / 500);
    ctx.strokeStyle = '#2563eb';
    let drawn = 0;
    for (const cell of table.cells) {
      const rect = orientedBboxToRect(cell.bbox);
      if (rect.w <= 1 || rect.h <= 1 || rect.x > pw || rect.y > ph) continue;
      ctx.strokeRect(rect.x * scale, rect.y * scale, rect.w * scale, rect.h * scale);
      drawn++;
    }
    return drawn > 0 ? { dataUrl: c.toDataURL('image/png'), w: cw, h: ch } : null;
  };

  // The page image with NO boxes → PNG data-URL, sized like drawTableCells so
  // both sides of the "detected cells" two-column line up. Used as the fallback
  // for a backend whose table result has no drawable cell bboxes.
  const drawPlainImage = (
    bmp: HTMLImageElement | ImageBitmap,
    maxDim = 1000,
  ): { dataUrl: string; w: number; h: number } | null => {
    const { w: bw, h: bh } = bmpDims(bmp);
    const scale = Math.min(1, maxDim / Math.max(bw || 1, bh || 1));
    const cw = Math.max(1, Math.round((bw || 1) * scale));
    const ch = Math.max(1, Math.round((bh || 1) * scale));
    const c = document.createElement('canvas');
    c.width = cw;
    c.height = ch;
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(bmp, 0, 0, cw, ch);
    return { dataUrl: c.toDataURL('image/png'), w: cw, h: ch };
  };

  // A downscaled PNG of the source image (+ dims) to embed in the docx. Handles
  // PDFs (rasterizes the given page) as well as image files.
  const sourceImageData = async (
    f: File,
    page = 1,
  ): Promise<{ dataUrl: string; w: number; h: number } | undefined> => {
    try {
      const bmp = await loadPageImage(f, page);
      if (!bmp) return undefined;
      const { w: bw, h: bh } = bmpDims(bmp);
      const scale = Math.min(1, 900 / Math.max(bw, bh));
      const w = Math.max(1, Math.round(bw * scale));
      const h = Math.max(1, Math.round(bh * scale));
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d');
      if (!ctx) return undefined;
      ctx.drawImage(bmp, 0, 0, w, h);
      (bmp as ImageBitmap).close?.();
      return { dataUrl: c.toDataURL('image/png'), w, h };
    } catch {
      return undefined;
    }
  };

  const buildDocxItem = async (f: File, idx: number, r: RunResult): Promise<CompareDocxItem> => {
    const panes: CompareDocxItem['panes'] = [
      { backend: 'default', ms: r.default.ms, data: r.default.data as CompareDocxItem['panes'][number]['data'], pageMs: r.default.pageMs, error: r.default.error },
      { backend: 'vllm', ms: r.vllm.ms, data: r.vllm.data as CompareDocxItem['panes'][number]['data'], pageMs: r.vllm.pageMs, error: r.vllm.error },
    ];

    const src = runPages[idx] ?? [];
    const firstPage = src[0] ?? 1;
    const tableMulti = mode === 'table' && src.length > 1;

    // Standalone source image for single-page image inputs (OCR / single-page
    // table / dataset rows). Document mode shows per-page box images, and
    // multi-page table now shows a source image PER PAGE below — skip both here.
    const sourceImage = mode === 'document' || tableMulti ? undefined : await sourceImageData(f, firstPage);

    let pageImages: CompareDocxPageImage[] | undefined;
    if (mode === 'document' && r.default.data && r.vllm.data) {
      const dDoc = r.default.data as DocumentResult;
      const vDoc = r.vllm.data as DocumentResult;
      const np = Math.min(dDoc.pages.length, vDoc.pages.length, MAX_BOX_PAGES);
      pageImages = [];
      for (let i = 0; i < np; i++) {
        const srcPage = src[i] ?? i + 1;
        const bmp = await loadPageImage(f, srcPage);
        if (!bmp) continue;
        const di = drawBoxes(bmp, dDoc.pages[i]);
        const vi = drawBoxes(bmp, vDoc.pages[i]);
        (bmp as ImageBitmap).close?.();
        if (di || vi) {
          pageImages.push({ page: srcPage, w: (di ?? vi)!.w, h: (di ?? vi)!.h, default: di?.dataUrl, vllm: vi?.dataUrl });
        }
      }
    } else if (tableMulti) {
      // Multi-page table: page-by-page like document mode — one plain source
      // image per selected page (cell boxes can't span pages in the merged
      // result). The docx pairs pageImages[i] with that page's ## Page chunk.
      pageImages = [];
      const np = Math.min(src.length, MAX_BOX_PAGES);
      for (let i = 0; i < np; i++) {
        const bmp = await loadPageImage(f, src[i]);
        if (!bmp) continue;
        const pi = drawPlainImage(bmp);
        (bmp as ImageBitmap).close?.();
        if (pi) pageImages.push({ page: i + 1, w: pi.w, h: pi.h, plain: pi.dataUrl });
      }
    }

    // Single-page table: draw each backend's detected CELL boxes over the page,
    // falling back to the plain page image when a backend has no usable bboxes.
    let cellBoxes: CompareDocxItem['cellBoxes'];
    if (mode === 'table' && src.length <= 1 && r.default.data && r.vllm.data) {
      const bmp = await loadPageImage(f, firstPage);
      if (bmp) {
        const plain = drawPlainImage(bmp);
        const di = drawTableCells(bmp, r.default.data as TableResult) ?? plain;
        const vi = drawTableCells(bmp, r.vllm.data as TableResult) ?? plain;
        (bmp as ImageBitmap).close?.();
        if (di || vi) cellBoxes = { w: (di ?? vi)!.w, h: (di ?? vi)!.h, default: di?.dataUrl, vllm: vi?.dataUrl };
      }
    }

    return {
      filename: f.name,
      mode,
      panes,
      preferred: preferredLabel(votes[idx] ?? null),
      groundTruth: labels[idx],
      pageImages,
      sourceImage,
      cellBoxes,
    };
  };

  const downloadActiveDocx = async () => {
    if (!file || !result) return;
    setExporting(true);
    try {
      const item = await buildDocxItem(file, activeIdx, result);
      const generatedAt = new Date().toLocaleString();
      const bytes = await buildCompareDocx({ items: [item], generatedAt });
      const base = file.name.replace(/\.[^.]+$/, '');
      downloadBytes(`${base}-benchmark.docx`, bytes, DOCX_MIME);
      // Companion full raw JSON output (base64 stripped).
      downloadText(`${base}-output.json`, buildOutputsJson([item], generatedAt), 'application/json;charset=utf-8');
      // Companion ground-truth .txt (dataset rows) so labels are easy to check.
      if (item.groundTruth && item.groundTruth.trim()) {
        downloadText(`${base}-groundtruth.txt`, buildGroundTruthTxt([item], generatedAt), 'text/plain;charset=utf-8');
      }
      toast.success('Downloaded .docx benchmark');
    } catch (e) {
      console.error('[compare] docx export failed', e);
      toast.error('DOCX export failed');
    } finally {
      setExporting(false);
    }
  };

  const downloadAllDocx = async () => {
    setExporting(true);
    try {
      const items: CompareDocxItem[] = [];
      for (const i of doneIdxs) {
        const r = results[i];
        const f = files[i];
        if (r && f) items.push(await buildDocxItem(f, i, r));
      }
      if (!items.length) return;
      const generatedAt = new Date().toLocaleString();
      const bytes = await buildCompareDocx({ items, generatedAt });
      downloadBytes(`batch-benchmark-${items.length}.docx`, bytes, DOCX_MIME);
      // Companion full raw JSON output (base64 stripped).
      downloadText(`batch-output-${items.length}.json`, buildOutputsJson(items, generatedAt), 'application/json;charset=utf-8');
      // Companion ground-truth .txt when any item is labeled (dataset eval).
      if (items.some((it) => it.groundTruth && it.groundTruth.trim())) {
        downloadText(`batch-groundtruth-${items.length}.txt`, buildGroundTruthTxt(items, generatedAt), 'text/plain;charset=utf-8');
      }
      toast.success(`Downloaded ${items.length}-item .docx benchmark`);
    } catch (e) {
      console.error('[compare] batch docx export failed', e);
      toast.error('DOCX export failed');
    } finally {
      setExporting(false);
    }
  };

  const multi = files.length > 1;

  return (
    <div className="min-h-[calc(100vh-116px)] text-slate-950">
      {/* Controls */}
      <div className="card mb-5 p-5">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center rounded-lg border border-slate-200 bg-white p-0.5 shadow-sm">
            {MODES.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => {
                  setMode(m.id);
                  resetRuns();
                }}
                aria-pressed={mode === m.id}
                className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                  mode === m.id ? 'bg-slate-950 text-white' : 'text-slate-500 hover:bg-slate-50 hover:text-slate-950'
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>
          <div className="ml-auto flex items-center gap-2 text-xs text-slate-500">
            <span>Tally — Cloud {counts.default} · Tie {counts.tie} · vLLM {counts.vllm}</span>
          </div>
        </div>

        {/* Input source: images vs labeled parquet dataset */}
        <div className="mt-4 flex items-center gap-2">
          <div className="flex items-center rounded-lg border border-slate-200 bg-white p-0.5 shadow-sm">
            {(['images', 'dataset'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setInputMode(m)}
                aria-pressed={inputMode === m}
                className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                  inputMode === m ? 'bg-slate-950 text-white' : 'text-slate-500 hover:bg-slate-50 hover:text-slate-950'
                }`}
              >
                {m === 'images' ? 'Images' : 'Dataset (.parquet)'}
              </button>
            ))}
          </div>
          {inputMode === 'dataset' && labels.length > 0 && (
            <span className="text-xs text-slate-500">{labels.length} labeled samples loaded</span>
          )}
        </div>

        {inputMode === 'images' ? (
          <div className="mt-3">
            <FileDropzone accept={accept} files={files} onChange={onFilesChange} disabled={running} multiple />
          </div>
        ) : (
          <div className="mt-3 flex flex-wrap items-center gap-3 rounded-xl border border-dashed border-slate-300 bg-slate-50 p-4">
            <label className="btn-secondary cursor-pointer">
              Choose .parquet
              <input
                type="file"
                accept=".parquet"
                className="hidden"
                onChange={(e) => setParquetFile(e.target.files?.[0] ?? null)}
              />
            </label>
            {parquetFile && <span className="text-xs text-slate-500">{parquetFile.name}</span>}
            <label className="flex items-center gap-1.5 text-xs text-slate-600">
              Samples:
              <input
                type="number"
                min={1}
                value={sampleCount}
                onChange={(e) => setSampleCount(Math.max(1, Number(e.target.value) || 1))}
                className="w-24 rounded-lg border border-slate-200 bg-white px-2 py-1 text-sm"
              />
            </label>
            <button type="button" className="btn-primary" disabled={!parquetFile || loadingDs} onClick={() => loadDataset(false)}>
              {loadingDs ? 'Reading…' : `Load ${sampleCount}`}
            </button>
            <button type="button" className="btn-ghost text-xs" disabled={!parquetFile || loadingDs} onClick={() => loadDataset(true)}>
              Load all
            </button>
            <span className="text-[11px] text-slate-400">expects {'{ image:{bytes}, label }'} rows · ground truth enables CER</span>
            {dsError && (
              <div className="w-full rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800">
                <span className="font-semibold">Couldn’t read images:</span>{' '}
                <span className="break-words font-mono">{dsError}</span>
              </div>
            )}
          </div>
        )}

        {/* Item selector: chips for a few, a stepper for many (datasets) */}
        {multi && files.length <= 12 && (
          <div className="mt-4 flex gap-2 overflow-x-auto pb-1">
            {files.map((f, i) => {
              const done = paneOk(results[i]);
              return (
                <button
                  key={i}
                  type="button"
                  onClick={() => setActiveIdx(i)}
                  aria-pressed={i === activeIdx}
                  className={`flex shrink-0 items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
                    i === activeIdx
                      ? 'border-accent bg-accent/10 text-slate-950'
                      : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                  }`}
                  title={f.name}
                >
                  <span>{i + 1}. {f.name.length > 16 ? f.name.slice(0, 14) + '…' : f.name}</span>
                  {done && <span className="text-emerald-500">✓</span>}
                </button>
              );
            })}
          </div>
        )}
        {files.length > 12 && (
          <div className="mt-4 flex items-center gap-2">
            <button
              type="button"
              onClick={() => setActiveIdx((i) => Math.max(0, i - 1))}
              disabled={activeIdx === 0}
              className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-40"
            >
              ◀
            </button>
            <span className="text-xs tabular-nums text-slate-600">
              Item {activeIdx + 1} / {files.length} {paneOk(results[activeIdx]) && <span className="text-emerald-500">✓</span>}
            </span>
            <button
              type="button"
              onClick={() => setActiveIdx((i) => Math.min(files.length - 1, i + 1))}
              disabled={activeIdx >= files.length - 1}
              className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-40"
            >
              ▶
            </button>
            <span className="text-xs text-slate-500">· {doneIdxs.length} done</span>
          </div>
        )}

        {/* Page selection (any mode, PDF only) — all selected pages are processed. */}
        {isPdfFile(file) && (
          <div className="mt-4 flex flex-wrap items-center gap-2 text-sm">
            <label htmlFor="compare-pages" className="font-medium text-slate-700">
              Pages:
            </label>
            <input
              id="compare-pages"
              type="text"
              value={pageRanges[activeIdx] ?? ''}
              onChange={(e) => setPageRanges((prev) => ({ ...prev, [activeIdx]: e.target.value }))}
              placeholder={pdfPageCounts[activeIdx] ? `all · 1–${pdfPageCounts[activeIdx]}` : 'loading…'}
              spellCheck={false}
              disabled={running}
              className="w-40 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-sm shadow-sm focus:border-accent focus:outline-none disabled:opacity-50"
            />
            {pdfPageCounts[activeIdx] ? (
              <span className="text-xs text-slate-500">
                {resolvePages(activeIdx, pdfPageCounts[activeIdx]).length} of {pdfPageCounts[activeIdx]} · empty = all · e.g. 1-3, 5
              </span>
            ) : (
              <span className="text-xs text-slate-400">reading page count…</span>
            )}
          </div>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button type="button" className="btn-primary" disabled={!file || running} onClick={runActive}>
            {running && !progress ? 'Running…' : result ? 'Run again' : 'Run both'}
          </button>
          {multi && (
            <button type="button" className="btn-secondary" disabled={running} onClick={runAll}>
              Run all ({files.length})
            </button>
          )}
          {/* Finish a partial batch: only the items that didn't complete, so a
              handful of failures don't force re-running all 2000. */}
          {multi && doneIdxs.length > 0 && doneIdxs.length < files.length && (
            <button type="button" className="btn-secondary" disabled={running} onClick={runRemaining}>
              Run remaining ({files.length - doneIdxs.length})
            </button>
          )}
          {progress || stage || docProg ? (
            <span className="flex items-center gap-2 text-xs text-slate-500">
              {progress && (
                <span className="tabular-nums font-medium text-slate-600">
                  File {progress.done}/{progress.total}
                </span>
              )}
              {stage && (
                <span className="flex items-center gap-1.5">
                  {progress && <span className="text-slate-300">·</span>}
                  <span className="h-3 w-3 animate-spin rounded-full border-2 border-slate-300 border-t-accent" />
                  {stage.total ? `${stage.label} ${stage.done}/${stage.total}` : stage.label}
                </span>
              )}
              {docProg && (
                <span className="flex items-center gap-1.5 tabular-nums">
                  {(progress || stage) && <span className="text-slate-300">·</span>}
                  <span className="h-3 w-3 animate-spin rounded-full border-2 border-slate-300 border-t-accent" />
                  Page {docProg.default}/{docProg.total} on Khmer Parsing API · {docProg.vllm}/{docProg.total} on Surya
                </span>
              )}
            </span>
          ) : (
            file && <span className="text-xs text-slate-500">{file.name}</span>
          )}
        </div>
      </div>

      {/* Document view switch (markdown vs boxes) + page stepper */}
      {mode === 'document' && result && (
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-500">View:</span>
            <div className="flex items-center rounded-lg border border-slate-200 bg-white p-0.5 shadow-sm">
              {(['markdown', 'boxes'] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setDocView(v)}
                  aria-pressed={docView === v}
                  className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                    docView === v ? 'bg-slate-950 text-white' : 'text-slate-500 hover:bg-slate-50 hover:text-slate-950'
                  }`}
                >
                  {v === 'markdown' ? 'Markdown' : 'Boxes'}
                </button>
              ))}
            </div>
          </div>
          {pageCount > 1 && (
            <div className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white p-0.5 shadow-sm">
              <button
                type="button"
                onClick={() => setPageIdx((p) => Math.max(0, p - 1))}
                disabled={pageIdx === 0}
                className="rounded-md px-2 py-1 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-40"
                aria-label="Previous page"
              >
                ◀
              </button>
              <span className="px-1 text-xs tabular-nums text-slate-600">
                Page {pageIdx + 1} / {pageCount}
              </span>
              <button
                type="button"
                onClick={() => setPageIdx((p) => Math.min(pageCount - 1, p + 1))}
                disabled={pageIdx >= pageCount - 1}
                className="rounded-md px-2 py-1 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-40"
                aria-label="Next page"
              >
                ▶
              </button>
              {pdfLoading && <span className="px-1 text-[11px] text-slate-400">rendering…</span>}
            </div>
          )}
        </div>
      )}

      {/* Ground truth (dataset items) */}
      {activeLabel && (
        <div className="mb-3 max-h-24 overflow-auto rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700">
          <span className="font-semibold text-slate-950">Ground truth:</span>{' '}
          <span className="whitespace-pre-wrap break-words">{activeLabel}</span>
        </div>
      )}

      {/* Preview controls — collapse the source, zoom the text. */}
      <div className="mb-2 flex flex-wrap items-center justify-end gap-2 text-xs">
        <button
          type="button"
          onClick={() => setShowSource((s) => !s)}
          className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 font-semibold text-slate-600 shadow-sm hover:bg-slate-50 hover:text-slate-950"
          title={showSource ? 'Hide the source image to widen the text panes' : 'Show the source image'}
        >
          {showSource ? '⤢ Hide source' : '⤡ Show source'}
        </button>
        <div className="flex items-center overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
          <button type="button" onClick={() => setPaneZoom((z) => Math.max(0.7, +(z - 0.1).toFixed(2)))} className="px-2.5 py-1 font-semibold text-slate-600 hover:bg-slate-50" title="Smaller text">A−</button>
          <span className="min-w-[3ch] border-x border-slate-200 px-1.5 py-1 text-center font-mono text-[11px] text-slate-500">{Math.round(paneZoom * 100)}%</span>
          <button type="button" onClick={() => setPaneZoom((z) => Math.min(1.8, +(z + 0.1).toFixed(2)))} className="px-2.5 py-1 font-semibold text-slate-600 hover:bg-slate-50" title="Larger text">A+</button>
        </div>
      </div>

      {/* Results: source | Cloud | vLLM (source collapsible) */}
      <div className={`grid gap-4 ${showSource ? 'lg:grid-cols-[0.7fr_1fr_1fr]' : 'lg:grid-cols-2'}`}>
        {showSource && (
          <ResultCard title="Source">
            {displayImageUrl ? (
              <ZoomableImage imageUrl={displayImageUrl} alt="source" minHeightClass="min-h-[260px]" enableKeyboard={false} />
            ) : (
              <div className="grid h-[260px] place-items-center rounded-lg border border-dashed border-slate-300 bg-slate-50 text-center text-sm text-slate-500">
                {pdfLoading ? 'Rendering page…' : file ? (mode === 'document' ? 'Rendering page…' : 'No preview') : 'Upload file(s), then Run'}
              </div>
            )}
          </ResultCard>
        )}

        {(['default', 'vllm'] as const).map((backend) => {
          const pane = result?.[backend];
          return (
            <ResultCard
              key={backend}
              title={BACKEND_NAME[backend]}
              meta={
                <span className="flex items-center gap-2 text-xs text-slate-500">
                  {pane && pane.data !== undefined && (
                    <>
                      <span>⏱ {fmtLatency(pane.ms)}</span>
                      {paneStat(mode, pane) && <span>· {paneStat(mode, pane)}</span>}
                      {activeCer(backend) !== null && (
                        <span className="font-medium text-slate-700">· CER {pct(activeCer(backend)!)}</span>
                      )}
                    </>
                  )}
                  <button
                    type="button"
                    onClick={() => runSide(backend)}
                    disabled={!file || running}
                    title={`Re-run ${BACKEND_NAME[backend]} only`}
                    className="rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-40"
                  >
                    ↻
                  </button>
                </span>
              }
            >
              {!pane ? (
                <div className="grid h-[260px] place-items-center text-sm text-slate-400">
                  {running ? 'Working…' : 'No result yet'}
                </div>
              ) : (
                <PaneBody
                  mode={mode}
                  pane={pane}
                  docView={docView}
                  imageUrl={displayImageUrl}
                  pageIdx={pageIdx}
                  zoom={paneZoom}
                  scrollRef={(el) => (paneScrollRefs.current[backend] = el)}
                  onScroll={onPaneScroll(backend)}
                />
              )}
            </ResultCard>
          );
        })}
      </div>

      {/* Save / export actions */}
      {(bothOk || doneIdxs.length > 0) && (
        <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
          {bothOk && (
            <button type="button" className="btn-secondary" onClick={saveToHistory}>
              Save to History
            </button>
          )}
          {bothOk && (
            <button type="button" className="btn-secondary" disabled={exporting} onClick={downloadActive}>
              Download .html
            </button>
          )}
          {bothOk && (
            <button type="button" className="btn-primary" disabled={exporting} onClick={downloadActiveDocx}>
              {exporting ? 'Building .docx…' : 'Download .docx'}
            </button>
          )}
          {multi && doneIdxs.length > 0 && (
            <button type="button" className="btn-secondary" onClick={saveAll}>
              Save all ({doneIdxs.length})
            </button>
          )}
          {multi && doneIdxs.length > 0 && (
            <button type="button" className="btn-secondary" disabled={exporting} onClick={downloadAll}>
              Download all .html ({doneIdxs.length})
            </button>
          )}
          {multi && doneIdxs.length > 0 && (
            <button type="button" className="btn-primary" disabled={exporting} onClick={downloadAllDocx}>
              {exporting ? 'Building .docx…' : `Download all .docx (${doneIdxs.length})`}
            </button>
          )}
        </div>
      )}

      {/* CER scorecard (labeled dataset) */}
      {nScored > 0 && (
        <div className="card mt-4 p-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-semibold text-slate-950">Accuracy scorecard</span>
            <span className="text-xs text-slate-500">{nScored} labeled · lower CER is better</span>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm">
              <div className="font-medium text-slate-950">{BACKEND_NAME.default}</div>
              <div className="text-slate-600">CER {pct(score.cerD / nScored)}</div>
            </div>
            <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm">
              <div className="font-medium text-slate-950">{BACKEND_NAME.vllm}</div>
              <div className="text-slate-600">CER {pct(score.cerV / nScored)}</div>
            </div>
          </div>
          <div className="mt-2 text-xs text-slate-500">
            Lower-CER wins — {BACKEND_NAME.vllm} {score.winV}/{nScored} · {BACKEND_NAME.default} {score.winD}/{nScored} · tie {score.tie}
            <span className="ml-2 text-slate-400">(CER = character error rate, the right metric for Khmer)</span>
          </div>
        </div>
      )}

      {/* Preference (for the active item) */}
      <div className="card mt-5 flex flex-wrap items-center justify-center gap-3 p-4">
        <span className="text-sm font-medium text-slate-950">Which looks better?</span>
        <VoteButton label="◀ Khmer Parsing API" active={vote === 'default'} disabled={!bothOk} onClick={() => onVote('default')} />
        <VoteButton label="Tie" active={vote === 'tie'} disabled={!bothOk} onClick={() => onVote('tie')} />
        <VoteButton label="Surya OCR 2 ▶" active={vote === 'vllm'} disabled={!bothOk} onClick={() => onVote('vllm')} />
      </div>
    </div>
  );
}

function ResultCard({ title, meta, children }: { title: string; meta?: ReactNode; children: ReactNode }) {
  return (
    <section className="card flex min-h-[320px] flex-col overflow-hidden">
      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-2.5">
        <span className="text-sm font-semibold text-slate-950">{title}</span>
        {meta}
      </div>
      <div className="min-h-0 flex-1 p-4">{children}</div>
    </section>
  );
}

function PaneBody({
  mode,
  pane,
  docView,
  imageUrl,
  pageIdx,
  zoom,
  scrollRef,
  onScroll,
}: {
  mode: Mode;
  pane: Pane;
  docView: 'markdown' | 'boxes';
  imageUrl?: string;
  pageIdx: number;
  zoom: number;
  scrollRef: (el: HTMLElement | null) => void;
  onScroll: (e: UIEvent<HTMLElement>) => void;
}) {
  // Taller previews (viewport-relative) so dense output is readable; the two
  // panes share a synchronized scroll and a common zoom factor.
  const PANE_H = '72vh';
  if (pane.error) return <div className="text-sm text-rose-600">{pane.error}</div>;
  if (pane.data === undefined) return null;

  if (mode === 'table') {
    // TableGrid owns its own scroll so its sticky header row works; wrap only
    // for zoom. (Grids don't need the vertical scroll-sync that text panes do.)
    const r = pane.data as TableResult;
    return (
      <div style={{ zoom }}>
        <TableGrid cells={r.cells} rows={r.num_rows} cols={r.num_cols} compact maxHeight={PANE_H} />
      </div>
    );
  }
  if (mode === 'document') {
    const r = pane.data as DocumentResult;
    const page = r.pages[pageIdx] ?? r.pages[0];
    if (!page) return <div className="text-sm text-slate-400">No page {pageIdx + 1} in this result.</div>;
    if (docView === 'boxes') {
      return (
        <div ref={scrollRef} onScroll={onScroll} className="space-y-2 overflow-auto" style={{ maxHeight: PANE_H, zoom }}>
          <PageImageWithBoxes page={page} imageUrl={imageUrl} maxHeight="60vh" />
          <RegionStats page={page} />
        </div>
      );
    }
    return (
      <MarkdownView
        source={pageToMarkdown(r, page.page_number)}
        maxHeight={PANE_H}
        showCopy
        zoom={zoom}
        scrollRef={scrollRef}
        onScroll={onScroll}
      />
    );
  }
  const r = normalizeOcrResponse(pane.data);
  return (
    <pre
      ref={scrollRef}
      onScroll={onScroll}
      className="overflow-auto whitespace-pre-wrap font-sans text-[15px] leading-relaxed text-slate-800"
      style={{ maxHeight: PANE_H, zoom }}
    >
      {r.text || '(no text returned)'}
    </pre>
  );
}

/** Region count + per-type breakdown for a parsed page (box-detection summary). */
function RegionStats({ page }: { page: DocumentResult['pages'][number] }) {
  const counts: Record<string, number> = {};
  for (const r of page.regions) counts[r.region_type] = (counts[r.region_type] ?? 0) + 1;
  const breakdown = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([type, n]) => `${n} ${type}`)
    .join(' · ');
  return (
    <div className="text-[11px] text-slate-500">
      {page.regions.length} regions{breakdown ? ` · ${breakdown}` : ''}
    </div>
  );
}

function VoteButton({
  label,
  active,
  disabled,
  onClick,
}: {
  label: string;
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className={`rounded-lg border px-4 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        active
          ? 'border-accent bg-accent/10 text-slate-950'
          : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
      }`}
    >
      {label}
    </button>
  );
}
