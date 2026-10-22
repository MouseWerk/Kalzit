# API: data sources and queries

All paths are under `/api`. Conventions (errors, ids, times, `Page<T>`) are in
`docs/ARCHITECTURE.md`. `{orgId}` and `{datasourceId}` are canonical UUIDs; any other value, an id
of another organization, or an id in the trash (except for `restore`) answers `404 not_found`.
Without a session every route answers `401 unauthenticated`; a non-member of `{orgId}` gets `404`.

| Method | Path | Access |
|---|---|---|
| GET | `/orgs/{orgId}/datasource-kinds` | member |
| GET | `/orgs/{orgId}/datasources` | member; lists the sources the caller may read or query (`?trash=true`: the trashed ones they may restore, `datasources:write`) |
| POST | `/orgs/{orgId}/datasources` | `datasources:write` (org-wide) |
| GET | `/orgs/{orgId}/datasources/{datasourceId}` | member; `datasources:read` on the source |
| PATCH | `/orgs/{orgId}/datasources/{datasourceId}` | member; `datasources:write` on the source |
| DELETE | `/orgs/{orgId}/datasources/{datasourceId}` | member; `datasources:write` on the source |
| POST | `/orgs/{orgId}/datasources/{datasourceId}/restore` | member; `datasources:write` on the source |
| POST | `/orgs/{orgId}/datasources/{datasourceId}/health` | member; `datasources:query` on the source |
| GET | `/orgs/{orgId}/datasources/{datasourceId}/schema` | member; `datasources:query` on the source |
| POST | `/orgs/{orgId}/query` | member; `datasources:query` on each query's source |
| POST | `/orgs/{orgId}/dashboards/{dashboardId}/panels/{panelId}/query` | member; `dashboards:read` on the dashboard |
| POST | `/orgs/{orgId}/dashboards/{dashboardId}/variables/{name}/options` | member; `dashboards:read` on the dashboard |

"On the source" means the org-wide permission of the member's roles, or a grant on that data
source (`query` gives read and query, `edit` adds write, `admin` adds permissions; see the grants
API). Grants are checked on every request, so revoking one cuts free queries, health and schema at
once. With the built-in roles, editors read and query every data source, admins and owners also
create, change and delete them. A member who may not see a source (a viewer without a grant) gets
`404 not_found` for it, an empty list, and `not_found` per query; one who sees it but lacks the
right gets `403 forbidden`. Viewers run queries through dashboards (see below).

