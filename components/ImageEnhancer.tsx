import { useEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_ENHANCE, isNoOp, processImage, type EnhanceOptions } from '@/lib/imageProcessing';
import { fmtBytes } from '@/lib/utils';

export interface ImageEnhancerProps {
  file: File;
  value: EnhanceOptions;
  onChange: (opts: EnhanceOptions) => void;
  /** Debounce ms before re-processing the preview. */
  previewDelayMs?: number;
}

/**
 * Read an image's natural pixel dimensions. Returns null until decoded.
 *
 * We deliberately read once per file (not on every render) to keep this
 * cheap even when the file is a 50 MP phone photo. createImageBitmap is
 * the fastest path here — it decodes off the main thread on supporting
 * browsers.
 */
function useNaturalDimensions(blob: Blob | null): { w: number; h: number } | null {
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    let cancelled = false;
    setDims(null);
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const onLoad = (img: { naturalWidth: number; naturalHeight: number }) => {
      if (!cancelled && img.naturalWidth && img.naturalHeight) {
        setDims({ w: img.naturalWidth, h: img.naturalHeight });
      }
    };
    if ('createImageBitmap' in window) {
      createImageBitmap(blob)
        .then((bmp) => {
          onLoad({ naturalWidth: bmp.width, naturalHeight: bmp.height });
          bmp.close?.();
        })
        .catch(() => {
          // Fall through to <img> path below.
        });
    }
    const img = new Image();
    img.onload = () => onLoad(img);
    img.onerror = () => {
      // If we can't decode, leave dims as null → preview falls back to
      // an aspect ratio that's reasonable for "we don't know".
      URL.revokeObjectURL(url);
    };
    img.src = url;
    return () => {
      cancelled = true;
      URL.revokeObjectURL(url);
    };
  }, [blob]);
  return dims;
}

/**
 * Single live preview of the (optionally enhanced) image.
 *
 * Design notes:
 * - The preview container uses the IMAGE's natural aspect ratio, not a
 *   hardcoded 4:3 — so a 16:9 phone photo shows in a 16:9 box, a 9:16
 *   screenshot shows in a 9:16 box, etc. No letterboxing distortion.
 * - When no sliders are touched, the preview IS the original (no canvas
 *   round-trip). The image's bytes and dimensions are unchanged on upload.
 * - The original is always rendered as a small reference next to the
 *   preview so the user can sanity-check at a glance.
 */
