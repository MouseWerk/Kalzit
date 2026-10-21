import type { QueryItem, QueryOutcome, TimeRange } from "../../../api/generated/shapes";
import {
  error,
  type FakeArea,
  type FakeAreaStates,
  type FakeRequest,
  json,
} from "../../../test/fakeServer";

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
];

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
  respond: (item: QueryItem, range: TimeRange) => QueryOutcome | Promise<QueryOutcome>;
  /** Grants on data sources for the caller, by data source id. */
  grants: Record<string, "query" | "edit" | "admin">;
  /** Every request body of the free query route, in order. */
  queries: Record<string, unknown>[];
}

export const PG_ID = "ds-pg";
export const PROM_ID = "ds-prom";

/** Hosts in link-local and metadata ranges are refused, as the target check does. */
const BLOCKED_HOST = /^(169\.254\.|fe80:|fd00:ec2::254)/i;

/**
 * A query whose text contains `fail:<code>` answers that error code. SQL with "time" in it, and
 * every PromQL query, answers a time series; other SQL a table with int64 and null values.
 */
export function defaultOutcome(item: QueryItem, range: TimeRange): QueryOutcome {
  const query = (item.query ?? {}) as Record<string, unknown>;
  const text = String(query.sql ?? query.expr ?? "");
  const failure = /fail:(\w+)/.exec(text);
  if (failure !== null) {
    return { error: { code: failure[1] as never, message: `source said no (${failure[1]})` } };
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
const QUERY_REQUEST_FIELDS = ["queries", "timeRange", "intervalMs", "maxDataPoints", "variables"];
const QUERY_ITEM_FIELDS = ["refId", "datasourceId", "query", "cursor", "limit"];

/** The documented query form of the kind; null when it fits, else the rejection message. */
function queryFormProblem(kind: string, query: unknown): string | null {
  if (typeof query !== "object" || query === null) {
    return "the query is not an object";
  }
  const q = query as Record<string, unknown>;
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
): Promise<QueryOutcome> {
  const source = state.datasources.find(
    (d) => d.id === item.datasourceId && d.deletedAt === undefined,
  );
  if (source === undefined) {
    return { error: { code: "not_found", message: "no such data source" } };
  }
  const problem = queryFormProblem(source.kind, item.query);
  if (problem !== null) {
    return { error: { code: "query_rejected", message: problem } };
  }
  return state.respond(item, range);
}

function publicView(ds: StoredDatasource) {
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

export function datasourcesFake(_areas: FakeAreaStates): FakeArea<FakeDatasourcesState> {
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
    respond: defaultOutcome,
    grants: {},
    queries: [],
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
      for (const item of items) {
        // Per query: an unseen source is not_found, a seen one without the right forbidden.
        results[item.refId] = !sees(item.datasourceId)
          ? { error: { code: "not_found", message: "no such data source" } }
          : !may(item.datasourceId, "query")
            ? { error: { code: "forbidden", message: "no query right on this data source" } }
            : await answerQuery(state, item, range);
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
      return json(201, publicView(stored));
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
      return may(ds.id, "read") ? json(200, publicView(ds)) : error(403, "forbidden");
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
        state.health[ds.id] ?? { ok: true, message: "PostgreSQL 17.2", latencyMs: 12 },
      );
    }
    if (!may(ds.id, "write")) {
      return error(403, "forbidden");
    }
    if (parts.length === 2 && method === "PATCH") {
      const extra = unknownKey(body, ["name", "settings", "secrets"]);
      if (extra !== undefined) {
        return validation(extra);
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
        return error(403, "forbidden");
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
      return json(200, publicView(ds));
    }
    if (parts.length === 2 && method === "DELETE") {
      ds.deletedAt = Date.now();
      return new Response(null, { status: 204 });
    }
    if (parts[2] === "restore" && method === "POST") {
      if (!inTrash) {
        return error(404, "not_found");
      }
      delete ds.deletedAt;
      return json(200, publicView(ds));
    }
    return undefined;
  }

  return { state, handle };
}
