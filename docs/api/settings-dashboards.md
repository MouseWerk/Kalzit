# API: settings, audit log, folders and dashboards

The routes of settings, the audit view, folders and dashboards, exactly as the server implements
them. All paths are below `/api`. General rules (docs/ARCHITECTURE.md, "API conventions") apply:
JSON in `camelCase`, ids are UUIDv7 strings, times are Unix milliseconds, errors are
`{"error": {"code", "message", "field"?}}`.

Every route checks its access before the body is read:

- without a session: `401 unauthenticated`;
- `/admin/...` as a signed-in non-admin: `403 forbidden`;
- `/orgs/{orgId}/...` for a non-member (or a malformed `orgId`): `404 not_found`;
- a member without the route's permission: `403 forbidden`.

These answers are not repeated per route below. Request bodies reject unknown fields and wrong
types with `422 validation`; query strings likewise (unknown parameters included).

Common shapes:

- **Page**: `{"items": [...], "nextCursor": string | null}`. `?limit=` is 1 to 200 (default 50,
  else `422 validation`, field `limit`); `?cursor=` is the `nextCursor` of the previous page (an
  invalid cursor is `422 validation`, field `cursor`).
- **Version conflict**: `409` with `{"error": {"code": "version_conflict", ...}, "current": <the
  stored resource, in the same shape as the route's answer>}`.
- **Busy**: `503 busy` with `Retry-After: 1` when the database could not give the request its
  lock in time (many writers at once, a backup). It is only answered before anything was
  committed, so nothing was changed: send the request again.
- **Conflict**: `409 conflict` when the resource is in a state that forbids the action (for
  example editing something in the trash), or changed between the server's checks and the change
  ("changed in the meantime": load it again and retry); the message says what to do.

## Access to folders and dashboards

