import type { BoundingBox } from '@/types/api';
import { toast } from '@/hooks/useToastStore';
import { playTing } from '@/lib/sound';

/** Format a confidence score (0..1) as a percentage with 1 decimal. */
export function fmtPct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

/** Format a bytes count as a human-readable string. */
export function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

/** Trigger a browser download of arbitrary text content. */
export function downloadText(filename: string, text: string, mime = 'text/plain;charset=utf-8'): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** Trigger a download of a JSON value (pretty-printed). */
export function downloadJson(filename: string, data: unknown): void {
  downloadText(filename, JSON.stringify(data, null, 2), 'application/json;charset=utf-8');
}

/**
 * Copy text to clipboard with fallback. Fires a toast notification and a
 * short "ting" sound on success (sound is muteable via the header toggle),
 * so every copy across the app gives feedback without each call site
 * having to wire it up.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    toast.success('Copied to clipboard');
    playTing();
    return true;
  } catch {
    toast.error('Copy failed');
    return false;
  }
}

/** Trigger a browser download of raw bytes (Uint8Array / ArrayBuffer). */
export function downloadBytes(filename: string, data: Uint8Array, mime: string): void {
  // Copy into a fresh ArrayBuffer so the Blob constructor accepts it
  // regardless of whether the source buffer is shared.
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  const blob = new Blob([copy.buffer], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** Common file extension for a given MIME type. Used when picking output formats. */
export function extensionForMime(mime: string, fallback = 'bin'): string {
  if (mime.startsWith('text/markdown')) return 'md';
  if (mime.startsWith('text/csv')) return 'csv';
  if (mime.startsWith('text/')) return 'txt';
  if (mime.includes('json')) return 'json';
  if (mime.includes('pdf')) return 'pdf';
  if (mime.includes('zip')) return 'zip';
  if (mime.includes('png')) return 'png';
  if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg';
  return fallback;
}

/**
 * Compute the axis-aligned bounding rectangle of an oriented 4-point bbox.
 * Returns {x, y, w, h} in document pixel coordinates.
 */
export function orientedBboxToRect(bbox: BoundingBox): { x: number; y: number; w: number; h: number } {
  const xs = bbox.points.map((p) => p[0]);
  const ys = bbox.points.map((p) => p[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  const w = Math.max(...xs) - x;
  const h = Math.max(...ys) - y;
  return { x, y, w, h };
}

/**
 * Map a document-space bbox to image-space percentages (0..100) so it can be
 * drawn as absolute-positioned overlays on a <img> element of any rendered size.
 */
export function bboxToPct(
  bbox: BoundingBox,
  pageW: number,
  pageH: number,
): { left: number; top: number; width: number; height: number } {
  const r = orientedBboxToRect(bbox);
  return {
    left: (r.x / pageW) * 100,
    top: (r.y / pageH) * 100,
    width: (r.w / pageW) * 100,
    height: (r.h / pageH) * 100,
  };
}

/** Whether a filename looks like a PDF. */
export function isPdf(name: string): boolean {
  return /\.pdf$/i.test(name);
}

/** Whether a filename looks like a supported image. */
export function isImage(name: string): boolean {
  return /\.(png|jpe?g|bmp|tiff?|webp)$/i.test(name);
}

/** All extensions accepted by the parser API. */
export const ACCEPTED_EXTENSIONS = '.pdf,.png,.jpg,.jpeg,.bmp,.tif,.tiff,.webp';

/** Pick a stable accent color per region type for overlays. */
const REGION_COLORS: Record<string, string> = {
  // The API emits the DocLayNet label set: text, title, section-header,
  // list-item, table, picture, caption, footnote, page-header, page-footer,
  // formula. Older aliases (paragraph/heading/figure/image) kept for back-compat.
  text: '#7c3aed',
  paragraph: '#7c3aed',
  title: '#ef4444',
  'section-header': '#f59e0b',
  heading: '#f59e0b',
  'list-item': '#3b82f6',
  caption: '#10b981',
  footnote: '#14b8a6',
  table: '#06b6d4',
  picture: '#ec4899',
  figure: '#ec4899',
  image: '#84cc16',
  formula: '#a855f7',
  'page-header': '#64748b',
  'page-footer': '#64748b',
};
export function colorForRegion(type: string): string {
  return REGION_COLORS[type.toLowerCase()] ?? '#94a3b8';
}
