import type { TimeRange } from "../../api/generated/shapes";
import { getTimeSettings, type TimeSettings } from "../../lib/timeSettings";
import { fromWall, normalizeWall, wallInput, wallOf, weekdayOf } from "../../lib/zonedTime";

/**
 * Time ranges as dashboards store them: text such as "now-6h", "now-1d/d" or an ISO time, so a
 * saved dashboard keeps meaning "the last six hours". Queries get absolute Unix milliseconds,
 * resolved in the user's time zone (the preference, else the browser's) with an injectable clock.
 *
 * Grammar: `now` [(+|-) <count><unit>]... [/<unit>], units s m h d w M y. Seconds, minutes and
 * hours are fixed lengths; days, weeks, months and years follow the calendar, so "now-1d" across
 * a daylight saving change is the same wall-clock time yesterday (23 or 25 hours ago). Rounding
 * with "/" goes to the start of the unit for `from` and to its last millisecond for `to`.
 */

export interface TextRange {
  from: string;
  to: string;
}

const UNITS = ["s", "m", "h", "d", "w", "M", "y"] as const;
type Unit = (typeof UNITS)[number];

const FIXED_MS: Partial<Record<Unit, number>> = { s: 1000, m: 60_000, h: 3_600_000 };

// The server's grammar (dashboards/model.rs): steps of at most five digits, one optional rounding.
const RELATIVE = /^now((?:[+-]\d{1,5}[smhdwMy])*)(?:\/([smhdwMy]))?$/;
const STEP = /([+-])(\d+)([smhdwMy])/g;

function add(ms: number, amount: number, unit: Unit, zone: string | null): number {
  const fixed = FIXED_MS[unit];
  if (fixed !== undefined) {
    return ms + amount * fixed;
  }
  const w = wallOf(ms, zone);
  switch (unit) {
    case "d":
      return fromWall({ ...w, day: w.day + amount }, zone);
    case "w":
      return fromWall({ ...w, day: w.day + amount * 7 }, zone);
    default: {
      // Months and years keep the day, clamped to the target month: Mar 31 minus a month is
      // Feb 28 (or 29), not Mar 3.
      const target = normalizeWall({
        ...w,
        day: 1,
        month: w.month + amount * (unit === "y" ? 12 : 1),
      });
      const lastDay = normalizeWall({ ...target, month: target.month + 1, day: 0 }).day;
      return fromWall({ ...target, day: Math.min(w.day, lastDay) }, zone);
    }
  }
}

/**
 * Start of the unit on the wall clock of the user's time zone; weeks start on the user's first
 * day (Monday unless chosen).
 */
function startOf(ms: number, unit: Unit, settings: TimeSettings): number {
  const zone = settings.timeZone;
  const w = wallOf(ms, zone);
  const firstDay = settings.weekStart === "sunday" ? 0 : settings.weekStart === "saturday" ? 6 : 1;
  const midnight = { hour: 0, minute: 0, second: 0, millisecond: 0 };
  switch (unit) {
    case "y":
      return fromWall({ ...w, ...midnight, month: 1, day: 1 }, zone);
    case "M":
      return fromWall({ ...w, ...midnight, day: 1 }, zone);
    case "w":
      return fromWall(
        {
          ...w,
          ...midnight,
          day: w.day - ((weekdayOf(w) - firstDay + 7) % 7),
        },
        zone,
      );
    case "d":
      return fromWall({ ...w, ...midnight }, zone);
    case "h":
      return fromWall({ ...w, minute: 0, second: 0, millisecond: 0 }, zone);
    case "m":
      return fromWall({ ...w, second: 0, millisecond: 0 }, zone);
    default:
      return ms - (((ms % 1000) + 1000) % 1000);
  }
}
export function isRelative(text: string): boolean {
  return RELATIVE.test(text.trim());
}

/**
 * Resolves one end of a range to Unix ms, or null when the text is not a time. `roundUp` is for
 * the `to` end: "now/d" then means the end of today, not its start.
 */
