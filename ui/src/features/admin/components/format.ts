import type { Language } from "../../../i18n/i18n";
import { zoneOption } from "../../../lib/timeSettings";
import { fromWall } from "../../../lib/zonedTime";

/** A point in time (Unix milliseconds) as date and time in the user's language. */
export function formatDateTime(ms: number, language: Language, zone: string | null): string {
  return new Intl.DateTimeFormat(language, {
    dateStyle: "medium",
    timeStyle: "short",
    ...zoneOption(zone),
  }).format(new Date(ms));
}

/** A setting value or audit summary as compact text. */
export function formatValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === undefined) {
    return "";
  }
  return JSON.stringify(value);
}

const MIDNIGHT = { hour: 0, minute: 0, second: 0, millisecond: 0 };

/** `yyyy-mm-dd` from a date input, as the start of that day in `zone` (Unix ms). */
export function startOfDay(date: string, zone: string | null): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (match === null) {
    return undefined;
  }
  return fromWall(
    { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]), ...MIDNIGHT },
    zone,
  );
}

/**
 * The start of the day after, in `zone`: the server's `to` is exclusive, so this includes the
 * whole chosen day (23 or 25 hours on a daylight saving change).
 */
export function startOfNextDay(date: string, zone: string | null): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (match === null) {
    return undefined;
  }
  return fromWall(
    { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) + 1, ...MIDNIGHT },
    zone,
  );
}

/** An audit summary (ids and changed field names) as short readable text. */
export function formatSummary(summary: Record<string, unknown>): string {
  return Object.entries(summary)
    .map(([key, value]) => {
      const text = Array.isArray(value)
        ? value.map((item) => (typeof item === "string" ? item : JSON.stringify(item))).join(", ")
        : formatValue(value);
      return `${key}: ${text}`;
    })
    .join(" · ");
}
