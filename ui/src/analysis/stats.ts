/**
 * Statistics over the values of a field, as the server computes them in
 * `server/src/analysis/stats.rs`: same formulas, same order of operations, so both give the same
 * digits. Empty values are left out before these run.
 */

export function sum(values: readonly number[]): number {
  let acc = 0;
  for (const v of values) acc += v;
  return acc;
}

export function mean(values: readonly number[]): number | null {
  return values.length === 0 ? null : sum(values) / values.length;
}

export function sorted(values: readonly number[]): number[] {
  return [...values].sort((a, b) => a - b);
}

/** The `p`th percentile (0 to 100) of sorted values, as Excel's PERCENTILE.INC. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const rank = (p / 100) * (values.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.min(Math.ceil(rank), values.length - 1);
  const a = values[lo] as number;
  const b = values[hi] as number;
  return a + (b - a) * (rank - lo);
}

/** The sample standard deviation (n - 1); needs two values. */
export function stddev(values: readonly number[]): number | null {
  if (values.length < 2) return null;
  const m = mean(values) as number;
  let squares = 0;
  for (const v of values) squares += (v - m) * (v - m);
  return Math.sqrt(squares / (values.length - 1));
}

export function min(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((a, b) => Math.min(a, b));
}

export function max(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((a, b) => Math.max(a, b));
}

export interface Line {
  slope: number;
  intercept: number;
  r2: number | null;
  n: number;
}

function moments(points: readonly (readonly [number, number])[]) {
  const n = points.length;
  let sx = 0;
  let sy = 0;
  for (const [x, y] of points) {
    sx += x;
    sy += y;
  }
  const mx = sx / n;
  const my = sy / n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const [x, y] of points) {
    const dx = x - mx;
    const dy = y - my;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  return { mx, my, sxx, sxy, syy };
}

/** The least-squares line of y over x; needs two points with different x. */
export function regression(points: readonly (readonly [number, number])[]): Line | null {
  if (points.length < 2) return null;
  const { mx, my, sxx, sxy, syy } = moments(points);
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  return {
    slope,
    intercept: my - slope * mx,
    r2: syy === 0 ? null : (sxy * sxy) / (sxx * syy),
    n: points.length,
  };
}

/** Pearson's correlation; needs two points and both series varying. */
export function correlation(points: readonly (readonly [number, number])[]): number | null {
  if (points.length < 2) return null;
  const { sxx, sxy, syy } = moments(points);
  if (sxx === 0 || syy === 0) return null;
  return Math.min(Math.max(sxy / (Math.sqrt(sxx) * Math.sqrt(syy)), -1), 1);
}

/** The trailing moving average: empty until the window is full, then the mean of its values. */
export function movingAverage(
  values: readonly (number | null)[],
  window: number,
): (number | null)[] {
  const w = Math.max(window, 1);
  const out: (number | null)[] = [];
  let total = 0;
  let count = 0;
  values.forEach((v, i) => {
    if (v !== null) {
      total += v;
      count++;
    }
    if (i >= w) {
      const old = values[i - w] ?? null;
      if (old !== null) {
        total -= old;
        count--;
      }
    }
    out.push(i + 1 < w || count === 0 ? null : total / count);
  });
  return out;
}
