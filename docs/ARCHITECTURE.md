# Kalzit architecture

How the parts fit together and the contracts every change must keep. `docs/PLAN.md` says what
Kalzit becomes; this file says how the code is shaped. Change it in the same pull request as the
code when a contract changes.

## Layout

| Path | What |
|---|---|
| `server/` | Rust crate `kalzit`: the HTTP server, auth, authorization, data sources, query engine, storage. One binary with the UI embedded. |
| `server/migrations/` | Numbered, portable SQL migrations (SQLite and PostgreSQL). |
| `server/src/shapes.rs` | The result envelope (`frame`, `documents`, `graph`). TypeScript types are generated from it. |
| `server/src/authz.rs` | Permission catalog, built-in roles, the access check. |
| `server/src/routes/` | One module per API area; each exports its route table. |
| `ui/` | React UI. `ui/src/features/<area>/` per area, `ui/src/panels/<type>/` per panel type. |
| `ui/src/api/generated/` | Types generated from the server (`cargo test` writes them, a test fails when they are stale). |
| `website/` | Astro marketing and docs site, independent of the app build. |

## API conventions

- JSON, `camelCase`, ids are UUIDv7 strings, times are Unix milliseconds (`createdAt`).
- Organization-scoped resources live under `/api/orgs/{orgId}/...`. Server-wide administration
  under `/api/admin/...`. The signed-in user under `/api/me`.
- Errors: `{"error": {"code", "message", "field"?}}`. `code` is stable and translated by the UI;
  `message` is English for logs and API clients; `field` names the request field for `validation`.
  Codes: `validation`, `unauthenticated`, `forbidden`, `not_found`, `conflict`,
  `version_conflict`, `rate_limited`, `cross_origin`, `invalid_credentials`, `setup_done`,
  `invalid_setup_token`, `datasource_error`, `query_timeout`, `query_rejected`, `internal`.
- A resource the user may not see answers `not_found`, not `forbidden`, so ids cannot be probed.
  `forbidden` is for resources the user can see but not change.
- Lists: `GET ...?limit=50&cursor=<opaque>` returns `{"items": [...], "nextCursor": string|null}`;
  `limit` at most 200.
- Edits of versioned resources (dashboards, analyses, settings) send the `version` they started
  from; a newer stored version answers `409 version_conflict` with the current version in the body.
- Deleting goes to the trash first (`deletedAt`), restore with `POST .../restore`; purging is a
  separate, confirmed call.

## Routes declare their access

Every route is declared in a route table with its access rule, and the router applies the rule
before the handler runs:

```rust
pub enum Access {
    Public,                 // setup, sign-in, health
    Authenticated,          // any signed-in user (/api/me)
    ServerAdmin,            // /api/admin/...
    Org(Permission),        // /api/orgs/{orgId}/...: member of the org with this permission
}
```

A guard test walks all route tables and fails for a route without a declared `Access`, and for an
`/api/orgs/{orgId}/` route whose access is not `Org(..)`. Resource-level checks (this folder, this
data source) happen in the handler with `authz::check_resource`, after the org-level check.

## Authorization

- **Permission** = action on a resource type: `dashboards:read|write|delete|share`,
  `folders:read|write|permissions`, `datasources:query|read|write|permissions`,
  `analyses:read|write`, `data:export`, `annotations:write`, `teams:read|write|members`,
  `users:read|invite|write`, `roles:read|write`, `serviceaccounts:write`, `audit:read`,
  `plugins:install|configure`, `settings:read|write`, `org:write|delete`.
- **Built-in roles** per organization: `owner` (everything, including `org:delete`), `admin`
  (everything except `org:delete`), `editor` (read and write dashboards, folders, analyses,
  annotations; query and read data sources; export), `viewer` (read dashboards, folders and
  analyses; query the data sources those use).
- **Custom roles** (M1): a named set of permissions per organization.
- **Grants**: a member's org role, plus the roles of their teams, plus resource grants
  (`resource_grants`: subject user/team/role, resource folder/dashboard/datasource, level
  `view|edit|admin` for folders and dashboards, `query|edit|admin` for data sources). Effective
  permission = union. Folder grants inherit to subfolders and dashboards.
- `authz::check(&ctx, permission)` and `authz::check_resource(&ctx, permission, resource)` return
  `Result<(), ApiError>`; `authz::explain(...)` returns the grants that allow it (for the
  "why can I" dialog).
- Guards: the last owner of an org and the last server admin cannot be removed or demoted; nobody
  can grant permissions they do not hold.
- Server admins administer the server (`/api/admin`), they are not automatically members of every
  organization.

## Result envelope (`server/src/shapes.rs`)

Every query returns exactly one shape; nothing is converted implicitly.

```ts
type QueryResult =
  | { shape: "frame"; frame: Frame }
  | { shape: "documents"; documents: DocumentSet }
  | { shape: "graph"; graph: GraphSet };

interface Frame {
  fields: Field[];                 // columnar, all value arrays have the same length
  meta?: { executedQuery?: string; rowsTruncated?: boolean; notices?: Notice[] };
}
interface Field {
  name: string;
  type: "time" | "number" | "int64" | "string" | "bool" | "json";
  unit?: string;                   // "ms", "bytes", "percent", ...
  values: unknown[];               // time: Unix ms; int64: decimal strings (beyond 2^53)
  labels?: Record<string, string>; // series labels (Prometheus)
}
interface DocumentSet {
  documents: Value[];              // typed values, see TypedValue below
  schema: FieldSchema[];           // sampled: path, types with share, coverage share
  nextCursor?: string;
  truncated?: { limit: number };
}
interface GraphSet {
  nodes: { id: string; labels: string[]; properties: Record<string, Value> }[];
  edges: { id: string; type: string; from: string; to: string; properties: Record<string, Value> }[];
  paths?: { nodes: string[]; edges: string[] }[];
  schema: { labels: string[]; edgeTypes: string[]; propertyKeys: Record<string, string[]> };
  truncated?: { limit: number };
}
```

