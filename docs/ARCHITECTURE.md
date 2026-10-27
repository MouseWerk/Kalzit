# Kalzit architecture

How the parts fit together and the contracts every change must keep. `docs/PLAN.md` says what
Kalzit becomes; this file says how the code is shaped. Change it in the same pull request as the
code when a contract changes. Items marked (M2), (M4) and so on are planned for that milestone;
everything else is M1.

## Layout

| Path | What |
|---|---|
| `server/` | Rust crate `kalzit`: HTTP server, auth, authorization, data sources, query engine, storage. One binary with the UI embedded. |
| `server/migrations/` | Numbered, portable SQL migrations (SQLite and PostgreSQL). |
| `server/src/shapes.rs` | Result envelope and API wire types; the UI's TypeScript types are generated from it. |
| `server/src/authz.rs` | Permission catalog, built-in roles, access and resource checks. |
| `server/src/analysis/`, `ui/src/analysis/` | Analysis steps, expression language and export; the same engine on both sides. |
| `server/src/saved_analyses.rs` | Saved analyses: the versioned model, its checks and dashboard links (routes in `routes/analyses.rs`, docs/api/analyses.md). |
| `server/src/audit.rs` | The audit log (`audit::record`). |
| `server/src/ai/` | AI: the provider interface with the OpenAI-compatible and Anthropic clients, stored providers and keys, limits, usage and audit (see "AI"; routes in `routes/ai.rs`, docs/api/ai.md). |
| `server/src/routes/` | One module per API area, each exporting its route table; `table.rs` enforces access. |
| `server/src/updates/`, `release/` | Updates: signed releases, staging, installation, trial and return; the release format and the signing tool `kalzit-sign` (see "Updates"). |
| `ui/` | React UI: `ui/src/features/<area>/` per area, `ui/src/panels/<type>/` per panel type. |
| `ui/src/api/generated/` | Types generated from the server; a test fails when they are stale. |

The website lives in its own private repository, `MouseWerk/kalzit-website`.

## API conventions

- JSON, `camelCase`, ids are UUIDv7 strings, times are Unix milliseconds (`createdAt`).
- Organization-scoped resources live under `/api/orgs/{orgId}/...`, server administration under
  `/api/admin/...`, the signed-in user under `/api/me`.
- Errors: `{"error": {"code", "message", "field"?}}` (`ErrorEnvelope`). `code` is stable and
  translated by the UI; `message` is English for logs and API clients; `field` names the request
  field of a `validation` error. The list lives in `error::ERROR_CODES`; the UI's `ErrorCode`
  type is generated from it and every code has a translation (tested). Codes: `validation`, `unauthenticated`, `forbidden`,
  `not_found`, `method_not_allowed`, `payload_too_large`, `conflict`, `version_conflict`,
  `rate_limited`, `cross_origin`, `invalid_credentials`, `setup_done`, `invalid_setup_token`,
  `datasource_error`, `datasource_target_blocked`, `query_timeout`, `query_rejected`, `busy`, `internal`.
  `busy` (503, with `Retry-After`) means the database could not give the request its lock in time
  (SQLite `SQLITE_BUSY`; PostgreSQL serialization failure, lock timeout or deadlock, the last also
  logged as a lock-order bug). Handlers read everything their reply needs inside the transaction,
  before the commit, so `busy` only ever comes before anything was committed: nothing was changed
  and the request may be sent again. An error after a commit, an exhausted connection pool and
  `SQLITE_LOCKED` answer `internal`.
- A resource the caller may not see answers `not_found`, so ids cannot be probed: other
  organizations, and restricted folders (and their dashboards) the caller has no grant for. `forbidden`
  is for what the caller can see but not do. `/api/admin` answers `forbidden` to signed-in
  non-admins: that the admin area exists is no secret.
- Lists answer `Page<T>`: `{"items": [...], "nextCursor": string | null}`. `?limit=` defaults to
  50; above 200 is a `validation` error. Order is stable, newest first unless the route says
  otherwise; the cursor is opaque.
- Versioned resources (dashboards, analyses, settings) carry `version` in the body. An update
  sends the `version` it started from; if the stored one is newer the answer is
  `409 version_conflict` with `{"error": {...}, "current": <the stored resource>}`.
- Deleting moves to the trash (`deletedAt`), `POST .../restore` brings it back, purging is a
  separate confirmed call.
- Sessions: the cookie is `kalzit_session` (`HttpOnly`, `SameSite=Lax`, `Path=/`). When the
  request is HTTPS (directly or at a trusted proxy), it is `__Host-kalzit_session` with `Secure`,
  and only that name is read, so a cookie planted over HTTP
  or by a sibling subdomain is ignored. Sign-in, failed sign-in and sign-out are audited.
- Sign-in rate limit: per email and per client address, IPv4 per address and IPv6 per /64. When
  the table is full, address entries are dropped before account entries.
- **Every query on an organization table filters by `ctx.org_id`.** Ids in the path or body
  (`datasourceId`, folder or dashboard ids) are resolved within the organization first; an id of
  another organization is `not_found`.

## Routes declare their access

Every API route is declared in a route table with its method, path and access rule; the router
applies the rule before the handler (and before the body is read):

```rust
pub enum Access {
    Public,             // listed in the guard test: setup, sign-in, sign-out
    Authenticated,      // listed in the guard test: /me
    ServerAdmin,        // every /admin/... route
    OrgMember,          // every /orgs/{orgId}/... route: member of that organization
    Org(Permission),    // ... and holds this permission
}
// route(Method::GET, "/orgs/{orgId}/teams", Access::Org(Permission::TeamsRead), get(list_teams))
```

Guards that keep this airtight:

- The guard test derives the rule from the path: `/orgs/...` must be `Org`/`OrgMember` with the
  second segment exactly `{orgId}`, `/admin/...` must be `ServerAdmin`, and `Public` or
  `Authenticated` routes must be on the reviewed lists in the test.
- An API test calls every declared organization and admin route without a session (401), as a
  member of another organization (404) and as a non-admin (403).
- Clippy forbids `Router::route`, `route_service`, `nest`, `nest_service`, `merge` and
  `fallback_service` outside the router assembly
  (`clippy.toml`), so a route cannot be added past the tables.
- `orgId` must be a canonical UUID (lowercase, hyphenated); anything else is `not_found` without
  a lookup.
- Single resources: after the org-level rule, handlers call
  `authz::check_resource(&db, &ctx, permission, Resource::Folder(id))` (also `Dashboard`,
  `Datasource`).

## Authorization

- **Permission** = action on a resource type: `dashboards:read|write|delete|share`,
  `folders:read|write|permissions`, `datasources:query|read|write|permissions`,
  `analyses:read|write`, `data:export`, `annotations:write`, `teams:read|write|members`,
  `users:read|invite|write`, `roles:read|write`, `serviceaccounts:write`, `audit:read`,
  `plugins:configure`, `settings:read|write`, `org:write|delete`. Installing plugins is a server
  action for server admins (M4), not an organization permission.
- **Built-in roles** (pinned by a test, so a new permission is granted only by an explicit edit):
  - `viewer`: `dashboards:read`, `folders:read`, `analyses:read`, `teams:read`. Viewers do not
    run their own queries; the panel query route runs the stored queries of a dashboard they may
    read.
  - `editor`: viewer plus `dashboards:write|delete|share`, `folders:write`,
    `datasources:query|read`, `analyses:write`, `data:export`, `annotations:write`, `users:read`.
    `dashboards:share` means granting access to users and teams of the same organization;
    public links for people without an account are a separate permission (M6), by default only
    for admins.
  - `admin`: everything except `org:delete`. `owner`: everything.
- **Custom roles**: a named set of permissions per organization.
- **Restricted folders**: a folder can be marked restricted. The nearest restricted folder at or
  above a folder or dashboard governs it: only grants (directly, through a team or a role) on that
  folder or below it count, so a restricted subfolder narrows access and grants above it do not
  reach in; a grant on a dashboard opens that dashboard alone. Org-wide permissions apply inside
  only for members holding `folders:permissions` (admins and owners). For everyone else such
  folders and dashboards do not exist (`not_found`), lists, search and the organization's audit
  view leave them out, and changes of a whole subtree that contains them (trash, restore, purge,
  move) are `forbidden`. Unrestricted folders follow the role defaults. Grants can extend a
  member's rights on any folder, dashboard or data source. `authz::check_resource` decides single
  resources (with `folders::folder_chain`); lists filter in SQL with `folders::VISIBILITY_CTE`,
  which applies the same rule and is tested against `check_resource`.
