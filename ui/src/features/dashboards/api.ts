import { queryOptions } from "@tanstack/react-query";
import { ApiError, expectShape, isRecord } from "../../api/client";
import type { Page, PanelQueryRequest, QueryResponse, TimeRange } from "../../api/generated/shapes";
import { orgPath, send } from "../datasources/api";
import { type DashboardModel, parseModel } from "./model";

/*
 * Folders and dashboards as docs/api/settings-dashboards.md specifies them. Request bodies carry
 * exactly the documented fields: the server answers unknown fields with 422 validation.
 */

/**
 * What the caller may do with one folder or dashboard, grants included (stream B adds it to the
 * answers). Absent on older servers; the UI then falls back to the organization permissions.
 */
export interface Access {
  write: boolean;
  delete: boolean;
  permissions: boolean;
}

function parseAccess(value: unknown): Access | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return {
    write: value.write === true,
    delete: value.delete === true,
    permissions: value.permissions === true,
  };
}

export interface Folder {
  id: string;
  parentId: string | null;
  name: string;
  /** The folder's own flag; subfolders inherit the restriction. */
  restricted: boolean;
  version: number;
  deletedAt: number | null;
  access?: Access;
}

export interface DashboardSummary {
  id: string;
  folderId: string | null;
  title: string;
  version: number;
  updatedAt: number;
  deletedAt: number | null;
  access?: Access;
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
    const folder: Folder = {
      id: node.id,
      parentId: nullableId(node.parentId),
      name: str(node.name),
      restricted: node.restricted === true,
      version: num(node.version),
      deletedAt: nullableNum(node.deletedAt),
    };
    const access = parseAccess(node.access);
    if (access !== undefined) {
      folder.access = access;
    }
    into.push(folder);
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
  const summary: DashboardSummary = {
    id: value.id,
    folderId: nullableId(value.folderId),
    title: str(value.title),
    version: num(value.version),
    updatedAt: num(value.updatedAt),
    deletedAt: nullableNum(value.deletedAt),
  };
  const access = parseAccess(value.access);
  if (access !== undefined) {
    summary.access = access;
  }
  return summary;
}

function parseDashboard(value: unknown): Dashboard {
  const summary = parseSummary(value);
  if (summary === null || !isRecord(value) || typeof value.version !== "number") {
    return invalid("dashboard");
  }
  return { ...summary, model: parseModel(value.model, summary.title) };
}

