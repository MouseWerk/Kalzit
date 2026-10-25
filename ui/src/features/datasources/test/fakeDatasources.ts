import type { QueryItem, QueryOutcome, TimeRange } from "../../../api/generated/shapes";
import {
  error,
  type FakeArea,
  type FakeAreaStates,
  type FakeRequest,
  json,
} from "../../../test/fakeServer";
import { FAKE_GRAPH, FAKE_GRAPH_SCHEMA, graphOutcome, NEO4J_ID, TIGERGRAPH_ID } from "./fakeGraph";
import { FAKE_MONGO_COLLECTIONS, mongoOutcome, parseMongo } from "./fakeMongo";
import { FAKE_SOURCE_SCHEMAS, sourceKindSources, sourceOutcome } from "./fakeSources";

/**
 * Fake routes for data sources and the free query route, written from docs/api/datasources.md
 * (stream C), not from the UI's types: Page envelopes (kinds included), no version on data
 * sources, unknown body fields, settings and query parameters refused with 422, secrets only in
 * `secrets` and never returned, health and schema need `datasources:query`, and each query form
 * exactly as documented (`{sql}`, `{expr, instant?, minStepMs?}`), anything else `query_rejected`.
 */

interface WireSetting {
  name: string;
  labelKey: string;
  type: "string" | "text" | "number" | "bool" | "select";
  required: boolean;
  secret: boolean;
  target: boolean;
  options?: string[];
  default?: unknown;
}

/** The fields marked `target` by the server's kinds (datasources/*.rs on m1/data). */
const TARGET_FIELDS = new Set([
  "host",
  "port",
  "database",
  "user",
  "sslMode",
  "caCert",
  "encrypt",
  "trustServerCertificate",
  "path",
  "url",
  "basicAuthUser",
  "hosts",
  "srv",
  "authSource",
  "tls",
  "replicaSet",
  "apiKeyHeader",
]);

interface WireKind {
  kind: string;
  name: string;
  shapes: string[];
  hintKey: string;
  settings: WireSetting[];
}

const setting = (
  name: string,
  type: WireSetting["type"],
  extra: Partial<WireSetting> = {},
): WireSetting => ({
  name,
  labelKey: `datasources.settings.${name}`,
  type,
  required: false,
  secret: false,
  target: TARGET_FIELDS.has(name),
  ...extra,
});

const COMMON = [setting("queryTimeoutSecs", "number"), setting("maxRows", "number")];

function sqlKind(kind: string, name: string, port: number, tls: WireSetting[]): WireKind {
  return {
    kind,
    name,
    shapes: ["frame"],
    hintKey: `datasources.kinds.${kind}.hint`,
    settings: [
      setting("host", "string", { required: true }),
      setting("port", "number", { default: port }),
      setting("database", "string", { required: true }),
      setting("user", "string", { required: true }),
      setting("password", "string", { secret: true }),
      ...tls,
      setting("caCert", "text"),
      ...COMMON,
    ],
  };
}