Access to a single folder or dashboard is decided per resource: the member's org-wide permissions
(their role and their teams' roles) plus their grants (`docs/api/access.md`) on it or on a folder
above it. Grants extend a member's rights beyond their role: a viewer with an `edit` grant on a
folder may save, create and delete dashboards there. So the folder and dashboard routes other than
the two lists are open to every member and check the permission named below on the resource;
what lives at the top level, outside every folder, needs the org-wide permission.

```ts
interface ResourceAccess {         // what the caller may do, grants included
  write: boolean;                  // folders: folders:write; dashboards: dashboards:write
  delete: boolean;                 // folders: folders:write; dashboards: dashboards:delete
  permissions: boolean;            // folders: folders:permissions; dashboards: dashboards:share
}
```

Restricted folders: a folder with `restricted: true` and everything below it (subfolders and
their dashboards) exist only for members who may manage folder permissions (`folders:permissions`:
admins and owners) and members with a grant on that folder or a folder below it, directly, through
a team or through a role. The nearest restricted folder above a resource decides: a restricted
subfolder narrows access further, and grants above it do not reach in. A grant on a single
dashboard shows that dashboard (not its folder). For everyone else every route answers
`404 not_found` for them, lists and searches leave them out, and the organization's audit view
leaves out the events about them. The audit view decides by the resource's current place: lifting
a restriction, or moving a folder or dashboard out of a restricted folder, also shows its earlier
events to everyone who may read the audit log.

A folder or dashboard is never shown with the id of a folder the caller cannot see: a folder
reached only through a grant below a hidden restricted folder has `parentId: null` (and hangs at
the top of the tree), a dashboard reached only through its own grant has `folderId: null`. Sending
that `null` back unchanged (`PATCH` of the folder, `PUT` of the dashboard) is no move.

Actions on a whole folder subtree (trash, restore, purge, move):

- `403 forbidden` ("the folder contains content you cannot see") when anything below the folder is
  hidden from the caller;
- `403 forbidden` ("... content you may not change") unless the caller holds `folders:write` on
  every subfolder that another restricted folder governs, and `dashboards:delete` on every folder
  whose dashboards go along (trash, restore, purge);
- moving a folder into or out of a restricted folder changes who sees it, so it needs
  `folders:permissions` on the folder and on the new parent; the same holds for moving a
  dashboard (on its folder and on the target folder).

Whoever restricts a folder, or creates one restricted, through an `admin` grant instead of
org-wide `folders:permissions` gets an `admin` grant on that folder in the same change
(audited as `grant.created` or `grant.changed`): grants above a restricted folder do not reach into
it, and without it they would lose sight of what they just made.

Purging a folder or dashboard deletes the grants on it and on everything purged with it; grants on
trashed resources stay, so a restore brings the access back.

## Settings

### Setting

```ts
interface Setting {
  key: string;                    // "audit.retention_days"
  scope: "server" | "org";
  value: unknown;                 // the value in effect
  default: unknown;
  source: "env" | "file" | "database" | "default";
  editable: boolean;              // false: set in the environment or kalzit.toml, or never UI-editable
  version: number;                // stored version an update must name; 0 = never saved
  description: string;            // English; the UI shows its own texts and uses this only for keys it does not know (SettingKey)
  updatedAt: number | null;       // of the stored value
  updatedBy: string | null;       // user id
}
```

Server settings take the first value found in: the environment, `kalzit.toml`, the database, the
default. Settings that live in the configuration (`sessions.*`) come from `kalzit.toml` and
`KALZIT_<SECTION>_<KEY>` and are never editable in the UI. Every other server setting can be
overridden by `KALZIT_SETTING_<KEY>` (key in upper snake case: `audit.retention_days` is
`KALZIT_SETTING_AUDIT_RETENTION_DAYS`; the value is JSON, or plain text for text settings).
Organization settings are the database value, then the default. A `KALZIT_SETTING_*` variable
that names no such server setting, or holds an invalid value, stops the server at start with a
message naming the variable. On Windows, which reads variable names regardless of case, a name in
any letter case is checked; elsewhere a name not in upper case would never apply and is refused. `source` is `file` whenever `kalzit.toml` sets the key, also to the default value.

Server settings:

| Key | Default | Accepts |
|---|---|---|
| `datasources.sqlite_dirs` | `[]` | up to 100 texts of 1 to 1024 characters |
| `datasources.file_dirs` | `[]` | up to 100 texts of 1 to 1024 characters |
| `datasources.allowed_targets` | `[]` | up to 100 texts of 1 to 1024 characters |
| `datasources.query_timeout_secs` | `30` | whole number 1 to 3600 |
| `datasources.max_rows` | `100000` | whole number 1 to 10,000,000 |
| `datasources.max_response_bytes` | `52428800` | whole number 1024 to 1 GiB |
| `audit.retention_days` | `365` | whole number 1 to 36500 |
| `appearance.default_language` | `"de"` | `"de"`, `"en"` |
| `appearance.default_theme` | `"system"` | `"system"`, `"light"`, `"dark"`, `"contrast"` |
| `sessions.lifetime_hours` | `720` | read-only (configuration) |
| `sessions.idle_timeout_hours` | `168` | read-only (configuration) |
| `dashboards.version_retention` | `100` | whole number 0 to 100000; 0 keeps every version |
| `appearance.product_name` | `"Kalzit"` | text of 1 to 40 characters, one line |
| `appearance.accent` | `"copper"` | `"copper"`, `"blue"`, `"teal"`, `"green"`, `"violet"`, `"rose"`, `"amber"`, `"graphite"`, or `#rrggbb` with at least 3:1 against the lightest light surface (luminance 1.0) and the darkest dark surface (luminance 0.00481) and 4.5:1 for the better of white or the dark label (luminance 0.00579); a refusal names the reached ratios |
| `appearance.density` | `"balanced"` | `"compact"`, `"balanced"`, `"comfortable"` |
| `appearance.font_size` | `14` | `13`, `14`, `15`, `16` (body text in pixels) |
| `appearance.start_page` | `"home"` | `"home"`, `"dashboards"`, `"explore"` |
| `appearance.time_zone` | `"browser"` | `"browser"` or an IANA name |
| `appearance.week_start` | `"monday"` | `"monday"`, `"sunday"`, `"saturday"` |
| `signin.welcome` | `""` | text up to 280 characters, line breaks allowed, no other control characters |
| `signin.notice` | `""` | text up to 2000 characters, line breaks allowed, no other control characters |
| `server.http_addr`, `server.https_addr`, `server.public_url`, `server.redirect_http_to_https`, `tls.cert_file`, `tls.min_version`, `tls.reload_interval_secs`, `security.trusted_proxies`, `security.hsts`, `security.hsts_max_age_secs`, `security.login_max_failures`, `security.login_window_secs`, `log.level`, `log.format` | as `kalzit.toml` | read-only (configuration), source `file`, `env` or `default` |

The product name and the sign-in texts refuse invisible direction and format characters (bidi
embeddings, overrides and isolates U+202A to U+202E and U+2066 to U+2069, the marks U+200E and
U+200F, the zero-width space U+200B, U+2060 to U+2064 and U+FEFF); the joiners U+200C and U+200D,
which scripts need, stay allowed.

The sign-in texts are plain text with a few Markdown marks (`**strong**`, `*emphasis*`,
`[text](https://...)` to http, https and mailto); the UI builds them from elements and never as
HTML.

Organization settings:

| Key | Default | Accepts |
|---|---|---|
| `dashboards.default_time_range` | `{"from": "now-6h", "to": "now"}` | a time range as in the dashboard model; new dashboards without `timeRange` get it |
| `appearance.accent`, `appearance.density`, `appearance.font_size`, `appearance.start_page`, `appearance.time_zone`, `appearance.week_start` | `"inherit"` | `"inherit"` (the server's value) or what the server setting of the same key accepts |

### `GET /admin/settings`

Server administrators. Answers `Page<Setting>` with every server setting in registry order;
`nextCursor` is always `null`.

### `PATCH /admin/settings/{key}`

Server administrators. Body `{"value": unknown, "version": number}`; `version` is the `version`
the client read (0 for a setting never saved). Answers the updated `Setting`.

Errors: `404 not_found` (no such server setting); `409 conflict` when the setting is not editable
in the UI or its value comes from the environment (`source: "env"`) or from `kalzit.toml`
(`source: "file"`); `422 validation` with field `value` (value rejected; checked before the
version); `409 version_conflict` with `current: Setting`. Audited as `settings.updated` (summary:
key and new version, never the value).

### `GET /orgs/{orgId}/settings`

Permission `settings:read`. Answers `Page<Setting>` with every organization setting.

### `PATCH /orgs/{orgId}/settings/{key}`

Permission `settings:write`. Same body, answer and errors as the server route; a server setting's
key is `404 not_found`. Audited as `settings.updated` with the organization id.

### Export and import

`GET /admin/settings/export` (server administrators) and `GET /orgs/{orgId}/settings/export`
(`settings:write`, since it holds only what the caller may change) answer

```ts
interface SettingsDocument {
  format: "kalzit.settings";
  formatVersion: 1;
  scope: "server" | "org";
  exportedAt: number;
  settings: Record<string, unknown>; // every editable setting (not from env or file) with its value
}
```

Secrets never live in the settings registry, so none can be exported.

`POST /admin/settings/import/preview` and `POST /orgs/{orgId}/settings/import/preview` (same
access) take `{"document": SettingsDocument}` and answer `Page<ImportItem>` without changing
anything:

```ts
interface ImportItem {
  key: string;
  status: "change" | "same" | "locked" | "invalid" | "unknown";
  current: unknown;   // null for an unknown key
  imported: unknown;
  version: number;    // what a batch must name
  source: "env" | "file" | "database" | "default" | null;  // null for an unknown key
  message?: string;   // English, for locked and invalid
}
```

A document of another format, version or scope is `422 validation` with field `document`.

`POST /admin/settings/batch` and `POST /orgs/{orgId}/settings/batch` (server administrators;
`settings:write`) take `{"changes": [{"key", "value", "version"} | {"key", "reset": true,
"version"}]}` (1 to 200, each key once) and
apply all of them or none, answering `Page<Setting>` with the new versions. Every entry is checked
before anything is written: an unknown key or a refused value is `422 validation` with field
`changes`, a locked setting `409 conflict`, a stale version `409 version_conflict` with
`current: Page<Setting>` of the named keys. Each change is audited as `settings.updated` with
`"batch": true` in the summary. A `reset` deletes the stored value, so the default applies again
(the answer has `source: "default"` and `version: 0`). Undo is another batch with the new
versions: the previous value for a setting whose `source` was `database`, a `reset` for one that
was `default`, so undo never stores a copy of the default.

## Appearance and brand

### `GET /branding`

Public: what the sign-in page shows anyway. Answers `{productName, logo: {contentType, sha256} |
null, signIn: {welcome, notice}, defaultTheme, accent, density, fontSize}` with the server's
values. The sign-in page applies `defaultTheme` when the visitor chose no theme in this browser;
the language stays the browser's until sign-in.

### `GET /branding/logo`

Public. The logo's bytes with its content type and `ETag` (the SHA-256); `If-None-Match` (a list,
weak tags or `*`) answers `304`. `404 not_found` without a logo. The UI adds `?v=<sha256 prefix>`
(at least 8 hex digits): such a URL is cached `public, max-age=31536000, immutable`, a plain one
`no-cache`.

### `PUT /admin/branding/logo`, `DELETE /admin/branding/logo`, `POST /admin/branding/logo/restore`

Server administrators. `PUT` takes `{"contentType": "image/png" | "image/jpeg" | "image/webp",
"data": base64}` of at most 256 KiB (the request body at most 400 KiB, else `413
payload_too_large`); the bytes must carry the type's signature (SVG is refused, as it can hold
scripts). Answers `{contentType, sha256}`. `DELETE` answers `204`, `404` without a logo. Both keep
the logo before them, and `POST .../restore` (undo) swaps it back: after an upload the earlier
logo (or none) returns, after a removal the removed one. It answers the logo now in effect or
`null`, `404` when there is nothing to swap. Audited as `branding.logo_updated` (type, size,
version), `branding.logo_removed` and `branding.logo_restored`.

