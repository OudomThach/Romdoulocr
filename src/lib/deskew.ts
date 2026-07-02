// Geometry + binarization boosters for the OCR preprocessing pipeline.
//
// These are the steps that fix a SCAN rather than a phone photo:
//   - deskew      — a flatbed scan rotated a couple of degrees has no quad to
//                   detect (the page fills the frame), so the perspective warp
//                   in documentScan.ts can't help. We estimate the text tilt
//                   directly and rotate it flat. This is the single biggest win
//                   for line segmentation, especially for stacked Khmer glyphs.
//   - autoCrop    — trim the black/dark scanner border (and the shadow gutter
//                   around a photographed page) so it doesn't bias Otsu or the
//                   skew estimate, and so the model sees only the page.
//   - adaptiveThreshold — local (Sauvola-style) binarization. A global Otsu
//                   threshold fails on scans with uneven lighting; a per-pixel
//                   local threshold keeps thin strokes on a shaded page.
//
// Everything is canvas-2D, zero-dep, matching imageProcessing.ts / documentScan.ts.
// The public entry point is geometryCorrect(canvas, opts): it takes a canvas and
// returns a (possibly new, possibly same) canvas, so processImage() can chain it.

export interface GeometryOptions {
  /** Auto-detect a small page rotation (±maxSkewDeg) and correct it. */
  deskew?: boolean;
  /** Search range for deskew, in degrees. Default 15. */
  maxSkewDeg?: number;
  /** Trim a dark scanner border / shadow gutter around the page. */
  autoCrop?: boolean;
  /** Local (Sauvola) binarization → clean black-on-white. */
  adaptiveThreshold?: boolean;
}

export function isGeometryNoOp(o: GeometryOptions): boolean {
  return !o.deskew && !o.autoCrop && !o.adaptiveThreshold;
}

/** Longest edge used for the cheap analysis passes (detection ≠ megapixels). */
const ANALYZE_EDGE = 1000;

/**
 * Apply the enabled geometry/binarization steps to a canvas, in the order that
 * makes each one's input cleanest: crop first (so skew + threshold only see the
 * page), then deskew (so the threshold sees level text), then binarize.
 * Returns the same canvas when nothing is enabled.
 */
export function geometryCorrect(canvas: HTMLCanvasElement, opts: GeometryOptions): HTMLCanvasElement {
  if (isGeometryNoOp(opts)) return canvas;
  let cur = canvas;
  if (opts.autoCrop) cur = autoCropCanvas(cur);
  if (opts.deskew) cur = deskewCanvas(cur, opts.maxSkewDeg ?? 15);
  if (opts.adaptiveThreshold) cur = adaptiveThresholdCanvas(cur);
  return cur;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function ctxOf(c: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Canvas 2D context unavailable');
  return ctx;
}

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, w);
  c.height = Math.max(1, h);
  return c;
}

/** Rec. 601 luma plane from a canvas. */
function lumaOf(canvas: HTMLCanvasElement): { lum: Uint8ClampedArray; w: number; h: number } {
  const { width: w, height: h } = canvas;
  const data = ctxOf(canvas).getImageData(0, 0, w, h).data;
  const lum = new Uint8ClampedArray(w * h);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    lum[p] = (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) | 0;
  }
  return { lum, w, h };
}

/** A downscaled luma plane for the analysis passes — bounds the cost. */
function analyzeLuma(canvas: HTMLCanvasElement): { lum: Uint8ClampedArray; w: number; h: number; scale: number } {
  const { width: sw, height: sh } = canvas;
  const scale = Math.min(1, ANALYZE_EDGE / Math.max(sw, sh));
  if (scale >= 1) {
    const { lum, w, h } = lumaOf(canvas);
    return { lum, w, h, scale: 1 };
  }
  const dw = Math.max(1, Math.round(sw * scale));
  const dh = Math.max(1, Math.round(sh * scale));
  const tmp = makeCanvas(dw, dh);
  const tctx = ctxOf(tmp);
  tctx.imageSmoothingEnabled = true;
  tctx.imageSmoothingQuality = 'medium';
  tctx.drawImage(canvas, 0, 0, dw, dh);
  const { lum, w, h } = lumaOf(tmp);
  return { lum, w, h, scale };
}

/** Otsu's method — the gray level that best splits the histogram in two. */
function otsu(gray: Uint8ClampedArray): number {
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
    if (between > max) { max = between; threshold = i; }
  }
  return threshold;
}

// ---------------------------------------------------------------------------
// Skew detection (projection-profile variance)
// ---------------------------------------------------------------------------

/**
 * Estimate the page's skew angle in degrees (positive = rotated clockwise).
 * Method: binarize to an ink mask, then for each candidate angle project the
 * ink onto the vertical axis and score the variance of the row sums. When text
 * lines are level, rows alternate hard between "line" and "gap" → high variance.
 * Coarse 1° sweep, then a 0.1° refinement around the best — fast and accurate.
 *
 * Operates on the downscaled luma so it's a few ms regardless of source size.
 * Returns 0 when the page is essentially level or too empty to judge.
 */
