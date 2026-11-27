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
  dashboard (on its folder and on the target folder). Moves between the open tree and team spaces
  need edit rights on both sides instead (`docs/api/access.md`, "Team spaces").

Team spaces and team ownership (a team's folders and dashboards, shared read only or team only)
add to these rules; see `docs/api/access.md`, "Team spaces".

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
| `datasources.max_response_bytes` | `134217728` (128 MiB) | whole number 1024 to 1 GiB; a memory budget: results count what they hold in memory, not their JSON text |
| `datasources.cache_enabled` | `true` | `true`, `false`; the query cache (docs/api/datasources.md, "Query cache"); off lets go of every kept answer |
| `datasources.cache_max_bytes` | `268435456` (256 MiB) | whole number 1 MiB to 64 GiB; the memory of all kept answers, counted as their serialized size |
| `audit.retention_days` | `365` | whole number 1 to 36500 |
| `usage.enabled` | `true` | `true`, `false`; counts dashboard views and panel and data source queries for the usage insights (docs/api/usage.md), never per person; off counts nothing new and keeps what was counted |
| `usage.retention_days` | `90` | whole number 1 to 90; usage buckets older than this are deleted every hour |
| `appearance.default_language` | `"de"` | `"de"`, `"en"` |
| `appearance.default_theme` | `"system"` | `"system"`, `"light"`, `"dark"`, `"contrast"`; the mode |
| `appearance.default_theme_light` | `"light"` | `"light"`, `"paper"`, `"calcite"`; the light variant for System and Light |
| `appearance.default_theme_dark` | `"dark"` | `"dark"`, `"graphite"`, `"night"`; the dark variant for System and Dark |
| `sessions.lifetime_hours` | `720` | read-only (configuration) |
| `sessions.idle_timeout_hours` | `168` | read-only (configuration) |
| `dashboards.version_retention` | `100` | whole number 0 to 100000; 0 keeps every version |
| `appearance.product_name` | `"Kalzit"` | text of 1 to 40 characters, one line |
| `appearance.accent` | `"copper"` | `"copper"`, `"blue"`, `"teal"`, `"green"`, `"violet"`, `"rose"`, `"amber"`, `"graphite"` (shown as Gray), or `#rrggbb` with at least 3:1 against the darkest light surface of every variant (`--bg-surface` of Paper, luminance 0.84929) and the lightest dark surface of every variant (`--bg-raised` of Night, luminance 0.01386) and 4.5:1 for the better of white or the dark label (luminance 0.00579); a refusal names the reached ratios |
| `appearance.density` | `"balanced"` | `"compact"`, `"balanced"`, `"comfortable"` |
| `appearance.font_size` | `14` | `13`, `14`, `15`, `16` (body text in pixels) |
| `appearance.start_page` | `"home"` | `"home"`, `"dashboards"`, `"explore"` |
| `appearance.time_zone` | `"browser"` | `"browser"` or an IANA name |
| `appearance.week_start` | `"monday"` | `"monday"`, `"sunday"`, `"saturday"` |
| `appearance.handbook` | `true` | boolean: whether the app shows the built-in handbook (Help > Handbook and the links into it); off, the Help menu keeps only the keyboard shortcuts |
| `signin.welcome` | `""` | text up to 280 characters, line breaks allowed, no other control characters |
| `signin.notice` | `""` | text up to 2000 characters, line breaks allowed, no other control characters |
| `signin.organization` | `""` | text up to 80 characters, one line: the organization named above the sign-in form |
| `signin.server_name` | `""` | text up to 80 characters, one line: the server name next to it, such as its address |
| `signin.product_line` | `true` | boolean: whether the pages before sign-in say one line about Kalzit while no notice is set |
| `signin.backdrop` | `true` | boolean: whether the panel next to the sign-in form shows its picture (the calcite crystal with a table, a document and a graph); off, the panel is a plain surface |
| `server.http_addr`, `server.https_addr`, `server.public_url`, `server.redirect_http_to_https`, `server.base_path`, `tls.cert_file`, `tls.min_version`, `tls.reload_interval_secs`, `security.trusted_proxies`, `security.forwarded_headers`, `security.hsts`, `security.hsts_max_age_secs`, `security.login_max_failures`, `security.login_window_secs`, `security.setup_max_failures`, `security.setup_window_secs`, `log.level`, `log.format`, `log.event_log`, `metrics.enabled`, `metrics.allowed_networks` | as `kalzit.toml` (`server.base_path`: [reverse proxy](../guide/reverse-proxy.md); `metrics.*`: [monitoring](../guide/monitoring.md); the metrics token is never shown) | read-only (configuration), source `file`, `env` or `default` |

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
| `dashboards.new_in_team_space` | `false` | `true` or `false`; new dashboards go into the team space of the member's team context (`docs/api/access.md`, "Team context") |
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
`"batch": true` in the summary. A `reset` removes the stored value, so the default applies again
(the answer has `source: "default"`). Its version keeps counting (the next version, or `0` for a
setting never saved), so a write that names a version from before the reset is refused with
`version_conflict` instead of silently replacing the default. Undo is another batch with the new
versions: the previous value for a setting whose `source` was `database`, a `reset` for one that
was `default`, so undo never stores a copy of the default. The settings pages undo a single
change the same way.

### CORS

Off by default (no CORS headers at all): only Kalzit's own pages call the API from a browser.
With `cors.enabled` and at least one origin, pages of those origins may call `/api/...`
(nothing outside it). Server settings with undo; a value in `KALZIT_SETTING_CORS_*` or in the
`[cors]` section of `kalzit.toml` (keys without the `cors.` prefix) locks the setting:

| Key | Default | Meaning |
|---|---|---|
| `cors.enabled` | `false` | Cross-origin requests on or off. |
| `cors.allowed_origins` | `[]` | Origins as `scheme://host[:port]`, without path, user or trailing slash, compared with the scheme's default port filled in. `https://*.example.com` stands for every subdomain of `example.com` (not the domain itself); a bare `*` is refused. `http://` only for `localhost`, `127.0.0.1` and `[::1]`. |
| `cors.allowed_methods` | `["GET", "POST", "PUT", "PATCH", "DELETE"]` | Of `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE`. |
| `cors.allowed_headers` | `["Authorization", "Content-Type"]` | Header names; `Accept`, `Accept-Language` and `Content-Language` are always allowed. |
| `cors.allow_credentials` | `false` | Whether those origins may use the session cookie. Never for wildcard entries: while it is on they match nothing, and `kalzit.toml` refuses both together at start. |
| `cors.max_age_secs` | `600` | `Access-Control-Max-Age` of preflight answers, 0 to 86400. |

- A preflight (`OPTIONS` with `Access-Control-Request-Method`) from an allowed origin with an
  allowed method and headers answers `204` with `Access-Control-Allow-Origin` (the one origin),
  `-Allow-Methods`, `-Allow-Headers`, `-Max-Age`, `-Allow-Credentials: true` when the cookie is
  allowed, and `Vary: Origin`. Any other preflight, and a request whose method is not allowed,
  answers `403 cross_origin` with `request.cross_origin_refused`.
- Requests from an allowed origin carry `Access-Control-Allow-Origin`,
  `Access-Control-Expose-Headers: Retry-After, X-Request-Id, Content-Disposition` and `Vary:
  Origin`, and pass the origin check that refuses other cross-origin changes. Without
  `cors.allow_credentials` their `Cookie` header is dropped before the route: only API tokens
  (`Authorization: Bearer`) sign them in, so an allowed origin can never act with a person's
  session by accident. With it, the session works as on Kalzit's own pages; allow it only for
  origins you trust like Kalzit itself.
- Requests from other origins get no CORS headers (the browser keeps the answer from the page),
  and changes from them stay refused (`403 cross_origin`).
- Settings changes are audited as `settings.updated`.
### Outbound proxy

Kalzit's own requests to the internet can go through an HTTP or HTTPS proxy: the plugin catalog
and its packages, update checks and downloads, ACME and the AI providers. Data sources never use
it; each keeps its own connection. Three ordinary server settings, with undo and lockable by
`KALZIT_SETTING_*` like any other:

| Key | Default | Meaning |
|---|---|---|
| `network.proxy_url` | `""` | `http://host:port` or `https://host:port`, nothing else (no user name, password or path). Empty: requests go out directly. |
| `network.no_proxy` | `[]` | Up to 100 entries the requests reach directly: a host name, `.example.com` or `*.example.com` (the domain and everything below it), an address, a network (`10.0.0.0/8`), or `*` for all. |
| `network.proxy_username` | `""` | The user name for the proxy's basic sign-in; empty: no sign-in. |

Before a request goes out, through the proxy or past it, Kalzit resolves the target's name
itself and checks every address with the same rules as without a proxy (no metadata address,
`datasources.allowed_targets` where it applies, the catalog's public-only rule, the AI provider's
"not this Kalzit" rule), so a target must resolve on the Kalzit server. The proxy's own address
is only kept from metadata addresses, so it may stand in the private network; when
`network.no_proxy` also names the proxy's host, that host gets the targets' rules like any other.

The proxy resolves the name again, so a name whose answer changes in between (DNS rebinding) is
only stopped by the proxy's own rules: the proxy must refuse private (RFC 1918), loopback,
link-local and metadata addresses (docs/guide/administration.md, "Outbound proxy", has a squid
example). Plain-http requests of guarded clients (the catalog's packages, an organization's AI
provider) go to the checked address in the absolute URL with the name in `Host`, so the proxy
does not resolve them. HTTPS goes through `CONNECT` by name, since the certificate is checked
against the name.

When the proxy setting or its password cannot be read, update checks and downloads, certificate
orders and the ACME check refuse instead of going out directly: the reason is logged at error
level and shows as the update check's error or the certificate's last failure
(`acme.directory_unreachable`). The catalog and AI calls answer with their usual errors.

The sign-in is sent only with a user name and a password stored for the proxy address in force.
With an `http://` proxy address it travels unencrypted to the proxy; the settings page says so.

#### `GET /admin/network/proxy-password`

Server administrators. `{ "set": bool, "stale": bool, "clearText": bool }`: `set` when a
password is stored for the proxy address in force, `stale` when one is stored for another address,
`clearText` when a user name is set and the proxy address is `http://`. The password is never sent
back.

#### `PUT /admin/network/proxy-password`

Body `{ "password": string | null }`; `null` or `""` removes it. Answers like `GET`. The password is stored encrypted
(`server_secrets`) together with the proxy address in force, and is only ever sent to that
address: after `network.proxy_url` changes it is not used (`stale`) until it is set again.
Refusals: `422 validation` on `password` with `settings.proxy_password_invalid` (`maxChars`, more
than 1024 characters or control characters) or `settings.proxy_url_missing` (no proxy address
set). Audited as `settings.updated` with key `network.proxy_password`, never the value.

## HTTPS certificates

Automatic certificates over ACME (guide: docs/guide/https.md), server administrators only. The
settings are dependent fields and are saved in one step, not as registry settings: they are
stored as one value (`tls.acme` in `server_settings`) with a version, and are not part of the
settings export. Problems are answered as `422 validation` with `error.field` (the field's name
below) and a reason from docs/api/datasources.md, "HTTPS certificates (ACME)".

```json
{
  "settings": {
    "enabled": true,
    "directory": "letsencrypt",
    "directoryUrl": "",
    "directoryCa": "",
    "domains": ["kalzit.example.com"],
    "email": "ops@example.com",
    "challenge": "http-01",
    "acceptTerms": true
  },
  "version": 2,
  "status": {
    "phase": "valid",
    "certificate": {
      "domains": ["kalzit.example.com"],
      "issuer": "R11",
      "notBefore": 1793000000000,
      "notAfter": 1800776000000,
      "issuedAt": 1793000000000,
      "directoryUrl": "https://acme-v02.api.letsencrypt.org/directory",
      "renewAt": 1798184000000
    },
    "nextAttemptAt": null,
    "lastError": null,
    "failures": 0
  },
  "server": { "httpAddr": "0.0.0.0:80", "httpsAddr": "0.0.0.0:443", "certificateFiles": false }
}
```

`directory` is `letsencrypt`, `letsencrypt_staging` or `custom` (then `directoryUrl`, an
`https://` address, and optionally `directoryCa`, PEM certificates trusted for it); `challenge`
is `http-01` or `tls-alpn-01`. `status.phase` is `off`, `waiting` (no matching certificate yet,
or due), `working` (an order runs), `valid` or `failed` (`lastError` with `reason`, `params`,
`message` and `at`; `nextAttemptAt` is the next try). `storeError` (same form, `acme.store_failed`)
says the certificate in use could not be stored; storing is retried, and renewal is not held back. `server` repeats what the configuration
says about the listeners; `certificateFiles` is true when `tls.cert_file` is set, which rules
ACME out.

### `GET /admin/acme`

The view above.

### `PUT /admin/acme`

Body `{ "settings": {...}, "version": <the version edited> }`. Names are trimmed, lower-cased and
deduplicated. On, every field is checked, then the server's listeners (`acme.https_off`,
`acme.http_off`, `acme.certificate_file_set`), then the directory (fetched over HTTPS) and every
name (resolved); off, only the form of the fields, and that HTTPS does not need ACME
(`acme.needed_for_https` while `server.https_addr` is set without certificate files). An older `version` answers
`409 version_conflict` with the stored view as `current`. Saved, the answer is the new view, the
audit log records `tls.acme_changed` (names, directory, challenge, whether a contact is set; never
the contact itself) and a certificate is ordered in the background when none matches.

