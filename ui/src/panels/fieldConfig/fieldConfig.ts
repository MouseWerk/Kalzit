import { isRecord } from "../../api/client";
import type { Field, FieldType } from "../../api/generated/shapes";
import { getTimeZone } from "../../lib/timeSettings";
import { formatValue, isNumeric, seriesName, toNumber } from "../frame";
import {
  CUSTOM_PREFIX,
  customSuffix,
  formatUnit,
  isCatalogUnit,
  joinFormatted,
  MAX_DECIMALS,
  MAX_UNIT_CHARS,
} from "./units";
import "../viz.css";
import { GRAPH_STYLE_KEYS, type GraphStyleOptions, parseGraphStyle } from "./graphStyle";
import { compilePattern } from "./pattern";

export { compilePattern } from "./pattern";

/**
 * The shared field options of frame panels, stored in the panel's `fieldConfig`: defaults for
 * every field and overrides for fields matched by name or pattern. The server checks the same
 * shape and bounds (`server/src/dashboards/panel_options.rs`); the limits below mirror it.
 */

/** Colors a threshold or a mapping can give: states first, then the chart palette. */
export const TONES = [
  "ok",
  "warn",
  "critical",
  "neutral",
  "chart-1",
  "chart-2",
  "chart-3",
  "chart-4",
  "chart-5",
  "chart-6",
  "chart-7",
  "chart-8",
] as const;
export type Tone = (typeof TONES)[number];

/** A free colour as stored: `#` and six hex digits, lower case. */
export type HexColor = `#${string}`;

/**
 * A colour as the options store it: a theme tone, which follows light, dark and contrast themes,
 * or a free colour the user picked (`#rrggbb`), which stays the same in every theme.
 */
export type ColorValue = Tone | HexColor;

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

export function isHexColor(value: unknown): value is HexColor {
  return typeof value === "string" && HEX_COLOR.test(value);
}

/** A stored colour, or undefined when it is neither a tone nor a free colour. */
export function colorValueOf(value: unknown): ColorValue | undefined {
  if (isTone(value)) return value;
  return isHexColor(value) ? (value.toLowerCase() as HexColor) : undefined;
}

/**
 * How series without a colour of their own are coloured: the categorical palette, one colour for
 * all, the threshold colours, or steps along a ramp (green to red, blues, grays).
 */
export const COLOR_SCHEMES = [
  "palette",
  "single",
  "thresholds",
  "greenYellowRed",
  "blues",
  "grays",
] as const;
export type ColorScheme = (typeof COLOR_SCHEMES)[number];

/** The tone of a stored colour; a free colour has none (panels that only know tones). */
export function toneOf(color: ColorValue | undefined): Tone | undefined {
  return isHexColor(color) ? undefined : color;
}

/** Whether the time series draws its thresholds, and how. */
export const THRESHOLD_DISPLAYS = ["off", "lines", "areas", "linesAndAreas"] as const;
export type ThresholdDisplay = (typeof THRESHOLD_DISPLAYS)[number];

export const CELL_DISPLAYS = ["auto", "color-text", "color-background", "gauge", "link"] as const;
export type CellDisplay = (typeof CELL_DISPLAYS)[number];

export interface ThresholdStep {
  /** null for the base step, which holds from minus infinity. */
  value: number | null;
  tone: Tone;
  /** A free colour for the step; panels that only know tones use the tone. */
  color?: HexColor;
}

export interface Thresholds {
  /** `percentage` compares where the value lies between min and max, 0 to 100. */
  mode: "absolute" | "percentage";
  steps: ThresholdStep[];
}

export type ValueMapping =
  | { type: "value"; value: string; text?: string; tone?: Tone }
  | { type: "range"; from: number | null; to: number | null; text?: string; tone?: Tone }
  | { type: "regex"; pattern: string; text?: string; tone?: Tone };

