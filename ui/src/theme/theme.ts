import { useSyncExternalStore } from "react";
import { readPreference, writePreference } from "../lib/storage";

/** "system" follows the operating system's light or dark setting through CSS alone. */
export const THEMES = ["system", "light", "dark", "contrast"] as const;
export type Theme = (typeof THEMES)[number];

// public/theme-boot.js reads the same key before the first paint; a test keeps both in sync.
export const THEME_STORAGE_KEY = "kalzit.theme";

function isTheme(value: unknown): value is Theme {
  return (THEMES as readonly unknown[]).includes(value);
}

/** The theme stored in this browser, or null when it holds no choice. */
export function storedTheme(): Theme | null {
  const stored = readPreference(THEME_STORAGE_KEY);
  return isTheme(stored) ? stored : null;
}

function readStoredTheme(): Theme {
  const stored = readPreference(THEME_STORAGE_KEY);
  return isTheme(stored) ? stored : "system";
}

let current: Theme = readStoredTheme();
const listeners = new Set<() => void>();

function applyToDocument(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}

applyToDocument(current);

export function getTheme(): Theme {
  return current;
}

export function setTheme(theme: Theme): void {
  writePreference(THEME_STORAGE_KEY, theme);
  if (theme === current) {
    return;
  }
  current = theme;
  applyToDocument(theme);
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, getTheme, getTheme);
}
