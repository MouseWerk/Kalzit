/** The room kept between two category names side by side, in px. */
export const LABEL_GAP = 12;
/** Height of a name's line, in px. */
export const LABEL_LINE = 14;
/** Room under the plot for names written straight, in px. */
export const FLAT_HEIGHT = 24;
/** Turned names take at most this share of the chart's height, so the bars keep the rest. */
const MAX_TURNED_SHARE = 0.4;
/** A turned name shorter than this (px) says too little; the names stay straight and thin out. */
const MIN_TURNED_WIDTH = 28;
/** From the plot's bottom to where a turned name starts, in px. */
export const TURNED_OFFSET = 6;
const SIN45 = Math.SQRT1_2;

export interface CategoryLabels {
  /** Every n-th category gets its name, from the first, so the names are spread evenly. */
  every: number;
  /** Names are turned 45 degrees and run down to the left from their category. */
  turned: boolean;
  /** Longer names are shortened with an ellipsis to this many px. */
  maxWidth: number;
  /** Px the names take under the plot. */
  height: number;
}

/**
 * Where the category names under a bar chart go. Straight under their bars while the longest
 * fits its category; turned 45 degrees where it does not, so every name (or every second, ...)
 * still shows, shortened to the room under the plot and to the room left of the first one; and
 * straight but thinned out evenly where even turned names would be cut to a stub.
 *
 * `widths` are the names' widths in px, `group` a category's width, `firstX` the middle of the
 * first category from the chart's left edge, `height` the chart's height and `lastRoom` the room
 * from the middle of the last category to the chart's right edge.
 */
export function categoryLabels(
  widths: readonly number[],
  group: number,
  firstX: number,
  height: number,
  lastRoom: number = firstX,
): CategoryLabels {
  const longest = Math.max(0, ...widths);
  if (!(group > 0) || longest + LABEL_GAP <= group) {
    return {
      every: 1,
      turned: false,
      maxWidth: Math.max(group - LABEL_GAP, longest),
      height: FLAT_HEIGHT,
    };
  }
  // Turned names stand LABEL_LINE apart across their slant once their bars are this far apart.
  const pitch = LABEL_LINE / SIN45;
  const every = Math.max(Math.ceil(pitch / group - 1e-9), 1);
  const room = Math.max(height * MAX_TURNED_SHARE, FLAT_HEIGHT);
  // A turned name of width w reaches w * sin45 down and w * cos45 left of its category's middle.
  const byHeight = (room - TURNED_OFFSET - LABEL_LINE * SIN45) / SIN45;
  const byLeft = firstX / SIN45;
  const maxWidth = Math.floor(Math.min(longest, byHeight, byLeft));
  if (maxWidth >= MIN_TURNED_WIDTH) {
    return {
      every,
      turned: true,
      maxWidth,
      height: Math.ceil(TURNED_OFFSET + (maxWidth + LABEL_LINE) * SIN45),
    };
  }
  // A name at an edge moves inward by what it lacks there (clampLabel); the spacing allows for
  // that, so it never reaches into the next shown name.
  const shift = Math.max(longest / 2 - Math.min(firstX, lastRoom), 0);
  const thinned = Math.max(Math.ceil((longest + LABEL_GAP + shift) / group - 1e-9), 1);
  return {
    every: thinned,
    turned: false,
    maxWidth: Math.max(Math.floor(Math.min(longest, thinned * group - LABEL_GAP - shift)), 0),
    height: FLAT_HEIGHT,
  };
}

/**
 * Where a straight name centered on `x` goes so it stays whole inside a chart `width` px wide:
 * names at the edges move inward instead of being cut.
 */
export function clampLabel(x: number, labelWidth: number, width: number): number {
  const half = labelWidth / 2;
  if (labelWidth >= width) {
    return width / 2;
  }
  return Math.min(Math.max(x, half), width - half);
}