### `POST /admin/acme/test`

Body `{ "settings": {...} }`: the checks of a save, without saving. Answers
`{ "termsOfService": "<url from the directory>" | null, "warnings": [{ "reason", "params", "message" }] }`;
warnings are `acme.https_later` (HTTPS is off; the certificate is served once it is on),
`acme.http_port` and `acme.https_port` (the listener is not on the port the CA
connects to).

### `POST /admin/acme/renew`

Orders a certificate now, also when the current one is not due; answers the view. ACME off is
`409 conflict` with `acme.off`; during the pause after a failed attempt `acme.renew_backoff`; for a
certificate younger than a third of its lifetime that matches the settings `acme.renew_too_soon`
(the CA's rate limits count every certificate). Recorded as `tls.certificate_requested`.

### `GET /.well-known/acme-challenge/{token}`

Not under `/api` and without sign-in: the HTTP-01 answer of a running order, on every listener
(also the HTTP listener that redirects everything else to HTTPS); `404` for any other token. With
several servers on one database, every server answers the leader's tokens.

## Instances

The Kalzit servers on this database (docs/operations/high-availability.md). Server
administrators only; read only.

### `GET /admin/instances`

```json
{
  "mode": "cluster",
  "database": "postgres",
  "transport": "notify",
  "leaderSince": 1800000000000,
  "leaderTerm": 4,
  "heartbeatSecs": 5,
  "leaseSecs": 15,
  "instances": [
    { "id": "0196...", "host": "kalzit-a", "version": "0.5.0", "address": "0.0.0.0:3000",
      "startedAt": 1800000000000, "heartbeatAt": 1800000300000, "stoppedAt": null,
      "alive": true, "leader": true, "current": true }
  ]
}
```

`mode` is `single` (SQLite, or no other server running on the database) or `cluster`;
`database` is `sqlite` or `postgres`; `transport` says how changes of other servers arrive:
`notify`, `poll` (the notification connection is down) or `none` (SQLite). `leaderSince` is when
the current leader took over (`null` while no lease is valid; on SQLite the server's start).
`instances` lists every server that started on the database within a day, newest first: `alive`
when it did not stop and its heartbeat is younger than the lease, `leader` for the holder of a
valid lease, `current` for the server that answered. Times are Unix milliseconds of the
database's clock.

## Appearance and brand

### `GET /branding`

Public: what the sign-in page shows anyway. Answers `{productName, logo: {contentType, sha256} |
null, signIn: {welcome, notice, organization, serverName, productLine, backdrop, maxFailures, lockMinutes},
defaultTheme, defaultThemeLight, defaultThemeDark, accent, density, fontSize, handbook}` with the
server's values; `handbook` is `appearance.handbook`. `organization` and
`serverName` (`signin.organization`, `signin.server_name`, empty unless an administrator sets
them) make the line above the form; `productLine` says whether the pages before sign-in show
one line about the product while no notice is set: `signin.product_line`, and always `false` on
a server with its own product name or logo; `backdrop` says whether the panel next to the form
shows its picture (`signin.backdrop`); `maxFailures` and `lockMinutes` are
`security.login_max_failures` and `security.login_window_secs` in minutes, for the texts about
the lockout. The sign-in page applies `defaultTheme`, `defaultThemeLight` and `defaultThemeDark` where the visitor
chose none of them in this browser;
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
`422 validation`; `actor`, `action`, `resourceType` or `resourceId` longer than 256 characters is
`422 validation` with that field and reason `request.filter_too_long` (param `max`).

### `GET /orgs/{orgId}/audit`

Permission `audit:read`. `Page<AuditEvent>` of this organization, newest first. `orgId` as a query
parameter is `422 validation`. For members without access to restricted folders:

- events about folders and dashboards they cannot see are left out, also after that content was
  purged (the server remembers which purged folders and dashboards were restricted content);
- a summary's `parentId` or `folderId` that names a folder they cannot see (or a purged restricted
  one) reads `null`.

Counts in summaries (`folder.trashed`: `{"folders", "dashboards"}`) are not narrowed. A
summary's `why` (what lies behind a neutral refusal, written by versions before 0.5.4) is left
out: that detail is for server administrators and stands in server-level entries
(`member.add_refused_reason`, `scim.request_refused_reason`).

`resourceName` (omitted when there is none) is the current name of the event's resource, for the
start page's "Recently changed": the title of a dashboard or saved analysis, the name of a data
source, folder, team, playlist or account. A data source is named only for members who may read
or query it; a resource that no longer exists has no name. An event about a public link or a
snapshot (`public_link.*`, `snapshot.*`) carries the title of the dashboard its summary names
(`dashboardId`), for a member only where they may see that dashboard. Both list routes set it; the
export does not.

### `GET /admin/audit`

Server administrators. `Page<AuditEvent>` of the whole server (sign-ins included), newest first;
`?orgId=` narrows it to one organization; an empty `orgId` is `422 validation` (field `orgId`).
Narrowed, it also holds the server-level entries about that organization (`orgId` `null`,
resource `org` with its id): `member.add_refused_reason` and `scim.request_refused_reason`. The
server export's `orgId` filter does the same.

### `POST /orgs/{orgId}/audit/export` and `POST /admin/audit/export`

The audit log as a file: every event the filters match, newest first, as the list routes show
them to the caller, not one page. The same rights as the lists: `audit:read` for an
organization's log (events about folders and dashboards the member cannot see left out, folder
ids in summaries hidden), server administrators for the server's.

