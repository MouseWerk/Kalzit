import { queryOptions } from "@tanstack/react-query";
import { ApiError, expectShape, isRecord } from "../../api/client";
import type {
  Page,
  PanelQueryRequest,
  QueryResponse,
  VariableOptionsRequest,
  VariableOptionsResponse,
} from "../../api/generated/shapes";
import { type AnalysisModel, parseAnalysisModel } from "../analyses/api";
import { orgPath, send } from "../datasources/api";
import { type DashboardModel, type PanelModel, parseModel } from "./model";

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

/** The team that owns a folder or dashboard (docs/api/access.md, "Team ownership"). */
export interface OwnerTeam {
  id: string;
  name: string;
}

/** Who besides the owner team sees team-owned content: everyone with access (read only), or nobody. */
export type Visibility = "shared" | "team";

function parseOwner(value: unknown): OwnerTeam | null {
  return isRecord(value) && typeof value.id === "string"
    ? { id: value.id, name: typeof value.name === "string" ? value.name : "" }
    : null;
}

export interface Folder {
  id: string;
  parentId: string | null;
  name: string;
  /** The folder's own flag; subfolders inherit the restriction. */
  restricted: boolean;
  /** The team that owns the folder; `null` for folders of the organization. */
  ownerTeam: OwnerTeam | null;
  /** A team space: a restricted top-level folder that a team owns. */
  teamSpace: boolean;
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
  /** The current version's tags; absent when it has none. */
  tags?: string[];
  /** The team that owns the dashboard; `null` when it belongs to the organization. */
  ownerTeam: OwnerTeam | null;
  /** Only the owner team, grants on it and org admins see it. */
  teamOnly: boolean;
}

/** A library panel as a dashboard shows it (docs/api/dashboard-features.md). */
export interface LinkedPanel {
  id: string;
  name: string;
  version: number;
  /** The panel content: a panel without id and grid. */
  model: PanelModel;
}

/** A saved analysis as a dashboard shows it (docs/api/analyses.md, "Linked panels"). */
export interface LinkedAnalysis {
  id: string;
  title: string;
  version: number;
  model: AnalysisModel;
}

export interface Dashboard extends DashboardSummary {
  model: DashboardModel;
  /** The library panels the model references, by id; a deleted one is missing. */
  libraryPanels: Record<string, LinkedPanel>;
  /** The saved analyses the model links, by id; a purged one is missing. */
  analyses: Record<string, LinkedAnalysis>;
}

function parseLinkedAnalyses(value: unknown): Record<string, LinkedAnalysis> {
  const out: Record<string, LinkedAnalysis> = {};
  if (!isRecord(value)) {
    return out;
  }
  for (const [id, entry] of Object.entries(value)) {
    if (isRecord(entry)) {
      out[id] = {
        id,
        title: str(entry.title),
        version: num(entry.version),
        model: parseAnalysisModel(entry.model),
      };
    }
  }
  return out;
}

/**
 * The model as the server stores it: a panel linking a saved analysis is a slot without queries
 * or steps of its own (the editor and the grid fill them in from the analysis to draw it).
 */
export function storedModel(model: DashboardModel): DashboardModel {
  if (!model.panels.some((panel) => panel.analysisId !== undefined)) {
    return model;
  }
  return {
    ...model,
    panels: model.panels.map((panel) =>
      panel.analysisId === undefined ? panel : { ...panel, targets: [], transformations: [] },
    ),
  };
}

/** Library panel content (no place) as a panel, for drawing and editing. */
export function parseLibraryContent(value: unknown, id = "library"): PanelModel {
  const content = isRecord(value) ? value : {};
  const [panel] = parseModel(
    { panels: [{ ...content, id, grid: { x: 0, y: 0, w: 12, h: 8 } }] },
    "",
  ).panels;
  return (
    panel ?? {
      id,
      type: "table",
      title: "",
      grid: { x: 0, y: 0, w: 12, h: 8 },
      targets: [],
      transformations: [],
      options: {},
      fieldConfig: {},
    }
  );
}

function parseLinkedPanels(value: unknown): Record<string, LinkedPanel> {
  const out: Record<string, LinkedPanel> = {};
  if (!isRecord(value)) {
    return out;
  }
  for (const [id, entry] of Object.entries(value)) {
    if (isRecord(entry)) {
      out[id] = {
        id,
        name: str(entry.name),
        version: num(entry.version),
        model: parseLibraryContent(entry.model, id),
      };
    }
  }
  return out;
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

export type { VariableOption } from "../../api/generated/shapes";

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
      ownerTeam: parseOwner(node.ownerTeam),
      teamSpace: node.teamSpace === true,
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
    ownerTeam: parseOwner(value.ownerTeam),
    teamOnly: value.teamOnly === true,
  };
  const access = parseAccess(value.access);
  if (access !== undefined) {
    summary.access = access;
  }
  const tags = Array.isArray(value.tags) ? value.tags.filter((t) => typeof t === "string") : [];
  if (tags.length > 0) {
    summary.tags = tags;
  }
  return summary;
}

