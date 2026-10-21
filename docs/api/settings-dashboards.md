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
- **Conflict**: `409 conflict` when the resource is in a state that forbids the action (for
  example editing something in the trash); the message says what to do first.

Restricted folders: a folder with `restricted: true` and everything below it (subfolders and
their dashboards) exist only for members who may manage folder permissions (`folders:permissions`:
admins and owners) and members with a grant (`docs/api/access.md`) on that folder or a folder
below it, directly, through a team or through a role. The nearest restricted folder above a
resource decides: a restricted subfolder narrows access further, and grants above it do not reach
in. A grant on a single dashboard shows that dashboard (not its folder). For everyone else every
route answers `404 not_found` for them, lists and searches leave them out, and the organization's
audit view leaves out the events about them. A folder someone reaches only through a grant below a
hidden restricted folder appears at the top of their tree with `parentId: null`.

Purging a folder or dashboard deletes the grants on it and on everything purged with it; grants on
trashed resources stay, so a restore brings the access back.

Actions on a whole subtree (trash, restore, purge, move) answer `403 forbidden` ("the folder
contains content you cannot see") when anything below the folder is hidden from the caller.

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
  description: string;            // English, for tooltips until the UI has its own texts
  updatedAt: number | null;       // of the stored value
  updatedBy: string | null;       // user id
}
```

Server settings take the first value found in: the environment, `kalzit.toml`, the database, the
default. Settings that live in the configuration (`sessions.*`) come from `kalzit.toml` and
`KALZIT_<SECTION>_<KEY>` and are never editable in the UI. Every other server setting can be
overridden by `KALZIT_SETTING_<KEY>` (key in upper snake case: `audit.retention_days` is
`KALZIT_SETTING_AUDIT_RETENTION_DAYS`; the value is JSON, or plain text for text settings).
Organization settings are the database value, then the default. A `KALZIT_SETTING_*` variable that
names no such server setting, or holds an invalid value, stops the server at start with a message
naming the variable. `source` is `file` whenever `kalzit.toml` sets the key, also to the default
value.

Server settings:

| Key | Default | Accepts |
|---|---|---|
| `datasources.sqlite_dirs` | `[]` | up to 100 texts of 1 to 1024 characters |
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

Organization settings:

| Key | Default | Accepts |
|---|---|---|
| `dashboards.default_time_range` | `{"from": "now-6h", "to": "now"}` | a time range as in the dashboard model |

### `GET /admin/settings`

Server administrators. Answers `Page<Setting>` with every server setting in registry order;
`nextCursor` is always `null`.

### `PATCH /admin/settings/{key}`

Server administrators. Body `{"value": unknown, "version": number}`; `version` is the `version`
the client read (0 for a setting never saved). Answers the updated `Setting`.

Errors: `404 not_found` (no such server setting); `409 conflict` (not editable, or set in the
environment); `422 validation` with field `value` (value rejected; checked before the version);
`409 version_conflict` with `current: Setting`. Audited as `settings.updated` (summary: key and
new version, never the value).

### `GET /orgs/{orgId}/settings`

Permission `settings:read`. Answers `Page<Setting>` with every organization setting.

### `PATCH /orgs/{orgId}/settings/{key}`

Permission `settings:write`. Same body, answer and errors as the server route; a server setting's
key is `404 not_found`. Audited as `settings.updated` with the organization id.

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
  summary: object;                // ids and changed field names, never secrets or typed text
  createdAt: number;
}
```

Query parameters (all optional): `actor` (user id), `action` (prefix: `dashboard.` or
`dashboard.saved`), `resourceType`, `resourceId`, `from` (inclusive), `to` (exclusive), `limit`,
`cursor`. `from` after `to` is `422 validation` (field `from`); a non-number time is
`422 validation`.

### `GET /orgs/{orgId}/audit`

Permission `audit:read`. `Page<AuditEvent>` of this organization, newest first. `orgId` as a query
parameter is `422 validation`. Events about folders and dashboards the caller cannot see (see
"Restricted folders") are left out; events of purged resources stay, since they hold only ids.

