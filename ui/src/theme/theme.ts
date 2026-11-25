import { useSyncExternalStore } from "react";
import { readPreference, writePreference } from "../lib/storage";

/**
 * The mode of the theme. "system" follows the operating system's light or dark setting through
 * CSS alone, between the chosen light and the chosen dark variant.
 */
export const THEMES = ["system", "light", "dark", "contrast"] as const;
export type Theme = (typeof THEMES)[number];

/**
 * The variants of each side (board Themes): one light and one dark variant are always kept, the
 * mode says which applies. High contrast has no variants. Light and Dark are the defaults.
 */
export const LIGHT_VARIANTS = ["light", "paper", "calcite"] as const;
export type LightVariant = (typeof LIGHT_VARIANTS)[number];
export const DARK_VARIANTS = ["dark", "graphite", "night"] as const;
export type DarkVariant = (typeof DARK_VARIANTS)[number];

// public/theme-boot.js reads the same keys before the first paint; a test keeps both in sync.
export const THEME_STORAGE_KEY = "kalzit.theme";
export const LIGHT_VARIANT_STORAGE_KEY = "kalzit.themeLight";
export const DARK_VARIANT_STORAGE_KEY = "kalzit.themeDark";

export function isTheme(value: unknown): value is Theme {
  return (THEMES as readonly unknown[]).includes(value);
}

export function isLightVariant(value: unknown): value is LightVariant {
  return (LIGHT_VARIANTS as readonly unknown[]).includes(value);
}

export function isDarkVariant(value: unknown): value is DarkVariant {
  return (DARK_VARIANTS as readonly unknown[]).includes(value);
}

function readStored<T extends string>(
  key: string,
  is: (value: unknown) => value is T,
  fallback: T,
): T {
  const stored = readPreference(key);
  return is(stored) ? stored : fallback;
}

let current: Theme = readStored(THEME_STORAGE_KEY, isTheme, "system");
let lightVariant: LightVariant = readStored(LIGHT_VARIANT_STORAGE_KEY, isLightVariant, "light");
let darkVariant: DarkVariant = readStored(DARK_VARIANT_STORAGE_KEY, isDarkVariant, "dark");
// A theme shown on top of the current one without being remembered (the setup's defaults).
let preview: Theme | null = null;
const listeners = new Set<() => void>();

function applyToDocument(): void {
  const root = document.documentElement;
  root.dataset.theme = preview ?? current;
  root.dataset.light = lightVariant;
  root.dataset.dark = darkVariant;
}

applyToDocument();

/** The theme the page shows: a preview while one runs, else the current theme. */
export function getTheme(): Theme {
  return preview ?? current;
}

/** The current theme without a preview: the one the page returns to when the preview ends. */
export function getSavedTheme(): Theme {
  return current;
}

/** The light variant, which applies in the light mode and in "system" on a light device. */
export function getLightVariant(): LightVariant {
  return lightVariant;
}

/** The dark variant, which applies in the dark mode and in "system" on a dark device. */
export function getDarkVariant(): DarkVariant {
  return darkVariant;
}

/** Runs a change and tells the listeners when the theme, a variant or the shown one changed. */
function change(update: () => void): void {
  const before = [getTheme(), current, lightVariant, darkVariant].join();
  update();
  if ([getTheme(), current, lightVariant, darkVariant].join() !== before) {
    applyToDocument();
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

/** Chooses the light variant and remembers it. */
export function setLightVariant(variant: LightVariant): void {
  writePreference(LIGHT_VARIANT_STORAGE_KEY, variant);
  change(() => {
    lightVariant = variant;
  });
}

/** Chooses the dark variant and remembers it. */
export function setDarkVariant(variant: DarkVariant): void {
  writePreference(DARK_VARIANT_STORAGE_KEY, variant);
  change(() => {
    darkVariant = variant;
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
 * The server's default theme and variants on the pages before sign-in. The mode applies only for a
 * visitor who never chose one in this browser. The variants always apply there: they are chosen
 * only in the account settings (board Themes, frame 7), and a variant an account stored in this
 * browser stays stored for its next visit. Nothing is remembered, so a later default reaches the
 * visitor too.
 */
export function applyDefaultTheme(theme: unknown, light?: unknown, dark?: unknown): void {
  change(() => {
    if (isTheme(theme) && readPreference(THEME_STORAGE_KEY) === null) {
      current = theme;
    }
    if (isLightVariant(light)) {
      lightVariant = light;
    }
    if (isDarkVariant(dark)) {
      darkVariant = dark;
    }
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

export function useLightVariant(): LightVariant {
  return useSyncExternalStore(subscribe, getLightVariant, getLightVariant);
}

export function useDarkVariant(): DarkVariant {
  return useSyncExternalStore(subscribe, getDarkVariant, getDarkVariant);
}
