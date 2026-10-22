import { getTimeZone } from "./timeSettings";

/**
 * Wall-clock time in the user's time zone (the preference, or the browser's when none is chosen),
 * so rounding to a day or week, axis ticks and typed times all use the zone the screen shows.
 * `zone` defaults to the preference; `null` is the browser's own zone.
 */
export interface Wall {
  year: number;
  /** 1 to 12. */
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(zone: string): Intl.DateTimeFormat {
  let format = formatters.get(zone);
  if (format === undefined) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(zone, format);
  }
  return format;
}

/** The wall-clock reading of `ms` in `zone`. */
export function wallOf(ms: number, zone: string | null = getTimeZone()): Wall {
  if (zone === null) {
    const d = new Date(ms);
    return {
      year: d.getFullYear(),
      month: d.getMonth() + 1,
      day: d.getDate(),
      hour: d.getHours(),
      minute: d.getMinutes(),
      second: d.getSeconds(),
      millisecond: d.getMilliseconds(),
    };
  }
  const parts: Record<string, number> = {};
  for (const part of formatter(zone).formatToParts(new Date(ms))) {
    if (part.type !== "literal") {
      parts[part.type] = Number(part.value);
    }
  }
  return {
    year: parts.year ?? 1970,
    month: parts.month ?? 1,
    day: parts.day ?? 1,
    // Some engines write midnight as 24 even with h23.
    hour: (parts.hour ?? 0) % 24,
    minute: parts.minute ?? 0,
    second: parts.second ?? 0,
    millisecond: ((ms % 1000) + 1000) % 1000,
  };
}

function utcOf(w: Wall): number {
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second, w.millisecond);
}

/** Fields that ran over (day 0, month 13, hour 24) carried into the next larger one, as Date does. */
export function normalizeWall(w: Wall): Wall {
  const d = new Date(utcOf(w));
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
    millisecond: d.getUTCMilliseconds(),
  };
}

/**
 * The instant a wall-clock time names in `zone`; fields may run over. A time that a daylight
 * saving change skips moves forward by the skipped hour, as the browser's own Date does; one that
 * occurs twice is the first of the two.
 */
export function fromWall(w: Wall, zone: string | null = getTimeZone()): number {
  if (zone === null) {
    return new Date(
      w.year,
      w.month - 1,
      w.day,
      w.hour,
      w.minute,
      w.second,
      w.millisecond,
    ).getTime();
  }
  const wanted = utcOf(w);
  const offsetAt = (t: number) => utcOf(wallOf(t, zone)) - t;
  // Two candidates, with the offset a day before and a day after; the earlier one that reads back
  // as wanted wins.
  const before = wanted - offsetAt(wanted - 86_400_000);
  const after = wanted - offsetAt(wanted + 86_400_000);
  const reads = (t: number) => utcOf(wallOf(t, zone)) === wanted;
  const first = Math.min(before, after);
  const second = Math.max(before, after);
  if (reads(first)) return first;
  if (reads(second)) return second;
  // In a gap: the offset from before the change carries the time past it, as Date does.
  return before;
}

/** 0 for Sunday to 6 for Saturday, as `Date.getDay()` counts. */
export function weekdayOf(w: Wall): number {
  return new Date(Date.UTC(w.year, w.month - 1, w.day)).getUTCDay();
}

/** The wall clock of `ms` as "2026-10-20T08:00", for a datetime-local input. */
export function wallInput(ms: number, zone: string | null = getTimeZone()): string {
  const w = wallOf(ms, zone);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${w.year}-${pad(w.month)}-${pad(w.day)}T${pad(w.hour)}:${pad(w.minute)}`;
}
