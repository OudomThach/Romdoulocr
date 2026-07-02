// Read a HuggingFace-style OCR dataset parquet in the browser and turn each row
// into an image File + ground-truth label, for the Compare tab's CER/WER eval.
//
// Typical row shape (HF `Image` feature):
//   { image: { bytes: <PNG bytes>, path: null }, label: "correct text" }
//
// Column names / nesting vary between datasets, so extraction is defensive and,
// when it can't find images, throws an error that names the actual columns.

export interface ParquetSample {
  file: File;
  label: string;
}

export interface ParquetLoadResult {
  samples: ParquetSample[];
  total: number;
}

const IMAGE_KEYS = ['image', 'img', 'png', 'jpg', 'jpeg', 'picture', 'image_bytes', 'bytes'];
const LABEL_KEYS = ['label', 'text', 'ground_truth', 'transcription', 'markdown', 'ocr', 'content', 'target', 'caption'];

function isImageMagic(b: Uint8Array): boolean {
  if (b.length < 4) return false;
  return (
    (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) || // PNG
    (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) || // JPEG
    (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) || // GIF
    (b[0] === 0x42 && b[1] === 0x4d) || // BMP
    (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46) // RIFF (WEBP)
  );
}

/** char-code → byte (binary string: each char is one byte, latin1). */
function latin1(s: string): Uint8Array {
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 0xff;
  return u;
}

/**
 * Bytes from a string that holds image data — either a binary string (1 char =
 * 1 byte, how hyparquet returns BYTE_ARRAY) or base64. We disambiguate by the
 * image magic header so we never mis-decode.
 */
function strToBytes(s: string): Uint8Array | null {
  if (!s) return null;
  const bin = latin1(s);
  if (isImageMagic(bin)) return bin; // binary string is already the image
  try {
    const b64 = latin1(atob(s.replace(/\s/g, '')));
    if (isImageMagic(b64)) return b64; // it was base64
  } catch {
    /* not base64 */
  }
  return bin.length ? bin : null; // best-effort fallback: treat as binary string
}

/** Coerce any plausible binary representation into bytes. */
function toBytes(v: unknown): Uint8Array | null {
  if (v == null) return null;
  if (v instanceof Uint8Array) return v.length ? v : null;
  if (ArrayBuffer.isView(v)) {
    const a = v as ArrayBufferView;
    return new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  }
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (Array.isArray(v)) return v.length ? Uint8Array.from(v as number[]) : null;
  if (typeof v === 'string') return strToBytes(v);
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.data)) return Uint8Array.from(o.data as number[]); // {type:'Buffer',data:[...]}
    if ('bytes' in o) return toBytes(o.bytes); // nested {bytes}
    // Iterable (some readers return a custom byte iterable)
    if (typeof (o as { [Symbol.iterator]?: unknown })[Symbol.iterator] === 'function') {
      try {
        const u = Uint8Array.from(v as Iterable<number>);
        if (u.length) return u;
      } catch {
        /* not numeric-iterable */
      }
    }
    // Array-like or numeric-keyed object: {0:137,1:80,...,length?:n}
    const keys = Object.keys(o);
    if (keys.length && keys.every((k) => /^\d+$/.test(k))) {
      return Uint8Array.from(keys.map((k) => Number(o[k])));
    }
    if (typeof o.length === 'number') {
      try {
        return Uint8Array.from(o as unknown as ArrayLike<number>);
      } catch {
        /* not array-like-numeric */
      }
    }
  }
  return null;
}

/** Bytes from a value that may be raw bytes or a {bytes,...} struct. */
function structBytes(v: unknown): Uint8Array | null {
  const direct = toBytes(v);
  if (direct && direct.length) return direct;
  if (v && typeof v === 'object' && 'bytes' in v) {
    const b = toBytes((v as { bytes: unknown }).bytes);
    if (b && b.length) return b;
  }
  return null;
}

