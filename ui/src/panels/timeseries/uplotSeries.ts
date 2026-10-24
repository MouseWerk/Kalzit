import uPlot from "uplot";
import { type Tone, thresholdTone } from "../fieldConfig/fieldConfig";
import { shiftHue, withAlpha } from "./canvasColor";
import { refineGaps, type SeriesStyle, type StackedData, spansGaps } from "./styles";

/**
 * uPlot series options from resolved series styles: the path builder of the draw style and
 * interpolation, dashes, points, gaps, stacking, and fills (solid, hatched, with an opacity, hue
 * or threshold gradient). Fills and gradients are made when uPlot draws, from the plot's current
 * size, and kept until the size or scale changes.
 */

/** Theme values the drawing needs, read from the token probes. */
export interface Paint {
  /** The series' color. */
  color: string;
  /** Colors of the threshold tones, for the scheme gradient. */
  tones: Partial<Record<Tone, string>>;
  /** Alpha of the hatch lines at full fill opacity (`--chart-hatch-alpha`). */
  hatchAlpha: number;
  /** Width of the hatch lines in CSS px (`--chart-hatch-width`). */
  hatchWidth: number;
  /** Room between hatch lines in CSS px (`--chart-hatch-spacing`). */
  hatchSpacing: number;
  /** What the fading gradient keeps at the baseline (`--chart-fade-to`). */
  fadeTo: number;
}

/** How far the hue gradient turns toward the baseline, in degrees. */
const HUE_SHIFT = 50;
/** CSS px between points at least, before automatic points show. */
const AUTO_POINT_SPACE = 24;

/** Builders made once: uPlot's builders are factories that hold their options. */
const linear = () => uPlot.paths.linear?.() as uPlot.Series.PathBuilder;
const spline = () => uPlot.paths.spline?.() as uPlot.Series.PathBuilder;

/** The path builder of a line's interpolation. */
function linePaths(style: SeriesStyle): uPlot.Series.PathBuilder {
  switch (style.interpolation) {
    case "smooth": {
      // A spline does not thin out points the way the linear path does; with more than a point
      // per pixel the two look the same, so the dense case draws linear and stays fast.
      const smooth = spline();
      const straight = linear();
      return (u, seriesIdx, idx0, idx1) =>
        (idx1 - idx0 > u.bbox.width ? straight : smooth)(u, seriesIdx, idx0, idx1);
    }
    case "stepBefore":
      return uPlot.paths.stepped?.({ align: -1 }) as uPlot.Series.PathBuilder;
    case "stepAfter":
      return uPlot.paths.stepped?.({ align: 1 }) as uPlot.Series.PathBuilder;
    default:
      return linear();
  }
}

/** Where a value lies between the plot's top (0) and bottom (1), for gradient stops. */
function offsetOf(u: uPlot, value: number): number {
  const y = u.valToPos(value, "y", true);
  return Math.min(Math.max((y - u.bbox.top) / (u.bbox.height || 1), 0), 1);
}

/**
 * A vertical gradient over the plot by the thresholds: each step's tone from its value upward,
 * with hard edges. Percentage steps are placed between the value axis' ends.
 */
function schemeGradient(
  u: uPlot,
  ctx: CanvasRenderingContext2D,
  style: SeriesStyle,
  paint: Paint,
  alpha: (offset: number) => number,
): CanvasGradient | string {
  const thresholds = style.thresholds;
  const color = (tone: Tone, offset: number) =>
    withAlpha(paint.tones[tone] ?? paint.color, alpha(offset));
  if (thresholds === undefined) {
    return withAlpha(paint.color, alpha(0));
  }
  const top = u.bbox.top;
  const gradient = ctx.createLinearGradient(0, top, 0, top + u.bbox.height);
  const scale = u.scales.y;
  const min = scale?.min ?? 0;
  const max = scale?.max ?? 1;
  const stepValue = (step: number) =>
    thresholds.mode === "percentage" ? min + (step / 100) * (max - min) : step;
  // From the top down: the tone at the top, then a hard edge at every step boundary.
  const range = { min, max };
  gradient.addColorStop(0, color(thresholdTone(max, thresholds, range), 0));
  const steps = thresholds.steps.slice(1).sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
  for (const [i, step] of steps.entries()) {
    const offset = offsetOf(u, stepValue(step.value ?? 0));
    const below = steps[i + 1]?.tone ?? thresholds.steps[0]?.tone ?? "neutral";
    gradient.addColorStop(offset, color(step.tone, offset));
    gradient.addColorStop(offset, color(below, offset));
  }
  gradient.addColorStop(1, color(thresholdTone(min, thresholds, range), 1));
  return gradient;
}

