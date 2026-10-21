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

Organization settings:

| Key | Default | Accepts |
|---|---|---|
| `dashboards.default_time_range` | `{"from": "now-6h", "to": "now"}` | a time range as in the dashboard model; new dashboards without `timeRange` get it |

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

Actions written by these routes: `settings.updated`, `folder.created`, `folder.updated`,
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
