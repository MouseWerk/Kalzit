import { queryOptions } from "@tanstack/react-query";
import { ApiError, expectShape, isRecord } from "../../api/client";
import type { Page, PanelQueryRequest, QueryResponse } from "../../api/generated/shapes";
import type { Target } from "../dashboards/model";
import type { TextRange } from "../dashboards/timeRange";
import { orgPath, send } from "../datasources/api";

/*
 * Saved analyses as docs/api/analyses.md specifies them: an Explore query kept under a name, in
 * folders with the dashboards' rights. Request bodies carry exactly the documented fields.
 */

/** The model version this UI writes; the server migrates older ones on read. */
export const ANALYSIS_SCHEMA_VERSION = 1;
export const MAX_TITLE_CHARS = 200;
export const MAX_DESCRIPTION_CHARS = 1000;

export interface Visualization {
  type: string;
  options?: unknown;
  fieldConfig?: unknown;
}

export interface AnalysisModel {
  schemaVersion: number;
  title: string;
  description?: string | undefined;
  /** Kept with the analysis; null follows the range in use (Explore's, or the dashboard's). */
  timeRange: TextRange | null;
  targets: Target[];
  steps: unknown[];
  visualization: Visualization;
}

export interface AnalysisAccess {
  write: boolean;
  delete: boolean;
  permissions: boolean;
}

export interface Analysis {
  id: string;
  folderId: string | null;
  title: string;
  version: number;
  createdBy: string | null;
  /** The creator's name; `null` when the account no longer exists. */
  createdByName: string | null;
  createdAt: number;
  updatedAt: number;
  updatedBy: string | null;
  /** The name of who saved last; `null` when the account no longer exists. */
  updatedByName: string | null;
  deletedAt: number | null;
  access: AnalysisAccess;
  ownerTeam: { id: string; name: string } | null;
  teamOnly: boolean;
  datasourceIds: string[];
  /** The caller may query every source of the analysis, so it may change and run it freely. */
  mayQuery: boolean;
  /** Dashboards linking it that the caller may read, trashed ones too. */
  uses: number;
  /** Absent in list items. */
  model?: AnalysisModel | undefined;
}

export interface AnalysisVersion {
  version: number;
  authorId: string | null;
  authorName: string | null;
  restoredFrom: number | null;
  createdAt: number;
}

function invalid(what: string): never {
  throw new ApiError("invalid_response", 200, `unexpected ${what} response`);
}

const str = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : fallback;
const num = (value: unknown, fallback = 0): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;
const nullableStr = (value: unknown): string | null => (typeof value === "string" ? value : null);
const nullableNum = (value: unknown): number | null => (typeof value === "number" ? value : null);

function parseTargets(value: unknown): Target[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item): Target[] => {
    if (!isRecord(item) || typeof item.refId !== "string") {
      return [];
    }
    const target: Target = {
      refId: item.refId,
      datasourceId: str(item.datasourceId),
      query: item.query,
    };
    if (item.hide === true) {
      target.hide = true;
    }
    return [target];
  });
}

/** Reads a model defensively, so one odd field cannot break a page. */
export function parseAnalysisModel(value: unknown): AnalysisModel {
  const model = isRecord(value) ? value : {};
  const range = isRecord(model.timeRange) ? model.timeRange : null;
  const visualization = isRecord(model.visualization) ? model.visualization : {};
  const parsed: AnalysisModel = {
    schemaVersion: num(model.schemaVersion, ANALYSIS_SCHEMA_VERSION),
    title: str(model.title),
    timeRange:
      range !== null && typeof range.from === "string" && typeof range.to === "string"
        ? { from: range.from, to: range.to }
        : null,
    targets: parseTargets(model.targets),
    steps: Array.isArray(model.steps) ? model.steps : [],
    visualization: {
      type: str(visualization.type, "table"),
      options: visualization.options ?? {},
      fieldConfig: visualization.fieldConfig ?? {},
    },
  };
  if (typeof model.description === "string" && model.description !== "") {
    parsed.description = model.description;
  }
  return parsed;
}

/** The model as the server takes it: no empty description, the range only when kept. */
export function modelBody(model: AnalysisModel): Record<string, unknown> {
  const body: Record<string, unknown> = {
    schemaVersion: ANALYSIS_SCHEMA_VERSION,
    title: model.title,
    timeRange: model.timeRange,
    targets: model.targets,
    steps: model.steps,
    visualization: model.visualization,
  };
  if (model.description !== undefined && model.description.trim() !== "") {
    body.description = model.description;
  }
  return body;
}

