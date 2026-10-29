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
| `plugin-api/` | Crate `kalzit-plugin-api`: the data source plugin protocol (`proto/`), the plugin manifest and its validator, the plugin signing context (see "Plugins"). |
| `server/src/plugins/` | The server's side of the plugin protocol: its types on the wire and the in-process adapter (see "Plugins"). |
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
- Sign-in rate limit (docs/api/access.md, "Sign-in rate limits"): per client address (IPv4 per
  address, IPv6 per /64), per account at that address, and per account from all addresses. The
  shared account budget does not hold a browser with a known device cookie (`auth::device`: an
  HMAC with a key derived from the secrets key over account, expiry and password hash), so an
  attacker cannot lock the owner out of a known browser, while distributed guessing gets one
  budget. An IPv6 /48 has a budget for all accounts that refuses only accounts not clean at the
  address. Shared budgets are counted before the password check under their lock and refunded
  on success, only within the window they were counted in. Only after the budgets passed does
  a check take one of 2 slots of its account (known devices and signed-in users have 1 slot of
  their own per account, and known devices a budget of 30 successful sign-ins per account and
  address) and a hashing thread: one per CPU for everyone, a quarter of that for known devices
  and signed-in users, each with at most 32 waiting per thread; beyond, `429` at once.
  One table per key class, windows on a monotonic clock. Existing accounts have a table without
  a cap (bounded by the users); emails without an account a bounded one that answers alike.
  In a bounded table a network (/48, /24) with fewer than 16 entries always gets its key; at
  the hard cap room is made from the network with the most entries that have not used up their
  attempts, and used-up entries are never dropped before their window ends. Caps: 100 000 /
  300 000 entries for addresses, accounts at an address, IPv6 sites and unknown emails; 10 000 /
  30 000 for password checks per user, setup codes and connection tests. Worst-case memory
  (estimated; every entry in a network of its own, maps at their largest): about 350 bytes per
  entry, so about 105 MB per large table and 420 MB for the four together, about 10 MB per small
  table, and about 350 bytes per user with failures in the account table.
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
  action for server admins, not an organization permission.
- **Built-in roles** (pinned by a test, so a new permission is granted only by an explicit edit):
  - `viewer`: `dashboards:read`, `folders:read`, `analyses:read`, `teams:read`. Viewers do not
    run their own queries; the panel query route runs the stored queries of a dashboard they may
    read.
  - `editor`: viewer plus `dashboards:write|delete|share`, `folders:write`,
    `datasources:query|read`, `analyses:write`, `data:export`, `annotations:write`, `users:read`.
    `dashboards:share` means granting access to users and teams of the same organization;
    public links for people without an account are a separate permission (M7), by default only
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

