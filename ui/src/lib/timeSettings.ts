/**
 * The user's time zone and first day of the week, as the preferences set them. Every component
 * that formats or rounds times reads them through `useI18n()` (`timeZone`, `weekStart`), so a
 * change re-renders the times already on screen; plain functions read `getTimeZone()`.
 */

export const WEEK_STARTS = ["monday", "sunday", "saturday"] as const;
export type WeekStart = (typeof WEEK_STARTS)[number];

export interface TimeSettings {
  /** An IANA zone, or null for the browser's own. */
  timeZone: string | null;
  /** Null is Monday (ISO 8601). */
  weekStart: WeekStart | null;
}

// The user's own choice, the organization's or server's default beneath it (settings,
// `appearance.time_zone` and `appearance.week_start`), and what applies: the choice, else the
// default.
let chosen: TimeSettings = { timeZone: null, weekStart: null };
let defaults: TimeSettings = { timeZone: null, weekStart: null };
let current: TimeSettings = { timeZone: null, weekStart: null };
const listeners = new Set<() => void>();

function recompute(): void {
  const next = {
    timeZone: chosen.timeZone ?? defaults.timeZone,
    weekStart: chosen.weekStart ?? defaults.weekStart,
  };
  if (next.timeZone === current.timeZone && next.weekStart === current.weekStart) {
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
  update({ ...chosen, timeZone: zone !== null && knownZone(zone) ? zone : null });
}

export function setWeekStart(start: WeekStart | null): void {
  update({ ...chosen, weekStart: start });
}

export function getTimeSettings(): TimeSettings {
  return current;
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

/** The option for `Intl.DateTimeFormat` and `toLocaleString`: the zone, or none (the browser's). */
export function zoneOption(zone: string | null): { timeZone?: string } {
  return zone === null ? {} : { timeZone: zone };
}
