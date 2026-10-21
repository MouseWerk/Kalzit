# API: data sources and queries

All paths are under `/api`. Conventions (errors, ids, times, `Page<T>`) are in
`docs/ARCHITECTURE.md`. `{orgId}` and `{datasourceId}` are canonical UUIDs; any other value, an id
of another organization, or an id in the trash (except for `restore`) answers `404 not_found`.
Without a session every route answers `401 unauthenticated`; a non-member of `{orgId}` gets `404`.

| Method | Path | Access |
|---|---|---|
| GET | `/orgs/{orgId}/datasource-kinds` | member |
| GET | `/orgs/{orgId}/datasources` | `datasources:read` or `datasources:query` (`?trash=true`: `datasources:write`) |
| POST | `/orgs/{orgId}/datasources` | `datasources:write` |
| GET | `/orgs/{orgId}/datasources/{datasourceId}` | `datasources:read` |
| PATCH | `/orgs/{orgId}/datasources/{datasourceId}` | `datasources:write` |
| DELETE | `/orgs/{orgId}/datasources/{datasourceId}` | `datasources:write` |
| POST | `/orgs/{orgId}/datasources/{datasourceId}/restore` | `datasources:write` |
| POST | `/orgs/{orgId}/datasources/{datasourceId}/health` | `datasources:query` |
| GET | `/orgs/{orgId}/datasources/{datasourceId}/schema` | `datasources:query` |
| POST | `/orgs/{orgId}/query` | `datasources:query` |
| POST | `/orgs/{orgId}/dashboards/{dashboardId}/panels/{panelId}/query` | member; `dashboards:read` on the dashboard |
| POST | `/orgs/{orgId}/dashboards/{dashboardId}/variables/{name}/options` | member; `dashboards:read` on the dashboard |

With the built-in roles, editors read and query data sources, admins and owners also create,
change and delete them. Viewers have neither: the list answers `403 forbidden`, a single data
source `404 not_found` (it is not visible to them), and they run queries only through dashboards.

## Kinds: `GET /orgs/{orgId}/datasource-kinds`

`Page<Kind>` (all kinds in one page, `nextCursor` is `null`), in this order: `postgres`, `mysql`,
`sqlite`, `mssql`, `prometheus`.

```json
{
  "items": [{
    "kind": "postgres",
    "name": "PostgreSQL",
    "shapes": ["frame"],
    "hintKey": "datasources.kinds.postgres.hint",
    "settings": [
      { "name": "host", "labelKey": "datasources.settings.host", "type": "string", "required": true, "secret": false, "target": true },
      { "name": "port", "labelKey": "datasources.settings.port", "type": "number", "required": false, "secret": false, "target": true, "default": 5432 },
      { "name": "password", "labelKey": "datasources.settings.password", "type": "string", "required": false, "secret": true, "target": false },
      { "name": "sslMode", "labelKey": "datasources.settings.sslMode", "type": "select", "required": false, "secret": false, "target": true,
        "options": ["disable", "prefer", "require", "verify-ca", "verify-full"], "default": "prefer" }
    ]
  }],
  "nextCursor": null
}
```

- `type`: `string` (one line), `text` (multi-line, e.g. a PEM certificate), `number` (whole number
  of at least 0), `bool`, `select` (one of `options`). `options` and `default` appear only when set.
- `secret: true` fields are sent in `secrets`, never in `settings`, and are never returned.
- `target: true` fields decide where the stored secrets are sent (host, port, database, user, TLS
  checks, URL, path). Changing one requires sending the secrets again (see Update).
- `hintKey` is the advice shown on the form. Suggested English texts:
  - `postgres`, `mysql`: "Use a login that can only read. Kalzit also runs every query in a
    read-only transaction, but only the database's permissions are a real boundary."
  - `mssql`: "Use a login that can only read (db_datareader). SQL Server has no read-only
    transaction, so the login's permissions are the only real defence; Kalzit's query check is a
    second line."
  - `sqlite`: "The file is opened read-only. It must lie in a directory a server administrator
    allowed."
  - `prometheus`: "Use a token or account that can only query."
- Every kind ends with the common fields `queryTimeoutSecs` (1 to 3600) and `maxRows` (at least 1):
  limits for this source; the server-wide limits are the maximum.

Fields per kind (common fields omitted):

| Kind | Fields (`*` required, `S` secret) |
|---|---|
| `postgres` | `host`*, `port` (5432), `database`*, `user`*, `password` S, `sslMode` (`disable`, `prefer` default, `require`, `verify-ca`, `verify-full`), `caCert` (text, PEM) |
| `mysql` | `host`*, `port` (3306), `database`*, `user`*, `password` S, `sslMode` (`disabled`, `preferred` default, `required`, `verify_ca`, `verify_identity`), `caCert` |
| `sqlite` | `path`* (absolute path of the file) |
| `mssql` | `host`*, `port` (1433), `database`*, `user`*, `password` S, `encrypt` (bool, default true), `trustServerCertificate` (bool, default false), `caCert` |
| `prometheus` | `url`* (`http(s)://host[:port][/path]`), `basicAuthUser`, `basicAuthPassword` S, `bearerToken` S, `caCert` |

