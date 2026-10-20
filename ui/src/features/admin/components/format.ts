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

/** The last millisecond of that day in local time, so "to" includes the whole day. */
export function endOfDay(date: string): number | undefined {
  const start = startOfDay(date);
  if (start === undefined) {
    return undefined;
  }
  const next = new Date(start);
  next.setDate(next.getDate() + 1);
  return next.getTime() - 1;
}
