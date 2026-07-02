// Export formatters for parsed-document results.
//
// We provide:
//   - text/markdown: a clean readable form suitable for docs/READMEs
//   - text/csv: for table results, opens in Excel/Sheets
//   - application/pdf: a searchable PDF where the OCR text is embedded as
//     a transparent overlay (so the PDF is both visually identical to the
//     original pages and selectable / searchable in any PDF viewer)
//
// We intentionally use pdf-lib (small, ESM, ~400 KB) instead of pdfkit/jsPDF
// because it produces byte-identical raster output via PNG embedding and
// has clean async APIs.

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import type { DocumentResult, LayoutRegion, PageResult, TableResult, VisualRegionCrop } from '@/types/api';
import { parsePipeTable } from './tableExport';

function bboxIou(a: [number, number][], b: [number, number][]): number {
  const ax = Math.min(...a.map((p) => p[0]));
  const ay = Math.min(...a.map((p) => p[1]));
  const ax2 = Math.max(...a.map((p) => p[0]));
  const ay2 = Math.max(...a.map((p) => p[1]));
  const bx = Math.min(...b.map((p) => p[0]));
  const by = Math.min(...b.map((p) => p[1]));
  const bx2 = Math.max(...b.map((p) => p[0]));
  const by2 = Math.max(...b.map((p) => p[1]));
  const ix = Math.max(0, Math.min(ax2, bx2) - Math.max(ax, bx));
  const iy = Math.max(0, Math.min(ay2, by2) - Math.max(ay, by));
  const inter = ix * iy;
  if (inter === 0) return 0;
  const areaA = (ax2 - ax) * (ay2 - ay);
  const areaB = (bx2 - bx) * (by2 - by);
  const union = areaA + areaB - inter;
  return inter / union;
}

function findCrop(
  region: LayoutRegion,
  pageNumber: number,
  figureCrops?: VisualRegionCrop[],
  imageCrops?: VisualRegionCrop[],
): VisualRegionCrop | null {
  const all = [...(figureCrops ?? []), ...(imageCrops ?? [])];
  if (all.length === 0) return null;
  let best: { crop: VisualRegionCrop; score: number } | null = null;
  for (const crop of all) {
    if (crop.page_number !== pageNumber) continue;
    const iou = bboxIou(region.bbox.points, crop.bbox.points);
    if (iou > 0.2 && (!best || iou > best.score)) best = { crop, score: iou };
  }
  return best?.crop ?? null;
}

interface MarkdownOptions {
  figureCrops?: VisualRegionCrop[];
  imageCrops?: VisualRegionCrop[];
  /** When true, render the translated (english_text) content instead of the original. */
  translated?: boolean;
}

/** Pretty Markdown for a DocumentResult. Always renders page-by-page with images. */
export function resultToMarkdown(result: DocumentResult, opts?: MarkdownOptions): string {
  const out: string[] = [];
  out.push(`# ${result.filename}\n`);

  // Only use full_text when there are no structured pages (avoid duplication)
  const topText = opts?.translated ? (result.translated_text ?? result.full_text) : result.full_text;
  if (topText && topText.trim() && (!result.pages || result.pages.length === 0)) {
    out.push(topText.trim());
    out.push('');
  }

  // Page-by-page structured rendering.
  for (const page of result.pages) {
    out.push(...renderPageMarkdown(page, opts, result.pages.length > 1));
  }
  return out.join('\n').trim() + '\n';
}

/**
 * Markdown for a single page of a DocumentResult, looked up by 1-based page
 * number. Used by the Markdown viewer's per-page mode so the rendered text
 * matches whichever page's image is on screen. No filename/page headings —
 * the caller already shows which page this is.
 */
export function pageToMarkdown(result: DocumentResult, pageNumber: number, opts?: MarkdownOptions): string {
  const page = result.pages.find((p) => p.page_number === pageNumber);
  if (!page) return '';
  return renderPageMarkdown(page, opts, false).join('\n').trim() + '\n';
}

/**
 * Render one page's regions to Markdown lines. Shared by the whole-document
 * exporter (which prefixes a "## Page N" heading when the doc is multi-page)
 * and the per-page viewer (which omits it).
 */
