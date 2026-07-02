// Bundle any number of text/binary files into a single zip and trigger
// a browser download. Used by the "Download all as .zip" button so a
// user with N results can pull them all in one go instead of clicking
// "Download .txt" on each card.

import JSZip from 'jszip';
import { downloadBytes } from '@/lib/utils';

export interface ZipEntry {
  /** Path inside the zip, e.g. "doc1.txt" or "doc1/result.txt". */
  name: string;
  /** Text content (UTF-8). */
  text?: string;
  /** Binary content. Takes precedence over `text` if both are set. */
  bytes?: Uint8Array;
}

export async function downloadZip(filename: string, entries: ZipEntry[]): Promise<void> {
  const zip = new JSZip();
  for (const e of entries) {
    if (e.bytes) {
      zip.file(e.name, e.bytes);
    } else if (typeof e.text === 'string') {
      zip.file(e.name, e.text);
    }
  }
  const blob = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
  downloadBytes(filename, blob, 'application/zip');
}