### `GET /orgs/{orgId}/appearance`

Any member. The organization's look: `{accent, density, fontSize, startPage, timeZone, weekStart}`,
each the organization's own value or, where it is `inherit`, the server's.

## Audit log

```ts
interface AuditEvent {
  id: string;
  orgId: string | null;           // null for server events such as sign-ins
  actorUserId: string | null;     // null for the system
  actorName: string | null;       // current name; null for the system or a removed account
  actorAddress: string | null;    // client IP address
  action: string;                 // "<area>.<verb>", see below
  resourceType: string | null;    // "folder", "dashboard", "setting", "org", "user"
  resourceId: string | null;
  summary: object;                // ids, counts and changed field names; never secrets or typed text
  createdAt: number;
}
```

Query parameters (all optional): `actor` (user id), `action` (prefix: `dashboard.` or
`dashboard.saved`), `resourceType`, `resourceId`, `from` (inclusive), `to` (exclusive), `limit`,
`cursor`. `from` after `to` is `422 validation` (field `from`); a non-number time is
`422 validation`.

### `GET /orgs/{orgId}/audit`

Permission `audit:read`. `Page<AuditEvent>` of this organization, newest first. `orgId` as a query
parameter is `422 validation`. For members without access to restricted folders:

- events about folders and dashboards they cannot see are left out, also after that content was
  purged (the server remembers which purged folders and dashboards were restricted content);
