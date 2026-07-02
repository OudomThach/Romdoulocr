import { useEffect, useSyncExternalStore } from 'react';

// Simple theme store without a dependency. We avoid zustand here so the
// toast/sound stores stay independent and this stays ~zero-cost. A tiny
// external store with useSyncExternalStore gives us SSR-safe subscription.

type Theme = 'light' | 'dark';
const STORAGE_KEY = 'khmer-parser-theme';

let currentTheme: Theme = readInitial();
const listeners = new Set<() => void>();

function readInitial(): Theme {
  if (typeof window === 'undefined') return 'light';
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    // localStorage may be blocked; fall through to default.
  }
  return 'light';
}

function applyTheme(theme: Theme) {
  currentTheme = theme;
  if (typeof document !== 'undefined') {
    const root = document.documentElement;
    if (theme === 'dark') root.classList.add('dark');
    else root.classList.remove('dark');
  }
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // ignore quota / disabled storage
  }
  listeners.forEach((l) => l());
}

// Apply on module load so the very first paint is correct (no flash).
if (typeof document !== 'undefined') {
  applyTheme(currentTheme);
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
function getSnapshot(): Theme {
  return currentTheme;
}

export function useTheme(): {
  theme: Theme;
  toggle: () => void;
  setTheme: (t: Theme) => void;
} {
  const theme = useSyncExternalStore(subscribe, getSnapshot, () => 'light' as Theme);
  // Re-apply on mount in case the class was stripped by HMR / hard reload.
  useEffect(() => {
    applyTheme(currentTheme);
  }, []);
  return {
    theme,
    toggle: () => applyTheme(currentTheme === 'dark' ? 'light' : 'dark'),
    setTheme: (t) => applyTheme(t),
  };
}
