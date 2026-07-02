import { useCallback, useRef } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { OcrImageResponse } from '@/types/api';

export interface OcrImageArgs {
  file: File;
}

export interface OcrImageOptions {
  onProgress?: (pct: number) => void;
}

export function useOcrImage(opts: OcrImageOptions = {}) {
  const controllerRef = useRef<AbortController | null>(null);

  const mutation = useMutation<OcrImageResponse, Error, OcrImageArgs>({
    mutationFn: async (args) => {
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      return api.ocrImage(args.file, {}, {
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
