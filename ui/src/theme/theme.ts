import { useSyncExternalStore } from "react";
import { withoutBase } from "../lib/basePath";
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
// The server's default variants as last seen on a page before sign-in: a cache for the first
// paint there, not a preference, never adopted by an account.
export const DEFAULT_LIGHT_CACHE_KEY = "kalzit.defaultThemeLight";
export const DEFAULT_DARK_CACHE_KEY = "kalzit.defaultThemeDark";

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

/**
 * The pages before sign-in (sign in, setup, the pages behind mailed links), as the routes in
 * app/baseRoutes.tsx name them; each also covers the paths below it. They show the server's
 * default variants, never one an account stored. public/theme-boot.js keeps the same list.
 */
export const PRE_SIGN_IN_PATHS = [
  "/login",
  "/anmelden",
  "/setup",
  "/invite",
  "/reset-password",
  "/register",
  "/confirm-email",
] as const;

/** Whether a path of the app (without the server's sub-path) is a page before sign-in. */
export function isPreSignInPath(path: string): boolean {
  return PRE_SIGN_IN_PATHS.some((page) => path === page || path.startsWith(`${page}/`));
}

function onPreSignInPage(): boolean {
  return typeof window !== "undefined" && isPreSignInPath(withoutBase(window.location.pathname));
}

let current: Theme = readStored(THEME_STORAGE_KEY, isTheme, "system");
// Before sign-in the server's default variants as last seen, so no account's variant flashes.
let lightVariant: LightVariant = onPreSignInPage()
  ? readStored(DEFAULT_LIGHT_CACHE_KEY, isLightVariant, "light")
  : readStored(LIGHT_VARIANT_STORAGE_KEY, isLightVariant, "light");
let darkVariant: DarkVariant = onPreSignInPage()
  ? readStored(DEFAULT_DARK_CACHE_KEY, isDarkVariant, "dark")
  : readStored(DARK_VARIANT_STORAGE_KEY, isDarkVariant, "dark");
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
 * The server's default theme and variants, from the pages around sign-in (and help). The mode
 * applies only for a visitor who never chose one in this browser, and so do the variants on other
 * pages (help, for someone signed in). On the pages before sign-in (`PRE_SIGN_IN_PATHS`) the
 * variants apply over a variant an account stored: they are chosen only in
 * the account settings (board Themes, frame 7), and the account's variant stays stored for its
 * next visit. No preference is written, so a later default reaches the visitor too; the default
 * variants only go to their cache keys, for the first paint of the next page before sign-in.
 */
export function applyDefaultTheme(theme: unknown, light?: unknown, dark?: unknown): void {
  if (isLightVariant(light)) {
    writePreference(DEFAULT_LIGHT_CACHE_KEY, light);
  }
  if (isDarkVariant(dark)) {
    writePreference(DEFAULT_DARK_CACHE_KEY, dark);
  }
  const preSignIn = onPreSignInPage();
  change(() => {
    if (isTheme(theme) && readPreference(THEME_STORAGE_KEY) === null) {
      current = theme;
    }
    if (
      isLightVariant(light) &&
      (preSignIn || readPreference(LIGHT_VARIANT_STORAGE_KEY) === null)
    ) {
      lightVariant = light;
    }
    if (isDarkVariant(dark) && (preSignIn || readPreference(DARK_VARIANT_STORAGE_KEY) === null)) {
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
