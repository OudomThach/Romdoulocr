import type { PageResult, LayoutRegion } from '@/types/api';
import { downloadText, downloadBytes } from '@/lib/utils';

export interface ParsedTable {
  headers: string[];
  rows: string[][];
}

/**
 * Parse OCR table text into structured rows/cells.
 * Tries pipe-delimited first, then tab-separated, then whitespace-aligned,
 * then falls back to line-based (one cell per row).
 */
export function parsePipeTable(text: string): ParsedTable | null {
  const raw = parsePipeTableRaw(text);
  return raw ? normalizeTable(raw) : null;
}

/**
 * Pad headers and every row out to the widest column count so the grid stays
 * rectangular. OCR rows often have a missing/extra pipe; without this, CSV/XLSX
 * cells shift left on short rows. We only pad (never drop data).
 */
function normalizeTable(t: ParsedTable): ParsedTable {
  const maxCols = Math.max(t.headers.length, 1, ...t.rows.map((r) => r.length));
  const pad = (r: string[]) =>
    r.length >= maxCols ? r : [...r, ...Array<string>(maxCols - r.length).fill('')];
  return { headers: pad(t.headers), rows: t.rows.map(pad) };
}

function parsePipeTableRaw(text: string): ParsedTable | null {
  const lines = text.replace(/\r\n/g, '\n').split('\n').map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim());

  if (lines.length < 2) return null;

  // Strategy 1: Pipe-delimited (most common from OCR)
  const allPiped = lines.every((l) => l.includes('|'));
  if (allPiped) {
    const rows = lines.map(splitPipeRow).filter((r) => r.some((c) => c.length > 0));
    if (rows.length >= 2) {
      if (rows.length > 1 && rows[1].every((c) => /^[-:=\s]*$/.test(c))) {
        return { headers: rows[0], rows: rows.slice(2) };
      }
      return { headers: rows[0], rows: rows.slice(1) };
    }
  }

  // Strategy 2: Tab-separated
  const allTabbed = lines.every((l) => l.includes('\t'));
  if (allTabbed) {
    const rows = lines.map((l) => l.split('\t').map((c) => c.trim())).filter((r) => r.some((c) => c.length > 0));
    if (rows.length >= 2 && rows[0].length > 1) {
      return { headers: rows[0], rows: rows.slice(1) };
    }
  }

  // Strategy 3: Whitespace-aligned (multiple spaces as column separators)
  const wsResult = parseWhitespaceAligned(lines);
  if (wsResult) return wsResult;

  // Strategy 4: Fallback — each line is a single-cell row
  if (lines.length >= 2) {
    return { headers: ['Content'], rows: lines.slice(1).map((l) => [l.trim()]) };
  }

  return null;
}

function parseWhitespaceAligned(lines: string[]): ParsedTable | null {
  const multiSpaceLines = lines.filter((l) => { const m = l.match(/\s{2,}/g); return m && m.length > 0; });
  if (multiSpaceLines.length < lines.length * 0.5) return null;

  const colBreaks = detectColumnBreaks(lines);
  if (colBreaks.length < 1) return null;

  const rows = lines.map((l) => splitByBreaks(l, colBreaks));
  const nonEmpty = rows.filter((r) => r.some((c) => c.length > 0));
  if (nonEmpty.length < 2) return null;

  return { headers: rows[0], rows: rows.slice(1) };
}

function detectColumnBreaks(lines: string[]): number[] {
  const breakPoints = new Map<number, number>();
  for (const line of lines) {
    let i = 0;
    while (i < line.length) {
      if (line[i] === ' ' && (i === 0 || line[i - 1] !== ' ')) {
        let end = i;
        while (end < line.length && line[end] === ' ') end++;
        if (end - i >= 2) {
          const mid = Math.floor((i + end) / 2);
          breakPoints.set(mid, (breakPoints.get(mid) ?? 0) + 1);
        }
        i = end;
      } else {
        i++;
      }
    }
  }
  const threshold = Math.max(2, Math.floor(lines.length * 0.3));
  return [...breakPoints.entries()]
    .filter(([, count]) => count >= threshold)
    .sort((a, b) => a[0] - b[0])
    .map(([pos]) => pos);
}

function splitByBreaks(line: string, breaks: number[]): string[] {
  const cells: string[] = [];
  let prev = 0;
  for (const br of breaks) {
    cells.push(line.slice(prev, br).trim());
    prev = br;
  }
  cells.push(line.slice(prev).trim());
  return cells;
}

function splitPipeRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