- a summary's `parentId` or `folderId` that names a folder they cannot see (or a purged restricted
  one) reads `null`.

Counts in summaries (`folder.trashed`: `{"folders", "dashboards"}`) are not narrowed.

### `GET /admin/audit`

Server administrators. `Page<AuditEvent>` of the whole server (sign-ins included), newest first;
`?orgId=` narrows it to one organization; an empty `orgId` is `422 validation` (field `orgId`).

Events older than `audit.retention_days` are deleted every hour; each run that deleted something
records `audit.expired` with `{"deleted": n, "before": ms}`.

Actions written by these routes: `settings.updated`, `branding.logo_updated`, `branding.logo_removed`, `branding.logo_restored`, `folder.created`, `folder.updated`,
`folder.trashed`, `folder.restored`, `folder.purged`, `dashboard.created`, `dashboard.saved`,
`dashboard.version_restored`, `dashboard.trashed`, `dashboard.restored`, `dashboard.purged`,
`audit.expired`.

## Folders

```ts
interface Folder {
  id: string;
  parentId: string | null;        // null: top level, or a parent the caller cannot see
  name: string;                   // 1 to 100 characters, trimmed, no control characters
  restricted: boolean;            // the folder's own flag; subfolders inherit the restriction
  version: number;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;       // set while in the trash
  access: ResourceAccess;
}
interface FolderNode extends Folder { children: FolderNode[] }
```

Folders nest at most 10 levels deep.

### `GET /orgs/{orgId}/folders`

Permission `folders:read`. Answers `Page<FolderNode>` (`nextCursor` always `null`): the tree of
folders not in the trash that the caller sees, each level sorted by name (case-insensitive).

`?trashed=true` answers the trash instead: one `FolderNode` (with empty `children`) per trashed
subtree, its top folder, newest deletion first. What was trashed in one call is one subtree: a
dashboard or subfolder trashed earlier on its own stays a separate entry and is not restored with
its folder.

### `POST /orgs/{orgId}/folders`

Any member. Body `{"name": string, "parentId"?: string | null, "restricted"?: boolean}`. Needs
`folders:write` on the parent (org-wide at the top level); `restricted: true` needs
`folders:permissions` on the parent (org-wide at the top level). Answers `201` with the `Folder`.

Errors: `422 validation` field `name`; `404 not_found` (parent not in the organization or not
visible); `422 validation` field `parentId` (parent in the trash, or too deep); `403 forbidden`
(missing permission).

### `PATCH /orgs/{orgId}/folders/{folderId}`

Any member; needs `folders:write` on the folder. Body `{"version": number, "name"?: string,
"parentId"?: string | null, "restricted"?: boolean}`; a missing field keeps its value,
`"parentId": null` moves the folder to the top level (unless `null` is how the caller sees its
current parent, see "Access"). A move needs `folders:write` on the new parent (org-wide
`folders:write` for the top level, as on create) and the subtree rules above; changing
`restricted` needs `folders:permissions` on the folder (an `admin` grant counts). Answers the
`Folder` (unchanged, with the same version, when nothing changed).

Errors, in this order: `422 validation` field `name`; `404 not_found` (folder or new parent not
visible); `403 forbidden` (a missing permission, or hidden content below a moved folder);
`409 conflict` (folder in the trash); `409 version_conflict` with `current: Folder`;
`422 validation` field `parentId` (moving into itself or a subfolder, parent in the trash, or too
deep); `409 conflict` (the subtree changed in the meantime).

### `DELETE /orgs/{orgId}/folders/{folderId}`

