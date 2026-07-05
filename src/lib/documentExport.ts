import type { DocumentResult, LayoutRegion, TableCell } from '@/types/api';
import { downloadText, downloadBytes } from '@/lib/utils';
import { parsePipeTable, tableToCsvString } from '@/lib/tableExport';
import { resultToMarkdown } from '@/lib/exporters';
import { downloadZip, type ZipEntry } from '@/lib/zipExport';

/** All region text joined per page, with `--- Page N ---` separators. */
export function extractAllText(r: { pages: { page_number: number; regions: { text: string }[] }[] }): string {
  return r.pages
    .map((p) => `--- Page ${p.page_number} ---\n` + p.regions.map((rg) => rg.text).join('\n'))
    .join('\n\n');
}

/**
 * Preferred plain text for a document result. The API's `full_text` can arrive
 * as an EMPTY STRING (not null) — plain `full_text ?? fallback` keeps that ""
 * and hides all the region text (blank result panes / exports). Treat blank as
 * missing and fall back to the joined region text.
 */
export function docText(r: {
  full_text?: string | null;
  pages?: { page_number: number; regions: { text: string }[] }[] | null;
}): string {
  if (r.full_text?.trim()) return r.full_text;
  return r.pages ? extractAllText({ pages: r.pages }) : '';
}

export interface SheetData {
  name: string;
  headers: string[];
  rows: string[][];
}

export interface QualityReport {
  avgConfidence: number;
  regionCount: number;
  tableCount: number;
  parseableTables: number;
  unparseableTables: number;
  lowConfidenceRegions: number;
  totalPages: number;
  regionTypes: Record<string, number>;
}

export function extractQualityReport(doc: DocumentResult): QualityReport {
  let totalConf = 0;
  let regionCount = 0;
  let lowConf = 0;
  let tableCount = 0;
  let parseableTables = 0;
  const regionTypes: Record<string, number> = {};

  for (const page of doc.pages) {
    for (const region of page.regions) {
      totalConf += region.confidence;
      regionCount++;
      if (region.confidence < 0.8) lowConf++;
      const type = region.region_type ?? 'unknown';
      regionTypes[type] = (regionTypes[type] ?? 0) + 1;
      if (type === 'table') {
        tableCount++;
        const parsed = parsePipeTable((region.text ?? '').trim());
        if (parsed && parsed.rows.length > 0) parseableTables++;
      }
    }
  }

  return {
    avgConfidence: regionCount > 0 ? totalConf / regionCount : 0,
    regionCount,
    tableCount,
    parseableTables,
    unparseableTables: tableCount - parseableTables,
    lowConfidenceRegions: lowConf,
    totalPages: doc.pages.length,
    regionTypes,
  };
}

export function extractSheetsFromDocument(doc: DocumentResult): SheetData[] {
  const sheets: SheetData[] = [];
  const docRows: string[][] = [];
  const docHeaders = ['Section', 'Content', 'Page'];

  for (const page of doc.pages) {
    let tableIdx = 0;
    for (const region of page.regions) {
      const text = (region.text ?? '').trim();
      if (!text) continue;

      if (region.region_type === 'table') {
        const parsed = parsePipeTable(text);
        if (parsed && parsed.rows.length > 0) {
          tableIdx++;
          sheets.push({
            name: `P${page.page_number}-T${tableIdx}`,
            headers: parsed.headers,
            rows: parsed.rows,
          });
        } else {
          docRows.push(...splitTableFallback(text).map((r) => [region.region_type, r, String(page.page_number)]));
        }
      } else {
        const label = region.region_type === 'title' ? 'Title'
          : region.region_type === 'heading' || region.region_type === 'section-header' ? 'Heading'
          : region.region_type === 'list-item' ? 'List'
          : region.region_type === 'caption' ? 'Caption'
          : region.region_type === 'footnote' ? 'Footnote'
          : 'Paragraph';
        docRows.push([label, text, String(page.page_number)]);
      }
    }
  }

  if (docRows.length > 0) {
    sheets.unshift({ name: 'Document', headers: docHeaders, rows: docRows });
  }

  return sheets;
}

