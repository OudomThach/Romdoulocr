import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { getBackend, type BackendId } from '@/lib/backend';
import { useLocale } from '@/lib/i18n';
import { normalizeOcrResponse } from '@/types/api';
import { copyToClipboard } from '@/lib/utils';

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * "Zoom in and re-read": drag a box over a page image and re-run OCR on just
 * that crop. Small / blurry text that garbles in a full-page pass usually reads
 * cleanly when isolated. Crops from the displayed image at its native pixels.
 *
 * Used by the shared page renderers (ZoomableImage, PageImageWithBoxes) so the
 * "read a specific area" affordance is available on every tab's page image.
 * `backend` defaults to whichever OCR backend is currently active, so the region
 * read matches what the tab itself is using.
 */
export function RegionReocr({
  imageUrl,
  onClose,
  backend,
}: {
  imageUrl: string;
  onClose: () => void;
  backend?: BackendId;
}) {
  const { t } = useLocale();
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null);
  const [rect, setRect] = useState<Rect | null>(null);
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const boxRef = useRef<HTMLDivElement>(null);
  const startRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const img = new Image();
    img.onload = () => setNat({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => setError('Could not load the page image.');
    img.src = imageUrl;
  }, [imageUrl]);

  const toSource = useCallback(
    (clientX: number, clientY: number) => {
      const el = boxRef.current;
      if (!el || !nat) return null;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      return {
        x: Math.max(0, Math.min(nat.w, ((clientX - r.left) / r.width) * nat.w)),
        y: Math.max(0, Math.min(nat.h, ((clientY - r.top) / r.height) * nat.h)),
      };
    },
    [nat],
  );

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (!startRef.current) return;
      const p = toSource(e.clientX, e.clientY);
      if (!p) return;
      const s = startRef.current;
      setRect({ x: Math.min(s.x, p.x), y: Math.min(s.y, p.y), w: Math.abs(p.x - s.x), h: Math.abs(p.y - s.y) });
    };
    const onUp = () => {
      startRef.current = null;
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [toSource]);

  const runReocr = useCallback(async () => {
    if (!rect || rect.w < 4 || rect.h < 4) return;
    setBusy(true);
    setError(null);
    setText(null);
    try {
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error('image load failed'));
        img.src = imageUrl;
      });
      const sw = Math.round(rect.w);
      const sh = Math.round(rect.h);
      const canvas = document.createElement('canvas');
      canvas.width = sw;
      canvas.height = sh;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Canvas 2D context unavailable');
      ctx.drawImage(img, Math.round(rect.x), Math.round(rect.y), sw, sh, 0, 0, sw, sh);
      const blob: Blob = await new Promise((resolve, reject) =>
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('crop failed'))), 'image/png'),
      );
      const file = new File([blob], 'region.png', { type: 'image/png' });
      const raw = await api.ocrImage(file, { useCtc: true }, { backend: backend ?? getBackend() });
      setText(normalizeOcrResponse(raw as unknown).text || t('region.noText'));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Re-OCR failed');
    } finally {
      setBusy(false);
    }
  }, [rect, imageUrl, backend, t]);

  const pct = (v: number, total: number) => `${(v / total) * 100}%`;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/70 p-4 backdrop-blur-sm">
      <div className="flex max-h-[92vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xl">
        <header className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
          <div>
            <h2 className="text-base font-semibold text-slate-950">{t('region.title')}</h2>
            <p className="text-xs text-slate-500">{t('region.hint')}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-2 py-1 text-sm font-semibold text-slate-500 hover:bg-slate-100 hover:text-slate-950"
          >
            {t('region.close')}
          </button>
        </header>

        <div className="grid min-h-0 flex-1 place-items-center overflow-auto bg-slate-100 p-4">
          {nat ? (
            <div
              ref={boxRef}
              className="relative max-h-full max-w-full cursor-crosshair select-none"
              style={{ aspectRatio: `${nat.w} / ${nat.h}`, width: 'min(100%, 620px)' }}
              onPointerDown={(e) => {
                e.preventDefault();
                const p = toSource(e.clientX, e.clientY);
                if (p) {
                  startRef.current = p;
                  setRect({ x: p.x, y: p.y, w: 0, h: 0 });
                  setText(null);
                }
              }}
            >
              <img src={imageUrl} alt="Page" draggable={false} className="absolute inset-0 h-full w-full rounded-lg object-contain" />
              {rect && rect.w > 0 && nat && (
                <div
                  className="absolute border-2 border-accent bg-accent/15"
                  style={{ left: pct(rect.x, nat.w), top: pct(rect.y, nat.h), width: pct(rect.w, nat.w), height: pct(rect.h, nat.h) }}
                />
              )}
            </div>
          ) : (
            <div className="grid h-64 place-items-center text-sm text-slate-500">{error ?? t('region.loading')}</div>
          )}
        </div>

        <footer className="border-t border-slate-200 px-5 py-3">
          {text !== null && (
            <div className="mb-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
              <div className="mb-1 flex items-center justify-between">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{t('region.result')}</span>
                <button
                  type="button"
                  onClick={() => void copyToClipboard(text)}
                  className="rounded-md border border-slate-200 bg-white px-2 py-0.5 text-[11px] font-semibold text-slate-700 hover:bg-slate-100"
                >
                  {t('region.copy')}
                </button>
              </div>
              <p
                className="max-h-40 overflow-auto whitespace-pre-wrap break-words text-sm text-slate-800"
                style={{ fontFamily: "'Noto Sans Khmer', 'Khmer OS Siemreap', 'Segoe UI', sans-serif" }}
              >
                {text}
              </p>
            </div>
          )}
          {error && nat && <p className="mb-2 text-xs text-rose-600">{error}</p>}
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                setRect(null);
                setText(null);
              }}
              disabled={!rect || busy}
              className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              {t('region.clear')}
            </button>
            <button
              type="button"
              onClick={() => void runReocr()}
              disabled={!rect || rect.w < 4 || rect.h < 4 || busy}
              className="inline-flex items-center gap-2 rounded-lg bg-slate-950 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
            >
              {busy ? t('region.running') : t('region.run')}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

/**
 * Self-contained "Read area" trigger: a small crop button that opens the
 * RegionReocr modal on the given page image. Dropped into the shared page
 * renderers (ZoomableImage, PageImageWithBoxes) so every tab's page image gets
 * the same "crop & read a specific part" affordance. Renders nothing without an
 * image. `variant="chip"` matches the floating zoom-control style.
 */
export function RegionReadButton({
  imageUrl,
  backend,
  variant = 'chip',
}: {
  imageUrl?: string;
  backend?: BackendId;
  variant?: 'chip' | 'solid';
}) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  if (!imageUrl) return null;

  const cls =
    variant === 'solid'
      ? 'inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white/95 px-2.5 py-1.5 text-xs font-semibold text-slate-700 shadow-sm backdrop-blur hover:bg-slate-100'
      : 'grid h-7 place-items-center gap-1 rounded px-2 text-xs font-semibold hover:bg-slate-100';

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={cls} title={t('region.title')}>
        <CropIcon className="h-4 w-4" />
        <span className={variant === 'chip' ? 'hidden sm:inline' : ''}>{t('region.button')}</span>
      </button>
      {open && <RegionReocr imageUrl={imageUrl} backend={backend} onClose={() => setOpen(false)} />}
    </>
  );
}

function CropIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 2v14a2 2 0 0 0 2 2h14" />
      <path d="M18 22V8a2 2 0 0 0-2-2H2" />
    </svg>
  );
}
