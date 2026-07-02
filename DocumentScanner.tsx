import { useCallback, useEffect, useRef, useState } from 'react';
import {
  detectDocumentCorners,
  insetCorners,
  scanDocument,
  type Corners,
  type Point,
  type ScanStyle,
} from '@/lib/documentScan';

type CornerKey = keyof Corners;

const CORNER_ORDER: CornerKey[] = ['tl', 'tr', 'br', 'bl'];

export interface DocumentScannerProps {
  file: File;
  onDone: (scanned: File) => void;
  onCancel: () => void;
}

/**
 * CamScanner-style crop screen: the photo with 4 draggable corner handles,
 * auto-positioned by edge detection. Drag to fix, pick an output look, Scan →
 * returns a flattened, lighting-corrected PNG.
 */
export function DocumentScanner({ file, onDone, onCancel }: DocumentScannerProps) {
  const [url, setUrl] = useState<string>('');
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null);
  const [corners, setCorners] = useState<Corners | null>(null);
  const [style, setStyle] = useState<ScanStyle>('grayscale');
  const [detecting, setDetecting] = useState(true);
  const [autoDetected, setAutoDetected] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<CornerKey | null>(null);

  // Object URL for the on-screen photo.
  useEffect(() => {
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);

  // Auto-detect corners once.
  useEffect(() => {
    let cancelled = false;
    setDetecting(true);
    setError(null);
    (async () => {
      try {
        const res = await detectDocumentCorners(file);
        if (cancelled) return;
        setNat({ w: res.width, h: res.height });
        setCorners(res.corners);
        setAutoDetected(res.detected);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'Could not read the image');
      } finally {
        if (!cancelled) setDetecting(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [file]);

  const clientToSource = useCallback(
    (clientX: number, clientY: number): Point | null => {
      const svg = svgRef.current;
      if (!svg || !nat) return null;
      const rect = svg.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return null;
      const x = ((clientX - rect.left) / rect.width) * nat.w;
      const y = ((clientY - rect.top) / rect.height) * nat.h;
      return {
        x: Math.max(0, Math.min(nat.w, x)),
        y: Math.max(0, Math.min(nat.h, y)),
      };
    },
    [nat],
  );

  // Global pointer handlers while dragging a handle.
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const key = dragRef.current;
      if (!key) return;
      const p = clientToSource(e.clientX, e.clientY);
      if (!p) return;
      setCorners((c) => (c ? { ...c, [key]: p } : c));
    };
    const onUp = () => {
      dragRef.current = null;
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [clientToSource]);

  const reset = useCallback(() => {
    setDetecting(true);
    detectDocumentCorners(file)
      .then((res) => {
        setNat({ w: res.width, h: res.height });
        setCorners(res.corners);
        setAutoDetected(res.detected);
      })
      .catch(() => undefined)
      .finally(() => setDetecting(false));
  }, [file]);

  const selectWhole = useCallback(() => {
    if (nat) setCorners(insetCorners(nat.w, nat.h));
  }, [nat]);

  const doScan = useCallback(async () => {
    if (!corners) return;
    setProcessing(true);
    setError(null);
    try {
      const scanned = await scanDocument(file, corners, { style });
      onDone(scanned);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Scan failed');
      setProcessing(false);
    }
  }, [corners, file, style, onDone]);

  const handleR = nat ? Math.max(nat.w, nat.h) * 0.016 : 8;
  const strokeW = nat ? Math.max(nat.w, nat.h) * 0.004 : 2;
  const polyPoints = corners
    ? CORNER_ORDER.map((k) => `${corners[k].x},${corners[k].y}`).join(' ')
    : '';

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/70 p-4 backdrop-blur-sm">
      <div className="flex max-h-[92vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xl">
        <header className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
          <div>
            <h2 className="text-base font-semibold text-slate-950">Scan document</h2>
            <p className="text-xs text-slate-500">
              {detecting
                ? 'Detecting page edges…'
                : autoDetected
                  ? 'Drag the corners to fine-tune, then Scan.'
                  : 'Couldn’t auto-detect — drag the corners onto the page.'}
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg px-2 py-1 text-sm font-semibold text-slate-500 hover:bg-slate-100 hover:text-slate-950"
          >
            Cancel
          </button>
        </header>

        <div className="grid min-h-0 flex-1 place-items-center overflow-auto bg-slate-100 p-4">
          {url && nat ? (
            <div
              className="relative max-h-full max-w-full select-none"
              style={{ aspectRatio: `${nat.w} / ${nat.h}`, width: 'min(100%, 640px)' }}
            >
              <img
                src={url}
                alt="Document to scan"
                draggable={false}
                className="absolute inset-0 h-full w-full rounded-lg object-contain"
              />
              <svg
                ref={svgRef}
                viewBox={`0 0 ${nat.w} ${nat.h}`}
                preserveAspectRatio="none"
                className="absolute inset-0 h-full w-full touch-none"
              >
                {corners && (
                  <>
                    <polygon
                      points={polyPoints}
                      fill="rgba(37, 99, 235, 0.12)"
                      stroke="#2563eb"
                      strokeWidth={strokeW}
                    />
                    {CORNER_ORDER.map((k) => (
                      <circle
                        key={k}
                        cx={corners[k].x}
                        cy={corners[k].y}
                        r={handleR}
                        fill="#fff"
                        stroke="#2563eb"
                        strokeWidth={strokeW}
                        className="cursor-grab"
                        style={{ pointerEvents: 'all' }}
                        onPointerDown={(e) => {
                          e.preventDefault();
                          dragRef.current = k;
                        }}
                      />
                    ))}
                  </>
                )}
              </svg>
            </div>
          ) : (
            <div className="grid h-64 place-items-center text-sm text-slate-500">
              {error ? error : 'Loading image…'}
            </div>
          )}
        </div>

        <footer className="border-t border-slate-200 px-5 py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="inline-flex rounded-2xl bg-slate-100 p-0.5 text-sm font-semibold">
              <StyleTab label="Grayscale" active={style === 'grayscale'} onClick={() => setStyle('grayscale')} />
              <StyleTab label="B&amp;W" active={style === 'bw'} onClick={() => setStyle('bw')} />
              <StyleTab label="Color" active={style === 'color'} onClick={() => setStyle('color')} />
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={selectWhole}
                disabled={!nat || processing}
                className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                Whole image
              </button>
              <button
                type="button"
                onClick={reset}
                disabled={detecting || processing}
                className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                Re-detect
              </button>
              <button
                type="button"
                onClick={doScan}
                disabled={!corners || processing}
                className="inline-flex items-center gap-2 rounded-lg bg-slate-950 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
              >
                {processing ? 'Scanning…' : 'Scan'}
              </button>
            </div>
          </div>
          {error && !processing && <p className="mt-2 text-xs text-rose-600">{error}</p>}
        </footer>
      </div>
    </div>
  );
}

function StyleTab({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-2xl px-3 py-1.5 transition-colors ${
        active ? 'bg-white text-slate-950 shadow-sm' : 'text-slate-600 hover:bg-white/60'
      }`}
    >
      {label}
    </button>
  );
}