Every message these routes answer comes with a stable `reason` code and its `params`; the UI
translates those, and the English `message` is only the fallback. See [Reasons](#reasons).

## Kinds: `GET /orgs/{orgId}/datasource-kinds`

`Page<Kind>` (all kinds in one page, `nextCursor` is `null`), in this order: `postgres`, `mysql`,
`sqlite`, `mssql`, `prometheus`, `mongodb`.

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
  - `mongodb`: "Use a login with only the read role on this database. Kalzit refuses logins that
    may do more, and servers without access control."
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
| `mongodb` | `hosts`* (`host`, `host:port` or `[v6]:port`, comma-separated, at most 50), `port` (27017, for hosts without one), `srv` (bool, default false: `mongodb+srv`, `hosts` is one name without port), `replicaSet`, `database`*, `user`, `password` S, `authSource` (default: `database`; with SRV the TXT record's, else `admin`), `tls` (bool; default false, true with SRV), `caCert` (needs TLS), `maxResponseBytes` (at least 1, within the server's limit) |

i18n keys the UI needs: `datasources.settings.<name>` for every field name above plus
`queryTimeoutSecs` and `maxRows`, and `datasources.kinds.<kind>.hint` for each kind. For
`mongodb`, `maxRows` limits documents.

## List: `GET /orgs/{orgId}/datasources`

Query: `limit` (1 to 200, default 50), `cursor` (the previous page's `nextCursor`), `trash`
(`true` lists the trash). Unknown parameters are a `validation` error. Newest first. The list
holds exactly the sources the caller can open or query; the trash holds exactly those they can
restore (`write` on the source, which needs the source to be visible to them: a role with
`datasources:write` but neither read nor query sees only the sources a grant shows it).

```json
{ "items": [{ "id": "0199…", "name": "Umsätze", "kind": "postgres", "createdAt": 1800000000000,
              "access": { "read": true, "query": true, "write": false, "permissions": false, "changeTarget": false } }],
  "nextCursor": null }
```

Items in the trash also carry `deletedAt`. `access` is described under [Access](#access).

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
  "updatedAt": 1800000000000,
  "access": { "read": true, "query": true, "write": true, "permissions": true, "changeTarget": true }
}
```

`secrets` lists only the secret fields that have a value. `deletedAt` appears only in the trash.

### Access

`access` (type `DatasourceAccess`, generated) says what the caller may do on this source, from
their roles and grants together, by the same rules the routes check. List and detail answers
agree; the list computes it for all rows at once.

| Field | True when the caller holds | Allows |
|---|---|---|
| `read` | `datasources:read` on the source (role, or any grant) | `GET` of the source: name, kind, settings without secrets |
| `query` | `datasources:query` on the source (role, or any grant) | free queries (`/query`, Explore), Test connection (`/health`), `/schema` |
| `write` | `datasources:write` on the source (admin roles, or an `edit` or `admin` grant) | `PATCH` of the name, non-target settings, limits and secrets; `DELETE` (trash) and `restore` |
| `permissions` | `datasources:permissions` on the source (admin roles, or an `admin` grant) | managing the source's grants |
| `changeTarget` | `write`, and also the org-wide `datasources:write` (the caller's role) or `datasources:permissions` on the source | changing `target` fields (host, port, database, user, TLS, URL, path), with the secrets that go with them (see Update) |

`changeTarget` is exactly the rule `PATCH` applies to target changes. It differs from
`permissions` in both directions: a custom role with the org-wide `datasources:write` but without
`datasources:permissions` may change targets but not manage grants, and one with
`datasources:read` and `datasources:permissions` but without write manages grants but cannot
change the source at all. An `edit` grant gives `write` without `changeTarget`. On a source the
caller cannot see, every flag is false. A test compares these flags with the routes' answers for
192 combinations of roles, team roles and grants.
Creating a source needs the org-wide `datasources:write` (the caller's role, not `access`).

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

Changing a `target` field (for example `host`, `port`, `user`, `sslMode`, `url`, `path`) needs
the org-wide `datasources:write` or an `admin` grant on the source; an `edit` grant may change the
name, the other settings and the limits, and re-enter secrets, but answers `403 forbidden` for a
target change. When the patch changes a `target` field,
every secret that is stored must be in the same patch, either with its value again or with `null`.
Otherwise the answer is `422 validation` with `field` naming the secret, so a stored password is
never sent to a new host without being entered again.

### Delete and restore

`DELETE` moves the data source to the trash and answers `204`. `POST .../restore` brings it back
(`404` when it is not in the trash). Purging is not available yet.

### Errors when saving

Each row's `reason` is in [Reasons](#reasons) (`settings.*`, `secrets.*`, `target.*`,
`request.*`, `datasource.*`).

| Status, code | When | `field` |
|---|---|---|
| `422 validation` | name empty or longer than 100 characters, unknown kind, unknown setting, wrong type, missing required field, secret sent in `settings`, unknown secret, port outside 1..65535, host with credentials, SQLite path not absolute, URL with credentials, query or fragment, `caCert` without a PEM certificate | the field name: `name`, `kind`, a settings field name such as `host`, `settings` (unknown setting), `secrets` (unknown secret) |
| `422 datasource_target_blocked` | the target is refused: SQLite file outside `datasources.sqlite_dirs`, in Kalzit's data directory, Kalzit's own database, missing, or a network path (every SQLite refusal has the same message, so it does not tell whether a file exists); a link-local or metadata address (`169.254.0.0/16`, `fe80::/10`, `fd00:ec2::254`); a host outside `datasources.allowed_targets` (when set) | `path`, `host` or `url` |
| `409 conflict` | another data source in use has this name (also when restoring) | `name` |
| `422 validation` | MongoDB: the login may do more than read, or the server has no access control (see [MongoDB](#mongodb-a-pipeline-or-find)) | `user` |
| `422 datasource_target_blocked` | MongoDB: a host the SRV records or the driver name is refused | `hosts` |

Name resolution happens when connecting, so a host name that resolves to a refused address is
reported by the query, health and schema routes, not when saving. MongoDB is the exception: when
its settings or secrets are saved, Kalzit connects (waiting at most 4 seconds for a server) and
checks the login's privileges; a refused target or a login that may write refuses the save. A
server that cannot be reached, or a wrong password, does not stop the save; the check runs again
on every connect.

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
- MongoDB: the driver resolves names and connects on its own, also to the replica set members and
  SRV targets a server names. All of its connections go through a SOCKS5 relay inside Kalzit on
  the loopback interface (random credentials per source, so no other local process can use it),
  which resolves and checks every name and connects to the checked address; TLS runs end to end
  with the real host name. Queries only go to the primary, a `mongos` or the one server of a
  direct connection, and so do the commands Kalzit sends itself (`connectionStatus`, `hostInfo`,
  `buildInfo`, `listCollections`, `listIndexes`). A deployment whose topology names a Unix socket
  path as a member (only Unix systems read such an address as a socket) is refused as a whole with
  `mongodb.socket_member`; the driver's monitor may still have sent its handshake (`hello`) there
  once, which the systemd setting `RestrictAddressFamilies` (docs/ARCHITECTURE.md) prevents.
  Kalzit's own database is
  never MongoDB, so for MongoDB the address rules are what applies.
- The block list holds the link-local range (which contains the usual cloud metadata address
  `169.254.169.254`) and AWS's IPv6 metadata address. Alibaba Cloud's metadata service
  (`100.100.100.200`) lies in the carrier-grade NAT range used by private networks and is not
  blocked; on Alibaba Cloud, restrict sources with `datasources.allowed_targets`.

## Test connection: `POST /orgs/{orgId}/datasources/{datasourceId}/health`

Body: none or `{}`. Always `200`, also when the source fails:

```json
{ "ok": true, "reason": "health.connected", "params": { "engine": "PostgreSQL", "version": "17.2" },
  "message": "PostgreSQL 17.2", "latencyMs": 12 }
{ "ok": false, "reason": "source.error", "params": { "detail": "password authentication failed for user \"leser\"" },
  "message": "password authentication failed for user \"leser\"", "latencyMs": 40, "code": "datasource_error" }
```

- `reason` and `params` are what the UI shows (see [Reasons](#reasons)); `message` is the English
  fallback. `params` is omitted when empty.
- When `ok` is true, `reason` is `health.connected` (`engine`, `version`),
  `health.connected_read_only` (SQLite: the file is opened read-only), `health.prometheus_answered`
  (`engine`) or `health.connected_admin_login` (`engine`, `version`: the login has administrator
  rights, PostgreSQL superuser or SQL Server sysadmin; the text should advise a read-only login).
  MongoDB answers `health.connected` (`engine` `MongoDB`) after the privilege check (run again on
  every test, also with a client built earlier) and a read of
  the database's collections; a login that may do more than read answers `ok: false` with
  `mongodb.login_not_read_only` or `mongodb.access_control_off`.
- `code` (only when `ok` is false) is `datasource_error`, `datasource_target_blocked` or
  `query_timeout`, with the failure's reason.
- Messages and params never contain secrets.

## Schema: `GET /orgs/{orgId}/datasources/{datasourceId}/schema`

SQL kinds:

```json
{ "kind": "tables", "tables": [{ "schema": "public", "name": "bestellungen", "columns": [{ "name": "menge", "type": "integer" }] }] }
```

`schema` is omitted for SQLite. Prometheus:

```json
{ "kind": "metrics", "metrics": ["up", "http_requests_total"], "labels": ["instance", "job"] }
```

MongoDB lists the database's collections (up to 1,000, by name, without `system.*`). The first
100 also get their indexes (keys in index order) and the field paths of a random sample of up to
100 documents (`$sample`, 2 seconds each; `sampled` is 0 where the sample did not run or failed).
`fields` has the form of the result schema (see [The documents shape](#the-documents-shape)).

```json
{ "kind": "collections", "database": "shop", "collections": [{
  "name": "bestellungen", "type": "collection",
  "indexes": [{ "name": "ts_land", "keys": [{ "field": "ts", "kind": -1 }, { "field": "land", "kind": 1 }], "unique": true }],
  "fields": [{ "path": "land", "coverage": 1, "types": [{ "name": "string", "share": 1 }] }],
  "sampled": 100 }] }
```

`type` is `collection`, `view` (no indexes) or `timeseries`.

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
  `{"error": {"code", "message", "reason", "params"}}`; one failing query does not fail the
  others. `not_found` and `forbidden` carry no `reason`: the code says it all.

Per-query error codes: `not_found` (no such data source in this organization), `forbidden`,
`query_rejected` (not a single read-only `SELECT`/`WITH`, a forbidden function, a writing stage,
a variable without a value, wrong query form), `datasource_target_blocked`, `datasource_error`,
`query_timeout`.

Queries run in parallel, at most 8 at a time per user and 64 on the whole server (more wait,
within their timeout); "Test connection" and schema reads count against the same limits. Results
of all running requests together are held to 1 GiB. Queries are cancelled when the client goes away
(SQL Server receives a cancel; PostgreSQL and MySQL/MariaDB also stop by their server-side time
limit). SQL and Prometheus results are frames, MongoDB results are documents (see
[MongoDB](#mongodb-a-pipeline-or-find)). Frames:

- Field types: `time` (Unix ms), `number`, `int64` (decimal strings, e.g. `COUNT(*)` and `BIGINT`),
  `string`, `bool`, `json`; missing values are `null`. `NUMERIC`/`DECIMAL` are `number`.
- SQLite types a column by its declared type, by SQLite's affinity rules: `INTEGER` (and every
  type containing `INT`) is `int64`; `REAL`, `FLOAT`, `DOUBLE` are `number`; `TEXT`, `CHAR`,
  `VARCHAR`, `CLOB` are `string`; `BOOLEAN` is `bool`; `DATE`, `TIME`, `DATETIME`, `TIMESTAMP` are
  `time`. So a table without rows still answers its types. Columns without a declared type
  (expressions such as `r * 2`), with `NUMERIC`/`DECIMAL` (which hold integers and reals alike) or
  with an unknown type take the type of their first value; without any value they are `string`.
  A value is converted to the column's type where nothing is lost: an integer in a `number`
  column, a whole-number REAL in an `int64` column (its integer). Any other value that does not
  fit, such as `2.5` in an `int64` column, is `null`; one `frame.value_mismatch` notice per
  column says how many (`count`, counting only rows in the answer, not one the row limit cut).
- Numbers in a SQLite `time` column are Unix time: a value whose magnitude is above 10^11 is
  milliseconds, any other value seconds (what `unixepoch()` returns; fractions are kept to the
  millisecond). 10^11 seconds lie in the year 5138 and 10^11 milliseconds in 1973, so both
  readings cover the dates people store. Text is read in the forms SQLite's date functions write.
  A time outside the years 1 to 9999 (for example a huge number) is `null` and counts as a
  mismatch.
- SQLite reads the file's current schema on every query, so a table recreated with other column
  types answers with its new types at once.
- `meta.executedQuery` is the statement as sent, with placeholders instead of values.
- Hitting the row limit (`datasources.max_rows`, the source's `maxRows`, the query's `limit`) or the
  response size limit (`datasources.max_response_bytes`, shared by all queries of the request)
  cuts the frame: `meta.rowsTruncated` is true and `meta.notices` says why. Columns of types the
  server cannot show are `null` with a notice.
- A notice is `{ "severity": "info" | "warning", "code", "params", "text" }`: `code` is a reason
  from [Reasons](#reasons) (`frame.*`, `prometheus.warning`), `text` the English fallback.

### SQL kinds: `{"sql": "..."}`

Exactly one `SELECT` or `WITH` statement. Rejected: other statements, several statements,
`SELECT ... INTO`, `FOR UPDATE`/`FOR SHARE` and other locking clauses, data-modifying `WITH`,
MySQL executable comments (`/*! ... */`), and file, network and session functions (`LOAD_FILE`,
`pg_read_file`, `lo_import`, `dblink`, `query_to_xml`, `OPENROWSET`, `OPENDATASOURCE`,
`OPENQUERY`, `load_extension`, named locks, `NEXT VALUE FOR`, functions with server-side effects
such as WAL switches, statistics resets, replication slots, backups, advisory locks and
sequences, ...), also when used as a table in `FROM`. PostgreSQL Unicode-escaped names and strings
(`U&"..."`, `U&'...'`) are refused. SQL Server table hints other than `NOLOCK` and
`READUNCOMMITTED` (on tables, joins and CTE references, also in the old `t (HINT)` form) and query
hints (`OPTION (...)`) are refused. MySQL/MariaDB: `--` starts a comment only before a space or control character, as on the
server. PostgreSQL and MySQL/MariaDB run in a read-only transaction; SQLite opens the file
read-only; every transaction is rolled back. PostgreSQL queries run with
`standard_conforming_strings = on`; MySQL/MariaDB sessions run with `sql_mode =
NO_ENGINE_SUBSTITUTION` (no `ANSI_QUOTES`, no `NO_BACKSLASH_ESCAPES`), so the server reads the text
as the check did. A MySQL/MariaDB server that supports neither `max_execution_time` nor
`max_statement_time` is refused, since its queries could not be stopped.

Macros and variables become bind parameters; the only variable text in the SQL is a quoted
identifier, and only from the source's schema:

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

`cursor` on a query (and `cursors` on the panel route) continues document results; SQL and
Prometheus sources ignore it.

### MongoDB: a pipeline or `find`

```json
{ "collection": "bestellungen",
  "pipeline": "[{\"$match\": {\"land\": \"${land}\", \"$__timeFilter\": \"ts\"}}, {\"$sort\": {\"ts\": -1}}]" }
{ "collection": "bestellungen", "filter": "{\"status\": \"bezahlt\"}", "projection": "{\"betrag\": 1}",
  "sort": "{\"ts\": -1}", "skip": 0, "limit": 100 }
```

- `collection` is a collection (or view) of the source's `database`, not `system.*`.
- `pipeline`, `filter`, `projection` and `sort` are **text** holding MongoDB Extended JSON
  (canonical or relaxed: `{"$oid": "..."}`, `{"$date": "2025-01-01T00:00:00Z"}`,
  `{"$numberDecimal": "1.5"}`, ...). Text keeps the key order, which `$sort` and exact
  sub-document matches depend on; a JSON object instead of text is `query.invalid_form`.
- A query is either `pipeline` (an array of stages) or the `find` fields; both together is
  `mongodb.pipeline_and_find`. Empty `filter` text means all documents. Other fields are refused.
- Only `aggregate` and `find` are ever sent for a query; there is no form for other commands.

Read-only check (on the BSON as sent, after binding; `query_rejected`):

- Every stage, also inside `$lookup` and `$unionWith` pipelines and `$facet`, must be one of
  `$addFields`, `$bucket`, `$bucketAuto`, `$count`, `$densify`, `$facet`, `$fill`, `$geoNear`,
  `$graphLookup`, `$group`, `$limit`, `$lookup`, `$match`, `$project`, `$redact`, `$replaceRoot`,
  `$replaceWith`, `$sample`, `$search`, `$searchMeta`, `$set`, `$setWindowFields`, `$skip`,
  `$sort`, `$sortByCount`, `$unionWith`, `$unset`, `$unwind`, `$vectorSearch` (names as written,
  case-sensitive). `$out` and `$merge` are `mongodb.write_stage`; anything else (`$currentOp`,
  `$collStats`, `$documents`, stages of future versions) is `mongodb.stage_not_allowed`.
- `$where`, `$function`, `$accumulator`, `$out` and `$merge` are refused as keys at any depth, in
  any letter case (`$expr` with `$function` included); JavaScript code values (`{"$code": ...}`)
  are refused.
- An operator key with invisible characters (zero-width, soft hyphen, controls, spaces,
  direction marks, tags), a full-width or small dollar sign, full-width letters or any non-ASCII
  letter is `mongodb.key_obfuscated`. Field names without a leading dollar are data and may hold
  any character.
- `$lookup` takes only `from`, `localField`, `foreignField`, `as`, `let` and `pipeline`;
  `$unionWith` only `coll` and `pipeline` (or a collection name); `$graphLookup` only `from`,
  `startWith`, `connectFromField`, `connectToField`, `as`, `maxDepth`, `depthField` and
  `restrictSearchWithMatch`. Any other argument (`db`, say) is `mongodb.stage_invalid`.
- The source's `database` may not be `admin`, `local` or `config` (`mongodb.database_reserved`).
- `$lookup.from`, `$graphLookup.from` and `$unionWith` name collections of the same database as
  text; another database (`{"db": ..., "coll": ...}`) or `system.*` is refused.
- The real boundary is the login: Kalzit checks it with `connectionStatus` (`showPrivileges`)
  whenever it builds a client (every 10 minutes at the latest), on "Test connection" and when the
  source is saved. With a login, the server must report it and its privileges (otherwise
  `mongodb.privileges_unknown`). Every privilege must be one of those of the `read` and `readAnyDatabase`
  roles (`changeStream`, `collStats`, `dbHash`, `dbStats`, `find`, `killCursors`,
  `listCollections`, `listDatabases`, `listIndexes`, `listSearchIndexes`, and `planCacheRead` and
  `performRawDataOperations` (MongoDB 8.2) on the source's own database (any collection), as the
  `read` role grants them there; on other databases or cluster-wide they are refused);
  anything more, on any database, is `mongodb.login_not_read_only` (`action`, `resource`). A
  server where `hostInfo` succeeds although no such privilege was granted checks no rights at all
  and is refused with `mongodb.access_control_off`.

Macros and variables become typed BSON values, never text spliced into JSON:

| Write | Becomes |
|---|---|
| `{"$__timeFilter": "ts"}` (a key, in `$match` and filters) | `"ts": {"$gte": <from>, "$lte": <to>}` as dates |
| `"$__timeFrom"`, `"$__timeTo"` (a whole string) | the range's ends as dates |
| `"$__interval_ms"` | the interval in milliseconds (64-bit integer) |
| `"${name}"` (a whole string) | the variable's value: text, a number (64-bit integer or double), a boolean, or a list of them (an array) |

Arguments that must be constants stay plain values: `$graphLookup` `connectFromField`,
`connectToField`, `as`, `maxDepth`, `depthField`; `$bucket` `boundaries` and `default`;
`$bucketAuto` `buckets` and `granularity`; all of `$densify`; `sortBy` and `partitionByFields`
of `$setWindowFields` and `$fill`, and their output `window` and `method`.

In aggregation expressions (`$project`, `$group`, `$expr`, `$lookup.let`, ...) a variable's value
is wrapped in `{"$literal": ...}`, so a text such as `"$preis"` stays text instead of reading a
field; in `$match`, filters, `$sort`, `$limit` and the like it is the plain value. Objects as
values, variables in keys or inside longer text, unknown `$__` macros and `$__timeFilter` in an
expression are refused.

Limits: `maxTimeMS` is set to the query's time limit, so the server stops the query itself;
leaving the request also ends the cursor (`killCursors`). Kalzit appends `$skip` (when continuing)
and `$limit` (the document limit plus one) to a pipeline and sets `skip`/`limit` on a `find`.
At the document limit (`datasources.max_rows`, `maxRows`, the query's `limit`) or the response
size limit (`datasources.max_response_bytes`, the source's `maxResponseBytes`) the set is cut:
`truncated` is `{"limit": <documents returned>}`, a notice says why, and `nextCursor` continues it.
A `$sample` size above the document limit is lowered to it. In `find`, `limit: 0` means no
limit, as in MongoDB (the document limit still holds). Documents keep the field order the
database stored. A cursor belongs to its query, time range and variables; with any other it is
`mongodb.cursor_invalid`. A `limit` in a `find` query is the query's own: reaching it is no cut.

### The documents shape

```json
{ "shape": "documents", "documents": {
  "documents": [{ "_id": { "$type": "objectId", "value": "65f0c1a2b3c4d5e6f7a8b9c0" }, "menge": 3,
                  "betrag": { "$type": "decimal", "value": "12.50" }, "ts": { "$type": "date", "value": "1800000000000" } }],
  "schema": [{ "path": "menge", "coverage": 1, "types": [{ "name": "int", "share": 1 }] }],
  "nextCursor": "MjAwOmFiY2Q", "truncated": { "limit": 200 },
  "notices": [{ "severity": "warning", "code": "documents.limit", "params": { "limit": "200" }, "text": "..." }],
  "executedQuery": "bestellungen.aggregate([...])" } }
```

Values JSON has no type for keep their BSON type as `{"$type", "value"}`:

| BSON | JSON |
|---|---|
| string, boolean, null, Int32, finite double | as is |
| array, embedded document | array, object (nested values follow the same rules) |
| Int64 | `{"$type": "int64", "value": "9007199254740993"}` |
| Decimal128 | `{"$type": "decimal", "value": "12.50"}` |
| ObjectId | `{"$type": "objectId", "value": "<24 hex digits>"}` |
| Date | `{"$type": "date", "value": "<Unix milliseconds>"}` (text, so dates outside JavaScript's range stay exact) |
| NaN, Infinity | `{"$type": "double", "value": "NaN"}`, `"Infinity"`, `"-Infinity"` |
| Binary, UUID subtype (4) | `{"$type": "uuid", "value": "0199f0a0-..."}` |
| Binary, other subtypes | `{"$type": "binary", "value": null}`, with one `documents.binary_hidden` notice per path (at most 20) |
| Timestamp | `{"$type": "timestamp", "value": "<seconds>:<increment>"}` |
| regular expression | `{"$type": "regex", "value": "/pattern/options"}` |
| JavaScript (with or without scope), symbol | `{"$type": "javascript", "value": "..."}`, `{"$type": "symbol", ...}` |
| MinKey, MaxKey, undefined | `{"$type": "minKey", "value": ""}`, `maxKey`, `undefined` |
| DBPointer | `{"$type": "dbPointer", "value": null}` |

A stored document with its own `$type` key is wrapped as `{"$type": "document", "value": {...}}`,
so it cannot be mistaken for a typed value.

`schema` is sampled from the first 1,000 documents of the result: every field path (`a.b`, array
elements as `items[]`, fields of documents in arrays as `items[].preis`, at most 2,000 paths, 32
levels) in the order it first appears, `coverage` (share of documents with the path, 0 to 1) and
`types` (per MongoDB type alias, as `$type` queries name them: `double`, `string`, `object`,
`array`, `binData`, `objectId`, `bool`, `date`, `null`, `regex`, `javascript`, `int`, `long`,
`decimal`, `timestamp`, ...: the share of the documents with the path where it has that type,
most common first; a path with several types in one document counts for each, so shares may add
up to more than 1).

## A dashboard's stored queries

Both routes run only what the dashboard's current version stores; the request adds the time
range, limits and variable values.

**Who may run them.** Reading the dashboard (`dashboards:read` on it, through the role, a folder
or a dashboard grant) is what authorizes its stored queries. The caller needs no data source
permission: viewers have none and still see their dashboards. This is safe because saving a
dashboard requires `datasources:query` on every data source its new or changed queries use, so
only sources an authorized editor placed there are reached, and only with the stored queries. A
data source must exist in the organization and not be in the trash (otherwise that target answers
`not_found`).

The consequence: the right to query a source is checked when a query is saved, not when it runs.
An editor who later loses access to a source leaves working dashboards behind; to stop such a
query, remove it from the dashboard (or move the dashboard where fewer people may read it).
Saving checks only queries that are new or changed against the stored version, so someone who may
edit a dashboard can rename or rearrange it without rights on its sources. Any change to a
variable definition (type, `current`, `options`, query) counts as a change of every stored query,
since variables shape what the queries read; a new or changed query
on a source the saver may not query answers `403 forbidden` naming the source, and an id that
names no data source of the organization `422 validation` (`field: model`).

A dashboard the
caller cannot read (another organization, a restricted folder without a grant, unknown or in the
trash) answers `404 not_found`, and so do unknown panels and variables.

**Variables.** `variables` may only name variables the dashboard defines; at most 100, names of
letters, digits and `_`, all values together at most 64 KiB (these limits also hold for
`POST /query`). `timeRange` and `intervalMs` (1 ms to one year) as for free queries. Per type:

- `constant`: the value is the dashboard's (`current`, or `current.value`); sending one is refused.
- `custom`: the value, or each value of a list, must be one of the variable's `options` (a list of
  values or of `{"value": ..., "label": ...}` objects).
- `query`, `textbox`, `interval`: free values. They are bound as parameters in SQL and escaped into
  quoted strings in PromQL. Inside a PromQL regex matcher (`=~`, `!~`) a free value is also
  regex-escaped, so it matches literally (`.+` matches the text `.+`); constant and custom values
  are kept as written there, so a dashboard may offer a pattern such as `.*`. In free queries every
  variable value is regex-escaped in regex matchers.
- Only `constant` and `custom` variables may be used as identifiers (`${x:identifier}`), since only
  their values are checked against the dashboard's own list; any other variable used that way
  answers `query_rejected` for that target. Identifiers must also be in the source's schema.

Breaking a rule answers `422 validation` with `field: variables`. The same rules hold for
Prometheus label matchers.

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

## Export

A query result after its analysis steps (docs/api/settings-dashboards.md, "Analysis steps") as a
file. The server runs the queries and the steps itself, so the file is made only after the same
checks as running them, plus `data:export` (editor and up by default; viewers do not have it). A
browser-side export would need the data in the browser first and could not be refused.

- `POST /orgs/{orgId}/export`, body `ExportRequest`: the fields of `QueryRequest` (`queries`,
  `timeRange`, `intervalMs`, `maxDataPoints`, `variables`), plus `steps` (default none),
  `format`, `language`, `frame` (the `refId` to export after the steps; the first frame when
  absent) and `title` (the file name's base). Every data source needs `datasources:query` (role
  or grant); one the caller may not query refuses the whole export (`403` or `404`).
- `POST /orgs/{orgId}/dashboards/{dashboardId}/panels/{panelId}/export`, body
  `PanelExportRequest` (`timeRange`, `intervalMs`, `maxDataPoints`, `variables`, `format`,
  `language`, `frame`): the panel's stored queries and stored steps, with the rules of the panel
  query route (`dashboards:read` on the dashboard, variables checked against it). Named after the
  panel's title, or the dashboard's.

The answer is the file with `Content-Disposition: attachment; filename="..."` (letters, digits,
`-`, `_`) and `Cache-Control: no-store`. Every export writes the audit event `data.exported` with
the format, the number of rows and the panel or the data sources, never the data.

- `csv`: RFC 4180, UTF-8 with a byte order mark (so Excel reads it as UTF-8), CRLF line ends.
  `language` `de` separates with `;` and writes a decimal comma, `en` uses `,` and a decimal
  point. Numbers keep every digit (`1e+21` from 10^21 on), `int64` its digits, times ISO 8601 in
  UTC, booleans `true`/`false`, `json` compact JSON. Text that starts with `=`, `+`, `-`, `@`, tab
  or carriage return gets a leading `'` (field names too), so a spreadsheet never runs it as a
  formula.
- `xlsx`: one sheet, bold frozen header row, typed cells: numbers, booleans and times (UTC, shown
  as `yyyy-mm-dd hh:mm:ss.000`). `int64` beyond 2^53 and times before 1900-03-01 are text; text is
  cut at Excel's 32,767 characters; at most 1,048,575 rows and 16,384 columns. Written with
  `rust_xlsxwriter` (maintained, no default features, writes cells and never formulas).
- `json`: the result envelope of the frame, `{"shape": "frame", "frame": {...}}`.

Documents become exportable through a projection step (`toFrame`); their own formats (JSON,
NDJSON) and graphs (GraphML, JSON) follow with M2 and M3, until then such a result answers
`export.shape_unsupported`. Steps that are not valid answer `422 validation` with reason
`steps.invalid` and `field: steps`; a step that fails answers its own reason with `field: steps`
and a message naming the step. A failing query answers its error as the variable options route
does: a file never holds less than was asked for.

## Reasons

Errors carry `error.reason` and `error.params` next to `error.code` and `error.message`; health
answers carry `reason` and `params`; notices carry `code` and `params`. Reasons are stable; the
UI translates them (`params` fill the text, for example `{name}`), and `message`/`text` is the
English fallback with the same content. `params` is omitted when empty, and its values are text.
`detail` params hold a database's or a library's own wording (English, untranslated), scrubbed of
secrets. Errors with the codes `not_found`, `forbidden` (unless listed), `internal`,
`unauthenticated` and `payload_too_large` carry no reason.

### Requests and data sources

| Reason | Params | When |
|---|---|---|
| `request.body_invalid` | `detail` | the JSON body is malformed, has unknown fields or wrong types |
| `request.query_invalid` | `detail` | the list's query string has unknown parameters |
| `request.limit` | `max` | `limit` outside 1 to `max` |
| `request.trash` | | `trash` is not `true` or `false` |
| `request.cursor` | | `cursor` is not valid |
| `request.name_length` | `field`, `max` | the name is empty or longer than `max` characters |
| `request.name_control_characters` | `field` | the name contains control characters |
| `datasource.kind_unknown` | `kind` | no such data source kind |
| `datasource.kind_unavailable` | `kind` | the stored source's kind is not available on this server |
| `datasource.name_taken` | | another data source in use has this name (`409 conflict`) |
| `datasource.target_change_forbidden` | `field` | `403 forbidden`: changing a target field needs the admin level |

### Settings and secrets (`422 validation`, `field` set)

Every reason here has the param `field` (the setting's name, or `settings`/`secrets`).

| Reason | Params | When |
|---|---|---|
| `settings.not_object` | | `settings` is not an object |
| `settings.too_large` | | the settings are too large |
| `settings.unknown` | `name` | not a setting of this kind |
| `settings.secret_in_settings` | | a secret was sent in `settings` |
| `settings.expected_text` | | the value must be text |
| `settings.expected_number` | | the value must be a whole number of at least 0 |
| `settings.expected_bool` | | the value must be true or false |
| `settings.expected_option` | `options` (comma-separated) | the value must be one of `options` |
| `settings.control_characters` | | the value contains control characters |
| `settings.required` | | a required setting is missing |
| `settings.out_of_range` | `min`, `max` (when bounded) | `queryTimeoutSecs` 1 to 3600, `maxRows` at least 1 |
| `settings.host_credentials` | | the host contains credentials |
| `settings.host_invalid` | | the host is not a host name or IP address |
| `settings.port_invalid` | | the port is outside 1 to 65535 |
| `settings.pem_invalid` | | `caCert` holds no PEM certificate |
| `settings.path_relative` | | the SQLite path is not absolute |
| `settings.url_invalid` | `detail` | the URL cannot be parsed |
| `settings.url_scheme` | | the URL is not `http://` or `https://` |
| `settings.url_credentials` | | the URL contains credentials |
| `settings.url_query` | | the URL contains a query or fragment |
| `settings.url_no_host` | | the URL has no host |
| `settings.invalid` | `detail` | the settings do not fit the kind (other cases) |
| `mongodb.too_many_hosts` | `max` | more than `max` hosts |
| `mongodb.srv_host` | | with SRV, `hosts` is not exactly one host name without a port |
| `mongodb.database_invalid` | | not a MongoDB database name (with `/`, `\`, `.`, `"`, `$` or a space, or longer than 63) |
| `mongodb.database_reserved` | | `admin`, `local` or `config`, the server's own databases |
| `mongodb.ca_without_tls` | | `caCert` is set but TLS is off |
| `secrets.unknown` | `name` | not a secret of this kind |
| `secrets.too_long` | | the secret is too long |
| `secrets.resend_on_target_change` | `field`, `secret` | a target changed; send `secret` again or remove it |

### Targets (`datasource_target_blocked`, or `datasource_error` where noted)

| Reason | Params | When |
|---|---|---|
| `target.sqlite_path_refused` | | the SQLite file is outside the allowed directories, in Kalzit's data directory, Kalzit's own database, missing, or a network path (one reason for all, so it does not tell whether a file exists) |
| `target.sqlite_path_relative` | | the SQLite path is not absolute |
| `target.metadata_address` | `address` or `host` | a link-local or cloud metadata address (also when a name resolves to one) |
| `target.not_allowed` | `host` | the host is outside `datasources.allowed_targets` |
| `target.scheme_not_allowed` | `scheme` | a URL scheme other than http(s) |
| `target.own_database` | | the source is Kalzit's own database |
| `target.own_database_unverifiable` | | `datasource_error`: a PostgreSQL-compatible server where Kalzit cannot verify that it is not its own database |
| `target.unresolvable` | `host`, `detail` | `datasource_error`: the host name does not resolve |
| `target.unreachable` | `host`, `detail` | `datasource_error`: no address of the host accepts a connection |
| `mongodb.srv_target` | | an SRV record names a target that is not a host |
| `mongodb.socket_member` | | the deployment names a Unix socket as a member |

### Queries (`query_rejected` unless noted)

| Reason | Params | When |
|---|---|---|
| `query.invalid_form` | `detail` | the query object does not fit the kind (`{"sql"}`, `{"expr", ...}`) |
| `query.count` | `max` | `422 validation`: not 1 to `max` queries |
| `query.ref_id` | | `422 validation`: a `refId` is empty, longer than 64 characters or repeated |
| `query.range_out_of_bounds` | | `422 validation`: `timeRange` outside the years 1 to 9999 |
| `query.range_reversed` | | `422 validation`: `timeRange.from` after `timeRange.to` |
| `query.interval_out_of_range` | | `422 validation`: `intervalMs` outside 1 ms to one year |
| `query.time_out_of_range` | `time` | a bound time the database cannot hold |
| `query.write_refused` | `detail` | the database refused a write (read-only transaction) |
| `query.timeout` | `seconds` | `query_timeout`: the query ran past its time limit |
| `query.statement_timeout` | | `datasource_error`: PostgreSQL cancelled it at its statement timeout |
| `query.stopped` | | `datasource_error`: SQLite stopped the statement |
| `sql.empty` | | the query is empty |
| `sql.multiple_statements` | | more than one statement |
| `sql.not_select` | | not a `SELECT`/`WITH` (also data-modifying `WITH`) |
| `sql.select_into` | | `SELECT ... INTO` |
| `sql.locking_clause` | | `FOR UPDATE`, `FOR SHARE` and similar |
| `sql.function_not_allowed` | `name` | a file, network, session or side-effect function |
| `sql.sequence` | | `NEXT VALUE FOR` (SQL Server) |
| `sql.table_hint` | `hint` | a SQL Server table hint other than `NOLOCK`/`READUNCOMMITTED` |
| `sql.legacy_table_hint` | `alias` | the old `t (HINT)` form |
| `sql.query_hint` | | `OPTION (...)` |
| `sql.executable_comment` | | MySQL `/*! ... */` |
| `sql.unicode_escape` | | PostgreSQL `U&"..."`, `U&'...'` |
| `sql.dash_comment_space` | | MySQL `--` followed by a non-ASCII space |
| `sql.placeholder` | | hand-written `$1`, `?`, `@P1`, `:name` |
| `sql.parse_error` | `detail` | the statement cannot be parsed for the check |
| `sql.unclosed_quote`, `sql.unclosed_bracket`, `sql.unclosed_comment`, `sql.unclosed_dollar_quote`, `sql.unclosed_variable`, `sql.unclosed_time_filter` | | an unclosed string, `[...]`, comment, `$tag$`, `${...}` or `$__timeFilter(` |
| `sql.macro_unknown` | `name` | an unknown `$__` macro |
| `sql.time_filter_column` | | `$__timeFilter()` without a column |
| `sql.variable_name_invalid` | `name` | an invalid name in `${...}` |
| `sql.variable_format_unknown` | `format` | `${x:format}` other than `:identifier` |
| `sql.variable_missing` | `name` | a variable without a value |
| `sql.variable_type` | `name` | a variable that is not a string, number, boolean or list of them |
| `sql.identifier_variable_not_allowed` | `name` | `${x:identifier}` with a variable other than constant or custom (dashboard routes) |
| `sql.identifier_unknown` | `name` | an identifier value that is not a table or column of the source |
| `sql.identifier_needs_schema` | | identifier variables without the source's schema |
| `promql.unclosed_quote` | | an unclosed quote in PromQL |
| `promql.macro_unknown` | `name` | an unknown `$__` macro |
| `promql.variable_outside_string` | `name` | a variable outside a quoted label value |
| `promql.variable_missing` | `name` | a variable without a value |
| `promql.variable_type` | `name` | a variable that is not a string, number, boolean or list of them |
| `promql.backtick` | `name` | a value with a backtick inside a `raw` string |
| `mongodb.json_invalid` | `field`, `detail` | `pipeline`, `filter`, `projection` or `sort` is not valid Extended JSON |
| `mongodb.not_a_document` | `field` | `filter`, `projection` or `sort` is not a JSON object |
| `mongodb.pipeline_not_array` | | the pipeline (or a nested one) is not an array |
| `mongodb.pipeline_and_find` | | `pipeline` together with `find` fields |
| `mongodb.stage_invalid` | | a stage that is not an object with exactly one stage name |
| `mongodb.write_stage` | `stage` | `$out` or `$merge` |
| `mongodb.stage_not_allowed` | `stage` | a stage that is not on the reading list |
| `mongodb.operator_not_allowed` | `operator` | `$where`, `$function`, `$accumulator`, `$out` or `$merge` as a key, in any case |
| `mongodb.javascript` | | a JavaScript code value |
| `mongodb.key_obfuscated` | `key` | an operator key with hidden or look-alike characters |
| `mongodb.collection_invalid` | `name` | not a collection name, or a collection of another database |
| `mongodb.system_collection` | `name` | a `system.*` collection |
| `mongodb.macro_unknown` | `name` | an unknown `$__` macro |
| `mongodb.time_filter_field` | | `$__timeFilter` without a field name |
| `mongodb.time_filter_context` | | `$__timeFilter` inside an expression |
| `mongodb.time_filter_conflict` | `field` | the field is filtered twice |
| `mongodb.variable_name_invalid` | `name` | an invalid name in `${...}` |
| `mongodb.variable_missing` | `name` | a variable without a value |
| `mongodb.variable_type` | `name` | a variable that is not text, a number, a boolean or a list of them |
| `mongodb.variable_in_text` | | `${...}` inside longer text |
| `mongodb.variable_in_key` | | `${...}` in a key |
| `mongodb.cursor_invalid` | | the cursor does not belong to this query |

### Dashboard variables (`422 validation`, `field: variables`, unless noted)

| Reason | Params | When |
|---|---|---|
| `variables.too_many` | `max` | more than `max` variables |
| `variables.name_invalid` | `name` | not a variable name |
| `variables.too_large` | `bytes` | all values together exceed `bytes` |
| `variables.unknown` | `name` | the dashboard has no such variable |
| `variables.constant` | `name` | a value was sent for a constant |
| `variables.not_an_option` | `name`, `value` | a custom variable's value outside its options |
| `variables.value_type` | `name` | not a value or a list of values |
| `variables.self_dependency` | `name` | the options request sends the variable's own value |
| `variables.not_a_query` | `name` | options asked for a variable that is not of type `query` (no `field`) |
| `variables.not_a_frame` | | the variable's query does not answer a table (no `field`) |

### Analysis steps and expressions

The browser shows these at the step; the export routes answer them as `422 validation` with
`field: steps` (docs/api/settings-dashboards.md, "Analysis steps"). `type` params are field types (`time`, `number`, `int64`,
`string`, `bool`, `json`), `left`, `right`, `expected`, `found`, `first` and `second` in
`expression.*` are expression types (`number`, `text`, `bool`, `time`, `null`).

| Reason | Params | When |
|---|---|---|
| `steps.invalid` | `detail` | the steps sent with an export are not valid steps |
| `steps.frame_missing` | `frame` | no table of that query: it answered no table, or a join used it up |
| `steps.field_missing` | `field` | the table has no such field |
| `steps.field_ambiguous` | `field` | several fields have this name |
| `steps.field_type` | `field`, `type` | the field's type does not fit the step (a sum of text) |
| `steps.name_taken` | `name` | the step's result field has the name of an existing field |
| `steps.no_time_field` | `frame` | a join or comparison by time on a table without a time field |
| `steps.key_types` | `left`, `right` | join key fields of types that cannot be matched |
| `steps.too_many_rows` | `max` | the join would make more than `max` rows |
| `steps.too_many_columns` | `max` | the pivot would make more than `max` fields |
| `expression.empty` | | the expression is empty |
| `expression.too_long` | `max` | longer than `max` characters |
| `expression.too_deep` | `max` | nested deeper than `max` levels |
| `expression.syntax` | `at` | unexpected input at character `at` |
| `expression.unclosed` | `at` | a parenthesis, quote or bracket opened at `at` is not closed |
| `expression.number` | `at` | the number at `at` is too large |
| `expression.unknown_function` | `name` | no such function |
| `expression.arguments_exact` | `name`, `count` | the function takes `count` values |
| `expression.arguments_range` | `name`, `min`, `max` | the function takes `min` to `max` values |
| `expression.arguments_min` | `name`, `min` | the function takes at least `min` values |
| `expression.unit` | | `startOf` needs a unit in quotes |
| `expression.unknown_field` | `field` | the table has no such field |
| `expression.ambiguous_field` | `field` | several fields have this name |
| `expression.field_type` | `field`, `type` | a JSON field cannot be used in an expression |
| `expression.operand_types` | `operator`, `left`, `right` | the operator cannot combine these types |
| `expression.argument_type` | `name`, `position`, `expected`, `found` | a function's value of the wrong type |
| `expression.mixed_types` | `name`, `first`, `second` | `if`, `coalesce`, `min` or `max` mix types |
| `expression.null_compare` | | a comparison with `null`; `isnull(...)` is meant |
| `expression.no_type` | | the expression is always empty |

### Export (`422 validation`)

| Reason | Params | When |
|---|---|---|
| `export.no_queries` | | the panel has no query |
| `export.frame_missing` | `frame` | no table with this reference id after the steps (`field: frame`) |
| `export.shape_unsupported` | `shape` | documents and graphs cannot be exported yet |
| `export.too_many_rows` | `max` | Excel takes at most `max` rows |
| `export.too_many_columns` | `max` | Excel takes at most `max` columns |
| `export.failed` | `detail` | the file could not be written |

### Sources and the server (`datasource_error` unless noted)

| Reason | Params | When |
|---|---|---|
| `source.error` | `detail` | the database or Prometheus answered an error |
| `source.no_answer` | | the server sent no answer |
| `sqlite.open_failed` | `detail` | the SQLite file cannot be opened |
| `mysql.no_time_limit` | | the server supports neither `max_execution_time` nor `max_statement_time` |
| `mssql.login_timeout` | | SQL Server did not complete the login in time |
| `mongodb.login_not_read_only` | `action`, `resource` | the login may do more than read (also `422 validation` with `field: user` when saving) |
| `mongodb.privileges_unknown` | | a login is set, but the server reports no login or no privileges for it (also `422 validation` with `field: user` when saving) |
| `mongodb.access_control_off` | | the server checks no access rights (also `422 validation` when saving) |
| `mongodb.no_server` | `detail` | no suitable MongoDB server answered in time |
| `mongodb.srv_lookup` | `detail` | the SRV or TXT lookup failed |
| `prometheus.credentials_invalid` | | the credentials contain characters a header cannot carry |
| `prometheus.not_an_api_response` | `status` | the server answered without a Prometheus API response |
| `prometheus.error` | `status`, `detail` | Prometheus answered an error |
| `prometheus.result_type` | `type` | an unexpected result type |
| `http.timeout` | | the HTTP request timed out |
| `http.too_large` | `bytes` | the answer exceeded `bytes` |
| `http.failed` | `detail` | the HTTP request failed |
| `secrets.unreadable` | | the source's secrets cannot be read |
| `secrets.undecryptable` | `field` | a stored secret cannot be decrypted (key changed) |
| `settings.stored_invalid` | | the stored settings no longer fit the kind |
| `server.shutting_down` | | the server is shutting down |
| `internal` | | an unexpected failure; see the server log |

### Health and notices

| Reason or notice code | Params | Meaning |
|---|---|---|
| `health.connected` | `engine`, `version` | connected (`ok: true`) |
| `health.connected_admin_login` | `engine`, `version` | connected, but the login has administrator rights |
| `health.connected_read_only` | `engine`, `version` | SQLite: connected, the file is opened read-only |
| `health.prometheus_answered` | `engine` | the Prometheus API answered |
| `frame.row_limit` | `rows` | notice: the result was cut at `rows` rows |
| `frame.size_limit` | | notice: the result was cut at the response size limit |
| `frame.binary_hidden` | `column` (SQLite) | notice: binary values are not shown |
| `frame.type_unsupported` | `column`, `type` | notice: a column type the server cannot show |
| `frame.value_mismatch` | `column`, `count` | notice: `count` SQLite values of `column` do not fit its type and are empty |
| `prometheus.warning` | `detail` | notice: a warning from Prometheus |
| `documents.limit` | `limit` | notice: the set was cut at `limit` documents |
| `documents.size_limit` | | notice: the set was cut at the response size limit |
| `documents.binary_hidden` | `path` | notice: binary values at `path` are not shown |

## Not here yet

- Purging data sources from the trash, testing settings before saving.
