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
