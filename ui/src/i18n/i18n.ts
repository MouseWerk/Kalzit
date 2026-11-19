import { useSyncExternalStore } from "react";
import { getBrand, subscribeBrand } from "../appearance/brand";
import { readPreference, writePreference } from "../lib/storage";
import { getTimeSettings, subscribeTimeSettings, type WeekStart } from "../lib/timeSettings";
import { showErrorToast } from "../lib/toasts";
import { AREA_LOADERS, type DeferredArea, type DeferredMessages } from "./deferred";
import type { en } from "./en";

export const LANGUAGES = ["de", "en"] as const;
export type Language = (typeof LANGUAGES)[number];

export type MessageKey = keyof typeof en | keyof DeferredMessages;
export type MessageParams = Readonly<Record<string, string | number>>;
/** A language's texts: all of the language chunk, and the deferred areas loaded so far. */
export type Catalog = Record<keyof typeof en, string> &
  Partial<Record<keyof DeferredMessages, string>>;

// Each language is a chunk of its own, loaded when it is first shown: the page fetches only the
// language it starts in (main.tsx waits for it before the first render), and the other one when
// someone switches. Typed against the English keys, so a key missing in German fails the
// typecheck as well as the parity test.
const LOADERS: Record<Language, () => Promise<Catalog>> = {
  de: () => import("./de").then((module): Catalog => module.de),
  en: () => import("./en").then((module): Catalog => module.en),
};

/** The catalogs loaded so far; the shown language's is always among them once the page runs. */
export const catalogs: Partial<Record<Language, Catalog>> = {};
const loading = new Map<Language, Promise<Catalog>>();
// The loaded catalogs as one value that changes whenever one arrives, for what reads several
// languages at once and must render again then.
let loadedCatalogs: Readonly<Partial<Record<Language, Catalog>>> = {};

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

/**
 * Loads a language's catalog (once; later calls share the first). The listeners hear of it, so
 * whatever reads both languages (the settings search) picks up the one that arrived.
 */
export function loadLanguage(language: Language): Promise<Catalog> {
  const loaded = catalogs[language];
  if (loaded !== undefined) {
    return Promise.resolve(loaded);
  }
  let pending = loading.get(language);
  if (pending === undefined) {
    pending = LOADERS[language]()
      .then(async (start) => {
        // The areas pages asked for come with the language, so a switch shows them at once:
        // those registered by now, and those that register while these are on their way. An
        // area that fails does not hold the language back; `loadArea` reports it to who asked.
        const tried = new Set<DeferredArea>();
        for (;;) {
          const next = [...areas].filter((area) => !tried.has(area));
          if (next.length === 0) break;
          for (const area of next) tried.add(area);
          await Promise.allSettled(next.map((area) => fetchArea(area, language)));
        }
        const parts = [...areas].map((area) => areaTexts.get(areaKey(area, language)) ?? {});
        const catalog: Catalog = Object.assign({}, start, ...parts);
        loading.delete(language);
        publish(language, catalog);
        return catalog;
      })
      .catch((error: unknown) => {
        // A failed fetch (a deploy replaced the chunk, the network dropped) may be tried again.
        loading.delete(language);
        throw error;
      });
    loading.set(language, pending);
  }
  return pending;
}

/** Puts a catalog in place and tells whoever reads the catalogs. */
function publish(language: Language, catalog: Catalog): void {
  catalogs[language] = catalog;
  loadedCatalogs = { ...catalogs };
  for (const listener of listeners) {
    listener();
  }
}

// The deferred areas asked for so far (deferred.ts), their texts per language once fetched, and
// the fetches on their way.
const areas = new Set<DeferredArea>();
const areaTexts = new Map<string, Record<string, string>>();
const areaLoads = new Map<string, Promise<void>>();

function areaKey(area: DeferredArea, language: Language): string {
  return `${area}:${language}`;
}

/** Fetches an area's texts in one language, once; a failed fetch may be tried again. */
function fetchArea(area: DeferredArea, language: Language): Promise<void> {
  const key = areaKey(area, language);
  if (areaTexts.has(key)) {
    return Promise.resolve();
  }
  let load = areaLoads.get(key);
  if (load === undefined) {
    load = AREA_LOADERS[area]
      [language]()
      .then((messages) => {
        areaTexts.set(key, messages);
      })
      .finally(() => {
        areaLoads.delete(key);
      });
    areaLoads.set(key, load);
  }
  return load;
}

/**
 * Loads an area's texts and merges them into the catalogs, in every language that is loaded or
 * on its way. A lazy page waits for its area before it renders (`lazyRouteComponent(() =>
 * loadArea("sharing").then(() => import("./Page")))`), so its texts are there with its code.
 *
 * A language still on its way is waited for first: its load takes along the areas registered
 * while it runs, and whatever it missed is merged here, so no page ever renders with the keys of
 * an area it asked for. A language not asked for yet gets the area when it loads.
 */
