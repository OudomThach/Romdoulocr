import { create } from 'zustand';

// Toast store: a tiny global queue of transient notifications. Components
// call `toast.push(...)` (or the helpers `toast.success` / `toast.error`)
// and the <Toaster /> mounted at the app root renders them.

export interface ToastAction {
  label: string;
  run: () => void;
}

export interface ToastItem {
  id: number;
  message: string;
  variant: 'success' | 'error' | 'info';
  /** Optional action button (e.g. "Undo"); the toast stays longer when set. */
  action?: ToastAction;
}

interface ToastState {
  items: ToastItem[];
  push: (message: string, variant?: ToastItem['variant'], action?: ToastAction) => void;
  dismiss: (id: number) => void;
}

let nextId = 1;

export const useToastStore = create<ToastState>((set) => ({
  items: [],
  push: (message, variant = 'info', action) => {
    const id = nextId++;
    set((s) => ({ items: [...s.items, { id, message, variant, action }] }));
    // With an action (undo) give the user time to click it; otherwise dismiss fast.
    const delay = action ? 6000 : 2200;
    window.setTimeout(() => {
      set((s) => ({ items: s.items.filter((it) => it.id !== id) }));
    }, delay);
  },
  dismiss: (id) => set((s) => ({ items: s.items.filter((it) => it.id !== id) })),
}));

// Convenience helpers — import these instead of the store when you just
// want to fire a toast from non-component code (e.g. utils.ts).
export const toast = {
  success: (msg: string) => useToastStore.getState().push(msg, 'success'),
  error: (msg: string) => useToastStore.getState().push(msg, 'error'),
  info: (msg: string) => useToastStore.getState().push(msg, 'info'),
};
