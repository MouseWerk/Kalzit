import { textWidth } from "../measure";

/**
 * Room right of the plot area, in px. The last time label is centered on the plot's right edge;
 * with less room half of it ("04:00 P") was cut off. Half the width of the widest label,
 * "12:00 PM", at the axis font. Both charts use it, so the fallback looks like uPlot.
 */
export const TIME_LABEL_OVERHANG = 32;

/**
 * At least this many px from one time label to the next. A label such as "10:30 AM" is about
 * 55 px wide; uPlot's default of 50 px let neighbors touch.
 */
export const PX_PER_TIME_TICK = 110;

/** Width of the value axis while its labels are not known yet, and where text cannot be measured. */
export const VALUE_AXIS_SIZE = 56;

/** Tick length, the gap before the label and a little air, as uPlot draws a value axis. */
const VALUE_AXIS_CHROME = 18;

/**
 * Width of the value axis that fits its longest label at the axis font: a fixed width cut long
 * labels such as "225 EUR" at the panel's left edge, and left short ones in too much room.
 */
export function valueAxisSize(
  labels: readonly (string | null)[] | undefined,
  font: string,
): number {
  let widest = 0;
  for (const label of labels ?? []) {
    const width = label === null ? 0 : textWidth(label, font);
    if (width === undefined) {
      return VALUE_AXIS_SIZE;
    }
    widest = Math.max(widest, width);
  }
  return widest === 0 ? VALUE_AXIS_SIZE : Math.ceil(widest) + VALUE_AXIS_CHROME;
}
