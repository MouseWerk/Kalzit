import { useSyncExternalStore } from "react";
import { getBrand, subscribeBrand } from "../appearance/brand";
import { readPreference, writePreference } from "../lib/storage";
import { getTimeSettings, subscribeTimeSettings, type WeekStart } from "../lib/timeSettings";
import { de, en } from "./catalogs";

export const LANGUAGES = ["de", "en"] as const;
export type Language = (typeof LANGUAGES)[number];

export type MessageKey = keyof typeof en;
export type MessageParams = Readonly<Record<string, string | number>>;

// Typed against the English keys, so a key missing in German fails the typecheck as well as the
// parity test.
export const catalogs: Record<Language, Record<MessageKey, string>> = { de, en };

export const LANGUAGE_STORAGE_KEY = "kalzit.language";
const FALLBACK_LANGUAGE: Language = "en";

function isLanguage(value: unknown): value is Language {
  return (LANGUAGES as readonly unknown[]).includes(value);
}

/** Picks the first supported language from the browser's preference list ("de-AT" counts as "de"). */
export function detectLanguage(preferred: readonly string[]): Language {
  for (const tag of preferred) {
    const base = tag.toLowerCase().split("-")[0];
    if (isLanguage(base)) {
      return base;
    }
  }
  return FALLBACK_LANGUAGE;
}

function initialLanguage(): Language {
  const stored = readPreference(LANGUAGE_STORAGE_KEY);
  if (isLanguage(stored)) {
    return stored;
  }
  return detectLanguage(
    navigator.languages.length > 0 ? navigator.languages : [navigator.language],
  );
}

let current: Language = initialLanguage();
// A language shown on top of the current one without being remembered (the setup's defaults).
let preview: Language | null = null;
const listeners = new Set<() => void>();

function applyToDocument(language: Language): void {
  document.documentElement.lang = language;
}

applyToDocument(current);

/** The language the page shows: a preview while one runs, else the current language. */
export function getLanguage(): Language {
  return preview ?? current;
}

/** The current language without a preview: the one the page returns to when the preview ends. */
export function getSavedLanguage(): Language {
  return current;
}

/** Runs a change and tells the listeners when the language or the shown one changed. */
function change(update: () => void): void {
  const shown = getLanguage();
  const saved = current;
  update();
  if (getLanguage() !== shown) {
    applyToDocument(getLanguage());
  }
  if (getLanguage() !== shown || current !== saved) {
    for (const listener of listeners) {
      listener();
    }
  }
}

/** Switches the UI language everywhere at once and remembers the choice; a preview ends. */
export function setLanguage(language: Language): void {
  writePreference(LANGUAGE_STORAGE_KEY, language);
  change(() => {
    current = language;
    preview = null;
  });
}

/**
 * Shows a language without remembering it, until `null` ends the preview and the current
 * language returns. A reload never keeps a preview.
 */
export function previewLanguage(language: Language | null): void {
  change(() => {
    preview = language;
  });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The current language without a preview, for the controls that change it for good. */
export function useSavedLanguage(): Language {
  return useSyncExternalStore(subscribe, getSavedLanguage, getSavedLanguage);
}

/** Looks up a message and fills `{name}` placeholders; unknown placeholders stay visible. */
export function translate(language: Language, key: MessageKey, params?: MessageParams): string {
  const message = catalogs[language][key];
  if (params === undefined) {
    return message;
  }
  return message.replace(/\{(\w+)\}/g, (placeholder, name: string) => {
    const value = params[name];
    return value === undefined ? placeholder : String(value);
  });
}

export type Translate = (key: MessageKey, params?: MessageParams) => string;

/**
 * The UI language with its translate function, and the user's time zone and first day of the
 * week: whatever formats or rounds times reads them here, so a change re-renders it.
 */
export function useI18n(): {
  language: Language;
  t: Translate;
  timeZone: string | null;
  weekStart: WeekStart | null;
} {
  const language = useSyncExternalStore(subscribe, getLanguage, getLanguage);
  const time = useSyncExternalStore(subscribeTimeSettings, getTimeSettings, getTimeSettings);
  const brand = useSyncExternalStore(subscribeBrand, getBrand, getBrand);
  // `{product}` is the product name an admin may set (window titles and the like).
  const t: Translate = (key, params) =>
    translate(language, key, { product: brand.productName, ...params });
  return { language, t, timeZone: time.timeZone, weekStart: time.weekStart };
}
