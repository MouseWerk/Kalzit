import { queryOptions } from "@tanstack/react-query";
import { ApiError, expectShape, isRecord, request } from "../../api/client";
import type { Page, QueryRequest, QueryResponse, Shape } from "../../api/generated/shapes";

/*
 * Data sources and free queries as docs/api/datasources.md (stream C) specifies them. Every call
 * of the data areas to these routes lives here, so a contract change is one module to adjust.
 * Request bodies carry exactly the documented fields: unknown fields answer 422 validation.
 */

/** `/api/orgs/{orgId}/...` with every segment encoded. */
export function orgPath(orgId: string, ...segments: string[]): string {
  return ["/api/orgs", orgId, ...segments]
    .map((part, i) => (i === 0 ? part : encodeURIComponent(part)))
    .join("/");
}

type Method = Parameters<typeof request>[0];

/** The one place the data areas send requests, so cancellation is passed on everywhere. */
export function send(
  method: Method,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  signal?.throwIfAborted();
  return request(method, path, body);
}

export const SETTING_TYPES = ["string", "text", "number", "bool", "select"] as const;
export type SettingType = (typeof SETTING_TYPES)[number];

/** One field of a data source kind's settings form, described by the server. */
export interface SettingSpec {
  name: string;
  /** Catalog key of the label, `datasources.settings.<name>`. */
  labelKey: string;
  /** `string` one line, `text` several lines (a PEM certificate), `number` a whole number >= 0. */
  type: SettingType;
  required: boolean;
  /** Write-only: stored encrypted, never sent back; the API only says whether it is set. */
  secret: boolean;
  options?: string[];
  /** What the server uses when the field is left out; the form starts with it. */
  default?: unknown;
}

export interface DatasourceKind {
  kind: string;
  name: string;
  shapes: Shape[];
  /** Catalog key of the advice on the form: a read-only, least-privilege login. */
  hintKey: string;
  settings: SettingSpec[];
}

export interface DatasourceSummary {
  id: string;
  name: string;
  kind: string;
  createdAt: number;
  /** Set for items of the trash. */
  deletedAt?: number;
}

export interface Datasource {
  id: string;
  name: string;
  kind: string;
  settings: Record<string, unknown>;
  /** Only the secret fields that have a value. */
  secrets: Record<string, { set: boolean }>;
}

export interface Health {
  ok: boolean;
  message: string;
  latencyMs: number;
  /** Only when the test failed: datasource_error, datasource_target_blocked or query_timeout. */
  code?: string;
}

export interface SqlSchema {
  kind: "tables";
  tables: { schema?: string; name: string; columns: { name: string; type: string }[] }[];
}

export interface PromSchema {
  kind: "metrics";
  metrics: string[];
  labels: string[];
}

export type SourceSchema = SqlSchema | PromSchema;

export interface DatasourceInput {
  name: string;
  kind: string;
  settings: Record<string, unknown>;
  secrets: Record<string, string>;
}

/**
 * Every field optional; `settings` replaces all settings. Per secret: a key left out keeps the
 * stored value, null removes it, a string sets it.
 */
export interface DatasourcePatch {
  name?: string;
  settings?: Record<string, unknown>;
  secrets?: Record<string, string | null>;
}

function invalid(what: string): never {
  throw new ApiError("invalid_response", 200, `unexpected ${what} response`);
}

function parseSetting(value: unknown): SettingSpec | null {
  if (
    !isRecord(value) ||
    typeof value.name !== "string" ||
    typeof value.type !== "string" ||
    !(SETTING_TYPES as readonly string[]).includes(value.type)
  ) {
    return null;
  }
  const spec: SettingSpec = {
    name: value.name,
    labelKey: typeof value.labelKey === "string" ? value.labelKey : value.name,
    type: value.type as SettingType,
    required: value.required === true,
    secret: value.secret === true,
  };
  if (Array.isArray(value.options)) {
    spec.options = value.options.filter((option): option is string => typeof option === "string");
  }
  if (value.default !== undefined) {
    spec.default = value.default;
  }
  return spec;
}

function parseKind(item: unknown): DatasourceKind | null {
  if (!isRecord(item) || typeof item.kind !== "string" || !Array.isArray(item.settings)) {
    return null;
  }
  return {
    kind: item.kind,
    name: typeof item.name === "string" ? item.name : item.kind,
    shapes: Array.isArray(item.shapes) ? (item.shapes as Shape[]) : ["frame"],
    hintKey: typeof item.hintKey === "string" ? item.hintKey : "",
    settings: item.settings.map(parseSetting).filter((spec) => spec !== null),
  };
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

function parseSummary(value: unknown): DatasourceSummary | null {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    typeof value.kind !== "string"
  ) {
    return null;
  }
  const summary: DatasourceSummary = {
    id: value.id,
    name: value.name,
    kind: value.kind,
    createdAt: typeof value.createdAt === "number" ? value.createdAt : 0,
  };
  if (typeof value.deletedAt === "number") {
    summary.deletedAt = value.deletedAt;
  }
  return summary;
}

