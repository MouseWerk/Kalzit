import { type FieldOptions, type Thresholds, toneClass } from "../fieldConfig/fieldConfig";
import type {
  ConnectGaps,
  DrawStyle,
  Fill,
  Gradient,
  Interpolation,
  LineStyle,
  ShowPoints,
  Stacking,
} from "../fieldConfig/graphStyle";
import type { Series } from "./series";
import "../panels.css";

/**
 * How each series of a time series panel is drawn: its graph style options with every unset one
 * resolved. The defaults follow `docs/design/feel.md` section 8: a lone series is monochrome
 * (`--chart-mono`) with a smooth line and a fading hatch under it, a comparison series is muted
 * and dashed, two or more series take the categorical palette, bars are filled at full strength.
 */
export interface SeriesStyle {
  /** The color class (`viz.css`, `panels.css`): a tone, a palette entry or a monochrome class. */
  colorClass: string;
  /** For legend and tooltip swatches: the color class plus the line style's swatch class. */
  swatchClass: string;
  drawStyle: DrawStyle;
  interpolation: Interpolation;
  /** CSS px. */
  lineWidth: number;
  lineStyle: LineStyle;
  /** Dash and gap lengths in CSS px, empty for a solid line. */
  dash: number[];
  fill: Fill;
  /** 0 to 1. */
  fillOpacity: number;
  gradient: Gradient;
  showPoints: ShowPoints;
  /** CSS px. */
  pointSize: number;
  connectGaps: ConnectGaps;
  /** ms; gaps up to this long are bridged with `connectGaps: "threshold"`. */
  connectGapsBelow: number;
  /** ms, or null: points further apart are not joined. */
  breakAfter: number | null;
  stack: Stacking;
  stackGroup: string;
  /** -1 before the point, 0 centered, 1 after it. */
  barAlignment: -1 | 0 | 1;
  /** 0.1 to 1 of the room between two points. */
  barWidth: number;
  comparison: boolean;
  /** For the `scheme` gradient. */
  thresholds: Thresholds | undefined;
}

export const MONO_CLASS = "series-mono";
export const MONO_COMPARE_CLASS = "series-mono-compare";

/** Fill strength in percent when none is set, by what is filled. */
const DEFAULT_OPACITY = { bars: 100, stacked: 40, solid: 18, hatch: 100 } as const;

const BAR_ALIGN = { before: -1, center: 0, after: 1 } as const;

/** Whether the series of a panel take the monochrome look: one series, no color of its own. */
export function isMonochrome(series: readonly Series[]): boolean {
  const primary = series.filter((s) => s.options?.comparison !== true);
  return primary.length === 1 && primary[0]?.options?.color === undefined;
}

/** Dash pattern of a line style at a line width. Dots are zero-length dashes with round caps. */
export function dashFor(lineStyle: LineStyle, lineWidth: number): number[] {
  const unit = Math.max(lineWidth, 1.5);
  switch (lineStyle) {
    case "dashed":
      return [3 * unit, 2.5 * unit];
    case "dotted":
      return [0, 2.5 * unit];
    default:
      return [];
  }
}