/** The stored dashboard of a `version_conflict` answer, or null when it is not one. */
export function dashboardFromBody(value: unknown): Dashboard | null {
  try {
    return parseDashboard(value);
  } catch {
    return null;
  }
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

async function folderPage(
  orgId: string,
  trashed: boolean,
  signal?: AbortSignal,
): Promise<Folder[]> {
  const path = orgPath(orgId, "folders") + (trashed ? "?trashed=true" : "");
  const value = await send("GET", path, undefined, signal);
  if (!isRecord(value) || !Array.isArray(value.items)) {
    return invalid("folder list");
  }
  return flattenFolders(value.items);
}

/** The visible folders not in the trash, parents before their children. */
export function fetchFolders(orgId: string, signal?: AbortSignal): Promise<Folder[]> {
  return folderPage(orgId, false, signal);
}

/** The top folder of every trashed subtree. */
export function fetchTrashedFolders(orgId: string, signal?: AbortSignal): Promise<Folder[]> {
  return folderPage(orgId, true, signal);
}

export async function createFolder(
  orgId: string,
  input: { name: string; parentId: string | null },
): Promise<void> {
  await send("POST", orgPath(orgId, "folders"), input);
}

export async function updateFolder(
  orgId: string,
  id: string,
  patch: { name?: string; parentId?: string | null; restricted?: boolean; version: number },
): Promise<void> {
  await send("PATCH", orgPath(orgId, "folders", id), patch);
}

export async function deleteFolder(orgId: string, id: string): Promise<void> {
  await send("DELETE", orgPath(orgId, "folders", id));
}

export async function restoreFolder(orgId: string, id: string): Promise<void> {
  await send("POST", orgPath(orgId, "folders", id, "restore"));
}

export async function purgeFolder(orgId: string, id: string): Promise<void> {
  await send("DELETE", orgPath(orgId, "folders", id, "purge"));
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
  signal?: AbortSignal,
): Promise<Page<DashboardSummary>> {
  const params = new URLSearchParams();
  if (filter.folderId !== undefined) params.set("folderId", filter.folderId);
  if (filter.q !== undefined && filter.q !== "") params.set("q", filter.q);
  if (filter.trashed === true) params.set("trashed", "true");
  if (filter.cursor !== undefined) params.set("cursor", filter.cursor);
  const query = params.toString();
  const path = orgPath(orgId, "dashboards") + (query === "" ? "" : `?${query}`);
  return parsePage(await send("GET", path, undefined, signal), parseSummary, "dashboard list");
}

export async function fetchDashboard(
  orgId: string,
  id: string,
  signal?: AbortSignal,
): Promise<Dashboard> {
  return parseDashboard(await send("GET", orgPath(orgId, "dashboards", id), undefined, signal));
}

/** Creates version 1; the title is the model's. */
export async function createDashboard(
  orgId: string,
  input: { folderId: string | null; model: DashboardModel },
): Promise<{ id: string }> {
  return parseDashboard(await send("POST", orgPath(orgId, "dashboards"), input));
}

/** Saves a new version. A newer stored version answers `version_conflict` (409). */
export async function saveDashboard(
  orgId: string,
  id: string,
  input: { model: DashboardModel; version: number; message: string },
): Promise<void> {
  const body = input.message === "" ? { model: input.model, version: input.version } : input;
  await send("PUT", orgPath(orgId, "dashboards", id), body);
}

export async function deleteDashboard(orgId: string, id: string): Promise<void> {
  await send("DELETE", orgPath(orgId, "dashboards", id));
}

export async function restoreDashboard(orgId: string, id: string): Promise<void> {
  await send("POST", orgPath(orgId, "dashboards", id, "restore"));
}

export async function purgeDashboard(orgId: string, id: string): Promise<void> {
  await send("DELETE", orgPath(orgId, "dashboards", id, "purge"));
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
  signal?: AbortSignal,
): Promise<Page<DashboardVersion>> {
  const path = orgPath(orgId, "dashboards", id, "versions");
  return parsePage(
    await send(
      "GET",
      cursor === undefined ? path : `${path}?cursor=${encodeURIComponent(cursor)}`,
      undefined,
      signal,
    ),
    parseVersion,
    "version list",
  );
}

export async function fetchVersionModel(
  orgId: string,
  id: string,
  version: number,
  signal?: AbortSignal,
): Promise<DashboardModel> {
  const value = await send(
    "GET",
    orgPath(orgId, "dashboards", id, "versions", String(version)),
    undefined,
    signal,
  );
  return parseModel(isRecord(value) ? value.model : undefined, "");
}

export async function restoreVersion(orgId: string, id: string, version: number): Promise<void> {
  await send("POST", orgPath(orgId, "dashboards", id, "versions", String(version), "restore"));
}

function isQueryResponse(value: unknown): value is QueryResponse {
  return isRecord(value) && isRecord(value.results);
}

/**
 * Runs a panel's stored queries, as viewers do. Aborting the signal cancels the request.
 */
export async function runPanelQuery(
  orgId: string,
  dashboardId: string,
  panelId: string,
  body: PanelQueryRequest,
  signal?: AbortSignal,
): Promise<QueryResponse> {
  const path = orgPath(orgId, "dashboards", dashboardId, "panels", panelId, "query");
  return expectShape(await send("POST", path, body, signal), isQueryResponse, "panel query");
}

/**
 * `VariableOptionsRequest` (decided contract; the generated type follows from shapes.rs): the
 * time range and the values of the other variables, the variable's own name left out.
 */
export interface VariableOptionsRequest {
  timeRange: TimeRange;
  variables: Record<string, unknown>;
}

/** The answer of the options route; errors are ordinary HTTP errors. */
export interface VariableOptionsResponse {
  options: VariableOption[];
  /** More options exist than the server sent. */
  truncated: boolean;
}

function isVariableOptions(value: unknown): value is VariableOptionsResponse {
  return (
    isRecord(value) &&
    typeof value.truncated === "boolean" &&
    Array.isArray(value.options) &&
    value.options.every(
      (o) => isRecord(o) && typeof o.value === "string" && typeof o.label === "string",
    )
  );
}

/** The choices of a saved query variable, from `POST .../variables/{name}/options`. */
export async function fetchVariableOptions(
  orgId: string,
  dashboardId: string,
  name: string,
  body: VariableOptionsRequest,
  signal?: AbortSignal,
): Promise<VariableOptionsResponse> {
  const path = orgPath(orgId, "dashboards", dashboardId, "variables", name, "options");
  return expectShape(await send("POST", path, body, signal), isVariableOptions, "variable options");
}

export const FOLDERS_KEY = "folders";
export const DASHBOARDS_KEY = "dashboards";

export function foldersQuery(orgId: string) {
  return queryOptions({
    queryKey: [FOLDERS_KEY, orgId],
    queryFn: ({ signal }) => fetchFolders(orgId, signal),
  });
}

export function dashboardQuery(orgId: string, id: string) {
  return queryOptions({
    queryKey: [DASHBOARDS_KEY, orgId, "one", id],
    queryFn: ({ signal }) => fetchDashboard(orgId, id, signal),
  });
}
