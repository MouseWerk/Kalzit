import type { TimeRange } from "../../api/generated/shapes";

/**
 * Time ranges as dashboards store them: text such as "now-6h", "now-1d/d" or an ISO time, so a
 * saved dashboard keeps meaning "the last six hours". Queries get absolute Unix milliseconds,
 * resolved in the browser's time zone with an injectable clock.
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

function add(date: Date, amount: number, unit: Unit): void {
  const fixed = FIXED_MS[unit];
  if (fixed !== undefined) {
    date.setTime(date.getTime() + amount * fixed);
    return;
  }
  switch (unit) {
    case "d":
      date.setDate(date.getDate() + amount);
      break;
    case "w":
      date.setDate(date.getDate() + amount * 7);
      break;
    default: {
      // Months and years keep the day, clamped to the target month: Mar 31 minus a month is
      // Feb 28 (or 29), not Mar 3.
      const day = date.getDate();
      date.setDate(1);
      date.setMonth(date.getMonth() + amount * (unit === "y" ? 12 : 1));
      const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
      date.setDate(Math.min(day, lastDay));
    }
  }
}

/** Start of the unit in local time; weeks start on Monday (ISO 8601). */
function startOf(date: Date, unit: Unit): void {
  switch (unit) {
    case "y":
      date.setMonth(0, 1);
      date.setHours(0, 0, 0, 0);
      break;
    case "M":
      date.setDate(1);
      date.setHours(0, 0, 0, 0);
      break;
    case "w":
      date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
      date.setHours(0, 0, 0, 0);
      break;
    case "d":
      date.setHours(0, 0, 0, 0);
      break;
    case "h":
      date.setMinutes(0, 0, 0);
      break;
    case "m":
      date.setSeconds(0, 0);
      break;
    default:
      date.setMilliseconds(0);
  }
}

export function isRelative(text: string): boolean {
  return RELATIVE.test(text.trim());
}

/**
 * Resolves one end of a range to Unix ms, or null when the text is not a time. `roundUp` is for
 * the `to` end: "now/d" then means the end of today, not its start.
 */
export function resolveTime(text: string, now: number, roundUp = false): number | null {
  const value = text.trim();
  const relative = RELATIVE.exec(value);
  if (relative !== null) {
    const date = new Date(now);
    for (const [, sign, count, unit] of (relative[1] ?? "").matchAll(STEP)) {
      add(date, (sign === "-" ? -1 : 1) * Number(count), unit as Unit);
    }
    const round = relative[2] as Unit | undefined;
    if (round !== undefined) {
      startOf(date, round);
      if (roundUp) {
        add(date, 1, round);
        date.setTime(date.getTime() - 1);
      }
    }
    return date.getTime();
  }
  // A date alone is local midnight of that day (Date.parse would take UTC midnight).
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (date !== null) {
    const [year, month, day] = [Number(date[1]), Number(date[2]), Number(date[3])];
    const local = new Date(year, month - 1, day);
    return local.getMonth() === month - 1 && local.getDate() === day ? local.getTime() : null;
  }
  // A date and a time; without an offset it is local time, as typed. Epoch numbers are not
  // accepted: the server refuses them in a stored range.
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?$/.test(value)) {
    const time = Date.parse(value);
    return Number.isNaN(time) ? null : time;
  }
  return null;
}

export type RangeProblem = "invalidFrom" | "invalidTo" | "fromAfterTo";

/** Resolves a stored range for one run of the queries. */
export function resolveRange(
  range: TextRange,
  now: number,
): { ok: true; range: TimeRange } | { ok: false; error: RangeProblem } {
  const from = resolveTime(range.from, now);
  if (from === null) {
    return { ok: false, error: "invalidFrom" };
  }
  const to = resolveTime(range.to, now, true);
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

/** Local time for a datetime-local input: "2026-10-20T08:00". */
export function toLocalInput(ms: number): string {
  const date = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
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
