import { type DownloadedFile, isApiError, requestFile } from "../api/client";
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

/**
 * Asks for the file with the calendar in effect. A zone the browser knows but the server's zone
 * data does not (a newer name) is refused; the file is then made in UTC rather than not at all.
 */
async function requestWithCalendar<T extends { timeZone?: string; weekStart?: string }>(
  path: string,
  body: T,
  signal: AbortSignal | undefined,
): Promise<DownloadedFile> {
  const calendar = calendarOf(getTimeSettings());
  const full = { timeZone: calendar.timeZone, weekStart: calendar.weekStart, ...body };
  try {
    return await requestFile(path, full, { signal });
  } catch (e) {
    if (body.timeZone !== undefined || !isApiError(e, "validation") || e.field !== "timeZone") {
      throw e;
    }
    const { timeZone: _unknown, ...withoutZone } = full;
    return requestFile(path, withoutZone, { signal });
  }
}

export function exportQuery(
  orgId: string,
  body: ExportRequest,
  signal?: AbortSignal,
): Promise<DownloadedFile> {
  return requestWithCalendar(orgPath(orgId, "export"), body, signal);
}

export function exportPanel(
  orgId: string,
  dashboardId: string,
  panelId: string,
  body: PanelExportRequest,
  signal?: AbortSignal,
): Promise<DownloadedFile> {
  const path = orgPath(orgId, "dashboards", dashboardId, "panels", panelId, "export");
  return requestWithCalendar(path, body, signal);
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
