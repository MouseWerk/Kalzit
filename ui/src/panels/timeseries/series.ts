import type { Frame } from "../../api/generated/shapes";
import { seriesName, timeField, toNumber, valueFields } from "../frame";

/** One line: times ascending (Unix ms) and values, NaN where the row has no value. */
export interface Series {
  name: string;
  times: Float64Array;
  values: Float64Array;
}

/** Every number or int64 field of every frame with a time field becomes one series. */
export function buildSeries(frames: readonly Frame[], legend = ""): Series[] {
  const series: Series[] = [];
  for (const frame of frames) {
    const time = timeField(frame);
    if (time === undefined) {
      continue;
    }
    const count = time.values.length;
    const times = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      times[i] = toNumber(time.values[i]) ?? Number.NaN;
    }
    for (const field of valueFields(frame)) {
      const values = new Float64Array(count);
      for (let i = 0; i < count; i++) {
        values[i] = toNumber(field.values[i]) ?? Number.NaN;
      }
      series.push({ name: seriesName(field, legend), times, values });
    }
  }
  return series;
}

export interface Extent {
  min: number;
  max: number;
}

/** The smallest and largest finite value over all series, or null when there is none. */
export function valueExtent(series: readonly Series[]): Extent | null {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const { values } of series) {
    for (let i = 0; i < values.length; i++) {
      const value = values[i] as number;
      if (value < min) min = value;
      if (value > max) max = value;
    }
  }
  return Number.isFinite(min) && Number.isFinite(max) ? { min, max } : null;
}

export interface Scale {
  /** Data value to pixel. */
  x: (time: number) => number;
  y: (value: number) => number;
}

/**
 * The SVG path of a series, reduced to at most four points per pixel column (first, smallest,
 * largest, last), so 100,000 points draw as a few thousand without changing the picture. A row
 * without a value breaks the line instead of bridging the gap.
 */
export function seriesPath(series: Series, scale: Scale, width: number): string {
  const { times, values } = series;
  const parts: string[] = [];
  let penDown = false;
  let column = Number.NaN;
  let first = -1;
  let last = -1;
  let low = -1;
  let high = -1;

  const flush = () => {
    if (first === -1) {
      return;
    }
    const indexes = [...new Set([first, low, high, last])].sort((a, b) => a - b);
    for (const index of indexes) {
      const x = scale.x(times[index] as number).toFixed(1);
      const y = scale.y(values[index] as number).toFixed(1);
      parts.push(`${penDown ? "L" : "M"}${x} ${y}`);
      penDown = true;
    }
    first = -1;
  };

  for (let i = 0; i < times.length; i++) {
    const value = values[i] as number;
    const time = times[i] as number;
    if (Number.isNaN(value) || Number.isNaN(time)) {
      flush();
      penDown = false;
      continue;
    }
    const px = Math.floor(Math.min(Math.max(scale.x(time), -1), width + 1));
    if (px !== column) {
      flush();
      column = px;
    }
    if (first === -1) {
      first = i;
      low = i;
      high = i;
    }
    if (value < (values[low] as number)) low = i;
    if (value > (values[high] as number)) high = i;
    last = i;
  }
  flush();
  return parts.join("");
}

/** Index of the point nearest to `time` in an ascending time array, for the hover readout. */
export function nearestIndex(times: Float64Array, time: number): number {
  let lo = 0;
  let hi = times.length - 1;
  if (hi < 0) {
    return -1;
  }
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((times[mid] as number) < time) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  if (lo > 0 && time - (times[lo - 1] as number) < (times[lo] as number) - time) {
    return lo - 1;
  }
  return lo;
}

/** Round tick values between min and max, about `count` of them. */
export function niceTicks(min: number, max: number, count: number): number[] {
  if (!(max > min)) {
    return [min];
  }
  const raw = (max - min) / Math.max(count, 1);
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((f) => f * magnitude).find((s) => s >= raw) ?? raw;
  const ticks: number[] = [];
  for (let tick = Math.ceil(min / step) * step; tick <= max + step * 1e-9; tick += step) {
    ticks.push(Number(tick.toPrecision(12)));
  }
  return ticks;
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const TIME_STEPS = [
  SECOND,
  5 * SECOND,
  15 * SECOND,
  30 * SECOND,
  MINUTE,
  5 * MINUTE,
  15 * MINUTE,
  30 * MINUTE,
  HOUR,
  3 * HOUR,
  6 * HOUR,
  12 * HOUR,
  DAY,
  7 * DAY,
  30 * DAY,
  365 * DAY,
];

/**
 * Time ticks at round steps. Steps of a day or more fall on local midnight, so a day tick reads
 * "20.10." and not "20.10. 02:00" in a time zone east of UTC.
 */
export function timeTicks(
  from: number,
  to: number,
  count: number,
): { ticks: number[]; step: number } {
  const span = to - from;
  const step = TIME_STEPS.find((s) => span / s <= count) ?? (TIME_STEPS.at(-1) as number);
  const ticks: number[] = [];
  if (step >= DAY) {
    const start = new Date(from);
    start.setHours(0, 0, 0, 0);
    const days = Math.round(step / DAY);
    for (let d = new Date(start); d.getTime() <= to; d.setDate(d.getDate() + days)) {
      if (d.getTime() >= from) {
        ticks.push(d.getTime());
      }
    }
  } else if (step >= HOUR) {
    // Hour steps are counted on the local clock tick by tick, so they stay on 00:00, 06:00, 12:00
    // across a daylight saving change instead of drifting to 01:00 after it.
    const hours = Math.round(step / HOUR);
    const d = new Date(from);
    d.setMinutes(0, 0, 0);
    if (d.getTime() < from) {
      d.setHours(d.getHours() + 1);
    }
    while (d.getHours() % hours !== 0) {
      d.setHours(d.getHours() + 1);
    }
    for (let guard = 0; d.getTime() <= to && guard < 1000; guard++) {
      ticks.push(d.getTime());
      const before = d.getHours();
      d.setHours(before + hours);
      // A skipped or repeated hour can leave the clock off the grid; put it back on.
      while (d.getHours() % hours !== 0) {
        d.setHours(d.getHours() + 1);
      }
    }
  } else {
    // Steps below an hour divide an hour, and zones move by whole hours, so a fixed step from a
    // local boundary stays on local boundaries.
    const offset = new Date(from).getTimezoneOffset() * MINUTE;
    for (let t = Math.ceil((from - offset) / step) * step + offset; t <= to; t += step) {
      ticks.push(t);
    }
  }
  return { ticks, step };
}
