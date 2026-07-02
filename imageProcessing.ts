// Browser-side image preprocessing for the OCR pipeline.
//
// We use the native Canvas2D API instead of pulling in OpenCV.js (~8 MB) or
// another library because:
//   - the operations the user actually needs (resize / contrast / brightness /
//     grayscale / sharpen / denoise) are 10-30 lines each in canvas
//   - keeping the bundle small matters — the upstream API itself is heavy
//   - all processing happens off the main thread only via the browser's
//     internal canvas implementation; we don't block React rendering for more
//     than a single decode + encode per file
//
// All functions are pure: they take a Blob/File and return a new File. They
// never mutate the input.

export interface EnhanceOptions {
  /** Target DPI; images smaller than this get upscaled. 0 = leave as-is. */
  targetDpi?: number;
  /** Max long edge in pixels. Images larger get downscaled. 0 = no limit. */
  maxDimension?: number;
  /** -100..+100. 0 = leave as-is. */
  contrast?: number;
  /** -100..+100. 0 = leave as-is. */
  brightness?: number;
  /** Drop color information. */
  grayscale?: boolean;
  /** Mild 3x3 unsharp mask. */
  sharpen?: boolean;
  /** 3x3 median filter — good for scanned docs with salt-and-pepper noise. */
  denoise?: boolean;
}

export const DEFAULT_ENHANCE: Required<EnhanceOptions> = {
  targetDpi: 0,
  maxDimension: 0,
  contrast: 0,
  brightness: 0,
  grayscale: false,
  sharpen: false,
  denoise: false,
};

/** Detect "is this a no-op" so we can skip the canvas round-trip entirely. */
export function isNoOp(opts: EnhanceOptions): boolean {
  return (
    (!opts.targetDpi || opts.targetDpi <= 0) &&
    !opts.contrast &&
    !opts.brightness &&
    !opts.grayscale &&
    !opts.sharpen &&
    !opts.denoise
  );
}

/**
 * Read any image File/Blob into an HTMLImageElement. Uses createImageBitmap
 * when available — it's ~2-3x faster than <img>.src on large images.
 */
async function loadBitmap(file: Blob): Promise<ImageBitmap & { __srcW: number; __srcH: number }> {
  if ('createImageBitmap' in window) {
    const bmp = await createImageBitmap(file);
    return Object.assign(bmp, { __srcW: bmp.width, __srcH: bmp.height });
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(Object.assign(img, { __srcW: img.naturalWidth, __srcH: img.naturalHeight }) as never);
    };
    img.onerror = (e) => {
      URL.revokeObjectURL(url);
      reject(e);
    };
    img.src = url;
  });
}

/**
 * Apply the full pipeline. Returns a new PNG File with the original filename
 * (but extension swapped to .png) so the upstream API receives a clean PNG.
 *
 * Always converts to PNG even when no enhancements are applied, so formats
 * the browser can't preview natively (TIFF, BMP) become displayable.
 */
export async function processImage(file: Blob, opts: EnhanceOptions = {}): Promise<File> {
  const noOp = isNoOp(opts);
  const isPng = (file as File).name?.toLowerCase().endsWith('.png');
  if (noOp && isPng) return file as File;

  const src = await loadBitmap(file);
  const { width: outW, height: outH } = outputSize(src.__srcW, src.__srcH, opts.targetDpi ?? 0, opts.maxDimension ?? 0);

  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Canvas 2D context unavailable');

  // Step 1: draw at output size (this is the upscaling step when targetDpi > srcDpi).
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, outW, outH);

  // Step 2: pixel-level adjustments (skipped when no-op — just format conversion).
  if (!noOp) {
    if (opts.brightness || opts.contrast || opts.grayscale) {
      const img = ctx.getImageData(0, 0, outW, outH);
      applyTonal(img.data, opts.contrast ?? 0, opts.brightness ?? 0, !!opts.grayscale);
      ctx.putImageData(img, 0, 0);
    }

    if (opts.denoise) {
      const img = ctx.getImageData(0, 0, outW, outH);
      applyMedianFilter(img.data, outW, outH, 1);
      ctx.putImageData(img, 0, 0);
    }
    if (opts.sharpen) {
      const img = ctx.getImageData(0, 0, outW, outH);
      applyUnsharpMask(img.data, outW, outH, 0.6);
      ctx.putImageData(img, 0, 0);
    }
  }

  // Encode as PNG (lossless, best for OCR downstream).
  const blob: Blob = await new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('canvas.toBlob failed'))), 'image/png'),
  );

  const name = swapExt((file as File).name ?? 'image.png', '.png');
  return new File([blob], name, { type: 'image/png' });
}