export function detectSkewAngle(lum: Uint8ClampedArray, w: number, h: number, maxDeg = 15): number {
  // Ink mask: darker than Otsu → 1. Bias slightly so faint strokes count.
  const t = otsu(lum);
  const ink = new Uint8Array(w * h);
  let inkCount = 0;
  // Inclusive (<=): a perfectly bimodal histogram leaves Otsu on the low edge
  // of a flat plateau, so the ink value can equal the threshold; `< t` would
  // then drop every ink pixel and the estimate collapses to 0.
  for (let i = 0; i < lum.length; i++) {
    if (lum[i] <= t) { ink[i] = 1; inkCount++; }
  }
  // Too little (blank) or too much (all-dark) ink → no reliable estimate.
  const frac = inkCount / (w * h);
  if (frac < 0.005 || frac > 0.9) return 0;

  const coarse = sweep(ink, w, h, maxDeg, -maxDeg, 1);
  // Refine ±1° around the coarse best at 0.1° resolution.
  const lo = Math.max(-maxDeg, coarse - 1);
  const hi = Math.min(maxDeg, coarse + 1);
  const fine = sweep(ink, w, h, hi, lo, 0.1);
  return Math.abs(fine) < 0.15 ? 0 : Number(fine.toFixed(2));
}

/** Return the angle in [lo,hi] (step `step`) that maximizes row-sum variance. */
function sweep(ink: Uint8Array, w: number, h: number, hi: number, lo: number, step: number): number {
  let best = 0;
  let bestScore = -Infinity;
  for (let deg = lo; deg <= hi + 1e-9; deg += step) {
    const score = profileVariance(ink, w, h, (deg * Math.PI) / 180);
    if (score > bestScore) { bestScore = score; best = deg; }
  }
  return best;
}

/**
 * Variance of the projected row sums when the ink is rotated by `rad`.
 * We don't actually rotate the buffer; we accumulate each ink pixel into the
 * row bucket it WOULD land in after rotation about the image center. O(ink).
 */
function profileVariance(ink: Uint8Array, w: number, h: number, rad: number): number {
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const cx = w / 2;
  const cy = h / 2;
  const rows = new Float64Array(h);
  for (let y = 0; y < h; y++) {
    const dy = y - cy;
    const base = y * w;
    for (let x = 0; x < w; x++) {
      if (!ink[base + x]) continue;
      // Rotated y-coordinate; bucket into the nearest output row.
      const ry = (x - cx) * sin + dy * cos + cy;
      const yi = ry | 0;
      if (yi >= 0 && yi < h) rows[yi]++;
    }
  }
  let mean = 0;
  for (let y = 0; y < h; y++) mean += rows[y];
  mean /= h;
  let varSum = 0;
  for (let y = 0; y < h; y++) {
    const d = rows[y] - mean;
    varSum += d * d;
  }
  return varSum / h;
}

/**
 * Detect skew on a canvas (downscaled internally) and, if non-trivial, return a
 * new canvas rotated to level with a white background. No-op canvases pass
 * straight through.
 */
export function deskewCanvas(canvas: HTMLCanvasElement, maxDeg = 15): HTMLCanvasElement {
  const { lum, w, h } = analyzeLuma(canvas);
  const angle = detectSkewAngle(lum, w, h, maxDeg);
  if (angle === 0) return canvas;
  return rotateCanvas(canvas, -angle);
}

/** Rotate a canvas by `deg` (clockwise) about its center, white fill, expanding
 * the output so no content is clipped. */
export function rotateCanvas(canvas: HTMLCanvasElement, deg: number): HTMLCanvasElement {
  const rad = (deg * Math.PI) / 180;
  const sw = canvas.width;
  const sh = canvas.height;
  const cos = Math.abs(Math.cos(rad));
  const sin = Math.abs(Math.sin(rad));
  const ow = Math.ceil(sw * cos + sh * sin);
  const oh = Math.ceil(sw * sin + sh * cos);
  const out = makeCanvas(ow, oh);
  const ctx = ctxOf(out);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, ow, oh);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.translate(ow / 2, oh / 2);
  ctx.rotate(rad);
  ctx.drawImage(canvas, -sw / 2, -sh / 2);
  return out;
}

// ---------------------------------------------------------------------------
// Auto-crop (trim dark scanner border / shadow gutter)
// ---------------------------------------------------------------------------

/**
 * Find the page's content bounds and crop to them (plus a small margin). Targets
 * the dark frame a flatbed leaves around an undersized page and the shadow gutter
 * around a photographed sheet. Conservative: only crops when it finds a clear,
 * large interior region — otherwise returns the canvas unchanged.
 */