export function resolveTime(
  text: string,
  now: number,
  roundUp = false,
  settings: TimeSettings = getTimeSettings(),
): number | null {
  const zone = settings.timeZone;
  const value = text.trim();
  const relative = RELATIVE.exec(value);
  if (relative !== null) {
    let time = now;
    for (const [, sign, count, unit] of (relative[1] ?? "").matchAll(STEP)) {
      time = add(time, (sign === "-" ? -1 : 1) * Number(count), unit as Unit, zone);
    }
    const round = relative[2] as Unit | undefined;
    if (round !== undefined) {
      time = startOf(time, round, settings);
      if (roundUp) {
        time = add(time, 1, round, zone) - 1;
      }
    }
    return time;
  }
  // A date alone is midnight of that day in the user's time zone (Date.parse would take UTC).
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (date !== null) {
    const [year, month, day] = [Number(date[1]), Number(date[2]), Number(date[3])];
    const time = fromWall(
      { year, month, day, hour: 0, minute: 0, second: 0, millisecond: 0 },
      zone,
    );
    const read = wallOf(time, zone);
    return read.month === month && read.day === day ? time : null;
  }
  // A date and a time; without an offset it is wall-clock time in the user's time zone, as
  // typed. Epoch numbers are not accepted: the server refuses them in a stored range.
  const full =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})?$/.exec(
      value,
    );
  if (full !== null) {
    if (full[8] !== undefined) {
      const time = Date.parse(value);
      return Number.isNaN(time) ? null : time;
    }
    const wall = {
      year: Number(full[1]),
      month: Number(full[2]),
      day: Number(full[3]),
      hour: Number(full[4]),
      minute: Number(full[5]),
      second: Number(full[6] ?? 0),
      millisecond: Number((full[7] ?? "0").padEnd(3, "0")),
    };
    // Only real calendar times: Feb 30 or 25:00 would roll over into another day.
    const normal = normalizeWall(wall);
    if (normal.month !== wall.month || normal.day !== wall.day || normal.hour !== wall.hour) {
      return null;
    }
    return fromWall(wall, zone);
  }
  return null;
}
export type RangeProblem = "invalidFrom" | "invalidTo" | "fromAfterTo";

/** Resolves a stored range for one run of the queries. */
export function resolveRange(
  range: TextRange,
  now: number,
  settings: TimeSettings = getTimeSettings(),
): { ok: true; range: TimeRange } | { ok: false; error: RangeProblem } {
  const from = resolveTime(range.from, now, false, settings);
  if (from === null) {
    return { ok: false, error: "invalidFrom" };
  }
  const to = resolveTime(range.to, now, true, settings);
  if (to === null) {
    return { ok: false, error: "invalidTo" };
  }
  if (from >= to) {
    return { ok: false, error: "fromAfterTo" };
  }
  return { ok: true, range: { from, to } };
}

/** Quick choices in the picker, by the text they store. */
export const PRESETS = [
  { from: "now-5m", to: "now" },
  { from: "now-15m", to: "now" },
  { from: "now-1h", to: "now" },
  { from: "now-6h", to: "now" },
  { from: "now-12h", to: "now" },
  { from: "now-24h", to: "now" },
  { from: "now-2d", to: "now" },
  { from: "now-7d", to: "now" },
  { from: "now-30d", to: "now" },
  { from: "now-90d", to: "now" },
  { from: "now-1y", to: "now" },
  { from: "now/d", to: "now/d" },
  { from: "now-1d/d", to: "now-1d/d" },
  { from: "now/w", to: "now/w" },
  { from: "now/M", to: "now/M" },
] as const satisfies readonly TextRange[];

export type Preset = (typeof PRESETS)[number];

export function presetOf(range: TextRange): Preset | undefined {
  return PRESETS.find((p) => p.from === range.from.trim() && p.to === range.to.trim());
}

/** Wall-clock time in the user's time zone for a datetime-local input: "2026-10-20T08:00". */
export function toLocalInput(ms: number): string {
  return wallInput(ms);
}

/** Stored text for an absolute time: ISO in UTC, unambiguous for every reader of the dashboard. */
export function toStoredAbsolute(ms: number): string {
  return new Date(ms).toISOString();
}

/** Points the server should return per series for a range: about one per pixel of a wide panel. */
export const MAX_DATA_POINTS = 1000;

/** The interval macros' value: the range spread over the points, at least one second. */
export function intervalFor(range: TimeRange, maxDataPoints = MAX_DATA_POINTS): number {
  return Math.max(1000, Math.round((range.to - range.from) / maxDataPoints));
}