Body: `format` (`csv` or `json`), `language` (CSV only: `de` separates with `;`, `en`, the
default, with `,`), and the list's filters `actor`, `action`, `resourceType`, `resourceId`,
`from`, `to`; `orgId` on the server route only (an empty one, one that names no organization,
or `orgId` on the organization route, is `422 validation`, field `orgId`). `from` after `to` is `422 validation` (field `from`), and the text filters have the list's limit of 256 characters.

- `csv`: RFC 4180, UTF-8 with a byte order mark, CRLF line ends, the columns `createdAt` (ISO 8601
  UTC), `id`, `orgId`, `actorUserId`, `actorName`, `actorAddress`, `actorTokenId`,
  `actorTokenPrefix`, `action`, `resourceType`, `resourceId`, `summary` (compact JSON). Text a
  spreadsheet would read as a formula gets a leading `'`, as in data exports.
- `json`: an array of `AuditEvent`.

The answer is the file (`kalzit-audit.csv` or `.json`) with `Cache-Control: no-store`. At most
100,000 events: more answer `422 validation` with reason `export.too_many_events` (param `max`);
a shorter time range or a filter makes a smaller file. The events are read 1,000 at a time and
written to a spool file in `export-tmp`, so memory holds one batch whatever the file's size; the
file is at most 256 MiB (`export.too_large`) and is then sent from disk as a data export's file
is. An audit export takes the same slots as data exports: one export per user at a time
(`503 busy`, reason `export.user_busy`) and at most 3 files being made on the server
(`export.busy`), and it needs 1 GiB of free disk space (`export.disk_space`). Making the file
takes at most 5 minutes; a longer one stops, frees its slots and answers `503 busy` with reason
`export.too_slow`. The events are read through the read connections, not those of changes.