function splitTableFallback(text: string): string[] {
  return text.split('\n').map((l) => l.trim()).filter(Boolean);
}

export function extractTableCells(doc: DocumentResult): { headers: string[]; rows: string[][] }[] {
  const out: { headers: string[]; rows: string[][] }[] = [];
  for (const page of doc.pages) {
    for (const region of page.regions) {
      if (region.region_type !== 'table') continue;
      const parsed = parsePipeTable((region.text ?? '').trim());
      if (parsed && parsed.rows.length > 0) out.push(parsed);
    }
  }
  return out;
}

export function cellsFromTableCells(cells: TableCell[]): { headers: string[]; rows: string[][] } {
  if (cells.length === 0) return { headers: [], rows: [] };
  const maxRow = Math.max(...cells.map((c) => c.row));
  const maxCol = Math.max(...cells.map((c) => c.col));
  const grid: string[][] = Array.from({ length: maxRow + 1 }, () =>
    Array.from({ length: maxCol + 1 }, () => ''),
  );
  for (const cell of cells) {
    if (cell.row < grid.length && cell.col < grid[cell.row].length) {
      grid[cell.row][cell.col] = cell.text;
    }
  }
  return { headers: grid[0] ?? [], rows: grid.slice(1) };
}

export async function exportDocumentToXlsx(doc: DocumentResult): Promise<Uint8Array> {
  const XLSX = await import('xlsx');
  const sheets = extractSheetsFromDocument(doc);
  const wb = XLSX.utils.book_new();

  for (const sheet of sheets) {
    const aoa: string[][] = [sheet.headers, ...sheet.rows];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const colWidths = sheet.headers.map((_, ci) => {
      let maxLen = sheet.headers[ci]?.length ?? 0;
      for (const row of sheet.rows) {
        const cellLen = row[ci]?.length ?? 0;
        if (cellLen > maxLen) maxLen = cellLen;
      }
      return { wch: Math.min(60, Math.max(10, maxLen + 2)) };
    });
    ws['!cols'] = colWidths;
    const safeName = sheet.name.slice(0, 31).replace(/[\\/?*[\]:]/g, '_');
    XLSX.utils.book_append_sheet(wb, ws, safeName);
  }

  const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as Uint8Array;
  return out;
}

