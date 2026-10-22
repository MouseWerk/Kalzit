import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { expectShape, isRecord, request } from "../api/client";
import { browserLanguage, getLanguage, LANGUAGES, type Language, setLanguage } from "../i18n/i18n";
import { readPreference, writePreference } from "../lib/storage";
import { setTimeZone, setWeekStart, WEEK_STARTS, type WeekStart } from "../lib/timeSettings";
import { getTheme, setTheme, storedTheme, THEMES, type Theme } from "../theme/theme";

/**
 * The signed-in user's preferences, stored on the server per user (`/api/me/preferences`,
 * docs/api/shell.md). Language and theme left unset follow what the browser already has, else the
 * server's default; time zone left unset is the browser's, week start Monday. Language and theme
 * also stay in the browser, so the next visit paints in them before the server answers.
 */

export { WEEK_STARTS, type WeekStart };

export interface StartDashboard {
  orgId: string;
  dashboardId: string;
  title: string;
}

export interface Preferences {
  language: Language | null;
  theme: Theme | null;
  timeZone: string | null;
  weekStart: WeekStart | null;
  startDashboard: StartDashboard | null;
  defaults: { language: string; theme: string };
}

export interface PreferencesPatch {
  language?: Language | null;
  theme?: Theme | null;
  timeZone?: string | null;
  weekStart?: WeekStart | null;
  startDashboard?: { orgId: string; dashboardId: string } | null;
}

const oneOf = <T extends string>(options: readonly T[], value: unknown): T | null =>
  options.find((option) => option === value) ?? null;

function parsePreferences(value: unknown): value is Preferences {
  return isRecord(value) && isRecord(value.defaults);
}

function normalize(value: Preferences): Preferences {
  const start = value.startDashboard as unknown;
  return {
    language: oneOf(LANGUAGES, value.language),
    theme: oneOf(THEMES, value.theme),
    timeZone: typeof value.timeZone === "string" ? value.timeZone : null,
    weekStart: oneOf(WEEK_STARTS, value.weekStart),
    startDashboard:
      isRecord(start) &&
      typeof start.orgId === "string" &&
      typeof start.dashboardId === "string" &&
      typeof start.title === "string"
        ? { orgId: start.orgId, dashboardId: start.dashboardId, title: start.title }
        : null,
    defaults: {
      language: String(value.defaults.language ?? ""),
      theme: String(value.defaults.theme ?? ""),
    },
  };
}

export async function fetchPreferences(): Promise<Preferences> {
  return normalize(
    expectShape(await request("GET", "/api/me/preferences"), parsePreferences, "preferences"),
  );
}

export async function updatePreferences(patch: PreferencesPatch): Promise<Preferences> {
  return normalize(
    expectShape(
      await request("PATCH", "/api/me/preferences", patch),
      parsePreferences,
      "preferences",
    ),
  );
}

export const preferencesQuery = queryOptions({
  queryKey: ["preferences"],
  queryFn: fetchPreferences,
  staleTime: 60_000,
});

/**
 * Language and theme the browser already has: a choice stored in it, or (language only) one its
 * own language list names. Null when it has neither; then the server's default applies.
 */
function localLanguage(): Language | null {
  return browserLanguage();
}

function localTheme(): Theme | null {
  return storedTheme();
}

/**
 * Applies what the preferences decide in the browser. Language and theme: the stored preference;
 * where there is none, what the browser already has while it has not been adopted yet (see
 * `usePreferencesSync`), else the server's default (docs/api/shell.md).
 */
export function applyPreferences(preferences: Preferences, keepLocal = false): void {
  const language =
    preferences.language ??
    (keepLocal ? localLanguage() : null) ??
    oneOf(LANGUAGES, preferences.defaults.language);
  if (language !== null && language !== getLanguage()) {
    setLanguage(language);
  }
  const theme =
    preferences.theme ??
    (keepLocal ? localTheme() : null) ??
    oneOf(THEMES, preferences.defaults.theme);
  if (theme !== null && theme !== getTheme()) {
    setTheme(theme);
  }
  setTimeZone(preferences.timeZone);
  setWeekStart(preferences.weekStart);
}

/** What the browser has that the server does not keep yet, as the patch that adopts it. */
export function adoptionPatch(preferences: Preferences): PreferencesPatch | null {
  const patch: PreferencesPatch = {};
  const language = localLanguage();
  if (preferences.language === null && language !== null) {
    patch.language = language;
  }
  const theme = localTheme();
  if (preferences.theme === null && theme !== null) {
    patch.theme = theme;
  }
  return Object.keys(patch).length === 0 ? null : patch;
}

/**
 * Remembers per browser and user that the browser's choices were adopted, so a preference the
 * user later resets to the default stays reset instead of being adopted again.
 */
export function adoptedKey(userId: string): string {
  return `kalzit.preferencesAdopted.${userId}`;
}

/**
 * Loads the signed-in user's preferences and applies them whenever they change. The first time a
 * user signs in in this browser, the language and theme it already has are saved as the user's
 * preferences where the server holds none, so they are not lost to the server's default.
 */
export function usePreferencesSync(userId: string): void {
  const queryClient = useQueryClient();
  const query = useQuery(preferencesQuery);
  useEffect(() => {
    if (query.data === undefined) {
      return;
    }
    const adopted = readPreference(adoptedKey(userId)) === "true";
    // Read before applying: applying stores the server's default in the browser, which is not a
    // choice of the browser's own.
    const patch = adopted ? null : adoptionPatch(query.data);
    applyPreferences(query.data, !adopted);
    if (adopted) {
      return;
    }
    // Marked first, so one adoption is sent even when the answer re-renders before it arrives.
    writePreference(adoptedKey(userId), "true");
    if (patch !== null) {
      updatePreferences(patch).then(
        (saved) => queryClient.setQueryData(preferencesQuery.queryKey, saved),
        // Not saved: the browser keeps its choice, and the next page view tries again.
        () => writePreference(adoptedKey(userId), "false"),
      );
    }
  }, [query.data, queryClient, userId]);
}
/**
 * Changes preferences on the server. The change applies in the browser at once (language and
 * theme before the server answers); a refused change is taken back.
 */
export function usePreferenceChange(options: {
  onSaved?: (patch: PreferencesPatch, previous: Preferences | undefined) => void;
  onFailed?: (error: unknown) => void;
}) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: PreferencesPatch) => updatePreferences(patch),
    onMutate: (patch) => {
      const previous = queryClient.getQueryData(preferencesQuery.queryKey);
      if (patch.language !== undefined && patch.language !== null) {
        setLanguage(patch.language);
      }
      if (patch.theme !== undefined && patch.theme !== null) {
        setTheme(patch.theme);
      }
      return { previous };
    },
    onSuccess: (saved, patch, context) => {
      queryClient.setQueryData(preferencesQuery.queryKey, saved);
      applyPreferences(saved);
      options.onSaved?.(patch, context?.previous);
    },
    onError: (error, _patch, context) => {
      if (context?.previous !== undefined) {
        applyPreferences(context.previous);
      }
      options.onFailed?.(error);
    },
  });
}