/** The style of a fill or a hatch line: a color, or a gradient from the line to the baseline. */
function gradientStyle(
  u: uPlot,
  ctx: CanvasRenderingContext2D,
  style: SeriesStyle,
  paint: Paint,
  alpha: number,
): CanvasGradient | string {
  const top = u.bbox.top;
  const bottom = top + u.bbox.height;
  switch (style.gradient) {
    case "opacity": {
      const gradient = ctx.createLinearGradient(0, top, 0, bottom);
      gradient.addColorStop(0, withAlpha(paint.color, alpha));
      gradient.addColorStop(1, withAlpha(paint.color, alpha * paint.fadeTo));
      return gradient;
    }
    case "hue": {
      const gradient = ctx.createLinearGradient(0, top, 0, bottom);
      gradient.addColorStop(0, withAlpha(paint.color, alpha));
      gradient.addColorStop(1, shiftHue(paint.color, HUE_SHIFT, alpha));
      return gradient;
    }
    case "scheme":
      return schemeGradient(u, ctx, style, paint, () => alpha);
    default:
      return withAlpha(paint.color, alpha);
  }
}

/**
 * Diagonal hatching as a pattern. The tile is one hatch spacing wide and as tall as the canvas,
 * so a gradient drawn into it lines up with the plot (patterns start at the canvas origin).
 */
function hatchPattern(u: uPlot, style: SeriesStyle, paint: Paint): CanvasPattern | string {
  const ratio = uPlot.pxRatio;
  const spacing = Math.max(1, Math.round(paint.hatchSpacing * ratio));
  const height = u.ctx.canvas.height;
  const tile = document.createElement("canvas");
  tile.width = spacing;
  tile.height = height;
  const ctx = tile.getContext("2d");
  if (ctx === null) {
    return withAlpha(paint.color, paint.hatchAlpha * style.fillOpacity);
  }
  ctx.lineWidth = paint.hatchWidth * ratio;
  ctx.strokeStyle = gradientStyle(u, ctx, style, paint, paint.hatchAlpha * style.fillOpacity);
  ctx.beginPath();
  for (let y = 0; y <= height + spacing; y += spacing) {
    // Past the tile's edges, so neighboring tiles join without a seam.
    ctx.moveTo(-1, y + 1);
    ctx.lineTo(spacing + 1, y - spacing - 1);
  }
  ctx.stroke();
  return u.ctx.createPattern(tile, "repeat") ?? withAlpha(paint.color, paint.hatchAlpha);
}

/**
 * A fill or stroke style made on first use and kept while what it depends on stays: the plot's
 * place on the canvas, and for the threshold scheme also the value axis' ends. New data on a live
 * dashboard keeps the size, so a hatch or a gradient is not made again on every draw.
 */
export function cached<T>(
  make: (u: uPlot) => T,
  byScale: boolean,
  counter?: { made: number },
): (u: uPlot) => T {
  let key = "";
  let value: T | undefined;
  return (u) => {
    let next = `${u.bbox.top},${u.bbox.height},${u.ctx.canvas.height}`;
    if (byScale) {
      next += `,${u.scales.y?.min},${u.scales.y?.max}`;
    }
    if (value === undefined || next !== key) {
      key = next;
      value = make(u);
      if (counter !== undefined) counter.made++;
    }
    return value;
  };
}

function fillOf(style: SeriesStyle, paint: Paint): uPlot.Series.Fill | undefined {
  const byScale = style.gradient === "scheme";
  switch (style.fill) {
    case "solid":
      return cached((u) => gradientStyle(u, u.ctx, style, paint, style.fillOpacity), byScale);
    case "hatch":
      return cached((u) => hatchPattern(u, style, paint), byScale);
    default:
      return undefined;
  }
}

function pointsOf(style: SeriesStyle, paint: Paint): uPlot.Series.Points {
  const points: uPlot.Series.Points = {
    size: style.pointSize,
    width: 0,
    fill: paint.color,
    stroke: paint.color,
  };
  if (style.showPoints === "auto") {
    // Only where points stand well apart, so a calm line does not turn into beads.
    points.space = Math.max(style.pointSize * 4, AUTO_POINT_SPACE);
  } else {
    points.show = style.showPoints === "always";
  }
  return points;
}

/**
 * uPlot's options for series `index` (0-based; uPlot's own index is one more, after x). `data`
 * holds the stacked data the chart draws, read when bars are drawn.
 */
