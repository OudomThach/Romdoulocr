// Dataset artifact generators — the single source of truth for markdown / CSV
// output. Used by BOTH the auto-save path (every OCR lands in Data management
// with artifacts) and the Review & Save gate, so they can never drift apart.

import { parsePipeTable } from '@/lib/tableExport';

/** Corrected/plain text -> markdown (text is already the document's content). */
export function buildMarkdown(text: string): string {
  return text;
}

/** Text -> CSV: pipe tables become proper rows; else one column per line.
 * UTF-8 BOM + CRLF so Excel renders Khmer correctly. */
export function buildCsv(text: string): string {
  const esc = (s: string) => `"${String(s ?? '').replace(/"/g, '""')}"`;
  const rows: string[][] = [];
  const parsed = parsePipeTable(text);
  if (parsed && parsed.rows.length > 0) {
    rows.push(parsed.headers, ...parsed.rows);
  } else {
    rows.push(...text.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => [l]));
  }
  return '\uFEFF' + rows.map((r) => r.map(esc).join(',')).join('\r\n');
}

/** Deep-strip bulky base64 payloads (crop_base64 / thumbnail_base64) so the
 * stored `json` artifact stays faithful but light. */
export function stripBulkyBase64(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripBulkyBase64);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === 'crop_base64' || k === 'thumbnail_base64') continue;
      out[k] = stripBulkyBase64(v);
    }
    return out;
  }
  return value;
}
