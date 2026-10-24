/**
 * The graph style of a time series: how each series is drawn. These are field options, so the
 * defaults set them for every series and an override for one series or a group of them
 * (`fieldConfig.ts`). The server checks the same names and bounds (`panel_options.rs`).
 * Unset means automatic: the monochrome defaults of `docs/design/feel.md` section 8, resolved
 * per panel by `ui/src/panels/timeseries/styles.ts`.
 */

export const DRAW_STYLES = ["line", "bars", "points"] as const;
export type DrawStyle = (typeof DRAW_STYLES)[number];

export const INTERPOLATIONS = ["linear", "smooth", "stepBefore", "stepAfter"] as const;
export type Interpolation = (typeof INTERPOLATIONS)[number];

export const LINE_STYLES = ["solid", "dashed", "dotted"] as const;
export type LineStyle = (typeof LINE_STYLES)[number];

/** `hatch` is the diagonal hatching of the monochrome look; `auto` is left unset. */
export const FILLS = ["none", "solid", "hatch"] as const;
export type Fill = (typeof FILLS)[number];

/** How the fill changes from the line down to the baseline. `scheme` follows the thresholds. */
export const GRADIENTS = ["none", "opacity", "hue", "scheme"] as const;
export type Gradient = (typeof GRADIENTS)[number];

export const SHOW_POINTS = ["auto", "always", "never"] as const;
export type ShowPoints = (typeof SHOW_POINTS)[number];

export const CONNECT_GAPS = ["never", "always", "threshold"] as const;
export type ConnectGaps = (typeof CONNECT_GAPS)[number];

export const STACKINGS = ["none", "normal", "percent"] as const;
export type Stacking = (typeof STACKINGS)[number];

export const BAR_ALIGNMENTS = ["before", "center", "after"] as const;
export type BarAlignment = (typeof BAR_ALIGNMENTS)[number];

export const GRAPH_LIMITS = {
  maxLineWidth: 10,
  minPointSize: 1,
  maxPointSize: 40,
  /** Bar width in percent of the room between two points. */
  minBarWidth: 10,
  maxBarWidth: 100,
  /** Gap durations in ms: a millisecond to a year. */
  minDuration: 1,
  maxDuration: 365 * 24 * 60 * 60 * 1000,
  stackGroupChars: 50,
} as const;

export interface GraphStyleOptions {
  drawStyle?: DrawStyle;
  lineInterpolation?: Interpolation;
  /** Line width in px, 0 to 10; 0 draws no line (a fill or points alone). */
  lineWidth?: number;
  lineStyle?: LineStyle;
  fill?: Fill;
  /** 0 to 100. */
  fillOpacity?: number;
  gradientMode?: Gradient;
  showPoints?: ShowPoints;
  /** Point diameter in px. */
  pointSize?: number;
  connectGaps?: ConnectGaps;
  /** With `connectGaps: "threshold"`: gaps up to this many ms are bridged. */
  connectGapsBelow?: number;
  /** Two points further apart than this many ms are not joined. */
  breakAfter?: number;
  stack?: Stacking;
  /** Series stack with the others of the same group; unset is one shared group. */
  stackGroup?: string;
  barAlignment?: BarAlignment;
  /** Percent of the room between two points. */
  barWidth?: number;
  /** A comparison series (previous period, a target): muted and dashed. */
  comparison?: boolean;
}

/** The graph style option names, in the order the editor shows them. */
export const GRAPH_STYLE_KEYS = [
  "drawStyle",
  "lineInterpolation",
  "lineWidth",
  "lineStyle",
  "fill",
  "fillOpacity",
  "gradientMode",
  "showPoints",
  "pointSize",
  "connectGaps",
  "connectGapsBelow",
  "breakAfter",
  "stack",
  "stackGroup",
  "barAlignment",
  "barWidth",
  "comparison",
] as const satisfies readonly (keyof GraphStyleOptions)[];

function choice<T extends string>(choices: readonly T[], value: unknown): T | undefined {
  return choices.find((c) => c === value);
}

function integer(value: unknown, min: number, max: number): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
    ? value
    : undefined;
}

/** Reads the graph style keys of stored field options; wrong types and bounds are dropped. */
export function parseGraphStyle(value: Record<string, unknown>): GraphStyleOptions {
  const L = GRAPH_LIMITS;
  const entries: [keyof GraphStyleOptions, unknown][] = [
    ["drawStyle", choice(DRAW_STYLES, value.drawStyle)],
    ["lineInterpolation", choice(INTERPOLATIONS, value.lineInterpolation)],
    ["lineWidth", integer(value.lineWidth, 0, L.maxLineWidth)],
    ["lineStyle", choice(LINE_STYLES, value.lineStyle)],
    ["fill", choice(FILLS, value.fill)],
    ["fillOpacity", integer(value.fillOpacity, 0, 100)],
    ["gradientMode", choice(GRADIENTS, value.gradientMode)],
    ["showPoints", choice(SHOW_POINTS, value.showPoints)],
    ["pointSize", integer(value.pointSize, L.minPointSize, L.maxPointSize)],
    ["connectGaps", choice(CONNECT_GAPS, value.connectGaps)],
    ["connectGapsBelow", integer(value.connectGapsBelow, L.minDuration, L.maxDuration)],
    ["breakAfter", integer(value.breakAfter, L.minDuration, L.maxDuration)],
    ["stack", choice(STACKINGS, value.stack)],
    [
      "stackGroup",
      typeof value.stackGroup === "string" && value.stackGroup !== ""
        ? value.stackGroup.slice(0, L.stackGroupChars)
        : undefined,
    ],
    ["barAlignment", choice(BAR_ALIGNMENTS, value.barAlignment)],
    ["barWidth", integer(value.barWidth, L.minBarWidth, L.maxBarWidth)],
    ["comparison", typeof value.comparison === "boolean" ? value.comparison : undefined],
  ];
  const options: Record<string, unknown> = {};
  for (const [key, parsed] of entries) {
    if (parsed !== undefined) options[key] = parsed;
  }
  return options as GraphStyleOptions;
}

const DURATION_UNITS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/** "30s", "5m", "1h 30m", "2d" or a plain number of ms; null when the text is not a duration. */
export function parseDuration(text: string): number | null {
  const parts = text.trim().toLowerCase().split(/\s+/);
  let total = 0;
  for (const part of parts) {
    const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d|w)?$/.exec(part);
    if (match === null) {
      return null;
    }
    total += Number(match[1]) * (DURATION_UNITS[match[2] ?? "ms"] as number);
  }
  const ms = Math.round(total);
  return ms >= GRAPH_LIMITS.minDuration && ms <= GRAPH_LIMITS.maxDuration ? ms : null;
}

/** A duration in ms as the shortest text `parseDuration` reads back: "90s" stays "90s". */
export function formatDuration(ms: number): string {
  for (const unit of ["w", "d", "h", "m", "s"] as const) {
    const size = DURATION_UNITS[unit] as number;
    if (ms >= size && ms % size === 0) {
      return `${ms / size}${unit}`;
    }
  }
  return `${ms}ms`;
}
