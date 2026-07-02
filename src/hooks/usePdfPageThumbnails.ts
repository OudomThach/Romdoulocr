import { useEffect, useState, useRef } from 'react';
import { renderPdfPagePreview, getPdfPageCount } from '@/lib/pdfProcessing';

interface PageThumb {
  pageNumber: number;
  url: string;
  loading: boolean;
  error: boolean;
}

export interface UsePdfPageThumbnailsResult {
  totalPages: number;
  thumbnails: PageThumb[];
  loading: boolean;
  error: string | null;
}

export function usePdfPageThumbnails(file: File | null, maxDim = 300): UsePdfPageThumbnailsResult {
  const [totalPages, setTotalPages] = useState(0);
  const [thumbnails, setThumbnails] = useState<PageThumb[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;
    setThumbnails([]);
    setTotalPages(0);
    setError(null);

    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.pdf')) return;

    setLoading(true);
    (async () => {
      try {
        const count = await getPdfPageCount(file);
        if (cancelledRef.current) return;
        setTotalPages(count);

        const initial: PageThumb[] = Array.from({ length: count }, (_, i) => ({
          pageNumber: i + 1,
          url: '',
          loading: true,
          error: false,
        }));
        setThumbnails(initial);

        for (let i = 0; i < count; i++) {
          if (cancelledRef.current) return;
          try {
            const url = await renderPdfPagePreview(file, i + 1, maxDim);
            if (cancelledRef.current) return;
            setThumbnails((prev) =>
              prev.map((t, idx) => (idx === i ? { ...t, url, loading: false } : t)),
            );
          } catch {
            if (cancelledRef.current) return;
            setThumbnails((prev) =>
              prev.map((t, idx) => (idx === i ? { ...t, loading: false, error: true } : t)),
            );
          }
        }
      } catch (e) {
        if (!cancelledRef.current) {
          setError(e instanceof Error ? e.message : 'Failed to load PDF');
        }
      } finally {
        if (!cancelledRef.current) setLoading(false);
      }
    })();

    return () => {
      cancelledRef.current = true;
    };
  }, [file, maxDim]);

  return { totalPages, thumbnails, loading, error };
}

export function pageRangeToString(pages: number[]): string {
  if (pages.length === 0) return '';
  const sorted = [...pages].sort((a, b) => a - b);
  const parts: string[] = [];
  let start = sorted[0];
  let prev = sorted[0];

  for (let i = 1; i <= sorted.length; i++) {
    const curr = sorted[i];
    if (curr === prev + 1) {
      prev = curr;
      continue;
    }
    if (start === prev) {
      parts.push(String(start));
    } else {
      parts.push(`${start}-${prev}`);
    }
    start = curr;
    prev = curr;
  }
  return parts.join(', ');
}

export function parsePageRangeFromString(input: string, totalPages: number): number[] {
  const trimmed = input.trim();
  if (!trimmed) return Array.from({ length: totalPages }, (_, i) => i + 1);

  const out = new Set<number>();
  const parts = trimmed.split(',').map((s) => s.trim()).filter(Boolean);
  for (const part of parts) {
    const m = /^(\d+)\s*-\s*(\d+)$/.exec(part);
    if (m) {
      const a = Math.max(1, Math.min(totalPages, parseInt(m[1], 10)));
      const b = Math.max(1, Math.min(totalPages, parseInt(m[2], 10)));
      const [lo, hi] = a <= b ? [a, b] : [b, a];
      for (let i = lo; i <= hi; i++) out.add(i);
    } else if (/^\d+$/.test(part)) {
      out.add(Math.max(1, Math.min(totalPages, parseInt(part, 10))));
    }
  }
  return [...out].sort((a, b) => a - b);
}
