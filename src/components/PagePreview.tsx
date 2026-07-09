import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { RegionReadButton } from '@/components/RegionReocr';
import type { BackendId } from '@/lib/backend';

const MIN_ZOOM = 1;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.25;

export interface ZoomableImageProps {
  imageUrl?: string;
  alt?: string;
  emptyMessage?: string;
  /** Min container height. Defaults to 520px. */
  minHeightClass?: string;
  /**
   * When true, +/- and 0 keys zoom (ignored while typing in a field).
   * Defaults to true.
   */
  enableKeyboard?: boolean;
  /**
   * Show the "Read area" crop button in the controls (defaults to true when an
   * image is present). The region read uses `regionBackend` or, if omitted, the
   * currently-active OCR backend.
   */
  allowRegionRead?: boolean;
  regionBackend?: BackendId;
}

/**
 * A page/table image that can be zoomed (buttons, +/-/0 keys, Ctrl+wheel) and
 * panned by scrolling once enlarged. Zoom controls float in the top-right of
 * the image so this is fully self-contained and reusable across tabs.
 */
export function ZoomableImage({
  imageUrl,
  alt,
  emptyMessage = 'No image preview available.',
  minHeightClass = 'min-h-[520px]',
  enableKeyboard = true,
  allowRegionRead = true,
  regionBackend,
}: ZoomableImageProps) {
  const [zoom, setZoom] = useState(1);
  const rootRef = useRef<HTMLDivElement>(null);

  // Reset to "fit" whenever the image changes.
  useEffect(() => {
    setZoom(1);
  }, [imageUrl]);

  const zoomIn = useCallback(() => setZoom((z) => Math.min(MAX_ZOOM, +(z + ZOOM_STEP).toFixed(2))), []);
  const zoomOut = useCallback(() => setZoom((z) => Math.max(MIN_ZOOM, +(z - ZOOM_STEP).toFixed(2))), []);
  const zoomFit = useCallback(() => setZoom(1), []);

  useEffect(() => {
    if (!enableKeyboard || !imageUrl) return;
    const handler = (e: KeyboardEvent) => {
      // Ignore when this preview is in a hidden (display:none) tab.
      if (rootRef.current?.offsetParent === null) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.key === '+' || e.key === '=') {
        e.preventDefault();
        zoomIn();
      } else if (e.key === '-' || e.key === '_') {
        e.preventDefault();
        zoomOut();
      } else if (e.key === '0') {
        e.preventDefault();
        zoomFit();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [enableKeyboard, imageUrl, zoomIn, zoomOut, zoomFit]);

  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      if (!imageUrl || !(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      if (e.deltaY < 0) zoomIn();
      else zoomOut();
    },
    [imageUrl, zoomIn, zoomOut],
  );

  return (
    <div
      ref={rootRef}
      className={`relative grid ${minHeightClass} place-items-center overflow-auto rounded-lg border border-slate-200 bg-slate-50 p-4`}
      onWheel={onWheel}
    >
      {imageUrl && (
        <div className="absolute right-2 top-2 z-10 inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white/95 px-1.5 py-1 text-sm text-slate-700 shadow-sm backdrop-blur">
          {allowRegionRead && (
            <>
              <RegionReadButton imageUrl={imageUrl} backend={regionBackend} variant="chip" />
              <span className="mx-0.5 h-5 w-px bg-slate-200" aria-hidden="true" />
            </>
          )}
          <button
            type="button"
            onClick={zoomOut}
            disabled={zoom <= MIN_ZOOM}
            className="grid h-7 w-7 place-items-center rounded font-semibold hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40"
            title="Zoom out (-)"
            aria-label="Zoom out"
          >
            &minus;
          </button>
          <button
            type="button"
            onClick={zoomFit}
            className="rounded px-2 py-1 text-xs font-semibold tabular-nums hover:bg-slate-100"
            title="Fit to view (0)"
          >
            {zoom === 1 ? 'Fit' : `${Math.round(zoom * 100)}%`}
          </button>
          <button
            type="button"
            onClick={zoomIn}
            disabled={zoom >= MAX_ZOOM}
            className="grid h-7 w-7 place-items-center rounded font-semibold hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40"
            title="Zoom in (+)"
            aria-label="Zoom in"
          >
            +
          </button>
        </div>
      )}
      {imageUrl ? (
        <img
          src={imageUrl}
          alt={alt ?? 'Preview'}
          draggable={false}
          style={{
            transform: `scale(${zoom})`,
            transformOrigin: zoom === 1 ? 'center' : 'top center',
            cursor: zoom > 1 ? 'grab' : 'default',
          }}
          className="max-h-[82vh] w-auto max-w-full rounded bg-white object-contain shadow-sm"
        />
      ) : (
        <div className="text-sm text-slate-500">{emptyMessage}</div>
      )}
    </div>
  );
}

export interface PagePreviewProps {
  /** Source page image URL (the actual rasterized page being shown). */
  imageUrl?: string;
  alt?: string;
  /** 0-based index of the page currently shown. */
  pageIndex: number;
  /** Total pages available to navigate. 1 for single images. */
  numPages: number;
  onPageChange: (index: number) => void;
  /** Right-hand side content — the extracted text / markdown for this page. */
  output: ReactNode;
  outputLabel?: string;
  /** Message shown when there is no image to preview. */
  emptyImageMessage?: string;
  /**
   * When true, ← / → change pages (as long as focus isn't in a text field).
   * Defaults to true.
   */
  enableKeyboard?: boolean;
}

/**
 * Shared side-by-side page preview used by every tab: the source page image
 * on the left (zoomable + pannable) and the extracted output on the right,
 * with prev/next page controls and keyboard navigation.
 *
 * Page navigation is always wired to the REAL page index, so "page 5" shows
 * page 5's image — the same number the user selected and extracted.
 */
export function PagePreview({
  imageUrl,
  alt,
  pageIndex,
  numPages,
  onPageChange,
  output,
  outputLabel = 'Page Text',
  emptyImageMessage = 'No page image preview available.',
  enableKeyboard = true,
}: PagePreviewProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const canPrev = pageIndex > 0;
  const canNext = numPages > 0 && pageIndex < numPages - 1;

  const goPrev = useCallback(() => {
    onPageChange(Math.max(0, pageIndex - 1));
  }, [onPageChange, pageIndex]);
  const goNext = useCallback(() => {
    onPageChange(Math.min(Math.max(0, numPages - 1), pageIndex + 1));
  }, [onPageChange, numPages, pageIndex]);

  // Keyboard: arrow keys flip pages, ignored while typing in a form field.
  useEffect(() => {
    if (!enableKeyboard) return;
    const handler = (e: KeyboardEvent) => {
      if (rootRef.current?.offsetParent === null) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.key === 'ArrowRight' && canNext) {
        e.preventDefault();
        goNext();
      } else if (e.key === 'ArrowLeft' && canPrev) {
        e.preventDefault();
        goPrev();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [enableKeyboard, canNext, canPrev, goNext, goPrev]);

  return (
    <div ref={rootRef} className="grid gap-4">
      <div className="inline-flex w-fit items-center gap-2 rounded-lg border border-slate-200 bg-white px-2 py-1 text-sm text-slate-700 shadow-sm">
        <button
          type="button"
          onClick={goPrev}
          disabled={!canPrev}
          className="rounded px-2 py-1 font-semibold hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40"
          title="Previous page (←)"
        >
          Prev
        </button>
        <span className="min-w-16 text-center tabular-nums">
          {numPages ? `${pageIndex + 1} / ${numPages}` : '0 / 0'}
        </span>
        <button
          type="button"
          onClick={goNext}
          disabled={!canNext}
          className="rounded px-2 py-1 font-semibold hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40"
          title="Next page (→)"
        >
          Next
        </button>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.15fr)_minmax(320px,0.85fr)]">
        <ZoomableImage imageUrl={imageUrl} alt={alt} emptyMessage={emptyImageMessage} />
        <div className="max-h-[82vh] overflow-auto rounded-lg border border-slate-200 bg-white p-4 text-[15px] leading-relaxed text-slate-800">
          <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-500">{outputLabel}</div>
          {output}
        </div>
      </div>
    </div>
  );
}
