import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { expectShape, isRecord, request } from "../api/client";
import { getLanguage, LANGUAGES, type Language, setLanguage } from "../i18n/i18n";
import { choiceFor, claimChoice, clearChoice, type LocalChoice } from "../lib/localChoice";
import { setTimeZone, setWeekStart, WEEK_STARTS, type WeekStart } from "../lib/timeSettings";
import { getTheme, setTheme, THEMES, type Theme } from "../theme/theme";

/**
 * The signed-in user's preferences, stored on the server per user (`/api/me/preferences`,
 * docs/api/shell.md). Language and theme left unset follow an explicit choice made on the sign-in
 * page, else the server's default; time zone left unset is the browser's, week start Monday. Language and theme
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
 * Applies what the preferences decide in the browser. Language and theme: the account's
 * preference; where there is none, an explicit choice made in this browser before signing in
 * (`choice`, until it is adopted), else the server's default (docs/api/shell.md).
 */
export function applyPreferences(preferences: Preferences, choice: LocalChoice = {}): void {
  const language =
    preferences.language ?? choice.language ?? oneOf(LANGUAGES, preferences.defaults.language);
  if (language !== null && language !== getLanguage()) {
    setLanguage(language);
  }
  const theme = preferences.theme ?? choice.theme ?? oneOf(THEMES, preferences.defaults.theme);
  if (theme !== null && theme !== getTheme()) {
    setTheme(theme);
  }
  setTimeZone(preferences.timeZone);
  setWeekStart(preferences.weekStart);
}

/** The explicit choice the server does not keep yet, as the patch that adopts it. */
export function adoptionPatch(
  preferences: Preferences,
  choice: LocalChoice,
): PreferencesPatch | null {
  const patch: PreferencesPatch = {};
  if (preferences.language === null && choice.language !== undefined) {
    patch.language = choice.language;
  }
  if (preferences.theme === null && choice.theme !== undefined) {
    patch.theme = choice.theme;
  }
  return Object.keys(patch).length === 0 ? null : patch;
}

/**
 * Loads the signed-in user's preferences and applies them whenever they change. A language or
 * theme chosen on the sign-in page becomes the user's preference where the server holds none
 * (one PATCH), so it is not lost to the server's default; values another user left in a shared
 * browser are never taken over (`lib/localChoice.ts`).
 */
export function usePreferencesSync(userId: string): void {
  const queryClient = useQueryClient();
  const query = useQuery(preferencesQuery);
  useEffect(() => {
    if (query.data === undefined) {
      return;
    }
    const choice = choiceFor(userId);
    applyPreferences(query.data, choice);
    const patch = adoptionPatch(query.data, choice);
    if (patch === null) {
      // Nothing left to adopt: the choice is the account's now, or the account had its own.
      clearChoice();
      return;
    }
    // Claimed first, so a re-render while the answer is on its way sends nothing twice and the
    // choice never passes to another account.
    claimChoice(userId);
    updatePreferences(patch).then(
      (saved) => {
        clearChoice();
        queryClient.setQueryData(preferencesQuery.queryKey, saved);
      },
      // Not saved: the choice stays this user's, and the next page view tries again.
      () => undefined,
    );
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
