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
`sqlite`, `mssql`, `prometheus`, `elasticsearch`, `file`, `http_json`, `mongodb`, `neo4j`,
`memgraph`, `tigergraph`.

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
  - `elasticsearch`: "Use an account or API key with only the read privilege on the indices
    (and `monitor` on the cluster for the version check). Kalzit sends only searches, counts and
    mapping reads, but only the cluster's permissions are a real boundary."
  - `file`: "The file is only read. It must lie in a directory a server administrator allowed."
  - `http_json`: "Kalzit sends only GET requests. Use a token that can only read."
  - `mongodb`: "Use a login with only the read role on this database. Kalzit refuses logins that
    may do more, and servers without access control."
  - `neo4j`: "Use a user with only read rights (the reader role). Kalzit also runs every query in a
    read transaction, which Neo4j enforces."
  - `memgraph`: "Use a user that may only read (no CREATE, MERGE, SET, REMOVE or DELETE privilege).
    Memgraph does not enforce read transactions, so Kalzit checks the user and refuses one that
    may write, unless you allow it below (needed for Memgraph Community)."
  - `tigergraph`: "Use a user with only the queryreader role. TigerGraph has no read transaction:
    Kalzit checks the user's rights and refuses one that may write, and checks every query's
    text."
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
| `elasticsearch` | `url`* (`http(s)://host[:port][/path]`, no query), `basicAuthUser`, `basicAuthPassword` S, `apiKey` S (sent as `ApiKey <key>`), `bearerToken` S, `caCert`, `index` (default index or pattern), `timeField` (default `@timestamp`; empty: no time filter) |
| `file` | `path`* (absolute path of a CSV, JSON or NDJSON file), `format` (`auto` default, `csv`, `json`, `ndjson`), `delimiter` (`auto` default, `comma`, `semicolon`, `tab`, `pipe`), `decimal` (`auto` default, `point`, `comma`), `header` (bool, default true) |
| `http_json` | `url`* (`http(s)://host[:port][/path][?query]`), `basicAuthUser`, `basicAuthPassword` S, `bearerToken` S, `apiKeyHeader` (a header name such as `X-Api-Key`), `apiKey` S (sent in that header), `caCert`, `documentsPath` (where the documents are in the answer, see below) |
| `mongodb` | `hosts`* (`host`, `host:port` or `[v6]:port`, comma-separated, at most 50), `port` (27017, for hosts without one), `srv` (bool, default false: `mongodb+srv`, `hosts` is one name without port), `replicaSet`, `database`*, `user`, `password` S, `authSource` (default: `database`; with SRV the TXT record's, else `admin`), `tls` (bool; default false, true with SRV), `caCert` (needs TLS), `maxResponseBytes` (at least 1, within the server's limit) |
| `neo4j` | `host`*, `port` (7687), `database` (the server's default database when empty), `user`, `password` S, `encrypt` (bool, default false: Bolt with TLS), `trustServerCertificate` (bool, default false), `caCert`, `maxNodes` (10,000), `maxEdges` (50,000) |
| `memgraph` | as `neo4j`, plus `allowWriteCapableUser` (bool, default false, a target field) |
| `tigergraph` | `url`* (the GSQL server, such as `https://tg.intern:14240`), `restppUrl` (REST++; default `<url>/restpp`), `graph`*, `user`*, `password` S, `secret` S (REST++ secret for tokens), `caCert`, `approvedQueries` (text: installed query names separated by commas or line breaks, a target field), `maxNodes`, `maxEdges` |

`maxNodes` and `maxEdges` (at least 1) limit graph answers; both are capped by the row limit
(`maxRows` and the server's `datasources.max_rows`). `allowWriteCapableUser` and
`approvedQueries` are target fields although they name no address: they decide what runs with the
stored secrets, so only a data source admin may change them, and only with the secrets again.

`elasticsearch` covers OpenSearch too; "Test connection" tells which one answered. With several
credentials set, `basicAuthUser` wins, then `apiKey`, then `bearerToken` (`http_json`: basic, then
bearer; the API key header is sent in addition). `file` with `format: auto` reads the file name:
`.csv`, `.tsv` (tab-separated), `.txt` as CSV, `.json` as JSON, `.ndjson` and `.jsonl` as NDJSON;
any other name needs a format (`settings.file_format_unknown`). `apiKeyHeader` may not be
`Authorization`, `Host`, `Accept`, `Content-Type`, `Content-Length`, `Connection` or
`Transfer-Encoding` (`settings.header_name_invalid`).

i18n keys the UI needs: `datasources.settings.<name>` for every field name above plus
`queryTimeoutSecs` and `maxRows`, and `datasources.kinds.<kind>.hint` for each kind. For
`mongodb`, `maxRows` limits documents. TigerGraph's `url`, `secret` and `graph` use the labels
`datasources.settings.gsqlUrl`, `datasources.settings.restppSecret` and
`datasources.settings.graph`.

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
| `422 datasource_target_blocked` | the target is refused: SQLite file outside `datasources.sqlite_dirs`, in Kalzit's data directory, Kalzit's own database, missing, or a network path (every SQLite refusal has the same message, so it does not tell whether a file exists); a CSV or JSON file outside `datasources.file_dirs` (the same rules and the same single message); a link-local or metadata address (`169.254.0.0/16`, `fe80::/10`, `fd00:ec2::254`); a host outside `datasources.allowed_targets` (when set) | `path`, `host` or `url` |
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
- Data source HTTP traffic (Prometheus, Elasticsearch/OpenSearch, HTTP JSON, TigerGraph) never
  uses a proxy; `HTTP_PROXY` and similar variables are ignored. A proxy would resolve names
  itself, past the target check. A URL with a user name or password, also as a redirect target,
  is refused (`target.url_credentials`). Redirects are followed up to five times, each target
  checked like the first (Elasticsearch/OpenSearch and HTTP JSON also check each against their
  own rules, see below; TigerGraph follows none); a
  redirect to another origin drops the `Authorization` header and every other credential header
  (the HTTP JSON API key). A 307 or 308 redirect repeats a search with its body; any other
  redirect continues as a GET without body.
- File sources (`file`) follow the SQLite rules within their own directories
  (`datasources.file_dirs`, empty by default): the path is checked as written and again after
  symlinks and junctions are resolved, Kalzit's data directory and database are always refused,
  network paths only when an allowed directory is one, and a missing file answers like a refused
  one. The SQLite and file directory lists are separate: a directory allowed for SQLite does not
  open CSV files.
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
- When `ok` is true, `reason` is `health.connected` (`engine`, `version`, and `edition` for the
  graph kinds when the server tells it), `health.connected_write_capable` (Memgraph with
  `allowWriteCapableUser`: the user may write),
  `health.connected_read_only` (SQLite: the file is opened read-only), `health.prometheus_answered`
  (`engine`) or `health.connected_admin_login` (`engine`, `version`: the login has administrator
  rights, PostgreSQL superuser or SQL Server sysadmin; the text should advise a read-only login).
  Elasticsearch and OpenSearch answer `health.connected` with `engine` `Elasticsearch` or
  `OpenSearch` and the cluster's version, read from `GET /`; a login that may not read that (403)
  but may count the default index answers `health.search_answered`. Files answer
  `health.file_readable` (`format`: `CSV`, `JSON` or `NDJSON`, `bytes`), HTTP JSON
  `health.http_json_answered` (`status`) after a GET of the source's URL that answered JSON.
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

Elasticsearch and OpenSearch: the indices matching the source's `index` (all when it is empty),
by name, without hidden ones (starting with `.`), at most 1,000, with their mapped fields (object
fields as dotted paths, multi-fields as `name.sub`, at most 5,000 per index) and the mapping type:

```json
{ "kind": "indices", "indices": [{ "name": "logs-2026.03", "columns": [{ "name": "@timestamp", "type": "date" }, { "name": "land", "type": "keyword" }] }] }
```

CSV files answer `tables` with one table named like the file and the column types inferred from
the first 1,000 rows (`int64`, `number`, `time`, `bool`, `string`). JSON and NDJSON files and
HTTP JSON answer the sampled document schema of the first 1,000 documents (see
[The documents shape](#the-documents-shape)):

```json
{ "kind": "fields", "fields": [{ "path": "kunde.name", "coverage": 1.0, "types": [{ "name": "string", "share": 1.0 }] }] }
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
Graph kinds:

```json
{ "kind": "graph", "labels": ["Person"], "edgeTypes": ["KNOWS"], "propertyKeys": ["name", "since"], "queries": ["nachbarn"] }
```

Neo4j answers `db.labels()`, `db.relationshipTypes()` and `db.propertyKeys()`; Memgraph a sample
of up to 10,000 nodes and relationships; TigerGraph its vertex types, edge types and attribute
names, and in `queries` the installed queries (4.x) and the approved ones. `queries` is omitted
when empty.

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

Explore also sends `"explore": true` (optional, default false): the successful queries of the run are
then kept in the caller's private Explore history (`docs/api/explore-history.md`).

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

### Elasticsearch and OpenSearch: `{"lucene": "..."}` or `{"dsl": {...}}`

```json
{ "lucene": "status:500 AND land:$land", "index": "logs-*", "size": 100 }
{ "dsl": { "query": { "term": { "land": "$land" } }, "aggs": { "zeit": { "date_histogram": { "field": "@timestamp", "fixed_interval": "$__interval" } } } } }
```

- `lucene` is a Lucene query string (`query_string`); `dsl` a search body. Send one of them
  (`elasticsearch.query_form`); with neither, every document matches. `index` (an index name or
  pattern list such as `logs-*,metrics-*,-logs-alt`) overrides the source's `index`; one of the
  two is needed (`elasticsearch.index_missing`). `timeField` overrides the source's.
- The time range is always added as a filter on the time field (`range` with `gte`/`lte` in
  epoch milliseconds) next to the query (`bool` with `must` and `filter`); an empty time field
  adds none. `meta.executedQuery` of an aggregation frame is the body as sent.
- Variables in `lucene`: `$name` or `${name}` outside a phrase becomes a quoted phrase
  (`"Öster\"reich"`), a list `("a" OR "b")`; inside a phrase the value is escaped into it (a list
  there is refused). `$__timeFrom` and `$__timeTo` become Unix milliseconds. A `\$` stays as
  written. Variables in `dsl`: a string that is exactly `$name` or `${name}` is replaced by the
  variable's JSON value (a list stays a list, so `{"terms": {"id": "$ids"}}` works); the macros
  `$__timeFrom`, `$__timeTo` (Unix ms), `$__interval` (such as `30s`) and `$__interval_ms` work
  the same way. Values are placed as JSON, never spliced into text, and must be texts, numbers,
  booleans or lists of them, so a variable cannot bring in a script.
- Without aggregations the answer is `documents`: each hit as the server sends it (`_index`,
  `_id`, `_score`, `_source`, and `fields`, `highlight` or `sort` when asked for), with the
  search body as `executedQuery`, the notices `elasticsearch.timed_out` and
  `elasticsearch.shard_failures` as for aggregations, and `documents.limit` when the size was
  lowered to the row limit and the total counts more hits. With aggregations it is a `frame` (see
  [Aggregations](#aggregations)) and no hits are fetched (`size` is 0).

**Read-only.** Kalzit builds every request itself and checks every URL right before sending it,
and again for every redirect the server answers with (a 307 to `_delete_by_query` is refused
before anything is sent there); only these are possible, below the source's URL: `GET /` (cluster
info), `POST /{index}/_search`, `POST /{index}/_count`, `GET /{index}/_mapping`,
`GET /{index}/_field_caps?fields=*` and `GET /_cat/indices[/{index}]?format=json&h=index`, with no
other query parameters (no `scroll`, `pipeline` or `request_cache`). Every other endpoint,
`_update_by_query`, `_delete_by_query`, `_bulk`, `_doc`, scroll, templates, PIT, SQL, EQL and any
method other than these, is refused (`elasticsearch.endpoint_not_allowed`). Index names are
letters, digits and `. _ - * :` per comma-separated part; a part may not start with `_` or be `.`
or `..` (`elasticsearch.index_invalid`), so an index cannot add a path or name an endpoint; date
math names (`<logs-{now/d}>`) are not supported. The search body is checked:

- Top-level keys only from: `query`, `aggs`/`aggregations`, `sort`, `_source`, `fields`,
  `docvalue_fields`, `stored_fields`, `size`, `from`, `track_total_hits`, `search_after`,
  `highlight`, `post_filter`, `min_score`, `script_fields`, `runtime_mappings`, `collapse`,
  `terminate_after`, `track_scores`, `version`, `seq_no_primary_term`, `indices_boost`,
  `rescore` (`elasticsearch.dsl_key_not_allowed`). `timeout` is always set to the query's time
  limit.
- Scripts, anywhere a `script` key appears, must be inline (`"script": "..."` or
  `{"source", "lang", "params", "options"}`), in `painless` (the default) or `expression`, at most
  16 KiB, and must not use the identifier `ctx`. Search scripts read through `doc`, `params` and
  `_source` and cannot change documents; `ctx` is how update and ingest scripts change them, so
  a script that names it is refused whatever it does (`elasticsearch.script_writes`). Stored
  scripts (`"id"`) are refused because their text is not visible to the check
  (`elasticsearch.stored_script`), and so are `scripted_metric` and every `*_script` key
  (`elasticsearch.script_not_allowed`), whose scripts keep state across shards or that sort or
  compute buckets by script (`_script` sorts, `bucket_script`, `bucket_selector`).
- A `wrapper` query (a query in base64, padding optional) is decoded and checked by the same
  rules wherever Elasticsearch reads a query (`query`, `bool` clauses, `post_filter`, `filter`,
  the `filters` of the `filters` and `adjacency_matrix` aggregations, `positive`, `negative`,
  `queries`, `rescore_query`, `highlight_query`, ...). There it must carry JSON (Elasticsearch
  would also read YAML, CBOR or SMILE, which the check cannot): anything else is
  `elasticsearch.wrapper_invalid`. Elsewhere `wrapper` is an ordinary field name, so
  `{"match": {"wrapper": {"query": "abc"}}}` works; should such a value still decode to a JSON
  query, that query is checked too.
- At most 256 KiB and 64 levels of nesting.

**Limits.** `size` (in the query or the body; default 500) is at most the row limit and 10,000.
`track_total_hits` is at most 100,000: `true` means 100,000, a larger number is lowered, without
it 10,000 is sent. The answer is read within the response size limit and the query timeout.

#### Aggregations

Each row of the frame is one path from the top through the bucket aggregations to a deepest
bucket. At most one bucket aggregation per level (`elasticsearch.sibling_buckets`); metric and
pipeline aggregations may sit at any level. `top_hits` is refused
(`elasticsearch.aggregation_not_supported`): query the hits instead. Aggregations of one level
are read in name order.

| Aggregation | Columns |
|---|---|
| `date_histogram`, `auto_date_histogram` | the aggregation's name: the bucket key, `time` (Unix ms) |
| `composite` | `name.source` per source of the key |
| keyed buckets (`filters`, `keyed: true`) | the name: the bucket's name, `string` |
| other bucket aggregations (`terms`, `histogram`, `range`, ...) | the name: `key_as_string` when sent, otherwise `key`; `number` when every key is a number, otherwise `string` |
| single-bucket aggregations (`filter`, `nested`, `reverse_nested`, `global`, `missing`, `sampler`, `children`, `parent`) | none; they only narrow the documents |
| the deepest bucket | `doc_count` (`number`) |
| metrics with `value` (`avg`, `sum`, `min`, `max`, `cardinality`, `value_count`, pipelines) | the name (`number`) |
| `percentiles`, `percentile_ranks` (`values`) | `name.key` per value, such as `p.95.0` |
| other multi-value metrics (`stats`, `extended_stats`, ...) | `name.field` per numeric field, `name.field.sub` one level deeper |

A metric at an outer level repeats on every row below it. A bucket without buckets below it adds
no row. Without bucket aggregations the frame has one row of metrics. A metric that answers no
number (`geo_bounds`) is left out with the notice `elasticsearch.aggregation_skipped`. Rows stop
at the row limit (`frame.row_limit`). `timed_out` and failed shards add the notices
`elasticsearch.timed_out` and `elasticsearch.shard_failures`.

### Files: `{}`

The source names the file, so the query is `{}` (`query.invalid_form` for anything else). The
file is read on every query within the row limit, the response size limit and the timeout: a
huge file costs only what the answer may hold. The time limit is checked before every record and
line (and every megabyte while a JSON file is parsed), and a read whose query went away (time
limit, client gone) stops at the next check. Blank lines count against the response size limit.
A UTF-8 byte order mark is skipped.

- CSV becomes a `frame`. RFC 4180: fields in `"..."` may hold the delimiter, line breaks and `""`
  for a quote; `\n` and `\r\n` end a record; empty lines are skipped; a `"` inside an unquoted
  field is text. A quote that is never closed is `csv.unclosed_quote` (`line`). The delimiter,
  when `auto`, is whichever of `,` `;` tab `|` occurs most often outside quotes in the first line
  (`,` when none). With `header` the first record names the columns (blank names become
  `column_<n>`, repeats get `_2`, `_3`); without it columns are `column_1` ... A row with fewer
  fields has `null` for the rest; extra fields are left out with the notice `csv.extra_fields`
  (`count`). At most 10,000 columns (`csv.too_many_columns`, `max`; the reader stops at the
  field past the cap, before the record is held whole); the header counts against the
  response size limit like the rows. A file with a UTF-16 byte order mark (Excel's "Unicode
  text") is read as UTF-16. A record that is not UTF-8 is read as Windows-1252 (what Excel writes
  on German Windows) with the notice `csv.legacy_encoding`.
- JSON becomes `documents`: the elements of a top-level array, or the value itself as one
  document. The file may be at most 256 MiB (`file.too_large`, `bytes`). An array is read element
  by element, and an element may take at most the bytes the answer has left: the reader counts
  them while the element is read and stops it as soon as it passes them, before it is held whole.
  The first element that does not fit the limits cuts the answer; once the row limit is reached,
  the rest is only checked to be valid JSON. Any other value is parsed whole,
  so it must fit the response size limit (`file.too_large`). Invalid JSON is `file.json_invalid`
  (`detail`). The schema samples the first 1,000 elements, so it works for large arrays too.
- NDJSON becomes `documents`, one per non-empty line, read line by line; an invalid line is
  `file.ndjson_line_invalid` (`line`, `detail`).

#### CSV columns

A column's type comes from all its values that are not blank, in this order:

| Type | When every value is | Value |
|---|---|---|
| `bool` | `true` or `false` (any case) | `true`, `false` |
| `int64` | a whole number, optional sign, no leading zero (`01067` is text, so postal codes stay text), within 64 bits | decimal text, as for SQL |
| `number` | a decimal number: with `decimal: point` `-12.5`, `.5`, `1e3`; with `decimal: comma` `12,5`, `-0,25`, `1.234.567,89` (points group thousands in threes); `auto` reads a column with a comma when any of its values has one, otherwise with a point (so `1.234` is 1.234 unless the column has a comma somewhere) | the number |
| `time` | an ISO 8601 date or date and time (`2026-03-01`, `2026-03-01 10:15`, `2026-03-01T10:15:30.5Z`, `2026-03-01T10:15:30+01:00`) or a German date (`01.03.2026`, `01.03.2026 10:15[:30]`), years 1 to 9999; without an offset UTC | Unix ms |
| `string` | anything else, and a column without values | the text as written |

Blank cells are `null`. Values are trimmed for typing; text keeps its spaces.

### HTTP JSON: `{"path": "...", "params": {...}, "documentsPath": "..."}`

All fields optional (`{}` requests the source's URL as it is).

- `path` is added below the source's URL (`orders/open` on `https://api.intern/v1/` requests
  `https://api.intern/v1/orders/open`, keeping the URL's own query). It must be relative and
  stay below the URL: no leading `/` or `\`, no `.` segments, no segments starting with `..`, no
  percent-encoded dots, slashes, backslashes or percent signs, no scheme, query or fragment
  (`http_json.path_invalid`).
- `params` are added as query parameters: texts, numbers and booleans
  (`http_json.param_invalid`). A value that is exactly `$name` or `${name}` takes the variable's
  value; a list repeats the parameter (`land=AT&land=CH`). A missing variable is
  `http_json.variable_missing`.
- The answer must be JSON (`http_json.not_json`, `status`) with a success status
  (`http_json.status`: `status` and the first 300 characters of the body as `detail`, with the
  source's secrets removed before it is cut).
- `documentsPath` (or the source's) is a dotted path into the answer (`data.items`, numbers
  index arrays: `results.0.rows`); nothing there is `http_json.path_missing` (`path`). The array
  there (or the answer itself) gives one document per element; any other value is one document.
- Only `GET` is sent; the target checks apply to the address and to every redirect (see
  [Connections and targets](#connections-and-targets)). A redirect is followed only when it stays
  on the source's origin at or below its URL, with the same segment rules as `path` (no segment
  starting with `..`, since some servers read `..;` as `..`, no encoded dots, slashes, backslashes or
  percent signs); any other is refused before it is followed (`http_json.redirect_refused`,
  `path`), so an open redirect of the API cannot reach other hosts or paths.
### Neo4j and Memgraph: `{"cypher": "MATCH ..."}`

Over Bolt (4.4 and 5.0 to 5.8), with TLS when `encrypt` is set. Kalzit opens the connection to the
checked address itself and checks the certificate against the host name. Each query runs in a
read transaction (`BEGIN {mode: "r"}`, the source's `database`, a server-side transaction timeout
of the query's time limit) that is rolled back; a query cut by a limit, the time limit or a client
that went away closes its connection, which ends the transaction on the server.

Read-only rules, checked on the tokens of the query (strings, backtick names, comments and
parameters are tokens of their own, so a keyword inside them is never seen):

- Exactly one statement, starting with `MATCH`, `OPTIONAL MATCH`, `WITH`, `UNWIND`, `RETURN`,
  `CALL`, `FINISH`, `LET` or `FILTER`, optionally after `EXPLAIN`, `PROFILE` or `CYPHER` options.
  So administration commands (`SHOW`, `CREATE INDEX`, `DROP`, `GRANT`, `START DATABASE`, Memgraph's
  `STORAGE MODE`, `FREE MEMORY`, `DUMP DATABASE`, ...) are refused.
- Refused anywhere, also inside `CALL {}`, `CALL (x) {}`, `EXISTS {}`, `COUNT {}` and `COLLECT {}`:
  `CREATE`, `MERGE`, `DELETE`, `DETACH`, `NODETACH`, `SET`, `REMOVE`, `INSERT`, `FOREACH`, `LOAD`
  (`LOAD CSV` and Memgraph's loaders), `USE`, `IN TRANSACTIONS` (also `IN n CONCURRENT
  TRANSACTIONS`), `PERIODIC COMMIT`.
- A number or numbered parameter followed directly by letters (`1DELETE`, `LIMIT 1SET`,
  `$1DELETE`) is refused: the database reads the letters as the next word. Hex (`0x1F`), octal
  (`0o17`), exponents (`1e-3`) and `_` in numbers are fine. Line comments also end at U+0085,
  U+2028 and U+2029.
- Function calls must be built-ins (`count`, `toUpper`, `date`, `shortestPath`, ...) or start with
  an allowed namespace: `date.`, `datetime.`, `localdatetime.`, `localtime.`, `time.`,
  `duration.`, `point.`, `vector.similarity.`, and APOC's pure helpers (`apoc.coll.`,
  `apoc.text.`, `apoc.map.`, `apoc.math.`, `apoc.convert.`, `apoc.date.`, `apoc.temporal.`,
  `apoc.number.`, `apoc.agg.`, `apoc.label.`, `apoc.hashing.`, `apoc.meta.cypher.`,
  `apoc.node.degree`, `apoc.node.labels`, `apoc.rel.type`, `apoc.util.md5` and `sha*`).
  Everything else is refused, among it `apoc.cypher.*` (which runs Cypher given as text),
  `apoc.load.*`, `apoc.export.*`, `apoc.periodic.*`, `apoc.trigger.*`, `apoc.schema.*`, `dbms.*`
  and `db.*`.
- `CALL` of a procedure only from this list (case does not matter): `db.labels`,
  `db.relationshipTypes`, `db.propertyKeys`, `db.schema.visualization`,
  `db.schema.nodeTypeProperties`, `db.schema.relTypeProperties`, `dbms.components`,
  `schema.node_type_properties`, `schema.rel_type_properties`.
- A word counts as a keyword unless it is in backticks, follows `.` or `:`, or is followed by
  `:` (a map key). A label or property named like a keyword works as `n:Set`, `n.create` or
  `{create: 1}`; elsewhere, such as after `|` in a label expression, write it in backticks.

Neo4j enforces the read transaction on the server (a write answers `query_rejected` with
`query.write_refused`). Memgraph accepts it but does not enforce it, so the user's privileges
decide. On every new connection, before reusing a pooled connection checked more than a minute
ago, and on Test connection, Kalzit probes them:

- `CREATE`, `MERGE`, `SET`, `REMOVE`, `DELETE`: each clause on `MATCH (n) WHERE false` (which
  matches nothing) in a transaction it rolls back.
- `READ_FILE`: `LOAD CSV` of a file that does not exist, on no rows, rolled back.
- `AUTH`, `TRIGGER`, `STREAM`, `CONFIG`: `SHOW USERS`, `SHOW TRIGGERS`, `SHOW STREAMS`,
  `SHOW CONFIG`, which change nothing.

Memgraph checks privileges before it runs a query, so a read-only user is refused each one, and a
user who has them gets an empty result and nothing changes. A replica (or read-only instance) refuses
writes the same way, so it counts as read-only. A user with any of these privileges is refused
(`memgraph.user_can_write`) unless `allowWriteCapableUser` is set; Memgraph Community has no
read-only users, so there the setting is needed, Test connection answers
`health.connected_write_capable`, and only the query check keeps queries read-only.

Not covered by the probes: privileges without a harmless probe (`MODULE_WRITE`, `DURABILITY`,
`REPLICATION`, `STORAGE_MODE`, `FREE_MEMORY`, `INDEX`, `CONSTRAINT`, `DUMP`, multi-tenancy and
impersonation), label-based (fine-grained) permissions, which can allow writes on some labels only,
and a privilege granted after the last check (at most a minute on a pooled connection). The query
check refuses the statements behind all of them.

Parameters: variables are bound as Cypher parameters (`$name`), never spliced into the text; a
list becomes a list. Macros: `$__timeFrom`, `$__timeTo` (UTC DateTime values),
`$__timeFromMs`, `$__timeToMs` and `$__interval_ms` (integers). `meta.executedQuery` of a frame is
the query as sent.

### TigerGraph: `{"gsql": "INTERPRET QUERY ..."}` or `{"installed": "name"}`

Both take `params` (an object), and each declared parameter that has no value there takes the
dashboard variable of the same name.

- Interpreted queries go to the GSQL server with the user and password: 4.x
  `POST /gsql/v1/queries/interpret?graph=<graph>`, 3.x `POST /gsqlserver/interpreted_query`. The
  text is one `INTERPRET QUERY (...) FOR GRAPH <graph> { ... }`; `FOR GRAPH` is required (3.x
  takes the graph from it), and another graph than the source's is refused. Every request and
  passes the target checks, and no TigerGraph request follows a redirect: a redirect answers
  `tigergraph.redirect_refused` (`path`), so a body or secret never reaches another URL and a
  query never another endpoint on the same server (an installed query outside
  `approvedQueries`, user management).
- Installed queries go to REST++ `GET /query/<graph>/<name>` with a token. With `secret`, the
  token comes from it (4.x `POST /gsql/v1/tokens`, 3.x `POST <restppUrl>/requesttoken`); without
  it, 4.x issues one for the user and password, and 3.x calls REST++ without a token (for servers
  without REST++ authentication). A token is replaced a minute before it expires, and once more
  when REST++ answers 401.
- The time limit goes along as `GSQL-TIMEOUT`, the size limit to REST++ as `RESPONSE-LIMIT`.
- Parameters are typed REST++ query parameters from the declared types: `INT`, `UINT`, `FLOAT`,
  `DOUBLE`, `BOOL`, `STRING`, `DATETIME` (text `YYYY-MM-DD HH:MM:SS` or Unix milliseconds),
  `VERTEX<T>` (the id), `VERTEX` (`{"type": ..., "id": ...}`), `SET`/`BAG`/`LIST` of them (a list,
  sent as repeated values). A value that does not fit is refused (`tigergraph.param_type`), as is
  a name the query does not declare. For an approved query whose text cannot be read the types
  are unknown, and values go as given (lists repeated, `{"type", "id"}` as a vertex).

What Kalzit found in the TigerGraph documentation (October 2026) about reading a query's text:
4.x has `GET /gsql/v1/queries/{name}?graph=<graph>` (field `queryContent`) and
`GET /gsql/v1/queries/info?graph=<graph>&query=<name>` (field `code`); both need the
`READ_QUERY` privilege, which the built-in `queryreader` role does not have. 3.x has no REST
endpoint for it, only the GSQL command `SHOW QUERY`, which Kalzit does not send (it sends no GSQL
commands made from input). So with a plain `queryreader` user, installed queries run only when
approved by name. Whether `queryreader` may run interpreted queries in 4.1+ (the per-query
`EXECUTE_QUERY` privilege) is checked against a real instance by the nightly job; if the server
refuses, the query answers `tigergraph.error`.

Read-only rules:

- The user must be a reader. Kalzit reads its roles and privileges when it sets up the
  connection (after every change of the source and every ten minutes) and in Test connection:
  4.x `GET /gsql/v1/users/<user>`, and when that is not allowed, and on 3.x, the fixed command
  `SHOW USER`. Allowed are only the privileges `READ_SCHEMA`, `READ_LOADINGJOB`,
  `EXECUTE_LOADINGJOB`, `READ_DATA`, `READ_QUERY` and `EXECUTE_QUERY` (on any graph), or, when
  only roles are known, the role `queryreader` (global roles and roles on the source's graph).
  Anything else, or a superuser, refuses the source (`tigergraph.user_can_write`). The built-in
  `queryreader` role includes `EXECUTE_LOADINGJOB`; Kalzit never runs loading jobs, but a custom
  role without it is safer.
- The GSQL text is parsed; what does not parse is refused. Allowed is exactly one query body
  with declarations, accumulators, vertex set seeds, `SELECT` blocks, `PRINT`, `IF`, `WHILE`,
  `FOREACH`, `CASE`, `BREAK`, `CONTINUE`, `RETURN` and calls of built-in functions. Refused, also
  inside `ACCUM` and `POST-ACCUM`: `INSERT INTO`, `UPDATE`, `DELETE`, assignments to attributes
  (`v.age = 1`, `e.weight += 1`), `PRINT ... TO_CSV` and `FILE`, `CREATE`, `ALTER`, `DROP`, `RUN`
  (loading jobs, schema changes), `INSTALL`, `GRANT`, `REVOKE`, `CLEAR`, `USE`, `LOAD`, `EXPORT`,
  `IMPORT`, calls of functions and methods outside a fixed list of built-ins (so calls of other
  queries, user-defined functions, `SelectVertex` and `evaluate`, and methods such as
  `setAttr`), characters outside ASCII outside strings, `#`, `\"` inside strings, `'` anywhere but
  right after an accumulator (`@@total'`), and a `TYPEDEF` named like a built-in, this or another
  query or a name used before it; when the graph's query names cannot be read (3.x, or a user
  without the right to list them), every `TYPEDEF` is refused. Global (`@@`) and vertex (`v.@x`) accumulators live for
  one run and are allowed.
- An installed query runs only when its text can be read and passes the check (the result of a
  check is kept for a minute), or when its text cannot be read and its name is in
  `approvedQueries`. Then only the reader user protects the data.
- Kalzit never calls REST++ upsert, delete or loading endpoints.

### Graph results

Graph kinds answer `graph` when the result holds graph elements and `frame` otherwise:

| Source | Becomes `graph` | Node `id` | Edge `id` |
|---|---|---|---|
| Neo4j, Memgraph | columns holding nodes, relationships, paths, or lists of them (the first record with a value decides) | the element id (Bolt 4.4: the number as text) | the element id |
| TigerGraph | printed vertex sets and edges (`PRINT R`, `PRINT @@edges`), also inside lists | `Type:id` (split at the first `:`) | `Type:<from>-><to>`; undirected `Type:<a>--<b>` with the ends in sorted order; a parallel edge with other attributes gets `#2`, `#3` |

- Each node and edge appears once. An edge whose end node is not in the result gets a node with
  only its id (and its type for TigerGraph), completed when the node itself arrives.
- Paths stay paths: `paths` lists the node and edge ids in walking order (a relationship walked
  against its direction keeps its own `from` and `to`).
- `schema` holds the labels, edge types and property keys per label of the answer.
- Columns or printed values without graph elements next to them are not part of the graph; a
  `graph.columns_omitted` notice names them. Query them separately for a table.
- Without graph elements the answer is a `frame`: per column one type when all values share it
  (`int64` for integers, `number`, `string`, `bool`, `time` for dates and date-times), else
  `json`. A TigerGraph result that prints one list of objects has a row per object, otherwise one
  row with every printed value. An empty Cypher result is an empty frame with its columns.
- Property values keep their types: integers beyond 2^53 as `{"$type": "int64", "value"}`, NaN
  and infinities as `{"$type": "float"}`, `{"$type": "date" | "time" | "localTime" |
  "localDateTime" | "dateTime" | "duration", "value"}` in ISO 8601 (a `dateTime` with a zone name
  is the UTC instant with `"zone"`), `{"$type": "point", "srid", "x", "y"[, "z"]}`,
  `{"$type": "binary"}` (base64); nodes and relationships inside frame values as
  `{"$type": "node" | "edge", ...}`.
- Hitting `maxNodes`, `maxEdges` or the response size limit stops reading: `truncated` is
  `{"limit", "reason"}` with `graph.node_limit`, `graph.edge_limit` or `graph.size_limit`, and a
  notice says the same.

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
  "nextCursor": "MjAwOmFiY2Q", "truncated": { "limit": 200, "reason": "documents.limit" },
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

Every document source (MongoDB, Elasticsearch and OpenSearch hits, JSON and NDJSON files, HTTP
JSON) answers this shape. Documents come in the order the source answered. The row limit counts
documents and the response size limit their size: the first document that does not fit ends the
set, `truncated.limit` is the number of documents kept, and `truncated.reason` and a notice say
which limit cut it (`documents.limit` with `limit`, or `documents.size_limit`). A search whose
`size` was lowered to the row limit (or 10,000) and whose total counts more hits than it answered
is cut the same way (`documents.limit`). `executedQuery` is the query as sent
(MongoDB, Elasticsearch). `nextCursor` is set where the source can continue the set (MongoDB);
`cursor` on a query (and `cursors` on the panel route) continues it. Other kinds ignore it.

`schema` is sampled from the first 1,000 documents of the result, the same way for every source:
every field path (`a.b`, array elements as `items[]`, fields of documents in arrays as
`items[].preis`; a document that is not an object as `$`; at most 2,000 paths, 32 levels and the
first 100 elements of each array; a key longer than 256 characters is cut there and ends in
`...`, a path longer than 4 KiB is left out with everything below it, and once the paths add up
to 256 KiB no new ones are listed) in the order it first appears, `coverage` (share of documents
with the path, 0 to 1; a path counts once per document however often it occurs in its arrays)
and `types` (the share of the documents with the path where it has that type, most common first;
a path with several types in one document counts for each, so shares may add up to more than 1).
MongoDB names types by their alias, as `$type` queries do (`double`, `string`, `object`, `array`,
`binData`, `objectId`, `bool`, `date`, `null`, `regex`, `javascript`, `int`, `long`, `decimal`,
`timestamp`, ...); the JSON sources by the JSON type (`string`, `number`, `bool`, `null`,
`object`, `array`). The schema counts against the response size limit like the documents: the
paths that no longer fit are left out, with the notice `documents.schema_cut`.

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
the format, the time range, the frame, the number of rows and the panel or the data sources,
never the data; an export refused inside the route writes `data.export_refused` with the code and
reason as well.

Resources: a server makes at most 3 export files at once (`503 busy`, reason `export.busy`, for
more). The steps and the encoder stop when the client goes away and when the query time limit
(`datasources.query_timeout_secs`) has passed (`504 query_timeout`, reason `steps.timeout`). The
steps' bounds hold here as in the browser (at most 5,000,000 cells per step and 67,108,864 UTF-16
units of made text per run), and a file is at most 256 MiB (`export.too_large`): CSV and JSON
are written in chunks that the answer sends as they are, and stop at the first byte past the
limit; an Excel file holds every cell until it is done, so it takes at most 1,000,000 cells
(`export.too_many_cells`, checked before it is built). An export's slot is given back only when
its work has stopped, also when the client went away. The statement as sent to the database
(`meta.executedQuery`) is not in the file.

- `csv`: RFC 4180, UTF-8 with a byte order mark (so Excel reads it as UTF-8), CRLF line ends.
  `language` `de` separates with `;` and writes a decimal comma, `en` uses `,` and a decimal
  point. Numbers keep every digit (`1e+21` from 10^21 on), `int64` its digits, times ISO 8601 in
  UTC (a fraction of a millisecond cut), booleans `true`/`false`, `json` compact JSON. Text that
  starts with `=`, `+`, `-`, `@` (also full-width, and after leading spaces, line breaks or
  invisible characters), tab or carriage return gets a leading `'`, field names and `int64` cells
  that are not plain digits too, so a spreadsheet never runs it as a formula (DDE included).
- `xlsx`: one sheet, bold frozen header row, typed cells: numbers, booleans and times (UTC, shown
  as `yyyy-mm-dd hh:mm:ss.000`). `int64` beyond 2^53 and times before 1900-03-01 are text; text is
  cut at Excel's 32,767 UTF-16 units, never inside a character; at most 1,048,575 rows and 16,384
  columns. The sheet is named after the table, never Excel's reserved "History". Written with
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
| `settings.url_query` | | the URL contains a query or fragment (`http_json`: a fragment) |
| `settings.file_format_unknown` | | `file`: the format is `auto` and the file name has no known extension |
| `settings.header_name_invalid` | | `http_json`: `apiKeyHeader` is not a header name or is a reserved one |
| `settings.url_no_host` | | the URL has no host |
| `settings.name_invalid` | | TigerGraph: the graph, user or an approved query name has characters other than letters, digits and `_` (users also `-`, `.`, `@`) |
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
| `target.url_credentials` | | an HTTP request or redirect URL contains a user name or password |
| `target.file_path_refused` | | the CSV or JSON file is outside `datasources.file_dirs`, in Kalzit's data directory, Kalzit's own database, missing, or a network path (one reason for all) |
| `target.file_path_relative` | | the file path is not absolute |
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
| `query.invalid_form` | `detail` | the query object does not fit the kind (`{"sql"}`, `{"expr", ...}`, `{"lucene"}` or `{"dsl"}`, `{}` for files, `{"path", "params", "documentsPath"}`) |
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
| `elasticsearch.query_form` | | both `lucene` and `dsl` |
| `elasticsearch.index_missing` | | neither the query nor the source names an index |
| `elasticsearch.index_invalid` | `index` | not an index name or pattern list (see above) |
| `elasticsearch.endpoint_not_allowed` | `path` | a request to anything but the read endpoints |
| `elasticsearch.query_too_large` | | the query text or body is over 256 KiB |
| `elasticsearch.dsl_not_object` | | `dsl` is not an object |
| `elasticsearch.dsl_key_not_allowed` | `key` | a top-level key of the body that is not allowed |
| `elasticsearch.dsl_too_deep` | | more than 64 levels of nesting |
| `elasticsearch.script_writes` | | a script uses `ctx` |
| `elasticsearch.stored_script` | | a stored script (`"id"`) |
| `elasticsearch.script_not_allowed` | `context` | `scripted_metric` or a `*_script` key |
| `elasticsearch.script_invalid` | `key` | a script with another key than `source`, `lang`, `params`, `options`, or without `source` |
| `elasticsearch.script_lang` | `lang` | a script language other than `painless` or `expression` |
| `elasticsearch.script_too_large` | | a script over 16 KiB |
| `elasticsearch.wrapper_invalid` | | a `wrapper` query that is not base64 of a JSON query |
| `elasticsearch.aggregation_invalid` | `name` (when known) | an aggregation that is not an object or has no type |
| `elasticsearch.aggregation_not_supported` | `name`, `type` | `top_hits` |
| `elasticsearch.sibling_buckets` | `names` | more than one bucket aggregation on one level |
| `elasticsearch.track_total_hits` | | `track_total_hits` is not true, false or a number |
| `elasticsearch.variable_missing` | `name` | a variable without a value |
| `elasticsearch.variable_type` | `name` | a variable that is not a string, number, boolean or list of them |
| `elasticsearch.variable_list_in_phrase` | `name` | a list variable inside a quoted Lucene phrase |
| `elasticsearch.macro_unknown` | `name` | an unknown `$__` macro |
| `http_json.path_invalid` | | a `path` that would leave the source's URL |
| `http_json.param_invalid` | `name` | a parameter that is not a text, number or boolean |
| `http_json.variable_missing` | `name` | a variable without a value |
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
| `cypher.empty` | | the Cypher query is empty |
| `cypher.multiple_statements` | | more than one statement |
| `cypher.not_read_query` | `keyword` | the query does not start with a reading clause (`MATCH`, `WITH`, `RETURN`, ...) |
| `cypher.write_clause` | `clause` | `CREATE`, `MERGE`, `DELETE`, `DETACH`, `NODETACH`, `SET`, `REMOVE` or `INSERT` |
| `cypher.foreach` | | `FOREACH` |
| `cypher.load` | | `LOAD CSV` and other loaders |
| `cypher.use` | | `USE` of another database |
| `cypher.in_transactions` | | `CALL { } IN TRANSACTIONS` or `PERIODIC COMMIT` |
| `cypher.procedure_not_allowed` | `name` | `CALL` of a procedure that is not on the read list |
| `cypher.parse_error` | | `CALL` without a procedure name or subquery |
| `cypher.function_not_allowed` | `name` | a function that is neither a built-in nor on the list of allowed namespaced functions |
| `cypher.number_followed_by_letters` | | a number or `$0` parameter with letters glued to it (`1DELETE`, `LIMIT 1SET`) |
| `cypher.unclosed_quote`, `cypher.unclosed_comment`, `cypher.unclosed_backtick` | | an unclosed string, `/*` comment or backtick name |
| `cypher.macro_unknown` | `name` | an unknown `$__` macro |
| `cypher.variable_missing` | `name` | a parameter without a variable value |
| `cypher.variable_type` | `name` | a variable that is not a string, number, boolean or list of them |
| `gsql.empty` | | the GSQL query is empty |
| `gsql.not_one_query` | | not exactly one `INTERPRET QUERY` (interpreted) or `CREATE QUERY` (installed text) |
| `gsql.parse_error` | `detail` | the query cannot be read for the check |
| `gsql.write` | `statement` | `INSERT`, `UPDATE` or `DELETE` |
| `gsql.attribute_assignment` | `target` | an assignment to an attribute |
| `gsql.file_output` | | `TO_CSV` or `FILE` |
| `gsql.statement_not_allowed` | `statement` | a schema, loading, user or administration statement |
| `gsql.function_not_allowed` | `name` | a function outside the built-ins Kalzit allows (also other queries) |
| `gsql.method_not_allowed` | `name` | a method outside the allowed ones (such as `setAttr`) |
| `gsql.other_graph` | `graph` | the query is for another graph |
| `gsql.graph_missing` | | an interpreted query without `FOR GRAPH` |
| `gsql.typedef_name` | `name` | a `TYPEDEF` named like a built-in, a query or a name used before it, or any `TYPEDEF` when the graph's query names cannot be read |
| `gsql.string_escape` | | `\"` inside a string |
| `gsql.unexpected_character` | `character` | a character outside ASCII, or `#`, outside strings and comments |
| `gsql.unclosed_quote`, `gsql.unclosed_comment` | | an unclosed string or comment |
| `tigergraph.query_name` | `name` | `installed` is not a query name |
| `tigergraph.query_text_unreadable` | `name` | the installed query's text cannot be read and the query is not approved |
| `tigergraph.param_type` | `name`, `type` | a parameter value does not fit its declared type |
| `tigergraph.param_unknown` | `name` | `params` names a parameter the query does not declare |

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
| `steps.too_many_cells` | `max` | the step would make more than `max` cells (rows times fields); checked before it builds them |
| `steps.too_much_text` | `max` | the steps of one run would make more than `max` UTF-16 units of text (calculated text and the copies a join makes) |
| `steps.timeout` | `seconds` | `504 query_timeout`: an export's steps and file took longer than the query time limit |
| `steps.cancelled` | | the client went away while its export was made (nobody receives this answer) |
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
| `expression.text_too_long` | `max` | a row's text would be longer than `max` UTF-16 units (Excel's limit for a cell) |

### Export (`422 validation`)

| Reason | Params | When |
|---|---|---|
| `export.no_queries` | | the panel has no query |
| `export.frame_missing` | `frame` | no table with this reference id after the steps (`field: frame`) |
| `export.shape_unsupported` | `shape` | documents and graphs cannot be exported yet |
| `export.too_many_rows` | `max` | Excel takes at most `max` rows |
| `export.too_many_columns` | `max` | Excel takes at most `max` columns |
| `export.failed` | `detail` | the file could not be written |
| `export.too_large` | `max` | the file would be larger than `max` bytes |
| `export.too_many_cells` | `max` | an Excel file takes at most `max` cells (rows times fields); refused before it is built |
| `export.busy` | | `503 busy`: as many exports as the server makes at once are running; try again shortly |

### Dashboards (`422 validation`, `field: model`)

| Reason | Params | When |
|---|---|---|
| `dashboards.panel_options` | `panel`, `detail` | a panel the save adds or changes (a dashboard, or a library panel) has options or field options the server refuses: `panel` is its title (else its id, for a library panel its name), `detail` names the option |

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
| `elasticsearch.error` | `status`, `detail` | Elasticsearch or OpenSearch answered an error (`detail`: its type and reason) |
| `elasticsearch.not_an_api_response` | `status` | the server answered without a search API response |
| `elasticsearch.credentials_invalid` | | the credentials contain characters a header cannot carry |
| `file.read_failed` | `detail` | the file cannot be read |
| `file.too_large` | `bytes` | a JSON file is larger than `bytes` |
| `file.json_invalid` | `detail` | the JSON file is not valid JSON |
| `file.ndjson_line_invalid` | `line`, `detail` | a line of an NDJSON file is not valid JSON |
| `csv.unclosed_quote` | `line` | a quoted field from `line` is never closed |
| `csv.too_many_columns` | `max` | the CSV file has more than `max` columns |
| `http_json.status` | `status`, `detail` | the server answered an error status |
| `http_json.not_json` | `status`, `detail` | the answer is not JSON |
| `http_json.path_missing` | `path` | the answer has nothing at `documentsPath` |
| `http_json.redirect_refused` | `path` | the server redirected outside the source's URL |
| `http_json.credentials_invalid` | | the credentials contain characters a header cannot carry |
| `bolt.protocol` | `detail` | the server broke the Bolt protocol (or speaks no version Kalzit does) |
| `bolt.tls` | `detail` (when known) | TLS could not be set up or failed |
| `bolt.login_timeout` | | the server did not complete the login in time |
| `bolt.too_large` | | a single message was larger than the response size limit |
| `memgraph.user_can_write` | `privileges` | the Memgraph user has privileges beyond reading (writing clauses, `READ_FILE`, `AUTH`, `TRIGGER`, `STREAM`, `CONFIG`) and `allowWriteCapableUser` is off |
| `memgraph.privileges_unverifiable` | `detail` | the check of the Memgraph user's privileges failed for another reason |
| `tigergraph.user_can_write` | `privileges` | the TigerGraph user may do more than read (privileges or roles beyond a reader's, or superuser) |
| `tigergraph.privileges_unverifiable` | | the user's roles and privileges cannot be read |
| `tigergraph.credentials_invalid` | | the credentials contain characters a header cannot carry |
| `tigergraph.not_an_api_response` | `status` | the server answered without a TigerGraph API response |
| `tigergraph.error` | `status`, `detail` | TigerGraph answered an error |
| `tigergraph.no_token` | | the token endpoint answered without a token |
| `tigergraph.redirect_refused` | `path` | TigerGraph answered a request with a redirect |
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
| `health.connected` | `engine`, `version`, `edition` | connected (`ok: true`); `edition` only for graph kinds that report it |
| `health.connected_admin_login` | `engine`, `version` | connected, but the login has administrator rights |
| `health.connected_read_only` | `engine`, `version` | SQLite: connected, the file is opened read-only |
| `health.prometheus_answered` | `engine` | the Prometheus API answered |
| `health.search_answered` | | Elasticsearch/OpenSearch: searching works, but the login may not read the cluster version |
| `health.file_readable` | `format`, `bytes` | the file can be read |
| `health.http_json_answered` | `status` | the URL answered JSON |
| `health.connected_write_capable` | `engine`, `version`, `privileges`, `edition` | Memgraph: connected, but the user may write (`allowWriteCapableUser` is on) |
| `frame.row_limit` | `rows` | notice: the result was cut at `rows` rows |
| `frame.size_limit` | | notice: the result was cut at the response size limit |
| `frame.binary_hidden` | `column` (SQLite) | notice: binary values are not shown |
| `frame.type_unsupported` | `column`, `type` | notice: a column type the server cannot show |
| `frame.value_mismatch` | `column`, `count` | notice: `count` SQLite values of `column` do not fit its type and are empty |
| `prometheus.warning` | `detail` | notice: a warning from Prometheus |
| `elasticsearch.aggregation_skipped` | `name` | notice: an aggregation answers no numbers and is left out |
| `elasticsearch.timed_out` | | notice: the search timed out on the server; the result may be incomplete |
| `elasticsearch.shard_failures` | `count` | notice: `count` shards failed; the result may be incomplete |
| `csv.extra_fields` | `count` | notice: `count` rows have more fields than the header |
| `csv.legacy_encoding` | | notice: the file is not UTF-8 and was read as Windows-1252 |
| `documents.limit` | `limit` | notice: the set was cut at `limit` documents |
| `documents.size_limit` | | notice: the set was cut at the response size limit |
| `documents.binary_hidden` | `path` | notice: binary values at `path` are not shown |
| `documents.schema_cut` | | notice: the schema lists only the paths that fit the response size limit |
| `graph.node_limit` | `limit` | notice: the graph was cut at `limit` nodes |
| `graph.edge_limit` | `limit` | notice: the graph was cut at `limit` edges |
| `graph.size_limit` | | notice: the graph was cut at the response size limit |
| `graph.row_limit` | `limit` | notice: the graph was cut after `limit` records (the row limit) |
| `graph.columns_omitted` | `columns` | notice: these columns or printed values hold no graph elements and are not in the graph |

### Updates (`422 validation` or `409 conflict`; also in the update status)

The update routes (docs/api/updates.md) answer these, and the status reports them for a check,
a download or an installation that ran in the background (`lastCheck.error`, `job.error`,
history `reasonCode`). `updates.mode_*` explain `mode.reason`, why a server only prepares.

| Reason | Params | When |
|---|---|---|
| `updates.no_trusted_key` | | this build trusts no release key, so nothing can be verified |
| `updates.signature_invalid` | | a signature does not match the manifest or a package entry |
| `updates.unknown_key` | `keyId` | signed with a key this build does not trust |
| `updates.manifest_invalid` | `detail` | the manifest or signature file is malformed, too large or not for Kalzit |
| `updates.no_package` | `platform`, `arch` | the release has no package for this server |
| `updates.wrong_platform` | `platform`, `arch`, `ours` | the uploaded package is for another platform |
| `updates.hash_mismatch` | | the package does not match its signed SHA-256 |
| `updates.size_mismatch` | | the package size differs from its signed size |
| `updates.too_large` | `max` | an upload part is larger than `max` bytes |
| `updates.downgrade` | `version`, `installed` | the release is older than the installed version (`409`) |
| `updates.already_installed` | `version` | this version runs already (`409`) |
| `updates.minimum_version` | `minimum` | the release needs at least `minimum` installed first (`409`) |
| `updates.source_unreachable` | `detail` | GitHub did not answer, or answered an error |
| `updates.source_refused` | `host` | a request or redirect would leave the release hosts |
| `updates.release_incomplete` | `version` | the release lacks its manifest, signature or package file |
| `updates.not_offered` | `version` | this version is not offered; check first (`409`) |
| `updates.busy` | | another update step runs (`409`) |
| `updates.pending` | | an installation is under way; the server restarts (`409`) |
| `updates.not_staged` | `version` | this version is not downloaded or uploaded (`409`) |
| `updates.manual_only` | `mode` | this server does not install on its own; `mode` is a `updates.mode_*` reason (`409`) |
| `updates.backup_unsupported` | | PostgreSQL: back the database up with pg_dump and confirm (`409`) |
| `updates.backup_failed` | `detail` | the database backup failed; nothing changed |
| `updates.smoke_test_failed` | `detail` | the new binary does not run on this server; nothing changed |
| `updates.install_failed` | `detail` | putting the files in place failed |
| `updates.rollback_unavailable` | `version` | that version or its backup is not kept (`409`) |
| `updates.rollback_needs_restore` | `version` | returning restores the database backup of that time; confirm with `restoreDatabase` (`409`) |
| `updates.rollback_restore_unsupported` | | PostgreSQL: returning across a database change needs your own restore (`409`) |
| `updates.schedule_out_of_range` | | the time is in the past, more than 7 days ahead, or the window end is not after it |
| `updates.schedule_missed` | | the server was not running during the planned window |
| `updates.upload_incomplete` | `part` | the upload lacks its `manifest`, `signature` or `package` |
| `updates.upload_unknown_part` | `part` | the upload has an unknown or repeated part |
| `updates.channel_mismatch` | | a preview release on the stable channel (`409`) |
| `updates.disk_full` | `needed` | the data directory's disk has less than `needed` bytes free for the upload (`409`) |
| `updates.rollback_unsigned` | `version` | the command line returns only to versions whose signed manifest was kept (`409`) |
| `updates.mode_windows_service` | | Windows: installing needs the service integration; use `kalzit update apply` |
| `updates.mode_not_systemd` | | Linux, not started by systemd |
| `updates.mode_binary_not_writable` | | the service account cannot replace the binary |
| `updates.mode_container` | | a container: update the image instead |
| `updates.mode_unsupported_platform` | | this system has no update support |

## Not here yet

- Purging data sources from the trash, testing settings before saving.
- Continuing document results with `cursor`; Elasticsearch date math index names; HTTP JSON
  methods other than GET.