Each export records `audit.exported` with the format, the filters that were set and the number
of `events`, before the file is sent: when the entry cannot be written, there is no file. An
organization's export is recorded in that organization's log; a server administrator's is
recorded in the server's log (`orgId` `null`), also when it was narrowed to one organization,
whose id the summary's `orgId` names. An export refused for its number of events, its size or
its time (`export.too_many_events`, `export.too_large`, `export.too_slow`) records
`audit.export_failed` in the same place, with the format, the filters and the `reason`.

Events older than `audit.retention_days` are deleted every hour; each run that deleted something
records `audit.expired` with `{"deleted": n, "before": ms}`.

Actions written by these routes: `settings.updated`, `branding.logo_updated`, `branding.logo_removed`, `branding.logo_restored`, `folder.created`, `folder.updated`,
`folder.trashed`, `folder.restored`, `folder.purged`, `dashboard.created`, `dashboard.saved`,
`dashboard.version_restored`, `dashboard.trashed`, `dashboard.restored`, `dashboard.purged`,
`audit.expired`, `audit.exported`, `audit.export_failed`.

## List order

Lists ordered by title or name (dashboards, saved analyses, folders, playlists, library panels,
service accounts, organizations, roles, teams, stars and search hits of equal score) follow the
rules of the UI languages: the Unicode Collation Algorithm with CLDR's root order, which German
and English share. "Ä" and "Ö" sort next to "A" and "O", "ß" like "ss"; case does not count, and
titles that differ only in case are ordered by id. The server computes the order itself
(`server/src/collation.rs`), so SQLite and PostgreSQL, in whatever locale it runs, answer the same
order, and cursors page through it without repeating or skipping entries.

## Folders

```ts
interface Folder {
  id: string;
  parentId: string | null;        // null: top level, or a parent the caller cannot see
  name: string;                   // 1 to 100 characters, trimmed, no control characters
  restricted: boolean;            // the folder's own flag; subfolders inherit the restriction
  ownerTeam: { id: string; name: string } | null;  // the team that owns it
  teamSpace: boolean;             // restricted, at the top level and owned by a team
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
folders not in the trash that the caller sees, each level sorted by name (language order, see "List order").
`?team=<teamId>` scopes it to a team context (`docs/api/access.md`, "Team context").

`?trashed=true` answers the trash instead: one `FolderNode` (with empty `children`) per trashed
subtree, its top folder, newest deletion first. What was trashed in one call is one subtree: a
dashboard or subfolder trashed earlier on its own stays a separate entry and is not restored with
its folder.

### `POST /orgs/{orgId}/folders`

Any member. Body `{"name": string, "parentId"?: string | null, "restricted"?: boolean,
"ownerTeamId"?: string}`. Needs `folders:write` on the parent (org-wide at the top level);
`restricted: true` needs `folders:permissions` on the parent (org-wide at the top level).
`ownerTeamId` creates a team space instead (top level only, `422 validation` `parentId`
otherwise): a maintainer of that team or an org admin. Answers `201` with the `Folder`.

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
```

- `timeZone` must name a zone of the IANA time zone database the server ships (`chrono-tz`), or
  be `browser`.
- `fQ` and `fy` count from the dashboard's `fiscalYearStartMonth`. Where a range is stored outside
  a dashboard (a panel's `timeFrom` inside the dashboard still uses it; a server setting such as
  `dashboards.default_time_range`, Explore), the fiscal year starts in January, so `fy` equals
  `y` there.
- The time options came after `schemaVersion` 2 without a new version: a server before them
  refuses a model that sets any of them (unknown field). Rolling back to such a server needs the
  dashboards saved without the options first (unset every time option in the settings).