export async function loadArea(area: DeferredArea): Promise<void> {
  areas.add(area);
  await Promise.all(
    LANGUAGES.map(async (language) => {
      // A failed language load is its own caller's to report; the area then has nothing to join.
      await loading.get(language)?.catch(() => undefined);
      if (catalogs[language] === undefined) {
        return;
      }
      await fetchArea(area, language);
      const texts = areaTexts.get(areaKey(area, language));
      const current = catalogs[language];
      const first = texts === undefined ? undefined : Object.keys(texts)[0];
      if (texts === undefined || current === undefined || first === undefined) {
        return;
      }
      // Already merged by the language's own load: nothing changes, nobody is told.
      if (!Object.hasOwn(current, first)) {
        publish(language, { ...current, ...texts });
      }
    }),
  );
}

/**
 * Forgets which areas were asked for and their fetched texts, so a test can load them again as a
 * fresh page does. The catalogs keep what they hold.
 */
export function forgetAreas(): void {
  areas.clear();
  areaTexts.clear();
  areaLoads.clear();
}

/** Loads the language the page starts in; main.tsx renders once it is there. */
export function loadInitialLanguage(): Promise<Catalog> {
  return loadLanguage(getLanguage());
}

/** Loads every language, for what searches across both (the settings search). */
export function loadAllLanguages(): Promise<void> {
  return Promise.all(LANGUAGES.map(loadLanguage)).then(() => undefined);
}

// A switch of the saved language and one of the preview, each waiting for its catalog. They are
// separate, so ending a preview never cancels a pending switch of the saved language (setup ends
// its preview right after it saves the language it showed). For each, the latest call wins: an
// earlier switch whose catalog arrives later does not undo a newer one.
interface Pending {
  target: Language | null;
  request: number;
}
const savedSwitch: Pending = { target: null, request: 0 };
const previewSwitch: Pending = { target: null, request: 0 };

// Runs `apply` once the language's catalog is loaded: at once when it already is, so a switch to
// a loaded language is synchronous. A call whose target already applies, with nothing pending,
// changes nothing. A failed download keeps the language shown and says so in a toast; the next
// switch tries again.
function whenLoaded(
  pending: Pending,
  language: Language | null,
  applies: boolean,
  apply: () => void,
): void {
  if (applies && pending.target === null) {
    return;
  }
  pending.request += 1;
  if (language === null || catalogs[language] !== undefined) {
    pending.target = null;
    change(apply);
    return;
  }
  const mine = pending.request;
  pending.target = language;
  loadLanguage(language).then(
    () => {
      if (mine === pending.request) {
        pending.target = null;
        change(apply);
      }
    },
    () => {
      if (mine === pending.request) {
        pending.target = null;
        showErrorToast(translate(getLanguage(), "common.languageLoadFailed"));
      }
    },
  );
}

/** Switches the UI language everywhere at once and remembers the choice; a preview ends. */
export function setLanguage(language: Language): void {
  writePreference(LANGUAGE_STORAGE_KEY, language);
  // A preview still waiting for its catalog would land over this choice.
  previewSwitch.request += 1;
  previewSwitch.target = null;
  whenLoaded(savedSwitch, language, current === language && preview === null, () => {
    current = language;
    preview = null;
  });
}

/**
 * The language the saved choice is heading to: a switch still waiting for its catalog, else the
 * current language. Whoever decides whether to switch compares with this, not with the language
 * shown, so a pending switch is not left to land over a later decision.
 */
export function getTargetLanguage(): Language {
  return savedSwitch.target ?? current;
}

/**
 * Shows a language without remembering it, until `null` ends the preview and the current
 * language returns. A reload never keeps a preview.
 */
export function previewLanguage(language: Language | null): void {
  whenLoaded(previewSwitch, language, preview === language, () => {
    preview = language;
  });
}

function getLoadedCatalogs(): Readonly<Partial<Record<Language, Catalog>>> {
  return loadedCatalogs;
}

/** The catalogs loaded so far; a new value (and a render) whenever one arrives. */
export function useLoadedCatalogs(): Readonly<Partial<Record<Language, Catalog>>> {
  return useSyncExternalStore(subscribe, getLoadedCatalogs, getLoadedCatalogs);
}

/**
 * Whether a key is in the catalogs, for keys built at run time (`documents.type.${type}`). Both
 * languages have the same keys (the parity test), so any loaded catalog answers.
 */
export function hasMessage(key: string): key is MessageKey {
  for (const language of LANGUAGES) {
    const catalog = catalogs[language];
    if (catalog !== undefined) {
      return Object.hasOwn(catalog, key);
    }
  }
  return false;
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
  // The shown language is loaded before anything renders; a language asked for by name that is
  // still on its way falls back to whichever catalog is there, and the key as the last resort.
  const message =
    catalogs[language]?.[key] ?? catalogs[getLanguage()]?.[key] ?? anyCatalog()?.[key] ?? key;
  if (params === undefined) {
    return message;
  }
  return message.replace(/\{(\w+)\}/g, (placeholder, name: string) => {
    const value = params[name];
    return value === undefined ? placeholder : String(value);
  });
}

function anyCatalog(): Catalog | undefined {
  return catalogs.en ?? catalogs.de;
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
