import { type DownloadedFile, requestFile } from "../api/client";
import type { ExportRequest, PanelExportRequest } from "../api/generated/shapes";
import { orgPath } from "../features/datasources/api";
import { getTimeSettings } from "../lib/timeSettings";
import { calendarOf } from "./panel";

/**
 * Exports (docs/api/datasources.md, "Export"). The server runs the queries and steps itself and
 * checks `data:export` with the same rights as running them; the UI only offers the action.
 * Calculated fields in the file read times in the calendar the screen shows (`timeZone`,
 * `weekStart`), unless the caller names one.
 */

function withCalendar<T extends { timeZone?: string; weekStart?: string }>(body: T): T {
  const calendar = calendarOf(getTimeSettings());
  return { timeZone: calendar.timeZone, weekStart: calendar.weekStart, ...body };
}

export function exportQuery(
  orgId: string,
  body: ExportRequest,
  signal?: AbortSignal,
): Promise<DownloadedFile> {
  return requestFile(orgPath(orgId, "export"), withCalendar(body), { signal });
}

export function exportPanel(
  orgId: string,
  dashboardId: string,
  panelId: string,
  body: PanelExportRequest,
  signal?: AbortSignal,
): Promise<DownloadedFile> {
  const path = orgPath(orgId, "dashboards", dashboardId, "panels", panelId, "export");
  return requestFile(path, withCalendar(body), { signal });
}

/** Hands a file to the browser's download. */
export function saveFile(file: DownloadedFile): void {
  const url = URL.createObjectURL(file.blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = file.filename;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  // Revoked after the click has handed the file over.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
