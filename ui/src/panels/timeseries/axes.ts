import { type ScaleSpec, skippedCount } from "../axisScale";
import type { AxisColor } from "../fieldConfig/axisOptions";
import { scaleSpecOf } from "../fieldConfig/axisOptions";
import type { FieldOptions } from "../fieldConfig/fieldConfig";
import type { Series } from "./series";
import type { SeriesStyle } from "./styles";

/** The scale key of the left and of the right value axis (uPlot's scale names). */
export type AxisKey = "y" | "y2";

/** One value axis of a time series and the series drawn on it. */
export interface AxisPlan {
  key: AxisKey;
  side: "left" | "right";
  /** Whether the axis is drawn; its series are drawn either way. */
  show: boolean;
  /** Indexes of the series on this axis. */
  series: number[];
  spec: ScaleSpec;
  label: string | undefined;
  /** Fixed width in px; undefined: as wide as the longest value. */
  width: number | undefined;
  grid: boolean;
  color: AxisColor;
  line: boolean;
  unit: string | undefined;
  decimals: number | undefined;
}

/**
 * Which series go on which value axis, and how each axis looks. A series' placement comes from
 * its field options: left, right, hidden (on the left scale, without an axis of its own) or auto,
 * which is left unless the field has a second unit: then it gets the right axis, so two units
 * stay readable. Each axis takes its options from its first series (so an override on the
 * right-hand field sets the right axis). With `auto` grid lines only the left axis draws them,
 * or the right one when there is no left axis to show. Series stacked to 100 % put percent on
 * the left axis, from 0 (or -100) to 100 unless its ends are set.
 */
export function planAxes(
  series: readonly Series[],
  styles: readonly SeriesStyle[],
  defaults: FieldOptions,
): { axes: AxisPlan[]; axisOf: AxisKey[] } {
  const optionsOf = (index: number) => series[index]?.options ?? defaults;
  const placementOf = (index: number) => optionsOf(index).axisPlacement ?? "auto";
  const unitOf = (index: number) => {
    const unit = optionsOf(index).unit;
    return unit === "none" ? undefined : unit;
  };
  // The left unit: the first series placed left on purpose, else the first automatic one.
  let leftUnit: string | undefined;
  let leftKnown = false;
  for (const wanted of ["left", "auto"] as const) {
    const first = series.findIndex((_, i) => placementOf(i) === wanted);
    if (first !== -1) {
      leftUnit = unitOf(first);
      leftKnown = true;
      break;
    }
  }
  const onRight = series.map((_, i) => {
    const placement = placementOf(i);
    return placement === "right" || (placement === "auto" && leftKnown && unitOf(i) !== leftUnit);
  });
  // The first axis is always "y" (thresholds and the pointer read it): with every series on the
  // right, the one axis there is "y".
  const anyLeft = onRight.some((right) => !right);
  const axisOf: AxisKey[] = onRight.map((right) => (right && anyLeft ? "y2" : "y"));
  const rightKey: AxisKey = anyLeft ? "y2" : "y";
  const percent = styles.some((style) => style.stack === "percent");
  const axes: AxisPlan[] = [];
  for (const key of ["y", "y2"] as const) {
    const members = axisOf.flatMap((k, i) => (k === key ? [i] : []));
    if (members.length === 0 && !(key === "y" && series.length === 0)) continue;
    const first = members[0] ?? 0;
    const options = optionsOf(first);
    const show = members.some((i) => placementOf(i) !== "hidden");
    const spec: ScaleSpec = { ...scaleSpecOf(options) };
    let unit = unitOf(first);
    let decimals = options.decimals;
    if (key === "y" && percent) {
      const negative = series.some(
        (s, i) => styles[i]?.stack === "percent" && s.values.some((v) => v < 0),
      );
      unit = "percent";
      decimals = undefined;
      spec.min = options.min ?? (negative ? -100 : 0);
      spec.max = options.max ?? 100;
    }
    axes.push({
      key,
      side: key === rightKey && onRight[first] === true ? "right" : "left",
      show,
      series: members,
      spec,
      label: options.axisLabel,
      width: options.axisWidth,
      grid: false,
      color: options.axisColor ?? "text",
      line: options.axisLine === true,
      unit,
      decimals,
    });
  }
  const shownLeft = axes.some((a) => a.side === "left" && a.show);
  for (const axis of axes) {
    const wanted = optionsOf(axis.series[0] ?? 0).axisGrid ?? "auto";
    axis.grid =
      wanted === "on" || (wanted === "auto" && axis.show && (axis.side === "left" || !shownLeft));
  }
  return { axes, axisOf };
}

/** How many points the log axes leave out (values ≤ 0), over all series on them. */
export function skippedPoints(
  series: readonly Series[],
  axes: readonly AxisPlan[],
  axisOf: readonly AxisKey[],
): number {
  let skipped = 0;
  series.forEach((s, i) => {
    const axis = axes.find((a) => a.key === axisOf[i]);
    if (axis !== undefined) skipped += skippedCount(axis.spec.scale, s.values);
  });
  return skipped;
}