```ts
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
  updatedByName: string | null;   // current name of who saved last; null once the account is removed
  deletedAt: number | null;
  access: ResourceAccess;
  tags: string[];
  // In lists only:
  starred?: boolean;              // the caller starred it
  openedAt?: number;              // when the caller last opened it; absent when never (or no
                                  // longer among their recently opened dashboards)
  layout?: DashboardLayout;       // with `layout=true`
}
interface DashboardLayout {
  // Panels and row bands on the 24-column grid, top to bottom (by y, then x), at most 24.
  // Panels outside rows keep their place; each row follows as a band { w: 24, h: 1,
  // type: "row" }, with its panels below it unless the row is stored collapsed.
  items: { x: number; y: number; w: number; h: number; type: string }[];
  more: boolean;                  // the dashboard holds more than `items`
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

Permission `dashboards:read`. `Page<DashboardSummary>` ordered by `sort`. Query: `folderId` (only
that folder; `404 not_found` if not visible), `q` (part of the title, of a tag or of the name of a
folder the caller sees that holds the dashboard directly, any case; at most 200 matching folders
count), `tag` (only dashboards with this tag, any case), `trashed=true` (the trash instead),
`team` (a team context, `docs/api/access.md`), `starred=true` (only the caller's starred ones),
`opened=true` (only those in the caller's recently opened list), `layout=true` (each summary
carries `layout`; `limit` then at most 50, else `422 validation` field `limit`), `sort`, `limit`,
`cursor`. Dashboards the caller does not see are left out. Summaries carry
`ownerTeam: { id, name } | null` and `teamOnly: boolean`.

`sort`: `title` (default; language order, see "List order", then id), `updated` (newest change
first, then id) or `opened` (what the caller opened last first, then what they never opened by
newest change, then id). Only the caller's own opens count. A cursor belongs to its sort.
With `opened`, pages can shift when the caller opens dashboards between two pages: an opened
dashboard moves to the front, so later pages may skip or repeat it.

The layout holds positions and panel types only: no titles, queries, options or data. A stored
model the server cannot read leaves `layout` out for that dashboard.

### `GET /orgs/{orgId}/dashboards/counts`

Permission `dashboards:read`. Query: `team` (as for the list). Counts what the list shows outside
the trash, by its own visibility rules:

```ts
interface DashboardCounts {
  total: number;                                    // every dashboard the list would show
  folders: { folderId: string | null; count: number }[];  // per folder the caller sees (null: the
                                                    // top level); folders without any, and hidden
                                                    // folders, are left out
  starred: number;                                  // of those, starred by the caller
  opened: number;                                   // of those, in the caller's recently opened list
  tags: { tag: string; count: number }[];           // tags of those dashboards, any case as one
                                                    // (one spelling in use), most used first, at
                                                    // most 100
}
```

A dashboard reached through a grant inside a folder hidden from the caller counts in `total`, but
its folder is not named.

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
`?expectedVersion=` names the current version the caller saw (the UI always sends it): a dashboard
saved since answers `409 version_conflict` with the stored `Dashboard` as `current`, so a restore
never replaces a save the caller has not seen. Other parameters are a `validation` error.

## Analysis steps

A panel's `transformations` (and the steps of an Explore query or a free export) are analysis
steps: explicit, ordered steps on the results of the panel's queries, each of which can be turned
off; the queries' own results stay as they are. Nothing is converted unless a step asks for it.
The browser runs them for what it shows (`ui/src/analysis/`); the server runs the same steps for
exports (`server/src/analysis/`), and both engines pass `server/src/analysis/conformance.json`.
Steps work on results in memory, bounded by the queries' row limit. Graph steps (below) are the
exception: they run with their query, in the database where the source can.

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
  | { type: "sort"; frame: string; by: { field: string; desc?: boolean }[] }  // 1 to 5 fields
  | { type: "organize"; frame: string; order?: string[]; hide?: string[];   // up to 500 each
      rename?: Record<string, string> }                                      // old name to new name
  | { type: "filterFields"; frame: string; mode: "keep" | "drop";
      names?: string[]; pattern?: string }                                  // names or pattern or both
  | { type: "filterRows"; frame: string; mode: "keep" | "drop"; match: "all" | "any";
      conditions: { field: string;                                          // 1 to 50
        op: "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "between" | "contains" | "matches"
          | "empty" | "notEmpty";
        value?: string | number | boolean; to?: string | number }[] }
  | { type: "limit"; frame: string; count: number; from?: "first" | "last" }  // count 1 to 1,000,000
  | { type: "convert"; frame: string;
      conversions: { field: string; to: "number" | "string" | "time" | "bool"; format?: string }[] }
  | { type: "reduceSeries"; frame: string; mode: "rows" | "columns";
      calculations: Agg[]; fields?: string[] }                              // each calculation once
  | { type: "stack"; frames: string[] }                                     // 2 to 20 queries
  | { type: "seriesToRows"; frames: string[] }                              // 1 to 20 queries
  // Graph steps: they read the graph result of `frame`.
  | { type: "toFrame"; frame: string; rows: "nodes" | "edges";              // a graph to a frame
      label?: string; edgeType?: string;                                    // label with nodes, edgeType with edges
      columns: { path: string; name?: string; type?: "string" | "number" | "int64" | "bool" | "time" }[] }
  | { type: "countLabels"; frame: string }
  | { type: "countEdgeTypes"; frame: string }
  | { type: "degreeDistribution"; frame: string; direction?: Direction }
  | { type: "topDegree"; frame: string; n: number; label?: string; direction?: Direction }  // n 1 to 1000
  | { type: "sharedNeighbours"; frame: string; label: string; via: string;  // via differs from label
      edgeType?: string; min: number; limit: number; name?: string }        // min at least 1, limit 1 to 1000
  | { type: "degree"; frame: string; direction?: Direction; name?: string } // name default "degree"
  | { type: "filterGraph"; frame: string; labels?: string[]; edgeTypes?: string[];  // up to 50 each
      property?: { key: string; op: "exists" | "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "contains";
                   value?: string | number | boolean } }                   // none for exists, a number to compare
);
type Direction = "both" | "out" | "in";                                     // default "both"
type Agg = "count" | "sum" | "mean" | "median" | "min" | "max" | "stddev" | "variance"
  | "first" | "last" | "firstRow" | "lastRow" | `p${0..100}`;               // "stdDev" is read as "stddev"
```

