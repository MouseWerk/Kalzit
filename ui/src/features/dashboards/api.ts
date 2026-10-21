import { queryOptions } from "@tanstack/react-query";
import { ApiError, expectShape, isRecord, request } from "../../api/client";
import type { Page, PanelQueryRequest, QueryResponse, TimeRange } from "../../api/generated/shapes";
import { orgPath } from "../datasources/api";
import { type DashboardModel, parseModel } from "./model";

export interface Folder {
  id: string;
  parentId: string | null;
  name: string;
  restricted: boolean;
  canEdit: boolean;
  /** Sent back with a change; the folder list is assumed to carry it like every versioned item. */
  version: number;
}

export interface DashboardSummary {
  id: string;
  title: string;
  folderId: string | null;
  updatedAt: number;
  updatedBy: string;
  deletedAt?: number;
}

export interface Dashboard {
  id: string;
  title: string;
  folderId: string | null;
  version: number;
  model: DashboardModel;
  canEdit: boolean;
}

export interface DashboardVersion {
  version: number;
  createdAt: number;
  createdBy: string;
  message: string;
}

export interface VariableOption {
  value: string;
  label: string;
}

function invalid(what: string): never {
  throw new ApiError("invalid_response", 200, `unexpected ${what} response`);
}

const str = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : fallback;
const num = (value: unknown, fallback = 0): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;
const nullableId = (value: unknown): string | null => (typeof value === "string" ? value : null);

function parseFolder(value: unknown): Folder | null {
  if (!isRecord(value) || typeof value.id !== "string") {
    return null;
  }
  return {
    id: value.id,
    parentId: nullableId(value.parentId),
    name: str(value.name),
    restricted: value.restricted === true,
    canEdit: value.canEdit === true,
    version: num(value.version),
  };
}

function parseSummary(value: unknown): DashboardSummary | null {
  if (!isRecord(value) || typeof value.id !== "string") {
    return null;
  }
  const summary: DashboardSummary = {
    id: value.id,
    title: str(value.title),
    folderId: nullableId(value.folderId),
    updatedAt: num(value.updatedAt),
    updatedBy: str(value.updatedBy),
  };
  if (typeof value.deletedAt === "number") {
    summary.deletedAt = value.deletedAt;
  }
  return summary;
}

function parseDashboard(value: unknown): Dashboard {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.version !== "number") {
    return invalid("dashboard");
  }
  const title = str(value.title);
  return {
    id: value.id,
    title,
    folderId: nullableId(value.folderId),
    version: value.version,
    model: parseModel(value.model, title),
    canEdit: value.canEdit === true,
  };
}

function parsePage<T>(value: unknown, item: (v: unknown) => T | null, what: string) {
  if (!isRecord(value) || !Array.isArray(value.items)) {
    return invalid(what);
  }
  return {
    items: value.items.map(item).filter((v): v is T => v !== null),
    nextCursor: typeof value.nextCursor === "string" ? value.nextCursor : null,
  } satisfies Page<T>;
}

export async function fetchFolders(orgId: string): Promise<Folder[]> {
  const value = await request("GET", orgPath(orgId, "folders"));
  if (!Array.isArray(value)) {
    return invalid("folder list");
  }
  return value.map(parseFolder).filter((f) => f !== null);
}

export async function createFolder(
  orgId: string,
  input: { name: string; parentId: string | null },
): Promise<void> {
  await request("POST", orgPath(orgId, "folders"), input);
}

export async function updateFolder(
  orgId: string,
  id: string,
  patch: { name?: string; parentId?: string | null; restricted?: boolean; version: number },
): Promise<void> {
  await request("PATCH", orgPath(orgId, "folders", id), patch);
}

export async function deleteFolder(orgId: string, id: string): Promise<void> {
  await request("DELETE", orgPath(orgId, "folders", id));
}

export async function restoreFolder(orgId: string, id: string): Promise<void> {
  await request("POST", orgPath(orgId, "folders", id, "restore"));
}

export interface DashboardFilter {
  folderId?: string | undefined;
  q?: string | undefined;
  /** The trash: dashboards deleted and not yet purged. */
  deleted?: boolean;
  cursor?: string | undefined;
}

