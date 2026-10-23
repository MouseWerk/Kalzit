import type { TimeRange } from "../../api/generated/shapes";
import type { MessageKey } from "../../i18n/i18n";
import { getTimeSettings, type TimeSettings } from "../../lib/timeSettings";
import { fromWall, normalizeWall, wallInput, wallOf, weekdayOf } from "../../lib/zonedTime";

/**
 * Time ranges as dashboards store them: text such as "now-6h", "now-1d/d" or an ISO time, so a
 * saved dashboard keeps meaning "the last six hours". Queries get absolute Unix milliseconds,
 * resolved in the time zone in effect (the dashboard's, else the user's preference, else the
 * browser's) with an injectable clock.
 *
 * Grammar: `now` [(+|-) <count><unit>]... [/<unit>], units s m h d w M y, plus fQ and fy for the
 * fiscal quarter and year, which start in the dashboard's fiscal start month (January unless
 * set). Seconds, minutes and hours are fixed lengths; days, weeks, months, quarters and years
 * follow the calendar, so "now-1d" across a daylight saving change is the same wall-clock time
 * yesterday (23 or 25 hours ago). Rounding with "/" goes to the start of the unit for `from` and
 * to its last millisecond for `to`.
 */

export interface TextRange {
  from: string;
  to: string;
}

type Unit = "s" | "m" | "h" | "d" | "w" | "M" | "y" | "fQ" | "fy";

const FIXED_MS: Partial<Record<Unit, number>> = { s: 1000, m: 60_000, h: 3_600_000 };

// The server's grammar (dashboards/model.rs): steps of at most five digits, one optional rounding.
const UNIT = "(?:fQ|fy|[smhdwMy])";
const RELATIVE = new RegExp(`^now((?:[+-]\\d{1,5}${UNIT})*)(?:/(${UNIT}))?$`);
const STEP = new RegExp(`([+-])(\\d+)(${UNIT})`, "g");
/** The longest count one step may have. */
const MAX_COUNT = 99_999;

/** Months a calendar or fiscal step moves by. */
const MONTHS: Partial<Record<Unit, number>> = { M: 1, fQ: 3, y: 12, fy: 12 };

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
      // Months, quarters and years keep the day, clamped to the target month: Mar 31 minus a
      // month is Feb 28 (or 29), not Mar 3.
      const target = normalizeWall({
        ...w,
        day: 1,
        month: w.month + amount * (MONTHS[unit] ?? 1),
      });
      const lastDay = normalizeWall({ ...target, month: target.month + 1, day: 0 }).day;
      return fromWall({ ...target, day: Math.min(w.day, lastDay) }, zone);
    }
  }
}

/** The fiscal start month in effect, 1 to 12; January when unset or out of range. */
function fiscalStart(settings: TimeSettings): number {
  const month = settings.fiscalYearStartMonth;
  return month !== undefined && Number.isInteger(month) && month >= 1 && month <= 12 ? month : 1;
}

/**
 * Start of the unit on the wall clock of the zone in effect; weeks start on the chosen first day
 * (Monday unless chosen), fiscal years and quarters in the fiscal start month.
 */
