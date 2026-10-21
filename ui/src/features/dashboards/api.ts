import { queryOptions } from "@tanstack/react-query";
import { ApiError, expectShape, isRecord, request } from "../../api/client";
import type { Page, PanelQueryRequest, QueryResponse, TimeRange } from "../../api/generated/shapes";
import { orgPath } from "../datasources/api";
import { type DashboardModel, parseModel } from "./model";

/*
 * Folders and dashboards as docs/api/settings-dashboards.md specifies them. Request bodies carry
 * exactly the documented fields: the server answers unknown fields with 422 validation.
 */

export interface Folder {
  id: string;
  parentId: string | null;
  name: string;
  /** The folder's own flag; subfolders inherit the restriction. */
  restricted: boolean;
  version: number;
  deletedAt: number | null;
}

export interface DashboardSummary {
  id: string;
  folderId: string | null;
  title: string;
  version: number;
  updatedAt: number;
  deletedAt: number | null;
}

export interface Dashboard extends DashboardSummary {
  model: DashboardModel;
}

export interface DashboardVersion {
  version: number;
  createdAt: number;
  /** Current name of the author; null once the account is removed. */
  authorName: string | null;
  message: string;
  /** The version this one brought back, for restores. */
  restoredFrom: number | null;
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
const nullableNum = (value: unknown): number | null => (typeof value === "number" ? value : null);

/** Folders arrive as a tree (`FolderNode` with `children`); the UI works on the flat list. */
function flattenFolders(nodes: unknown[], into: Folder[] = []): Folder[] {
  for (const node of nodes) {
    if (!isRecord(node) || typeof node.id !== "string") {
      continue;
    }
    into.push({
      id: node.id,
      parentId: nullableId(node.parentId),
      name: str(node.name),
      restricted: node.restricted === true,
      version: num(node.version),
      deletedAt: nullableNum(node.deletedAt),
    });
    if (Array.isArray(node.children)) {
      flattenFolders(node.children, into);
    }
  }
  return into;
}

function parseSummary(value: unknown): DashboardSummary | null {
  if (!isRecord(value) || typeof value.id !== "string") {
    return null;
  }
  return {
    id: value.id,
    folderId: nullableId(value.folderId),
    title: str(value.title),
    version: num(value.version),
    updatedAt: num(value.updatedAt),
    deletedAt: nullableNum(value.deletedAt),
  };
}

function parseDashboard(value: unknown): Dashboard {
  const summary = parseSummary(value);
  if (summary === null || !isRecord(value) || typeof value.version !== "number") {
    return invalid("dashboard");
  }
  return { ...summary, model: parseModel(value.model, summary.title) };
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

async function folderPage(orgId: string, trashed: boolean): Promise<Folder[]> {
  const path = orgPath(orgId, "folders") + (trashed ? "?trashed=true" : "");
  const value = await request("GET", path);
  if (!isRecord(value) || !Array.isArray(value.items)) {
    return invalid("folder list");
  }
  return flattenFolders(value.items);
}

/** The visible folders not in the trash, parents before their children. */
export function fetchFolders(orgId: string): Promise<Folder[]> {
  return folderPage(orgId, false);
}

/** The top folder of every trashed subtree. */
export function fetchTrashedFolders(orgId: string): Promise<Folder[]> {
  return folderPage(orgId, true);
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

export async function purgeFolder(orgId: string, id: string): Promise<void> {
  await request("DELETE", orgPath(orgId, "folders", id, "purge"));
}

export interface DashboardFilter {
  folderId?: string | undefined;
  q?: string | undefined;
  /** The trash: dashboards deleted and not yet purged. */
  trashed?: boolean;
  cursor?: string | undefined;
}

export async function fetchDashboards(
  orgId: string,
  filter: DashboardFilter,
): Promise<Page<DashboardSummary>> {
  const params = new URLSearchParams();
  if (filter.folderId !== undefined) params.set("folderId", filter.folderId);
  if (filter.q !== undefined && filter.q !== "") params.set("q", filter.q);
  if (filter.trashed === true) params.set("trashed", "true");
  if (filter.cursor !== undefined) params.set("cursor", filter.cursor);
  const query = params.toString();
  const path = orgPath(orgId, "dashboards") + (query === "" ? "" : `?${query}`);
  return parsePage(await request("GET", path), parseSummary, "dashboard list");
}

export async function fetchDashboard(orgId: string, id: string): Promise<Dashboard> {
  return parseDashboard(await request("GET", orgPath(orgId, "dashboards", id)));
}

/** Creates version 1; the title is the model's. */
export async function createDashboard(
  orgId: string,
  input: { folderId: string | null; model: DashboardModel },
): Promise<{ id: string }> {
  return parseDashboard(await request("POST", orgPath(orgId, "dashboards"), input));
}

/** Saves a new version. A newer stored version answers `version_conflict` (409). */
export async function saveDashboard(
  orgId: string,
  id: string,
  input: { model: DashboardModel; version: number; message: string },
): Promise<void> {
  const body = input.message === "" ? { model: input.model, version: input.version } : input;
  await request("PUT", orgPath(orgId, "dashboards", id), body);
}

export async function deleteDashboard(orgId: string, id: string): Promise<void> {
  await request("DELETE", orgPath(orgId, "dashboards", id));
}

export async function restoreDashboard(orgId: string, id: string): Promise<void> {
  await request("POST", orgPath(orgId, "dashboards", id, "restore"));
}

export async function purgeDashboard(orgId: string, id: string): Promise<void> {
  await request("DELETE", orgPath(orgId, "dashboards", id, "purge"));
}

function parseVersion(value: unknown): DashboardVersion | null {
  if (!isRecord(value) || typeof value.version !== "number") {
    return null;
  }
  return {
    version: value.version,
    createdAt: num(value.createdAt),
    authorName: typeof value.authorName === "string" ? value.authorName : null,
    message: str(value.message),
    restoredFrom: nullableNum(value.restoredFrom),
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
