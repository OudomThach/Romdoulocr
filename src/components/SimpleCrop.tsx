import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocale } from '@/lib/i18n';

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

type DragMode = { kind: 'draw' } | { kind: 'move'; start: Rect } | { kind: 'resize'; corner: 0 | 1 | 2 | 3 };

/**
 * Dead-simple box crop: drag a rectangle over the image, hit "OCR this area".
 * Replaces the CamScanner-style perspective scanner in the OCR tab — one
 * screen, one action, no styles/corners/warping to learn.
 */
export function SimpleCrop({
  file,
  onDone,
  onCancel,
}: {
  file: File;
  onDone: (cropped: File) => void;
  onCancel: () => void;
}) {
  const { t } = useLocale();
  const [url, setUrl] = useState('');
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null);
  const [rect, setRect] = useState<Rect | null>(null);
  const [busy, setBusy] = useState(false);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<{ mode: DragMode; anchor: { x: number; y: number } } | null>(null);

  useEffect(() => {
    const u = URL.createObjectURL(file);
    setUrl(u);
    const img = new Image();
    img.onload = () => {
      setNat({ w: img.naturalWidth, h: img.naturalHeight });
      // Default selection: centered 80% box — usable with zero adjustment.
      setRect({
        x: img.naturalWidth * 0.1,
        y: img.naturalHeight * 0.1,
        w: img.naturalWidth * 0.8,
        h: img.naturalHeight * 0.8,
      });
    };
    img.src = u;
    return () => URL.revokeObjectURL(u);
  }, [file]);

  const toNat = useCallback(
    (clientX: number, clientY: number) => {
      const svg = svgRef.current;
      if (!svg || !nat) return null;
      const b = svg.getBoundingClientRect();
      if (b.width === 0 || b.height === 0) return null;
      return {
        x: Math.max(0, Math.min(nat.w, ((clientX - b.left) / b.width) * nat.w)),
        y: Math.max(0, Math.min(nat.h, ((clientY - b.top) / b.height) * nat.h)),
      };
    },
    [nat],
  );

  const corners = (r: Rect): { x: number; y: number }[] => [
    { x: r.x, y: r.y },
    { x: r.x + r.w, y: r.y },
    { x: r.x + r.w, y: r.y + r.h },
    { x: r.x, y: r.y + r.h },
  ];

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    const p = toNat(e.clientX, e.clientY);
    if (!p || !nat || !rect) return;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const grab = Math.max(nat.w, nat.h) * 0.035; // finger-sized hit area
    const cs = corners(rect);
    const hit = cs.findIndex((c) => Math.hypot(c.x - p.x, c.y - p.y) <= grab);
    if (hit >= 0) {
      dragRef.current = { mode: { kind: 'resize', corner: hit as 0 | 1 | 2 | 3 }, anchor: p };
    } else if (p.x >= rect.x && p.x <= rect.x + rect.w && p.y >= rect.y && p.y <= rect.y + rect.h) {
      dragRef.current = { mode: { kind: 'move', start: rect }, anchor: p };
    } else {
      dragRef.current = { mode: { kind: 'draw' }, anchor: p };
      setRect({ x: p.x, y: p.y, w: 0, h: 0 });
    }
  };

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    const p = toNat(e.clientX, e.clientY);
    if (!drag || !p || !nat) return;
    if (drag.mode.kind === 'draw') {
      setRect(normalize(drag.anchor, p));
    } else if (drag.mode.kind === 'move') {
      const s = drag.mode.start;
      const dx = p.x - drag.anchor.x;
      const dy = p.y - drag.anchor.y;
      setRect({
        x: Math.max(0, Math.min(nat.w - s.w, s.x + dx)),
        y: Math.max(0, Math.min(nat.h - s.h, s.y + dy)),
        w: s.w,
        h: s.h,
      });
    } else {
      setRect((r) => {
        if (!r) return r;
        const cs = corners(r);
        const opposite = cs[(drag.mode as { corner: number }).corner === 0 ? 2 : (drag.mode as { corner: number }).corner === 1 ? 3 : (drag.mode as { corner: number }).corner === 2 ? 0 : 1];
        return normalize(opposite, p);
      });
    }
  };

  const onPointerUp = () => {
    dragRef.current = null;
  };

  const apply = async () => {
    if (!rect || !nat || rect.w < 8 || rect.h < 8) return;
    setBusy(true);
    try {
      const bmp = await createImageBitmap(file);
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(rect.w);
      canvas.height = Math.round(rect.h);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('canvas unavailable');
      ctx.drawImage(bmp, rect.x, rect.y, rect.w, rect.h, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'));
      if (!blob) throw new Error('crop failed');
      const base = file.name.replace(/\.[^.]+$/, '');
      onDone(new File([blob], `${base}-crop.png`, { type: 'image/png' }));
    } finally {
      setBusy(false);
    }
  };

  const handleR = nat ? Math.max(nat.w, nat.h) * 0.012 : 6;

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={t('crop.title')}
    >
      <section className="panel-raised toast-in flex max-h-[92vh] w-full max-w-2xl flex-col p-4 sm:p-6">
        <header className="mb-3 flex items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold tracking-tight text-slate-950">{t('crop.title')}</h2>
            <p className="text-xs text-slate-500">{t('crop.hint')}</p>
          </div>
        </header>

        <div className="relative min-h-0 flex-1 overflow-auto">
          {url && nat && rect && (
            <svg
              ref={svgRef}
              viewBox={`0 0 ${nat.w} ${nat.h}`}
              className="h-auto w-full touch-none select-none rounded-lg"
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
            >
              <image href={url} width={nat.w} height={nat.h} />
              {/* dim everything outside the selection */}
              <path
                d={`M0 0H${nat.w}V${nat.h}H0Z M${rect.x} ${rect.y}h${rect.w}v${rect.h}h${-rect.w}Z`}
                fillRule="evenodd"
                fill="rgb(0 0 0 / 0.55)"
              />
              <rect
                x={rect.x}
                y={rect.y}
                width={rect.w}
                height={rect.h}
                fill="none"
                stroke="rgb(var(--c-accent))"
                strokeWidth={handleR / 2.5}
              />
              {corners(rect).map((c, i) => (
                <circle key={i} cx={c.x} cy={c.y} r={handleR} fill="rgb(var(--c-accent))" stroke="#fff" strokeWidth={handleR / 4} />
              ))}
            </svg>
          )}
        </div>

        <footer className="mt-4 flex flex-wrap justify-end gap-2">
          <button type="button" onClick={onCancel} className="btn-secondary min-h-11">
            {t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={() => void apply()}
            disabled={busy || !rect || rect.w < 8 || rect.h < 8}
            className="btn-primary min-h-11"
          >
            {t('crop.apply')}
          </button>
        </footer>
      </section>
    </div>
  );
}

function normalize(a: { x: number; y: number }, b: { x: number; y: number }): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(b.x - a.x),
    h: Math.abs(b.y - a.y),
  };
}