export async function fetchDashboards(
  orgId: string,
  filter: DashboardFilter,
): Promise<Page<DashboardSummary>> {
  const params = new URLSearchParams();
  if (filter.folderId !== undefined) params.set("folderId", filter.folderId);
  if (filter.q !== undefined && filter.q !== "") params.set("q", filter.q);
  if (filter.deleted === true) params.set("deleted", "true");
  if (filter.cursor !== undefined) params.set("cursor", filter.cursor);
  const query = params.toString();
  const path = orgPath(orgId, "dashboards") + (query === "" ? "" : `?${query}`);
  return parsePage(await request("GET", path), parseSummary, "dashboard list");
}

export async function fetchDashboard(orgId: string, id: string): Promise<Dashboard> {
  return parseDashboard(await request("GET", orgPath(orgId, "dashboards", id)));
}

export async function createDashboard(
  orgId: string,
  input: { title: string; folderId: string | null; model: DashboardModel },
): Promise<{ id: string }> {
  const value = await request("POST", orgPath(orgId, "dashboards"), input);
  if (!isRecord(value) || typeof value.id !== "string") {
    return invalid("dashboard");
  }
  return { id: value.id };
}

/** Saves a new version. A newer stored version answers `version_conflict` (409). */
export async function saveDashboard(
  orgId: string,
  id: string,
  input: { model: DashboardModel; version: number; message: string },
): Promise<void> {
  await request("PUT", orgPath(orgId, "dashboards", id), input);
}

export async function deleteDashboard(orgId: string, id: string): Promise<void> {
  await request("DELETE", orgPath(orgId, "dashboards", id));
}

export async function restoreDashboard(orgId: string, id: string): Promise<void> {
  await request("POST", orgPath(orgId, "dashboards", id, "restore"));
}

function parseVersion(value: unknown): DashboardVersion | null {
  if (!isRecord(value) || typeof value.version !== "number") {
    return null;
  }
  return {
    version: value.version,
    createdAt: num(value.createdAt),
    createdBy: str(value.createdBy),
    message: str(value.message),
  };
}

export async function fetchVersions(
  orgId: string,
  id: string,
  cursor?: string,
): Promise<Page<DashboardVersion>> {
  const path = orgPath(orgId, "dashboards", id, "versions");
  return parsePage(
    await request(
      "GET",
      cursor === undefined ? path : `${path}?cursor=${encodeURIComponent(cursor)}`,
    ),
    parseVersion,
    "version list",
  );
}

export async function fetchVersionModel(
  orgId: string,
  id: string,
  version: number,
): Promise<DashboardModel> {
  const value = await request("GET", orgPath(orgId, "dashboards", id, "versions", String(version)));
  return parseModel(isRecord(value) ? value.model : undefined, "");
}

export async function restoreVersion(orgId: string, id: string, version: number): Promise<void> {
  await request("POST", orgPath(orgId, "dashboards", id, "versions", String(version), "restore"));
}

function isQueryResponse(value: unknown): value is QueryResponse {
  return isRecord(value) && isRecord(value.results);
}

/**
 * Runs a panel's stored queries, as viewers do. The signal is checked before sending, so a query
 * that waited in line and is no longer needed never reaches the server.
 */
export async function runPanelQuery(
  orgId: string,
  dashboardId: string,
  panelId: string,
  body: PanelQueryRequest,
  signal?: AbortSignal,
): Promise<QueryResponse> {
  signal?.throwIfAborted();
  const path = orgPath(orgId, "dashboards", dashboardId, "panels", panelId, "query");
  return expectShape(await request("POST", path, body), isQueryResponse, "panel query");
}

export async function fetchVariableOptions(
  orgId: string,
  dashboardId: string,
  name: string,
  body: { timeRange: TimeRange; variables: Record<string, unknown> },
): Promise<VariableOption[]> {
  const path = orgPath(orgId, "dashboards", dashboardId, "variables", name, "options");
  const value = await request("POST", path, body);
  if (!isRecord(value) || !Array.isArray(value.options)) {
    return invalid("variable options");
  }
  return value.options.flatMap((option) =>
    isRecord(option) && typeof option.value === "string"
      ? [{ value: option.value, label: str(option.label, option.value) }]
      : [],
  );
}

export const FOLDERS_KEY = "folders";
export const DASHBOARDS_KEY = "dashboards";

export function foldersQuery(orgId: string) {
  return queryOptions({
    queryKey: [FOLDERS_KEY, orgId],
    queryFn: () => fetchFolders(orgId),
  });
}

export function dashboardQuery(orgId: string, id: string) {
  return queryOptions({
    queryKey: [DASHBOARDS_KEY, orgId, "one", id],
    queryFn: () => fetchDashboard(orgId, id),
  });
}
