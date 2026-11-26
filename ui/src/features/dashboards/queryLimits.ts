import type { TimeRange } from "../../api/generated/shapes";
import type { PanelModel } from "./model";
import { MAX_DATA_POINTS } from "./timeRange";

/**
 * A panel's query options (ParityEditors board, frame 5; docs/api/dashboard-features.md):
 * the most data points, the smallest interval and the cache time. The server applies the same
 * to the panel's stored queries (`routes::query::PanelLimits`), whatever a request asks; the UI
 * sends what they come to, so the editor's preview and the dashboard ask alike.
 */

/** The server's limits (`dashboards::model`). */
export const MAX_PANEL_DATA_POINTS = 10_000;
export const MAX_MIN_INTERVAL_MS = 86_400_000;
export const MAX_CACHE_TIMEOUT_MS = 86_400_000;

const UNIT_MS: Readonly<Record<string, number>> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};
const FIXED_DURATION = /^(\d{1,5})([smhd])$/;

/** A length of fixed size in milliseconds (`30s`, `5m`, `2h`, `1d`; not zero), else null. */
export function fixedDurationMs(text: string): number | null {
  const match = FIXED_DURATION.exec(text);
  if (match === null) return null;
  const n = Number(match[1]);
  return n > 0 ? n * (UNIT_MS[match[2] as string] as number) : null;
}

/** Whether `text` is a valid smallest interval: a fixed length up to a day. */
export function isMinInterval(text: string): boolean {
  const ms = fixedDurationMs(text);
  return ms !== null && ms <= MAX_MIN_INTERVAL_MS;
}

/** Whether `text` is a valid cache time: a fixed length up to a day. */
export function isCacheTimeout(text: string): boolean {
  const ms = fixedDurationMs(text);
  return ms !== null && ms <= MAX_CACHE_TIMEOUT_MS;
}

/** Whether `value` is a valid most data points: a whole number from 1 to 10,000. */
export function isMaxDataPoints(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= MAX_PANEL_DATA_POINTS;
}

/** The first query option that is not valid, or null. */
export function queryOptionsProblem(panel: PanelModel): string | null {
  if (panel.maxDataPoints !== undefined && !isMaxDataPoints(panel.maxDataPoints)) {
    return "maxDataPoints";
  }
  if (panel.minInterval !== undefined && !isMinInterval(panel.minInterval)) return "minInterval";
  if (panel.cacheTimeout !== undefined && !isCacheTimeout(panel.cacheTimeout)) {
    return "cacheTimeout";
  }
  return null;
}

/** What a panel's queries ask for over `range`: the data points and `$__interval`. */
export interface QueryLimits {
  maxDataPoints: number;
  intervalMs: number;
  /** The interval came from the smallest interval, not from the points. */
  raised: boolean;
}

/**
 * The data points and interval a panel's queries run with: its own most points (else the
 * default), the range spread over them (at least a second), raised to its smallest interval.
 */
export function queryLimits(panel: PanelModel, range: TimeRange): QueryLimits {
  const points =
    panel.maxDataPoints !== undefined && isMaxDataPoints(panel.maxDataPoints)
      ? panel.maxDataPoints
      : MAX_DATA_POINTS;
  const spread = Math.max(1000, Math.round((range.to - range.from) / points));
  const floor = panel.minInterval === undefined ? null : fixedDurationMs(panel.minInterval);
  const raised = floor !== null && floor > spread;
  return { maxDataPoints: points, intervalMs: raised ? floor : spread, raised };
}
