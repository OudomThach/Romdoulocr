import { create } from 'zustand';
import type { StoredRun, RunSettings, TabKind } from '@/lib/storage';

/**
 * Live settings store shared by all tabs. Lifting settings out of
 * individual tab components lets the History tab's "Re-use settings"
 * button apply a saved run's parameters to whichever tab is active,
 * without us having to thread props through.
 *
 * Why zustand? We could use React context but a tiny store is cleaner
 * for a small bag of state shared across many sibling components.
 */
interface SettingsState {
  activeTab: TabKind;
  setActiveTab: (t: TabKind) => void;

  /**
   * OCR recall knobs, shared across every tab. Both default ON for maximum
   * text extraction; toggle off to revert to the previous behavior.
   *   highRes     — 400 DPI / uncapped rasterization (vs 200 DPI / uncapped)
   *   fullPageOcr — extra detect_layout=false pass to catch missed margins
   */
  extraction: {
    highRes: boolean;
    fullPageOcr: boolean;
  };
  setExtraction: (patch: Partial<SettingsState['extraction']>) => void;

  document: {
    detectLayout: boolean;
    detectLines: boolean;
    useCtc: boolean;
    concurrency: number;
  };
  translated: {
    sourceLang: string;
    targetLang: string;
    detectLayout: boolean;
    detectLines: boolean;
    useCtc: boolean;
    concurrency: number;
  };
  ocr: {
    useCtc: boolean;
    concurrency: number;
  };
  table: {
    useCtc: boolean;
    rowTolerance: number;
    concurrency: number;
  };

  setDocument: (patch: Partial<SettingsState['document']>) => void;
  setTranslated: (patch: Partial<SettingsState['translated']>) => void;
  setOcr: (patch: Partial<SettingsState['ocr']>) => void;
  setTable: (patch: Partial<SettingsState['table']>) => void;

  /** Apply the saved settings of a history run, and switch to its tab. */
  applyFromRun: (run: StoredRun) => void;
}

const initialDocument = {
  detectLayout: true,
  detectLines: true,
  useCtc: true,
  concurrency: 2,
};
const initialTranslated = {
  sourceLang: 'km',
  targetLang: 'en',
  detectLayout: true,
  detectLines: true,
  useCtc: true,
  concurrency: 2,
};
const initialOcr = { useCtc: true, concurrency: 2 };
const initialTable = { useCtc: true, rowTolerance: 20, concurrency: 2 };

export const useSettingsStore = create<SettingsState>((set) => ({
  activeTab: 'document',
  setActiveTab: (t) => set({ activeTab: t }),

  extraction: { highRes: true, fullPageOcr: true },
  setExtraction: (patch) => set((s) => ({ extraction: { ...s.extraction, ...patch } })),

  document: { ...initialDocument },
  translated: { ...initialTranslated },
  ocr: { ...initialOcr },
  table: { ...initialTable },

  setDocument: (patch) =>
    set((s) => ({ document: { ...s.document, ...patch } })),
  setTranslated: (patch) =>
    set((s) => ({ translated: { ...s.translated, ...patch } })),
  setOcr: (patch) => set((s) => ({ ocr: { ...s.ocr, ...patch } })),
  setTable: (patch) => set((s) => ({ table: { ...s.table, ...patch } })),

  applyFromRun: (run) => {
    const s = run.settings as RunSettings;
    set((cur) => {
      const next = { ...cur };
      if (run.tab === 'document') {
        next.document = {
          detectLayout: s.detectLayout ?? cur.document.detectLayout,
          detectLines: s.detectLines ?? cur.document.detectLines,
          useCtc: true,
          concurrency: s.concurrency ?? cur.document.concurrency,
        };
      } else if (run.tab === 'translated') {
        next.translated = {
          sourceLang: s.sourceLang ?? cur.translated.sourceLang,
          targetLang: s.targetLang ?? cur.translated.targetLang,
          detectLayout: s.detectLayout ?? cur.translated.detectLayout,
          detectLines: s.detectLines ?? cur.translated.detectLines,
          useCtc: s.useCtc ?? cur.translated.useCtc,
          concurrency: s.concurrency ?? cur.translated.concurrency,
        };
      } else if (run.tab === 'ocr') {
        next.ocr = {
          useCtc: s.useCtc ?? cur.ocr.useCtc,
          concurrency: s.concurrency ?? cur.ocr.concurrency,
        };
      } else if (run.tab === 'table') {
        next.table = {
          useCtc: true,
          rowTolerance: s.rowTolerance ?? cur.table.rowTolerance,
          concurrency: s.concurrency ?? cur.table.concurrency,
        };
      }
      next.activeTab = run.tab;
      return next;
    });
  },
}));

// Selector helper for the per-tab "Re-use settings" button.
export function useActiveTab() {
  return useSettingsStore((s) => s.activeTab);
}