export function ImageEnhancer({ file, value, onChange, previewDelayMs = 200 }: ImageEnhancerProps) {
  const dims = useNaturalDimensions(file);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewSize, setPreviewSize] = useState<{ w: number; h: number; bytes: number } | null>(null);
  const [processingMs, setProcessingMs] = useState<number | null>(null);
  const timerRef = useRef<number | null>(null);
  const lastObjectUrlRef = useRef<string | null>(null);

  const originalUrl = useMemo(() => URL.createObjectURL(file), [file]);

  useEffect(() => () => URL.revokeObjectURL(originalUrl), [originalUrl]);

  useEffect(
    () => () => {
      if (lastObjectUrlRef.current) URL.revokeObjectURL(lastObjectUrlRef.current);
    },
    [],
  );

  // Debounced preview. When `value` is a no-op, we skip the canvas
  // entirely and let the <img> render the original — the user's file
  // goes through to the API byte-for-byte.
  useEffect(() => {
    if (timerRef.current) window.clearTimeout(timerRef.current);

    if (isNoOp(value)) {
      if (lastObjectUrlRef.current) {
        URL.revokeObjectURL(lastObjectUrlRef.current);
        lastObjectUrlRef.current = null;
      }
      setPreviewUrl(null);
      setPreviewSize(null);
      setProcessingMs(null);
      return;
    }

    timerRef.current = window.setTimeout(async () => {
      const start = performance.now();
      try {
        const previewOpts: EnhanceOptions = { ...value, targetDpi: clampPreviewDpi(value.targetDpi) };
        const blob = await processImage(file, previewOpts);
        const ms = Math.round(performance.now() - start);
        setProcessingMs(ms);
        if (lastObjectUrlRef.current) URL.revokeObjectURL(lastObjectUrlRef.current);
        const url = URL.createObjectURL(blob);
        lastObjectUrlRef.current = url;
        setPreviewUrl(url);
        // Read the processed blob's dimensions to display size info.
        if ('createImageBitmap' in window) {
          try {
            const bmp = await createImageBitmap(blob);
            setPreviewSize({ w: bmp.width, h: bmp.height, bytes: blob.size });
            bmp.close?.();
          } catch {
            setPreviewSize({ w: 0, h: 0, bytes: blob.size });
          }
        } else {
          setPreviewSize({ w: 0, h: 0, bytes: blob.size });
        }
      } catch (e) {
        console.error('preview processing failed', e);
      }
    }, previewDelayMs);

    return () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
  }, [file, JSON.stringify(value), previewDelayMs]);

  const update = (patch: Partial<EnhanceOptions>) => onChange({ ...value, ...patch });
  const noOp = isNoOp(value);

  // Container aspect ratio: use the image's natural ratio if known,
  // otherwise fall back to 4:3 so the layout doesn't collapse.
  const aspect = dims && dims.w && dims.h ? `${dims.w} / ${dims.h}` : '4 / 3';

  // Compute the projected output size for the DPI slider hint.
  const projectedOutputDims = useMemo(() => {
    if (!dims || !value.targetDpi || value.targetDpi <= 72) return null;
    const scale = Math.min(2, value.targetDpi / 72);
    return { w: Math.round(dims.w * scale), h: Math.round(dims.h * scale) };
  }, [dims, value.targetDpi]);

  return (
    <div className="card p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="text-xs uppercase tracking-wide text-ink-400">Enhance before upload</div>
        <div className="text-xs text-ink-500">
          {noOp
            ? 'passthrough — sending the original'
            : processingMs !== null
              ? `${processingMs} ms preview`
              : 'working…'}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_220px]">
        <div className="grid gap-3 md:grid-cols-[1fr_140px]">
          {/* Main preview — uses the image's natural aspect ratio */}
          <div
            className="relative w-full overflow-hidden rounded-lg border border-ink-800 bg-ink-950"
            style={{ aspectRatio: aspect }}
          >
            <img
              src={previewUrl ?? originalUrl}
              alt={noOp ? 'original (no enhancements)' : 'enhanced preview'}
              className="absolute inset-0 h-full w-full object-contain"
            />
            <div className="pointer-events-none absolute left-3 top-2 rounded bg-black/60 px-2 py-0.5 text-[10px] font-medium text-ink-50">
              {noOp ? 'ORIGINAL' : 'PREVIEW'}
            </div>
          </div>

          {/* The original is always shown as a small reference so the user
              can confirm what they're starting from, even while dragging
              sliders. This is the "input doesn't disappear" guarantee. */}
          <div className="flex flex-col gap-2">
            <div className="text-[10px] uppercase tracking-wide text-ink-500">Original</div>
            <div
              className="relative w-full overflow-hidden rounded-lg border border-ink-800 bg-ink-950"
              style={{ aspectRatio: aspect }}
            >
              <img src={originalUrl} alt="original" className="absolute inset-0 h-full w-full object-contain" />
            </div>
            <div className="text-[10px] text-ink-500">
              {file.name} · {fmtBytes(file.size)}
              {dims && (
                <>
                  <br />
                  {dims.w} × {dims.h} px
                </>
              )}
            </div>
          </div>
        </div>

        {/* Controls */}
        <div className="grid gap-3 text-sm">
          <Slider
            label="Target DPI"
            help={
              noOp
                ? 'Off — your file goes through unchanged.'
                : projectedOutputDims
                  ? `Output ≈ ${projectedOutputDims.w} × ${projectedOutputDims.h} px`
                  : 'Upscale small images. Cap at 2× source.'
            }
            min={0}
            max={600}
            step={50}
            value={value.targetDpi ?? 0}
            onChange={(v) => update({ targetDpi: v })}
            format={(v) => (v === 0 ? 'off' : `${v}`)}
          />
          <Slider
            label="Contrast"
            min={-100}
            max={100}
            step={1}
            value={value.contrast ?? 0}
            onChange={(v) => update({ contrast: v })}
            format={(v) => (v === 0 ? '0' : `${v > 0 ? '+' : ''}${v}`)}
          />
          <Slider
            label="Brightness"
            min={-100}
            max={100}
            step={1}
            value={value.brightness ?? 0}
            onChange={(v) => update({ brightness: v })}
            format={(v) => (v === 0 ? '0' : `${v > 0 ? '+' : ''}${v}`)}
          />
          <Toggle label="Grayscale" help="OCR often does better on B/W" checked={!!value.grayscale} onChange={(v) => update({ grayscale: v })} />
          <Toggle label="Sharpen" help="Unsharp mask. Run after denoise." checked={!!value.sharpen} onChange={(v) => update({ sharpen: v })} />
          <Toggle label="Denoise" help="Median filter for scanned docs" checked={!!value.denoise} onChange={(v) => update({ denoise: v })} />
          <button onClick={() => onChange(DEFAULT_ENHANCE)} className="btn-ghost text-xs" disabled={noOp}>
            Reset
          </button>

          {/* Show projected output size for the DPI slider so the user
              can see what they're about to upload. */}
          {!noOp && previewSize && previewSize.w > 0 && dims && (
            <div className="rounded-md border border-ink-800 bg-ink-900/60 px-2 py-1.5 text-[10px] text-ink-300">
              <div className="text-ink-500">After processing</div>
              <div className="font-mono">
                {previewSize.w} × {previewSize.h} px
                {' · '}
                {fmtBytes(previewSize.bytes)}
              </div>
              {dims && (previewSize.w !== dims.w || previewSize.h !== dims.h) && (
                <div className="text-amber-400">
                  Was {dims.w} × {dims.h} px ({fmtBytes(file.size)})
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Cap the preview DPI so the debounced preview stays under ~50 ms. */
function clampPreviewDpi(dpi: number | undefined): number {
  if (!dpi || dpi <= 72) return 0;
  return Math.min(150, dpi);
}

function Slider({
  label,
  help,
  min,
  max,
  step,
  value,
  onChange,
  format,
}: {
  label: string;
  help?: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (v: number) => void;
  format?: (v: number) => string;
}) {
  return (
    <label className="block">
      <div className="flex items-center justify-between text-xs">
        <span className="text-ink-200">{label}</span>
        <span className="font-mono text-ink-400">{format ? format(value) : value}</span>
      </div>
      {help && <div className="mb-1 text-[10px] text-ink-500">{help}</div>}
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-ink-800 accent-accent"
      />
    </label>
  );
}

function Toggle({
  label,
  help,
  checked,
  onChange,
}: {
  label: string;
  help?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-start justify-between gap-3">
      <span>
        <span className="block text-xs text-ink-200">{label}</span>
        {help && <span className="block text-[10px] text-ink-500">{help}</span>}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${checked ? 'bg-accent' : 'bg-ink-700'}`}
      >
        <span
          className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${checked ? 'translate-x-4' : 'translate-x-0.5'}`}
        />
      </button>
    </label>
  );
}