export function autoCropCanvas(canvas: HTMLCanvasElement): HTMLCanvasElement {
  const { lum, w, h, scale } = analyzeLuma(canvas);
  const t = otsu(lum);

  // Column / row "is this mostly page (bright)" occupancy.
  // A border column/row is mostly dark; a page column/row is mostly bright.
  const colBright = new Float64Array(w);
  const rowBright = new Float64Array(h);
  for (let y = 0; y < h; y++) {
    const base = y * w;
    for (let x = 0; x < w; x++) {
      if (lum[base + x] >= t) { colBright[x]++; rowBright[y]++; }
    }
  }
  // Keep the central band where occupancy is above a fraction of its max.
  const colThresh = h * 0.4;
  const rowThresh = w * 0.4;
  let x0 = 0, x1 = w - 1, y0 = 0, y1 = h - 1;
  while (x0 < x1 && colBright[x0] < colThresh) x0++;
  while (x1 > x0 && colBright[x1] < colThresh) x1--;
  while (y0 < y1 && rowBright[y0] < rowThresh) y0++;
  while (y1 > y0 && rowBright[y1] < rowThresh) y1--;

  // Map back to full-res, add a 1% margin so we don't shave page edges.
  const inv = 1 / scale;
  const mx = Math.round((x1 - x0) * 0.01 * inv);
  const my = Math.round((y1 - y0) * 0.01 * inv);
  let fx0 = Math.max(0, Math.round(x0 * inv) - mx);
  let fy0 = Math.max(0, Math.round(y0 * inv) - my);
  let fx1 = Math.min(canvas.width - 1, Math.round(x1 * inv) + mx);
  let fy1 = Math.min(canvas.height - 1, Math.round(y1 * inv) + my);
  const cw = fx1 - fx0 + 1;
  const ch = fy1 - fy0 + 1;

  // Bail if the crop is trivial (<3% trimmed) or implausibly aggressive (<50%
  // of either dimension kept) — protects full-bleed pages and odd content.
  const trimmed = 1 - (cw * ch) / (canvas.width * canvas.height);
  const keepW = cw / canvas.width;
  const keepH = ch / canvas.height;
  if (trimmed < 0.03 || keepW < 0.5 || keepH < 0.5) return canvas;

  const out = makeCanvas(cw, ch);
  ctxOf(out).drawImage(canvas, fx0, fy0, cw, ch, 0, 0, cw, ch);
  return out;
}

// ---------------------------------------------------------------------------
// Adaptive (Sauvola) binarization
// ---------------------------------------------------------------------------

/**
 * Sauvola local thresholding via integral images (O(pixels), window-size
 * independent). For each pixel, threshold = mean·(1 + k·(stddev/R − 1)) over a
 * local window. Keeps text on shaded / unevenly-lit scans where a single global
 * threshold would drop strokes or flood shadows.
 */
export function adaptiveThresholdCanvas(canvas: HTMLCanvasElement): HTMLCanvasElement {
  const ctx = ctxOf(canvas);
  const { width: w, height: h } = canvas;
  const img = ctx.getImageData(0, 0, w, h);
  const data = img.data;

  const lum = new Float64Array(w * h);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    lum[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }

  // Integral images of value and value² (padded by one row/col).
  const W = w + 1;
  const sum = new Float64Array(W * (h + 1));
  const sumSq = new Float64Array(W * (h + 1));
  for (let y = 0; y < h; y++) {
    let rowSum = 0, rowSqr = 0;
    for (let x = 0; x < w; x++) {
      const v = lum[y * w + x];
      rowSum += v;
      rowSqr += v * v;
      const idx = (y + 1) * W + (x + 1);
      sum[idx] = sum[idx - W] + rowSum;
      sumSq[idx] = sumSq[idx - W] + rowSqr;
    }
  }

  // Window ≈ 1/24 of the long edge (odd), classic Sauvola k=0.34, R=128.
  const rad = Math.max(7, Math.round(Math.max(w, h) / 48));
  const k = 0.34;
  const R = 128;

  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - rad);
    const y1 = Math.min(h - 1, y + rad);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - rad);
      const x1 = Math.min(w - 1, x + rad);
      const area = (x1 - x0 + 1) * (y1 - y0 + 1);
      const A = y0 * W + x0;
      const B = y0 * W + (x1 + 1);
      const C = (y1 + 1) * W + x0;
      const D = (y1 + 1) * W + (x1 + 1);
      const s = sum[D] - sum[B] - sum[C] + sum[A];
      const sq = sumSq[D] - sumSq[B] - sumSq[C] + sumSq[A];
      const mean = s / area;
      const variance = sq / area - mean * mean;
      const std = variance > 0 ? Math.sqrt(variance) : 0;
      const threshold = mean * (1 + k * (std / R - 1));
      const v = lum[y * w + x] > threshold ? 255 : 0;
      const o = (y * w + x) * 4;
      data[o] = data[o + 1] = data[o + 2] = v;
      data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}
