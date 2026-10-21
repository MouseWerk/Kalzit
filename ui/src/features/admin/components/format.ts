import type { Language } from "../../../i18n/i18n";

/** A point in time (Unix milliseconds) as date and time in the user's language. */
export function formatDateTime(ms: number, language: Language): string {
  return new Intl.DateTimeFormat(language, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(ms),
  );
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

/** `yyyy-mm-dd` from a date input, as the start of that day in local time (Unix ms). */
export function startOfDay(date: string): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (match === null) {
    return undefined;
  }
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime();
}

/**
 * The start of the day after, in local time: the server's `to` is exclusive, so this includes the
 * whole chosen day.
 */
export function startOfNextDay(date: string): number | undefined {
  const start = startOfDay(date);
  if (start === undefined) {
    return undefined;
  }
  const next = new Date(start);
  next.setDate(next.getDate() + 1);
  return next.getTime();
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
