/**
 * The unit catalog of the field options: how a number is written with its unit, per language.
 * Numbers go through Intl (grouping, decimal sign, currency position), symbols are the SI and
 * IEC ones and stay the same in every language. A unit id the catalog does not know is shown as
 * a plain suffix, which is also how units typed by hand before the catalog existed keep working.
 */

export const UNIT_GROUPS = [
  "misc",
  "data",
  "rate",
  "time",
  "currency",
  "energy",
  "temperature",
  "date",
] as const;
export type UnitGroup = (typeof UNIT_GROUPS)[number];

/** A formatted value: the number part and the unit symbol shown after it (may be empty). */
export interface Formatted {
  text: string;
  suffix: string;
}

export interface UnitDef {
  id: string;
  group: UnitGroup;
  /** Symbol shown in the picker next to the name; empty for units without one. */
  symbol: string;
  format: (value: number, decimals: number | undefined, language: string) => Formatted;
}

/** Longest unit id or custom suffix the model accepts (server: `MAX_UNIT_CHARS`). */
export const MAX_UNIT_CHARS = 40;
export const MAX_DECIMALS = 10;
/** Custom units are stored as `suffix:<text>`, so they never collide with a catalog id. */
export const CUSTOM_PREFIX = "suffix:";

const formats = new Map<string, Intl.NumberFormat>();

function numberFormat(language: string, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = `${language}|${JSON.stringify(options)}`;
  let format = formats.get(key);
  if (format === undefined) {
    format = new Intl.NumberFormat(language, options);
    formats.set(key, format);
  }
  return format;
}

/**
 * Fraction digits when none are set: enough to tell values apart at their size, never a long
 * tail. Below one, three significant digits keep 0.00123 readable.
 */
function autoDigits(value: number): Intl.NumberFormatOptions {
  const abs = Math.abs(value);
  if (abs === 0 || abs >= 100) {
    return { maximumFractionDigits: abs >= 1000 ? 0 : 1 };
  }
  if (abs >= 1) {
    return { maximumFractionDigits: 2 };
  }
  return { maximumSignificantDigits: 3 };
}

function digits(value: number, decimals: number | undefined): Intl.NumberFormatOptions {
  return decimals === undefined
    ? autoDigits(value)
    : { minimumFractionDigits: decimals, maximumFractionDigits: decimals };
}

export function formatNumber(value: number, decimals: number | undefined, language: string): string {
  return numberFormat(language, digits(value, decimals)).format(value);
}

/**
 * Picks the largest step not above the value, so 1536 bytes reads "1.5 KiB". Values below the
 * first step keep it (0.5 B, not 512 mB).
 */
function scaled(steps: readonly [factor: number, symbol: string][]) {
  return (value: number, decimals: number | undefined, language: string): Formatted => {
    const abs = Math.abs(value);
    let chosen = steps[0] as [number, string];
    for (const step of steps) {
      if (abs >= step[0]) {
        chosen = step;
      }
    }
    return { text: formatNumber(value / chosen[0], decimals, language), suffix: chosen[1] };
  };
}

/** A fixed symbol after the number. */
function plain(symbol: string) {
  return (value: number, decimals: number | undefined, language: string): Formatted => ({
    text: formatNumber(value, decimals, language),
    suffix: symbol,
  });
}

const IEC = ["B", "KiB", "MiB", "GiB", "TiB", "PiB", "EiB"];
const SI_BIG = ["", "k", "M", "G", "T", "P", "E"];

function powers(base: number, symbols: readonly string[], unit: string) {
  return symbols.map((prefix, i) => [base ** i, `${prefix}${unit}`] as [number, string]);
}

/** SI prefixes from nano to tera around a base unit (W, V, Hz, ...). */
function siSteps(unit: string): [number, string][] {
  return [
    [1e-9, `n${unit}`],
    [1e-6, `µ${unit}`],
    [1e-3, `m${unit}`],
    [1, unit],
    [1e3, `k${unit}`],
    [1e6, `M${unit}`],
    [1e9, `G${unit}`],
    [1e12, `T${unit}`],
  ];
}

const MS = 1;
const DURATION_STEPS: [number, string][] = [
  [1e-6 * MS, "ns"],
  [1e-3 * MS, "µs"],
  [MS, "ms"],
  [1000 * MS, "s"],
  [60_000 * MS, "min"],
  [3_600_000 * MS, "h"],
  [86_400_000 * MS, "d"],
  [7 * 86_400_000 * MS, "w"],
  [365 * 86_400_000 * MS, "y"],
];

/** A duration given in `factor` milliseconds, written in the largest fitting unit. */
function duration(factor: number) {
  const inMs = scaled(DURATION_STEPS);
  return (value: number, decimals: number | undefined, language: string): Formatted =>
    inMs(value * factor, decimals, language);
}

/** Compact counts: 1.2k ops/s. */
function rate(symbol: string) {
  const steps = powers(1000, SI_BIG, "");
  return (value: number, decimals: number | undefined, language: string): Formatted => {
    const { text, suffix } = scaled(steps)(value, decimals, language);
    return { text: `${text}${suffix}`, suffix: symbol };
  };
}

const CURRENCIES = ["EUR", "USD", "GBP", "CHF", "JPY", "CNY", "SEK", "NOK", "DKK", "PLN", "CZK"];

function currency(code: string) {
  return (value: number, decimals: number | undefined, language: string): Formatted => ({
    text: numberFormat(language, {
      style: "currency",
      currency: code,
      ...(decimals === undefined
        ? {}
        : { minimumFractionDigits: decimals, maximumFractionDigits: decimals }),
    }).format(value),
    suffix: "",
  });
}

const relativeFormats = new Map<string, Intl.RelativeTimeFormat>();

