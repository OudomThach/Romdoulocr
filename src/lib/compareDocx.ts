// Builds a Word (.docx) benchmark report for Compare runs: a real document you
// can hand to someone, not just a screen dump.
//
// Layout is PAGE-FIRST so it's easy to compare: after a per-file summary, each
// source page gets its own section showing BOTH backends side by side — Cloud
// API on the left, vLLM (surya-ocr-2) on the right — with that page's timing,
// detected-region boxes, and extracted markdown together. You read page 1 for
// both engines, then page 2, and so on.
//
// Box images arrive pre-rendered (PNG data-URLs) from the caller, which owns the
// canvas + page rasterization; this module only assembles the docx.

import { normalizeOcrResponse, type DocumentResult, type OcrImageResponse, type TableResult } from '@/types/api';
import { docText } from '@/lib/documentExport';
import { pageToMarkdown } from '@/lib/exporters';
import { parsePipeTable } from '@/lib/tableExport';
import { cer, pct, diffChars, type DiffToken } from '@/lib/textMetrics';

const KH = 'Noto Sans Khmer';

export type CompareMode = 'ocr' | 'table' | 'document';

export interface CompareDocxPane {
  backend: 'default' | 'vllm';
  ms: number;
  data?: DocumentResult | OcrImageResponse | TableResult;
  pageMs?: { page: number; ms: number }[];
  error?: string;
}

/** One page's box-overlay images (same base page, different detected regions). */
export interface CompareDocxPageImage {
  page: number;
  w: number;
  h: number;
  default?: string; // PNG data-URL with Khmer Parsing API's boxes
  vllm?: string; // PNG data-URL with vLLM's boxes
}

export interface CompareDocxItem {
  filename: string;
  mode: CompareMode;
  panes: CompareDocxPane[];
  preferred?: string;
  groundTruth?: string;
  pageImages?: CompareDocxPageImage[];
  /** The source image (e.g. a parquet dataset row), embedded so you can see the
   * input next to the ground truth and the OCR outputs. */
  sourceImage?: { dataUrl: string; w: number; h: number };
  /** Table mode: the source page with each backend's detected CELL boxes drawn. */
  cellBoxes?: { w: number; h: number; default?: string; vllm?: string };
}

/**
 * Plain-text dump of ground truth + both engines' output per item, so the
 * dataset labels are easy to eyeball / diff outside Word. Emitted alongside the
 * .docx when the run has ground-truth labels.
 */
export function buildGroundTruthTxt(items: CompareDocxItem[], generatedAt: string): string {
  const lines: string[] = [
    'Backend Comparison — Ground Truth & Outputs',
    `Generated ${generatedAt} · ${items.length} item(s)`,
    '',
  ];
  items.forEach((it, i) => {
    const d = paneOf(it, 'default');
    const v = paneOf(it, 'vllm');
    lines.push(`==================== ${i + 1}. ${it.filename} ====================`);
    lines.push('');
    lines.push('[Ground truth]');
    lines.push((it.groundTruth ?? '(none)').trim());
    lines.push('');
    const withCer = (pane?: CompareDocxPane) =>
      it.groundTruth && pane?.data ? ` (CER ${pct(cer(it.groundTruth, paneText(it.mode, pane.data)))})` : '';
    lines.push(`[Khmer Parsing API]${withCer(d)}`);
    lines.push((d?.error ? `Error: ${d.error}` : paneText(it.mode, d?.data)).trim() || '(empty)');
    lines.push('');
    lines.push(`[Surya OCR 2]${withCer(v)}`);
    lines.push((v?.error ? `Error: ${v.error}` : paneText(it.mode, v?.data)).trim() || '(empty)');
    lines.push('');
  });
  return lines.join('\n');
}

const BACKEND_NAME: Record<'default' | 'vllm', string> = { default: 'Khmer Parsing API', vllm: 'Surya OCR 2' };

function secs(ms: number): string {
  return `${(ms / 1000).toFixed(2)}s`;
}

// Traffic-light colors. CER: lower is better. Rate (perfect/usable %): higher is
// better. Returned as bare hex (docx color format).
function cerColor(c: number): string {
  return c <= 0.05 ? '15803D' : c <= 0.15 ? 'B45309' : 'B91C1C';
}
function rateColor(r: number): string {
  return r >= 0.9 ? '15803D' : r >= 0.5 ? 'B45309' : 'B91C1C';
}
function usabilityVerdict(meanCer: number): string {
  return meanCer <= 0.05 ? 'production-ready' : meanCer <= 0.15 ? 'usable with review' : 'not usable';
}

