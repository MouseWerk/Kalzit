import type { Frame } from "../api/generated/shapes";
import type { LokiQuery } from "../features/datasources/queryKinds";
import { LEVELS, type Level, normalizeLevel } from "./levels";
import type { LogLine } from "./model";

/**
 * The volume by level above the list (board Logs.dc.html, frame 4): stacked bars over the whole
 * range. Where the source can count (Loki), a count query of its own counts every line in the
 * range with the same selector and filters; it runs beside the line query, read-only like any
 * query, and shows under "Inspect" as a second query. Without one the bars count the loaded lines
 * and say so ("from the 1,000 loaded lines").
 */

export interface VolumeBucket {
  from: number;
  to: number;
  counts: Record<Level, number>;
}

export interface Volume {
  from: number;
  to: number;
  stepMs: number;
  buckets: VolumeBucket[];
  totals: Record<Level, number>;
  /** "count": a count query over the whole range; "loaded": the lines loaded, which it says. */
  basis: "count" | "loaded";
}

/** Bar widths to choose from: the smallest that keeps the bars at about `bars` over the range. */
const STEPS = [
  1_000, 2_000, 5_000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000, 900_000,
  1_800_000, 3_600_000, 7_200_000, 10_800_000, 21_600_000, 43_200_000, 86_400_000, 172_800_000,
  604_800_000,
];
export const VOLUME_BARS = 60;

export function volumeStep(rangeMs: number, bars = VOLUME_BARS): number {
  const wanted = Math.max(1, rangeMs) / bars;
  return STEPS.find((step) => step >= wanted) ?? (STEPS[STEPS.length - 1] as number);
}

export function zeroCounts(): Record<Level, number> {
  return Object.fromEntries(LEVELS.map((level) => [level, 0])) as Record<Level, number>;
}

/**
 * LogQL without comments, which would swallow the rest once it is wrapped in a function. Text in
 * quotes and backticks stays as it is.
 */
export function withoutComments(logql: string): string {
  let out = "";
  let quote: string | null = null;
  for (let i = 0; i < logql.length; i += 1) {
    const c = logql[i] as string;
    if (quote !== null) {
      out += c;
      if (c === "\\" && quote !== "`" && i + 1 < logql.length) {
        out += logql[i + 1];
        i += 1;
      } else if (c === quote) {
        quote = null;
      }
      continue;
    }
    if (c === '"' || c === "`") {
      quote = c;
      out += c;
    } else if (c === "#") {
      const end = logql.indexOf("\n", i);
      i = end === -1 ? logql.length : end - 1;
    } else {
      out += c;
    }
  }
  return out.trim();
}

/** Whether a LogQL query reads lines (a stream selector first) rather than numbers. */
export function isLogQuery(logql: string): boolean {
  return /^\s*\{/.test(withoutComments(logql));
}

/**
 * Loki's count query for a log query: the lines per bar and level over the whole range, with the
 * same selector and pipeline. The level is the `level` label, else Loki's `detected_level`; lines
 * with neither count as "unknown". Null for a metric query or an instant query.
 */
export function lokiVolumeQuery(query: LokiQuery, stepMs: number): LokiQuery | null {
  if (query.instant === true || !isLogQuery(query.logql)) {
    return null;
  }
  return {
    logql: `sum by (level, detected_level) (count_over_time(${withoutComments(query.logql)} [$__interval]))`,
    minStepMs: stepMs,
  };
}

function bucketsOver(from: number, to: number, stepMs: number): VolumeBucket[] {
  const start = Math.floor(from / stepMs) * stepMs;
  const buckets: VolumeBucket[] = [];
  for (let at = start; at < to && buckets.length < 10_000; at += stepMs) {
    buckets.push({ from: at, to: at + stepMs, counts: zeroCounts() });
  }
  return buckets;
}

function totalsOf(buckets: readonly VolumeBucket[]): Record<Level, number> {
  const totals = zeroCounts();
  for (const bucket of buckets) {
    for (const level of LEVELS) {
      totals[level] += bucket.counts[level];
    }
  }
  return totals;
}

/** The loaded lines counted per bar and level. */
export function volumeFromLines(
  lines: readonly LogLine[],
  range: { from: number; to: number },
  stepMs: number,
): Volume {
  const buckets = bucketsOver(range.from, range.to, stepMs);
  const first = buckets[0]?.from ?? range.from;
  for (const line of lines) {
    if (line.timeMs === null) continue;
    const bucket = buckets[Math.floor((line.timeMs - first) / stepMs)];
    if (bucket !== undefined) {
      bucket.counts[line.level] += 1;
    }
  }
  return { ...range, stepMs, buckets, totals: totalsOf(buckets), basis: "loaded" };
}

/**
 * The answer of the count query as bars: one series per level label, a count at the end of each
 * step. A sample at `t` counts the lines of the step before it.
 */
export function volumeFromFrame(
  frame: Frame,
  range: { from: number; to: number },
  stepMs: number,
): Volume {
  const times = frame.fields.find((field) => field.type === "time")?.values ?? [];
  const byStart = new Map<number, VolumeBucket>();
  for (const field of frame.fields) {
    if (field.type === "time") continue;
    const level = normalizeLevel(field.labels?.level ?? field.labels?.detected_level);
    field.values.forEach((value, row) => {
      const at = Number(times[row]);
      const count = Number(value);
      if (!Number.isFinite(at) || !Number.isFinite(count) || count <= 0) return;
      const start = at - stepMs;
      let bucket = byStart.get(start);
      if (bucket === undefined) {
        bucket = { from: start, to: at, counts: zeroCounts() };
        byStart.set(start, bucket);
      }
      bucket.counts[level] += count;
    });
  }
  const buckets = [...byStart.values()].sort((a, b) => a.from - b.from);
  return { ...range, stepMs, buckets, totals: totalsOf(buckets), basis: "count" };
}

/** The highest stack of a bar, for the axis. */
export function tallest(volume: Volume): number {
  let max = 0;
  for (const bucket of volume.buckets) {
    let sum = 0;
    for (const level of LEVELS) sum += bucket.counts[level];
    max = Math.max(max, sum);
  }
  return max;
}

/** A round top for the axis and its ticks: 0, half and the top. */
export function axisTop(max: number): number {
  if (max <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(max));
  for (const factor of [1, 2, 2.5, 5, 10]) {
    if (factor * magnitude >= max) return factor * magnitude;
  }
  return 10 * magnitude;
}
