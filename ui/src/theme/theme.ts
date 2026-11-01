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

function readStoredTheme(): Theme {
  const stored = readPreference(THEME_STORAGE_KEY);
  return isTheme(stored) ? stored : "system";
}

let current: Theme = readStoredTheme();
// A theme shown on top of the current one without being remembered (the setup's defaults).
let preview: Theme | null = null;
const listeners = new Set<() => void>();

function applyToDocument(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}

applyToDocument(current);

/** The theme the page shows: a preview while one runs, else the current theme. */
export function getTheme(): Theme {
  return preview ?? current;
}

/** The current theme without a preview: the one the page returns to when the preview ends. */
export function getSavedTheme(): Theme {
  return current;
}

/** Runs a change and tells the listeners when the theme or the shown one changed. */
function change(update: () => void): void {
  const shown = getTheme();
  const saved = current;
  update();
  if (getTheme() !== shown) {
    applyToDocument(getTheme());
  }
  if (getTheme() !== shown || current !== saved) {
    for (const listener of listeners) {
      listener();
    }
  }
}

/** Switches the theme and remembers it; a running preview ends. */
export function setTheme(theme: Theme): void {
  writePreference(THEME_STORAGE_KEY, theme);
  change(() => {
    current = theme;
    preview = null;
  });
}

/**
 * Shows a theme without remembering it, until `null` ends the preview and the current theme
 * returns. A reload never keeps a preview.
 */
export function previewTheme(theme: Theme | null): void {
  change(() => {
    preview = theme;
  });
}

/**
 * The server's default theme for a visitor who never chose one in this browser (the sign-in
 * page). It applies without being remembered, so a later default reaches them too.
 */
export function applyDefaultTheme(theme: unknown): void {
  if (!isTheme(theme) || readPreference(THEME_STORAGE_KEY) !== null) {
    return;
  }
  change(() => {
    current = theme;
  });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The theme the page shows, preview included. */
export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, getTheme, getTheme);
}

/** The current theme without a preview, for the controls that change it for good. */
export function useSavedTheme(): Theme {
  return useSyncExternalStore(subscribe, getSavedTheme, getSavedTheme);
}