function paneOf(item: CompareDocxItem, backend: 'default' | 'vllm'): CompareDocxPane | undefined {
  return item.panes.find((p) => p.backend === backend);
}

function regionCount(data?: CompareDocxPane['data']): number {
  const doc = data as DocumentResult | undefined;
  if (!doc?.pages) return 0;
  return doc.pages.reduce((n, p) => n + (p.regions?.length ?? 0), 0);
}

function paneText(mode: CompareMode, data?: CompareDocxPane['data']): string {
  if (!data) return '';
  // Blank-aware: full_text can arrive as "" — fall back to region text.
  if (mode === 'document') return docText(data as DocumentResult);
  if (mode === 'table') return (data as TableResult).structured_text ?? '';
  return normalizeOcrResponse(data).text ?? '';
}

function pageCountOf(data?: CompareDocxPane['data']): number {
  const doc = data as DocumentResult | undefined;
  return doc?.pages?.length ?? (data ? 1 : 0);
}

/** Markdown for ONE column at page index i (document → that page; else whole). */
function columnMarkdown(item: CompareDocxItem, pane: CompareDocxPane | undefined, i: number): string {
  if (!pane || pane.error) return pane?.error ? `Error: ${pane.error}` : '(no result)';
  const data = pane.data;
  if (!data) return '(no result)';
  if (item.mode === 'document') return pageToMarkdown(data as DocumentResult, i + 1) || '(empty)';
  if (item.mode === 'table') return (data as TableResult).structured_text || '(empty)';
  return normalizeOcrResponse(data).text || '(empty)';
}

// Fields that hold base64 image data — replaced with a short placeholder so the
// JSON stays readable (a single crop is tens of KB of gibberish otherwise).
const BASE64_KEYS = new Set(['crop_base64', 'debug_image', 'image_base64', 'sourcePreview', 'bytes']);

function stripBase64(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(stripBase64);
  if (obj && typeof obj === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      out[k] = BASE64_KEYS.has(k) && typeof v === 'string' && v.length > 0 ? `‹base64 image, ${v.length} chars omitted›` : stripBase64(v);
    }
    return out;
  }
  return obj;
}

/** Pretty JSON of a pane's raw API output (base64 stripped), capped for the doc. */
function jsonForPane(pane: CompareDocxPane | undefined, cap = 6000): string {
  if (!pane) return '(no result)';
  if (pane.error) return JSON.stringify({ error: pane.error }, null, 2);
  if (!pane.data) return '(no result)';
  const full = JSON.stringify(stripBase64(pane.data), null, 2);
  return full.length > cap ? `${full.slice(0, cap)}\n… truncated (${full.length} chars total — see the .json file)` : full;
}

/** Full raw outputs of all items as a JSON string (companion download). */
export function buildOutputsJson(items: CompareDocxItem[], generatedAt: string): string {
  const payload = {
    generated: generatedAt,
    backends: { default: 'Khmer Parsing API', vllm: 'Surya OCR 2' },
    items: items.map((it) => ({
      filename: it.filename,
      mode: it.mode,
      groundTruth: it.groundTruth ?? null,
      outputs: {
        default: stripBase64(paneOf(it, 'default')?.data ?? paneOf(it, 'default')?.error ?? null),
        vllm: stripBase64(paneOf(it, 'vllm')?.data ?? paneOf(it, 'vllm')?.error ?? null),
      },
    })),
  };
  return JSON.stringify(payload, null, 2);
}