/** The kinds in the documented order and with the documented fields and defaults. */
export const FAKE_KINDS: WireKind[] = [
  sqlKind("postgres", "PostgreSQL", 5432, [
    setting("sslMode", "select", {
      options: ["disable", "prefer", "require", "verify-ca", "verify-full"],
      default: "prefer",
    }),
  ]),
  sqlKind("mysql", "MySQL / MariaDB", 3306, [
    setting("sslMode", "select", {
      options: ["disabled", "preferred", "required", "verify_ca", "verify_identity"],
      default: "preferred",
    }),
  ]),
  {
    kind: "sqlite",
    name: "SQLite",
    shapes: ["frame"],
    hintKey: "datasources.kinds.sqlite.hint",
    settings: [setting("path", "string", { required: true }), ...COMMON],
  },
  sqlKind("mssql", "Microsoft SQL Server", 1433, [
    setting("encrypt", "bool", { default: true }),
    setting("trustServerCertificate", "bool", { default: false }),
  ]),
  {
    kind: "prometheus",
    name: "Prometheus",
    shapes: ["frame"],
    hintKey: "datasources.kinds.prometheus.hint",
    settings: [
      setting("url", "string", { required: true }),
      setting("basicAuthUser", "string"),
      setting("basicAuthPassword", "string", { secret: true }),
      setting("bearerToken", "string", { secret: true }),
      setting("caCert", "text"),
      ...COMMON,
    ],
  },
  {
    kind: "elasticsearch",
    name: "Elasticsearch / OpenSearch",
    shapes: ["documents", "frame"],
    hintKey: "datasources.kinds.elasticsearch.hint",
    settings: [
      setting("url", "string", { required: true }),
      setting("basicAuthUser", "string"),
      setting("basicAuthPassword", "string", { secret: true }),
      setting("apiKey", "string", { secret: true }),
      setting("bearerToken", "string", { secret: true }),
      setting("caCert", "text"),
      setting("index", "string"),
      setting("timeField", "string", { default: "@timestamp" }),
      ...COMMON,
    ],
  },
  {
    kind: "file",
    name: "CSV/JSON file",
    shapes: ["frame", "documents"],
    hintKey: "datasources.kinds.file.hint",
    settings: [
      setting("path", "string", { required: true }),
      setting("format", "select", { options: ["auto", "csv", "json", "ndjson"], default: "auto" }),
      setting("delimiter", "select", {
        options: ["auto", "comma", "semicolon", "tab", "pipe"],
        default: "auto",
      }),
      setting("decimal", "select", { options: ["auto", "point", "comma"], default: "auto" }),
      setting("header", "bool", { default: true }),
      ...COMMON,
    ],
  },
  {
    kind: "http_json",
    name: "HTTP JSON",
    shapes: ["documents"],
    hintKey: "datasources.kinds.http_json.hint",
    settings: [
      setting("url", "string", { required: true }),
      setting("basicAuthUser", "string"),
      setting("basicAuthPassword", "string", { secret: true }),
      setting("bearerToken", "string", { secret: true }),
      setting("apiKeyHeader", "string"),
      setting("apiKey", "string", { secret: true }),
      setting("caCert", "text"),
      setting("documentsPath", "string"),
      ...COMMON,
    ],
  },
  {
    kind: "mongodb",
    name: "MongoDB",
    shapes: ["documents"],
    hintKey: "datasources.kinds.mongodb.hint",
    settings: [
      setting("hosts", "string", { required: true }),
      setting("port", "number", { default: 27017 }),
      setting("srv", "bool", { default: false }),
      setting("replicaSet", "string"),
      setting("database", "string", { required: true }),
      setting("user", "string"),
      setting("password", "string", { secret: true }),
      setting("authSource", "string"),
      setting("tls", "bool", { default: false }),
      setting("caCert", "text"),
      setting("maxResponseBytes", "number"),
      ...COMMON,
    ],
  },
  boltKind("neo4j", "Neo4j", []),
  boltKind("memgraph", "Memgraph", [
    setting("allowWriteCapableUser", "bool", { default: false, target: true }),
  ]),
  {
    kind: "tigergraph",
    name: "TigerGraph",
    shapes: ["graph", "frame"],
    hintKey: "datasources.kinds.tigergraph.hint",
    settings: [
      setting("url", "string", {
        required: true,
        target: true,
        labelKey: "datasources.settings.gsqlUrl",
      }),
      setting("restppUrl", "string", { target: true }),
      setting("graph", "string", { required: true, target: true }),
      setting("user", "string", { required: true }),
      setting("password", "string", { secret: true }),
      setting("secret", "string", { secret: true, labelKey: "datasources.settings.restppSecret" }),
      setting("caCert", "text"),
      setting("approvedQueries", "text", { target: true }),
      setting("maxNodes", "number", { default: 10_000 }),
      setting("maxEdges", "number", { default: 50_000 }),
      ...COMMON,
    ],
  },
];

/** Neo4j and Memgraph over Bolt (docs/api/datasources.md, the fields per kind). */
function boltKind(kind: string, name: string, extra: WireSetting[]): WireKind {
  return {
    kind,
    name,
    shapes: ["graph", "frame"],
    hintKey: `datasources.kinds.${kind}.hint`,
    settings: [
      setting("host", "string", { required: true }),
      setting("port", "number", { default: 7687 }),
      setting("database", "string"),
      setting("user", "string"),
      setting("password", "string", { secret: true }),
      setting("encrypt", "bool", { default: false }),
      setting("trustServerCertificate", "bool", { default: false }),
      setting("caCert", "text"),
      setting("maxNodes", "number", { default: 10_000 }),
      setting("maxEdges", "number", { default: 50_000 }),
      ...extra,
      ...COMMON,
    ],
  };
}

