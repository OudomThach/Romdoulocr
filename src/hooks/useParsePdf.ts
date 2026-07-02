import { useCallback, useRef } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { DocumentResult } from '@/types/api';

export interface ParsePdfArgs {
  files: File[];
  detectLayout?: boolean;
  detectLines?: boolean;
  useCtc?: boolean;
}

export interface ParsePdfOptions {
  onProgress?: (pct: number) => void;
}

/**
 * Mutation that owns its own AbortController so the UI can cancel an
 * in-flight upload/parse with one call.
 */
export function useParsePdf(opts: ParsePdfOptions = {}) {
  const controllerRef = useRef<AbortController | null>(null);

  const mutation = useMutation<DocumentResult, Error, ParsePdfArgs>({
    mutationFn: async (args) => {
      // Always start a fresh controller — a previous run's controller, if any,
      // is already settled (either completed or aborted).
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      return api.parsePdf(args.files, args, {
        onProgress: opts.onProgress,
        signal: controller.signal,
      });
    },
  });

  const cancel = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
  }, []);

  return { ...mutation, cancel };
}