Any member; needs `folders:write` on the folder and the subtree rules above. Moves the folder,
every subfolder and every dashboard in them to the trash (`204`). Already in the trash: `204`
without a change. `409 conflict` when something joined the subtree while the request ran.

### `POST /orgs/{orgId}/folders/{folderId}/restore`

Any member; needs `folders:write` on the folder and the subtree rules above for what comes back.
Takes the folder and whatever was trashed together with it out of the trash; answers the
`Folder`. Not in the trash: the `Folder` unchanged. `409 conflict` when its parent is still in the
trash, or the trash entry changed while the request ran.

### `DELETE /orgs/{orgId}/folders/{folderId}/purge`

Any member; needs `folders:write` on the folder and the subtree rules above. Deletes the folder for
good with all its subfolders, dashboards and their versions (`204`). `409 conflict` when the
folder is not in the trash (also when it was restored while the purge waited).

## Dashboards

The model (`schemaVersion` 2):

```ts
interface DashboardModel {
  schemaVersion: 2;
  title: string;                                // 1 to 200 characters
  timeRange: { from: string; to: string };      // "now", "now-6h", "now-1d/d", "now+15m", or ISO
                                                // 8601: "2026-10-20" or "2026-10-20T08:15:00Z"
                                                // (a time needs a zone: "Z" or "+02:00");
                                                // units s m h d w M y, and fQ, fy for the
                                                // fiscal quarter and year ("now-1fy/fy")
  refreshSeconds?: number;                      // 5 to 86400
  variables?: Variable[];                       // up to 100, default []
  panels?: Panel[];                             // up to 500, default []
  // Time options; each left out while unset, so older dashboards read as before.
  timeZone?: string;                            // "browser" or a zone name ("Europe/Berlin");
                                                // unset: each viewer's own preference
  weekStart?: "monday" | "sunday" | "saturday"; // unset: each viewer's own preference
  fiscalYearStartMonth?: number;                // 1 to 12; unset: January
  nowDelay?: string;                            // "now" stands this far back: 1 to 5 digits
                                                // and s, m, h or d ("1m")
  refreshIntervals?: number[];                  // seconds, 5 to 86400 each, ascending, up to
                                                // 20; offered for the automatic refresh
  sharedCursor?: "off" | "crosshair" | "tooltip"; // the pointer's time in every time panel
}
interface Variable {
  name: string;                                 // letters, digits, _; not starting with a digit; unique
  type: "query" | "custom" | "constant" | "textbox" | "interval";
  label?: string;
  datasourceId?: string;                        // required for "query", not allowed otherwise
  query?: unknown;
  options?: unknown;
  current?: unknown;
}
interface Panel {
  id: string;                                   // 1 to 64 characters, unique in the dashboard
  type: string;                                 // 1 to 64 characters
  title?: string;                               // up to 200 characters, default ""
  grid: { x: number; y: number; w: number; h: number };  // w 1 to 24, x + w <= 24, h 1 to 200, y <= 10000
  targets?: { refId: string; datasourceId: string; query: unknown }[];  // up to 50; refId unique per panel
  transformations?: Step[];                     // analysis steps, up to 50, default []; see "Analysis steps"
  options?: unknown;                            // default {}
  fieldConfig?: unknown;                        // default {}
}
```

### Transformations

`transformations` holds the panel's steps, in order, each `{"id", "type", "disabled"?, ...}`: `id` is
a UUID that stays with the step, `disabled: true` keeps a step without applying it. Steps name the
query they work on by its `refId` in `frame`. The query keeps its own form; nothing a step does
is part of it.

The projection step turns the documents of one query into a frame (docs/PLAN.md, section 1):

```json
{ "id": "0199f0a0-1c2e-7a4b-9e1d-3f5a6b7c8d90", "type": "toFrame", "frame": "A",
  "columns": [{ "path": "createdAt", "type": "time" }, { "path": "items.0.price", "name": "Price" }],
  "disabled": false }
```

- `columns`: 1 to 200, one per frame column. `path` is a dotted field path of 1 to 500 characters;
  inside an array it names the element by index (`items.0.price`), and a path through an array
  without an index reads nothing. `name` (1 to 200 characters) defaults to the path. Neither holds
  control characters, and no two columns have the same name (their own, or the path where they
  have none). `type` is `time`, `number`, `int64`, `string` or `bool`; without it the type is taken
  from the first value. `json` is not a stored type: an object or array read without a type shows
  as JSON, but a step naming `json` is refused. A value that does not fit the type is `null`.
  Numbers in text are read as decimal or hexadecimal numbers, dates as Unix milliseconds or
  RFC 3339 text.
- The UI leaves columns without a path out when it stores the step, and leaves out a step with no
  column left; it does not save a step that breaks these rules, and says so at the field.
- The UI applies the step with the panel's other steps (the shared analysis engine) to the
  documents it holds; a result that is already a frame passes unchanged. The source's notices go
  with the frame.

