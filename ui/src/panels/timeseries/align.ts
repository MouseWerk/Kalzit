import type { Series } from "./series";

/**
 * Series as uPlot takes them: one shared, ascending x array and one y array per series, null where
 * a series has no value at that x (uPlot breaks the line there). Series of one frame share their
 * time array already; series of different frames are merged onto the union of their times.
 */
export function alignSeries(series: readonly Series[]): [number[], ...(number | null)[][]] {
  const groups = new Map<Float64Array, number[]>();
  series.forEach((s, index) => {
    const members = groups.get(s.times) ?? [];
    members.push(index);
    groups.set(s.times, members);
  });
  const yOf = (values: Float64Array, i: number) => {
    const value = values[i] as number;
    return Number.isNaN(value) ? null : value;
  };

  if (groups.size <= 1) {
    const times = series[0]?.times ?? new Float64Array();
    const x: number[] = [];
    const keep: number[] = [];
    for (let i = 0; i < times.length; i++) {
      const time = times[i] as number;
      if (!Number.isNaN(time)) {
        x.push(time);
        keep.push(i);
      }
    }
    return [x, ...series.map((s) => keep.map((i) => yOf(s.values, i)))];
  }

  const all = new Set<number>();
  for (const times of groups.keys()) {
    for (const time of times) {
      if (!Number.isNaN(time)) all.add(time);
    }
  }
  const x = [...all].sort((a, b) => a - b);
  const column = new Map(x.map((time, i) => [time, i]));
  const ys = series.map((s) => {
    const y: (number | null)[] = new Array(x.length).fill(null);
    for (let i = 0; i < s.times.length; i++) {
      const at = column.get(s.times[i] as number);
      if (at !== undefined) {
        y[at] = yOf(s.values, i);
      }
    }
    return y;
  });
  return [x, ...ys];
}