function parseAnalysis(value: unknown): Analysis | null {
  if (!isRecord(value) || typeof value.id !== "string") {
    return null;
  }
  const access = isRecord(value.access) ? value.access : {};
  const owner = isRecord(value.ownerTeam) ? value.ownerTeam : null;
  return {
    id: value.id,
    folderId: nullableStr(value.folderId),
    title: str(value.title),
    version: num(value.version),
    createdBy: nullableStr(value.createdBy),
    createdByName: nullableStr(value.createdByName),
    createdAt: num(value.createdAt),
    updatedAt: num(value.updatedAt),
    updatedBy: nullableStr(value.updatedBy),
    updatedByName: nullableStr(value.updatedByName),
    deletedAt: nullableNum(value.deletedAt),
    access: {
      write: access.write === true,
      delete: access.delete === true,
      permissions: access.permissions === true,
    },
    ownerTeam:
      owner !== null && typeof owner.id === "string"
        ? { id: owner.id, name: str(owner.name) }
        : null,
    teamOnly: value.teamOnly === true,
    datasourceIds: Array.isArray(value.datasourceIds)
      ? value.datasourceIds.filter((id): id is string => typeof id === "string")
      : [],
    mayQuery: value.mayQuery === true,
    uses: num(value.uses),
    model: value.model === undefined ? undefined : parseAnalysisModel(value.model),
  };
}

function expectAnalysis(value: unknown): Analysis {
  return parseAnalysis(value) ?? invalid("analysis");
}

/** The stored analysis of a `version_conflict` answer, or null when it is not one. */
export function analysisFromConflict(error: unknown): Analysis | null {
  return error instanceof ApiError && error.code === "version_conflict"
    ? parseAnalysis(error.current)
    : null;
}

function parsePage<T>(value: unknown, item: (v: unknown) => T | null, what: string): Page<T> {
  if (!isRecord(value) || !Array.isArray(value.items)) {
    return invalid(what);
  }
  return {
    items: value.items.map(item).filter((v): v is T => v !== null),
    nextCursor: typeof value.nextCursor === "string" ? value.nextCursor : null,
  };
}

export type AnalysisSort = "title" | "updated";

export interface AnalysisFilter {
  folderId?: string | undefined;
  q?: string | undefined;
  trashed?: boolean | undefined;
  team?: string | undefined;
  datasourceId?: string | undefined;
  createdBy?: string | undefined;
  ownerTeamId?: string | undefined;
  sort?: AnalysisSort | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
}

export async function fetchAnalyses(
  orgId: string,
  filter: AnalysisFilter,
  signal?: AbortSignal,
): Promise<Page<Analysis>> {
  const params = new URLSearchParams();
  const set = (name: string, value: string | undefined) => {
    if (value !== undefined && value !== "") params.set(name, value);
  };
  set("folderId", filter.folderId);
  set("q", filter.q);
  if (filter.trashed === true) params.set("trashed", "true");
  set("team", filter.team);
  set("datasourceId", filter.datasourceId);
  set("createdBy", filter.createdBy);
  set("ownerTeamId", filter.ownerTeamId);
  set("sort", filter.sort);
  set("limit", filter.limit === undefined ? undefined : String(filter.limit));
  set("cursor", filter.cursor);
  const query = params.toString();
  const path = orgPath(orgId, "analyses") + (query === "" ? "" : `?${query}`);
  return parsePage(await send("GET", path, undefined, signal), parseAnalysis, "analysis list");
}

export async function fetchAnalysis(
  orgId: string,
  id: string,
  signal?: AbortSignal,
): Promise<Analysis> {
  return expectAnalysis(await send("GET", orgPath(orgId, "analyses", id), undefined, signal));
}

export async function createAnalysis(
  orgId: string,
  input: { model: AnalysisModel; folderId: string | null },
): Promise<Analysis> {
  return expectAnalysis(
    await send("POST", orgPath(orgId, "analyses"), {
      model: modelBody(input.model),
      folderId: input.folderId,
    }),
  );
}

