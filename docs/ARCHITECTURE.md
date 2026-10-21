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
  `datasource_error`, `datasource_target_blocked`, `query_timeout`, `query_rejected`, `internal`.
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
  "binary" | "int64", "value": string}`. The schema sample gives every path with coverage and
  type shares (finite numbers 0 to 1).
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
  (`datasources.sqlite_dirs`, empty by default, never including the data directory). A server
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
  Rejections answer `query_rejected` with the reason.
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
- At start (`data_dir::prepare`, before the database opens) a missing directory is created
  private from its first moment: on Linux with mode 0700, on Windows through `CreateDirectoryW`
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
  as `scheme:***`; `sqlite:` URLs are shown as they are. Such a URL is refused at load anyway: a
  `database.url` other than `sqlite:` must start with `scheme://`, and the error does not repeat it. The
  `connect` error uses the same function.
- Contents: `kalzit.db` (the default SQLite database, `database.url` unset) with its `-wal` and
  `-shm` files, `setup-token.txt` until the first owner exists, `secrets.lock`, and the fallback
  key file for data source secrets when no other key source is configured (`secrets.key` on
  Linux, `secrets.key.dpapi` on Windows).
- Backups: copy `kalzit.db`, `kalzit.db-wal` and `kalzit.db-shm` together while the server is
  stopped, or use the SQLite backup API (`sqlite3 kalzit.db ".backup backup.db"`), which works
  while the server is stopped or running. Copying only `kalzit.db` of a running server loses
  what is still in the WAL file. Back up the key file too (when it is used); without it stored
  data source secrets cannot be decrypted. A DPAPI key file only works on the same computer.
  To restore, copy the files into the data directory, do not move them: a copy takes the
  directory's private entries, a moved file keeps its old ones, and Kalzit refuses it. Restore
  tools that copy ACLs (`robocopy /COPYALL` or `/SEC`, `xcopy /O`) keep foreign entries as well,
  and Kalzit refuses such files too: use a plain copy, or run `icacls <file> /reset` afterwards.

### Running as a service

- Linux (systemd): run as a dedicated user and let systemd create the directories:

  ```ini
  [Service]
  User=kalzit
  ExecStart=/usr/local/bin/kalzit serve
  StateDirectory=kalzit
  StateDirectoryMode=0700
  ConfigurationDirectory=kalzit
  ```

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
- E2E: Playwright against the production build of the binary, on Linux and Windows (M1 end).