### `GET /admin/audit`

Server administrators. `Page<AuditEvent>` of the whole server (sign-ins included), newest first;
`?orgId=` narrows it to one organization; an empty `orgId` is `422 validation` (field `orgId`).

Events older than `audit.retention_days` are deleted every hour; each run that deleted something
records `audit.expired` with `{"deleted": n, "before": ms}`.

Actions written by these routes: `settings.updated`, `folder.created`, `folder.updated`,
`folder.trashed`, `folder.restored`, `folder.purged`, `dashboard.created`, `dashboard.saved`,
`dashboard.version_restored`, `dashboard.trashed`, `dashboard.restored`, `dashboard.purged`,
`audit.expired`.

## Folders

```ts
interface Folder {
  id: string;
  parentId: string | null;        // null: top level
  name: string;                   // 1 to 100 characters, trimmed, no control characters
  restricted: boolean;            // the folder's own flag; subfolders inherit the restriction
  version: number;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;       // set while in the trash
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

Permission `folders:write`. Body `{"name": string, "parentId"?: string | null, "restricted"?:
boolean}`. Answers `201` with the `Folder`.

Errors: `422 validation` field `name`; `404 not_found` (parent not in the organization or not
visible); `422 validation` field `parentId` (parent in the trash, or too deep); `403 forbidden`
(no `folders:write` on the parent, or `restricted: true` without `folders:permissions`).

### `PATCH /orgs/{orgId}/folders/{folderId}`

Permission `folders:write` on the folder. Body `{"version": number, "name"?: string, "parentId"?:
string | null, "restricted"?: boolean}`; a missing field keeps its value, `"parentId": null` moves
the folder to the top level. Answers the `Folder` (unchanged, with the same version, when nothing
changed).

Errors, in this order: `422 validation` field `name`; `404 not_found` (folder or new parent not
visible); `403 forbidden` (no `folders:write` on the new parent; changing `restricted` without
`folders:permissions`); `409 conflict` (folder in the trash); `409 version_conflict` with
`current: Folder`; `422 validation` field `parentId` (moving into itself or a subfolder, parent in
the trash, or too deep); `403 forbidden` when moving a folder with content the caller cannot see.

### `DELETE /orgs/{orgId}/folders/{folderId}`

Permission `folders:write` on the folder. Moves the folder, every subfolder and every dashboard in
them to the trash (`204`). Needs `dashboards:delete` too when that includes dashboards
(`403 forbidden` otherwise), and `403 forbidden` when content below is hidden from the caller.
Already in the trash: `204` without a change.

### `POST /orgs/{orgId}/folders/{folderId}/restore`

Permission `folders:write` on the folder. Takes the folder and whatever was trashed together with
it out of the trash; answers the `Folder`. Not in the trash: the `Folder` unchanged. Errors:
`409 conflict` when its parent is still in the trash; `403 forbidden` when content below is hidden
from the caller.

### `DELETE /orgs/{orgId}/folders/{folderId}/purge`

Permission `folders:write` on the folder. Deletes the folder for good with all its subfolders,
dashboards and their versions (`204`). Needs `dashboards:delete` when dashboards are among them.
Errors: `409 conflict` when the folder is not in the trash; `403 forbidden` when content below is
hidden from the caller.

## Dashboards

The model (`schemaVersion` 1):

```ts
interface DashboardModel {
  schemaVersion: 1;
  title: string;                                // 1 to 200 characters
  timeRange: { from: string; to: string };      // "now", "now-6h", "now-1d/d", "now+15m", or ISO
                                                // 8601: "2026-10-20" or "2026-10-20T08:15:00Z"
                                                // (a time needs a zone: "Z" or "+02:00")
  refreshSeconds?: number;                      // 5 to 86400
  variables?: Variable[];                       // up to 100, default []
  panels?: Panel[];                             // up to 500, default []
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
  transformations?: unknown[];                  // up to 50, default []
  options?: unknown;                            // default {}
  fieldConfig?: unknown;                        // default {}
}
```

Unknown fields are refused. The server stores the model with defaults filled in and answers it so;
stored that way it may take at most 1 MiB (1048576 bytes), else `422 validation` field `model`.
A model with a lower `schemaVersion` is migrated on save and on read; a higher one ("comes from a
newer Kalzit") is refused. Invalid models answer `422 validation` with field `model` and a message
naming the place (`model.panels[0].grid: w must be 1 to 24`).

Saving (create, save, restoring a version) checks `datasources:query` on every `datasourceId` of the
panels and query variables: a data source the caller cannot see is `422 validation` field `model`
("data source ... does not exist"), one they see but may not query is `403 forbidden`.

```ts
interface DashboardSummary {
  id: string;
  folderId: string | null;
  title: string;
  version: number;
  createdAt: number;
  updatedAt: number;
  updatedBy: string | null;
  deletedAt: number | null;
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
title, any case), `trashed=true` (the trash instead), `limit`, `cursor`. Dashboards in folders the
caller does not see are left out.

