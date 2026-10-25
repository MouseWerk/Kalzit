import type { Field, FieldType, Frame } from "../api/generated/shapes";
import { getTimeZone, zoneOption } from "../lib/timeSettings";
import { fromWall, wallOf } from "../lib/zonedTime";

/**
 * Reading frames (docs/ARCHITECTURE.md, result envelope): `time` is Unix ms, `int64` and
 * `decimal` arrive as decimal strings so they stay exact, a `date` is the ms of its midnight UTC,
 * and a missing value is `null`.
 */

/** Times and days: fields that can be a time axis. */
export function isTimeType(type: FieldType): boolean {
  return type === "time" || type === "date";
}

/** Numbers, int64 and decimal text: fields drawn and computed as numbers. */
export function isNumeric(type: FieldType): boolean {
  return type === "number" || type === "int64" || type === "decimal";
}

// Date fields as time fields at each day's midnight on the wall clock, per zone, so a chart puts
// a day on that day in every time zone; kept with the field so a panel drawn again gets the same.
const dayFields = new WeakMap<Field, Map<string, Field>>();

/** A date field as a time field at each day's midnight in `zone` (null: the browser's). */
export function dayStarts(field: Field, zone: string | null = getTimeZone()): Field {
  let byZone = dayFields.get(field);
  if (byZone === undefined) {
    byZone = new Map();
    dayFields.set(field, byZone);
  }
  const key = zone ?? "";
  let converted = byZone.get(key);
  if (converted === undefined) {
    const values = field.values.map((v) => {
      if (typeof v !== "number" || !Number.isFinite(v)) return null;
      const day = wallOf(v, "UTC");
      return fromWall({ ...day, hour: 0, minute: 0, second: 0, millisecond: 0 }, zone);
    });
    converted = { ...field, type: "time", values };
    byZone.set(key, converted);
  }
  return converted;
}

/**
 * The frame's time axis: its first time field, or its first date field with each day at its
 * midnight in the zone in effect.
 */
export function timeField(frame: Frame): Field | undefined {
  const field = frame.fields.find((f) => f.type === "time" || f.type === "date");
  return field?.type === "date" ? dayStarts(field) : field;
}