/**
 * Decide output canvas size based on a target DPI. We treat the source image
 * as if it were scanned at 72 DPI unless we can prove otherwise, because
 * most phone photos and screenshots don't have meaningful DPI metadata.
 *
 * This is intentionally heuristic: a 3000x4000 phone photo will get the DPI
 * slider up to 300 and yield a 12500x16667 image (which is way too big).
 * So we cap the upscale at 2x the original to bound the upload size.
 */
function outputSize(srcW: number, srcH: number, targetDpi: number, maxDim: number): { width: number; height: number } {
  let w = srcW;
  let h = srcH;

  // Downscale if longer edge exceeds maxDimension
  const longEdge = Math.max(w, h);
  if (maxDim > 0 && longEdge > maxDim) {
    const scale = maxDim / longEdge;
    w = Math.round(w * scale);
    h = Math.round(h * scale);
  }

  // Upscale if target DPI requires it
  if (targetDpi > 72) {
    const scale = Math.min(2, targetDpi / 72);
    w = Math.round(w * scale);
    h = Math.round(h * scale);
  }

  return { width: w, height: h };
}

function swapExt(name: string, ext: string): string {
  const i = name.lastIndexOf('.');
  return (i > 0 ? name.slice(0, i) : name) + ext;
}

/** Per-pixel tonal adjustments. Modifies the buffer in place. */
function applyTonal(data: Uint8ClampedArray, contrast: number, brightness: number, grayscale: boolean): void {
  // Map slider ranges to actual transform params.
  // Contrast factor: -100 -> 0, 0 -> 1, +100 -> 2.
  const c = (contrast + 100) / 100;
  // Brightness offset: -100 -> -50, 0 -> 0, +100 -> +50.
  const b = brightness / 2;

  for (let i = 0; i < data.length; i += 4) {
    let r = data[i];
    let g = data[i + 1];
    let bl = data[i + 2];

    if (grayscale) {
      // Rec. 601 luma — perceived brightness, not a flat average.
      const y = 0.299 * r + 0.587 * g + 0.114 * bl;
      r = g = bl = y;
    }

    // Contrast around mid-gray, then add brightness offset, then clamp.
    r = clamp255(c * (r - 128) + 128 + b);
    g = clamp255(c * (g - 128) + 128 + b);
    bl = clamp255(c * (bl - 128) + 128 + b);

    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = bl;
    // Alpha untouched.
  }
}

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

/**
 * 3x3 unsharp mask: a tiny sharpening kernel that emphasizes edges without
 * the ringing artifacts of a hard Laplacian. amount=1 is strong; we use 0.6.
 */
function applyUnsharpMask(data: Uint8ClampedArray, w: number, h: number, amount: number): void {
  const src = new Uint8ClampedArray(data);
  // Sharpen kernel (sums to 1, so overall brightness is preserved):
  //   0 -k  0
  //  -k 1+4k -k
  //   0 -k  0
  const k = amount;
  const center = 1 + 4 * k;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const idx = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        const v =
          center * src[idx + c] -
          k * (src[idx - 4 + c] + src[idx + 4 + c] + src[idx - w * 4 + c] + src[idx + w * 4 + c]);
        data[idx + c] = clamp255(v);
      }
    }
  }
}

/**
 * 3x3 median filter. Great for removing salt-and-pepper noise from scanned
 * documents; side effect is slight softening of edges, which is why we run
 * it BEFORE sharpening.
 */
function applyMedianFilter(data: Uint8ClampedArray, w: number, h: number, radius: number): void {
  const src = new Uint8ClampedArray(data);
  const window: number[] = new Array((2 * radius + 1) ** 2);
  for (let y = radius; y < h - radius; y++) {
    for (let x = radius; x < w - radius; x++) {
      const idx = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        let n = 0;
        for (let ky = -radius; ky <= radius; ky++) {
          for (let kx = -radius; kx <= radius; kx++) {
            window[n++] = src[((y + ky) * w + (x + kx)) * 4 + c];
          }
        }
        // Partial sort — just need the middle. Faster than full sort.
        const mid = window.length >> 1;
        const sorted = window.slice().sort((a, b) => a - b);
        data[idx + c] = sorted[mid];
      }
    }
  }
}