function csvEscape(v: string): string {
  if (/[",\r\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

export function tableToCsvString(t: ParsedTable): string {
  const lines = [t.headers.map(csvEscape).join(',')];
  for (const row of t.rows) lines.push(row.map(csvEscape).join(','));
  return lines.join('\r\n') + '\r\n';
}

export function tableToHtmlString(t: ParsedTable, caption?: string): string {
  const cap = caption ? `<caption>${escHtml(caption)}</caption>` : '';
  const thead = `<thead><tr>${t.headers.map((h) => `<th>${escHtml(h)}</th>`).join('')}</tr></thead>`;
  const tbody = `<tbody>${t.rows
    .map((r) => `<tr>${r.map((c) => `<td>${escHtml(c)}</td>`).join('')}</tr>`)
    .join('')}</tbody>`;
  return `<table border="1" cellspacing="0" cellpadding="4">${cap}${thead}${tbody}</table>`;
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
      return `<ul>${text.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => `<li>${escHtml(l)}</li>`).join('')}</ul>`;
    case 'caption':
    case 'footnote':
      return `<p><em>${escHtml(text)}</em></p>`;
    case 'table': {
      const parsed = parsePipeTable(text);
      if (parsed) return tableToHtmlString(parsed, `Table region`);
      return `<pre>${escHtml(text)}</pre>`;
    }
    default:
      return `<p>${escHtml(text).replace(/\n/g, '<br>')}</p>`;
  }
}

export function pageToHtmlDocument(page: PageResult, title?: string): string {
  const titleStr = title ?? `Page ${page.page_number}`;
  const body = page.regions.map(regionToHtml).join('\n');
  return `<!DOCTYPE html>
<html lang="km">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escHtml(titleStr)}</title>
<style>
  body { font-family: 'Segoe UI', 'Noto Sans Khmer', sans-serif; max-width: 900px; margin: 40px auto; padding: 20px; color: #1a1a1a; line-height: 1.6; }
  h1 { font-size: 1.6em; border-bottom: 2px solid #ddd; padding-bottom: 6px; }
  h2 { font-size: 1.25em; margin-top: 1.5em; color: #333; }
  table { border-collapse: collapse; width: 100%; margin: 1em 0; font-size: 0.9em; }
  th { background: #f4f4f4; text-align: left; font-weight: 600; }
  th, td { border: 1px solid #ccc; padding: 6px 10px; }
  tr:nth-child(even) { background: #fafafa; }
  pre { background: #f6f6f6; padding: 12px; border-radius: 6px; overflow-x: auto; font-family: monospace; }
  caption { caption-side: top; font-size: 0.85em; color: #666; margin-bottom: 6px; }
  em { color: #555; }
</style>
</head>
<body>
${body}
</body>
</html>`;
}

export function pageToXlsxHtml(page: PageResult): string {
  const tables = page.regions.filter((r) => r.region_type === 'table' && parsePipeTable((r.text ?? '').trim()));
  if (tables.length === 0) {
    const body = page.regions.map((r) => {
      const text = (r.text ?? '').trim();
      if (!text) return '';
      if (r.region_type === 'title' || r.region_type === 'heading')
        return `<tr><td><b>${escHtml(text)}</b></td></tr>`;
      return `<tr><td>${escHtml(text).replace(/\n/g, '<br>')}</td></tr>`;
    }).join('\n');
    return `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta charset="UTF-8"></head><body><table border="1">${body}</table></body></html>`;
  }
  const sheets = tables.map((r, i) => {
    const parsed = parsePipeTable((r.text ?? '').trim())!;
    return tableToHtmlString(parsed, `Table ${i + 1}`);
  }).join('\n<br>\n');
  return `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta charset="UTF-8"></head><body>${sheets}</body></html>`;
}

export function pageToCsvBundle(page: PageResult): { name: string; text: string }[] {
  const out: { name: string; text: string }[] = [];
  let tableIdx = 0;
  for (const region of page.regions) {
    if (region.region_type !== 'table') continue;
    const parsed = parsePipeTable((region.text ?? '').trim());
    if (!parsed) continue;
    tableIdx++;
    out.push({ name: `table-${tableIdx}.csv`, text: tableToCsvString(parsed) });
  }
  return out;
}

export function downloadPageHtml(page: PageResult, filenameBase: string): void {
  const html = pageToHtmlDocument(page, filenameBase);
  downloadText(`${filenameBase}.html`, html, 'text/html;charset=utf-8');
}

// Excel ignores the charset hint when opening a double-clicked file and guesses
// the local codepage, which mojibakes Khmer. A leading UTF-8 BOM forces UTF-8
// decoding. Harmless for English/ASCII.
const UTF8_BOM = '﻿';

export function downloadPageXlsx(page: PageResult, filenameBase: string): void {
  const xls = pageToXlsxHtml(page);
  const bytes = new TextEncoder().encode(UTF8_BOM + xls);
  downloadBytes(`${filenameBase}.xls`, bytes, 'application/vnd.ms-excel');
}


export function downloadPageCsvs(page: PageResult, filenameBase: string): void {
  const csvs = pageToCsvBundle(page);
  if (csvs.length === 0) return;
  if (csvs.length === 1) {
    downloadText(`${filenameBase}-${csvs[0].name}`, UTF8_BOM + csvs[0].text, 'text/csv;charset=utf-8');
    return;
  }
  for (const c of csvs) {
    downloadText(`${filenameBase}-${c.name}`, UTF8_BOM + c.text, 'text/csv;charset=utf-8');
  }
}

export function countTablesInPage(page: PageResult): number {
  return page.regions.filter((r) => r.region_type === 'table' && parsePipeTable((r.text ?? '').trim())).length;
}