export interface StoredDatasource {
  id: string;
  name: string;
  kind: string;
  settings: Record<string, unknown>;
  secrets: Record<string, string>;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;
}

export interface WireHealth {
  ok: boolean;
  reason?: string;
  params?: Record<string, string>;
  message: string;
  latencyMs: number;
  code?: string;
}

export interface FakeDatasourcesState {
  datasources: StoredDatasource[];
  /** Schema answers per data source id, in the documented wire shape. */
  schemas: Record<string, unknown>;
  /** The answer of "Test connection" per data source id; healthy by default. */
  health: Record<string, WireHealth>;
  /** Answers one valid query item. Defaults to `defaultOutcome`. */
  respond: (
    item: QueryItem,
    range: TimeRange,
    variables: Record<string, unknown>,
  ) => QueryOutcome | Promise<QueryOutcome>;
  /** Grants on data sources for the caller, by data source id. */
  grants: Record<string, "query" | "edit" | "admin">;
  /** Whether answers carry `access` (stream C's addition); false plays an older server. */
  sendAccess: boolean;
  /** Every request body of the free query route, in order. */
  queries: Record<string, unknown>[];
  /** Collections of MongoDB sources (one set for all of them), by name. */
  mongo: Record<string, Record<string, unknown>[]>;
}

export const PG_ID = "ds-pg";
export const PROM_ID = "ds-prom";
export const MONGO_ID = "ds-mongo";

/** Adds a MongoDB source with the fake collections and their sampled fields to the schema. */
export function addMongoSource(state: FakeDatasourcesState): void {
  const created = Date.UTC(2026, 0, 16);
  state.datasources.push({
    id: MONGO_ID,
    name: "Shop documents",
    kind: "mongodb",
    settings: { hosts: "mongo.internal", database: "shop", user: "reader" },
    secrets: { password: "s3cret" },
    createdAt: created,
    updatedAt: created,
  });
  state.schemas[MONGO_ID] = {
    kind: "collections",
    database: "shop",
    collections: [
      {
        name: "orders",
        type: "collection",
        indexes: [{ name: "_id_", keys: [{ field: "_id", kind: 1 }], unique: true }],
        fields: [{ path: "status", coverage: 1, types: [{ name: "string", share: 1 }] }],
        sampled: 3,
      },
      { name: "customers", type: "collection", indexes: [], fields: [], sampled: 0 },
    ],
  };
}

/** Hosts in link-local and metadata ranges are refused, as the target check does. */
const BLOCKED_HOST = /^(169\.254\.|fe80:|fd00:ec2::254)/i;

/**
 * A query whose text contains `fail:<code>` answers that error code. SQL with "time" in it, and
 * every PromQL query, answers a time series; other SQL a table with int64 and null values;
 * Cypher a graph (fakeGraph.ts).
 */
export function defaultOutcome(
  item: QueryItem,
  range: TimeRange,
  variables: Record<string, unknown> = {},
): QueryOutcome {
  const query = (item.query ?? {}) as Record<string, unknown>;
  const text = String(query.sql ?? query.expr ?? query.cypher ?? "");
  const failure = /fail:(\w+)/.exec(text);
  if (failure !== null) {
    return { error: { code: failure[1] as never, message: `source said no (${failure[1]})` } };
  }
  if (typeof query.cypher === "string") {
    return graphOutcome(query.cypher, variables);
  }
  if (typeof query.gsql === "string" || typeof query.installed === "string") {
    return { result: { shape: "graph", graph: FAKE_GRAPH } };
  }
  const meta = { executedQuery: text, rowsTruncated: false, notices: [] };
  if (typeof query.sql === "string" && !/\btime\b/i.test(query.sql)) {
    return {
      result: {
        shape: "frame",
        frame: {
          fields: [
            { name: "id", type: "int64", values: ["9007199254740993", "2", null] },
            { name: "name", type: "string", values: ["Ada", null, "Grace"] },
            { name: "score", type: "number", values: [1.5, null, 3] },
          ],
          meta,
        },
      },
    };
  }
  const points = 10;
  const step = (range.to - range.from) / (points - 1);
  return {
    result: {
      shape: "frame",
      frame: {
        fields: [
          {
            name: "time",
            type: "time",
            values: Array.from({ length: points }, (_, i) => range.from + i * step),
          },
          {
            name: "up",
            type: "number",
            values: Array.from({ length: points }, (_, i) => i * 2),
            labels: { job: "api" },
          },
        ],
        meta,
      },
    },
  };
}

