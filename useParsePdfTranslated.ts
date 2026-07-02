import { useCallback, useRef } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { DocumentResult } from '@/types/api';

export interface ParsePdfTranslatedArgs {
  files: File[];
  sourceLang?: string;
  targetLang?: string;
  detectLayout?: boolean;
  detectLines?: boolean;
  useCtc?: boolean;
}

export interface ParsePdfTranslatedOptions {
  onProgress?: (pct: number) => void;
}

export function useParsePdfTranslated(opts: ParsePdfTranslatedOptions = {}) {
  const controllerRef = useRef<AbortController | null>(null);

  const mutation = useMutation<DocumentResult, Error, ParsePdfTranslatedArgs>({
    mutationFn: async (args) => {
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      return api.parsePdfTranslated(args.files, args, {
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