export async function exportDocumentToDocx(doc: DocumentResult): Promise<Uint8Array> {
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
    AlignmentType,
    PageBreak,
  } = docx;

  const children: Array<InstanceType<typeof docx.Paragraph> | InstanceType<typeof docx.Table>> = [];

  for (let pi = 0; pi < doc.pages.length; pi++) {
    const page = doc.pages[pi];
    for (const region of page.regions) {
      const text = (region.text ?? '').trim();
      if (!text) continue;

      switch (region.region_type) {
        case 'title':
          children.push(
            new Paragraph({
              heading: HeadingLevel.TITLE,
              children: [new TextRun({ text, font: 'Noto Sans Khmer' })],
            }),
          );
          break;
        case 'section-header':
        case 'heading':
          children.push(
            new Paragraph({
              heading: HeadingLevel.HEADING_1,
              children: [new TextRun({ text, font: 'Noto Sans Khmer' })],
            }),
          );
          break;
        case 'list-item':
          for (const ln of text.split('\n').map((l) => l.trim()).filter(Boolean)) {
            children.push(
              new Paragraph({
                bullet: { level: 0 },
                children: [new TextRun({ text: ln, font: 'Noto Sans Khmer' })],
              }),
            );
          }
          break;
        case 'caption':
        case 'footnote':
          children.push(
            new Paragraph({
              children: [new TextRun({ text, italics: true, font: 'Noto Sans Khmer' })],
              alignment: AlignmentType.CENTER,
            }),
          );
          break;
        case 'table': {
          const parsed = parsePipeTable(text);
          if (parsed && parsed.rows.length > 0) {
            const headerRow = new TableRow({
              children: parsed.headers.map(
                (h) =>
                  new TableCell({
                    children: [new Paragraph({ children: [new TextRun({ text: h, bold: true, font: 'Noto Sans Khmer' })] })],
                    width: { size: Math.floor(100 / parsed.headers.length), type: WidthType.PERCENTAGE },
                  }),
              ),
            });
            const bodyRows = parsed.rows.map(
              (row) =>
                new TableRow({
                  children: row.map(
                    (cell) =>
                      new TableCell({
                        children: [new Paragraph({ children: [new TextRun({ text: cell, font: 'Noto Sans Khmer' })] })],
                      }),
                  ),
                }),
            );
            children.push(
              new Table({
                rows: [headerRow, ...bodyRows],
                width: { size: 100, type: WidthType.PERCENTAGE },
              }),
            );
          } else {
            children.push(
              new Paragraph({
                children: [new TextRun({ text, font: 'Noto Sans Khmer' })],
              }),
            );
          }
          break;
        }
        default:
          children.push(
            new Paragraph({
              children: [new TextRun({ text, font: 'Noto Sans Khmer' })],
              spacing: { after: 120 },
            }),
          );
      }
    }

    if (pi < doc.pages.length - 1) {
      children.push(
        new Paragraph({
          children: [new PageBreak()],
        }),
      );
    }
  }

  const docxDoc = new Document({
    sections: [
      {
        properties: {},
        children,
      },
    ],
  });

  const blob = await Packer.toBlob(docxDoc);
  const arr = new Uint8Array(await blob.arrayBuffer());
  return arr;
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function regionToHtml(region: LayoutRegion): string {
  const text = (region.text ?? '').trim();
  if (!text) return '';
  switch (region.region_type) {
    case 'title':
      return `<h1>${escHtml(text)}</h1>`;
    case 'section-header':
    case 'heading':
      return `<h2>${escHtml(text)}</h2>`;
    case 'list-item':
      return `<ul>${text
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => `<li>${escHtml(l)}</li>`)
        .join('')}</ul>`;
    case 'caption':
    case 'footnote':
      return `<p class="caption">${escHtml(text)}</p>`;
    case 'table': {
      const parsed = parsePipeTable(text);
      if (parsed) {
        const thead = `<thead><tr>${parsed.headers.map((h) => `<th>${escHtml(h)}</th>`).join('')}</tr></thead>`;
        const tbody = `<tbody>${parsed.rows
          .map((r) => `<tr>${r.map((c) => `<td>${escHtml(c)}</td>`).join('')}</tr>`)
          .join('')}</tbody>`;
        return `<table>${thead}${tbody}</table>`;
      }
      return `<pre>${escHtml(text)}</pre>`;
    }
    default:
      return `<p>${escHtml(text).replace(/\n/g, '<br>')}</p>`;
  }
}

export function exportDocumentToHtml(doc: DocumentResult): string {
  const body = doc.pages
    .map((page) => {
      const content = page.regions.map(regionToHtml).join('\n');
      return `<section class="page"><div class="page-label">Page ${page.page_number}</div>${content}</section>`;
    })
    .join('\n');

  return `<!DOCTYPE html>
<html lang="km">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escHtml(doc.filename)}</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Noto+Sans+Khmer:wght@400;600&display=swap');
  body { font-family: 'Segoe UI', 'Noto Sans Khmer', sans-serif; max-width: 900px; margin: 40px auto; padding: 20px; color: #1a1a1a; line-height: 1.7; }
  h1 { font-size: 1.6em; border-bottom: 2px solid #ddd; padding-bottom: 6px; }
  h2 { font-size: 1.25em; margin-top: 1.5em; color: #333; }
  table { border-collapse: collapse; width: 100%; margin: 1em 0; font-size: 0.9em; }
  th { background: #e8e8e8; text-align: left; font-weight: 600; }
  th, td { border: 1px solid #999; padding: 8px 12px; }
  tr:nth-child(even) { background: #f8f8f8; }
  pre { background: #f6f6f6; padding: 12px; border-radius: 6px; overflow-x: auto; font-family: monospace; }
  .caption { text-align: center; font-style: italic; color: #555; }
  .page { margin-bottom: 2em; }
  .page-label { font-size: 0.75em; color: #aaa; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 0.5em; }
</style>
</head>
<body>
${body}
</body>
</html>`;
}

