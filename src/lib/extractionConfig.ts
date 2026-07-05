// Central knobs for OCR recall ("extract ALL the text").
//
// Two toggles, both exposed in the UI and stored in useSettingsStore so they
// can be reverted at any time without a code change:
//
//   highRes      — rasterize PDFs / upscale images at a higher resolution so
//                  dense Khmer text (stacked sub-consonants, diacritics) keeps
//                  enough pixels for the model to read. Revert = back to the
//                  previous 200 DPI / 2500px behavior.
//   fullPageOcr  — after the normal layout pass, run a second pass with
//                  detect_layout=false (whole page) and append any text the
//                  layout boxes missed (margins, headers/footers, stamps).
//                  Revert = single layout-only pass.
//
// To change the defaults globally, edit STANDARD_RASTER / HIGH_RASTER below.

import type { EnhanceOptions } from '@/lib/imageProcessing';

export interface RasterProfile {
  /** PDF rasterization DPI and image upscaling target. */
  dpi: number;
  /** Max long edge in pixels (0 = uncapped). */
  maxDimension: number;
}

// NOTE: maxDimension is 0 (uncapped) on both profiles — the full native
// resolution of every page/image is sent to OCR so nothing dense (tables,
// stacked Khmer glyphs) gets thrown away by downscaling. Tradeoff: very large
// scans produce large PNG uploads. To re-introduce a ceiling, set a pixel
// value here (e.g. 4000) instead of 0.

/** Previous behavior — kept as the "revert" target. */
export const STANDARD_RASTER: RasterProfile = { dpi: 200, maxDimension: 0 };

/**
 * Improved recall — more pixels for dense scripts. 400 DPI is the OCR sweet
 * spot: for vector PDFs this is genuinely sharper rasterization (not just
 * interpolation), which helps stacked sub-consonants / diacritics resolve.
 * Bump to 600 for very small print at the cost of much larger uploads.
 */
export const HIGH_RASTER: RasterProfile = { dpi: 400, maxDimension: 0 };

export function rasterFor(highRes: boolean): RasterProfile {
  return highRes ? HIGH_RASTER : STANDARD_RASTER;
}

/**
 * Preprocessing options for a source image. Same cleanup pipeline as before
 * (grayscale / contrast / sharpen / denoise / brightness); only the resolution
 * ceiling changes with the highRes toggle.
 */
/**
 * Minimal preprocessing (OCR Image tab): ONLY resolution normalization —
 * upscale small images toward the target DPI — plus JPEG upload encoding.
 * NO tonal or geometry edits (grayscale / contrast / sharpen / denoise /
 * brightness / deskew / autoCrop): what you upload is what the engine reads.
 * Rationale: adapter-side A/B testing showed aggressive tonal filters can
 * CORRUPT clean text, and the silent edits confused users ("what did you do
 * to my image?"). The document tabs keep the full pipeline for tilted scans.
 */
export function minimalPreprocessOpts(highRes: boolean): EnhanceOptions {
  const { dpi, maxDimension } = rasterFor(highRes);
  return { targetDpi: dpi, maxDimension, format: 'jpeg' };
}

export function preprocessOpts(highRes: boolean): EnhanceOptions {
  const { dpi, maxDimension } = rasterFor(highRes);
  return {
    grayscale: true,
    contrast: 20,
    sharpen: true,
    denoise: true,
    brightness: 10,
    maxDimension,
    targetDpi: dpi,
    // Geometry boosters: deskew + border-crop straighten and trim a scanned
    // page before OCR — the biggest win for line segmentation on tilted scans,
    // and both are no-ops on an already-clean page. adaptiveThreshold is left
    // OFF here (it hard-binarizes, which can hurt the model on color/photo
    // input); expose it as an opt-in toggle for users with shaded B/W scans.
    deskew: true,
    autoCrop: true,
    // JPEG upload encoding: ~5-10× smaller than PNG at OCR-equivalent quality,
    // which is the single biggest "connection speed" win (upload dominates on
    // big scans). Display/format-conversion paths keep PNG.
    format: 'jpeg',
  };
}
