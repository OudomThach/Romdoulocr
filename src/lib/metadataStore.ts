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
}

interface MetadataState {
  byFilename: Record<string, MetaSummary>;
  add: (s: MetaSummary) => void;
  get: (filename: string | null | undefined) => MetaSummary | null;
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
  clear: () => set({ byFilename: {} }),
  pendingRecordId: null,
  openRecord: (id) => set({ pendingRecordId: id }),
  consumePendingRecord: () => {
    const id = get().pendingRecordId;
    if (id) set({ pendingRecordId: null });
    return id;
  },
}));
