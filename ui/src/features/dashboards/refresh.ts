import type { Translate } from "../../i18n/i18n";
import { formatDuration } from "./timeRange";

/** The automatic refresh intervals Kalzit offers when a dashboard does not set its own, seconds. */
export const DEFAULT_REFRESH_INTERVALS: readonly number[] = [10, 30, 60, 300, 900, 1800, 3600];

/** The server's bounds for an interval (dashboards/model.rs). */
export const MIN_REFRESH_SECONDS = 5;
export const MAX_REFRESH_SECONDS = 24 * 3600;
export const MAX_REFRESH_INTERVALS = 20;

/**
 * The intervals to offer: the dashboard's list, else Kalzit's, plus the one running now so the
 * menu always shows what is checked. 0 (off) is not part of the list.
 */
export function refreshIntervals(own: readonly number[] | undefined, running = 0): number[] {
  const list = own !== undefined && own.length > 0 ? [...own] : [...DEFAULT_REFRESH_INTERVALS];
  if (running > 0 && !list.includes(running)) {
    list.push(running);
  }
  return list.sort((a, b) => a - b);
}

/** An interval for people: "Every 30 seconds", "Every 5 minutes", "Every hour". */
export function intervalLabel(t: Translate, seconds: number): string {
  if (seconds <= 0) {
    return t("dashboards.refresh.off");
  }
  if (seconds % 3600 === 0) {
    const n = seconds / 3600;
    return n === 1 ? t("toolbar.refresh.everyHour") : t("toolbar.refresh.everyHours", { n });
  }
  if (seconds % 60 === 0) {
    const n = seconds / 60;
    return n === 1 ? t("toolbar.refresh.everyMinute") : t("toolbar.refresh.everyMinutes", { n });
  }
  return t("toolbar.refresh.everySeconds", { n: seconds });
}

/** The short form beside the refresh button: "30s", "5m", "1h". */
export function intervalShort(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

/** An interval list as the settings show it: "10s, 1m, 5m". */
export function formatDurationList(seconds: readonly number[]): string {
  return seconds.map(formatDuration).join(", ");
}
