English | [Deutsch](de/warehouses.md)

# Data warehouses: BigQuery, Snowflake and Databricks SQL

Kalzit reads Google BigQuery, Snowflake and Databricks SQL with SQL over their REST APIs. Each
answers a table (`frame`), like the other SQL sources: you write one `SELECT` or `WITH` statement
in the warehouse's own dialect, and the time range and variables reach the warehouse as query
parameters, never as text in the statement.

Warehouses bill what queries read or how long they run. Kalzit therefore:

- keeps answers in the [query cache](performance.md) by default (60 seconds; change it under
  **Cache** in the data source settings),
- cancels a query in the warehouse when it stops waiting for it (the query time limit ran out, or
  the panel or request was closed), and sends the query time limit to the warehouse as its own
  limit,
- asks the warehouse for at most one row more than the row limit where the API allows it,
- estimates every BigQuery query in a free dry run first and refuses it above the source's
  **Maximum bytes billed per query**.

## Read-only access

Data sources are read-only. Kalzit refuses everything but one `SELECT`/`WITH` statement on the
server, before it reaches the warehouse, and also refuses functions that read files, stages or
secrets, query other servers, send HTTP requests or call AI models (see the
[API reference](../api/datasources.md#bigquery-snowflake-and-databricks-sql-sql)). That check is
the second line. **The real boundary is a login that can only read:**

### BigQuery

Create a service account for Kalzit and grant it only:

- **BigQuery Data Viewer** (`roles/bigquery.dataViewer`) on the datasets Kalzit may read, and
- **BigQuery Job User** (`roles/bigquery.jobUser`) on the project the queries run in.

Give it no other role: these two roles are the real boundary. Kalzit's token has BigQuery's
`bigquery` scope, because BigQuery accepts no read-only scope for starting a job (the dry run) or
cancelling one. Kalzit sends every query as a dry run first; BigQuery names the statement type,
and anything but `SELECT` (a script, DML, DDL) is refused before it runs.

### Snowflake

Snowflake has no read-only session, so the role decides everything. A role for Kalzit:

```sql
CREATE ROLE kalzit_reader;
GRANT USAGE ON WAREHOUSE reporting_xs TO ROLE kalzit_reader;
GRANT USAGE ON DATABASE sales TO ROLE kalzit_reader;
GRANT USAGE ON ALL SCHEMAS IN DATABASE sales TO ROLE kalzit_reader;
GRANT SELECT ON ALL TABLES IN DATABASE sales TO ROLE kalzit_reader;
GRANT SELECT ON FUTURE TABLES IN DATABASE sales TO ROLE kalzit_reader;
CREATE USER kalzit_reader DEFAULT_ROLE = kalzit_reader DEFAULT_WAREHOUSE = reporting_xs TYPE = SERVICE;
GRANT ROLE kalzit_reader TO USER kalzit_reader;
```

Give the user no other role. A small warehouse with `AUTO_SUSPEND` and a resource monitor keeps
costs in check.

### Databricks SQL

Databricks has no read-only session either. Use a service principal (or, for a test, your own
personal access token) with only these Unity Catalog privileges:

```sql
GRANT USE CATALOG ON CATALOG main TO `kalzit-reader`;
GRANT USE SCHEMA ON SCHEMA main.sales TO `kalzit-reader`;
GRANT SELECT ON SCHEMA main.sales TO `kalzit-reader`;
```

and **CAN USE** on the SQL warehouse. No `MODIFY`, no `ALL PRIVILEGES`, no workspace admin.

## Setting up the data source

Under **Data sources** > **Add data source**, pick the warehouse. Secrets (keys, tokens) are
stored encrypted with the [secrets key](administration.md) and never shown again; you can only
replace or remove them.

### BigQuery

| Setting | What to enter |
|---|---|
| Project ID | The project the queries run and are billed in, such as `acme-analytics` |
| Location | Where the datasets live, such as `EU`, `US` or `europe-west3`; empty lets BigQuery choose |
| Default dataset | Used for table names without a dataset; schema browsing then shows only it |
| Sign-in | `serviceAccountKey` (a JSON key file) or `workloadIdentity` |
| Service account key (JSON) | The whole key file of the service account above |
| Workload identity configuration (JSON) | For `workloadIdentity`: a workload identity federation configuration (`gcloud iam workload-identity-pools create-cred-config ... --credential-source-file=...`) |
| Maximum bytes billed per query | A cap per query, such as `10737418240` (10 GiB); empty uses the project's own limits |
| API URL | Leave `https://bigquery.googleapis.com` unless you use a Private Service Connect endpoint |

With **workload identity federation**, no key leaves Google: the configuration names a file with
a token from your identity provider (a Kubernetes service account token, say). That file must lie
in a folder a server admin allowed for files (`datasources.file_dirs`). Only file sources are
supported; Kalzit does not use the metadata server of a cloud VM, which it refuses as a target.

### Snowflake

| Setting | What to enter |
|---|---|
| Account identifier | `myorg-myaccount`, or a locator such as `xy12345.eu-central-1` |
| User name | The user above |
| Private key (PEM) | The user's unencrypted private key (`-----BEGIN PRIVATE KEY-----`) |
| Warehouse, Role, Database, Schema | Optional; empty uses the user's defaults |
| URL | Only for a private link; empty means `https://<account>.snowflakecomputing.com` |

Kalzit signs in with key-pair authentication. Create a key and give the user its public key:

```sh
openssl genrsa 2048 | openssl pkcs8 -topk8 -inform PEM -out kalzit_key.p8 -nocrypt
openssl rsa -in kalzit_key.p8 -pubout -out kalzit_key.pub
```

```sql
ALTER USER kalzit_reader SET RSA_PUBLIC_KEY = 'MIIBIjANBgkqh...';
```

Paste the content of `kalzit_key.p8` into **Private key**. Kalzit keeps it encrypted, so the key
itself must not be encrypted. Statements run in UTC with the query tag `kalzit`.

### Databricks SQL

| Setting | What to enter |
|---|---|
| Workspace URL | Such as `https://adb-1234567890123456.7.azuredatabricks.net` or `https://dbc-a1b2c3d4-e5f6.cloud.databricks.com` |
| SQL warehouse ID | From the warehouse's **Connection details** (the last part of the HTTP path) |
| Catalog, Schema | Optional; empty uses the warehouse's defaults |
| Sign-in | `token` (a personal access token) or `oauth` (OAuth machine-to-machine) |
| API token | For `token` |
| OAuth client ID, OAuth secret | For `oauth`: the service principal's client ID and an OAuth secret created for it |

## Queries

Write SQL in the warehouse's dialect. Macros and variables work as in every SQL source
([query languages](query-languages.md#bigquery)); how they reach each warehouse:

| | BigQuery | Snowflake | Databricks |
|---|---|---|---|
| `$__timeFilter(col)` | `col BETWEEN TIMESTAMP_MILLIS(?) AND ...` | `col BETWEEN TO_TIMESTAMP_TZ(?, 3) AND ...` | `col BETWEEN timestamp_millis(:p1) AND ...` |
| `$__interval` | an `INTERVAL` | text such as `30 seconds` | text such as `30 seconds` (for `window()`) |
| `$__interval_ms` | integer | integer | integer |
| `$name` | a query parameter | a binding | a named parameter |

Compare a `DATETIME` (BigQuery) or `TIMESTAMP_NTZ` (Snowflake, Databricks) column as UTC; cast it
where it holds local times. For buckets over time, use `TIMESTAMP_BUCKET(ts, $__interval)` in
BigQuery, `TO_TIMESTAMP(FLOOR(DATE_PART(EPOCH_MILLISECOND, ts) / $__interval_ms) * $__interval_ms, 3)`
in Snowflake and `window(ts, $__interval).start` in Databricks.

Not allowed, besides writes: `$` other than in variables and macros (also Snowflake's `$$`
strings, `$1` columns and `SYSTEM$` functions), hand-written placeholders (`?`, `@name`),
Snowflake stages (`@stage`) and `#` comments, raw strings with a backslash (BigQuery, Databricks)
and tables named by a file path in Databricks (``parquet.`/data` ``).

**Schema browsing** lists the tables and columns from `INFORMATION_SCHEMA`: in BigQuery of the
default dataset, else of every dataset in the location; in Snowflake and Databricks of every
schema of the current database or catalog. The **Explore** starters (latest rows, counts per
value, a value over time) and the cheat sheet are the same as for the other SQL sources, written
in the warehouse's dialect.

## Troubleshooting

| Message | What to do |
|---|---|
| The data source refused the login | BigQuery: the key or the workload identity is not accepted. Snowflake: the public key is not set on the user, or the account identifier or user name is wrong. Databricks: the token expired or the OAuth secret is wrong. |
| BigQuery reads this statement as SCRIPT | Only one `SELECT` runs; remove `DECLARE`, `BEGIN ... END` and the like. |
| The query would read more data than this data source allows | Narrow the time range or the columns, or raise **Maximum bytes billed per query**. |
| Stages (@name) are not allowed | Kalzit reads only tables; load files into a table first. |

Kalzit's tests run against recorded API answers; a nightly job of the project runs the same
checks against real warehouses where test credentials exist.
