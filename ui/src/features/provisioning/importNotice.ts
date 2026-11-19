import { isRecord } from "../../api/client";

/*
 * The quiet line a dashboard shows after it came from a Grafana import (board
 * Provisioning.dc.html, frame 12). Kept in this browser until it is dismissed; the report itself
 * stays with the dashboard on the server.
 */

/** What the import left on a new dashboard for its first visit: the counts of its report. */
export interface ImportNotice {
  at: number;
  converted: number;
  approximated: number;
  skipped: number;
}

const NOTICE_PREFIX = "kalzit.imported.";

export function noticeKey(dashboardId: string): string {
  return `${NOTICE_PREFIX}${dashboardId}`;
}

export function parseNotice(stored: string | null): ImportNotice | null {
  if (stored === null || stored === "") return null;
  try {
    const value: unknown = JSON.parse(stored);
    if (
      isRecord(value) &&
      typeof value.at === "number" &&
      typeof value.converted === "number" &&
      typeof value.approximated === "number" &&
      typeof value.skipped === "number"
    ) {
      return {
        at: value.at,
        converted: value.converted,
        approximated: value.approximated,
        skipped: value.skipped,
      };
    }
  } catch {
    // Not ours, or cut off: no notice.
  }
  return null;
}
