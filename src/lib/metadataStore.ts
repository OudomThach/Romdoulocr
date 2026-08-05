import { create } from 'zustand';

// Holds recently created metadata records keyed by source filename, so every
// tab can show an inline "Metadata saved" panel for the result it displays —
// including multi-file batches where the last record is not the shown file.

export interface MetaSummary {
  id: string;
  type: string;
  status: string;
  model: string;
  filename: string;
  justCreated: boolean;
}

interface MetadataState {
  byFilename: Record<string, MetaSummary>;
  add: (s: MetaSummary) => void;
  get: (filename: string | null | undefined) => MetaSummary | null;
  patchSummary: (id: string, patch: Partial<Pick<MetaSummary, 'status'>>) => void;
  markOpened: (id: string) => void;
  clear: () => void;
  pendingRecordId: string | null;
  openRecord: (id: string) => void;
  consumePendingRecord: () => string | null;
}

const MAX_ENTRIES = 20;

export const useMetadataStore = create<MetadataState>((set, get) => ({
  byFilename: {},
  add: (s) =>
    set((state) => {
      const byFilename = { ...state.byFilename, [s.filename]: s };
      const keys = Object.keys(byFilename);
      if (keys.length > MAX_ENTRIES) {
        // Drop the oldest inserted key (insertion order is preserved for
        // string keys in JS objects).
        const oldest = keys[0];
        delete byFilename[oldest];
      }
      return { byFilename };
    }),
  get: (filename) => (filename ? get().byFilename[filename] ?? null : null),
  patchSummary: (id, patch) =>
    set((state) => {
      const entry = Object.values(state.byFilename).find((e) => e.id === id);
      if (!entry) return state;
      return { byFilename: { ...state.byFilename, [entry.filename]: { ...entry, ...patch } } };
    }),
  markOpened: (id) =>
    set((state) => {
      const entry = Object.values(state.byFilename).find((e) => e.id === id);
      if (!entry || !entry.justCreated) return state;
      return { byFilename: { ...state.byFilename, [entry.filename]: { ...entry, justCreated: false } } };
    }),
  clear: () => set({ byFilename: {} }),
  pendingRecordId: null,
  openRecord: (id) => set({ pendingRecordId: id }),
  consumePendingRecord: () => {
    const id = get().pendingRecordId;
    if (id) set({ pendingRecordId: null });
    return id;
  },
}));
