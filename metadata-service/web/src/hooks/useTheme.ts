import { useSyncExternalStore } from "react";

type Theme = "light" | "dark";
const STORAGE_KEY = "khmer-parser-theme"; // shared with the Romdoul OCR app

let currentTheme: Theme = readInitial();
const listeners = new Set<() => void>();

function readInitial(): Theme {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    /* storage blocked */
  }
  return "light";
}

function applyTheme(theme: Theme) {
  currentTheme = theme;
  if (typeof document !== "undefined") {
    const root = document.documentElement;
    if (theme === "dark") root.classList.add("dark");
    else root.classList.remove("dark");
  }
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    /* ignore */
  }
  listeners.forEach((l) => l());
}

if (typeof document !== "undefined") {
  applyTheme(readInitial());
}

export function useTheme(): { theme: Theme; toggle: () => void } {
  useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => currentTheme,
    () => currentTheme,
  );
  return {
    theme: currentTheme,
    toggle: () => applyTheme(currentTheme === "light" ? "dark" : "light"),
  };
}