function findImageBytes(row: Record<string, unknown>): Uint8Array | null {
  for (const key of IMAGE_KEYS) {
    if (key in row) {
      const b = structBytes(row[key]);
      if (b) return b;
    }
  }
  // Fallback: any column whose name mentions image/bytes, or any struct/binary.
  for (const [key, val] of Object.entries(row)) {
    if (/image|bytes|png|jpe?g|picture/i.test(key)) {
      const b = structBytes(val);
      if (b) return b;
    }
  }
  return null;
}

function findLabel(row: Record<string, unknown>): string {
  for (const key of LABEL_KEYS) {
    const v = row[key];
    if (typeof v === 'string' && v.length) return v;
    if (v instanceof Uint8Array) return new TextDecoder('utf-8').decode(v); // bytes label
    if (v != null && typeof v !== 'object') return String(v);
  }
  return '';
}

function describeVal(v: unknown, depth = 0): string {
  if (v == null) return 'null';
  if (v instanceof Uint8Array) return `Uint8Array(${v.length})`;
  if (ArrayBuffer.isView(v)) return `${(v as { constructor?: { name?: string } }).constructor?.name ?? 'view'}(${(v as ArrayBufferView).byteLength})`;
  if (v instanceof ArrayBuffer) return `ArrayBuffer(${v.byteLength})`;
  if (Array.isArray(v)) return `Array(${v.length})`;
  if (typeof v === 'string') return `string(${v.length})`;
  if (typeof v === 'object') {
    if (depth > 1) return 'object';
    return `{${Object.entries(v as Record<string, unknown>)
      .map(([k, vv]) => `${k}:${describeVal(vv, depth + 1)}`)
      .join(',')}}`;
  }
  return typeof v;
}

function describeRow(row: Record<string, unknown>): string {
  return Object.entries(row)
    .map(([k, v]) => `${k}:${describeVal(v)}`)
    .join(', ');
}

export async function readParquetDataset(
  file: File,
  limit: number | 'all',
): Promise<ParquetLoadResult> {
  const { parquetReadObjects, parquetMetadataAsync } = await import('hyparquet');
  const { compressors } = await import('hyparquet-compressors');

  // Slice-backed buffer: hyparquet only reads the byte ranges it needs.
  const asyncBuffer = {
    byteLength: file.size,
    slice: (start: number, end: number) => file.slice(start, end).arrayBuffer(),
  };

  const metadata = await parquetMetadataAsync(asyncBuffer);
  const total = Number(metadata.num_rows);
  const n = limit === 'all' ? total : Math.min(limit, total);

  const rows = (await parquetReadObjects({
    file: asyncBuffer,
    metadata,
    rowStart: 0,
    rowEnd: n,
    compressors,
    // CRITICAL: HF stores image bytes as a BYTE_ARRAY with no string logical
    // type. hyparquet UTF-8-decodes byte arrays by default, which CORRUPTS the
    // binary (every byte > 127 becomes U+FFFD). utf8:false returns raw
    // Uint8Array for binary columns; genuine string columns (label) stay strings.
    utf8: false,
  })) as Record<string, unknown>[];

  const sliced = rows.slice(0, n);
  if (sliced.length === 0) throw new Error(`Read 0 rows from parquet (file may be empty or unreadable).`);

  // Log the raw first row so its exact runtime types are inspectable in DevTools.
  // eslint-disable-next-line no-console
  console.log('[parquet] first row:', sliced[0]);

  const samples: ParquetSample[] = [];
  for (let i = 0; i < sliced.length; i++) {
    const bytes = findImageBytes(sliced[i]);
    if (bytes) samples.push({ file: new File([bytes as unknown as BlobPart], `sample_${i + 1}.png`, { type: 'image/png' }), label: findLabel(sliced[i]) });
  }

  if (samples.length === 0) {
    // Surface the real schema (with nested types) so we can map the right columns.
    throw new Error(`No image bytes found. Row → ${describeRow(sliced[0])}`);
  }

  return { samples, total };
}
