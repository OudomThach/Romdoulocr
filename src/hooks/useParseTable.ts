import { useCallback, useRef } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { TableResult } from '@/types/api';

export interface ParseTableArgs {
  file: File;
  useCtc?: boolean;
  rowTolerance?: number;
}

export interface ParseTableOptions {
  onProgress?: (pct: number) => void;
}

export function useParseTable(opts: ParseTableOptions = {}) {
  const controllerRef = useRef<AbortController | null>(null);

  const mutation = useMutation<TableResult, Error, ParseTableArgs>({
    mutationFn: async (args) => {
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      return api.parseTable(args.file, args, {
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
