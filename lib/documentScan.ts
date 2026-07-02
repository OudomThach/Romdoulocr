// CamScanner-style document scanning, 100% in-browser, zero deps.
//
// Pipeline (the "really fast" part lives in how little work each step does):
//   1. detectDocumentCorners — find the 4 corners of the page. We do this on a
//      tiny ~480px copy of the photo (detection doesn't need megapixels), so it
//      is a few milliseconds regardless of how big the original is.
//   2. warpPerspective — flatten the detected quad into a clean rectangle by
//      inverse-mapping each output pixel through a square→quad homography and
//      bilinear-sampling the full-res source. Correct (true perspective) and
//      simple — no WebGL context to manage.
//   3. cleanScan — kill the shadows / uneven phone-camera lighting by dividing
//      out a blurred illumination estimate, then either keep a soft grayscale
//      or hard-binarize for the classic black-on-white "scanned" look.
//
// All canvas 2D, matching the rest of the preprocessing pipeline.

export interface Point {
  x: number;
  y: number;
}

/** Page corners in SOURCE-image pixel coordinates, clockwise from top-left. */
export interface Corners {
  tl: Point;
  tr: Point;
  br: Point;
  bl: Point;
}

export type ScanStyle = 'grayscale' | 'bw' | 'color';

export interface ScanOptions {
  /** Output look. Default 'grayscale' (best balance for OCR). */
  style?: ScanStyle;
  /** Cap on the flattened output's long edge, in px. Default 2200. */
  maxOutputEdge?: number;
}

/** Longest edge used for the cheap detection pass. */
const DETECT_EDGE = 480;

// ---------------------------------------------------------------------------
// Image loading
// ---------------------------------------------------------------------------

/** Decode a File/Blob to an ImageBitmap (fast path) or HTMLImageElement. */
export async function loadImage(file: Blob): Promise<ImageBitmap | HTMLImageElement> {
  if ('createImageBitmap' in window) {
    return createImageBitmap(file);
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = (e) => {
      URL.revokeObjectURL(url);
      reject(e);
    };
    img.src = url;
  });
}

function dims(img: ImageBitmap | HTMLImageElement): { w: number; h: number } {
  const w = (img as ImageBitmap).width ?? (img as HTMLImageElement).naturalWidth;
  const h = (img as ImageBitmap).height ?? (img as HTMLImageElement).naturalHeight;
  return { w, h };
}

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

// ---------------------------------------------------------------------------
// Corner detection
// ---------------------------------------------------------------------------

/**
 * Detect the page's 4 corners. Returns corners in source-pixel coordinates,
 * plus the source dimensions so callers can map to display space. Returns a
 * sensible inset rectangle (never null) when it can't find a confident quad —
 * the user can always drag the handles to fix it.
 */
