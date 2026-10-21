import { queryOptions } from "@tanstack/react-query";
import { ApiError, expectShape, isRecord, request } from "../../api/client";
import type { Page, QueryRequest, QueryResponse, Shape } from "../../api/generated/shapes";

/** `/api/orgs/{orgId}/...` with every segment encoded. */
export function orgPath(orgId: string, ...segments: string[]): string {
  return ["/api/orgs", orgId, ...segments]
    .map((part, i) => (i === 0 ? part : encodeURIComponent(part)))
    .join("/");
}

export const SETTING_TYPES = ["string", "number", "bool", "select", "path", "url"] as const;
export type SettingType = (typeof SETTING_TYPES)[number];

export interface SettingOption {
  value: string;
  /** A catalog key, or a plain label when the server sends one (engine names such as "TLS 1.3"). */
  label: string;
}

/** One field of a data source kind's settings form, described by the server. */
export interface SettingSpec {
  name: string;
  labelKey: string;
  type: SettingType;
  required: boolean;
  /** Write-only: stored encrypted, never sent back; the API only says whether it is set. */
  secret: boolean;
  options?: SettingOption[];
}

export interface DatasourceKind {
  kind: string;
  name: string;
  shapes: Shape[];
  settings: SettingSpec[];
}

export interface DatasourceSummary {
  id: string;
  name: string;
  kind: string;
  createdAt: number;
}

export interface Datasource {
  id: string;
  name: string;
  kind: string;
  settings: Record<string, unknown>;
  secrets: Record<string, { set: boolean }>;
  version: number;
}

export interface Health {
  ok: boolean;
  message: string;
  latencyMs: number;
}

export interface SqlSchema {
  tables: { schema?: string; name: string; columns: { name: string; type: string }[] }[];
}

export interface PromSchema {
  metrics: { name: string; help?: string; labels: string[] }[];
}

export type SourceSchema = SqlSchema | PromSchema;

export interface DatasourceInput {
  name: string;
  kind: string;
  settings: Record<string, unknown>;
  secrets: Record<string, string>;
}

/** Patch semantics for secrets: a key left out keeps the stored value, null removes it. */
export interface DatasourcePatch {
  name?: string;
  settings?: Record<string, unknown>;
  secrets?: Record<string, string | null>;
  version: number;
}

function invalid(what: string): never {
  throw new ApiError("invalid_response", 200, `unexpected ${what} response`);
}

function normalizeOption(value: unknown): SettingOption | null {
  if (typeof value === "string") {
    return { value, label: value };
  }
  if (isRecord(value) && typeof value.value === "string") {
    const label = value.labelKey ?? value.label ?? value.value;
    return { value: value.value, label: typeof label === "string" ? label : value.value };
  }
  return null;
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
    spec.options = value.options.map(normalizeOption).filter((option) => option !== null);
  }
  return spec;
}

function parseKinds(value: unknown): DatasourceKind[] {
  if (!Array.isArray(value)) {
    invalid("data source kinds");
  }
  return (value as unknown[]).map((item) => {
    if (!isRecord(item) || typeof item.kind !== "string" || !Array.isArray(item.settings)) {
      return invalid("data source kind");
    }
    return {
      kind: item.kind,
      name: typeof item.name === "string" ? item.name : item.kind,
      shapes: Array.isArray(item.shapes) ? (item.shapes as Shape[]) : ["frame"],
      settings: item.settings.map(parseSetting).filter((spec) => spec !== null),
    };
  });
}

function isPage(value: unknown): value is Page<unknown> {
  return isRecord(value) && Array.isArray(value.items);
}

function isSummary(value: unknown): value is DatasourceSummary {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.kind === "string"
  );
}

function isDatasource(value: unknown): value is Datasource {
  return (
    isSummary(value) &&
    isRecord((value as unknown as Record<string, unknown>).settings) &&
    typeof (value as unknown as Record<string, unknown>).version === "number"
  );
}

function isHealth(value: unknown): value is Health {
  return isRecord(value) && typeof value.ok === "boolean";
}

function isQueryResponse(value: unknown): value is QueryResponse {
  return isRecord(value) && isRecord(value.results);
}

export async function fetchKinds(orgId: string): Promise<DatasourceKind[]> {
  return parseKinds(await request("GET", orgPath(orgId, "datasource-kinds")));
}

export async function fetchDatasources(orgId: string): Promise<DatasourceSummary[]> {
  // Organizations have a handful of data sources; the largest page covers them in one request.
  const page = expectShape(
    await request("GET", `${orgPath(orgId, "datasources")}?limit=200`),
    isPage,
    "data source list",
  );
  return page.items.filter(isSummary);
}

export async function fetchDatasource(orgId: string, id: string): Promise<Datasource> {
  const value = expectShape(
    await request("GET", orgPath(orgId, "datasources", id)),
    isDatasource,
    "data source",
  );
  return { ...value, secrets: isRecord(value.secrets) ? value.secrets : {} };
}

export async function createDatasource(orgId: string, input: DatasourceInput): Promise<Datasource> {
  return expectShape(
    await request("POST", orgPath(orgId, "datasources"), input),
    isDatasource,
    "data source",
  );
}

export async function updateDatasource(
  orgId: string,
  id: string,
  patch: DatasourcePatch,
): Promise<Datasource> {
  return expectShape(
    await request("PATCH", orgPath(orgId, "datasources", id), patch),
    isDatasource,
    "data source",
  );
}

export async function deleteDatasource(orgId: string, id: string): Promise<void> {
  await request("DELETE", orgPath(orgId, "datasources", id));
}

export async function restoreDatasource(orgId: string, id: string): Promise<void> {
  await request("POST", orgPath(orgId, "datasources", id, "restore"));
}

export async function checkHealth(orgId: string, id: string): Promise<Health> {
  const health = expectShape(
    await request("POST", orgPath(orgId, "datasources", id, "health")),
    isHealth,
    "connection test",
  );
  return {
    ok: health.ok,
    message: typeof health.message === "string" ? health.message : "",
    latencyMs: typeof health.latencyMs === "number" ? health.latencyMs : 0,
  };
}

export async function fetchSchema(orgId: string, id: string): Promise<SourceSchema> {
  const value = await request("GET", orgPath(orgId, "datasources", id, "schema"));
  if (isRecord(value) && Array.isArray(value.metrics)) {
    return { metrics: value.metrics as PromSchema["metrics"] };
  }
  if (isRecord(value) && Array.isArray(value.tables)) {
    return { tables: value.tables as SqlSchema["tables"] };
  }
  return invalid("schema");
}

/**
 * `POST /query`: free queries for members with `datasources:query`. The signal is checked before
 * sending, so a query that waited in line and is no longer needed never reaches the server.
 */
export async function runQuery(
  orgId: string,
  body: QueryRequest,
  signal?: AbortSignal,
): Promise<QueryResponse> {
  signal?.throwIfAborted();
  return expectShape(
    await request("POST", orgPath(orgId, "query"), body),
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

export function datasourcesQuery(orgId: string) {
  return queryOptions({
    queryKey: [DATASOURCES_KEY, orgId],
    queryFn: () => fetchDatasources(orgId),
  });
}

export function datasourceQuery(orgId: string, id: string) {
  return queryOptions({
    queryKey: [DATASOURCES_KEY, orgId, id],
    queryFn: () => fetchDatasource(orgId, id),
  });
}

export function schemaQuery(orgId: string, id: string) {
  return queryOptions({
    queryKey: [DATASOURCES_KEY, orgId, id, "schema"],
    queryFn: () => fetchSchema(orgId, id),
    staleTime: 5 * 60_000,
    retry: false,
  });
}