function parseDashboard(value: unknown): Dashboard {
  const summary = parseSummary(value);
  if (summary === null || !isRecord(value) || typeof value.version !== "number") {
    return invalid("dashboard");
  }
  return {
    ...summary,
    model: parseModel(value.model, summary.title),
    libraryPanels: parseLinkedPanels(value.libraryPanels),
    analyses: parseLinkedAnalyses(value.analyses),
  };
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
  team?: string,
): Promise<Folder[]> {
  const params = new URLSearchParams();
  if (trashed) params.set("trashed", "true");
  if (team !== undefined) params.set("team", team);
  const query = params.toString();
  const path = orgPath(orgId, "folders") + (query === "" ? "" : `?${query}`);
  const value = await send("GET", path, undefined, signal);
  if (!isRecord(value) || !Array.isArray(value.items)) {
    return invalid("folder list");
  }
  return flattenFolders(value.items);
}

/**
 * The visible folders not in the trash, parents before their children; with `team`, only those
 * in that team context (outside other teams' spaces, or shared with the team).
 */
export function fetchFolders(
  orgId: string,
  signal?: AbortSignal,
  team?: string,
): Promise<Folder[]> {
  return folderPage(orgId, false, signal, team);
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

/** Creates a team space: a restricted top-level folder the team owns. */
export async function createTeamSpace(
  orgId: string,
  input: { name: string; ownerTeamId: string },
): Promise<{ id: string }> {
  const value = await send("POST", orgPath(orgId, "folders"), input);
  return { id: isRecord(value) && typeof value.id === "string" ? value.id : "" };
}

/** Sets the team that owns a folder or dashboard and who else sees it. */
export async function setOwner(
  orgId: string,
  kind: "folders" | "dashboards",
  id: string,
  input: { ownerTeamId: string | null; visibility: Visibility; version: number },
): Promise<void> {
  await send("PUT", orgPath(orgId, kind, id, "owner"), input);
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
  /** Only dashboards with this tag. */
  tag?: string | undefined;
  /** A team context: only dashboards outside other teams' spaces, or shared with the team. */
  team?: string | undefined;
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
  if (filter.tag !== undefined && filter.tag !== "") params.set("tag", filter.tag);
  if (filter.team !== undefined) params.set("team", filter.team);
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
  input: {
    folderId: string | null;
    model: DashboardModel;
    /** Leaves the time range out, so the server applies the organization's default. */
    defaultTimeRange?: boolean;
  },
): Promise<{ id: string }> {
  const { timeRange: _timeRange, ...rest } = storedModel(input.model);
  const model = input.defaultTimeRange === true ? rest : storedModel(input.model);
  return parseDashboard(
    await send("POST", orgPath(orgId, "dashboards"), { folderId: input.folderId, model }),
  );
}

/** Saves a new version. A newer stored version answers `version_conflict` (409). */
export async function saveDashboard(
  orgId: string,
  id: string,
  input: { model: DashboardModel; version: number; message: string },
): Promise<void> {
  const model = storedModel(input.model);
  const body =
    input.message === ""
      ? { model, version: input.version }
      : { model, version: input.version, message: input.message };
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

/**
 * Makes an old version the current one. `expectedVersion` is the current version the user saw:
 * a dashboard saved since answers `version_conflict` instead of being replaced.
 */
export async function restoreVersion(
  orgId: string,
  id: string,
  version: number,
  expectedVersion: number,
): Promise<void> {
  const path = orgPath(orgId, "dashboards", id, "versions", String(version), "restore");
  await send("POST", `${path}?expectedVersion=${expectedVersion}`);
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

export function foldersQuery(orgId: string, team?: string) {
  return queryOptions({
    queryKey: team === undefined ? [FOLDERS_KEY, orgId] : [FOLDERS_KEY, orgId, "team", team],
    queryFn: ({ signal }) => fetchFolders(orgId, signal, team),
  });
}

export function dashboardQuery(orgId: string, id: string) {
  return queryOptions({
    queryKey: [DASHBOARDS_KEY, orgId, "one", id],
    queryFn: ({ signal }) => fetchDashboard(orgId, id, signal),
  });
}