function parseDatasource(value: unknown): Datasource {
  const summary = parseSummary(value);
  if (summary === null || !isRecord(value) || !isRecord(value.settings)) {
    return invalid("data source");
  }
  const secrets: Datasource["secrets"] = {};
  if (isRecord(value.secrets)) {
    for (const [field, state] of Object.entries(value.secrets)) {
      secrets[field] = { set: isRecord(state) && state.set === true };
    }
  }
  return { id: summary.id, name: summary.name, kind: summary.kind, settings: value.settings, secrets };
}

function isHealth(value: unknown): value is Health {
  return isRecord(value) && typeof value.ok === "boolean";
}

function isQueryResponse(value: unknown): value is QueryResponse {
  return isRecord(value) && isRecord(value.results);
}

export async function fetchKinds(orgId: string): Promise<DatasourceKind[]> {
  const page = parsePage(
    await send("GET", orgPath(orgId, "datasource-kinds")),
    parseKind,
    "data source kinds",
  );
  return page.items;
}

/** One page of the list, or of the trash. */
export async function fetchDatasourcePage(
  orgId: string,
  options: { cursor?: string | undefined; trash?: boolean } = {},
): Promise<Page<DatasourceSummary>> {
  const params = new URLSearchParams();
  if (options.trash === true) params.set("trash", "true");
  if (options.cursor !== undefined) params.set("cursor", options.cursor);
  const query = params.toString();
  const path = orgPath(orgId, "datasources") + (query === "" ? "" : `?${query}`);
  return parsePage(await send("GET", path), parseSummary, "data source list");
}

/** Pages after this are not read for pickers; no organization keeps that many sources. */
const PICKER_PAGES = 20;

/** Every data source, for pickers in Explore and the panel editor. */
export async function fetchAllDatasources(orgId: string): Promise<DatasourceSummary[]> {
  const all: DatasourceSummary[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < PICKER_PAGES; page++) {
    const next = await fetchDatasourcePage(orgId, { cursor });
    all.push(...next.items);
    if (next.nextCursor === null) {
      break;
    }
    cursor = next.nextCursor;
  }
  return all;
}

export async function fetchDatasource(orgId: string, id: string): Promise<Datasource> {
  return parseDatasource(await send("GET", orgPath(orgId, "datasources", id)));
}

export async function createDatasource(orgId: string, input: DatasourceInput): Promise<Datasource> {
  return parseDatasource(await send("POST", orgPath(orgId, "datasources"), input));
}

export async function updateDatasource(
  orgId: string,
  id: string,
  patch: DatasourcePatch,
): Promise<Datasource> {
  return parseDatasource(await send("PATCH", orgPath(orgId, "datasources", id), patch));
}

export async function deleteDatasource(orgId: string, id: string): Promise<void> {
  await send("DELETE", orgPath(orgId, "datasources", id));
}

export async function restoreDatasource(orgId: string, id: string): Promise<void> {
  await send("POST", orgPath(orgId, "datasources", id, "restore"));
}

export async function checkHealth(orgId: string, id: string): Promise<Health> {
  const health = expectShape(
    await send("POST", orgPath(orgId, "datasources", id, "health")),
    isHealth,
    "connection test",
  );
  const result: Health = {
    ok: health.ok,
    message: typeof health.message === "string" ? health.message : "",
    latencyMs: typeof health.latencyMs === "number" ? health.latencyMs : 0,
  };
  if (!health.ok && typeof health.code === "string") {
    result.code = health.code;
  }
  return result;
}

export async function fetchSchema(orgId: string, id: string): Promise<SourceSchema> {
  const value = await send("GET", orgPath(orgId, "datasources", id, "schema"));
  const strings = (list: unknown) =>
    Array.isArray(list) ? list.filter((item): item is string => typeof item === "string") : [];
  if (isRecord(value) && value.kind === "metrics") {
    return { kind: "metrics", metrics: strings(value.metrics), labels: strings(value.labels) };
  }
  if (isRecord(value) && value.kind === "tables" && Array.isArray(value.tables)) {
    return { kind: "tables", tables: value.tables as SqlSchema["tables"] };
  }
  return invalid("schema");
}

/** `POST /query`: free queries for members with `datasources:query`. */
export async function runQuery(
  orgId: string,
  body: QueryRequest,
  signal?: AbortSignal,
): Promise<QueryResponse> {
  return expectShape(
    await send("POST", orgPath(orgId, "query"), body, signal),
    isQueryResponse,
    "query",
  );
}

export function kindsQuery(orgId: string) {
  return queryOptions({
    queryKey: ["datasource-kinds", orgId],
    queryFn: () => fetchKinds(orgId),
    // The kinds are compiled into the server; they change only with an update.
    staleTime: 10 * 60_000,
  });
}

export const DATASOURCES_KEY = "datasources";

/** All data sources, for pickers. */
export function datasourcesQuery(orgId: string) {
  return queryOptions({
    queryKey: [DATASOURCES_KEY, orgId, "all"],
    queryFn: () => fetchAllDatasources(orgId),
  });
}

export function datasourceQuery(orgId: string, id: string) {
  return queryOptions({
    queryKey: [DATASOURCES_KEY, orgId, "one", id],
    queryFn: () => fetchDatasource(orgId, id),
  });
}

export function schemaQuery(orgId: string, id: string) {
  return queryOptions({
    queryKey: [DATASOURCES_KEY, orgId, "schema", id],
    queryFn: () => fetchSchema(orgId, id),
    staleTime: 5 * 60_000,
    retry: false,
  });
}
