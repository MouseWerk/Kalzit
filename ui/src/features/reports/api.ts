import { queryOptions } from "@tanstack/react-query";
import {
  type DownloadedFile,
  expectShape,
  isApiError,
  isRecord,
  requestFile,
} from "../../api/client";
import type {
  Page,
  Report,
  ReportInput,
  ReportRun,
  ReportsStatus,
} from "../../api/generated/shapes";
import { orgPath, send } from "../datasources/api";

/**
 * Scheduled reports of an organization (docs/api/reports.md): the reports, their runs, the
 * preview of a draft and the status with the limits in force. The server checks every right;
 * the UI only hides what a person may not do.
 */

export type {
  Recipient,
  RecipientView,
  Report,
  ReportFormat,
  ReportInput,
  ReportLanguage,
  ReportRun,
  ReportsStatus,
  RunStatus,
  Schedule,
  Weekday,
} from "../../api/generated/shapes";

function isStatus(value: unknown): value is ReportsStatus {
  return isRecord(value) && typeof value.enabled === "boolean" && isRecord(value.limits);
}

export function isReport(value: unknown): value is Report {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    isRecord(value.schedule) &&
    Array.isArray(value.recipients) &&
    Array.isArray(value.formats)
  );
}

function isRun(value: unknown): value is ReportRun {
  return isRecord(value) && typeof value.id === "string" && typeof value.status === "string";
}

function isPageOf<T>(item: (value: unknown) => value is T) {
  return (value: unknown): value is Page<T> =>
    isRecord(value) && Array.isArray(value.items) && value.items.every(item);
}

const isReportPage = isPageOf(isReport);
const isRunPage = isPageOf(isRun);

const path = (orgId: string, ...rest: string[]) => orgPath(orgId, "reports", ...rest);

export async function fetchStatus(orgId: string, signal?: AbortSignal): Promise<ReportsStatus> {
  const value = await send("GET", path(orgId, "status"), undefined, signal);
  return expectShape(value, isStatus, "reports status");
}

/** Every report the person may see: an organization has at most a few hundred. */
export async function fetchReports(orgId: string, signal?: AbortSignal): Promise<Report[]> {
  const all: Report[] = [];
  let cursor: string | null = null;
  do {
    const query: string = cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`;
    const value = await send("GET", `${path(orgId)}?limit=200${query}`, undefined, signal);
    const page: Page<Report> = expectShape(value, isReportPage, "reports");
    all.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== null);
  return all;
}

export async function fetchReport(orgId: string, id: string, signal?: AbortSignal) {
  return expectShape(await send("GET", path(orgId, id), undefined, signal), isReport, "report");
}

export async function createReport(orgId: string, input: ReportInput): Promise<Report> {
  return expectShape(await send("POST", path(orgId), input), isReport, "report");
}

export async function updateReport(orgId: string, id: string, input: ReportInput) {
  return expectShape(await send("PUT", path(orgId, id), input), isReport, "report");
}

export async function deleteReport(orgId: string, id: string): Promise<void> {
  await send("DELETE", path(orgId, id));
}

/** Queues a run now; it goes to every recipient, like a scheduled one. */
export async function sendNow(orgId: string, id: string): Promise<ReportRun> {
  const value = await send("POST", path(orgId, id, "send"));
  if (!isRecord(value) || !isRun(value.run)) {
    return expectShape(undefined, isRun, "report run");
  }
  return value.run;
}

export async function fetchRuns(
  orgId: string,
  id: string,
  cursor: string | undefined,
  signal?: AbortSignal,
): Promise<Page<ReportRun>> {
  const query = cursor === undefined ? "" : `?cursor=${encodeURIComponent(cursor)}`;
  const value = await send("GET", `${path(orgId, id, "runs")}${query}`, undefined, signal);
  return expectShape(value, isRunPage, "report runs");
}

/** The PDF of a draft, drawn by the server with the caller's rights; nothing is stored or sent. */
export function previewReport(
  orgId: string,
  input: ReportInput,
  signal?: AbortSignal,
): Promise<DownloadedFile> {
  return requestFile(path(orgId, "preview"), input, { signal });
}

/**
 * Pauses or resumes a report on the version the caller saw (`409 version_conflict` otherwise).
 * Pausing never checks the report's content; resuming checks it as a save would.
 */
export async function setReportPaused(
  orgId: string,
  id: string,
  version: number,
  paused: boolean,
): Promise<Report> {
  const value = await send("POST", path(orgId, id, paused ? "pause" : "resume"), { version });
  return expectShape(value, isReport, "report");
}

/**
 * As `setReportPaused`, for the pages that hold no draft: when someone changed the report in the
 * meantime, the switch is set once more on the version the server answered with.
 */
export async function setLatestPaused(
  orgId: string,
  report: Report,
  paused: boolean,
): Promise<Report> {
  try {
    return await setReportPaused(orgId, report.id, report.version, paused);
  } catch (error) {
    if (isApiError(error, "version_conflict") && isReport(error.current)) {
      return setReportPaused(orgId, report.id, error.current.version, paused);
    }
    throw error;
  }
}

export const REPORTS_KEY = "reports";

/** The status changes with settings only; the navigation reads it on every page. */
const STATUS_STALE_MS = 60_000;

export function statusQuery(orgId: string) {
  return queryOptions({
    queryKey: [REPORTS_KEY, orgId, "status"],
    queryFn: ({ signal }) => fetchStatus(orgId, signal),
    staleTime: STATUS_STALE_MS,
  });
}

export function reportsQuery(orgId: string) {
  return queryOptions({
    queryKey: [REPORTS_KEY, orgId, "list"],
    queryFn: ({ signal }) => fetchReports(orgId, signal),
    staleTime: 30_000,
  });
}

export function reportQuery(orgId: string, id: string) {
  return queryOptions({
    queryKey: [REPORTS_KEY, orgId, "one", id],
    queryFn: ({ signal }) => fetchReport(orgId, id, signal),
  });
}