i18n keys the UI needs: `datasources.settings.<name>` for every field name above plus
`queryTimeoutSecs` and `maxRows`, and `datasources.kinds.<kind>.hint` for each kind.

## List: `GET /orgs/{orgId}/datasources`

Query: `limit` (1 to 200, default 50), `cursor` (the previous page's `nextCursor`), `trash`
(`true` lists the trash; needs `datasources:write`). Unknown parameters are a `validation` error.
Newest first.

```json
{ "items": [{ "id": "0199…", "name": "Umsätze", "kind": "postgres", "createdAt": 1800000000000 }], "nextCursor": null }
```

Items in the trash also carry `deletedAt`.

## One data source

`Datasource`, as answered by `GET`, `POST` (201), `PATCH` and `restore`:

```json
{
  "id": "0199…",
  "name": "Umsätze",
  "kind": "postgres",
  "settings": { "host": "db.intern", "port": 5432, "database": "shop", "user": "leser", "sslMode": "verify-full" },
  "secrets": { "password": { "set": true } },
  "createdAt": 1800000000000,
  "updatedAt": 1800000000000
}
```

`secrets` lists only the secret fields that have a value. `deletedAt` appears only in the trash.

### Create: `POST /orgs/{orgId}/datasources`

```json
{ "name": "Umsätze", "kind": "postgres", "settings": { ... }, "secrets": { "password": "..." } }
```

`settings` defaults to `{}`, `secrets` to `{}`. Unknown body fields are rejected. Answers `201`.

### Update: `PATCH /orgs/{orgId}/datasources/{datasourceId}`

```json
{ "name": "Neu", "settings": { ... }, "secrets": { "password": null, "bearerToken": "..." } }
```

All fields optional. `settings`, when present, replaces all settings. Per secret field: absent =
keep, `null` = remove, string = set. A patch that changes nothing answers the data source as is.

When the patch changes a `target` field (for example `host`, `port`, `user`, `sslMode`, `url`),
every secret that is stored must be in the same patch, either with its value again or with `null`.
Otherwise the answer is `422 validation` with `field` naming the secret, so a stored password is
never sent to a new host without being entered again.

### Delete and restore

`DELETE` moves the data source to the trash and answers `204`. `POST .../restore` brings it back
(`404` when it is not in the trash). Purging is not available yet.

### Errors when saving

| Status, code | When | `field` |
|---|---|---|
| `422 validation` | name empty or longer than 100 characters, unknown kind, unknown setting, wrong type, missing required field, secret sent in `settings`, unknown secret, port outside 1..65535, host with credentials, SQLite path not absolute, URL with credentials, query or fragment, `caCert` without a PEM certificate | the field name: `name`, `kind`, a settings field name such as `host`, `settings` (unknown setting), `secrets` (unknown secret) |
| `422 datasource_target_blocked` | the target is refused: SQLite file outside `datasources.sqlite_dirs`, in Kalzit's data directory, Kalzit's own database, missing, or a network path (every SQLite refusal has the same message, so it does not tell whether a file exists); a link-local or metadata address (`169.254.0.0/16`, `fe80::/10`, `fd00:ec2::254`); a host outside `datasources.allowed_targets` (when set) | `path`, `host` or `url` |
| `409 conflict` | another data source in use has this name (also when restoring) | `name` |

Name resolution happens when connecting, so a host name that resolves to a refused address is
reported by the query, health and schema routes, not when saving.

### Connections and targets

- Kalzit resolves a host name once, checks the address and connects to that address; the name is
  used for TLS. Exception: PostgreSQL `verify-full` and MySQL `verify_identity` need the driver to
  connect by name (the drivers check the certificate against the host they connect to and have no
  separate TLS name). There the name is resolved and checked again right before every new pooled
  connection; an address change between that check and the driver's own lookup could only reach
  a server holding a valid certificate for the name.
- Data source HTTP traffic (Prometheus) never uses a proxy; `HTTP_PROXY` and similar variables are
  ignored. A proxy would resolve names itself, past the target check.
- When Kalzit itself runs on PostgreSQL, every PostgreSQL source is checked after connecting to make
  sure it is not Kalzit's own database (`pg_control_system()` and `current_database()`). Servers
  that speak the PostgreSQL protocol but lack `pg_control_system()` (several compatible engines)
  are then refused.
- The block list holds the link-local range (which contains the usual cloud metadata address
  `169.254.169.254`) and AWS's IPv6 metadata address. Alibaba Cloud's metadata service
  (`100.100.100.200`) lies in the carrier-grade NAT range used by private networks and is not
  blocked; on Alibaba Cloud, restrict sources with `datasources.allowed_targets`.

## Test connection: `POST /orgs/{orgId}/datasources/{datasourceId}/health`

Body: none or `{}`. Always `200`, also when the source fails:

```json
{ "ok": true, "message": "PostgreSQL 17.2", "latencyMs": 12 }
{ "ok": false, "message": "password authentication failed for user \"leser\"", "latencyMs": 40, "code": "datasource_error" }
```

`code` (only when `ok` is false) is `datasource_error`, `datasource_target_blocked` or
`query_timeout`. Messages never contain secrets. When the login has administrator rights
(PostgreSQL superuser, SQL Server sysadmin), `ok` is true and the message advises a read-only login.

## Schema: `GET /orgs/{orgId}/datasources/{datasourceId}/schema`

SQL kinds:

```json
{ "kind": "tables", "tables": [{ "schema": "public", "name": "bestellungen", "columns": [{ "name": "menge", "type": "integer" }] }] }
```

`schema` is omitted for SQLite. Prometheus:

```json
{ "kind": "metrics", "metrics": ["up", "http_requests_total"], "labels": ["instance", "job"] }
```

Errors: `502 datasource_error`, `422 datasource_target_blocked`, `504 query_timeout`.

## Queries: `POST /orgs/{orgId}/query`

Body `QueryRequest`, answer `QueryResponse` (types generated in `ui/src/api/generated/shapes.ts`):

```json
{
  "queries": [{ "refId": "A", "datasourceId": "0199…", "query": { "sql": "SELECT ..." } }],
  "timeRange": { "from": 1799990000000, "to": 1800000000000 },
  "intervalMs": 30000,
  "maxDataPoints": 1000,
  "variables": { "land": "Österreich", "ids": [1, 2] }
}
```

- 1 to 50 queries, each with its own `refId` (1 to 64 characters); `timeRange.from` not after
  `timeRange.to`, both within the years 1 to 9999. Otherwise `422 validation` (`field`: `queries`
  or `timeRange`).
- `intervalMs` is optional; without it the interval is the range divided by `maxDataPoints`
  (default 1000), rounded up to a familiar step (1 ms ... 1 week).
- `limit` on a query lowers the row limit for it.
- The answer is `200` with one entry per `refId`, either `{"result": QueryResult}` or
  `{"error": {"code", "message"}}`; one failing query does not fail the others.

Per-query error codes: `not_found` (no such data source in this organization), `forbidden`,
`query_rejected` (not a single read-only `SELECT`/`WITH`, a forbidden function, a variable without
a value, wrong query form), `datasource_target_blocked`, `datasource_error`, `query_timeout`.

Queries run in parallel, at most 8 at a time per user and 64 on the whole server (more wait,
within their timeout); "Test connection" and schema reads count against the same limits. Results
of all running requests together are held to 1 GiB. Queries are cancelled when the client goes away
(SQL Server receives a cancel; PostgreSQL and MySQL/MariaDB also stop by their server-side time
limit). Results are frames:

- Field types: `time` (Unix ms), `number`, `int64` (decimal strings, e.g. `COUNT(*)` and `BIGINT`),
  `string`, `bool`, `json`; missing values are `null`. `NUMERIC`/`DECIMAL` are `number`.
- `meta.executedQuery` is the statement as sent, with placeholders instead of values.
- Hitting the row limit (`datasources.max_rows`, the source's `maxRows`, the query's `limit`) or the
  response size limit (`datasources.max_response_bytes`, shared by all queries of the request)
  cuts the frame: `meta.rowsTruncated` is true and `meta.notices` says why. Columns of types the
  server cannot show are `null` with a notice.

### SQL kinds: `{"sql": "..."}`

Exactly one `SELECT` or `WITH` statement. Rejected: other statements, several statements,
`SELECT ... INTO`, `FOR UPDATE`/`FOR SHARE` and other locking clauses, data-modifying `WITH`,
MySQL executable comments (`/*! ... */`), and file, network and session functions (`LOAD_FILE`,
`pg_read_file`, `lo_import`, `dblink`, `query_to_xml`, `OPENROWSET`, `OPENDATASOURCE`,
`OPENQUERY`, `load_extension`, named locks, `NEXT VALUE FOR`, ...), also when used as a table in
`FROM`. MySQL/MariaDB: `--` starts a comment only before a space or control character, as on the
server. PostgreSQL and MySQL/MariaDB run in a read-only transaction; SQLite opens the file
read-only; every transaction is rolled back. PostgreSQL queries run with
`standard_conforming_strings = on`; MySQL/MariaDB sessions run with `sql_mode =
NO_ENGINE_SUBSTITUTION` (no `ANSI_QUOTES`, no `NO_BACKSLASH_ESCAPES`), so the server reads the text
as the check did. A MySQL/MariaDB server that supports neither `max_execution_time` nor
`max_statement_time` is refused, since its queries could not be stopped.

Macros and variables become bind parameters, never text in the SQL:

| Write | Becomes |
|---|---|
| `$__timeFilter(col)` | `(col BETWEEN <from> AND <to>)` |
| `$__timeFrom`, `$__timeTo` | the range's ends as timestamps (SQLite: text `YYYY-MM-DD HH:MM:SS.SSS`, UTC) |
| `$__interval` | the interval (PostgreSQL: an `interval`; others: text such as `30s`) |
| `$__interval_ms` | the interval in milliseconds (integer) |
| `$name`, `${name}` | the variable's value; a list becomes `?, ?, ?` (use in `IN (...)`), an empty list `NULL` |
| `${name:identifier}` | a quoted identifier; the value must be a table or column name from the source's schema |

String variables are bound as text: compare them with non-text columns through a cast
(`id = $id::int` in PostgreSQL). Hand-written placeholders (`$1`, `?`, `@P1`, `:name`) are rejected.
Times are compared in UTC (`TimeZone`/`time_zone` are set to UTC for the query).

### Prometheus: `{"expr": "...", "instant": false, "minStepMs": 15000}`

A range query by default (step: the interval, at least `minStepMs`, and at most 11,000 points per
series), an instant query at `timeRange.to` with `"instant": true`. The frame has a `time` field and
one `number` field per series, named like `up{job="api"}` with the series' `labels`. Warnings from
the server become notices.

Macros: `$__interval`, `$__interval_ms`, `$__rate_interval` (four intervals, at least `1m`),
`$__range`, `$__timeFrom`, `$__timeTo` (Unix seconds). Variables are allowed only inside quoted
strings (`job="$job"`), escaped for the string; a list becomes `a|b` with regex characters escaped
(use with `=~`). A variable outside a string is `query_rejected`.

## A dashboard's stored queries

Both routes run only what the dashboard's current version stores; the request adds the time
range, limits and variable values (bound like all variables, never text in the query).

**Who may run them.** Reading the dashboard (`dashboards:read` on it, through the role, a folder
or a dashboard grant) is what authorizes its stored queries. The caller needs no data source
permission: viewers have none and still see their dashboards. This is safe because saving a
dashboard requires `datasources:query` on every data source it uses, so only sources an authorized
editor placed there are reached, and only with the stored queries. A data source must exist in the
organization and not be in the trash (otherwise that target answers `not_found`). A dashboard the
caller cannot read (another organization, a restricted folder without a grant, unknown or in the
trash) answers `404 not_found`, and so do unknown panels and variables.

**Variables.** `variables` may only name variables the dashboard defines (otherwise `422
validation`, `field: variables`); at most 100, names of letters, digits and `_`, all values together
at most 64 KiB. `timeRange` as for free queries. These limits also hold for `POST /query`.

### Panel: `POST /orgs/{orgId}/dashboards/{dashboardId}/panels/{panelId}/query`

Body `PanelQueryRequest`: `timeRange`, optional `intervalMs`, `maxDataPoints`, `limit` (rows per
target), `cursors` (per `refId`, for document results, M2) and `variables`. Answer `QueryResponse`
with one outcome per stored target of the panel (empty `results` for a panel without targets).
Per-target errors are as for free queries, including `query_rejected` for a stored statement that
is not a single read-only `SELECT`.

### Variable options: `POST /orgs/{orgId}/dashboards/{dashboardId}/variables/{name}/options`

Body `VariableOptionsRequest`: `{ "timeRange": {...}, "variables": {...} }` (no other fields). The
variable's own name in `variables` is refused (`422 validation`, `field: variables`); a variable
that is not of type `query` is `422 validation`.

```json
{ "options": [{ "value": "AT", "label": "Österreich" }], "truncated": false }
```

- `value` is the first field of the result, `label` the second field or the value again.
- Options are distinct by value, in the query's order; empty values are skipped. `int64` stays its
  decimal text, `time` becomes ISO 8601 in UTC (`2025-01-01T10:00:00.000Z`), numbers and booleans
  their JSON text.
- At most 10,000 options; `truncated` is true when that limit or the query's row limit cut the list.
- A failing query answers with its code: `422 query_rejected` or `datasource_target_blocked`,
  `504 query_timeout`, `502 datasource_error`, `404 not_found` (data source gone).

## Not here yet

- Purging data sources from the trash, per-source grants (`resource_grants`), testing settings
  before saving.