- **Grants**: a member's org role, plus the roles of their teams, plus resource grants
  (`resource_grants`: subject user/team/role, resource folder/dashboard/analysis/datasource, level
  `view|edit|admin` for folders, dashboards and saved analyses, `query|edit|admin` for data
  sources). Effective permission = union. Folder grants inherit to subfolders, dashboards and
  saved analyses. `resource_grants` has no foreign keys (it points at four tables); purging a
  resource deletes its grants in the same transaction.
- **Saved analyses** follow the dashboards' rules in every respect (folders, restricted folders,
  team spaces, team ownership, grants; `Resource::Analysis`), with `analyses:read|write` in place
  of the dashboard permissions and `dashboards:share` for sharing. Reading an analysis authorizes
  running its stored queries, as reading a dashboard does; saving checks `datasources:query` on
  new or changed queries. A dashboard panel may link one (`analysisId`); its queries then count as
  the dashboard's own (docs/api/analyses.md).
- `ctx.check(permission)`; `authz::check_resource(&db, &ctx, permission, resource)` answers
  `not_found` when the caller cannot see the resource and `forbidden` when they see it but may not
  do this; `authz::explain(&ctx, permission, Option<Resource>)` lists the grants that allow it
  (the "why can I" dialog).
- Administration in the UI is shown to server admins and to members holding an admin-level
  permission (`users:write`, `settings:read`, `roles:write`, `audit:read`); editors do not see it,
  although they may read the user list to share dashboards.
- The last owner of an organization and the last server admin cannot be removed or demoted;
  nobody can grant permissions they do not hold.
- Server admins administer the server, they are not automatically members of every organization.

## Result envelope and wire types (`server/src/shapes.rs`)

Every query returns exactly one shape; nothing is converted implicitly. The generated
`ui/src/api/generated/shapes.ts` is the reference; in short:

```ts
type QueryResult =
  | { shape: "frame"; frame: Frame }            // columnar fields of equal length
  | { shape: "documents"; documents: DocumentSet }
  | { shape: "graph"; graph: GraphSet };
```

- Frame field types: `time` (Unix ms), `number`, `int64` (always decimal strings), `string`,
  `bool`, `json`; a missing value is `null`. Frames are built through `Frame::new`, which checks
  equal lengths.
- Documents keep database types JSON lacks as `{"$type": "objectId" | "date" | "decimal" |
  "binary" | "int64" | "uuid" | ..., "value": string}` (all of them, and binary values hidden as
  `null`, in docs/api/datasources.md, "The documents shape"). The schema sample gives every path
  with coverage and type shares (finite numbers 0 to 1); every document source samples through
  one shared walker (`datasources/document_schema.rs`) with its own type names, and cut sets
  carry `documents.*` notices like frames.
- Graphs keep nodes, edges, paths and the label/edge-type/property schema.
- Projections (documents or graph to a frame) are explicit steps stored with the panel in its
  `transformations` (`{"id", "type": "toFrame", "frame": "<refId>", "columns", "disabled"?}`,
  docs/api/settings-dashboards.md), not in the query, which keeps the source's own form. They are
  never applied by the backend on its own.
- Query API: `POST /api/orgs/{orgId}/query` (`QueryRequest`, needs `datasources:query`) and
  `POST /api/orgs/{orgId}/dashboards/{dashboardId}/panels/{panelId}/query`
  (`PanelQueryRequest`, runs the panel's stored queries, needs `dashboards:read` on that
  dashboard). Because stored queries run with the viewer's rights, **saving a dashboard checks
  `datasources:query` on every data source its new or changed panel and variable queries use**,
  so an editor cannot reach a data source through a panel they could not query directly. The
  right is checked when a query is saved, not when it runs: an editor who later loses access
  leaves working dashboards behind, and removing the query from the dashboard is how to stop it. Query-type dashboard
  variables run the same way through
  `POST /api/orgs/{orgId}/dashboards/{dashboardId}/variables/{name}/options`
  (`VariableOptionsRequest`, answers `VariableOptionsResponse`). The panel route answers
  `QueryResponse`: per `refId` either `{result}` or `{error}`. Free queries, health and schema
  are checked per data source (role or grant) on every request. Reading the dashboard is what
  authorizes its stored queries: the caller needs no data source permission, but only data
  sources the stored model references (and that exist in the organization) are run. Queries run
  in parallel with per-user and server-wide concurrency limits and are cancelled when the client
  goes away.
  `QueryItem.cursor`/`limit` page through a `DocumentSet` (M2).

## Data sources

- A data source plugin implements one trait (built-ins are compiled in; external plugins (M4) use
  the same contract over gRPC):

  ```rust
  #[async_trait::async_trait]
  pub trait DataSourcePlugin: Send + Sync {
      fn kind(&self) -> &'static str;                          // "postgres"
      fn shapes(&self) -> &'static [Shape];
      fn check_settings(&self, settings: &serde_json::Value) -> Result<(), FieldError>;
      async fn health(&self, conn: &Connection) -> Health;      // "Test connection"
      async fn schema(&self, conn: &Connection) -> Result<SourceSchema, SourceError>;
      async fn query(&self, conn: &Connection, req: SourceQuery) -> Result<QueryResult, SourceError>;
  }
  ```
- **Targets.** Data sources may point at hosts in private networks and on localhost (self-hosting
  means databases in the own network). Always refused, answering `datasource_target_blocked`:
  Kalzit's own data directory and database (also through a PostgreSQL source at the same server
  and database), link-local and cloud metadata addresses (`169.254.0.0/16`, `fe80::/10`,
  `100.100.100.200`, `168.63.129.16`, `192.0.0.192`, `fd00:ec2::254`, `fd20:ce::254`, in every
  IPv6 form that carries them), and SQLite files outside the directories a server admin allowed
  (`datasources.sqlite_dirs`, empty by default, never including the data directory); CSV and
  JSON files of file sources follow the same rules within `datasources.file_dirs`. A server
  admin can additionally restrict sources to a list of allowed hosts and networks
  (`datasources.allowed_targets`). Rules that make this hold:
  - Names are resolved once per connect, the resolved address is checked, and the driver connects
    to that address (the name is kept only for TLS server name checks), so DNS rebinding cannot
    swap the target.
  - Every HTTP-based source uses the one HTTP client factory (proxy, certificates, timeouts, target
    check on every redirect); a guard test fails if a source builds its own client.
  - "Kalzit's own PostgreSQL" is detected after connecting by comparing
    `pg_control_system().system_identifier` and `current_database()` with Kalzit's own connection,
    not by host name (aliases such as `localhost`, `::1` or a container name).
  - SQLite paths are canonicalized (symlinks and junctions resolved) before the directory check.
  - MySQL/MariaDB clients run with `local_infile` disabled, so a hostile server cannot ask Kalzit
    to send local files; a test covers it.