export async function detectDocumentCorners(
  file: Blob,
): Promise<{ corners: Corners; width: number; height: number; detected: boolean }> {
  const img = await loadImage(file);
  const { w: srcW, h: srcH } = dims(img);

  const scale = Math.min(1, DETECT_EDGE / Math.max(srcW, srcH));
  const dw = Math.max(1, Math.round(srcW * scale));
  const dh = Math.max(1, Math.round(srcH * scale));

  const canvas = makeCanvas(dw, dh);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return { corners: insetCorners(srcW, srcH), width: srcW, height: srcH, detected: false };
  ctx.drawImage(img, 0, 0, dw, dh);
  const { data } = ctx.getImageData(0, 0, dw, dh);

  // Grayscale (Rec. 601 luma).
  const gray = new Uint8ClampedArray(dw * dh);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    gray[p] = (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) | 0;
  }

  boxBlur(gray, dw, dh, 2);
  const t = otsuThreshold(gray);

  // The page is assumed to be the brighter region. Build a foreground mask,
  // then erode once to drop isolated bright specks in the background.
  const mask = new Uint8Array(dw * dh);
  for (let i = 0; i < gray.length; i++) mask[i] = gray[i] > t ? 1 : 0;
  erode(mask, dw, dh);

  // Extreme-points trick: the 4 corners of a convex page are the foreground
  // pixels that extremize (x+y) and (x−y).
  let tl = -1, tr = -1, br = -1, bl = -1;
  let tlV = Infinity, brV = -Infinity, trV = -Infinity, blV = Infinity;
  let count = 0;
  let minX = dw, minY = dh, maxX = 0, maxY = 0;
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      if (!mask[y * dw + x]) continue;
      count++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      const sum = x + y;
      const diff = x - y;
      const idx = y * dw + x;
      if (sum < tlV) { tlV = sum; tl = idx; }
      if (sum > brV) { brV = sum; br = idx; }
      if (diff > trV) { trV = diff; tr = idx; }
      if (diff < blV) { blV = diff; bl = idx; }
    }
  }

  const inv = 1 / scale;
  const toPoint = (idx: number): Point => ({ x: (idx % dw) * inv, y: Math.floor(idx / dw) * inv });

  // Confidence gate: the detected quad should cover a real chunk of the frame.
  // If the page fills almost the whole frame (bbox ~ full image) or barely any
  // of it, the extreme-points result is unreliable — fall back to an inset.
  const frac = count / (dw * dh);
  const bboxFrac = ((maxX - minX) * (maxY - minY)) / (dw * dh);
  if (count === 0 || tl < 0 || frac < 0.1 || bboxFrac > 0.985) {
    return { corners: insetCorners(srcW, srcH), width: srcW, height: srcH, detected: false };
  }

  const corners: Corners = {
    tl: toPoint(tl),
    tr: toPoint(tr),
    br: toPoint(br),
    bl: toPoint(bl),
  };
  return { corners, width: srcW, height: srcH, detected: true };
}

/** A centered rectangle inset 6% from each edge — the manual-adjust fallback. */
export function insetCorners(w: number, h: number): Corners {
  const mx = w * 0.06;
  const my = h * 0.06;
  return {
    tl: { x: mx, y: my },
    tr: { x: w - mx, y: my },
    br: { x: w - mx, y: h - my },
    bl: { x: mx, y: h - my },
  };
}

// ---------------------------------------------------------------------------
// Perspective warp + clean
// ---------------------------------------------------------------------------

/**
 * Flatten the page: produce a new PNG File of just the quad, perspective-
 * corrected and cleaned. `corners` are in source-image pixel coordinates.
 */
export async function scanDocument(file: Blob, corners: Corners, opts: ScanOptions = {}): Promise<File> {
  const style = opts.style ?? 'grayscale';
  const maxEdge = opts.maxOutputEdge ?? 2200;

  const img = await loadImage(file);
  const { w: srcW, h: srcH } = dims(img);

  // Source pixels (decode once at full resolution).
  const sCanvas = makeCanvas(srcW, srcH);
  const sCtx = sCanvas.getContext('2d', { willReadFrequently: true });
  if (!sCtx) throw new Error('Canvas 2D context unavailable');
  sCtx.drawImage(img, 0, 0);
  const src = sCtx.getImageData(0, 0, srcW, srcH);

  // Output size from the average of opposing edge lengths.
  const wTop = dist(corners.tl, corners.tr);
  const wBot = dist(corners.bl, corners.br);
  const hLeft = dist(corners.tl, corners.bl);
  const hRight = dist(corners.tr, corners.br);
  let outW = Math.max(1, Math.round((wTop + wBot) / 2));
  let outH = Math.max(1, Math.round((hLeft + hRight) / 2));
  const longEdge = Math.max(outW, outH);
  if (longEdge > maxEdge) {
    const s = maxEdge / longEdge;
    outW = Math.max(1, Math.round(outW * s));
    outH = Math.max(1, Math.round(outH * s));
  }

  // Homography mapping the unit square (normalized output) → source quad.
  const H = squareToQuad(corners);
  const out = new ImageData(outW, outH);
  const od = out.data;
  const sd = src.data;

  for (let y = 0; y < outH; y++) {
    const v = (y + 0.5) / outH;
    for (let x = 0; x < outW; x++) {
      const u = (x + 0.5) / outW;
      const denom = H.g * u + H.h * v + 1;
      const sx = (H.a * u + H.b * v + H.c) / denom;
      const sy = (H.d * u + H.e * v + H.f) / denom;
      const o = (y * outW + x) * 4;
      bilinear(sd, srcW, srcH, sx, sy, od, o);
    }
  }

  cleanScan(od, outW, outH, style);

  const canvas = makeCanvas(outW, outH);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');
  ctx.putImageData(out, 0, 0);

  const blob: Blob = await new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('canvas.toBlob failed'))), 'image/png'),
  );
  const name = swapExt((file as File).name ?? 'scan.png', '.png');
  return new File([blob], `${stripExt(name)}_scan.png`, { type: 'image/png' });
}