Unknown fields are refused. The server stores the model with defaults filled in and answers it so;
stored that way it may take at most 1 MiB (1048576 bytes), else `422 validation` field `model`.
A model with a lower `schemaVersion` is migrated on save and on read; a higher one ("comes from a
newer Kalzit") is refused. Invalid models answer `422 validation` with field `model` and a message
naming the place (`model.panels[0].grid: w must be 1 to 24`).

Migration from version 1 to 2: version 1 gave `transformations` no defined content, except the
projections the documents UI stored there as `{"type": "toFrame", "refId", "columns"}`. Those
become version 2 steps (`id` `projection-<refId>`, `refId` renamed to `frame`), keeping the
columns version 2 accepts (a path, a known type, a name not used before); a projection with no
column left, one of a query the panel does not have, an earlier one of the same query (the last
stays, as the documents UI applied it) and every other entry are dropped. Version 2 is one
combined version: the dashboard features (rows, repeats, links, tags, annotation queries, panel
time options, library panels and multi-value variables, docs/api/dashboard-features.md) add their
fields under it, optional and empty by default. A library panel slot (`libraryPanelId`) has no
targets, steps or links of its own: `targets`, `transformations` and `links` must be empty there,
and the library panel's own steps are checked against its own queries.

Saving (create, save, restoring a version) checks `datasources:query` on every `datasourceId` of the
panels and query variables: a data source the caller cannot see is `422 validation` field `model`
("data source ... does not exist"), one they see but may not query is `403 forbidden`.

```ts
interface DashboardSummary {
  id: string;
  folderId: string | null;        // null: top level, or a folder the caller cannot see
  title: string;
  version: number;
  createdAt: number;
  updatedAt: number;
  updatedBy: string | null;
  deletedAt: number | null;
  access: ResourceAccess;
}
interface Dashboard extends DashboardSummary {
  model: DashboardModel;          // migrated to the current schemaVersion
  createdBy: string | null;
}
interface DashboardVersionSummary {
  version: number;
  message: string;                // "" when none was given, and for restores
  authorId: string | null;
  authorName: string | null;      // current name; null once the account is removed
  restoredFrom: number | null;    // the version this one brought back
  createdAt: number;
}
interface DashboardVersion extends DashboardVersionSummary { model: DashboardModel }
```

`message` (on create and save) is optional, up to 500 characters, no control characters except
line breaks (`422 validation` field `message`).

### `GET /orgs/{orgId}/dashboards`

Permission `dashboards:read`. `Page<DashboardSummary>` ordered by title (the database's collation),
then id. Query: `folderId` (only that folder; `404 not_found` if not visible), `q` (part of the
title, any case), `trashed=true` (the trash instead), `limit`, `cursor`. Dashboards the caller
does not see are left out.

### `POST /orgs/{orgId}/dashboards`

Any member; needs `dashboards:write` on the folder (org-wide at the top level). Body
`{"model": DashboardModel, "folderId"?: string | null, "message"?: string}`. A model without
`timeRange` gets the organization's `dashboards.default_time_range`. Answers `201` with the
`Dashboard` (version 1).

Errors: invalid model or message (see above); `404 not_found` (folder not in the organization or
not visible); `422 validation` field `folderId` (folder in the trash); `403 forbidden` (missing
permission); data source check (see above).

### `GET /orgs/{orgId}/dashboards/{dashboardId}`

Any member; needs `dashboards:read` on the dashboard. Answers the `Dashboard`, also while it is in
the trash (`deletedAt` set). `404 not_found` for ids of other organizations and dashboards the
caller cannot see.

### `PUT /orgs/{orgId}/dashboards/{dashboardId}`

Any member; needs `dashboards:write` on the dashboard. Body `{"model": DashboardModel, "version":
number, "message"?: string, "folderId"?: string | null}`. `version` is the version the editor
started from; a missing `folderId` (or the `folderId` as the caller sees it) keeps the folder,
another folder or `null` (top level) moves it, which needs `dashboards:write` there (org-wide at
the top level) and, into or out of a restricted folder, `folders:permissions` on the current and
the new folder. Saves a new version; answers the `Dashboard`. The title follows `model.title`.
Versions beyond `dashboards.version_retention` are deleted, oldest first.

Errors: `404 not_found`; `409 conflict` (in the trash); invalid model or message; folder errors as
on create; `409 version_conflict` with `current: Dashboard`; data source check.

### `DELETE /orgs/{orgId}/dashboards/{dashboardId}`

Any member; needs `dashboards:delete` on the dashboard. Moves it to the trash (`204`); already
there: `204` without a change.

### `POST /orgs/{orgId}/dashboards/{dashboardId}/restore`

Any member; needs `dashboards:delete` on the dashboard. Takes it out of the trash; answers the
`Dashboard`. Not in the trash: the `Dashboard` unchanged. `409 conflict` while its folder is in
the trash; `404 not_found` when it was purged while the restore waited.

### `DELETE /orgs/{orgId}/dashboards/{dashboardId}/purge`

Any member; needs `dashboards:delete` on the dashboard. Deletes it with all versions for good
(`204`). `409 conflict` when it is not in the trash, also when it was restored while the purge
waited.

### `GET /orgs/{orgId}/dashboards/{dashboardId}/versions`

Any member; needs `dashboards:read` on the dashboard. `Page<DashboardVersionSummary>`, newest
version first.

### `GET /orgs/{orgId}/dashboards/{dashboardId}/versions/{version}`

Any member; needs `dashboards:read` on the dashboard. Answers the `DashboardVersion`;
`404 not_found` for a version that does not exist (or was dropped by the retention) and for
anything but plain digits without a leading zero (`01` and `+1` are `404`).

### `POST /orgs/{orgId}/dashboards/{dashboardId}/versions/{version}/restore`

Any member; needs `dashboards:write` on the dashboard. No body. Saves that version's model as a
new version (with `restoredFrom` set, `message` empty) and answers the `Dashboard`. The old model
must pass today's validation (`422 validation` field `model` otherwise) and the data source check.
`409 conflict` while the dashboard is in the trash; `404 not_found` for an unknown version.

## Analysis steps

A panel's `transformations` (and the steps of an Explore query or a free export) are analysis
steps: explicit, ordered steps on the results of the panel's queries, each of which can be turned
off; the queries' own results stay as they are. Nothing is converted unless a step asks for it.
The browser runs them for what it shows (`ui/src/analysis/`); the server runs the same steps for
exports (`server/src/analysis/`), and both engines pass `server/src/analysis/conformance.json`.
Steps work on results in memory, bounded by the queries' row limit; moving heavy grouping into
the database (pushdown) comes later.

Every step is `{ "id": string, "type": ..., "disabled"?: boolean, ... }`: `id` 1 to 64
characters, unique in the list; at most 50 steps. A step reads results by the `refId` of their
query and writes its result back under that `refId`; `frame`, `left` and `right` must name a query
of the panel. Names are 1 to 200 characters without control characters. Unknown fields are
refused.

```ts
type Step = { id: string; disabled?: boolean } & (
  | { type: "toFrame"; frame: string;                                       // documents to a frame
      columns: { path: string; name?: string; type?: "string" | "number" | "int64" | "bool" | "time" }[] }
  | { type: "calculate"; frame: string; name: string; expression: string }  // expression up to 2000 characters
  | { type: "join"; left: string; right: string;                           // left and right differ
      on: { by: "time" } | { by: "key"; leftField: string; rightField: string };
      mode: "inner" | "left" | "outer" }
  | { type: "reduce"; frame: string; fields: string[];                     // 1 to 50 fields
      stats: ("count" | "sum" | "mean" | "median" | "min" | "max" | "stddev" | "percentile")[];  // each once
      percentiles?: number[] }                                              // 1 to 10, 0 to 100, with "percentile" only
  | { type: "trend"; frame: string; field: string; x?: string;
      output: "fitted" | "summary"; name?: string }                         // name for "fitted" only, required there
  | { type: "movingAverage"; frame: string; field: string; window: number; name: string }  // window 1 to 10000
  | { type: "correlate"; frame: string; x: string; y: string }
  | { type: "compare"; frame: string; field: string; time?: string;
      period: "week" | "month" | "year"; output: "previous" | "difference" | "percent"; name: string }
  | { type: "group"; frame: string; by: string[];                           // 1 to 10 fields
      aggregations: { field: string; op: Agg; name?: string }[] }           // up to 50
  | { type: "pivot"; frame: string; row: string; column: string; value: string; op: Agg }
);
type Agg = "count" | "sum" | "mean" | "median" | "min" | "max" | "stddev" | "first" | "last";
```

- **toFrame** (the projection) turns the `documents` result of `frame` into a frame, one column
  per field path (dotted, array indexes as numbers: `items.0.price`), named `name` or the path,
  typed `type` or by the first value; values that do not fit the type are empty. 1 to 200 columns,
  paths 1 to 500 characters, column names unique. The steps after it work on that frame; a
  result that already is a frame passes unchanged. Documents are no frame for any other step.
  The documents UI edits the projection; it lives in the panel's `transformations`, not in the
  query (a decision recorded in docs/PLAN.md, section 13).
- **calculate** adds the field `name`, typed by its expression.
- **join** matches the rows of `right` to those of `left`, by the first `time` field of each or by
  key fields (`number` and `int64` keys match each other, other types only their own; empty keys
  never match). `inner` keeps matched rows, `left` all rows of `left`, `outer` all rows of both.
  The result takes the place of `left`, `right` is used up. Its first field is the key; the other
  fields are named `<refId>.<field>` (`A.revenue`, `B.sessions`), so a later formula can span both
  queries. A join by time is sorted by time; at most 500,000 rows.
- **reduce** answers one row per field: `field`, then each measure (`count`, `sum`, `mean`,
  `median`, `min`, `max`, `stddev`, `p90`, ...). `stddev` is the sample standard deviation;
  percentiles interpolate between the closest ranks (Excel's PERCENTILE.INC).
- **trend** is the least-squares line of `field` over `x` (the first time field when `x` is
  absent, else the row number): `fitted` adds the line's value per row, `summary` answers `field`,
  `slope` (per day over time), `intercept`, `r2`, `n`.
- **movingAverage** adds the trailing mean over `window` rows, empty until the window is full.
- **correlate** answers `x`, `y`, Pearson's `r` and `n`.
- **compare** adds the value exactly one week, calendar month or year earlier (UTC; 31 March
  compares with the last day of February), the difference, or the change in percent. The query's
  time range has to cover both periods.
- **group** answers one row per distinct combination of `by`, in the order they first appear,
  one field per aggregation (`op(field)` unless named). `sum`, `mean`, `median`, `stddev` need
  numbers; `min` and `max` also take `int64`, `time` and `string`; `count`, `first`, `last` any
  field. **pivot** answers one row per value of `row` and one field per value of `column` (at most
  500).
- Empty values are left out of every statistic and aggregation.
- Bounds, the same in the browser and on the server: a step makes at most 5,000,000 cells (rows
  times fields, checked before it builds them: `steps.too_many_cells`); the steps of one run make
  at most 67,108,864 UTF-16 units of text, calculated text and the copies a join makes
  (`steps.too_much_text`).

Saving checks each step's form and bounds and parses every expression (syntax errors name the
place: `model.panels[0].transformations[1].expression: unexpected input at 4`). Field names and
types are checked when a step runs, since only then the fields are known; the browser shows the
reason at the step and the export routes answer it (docs/api/datasources.md, "Reasons").

### Expressions

A small language over the fields of one frame, parsed and type-checked, never evaluated as code.
Positions count characters from 1.

- Values: numbers (`1.5`, `2e3`), text (`'...'` or `"..."` with `\'`, `\"`, `\\`, `\n`, `\t`),
  `true`, `false`, `null`; fields by a bare name (`betrag`, `A.umsatz`: letters, digits, `_`, `.`)
  or any name in brackets (`[Umsatz (€)]`, `]]` for a `]`).
- Operators by precedence: `or` `||`, `and` `&&`, `not` `!`, comparisons `=` `==` `!=` `<>` `<`
  `<=` `>` `>=` (not chained), `+` `-`, `*` `/` `%`, unary `-`, `^` (right to left; `-2^2` is
  -4). Keywords and function names ignore case.
- Types: `number` (also `int64` fields, as the nearest double: digits beyond 2^53 are lost),
  `text`, `bool`, `time` (Unix ms). `time - time` is a number of ms, `time ± number` a time,
  `text + text` joins; `json` fields cannot be used.
- Empty values: arithmetic and comparisons with an empty value are empty; `and`/`or` use
  three-valued logic; division by zero and results that are not finite are empty; comparing with
  the literal `null` is refused (use `isnull`).
- Functions: `if`, `coalesce`, `isnull`, `round(x, digits?)` (half away from zero, 0 to 15
  digits), `floor`, `ceil`, `abs`, `sqrt`, `exp`, `ln`, `log10`, `pow`, `min`, `max` (numbers,
  text or times; empty values left out), `year`, `month`, `day`, `hour`, `minute`, `second`,
  `weekday` (1 Monday to 7 Sunday), `startOf(t, 'minute' | 'hour' | 'day' | 'week' | 'month' |
  'quarter' | 'year')`, `concat`, `text` (numbers as JavaScript writes them, times as ISO 8601),
  `number`, `lower`, `upper`, `length`, `contains`. Calendar functions use UTC; a time outside the
  years 1 to 9999 is empty.
- Limits: 2000 characters, nesting 64 levels while parsing and a tree at most 128 high (chains
  inside parentheses grow it), 100 values per call, text results at most 32,767 UTF-16 units per
  cell (`expression.text_too_long`).
- `int64` text and `number(...)` read one grammar: an optional sign, digits with an optional
  fraction and exponent, ASCII spaces around; anything else is empty. Group keys and `min`/`max`
  of `int64` compare exactly; cells that do not read are left out.
- Both engines agree exactly, except `exp`, `ln`, `log10`, `pow` and `^`, whose platform libraries
  may round the last bit differently (one unit in the last place). Numbers are written as
  ECMAScript `Number::toString` writes them (`ryu-js` on the server).
