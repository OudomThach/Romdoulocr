import { useEffect, useState } from 'react';
import { renderPdfPagePreviews } from '@/lib/pdfProcessing';

/**
 * Generate and cache low-DPI page previews for a parsed PDF result.
 *
 * The PDF is parsed exactly once and every page is rendered from that one
 * document handle (see `renderPdfPagePreviews`). Previews fill in
 * progressively as each page finishes so the user sees pages appear
 * instead of waiting for the last one.
 *
 * Each preview is a PNG data URL — small, no cleanup needed. Previews are
 * independent of the high-DPI rasterization we send to the API; this is
 * purely for the side-panel display.
 */
export function usePagePreviews(
  file: File | null,
  pageNumbers: number[],
  maxDim = 480,
): { previews: Map<number, string>; loading: boolean; error: Error | null } {
  const [previews, setPreviews] = useState<Map<number, string>>(new Map());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  // Stable key for the current request so we don't re-generate if the
  // caller passes a referentially-new array with the same contents.
  const key = `${file?.name ?? ''}|${file?.size ?? 0}|${pageNumbers.join(',')}`;

  useEffect(() => {
    if (!file || pageNumbers.length === 0) {
      setPreviews(new Map());
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        await renderPdfPagePreviews(file, pageNumbers, maxDim, (pageNum, url) => {
          if (cancelled) return;
          // Progressive fill: emit a new Map each time so React re-renders.
          setPreviews((prev) => {
            const next = new Map(prev);
            next.set(pageNum, url);
            return next;
          });
        });
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e : new Error('Preview failed'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, file, maxDim]);

  return { previews, loading, error };
}