/** "3 hours ago" / "vor 3 Stunden", from a Unix ms time. */
export function fromNow(time: number, language: string, now = Date.now()): string {
  let format = relativeFormats.get(language);
  if (format === undefined) {
    format = new Intl.RelativeTimeFormat(language, { numeric: "auto" });
    relativeFormats.set(language, format);
  }
  const seconds = (time - now) / 1000;
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 365 * 86_400],
    ["month", 30 * 86_400],
    ["week", 7 * 86_400],
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
    ["second", 1],
  ];
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size || unit === "second") {
      return format.format(Math.round(seconds / size), unit);
    }
  }
  return "";
}

const dateTimes = new Map<string, Intl.DateTimeFormat>();

function dateTime(language: string): Intl.DateTimeFormat {
  let format = dateTimes.get(language);
  if (format === undefined) {
    format = new Intl.DateTimeFormat(language, { dateStyle: "short", timeStyle: "medium" });
    dateTimes.set(language, format);
  }
  return format;
}

/** A value from 0 to 100, written as the language writes percent ("45 %" in German). */
function percent(value: number, decimals: number | undefined, language: string): Formatted {
  return {
    text: numberFormat(language, { style: "percent", ...digits(value, decimals) }).format(
      value / 100,
    ),
    suffix: "",
  };
}

function unit(id: string, group: UnitGroup, symbol: string, format: UnitDef["format"]): UnitDef {
  return { id, group, symbol, format };
}

export const UNITS: readonly UnitDef[] = [
  unit("none", "misc", "", plain("")),
  unit("short", "misc", "k, M", (value, decimals, language) => ({
    text: numberFormat(language, {
      notation: "compact",
      ...(decimals === undefined ? { maximumFractionDigits: 1 } : digits(value, decimals)),
    }).format(value),
    suffix: "",
  })),
  // percent takes 0 to 100, percentunit 0 to 1; both are written as the language writes "%".
  unit("percent", "misc", "%", percent),
  unit("percentunit", "misc", "%", (value, decimals, language) =>
    percent(value * 100, decimals, language),
  ),
  unit("ppm", "misc", "ppm", plain("ppm")),
  unit("bytes", "data", "B, KiB", scaled(powers(1024, IEC, ""))),
  unit("decbytes", "data", "B, kB", scaled(powers(1000, SI_BIG, "B"))),
  unit("bits", "data", "b, kb", scaled(powers(1000, SI_BIG, "b"))),
  unit("bytesps", "rate", "B/s", scaled(powers(1024, IEC, "").map(([f, s]) => [f, `${s}/s`]))),
  unit("bitsps", "rate", "b/s", scaled(powers(1000, SI_BIG, "b/s"))),
  unit("ops", "rate", "ops/s", rate("ops/s")),
  unit("reqps", "rate", "req/s", rate("req/s")),
  unit("rpm", "rate", "req/min", rate("req/min")),
  unit("ns", "time", "ns", duration(1e-6)),
  unit("us", "time", "µs", duration(1e-3)),
  unit("ms", "time", "ms", duration(1)),
  unit("s", "time", "s", duration(1000)),
  unit("m", "time", "min", duration(60_000)),
  unit("h", "time", "h", duration(3_600_000)),
  unit("d", "time", "d", duration(86_400_000)),
  ...CURRENCIES.map((code) => unit(`currency:${code}`, "currency", code, currency(code))),
  unit("watt", "energy", "W", scaled(siSteps("W"))),
  unit("watthour", "energy", "Wh", scaled(siSteps("Wh"))),
  unit("volt", "energy", "V", scaled(siSteps("V"))),
  unit("ampere", "energy", "A", scaled(siSteps("A"))),
  unit("hertz", "energy", "Hz", scaled(siSteps("Hz"))),
  unit("celsius", "temperature", "°C", plain("°C")),
  unit("fahrenheit", "temperature", "°F", plain("°F")),
  unit("kelvin", "temperature", "K", plain("K")),
  unit("dateTime", "date", "", (value, _decimals, language) => ({
    text: dateTime(language).format(value),
    suffix: "",
  })),
  unit("dateIso", "date", "", (value) => ({
    text: Number.isFinite(value) ? new Date(value).toISOString() : "",
    suffix: "",
  })),
  unit("fromNow", "date", "", (value, _decimals, language) => ({
    text: fromNow(value, language),
    suffix: "",
  })),
];

const BY_ID = new Map(UNITS.map((u) => [u.id, u]));

export function unitDef(id: string): UnitDef | undefined {
  return BY_ID.get(id);
}

/** Whether the id is a catalog unit; anything else is shown as a suffix. */
export function isCatalogUnit(id: string): boolean {
  return BY_ID.has(id);
}

/** The custom suffix of a unit id, or the id itself when it is no catalog unit. */
export function customSuffix(id: string): string {
  return id.startsWith(CUSTOM_PREFIX) ? id.slice(CUSTOM_PREFIX.length) : id;
}

/** A number with its unit. An empty or unknown unit id falls back to a plain suffix. */
export function formatUnit(
  value: number,
  unitId: string | undefined,
  decimals: number | undefined,
  language: string,
): Formatted {
  if (!Number.isFinite(value)) {
    return { text: "", suffix: "" };
  }
  const def = unitId === undefined || unitId === "" ? undefined : BY_ID.get(unitId);
  if (def !== undefined) {
    return def.format(value, decimals, language);
  }
  return {
    text: formatNumber(value, decimals, language),
    suffix: unitId === undefined ? "" : customSuffix(unitId),
  };
}

/** Value and unit as one string, joined with a no-break space so they never wrap apart. */
export function joinFormatted({ text, suffix }: Formatted): string {
  return suffix === "" || text === "" ? text : `${text} ${suffix}`;
}
