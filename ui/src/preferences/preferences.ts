import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useSyncExternalStore } from "react";
import { expectShape, isRecord, request } from "../api/client";
import { getLanguage, LANGUAGES, type Language, setLanguage } from "../i18n/i18n";
import { getTheme, setTheme, THEMES, type Theme } from "../theme/theme";

/**
 * The signed-in user's preferences, stored on the server per user (`/api/me/preferences`,
 * docs/api/shell.md). A preference left unset follows the server's default (language, theme), the
 * browser (time zone) or the language (week start). Language and theme also stay in the browser,
 * so the next visit paints in them before the server answers.
 */

export const WEEK_STARTS = ["monday", "sunday", "saturday"] as const;
export type WeekStart = (typeof WEEK_STARTS)[number];

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

// Time zone and week start for everything that formats or rounds times.
let timeZone: string | null = null;
let weekStart: WeekStart | null = null;
const listeners = new Set<() => void>();

function emit(): void {
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

/** Whether the browser knows the zone; an unknown one falls back to the browser's own. */
function knownZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

export function setTimeZone(zone: string | null): void {
  const next = zone !== null && knownZone(zone) ? zone : null;
  if (next !== timeZone) {
    timeZone = next;
    emit();
  }
}

export function getTimeZone(): string | null {
  return timeZone;
}

/**
 * The time zone option for `Intl.DateTimeFormat` and `toLocaleString`: the chosen zone, or none
 * (the browser's).
 */
export function zoned(): { timeZone?: string } {
  return timeZone === null ? {} : { timeZone };
}

/** The zone as part of a cache key for formatters. */
export function zoneKey(): string {
  return timeZone ?? "";
}

export function setWeekStart(start: WeekStart | null): void {
  if (start !== weekStart) {
    weekStart = start;
    emit();
  }
}

/** The first day of the week as `Date.getDay()` numbers it: the choice, else Monday (ISO 8601). */
export function weekStartDay(): number {
  const start = weekStart ?? "monday";
  return start === "sunday" ? 0 : start === "saturday" ? 6 : 1;
}

/** Re-renders when time zone or week start change, so formatted times follow at once. */
export function useTimeSettings(): string {
  return useSyncExternalStore(
    subscribe,
    () => `${timeZone ?? ""}|${weekStart ?? ""}`,
    () => "",
  );
}

/** Applies what the preferences decide in the browser. */
export function applyPreferences(preferences: Preferences): void {
  const language = preferences.language ?? oneOf(LANGUAGES, preferences.defaults.language);
  if (language !== null && language !== getLanguage()) {
    setLanguage(language);
  }
  const theme = preferences.theme ?? oneOf(THEMES, preferences.defaults.theme);
  if (theme !== null && theme !== getTheme()) {
    setTheme(theme);
  }
  setTimeZone(preferences.timeZone);
  setWeekStart(preferences.weekStart);
}

/** Loads the signed-in user's preferences and applies them whenever they change. */
export function usePreferencesSync(): void {
  const query = useQuery(preferencesQuery);
  useEffect(() => {
    if (query.data !== undefined) {
      applyPreferences(query.data);
    }
  }, [query.data]);
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