/** One series' style from its field options and the panel's other series. */
function resolveOne(options: FieldOptions, index: number, mono: boolean): SeriesStyle {
  const comparison = options.comparison === true;
  const drawStyle = options.drawStyle ?? "line";
  const stack = options.stack ?? "none";
  const colorClass =
    options.color !== undefined
      ? toneClass(options.color)
      : comparison
        ? MONO_COMPARE_CLASS
        : mono
          ? MONO_CLASS
          : toneClass(undefined, index);
  const lineWidth = options.lineWidth ?? (mono ? 2 : 1);
  const lineStyle = options.lineStyle ?? (comparison ? "dashed" : "solid");
  const autoFill: Fill =
    drawStyle === "bars"
      ? "solid"
      : comparison || drawStyle === "points"
        ? "none"
        : stack !== "none"
          ? "solid"
          : mono
            ? "hatch"
            : "none";
  const fill = options.fill ?? autoFill;
  const opacity =
    options.fillOpacity ??
    (fill === "hatch"
      ? DEFAULT_OPACITY.hatch
      : drawStyle === "bars"
        ? DEFAULT_OPACITY.bars
        : stack !== "none"
          ? DEFAULT_OPACITY.stacked
          : DEFAULT_OPACITY.solid);
  // The monochrome hatch fades toward the baseline, as in the owner's reference.
  const gradient =
    options.gradientMode ?? (fill === "hatch" && options.fill === undefined ? "opacity" : "none");
  const swatch = lineStyle === "solid" || drawStyle !== "line" ? "" : ` ts__swatch--${lineStyle}`;
  return {
    colorClass,
    swatchClass: `${colorClass}${swatch}`,
    drawStyle,
    // A lone series is drawn smooth (monotone, so it never overshoots a value).
    interpolation: options.lineInterpolation ?? (mono && !comparison ? "smooth" : "linear"),
    lineWidth,
    lineStyle,
    dash: dashFor(lineStyle, lineWidth),
    fill,
    fillOpacity: opacity / 100,
    gradient,
    showPoints: options.showPoints ?? (drawStyle === "points" ? "always" : "auto"),
    pointSize: options.pointSize ?? 5,
    connectGaps: options.connectGaps ?? "never",
    connectGapsBelow: options.connectGapsBelow ?? 0,
    breakAfter: options.breakAfter ?? null,
    stack,
    stackGroup: options.stackGroup ?? "",
    barAlignment: BAR_ALIGN[options.barAlignment ?? "center"],
    barWidth: (options.barWidth ?? 60) / 100,
    comparison,
    thresholds: options.thresholds,
  };
}

/** The resolved style of every series, in series order. */
export function resolveStyles(series: readonly Series[]): SeriesStyle[] {
  const mono = isMonochrome(series);
  return series.map((s, index) => resolveOne(s.options ?? {}, index, mono));
}

/**
 * A key that changes exactly when the drawing must be built again: everything about each
 * series' look except its data.
 */
export function styleKey(styles: readonly SeriesStyle[]): string {
  return JSON.stringify(styles);
}

export interface StackedData {
  /** Values as drawn: stacked series hold their running sums, others their own values. */
  ys: (number | null)[][];
  /** Per series, the running sum below it at each point (for bars), or null when not stacked. */
  baselines: (Float64Array | null)[];
  /**
   * Per series, the series index (0-based) its line fills down to, or -1 for zero: the nearest
   * earlier series of its group on the same side of zero (by the sign of its sum).
   */
  below: number[];
  /** Per series, whether it stacks below zero (the sum of its values is negative). */
  down: boolean[];
  /** Whether any series stacks to 100 %. */
  percent: boolean;
}

/**
 * Stacks series by their stack mode and group, in series order. Positive values stack up from
 * zero and negative values down from zero, each side on its own running sum, so a group of
 * incoming and outgoing traffic reads as two stacks. Only values at the same time are summed; a
 * series without a value at a time stays a gap there, and the series above it stack on what is
 * present. Percent stacking divides by the sum of the absolute values present at that time, so
 * +5 and -5 become +50 % and -50 %; a time whose values are all zero gives 0 % (0/0 is 0).
 * A stacked line fills down to the series it stands on (`below`); where that series has no value
 * the fill has no lower edge and breaks there, as the line of a missing value does.
 */
