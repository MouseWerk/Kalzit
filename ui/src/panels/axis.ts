import { axisTickFormat } from "./fieldConfig/units";
import { shortenText } from "./measure";
import { niceTicks } from "./timeseries/series";

/** A value axis takes at most this share of the chart's width; the plot keeps the rest. */
export const MAX_AXIS_SHARE = 0.3;

/**
 * Value axis labels that fit `maxWidth` px: with their unit when that fits; else as short plain
 * numbers (40 k instead of 40,000 orders), the unit still in the tooltip; else cut with an
 * ellipsis. `measure` gives a label's width in px.
 */
export function fitAxisLabels(
  ticks: readonly number[],
  unit: string | undefined,
  decimals: number | undefined,
  language: string,
  maxWidth: number,
  measure: (text: string) => number,
  font: string | null = null,
): string[] {
  const widest = (texts: readonly string[]) => Math.max(0, ...texts.map(measure));
  const full = ticks.map(axisTickFormat(ticks, unit, decimals, language));
  if (widest(full) <= maxWidth || unit === undefined) {
    return widest(full) <= maxWidth ? full : full.map((text) => shortenText(text, maxWidth, font));
  }
  const plain = ticks.map(axisTickFormat(ticks, undefined, undefined, language));
  if (widest(plain) <= maxWidth) {
    return plain;
  }
  return plain.map((text) => shortenText(text, maxWidth, font));
}

export interface ValueAxis {
  /** Round tick values from min to max. */
  ticks: number[];
  min: number;
  max: number;
}

/**
 * A value axis for bars: round ticks about `count` apart, with open ends rounded outward to the
 * next tick so no value is cut off (a bar of 120 on ticks of 50 gets an axis to 150, a bar of
 * -37 one from -50). Ends fixed in the field options are kept exactly, and only the ticks
 * between them are drawn.
 */
export function valueAxis(
  low: number,
  high: number,
  count: number,
  fixed: { min?: number | undefined; max?: number | undefined } = {},
): ValueAxis {
  const from = fixed.min ?? low;
  const to = fixed.max ?? high;
  const rough = niceTicks(from, to, count);
  const step = rough.length > 1 ? (rough[1] as number) - (rough[0] as number) : 0;
  if (!(step > 0)) {
    const only = rough[0] ?? from;
    // One value (or none): the axis runs from zero to it, or to one when it is zero.
    return {
      ticks: [only],
      min: fixed.min ?? Math.min(only, 0),
      max: fixed.max ?? (Math.max(only, 0) || 1),
    };
  }
  const min = fixed.min ?? Math.floor(from / step + 1e-9) * step;
  const max = fixed.max ?? Math.ceil(to / step - 1e-9) * step;
  const ticks: number[] = [];
  for (let tick = Math.ceil(min / step - 1e-9) * step; tick <= max + step * 1e-9; tick += step) {
    ticks.push(Number(tick.toPrecision(12)));
  }
  return { ticks, min: Number(min.toPrecision(12)), max: Number(max.toPrecision(12)) };
}