- A data source plugin implements one trait (built-ins are compiled in; external plugins use
  the same contract over gRPC, see "Plugins"). Kinds are registered in `registry::KindRegistry`:

  ```rust
  #[async_trait::async_trait]
  pub trait DataSourcePlugin: Send + Sync {
      fn kind(&self) -> &'static str;                          // "postgres"
      fn shapes(&self) -> &'static [Shape];
      fn check_settings(&self, settings: &serde_json::Value) -> Result<(), FieldError>;
      async fn health(&self, conn: &Connection) -> Health;      // "Test connection"
      async fn schema(&self, conn: &Connection) -> Result<SourceSchema, SourceError>;
      async fn query(&self, conn: &Connection, req: SourceQuery) -> Result<QueryResult, SourceError>;
      // Optional parts, each with a default: capabilities() names the ones a kind implements
      // (check_on_save, watch, distribution, pushdown).
      fn capabilities(&self) -> &'static [Capability] { &[] }
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
  ClickHouse runs every query over its HTTP interface with `max_execution_time`, cancel on hang-up
  and `readonly=1` after the SQL check, on a checked text built alongside the sent one
  (which also refuses `SETTINGS`, `FORMAT` and the table functions that reach files or other
  servers) and binds values as query parameters. InfluxDB and Loki reach only a fixed list of
  read endpoints, checked on every URL and redirect; InfluxDB checks Flux (no `to`/`wideTo` names,
  an allow-list of imports without aliases, no `host`/`token` names or keys) and InfluxQL (one `SELECT` without
  `INTO`, or one `SHOW`, sent by GET, which InfluxDB runs only for reads), and binds SQL (3.x) as
  named parameters. Loki log lines answer `documents`, its metric queries and InfluxDB answer
  `frame`.
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
  that runs the queries through `run_queries_with` (all query limits apply, never the query
  cache, with the organization's live slot pool `live:{orgId}`) and makes the result message once for every
  connection; held results count against a live memory budget. A kind reports changes through
  the optional `DataSourcePlugin::watch` (MongoDB: change streams with resume tokens, on their own
  client and pool, at most 8 per source); without one, or for a moving range, the feed polls. Slow clients are dropped instead of buffered; a stopping server
  closes every connection with a reason.

### Query cache (`datasources/cache.rs`, M5)

Answers of read-only queries are kept in memory (docs/api/datasources.md, "Query cache"). The
contract:

- **Where.** `run_one` asks the cache after the item is resolved in the caller's organization, the
  kind is available to it, the target rules are current and the limits are known, and before a
  query slot or connection is taken. Callers choose with `CacheUse` through `run_queries_cached`:
  free queries, panels, saved analyses and variable options use it (`refresh` bypasses the read and
  replaces the entry), AI tools use it scoped by the AI data rules, everything else
  (`run_queries`, `run_queries_with`: live feeds, exports, annotations) never does. The server
  setting `datasources.cache_enabled` and the source's `cacheEnabled` (default per kind,
  `cache::enabled_by_default`) must both be on.
- **Rights in the key.** The key is a SHA-256 over the caller (organization, user, role, sorted
  permissions, scope) and the query (source id and `updated_at`, kind and shapes, canonical query
  and steps, cursor, rounded range, interval, data points, variables and identifier variables, row
  limit). Authorization always runs before the cache, in the routes, so the cache never decides
  access; being per user, an entry cannot reach anyone else even where rules would allow it.
- **Invalidation by generations.** Each entry carries a `Stamp`: the generations of rights
  server-wide and of its organization, of the target rules and of its data source, taken before
  the query ran. `DataSources::forget` (source changed, trashed, purged), a change of the target
  rules (`DataSources::policy`), routes marked `RouteDef::changes_rights` (grants, roles, members,
  teams, folder trash, restore, purge and owner, dashboard and analysis trash, restore, purge and
  owner, plugin block, disable and removal, organization settings, AI access; server routes for
  all organizations) and handlers that move a folder, restrict it or move a dashboard or analysis
  to another folder bump one. Routes and handlers hold a drop guard
  (`QueryCache::bump_on_drop`, taken before the commit), so a client that goes away mid-change
  cannot skip the bump; a route answering with an error disarms it, so refused changes keep the
  answers. An entry under an older stamp is never served and goes when asked for; an answer read under an older stamp is not
  kept. No scan under the lock. A folder's new name changes nothing. Turning the cache off or
  emptying it drops everything.
- **Hits cost like answers.** A hit takes a query slot of the user and the server and is charged
  against the request's `ResponseBudget` (and with it the server's in-flight pool) before it is
  parsed: what the answer held when it was read from its source (`cache::held_size`, counted as
  the budget counts it, 32 bytes per value), at least twice its stored size. One that does not
  fit runs in its source as a miss and is cut there. Keeping an answer serializes it through a writer that stops at the entry cap and draws
  the copy from the same budget, given back once the copy belongs to the cache.
- **Memory.** Entries are kept serialized and counted by their buffer plus 512 bytes, within
  `datasources.cache_max_bytes`; least recently used first, one organization at most half, one
  person at most a quarter of their organization's half and one entry at most a quarter of the
  limit; a lowered limit applies all of them at once. Expired entries go when they are next asked for or pushed
  out.
- **Never kept:** errors, timeouts and answers with a failed graph step. Hits are counted
  (`GET /admin/query-cache`), not audited.

## Plugins

Decided by the owner on 2026-10-27. Done: the protocol, the manifest with its validator, the
signing context, the kind registry, the in-process adapter, the host for data source plugins
(install from a file with every check, trust, approval, processes with supervision and sandbox,
the admin API in docs/api/plugins.md), its pages in the UI after the board
`docs/design/blueprint/Plugins.dc.html` (`ui/src/features/plugins`: Settings > Plugins with the
installed plugins, install from a file, signature and trust, a page per plugin, and the
organization's block list; plugin kinds in "Add data source" with a JSON query editor), the Rust
SDK with the packaging tool and example plugins, the panel message API and the panel host
(panel types in the visualization picker, the sandboxed frame, the options editor from the
manifest), Kalzit's network connector, the only network a plugin has, and the catalog's host side
(`plugins::catalog`: settings, the checked index, browsing and installing from it in the Catalog
tab).

Two plugin kinds, two models: a **data source** plugin is a process next to the server that
serves the gRPC protocol below; a **panel** plugin is a web bundle that runs in the browser in a
sandboxed iframe and talks to Kalzit through a small, versioned message API. Panels never get a
process, a network target or the gRPC protocol.

### Contract (`plugin-api/`, crate `kalzit-plugin-api`)

- `proto/kalzit/plugin/datasource/v1/datasource.proto`: the data source protocol, version 1.
  The build compiles it with protox, a protobuf compiler written in Rust, and tonic-prost-build,
  so no `protoc` is needed on Windows, Linux or in the Docker build. The crate holds the
  generated messages, the client and the server trait, without a transport.
- `manifest.rs`: the manifest format, its validator and the package check; `signing.rs`: what
  plugin, catalog and hand-over signatures cover and the trust rules (reserved ids, updates
  bound to the key); `catalog.rs`: the catalog index with its rollback and freeze checks. The
  crate depends on no server type, so SDKs and the signing tool can use it.

### Process model and transport

- A data source plugin is a process of its own next to the server, one per installed plugin,
  serving all data sources of its kind. Kalzit starts it with a time limit for the handshake,
  watches it and restarts it with backoff; a crashed or hanging plugin fails only the queries
  of its kind, never the server. Before every start the program file is hashed again (opened as
  a regular file, no link) and compared with the SHA-256 its signed manifest lists
  (`package::verify_binary`); a changed file does not start (`plugin.binary_changed`).
- Kalzit is the gRPC client (tonic, HTTP/2), the plugin the server. The connection is local:
  - Windows: a named pipe with a random name (`\\.\pipe\kalzit-plugin-<random>`). Kalzit creates
    it (its first instance before the plugin starts, for Kalzit's account, the start's SID and
    the plugin's AppContainer, labelled low) and keeps one instance waiting; the plugin connects
    to it as a client, because an AppContainer cannot create pipes, checks that the server is
    Kalzit's process (`GetNamedPipeServerProcessId`) and serves the protocol on each connection
    it makes. Kalzit uses a connection only when its client process
    (`GetNamedPipeClientProcessId`) is the child it started, on every connect.
  - Linux: one end of a socket pair Kalzit makes before the start, inherited with its descriptor
    number (`KALZIT_PLUGIN_ADDRESS=fd:<n>`; only close-on-exec is cleared in the child, nothing
    is moved over its other descriptors); the plugin serves the protocol on that one connection. A
    pair reaches only Kalzit, so no process check is needed, and the plugin opens no socket of
    its own (the sandbox refuses `socket`). When the connection ends, the plugin is restarted.
  - stdio carries only the handshake (the plugin prints `kalzit-plugin 1 ready` on stdout when it
    listens) and the plugin's log (stderr, into Kalzit's log with the plugin id, kept per plugin
    with limits: 2000 lines, 512 KiB, lines cut at 4 KiB, 200 lines per second). The address
    and a per-start token arrive in the environment (`KALZIT_PLUGIN_ADDRESS`,
    `KALZIT_PLUGIN_TOKEN`, Kalzit's process id as `KALZIT_PLUGIN_HOST_PID`, and the network
    connector as `KALZIT_PLUGIN_CONNECTOR`), which holds nothing else of Kalzit's; the plugin
    serves only that process (the pipe's server process id, `SO_PEERCRED` of the socket), every
    call carries the token as metadata (`kalzit-plugin-token`) and the plugin refuses calls
    without it.
- `plugins::supervisor`: the process starts with the first call of its kind; within 10 seconds
  it must say ready, accept the checked connection and answer `Describe` in line with its
  manifest. Every 30 seconds a `Describe` probes it; two missed answers end it. After the n-th
  failure in a row it waits 10 s, 30 s, 1, 2, 5 and 10 minutes before its next start, then stays
  stopped until an administrator restarts it; 10 minutes of running start the count afresh.
  Disabling, removing, removing its key and Kalzit's stop kill it with everything it started.
- `plugins::remote::Remote` is the `DataSourcePlugin` of a plugin kind: every call goes over
  gRPC with a deadline; results go through `wire::Assembler` with the query's limits. Plugin
  reasons that are not reasons of Kalzit's catalog become `plugin.error` (docs/api/plugins.md).
  Before each call the targets the manifest takes from the settings pass the data source target
  rules; every connection the plugin then asks for passes the connector's checks again (see
  "Network connector").

### Protocol, version 1

| RPC | What |
|---|---|
| `Describe` | Protocol version, kind (the manifest id), shapes, capabilities. First call after start; an answer that contradicts the manifest stops the plugin. |
| `CheckSettings` | The kind's own settings checks, without network. The form rules of the manifest are checked by Kalzit before. |
| `Health` | "Test connection": what connected, or an `Error` like any other call. |
| `Schema` | Completion data in one of the documented schema forms, as JSON. |
| `Query` | One query; the result streams as parts (below). |
| `CheckOnSave` | Capability `check_on_save`: checks on the source itself when it is saved (the login may only read). |
| `Watch` | Capability `watch`: change feed for live updates, positions as opaque resume tokens; `unsupported` as first event means "poll". |
| `Release` | Kalzit forgets a data source (settings changed, deleted): close its pools. |

- Every call carries the data source (`Connection`: id, revision, settings, secrets); plugins
  may keep pools per id and revision until `Release`. Secrets are never logged or echoed.
- **Native shapes.** A result is `start` (shape; frame fields without values), batches of the
  started shape (`frame_rows` with one JSON array per field, `documents` as JSON objects in the
  stored key order, `graph` with nodes, edges and paths), then `end` with the shape's metadata
  (notices, truncation, schema, cursor), or `error`. Kalzit refuses parts out of order, of
  another shape, ragged columns or documents that are not objects (`plugins::wire::Assembler`);
  a stream without `end` or `error` is a failed query. Values without a protobuf type travel as
  JSON in the forms of docs/api/datasources.md; present-but-empty maps and paths keep their
  presence, so a result survives the wire exactly (tested for all three shapes).
- **Frame values** must fit their field's type, as the result envelope defines them: `time`
  and `date` JSON numbers of Unix milliseconds in the supported range, `number` JSON numbers,
  `int64` decimal integer strings within 64 bits, `decimal` decimal strings (`-1234.50`, no
  exponent, no `NaN`), `string` strings, `bool` booleans, `json` anything; `null` everywhere. A
  value that does not fit fails the query with the column and row named.
- **The host enforces the limits**, whatever the plugin sends. `plugins::wire::Assembler`
  takes the query's limits (`wire::Limits`: rows, documents and graph elements, the request's
  response byte budget, at most `MAX_PARTS` parts): rows, documents, nodes and edges beyond the
  limits and batches beyond the budget are cut, with the same truncation and notices built-in
  sources give (`frame.row_limit`, `documents.limit`, `graph.node_limit`, `*.size_limit`; a
  cut graph keeps only edges and paths whose ends remain and says how many paths it left out
  with `graph.paths_cut`, a cut document set loses its cursor). Every part draws its size from
  the budget before its JSON is read, and after a cut the remaining parts are dropped unread.
  The start (at most `MAX_FIELDS` frame fields) and the end count against the budget too: a
  start that does not fit fails the query, an end that does not fit leaves out the plugin's
  schema, notices and executed query and marks the result as cut. A stream with more parts
  than allowed ends the query with an error, so a plugin that never ends cannot hold the
  host. Both sides decode no message above 16 MiB (`MAX_MESSAGE_BYTES`, set as tonic's
  `max_decoding_message_size`); batches aim at 1 MiB (`TARGET_PART_BYTES`), as the in-process
  adapter cuts them.
- **Cancellation** is the end of the call (HTTP/2 `RST_STREAM`); the plugin stops the work in
  the database too. **Deadlines** arrive as the gRPC deadline and as `deadline_unix_ms` on
  `Query`, `Health`, `Schema` and `CheckOnSave`, next to the limits (`timeout_ms`, `max_rows`,
  `max_response_bytes`) a result must keep. A timeout of less than a second is reported as one
  second, never as zero.
- **Errors** are `Error { kind, detail }` with the kinds of `SourceError` (rejected, blocked,
  timeout, failed) and a detail (reason, params, English text), so they reach the API with the
  same codes as built-in errors. gRPC status codes are for broken calls only
  (`INVALID_ARGUMENT`, `UNIMPLEMENTED` for a missing capability).
- **Capabilities.** Version 1 has `check_on_save` and `watch`. Field distributions and graph
  step pushdown stay with the built-in kinds: both depend on Kalzit's step language, which is not
  yet a stable contract. `DataSourcePlugin::capabilities` declares them for every kind; Kalzit
  never calls an RPC whose capability is missing.
- **Evolution.** Version 1 only grows: new fields, enum values, oneof parts or RPCs, each
  raising the minor version (`PROTOCOL_MINOR`, now 0). Renaming, renumbering or changing a
  field's meaning needs a new package (`kalzit.plugin.datasource.v2`). The host announces its
  minor version and the additions it understands by name in `DescribeRequest`
  (`protocol_minor`, `features`); a plugin uses an addition only when the host announced it.
  The host in turn stays safe with what it does not know: an unknown notice severity counts as
  info, an unknown error kind as failed, an unknown capability is ignored, an unknown result
  part is skipped with the notice `plugin.part_skipped`, and a frame field of an unknown type
  is left out with `frame.type_unsupported` naming it. Kalzit refuses plugins whose major
  version it does not speak (`SUPPORTED_PROTOCOL_VERSIONS`). Tested in both crates.

### Panel plugins

- A panel plugin never runs on the server. Installed, approved, enabled and trusted, it is in
  `plugins::panels::PanelRegistry` (no process, nothing in the kind registry); its panel type is
  its id. `GET /orgs/{orgId}/panel-plugins` lists those not blocked for the organization with
  their declared options; the UI adds them to the panel registry after the built-in types
  (`setExternalPanels`), so the picker offers them with a neutral "Plugin" badge and the
  publisher, and Explore (no dashboard) does not.
- The bundle (`[panel]` in the manifest: one `.js`/`.mjs` file with its SHA-256 and the message
  API version `api`) is served by `GET /orgs/{orgId}/panel-plugins/{id}/frame` from the installed
  package, its hash checked against the manifest on every request, as one HTML document with the
  bundle inline. Inline because the frame's requests carry no session (opaque origin), so a
  separate bundle request could not be authorized. The response carries its own policy:
  `sandbox allow-scripts`, `default-src 'none'`, the bundle's hash as the only script source,
  `connect-src 'none'`, `webrtc 'block'`, no forms, no base, `frame-ancestors 'self'`
  (`net::security_headers` keeps it), and `X-DNS-Prefetch-Control: off`. Remaining risk: WebRTC is
  outside `connect-src`, and `webrtc 'block'` holds only in browsers that implement it; there a
  panel could still reach a STUN/TURN server. That rests on the signature and the admin's trust. Authorization per request: the dashboard (readable when it shows the panel, editable
  otherwise), the plugin enabled, trusted and not blocked for the organization.
- The UI loads it into `<iframe sandbox="allow-scripts">` without `allow-same-origin`: the panel
  gets an opaque origin, so it cannot read Kalzit's cookies, storage or DOM, call its API or
  reach other panels.
- Messages (`postMessage`, each with `api` and `type`): into the frame the panel's options (the
  declared ones that fit, with defaults), its size, the theme tokens (colors resolved), the mode
  (`view`/`edit`) and the query results in their native shapes after the panel's steps, as
  built-in panels receive them; out of the frame only events. The host
  (`ui/src/features/plugins/panel`) accepts them only from its frame's window with the origin
  `"null"`, checks each against the schema of its version (the same cases as
  `kalzit_plugin_api::panel`, shared as fixtures), keeps 20 events and 5 log lines per second,
  and acts only on a size request, options in the panel editor (checked against
  `[[panel.options]]`), a link the viewer confirms and log lines. A frame that does not say
  `ready` within 10 seconds or loads a second document (a navigation) is stopped and shows an
  error with "Try again". A panel cannot run queries of its own.
- The options editor is built from `[[panel.options]]`: a field per option with its label and
  help in the user's language, numbers within their range, selects from their choices.
- Version 1 grows only by new optional fields and message types (`setOptions`, `link`, `log` and
  `init.mode` came this way); the manifest's `api` names the version a bundle speaks, and Kalzit
  refuses versions it does not know.

### SDK, packaging tool and examples

- `plugin-sdk/` (crate `kalzit-plugin-sdk`): a plugin implements the `DataSource` trait
  (describe, check_settings, health, schema, query; optional check_on_save, watch, release) and
  calls `kalzit_plugin_sdk::run`. The SDK reads the start's environment (and takes the token out
  of it, keeping the connector's copy), serves with the checks of "Process model and transport"
  (Windows: connects to the pipe Kalzit created and checks the server's process id; Linux:
  listens on the socket, `SO_PEERCRED`), connects to targets only through Kalzit's connector
  (`net::connect`), prints the handshake, refuses calls without the token (compared in
  constant time), turns the gRPC deadline and `deadline_unix_ms` into one deadline per call, and
  drives a query's future from its result stream, so a cancelled call drops the plugin's work.
  Results are written per shape (`FrameWriter`, `DocumentWriter`, `GraphWriter`), which keep
  the order of parts, cut batches at `TARGET_PART_BYTES` and say `Full` one row past the row
  limit or one part past the byte budget, so the host cuts with its own notice. Errors map to
  `Error` kinds; logs go to stderr. Its tests serve a plugin on a real pipe or socket.
- Network: `kalzit_plugin_sdk::net::connect` is the client of Kalzit's connector (see "Network
  connector"); a plugin has no other way out.
- `plugin-tool/` (binary `kalzit-plugin`): `keygen`, `package` (writes `[files]` with the
  hashes, checks the manifest as the host does, signs with a key file or
  `KALZIT_PLUGIN_SIGNING_KEY`), `sign`, `attach-signature` and `verify`. A tool of its own, so `kalzit-sign` stays
  small next to the release key.
- `examples/plugins/csv-http` (`dev.kalzit.csv-http`, a CSV or JSON file over HTTP as a frame)
  and `examples/plugins/panel-kpi`. CI builds, packages and signs them per system with a
  throwaway key. Release tags package them unsigned in a job without the key, sign only the
  manifests with `kalzit-sign sign-plugin-manifest` (plugin key in the `release` environment),
  attach the signatures and check them against the compiled main key, then publish them with
  the release; every artifact is fetched by name and checked against the hash its job reported. The contract test installs the data source example signed with a key trusted as
  Kalzit's and queries it through the host on Windows and Linux.

### Registry and the in-process adapter

- `datasources::registry::KindRegistry` holds the kinds. Built-ins are registered at start
  through the same `register` a plugin uses; nothing can take a name in use, built-ins cannot
  be removed, and a removed plugin kind leaves its data sources stored (they answer
  `datasource.kind_unavailable`) while running queries finish on their `Arc<Kind>`.
- `plugins::in_process::InProcess` serves any registered kind through the generated server
  trait. It is the protocol's reference: built-in kinds answer through it exactly what they
  answer directly (tested with SQLite), so what the protocol cannot express shows up there
  first, and plugin SDKs are tested against it. The query path keeps calling built-in kinds
  directly; the host wraps a plugin process in a `DataSourcePlugin` (`plugins::remote::Remote`), so
  routes, limits, live updates and the target checks stay the same for every kind.

### Manifest (`kalzit-plugin.toml`)

```toml
manifest = 1                       # format version
id = "dev.example.redis"           # lowercase reverse domain name; the kind's name
name = "Redis"
version = "1.2.0"                  # semver
kind = "datasource"                # or "panel"
min_kalzit = "0.4.0"
shapes = ["frame", "documents"]
protocol = 1                       # data sources
capabilities = ["watch"]           # check_on_save, watch