const unknownKey = (body: Record<string, unknown>, allowed: string[]) =>
  Object.keys(body).find((key) => !allowed.includes(key));

/** Request body field checks shared with the dashboard fakes. */
export function unknownField(body: Record<string, unknown>, allowed: string[]) {
  return unknownKey(body, allowed);
}

/** `PanelQueryRequest` in api/generated/shapes.ts. */
export const PANEL_QUERY_REQUEST_FIELDS = [
  "timeRange",
  "cursors",
  "limit",
  "intervalMs",
  "maxDataPoints",
  "variables",
];
const QUERY_REQUEST_FIELDS = [
  "queries",
  "timeRange",
  "intervalMs",
  "maxDataPoints",
  "variables",
  "explore",
];
const QUERY_ITEM_FIELDS = ["refId", "datasourceId", "query", "cursor", "limit"];

/** The documented query form of the kind; null when it fits, else the rejection message. */
function queryFormProblem(kind: string, query: unknown): string | null {
  if (typeof query !== "object" || query === null) {
    return "the query is not an object";
  }
  const q = query as Record<string, unknown>;
  if (kind === "mongodb") {
    // Checked whole, with its reasons, in `answerQuery`.
    return null;
  }
  if (kind === "neo4j" || kind === "memgraph") {
    const extra = unknownKey(q, ["cypher"]);
    if (extra !== undefined) return `unknown query field ${extra}`;
    if (typeof q.cypher !== "string") return "cypher is required";
    return q.cypher.trim() === "" ? "the query is empty" : null;
  }
  if (kind === "tigergraph") {
    const extra = unknownKey(q, ["gsql", "installed", "params"]);
    if (extra !== undefined) return `unknown query field ${extra}`;
    const forms = [typeof q.gsql === "string", typeof q.installed === "string"].filter(Boolean);
    return forms.length === 1 ? null : "gsql or installed is required";
  }
  if (kind === "prometheus") {
    const extra = unknownKey(q, ["expr", "instant", "minStepMs"]);
    if (extra !== undefined) return `unknown query field ${extra}`;
    if (typeof q.expr !== "string") return "expr is required";
    if (q.instant !== undefined && typeof q.instant !== "boolean") return "instant is a boolean";
    if (q.minStepMs !== undefined && !Number.isInteger(q.minStepMs)) return "minStepMs";
    return null;
  }
  const extra = unknownKey(q, ["sql"]);
  if (extra !== undefined) return `unknown query field ${extra}`;
  if (typeof q.sql !== "string") return "sql is required";
  // An empty statement is not a single SELECT or WITH.
  return q.sql.trim() === "" ? "the query is empty" : null;
}

/** Runs one query item as the server would: on a live data source, in its documented form. */
export async function answerQuery(
  state: FakeDatasourcesState,
  item: QueryItem,
  range: TimeRange,
  variables: Record<string, unknown> = {},
): Promise<QueryOutcome> {
  const source = state.datasources.find(
    (d) => d.id === item.datasourceId && d.deletedAt === undefined,
  );
  if (source === undefined) {
    return { error: { code: "not_found", message: "no such data source" } };
  }
  if (source.kind === "mongodb") {
    // The MongoDB rejections carry their reasons (a write stage), so they answer whole.
    const parsed = parseMongo(item.query);
    if ("error" in parsed) {
      return parsed;
    }
  }
  // Search, file and HTTP JSON sources answer from their own fake, with the server's reasons.
  const answered = sourceOutcome(source, item, range, variables);
  if (answered !== undefined) {
    return answered;
  }
  const problem = queryFormProblem(source.kind, item.query);
  if (problem !== null) {
    return { error: { code: "query_rejected", message: problem } };
  }
  return state.respond(item, range, variables);
}