### `POST /orgs/{orgId}/dashboards`

Permission `dashboards:write`. Body `{"model": DashboardModel, "folderId"?: string | null,
"message"?: string}`. Answers `201` with the `Dashboard` (version 1).

Errors: invalid model or message (see above); `404 not_found` (folder not in the organization or
not visible); `422 validation` field `folderId` (folder in the trash); `403 forbidden` (no
`dashboards:write` in that folder); data source check (see above).

### `GET /orgs/{orgId}/dashboards/{dashboardId}`

Permission `dashboards:read`. Answers the `Dashboard`, also while it is in the trash (`deletedAt`
set). `404 not_found` for ids of other organizations and dashboards in hidden folders.

### `PUT /orgs/{orgId}/dashboards/{dashboardId}`

Permission `dashboards:write`. Body `{"model": DashboardModel, "version": number, "message"?:
string, "folderId"?: string | null}`. `version` is the version the editor started from; a missing
`folderId` keeps the folder, `null` moves to the top level. Saves a new version; answers the
`Dashboard`. The title follows `model.title`. Versions beyond `dashboards.version_retention` are
deleted, oldest first.

Errors: `404 not_found`; `409 conflict` (in the trash); invalid model or message; folder errors as
on create; `409 version_conflict` with `current: Dashboard`; data source check.

### `DELETE /orgs/{orgId}/dashboards/{dashboardId}`

Permission `dashboards:delete`. Moves it to the trash (`204`); already there: `204` without a
change.

### `POST /orgs/{orgId}/dashboards/{dashboardId}/restore`

Permission `dashboards:delete`. Takes it out of the trash; answers the `Dashboard`. Not in the
trash: the `Dashboard` unchanged. `409 conflict` while its folder is in the trash.

### `DELETE /orgs/{orgId}/dashboards/{dashboardId}/purge`

Permission `dashboards:delete`. Deletes it with all versions for good (`204`). `409 conflict` when
it is not in the trash.

### `GET /orgs/{orgId}/dashboards/{dashboardId}/versions`

Permission `dashboards:read`. `Page<DashboardVersionSummary>`, newest version first.

### `GET /orgs/{orgId}/dashboards/{dashboardId}/versions/{version}`

Permission `dashboards:read`. Answers the `DashboardVersion`; `404 not_found` for a version that
does not exist (or was dropped by the retention) and for anything but plain digits without a
leading zero (`01` and `+1` are `404`).

### `POST /orgs/{orgId}/dashboards/{dashboardId}/versions/{version}/restore`

Permission `dashboards:write`. No body. Saves that version's model as a new version (with
`restoredFrom` set, `message` empty) and answers the `Dashboard`. The old model must pass today's
validation (`422 validation` field `model` otherwise) and the data source check. `409 conflict` while
the dashboard is in the trash; `404 not_found` for an unknown version.