/** Field options; the graph style keys only matter to the time series (`graphStyle.ts`). */
export interface FieldOptions extends GraphStyleOptions {
  /** A catalog unit id (`bytes`, `currency:EUR`) or `suffix:<text>`. */
  unit?: string;
  decimals?: number;
  min?: number;
  max?: number;
  thresholds?: Thresholds;
  mappings?: ValueMapping[];
  /** Shown where a field has no value. */
  noValue?: string;
  /** Replaces the field's name in legends, headers and readouts. */
  displayName?: string;
  /** A fixed colour for the field's series: a tone or a free colour. */
  color?: ColorValue;
  /** How series without a colour of their own are coloured; unset is the palette. */
  colorScheme?: ColorScheme;
  /** The series' own opacity in percent (line, points, bars); the fill has its own. */
  opacity?: number;
  /** Time series: draw the thresholds as lines, areas or both; unset is off. */
  thresholdDisplay?: ThresholdDisplay;
  /** Tables: how cells of the field are drawn. */
  cellDisplay?: CellDisplay;
  /** Tables: a link for every cell; `${__value}` is the cell's value, URL-encoded. */
  link?: string;
  /** Tables: column width in px. */
  width?: number;
}

export interface FieldMatcher {
  type: "name" | "regex";
  value: string;
}

/** An override's properties: a value sets it, `null` clears what the defaults set. */
export type OverrideProperties = { [K in keyof FieldOptions]?: FieldOptions[K] | null };

export interface FieldOverride {
  matcher: FieldMatcher;
  properties: OverrideProperties;
}

/** The option names, for clearing and resetting them one by one. */
export const OPTION_KEYS = [
  "unit",
  "decimals",
  "min",
  "max",
  "thresholds",
  "mappings",
  "noValue",
  "displayName",
  "color",
  "colorScheme",
  "opacity",
  "thresholdDisplay",
  "cellDisplay",
  "link",
  "width",
  ...GRAPH_STYLE_KEYS,
] as const satisfies readonly (keyof FieldOptions)[];

export interface FieldConfig {
  defaults: FieldOptions;
  overrides: FieldOverride[];
}

export const LIMITS = {
  unitChars: MAX_UNIT_CHARS,
  decimals: MAX_DECIMALS,
  thresholdSteps: 20,
  mappings: 100,
  overrides: 50,
  textChars: 200,
  noValueChars: 100,
  linkChars: 2000,
  minWidth: 40,
  maxWidth: 1000,
} as const;

export const EMPTY_FIELD_CONFIG: FieldConfig = { defaults: {}, overrides: [] };

/** The thresholds a new gauge or bar gauge starts with: fine up to 80, critical above. */
export const DEFAULT_THRESHOLDS: Thresholds = {
  mode: "absolute",
  steps: [
    { value: null, tone: "ok" },
    { value: 80, tone: "critical" },
  ],
};

