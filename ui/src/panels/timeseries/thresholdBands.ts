import type { ThresholdDisplay, ThresholdStep, Thresholds } from "../fieldConfig/fieldConfig";
import type { SeriesStyle } from "./styles";

/** One threshold step as drawn over the plot: the value range it covers and its step. */
export interface Band {
  from: number;
  to: number;
  step: ThresholdStep;
}

/** The thresholds a chart draws, and how: from the first series that asks for them. */
export function shownThresholds(
  styles: readonly SeriesStyle[],
): { thresholds: Thresholds; display: Exclude<ThresholdDisplay, "off"> } | null {
  for (const style of styles) {
    if (style.thresholdDisplay !== "off" && style.thresholds !== undefined) {
      return { thresholds: style.thresholds, display: style.thresholdDisplay };
    }
  }
  return null;
}

/**
 * A step's value on the value axis. Percentage steps lie between the axis' ends, as the line's
 * threshold gradient places them (`schemeGradient`), so lines, bands and the coloured line agree.
 * Panels that colour single values (stat, gauge) take the percentage of the field's min and max
 * instead; a time series with fixed min and max has those as its axis ends, so the two match there.
 */
function axisValue(thresholds: Thresholds, value: number, min: number, max: number): number {
  return thresholds.mode === "percentage" ? min + (value / 100) * (max - min) : value;
}

/**
 * The steps as bands over the value axis from `min` to `max`, bottom up: each from its value (the
 * base step from the bottom) to the next step's value, clipped to the axis; bands outside it are
 * left out.
 */
export function thresholdBands(thresholds: Thresholds, min: number, max: number): Band[] {
  const [base, ...rest] = thresholds.steps;
  if (base === undefined || !(max > min)) {
    return [];
  }
  const steps = rest
    .filter((step) => step.value !== null)
    .map((step) => ({ step, at: axisValue(thresholds, step.value as number, min, max) }))
    .sort((a, b) => a.at - b.at);
  const bands: Band[] = [];
  let from = min;
  let current = base;
  for (const { step, at } of steps) {
    const to = Math.min(Math.max(at, min), max);
    if (to > from) {
      bands.push({ from, to, step: current });
    }
    from = Math.max(from, to);
    current = step;
  }
  if (max > from) {
    bands.push({ from, to: max, step: current });
  }
  return bands;
}

/** The step boundaries inside the axis, where lines are drawn, with the step that begins there. */
export function thresholdLines(
  thresholds: Thresholds,
  min: number,
  max: number,
): { value: number; step: ThresholdStep }[] {
  return thresholds.steps
    .slice(1)
    .filter((step) => step.value !== null)
    .map((step) => ({ value: axisValue(thresholds, step.value as number, min, max), step }))
    .filter(({ value }) => value > min && value < max);
}
