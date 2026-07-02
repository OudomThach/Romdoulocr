import { useCallback, useEffect, useRef, useState } from 'react';
import { getPdfPageCount, renderPdfPagePreviews } from '@/lib/pdfProcessing';
import { isPdf } from '@/lib/utils';

export interface PdfPageSelectionState {
  pageSelections: Record<string, number[]>;
  pageThumbnails: Record<string, string[]>;
  thumbLoading: Set<string>;
  onPageSelectionChange: (fileKey: string, pages: number[]) => void;
}

export function usePdfPageSelection(
  files: File[],
  fileKey: (file: File) => string,
  previewMaxDim = 280,
): PdfPageSelectionState {
  const [pageSelections, setPageSelections] = useState<Record<string, number[]>>({});
  const [pageThumbnails, setPageThumbnails] = useState<Record<string, string[]>>({});
  const [thumbLoading, setThumbLoading] = useState<Set<string>>(new Set());

  // Ref-based guard: tracks files we've already kicked off rendering for, so
  // the effect doesn't re-process them. Using a ref (not state) is critical —
  // if this were in the dependency array, every thumbnail update would re-run
  // the effect, fire the cleanup (cancelled = true), and kill the in-flight
  // render after the first page. That was the bug: only page 1 ever showed.
  const processingRef = useRef<Set<string>>(new Set());
  // Keep a ref mirror of pageThumbnails so the guard inside the effect sees
  // the latest data without being in the dependency array.
  const thumbnailsRef = useRef<Record<string, string[]>>({});
  thumbnailsRef.current = pageThumbnails;

  const onPageSelectionChange = useCallback((key: string, pages: number[]) => {
    setPageSelections((prev) => ({ ...prev, [key]: [...pages].sort((a, b) => a - b) }));
  }, []);

  useEffect(() => {
    let cancelled = false;
    const pdfFiles = files.filter((file) => isPdf(file.name));
    const activePdfKeys = new Set(pdfFiles.map(fileKey));

    // Prune stale entries for files that were removed.
    setPageSelections((prev) => pruneRecord(prev, activePdfKeys));
    setPageThumbnails((prev) => pruneRecord(prev, activePdfKeys));
    setThumbLoading((prev) => pruneSet(prev, activePdfKeys));
    processingRef.current = new Set([...processingRef.current].filter((k) => activePdfKeys.has(k)));

    // Track the keys we start processing in THIS effect run so the cleanup
    // can release them. Without this, React.StrictMode's mount→unmount→mount
    // cycle (dev) would leave the keys in processingRef from the first
    // (cancelled) run, and the second mount would skip them forever — no
    // thumbnails would ever render.
    const startedThisRun = new Set<string>();

    for (const file of pdfFiles) {
      const key = fileKey(file);
      // Skip if already rendering.
      if (processingRef.current.has(key)) continue;
      // Skip only if at least one thumbnail URL is actually filled. Checking
      // just `.length` would skip files whose array is all empty strings
      // (e.g. a previous render was cancelled), which would prevent retries.
      const existing = thumbnailsRef.current[key];
      if (existing && existing.some((u) => u.length > 0)) continue;
      processingRef.current.add(key);
      startedThisRun.add(key);

      setThumbLoading((prev) => {
        if (prev.has(key)) return prev;
        const next = new Set(prev);
        next.add(key);
        return next;
      });

      void (async () => {
        try {
          const totalPages = await getPdfPageCount(file);
          if (cancelled) return;
          const allPages = Array.from({ length: totalPages }, (_, i) => i + 1);

          setPageSelections((prev) => {
            const prior = prev[key]?.filter((page) => page >= 1 && page <= totalPages) ?? [];
            return { ...prev, [key]: prior.length > 0 ? prior : allPages };
          });
          setPageThumbnails((prev) => {
            if (prev[key]?.length === totalPages) return prev;
            return { ...prev, [key]: new Array(totalPages).fill('') };
          });

          // Render every page in a single pass: the PDF is parsed exactly
          // once and the document handle is reused for all pages. Each page
          // is emitted via onPage as soon as it's drawn so the grid fills in
          // progressively.
          await renderPdfPagePreviews(file, allPages, previewMaxDim, (pageNum, url) => {
            if (cancelled) return;
            setPageThumbnails((prev) => {
              const existingArr = [...(prev[key] ?? new Array(totalPages).fill(''))];
              const index = pageNum - 1;
              if (existingArr[index] !== url) {
                existingArr[index] = url;
                return { ...prev, [key]: existingArr };
              }
              return prev;
            });
          });
        } catch (error) {
          console.error('Failed to generate PDF thumbnails:', error);
        } finally {
          // Only clean up our ownership flags if this run is still the
          // active one. If we were cancelled (StrictMode remount in dev, or
          // the file set changed), a newer effect run may have already
          // re-added this key to processingRef/thumbLoading — clearing them
          // here would break that newer run.
          if (!cancelled) {
            processingRef.current.delete(key);
            setThumbLoading((prev) => {
              if (!prev.has(key)) return prev;
              const next = new Set(prev);
              next.delete(key);
              return next;
            });
          }
        }
      })();
    }

    return () => {
      cancelled = true;
      // Release the keys this run started so a remount (StrictMode in dev,
      // or the file set changing) can reprocess them. The in-flight async
      // will bail out via the `cancelled` flag above.
      for (const k of startedThisRun) {
        processingRef.current.delete(k);
      }
    };
    // Intentionally NOT depending on pageThumbnails/thumbLoading — those are
    // set BY this effect, so including them creates a feedback loop that
    // cancels the render after the first page. The ref guards prevent
    // re-processing without re-triggering the effect.
  }, [fileKey, files, previewMaxDim]);

  return { pageSelections, pageThumbnails, thumbLoading, onPageSelectionChange };
}

function pruneRecord<T>(record: Record<string, T>, activeKeys: Set<string>): Record<string, T> {
  let changed = false;
  const next: Record<string, T> = {};
  for (const key of activeKeys) {
    if (key in record) next[key] = record[key];
  }
  if (Object.keys(record).length !== Object.keys(next).length) changed = true;
  return changed ? next : record;
}

function pruneSet(set: Set<string>, activeKeys: Set<string>): Set<string> {
  let changed = false;
  const next = new Set<string>();
  for (const key of set) {
    if (activeKeys.has(key)) {
      next.add(key);
    } else {
      changed = true;
    }
  }
  return changed ? next : set;
}
