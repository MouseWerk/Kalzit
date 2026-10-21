import type { Field, FieldType, Frame } from "../api/generated/shapes";

/**
 * Reading frames (docs/ARCHITECTURE.md, result envelope): `time` is Unix ms, `int64` arrives as a
 * decimal string so it stays exact, and a missing value is `null`.
 */

export function timeField(frame: Frame): Field | undefined {
  return frame.fields.find((field) => field.type === "time");
}

/** Fields that can be drawn as values. */
export function valueFields(frame: Frame): Field[] {
  return frame.fields.filter((field) => field.type === "number" || field.type === "int64");
}

export function rowCount(frame: Frame): number {
  return frame.fields[0]?.values.length ?? 0;
}

/**
 * A value as a number for drawing. int64 strings become the nearest double: exact enough for a
 * pixel, while tables and stats show the original digits.
 */
export function toNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string" && value !== "") {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }
  return null;
}

/** "cpu{host="a"}": the field name with its series labels, as a series is usually written. */
export function seriesName(field: Field): string {
  const labels = Object.entries(field.labels ?? {}).filter(([key]) => key !== "__name__");
  if (labels.length === 0) {
    return field.name;
  }
  const text = labels.map(([key, value]) => `${key}="${value}"`).join(", ");
  return `${field.name}{${text}}`;
}

const numberFormats = new Map<string, Intl.NumberFormat>();
const dateFormats = new Map<string, Intl.DateTimeFormat>();

function numberFormat(language: string): Intl.NumberFormat {
  let format = numberFormats.get(language);
  if (format === undefined) {
    format = new Intl.NumberFormat(language, { maximumFractionDigits: 6 });
    numberFormats.set(language, format);
  }
  return format;
}

export function dateTimeFormat(language: string): Intl.DateTimeFormat {
  let format = dateFormats.get(language);
  if (format === undefined) {
    format = new Intl.DateTimeFormat(language, { dateStyle: "short", timeStyle: "medium" });
    dateFormats.set(language, format);
  }
  return format;
}

/** A value as text: null is empty, int64 keeps every digit, numbers follow the language. */
export function formatValue(type: FieldType, value: unknown, language: string): string {
  if (value === null || value === undefined) {
    return "";
  }
  switch (type) {
    case "int64":
      return String(value);
    case "number":
      return typeof value === "number" ? numberFormat(language).format(value) : String(value);
    case "time":
      return typeof value === "number" ? dateTimeFormat(language).format(value) : String(value);
    case "json":
      return JSON.stringify(value);
    default:
      return String(value);
  }
}

function compareInt64(a: string, b: string): number {
  try {
    const left = BigInt(a);
    const right = BigInt(b);
    return left < right ? -1 : left > right ? 1 : 0;
  } catch {
    return a.localeCompare(b);
  }
}

/** Sort order for one column; nulls always go last, whatever the direction. */
export function compareValues(type: FieldType, a: unknown, b: unknown): number {
  if (type === "int64" && typeof a === "string" && typeof b === "string") {
    return compareInt64(a, b);
  }
  if (typeof a === "number" && typeof b === "number") {
    return a - b;
  }
  if (typeof a === "boolean" && typeof b === "boolean") {
    return Number(a) - Number(b);
  }
  return String(type === "json" ? JSON.stringify(a) : a).localeCompare(
    String(type === "json" ? JSON.stringify(b) : b),
  );
}