function startOf(ms: number, unit: Unit, settings: TimeSettings): number {
  const zone = settings.timeZone;
  const w = wallOf(ms, zone);
  const firstDay = settings.weekStart === "sunday" ? 0 : settings.weekStart === "saturday" ? 6 : 1;
  const midnight = { hour: 0, minute: 0, second: 0, millisecond: 0 };
  switch (unit) {
    case "fy":
    case "fQ": {
      // Months since the fiscal year began, then back to the start of that year or quarter.
      const since = (w.month - fiscalStart(settings) + 12) % 12;
      const back = unit === "fy" ? since : since % 3;
      return fromWall({ ...w, ...midnight, month: w.month - back, day: 1 }, zone);
    }
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
  // A date alone is midnight of that day in the zone in effect (Date.parse would take UTC).
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
  // A date and a time; without an offset it is wall-clock time in the zone in effect, as typed.
  // Epoch numbers are not accepted: the server refuses them in a stored range.
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

/**
 * "Now" for a dashboard with a now delay ("1m"): that far back, so the newest, still incomplete
 * data is left out. A delay that is not a length is ignored.
 */
export function delayedNow(
  now: number,
  delay: string | undefined,
  settings?: TimeSettings,
): number {
  if (delay === undefined || parseDuration(delay) === null) {
    return now;
  }
  return resolveTime(`now-${delay}`, now, false, settings) ?? now;
}

/** One quick choice: the text it stores and its name. */
export interface Preset extends TextRange {
  label: MessageKey;
  /** Uses the fiscal year: offered with the fiscal start month in mind. */
  fiscal?: boolean;
}

/** Quick choices in the picker, by the text they store. */
export const PRESETS: readonly Preset[] = [
  { from: "now-5m", to: "now", label: "dashboards.time.last5m" },
  { from: "now-15m", to: "now", label: "dashboards.time.last15m" },
  { from: "now-30m", to: "now", label: "toolbar.range.last30m" },
  { from: "now-1h", to: "now", label: "dashboards.time.last1h" },
  { from: "now-3h", to: "now", label: "toolbar.range.last3h" },
  { from: "now-6h", to: "now", label: "dashboards.time.last6h" },
  { from: "now-12h", to: "now", label: "dashboards.time.last12h" },
  { from: "now-24h", to: "now", label: "dashboards.time.last24h" },
  { from: "now-2d", to: "now", label: "dashboards.time.last2d" },
  { from: "now-7d", to: "now", label: "dashboards.time.last7d" },
  { from: "now-30d", to: "now", label: "dashboards.time.last30d" },
  { from: "now-90d", to: "now", label: "dashboards.time.last90d" },
  { from: "now-6M", to: "now", label: "toolbar.range.last6M" },
  { from: "now-1y", to: "now", label: "dashboards.time.last1y" },
  { from: "now-2y", to: "now", label: "toolbar.range.last2y" },
  { from: "now-5y", to: "now", label: "toolbar.range.last5y" },
  { from: "now/d", to: "now/d", label: "dashboards.time.today" },
  { from: "now/d", to: "now", label: "toolbar.range.todaySoFar" },
  { from: "now-1d/d", to: "now-1d/d", label: "dashboards.time.yesterday" },
  { from: "now-2d/d", to: "now-2d/d", label: "toolbar.range.dayBeforeYesterday" },
  { from: "now/w", to: "now/w", label: "dashboards.time.thisWeek" },
  { from: "now/w", to: "now", label: "toolbar.range.thisWeekSoFar" },
  { from: "now-1w/w", to: "now-1w/w", label: "toolbar.range.previousWeek" },
  { from: "now/M", to: "now/M", label: "dashboards.time.thisMonth" },
  { from: "now/M", to: "now", label: "toolbar.range.thisMonthSoFar" },
  { from: "now-1M/M", to: "now-1M/M", label: "toolbar.range.previousMonth" },
  { from: "now/y", to: "now/y", label: "toolbar.range.thisYear" },
  { from: "now/y", to: "now", label: "toolbar.range.thisYearSoFar" },
  { from: "now-1y/y", to: "now-1y/y", label: "toolbar.range.previousYear" },
  { from: "now/fQ", to: "now/fQ", label: "toolbar.range.thisFiscalQuarter", fiscal: true },
  { from: "now/fQ", to: "now", label: "toolbar.range.thisFiscalQuarterSoFar", fiscal: true },
  {
    from: "now-1fQ/fQ",
    to: "now-1fQ/fQ",
    label: "toolbar.range.previousFiscalQuarter",
    fiscal: true,
  },
  { from: "now/fy", to: "now/fy", label: "toolbar.range.thisFiscalYear", fiscal: true },
  { from: "now/fy", to: "now", label: "toolbar.range.thisFiscalYearSoFar", fiscal: true },
  { from: "now-1fy/fy", to: "now-1fy/fy", label: "toolbar.range.previousFiscalYear", fiscal: true },
];

export function presetOf(range: TextRange): Preset | undefined {
  return PRESETS.find((p) => p.from === range.from.trim() && p.to === range.to.trim());
}

/** Wall-clock time in the zone in effect for a datetime-local input: "2026-10-20T08:00". */
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

// Moving and widening a range. Relative ranges stay relative where the arithmetic allows it, so
// "the last 6 hours" moved back is "6 to 12 hours ago", still sliding with the clock; anything
// else becomes absolute times.

/**
 * Units that add up without the calendar, with their size in the family's base: seconds, days,
 * months. Fiscal steps without rounding are plain months (a quarter is three, a year twelve).
 */
const FAMILY: Record<Unit, { family: "s" | "d" | "M"; size: number }> = {
  s: { family: "s", size: 1 },
  m: { family: "s", size: 60 },
  h: { family: "s", size: 3600 },
  d: { family: "d", size: 1 },
  w: { family: "d", size: 7 },
  M: { family: "M", size: 1 },
  fQ: { family: "M", size: 3 },
  y: { family: "M", size: 12 },
  fy: { family: "M", size: 12 },
};

/** The units a sum in a family is written in, largest first. */
const WRITE_UNITS: Record<"s" | "d" | "M", readonly Unit[]> = {
  s: ["h", "m", "s"],
  d: ["w", "d"],
  M: ["y", "M"],
};

interface Relative {
  steps: { amount: number; unit: Unit }[];
  round: Unit | undefined;
}

function parseRelative(text: string): Relative | null {
  const match = RELATIVE.exec(text.trim());
  if (match === null) {
    return null;
  }
  const steps = [...(match[1] ?? "").matchAll(STEP)].map(([, sign, count, unit]) => ({
    amount: (sign === "-" ? -1 : 1) * Number(count),
    unit: unit as Unit,
  }));
  return { steps, round: match[2] as Unit | undefined };
}

/** The steps as one number in `family`, or null when a step is of another family. */
function sumIn(steps: Relative["steps"], family: "s" | "d" | "M"): number | null {
  let sum = 0;
  for (const step of steps) {
    const unit = FAMILY[step.unit];
    if (unit.family !== family) {
      return null;
    }
    sum += step.amount * unit.size;
  }
  return sum;
}

/** "now", "now-12h", "now+30m": an offset in a family's base, in its largest even unit. */
function writeOffset(offset: number, family: "s" | "d" | "M"): string | null {
  if (offset === 0) {
    return "now";
  }
  for (const unit of WRITE_UNITS[family]) {
    const size = FAMILY[unit].size;
    if (offset % size === 0 && Math.abs(offset / size) <= MAX_COUNT) {
      return `now${offset < 0 ? "-" : "+"}${Math.abs(offset / size)}${unit}`;
    }
  }
  return null;
}

/** The units rounded periods of `unit` may be counted in. */
function countsOf(steps: Relative["steps"], unit: Unit): number | null {
  const fiscal = unit === "fQ" || unit === "fy";
  let periods = 0;
  for (const step of steps) {
    const sameKind = FAMILY[step.unit].family === FAMILY[unit].family;
    const stepFiscal = step.unit === "fQ" || step.unit === "fy";
    // A fiscal period is counted in fiscal steps; a calendar one in calendar steps.
    if (!sameKind || (FAMILY[unit].family === "M" && fiscal !== stepFiscal)) {
      return null;
    }
    const ratio = (step.amount * FAMILY[step.unit].size) / FAMILY[unit].size;
    if (!Number.isInteger(ratio)) {
      return null;
    }
    periods += ratio;
  }
  return periods;
}

function writeRounded(periods: number, unit: Unit): string | null {
  if (Math.abs(periods) > MAX_COUNT) {
    return null;
  }
  return periods === 0
    ? `now/${unit}`
    : `now${periods < 0 ? "-" : "+"}${Math.abs(periods)}${unit}/${unit}`;
}

/** Both ends as offsets from now when they share one family and no rounding. */
function plainOffsets(
  range: TextRange,
): { from: number; to: number; family: "s" | "d" | "M" } | null {
  const from = parseRelative(range.from);
  const to = parseRelative(range.to);
  if (from === null || to === null || from.round !== undefined || to.round !== undefined) {
    return null;
  }
  const families = new Set([...from.steps, ...to.steps].map((s) => FAMILY[s.unit].family));
  if (families.size > 1) {
    return null;
  }
  const family = [...families][0] ?? "s";
  const a = sumIn(from.steps, family);
  const b = sumIn(to.steps, family);
  return a === null || b === null || a >= b ? null : { from: a, to: b, family };
}

/** Both ends rounded to the same unit, as counts of that unit from the current period. */
function roundedOffsets(range: TextRange): { from: number; to: number; unit: Unit } | null {
  const from = parseRelative(range.from);
  const to = parseRelative(range.to);
  const unit = from?.round;
  if (from === null || to === null || unit === undefined || to.round !== unit) {
    return null;
  }
  const a = countsOf(from.steps, unit);
  const b = countsOf(to.steps, unit);
  return a === null || b === null || a > b ? null : { from: a, to: b, unit };
}

function written(from: string | null, to: string | null): TextRange | null {
  return from === null || to === null ? null : { from, to };
}

function absolute(range: TimeRange): TextRange {
  return { from: toStoredAbsolute(range.from), to: toStoredAbsolute(range.to) };
}

/**
 * The range moved by its own length, back (-1) or forward (+1): "the last 6 hours" becomes
 * "6 to 12 hours ago", "today" becomes "yesterday". Null when the range does not resolve.
 */
export function shiftRange(
  range: TextRange,
  direction: -1 | 1,
  now: number,
  settings: TimeSettings = getTimeSettings(),
): TextRange | null {
  const plain = plainOffsets(range);
  if (plain !== null) {
    const span = (plain.to - plain.from) * direction;
    const moved = written(
      writeOffset(plain.from + span, plain.family),
      writeOffset(plain.to + span, plain.family),
    );
    if (moved !== null) {
      return moved;
    }
  }
  const rounded = roundedOffsets(range);
  if (rounded !== null) {
    const span = (rounded.to - rounded.from + 1) * direction;
    const moved = written(
      writeRounded(rounded.from + span, rounded.unit),
      writeRounded(rounded.to + span, rounded.unit),
    );
    if (moved !== null) {
      return moved;
    }
  }
  const resolved = resolveRange(range, now, settings);
  if (!resolved.ok) {
    return null;
  }
  // Absolute ends: the same length, rounded to the millisecond after the end it shares.
  const length = resolved.range.to - resolved.range.from + (isRoundedEnd(range.to) ? 1 : 0);
  return absolute({
    from: resolved.range.from + direction * length,
    to: resolved.range.to + direction * length,
  });
}

function isRoundedEnd(text: string): boolean {
  return parseRelative(text)?.round !== undefined;
}

/**
 * The range twice as long. A range that ends now keeps ending now and reaches back twice as far;
 * other ranges grow on both sides, but never past now when they ended before it. Rounded ranges
 * add as many whole periods before them ("this week" becomes "last week and this week").
 */
export function zoomOutRange(
  range: TextRange,
  now: number,
  settings: TimeSettings = getTimeSettings(),
): TextRange | null {
  const plain = plainOffsets(range);
  if (plain !== null) {
    const span = plain.to - plain.from;
    let from = plain.from - span;
    let to = plain.to;
    if (plain.to !== 0) {
      const before = Math.floor(span / 2);
      from = plain.from - before;
      to = plain.to + (span - before);
      if (plain.to < 0 && to > 0) {
        from -= to;
        to = 0;
      }
    }
    const wider = written(writeOffset(from, plain.family), writeOffset(to, plain.family));
    if (wider !== null) {
      return wider;
    }
  }
  const rounded = roundedOffsets(range);
  if (rounded !== null) {
    const periods = rounded.to - rounded.from + 1;
    const wider = written(
      writeRounded(rounded.from - periods, rounded.unit),
      writeRounded(rounded.to, rounded.unit),
    );
    if (wider !== null) {
      return wider;
    }
  }
  const resolved = resolveRange(range, now, settings);
  if (!resolved.ok) {
    return null;
  }
  const span = resolved.range.to - resolved.range.from;
  let from = resolved.range.from - Math.floor(span / 2);
  let to = resolved.range.to + Math.ceil(span / 2);
  if (resolved.range.to <= now && to > now) {
    from -= to - now;
    to = now;
  }
  return absolute({ from, to });
}

/** A range as copied to the clipboard: JSON with `from` and `to`, as stored. */
export function rangeToClipboard(range: TextRange): string {
  return JSON.stringify({ from: range.from.trim(), to: range.to.trim() });
}

/**
 * A range from the clipboard: the JSON `rangeToClipboard` writes, or two times on one line
 * separated by " to ", an en dash or a comma. Null when it is not a range Kalzit can store.
 */
export function rangeFromClipboard(text: string, now: number): TextRange | null {
  let candidate: TextRange | null = null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as { from?: unknown }).from === "string" &&
      typeof (parsed as { to?: unknown }).to === "string"
    ) {
      const { from, to } = parsed as TextRange;
      candidate = { from: from.trim(), to: to.trim() };
    }
  } catch {
    const parts = text.trim().split(/\s+to\s+|\s*[–,]\s*/);
    if (parts.length === 2 && parts[0] !== undefined && parts[1] !== undefined) {
      candidate = { from: parts[0], to: parts[1] };
    }
  }
  if (candidate === null || !resolveRange(candidate, now).ok) {
    return null;
  }
  // Absolute times are stored in UTC, as the picker stores them.
  const store = (text: string) => {
    if (isRelative(text) || /(Z|[+-]\d{2}:\d{2})$/.test(text) || /^\d{4}-\d{2}-\d{2}$/.test(text)) {
      return text;
    }
    const time = resolveTime(text, now);
    return time === null ? text : toStoredAbsolute(time);
  };
  return { from: store(candidate.from), to: store(candidate.to) };
}

/** Lengths as dashboards store them ("30s", "5m", "1h", "1d"), in seconds. */
const DURATION_SECONDS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86_400 };

/** "5m" in seconds; null when it is not one to five digits and s, m, h or d. */
export function parseDuration(text: string): number | null {
  const match = /^(\d{1,5})([smhd])$/.exec(text.trim());
  if (match === null) {
    return null;
  }
  const count = Number(match[1]);
  return count > 0 ? count * (DURATION_SECONDS[match[2] as string] ?? 1) : null;
}

/** Seconds as the shortest even length: 90 is "90s", 300 is "5m", 3600 is "1h". */
export function formatDuration(seconds: number): string {
  for (const unit of ["d", "h", "m"] as const) {
    const size = DURATION_SECONDS[unit] ?? 1;
    if (seconds % size === 0) {
      return `${seconds / size}${unit}`;
    }
  }
  return `${seconds}s`;
}
