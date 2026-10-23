import type { Field, FieldType, Frame } from "../api/generated/shapes";
import { getTimeZone, zoneOption } from "../lib/timeSettings";

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
  return String(type === "json" ? JSON.stringify(a) : a).localeCompare(
    String(type === "json" ? JSON.stringify(b) : b),
  );
}
