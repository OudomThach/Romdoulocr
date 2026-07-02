import { useCallback, useEffect, useState } from 'react';
import {
  addRun as storageAdd,
  clearRuns as storageClear,
  deleteRun as storageDelete,
  exportRuns as storageExport,
  importRuns as storageImport,
  listRuns as storageList,
  storageInfo,
  updateRun as storageUpdate,
  type StoredRun,
  type TabKind,
  type RunSettings,
} from '@/lib/storage';

/**
 * React-side view over the localStorage-backed run history.
 *
 * - `runs` is a sorted list (newest first) re-read from storage on every
 *   mutation. We deliberately don't try to maintain an in-memory cache; the
 *   storage layer is fast enough (a single JSON read/write) and it makes
 *   cross-tab changes "just work".
 * - Every mutator returns the updated list so callers can show feedback
 *   without a second read.
 */
export function useHistory() {
  const [runs, setRuns] = useState<StoredRun[]>(() => storageList());
  const [info, setInfo] = useState(() => storageInfo());

  const refresh = useCallback(() => {
    setRuns(storageList());
    setInfo(storageInfo());
  }, []);

  const addRun = useCallback(
    (args: {
      tab: TabKind;
      filename: string;
      fileSize?: number;
      settings: RunSettings;
      result: StoredRun['result'];
      pagePreviews?: Record<number, string>;
    }) => {
      const run: StoredRun = {
        id: `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        timestamp: Date.now(),
        tab: args.tab,
        filename: args.filename,
        fileSize: args.fileSize,
        settings: args.settings,
        result: args.result,
        pagePreviews: args.pagePreviews,
        notes: '',
        tags: [],
        favorite: false,
      };
      storageAdd(run);
      refresh();
      return run;
    },
    [refresh],
  );

  const updateRun = useCallback(
    (id: string, patch: Partial<StoredRun>) => {
      storageUpdate(id, patch);
      refresh();
    },
    [refresh],
  );

  const deleteRun = useCallback(
    (id: string) => {
      storageDelete(id);
      refresh();
    },
    [refresh],
  );

  const clearAll = useCallback(() => {
    storageClear();
    refresh();
  }, [refresh]);

  const exportJson = useCallback(() => storageExport(), []);

  const importJson = useCallback(
    (json: string, mode: 'merge' | 'replace' = 'merge') => {
      const r = storageImport(json, mode);
      refresh();
      return r;
    },
    [refresh],
  );

  // Re-read on mount in case another tab wrote to storage.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'khmer-parser-runs.v1') refresh();
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [refresh]);

  return { runs, info, addRun, updateRun, deleteRun, clearAll, exportJson, importJson };
}
