import { useEffect, useRef } from 'react';
import { useHistory } from '@/hooks/useHistory';
import type { RunSettings, StoredRun, TabKind } from '@/lib/storage';

/**
 * Auto-save every successful batch item to the run history.
 *
 * We use a ref to track which item IDs we've already saved so:
 * - StrictMode double-effects don't double-save
 * - Effect re-runs (e.g. on settings change) don't re-save
 *
 * `prepared` is consulted at completion time, not enqueue time, so the
 * saved snapshot always references the *prepared* file (enhanced, page-
 * selected, etc.), not the original upload.
 */
export function useHistoryAutoSave<T extends { id: string; source: { name: string; size?: number } }>(
  tab: TabKind,
  batch: { items: { id: string; status: string; result?: unknown; args?: unknown }[] },
  prepared: T[],
  settings: RunSettings,
  /**
   * Optional: produce compact page thumbnails (keyed by result page_number) to
   * store with the run so History can show the page photo. Runs once per saved
   * item; failures degrade to a text-only run.
   */
  capturePreviews?: (
    item: { args?: unknown },
    prep: T,
  ) => Promise<Record<number, string> | undefined>,
) {
  const history = useHistory();
  const savedIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    for (const item of batch.items) {
      if (item.status !== 'done' || !item.result) continue;
      if (savedIdsRef.current.has(item.id)) continue;
      const fileKey = (item.args as { fileKey?: string } | undefined)?.fileKey;
      const prep = fileKey ? prepared.find((p) => p.id === fileKey) : undefined;
      if (!prep) continue;
      savedIdsRef.current.add(item.id); // reserve before any await to avoid double-save
      const result = item.result as StoredRun['result'];
      const filename =
        (typeof (result as { filename?: string }).filename === 'string'
          ? (result as { filename: string }).filename
          : undefined) || prep.source.name;

      const save = (pagePreviews?: Record<number, string>) =>
        history.addRun({ tab, filename, fileSize: prep.source.size, settings, result, pagePreviews });

      if (capturePreviews) {
        capturePreviews(item, prep)
          .then((pv) => save(pv))
          .catch(() => save(undefined));
      } else {
        save(undefined);
      }
    }
  }, [batch.items, prepared, settings, tab, history, capturePreviews]);
}