export function stackData(
  ys: readonly (number | null)[][],
  styles: readonly SeriesStyle[],
): StackedData {
  const groups = new Map<string, number[]>();
  styles.forEach((style, index) => {
    if (style.stack === "none") {
      return;
    }
    const key = `${style.stack}\u0000${style.stackGroup}`;
    const members = groups.get(key) ?? [];
    members.push(index);
    groups.set(key, members);
  });
  const out: StackedData = {
    ys: [...ys],
    baselines: ys.map(() => null),
    below: ys.map(() => -1),
    down: ys.map(() => false),
    percent: false,
  };
  for (const [key, members] of groups) {
    const percent = key.startsWith("percent");
    out.percent ||= percent;
    const length = ys[members[0] as number]?.length ?? 0;
    // The sum of absolute values per time, for percent.
    const totals = new Float64Array(length);
    if (percent) {
      for (const member of members) {
        const values = ys[member] ?? [];
        for (let i = 0; i < length; i++) {
          const v = values[i];
          if (v !== null && v !== undefined) totals[i] = (totals[i] as number) + Math.abs(v);
        }
      }
    }
    const up = new Float64Array(length);
    const down = new Float64Array(length);
    // The last series of each side, for the fill below the next one.
    let lastUp = -1;
    let lastDown = -1;
    for (const member of members) {
      const values = ys[member] ?? [];
      const base = new Float64Array(length);
      const stacked: (number | null)[] = new Array(length);
      let sum = 0;
      for (let i = 0; i < length; i++) {
        const v = values[i];
        if (v === null || v === undefined) {
          stacked[i] = null;
          base[i] = up[i] as number;
          continue;
        }
        const total = totals[i] as number;
        const part = percent ? (total === 0 ? 0 : (v / total) * 100) : v;
        sum += part;
        const side = part < 0 ? down : up;
        base[i] = side[i] as number;
        side[i] = (side[i] as number) + part;
        stacked[i] = side[i] as number;
      }
      out.ys[member] = stacked;
      out.baselines[member] = base;
      if (sum < 0) {
        out.down[member] = true;
        out.below[member] = lastDown;
        lastDown = member;
      } else {
        out.below[member] = lastUp;
        lastUp = member;
      }
    }
  }
  return out;
}

export type Gap = [from: number, to: number];

/**
 * The gaps a line keeps, in canvas px: uPlot finds one per run of missing values (from the point
 * before to the point after). `connectGaps` drops all of them or those shorter than its
 * threshold; `breakAfter` adds one between two present points further apart than it. Sorted and
 * merged, as uPlot's clip expects.
 */
export function refineGaps(
  style: SeriesStyle,
  xs: ArrayLike<number>,
  ys: ArrayLike<number | null | undefined>,
  idx0: number,
  idx1: number,
  nullGaps: readonly Gap[],
  /** Canvas px per ms on the time axis. */
  pxPerMs: number,
  /** Canvas px of a time. */
  pixelOf: (time: number) => number,
): Gap[] {
  let gaps: Gap[] =
    style.connectGaps === "always"
      ? []
      : style.connectGaps === "threshold"
        ? nullGaps.filter(([from, to]) => (to - from) / pxPerMs >= style.connectGapsBelow)
        : [...nullGaps];
  if (style.breakAfter !== null) {
    const limit = style.breakAfter;
    let previous = -1;
    for (let i = idx0; i <= idx1; i++) {
      const y = ys[i];
      if (y === null || y === undefined) {
        continue;
      }
      if (previous !== -1 && (xs[i] as number) - (xs[previous] as number) > limit) {
        gaps.push([pixelOf(xs[previous] as number), pixelOf(xs[i] as number)]);
      }
      previous = i;
    }
    gaps = mergeGaps(gaps);
  }
  return gaps;
}

function mergeGaps(gaps: Gap[]): Gap[] {
  gaps.sort((a, b) => a[0] - b[0]);
  const merged: Gap[] = [];
  for (const gap of gaps) {
    const last = merged.at(-1);
    if (last !== undefined && gap[0] <= last[1]) {
      last[1] = Math.max(last[1], gap[1]);
    } else {
      merged.push([gap[0], gap[1]]);
    }
  }
  return merged;
}

/** Whether a line needs uPlot's gap handling at all (else it spans every gap). */
export function spansGaps(style: SeriesStyle): boolean {
  return style.connectGaps === "always" && style.breakAfter === null;
}
