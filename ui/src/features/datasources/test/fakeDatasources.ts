import type {
  QueryItem,
  QueryOutcome,
  QueryRequest,
  TimeRange,
} from "../../../api/generated/shapes";
import {
  error,
  type FakeArea,
  type FakeAreaStates,
  type FakeRequest,
  json,
} from "../../../test/fakeServer";
import type { DatasourceKind, Health, SourceSchema } from "../api";

/**
 * Fake routes for data sources and the free query route, following the contract in
 * docs/ARCHITECTURE.md: secrets are write-only (`{set}`), PATCH uses omitted/null/string for
 * secrets, versions are checked, deleting moves to the trash, and permissions are enforced.
 */

export interface StoredDatasource {
  id: string;
  name: string;
  kind: string;
  settings: Record<string, unknown>;
  secrets: Record<string, string>;
  version: number;
  createdAt: number;
  deletedAt?: number;
}

export interface FakeDatasourcesState {
  kinds: DatasourceKind[];
  datasources: StoredDatasource[];
  schemas: Record<string, SourceSchema>;
  /** The answer of "Test connection" per data source id; healthy by default. */
  health: Record<string, Health>;
  /** Answers one query item. Defaults to `defaultOutcome`. */
  respond: (item: QueryItem, range: TimeRange) => QueryOutcome | Promise<QueryOutcome>;
  /** Every request to the free query route, in order. */
  queries: QueryRequest[];
}

export const SQL_SETTINGS: DatasourceKind["settings"] = [
  {
    name: "host",
    labelKey: "datasources.settings.host",
    type: "string",
    required: true,
    secret: false,
  },
  {
    name: "port",
    labelKey: "datasources.settings.port",
    type: "number",
    required: false,
    secret: false,
  },
  {
    name: "database",
    labelKey: "datasources.settings.database",
    type: "string",
    required: true,
    secret: false,
  },
  {
    name: "user",
    labelKey: "datasources.settings.user",
    type: "string",
    required: true,
    secret: false,
  },
  {
    name: "password",
    labelKey: "datasources.settings.password",
    type: "string",
    required: false,
    secret: true,
  },
  {
    name: "sslMode",
    labelKey: "datasources.settings.sslMode",
    type: "select",
    required: true,
    secret: false,
    options: [
      { value: "require", label: "require" },
      { value: "disable", label: "disable" },
    ],
  },
];

export const FAKE_KINDS: DatasourceKind[] = [
  { kind: "postgres", name: "PostgreSQL", shapes: ["frame"], settings: SQL_SETTINGS },
  { kind: "mysql", name: "MySQL / MariaDB", shapes: ["frame"], settings: SQL_SETTINGS },
  {
    kind: "sqlite",
    name: "SQLite",
    shapes: ["frame"],
    settings: [
      {
        name: "path",
        labelKey: "datasources.settings.path",
        type: "path",
        required: true,
        secret: false,
      },
    ],
  },
  {
    kind: "prometheus",
    name: "Prometheus",
    shapes: ["frame"],
    settings: [
      {
        name: "url",
        labelKey: "datasources.settings.url",
        type: "url",
        required: true,
        secret: false,
      },
      {
        name: "token",
        labelKey: "datasources.settings.token",
        type: "string",
        required: false,
        secret: true,
      },
      {
        name: "tlsSkipVerify",
        labelKey: "datasources.settings.tlsSkipVerify",
        type: "bool",
        required: false,
        secret: false,
      },
    ],
  },
];

export const PG_ID = "ds-pg";
export const PROM_ID = "ds-prom";

/** A query whose text contains `fail:<code>` answers that error code; handy in tests. */
export function defaultOutcome(item: QueryItem, range: TimeRange): QueryOutcome {
  const query = (item.query ?? {}) as Record<string, unknown>;
  const text = String(query.sql ?? query.expr ?? "");
  const failure = /fail:(\w+)/.exec(text);
  if (failure !== null) {
    return { error: { code: failure[1] as never, message: `source said no (${failure[1]})` } };
  }
  if (query.format === "table") {
    return {
      result: {
        shape: "frame",
        frame: {
          fields: [
            { name: "id", type: "int64", values: ["9007199254740993", "2", null] },
            { name: "name", type: "string", values: ["Ada", null, "Grace"] },
            { name: "score", type: "number", values: [1.5, null, 3] },
          ],
          meta: { executedQuery: text, rowsTruncated: false, notices: [] },
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
            name: "value",
            type: "number",
            values: Array.from({ length: points }, (_, i) => i * 2),
          },
        ],
        meta: { executedQuery: text, rowsTruncated: false, notices: [] },
      },
    },
  };
}

/** Runs one query item as the server would: only against a data source that is not deleted. */
export async function answerQuery(
  state: FakeDatasourcesState,
  item: QueryItem,
  range: TimeRange,
): Promise<QueryOutcome> {
  const exists = state.datasources.some(
    (d) => d.id === item.datasourceId && d.deletedAt === undefined,
  );
  if (!exists) {
    return { error: { code: "not_found", message: "no such data source" } };
  }
  return state.respond(item, range);
}