/** Adds the Elasticsearch, CSV file and HTTP JSON sources (ES_ID, FILE_ID, HTTP_ID) with schemas. */
export function addSourceKinds(state: FakeDatasourcesState): void {
  state.datasources.push(...sourceKindSources(Date.UTC(2026, 0, 12)));
  Object.assign(state.schemas, FAKE_SOURCE_SCHEMAS);
}

/** Adds the TigerGraph source "Tiger" (graph `social`) with an installed query, for the tests. */
export function addTigerGraphSource(state: FakeDatasourcesState): void {
  const created = Date.UTC(2026, 0, 9);
  state.datasources.push({
    id: TIGERGRAPH_ID,
    name: "Tiger",
    kind: "tigergraph",
    settings: { url: "https://tg.internal:14240", graph: "social", user: "reader" },
    secrets: { password: "s3cret" },
    createdAt: created,
    updatedAt: created,
  });
  state.schemas[TIGERGRAPH_ID] = { ...FAKE_GRAPH_SCHEMA, queries: ["neighbours", "top_customers"] };
}

/** Adds the Neo4j source "Graph DB" (NEO4J_ID) with its schema, for the graph tests. */
export function addNeo4jSource(state: FakeDatasourcesState): void {
  const created = Date.UTC(2026, 0, 10);
  state.datasources.push({
    id: NEO4J_ID,
    name: "Graph DB",
    kind: "neo4j",
    settings: { host: "graph.internal", port: 7687, user: "reader" },
    secrets: { password: "s3cret" },
    createdAt: created,
    updatedAt: created,
  });
  state.schemas[NEO4J_ID] = FAKE_GRAPH_SCHEMA;
}

function publicView(ds: StoredDatasource, access?: Record<string, boolean>) {
  const secrets = Object.fromEntries(Object.keys(ds.secrets).map((name) => [name, { set: true }]));
  const view: Record<string, unknown> = {
    id: ds.id,
    name: ds.name,
    kind: ds.kind,
    settings: ds.settings,
    secrets,
    createdAt: ds.createdAt,
    updatedAt: ds.updatedAt,
  };
  if (ds.deletedAt !== undefined) {
    view.deletedAt = ds.deletedAt;
  }
  if (access !== undefined) {
    view.access = access;
  }
  return view;
}

function validation(field: string): Response {
  return json(422, { error: { code: "validation", message: `invalid ${field}`, field } });
}