/**
 * Saves the next version. `version` is the one the caller started from; a newer stored one
 * answers `version_conflict` with the stored analysis. `folderId` moves it when given.
 */
export async function saveAnalysis(
  orgId: string,
  id: string,
  input: { model: AnalysisModel; version: number; folderId?: string | null | undefined },
): Promise<Analysis> {
  const body: Record<string, unknown> = { model: modelBody(input.model), version: input.version };
  if (input.folderId !== undefined) {
    body.folderId = input.folderId;
  }
  return expectAnalysis(await send("PUT", orgPath(orgId, "analyses", id), body));
}

export async function trashAnalysis(orgId: string, id: string): Promise<void> {
  await send("DELETE", orgPath(orgId, "analyses", id));
}

export async function restoreAnalysis(orgId: string, id: string): Promise<void> {
  await send("POST", orgPath(orgId, "analyses", id, "restore"));
}

export async function purgeAnalysis(orgId: string, id: string): Promise<void> {
  await send("DELETE", orgPath(orgId, "analyses", id, "purge"));
}

export interface AnalysisUse {
  id: string;
  title: string;
  deletedAt: number | null;
}

export async function fetchUses(
  orgId: string,
  id: string,
  signal?: AbortSignal,
): Promise<AnalysisUse[]> {
  const value = await send("GET", orgPath(orgId, "analyses", id, "uses"), undefined, signal);
  if (!isRecord(value) || !Array.isArray(value.items)) {
    return invalid("analysis uses");
  }
  return value.items.flatMap((item): AnalysisUse[] =>
    isRecord(item) && typeof item.id === "string"
      ? [{ id: item.id, title: str(item.title), deletedAt: nullableNum(item.deletedAt) }]
      : [],
  );
}

function parseVersion(value: unknown): AnalysisVersion | null {
  if (!isRecord(value) || typeof value.version !== "number") {
    return null;
  }
  return {
    version: value.version,
    authorId: nullableStr(value.authorId),
    authorName: nullableStr(value.authorName),
    restoredFrom: nullableNum(value.restoredFrom),
    createdAt: num(value.createdAt),
  };
}

export async function fetchVersions(
  orgId: string,
  id: string,
  options: { cursor?: string | undefined; limit?: number | undefined } = {},
  signal?: AbortSignal,
): Promise<Page<AnalysisVersion>> {
  const params = new URLSearchParams();
  if (options.cursor !== undefined) params.set("cursor", options.cursor);
  if (options.limit !== undefined) params.set("limit", String(options.limit));
  const query = params.toString();
  const path = orgPath(orgId, "analyses", id, "versions") + (query === "" ? "" : `?${query}`);
  return parsePage(await send("GET", path, undefined, signal), parseVersion, "version list");
}

export async function fetchVersionModel(
  orgId: string,
  id: string,
  version: number,
  signal?: AbortSignal,
): Promise<AnalysisModel> {
  const value = await send(
    "GET",
    orgPath(orgId, "analyses", id, "versions", String(version)),
    undefined,
    signal,
  );
  return parseAnalysisModel(isRecord(value) ? value.model : undefined);
}

/** Saves an old version as the next one; `expectedVersion` is the current one the user saw. */
export async function restoreVersion(
  orgId: string,
  id: string,
  version: number,
  expectedVersion: number,
): Promise<void> {
  const path = orgPath(orgId, "analyses", id, "versions", String(version), "restore");
  await send("POST", `${path}?expectedVersion=${expectedVersion}`);
}

function isQueryResponse(value: unknown): value is QueryResponse {
  return isRecord(value) && isRecord(value.results);
}

/** Runs the stored queries of an analysis, as its readers may. */
export async function runAnalysis(
  orgId: string,
  id: string,
  body: Omit<PanelQueryRequest, "variables" | "cursors"> & {
    cursors?: Record<string, string>;
  },
  signal?: AbortSignal,
): Promise<QueryResponse> {
  return expectShape(
    await send("POST", orgPath(orgId, "analyses", id, "query"), body, signal),
    isQueryResponse,
    "analysis query",
  );
}

export const ANALYSES_KEY = "analyses";

export function analysisQuery(orgId: string, id: string) {
  return queryOptions({
    queryKey: [ANALYSES_KEY, orgId, "one", id],
    queryFn: ({ signal }) => fetchAnalysis(orgId, id, signal),
  });
}