/** Fields that can be drawn as values. */
export function valueFields(frame: Frame): Field[] {
  return frame.fields.filter((field) => isNumeric(field.type));
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

/**
 * The reference id of the query each frame answered, kept beside the bare frames panels get:
 * passing it in the panel props would change every panel and the editor for one name, and a weak
 * map keeps it with the frame object without copying it (docs/ARCHITECTURE.md, series names).
 */
const frameNames = new WeakMap<Frame, string>();

export function nameFrame(frame: Frame, name: string): void {
  frameNames.set(frame, name);
}

export function frameName(frame: Frame): string | undefined {
  return frameNames.get(frame);
}

export interface NamedSeries {
  /** The name as written: display name, template or field name with labels. */
  name: string;
  field: Field;
  /** The reference id of the series' query, when known. */
  refId?: string;
  /** Set by the author (display name or name template): kept as it is. */
  fixed: boolean;
}

/** The field name without a label part: "cpu" of "cpu{host="a"}", "" of "{host="a"}". */
function baseName(name: string): string {
  const brace = name.indexOf("{");
  return (brace === -1 ? name : name.slice(0, brace)).trim();
}

/**
 * Names that tell the series of a panel apart. Series with labels are named by the label values
 * that differ between them ("node-a:9100" instead of `{instance="node-a:9100", job="node"}`), with
 * the metric name in front when there is one. Names that are still equal get their query's
 * reference id ("amount (B)"), or a number when the queries are the same. Names the author set
 * stay as they are.
 */
export function distinctSeriesNames(series: readonly NamedSeries[]): string[] {
  const names = series.map((s) => s.name);
  const open = series.flatMap((s, index) => (s.fixed ? [] : [index]));
  const labelled = open.filter((i) => {
    const labels = series[i]?.field.labels ?? {};
    return Object.keys(labels).some((key) => key !== "__name__");
  });
  if (labelled.length > 1) {
    const keys = new Set(labelled.flatMap((i) => Object.keys(series[i]?.field.labels ?? {})));
    keys.delete("__name__");
    const varying = [...keys].filter(
      (key) => new Set(labelled.map((i) => series[i]?.field.labels?.[key] ?? "")).size > 1,
    );
    if (varying.length > 0) {
      for (const i of labelled) {
        const entry = series[i] as NamedSeries;
        const values = varying.map((key) => entry.field.labels?.[key] ?? "").filter((v) => v);
        const base = entry.field.labels?.__name__ ?? baseName(entry.field.name);
        names[i] = [base, values.join(", ")].filter((part) => part !== "").join(" ");
      }
    }
  }
  const groups = new Map<string, number[]>();
  for (const i of open) {
    const name = names[i] as string;
    groups.set(name, [...(groups.get(name) ?? []), i]);
  }
  for (const [name, members] of groups) {
    if (members.length < 2) continue;
    const refIds = members.map((i) => series[i]?.refId);
    const byRef = refIds.every((r) => r !== undefined) && new Set(refIds).size === members.length;
    members.forEach((i, n) => {
      names[i] = `${name} (${byRef ? refIds[n] : n + 1})`;
    });
  }
  return names;
}

/**
 * "cpu{host="a"}": the field name with its series labels, as a series is usually written. A name
 * that already carries them (Prometheus fields are named so) is kept. With a legend template,
 * `{{label}}` is replaced by that label's value, `{{__name__}}` by the field name.
 */
export function seriesName(field: Field, legend = ""): string {
  if (legend.trim() !== "") {
    return legend.replace(/\{\{\s*([\w:]+)\s*\}\}/g, (_, label: string) =>
      label === "__name__" ? (field.labels?.__name__ ?? field.name) : (field.labels?.[label] ?? ""),
    );
  }
  const labels = Object.entries(field.labels ?? {}).filter(([key]) => key !== "__name__");
  if (labels.length === 0 || field.name.includes("{")) {
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

export function dateTimeFormat(language: string, zone: string | null): Intl.DateTimeFormat {
  const key = `${language}|${zone ?? ""}`;
  let format = dateFormats.get(key);
  if (format === undefined) {
    format = new Intl.DateTimeFormat(language, {
      dateStyle: "short",
      timeStyle: "medium",
      ...zoneOption(zone),
    });
    dateFormats.set(key, format);
  }
  return format;
}

const dayFormats = new Map<string, Intl.DateTimeFormat>();

/** A day as the language writes dates, read in UTC so it never moves to the day before. */
function dayFormat(language: string): Intl.DateTimeFormat {
  let format = dayFormats.get(language);
  if (format === undefined) {
    format = new Intl.DateTimeFormat(language, { dateStyle: "short", timeZone: "UTC" });
    dayFormats.set(language, format);
  }
  return format;
}

/** Fraction digits up to which a decimal keeps the zeros its scale gives it. */
const MAX_SHOWN_SCALE = 6;

/**
 * Decimal text with the language's grouping and decimal sign, every digit kept: "-1234.50" is
 * "-1.234,50" in German. Above a scale of six, zeros at the end are left out (fixed decimals in
 * the field options format the value instead).
 */
function formatDecimal(value: unknown, language: string): string {
  const text = String(value);
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (match === null) return text;
  const [, sign, whole, scaled] = match;
  // A short scale is part of the value's form (12.50 money stays 12.50); a long one (a NUMERIC
  // with scale 10) would pad every value with zeros, so those are trimmed.
  const fraction =
    scaled !== undefined && scaled.length > MAX_SHOWN_SCALE
      ? scaled.replace(/0+$/, "") || undefined
      : scaled;
  const grouped = formatInt64(whole, language);
  if (fraction === undefined) return `${sign}${grouped}`;
  const point =
    numberFormat(language)
      .formatToParts(1.5)
      .find((p) => p.type === "decimal")?.value ?? ".";
  return `${sign}${grouped}${point}${fraction}`;
}

/** int64 digits grouped as the language groups numbers, every digit kept. */
function formatInt64(value: unknown, language: string): string {
  try {
    return BigInt(String(value)).toLocaleString(language);
  } catch {
    return String(value);
  }
}

/** A value as text: null is empty, int64 keeps every digit, numbers follow the language. */
export function formatValue(
  type: FieldType,
  value: unknown,
  language: string,
  zone: string | null = getTimeZone(),
): string {
  if (value === null || value === undefined) {
    return "";
  }
  switch (type) {
    case "int64":
      return formatInt64(value, language);
    case "decimal":
      return formatDecimal(value, language);
    case "date":
      return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 8.64e15
        ? dayFormat(language).format(value)
        : String(value);
    case "number":
      return typeof value === "number" ? numberFormat(language).format(value) : String(value);
    case "time":
      // Beyond 8.64e15 ms (a "never expires" sentinel) JavaScript has no date: the number shows.
      return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 8.64e15
        ? dateTimeFormat(language, zone).format(value)
        : String(value);
    case "json":
      return JSON.stringify(value);
    default:
      return String(value);
  }
}

/** An int64 value as a BigInt, for exact comparison; null when it is not a decimal string. */
export function int64Key(value: unknown): bigint | null {
  if (typeof value !== "string" && typeof value !== "number") {
    return null;
  }
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

/** Sort order for one column of values (int64 already turned into BigInt keys). */
export function compareValues(type: FieldType, a: unknown, b: unknown): number {
  if (typeof a === "bigint" && typeof b === "bigint") {
    return a < b ? -1 : a > b ? 1 : 0;
  }
  if (typeof a === "number" && typeof b === "number") {
    return a - b;
  }
  if (typeof a === "boolean" && typeof b === "boolean") {
    return Number(a) - Number(b);
  }
  if (type === "decimal") {
    const x = toNumber(a);
    const y = toNumber(b);
    if (x !== null && y !== null) return x - y;
  }
  return String(type === "json" ? JSON.stringify(a) : a).localeCompare(
    String(type === "json" ? JSON.stringify(b) : b),
  );
}