`Value` keeps database types that JSON lacks: `{"$type": "objectId" | "date" | "decimal" |
"binary" | "int64", "value": string}` next to plain JSON. Projections (documents or graph to a
frame) are explicit query steps, stored in the query, never applied by the backend on its own.

## Data sources

- A data source plugin implements one trait (built-ins are compiled in, external plugins in M4
  use the same contract over gRPC):

  ```rust
  #[async_trait::async_trait]
  pub trait DataSourcePlugin: Send + Sync {
      fn kind(&self) -> &'static str;                          // "postgres"
      fn shapes(&self) -> &'static [Shape];                     // what it can return
      fn check_settings(&self, settings: &serde_json::Value) -> Result<(), FieldError>;
      async fn health(&self, conn: &Connection) -> Health;      // "Test connection"
      async fn schema(&self, conn: &Connection) -> Result<SourceSchema, SourceError>;
      async fn query(&self, conn: &Connection, req: QueryRequest) -> Result<QueryResult, SourceError>;
  }
  ```
- **Read-only by default.** SQL sources accept a single `SELECT`/`WITH` statement (parsed with
  `sqlparser`) and run it in a read-only transaction where the database offers one (PostgreSQL,
  MySQL/MariaDB; SQLite opens the file read-only; SQL Server relies on the statement check plus
  the recommended read-only login, shown in the settings form). Rejections answer
  `query_rejected` with the reason.
- **No string interpolation of user input.** Macros (`$__timeFilter(col)`, `$__timeFrom`,
  `$__timeTo`, `$__interval`, `$__interval_ms`) and dashboard variables become bind parameters.
  A variable used as an identifier must match an allow-list from the source's schema.
- Limits per data source with server-wide maxima: timeout (default 30 s), rows/points (default
  100,000), response size; exceeding them answers `query_timeout` or a truncated result with
  `meta.rowsTruncated`.
- Connections are pooled per data source and rebuilt when its settings change.
- **Secrets** (passwords, tokens, client keys) are stored encrypted (AES-256-GCM) in
  `datasource_secrets`; the key comes from `KALZIT_SECRETS_KEY` or `secrets.key` in the data
  directory (created on first start, mode 0600; on Windows protected with DPAPI). The API never
  returns a secret, only `"set": true`; sending an empty value keeps it, `null` removes it.
- Query API: `POST /api/orgs/{orgId}/query` with
  `{"queries": [{"refId", "datasourceId", "query"}], "timeRange": {"from", "to"},
  "intervalMs", "maxDataPoints", "variables"}`; answers
  `{"results": {"<refId>": {"result": QueryResult} | {"error": {"code", "message"}}}}`. Queries
  run in parallel with a per-user concurrency limit and are cancelled when the client goes away.

## Dashboards

- Tables `folders` (nested, `parent_id`), `dashboards` (folder, title, current version, trash),
  `dashboard_versions` (every save, with author and message; restore creates a new version).
- The dashboard model is JSON with `schemaVersion`; the server migrates older models on read, one
  step per version, with a test per step.

  ```ts
  interface DashboardModel {
    schemaVersion: 1;
    title: string;
    timeRange: { from: string; to: string };   // "now-6h", "now", or ISO times
    refreshSeconds?: number;
    variables: Variable[];
    panels: {
      id: string; type: string; title: string;
      grid: { x: number; y: number; w: number; h: number };   // 24 columns
      targets: { refId: string; datasourceId: string; query: unknown }[];
      transformations: unknown[]; options: unknown; fieldConfig: unknown;
    }[];
  }
  ```
- Panels declare the shapes they accept; the panel picker offers matching panels first.

## Settings and audit

- `server_settings` (key, JSON value, version, updated_by, updated_at). A registry in code lists
  every setting with type, default, validation and whether it may be changed in the UI. Effective
  value = environment > file > database > default; `GET /api/admin/settings` reports value and
  source, and settings from the environment or file are read-only in the UI.
- `audit_events` (org or server scope, actor user and address, action, resource, short JSON
  summary without secrets, time), written in the same transaction as the change.

## Migrations

Numbered and never edited after release (`engineering/data-and-apis.md`). Reserved numbers for
M1 so parallel work does not collide:

| Number | Content |
|---|---|
| 0002 | teams, team members, custom roles, role permissions, resource grants |
| 0003 | server settings, audit events |
| 0004 | data sources, data source secrets |
| 0005 | folders, dashboards, dashboard versions |

## UI structure

- `ui/src/features/<area>/` (`admin`, `datasources`, `dashboards`, `explore`) own their routes
  (exported as a route list the router includes), queries and components.
- `ui/src/panels/<type>/` export `{ type, shapes, Editor, Panel }`; a registry lists them.
- Translations: one catalog file per area and language under `ui/src/i18n/<lang>/<area>.json`,
  combined in `ui/src/i18n/catalogs.ts`; keys are prefixed with the area (`admin.users.title`).
- Generated API types live in `ui/src/api/generated/`; hand-written API calls per area in
  `ui/src/features/<area>/api.ts`, all through `ui/src/api/client.ts`.

## Testing contracts

- Server: unit tests per module; API tests through the router (SQLite, and PostgreSQL in CI);
  data source tests against real databases in CI service containers (`KALZIT_TEST_<SOURCE>_URL`),
  skipped with a printed notice when the variable is not set.
- UI: Vitest per feature; guard tests for design, i18n and route access; generated types current.
- E2E: Playwright against the production build of the binary, on Linux and Windows.
