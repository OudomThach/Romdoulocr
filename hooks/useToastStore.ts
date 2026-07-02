import { create } from 'zustand';

// Toast store: a tiny global queue of transient notifications. Components
// call `toast.push(...)` (or the helpers `toast.success` / `toast.error`)
// and the <Toaster /> mounted at the app root renders them.

export interface ToastItem {
  id: number;
  message: string;
  variant: 'success' | 'error' | 'info';
}

interface ToastState {
  items: ToastItem[];
  push: (message: string, variant?: ToastItem['variant']) => void;
  dismiss: (id: number) => void;
}

let nextId = 1;

export const useToastStore = create<ToastState>((set) => ({
  items: [],
  push: (message, variant = 'info') => {
    const id = nextId++;
    set((s) => ({ items: [...s.items, { id, message, variant }] }));
    // Auto-dismiss after 2.2s. We don't store the timer in state to avoid
    // re-renders; the Toaster's per-item effect handles cleanup.
    window.setTimeout(() => {
      set((s) => ({ items: s.items.filter((it) => it.id !== id) }));
    }, 2200);
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