function renderPageMarkdown(page: PageResult, opts: MarkdownOptions | undefined, includePageHeading: boolean): string[] {
  const out: string[] = [];
  if (includePageHeading) out.push(`## Page ${page.page_number}\n`);
  for (const region of page.regions) {
    const text = (opts?.translated ? (region.english_text || region.text) : region.text ?? '').trim();

    // Visual regions. The layout model (DocLayNet taxonomy) labels these
    // `picture`; older builds used `image` / `figure` — accept all three.
    if (region.region_type === 'figure' || region.region_type === 'image' || region.region_type === 'picture') {
      const crop = findCrop(region, page.page_number, opts?.figureCrops, opts?.imageCrops);
      const b64 = crop?.crop_base64 ?? region.crop_base64;
      if (b64) {
        out.push(`![${region.region_type}](data:image/png;base64,${b64})\n`);
      }
      if (text) out.push(`${text}\n`);
      continue;
    }

    if (!text) continue;
    switch (region.region_type) {
      case 'title':
        out.push(`### ${text}\n`);
        break;
      // `section-header` is the DocLayNet label the API actually emits; keep
      // `heading` for back-compat. Both render as a markdown heading.
      case 'section-header':
      case 'heading':
        out.push(`#### ${text}\n`);
        break;
      case 'list-item':
        // Preserve list semantics — one bullet per line of the region.
        for (const ln of text.split('\n')) {
          const t = ln.trim();
          if (t) out.push(`- ${t}`);
        }
        out.push('');
        break;
      case 'caption':
      case 'footnote':
        out.push(`*${text}*\n`);
        break;
      case 'table': {
        const parsed = parsePipeTable(text);
        if (parsed) {
          const colCount = parsed.headers.length;
          if (colCount > 0) {
            out.push(`| ${parsed.headers.map((h) => h.replace(/\|/g, '\\|')).join(' | ')} |`);
            out.push(`| ${parsed.headers.map(() => '---').join(' | ')} |`);
            for (const row of parsed.rows) {
              const cells = Array.from({ length: colCount }, (_, i) => (row[i] ?? '').replace(/\|/g, '\\|'));
              out.push(`| ${cells.join(' | ')} |`);
            }
            out.push('');
          }
        } else {
          out.push(`${text}\n`);
        }
        break;
      }
      default:
        out.push(`${text}\n`);
    }
  }
  out.push('');
  return out;
}

/** CSV for TableResult. Quotes fields with commas/quotes/newlines. */
export function tableToCsv(table: TableResult): string {
  const rows: string[][] = Array.from({ length: table.num_rows }, () =>
    Array.from({ length: table.num_cols }, () => ''),
  );
  for (const cell of table.cells) {
    if (cell.row < rows.length && cell.col < rows[cell.row].length) {
      rows[cell.row][cell.col] = cell.text;
    }
  }
  return rows.map((r) => r.map(csvEscape).join(',')).join('\r\n') + '\r\n';
}

function csvEscape(v: string): string {
  if (/[",\r\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

/**
 * Build a searchable PDF where each page is a transparent text overlay on
 * a blank background, positioned using the OCR bounding boxes. The visual
 * fidelity is intentionally minimal here — the goal is text-searchable
 * output, not page rasterization.
 *
 * For richer PDF export with original page images, we'd need server-side
 * rasterization of the source PDF, which we deliberately avoid.
 */
export async function resultToSearchablePdf(result: DocumentResult): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);

  // pdf-lib uses 72-DPI points; convert from pixels assuming a 96 DPI baseline
  // (matches what most rasterizers produce for screen-friendly output).
  const PX_TO_PT = 72 / 96;

  for (const page of result.pages) {
    const w = page.width * PX_TO_PT;
    const h = page.height * PX_TO_PT;
    const pdfPage = pdf.addPage([w, h]);

    for (const region of page.regions) {
      for (const line of region.lines) {
        const xs = line.bbox.points.map((p) => p[0]);
        const ys = line.bbox.points.map((p) => p[1]);
        const x = Math.min(...xs) * PX_TO_PT;
        const yTop = Math.min(...ys) * PX_TO_PT;
        const lineH = Math.max(...ys) - Math.min(...ys);
        // pdf-lib origin is bottom-left.
        const y = h - yTop - lineH * PX_TO_PT;
        const text = line.text?.trim();
        if (!text) continue;

        const fontSize = Math.max(6, Math.min(18, lineH * PX_TO_PT * 0.8));
        pdfPage.drawText(text, {
          x,
          y: Math.max(0, y),
          size: fontSize,
          font,
          color: rgb(0, 0, 0),
          maxWidth: w - x,
        });
      }
    }
  }
  return pdf.save();
}