- **Read-only.** The real defence is a read-only, least-privilege database login; the settings
  form says so for every engine. On top of it, SQL sources accept one `SELECT`/`WITH` statement
  (parsed with `sqlparser`) and reject `INTO` (`INTO OUTFILE`, `SELECT ... INTO table`), locking
  clauses (`FOR UPDATE/SHARE`) and file or network functions (`LOAD_FILE`, `pg_read_file`,
  `lo_import`, `dblink`, `OPENROWSET`, `OPENDATASOURCE`, `load_extension`). They run in a
  read-only transaction where the engine has one (PostgreSQL, MySQL/MariaDB); SQLite opens the
  file read-only with extension loading disabled. Each engine has tests for these rejections.
  Rejections answer `query_rejected` with the reason. Elasticsearch and OpenSearch sources reach
  only a fixed list of read endpoints (checked on every URL before it is sent) and refuse stored
  scripts and scripts that use `ctx`; HTTP JSON sources send only GET requests below their URL.
  Rejections answer `query_rejected` with the reason. Graph sources (`neo4j`, `memgraph` over
  Bolt with Kalzit's own client in `bolt.rs`; `tigergraph` over HTTP) answer `graph`: Cypher is
  checked on its tokens and runs in a read transaction, Memgraph and TigerGraph users that may
  write are refused, and GSQL is parsed and refused when it writes or does not parse
  (docs/api/datasources.md).
- **No string interpolation of user input.** Macros (`$__timeFilter(col)`, `$__timeFrom`,
  `$__timeTo`, `$__interval`, `$__interval_ms`) and variables become bind parameters. A variable
  used as an identifier must match an allow-list from the source's schema.
- **Limits** per data source within server-wide maxima: timeout (default 30 s), rows/points
  (default 100,000), response size; exceeding them answers `query_timeout` or a truncated result
  with `meta.rowsTruncated`.
  - Reading stops on the source once the row limit is reached: PostgreSQL reads through a cursor
    (`DECLARE ... NO SCROLL CURSOR`, `FETCH` of at most the limit plus one row per round trip,
    planned for all rows with `cursor_tuple_fraction = 1.0`, each `FETCH` limited by
    `statement_timeout` to the time the query has left),
    MySQL/MariaDB and SQL Server close the connection of a cut result, so the server stops the
    statement instead of sending the rest, and SQLite stops stepping the statement.
  - The response size budget (`datasources.max_response_bytes`, default 128 MiB per request;
    `datasources.max_inflight_bytes`, 1 GiB for all requests) is a memory budget: it counts what
    a result holds in memory, not only its JSON text: 32
    bytes for every value (also nulls and numbers), the text of strings (their capacity, at least
    their JSON form), and the keys and entries of documents, graph properties and nested values
    (`frame::value_size`).
- Connections are pooled per data source and rebuilt when its settings change. The pool is built
  once per data source: parallel first queries (a dashboard opening with a cold cache) wait for
  the same build instead of each opening a pool and logging in. A connection nobody holds closes
  its SQLite file when dropped (also one whose entry was forgotten while it was built), and a
  build that finishes after the server began to stop is closed instead of used.
- **Secrets** (passwords, tokens, client keys) never live in plain settings: settings with a URL
  or DSN reject embedded credentials, which go into dedicated secret fields.
  - Stored in `datasource_secrets`, encrypted with AES-256-GCM, a random 96-bit nonce per
    encryption, and the data source id plus field name as associated data, so a blob cannot be
    moved to another source or field. Each blob records the id of the key that encrypted it.
  - The key (32 random bytes): `KALZIT_SECRETS_KEY` (base64) if set; on Linux systemd credentials
    (`$CREDENTIALS_DIRECTORY/kalzit-secrets-key`); on Windows a key file protected with DPAPI in
    machine scope; otherwise `secrets.key` in the data directory with mode 0600 and a warning in
    the log. Backups of the database need the key; without it secrets are unrecoverable and must
    be entered again.
  - `kalzit secrets rotate` re-encrypts every blob with a new key.
  - Settings fields that decide where secrets are sent (host, port, database, user, TLS checks,
    URL, path) are marked `target` in the kind's settings schema. A change to one requires every
    stored secret to be sent again (or removed) in the same change, so a secret is never
    redirected to a new target.
  - API patch semantics for a secret field: omitted = keep, `null` = remove, string = set. The API
    never returns a secret, only `{"set": true}`.
  - Errors from sources (`datasource_error`), "Test connection" output and audit summaries are
    scrubbed of credentials before they leave the server.
- **Live updates** (docs/api/live.md): a WebSocket per browser tab (`routes::live`) carries
  subscriptions to a panel's stored queries or to free queries, authorized like their REST routes
  on subscribe and again every 30 seconds. Equal subscriptions share one feed (`live`), a task
  that runs the queries through `run_queries_with` (all query limits apply, with the
  organization's live slot pool `live:{orgId}`) and makes the result message once for every
  connection; held results count against a live memory budget. A kind reports changes through
  the optional `DataSourcePlugin::watch` (MongoDB: change streams with resume tokens, on their own
  client and pool, at most 8 per source); without one, or for a moving range, the feed polls. Slow clients are dropped instead of buffered; a stopping server
  closes every connection with a reason.

## Dashboards

- Tables `folders` (nested, `parent_id`), `dashboards` (folder, title, current version, trash),
  `dashboard_versions` (every save, with author and message; restore creates a new version).
- The dashboard model is JSON with `schemaVersion`; the server migrates older models on read, one
  step per version, with a test per step.

  ```ts
  interface DashboardModel {
    schemaVersion: 2;
    title: string;
    timeRange: { from: string; to: string };   // "now-6h", "now-1fy/fy", "now", or ISO times
    refreshSeconds?: number;
    // Time options, each optional: zone, week start, fiscal year start, now delay, refresh
    // intervals and the shared cursor (docs/api/settings-dashboards.md).
    variables: Variable[];
    panels: {
      id: string; type: string; title: string;
      grid: { x: number; y: number; w: number; h: number };   // 24 columns
      targets: { refId: string; datasourceId: string; query: unknown }[];
      transformations: Step[];   // analysis steps, see "Analysis steps and export"
      options: unknown; fieldConfig: unknown;
    }[];
  }
  ```
- Model version 2 adds tags, rows, repeats, annotation queries, dashboard and panel links, panel
  time options, multi-value variables and library panel references; annotations, playlists and
  library panels are their own resources (docs/api/dashboard-features.md). Library panels follow
  their folder's rights; a dashboard that shows one authorizes its queries for its readers.
- Panels declare the shapes they accept; the panel picker offers matching panels first.
- A panel's `options` belong to its type; `fieldConfig` holds the shared field options
  (`{defaults, overrides}`: unit, decimals, min and max, thresholds, value mappings, no-value
  text, display name, color, table cell display, link, width). `null` in an override clears what
  the defaults set. Regex matchers and mappings use RE2 syntax (no backreferences or
  lookaround): the UI runs them with re2js in linear time, the server checks them with the
  `regex` crate.
- `dashboards::panel_options` checks the options and field options of the built-in frame and
  document and graph panel types (network, hierarchy, path) on create, save and restore of
  dashboards and on create and save of library panels (which keep no versions), and only for
  panels the write adds or changes, so stored dashboards and library panels keep loading,
  querying and saving unchanged when a rule tightens. Reads never run it. The document explorer
  and the schema panel take no options; the distribution's `path` and the card's `titlePath` are
  field paths of up to 500 characters without control characters. A new panel type (plugins)
  adds its own check there
  when it lands, and its default and editor options to the contract fixture
  (`ui/src/panels/contract.test.ts`); unknown types are left alone.
- Series names (`distinctSeriesNames`, `ui/src/panels/frame.ts`): a series is named by its display
  name, else its name template, else its field name with labels. Without a display name or
  template, series with labels are named by the label values that differ between them in the
  current result (after the metric name), and names that are still equal get their query's
  reference id ("amount (A)"), else a number. These automatic names depend on the result: when a
  series appears or disappears, the labels that differ and so the names can change. A display
  name or a name template fixes them. The reference id travels beside the bare frames panels get
  (`nameFrame`, a weak map filled by `runPanelSteps`), so the panel props stay one frame list.
- State words (state timeline and status history, `stateTone` in
  `ui/src/panels/state/stateData.ts`): a value's color comes, in this order, from a value
  mapping, the thresholds, the field's color, a known state word, and else the palette. Only the
  whole value counts ("down", not "Down Under" or "up-to-date"), in any case. Good: ok, up,
  healthy, success, passed, gesund, erfolgreich, bestanden. Warning: warning, degraded, pending,
  Warnung, eingeschränkt, ausstehend. Danger: down, error, failed, failure, critical, offline,
  Fehler, fehlgeschlagen, ausgefallen, kritisch. Neutral: unknown, unbekannt. The panel option
  `colorStateWords` (on by default) switches it off.

## Analysis steps and export

- A panel's `transformations` are analysis steps (docs/api/settings-dashboards.md, "Analysis
  steps"): `{id, type, disabled?, ...}`, ordered, each reading results by `refId`. Types:
  `toFrame` (projection of documents), `calculate` (expression language, parsed and type-checked,
  never evaluated as code), `join` (two queries by time or key, fields named `<refId>.<field>`),
  `reduce`, `trend`, `movingAverage`, `correlate`, `compare`, `group`, `pivot`.
- **The projection lives in the panel's `transformations`**, as a `toFrame` step, not in the
  query (PLAN section 1 said "in der Abfrage"; decided otherwise, PLAN section 13): the query stays
  in the data source's own form, the projection is visible, can be turned off, and steps after it
  work on its frame.
- Two engines with one behaviour: `ui/src/analysis/` runs the steps for what the browser shows;
  `server/src/analysis/` runs them for exports, so a file holds what the panel shows and the
  permission check stays on the server. Both pass `server/src/analysis/conformance.json`; numbers
  are written as JavaScript writes them and calendar functions work in UTC in both.
- Saving a dashboard checks the steps' form and bounds and parses expressions; fields and types are
  checked when a step runs. Steps run on results in memory, bounded by the row limit; pushdown of
  grouping into the database comes later.
- Export: `POST /api/orgs/{orgId}/export` and
  `POST /api/orgs/{orgId}/dashboards/{dashboardId}/panels/{panelId}/export`, both
  `Access::Org(Permission::DataExport)` plus the rights of running the queries (free:
  `datasources:query` per source; panel: `dashboards:read`). CSV, Excel (`rust_xlsxwriter`) and
  JSON; written to the audit log as `data.exported` (refused ones as `data.export_refused`, ones
  whose download does not complete as `data.export_aborted`). The file is made into a spool file
  (`<data dir>/export-tmp`, Excel in constant memory mode) and then sent from disk by a task of its
  own through a bounded channel of 1 MiB chunks, with a stall time of 60 s and a total of 15
  minutes. At most 3 exports make files at once per server and a user has one at a time; their
  steps and encoder run in `spawn_blocking` and stop on a cancel flag (a drop guard in the
  handler) and the query timeout. Both engines
  share the bounds: expression trees at most 128 high, text at most 32,767 UTF-16 units per cell
  and 64 Mi units per run, at most 5,000,000 cells per step.

## Settings and audit

- `server_settings` (key, JSON value, version, updated_by, updated_at) and `org_settings` (org
  id, key, ...). `settings::REGISTRY` lists every setting with scope (server or organization),
  default and whether the UI may change it; read with `settings::get(&state, key)` /
  `settings::get_org(&state, org_id, key)`. The foundation ships the registry and both functions
  answering defaults; stream B adds the layers and tables behind the same signatures. Effective server value =
  environment > file > database > default; `GET /api/admin/settings` reports value and source,
  and settings from the environment or file are read-only in the UI. Settings that live in the
  configuration use `KALZIT_<SECTION>_<KEY>`; all other server settings can be set with
  `KALZIT_SETTING_<KEY>` (key in upper snake case), checked at start (`settings::check_environment`).
  `Config::file_keys` records what `kalzit.toml` set, for the `file` source. The server deletes
  audit events past their retention every hour (`routes::audit::spawn_retention`).
- Network, TLS, proxy, security and log values of the configuration are registry entries too
  (`ui_editable: false`, read from `Config`), so the settings page shows them read-only with
  their source. A key may exist in both scopes: the organization entries of `appearance.*` start
  as `inherit` and follow the server's value (`GET /api/orgs/{orgId}/appearance` merges them).
- Customization goes through vetted options only, never custom CSS: accent names the tokens
  define per scheme, or a `#rrggbb` that passes the contrast rules of `appearance.rs` (mirrored in
  `ui/src/appearance/contrast.ts`), density, font size and texts. The UI applies them as data
  attributes on `<html>` that the tokens read; a custom accent is one custom property set through
  the CSSOM, so the CSP stays `style-src 'self'`. The logo is stored in the database (raster
  formats only, at most 256 KiB) and served same-origin at `GET /api/branding/logo`; `GET
  /api/branding` is public, as the sign-in page shows it. The logo before the last upload or
  removal is kept as a second row, which undo swaps back.
- Settings export as JSON (only what the caller may change), import through a preview and a batch
  that applies every change or none in one transaction (docs/api/settings-dashboards.md).
- `audit_events`: written with `audit::record(&mut tx, &AuditEvent { .. })` inside the
  transaction of the change. Actions are `<area>.<verb>` (`setup.completed`, `auth.signed_in`,
  `auth.sign_in_failed`, `team.created`). Summaries hold ids and changed field names, never
  secrets and never what a user typed (a failed sign-in records the account id if it exists, not
  the email). Events older than `audit.retention_days` (default 365) are deleted (stream B),
  since they hold client addresses: 5,000 per transaction, so a large backlog never holds the
  write lock for long.
- A settings reset keeps the row as a marker (value `null`) with the next version, so versions
  only ever count up and a write from before the reset is a `version_conflict`.
- A database that a newer Kalzit migrated is refused at start with a message that says so and
  names the backups in `updates/backups`, before the migrator runs.
- The audit list query carries only the filters that are set, and pages by the row value
  `(created_at, id)`, so it runs on the indexes `audit_events_org_time_id` and
  `audit_events_org_resource` (migration 0015) without a sort; a test checks the plan with
  `EXPLAIN QUERY PLAN` on SQLite.

## AI

Built-in AI (M4; owner decisions in docs/PLAN.md, section 12, API in docs/api/ai.md). This
section is the core every AI function builds on; the functions themselves (explain or draft a
query, summarize a result, the agent chat) come after it and must go through it.

- **Off by default, one switch.** `ai.enabled` (server setting, default `false`) gates every AI
  call (`409 ai_unavailable`, `ai.disabled`). `GET /api/orgs/{orgId}/ai/status` tells the UI
  whether AI is usable (on and a provider in effect). Off, it answers only
  `{"enabled": false, "usable": false}`. Every AI element in the UI sits inside `AiGate`
  (`ui/src/features/ai`), which renders nothing unless the status says usable, so without a
  connected provider there is no AI button, menu entry, placeholder or hint.
- **One provider interface** (`server/src/ai/mod.rs`, trait `Provider`): a `ChatRequest`
  (system text, messages of text, tool calls and tool results, tool definitions as JSON Schema,
  max tokens, temperature) becomes a stream of `ChatEvent`s: text deltas, complete tool calls,
  token usage, the end with its stop reason. `ai::complete` collects a whole answer. Two clients:
  `openai` (chat completions, for OpenAI, LiteLLM, Ollama and other compatible servers; reads
  a streamed or a whole JSON answer) and `anthropic` (Messages API, `anthropic-version`
  2023-06-01). Server-sent events are parsed by `ai::sse`. Model ids are configuration only;
  the code names none.
- **Transport.** Every request uses the one HTTP client factory (`crate::http`), so the base URL
  passes the data source target policy on every connection (private networks and localhost
  allowed, link-local and metadata addresses refused, `datasources.allowed_targets` applied),
  plus a check that refuses Kalzit's own addresses. Requests are sent with `send_once`: no
  redirects, so the key reaches exactly the configured URL. Retries with backoff (0.5 s, 1 s,
  jitter, at most 3 attempts, `Retry-After` up to 10 s) on passing failures before anything
  of the answer arrived; one time limit for the whole call (`ai.request_timeout_secs`); a
  `CancellationToken` stops a call at once, and dropping its stream cancels it. Answers are
  capped at 16 MiB. The last connection test of a provider is kept on it (`lastTest`).
- **Configuration.** `ai_providers` (migration 0019): server-wide rows (`org_id` NULL) and an
  organization's own rows, which override the server's for its members. One default per scope.
  Keys live in `ai_provider_secrets`, encrypted with the secrets key like data source secrets
  (associated data `ai-provider:<id>` and the field, so a blob cannot pass as a data source's);
  `kalzit secrets rotate` re-encrypts them. Keys are write-only in the API, scrubbed from every
  error, and never logged or audited. A changed base URL needs the key sent again.
- **Rights.** Server providers and usage: server administrators. An organization's providers:
  `settings:write` (`settings:read` to list). The status: every member. AI acts only with the
  signed-in user's rights and only reads: a function that reads data runs the query as the user
  through the normal query path (read-only rules, grants, limits), never with a service identity.
- **What data leaves the server.** Only what a function puts into its prompt, sent only to the
  provider in effect, and only through `ai::redact`, the one helper every feature uses for data
  of a source. A source is closed to AI until someone who may edit it opens it
  (`ai_datasource_access.readable`, `PUT .../datasources/{id}/ai-access`, `datasources:write`):
  closed, explain and draft send only the query text the user typed (`schema_for_model` answers
  `None`) and summarize and the chat refuse it (`result_for_model`, `ai.datasource_not_readable`).
  Open, its schema and results go in, with the values of its excluded fields
  (`excluded_fields`, "Felder ausnehmen") replaced by `[excluded]` (names stay) and results cut
  to `ai.max_rows_to_model`. Matching of excluded fields is broad on purpose (dotted suffixes in
  both directions, any case), since results do not always name their table. Secrets, connection
  settings and Kalzit's own data never go into a prompt. A local provider (Ollama) keeps
  everything on the network of the installation.
- **First-use notice.** Before a person's first call through a provider the UI shows what leaves
  the server and to which host (`provider.host` of the status); the acknowledgement is stored per
  person and provider (`ai_notice_acks`), and `ai::service` refuses calls without it
  (`ai.notice_required`). A new provider asks again.
- **Limits.** Per person and day (UTC) in an organization: calls and tokens
  (`ai.user_requests_per_day`, `ai.user_tokens_per_day`); per organization and calendar month:
  tokens (`ai.org_tokens_per_month`); 0 is no limit. An organization may lower each of them and
  the chat retention in its own settings (`inherit` by default; the stricter value applies), and
  turn AI off for its members (`ai.org_enabled`). `ai.allow_org_providers` decides whether its own
  providers are allowed and used. At once: on the server (`ai.max_concurrent`) and per user
  (`ai.max_concurrent_per_user`), held in memory (`ai::service::AiRuntime`) and given back when a
  call ends or its stream is dropped. Counters are `ai_usage` rows per day, organization and
  user: a call counts when it starts (so calls at once cannot all pass a limit), its tokens when
  it ends. Refusals are `429 rate_limited` with `Retry-After`. Usage is shown in tokens and calls,
  never in money.
- **Audit.** Every call writes `ai.called` (purpose, provider kind and scope, model, input and
  output tokens, outcome `ok`, `failed` with its reason, or `cancelled`), never the prompt or the
  answer. Configuration writes `ai.provider_created|updated|deleted|tested`,
  `ai.notice_acknowledged` and `datasource.ai_access_changed` (with the number of excluded fields,
  not their names).
- **Privacy.** Chats (with the chat package) are stored per user and deleted
  `ai.chat_retention_days` (default 30, 0 keeps none; an organization may only shorten it,
  `ai::service::chat_retention_days`) after their last message; nobody else reads them, admins
  included. Usage rows hold counts only. The audit retention covers the call entries.
- **Screens.** The approved board is `docs/design/blueprint/AI.dc.html` (Verwaltung > KI, KI der
  Organisation, the source's KI tab with "Felder ausnehmen", the notice, explain and draft in
  Explore). Until its package lands, the settings page shows a planned AI section.
- **Calling AI from a feature:** `ai::service::complete` or `ai::service::stream` with a
  `Caller` (organization, user, address, a short stable purpose such as `explain_query`). They
  check the switch, the provider, the limits and the concurrency, then count and audit; a feature
  never builds a provider itself. The connection test (`POST .../providers/{id}/test`) is the one
  exception: it calls the stored provider directly, also while AI is off, is not counted, but is
  audited.

## Data directory

- Default: `%ProgramData%\Kalzit\data` on Windows (from the `ProgramData` variable; without it
  the start fails and asks for `paths.data_dir`), `/var/lib/kalzit` on Linux and other Unix
  systems. Never the working directory, which for a Windows service is `C:\Windows\System32`.
- `[paths] data_dir` in `kalzit.toml` or `KALZIT_PATHS_DATA_DIR` override it. Relative paths
  in `kalzit.toml` (`paths.data_dir`, `tls.cert_file`, `tls.key_file` and a `sqlite:` file in
  `database.url`) are relative to the folder of that file, also when the file itself is named
  relatively (`KALZIT_CONFIG=conf/kalzit.toml`). A relative data directory from the environment
  is relative to the working directory, and the server logs a warning that it depends on it.
- At start, `data_dir::prepare` runs before `db::connect`, so the folder is checked before the
  database opens. A missing directory is created private from its first moment: on Linux with
  mode 0700, on Windows through `CreateDirectoryW`
  with a protected ACL, inherited by its contents, for SYSTEM, Administrators and the account
  Kalzit runs as (`OW`, the owner). When Kalzit creates a missing `%ProgramData%\Kalzit` on the
  way, that folder gets SYSTEM and Administrators full access and Users read and execute, with
  no create rights for users; the creating account (`OW`, not inherited) may only read it and
  add subfolders (`0x1200ad`), so a non-admin service account can create `data` but cannot
  write files there or change the folder's entries. If a non-elevated user ran Kalzit first,
  that user owns the folder, and a service started later refuses it and prints the `icacls`
  hint.
- An existing directory is never changed, only checked; it holds password hashes and sessions,
  so the start is refused rather than warned about:
  - Linux: it must belong to the account Kalzit runs as (compared with the owner of a probe
    file) and be closed to group and others (`mode & 0o077 == 0`). The error names
    `chmod 700` and the systemd `StateDirectoryMode=0700`.
  - Windows: its owner must be SYSTEM, Administrators or the account Kalzit runs as, and no
    other account (Everyone, Users, Authenticated Users, other users) may read or write it. The
    error names the `icacls` commands that fix it. `CREATOR OWNER` entries are accepted: only
    accounts that may create files there get them, and those are limited to the trusted ones.
  - Both: the directory must be writable (a probe file created with `create_new` and removed).
- Before reading `%ProgramData%\Kalzit\kalzit.toml` (the path compared without case, after
  canonicalizing), the folder and the file are checked the same way, except that others may
  read them: a configuration that a non-admin could change would decide where the data lives
  and which certificate is served. The folder is also checked at start whenever the data
  directory lies inside it (as written or with junctions resolved), with or without a
  `kalzit.toml`. A folder owned by an account other than SYSTEM or Administrators whose owner
  entry can still change its DACL (left from an interrupted creation) is refused as well.
- Windows also checks the state files that exist (`kalzit.db`, `-wal`, `-shm`, `secrets.key`,
  `secrets.key.dpapi`, `setup-token.txt`): a file keeps the entries it was created with, so one
  moved in from elsewhere may be open to others. The error names `icacls ... /reset`.
- The folder is meant for elevated admin tools (an elevated prompt, `icacls`, an installer).
  Opening it in a non-elevated Explorer and clicking "Continue" adds an explicit entry for your
  own account; Kalzit then refuses to start until it is removed
  (`icacls "%ProgramData%\Kalzit\data" /remove <account>`).
- `setup-token.txt` and the key files are created with their own file ACL (SYSTEM,
  Administrators, owner) on Windows and mode 0600 on Linux, through `data_dir::acl`, which also
  serves `secrets.rs`.
- One info line names the data directory and the database. `db::redact` parses the URL (`url`) and
  rebuilds it from scheme, user, `***` for a password, host, port and path; query values are shown
  only for harmless keys (`sslmode`, `application_name`, `connect_timeout`, `mode`, `host`,
  `port`, `dbname`, ...), all others as `***`. A URL with an `@` after its authority (the text from
  `://` to the first `/`, `?` or `#`) is ambiguous: a password with raw special characters may
  have become port, path or query (`u:2024/Summer@db` parses as port 2024). It is logged as
  `scheme://***` only, and a warning at start says to percent-encode the password. A URL that does
  not parse is shown as `<unparseable database url>`, one without an authority (`postgres:u:pw@db`)
  as `scheme:***`; `sqlite:` URLs are shown as they are. The redaction stays generic, but at load
  `database.url` must be `sqlite:...`, `postgres://...` or `postgresql://...` (Kalzit's own database is
  SQLite or PostgreSQL); anything else is refused, and the error does not repeat the value. The
  `connect` error uses the same function.
- Contents: `kalzit.db` (the default SQLite database, `database.url` unset) with its `-wal` and
  `-shm` files, `setup-token.txt` until the first owner exists, `secrets.lock`, and the fallback
  key file for data source secrets when no other key source is configured (`secrets.key` on
  Linux, `secrets.key.dpapi` on Windows), and `updates/` (staged releases, kept binaries, database
  backups, the update plan and history; see "Updates").
- The database file is also checked for a network drive (see "Storage (SQLite)"): a data
  directory on a UNC path, a mapped network drive, NFS, CIFS/SMB or 9p is refused when the
  database opens. Backups and restores are under "Backups".

### Running as a service

- Linux (systemd): run as a dedicated user and let systemd create the directories:

  ```ini
  [Service]
  User=kalzit
  ExecStart=/usr/local/bin/kalzit serve
  Restart=on-failure
  StateDirectory=kalzit
  StateDirectoryMode=0700
  ConfigurationDirectory=kalzit
  PrivateTmp=yes
  RestrictAddressFamilies=AF_INET AF_INET6 AF_NETLINK
  ```

  Kalzit opens no Unix sockets itself: logs go to standard output, which systemd hands over
  already open (the restriction only stops new sockets), and data sources reach only network
  hosts. So `RestrictAddressFamilies` also stops a driver from being steered to a local socket
  (a MongoDB replica set member can announce a socket path). Add `AF_UNIX` only when
  `database.url` reaches PostgreSQL through a socket directory (`?host=/run/postgresql`). Name
  lookups through `nss-resolve` fall back to DNS without it, as with the usual
  `resolve [!UNAVAIL=return] dns`.

  `StateDirectory=kalzit` creates `/var/lib/kalzit` owned by `User`. Without systemd, create it
  with `sudo install -d -o kalzit -m 0700 /var/lib/kalzit`. `/etc/kalzit/kalzit.toml` should be
  owned by root and not writable by the service user.
- Windows: run the service as a virtual account (`NT SERVICE\Kalzit`) or as LocalSystem. Kalzit
  creates `%ProgramData%\Kalzit\data` on the first start with access for SYSTEM, Administrators
  and the service account only. If an installer or an admin creates the folder beforehand, it
  must have the same rights (owner SYSTEM, Administrators or the service account, no access for
  others), or the start is refused. Changing the service account later means granting the new
  account access to the data directory (`icacls ... /grant "NT SERVICE\Kalzit":(OI)(CI)F`) and
  making it or Administrators the owner.

## Storage (SQLite)

- SQLite runs on one host with its file on a local disk: a data directory on a network drive
  (UNC path or mapped network drive on Windows, NFS, CIFS/SMB, 9p and similar on Linux) is refused
  at start. Shared storage or several Kalzit servers on one database need PostgreSQL.
- WAL mode (`kalzit.db` plus `kalzit.db-wal` and `kalzit.db-shm`), `synchronous = FULL`, a 15 s
  busy timeout and `journal_size_limit` = 64 MiB. Readers never wait for writers. Every
  transaction starts through `db::begin`: `BEGIN IMMEDIATE` on SQLite, so it holds the write lock
  from the start and never fails on a stale read snapshot. Every commit goes through
  `db::commit`, which marks the request as having saved something: later database errors of that
  request answer `internal`, never `busy`. Clippy refuses sqlx's own `begin` and `commit`
  elsewhere (`clippy.toml`); the data source drivers' read-only transactions on the users'
  databases are the marked exceptions. A graceful stop (Ctrl+C, SIGTERM, and on Windows closing
  the console or shutting down, with a 3 s grace instead of 10 s) closes the database, which
  folds the WAL back into `kalzit.db`. The close gets 5 s, on Windows at most what is left of the
  grace; when a statement still waits for a lock another program holds, the stop goes on without
  it and logs a warning. Nothing committed is lost, and the next start completes the checkpoint.
  A supervisor must allow for that: stop the container with `docker stop -t 20`, or create it
  with `docker run --stop-timeout 20` (Docker's default of 10 s is shorter than the 10 s grace
  plus the close); systemd's default of 90 s is enough.
- Writes queue for the one write lock on the main pool, each holding a connection while it waits
  (up to the busy timeout). The reads every request makes, the session lookup, the sign-in's user
  lookup and the organization membership and permissions, go through a separate pool of
  read-only connections (`AppState::read_db`, `query_only`), so a queue of writers cannot use up
  the connections they need; SQLite keeps its single writer. On PostgreSQL both are the same pool.
- Reads never wait on writers: the one write a read request makes, the session's last-seen time,
  runs in a background task, so a cancelled request cannot cut it short. At most a quarter of
  the pool (1 to 4) runs at once; past that a touch is skipped, and the session's next request
  tries again, since its touch is still due. An older touch never overwrites a newer one. A
  failed touch is logged at debug level only.
- Background writes: the touches and the hourly jobs (session cleanup, audit retention) run as
  tasks a stop ends before it closes the database (`db::Background`). The stop signals them;
  they start no new statement and leave their sleeps, and the stop waits up to 3 s for the
  statement they are in, so every connection is back and closed with the pool. Only a task still
  running after that is aborted. On SQLite they use a small pool of their own whose connections
  wait at most 0.5 s for the write lock: SQLite keeps waiting even after a statement is aborted,
  and closing the database would wait the full 15 s. The requests' connections keep their 15 s.
  Each of these writes is repeated later, so a dropped one costs nothing. An hourly run that
  finds the database busy is tried again after 2 s, 10 s, 1 and 5 minutes, as long as that is before the
  next run (`db::Schedule`): the audit retention is a privacy rule and must not slip by an hour.
- Network drives: a symbolic link or junction is followed to where `kalzit.db` really is. The
  check lets the start go on when it cannot tell (no readable mount table, a path without drive
  letter, an unknown drive type, systems other than Windows and Linux).

## Backups

One place for everything a backup needs:

- What: `kalzit.db` with `kalzit.db-wal` and `kalzit.db-shm`, and the key file when no external key
  source is used (`secrets.key` on Linux, `secrets.key.dpapi` on Windows). Without the key, stored
  data source secrets cannot be decrypted; a DPAPI key file only works on the same computer.
- While the server runs: `VACUUM INTO 'backup.db'` (one consistent file) or the sqlite3 shell's
  `.backup backup.db` (the SQLite backup API). Never copy only `kalzit.db` of a running server: what
  is still in the WAL file is lost.
- With the server stopped: copy `kalzit.db`, `kalzit.db-wal` and `kalzit.db-shm` together (after a
  graceful stop the last two are usually gone).
- Restore: copy the files into the data directory, do not move them. A copy takes the directory's
  private entries; a moved file keeps its old ones, and Kalzit refuses it at start. Restore tools
  that copy ACLs (`robocopy /COPYALL` or `/SEC`, `xcopy /O`) keep foreign entries as well, and
  Kalzit refuses such files too: use a plain copy, or run `icacls <file> /reset` afterwards.

## Updates

Kalzit updates itself from the GitHub Releases of MouseWerk/Kalzit, or from the same signed
package uploaded offline (`server/src/updates/`, API docs/api/updates.md, operator guide
docs/operations/updates.md). Server administrators only; every step is audited (`update.*`).

- **Trust.** A release has a manifest (JSON: version, channel, minimum version, release notes
  summary, an `https` notes link and highlights, and per package platform, arch, file, size,
  SHA-256) with a detached Ed25519 signature over its exact bytes, and each package entry carries
  its own signature over version, platform, arch, file, size and SHA-256. Each signed message
  starts with its own context line, so one cannot pass as the other. The format lives in the small
  crate `release/` (`kalzit-release`), shared by the server and the signing tool `kalzit-sign`, so
  both sides cannot drift apart. Signatures name their key by id (first 8 bytes of the key's
  SHA-256); only keys compiled in are trusted (`signing::COMPILED_KEYS`, plus
  `KALZIT_UPDATE_PUBLIC_KEYS` at build time), verified with `ed25519-dalek` (`verify_strict`, weak
  keys refused). Several keys make a rotation possible, and a second key kept offline makes
  revoking a leaked one possible. The first entry is a marked placeholder that is no key: until
  the owner puts the real public keys there, a build verifies nothing and installs nothing.
- **Release side.** The private key exists only on the owner's machine and as the secret
  `KALZIT_RELEASE_SIGNING_KEY` of the GitHub environment `release` (required reviewers). The
  release workflow (`.github/workflows/release.yml`, actions pinned to commits, checkouts without
  credentials) releases only tags on `main`, builds the binaries, and builds only `kalzit-release`
  in the job that holds the key.
- **Source.** Checks list the releases of the channel (stable: not pre-release and no pre-release
  version; preview: all) through the one HTTP client factory, with a target policy that allows only
  `api.github.com`, `github.com`, `objects.githubusercontent.com` and
  `release-assets.githubusercontent.com`, plus a hop check that refuses any other host and plain
  HTTP on every redirect. Responses are size-limited (release list 8 MiB, manifest 256 KiB,
  signature 4 KiB, package its signed size, at most 512 MiB). A manifest whose channel is preview
  is refused on the stable channel. The last check is kept in `updates/state.json`; a daily check
  runs only when `updates.check_daily` is on (off by default).
- **Staging.** A download streams into `updates/incoming/` with its SHA-256 computed on the way and
  stops past the signed size; only a verified release becomes `updates/staging/` (manifest,
  signature, package, `staged.json`). Uploads (multipart: one `.kalzit-update` bundle, or the three
  files; one at a time, with room for twice their size) go into `updates/upload-<id>/` with
  per-part limits and pass the same checks; the package is matched to its manifest entry by hash
  and must be this platform's. Downgrades, the installed version and releases whose
  `minimumVersion` is above the installed one are refused. File work (splitting, hashing,
  copying, restoring) runs on the blocking pool.
- **Nothing in the data directory is trusted for what it does.** Installing verifies the staged
  manifest again from memory, then copies the package once, from one open file, into the running
  binary's own folder (`.kalzit.new`, `.kalzit.new.exe`) and checks the copy against the signed
  size and SHA-256 (`install::place_binary`); only that copy runs for the smoke test (`--version`
  with an empty environment) and is renamed over the binary. Kept binaries live at
  `versions/<version>/<binary name>`, a path derived from the version and never read from JSON;
  their SHA-256 is recorded when they are kept, and the signed manifest of every installed release
  is recorded next to them, so a return checks the copy against the signed hash where there is
  one (`install::verify_kept`). Backups are taken only by plain file name from `backups/`, never
  through a link. Backups and their records have mode 0600 on Unix.
- **Install.** Apply verifies, copies and smoke-tests as above, backs the SQLite database up with
  `VACUUM INTO` (PostgreSQL: the administrator confirms an own `pg_dump`), keeps the running binary
  in `versions/<from>/` with its schema version, backup and SHA-256, records the new release's
  manifest, writes `updates/plan.json` (format 2) and then renames the checked copy into place (on
  Windows the running binary moves aside first). The server stops gracefully, closes the database,
  drops its runtime and hands over: on Unix it replaces its process image with the new binary
  (`exec`), so systemd keeps the same main process and no privilege is needed; on Windows it
  starts the binary as a child.
- **Trial and return.** `updates::boot::guard` runs first at `kalzit serve`, before the database
  opens. The new version's first start marks the plan `trial` and starts a watchdog thread; once
  `/readyz` answers through the router and every listener accepts a connection, the plan is
  removed and the installation recorded. A failed start (migrations), a failed health check or
  the deadline (`updates.health_timeout_secs`, clamped to 15 to 1800 s) mark the plan
  `rollbackRequested` and start the binary again (on Windows a hang only ends the process; the
  return happens at the next start). That start, or any start that finds a `trial` plan (a
  crash), restores the backup (WAL and shared memory files first, so the newer WAL is never
  replayed) and the previous binary after its copy matched the recorded hash, marks the plan
  `rolledBack` and starts the previous version, which records the return once (the plan's
  `recorded` flag keeps a failed audit write from adding a second history entry). A new version
  that refuses the configuration returns the same way: `main` finds the data directory with
  `Config::data_dir_hint` when the configuration does not load. On PostgreSQL, when the new build
  carries migrations newer than the schema of the previous version, the plan is marked `migrated`
  before the first start opens the database (they may run, or partly run, before anything could
  report it), and the trial marks it too when it sees the schema change; a marked plan keeps the
  new version instead of starting a previous binary that could not use the schema, and says so in
  the log. Plan changes of the trial and its watchdog go through one lock. The
  return always runs in a fresh process, before anything opens the database. A plan that fits
  neither version is set aside (`plan-<time>.stale.json`), one that cannot be read or has another
  format too (`plan-<time>.unreadable.json`), loudly.
- **Where it installs on its own** (`platform::detect_mode`): Linux under systemd
  (`INVOCATION_ID`), outside containers, with the binary's folder writable by the service account.
  Windows has no service integration yet (planned with the installer, M5), so there and
  everywhere else the server downloads and verifies, and `kalzit update apply` / `kalzit update
  rollback <version>` install with the server stopped (they hold the data directory lock
  exclusively); the next start runs the same trial. These commands usually run as root or an
  Administrator: on Unix, as root on a data directory another account owns, they touch the data
  directory only with that account's user, group and supplementary group ids and switch back to
  root just for the copy into the binary's folder, the smoke test and the rename (the
  supplementary groups are reduced to the owner's group, and an `updates/` folder of another owner
  than the data directory is refused); files from the data directory are opened as regular files
  only (`O_NOFOLLOW`, `O_NONBLOCK`, checked with `fstat`). On Windows they refuse links and
  junctions below `updates/`; the service account could still swap such a folder between that
  check and its use, which Kalzit's own Windows service integration (M5) is meant to close. The
  command line returns only to versions installed through an update (in the history) whose
  signed manifest was kept. The CI job `update-rights` runs the switch as root against a real
  service account.
- **Kept versions and history.** The newest `updates.keep_versions` (3) previous binaries (never
  the running version's folder) stay with their backups; manual backups ("Back up now") are kept
  to the same count. A return to a kept version swaps only the binary when the schema version
  (`MAX(version)` of `_sqlx_migrations`) is the same, otherwise it restores the backup taken when
  that version was left, after the server stopped, which the request must confirm.
  `updates/history.json` lists installations, returns and aborted steps (newest first, 50
  entries); it lives outside the database, so a restore keeps it.
- **Planning.** `PUT /admin/updates/schedule` stores a time and the end of the maintenance window
  (`updates.window`, chosen in the administrator's local time in the UI; on PostgreSQL with the
  confirmation of an own backup); a background loop (every 30 s, stopped with the server's
  background tasks) installs when it is due, and gives up with `updates.schedule_missed` when the
  server was down for the whole window. A planned installation that cannot run is in the history.

## Migrations

Numbered and never edited after release (`engineering/data-and-apis.md`).

| Number | Content | Owner |
|---|---|---|
| 0001 | orgs, users, members, sessions | M0 |
| 0002 | audit events | M1 foundation |
| 0003 | teams, team members, custom roles, role permissions, resource grants | stream A |
| 0004 | server settings, org settings | stream B |
| 0005 | folders, dashboards, dashboard versions | stream B |
| 0006 | data sources, data source secrets | stream C |
| 0007 | setup lock (one row once setup ran) | fix/sqlite-contention |
| 0008 | dashboard stars, dashboard views, user preferences (docs/api/shell.md) | ux/shell |
| 0009 | annotations, playlists, library panels and their uses, dashboard tags | ux/dashboards |
| 0010 | the server's logo (appearance and brand) | ux/settings |
| 0011 | dashboard pins (sidebar, per user and organization) | ux/sidebar |
| 0012 | not used (left free when 0013 and 0014 were numbered in parallel) | |
| 0013 | Explore query history (per user, 30 days) | explore history (#76) |
| 0014 | team ownership of folders and dashboards (team spaces), team contexts | feat/team-spaces |
| 0015 | audit log indexes by organization, time and id, and by resource | fix/m1-wave-3-perf |

## M1 work streams

Each stream works in its own branch and worktree and owns the files listed; shared files are
changed only by the orchestrator.

| Stream | Owns |
|---|---|
| A: access | migration 0003; `routes/teams.rs`, `routes/roles.rs`, `routes/members.rs`, `routes/admin_users.rs`, `routes/admin_orgs.rs`; custom roles, team roles and resource grants in `authz.rs` (`effective_permissions`, `check_resource`, `explain`) |
| B: settings, audit view, dashboards | migrations 0004 and 0005; `settings.rs`, `routes/admin_settings.rs`, `routes/audit.rs`, `routes/folders.rs`, `routes/dashboards.rs`, dashboard model migrations |
| C: data | migration 0006; `secrets.rs`, `datasources/` (plugin trait, registry, PostgreSQL, MySQL/MariaDB, SQL Server, SQLite, Prometheus, target check, read-only checks), `routes/datasources.rs`, `routes/query.rs` (both query routes), the HTTP client factory |
| D: admin UI | `ui/src/features/admin/`, `ui/src/i18n/*/admin.json` |
| E: data UI | `ui/src/features/datasources/`, `ui/src/features/dashboards/`, `ui/src/features/explore/`, `ui/src/panels/`, their catalog files |

Shared, orchestrator only (a stream that needs a change there asks for it, with the exact edit):
`routes/mod.rs` (one line per new route table), `lib.rs`, `Cargo.toml`, `config.rs`, `app.rs`
(`AppState`), `error.rs` (including `ERROR_CODES`), `shapes.rs` and its generated
`ui/src/api/generated/shapes.ts`, `settings.rs` registry entries (stream B owns the rest of the
file), `ui/package.json`, `ui/src/api/client.ts`, `ui/src/i18n/catalogs.ts`,
`ui/src/i18n/*/core.json`, `ui/src/features/nav.ts`, this document. Stream C reads settings only
through `settings::get`; new registry entries are requested from the orchestrator.

## UI structure

- `ui/src/features/<area>/` own their routes (`routes.tsx`, attached under the signed-in app
  route), nav item, API calls (`api.ts`, through `ui/src/api/client.ts`), components and pages.
- `ui/src/panels/<type>/` export `{ type, shapes, Editor, Panel }`; a registry lists them.
  Optional: `description` and `Preview` for the panel picker, `fieldOptions` (the field option
  groups the panel uses, edited by the shared `FieldConfigEditor`) and `standalone` for panels
  that draw without a query (text). Panels receive `fieldConfig` parsed and the dashboard's
  `variables`.
- Translations: `ui/src/i18n/<lang>/<area>.json`, keys prefixed with the area; core holds only
  shared keys. Tests check prefixes, duplicates and per-file parity.
- The current organization's permissions come from `GET /api/orgs/{orgId}`; areas hide what the
  server would refuse, and the server checks every request regardless.
- Query results (panel answers, Explore runs) can each hold up to the response size limit. They
  stay in the TanStack Query cache for `RESULT_GC_MS` (5 s) once nothing shows them, and when a
  new answer arrives the older unshown ones of the same panel or of Explore are dropped
  (`api/resultCache.ts`), so a refreshing dashboard keeps one answer per panel.
- Graph panels (`ui/src/panels/graph/`) draw with Sigma.js on Graphology (WebGL) and lay out in
  a worker (`layout.worker.ts`, `layoutEngine.ts`): ForceAtlas2 for the network panel, and for
  the hierarchy panel Kalzit's own layered layout (cycles broken by reversing back edges, layers
  by longest path from the roots, barycenter sweeps against crossings). There is no ELK (elkjs)
  in the bundle; it may come later (M5) as an optional hierarchy layout that loads only when a
  panel chooses it, and the layered layout stays the default.

## Testing contracts

- Server: unit tests per module; API tests through the router (SQLite, and PostgreSQL in CI);
  data source tests against real databases in CI service containers (`KALZIT_TEST_<SOURCE>_URL`),
  skipped with a printed notice when the variable is not set.
- UI: Vitest per feature; guard tests for design (every CSS file), i18n and the route tree;
  generated types current.
- E2E: Playwright (`ui/e2e/`) against the server binary with the embedded UI, on Linux and
  Windows (CI job `e2e`, which builds with the `e2e` profile: release settings, less
  optimization). Global setup starts the binary on a free port with a fresh private data
  directory, a random setup token and `datasources.sqlite_dirs` set to a fixture folder,
  writes the fixture SQLite database there (sales per region and time, from code, nothing
  binary committed) and stops the server by its PID afterwards. It records that PID in the run
  folder; the next setup removes folders of runs that crashed, stopping a recorded server only
  if it still runs the binary copied into that folder. The first project runs the first-run
  setup through the UI; the other tests arrange what they need through the API and run in
  parallel on unique names. Chromium runs every scenario, Firefox and WebKit the query editor
  under the server's CSP. Every test fails on an unexpected browser console warning or error;
  the CSP notice for CodeMirror's refused style element passes once per page load and only
  while CodeMirror's is the page's only `<style>` element. axe (`@axe-core/playwright`) allows
  no serious or critical finding on the main pages (light theme in English, dark theme in
  German), and at 360 px nothing sticks out of the viewport or of an open dialog.
  Document and search sources run against real servers: on Linux the job starts MongoDB and
  OpenSearch as containers (`.github/scripts/e2e-services.sh`, MongoDB seeded from
  `ui/e2e/fixtures/mongo-orders.js` with a read-only login) and names them in
  `KALZIT_E2E_MONGODB` (`host:port`) and `KALZIT_E2E_OPENSEARCH` (a base URL). Windows runners
  have no Linux containers, so there `documents.spec.ts` and `opensearch.spec.ts` skip with that
  reason and the release's Windows checklist covers them; on Linux in CI a missing service
  fails. Graph sources run the same way: the job also starts Neo4j (community) and Memgraph,
  seeds both from `ui/e2e/fixtures/graph-shop.cypher` and names them in `KALZIT_E2E_NEO4J` and
  `KALZIT_E2E_MEMGRAPH` (`host:port`), and `graph.spec.ts` skips on Windows with that reason.
  Neither community edition has read-only users, so the Neo4j source relies on Neo4j enforcing
  Kalzit's read transactions and the Memgraph source has `allowWriteCapableUser` set. The HTTP
  JSON spec serves its fixture from a small server inside the test, on a free loopback port.
  Run locally from `ui/`:

  ```
  npm run e2e                                  # builds the UI and the release server first
  KALZIT_E2E_BINARY=../target/release/kalzit npm run e2e   # an existing binary, no build
  npx playwright test -c e2e/playwright.config.ts viewer   # one file
  ```

  Once per machine: `npx playwright install chromium firefox webkit` (on Linux also
  `npx playwright install-deps`). `KALZIT_E2E_BROWSERS=chromium` limits the browsers,
  `KALZIT_E2E_RUN_DIR` sets the folder for run data (default: the system temp folder) and
  `KALZIT_E2E_KEEP=1` keeps it until the next run. Report, traces and `server.log` land in
  `ui/e2e/.output/` (`npx playwright show-report e2e/.output/report`).

  Known runner fault, not fixed (tracked in
  [#42](https://github.com/MouseWerk/Kalzit/issues/42)): on the Windows CI runner a page load
  occasionally fails with `net::ERR_NO_BUFFER_SPACE` (Windows `WSAENOBUFS`) for one of the UI's
  own files, so the page
  stays empty and the test fails on that console entry and a timeout. It is not the suite's own
  connection count: a full local run with four workers peaks at about 600 loopback sockets,
  most in `TIME_WAIT`, against 16,384 ephemeral ports, and CI runs two workers. Fewer workers
  or shared browser contexts would not remove it, so the guard keeps failing on it rather than
  retrying; rerun the job and add the run to the issue.
- Screenshots: the images in `README.md` come from the real application. `npm run screenshots`
  in `ui/` (config `ui/e2e/screenshots.config.ts`, not part of the test run) starts the binary
  through the same global setup, seeds a demo organization through the API (members, teams,
  the SQLite sales fixture, a dashboard with a variable and four panels; later pictures add a
  JSON file of orders with document panels, a panel with analysis steps and a dashboard of
  graph styles; with `KALZIT_E2E_MONGODB` or `KALZIT_E2E_NEO4J` set, also the field distribution
  and the graph panels with explorer mode) and writes PNGs at
  1440x900 to `docs/screenshots/`. The fixture data lies around a fixed moment and the pages run
  on a clock fixed to it; times the server records (sessions, member since, last saved) are
  moved to that moment in the API answers, so reruns give near-identical files. **Every pull request that visibly changes the
  UI reruns `npm run screenshots` and commits the changed images.**
- CI (`.github/workflows/ci.yml`) runs on pull requests, on pushes to `main` and in the GitHub
  merge queue (`merge_group`). Its first job, `changes`, compares a pull request's merge commit
  with its first parent (`main`) and sets flags through `.github/scripts/changes.sh` (tested by
  `changes.test.sh` in the same job). Renames count with both paths, so moving a file out of
  `server/` is a server change:

  | Flag | Set by |
  | --- | --- |
  | `server` | `server/`, `release/`, `Cargo.toml`, `Cargo.lock`, `rust-toolchain(.toml)`, `clippy.toml`, `rustfmt.toml`, `.cargo/`, `ui/src/api/generated/`, `docs/api/` |
  | `ui` | `ui/` (including `ui/e2e/`), `server/src/analysis/`, `ui/src/api/generated/`, `docs/api/`, `docs/glossary.md` |
  | `e2e` | `server` or `ui` |
  | `audit` | `server`, `ui/package.json`, `ui/package-lock.json` |
  | `workflows` | `.github/`; turns every flag on (shown in the log only) |
  | `docs_only` | only `docs/`, Markdown files and `LICENSE` changed (shown in the log only) |

  `docs/api/` and `docs/glossary.md` count as code because server and UI tests read them;
  `server/src/analysis/` (with `conformance.json`) counts for the UI too, whose conformance test
  runs the same cases, and the generated types for the server, whose test compares them. A
  path in no listed area turns every flag on, so a new top-level file runs the full check until
  the script knows it. On pushes to `main` and in the merge queue every flag is on: the queue
  tests each pull request fully on top of `main`.

  `server`, `postgres`, `datasources` and `update-rights` (the privilege switch of the update command
  line, run with sudo against a `kalzit` account) need `server`, `ui` needs `ui`, `e2e` needs `e2e`,
  `audit` needs `audit`. The required checks keep reporting when their area did not change:
  `postgres`, `datasources`, `update-rights` and `audit` are skipped as a whole (GitHub counts a skipped job as
  passed), while the matrix jobs `server (<os>)`, `ui (<os>)` and `e2e (<os>)` start and skip
  every step, because a matrix job skipped as a whole reports one check without the matrix
  value and leaves the required `server (ubuntu-latest)` and the others waiting. If `changes`
  itself fails, every job runs. A newer push to a pull request cancels its running CI; runs on
  `main` and in the merge queue always finish. Merge queue runs restore the caches of `main` but
  do not save their own (Rust build cache, Playwright browsers, browser system packages), since a
  cache saved there belongs to the queue's temporary branch. The exception is the npm cache of
  `actions/setup-node`, which cannot be told not to save: it saves only when no cache matches
  `ui/package-lock.json`, so in the queue only for a pull request that changes the lockfile.