/** Distance between two points. */
function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

interface Homography {
  a: number; b: number; c: number;
  d: number; e: number; f: number;
  g: number; h: number;
}

/**
 * Heckbert's closed-form unit-square → quadrilateral projective mapping.
 * Square corners (0,0),(1,0),(1,1),(0,1) map to tl,tr,br,bl respectively.
 * Maps normalized output (u,v) → source (X,Y).
 */
function squareToQuad(c: Corners): Homography {
  const x0 = c.tl.x, y0 = c.tl.y;
  const x1 = c.tr.x, y1 = c.tr.y;
  const x2 = c.br.x, y2 = c.br.y;
  const x3 = c.bl.x, y3 = c.bl.y;

  const sx = x0 - x1 + x2 - x3;
  const sy = y0 - y1 + y2 - y3;

  if (Math.abs(sx) < 1e-9 && Math.abs(sy) < 1e-9) {
    // Affine (parallelogram).
    return { a: x1 - x0, b: x2 - x1, c: x0, d: y1 - y0, e: y2 - y1, f: y0, g: 0, h: 0 };
  }

  const dx1 = x1 - x2, dy1 = y1 - y2;
  const dx2 = x3 - x2, dy2 = y3 - y2;
  const den = dx1 * dy2 - dx2 * dy1;
  const g = (sx * dy2 - dx2 * sy) / den;
  const h = (dx1 * sy - sx * dy1) / den;
  return {
    a: x1 - x0 + g * x1,
    b: x3 - x0 + h * x3,
    c: x0,
    d: y1 - y0 + g * y1,
    e: y3 - y0 + h * y3,
    f: y0,
    g,
    h,
  };
}

/** Bilinear-sample source RGBA at (sx,sy) into dst at offset o. */
function bilinear(
  s: Uint8ClampedArray,
  w: number,
  h: number,
  sx: number,
  sy: number,
  dst: Uint8ClampedArray,
  o: number,
): void {
  if (sx < 0 || sy < 0 || sx > w - 1 || sy > h - 1) {
    dst[o] = dst[o + 1] = dst[o + 2] = 255;
    dst[o + 3] = 255;
    return;
  }
  const x0 = Math.floor(sx);
  const y0 = Math.floor(sy);
  const x1 = Math.min(x0 + 1, w - 1);
  const y1 = Math.min(y0 + 1, h - 1);
  const fx = sx - x0;
  const fy = sy - y0;
  const i00 = (y0 * w + x0) * 4;
  const i10 = (y0 * w + x1) * 4;
  const i01 = (y1 * w + x0) * 4;
  const i11 = (y1 * w + x1) * 4;
  for (let k = 0; k < 3; k++) {
    const top = s[i00 + k] * (1 - fx) + s[i10 + k] * fx;
    const bot = s[i01 + k] * (1 - fx) + s[i11 + k] * fx;
    dst[o + k] = (top * (1 - fy) + bot * fy) | 0;
  }
  dst[o + 3] = 255;
}