/** dataURL → raw bytes for docx ImageRun. */
function dataUrlToBytes(u: string): Uint8Array {
  const b64 = u.slice(u.indexOf(',') + 1);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function buildCompareDocx(opts: { items: CompareDocxItem[]; generatedAt: string }): Promise<Uint8Array> {
  const docx = await import('docx');
  const {
    Document,
    Packer,
    Paragraph,
    TextRun,
    HeadingLevel,
    Table,
    TableRow,
    TableCell,
    WidthType,
    BorderStyle,
    ImageRun,
    PageBreak,
    ShadingType,
    TableLayoutType,
  } = docx;

  type Child = InstanceType<typeof Paragraph> | InstanceType<typeof Table>;
  type Run = InstanceType<typeof TextRun>;
  type Par = InstanceType<typeof Paragraph>;
  type Tbl = InstanceType<typeof Table>;
  type Block = Par | Tbl; // a cell can hold paragraphs AND (nested) tables

  const thin = { style: BorderStyle.SINGLE, size: 1, color: 'CBD5E1' };
  const allBorders = { top: thin, bottom: thin, left: thin, right: thin, insideHorizontal: thin, insideVertical: thin };

  const text = (s: string, o: { bold?: boolean; italics?: boolean; size?: number; color?: string } = {}) =>
    new TextRun({ text: s, font: KH, bold: o.bold, italics: o.italics, size: o.size, color: o.color });

  const para = (runs: Run[], o: { spacing?: number; heading?: (typeof HeadingLevel)[keyof typeof HeadingLevel] } = {}) =>
    new Paragraph({ children: runs, spacing: o.spacing ? { after: o.spacing } : undefined, heading: o.heading });

  const cellOf = (children: Par[], o: { fill?: string } = {}) =>
    new TableCell({
      shading: o.fill ? { fill: o.fill, color: 'auto', type: ShadingType.CLEAR } : undefined,
      children: children.length ? children : [new Paragraph({})],
      margins: { top: 40, bottom: 40, left: 80, right: 80 },
    });

  const textCell = (runs: Run[], o: { fill?: string } = {}) => cellOf([new Paragraph({ children: runs })], o);

  const gridTable = (header: string[], rows: Run[][][]) =>
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      layout: TableLayoutType.AUTOFIT,
      borders: allBorders,
      rows: [
        new TableRow({ tableHeader: true, children: header.map((h) => textCell([text(h, { bold: true, size: 18 })], { fill: 'E2E8F0' })) }),
        ...rows.map((r) => new TableRow({ children: r.map((runs) => textCell(runs)) })),
      ],
    });

  // Two equal columns (Khmer Parsing API | Surya OCR 2), each cell holding paragraphs
  // AND nested tables (rendered markdown tables).
  const endsWithParagraph = (blocks: Block[]): Block[] => {
    // Word requires a table cell's content to END with a paragraph; a cell that
    // ends with a (nested) table renders corrupt. Pad when needed.
    if (!blocks.length) return [new Paragraph({})];
    const last = blocks[blocks.length - 1];
    return last instanceof Table ? [...blocks, new Paragraph({})] : blocks;
  };
  const twoCol = (left: Block[], right: Block[]) =>
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      columnWidths: [4680, 4680],
      borders: allBorders,
      rows: [
        new TableRow({
          tableHeader: true,
          children: [textCell([text('Khmer Parsing API', { bold: true, size: 18 })], { fill: 'E2E8F0' }), textCell([text('Surya OCR 2 · vLLM', { bold: true, size: 18 })], { fill: 'E2E8F0' })],
        }),
        new TableRow({
          children: [
            new TableCell({ width: { size: 50, type: WidthType.PERCENTAGE }, margins: { top: 60, bottom: 60, left: 100, right: 100 }, children: endsWithParagraph(left) }),
            new TableCell({ width: { size: 50, type: WidthType.PERCENTAGE }, margins: { top: 60, bottom: 60, left: 100, right: 100 }, children: endsWithParagraph(right) }),
          ],
        }),
      ],
    });

  const imagePara = (url: string | undefined, w: number, h: number): Par => {
    if (!url) return new Paragraph({ children: [text('(no image)', { italics: true, color: '94A3B8' })] });
    const dispW = 250;
    const dispH = w > 0 ? Math.round((h / w) * dispW) : 320;
    return new Paragraph({ children: [new ImageRun({ type: 'png', data: dataUrlToBytes(url), transformation: { width: dispW, height: dispH } })] });
  };

  // Tracked-changes rendering of a diff: red = wrong/extra char the OCR produced,
  // blue strikethrough = a reference char the OCR missed. Splits on newlines so
  // multi-line output stays readable.
  const diffRun = (kind: DiffToken['kind'], seg: string): Run => {
    if (kind === 'delete') return new TextRun({ text: seg, font: KH, size: 18, color: '2563EB', strike: true });
    if (kind === 'replace' || kind === 'insert') return new TextRun({ text: seg, font: KH, size: 18, color: 'B91C1C', bold: true });
    return new TextRun({ text: seg, font: KH, size: 18 });
  };
  const diffParas = (tokens: DiffToken[]): Block[] => {
    const paras: Par[] = [];
    let runs: Run[] = [];
    const flush = () => {
      paras.push(new Paragraph({ children: runs.length ? runs : [text(' ')] }));
      runs = [];
    };
    for (const t of tokens) {
      const segs = t.text.split('\n');
      segs.forEach((seg, k) => {
        if (k > 0) flush();
        if (seg) runs.push(diffRun(t.kind, seg));
      });
    }
    flush();
    return paras.length ? paras : [new Paragraph({})];
  };

  // A markdown pipe-table → a real (nested) Word table.
  // Render a pipe table as a real Word table. Column count drives the font size
  // and (critically) the table layout: AUTOFIT lets Word size columns to their
  // content instead of equal-splitting a narrow cell into one-glyph columns.
  const mdTable = (parsed: { headers: string[]; rows: string[][] }, fontSize: number): Tbl => {
    const padM = { top: 24, bottom: 24, left: 48, right: 48 };
    return new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      layout: TableLayoutType.AUTOFIT,
      borders: allBorders,
      rows: [
        new TableRow({
          tableHeader: true,
          children: parsed.headers.map(
            (h) =>
              new TableCell({
                shading: { fill: 'F1F5F9', color: 'auto', type: ShadingType.CLEAR },
                margins: padM,
                children: [new Paragraph({ children: [text(h, { bold: true, size: fontSize })] })],
              }),
          ),
        }),
        ...parsed.rows.map(
          (r) =>
            new TableRow({
              children: r.map(
                (c) => new TableCell({ margins: padM, children: [new Paragraph({ children: [text(c, { size: fontSize })] })] }),
              ),
            }),
        ),
      ],
    });
  };

  // SMART table block rendering. A side-by-side comparison cell is only ~3" wide,
  // so a wide or sparse "table" (e.g. an OCR misparse with 11 columns of single
  // glyphs) renders as an unreadable one-char-per-line grid. Detect those and
  // fall back to compact text rows instead of forcing a broken grid.
  const renderTableBlock = (parsed: { headers: string[]; rows: string[][] }, raw: string[]): Block[] => {
    const cols = parsed.headers.length;
    const headerNonEmpty = parsed.headers.filter((h) => h.trim()).length;
    const allCells = parsed.headers.length + parsed.rows.reduce((n, r) => n + r.length, 0);
    const emptyCells =
      parsed.headers.filter((h) => !h.trim()).length +
      parsed.rows.reduce((n, r) => n + r.filter((c) => !c.trim()).length, 0);
    const emptyRatio = allCells ? emptyCells / allCells : 1;

    // Render a real grid ONLY when it's well-formed and not absurdly wide. The
    // fallbacks below catch the OCR-misparse case (many columns of single
    // glyphs, mostly-empty cells, a near-blank header row) that otherwise
    // collapses into an unreadable one-char-per-line grid in a ~3" cell.
    const degenerate = cols > 12 || emptyRatio > 0.45 || (headerNonEmpty <= 1 && cols > 3);
    if (degenerate) {
      // Collapse each row to its non-empty cells joined by " · " — keeps the
      // data legible and compact instead of a crushed micro-grid.
      const compact: Block[] = [];
      const headerLine = parsed.headers.map((h) => h.trim()).filter(Boolean).join(' · ');
      if (headerLine) compact.push(new Paragraph({ children: [text(headerLine, { bold: true, size: 15 })] }));
      for (const r of parsed.rows) {
        const line = r.map((c) => c.trim()).filter(Boolean).join(' · ');
        if (line) compact.push(new Paragraph({ children: [text(line, { size: 15 })] }));
      }
      return compact.length ? compact : raw.map((l) => new Paragraph({ children: [text(l || ' ', { size: 14 })] }));
    }

    // Fits: render a real table, shrinking the font as columns grow.
    const fontSize = cols >= 8 ? 12 : cols >= 6 ? 13 : cols >= 5 ? 14 : cols >= 4 ? 15 : 16;
    return [mdTable(parsed, fontSize)];
  };

  // Raw markdown SOURCE: the literal text (pipes, #, -) shown verbatim in a
  // light-shaded "code block" so you can read/copy exactly what each engine
  // emitted, alongside the rendered version above.
  const rawMarkdownBlocks = (md: string): Block[] =>
    md.split('\n').map(
      (line) =>
        new Paragraph({
          children: [text(line || ' ', { size: 14 })],
          shading: { type: ShadingType.CLEAR, color: 'auto', fill: 'F1F5F9' },
          spacing: { before: 0, after: 0 },
        }),
    );

  // Render a markdown string into docx blocks, turning pipe-table blocks into
  // (smartly rendered) tables and everything else into paragraphs.
  const looksLikeTableRow = (l: string) => l.trim().startsWith('|');
  const markdownToBlocks = (md: string): Block[] => {
    const lines = md.split('\n');
    const out: Block[] = [];
    let i = 0;
    while (i < lines.length) {
      if (looksLikeTableRow(lines[i])) {
        let j = i;
        const block: string[] = [];
        while (j < lines.length && looksLikeTableRow(lines[j])) {
          block.push(lines[j]);
          j++;
        }
        const parsed = parsePipeTable(block.join('\n'));
        if (parsed && parsed.rows.length > 0) {
          out.push(...renderTableBlock(parsed, block));
        } else {
          for (const b of block) out.push(new Paragraph({ children: [text(b || ' ', { size: 18 })] }));
        }
        i = j;
      } else {
        out.push(new Paragraph({ children: [text(lines[i] || ' ', { size: 18 })] }));
        i++;
      }
    }
    return out.length ? out : [new Paragraph({})];
  };

  const children: Child[] = [];

  children.push(para([text('Backend Comparison — Benchmark Report', { bold: true, size: 32 })]));
  children.push(para([text(`Generated ${opts.generatedAt} · ${opts.items.length} item(s) · Khmer Parsing API vs Surya OCR 2 (vLLM)`, { size: 18, color: '64748B' })], { spacing: 200 }));

  // --- aggregate scorecard (only when we have ground-truth labels) ----------
  const labeled = opts.items.filter((it) => it.groundTruth && it.groundTruth.trim().length > 0);
  const multiItem = opts.items.length > 1;
  if (labeled.length > 0 || multiItem) {
    // Collect per-item CER + latency for each backend so we can report real
    // aggregates (mean/median/spread), not just a single average.
    const cersD: number[] = [];
    const cersV: number[] = [];
    const msD: number[] = [];
    const msV: number[] = [];
    let winD = 0;
    let winV = 0;
    let tie = 0;
    for (const it of opts.items) {
      const d = paneOf(it, 'default');
      const v = paneOf(it, 'vllm');
      if (d && d.data) msD.push(d.ms);
      if (v && v.data) msV.push(v.ms);
      if (it.groundTruth && it.groundTruth.trim()) {
        const cd = cer(it.groundTruth, paneText(it.mode, d?.data));
        const cv = cer(it.groundTruth, paneText(it.mode, v?.data));
        cersD.push(cd);
        cersV.push(cv);
        if (cv < cd) winV++;
        else if (cd < cv) winD++;
        else tie++;
      }
    }
    const aggStats = (xs: number[]) => {
      const n = xs.length;
      if (!n) return null;
      const sorted = [...xs].sort((a, b) => a - b);
      const mean = xs.reduce((a, b) => a + b, 0) / n;
      const median = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
      const perfect = xs.filter((c) => c === 0).length / n; // exact-match rate
      const usable = xs.filter((c) => c <= 0.1).length / n; // CER ≤ 10%
      return { mean, median, perfect, usable, worst: sorted[n - 1] };
    };
    const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
    const total = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
    const cerCell = (c: number) => [text(pct(c), { color: cerColor(c) })];
    const rateCell = (r: number) => [text(pct(r), { color: rateColor(r) })];

    const sD = aggStats(cersD);
    const sV = aggStats(cersV);

    // Plain-English verdict up top — the thing most readers actually want.
    if (sD && sV) {
      children.push(
        para(
          [
            text('Verdict: ', { bold: true, size: 20 }),
            text(`${BACKEND_NAME.default} is `, { size: 18 }),
            text(usabilityVerdict(sD.mean), { bold: true, size: 18, color: cerColor(sD.mean) }),
            text(` (mean CER ${pct(sD.mean)}, ${pct(sD.perfect)} perfect). ${BACKEND_NAME.vllm} is `, { size: 18 }),
            text(usabilityVerdict(sV.mean), { bold: true, size: 18, color: cerColor(sV.mean) }),
            text(` (mean CER ${pct(sV.mean)}, ${pct(sV.perfect)} perfect).`, { size: 18 }),
          ],
          { spacing: 160 },
        ),
      );
    }

    children.push(para([text('Summary scorecard', { bold: true, size: 24 })], { spacing: 120, heading: HeadingLevel.HEADING_2 }));

    if (sD && sV) {
      const n = cersD.length;
      const leader = sD.mean <= sV.mean ? BACKEND_NAME.default : BACKEND_NAME.vllm;
      children.push(
        para(
          [
            text(`${leader} leads on accuracy`, { bold: true, size: 18 }),
            text(`  ·  ${n} labeled samples · ties ${tie}`, { size: 16, color: '64748B' }),
          ],
          { spacing: 80 },
        ),
      );
      children.push(
        gridTable(
          ['Backend', 'Mean CER', 'Median CER', 'Perfect (CER 0)', 'Usable (≤10%)', 'Worst CER', 'Wins'],
          [
            [[text(BACKEND_NAME.default, { bold: true })], cerCell(sD.mean), cerCell(sD.median), rateCell(sD.perfect), rateCell(sD.usable), cerCell(sD.worst), [text(`${winD} / ${n}`)]],
            [[text(BACKEND_NAME.vllm, { bold: true })], cerCell(sV.mean), cerCell(sV.median), rateCell(sV.perfect), rateCell(sV.usable), cerCell(sV.worst), [text(`${winV} / ${n}`)]],
          ],
        ),
      );
      children.push(
        para(
          [text('Perfect = exact match (CER 0). Usable = CER ≤ 10%. Median resists outliers a single garbage read would skew. Lower CER is better; CER is the right metric for Khmer.', { size: 16, color: '64748B' })],
          { spacing: 120 },
        ),
      );

      // CER distribution — the shape of the results, not just the average.
      const buckets = (xs: number[]) => ({
        perfect: xs.filter((c) => c === 0).length,
        b5: xs.filter((c) => c > 0 && c <= 0.05).length,
        b10: xs.filter((c) => c > 0.05 && c <= 0.1).length,
        b25: xs.filter((c) => c > 0.1 && c <= 0.25).length,
        hi: xs.filter((c) => c > 0.25).length,
      });
      const bD = buckets(cersD);
      const bV = buckets(cersV);
      const hiCell = (k: number) => [text(String(k), k ? { color: 'B91C1C', bold: true } : {})];
      const okCell = (k: number) => [text(String(k), k ? { color: '15803D' } : {})];
      children.push(para([text('CER distribution (# of samples)', { bold: true, size: 18 })], { spacing: 100 }));
      children.push(
        gridTable(
          ['Backend', 'Perfect', '≤5%', '≤10%', '≤25%', '>25% (failed)'],
          [
            [[text(BACKEND_NAME.default, { bold: true })], okCell(bD.perfect), [text(String(bD.b5))], [text(String(bD.b10))], [text(String(bD.b25))], hiCell(bD.hi)],
            [[text(BACKEND_NAME.vllm, { bold: true })], okCell(bV.perfect), [text(String(bV.b5))], [text(String(bV.b10))], [text(String(bV.b25))], hiCell(bV.hi)],
          ],
        ),
      );
      children.push(para([text(' ')], { spacing: 120 }));
    }

    if (multiItem) {
      children.push(para([text('Speed', { bold: true, size: 20 })], { spacing: 100, heading: HeadingLevel.HEADING_2 }));
      children.push(
        gridTable(
          ['Backend', 'Items', 'Avg / item', 'Total time'],
          [
            [[text(BACKEND_NAME.default, { bold: true })], [text(String(msD.length))], [text(secs(mean(msD)))], [text(secs(total(msD)))]],
            [[text(BACKEND_NAME.vllm, { bold: true })], [text(String(msV.length))], [text(secs(mean(msV)))], [text(secs(total(msV)))]],
          ],
        ),
      );
      children.push(para([text(' ')], { spacing: 160 }));
    }
  }

  // --- per item -------------------------------------------------------------
  opts.items.forEach((item, idx) => {
    const d = paneOf(item, 'default');
    const v = paneOf(item, 'vllm');
    const prefNote = item.preferred ? ` · preferred: ${item.preferred}` : '';

    children.push(
      para([text(`${idx + 1}. ${item.filename}`, { bold: true, size: 26 }), text(`   (${item.mode}${prefNote})`, { size: 16, color: '64748B' })], {
        spacing: 120,
        heading: HeadingLevel.HEADING_1,
      }),
    );

    // Source image (e.g. a dataset row) — see the input itself.
    if (item.sourceImage?.dataUrl) {
      const si = item.sourceImage;
      const dispW = Math.min(360, si.w || 360);
      const dispH = si.w > 0 ? Math.round((si.h / si.w) * dispW) : 200;
      children.push(para([text('Source image', { italics: true, size: 16, color: '64748B' })], { spacing: 40 }));
      children.push(new Paragraph({ children: [new ImageRun({ type: 'png', data: dataUrlToBytes(si.dataUrl), transformation: { width: dispW, height: dispH } })] }));
    }

    // Table mode: detected cell boxes drawn on the source page, side by side.
    if (item.cellBoxes && (item.cellBoxes.default || item.cellBoxes.vllm)) {
      const cb = item.cellBoxes;
      children.push(para([text('Detected table cells (boxes)', { italics: true, size: 16, color: '64748B' })], { spacing: 40 }));
      children.push(twoCol([imagePara(cb.default, cb.w, cb.h)], [imagePara(cb.vllm, cb.w, cb.h)]));
    }

    // Ground truth (dataset label) — shaded block so it's easy to eyeball
    // against the OCR outputs below.
    if (item.groundTruth && item.groundTruth.trim()) {
      children.push(para([text('Ground truth', { bold: true, size: 20 })], { spacing: 40 }));
      for (const line of item.groundTruth.split('\n')) {
        children.push(
          new Paragraph({
            children: [text(line || ' ', { size: 18 })],
            shading: { type: ShadingType.CLEAR, color: 'auto', fill: 'FEF3C7' },
            spacing: { before: 0, after: 0 },
          }),
        );
      }
      children.push(para([text(' ')], { spacing: 80 }));
    }

    // Per-file summary (totals) — the at-a-glance scoreboard.
    const summaryHeader = ['Backend', 'Total time', 'Pages', 'Avg / page', 'Regions'];
    const withCer = !!item.groundTruth;
    if (withCer) summaryHeader.splice(4, 0, 'CER');
    const summaryRow = (pane?: CompareDocxPane) => {
      const name = pane ? BACKEND_NAME[pane.backend] : '';
      if (!pane || pane.error || !pane.data) {
        const cells = [[text(name)], [text(pane?.error ? 'error' : '—')], [text('—')], [text('—')], [text('—')]];
        if (withCer) cells.splice(4, 0, [text('—')]);
        return cells;
      }
      const np = pageCountOf(pane.data);
      const cells = [
        [text(name, { bold: true })],
        [text(secs(pane.ms))],
        [text(String(np))],
        [text(np > 0 ? secs(pane.ms / np) : '—')],
        [text(String(regionCount(pane.data)))],
      ];
      if (withCer) {
        const c = cer(item.groundTruth!, paneText(item.mode, pane.data));
        cells.splice(4, 0, [text(pct(c), { color: cerColor(c), bold: true })]);
      }
      return cells;
    };
    children.push(para([text('Summary', { bold: true, size: 22 })], { spacing: 80, heading: HeadingLevel.HEADING_2 }));
    children.push(gridTable(summaryHeader, [summaryRow(d), summaryRow(v)]));

    // --- PAGE BY PAGE: page 1 (both engines) → page 2 → … -------------------
    const dDoc = d?.data as DocumentResult | undefined;
    const vDoc = v?.data as DocumentResult | undefined;
    const dMs = d?.pageMs ?? [];
    const vMs = v?.pageMs ?? [];
    const isDoc = item.mode === 'document';
    const nPages = isDoc
      ? Math.max(dDoc?.pages?.length ?? 0, vDoc?.pages?.length ?? 0, dMs.length, vMs.length, 1)
      : 1;
    const imgByPage = new Map<number, CompareDocxPageImage>();
    (item.pageImages ?? []).forEach((pi) => imgByPage.set(pi.page, pi));

    for (let i = 0; i < nPages; i++) {
      const label = isDoc ? dMs[i]?.page ?? vMs[i]?.page ?? i + 1 : null;
      children.push(para([text(isDoc ? `Page ${label}` : 'Result', { bold: true, size: 24 })], { spacing: 80, heading: HeadingLevel.HEADING_2 }));

      // Per-page timing line.
      if (isDoc) {
        const dm = dMs[i]?.ms;
        const vm = vMs[i]?.ms;
        const dreg = dDoc?.pages?.[i]?.regions?.length;
        const vreg = vDoc?.pages?.[i]?.regions?.length;
        const faster = dm != null && vm != null ? (dm <= vm ? BACKEND_NAME.default : BACKEND_NAME.vllm) : '—';
        children.push(
          para(
            [
              text(`${BACKEND_NAME.default} `, { bold: true, size: 18 }),
              text(`${dm != null ? secs(dm) : '—'} · ${dreg ?? '—'} regions`, { size: 18 }),
              text(`      ${BACKEND_NAME.vllm} `, { bold: true, size: 18 }),
              text(`${vm != null ? secs(vm) : '—'} · ${vreg ?? '—'} regions`, { size: 18 }),
              text(`      · faster: ${faster}`, { size: 16, color: '64748B' }),
            ],
            { spacing: 80 },
          ),
        );
      }

      // Boxes side by side (document mode, when images were generated).
      const pim = label != null ? imgByPage.get(label) : undefined;
      if (isDoc && pim && (pim.default || pim.vllm)) {
        children.push(para([text('Detected regions', { italics: true, size: 16, color: '64748B' })], { spacing: 40 }));
        children.push(twoCol([imagePara(pim.default, pim.w, pim.h)], [imagePara(pim.vllm, pim.w, pim.h)]));
      }

      // Markdown side by side — the readable text comparison for this page.
      // Pipe tables are rendered as real Word tables, not raw "| … |" text.
      const dMd = columnMarkdown(item, d, i);
      const vMd = columnMarkdown(item, v, i);

      // For labeled items (dataset rows), show the per-character DIFF vs the
      // ground truth instead — you see exactly what each engine got wrong.
      const showDiff = !isDoc && !!item.groundTruth && item.groundTruth.trim().length > 0;
      if (showDiff) {
        children.push(
          para(
            [
              text('Differences vs ground truth', { italics: true, size: 16, color: '64748B' }),
              text('   red = wrong/extra · blue strikethrough = missing', { italics: true, size: 14, color: '94A3B8' }),
            ],
            { spacing: 40 },
          ),
        );
        children.push(
          twoCol(
            diffParas(diffChars(item.groundTruth!, paneText(item.mode, d?.data))),
            diffParas(diffChars(item.groundTruth!, paneText(item.mode, v?.data))),
          ),
        );
      } else {
        children.push(para([text('Extracted text', { italics: true, size: 16, color: '64748B' })], { spacing: 40 }));
        children.push(twoCol(markdownToBlocks(dMd), markdownToBlocks(vMd)));
      }

      // Raw markdown source for each engine, verbatim — copy/paste friendly.
      children.push(para([text('Markdown (source)', { italics: true, size: 16, color: '64748B' })], { spacing: 40 }));
      children.push(twoCol(rawMarkdownBlocks(dMd), rawMarkdownBlocks(vMd)));

      // Breathing room before the next page.
      children.push(para([text(' ')], { spacing: 120 }));
    }

    // Raw JSON (API output) at the bottom — base64 image blobs stripped, capped.
    children.push(
      para(
        [
          text('Raw JSON (API output)', { italics: true, size: 16, color: '64748B' }),
          text('   base64 image data omitted · full data in the .json file', { italics: true, size: 14, color: '94A3B8' }),
        ],
        { spacing: 40 },
      ),
    );
    children.push(twoCol(rawMarkdownBlocks(jsonForPane(d)), rawMarkdownBlocks(jsonForPane(v))));
    children.push(para([text(' ')], { spacing: 120 }));

    if (idx < opts.items.length - 1) {
      if (item.mode === 'document') {
        // Document items are long (multi-page, box images) — give each its page.
        children.push(new Paragraph({ children: [new PageBreak()] }));
      } else {
        // Short items (OCR / table / dataset rows) flow continuously with a thin
        // divider instead of each wasting a whole page (the empty-space issue).
        children.push(
          new Paragraph({
            children: [text(' ', { size: 8 })],
            border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'CBD5E1', space: 8 } },
            spacing: { before: 160, after: 200 },
          }),
        );
      }
    }
  });

  const doc = new Document({ sections: [{ properties: {}, children }] });
  const blob = await Packer.toBlob(doc);
  return new Uint8Array(await blob.arrayBuffer());
}
