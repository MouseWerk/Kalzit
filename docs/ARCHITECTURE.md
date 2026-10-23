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
| `server/src/audit.rs` | The audit log (`audit::record`). |
| `server/src/routes/` | One module per API area, each exporting its route table; `table.rs` enforces access. |
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
  (`resource_grants`: subject user/team/role, resource folder/dashboard/datasource, level
  `view|edit|admin` for folders and dashboards, `query|edit|admin` for data sources). Effective
  permission = union. Folder grants inherit to subfolders and dashboards. `resource_grants` has no
  foreign keys (it points at three tables); purging a resource deletes its grants in the same
  transaction.
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
- Projections (documents or graph to a frame) are explicit query steps stored in the query,
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
  `fd00:ec2::254`), and SQLite files outside the directories a server admin allowed
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
- Connections are pooled per data source and rebuilt when its settings change.
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

## Dashboards

- Tables `folders` (nested, `parent_id`), `dashboards` (folder, title, current version, trash),
  `dashboard_versions` (every save, with author and message; restore creates a new version).
- The dashboard model is JSON with `schemaVersion`; the server migrates older models on read, one
  step per version, with a test per step.

  ```ts
  interface DashboardModel {
    schemaVersion: 2;
    title: string;
    timeRange: { from: string; to: string };   // "now-6h", "now", or ISO times
    refreshSeconds?: number;
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
  graph panel types (network, hierarchy, path) on create, save and restore of dashboards and on
  create and save of library panels (which keep no versions), and only for panels the write adds
  or changes, so stored dashboards and library panels keep loading, querying and saving
  unchanged when a rule tightens.
  Reads never run it. A new panel type (the document panels, plugins) adds its own check there
  when it lands, and its default and editor options to the contract fixture
  (`ui/src/panels/contract.test.ts`); unknown types are left alone.

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
  JSON; written to the audit log as `data.exported` (refused ones as `data.export_refused`). At
  most 3 exports make files at once per server; their steps and encoder run in `spawn_blocking`
  and stop on a cancel flag (a drop guard in the handler) and the query timeout. Both engines
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
- `audit_events`: written with `audit::record(&mut tx, &AuditEvent { .. })` inside the
  transaction of the change. Actions are `<area>.<verb>` (`setup.completed`, `auth.signed_in`,
  `auth.sign_in_failed`, `team.created`). Summaries hold ids and changed field names, never
  secrets and never what a user typed (a failed sign-in records the account id if it exists, not
  the email). Events older than `audit.retention_days` (default 365) are deleted (stream B),
  since they hold client addresses.

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
  Linux, `secrets.key.dpapi` on Windows).
- The database file is also checked for a network drive (see "Storage (SQLite)"): a data
  directory on a UNC path, a mapped network drive, NFS, CIFS/SMB or 9p is refused when the
  database opens. Backups and restores are under "Backups".

### Running as a service

- Linux (systemd): run as a dedicated user and let systemd create the directories:

  ```ini
  [Service]
  User=kalzit
  ExecStart=/usr/local/bin/kalzit serve
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
  finds the database busy is tried again after 1, 2 and 4 minutes, as long as that is before the
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
  the SQLite sales fixture, a dashboard with a variable and four panels) and writes PNGs at
  1440x900 to `docs/screenshots/`. The fixture data lies around a fixed moment and the pages run
  on a clock fixed to it; times the server records (sessions, member since, last saved) are
  moved to that moment in the API answers, so reruns give near-identical files. **Every pull request that visibly changes the
  UI reruns `npm run screenshots` and commits the changed images.**