function isTone(value: unknown): value is Tone {
  return (TONES as readonly unknown[]).includes(value);
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function text(value: unknown, max: number): string | undefined {
  return typeof value === "string" ? value.slice(0, max) : undefined;
}

function parseThresholds(value: unknown): Thresholds | undefined {
  if (!isRecord(value) || !Array.isArray(value.steps)) {
    return undefined;
  }
  const steps: ThresholdStep[] = [];
  for (const raw of value.steps.slice(0, LIMITS.thresholdSteps)) {
    if (!isRecord(raw) || !isTone(raw.tone)) {
      continue;
    }
    const v = steps.length === 0 ? null : (finite(raw.value) ?? null);
    if (steps.length > 0 && v === null) {
      continue;
    }
    const step: ThresholdStep = { value: v, tone: raw.tone };
    if (isHexColor(raw.color)) step.color = raw.color.toLowerCase() as HexColor;
    steps.push(step);
  }
  if (steps.length === 0) {
    return undefined;
  }
  const [base, ...rest] = steps;
  rest.sort((a, b) => (a.value as number) - (b.value as number));
  return {
    mode: value.mode === "percentage" ? "percentage" : "absolute",
    steps: [base as ThresholdStep, ...rest],
  };
}

function parseMapping(value: unknown): ValueMapping | null {
  if (!isRecord(value)) {
    return null;
  }
  const result: { text?: string; tone?: Tone } = {};
  const shown = text(value.text, LIMITS.textChars);
  if (shown !== undefined) result.text = shown;
  if (isTone(value.tone)) result.tone = value.tone;
  switch (value.type) {
    case "value":
      return { type: "value", value: text(value.value, LIMITS.textChars) ?? "", ...result };
    case "range":
      return {
        type: "range",
        from: finite(value.from) ?? null,
        to: finite(value.to) ?? null,
        ...result,
      };
    case "regex":
      return { type: "regex", pattern: text(value.pattern, LIMITS.textChars) ?? "", ...result };
    default:
      return null;
  }
}

/** Reads stored field options defensively: unknown keys and wrong types are dropped. */
export function parseFieldOptions(value: unknown): FieldOptions {
  if (!isRecord(value)) {
    return {};
  }
  const options: FieldOptions = parseGraphStyle(value);
  const unit = text(value.unit, LIMITS.unitChars + CUSTOM_PREFIX.length);
  if (unit !== undefined && unit !== "") options.unit = unit;
  const decimals = finite(value.decimals);
  if (decimals !== undefined && Number.isInteger(decimals)) {
    options.decimals = Math.min(Math.max(decimals, 0), LIMITS.decimals);
  }
  const min = finite(value.min);
  if (min !== undefined) options.min = min;
  const max = finite(value.max);
  if (max !== undefined) options.max = max;
  const thresholds = parseThresholds(value.thresholds);
  if (thresholds !== undefined) options.thresholds = thresholds;
  if (Array.isArray(value.mappings)) {
    options.mappings = value.mappings
      .slice(0, LIMITS.mappings)
      .map(parseMapping)
      .filter((m) => m !== null);
  }
  const noValue = text(value.noValue, LIMITS.noValueChars);
  if (noValue !== undefined) options.noValue = noValue;
  const displayName = text(value.displayName, LIMITS.textChars);
  if (displayName !== undefined && displayName !== "") options.displayName = displayName;
  const color = colorValueOf(value.color);
  if (color !== undefined) options.color = color;
  const scheme = COLOR_SCHEMES.find((s) => s === value.colorScheme);
  if (scheme !== undefined) options.colorScheme = scheme;
  const opacity = finite(value.opacity);
  if (opacity !== undefined && Number.isInteger(opacity) && opacity >= 0 && opacity <= 100) {
    options.opacity = opacity;
  }
  const display = THRESHOLD_DISPLAYS.find((d) => d === value.thresholdDisplay);
  if (display !== undefined) options.thresholdDisplay = display;
  const cellDisplay = CELL_DISPLAYS.find((d) => d === value.cellDisplay);
  if (cellDisplay !== undefined) options.cellDisplay = cellDisplay;
  const link = text(value.link, LIMITS.linkChars);
  if (link !== undefined && link !== "") options.link = link;
  const width = finite(value.width);
  if (width !== undefined) {
    options.width = Math.min(Math.max(Math.round(width), LIMITS.minWidth), LIMITS.maxWidth);
  }
  return options;
}

/** Override properties: like field options, and an explicit `null` is kept as "clear". */
export function parseOverrideProperties(value: unknown): OverrideProperties {
  const properties: OverrideProperties = parseFieldOptions(value);
  if (isRecord(value)) {
    for (const key of OPTION_KEYS) {
      if (value[key] === null) {
        properties[key] = null;
      }
    }
  }
  return properties;
}

export function parseFieldConfig(value: unknown): FieldConfig {
  if (!isRecord(value)) {
    return EMPTY_FIELD_CONFIG;
  }
  const overrides: FieldOverride[] = [];
  if (Array.isArray(value.overrides)) {
    for (const raw of value.overrides.slice(0, LIMITS.overrides)) {
      if (!isRecord(raw) || !isRecord(raw.matcher)) {
        continue;
      }
      const type = raw.matcher.type === "regex" ? "regex" : "name";
      overrides.push({
        matcher: { type, value: text(raw.matcher.value, LIMITS.textChars) ?? "" },
        properties: parseOverrideProperties(raw.properties),
      });
    }
  }
  return { defaults: parseFieldOptions(value.defaults), overrides };
}

/** Whether an override applies to the field: by its name or its name with labels. */
export function matches(matcher: FieldMatcher, field: Field): boolean {
  const names = [field.name, seriesName(field)];
  if (matcher.type === "name") {
    return names.includes(matcher.value);
  }
  const pattern = matcher.value === "" ? null : compilePattern(matcher.value);
  return pattern !== null && names.some((name) => pattern.test(name));
}

/**
 * The options in effect for one field. Precedence, lowest first: the unit the data source sent
 * with the field, the panel's defaults, then every matching override in order, so a later
 * override wins over an earlier one property by property.
 */
export function fieldOptionsFor(field: Field, config: FieldConfig): FieldOptions {
  let options: FieldOptions =
    field.unit === undefined || field.unit === "" ? {} : { unit: field.unit };
  options = { ...options, ...config.defaults };
  for (const override of config.overrides) {
    if (matches(override.matcher, field)) {
      const next: Record<string, unknown> = { ...options };
      for (const [key, value] of Object.entries(override.properties)) {
        if (value === null) {
          delete next[key];
        } else if (value !== undefined) {
          next[key] = value;
        }
      }
      options = next as FieldOptions;
    }
  }
  return options;
}

/** The field's name as panels show it: its display name, else its name with labels. */
export function displayNameOf(field: Field, options: FieldOptions, template = ""): string {
  return options.displayName ?? seriesName(field, template);
}

/**
 * The tone of a number under the thresholds: the last step at or below it. Percentage steps
 * compare where the value lies between min and max.
 */
export function thresholdTone(
  value: number,
  thresholds: Thresholds,
  range: { min: number; max: number } = { min: 0, max: 100 },
): Tone {
  return thresholdStep(value, thresholds, range).tone;
}

/** The step a number falls in under the thresholds, with its tone and its free colour. */
export function thresholdStep(
  value: number,
  thresholds: Thresholds,
  range: { min: number; max: number } = { min: 0, max: 100 },
): ThresholdStep {
  const position =
    thresholds.mode === "percentage"
      ? ((value - range.min) / (range.max - range.min || 1)) * 100
      : value;
  let found: ThresholdStep = thresholds.steps[0] ?? { value: null, tone: "neutral" };
  for (const step of thresholds.steps.slice(1)) {
    if (step.value !== null && position >= step.value) {
      found = step;
    }
  }
  return found;
}

function rawText(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (typeof raw === "number" || typeof raw === "boolean" || typeof raw === "bigint") {
    return String(raw);
  }
  return JSON.stringify(raw);
}

/** The first mapping that applies to a value, in the order they are listed. */
export function findMapping(
  raw: unknown,
  mappings: readonly ValueMapping[] | undefined,
): ValueMapping | undefined {
  if (mappings === undefined || mappings.length === 0 || raw === null || raw === undefined) {
    return undefined;
  }
  const asText = rawText(raw);
  const asNumber = toNumber(raw);
  return mappings.find((mapping) => {
    switch (mapping.type) {
      case "value": {
        // "5" matches 5 and 5.0; text compares as written.
        const wanted = toNumber(mapping.value);
        return asNumber !== null && wanted !== null && mapping.value.trim() !== ""
          ? asNumber === wanted
          : asText === mapping.value;
      }
      case "range":
        return (
          asNumber !== null &&
          (mapping.from === null || asNumber >= mapping.from) &&
          (mapping.to === null || asNumber <= mapping.to)
        );
      case "regex": {
        const pattern = mapping.pattern === "" ? null : compilePattern(mapping.pattern);
        return pattern?.test(asText);
      }
      default:
        return false;
    }
  });
}

/** A value as a panel shows it. */
export interface DisplayValue {
  /** The number or mapped text; "" when there is none. */
  text: string;
  /** The unit symbol, shown smaller after the text; "" for none. */
  suffix: string;
  /** From a mapping, else from the thresholds; undefined when neither applies. */
  tone: Tone | undefined;
  /** The value as a number, for drawing; null when it has none. */
  numeric: number | null;
  /** Whether the value is missing (null). */
  missing: boolean;
}

/** Text and suffix as one string. */
export function displayText(value: DisplayValue): string {
  return joinFormatted(value);
}

/**
 * One value through the field options: missing values get the no-value text, mappings come
 * first, then unit and decimals, and the tone from mapping or thresholds. Without unit and
 * decimals a value keeps its own form, so int64 shows every digit and text stays text.
 */
export function displayValue(
  raw: unknown,
  type: FieldType,
  options: FieldOptions,
  language: string,
  range?: { min: number; max: number },
  /** The user's time zone for time values (`useI18n().timeZone`), null for the browser's. */
  zone: string | null = getTimeZone(),
): DisplayValue {
  const numeric = isNumeric(type) ? toNumber(raw) : null;
  const missing =
    raw === null || raw === undefined || (typeof raw === "number" && !Number.isFinite(raw));
  if (missing) {
    return { text: options.noValue ?? "", suffix: "", tone: undefined, numeric: null, missing };
  }
  const tone =
    numeric !== null && options.thresholds !== undefined
      ? thresholdTone(numeric, options.thresholds, rangeOf(options, range))
      : undefined;
  const mapping = findMapping(raw, options.mappings);
  if (mapping !== undefined && mapping.text !== undefined && mapping.text !== "") {
    return { text: mapping.text, suffix: "", tone: mapping.tone ?? tone, numeric, missing };
  }
  // A catalog unit or fixed decimals format the number; a custom suffix alone keeps the value's
  // own form (every int64 digit) and only adds the suffix.
  // "none" clears a unit the data source sent and formats like no unit at all.
  const unit = options.unit === "none" ? undefined : options.unit;
  const formatted =
    numeric !== null &&
    ((unit !== undefined && isCatalogUnit(unit)) || options.decimals !== undefined)
      ? formatUnit(numeric, unit, options.decimals, language)
      : {
          text: formatValue(type, raw, language, zone),
          suffix: unit === undefined || numeric === null ? "" : customSuffix(unit),
        };
  return { ...formatted, tone: mapping?.tone ?? tone, numeric, missing };
}

/** Min and max for percentages and gauges: the options' own, else the given data range. */
export function rangeOf(
  options: FieldOptions,
  data: { min: number; max: number } = { min: 0, max: 100 },
): { min: number; max: number } {
  return { min: options.min ?? data.min, max: options.max ?? data.max };
}

/** The smallest and largest number of a field, or null when it has none. */
export function fieldExtent(field: Field): { min: number; max: number } | null {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const raw of field.values) {
    const value = toNumber(raw);
    if (value === null) continue;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return Number.isFinite(min) ? { min, max } : null;
}

/**
 * CSS class of a tone (viz.css), or of the palette entry for the series index. A free colour
 * takes the palette entry here: only the time series draws free colours so far
 * (`timeseries/styles.ts`), the other panels keep their palette.
 */
export function toneClass(tone: ColorValue | undefined, index = 0): string {
  return tone === undefined || isHexColor(tone) ? `series-${(index % 8) + 1}` : `tone--${tone}`;
}

const SAFE_LINK = /^(https?:\/\/|mailto:|\/(?!\/)|\.\/|\?|#)/i;

/**
 * Whether an address may become a link: web, mail and same-site addresses only. A backslash is
 * refused anywhere, since browsers read `/\\host` as `//host`, another site.
 */
export function isSafeHref(href: string): boolean {
  // Browsers drop tabs and line breaks from addresses, so "/\t/evil.example" would become
  // "//evil.example"; no control character may appear at all.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it looks for
  if (href.includes("\\") || /[\u0000-\u001f\u007f]/.test(href) || !SAFE_LINK.test(href)) {
    return false;
  }
  // What the browser makes of it decides: a web or mail address, or a page of this server.
  const origin = globalThis.location?.origin ?? "http://kalzit.invalid";
  let url: URL;
  try {
    url = new URL(href, origin);
  } catch {
    return false;
  }
  if (/^(https?:|mailto:)/i.test(href)) {
    return ["http:", "https:", "mailto:"].includes(url.protocol);
  }
  return url.origin === new URL(origin).origin;
}

// biome-ignore lint/suspicious/noTemplateCurlyInString: a placeholder users type
const VALUE = "${__value}";
// biome-ignore lint/suspicious/noTemplateCurlyInString: a placeholder users type
const FIELD = "${__field}";

/**
 * A cell link. A template that is `${__value}` alone uses the value itself as the address;
 * otherwise `${__value}` and `${__field}` are filled in URL-encoded. Either way only safe
 * addresses become links (javascript:, data: and the like give null).
 */
export function cellLink(template: string, value: string, fieldName: string): string | null {
  const href =
    template.trim() === VALUE
      ? value.trim()
      : template
          .replaceAll(VALUE, encodeURIComponent(value))
          .replaceAll(FIELD, encodeURIComponent(fieldName))
          .trim();
  return isSafeHref(href) ? href : null;
}