export function exportDocumentToCsvs(doc: DocumentResult): { name: string; text: string }[] {
  const out: { name: string; text: string }[] = [];
  for (const page of doc.pages) {
    let tableIdx = 0;
    for (const region of page.regions) {
      if (region.region_type !== 'table') continue;
      const parsed = parsePipeTable((region.text ?? '').trim());
      if (!parsed || parsed.rows.length === 0) continue;
      tableIdx++;
      out.push({
        name: `page${page.page_number}-table${tableIdx}.csv`,
        text: tableToCsvString(parsed),
      });
    }
  }
  return out;
}

export async function downloadDocumentXlsx(doc: DocumentResult, filenameBase: string): Promise<void> {
  const bytes = await exportDocumentToXlsx(doc);
  downloadBytes(`${filenameBase}.xlsx`, bytes, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
}

export async function downloadDocumentDocx(doc: DocumentResult, filenameBase: string): Promise<void> {
  const bytes = await exportDocumentToDocx(doc);
  downloadBytes(`${filenameBase}.docx`, bytes, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
}

export function downloadDocumentHtml(doc: DocumentResult, filenameBase: string): void {
  const html = exportDocumentToHtml(doc);
  downloadText(`${filenameBase}.html`, html, 'text/html;charset=utf-8');
}

// Excel ignores the charset hint on a double-clicked .csv and guesses the
// local codepage, which mojibakes Khmer. A UTF-8 BOM forces it to decode UTF-8.
const CSV_BOM = '﻿';

export function downloadDocumentCsvs(doc: DocumentResult, filenameBase: string): void {
  const csvs = exportDocumentToCsvs(doc);
  if (csvs.length === 0) return;
  for (const c of csvs) {
    downloadText(`${filenameBase}-${c.name}`, CSV_BOM + c.text, 'text/csv;charset=utf-8');
  }
}

/** Download a single parsed table as a BOM-prefixed CSV. */
export function downloadSingleTableCsv(
  table: { headers: string[]; rows: string[][] },
  filenameBase: string,
): void {
  downloadText(`${filenameBase}.csv`, CSV_BOM + tableToCsvString(table), 'text/csv;charset=utf-8');
}

/** Build a one-sheet XLSX for a single parsed table. */
export async function exportSingleTableToXlsx(
  table: { headers: string[]; rows: string[][] },
  sheetName = 'Table',
): Promise<Uint8Array> {
  const XLSX = await import('xlsx');
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([table.headers, ...table.rows]);
  ws['!cols'] = table.headers.map((_, ci) => {
    let maxLen = table.headers[ci]?.length ?? 0;
    for (const row of table.rows) maxLen = Math.max(maxLen, row[ci]?.length ?? 0);
    return { wch: Math.min(60, Math.max(10, maxLen + 2)) };
  });
  XLSX.utils.book_append_sheet(wb, ws, sheetName.slice(0, 31).replace(/[\\/?*[\]:]/g, '_'));
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as Uint8Array;
}

export async function downloadSingleTableXlsx(
  table: { headers: string[]; rows: string[][] },
  filenameBase: string,
): Promise<void> {
  const bytes = await exportSingleTableToXlsx(table);
  downloadBytes(
    `${filenameBase}.xlsx`,
    bytes,
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );
}

/** Tab-separated form of a table — pastes straight into Excel/Sheets with columns intact. */
export function tableToTsv(table: { headers: string[]; rows: string[][] }): string {
  const esc = (v: string) => v.replace(/\t/g, ' ').replace(/\r?\n/g, ' ');
  return [table.headers, ...table.rows].map((r) => r.map(esc).join('\t')).join('\n');
}

/** True if the document has any non-table region carrying text. */
export function documentHasText(doc: DocumentResult): boolean {
  return doc.pages.some((p) =>
    p.regions.some((r) => r.region_type !== 'table' && (r.text ?? '').trim().length > 0),
  );
}

/** A DocumentResult narrowed to a single page (for per-page exports). */
export function singlePageDocument(doc: DocumentResult, pageNumber: number): DocumentResult {
  const page = doc.pages.find((p) => p.page_number === pageNumber);
  const pages = page ? [page] : [];
  const onPage = <T extends { page_number: number }>(arr?: T[]) =>
    arr?.filter((c) => c.page_number === pageNumber);
  return {
    ...doc,
    num_pages: pages.length,
    pages,
    full_text: undefined,
    translated_text: undefined,
    table_crops: onPage(doc.table_crops),
    figure_crops: onPage(doc.figure_crops),
    image_crops: onPage(doc.image_crops),
  };
}

export function countDocumentTables(doc: DocumentResult): number {
  let n = 0;
  for (const page of doc.pages) {
    for (const region of page.regions) {
      if (region.region_type === 'table') {
        const parsed = parsePipeTable((region.text ?? '').trim());
        if (parsed && parsed.rows.length > 0) n++;
      }
    }
  }
  return n;
}

export function exportDocumentToMarkdown(doc: DocumentResult): string {
  return resultToMarkdown(doc);
}

export function exportDocumentToPlainText(doc: DocumentResult): string {
  const lines: string[] = [];
  for (const page of doc.pages) {
    lines.push(`--- Page ${page.page_number} ---`);
    lines.push('');
    for (const region of page.regions) {
      const text = (region.text ?? '').trim();
      if (!text) continue;
      if (region.region_type === 'title' || region.region_type === 'heading' || region.region_type === 'section-header') {
        lines.push(text.toUpperCase());
      } else if (region.region_type === 'list-item') {
        for (const ln of text.split('\n').map((l) => l.trim()).filter(Boolean)) lines.push(`- ${ln}`);
      } else {
        lines.push(text);
      }
      lines.push('');
    }
    lines.push('');
  }
  return lines.join('\n').trim() + '\n';
}

export function downloadDocumentMarkdown(doc: DocumentResult, filenameBase: string): void {
  const md = exportDocumentToMarkdown(doc);
  downloadText(`${filenameBase}.md`, md, 'text/markdown;charset=utf-8');
}

export function downloadDocumentText(doc: DocumentResult, filenameBase: string): void {
  const txt = exportDocumentToPlainText(doc);
  downloadText(`${filenameBase}.txt`, txt, 'text/plain;charset=utf-8');
}

export function downloadDocumentJson(doc: DocumentResult, filenameBase: string): void {
  const json = JSON.stringify(doc, null, 2);
  downloadText(`${filenameBase}.json`, json, 'application/json;charset=utf-8');
}

export async function downloadAllFormatsAsZip(doc: DocumentResult, filenameBase: string): Promise<void> {
  const entries: ZipEntry[] = [];

  entries.push({ name: `${filenameBase}.json`, text: JSON.stringify(doc, null, 2) });
  entries.push({ name: `${filenameBase}.md`, text: exportDocumentToMarkdown(doc) });
  entries.push({ name: `${filenameBase}.txt`, text: exportDocumentToPlainText(doc) });
  entries.push({ name: `${filenameBase}.html`, text: exportDocumentToHtml(doc) });

  try {
    const xlsxBytes = await exportDocumentToXlsx(doc);
    entries.push({ name: `${filenameBase}.xlsx`, bytes: xlsxBytes });
  } catch { /* skip if xlsx fails */ }

  try {
    const docxBytes = await exportDocumentToDocx(doc);
    entries.push({ name: `${filenameBase}.docx`, bytes: docxBytes });
  } catch { /* skip if docx fails */ }

  for (const csv of exportDocumentToCsvs(doc)) {
    entries.push({ name: `${filenameBase}-${csv.name}`, text: csv.text });
  }

  await downloadZip(`${filenameBase}-all-formats.zip`, entries);
}