[[settings]]                       # the settings form (data sources)
name = "host"
label = { en = "Host", de = "Host" }
type = "string"                    # string, text, number, bool, select
required = true
target = true                      # decides where secrets go

[[settings]]
name = "password"
label = { en = "Password", de = "Passwort" }
type = "string"
secret = true

[[permissions.network]]            # the only targets the plugin can reach
setting = "host"                   # a target field ...
form = "host"                      # ... holding a host (or "url": scheme, host and port)
default_port = 6379
protocol = "tls"                   # tcp (default) or tls, for hosts
[[permissions.network]]
host = "license.example.dev"       # or a fixed host and port
port = 443
protocol = "tls"

[binaries]                         # data sources: one executable per platform
windows-x64 = "bin/windows-x64/redis-plugin.exe"
linux-x64 = "bin/linux-x64/redis-plugin"

[files]                            # every file of the package with its SHA-256
"bin/windows-x64/redis-plugin.exe" = "<64 hex digits>"
"bin/linux-x64/redis-plugin" = "<64 hex digits>"
"LICENSE" = "<64 hex digits>"
```

A panel has `[panel]` with `path` (the `.js`/`.mjs` bundle, listed in `files`) and `api` (the
panel message API version) instead of binaries, settings and permissions, and optionally
`[[panel.options]]`: `name`, `label` (`en`, optionally `de`), `type` (`string`, `text`,
`number`, `integer`, `bool`, `select`), `default`, `choices` (a select's), `min` and `max`
(numbers), `help`; at most 64, defaults checked against their type and range.

`manifest::parse` reports every problem at once with its path and a stable code
(`manifest.*`): unknown keys, ids that are not reverse domain names (so a plugin can never take
a built-in name such as `postgres`), versions that are not semver, unknown shapes,
capabilities, platforms or setting types, repeats, secrets that are targets or have defaults,
selects without options, network targets that are not `target` fields, lack their `form` or
use wildcards, protocols other than `tcp` and `tls`, binaries or bundles not listed in
`files`, hashes that are not SHA-256, Windows binaries without `.exe`, texts with control or
bidirectional override characters, and parts of the other kind. Package paths stay inside the
package and are portable: relative, `/` between parts, no `..`, no Windows device names
(`CON`, `NUL`, `COM1`, also with an extension), no part ending in a dot or space, no characters
Windows refuses, and no two paths that differ only in case. Plugin texts come from the manifest
(labels in `en`, optionally `de`), not from Kalzit's catalogs. Fixed hosts and setting targets
pass the same data source target rules (`TargetPolicy`) as built-in sources.

### Signing and trust

- A plugin signature is Ed25519 over `kalzit-plugin-manifest-v1\n` followed by the manifest's
  exact bytes (`kalzit-plugin.sig` next to `kalzit-plugin.toml`). A catalog index is signed over
  `kalzit-plugin-catalog-v1\n`, a key hand-over over `kalzit-plugin-handover-v1\n`. No
  context is a prefix of another or of the release contexts (`kalzit-update-*`), and a real
  Ed25519 signature made in one context fails in every other (tested).
- **The manifest pins the whole package.** `files` lists every file with its SHA-256; before
  anything runs, the host compares the unpacked package with it (`Manifest::check_package`)
  and refuses unlisted files, missing files, other hashes and links or other special entries.
  The host unpacks into a fresh directory only Kalzit's service account can write, hashes the
  files there and runs the plugin from there (nothing can change between check and start);
  it lists entries without following links and reports symbolic links, junctions, reparse
  points, files with more than one hard link and archive entries that are links or devices as
  special entries.
  So nothing unsigned can ride along: on Windows a DLL placed next to the binary would be
  loaded before the system's (DLL search order), and the host also starts plugin binaries with
  the safe DLL search mode (system directory first, not the current directory).
- **A plugin id is bound to its key** (`signing::check_update`). An update must be signed by
  the key of the installed version, or by a key that key handed the id over to: a hand-over
  statement (plugin id, the old and the new public key in full, and the first plugin version
  the new key may sign) signed by the old key and kept with the plugin, so a publisher can
  rotate keys without the admin re-trusting the plugin. Keys are compared by all 32 bytes,
  never by the short key id. Chains of hand-overs are followed until nothing changes, so their
  order does not matter. Updates never go to an older version (downgrades refused), and a
  signed install never becomes unsigned.
- Hand-overs do not expire, and a leaked old key can hand the id over again: the remedy for a
  leaked key is removing it from the trusted keys, which stops its plugins (after the admin
  confirms), and trusting the publisher's new key.
- Ids under `io.kalzit.` and `dev.kalzit.` need Kalzit's own plugin key (`check_signer`).
  `check_update` does not look at ids, so the host runs `check_signer` on every install and
  every update as well.
- Trusted for plugins: Kalzit's own plugin key and the publisher keys a server admin adds. The
  release keys are never trusted for plugins and plugin keys never for releases. Unsigned
  plugins install only with an explicit admin switch, off by default, and are marked as such.
  An invalid signature (one that does not verify, or a manifest that does not match it) is
  always refused, also with that switch on.
- Removing a trusted key stops the plugins signed with it, after the admin confirms the list
  of affected plugins.
- An update whose manifest adds permissions (`Manifest::added_permissions`, new network
  targets) does not run until a server admin approves them; the installed version keeps
  running meanwhile.
- Organization admins can block an installed plugin for their organization: its kind and panel
  type are then not offered there and its data sources and panels in that organization stop
  (`DataSources::kind_in_org`).
- Installing, removing, approving, blocking and changing trust are recorded in the audit log.
- The host (`plugins::package`, `plugins::host`): the package is unpacked into a fresh
  directory below `<data_dir>/plugins/packages` that only Kalzit's account may write, with every
  entry path checked before anything is written and the unpacked size counted (at most 1 GiB);
  then `check_package`, the signature against Kalzit's plugin keys (the main key and the offline
  backup key compiled in, plus `KALZIT_PLUGIN_PUBLIC_KEYS` at build time) and the publisher keys in
  `plugin_keys`, `check_signer` and, for an update, `check_update` with the hand-overs kept
  in `plugin_handovers`. Installed plugins are the table `plugins` (migration 0020), with the
  exact manifest, the signer and its key, the approval, the switch and an update that waits.

### Catalog

A signed index (the project's, or a mirror an administrator names; there is no default address)
lists plugins with versions, key ids, download URLs and package hashes (`catalog::CatalogIndex`).
It is off by default; turning it on is a server setting. Every index carries a growing
`sequence`, its publication time and an `expiresAt` at most 31 days later. The host remembers
the highest sequence it accepted per catalog key (`catalog::Accepted`, by the full public key;
`parse_index` takes the key whose signature verified) and refuses an older or equal one
(rollback) and an index past its expiry (freeze), so whoever controls the download cannot keep
a known-vulnerable version listed. Every entry is checked: a valid plugin id, semantic version
and kind, a 16-digit key id, an `https` URL without user info, a SHA-256 in lowercase hex, and no
id with the same version twice. Installing from a file (the package with its manifest and
signature) always works, also offline, and runs the same checks.

- An index may withdraw versions (`revoked`: plugin id, a semver requirement, a reason); they are
  never installed from the catalog and installed versions they match are named in the UI.
  Optional `description`, `publisher` and `network` texts of an entry are for browsing only; the
  review before approval shows the package's own manifest.
- The host side is `plugins::catalog` (settings `plugins.catalog_enabled`, off by default,
  `plugins.catalog_url`, no default host, and `plugins.catalog_refresh_hours`). Kalzit itself
  loads the index and `<url>.sig` (a detached signature like a package's) with the one HTTP
  client (`crate::http`): the data source target policy, HTTPS only on every hop, 30 s and 4 MiB
  for the index, 10 minutes and the entry's size for a package. Redirects are followed hop by
  hop: the configured host and port use a client that may reach a private mirror but never
  Kalzit's own ports (`LocalGuard`), every other host one that refuses all but public addresses
  (`LocalGuard::is_private`), both resolving through the target policy and connecting to the
  checked address. The signature must verify with a key allowed for the catalog: Kalzit's plugin
  keys or publisher keys an administrator marked `may_sign_catalog` (a column of `plugin_keys`);
  trust for plugins alone is not enough. Then
  `parse_index` with the accepted sequences. The first list of an address pins its key (another
  key needs `acceptKeyChange`), and the highest sequence is kept per key and per address. The index
  taken, its key, the accepted sequences (never lowered, also across URL changes) and the last failure are the row of `plugin_catalog`
  (migration 0024); a failure keeps the index taken before, and the same bytes served again count
  as unchanged until their expiry. A background loop refreshes when due (`spawn_background`).
- Installing from the catalog: the entry must be listed in a current, unexpired index and not
  withdrawn; the package is streamed into the host's private upload directory and must match
  the entry's size and SHA-256, its manifest the entry's id and version, and its signature a
  trusted key with the entry's key id (never unsigned from the catalog). Then it goes through
  `PluginHost::install` unchanged: the same checks, update rules, approval and sandbox as an
  uploaded file. Refusals and installs are in the audit log (`plugins.install_refused` with
  `source: "catalog"`, `plugins.catalog_installed`, `plugins.catalog_refreshed`).

### Sandbox

What a plugin process gets (`plugins::sandbox`; details and the exact lists in
docs/api/plugins.md, "Sandbox"). The layers in force and the missing ones are in the plugin's
status and in the log. On Linux Landlock is required unless an administrator allows plugins
without it (`allowWithoutLandlock`, shown on the plugin before approval), and plugins do not run
while Kalzit runs as root.

- Windows: a restricted token without privileges (except bypass traverse checking), with
  Administrators for deny only and the restricting SIDs Everyone, Users, `RESTRICTED`, a SID of
  the plugin and a SID of this start (not the logon session: Kalzit's process grants it read access), at low
  integrity, with a default DACL for Kalzit's account, SYSTEM and that SID only. So the plugin
  cannot open Kalzit's process or another plugin's (tested), cannot read or write Kalzit's data
  directory (tested) and writes only where the low label allows: its run directory. Its package
  is read and run for the plugin's SID only, its run directory read and write (not run) for the
  start's SID only. A job object, assigned before
  the process runs (it starts suspended): killed with Kalzit, no breakaway, 2 GiB of memory and
  16 processes for the whole job, no desktop, clipboard, global atoms or system settings, an
  optional CPU cap. Image load policy: System32 first, no images from remote shares or with a low
  label. Its pipe ends are inheritable only while it is created, under a lock, and only they are
  in its handle list.
- Linux: `no_new_privs`; Landlock: the file system read-only and visible only where a process
  needs it (system libraries, `/proc`, `/sys`, certificates and a few files of `/etc`, five device
  files), its package to read and run, its run directory to write (not to run), other processes'
  `/proc` entries out of reach; seccomp: no `ptrace`, no other process's memory, no mounts, no
  namespaces (also `clone` with `CLONE_NEW*`; `clone3` answers `ENOSYS`), no `io_uring`, kernel
  modules, `kexec`, `bpf`, `perf_event_open`, `userfaultfd` or keyrings, `truncate` refused where
  Landlock cannot guard it (ABI below 3), other architectures killed; signals only to itself and
  its group (Landlock signal scope from ABI 6, else a seccomp filter that knows its process id);
  a user and an IPC namespace with the account mapped to itself (where unprivileged user
  namespaces are allowed); a limit on the data segment; no core dumps; its own process group,
  killed as a whole, and killed when Kalzit ends.
  The plugin gets its own session and process group (`setsid` before exec), outside Kalzit's,
  and `setpgid`/`setsid` are refused after that. Without Landlock (unless allowed) nothing
  starts: the host checks before spawning, and the child fails the spawn when Landlock does not
  take.
- Network, Windows: an AppContainer of its own per plugin (a profile `kalzit.plugin.<hash>` of
  the installation and the plugin id, so two installations never share one,
  removed with the plugin) without any capability and without a loopback exemption, combined
  with the restricted token (Windows makes the token a lowbox token; every access passes the
  normal, the restricting-SID and the AppContainer check). It opens no network connection, not
  even to loopback. An AppContainer cannot create named pipes, so Kalzit creates the plugin's
  pipe and the plugin connects to it; Windows sets `TEMP`/`TMP` to the container's `AC\Temp`,
  which Kalzit empties at every start and limits to the plugin. Files any local account may
  read (`kalzit.toml` in ProgramData with `database.url`, a TLS key inheriting ProgramData's
  entries) stay closed: they grant Users or Everyone, which remain restricting SIDs (System32
  and the `NUL` device need them), but no AppContainer (tested). A file of Kalzit's with secrets
  that grants reading to those and to all AppContainers (as under `C:\Program Files`) would be
  readable: then plugins do not start (`plugin.secrets_exposed`, `host::exposed_secrets`); one
  that only local accounts may read is a warning in the plugin's status and log. A Windows Filtering Platform
  rule was not chosen: adding filters needs administrator rights, which a Kalzit service account
  does not have.
- Network, Linux: the seccomp filter refuses `socket`, `connect`, `bind`, `listen`, `accept` and
  `accept4` for every family (`EACCES`), Unix sockets included, allows `socketpair` for stream
  and sequenced-packet pairs only, and refuses `MSG_FASTOPEN`. The plugin's connection to Kalzit
  and the connector are inherited socket pairs, and every network connection is a socket pair
  Kalzit relays, so it reaches neither the network nor a Unix socket of the host (a database's,
  Docker's, D-Bus's, `/dev/log`, named or abstract), whatever Landlock's ABI, and holds no socket
  of the host's network it could point elsewhere. Where user namespaces are allowed the plugin
  also gets a network namespace of its own with only an unconfigured loopback device.
- Processes and CPU are not limited on Linux.

### Network connector

The only network a plugin has (`plugins::connector`, protocol minor 1, feature
`network_connector`; the client is `kalzit_plugin_api::connector::Connector`; details and reasons
in docs/api/plugins.md, "Network connector"). The plugin sends a `ConnectRequest` (token, data
source id, host, port, `tcp` or `tls`, request id), framed with a 4-byte length, to
`KALZIT_PLUGIN_CONNECTOR`: on Linux an inherited `SOCK_SEQPACKET` pair `fd:<n>` (requests may
overlap; it belongs to the process that opened it), on Windows one connection to a named pipe of Kalzit's per request (only the plugin's
process is served; the client checks that the server is Kalzit). gRPC cannot carry a socket.

- The plugin must have been handed the data source (`connector::Grants`, recorded with every
  call that hands over a `Connection`; taken back, with its open connections closed, when the
  data source changes or goes to the trash, `DataSources::on_forget`). The target must be one
  the manifest declares for the data source's settings as they are stored at the connect
  (`connector::Lookup`, `host::StateLookup`, with the target rules of the server settings then;
  a source of an organization that blocked the plugin is refused, and the block revokes its
  grants). "Test connection" and the check before a save hand over settings that may not be
  stored: they get a draft grant under an id of their own (`draft-...`, `Grants::draft`) for the
  length of the call, checked by the same rules and revoked with its connections at its end.
  Requests with a host above 253 bytes are refused before any check. The target must be one the
  manifest declares for these settings: a `host` setting with its port setting or default port and
  protocol, a `url` setting's host and port (`https`/`wss` mean TLS), a fixed host and port. The
  protocol is a permission label; Kalzit does not enforce TLS on the stream.
- Kalzit resolves the name, checks every address with the data source target rules
  (`TargetPolicy`: metadata addresses, `datasources.allowed_targets`) and against its own
  addresses (`connector::OwnEndpoints`: the HTTP and HTTPS ports on any local address, the
  PostgreSQL database of `database.url`, resolved at start and again per request; with no
  address from either, its port is refused everywhere), and connects to the checked address, so
  a name cannot resolve to something else for the connection (DNS rebinding).
- Kalzit keeps the TCP connection and relays it (`connector::relay`): on Linux the plugin gets
  one end of a new stream socket pair with `SCM_RIGHTS`, on Windows the pipe itself. Handing the
  TCP socket over was dropped: a plugin could disconnect it (`connect` with `AF_UNSPEC`) and
  point it anywhere, or bind and listen with it. A socket handle duplicated into the AppContainer
  (`WSADuplicateSocket`) would have the same problem on Windows. The relay makes the count of
  connections exact and ends a connection when either side ends it, when idle, or when its data
  source is taken back.
- Every relay also ends with the plugin process (a per-start cancellation, `Context::stopped`).
- Linux: a plugin starts only when the seccomp network filter or a network namespace took
  (`plugin.network_missing`), unless an administrator allows plugins without Landlock; then the
  plugin page warns.
- Limits (`supervisor::Options`): 64 connections at once per plugin, 15 minutes without traffic,
  one budget of 10 seconds per request for the data source, the lookups and every address, 16
  requests under way at once. Every refused connect goes to the plugin's log, Kalzit's log and
  the audit log (`plugins.connect_refused`), and the connector's other warnings to the logs,
  each at most once a minute per target and reason, refusals also through a token bucket per
  plugin (20, then one per 3 seconds) checked before a key is remembered, and at most 1000
  distinct keys at once. Refusals for Kalzit's own addresses, metadata addresses and the
  allow-list are always audited, once a minute per reason; everything held back is counted by
  reason and summed up once a minute (`plugins.connect_refusals_suppressed`).
- The plugin speaks its database's protocol over the stream and wraps it in TLS itself.

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
  field paths of up to 500 characters without control characters. A new built-in panel type adds
  its own check there, and its default and editor options to the contract fixture
  (`ui/src/panels/contract.test.ts`); unknown types, panel plugins among them, are left alone on
  save: a plugin panel's options are checked against its `[[panel.options]]` in the editor, and
  only the declared ones that fit reach its frame.
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

Built-in AI (owner decisions in docs/PLAN.md, section 12, API in docs/api/ai.md). This section
is the core every AI function builds on, then the functions themselves (explain or draft a
query, summarize a result, the agent chat "Fragen"), which all go through it.

- **Off by default, one switch.** `ai.enabled` (server setting, default `false`) gates every AI
  call (`409 ai_unavailable`, `ai.disabled`). `GET /api/orgs/{orgId}/ai/status` tells the UI
  whether AI is usable (on and a provider in effect). Off, it answers only
  `{"enabled": false, "usable": false, "orgProvidersAllowed": ...}`. Every AI element in the UI sits inside `AiGate`
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
  plus a refusal of Kalzit itself: when saved, its public URL and loopback or listening addresses
  on its ports (IPv4-mapped IPv6 normalised); at connect time, when the base URL's port is one of
  Kalzit's listening ports, `http::LocalGuard` refuses every address of this computer (loopback,
  unspecified, any address a socket can be bound to) in the resolver and for address literals,
  so no host name can lead back to Kalzit. Requests are sent with `send_once`: no redirects, so
  the key reaches exactly the configured URL. Retries with backoff (0.5 s, 1 s, jitter, at most 3
  attempts, `Retry-After` up to 10 s) on passing failures before anything of the answer arrived;
  one deadline for the whole call, retries and waits included (`ai.request_timeout_secs`); a
  `CancellationToken` stops a call at once, and dropping its stream cancels it. Answers are
  capped at 16 MiB. The last connection test of a provider is kept on it (`lastTest`) and cleared
  by a change of address, model, key or token field; AI is switched on (server or organization)
  only while a provider in effect has a pass (`service::check_switch`). OpenAI-compatible
  requests carry the answer budget as `max_completion_tokens` for api.openai.com and
  `max_tokens` elsewhere (`TokenLimitField`), and drop `stream_options` once on a 400.
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
  both directions, NFKC and case folding, JSON columns included), since results do not always
  name their table. It works by name and is best effort, not a security boundary: an alias or an
  expression passes values under another name; the boundary is the opt-in and the user's rights.
  Secrets, connection
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
  providers are allowed, changed, tested and used. At once: on the server (`ai.max_concurrent`),
  per organization (`ai.max_concurrent_per_org`) and per user (`ai.max_concurrent_per_user`),
  held in memory (`ai::service::AiRuntime`). Counters are `ai_usage` rows per day, organization
  and user (no foreign key to the user, so a deleted user's tokens keep counting for the month).
  Admission is one step under `AiRuntime::admission`: read the counters, with running calls'
  reservations counted as used, check, take a place, then add the call and reserve its budget
  (estimated input plus `max_tokens`). Everything after admission runs in a spawned task that
  always ends with `finish`: one `UPDATE` swaps the reservation for the tokens used (as the
  provider reported them, else estimated at four characters a token and marked
  `"estimated": true`), the audit entry is written, and only then is the place given back. So a
  dropped stream or a dropped request still counts and audits its call. With several server
  processes on one database, each process may admit one call over a limit. Refusals are
  `429 rate_limited` with `Retry-After`. Usage is shown in tokens and calls, never in money.
- **Audit.** Every call writes `ai.called` (purpose, provider kind and scope, model, input and
  output tokens, outcome `ok`, `failed` with its reason, or `cancelled`), never the prompt or the
  answer. Configuration writes `ai.provider_created|updated|deleted|tested`,
  `ai.notice_acknowledged` and `datasource.ai_access_changed` (with the number of excluded fields,
  not their names).
- **Privacy.** Chats are stored per user and organization (`ai_chats`, `ai_chat_messages`,
  migration 0022) and deleted `ai.chat_retention_days` (default 30, 0 keeps none; an organization
  may only shorten it, `ai::service::chat_retention_days`) after their last message by an hourly
  job (`ai::chats::spawn_retention`); nobody else reads them, admins included, and their owner
  deletes one or all at any time. A stored tool result holds only what went to the provider.
  Usage rows hold counts only. The audit retention covers the call entries.
- **Screens.** The approved boards are `docs/design/blueprint/AI.dc.html` (Verwaltung > KI, KI der
  Organisation, the source's KI part with "Felder ausnehmen", the notice, explain and draft in
  Explore, summarize at the result and in the panel menu, the chat's history and source picker)
  and `DataChat.dc.html` ("Fragen", with the changes frame 11 of the AI board lists). The UI lives
  in `ui/src/features/ai` (the chat in `ui/src/features/ai/chat`).
- **Plain calls** (`server/src/routes/ai_calls.rs`, docs/api/ai.md "Explain, draft and
  summarize"): explain, draft and summarize call `ai::service::stream` with the feature's
  versioned prompt (`ai::prompts`) and answer with server-sent events (`meta`, `text`, `done` or
  `error`). Not the live WebSocket: each call is one request and one answer, and closing the
  request cancels the call, which the service then counts and audits as `cancelled`. Explain and
  draft need `datasources:query` on the source and add its schema only when it is open to AI.
  Summaries run the query again on the server as the caller (a free query in Explore, or a
  panel's stored queries for whoever may read the dashboard), refuse a closed source before
  anything runs, and pass the results through `ai::redact`; a panel's own steps run on the server
  first and its hidden queries stay out. The switch, provider, notice and
  daily limits are checked first (`service::precheck`), so a refused call runs no query. A draft
  is only returned in the source's query form; running it goes through the normal read-only
  checks. Untrusted text (queries, requests, titles, schemas, results) goes into the user message
  in `<kalzit:...>` blocks that cannot be closed from inside; the system prompt names the blocks
  as data whose instructions are never followed.
- **The agent chat "Fragen"** (`server/src/routes/ai_chat.rs`, `ai::tools`, `ai::chats`;
  docs/api/ai.md "Chat"). A question is stored, then answered in rounds: each round is one
  `service::stream` call with the versioned `CHAT` prompt and the tool definitions, so every round
  is admitted, counted and audited like any AI call. The provider trait carries tool calls for
  both APIs (`Part::ToolCall`, `Part::ToolResult`, `ChatEvent::ToolCall`; OpenAI `tool_calls` and
  `role: tool` messages, Anthropic `tool_use` and `tool_result` blocks). The tools are
  `list_datasources`, `get_schema`, `run_query`, `find_panels`, `run_panel` and `propose_query`;
  each call is authorized in `ai::tools` with the asker's `OrgCtx` exactly as the matching route
  would (`datasources:query` for schema and free queries, `dashboards:read` for a panel's stored
  queries, so viewers ask about the panels they see), needs the source open to AI and chosen in
  the composer, runs through the normal query path, and passes its result through `ai::redact`.
  Free queries are refused on outward-facing kinds (`tools::outward_facing`: `http_json` and
  every plugin kind), where the model would choose where a request goes; `run_panel` refuses a
  panel whose stored queries name an excluded field or whose steps read one, and redacts all its
  results with the merged rules of its sources. A refused call is a result with an error the model reads, never a failure of the answer. Each
  call is shown in the chat as it starts and ends (`tool`, `toolResult`) and audited as
  `ai.tool_called` (tool, source or dashboard, query, rows, outcome; no result data). At most
  `ai.max_tool_calls` calls per answer; past it, the model gets one round to answer in words. The
  answer runs in a task of its own that streams to the request through a channel and stores the
  answer when it ends, also when the person stops it (closing the request drops the channel,
  which cancels the round and the running tool). The conversation the provider gets is rebuilt
  from the stored chat (the newest twelve questions); results of sources the person lost or that
  were closed to AI since are withheld there and in the API, and the results still shown are
  redacted again with the rules as they are now (`redact::restrict_stored`). Where a result shows
  less than the model saw, the answer's text, call arguments, model-written queries and proposals
  are withheld too (`chats::checked_turn`), so they are neither shown nor sent again; the stored
  chat itself never changes. A chat answers one question at a
  time. A question may name a dashboard as context (`dashboards:read`); its title and panels go
  to the model fenced. `run_panel` runs the panel's enabled steps on the server, as summaries do.
- **A provider per function.** `ai.provider_explain`, `ai.provider_summarize` and
  `ai.provider_chat` choose a server provider per function (`service::in_effect_for`, from the
  call's purpose); an organization's own provider still applies to all functions. The notice is
  per provider, so the status names each function's provider with its acknowledgement, endpoint,
  last test and whether data leaves the own network: as the administrators set it on the provider
  (`leaves_network`, `yes` or `no`), or, left open, judged from its address
  (`service::stays_in_network`, reported as `leavesNetworkEstimated`).
- **Prompt injection (tool use in the chat).** Everything that comes back
  from a data source, a document or a web page is untrusted input to the model: it may contain
  text written to steer it. So tools are read-only by construction (they run queries through the
  normal read-only query path with the asking user's rights, never anything that writes, sends or
  changes settings); tool calls are capped (`ai.max_tool_calls`) and each one is audited; a tool
  never sees keys or connection settings; results go through `ai::redact` like any other data;
  and anything that would change state (saving a dashboard or analysis the model drafted) is
  only offered to the user and happens after their explicit confirmation in the UI, never as a
  tool call. The model's answer is shown as text; the UI never runs it as code or follows a link
  in it on its own.
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

- Linux packages (`deploy/linux`, built with nfpm by `deploy/linux/package.sh`): the deb and rpm
  install `/usr/bin/kalzit`, the unit `kalzit.service`, `/etc/kalzit/kalzit.toml` (`root:kalzit`,
  `0640`, kept on updates) and the marker `/usr/lib/kalzit/package` (`deb` or `rpm`). The
  scripts create the system account `kalzit`, the data directory `/var/lib/kalzit` (`0700`) and,
  on a first installation whose data directory holds no secrets yet, the secrets key in the
  credential store (`systemd-creds encrypt --with-key=host` into `/etc/credstore.encrypted`, else
  `/etc/credstore` readable by root), which the unit imports (`ImportCredential=`). The unit runs
  `kalzit --config /etc/kalzit/kalzit.toml serve` as `kalzit` with `CAP_NET_BIND_SERVICE` only and
  hardening that leaves the plugin sandbox intact: `ProtectSystem=strict` with
  `ReadWritePaths=/var/lib/kalzit`, `NoNewPrivileges`, `PrivateTmp`, `PrivateDevices`, the
  `Protect*` kernel, clock, host name and `/proc` settings, `RestrictNamespaces=~cgroup mnt pid
  uts` (user, IPC and network namespaces stay for plugins), `SystemCallFilter=@system-service`
  plus the Landlock calls and `setsid`, `RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
  AF_NETLINK` (`AF_UNIX` for the plugin sockets). The sandbox clears the ambient capability set
  and drops the bounding set before a plugin's exec, so `CAP_NET_BIND_SERVICE` never reaches a
  plugin. The deb also ships `/etc/apparmor.d/kalzit` (unconfined, `userns,`), loaded in postinst,
  because Ubuntu's AppArmor otherwise refuses the plugin sandbox its user namespaces. The scripts
  refuse an existing `kalzit` account that is not a system account, has a login shell, or whose
  group has other members. `kalzit sandbox-check` starts a test program (`kalzit sandbox-probe`)
  the way a plugin is started and prints the layers in force and the program's capability sets;
  CI (`.github/scripts/package-smoke.sh`) runs it inside a copy of the unit and outside, and fails
  when the unit takes a layer away, a namespace layer is missing or a capability reaches it.
  Removing keeps data, configuration and key; only `apt purge` deletes them. The updater leaves
  a packaged binary to the package manager (`updates.mode_deb`, `updates.mode_rpm`, see Updates).
  The packages require the glibc version the binary needs (read from its symbol versions).
- Linux (systemd) without the packages: run as a dedicated user and let systemd create the
  directories:

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
- Windows: Kalzit is its own Windows service (`server/src/service.rs`), set up by the MSI package
  (`packaging/windows`, WiX v5) or by `kalzit service install`; installation guide in
  docs/guide/installation.md, "Windows".
  - The service `Kalzit` runs `kalzit.exe service run --config
    %ProgramData%\Kalzit\kalzit.toml` as the virtual account `NT SERVICE\Kalzit` and starts
    automatically. `service run` hands the main thread to the service control dispatcher; the
    server runs as `kalzit serve` would, reports `START_PENDING` with progress until its listeners
    are bound (`server::on_started`), then `RUNNING`. Stop ends it through `server::request_stop`
    with the normal grace (10 s, then the database closes); a system shutdown gets the short
    grace (3 s) of a console close. It ends with exit code 0, `RESTART_EXIT` (3, service-specific)
    when an update or a return asked for a restart, and 1 on a failure.
  - The log goes to `<data dir>\logs\kalzit.log` (rotated at 10 MiB, three older files kept, no
    terminal colors), after the data directory was prepared and checked, so the folder is private
    before anything is written into it. What fails before that file is open (the configuration,
    the data directory) goes to the Windows event log, Application, source `Kalzit`; the MSI
    registers the source with the general message file of .NET Framework so the text shows as
    written. `kalzit service configure` and `cleanup` report their errors there as well, since
    the installer runs them without a console.
  - `kalzit service configure` (run by the MSI after `InstallServices` and before
    `StartServices`, as LocalSystem, only at the first installation and at upgrades, never at a
    repair; and by `kalzit service install`) runs as SYSTEM over folders a user may have prepared
    beforehand, so it takes over nothing it did not make or Kalzit made, and refuses instead,
    with the reason in the event log. The MSI runs both of its steps (configure, cleanup) from
    its own copy of `kalzit.exe` in the Binary table, which msiexec unpacks into its protected
    folder (`--program` names the installed file), never from the installed program, which the
    service account may change with self-update. `icacls`, `sc` and `netsh` are called by their
    full path in System32 (`GetSystemDirectoryW`), never by a bare name the program folder could
    answer. `kalzit.exe` is linked with `/DEPENDENTLOADFLAG:0x800` and calls
    `SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32)` first thing, so neither its imports
    nor DLLs loaded later come from the program folder. Paths are normalized before any
    comparison with system folders (`\\?\`, device and network paths and `.`/`..` refused, the
    deepest existing folder resolved with `GetFinalPathNameByHandleW`). A quote in any MSI
    setting stops the installation through a launch condition:
    - The program folder first, before anything else is touched: not a drive root, Program
      Files or the Windows folder itself, nothing in it but Kalzit's files (`kalzit.exe`,
      `LICENSE.txt` and what the updater leaves), nobody else may change it (installer service
      entries aside), no link or junction on its path, and no folder above it lets others
      rename or remove what is inside (`TAKEOVER_MASK`: delete, delete child, write DAC or
      owner, full control; inherit-only entries do not count). Then it gets a protected list:
      SYSTEM and Administrators full, Users read and execute, the service account modify with
      self-update; owner Administrators; and its content is checked again. It is not added to
      `PATH`.
    - `%ProgramData%\Kalzit`: created for Administrators to write and everyone to read; an
      existing one is accepted only as Kalzit makes it (owner SYSTEM, Administrators, or the
      service account with a limited owner entry; nobody else may write). An existing
      `kalzit.toml` is kept (an upgrade, with its ports and data directory) only when it is a
      regular file only Administrators may change; else the installation stops.
    - The data directory may not be a drive root, a system folder (`%ProgramData%`, `C:\Users`,
      profiles) or lie in Windows, Program Files or the program folder; the folders above it must
      pass the same check as the program folder's. A new one is created with its protected list
      (Administrators and the service account, owner Administrators) from its first moment. An
      existing one is walked first: any link or junction in it, any object owned by someone else
      or open to anyone else (below `plugins`, the sandbox's plugin and start SIDs and
      AppContainers aside) stops the installation. Then every object gets the protected list and
      Administrators as owner, except below `plugins`, whose grants the sandbox needs.
    - The service account's SID is `S-1-5-80-` plus the SHA-1 of the upper-case service name
      (`service::service_sid`), so it is known before the MSI creates the service and stays the
      same when the service is created again.
    - With HTTPS `self-signed` it makes a certificate (rcgen) for the computer name, `localhost`,
      `127.0.0.1` and `::1` in `<data dir>\tls` (reused only after the data directory passed the
      walk above). With `certificate` the files must be regular files only Administrators may
      change, the key also one only they may read, below folders nobody else may rename; then
      the service account gets read access where they are, so a renewal needs no reinstallation.
    - It limits the service to `SeChangeNotifyPrivilege` (`sc privs`): no `SeImpersonate` or
      `SeAssignPrimaryToken`, through which a compromised service could become SYSTEM. The plugin
      sandbox needs none of them (a restricted copy of the own token needs no privilege). It sets
      the recovery actions (restart after 2 s, 5 s, then every 30 s; the count resets after a day)
      and turns them on for stops with an error code, too, and opens the firewall when asked
      (inbound rule `Kalzit`, TCP, the configuration's ports).
    - Values come in with a space before the closing quote (`"[DATADIR] "`), so a folder ending
      in a backslash does not escape the quote; a value with a quote is refused.
  - Self-update is off by default (`SELFUPDATE=0`, `--self-update 0`): only SYSTEM and
    Administrators may change the program folder, and updates come with a new MSI (or
    `kalzit update apply`). With 1 the service account may modify it, so the updater can swap the
    binary, as on Linux with a binary owned by the service account; then the service account can
    change code an administrator might run elevated, which the installation guide warns about.
  - `kalzit service cleanup` (before the MSI removes the program, not during an upgrade, and in
    `kalzit service uninstall`) removes the firewall rule and, with `REMOVEDATA=1` /
    `--remove-data`, the data directory and `kalzit.toml`. A data directory is removed only when
    no link or junction lies on its path, the folders above it are safe, the folder opened
    without following links is the one the path names (`GetFinalPathNameByHandleW`), it is not a
    drive root and it is empty or holds Kalzit's files (`kalzit.db`, `updates`,
    `secrets.key.dpapi`, ...); anything else is left with a note. `remove_dir_all` removes links
    inside as links.
  - At every start, `data_dir::prepare` also checks `updates`, `plugins`, `tls` and `logs` in the
    data directory: real folders (no link or junction), as private as the data directory.
  - The MSI package: per machine, x64, program folder `C:\Program Files\Kalzit` (remembered in
    `HKLM\Software\MouseWerk\Kalzit`). A major upgrade removes the previous version completely
    first (`afterInstallValidate`), so a `kalzit.exe` the updater replaced in the meantime does not
    confuse file versioning; the configuration and data are not part of the package and stay. The
    wizard (WixUI dialogs plus a settings page) asks for the program folder, port, data folder,
    HTTPS mode, HTTPS port, certificate and key, and the firewall, and skips the settings when
    `kalzit.toml` exists; removing asks whether the data goes too. Every setting is also an MSI
    property for silent installations.
  - Running Kalzit as LocalSystem or another account works as before: the data directory must
    then belong to that account or Administrators, without access for others (Kalzit creates
    `%ProgramData%\Kalzit\data` that way on its first start). Changing the account later means
    granting the new one access to the data directory (`icacls ... /grant "NT SERVICE\Kalzit":(OI)(CI)F`)
    and making it or Administrators the owner.

## HTTPS certificates

`server/src/tls.rs` builds the rustls configuration (ring, TLS 1.2 or 1.3, ALPN `h2` and
`http/1.1`). With `tls.cert_file` and `tls.key_file` it serves those files and reloads them when
they change. Without them, the HTTPS listener asks `acme::resolver::Certificates` for every
handshake: the certificate ACME issued, until then a self-signed one made at the start (names
from the ACME settings or `server.public_url`); a client that offers only the ALPN protocol
`acme-tls/1` gets the TLS-ALPN-01 challenge certificate of the name it asks for (RFC 8737), or no
certificate. A new certificate takes effect for the next handshake; nothing restarts. The start
refuses HTTPS without certificate files while ACME is off in the stored settings (fail closed);
HTTP-01 orders and stores a certificate while HTTPS is still off, so HTTPS can then start with it.

ACME (`server/src/acme`, RFC 8555 through the `instant-acme` crate):

- **Settings** (`acme::settings`): one value `tls.acme` in `server_settings`, with a version,
  saved by `PUT /api/admin/acme` in one step after the checks (each field, the listeners the
  challenge needs, the directory fetched over HTTPS, every name resolved); the first problem is
  answered with its field and an `acme.*` reason. They are not registry settings: their fields
  depend on each other, so the settings page saves them together instead of one by one with undo
  (CLAUDE.md).
- **Transport** (`acme::transport`): the protocol's requests go through Kalzit's one HTTP client
  (`crate::http`): system certificates plus an optional CA for a custom directory, no proxy, the
  target check (never a metadata address or Kalzit's own database).
- **Order** (`acme::issue`): the account of the directory (registered on first use, its contact
  updated when it changed, registered again when the CA no longer knows it), an order for all
  names, per name the chosen challenge answered by this server (HTTP-01 from a token map that
  `GET /.well-known/acme-challenge/{token}` serves on every listener, TLS-ALPN-01 from the
  resolver), polling until ready, a new P-256 key and CSR, polling for the chain. Challenge
  answers are removed when the order ends, whatever happened.
- **Schedule** (`acme::spawn`, a background task of the server): an order is due when ACME is on
  and no stored certificate matches the names and directory, when two thirds of its lifetime
  have passed, or on request (`POST /api/admin/acme/renew`, refused during a failure's pause and
  for a matching certificate younger than a third of its lifetime). A failure waits 5, 15, 60,
  180, 360, then 720 minutes before the next attempt; a save with other settings resets the wait.
  An issued certificate counts only once the resolver serves it; one that could not be stored
  stays in use from memory and storing is retried after the pause, without a new order.
  `/.well-known/acme-challenge/` looks up only base64url tokens.
- **Store** (`acme::store`): `acme/account-<hash of the directory URL>.enc` and
  `acme/certificate.enc` in the data directory (`0700` folder, `0600` files on Unix, written
  through a temporary file and a rename), each AES-256-GCM encrypted with the secrets key, owner
  `acme` and the file's purpose as associated data. `kalzit secrets rotate` re-encrypts them after
  the database. A file that cannot be read is logged and a new certificate is ordered.
- **Audit**: `tls.acme_changed`, `tls.certificate_requested` (by an administrator),
  `tls.certificate_issued` and `tls.certificate_failed` (by the server, with reason and next
  attempt). Private keys and the contact address never reach the log or the audit log.

Several servers behind one load balancer each order and answer for themselves; HTTP-01 answers
live in one process's memory. CI orders real certificates from pebble, Let's Encrypt's test
server (job `acme`, `server/tests/acme_pebble.rs`); the checks and routes are unit-tested on
Windows and Linux (`acme::api_tests`).

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
  in the job that holds the key. Windows files are signed with Authenticode in two small jobs
  (`windows-sign-exe`, `windows-sign-msi`) that alone use the environment `windows-signing`,
  which holds only the code-signing secrets; the MSI is built from the signed program in between,
  in a job without any secret (`windows-msi`), which also runs the signed program once and checks that the package carries exactly it, as installed file and as setup copy (`packaging/windows/check-msi.ps1`). Signing uses Microsoft Artifact Signing (the key
  stays in Microsoft's HSM; recommended) or a PFX imported into the runner's user store for the
  signing only; nothing but signtool runs while key material is present
  (`packaging/windows/sign.ps1`, docs/operations/updates.md). Without either both stay unsigned
  and the release notes say so. The MSI
  is listed in the manifest under `installers` (signed like a package, with no offline package):
  the updater never installs it, and older servers ignore the field.
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
  (`exec`), so systemd keeps the same main process and no privilege is needed. The Windows
  service reports `STOPPED` with `RESTART_EXIT`, and its recovery actions (on for stops with an
  error code) make the service manager start the service again two seconds later, which runs the
  binary now at the service's path; a console server on Windows starts the binary as a child.
- **Trial and return.** `updates::boot::guard` runs first at `kalzit serve`, before the database
  opens. The new version's first start marks the plan `trial` and starts a watchdog thread; once
  `/readyz` answers through the router and every listener accepts a connection, the plan is
  removed and the installation recorded. A failed start (migrations), a failed health check or
  the deadline (`updates.health_timeout_secs`, clamped to 15 to 1800 s) mark the plan
  `rollbackRequested` and start the binary again (on Windows a hang only ends the process; the
  return happens at the next start, which for the service the recovery actions make seconds
  later). That start, or any start that finds a `trial` plan (a
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
  Windows when Kalzit runs as its Windows service (`platform::mark_windows_service`) and the
  service account may write the program folder. Everywhere else (a console on Windows, a
  container, a binary owned by root) the server downloads and verifies, and `kalzit update apply` / `kalzit update
  rollback <version>` install with the server stopped (they hold the data directory lock
  exclusively); the next start runs the same trial. These commands usually run as root or an
  Administrator: on Unix, as root on a data directory another account owns, they touch the data
  directory only with that account's user, group and supplementary group ids and switch back to
  root just for the copy into the binary's folder, the smoke test and the rename (the
  supplementary groups are reduced to the owner's group, and an `updates/` folder of another owner
  than the data directory is refused); files from the data directory are opened as regular files
  only (`O_NOFOLLOW`, `O_NONBLOCK`, checked with `fstat`). On Windows they refuse links and
  junctions below `updates/`; the service account could still swap such a folder between that
  check and its use. A Windows service with self-update on installs as the service account
  itself, so nothing runs with more rights there; for the command line, keep the service account
  a virtual account that nothing else uses. The
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
- Screenshots: the images in `README.md` are the gallery renders in `docs/screenshots/gallery/`
  (`npm run gallery`, see `docs/screenshots/README.md`); the user guide's come from
  `npm run screenshots`. Both are taken from the real application at desktop size. `npm run screenshots`
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
  | `installer` | `server` or `packaging/` |

  `docs/api/` and `docs/glossary.md` count as code because server and UI tests read them;
  `server/src/analysis/` (with `conformance.json`) counts for the UI too, whose conformance test
  runs the same cases, and the generated types for the server, whose test compares them. A
  path in no listed area turns every flag on, so a new top-level file runs the full check until
  the script knows it. On pushes to `main` and in the merge queue every flag is on: the queue
  tests each pull request fully on top of `main`.

  `server`, `postgres`, `datasources` and `update-rights` (the privilege switch of the update command
  line, run with sudo against a `kalzit` account) need `server`, `ui` needs `ui`, `e2e` needs `e2e`,
  `audit` needs `audit`, and `msi` (the Windows installer built and installed on the runner,
  `.github/scripts/msi-test.ps1`) needs `installer`. The required checks keep reporting when their area did not change:
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