/** Settings and secrets as the save routes check them; a Response when they are refused. */
function checkSettings(
  kind: WireKind,
  settings: Record<string, unknown>,
  secrets: Record<string, unknown>,
  requireAll: boolean,
): Response | null {
  for (const [name, value] of Object.entries(settings)) {
    const spec = kind.settings.find((s) => s.name === name);
    if (spec === undefined) return validation("settings");
    if (spec.secret) return validation(name);
    const ok =
      spec.type === "number"
        ? Number.isInteger(value) && (value as number) >= 0
        : spec.type === "bool"
          ? typeof value === "boolean"
          : spec.type === "select"
            ? spec.options?.includes(String(value)) === true
            : typeof value === "string";
    if (!ok) return validation(name);
    if (name === "port" && ((value as number) < 1 || (value as number) > 65535)) {
      return validation("port");
    }
    if (
      (name === "host" || name === "url") &&
      BLOCKED_HOST.test(String(value).replace(/^https?:\/\//, ""))
    ) {
      return json(422, {
        error: { code: "datasource_target_blocked", message: "target refused", field: name },
      });
    }
    // SQLite files only from the admin-allowed folders, here /data (docs: target reasons).
    if (name === "path" && kind.kind === "sqlite" && !String(value).startsWith("/data/")) {
      return json(422, {
        error: {
          code: "datasource_target_blocked",
          message: "the SQLite file is not in an allowed directory",
          field: "path",
          reason: "target.sqlite_path_refused",
        },
      });
    }
  }
  for (const name of Object.keys(secrets)) {
    const spec = kind.settings.find((s) => s.name === name);
    if (spec === undefined || !spec.secret) return validation("secrets");
  }
  if (requireAll) {
    for (const spec of kind.settings) {
      if (spec.required && !spec.secret && settings[spec.name] === undefined) {
        return validation(spec.name);
      }
    }
  }
  return null;
}

export function datasourcesFake(areas: FakeAreaStates): FakeArea<FakeDatasourcesState> {
  let nextId = 1;
  const created = Date.UTC(2026, 0, 15);
  const state: FakeDatasourcesState = {
    datasources: [
      {
        id: PG_ID,
        name: "Sales DB",
        kind: "postgres",
        settings: {
          host: "db.internal",
          port: 5432,
          database: "sales",
          user: "reader",
          sslMode: "verify-full",
        },
        secrets: { password: "s3cret" },
        createdAt: created,
        updatedAt: created,
      },
      {
        id: PROM_ID,
        name: "Metrics",
        kind: "prometheus",
        settings: { url: "http://prometheus:9090" },
        secrets: {},
        createdAt: created - 1000,
        updatedAt: created - 1000,
      },
    ],
    schemas: {
      [PG_ID]: {
        kind: "tables",
        tables: [
          {
            schema: "public",
            name: "orders",
            columns: [
              { name: "id", type: "bigint" },
              { name: "created_at", type: "timestamptz" },
              { name: "amount", type: "numeric" },
            ],
          },
          { schema: "public", name: "customers", columns: [{ name: "name", type: "text" }] },
        ],
      },
      [PROM_ID]: {
        kind: "metrics",
        metrics: ["http_requests_total", "up"],
        labels: ["instance", "job", "status"],
      },
    },
    health: {},
    // MongoDB queries run against the fake collections; everything else as `defaultOutcome`.
    respond: (item, range, variables) =>
      typeof (item.query as Record<string, unknown> | null)?.collection === "string"
        ? mongoOutcome(item, state.mongo)
        : defaultOutcome(item, range, variables),
    grants: {},
    sendAccess: true,
    queries: [],
    mongo: FAKE_MONGO_COLLECTIONS(),
  };

  const live = () => state.datasources.filter((ds) => ds.deletedAt === undefined);
  const nameTaken = (name: string, except?: string) =>
    live().some((ds) => ds.name === name && ds.id !== except);

  async function handle(request: FakeRequest): Promise<Response | undefined> {
    const { method, route, search, body, permissions } = request;
    const parts = route.split("/").slice(4); // after /api/orgs/{orgId}
    const can = (permission: string) => permissions.has(permission);
    // "On the source" (docs/api/datasources.md): the org-wide permission, or a grant on that
    // source; `query` gives read and query, `edit` adds write, `admin` adds permissions.
    const level = (id: string) => state.grants[id];
    const may = (id: string, right: "read" | "query" | "write" | "admin") => {
      const grant = level(id);
      const granted =
        grant === "admin" ||
        (grant === "edit" && right !== "admin") ||
        (grant === "query" && (right === "read" || right === "query"));
      const role = right === "admin" ? can("datasources:write") : can(`datasources:${right}`);
      return granted || role;
    };
    const sees = (id: string) => may(id, "read") || may(id, "query");
    // The `access` object of list and detail answers, unless the test plays an older server.
    const accessOf = (id: string) =>
      state.sendAccess
        ? {
            read: sees(id),
            query: may(id, "query"),
            write: may(id, "write"),
            permissions: level(id) === "admin" || can("datasources:permissions"),
            changeTarget: may(id, "admin"),
          }
        : undefined;
    const view = (ds: StoredDatasource) => publicView(ds, accessOf(ds.id));

    if (parts[0] === "datasource-kinds" && parts.length === 1 && method === "GET") {
      return json(200, { items: FAKE_KINDS, nextCursor: null });
    }
    if (parts[0] === "query" && parts.length === 1 && method === "POST") {
      const extra = unknownKey(body, QUERY_REQUEST_FIELDS);
      if (extra !== undefined) {
        return validation(extra);
      }
      const items = (body.queries ?? []) as QueryItem[];
      if (items.length < 1 || items.length > 50) {
        return validation("queries");
      }
      for (const item of items) {
        if (
          unknownKey(item as unknown as Record<string, unknown>, QUERY_ITEM_FIELDS) !== undefined
        ) {
          return validation("queries");
        }
      }
      const range = body.timeRange as TimeRange;
      if (range.from > range.to) {
        return validation("timeRange");
      }
      state.queries.push(body);
      const results: Record<string, QueryOutcome> = {};
      const history = body.explore === true ? areas.exploreHistory?.entries : undefined;
      for (const item of items) {
        // Per query: an unseen source is not_found, a seen one without the right forbidden.
        results[item.refId] = !sees(item.datasourceId)
          ? { error: { code: "not_found", message: "no such data source" } }
          : !may(item.datasourceId, "query")
            ? { error: { code: "forbidden", message: "no query right on this data source" } }
            : await answerQuery(
                state,
                item,
                range,
                (body.variables ?? {}) as Record<string, unknown>,
              );
      }
      // Explore keeps the successful runs of the caller (docs/api/explore-history.md).
      for (const item of items) {
        const ds = state.datasources.find((d) => d.id === item.datasourceId);
        if (history !== undefined && ds !== undefined && "result" in (results[item.refId] ?? {})) {
          history.unshift({
            id: `h${history.length + 1}-${Date.now()}`,
            datasourceId: ds.id,
            datasourceName: ds.name,
            datasourceKind: ds.kind,
            query: item.query,
            shape: "frame",
            rowCount: null,
            durationMs: 1,
            createdAt: Date.now(),
          });
        }
      }
      return json(200, { results });
    }
    if (parts[0] !== "datasources") {
      return undefined;
    }
    if (parts.length === 1 && method === "GET") {
      const extra = [...search.keys()].find((key) => !["limit", "cursor", "trash"].includes(key));
      if (extra !== undefined) {
        return validation(extra);
      }
      const trash = search.get("trash") === "true";
      // Members get what they may read or query; the trash, what they may restore.
      const limit = Number(search.get("limit") ?? 50);
      const start = Number(search.get("cursor") ?? 0);
      const all = state.datasources
        .filter((ds) => (trash ? ds.deletedAt !== undefined : ds.deletedAt === undefined))
        .filter((ds) => (trash ? may(ds.id, "write") : sees(ds.id)))
        .sort((a, b) => b.createdAt - a.createdAt);
      const items = all.slice(start, start + limit).map((ds) => {
        const item: Record<string, unknown> = {
          id: ds.id,
          name: ds.name,
          kind: ds.kind,
          createdAt: ds.createdAt,
        };
        if (ds.deletedAt !== undefined) item.deletedAt = ds.deletedAt;
        const access = accessOf(ds.id);
        if (access !== undefined) item.access = access;
        return item;
      });
      const next = start + limit < all.length ? String(start + limit) : null;
      return json(200, { items, nextCursor: next });
    }
    if (parts.length === 1 && method === "POST") {
      if (!can("datasources:write")) {
        return error(403, "forbidden");
      }
      const extra = unknownKey(body, ["name", "kind", "settings", "secrets"]);
      if (extra !== undefined) {
        return validation(extra);
      }
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (name === "" || name.length > 100) {
        return validation("name");
      }
      const kind = FAKE_KINDS.find((k) => k.kind === body.kind);
      if (kind === undefined) {
        return validation("kind");
      }
      const settings = (body.settings ?? {}) as Record<string, unknown>;
      const secrets = (body.secrets ?? {}) as Record<string, unknown>;
      const refused = checkSettings(kind, settings, secrets, true);
      if (refused !== null) {
        return refused;
      }
      if (nameTaken(name)) {
        return json(409, { error: { code: "conflict", message: "name in use", field: "name" } });
      }
      const now = Date.now();
      const stored: StoredDatasource = {
        id: `ds-new-${nextId++}`,
        name,
        kind: kind.kind,
        settings,
        secrets: Object.fromEntries(
          Object.entries(secrets).filter((e): e is [string, string] => typeof e[1] === "string"),
        ),
        createdAt: now,
        updatedAt: now,
      };
      state.datasources.push(stored);
      return json(201, view(stored));
    }
    const ds = state.datasources.find((d) => d.id === decodeURIComponent(parts[1] ?? ""));
    const inTrash = ds?.deletedAt !== undefined;
    if (ds === undefined || (inTrash && parts[2] !== "restore")) {
      return error(404, "not_found");
    }
    if (!sees(ds.id)) {
      return error(404, "not_found");
    }
    if (parts.length === 2 && method === "GET") {
      return may(ds.id, "read") ? json(200, view(ds)) : error(403, "forbidden");
    }
    if (parts[2] === "schema" && method === "GET") {
      return may(ds.id, "query") ? json(200, state.schemas[ds.id]) : error(403, "forbidden");
    }
    if (parts[2] === "health" && method === "POST") {
      if (!may(ds.id, "query")) {
        return error(403, "forbidden");
      }
      if (Object.keys(body).length > 0) {
        return validation(Object.keys(body)[0] ?? "");
      }
      return json(
        200,
        state.health[ds.id] ?? {
          ok: true,
          reason: "health.connected",
          params: { engine: "PostgreSQL", version: "17.2" },
          message: "PostgreSQL 17.2",
          latencyMs: 12,
        },
      );
    }
    if (!may(ds.id, "write")) {
      return error(403, "forbidden");
    }
    // A save or delete from a form loaded before the last change (Update in the doc).
    const stale = (expected: unknown) =>
      typeof expected === "number" && expected !== ds.updatedAt
        ? json(409, {
            error: { code: "version_conflict", message: "a newer version was saved" },
            current: view(ds),
          })
        : null;
    if (parts.length === 2 && method === "PATCH") {
      const extra = unknownKey(body, ["name", "settings", "secrets", "expectedUpdatedAt"]);
      if (extra !== undefined) {
        return validation(extra);
      }
      const refusedStale = stale(body.expectedUpdatedAt);
      if (refusedStale !== null) {
        return refusedStale;
      }
      // Settings and secrets change only over a named version (Update in the doc).
      const changesTarget =
        body.settings !== undefined || Object.keys((body.secrets ?? {}) as object).length > 0;
      if (changesTarget && typeof body.expectedUpdatedAt !== "number") {
        return json(422, {
          error: {
            code: "validation",
            message: "expectedUpdatedAt is required when settings or secrets change",
            field: "expectedUpdatedAt",
            reason: "datasource.expected_version_missing",
          },
        });
      }
      const kind = FAKE_KINDS.find((k) => k.kind === ds.kind) as WireKind;
      const settings = (body.settings ?? ds.settings) as Record<string, unknown>;
      const secrets = (body.secrets ?? {}) as Record<string, unknown>;
      const refused = checkSettings(kind, settings, secrets, body.settings !== undefined);
      if (refused !== null) {
        return refused;
      }
      // A changed target field needs every stored secret in the same patch (Update in the doc).
      const movedTarget = kind.settings.find(
        (s) => s.target && JSON.stringify(settings[s.name]) !== JSON.stringify(ds.settings[s.name]),
      );
      // A target change needs org-wide write or an admin grant; an edit grant is not enough.
      if (movedTarget !== undefined && !may(ds.id, "admin")) {
        return json(403, {
          error: {
            code: "forbidden",
            message: `changing ${movedTarget.name} needs the admin level on this data source`,
            reason: "datasource.target_change_forbidden",
            params: { field: movedTarget.name },
          },
        });
      }
      if (movedTarget !== undefined) {
        const missing = Object.keys(ds.secrets).find((name) => !(name in secrets));
        if (missing !== undefined) {
          return json(422, {
            error: {
              code: "validation",
              message: `${movedTarget.name} changes where the data source connects; send ${missing} again or remove it`,
              field: missing,
            },
          });
        }
      }
      if (typeof body.name === "string") {
        if (nameTaken(body.name.trim(), ds.id)) {
          return json(409, { error: { code: "conflict", message: "name in use", field: "name" } });
        }
        ds.name = body.name.trim();
      }
      if (body.settings !== undefined) ds.settings = settings;
      for (const [field, value] of Object.entries(secrets)) {
        if (value === null) {
          delete ds.secrets[field];
        } else if (typeof value === "string") {
          ds.secrets[field] = value;
        }
      }
      ds.updatedAt = Date.now();
      return json(200, view(ds));
    }
    if (parts.length === 2 && method === "DELETE") {
      const expected = search.get("expectedUpdatedAt");
      const refusedStale = stale(expected === null ? undefined : Number(expected));
      if (refusedStale !== null) {
        return refusedStale;
      }
      ds.deletedAt = Date.now();
      return new Response(null, { status: 204 });
    }
    if (parts[2] === "restore" && method === "POST") {
      if (!inTrash) {
        return error(404, "not_found");
      }
      delete ds.deletedAt;
      return json(200, view(ds));
    }
    return undefined;
  }

  return { state, handle };
}