/**
 * Remove uneven lighting and (optionally) binarize for the scanned look.
 * Illumination flattening: estimate the background as a heavy box-blur of the
 * luma, then divide it out so shadows / gradients vanish but ink stays dark.
 */
function cleanScan(data: Uint8ClampedArray, w: number, h: number, style: ScanStyle): void {
  if (style === 'color') return; // warp only, keep original colors

  // Luma plane.
  const lum = new Uint8ClampedArray(w * h);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    lum[p] = (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) | 0;
  }

  // Background illumination ≈ heavy blur (radius scales with the page).
  const bg = lum.slice();
  const radius = Math.max(8, Math.round(Math.max(w, h) / 24));
  boxBlur(bg, w, h, radius);

  const isBw = style === 'bw';
  for (let p = 0, i = 0; p < lum.length; p++, i += 4) {
    // Normalize by background → flat white page, dark ink preserved.
    const norm = bg[p] > 0 ? Math.min(255, (lum[p] / bg[p]) * 255) : 255;
    let v: number;
    if (isBw) {
      // Soft adaptive threshold around white; slight bias keeps thin Khmer
      // strokes from dropping out.
      v = norm < 200 ? 0 : 255;
    } else {
      // Grayscale "magic": stretch contrast a touch so text pops.
      v = clamp255((norm - 128) * 1.15 + 128);
    }
    data[i] = data[i + 1] = data[i + 2] = v;
    data[i + 3] = 255;
  }
}

// ---------------------------------------------------------------------------
// Small image-processing primitives
// ---------------------------------------------------------------------------

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

/** Separable box blur, in place. */
function boxBlur(data: Uint8ClampedArray, w: number, h: number, radius: number): void {
  if (radius < 1) return;
  const tmp = new Uint8ClampedArray(data.length);
  const win = radius * 2 + 1;
  // Horizontal.
  for (let y = 0; y < h; y++) {
    let sum = 0;
    const row = y * w;
    for (let x = -radius; x <= radius; x++) sum += data[row + clampIdx(x, w)];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = (sum / win) | 0;
      sum += data[row + clampIdx(x + radius + 1, w)] - data[row + clampIdx(x - radius, w)];
    }
  }
  // Vertical.
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let y = -radius; y <= radius; y++) sum += tmp[clampIdx(y, h) * w + x];
    for (let y = 0; y < h; y++) {
      data[y * w + x] = (sum / win) | 0;
      sum += tmp[clampIdx(y + radius + 1, h) * w + x] - tmp[clampIdx(y - radius, h) * w + x];
    }
  }
}

function clampIdx(i: number, n: number): number {
  return i < 0 ? 0 : i >= n ? n - 1 : i;
}

/** Otsu's method — the gray level that best splits the histogram in two. */
function otsuThreshold(gray: Uint8ClampedArray): number {
  const hist = new Array(256).fill(0);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  const total = gray.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, max = 0, threshold = 127;
  for (let i = 0; i < 256; i++) {
    wB += hist[i];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += i * hist[i];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > max) {
      max = between;
      threshold = i;
    }
  }
  return threshold;
}

/** 3×3 erosion of a binary mask, in place (drops isolated specks). */
function erode(mask: Uint8Array, w: number, h: number): void {
  const src = mask.slice();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!src[y * w + x]) continue;
      let on = true;
      for (let ky = -1; ky <= 1 && on; ky++) {
        for (let kx = -1; kx <= 1; kx++) {
          const nx = clampIdx(x + kx, w);
          const ny = clampIdx(y + ky, h);
          if (!src[ny * w + nx]) {
            on = false;
            break;
          }
        }
      }
      mask[y * w + x] = on ? 1 : 0;
    }
  }
}

function stripExt(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(0, i) : name;
}

function swapExt(name: string, ext: string): string {
  const i = name.lastIndexOf('.');
  return (i > 0 ? name.slice(0, i) : name) + ext;
}