- **toFrame** (the projection) turns the `documents` result of `frame` into a frame, one column
  per field path (dotted, array indexes as numbers: `items.0.price`), named `name` or the path,
  typed `type` or by the first value; values that do not fit the type are empty. 1 to 200 columns,
  paths 1 to 500 characters, column names unique. The steps after it work on that frame; a
  result that already is a frame passes unchanged. Documents are no frame for any other step.
  The documents UI edits the projection; it lives in the panel's `transformations`, not in the
  query (a decision recorded in docs/PLAN.md, section 14).
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
- **trend** (the step "Trend line" in the UI) is the least-squares line of `field` over `x` (the first time field when `x` is
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
- **sort** orders the rows by `by`, the first key first, each ascending unless `desc`; rows with
  equal keys keep their order and empty cells come last in either direction. `int64` compares
  exactly, other numbers, `time` and `date` as numbers, `string` by code point, `false` before
  `true`; a `json` field answers `steps.field_type`.
- Empty values are left out of every statistic and aggregation.
- `first` and `last` are the first and last value that is not empty, `firstRow` and `lastRow` the
  cell of the first and last row (which may be empty); `stddev` and `variance` are sample
  measures (n - 1); `pN` is the Nth percentile, as `percentile` of **reduce**. A filter on an int64
  field with whole numbers compares exactly.
- **organize** puts the fields named in `order` first (the others after them, in their order),
  leaves out `hide` and renames by `rename`; names no field has are passed over. A new name that
  another field keeps answers `steps.name_taken`.
- **filterFields** keeps (`keep`) or leaves out (`drop`) the fields among `names` or whose name
  matches the regular expression `pattern` anywhere in its first 150 characters (the syntax both
  engines share: `.`, `*`, `+`, `?`, `{n,m}` up to 1000, `[...]`, `(...)`, `|`, `^`, `$` and
  backslash before a special character; `.` is any character but `\r`, `\n`, U+2028 and U+2029;
  no `(?`, no letter escapes such as `\d`, no class set operations, no quantified group that holds
  a quantifier or a `|`, such as `(a+)+` or `(a|aa)+`; at most two repetitions (`*`, `+`, `?`,
  `{n,}`, `{n,m}` with m above 1) besides a leading or trailing `.*`, alternatives in groups that
  multiply to at most 4096 ways without a repetition, 64 with one and none with two, at most 2000
  characters, and an expanded size of at most 16,000 (a character counts its UTF-8 bytes, a class or
  `.` 40, times its repetition count); anything else answers `steps.pattern`). These limits keep a
  pattern fast in the browser, which runs stored steps for viewers.
- **filterRows** keeps or leaves out the rows that pass all (`all`) or any (`any`) condition.
  `empty` is an empty value or empty text. Numbers and times compare as numbers (`value` may be
  number text, for times also ISO 8601 text), text by code point, true and false only with `eq`
  and `ne`; `between` takes both ends. `contains` and `matches` read the cell as text (times in ISO
  8601); `matches` takes the pattern syntax of **filterFields** and reads the first 150
  characters of the cell. An empty cell passes only `ne` and `empty`. A value that cannot be
  compared answers `steps.filter_value`.
- **limit** keeps the first or the last `count` rows.
- **convert** turns fields into another type in their place: to `number` (text by the number
  grammar, true as 1, times as ms), `string` (numbers as JavaScript writes them, times in ISO 8601),
  `time` (text as ISO 8601 or by `format` with `YYYY`, `MM`, `DD`, `HH`, `mm`, `ss`, `SSS`; numbers as
  ms) or `bool` (`true`, `false`, `1`, `0` in any case; numbers other than 0). Values that cannot be
  read are empty; JSON fields are refused. Only numbers keep their unit.
- **reduceSeries** reduces every number field (or `fields`) of the table with each calculation:
  `rows` answers `field` and one field per calculation (numbers only), `columns` one row with a
  field per series and calculation (`calc(field)`, the field's name for a single calculation).
- **stack** puts the rows of `frames` one under the other at the place of the first; the others
  are used up. Fields of the same name become one (different types answer `steps.stack_types`).
- **seriesToRows** makes `time`, `metric` (the field's name and its labels, `cpu{host="a"}`) and
  `value` of every number field next to the first time field of its table, by time, at the place
  of the first of `frames`. Both answer at most 500,000 rows (`steps.result_rows`).

### Graph steps

Graph steps read the `graph` result of a query (Neo4j, Memgraph, TigerGraph) and make a frame or
a smaller graph; every change of shape is one of these visible steps. Steps that read a frame
work only after a step that made one; a frame step on a graph answers `steps.frame_missing`, a
graph step on anything else `steps.not_graph`.

- **countLabels** answers `label`, `nodes` and `share` (of all nodes, 0 to 1), most nodes first,
  then by label. A node with several labels counts once for each.
- **countEdgeTypes** answers `type`, `from`, `to` (the labels of the edge's ends joined with `:`,
  empty for a node without labels) and `edges`, most edges first, then by type, `from`, `to`.
- **degreeDistribution** answers `degree` and `nodes`: how many nodes have how many edges
  (`out`: edges that start there, `in`: that end there, `both`: either; a loop counts twice),
  nodes without edges included, by degree.
- **topDegree** keeps the `n` nodes with the highest degree (only those with `label`, when
  given; ties by node id) and the edges between them. The result stays a graph.
- **sharedNeighbours** answers pairs of `label` nodes with neighbours of the label `via` in
  common, over edges of `edgeType` (all types when absent) in either direction: `a`, `b`, `shared`
  (how many) and `neighbours` (a list). Pairs with at least `min` shared neighbours, the `limit`
  with the most, then by the ids of `a` and `b`. Nodes are named by their text property `name`,
  else by their id; neighbours are listed by id. Such as customers who bought the same products.
- **degree** ("Grad berechnen") gives every node its degree as the property `name` (`degree`),
  replacing one of that name. The result stays a graph.
- **filterGraph** ("Teilgraph filtern") keeps the nodes with one of `labels` (all when absent)
  whose property `key` passes the condition, and the edges of `edgeTypes` (all when absent) whose
  ends both stay; paths are left out. `exists`: the property has a value; `eq`, `ne`: equal to the
  text, number (also a 64-bit integer or decimal property) or true or false; `gt`, `gte`, `lt`,
  `lte`: a number compared with a number; `contains`: text in text. A node without the property
  passes no condition. The result stays a graph.
- **toFrame** with `rows` makes one row per node (only those with `label`) or per edge (only
  those of `edgeType`); the column paths are property keys, and `@id`, `@labels` (nodes) or
  `@id`, `@type`, `@from`, `@to` (edges), which win over properties of the same name. The rest is
  as for documents.

Labels, edge types and property keys of graph steps are 1 to 200 characters without control
characters or backslashes. A node the query returned only as the end of a relationship counts as
a node without labels and properties, in the database as on the server.

Text and ids compare by UTF-16 code units, as Neo4j compares them, so every engine answers the
same rows in the same order. Where they run: the enabled graph steps of a query go with it
(`QueryItem.steps`, docs/api/datasources.md, "Graph steps"); the panel route sends a panel's
stored ones itself. For Neo4j and Memgraph the first one runs in the database, as read-only
Cypher around the query; the others run on the server. The answer says where each ran. The
browser runs them only as a preview, on the graph it holds, until that answer is there.
- Bounds, the same in the browser and on the server: a step makes at most 5,000,000 cells (rows
  times fields, checked before it builds them: `steps.too_many_cells`); the steps of one run make
  at most 67,108,864 UTF-16 units of text, calculated text and the copies a join makes
  (`steps.too_much_text`).

Saving checks each step's form and bounds and parses every expression (syntax errors name the
place: `model.panels[0].transformations[1].expression: unexpected input at 4`). Field names and
types are checked when a step runs, since only then the fields are known; the browser shows the
reason at the step and the export routes answer it (docs/api/datasources.md, "Reasons").

### Graph algorithm steps

Graph algorithms as steps (docs/PLAN.md, section 15, 0.8.2; board
`docs/design/blueprint/Graph082.dc.html`). They read the `graph` result of a query and keep it a
graph: what they find becomes node or edge properties, the graph's `paths`, or suggested edges;
only similarity may answer a table instead, and says so with its shape. They run with the query
(`QueryItem.steps`) like the other graph steps, and compute on exactly the result: its nodes and
the edges between them (an edge whose end the query did not return is left out), never on the
whole database. Nothing is written to the source.

Every step takes `name` for the property it adds (the default below), so two steps of a kind can
stand side by side; `direction` is `out` (along the edges), `in` or `both` (either way, the
default unless said otherwise); `weight` names a number property of the edges (0 or more where
set, 1 where not; anything else is `steps.weight_invalid`); `edgeTypes` keeps only edges of those
types. Every algorithm step may also carry `"place": "server"` (default `auto`) to always run on
the Kalzit server, for comparing runs. The step `degree` (above) is the degree centrality; it
also takes `edgeTypes` and `weight` (then the sum of the weights at the node, a number).

| Step | Parameters (default) | Result |
| --- | --- | --- |
| `centrality` | `measure`: `pageRank` (`damping` 0.85, `maxIterations` 100 and at most 100, `tolerance` 1e-7, `weight`), `eigenvector` (`maxIterations` 100 and at most 100, `tolerance` 1e-6, `weight`), `betweenness`, `closeness`, `harmonic`; `direction` | per node `pagerank`, `eigenvector`, `betweenness`, `closeness` or `harmonic` |
| `communities` | `algorithm`: `louvain`, `leiden` (`resolution` 1.0, `maxIterations` 10 levels), `labelPropagation` (`maxIterations` 10), `weaklyConnected`, `stronglyConnected`; `weight`, `seed` (42) | per node `community`, or `component` for components, numbered from 0 |
| `kCore` | `k` (1 to 10,000) | per node `core`; with `k` only the k-core: the nodes of core number `k` or more and the edges between them |
| `triangles` | `clustering` (name of the second property) | per node `triangles` and `clustering` (0 to 1) |
| `similarity` | `measure`: `jaccard`, `overlap` (`edgeTypes`, `direction`), `cosine`, `knn` (`properties`: 1 to 50 number properties); `topK` (10, at most the setting, 100), `label`, `minScore`, `output`: `table` or `edges` (`edges` for `knn`) | a table `a`, `b` (names), `score`, `aId`, `bId`; or edges of type `SIMILAR` with `score` |
| `linkPrediction` | `measure`: `commonNeighbours`, `adamicAdar`, `preferentialAttachment`; `topK` (50, at most the setting, 50; the setting itself at most 500), `label`, `minScore` | suggested edges of type `SUGGESTED` in `suggested` |
| `paths` | `mode`: `shortest`, `allShortest` (`maxPaths`), `weighted` (`weight` required), `kShortest` (`k` 3, `weight`); `from`, `to` (node ids), `direction`, `edgeTypes`, `maxLength` (30; for `kShortest` the setting, 8), `keepAll` | the paths' nodes and edges (all of the graph with `keepAll`), `paths`, per node on them `path_order` |
| `reachable` | `from` (1 to 100 node ids), `maxHops` (2, at most 8), `direction`, `edgeTypes` | the nodes reached and the edges between them, per node `distance` |
| `bridges` | | per edge `bridge` (true or false) |
| `articulationPoints` | | per node `articulation` (true or false) |
| `cycles` | `maxLength` (6), `maxCount` (200), `direction` (`out` by default; `both`: cycles of three nodes or more) | the cycles as `paths`, per node `in_cycle` |
| `mergeNodes` | `by`: `label` or `property` (with `property`, such as `community`); `aggregates` and `edgeAggregates` (`op`: `count`, `sum`, `mean`, `min`, `max`, `distinct`; `property`; `name`); `loops` (true), `mergeTypes` (false) | one node `group:<value>` (label `Gruppe`) per group with `name`, `count`, the aggregates, `members` and `memberIds` (at most 1,000); one edge per pair of groups and type with `count` and the edge aggregates |
| `aggregateAlong` | `along`: `neighbours` (default: `label`, `edgeTypes`, `direction` (`out`), `depth` (1, at most 4)) or `paths` (`of`: `nodes` or `edges`); `op`: `sum`, `mean`, `count`, `min`, `max`; `property` (not for `count`), `name` (required) | `neighbours`: per node with `label` the value over the nodes reached, each once. `paths`: per path of the graph (of a `paths` or `cycles` step, or of the query) the value over its nodes or edges, in the path's `values` |

Details:

- PageRank answers shares that sum to 1; a node without outgoing edges passes its share to all
  nodes. Eigenvector scores have length 1. Betweenness counts each pair once for `both`.
  Closeness is the number of nodes reached over the sum of their distances; harmonic the sum of
  inverse distances over the other nodes. Paths, cycles, triangles, cores, bridges, similarity
  and link prediction count parallel edges once and leave loops out.
- Communities are numbered in the order of their smallest node id, so a community keeps its
  number from run to run while its smallest member stays. The server's Louvain, Leiden (with a
  greedy refinement) and label propagation run in a fixed order: the same input gives the same
  answer.
- Similarity and link prediction take ties for the node that comes first in the result. Scores of
  0 are no pair. Link prediction uses only the topology of the result, no trained model.
  Suggested edges (`suggested: true`, with `score`) stay in the graph's `suggested`, apart from
  `edges`: they are not counted, no later step reads them, and exports leave them out unless
  asked to take them.
- Listing steps stop at their bounds and say so: all shortest paths with the notice
  `analysis.paths_cut` (`shown`, `total`), cycles with `analysis.cycles_cut` (`limit`; how many
  more there are is not counted). Paths are searched within `maxLength`: the weighted path and
  the k shortest paths are the best that fit. When no path fits but a longer one exists, the
  graph gets the notice `analysis.paths_too_long` (`maxLength`, `edges`) and the summary
  `noPathWithin`, never a silent "no path".
- A node id in `from` or `to` that the result does not have is `steps.node_missing` (`node`).

Where they run. Each step's place in the answer (`steps[]`) says `ranIn` (`database` or `server`),
`summary` (below) and, for an algorithm step that ran on the server, `reason`:

| Step | Neo4j with GDS | Memgraph with MAGE | TigerGraph |
| --- | --- | --- | --- |
| PageRank | `gds.pageRank` | `pagerank.get` over `project()`, `out` without `weight` and without nodes lacking edges | server |
| Eigenvector, closeness, harmonic | `gds.eigenvector`, `gds.closeness`, `gds.closeness.harmonic` | server | server |
| Betweenness | `gds.betweenness` | server (always: a running MAGE procedure cannot be stopped) | server |
| Louvain, Leiden | `gds.louvain` (not with `resolution`), `gds.leiden` | `community_detection.get_subgraph`, `leiden_community_detection.get_subgraph` (not with `resolution` or `maxIterations`) | server |
| Label propagation | `gds.labelPropagation` | server | server |
| Weakly, strongly connected | `gds.wcc`, `gds.scc` | `weakly_connected_components.get` over `project()`; strongly: server | server |
| k-core, triangles and clustering | `gds.kcore`, `gds.triangleCount` and `gds.localClusteringCoefficient` | server | server |
| Jaccard, overlap; cosine, kNN | `gds.nodeSimilarity`; `gds.knn` (not with `label`) | server (always: a running MAGE procedure cannot be stopped) | server |
| Shortest, weighted path | `gds.shortestPath.dijkstra` | `*BFS` and `*WSHORTEST`, filtered to the result's edges and nodes | server |
| k shortest paths | `gds.shortestPath.yens` | server | server |
| All shortest paths | server (listing) | server (listing) | server |
| Reachable | `gds.allShortestPaths.delta` (one start node) | `*BFS` from every start node, filtered as above | server |
| Bridges, articulation points | `gds.bridges`, `gds.articulationPoints` | `bridges.get`, `biconnected_components.get` over `project()` | server |
| Cycles | server (listing) | server (always) | server |
| Link prediction | server | server | server |
| Merge nodes, aggregate along | server | server | server |

- In Neo4j, Kalzit projects exactly the result's nodes and the edges between them into GDS's
  in-memory catalog, seeking the edges and the nodes without edges by their ids (a node's other
  relationships are never read), under a name made for the step (`kalzit-algorithm-<uuid>`), runs
  the algorithm's `stream` mode and drops the projection right after, also when the stream
  failed; one such step per source at a time. Projections left by a broken connection are
  dropped by a later step's sweep once they are older than the longest time a request may take
  (one hour) plus ten minutes. These are fixed queries of Kalzit (`cypher::check_fixed`); a user's query
  still may not project or drop a graph. In Memgraph the result's nodes and edges go to a
  `*_subgraph` procedure as lists or through `project()`, in one read query; paths use
  Memgraph's own expansions, whose filter admits only the result's edges and nodes.
- Link prediction always runs on the server: GDS offers it only as functions on two nodes that
  read their neighbours in the whole database, not in the result. Merging nodes and aggregating
  along need only the result, which is already on the server (`algorithm.local`).
- TigerGraph runs every algorithm step on the server; an administrator-installed, read-only
  library query limited to a vertex set will be used where it exists (hook
  `DataSourcePlugin::algorithm_library`).
- Both ways read the same input and build the answer with the same code, and pass the same cases
  in `server/src/analysis/conformance.json` ("algorithms"). Deterministic steps agree exactly;
  iterative and randomised ones (PageRank, eigenvector, Louvain, Leiden, label propagation, kNN)
  agree within the stated tolerance or by invariants (ranking, partition, number of communities).
  A library may pick another of several paths of the same length. Library scores of PageRank are
  scaled to sum 1; the libraries' own handling of nodes without outgoing edges applies there.
- In Neo4j one deadline covers the sweep, the projection and the streams; the projection is
  dropped afterwards also when the request has gone away, and only then is the source's gate
  freed. Steps on the server wait for one of their places without holding a thread.
- `reason` when an algorithm step ran on the server: `algorithm.no_library` (the source has no
  library Kalzit uses), `algorithm.local` (it needs only the result), `algorithm.not_in_library`
  (no read-only variant limited to the result), `algorithm.enumerating` (listing steps keep their
  bounds on the server), `algorithm.not_cancellable` (Memgraph cannot stop a running procedure),
  `algorithm.option` (an option the library does not offer), `algorithm.isolated_nodes`
  (Memgraph's projection holds no nodes without edges), `algorithm.empty` (no edges),
  `algorithm.library_failed` (the library failed or did not answer in time; the server computed
  the same step; when the library lacks what the step needs, an unknown procedure or function or
  a syntax it does not take, the source is not asked again for that step for ten minutes; when
  it ran out of time, not for that step on results of the same size or larger, by powers of two
  of nodes plus edges; errors the data causes are not remembered),
  `algorithm.place_server` (the step asked for it). An answer of the library Kalzit cannot read
  is not replaced: the step fails with `steps.algorithm_answer`, `ranIn: "database"` and
  `reason: "algorithm.answer_unreadable"`, and may be run with `"place": "server"`.

Summary. Every algorithm step's place carries `summary`: `key` (an i18n key of the UI,
`analysis.summary.*`) and `values`, the numbers and names its sentence needs, such as
`{"key": "analysis.summary.communities", "values": {"count": 3, "modularity": 0.41, "largest": 5,
"smallest": 5}}` ("3 Communities, Modularität 0,41"). Keys: `centrality` (`measure`, `nodes`,
`max`, `top`, `allSame`), `communities` (`count`, `modularity`, `largest`, `smallest`),
`components` (`count`, `largest`, `nodes`), `kCore` (`maxCore`, `nodes`, `of`), `triangles`
(`triangles`, `averageClustering`), `similarity` (`pairs`, `measure`, `minScore`, `best`, `a`,
`b`), `linkPrediction` (`pairs`, `measure`, `best`, `a`, `b`), `paths` (`paths`, `edges`, `cost`,
`mode`, `from`, `to`, `weight`, `total` when cut), `noPath`, `reachable` (`nodes`, `of`,
`maxHops`, `starts`, `from`), `noPathWithin` (`maxLength`, `edges`), `bridges` (`count`, `a`, `b`), `articulationPoints` (`count`,
`first`), `cycles` (`count`, `cut`, `maxCount`, `maxLength`), `mergeNodes` (`nodes`, `groups`,
`edges`, `groupEdges`, `largest`, `largestCount`), `aggregateAlong` (`nodes`, `of`, `name`, `max`,
`top`), `aggregateAlongPaths` (`paths`, `of`, `name`, `min`, `max`), `kCoreOf` (`k`,
`maxCore`, `nodes`, `of`). Names are the nodes' text property `name`, else their id.

Limits, server settings that an organization may only lower (`datasources.algorithm_*`; the
parallel steps are per Kalzit server):

| Setting | Default | |
| --- | --- | --- |
| `algorithm_timeout_secs` | 30 | per step, within the query's time limit (`steps.algorithm_timeout`) |
| `algorithm_max_nodes` | 100,000 | nodes of the result per step; a fifth (20,000) for betweenness, closeness, harmonic and similarity (`steps.algorithm_too_large`, `nodes`, `maxNodes`) |
| `algorithm_max_memory_bytes` | 512 MiB | memory per step, estimated before it starts (`steps.algorithm_memory`, `neededMb`, `maxMb`) |
| `algorithm_max_parallel` | 2 | steps computing on the server at once; others wait within their time |
| `algorithm_max_results` | 200 | paths or cycles a listing step gives at most (`steps.algorithm_bound`, `param`, `max`) |
| `algorithm_max_length` | 8 | edges of a cycle or of one of the k shortest paths |
| `algorithm_max_top_k` | 100 | similar nodes per node (`topK` of similarity), at most 100 |
| `algorithm_max_suggestions` | 50 | suggested edges per link prediction step, also its default; at most 500 |

Every step on the server looks at its deadline and at the request: a request that goes away stops
it. In Neo4j a step that runs too long is stopped with its transaction.

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
  `number`, `lower`, `upper`, `length`, `contains`. Calendar functions read times in the time zone
  in effect (the dashboard's, else the viewer's; an export names it in `timeZone`, UTC when
  absent), and `startOf(t, 'week')` starts on the first day of the week in effect (Monday unless
  set); `weekday` always counts 1 Monday to 7 Sunday. Minutes and hours step back on the time line;
  days and longer start at the wall clock's midnight (the first instant after it when a daylight
  saving change skips midnight). A time outside the years 1 to 9999 is empty.
- Limits: 2000 characters, nesting 64 levels while parsing and a tree at most 128 high (chains
  inside parentheses grow it), 100 values per call, text results at most 32,767 UTF-16 units per
  cell (`expression.text_too_long`).
- `int64` text and `number(...)` read one grammar: an optional sign, digits with an optional
  fraction and exponent, ASCII spaces around; anything else is empty. Group keys and `min`/`max`
  of `int64` compare exactly; cells that do not read are left out.
- Both engines agree exactly, except `exp`, `ln`, `log10`, `pow` and `^`, whose platform libraries
  may round the last bit differently (one unit in the last place). Numbers are written as
  ECMAScript `Number::toString` writes them (`ryu-js` on the server).