function publicView(ds: StoredDatasource) {
  const kind = FAKE_KINDS.find((k) => k.kind === ds.kind);
  const secrets = Object.fromEntries(
    (kind?.settings ?? [])
      .filter((s) => s.secret)
      .map((s) => [s.name, { set: ds.secrets[s.name] !== undefined }]),
  );
  return {
    id: ds.id,
    name: ds.name,
    kind: ds.kind,
    settings: ds.settings,
    secrets,
    version: ds.version,
  };
}

export function datasourcesFake(_areas: FakeAreaStates): FakeArea<FakeDatasourcesState> {
  let nextId = 1;
  const state: FakeDatasourcesState = {
    kinds: FAKE_KINDS,
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
          sslMode: "require",
        },
        secrets: { password: "s3cret" },
        version: 1,
        createdAt: Date.UTC(2026, 0, 15),
      },
      {
        id: PROM_ID,
        name: "Metrics",
        kind: "prometheus",
        settings: { url: "http://prometheus:9090", tlsSkipVerify: false },
        secrets: {},
        version: 1,
        createdAt: Date.UTC(2026, 1, 1),
      },
    ],
    schemas: {
      [PG_ID]: {
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
        metrics: [
          { name: "http_requests_total", help: "Requests served", labels: ["job", "status"] },
          { name: "up", labels: ["job", "instance"] },
        ],
      },
    },
    health: {},
    respond: defaultOutcome,
    queries: [],
  };

  const live = () => state.datasources.filter((ds) => ds.deletedAt === undefined);

  async function handle(request: FakeRequest): Promise<Response | undefined> {
    const { method, route, body, permissions } = request;
    const parts = route.split("/").slice(4); // after /api/orgs/{orgId}
    const can = (permission: string) => permissions.has(permission);

    if (parts[0] === "datasource-kinds" && parts.length === 1 && method === "GET") {
      return can("datasources:read") || can("datasources:write")
        ? json(200, state.kinds)
        : error(403, "forbidden");
    }
    if (parts[0] === "query" && parts.length === 1 && method === "POST") {
      if (!can("datasources:query")) {
        return error(403, "forbidden");
      }
      const query = body as unknown as QueryRequest;
      state.queries.push(query);
      const results: Record<string, QueryOutcome> = {};
      for (const item of query.queries) {
        results[item.refId] = await answerQuery(state, item, query.timeRange);
      }
      return json(200, { results });
    }
    if (parts[0] !== "datasources") {
      return undefined;
    }
    const readable = can("datasources:read") || can("datasources:write");
    if (parts.length === 1 && method === "GET") {
      if (!readable) {
        return error(403, "forbidden");
      }
      const items = live().map(({ id, name, kind, createdAt }) => ({ id, name, kind, createdAt }));
      return json(200, { items, nextCursor: null });
    }
    if (parts.length === 1 && method === "POST") {
      if (!can("datasources:write")) {
        return error(403, "forbidden");
      }
      if (typeof body.name !== "string" || body.name === "") {
        return error(400, "validation", "name");
      }
      const created: StoredDatasource = {
        id: `ds-new-${nextId++}`,
        name: body.name,
        kind: String(body.kind),
        settings: (body.settings ?? {}) as Record<string, unknown>,
        secrets: (body.secrets ?? {}) as Record<string, string>,
        version: 1,
        createdAt: Date.now(),
      };
      state.datasources.push(created);
      return json(201, publicView(created));
    }
    const ds = state.datasources.find((d) => d.id === decodeURIComponent(parts[1] ?? ""));
    if (ds === undefined || (ds.deletedAt !== undefined && parts[2] !== "restore")) {
      return error(404, "not_found");
    }
    if (parts.length === 2 && method === "GET") {
      return readable ? json(200, publicView(ds)) : error(403, "forbidden");
    }
    if (parts[2] === "schema" && method === "GET") {
      return can("datasources:query")
        ? json(200, state.schemas[ds.id] ?? { tables: [] })
        : error(403, "forbidden");
    }
    if (parts[2] === "health" && method === "POST") {
      if (!can("datasources:write")) {
        return error(403, "forbidden");
      }
      return json(
        200,
        state.health[ds.id] ?? { ok: true, message: "PostgreSQL 17.2", latencyMs: 12.4 },
      );
    }
    if (!can("datasources:write")) {
      return error(403, "forbidden");
    }
    if (parts.length === 2 && method === "PATCH") {
      if (body.version !== ds.version) {
        return json(409, {
          error: { code: "version_conflict", message: "newer version" },
          current: publicView(ds),
        });
      }
      if (typeof body.name === "string") ds.name = body.name;
      if (body.settings !== undefined) ds.settings = body.settings as Record<string, unknown>;
      for (const [field, value] of Object.entries(
        (body.secrets ?? {}) as Record<string, unknown>,
      )) {
        if (value === null) {
          delete ds.secrets[field];
        } else if (typeof value === "string") {
          ds.secrets[field] = value;
        }
      }
      ds.version++;
      return json(200, publicView(ds));
    }
    if (parts.length === 2 && method === "DELETE") {
      ds.deletedAt = Date.now();
      return new Response(null, { status: 204 });
    }
    if (parts[2] === "restore" && method === "POST") {
      delete ds.deletedAt;
      return new Response(null, { status: 204 });
    }
    return undefined;
  }

  return { state, handle };
}