export function uplotSeries(
  label: string,
  index: number,
  style: SeriesStyle,
  paint: Paint,
  data: { current: StackedData },
): uPlot.Series {
  const options: uPlot.Series = {
    label,
    stroke:
      style.gradient === "scheme" && style.thresholds !== undefined
        ? cached((u) => schemeGradient(u, u.ctx, style, paint, () => 1), true)
        : paint.color,
    width: style.lineWidth,
    points: pointsOf(style, paint),
    spanGaps: spansGaps(style),
  };
  const fill = fillOf(style, paint);
  if (fill !== undefined) options.fill = fill;
  if (style.dash.length > 0) options.dash = style.dash;
  if (style.lineStyle === "dotted") options.cap = "round";
  if (style.drawStyle === "points") {
    options.paths = () => null;
  } else if (style.drawStyle === "bars") {
    const stacked = data.current.baselines[index] !== null;
    options.paths = uPlot.paths.bars?.({
      align: style.barAlignment,
      size: [style.barWidth, Number.POSITIVE_INFINITY, 1],
      ...(stacked
        ? {
            // Stacked bars stand on the running sum below them, exactly per point.
            disp: {
              y0: {
                unit: 1 as uPlot.Series.BarsPathBuilderFacetUnit,
                // A typed array reads like the plain one uPlot asks for; no copy per draw.
                values: () =>
                  (data.current.baselines[index] ??
                    []) as unknown as uPlot.Series.BarsPathBuilderFacetValue[],
              },
              y1: {
                unit: 1 as uPlot.Series.BarsPathBuilderFacetUnit,
                values: (u: uPlot, seriesIdx: number) =>
                  u.data[seriesIdx] as uPlot.Series.BarsPathBuilderFacetValue[],
              },
            },
          }
        : {}),
    }) as uPlot.Series.PathBuilder;
  } else {
    const line = linePaths(style);
    options.paths =
      fill !== undefined && data.current.baselines[index] !== null
        ? stackedFill(line, index, style.interpolation, data)
        : line;
  }
  if (style.drawStyle !== "bars" && (style.connectGaps !== "never" || style.breakAfter !== null)) {
    options.gaps = (u, seriesIdx, idx0, idx1, nullGaps) => {
      const scale = u.scales.x;
      const span = (scale?.max ?? 1) - (scale?.min ?? 0);
      return refineGaps(
        style,
        u.data[0] as ArrayLike<number>,
        u.data[seriesIdx] as ArrayLike<number | null>,
        idx0,
        idx1,
        nullGaps as [number, number][],
        u.bbox.width / (span || 1),
        (time) => Math.round(u.valToPos(time, "x", true)),
      );
    };
  }
  return options;
}

/**
 * A stacked line's fill: from its line down to its own baseline (the running sum of its side
 * below it), point by point, so a value that changes sides fills on its side and never across
 * zero to another series. The line itself comes from the interpolation's builder; the baseline is
 * walked back in the same steps for stepped lines and straight otherwise, thinned like the linear
 * path to the first, lowest, highest and last point per pixel column. Missing values are skipped;
 * uPlot's gap clip breaks the fill there with the line.
 *
 * Known limitation: a smooth line stacked on a smooth line has its baseline walked straight. With
 * a point per pixel or more (where the smooth line is drawn straight anyway) that is exact; with
 * sparse points the fill's lower edge cuts the curve below it in chords, a sliver at most.
 */
export function stackedFill(
  line: uPlot.Series.PathBuilder,
  index: number,
  interpolation: SeriesStyle["interpolation"],
  data: { current: StackedData },
): uPlot.Series.PathBuilder {
  return (u, seriesIdx, idx0, idx1) => {
    const paths = line(u, seriesIdx, idx0, idx1);
    const base = data.current.baselines[index];
    const stroke = paths?.stroke;
    if (paths === null || !(stroke instanceof Path2D) || base === null || base === undefined) {
      return paths;
    }
    const xs = u.data[0] as ArrayLike<number>;
    const ys = u.data[seriesIdx] as ArrayLike<number | null | undefined>;
    let last = idx1;
    while (last >= idx0 && (ys[last] === null || ys[last] === undefined)) last--;
    let first = idx0;
    while (first <= last && (ys[first] === null || ys[first] === undefined)) first++;
    if (first > last) {
      return paths;
    }
    const x = (i: number) => u.valToPos(xs[i] as number, "x", true);
    const y = (i: number) => u.valToPos(base[i] as number, "y", true);
    const fill = new Path2D(stroke);
    const missing = (i: number) => ys[i] === null || ys[i] === undefined;
    if (interpolation === "stepAfter" || interpolation === "stepBefore") {
      fill.lineTo(x(last), y(last));
      let next = last;
      for (let i = last - 1; i >= first; i--) {
        if (missing(i)) continue;
        if (interpolation === "stepAfter") {
          // The value of i holds until the next point: up or down there, then back across.
          fill.lineTo(x(next), y(i));
        } else {
          fill.lineTo(x(i), y(next));
        }
        fill.lineTo(x(i), y(i));
        next = i;
      }
    } else {
      // Per pixel column the first, lowest, highest and last point, in walking order.
      let column = Number.NaN;
      let group: number[] = [];
      const flush = () => {
        for (const i of [...new Set(group)].sort((a, b) => b - a)) {
          fill.lineTo(x(i), y(i));
        }
        group = [];
      };
      for (let i = last; i >= first; i--) {
        if (missing(i)) continue;
        const px = Math.round(x(i));
        if (px !== column) {
          flush();
          column = px;
          group = [i, i, i, i];
          continue;
        }
        const [, low = i, high = i] = group;
        if ((base[i] as number) < (base[low] as number)) group[1] = i;
        if ((base[i] as number) > (base[high] as number)) group[2] = i;
        group[3] = i;
      }
      flush();
    }
    fill.closePath();
    paths.fill = fill;
    return paths;
  };
}
