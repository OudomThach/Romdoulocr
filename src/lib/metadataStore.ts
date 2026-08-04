import { create } from 'zustand';

// Holds the most recent metadata record created by an extraction, so tabs can
// show an inline "Metadata saved" panel right where the results render.

export interface MetaSummary {
  id: string;
  type: string;
  status: string;
  model: string;
  filename: string;
}

interface MetadataState {
  last: MetaSummary | null;
  setLast: (s: MetaSummary | null) => void;
}

export const useMetadataStore = create<MetadataState>((set) => ({
  last: null,
  setLast: (s) => set({ last: s }),
}));
