import { valueAxis } from "./axis";
import { type ScaleSpec, skippedCount, valueScale } from "./axisScale";
import { type AxisOptions, scaleSpecOf } from "./fieldConfig/axisOptions";
import "./panels.css";

/**
 * The one value axis of the bar chart and the histogram, from the panel's default field options
 * (ParityEditors board, frame 2: the group "Achsen" applies to them as to the time series).
 */

/** Room between the labels and the plot. */
export const AXIS_GAP = 8;
/** Room for an axis label turned along the axis. */
export const TITLE_ROOM = 16;
/** Room beside the plot where no axis stands. */
const EDGE = 8;

export interface BarAxis {
  spec: ScaleSpec;
  min: number;
  max: number;
  ticks: number[];
  /** Where a value lies between min (0) and max (1); 0 for values the scale cannot draw. */
  fraction: (value: number) => number;
  /** Values the scale leaves out (≤ 0 on a log scale). */
  skipped: number;
  side: "left" | "right";
  show: boolean;
  grid: boolean;
  line: boolean;
  label: string | undefined;
  width: number | undefined;
}

/**
 * The value axis of bars over `values`: from zero (bars stand on it) to the largest value on a
 * linear or "log around zero" scale, from the smallest positive value on a log scale. A linear
 * axis rounds its open ends out to the next tick, as before the axis options.
 */
export function barAxis(
  values: readonly number[],
  options: AxisOptions & { min?: number; max?: number },
  count: number,
): BarAxis {
  const spec: ScaleSpec = scaleSpecOf(options);
  let fraction: (value: number) => number;
  let min: number;
  let max: number;
  let ticks: number[];
  if (spec.scale === "linear") {
    let low = 0;
    let high = 0;
    for (const v of values) {
      if (v < low) low = v;
      if (v > high) high = v;
    }
    if (spec.softMin !== undefined) low = Math.min(low, spec.softMin);
    if (spec.softMax !== undefined) high = Math.max(high, spec.softMax);
    if (spec.centeredZero === true) {
      const reach = Math.max(Math.abs(low), Math.abs(high));
      low = -reach;
      high = reach;
    }
    const axis = valueAxis(low, high, count, options);
    min = axis.min;
    max = axis.max;
    ticks = axis.ticks;
    fraction = (value) => (value - min) / (max - min || 1);
  } else {
    const drawn = spec.scale === "log" ? values.filter((v) => v > 0) : [0, ...values];
    let extent: { min: number; max: number } | null = null;
    for (const v of drawn) {
      extent =
        extent === null
          ? { min: v, max: v }
          : { min: Math.min(extent.min, v), max: Math.max(extent.max, v) };
    }
    const scale = valueScale(extent, spec, count);
    min = scale.min;
    max = scale.max;
    ticks = scale.ticks;
    fraction = (value) => {
      const at = scale.fraction(value);
      return Number.isFinite(at) ? at : 0;
    };
  }
  const placement = options.axisPlacement ?? "auto";
  const grid = options.axisGrid ?? "auto";
  return {
    spec,
    min,
    max,
    ticks,
    fraction,
    skipped: skippedCount(spec.scale, values),
    side: placement === "right" ? "right" : "left",
    show: placement !== "hidden",
    grid: grid !== "off",
    line: options.axisLine === true,
    label: options.axisLabel,
    width: options.axisWidth,
  };
}

/** The room left and right of the plot for an axis whose widest label is `labels` px. */
export function axisRoom(axis: BarAxis, labels: number): { left: number; right: number } {
  if (!axis.show) return { left: EDGE, right: EDGE };
  const room =
    (axis.width ?? Math.ceil(labels) + AXIS_GAP) + (axis.label === undefined ? 0 : TITLE_ROOM);
  return axis.side === "left" ? { left: room, right: EDGE } : { left: EDGE, right: room };
}

/** Grid lines, labels, the axis line and the label of a bar chart's value axis, as SVG. */
export function ValueAxisMarks({
  axis,
  ticks,
  y,
  plotLeft,
  plotWidth,
  top,
  plotHeight,
  boxWidth,
}: {
  axis: BarAxis;
  ticks: readonly { tick: number; text: string }[];
  y: (value: number) => number;
  plotLeft: number;
  plotWidth: number;
  top: number;
  plotHeight: number;
  boxWidth: number;
}) {
  const onLeft = axis.side === "left";
  const edge = onLeft ? plotLeft : plotLeft + plotWidth;
  const titleX = onLeft ? TITLE_ROOM / 2 : boxWidth - TITLE_ROOM / 2;
  const titleY = top + plotHeight / 2;
  return (
    <g className="ts__axis">
      {ticks.map(({ tick, text }) => (
        <g key={tick}>
          {axis.grid ? (
            <line
              className="ts__grid"
              x1={plotLeft}
              x2={plotLeft + plotWidth}
              y1={y(tick)}
              y2={y(tick)}
            />
          ) : null}
          {axis.show ? (
            <text
              className="ts__label"
              x={onLeft ? edge - AXIS_GAP : edge + AXIS_GAP}
              y={y(tick)}
              textAnchor={onLeft ? "end" : "start"}
            >
              {text}
            </text>
          ) : null}
        </g>
      ))}
      {axis.show && axis.line ? (
        <line className="ts__axis-line" x1={edge} x2={edge} y1={top} y2={top + plotHeight} />
      ) : null}
      {axis.show && axis.label !== undefined ? (
        <text
          className="ts__label ts__axis-title"
          x={titleX}
          y={titleY}
          textAnchor="middle"
          transform={`rotate(-90 ${titleX} ${titleY})`}
        >
          {axis.label}
        </text>
      ) : null}
    </g>
  );
}
