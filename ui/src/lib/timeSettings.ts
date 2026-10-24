import { useSyncExternalStore } from "react";

/**
 * The time zone and first day of the week in effect: the user's choice, else the organization's
 * or server's default, and while a dashboard is open as that dashboard overrides them (with its
 * fiscal year too). Every component that formats or rounds times reads them through `useI18n()`
 * (`timeZone`, `weekStart`), so a change re-renders the times already on screen; plain functions
 * read `getTimeZone()`.
 */

export const WEEK_STARTS = ["monday", "sunday", "saturday"] as const;
export type WeekStart = (typeof WEEK_STARTS)[number];

export interface TimeSettings {
  /** An IANA zone, or null for the browser's own. */
  timeZone: string | null;
  /** Null is Monday (ISO 8601). */
  weekStart: WeekStart | null;
  /** The month (1 to 12) a fiscal year starts with; absent is January. */
  fiscalYearStartMonth?: number | undefined;
}

/**
 * What an open dashboard sets: a field left out keeps the user's setting. `timeZone: null` is
 * the browser's own zone, whatever the user's setting says.
 */
export interface TimeOverride {
  timeZone?: string | null;
  weekStart?: WeekStart;
  fiscalYearStartMonth?: number;
}

// The user's own choice, the organization's or server's default beneath it (settings,
// `appearance.time_zone` and `appearance.week_start`), an open dashboard's override above both,
// and what applies.
let chosen: TimeSettings = { timeZone: null, weekStart: null };
let defaults: TimeSettings = { timeZone: null, weekStart: null };
let override: TimeOverride | null = null;
let user: TimeSettings = { timeZone: null, weekStart: null };
let current: TimeSettings = user;
const listeners = new Set<() => void>();

/** Whether the browser knows the zone; an unknown one falls back to the browser's own. */
export function knownZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/**
 * The user's settings with an override applied. A zone the browser does not know keeps the
 * user's zone.
 */
export function applyTimeOverride(base: TimeSettings, over: TimeOverride | null): TimeSettings {
  if (over === null) {
    return base;
  }
  const zone = over.timeZone;
  const next: TimeSettings = {
    timeZone: zone === undefined || (zone !== null && !knownZone(zone)) ? base.timeZone : zone,
    weekStart: over.weekStart ?? base.weekStart,
  };
  if (over.fiscalYearStartMonth !== undefined) {
    next.fiscalYearStartMonth = over.fiscalYearStartMonth;
  }
  return next;
}

function recompute(): void {
  const nextUser = {
    timeZone: chosen.timeZone ?? defaults.timeZone,
    weekStart: chosen.weekStart ?? defaults.weekStart,
  };
  if (nextUser.timeZone !== user.timeZone || nextUser.weekStart !== user.weekStart) {
    user = nextUser;
  }
  const next = applyTimeOverride(user, override);
  if (
    next.timeZone === current.timeZone &&
    next.weekStart === current.weekStart &&
    next.fiscalYearStartMonth === current.fiscalYearStartMonth
  ) {
    return;
  }
  current = next;
  for (const listener of listeners) {
    listener();
  }
}

function update(next: TimeSettings): void {
  chosen = next;
  recompute();
}

/**
 * The defaults for users who chose nothing: an IANA zone (or null for the browser's) and a first
 * day of the week (null: Monday).
 */
export function setDefaultTimeSettings(next: TimeSettings): void {
  defaults = {
    timeZone: next.timeZone !== null && knownZone(next.timeZone) ? next.timeZone : null,
    weekStart: next.weekStart,
  };
  recompute();
}

export function setTimeZone(zone: string | null): void {
  update({ ...chosen, timeZone: zone !== null && knownZone(zone) ? zone : null });
}

export function setWeekStart(start: WeekStart | null): void {
  update({ ...chosen, weekStart: start });
}

/** The open dashboard's own time options, or null when it leaves them to the user. */
export function setTimeOverride(next: TimeOverride | null): void {
  override = next;
  recompute();
}

/** The settings in effect: the user's, with an open dashboard's override applied. */
export function getTimeSettings(): TimeSettings {
  return current;
}

/** The user's own settings (choice, else default), without a dashboard's override. */
export function getUserTimeSettings(): TimeSettings {
  return user;
}

export function getTimeZone(): string | null {
  return current.timeZone;
}

/** The first day of the week as `Date.getDay()` numbers it: the choice, else Monday (ISO 8601). */
export function weekStartDay(): number {
  const start = current.weekStart ?? "monday";
  return start === "sunday" ? 0 : start === "saturday" ? 6 : 1;
}

export function subscribeTimeSettings(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The zones the browser knows, with UTC first (browsers list it under other names or not at all). */
export function timeZones(): string[] {
  const supported = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
  let zones: string[] = [];
  try {
    zones = supported?.("timeZone") ?? [];
  } catch {
    // An engine without the list offers UTC alone.
  }
  return ["UTC", ...zones.filter((zone) => zone !== "UTC")];
}

/** The browser's own zone. */
export function browserZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** The settings in effect, for components: they render again when the settings change. */
export function useTimeSettings(): TimeSettings {
  return useSyncExternalStore(subscribeTimeSettings, getTimeSettings, getTimeSettings);
}

/** The option for `Intl.DateTimeFormat` and `toLocaleString`: the zone, or none (the browser's). */
export function zoneOption(zone: string | null): { timeZone?: string } {
  return zone === null ? {} : { timeZone: zone };
}
