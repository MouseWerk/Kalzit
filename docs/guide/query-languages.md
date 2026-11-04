# Query languages for beginners

This page is for you if you open [Explore](explore.md) and have never written a query in the
language of your data source. Each section below shows what the source holds, a few small queries
to start from, and how Kalzit's time range and dashboard variables reach the query. The exact
rules per kind are in the API reference: [data sources and queries](../api/datasources.md#queries-post-orgsorgidquery).

You do not have to start from an empty editor:

- **Start here** appears while the editor is empty. Its starter actions fill in a safe, read-only
  query for the selected data source, such as the first rows of a table or the latest log lines.
  Run it as it is, then change it a little at a time.
- The **schema list** shows the tables, collections, metrics, indices or labels of the source.
  Next to an entry, **Show rows** fills in a query for its first rows, **Count** counts them and
  **Show structure** lists its columns or fields with their types.
- **Cheat sheet** (Shift+F1 anywhere, or Ctrl+/ / Cmd+/ outside the editor, where those keys
  comment lines out) opens a short reference of the current language: the
  common clauses, the macros and how variables are written.
- When a query fails, the error comes with a **hint** in plain words: what the source did not
  accept and what to try instead.
- **Show the query** next to a starter or a step shows the query behind it, so you can read how
  it is written and learn the language from your own data.

Every result keeps its native shape: a `frame` (rows and columns), `documents` (as the database
stores them) or a `graph` (nodes and edges). Kalzit never converts one into another behind your
back; a conversion is a step you add. Data sources are read-only: a query that would write,
delete or change the database is refused before it reaches the source (see
[Data sources](data-sources.md#read-only)).

## How the time range and variables apply

The time range you pick in Explore (or on the dashboard) does not filter anything by itself in
most languages: you place a **macro** such as `$__timeFilter(created_at)` or `$__timeFrom` in the
query, and Kalzit fills in the range. Prometheus, Loki and the search sources are the exceptions:
they always query the selected range. Macros such as `$__interval` give a grouping interval that
fits the range and the panel width. **Dashboard variables** are written `$name` (or `${name}`)
and are filled in on a dashboard; Explore has no variables, so try a query with a fixed value
first and replace it with the variable once the query sits in a panel. A value never changes the
structure of a query: SQL, Cypher and MongoDB receive values as bound parameters, and PromQL,
LogQL, InfluxQL and Lucene get them written into the text with every quote and special character
escaped.

## PostgreSQL

PostgreSQL holds tables of rows and columns, grouped in schemas (usually `public`). You read them
with one `SELECT` or `WITH` statement.

```sql
SELECT * FROM orders ORDER BY created_at DESC LIMIT 100
```

The 100 newest orders with all their columns.

```sql
SELECT status, count(*) AS orders FROM orders GROUP BY status ORDER BY orders DESC LIMIT 100
```

How many orders there are per status, the largest group first.

```sql
SELECT id, total, created_at FROM orders WHERE total > 100 AND status = 'paid' ORDER BY total DESC LIMIT 100
```

Paid orders above 100, the largest first.

```sql
SELECT c.name, count(o.id) AS orders, sum(o.total) AS revenue
FROM customers c JOIN orders o ON o.customer_id = c.id
GROUP BY c.name ORDER BY revenue DESC LIMIT 100
```

Orders and revenue per customer, by joining two tables.

```sql
SELECT date_bin($__interval, created_at, TIMESTAMP '2000-01-01') AS time, count(*) AS orders
FROM orders WHERE $__timeFilter(created_at)
GROUP BY 1 ORDER BY 1 LIMIT 1000
```

Orders over time within the selected range, one row per interval (`date_bin` needs PostgreSQL 14
or later); this answers a time series.

**Time range and variables:** `$__timeFilter(column)` keeps the rows in the range, `$__timeFrom`
and `$__timeTo` are its ends, `$__interval` is an `interval` value and `$__interval_ms` the same in
milliseconds. A variable is `$status`; a multi-value variable goes into `IN ($status)`. Variables
arrive as text, so cast them for other column types: `id = $id::int`.

## MySQL and MariaDB

MySQL and MariaDB hold tables in databases. You read them with one `SELECT` or `WITH` statement;
names may be quoted with backticks.

```sql
SELECT * FROM orders ORDER BY created_at DESC LIMIT 100
```

The 100 newest orders.

```sql
SELECT status, COUNT(*) AS orders FROM orders GROUP BY status ORDER BY orders DESC LIMIT 100
```

Number of orders per status.

```sql
SELECT id, total FROM orders WHERE status = 'paid' AND total > 100 ORDER BY total DESC LIMIT 100
```

Paid orders above 100.

```sql
SELECT c.name, COUNT(o.id) AS orders
FROM customers c JOIN orders o ON o.customer_id = c.id
GROUP BY c.name ORDER BY orders DESC LIMIT 100
```

Orders per customer.

```sql
SELECT FROM_UNIXTIME(FLOOR(UNIX_TIMESTAMP(created_at) * 1000 / $__interval_ms) * $__interval_ms / 1000) AS time,
       COUNT(*) AS orders
FROM orders WHERE $__timeFilter(created_at)
GROUP BY 1 ORDER BY 1 LIMIT 1000
```

Orders per interval within the selected range.

**Time range and variables:** `$__timeFilter(column)`, `$__timeFrom`, `$__timeTo`, `$__interval`
(text such as `30s`) and `$__interval_ms` (a whole number). Times are compared in UTC. Variables
are `$name`, lists go into `IN ($name)`.

## SQLite

A SQLite source is one database file with tables. Kalzit opens it read-only and reads it with one
`SELECT` or `WITH` statement.

```sql
SELECT * FROM orders LIMIT 100
```

The first 100 rows of a table.

```sql
SELECT status, COUNT(*) AS orders FROM orders GROUP BY status ORDER BY orders DESC LIMIT 100
```

Number of orders per status.

```sql
SELECT id, total, created_at FROM orders WHERE total > 100 ORDER BY created_at DESC LIMIT 100
```

The newest orders above 100.

```sql
SELECT strftime('%Y-%m-%d', created_at) AS day, COUNT(*) AS orders
FROM orders WHERE $__timeFilter(created_at)
GROUP BY day ORDER BY day LIMIT 1000
```

Orders per day within the selected range.

```sql
SELECT c.name, SUM(o.total) AS revenue
FROM customers c JOIN orders o ON o.customer_id = c.id
GROUP BY c.name ORDER BY revenue DESC LIMIT 100
```

Revenue per customer.

**Time range and variables:** `$__timeFilter(column)` works for times stored as text or as Unix
seconds or milliseconds; `$__timeFrom` and `$__timeTo` are text (`YYYY-MM-DD HH:MM:SS.SSS`, UTC),
plus `$__interval` and `$__interval_ms`. Variables are `$name`, lists go into `IN ($name)`.

## SQL Server

SQL Server holds tables in databases and schemas (usually `dbo`). You read them with one `SELECT`
or `WITH` statement. SQL Server has no `LIMIT`: write `TOP` after `SELECT`.

```sql
SELECT TOP 100 * FROM orders ORDER BY created_at DESC
```

The 100 newest orders.

```sql
SELECT TOP 100 status, COUNT(*) AS orders FROM orders GROUP BY status ORDER BY orders DESC
```

Number of orders per status.

```sql
SELECT TOP 100 id, total FROM orders WHERE status = 'paid' AND total > 100 ORDER BY total DESC
```

Paid orders above 100.

```sql
SELECT TOP 100 c.name, COUNT(o.id) AS orders
FROM customers c JOIN orders o ON o.customer_id = c.id
GROUP BY c.name ORDER BY orders DESC
```

Orders per customer.

```sql
SELECT TOP 1000 CAST(created_at AS date) AS day, COUNT(*) AS orders
FROM orders WHERE $__timeFilter(created_at)
GROUP BY CAST(created_at AS date) ORDER BY day
```

Orders per day within the selected range.

**Time range and variables:** `$__timeFilter(column)`, `$__timeFrom`, `$__timeTo`, `$__interval`
and `$__interval_ms`, as for the other SQL sources. Variables are `$name`, lists go into
`IN ($name)`. Query hints (`OPTION (...)`) and table hints other than `NOLOCK` are refused.

## ClickHouse

ClickHouse holds large tables for analysis, often one row per event. You read them with SQL in
ClickHouse's own dialect, one `SELECT` or `WITH` statement.

```sql
SELECT * FROM events ORDER BY ts DESC LIMIT 100
```

The 100 newest events.

```sql
SELECT path, count() AS requests FROM events GROUP BY path ORDER BY requests DESC LIMIT 100
```

Requests per path, the busiest first.

```sql
SELECT path, status FROM events WHERE status >= 500 ORDER BY ts DESC LIMIT 100
```

The newest failed requests.

```sql
SELECT toStartOfInterval(ts, $__interval) AS time, count() AS requests
FROM events WHERE $__timeFilter(ts)
GROUP BY time ORDER BY time LIMIT 1000
```

Requests per interval within the selected range.

**Time range and variables:** the SQL macros (`$__timeFilter(column)`, `$__timeFrom`, `$__timeTo`,
`$__interval`, `$__interval_ms`) and variables (`$name`) become ClickHouse query parameters.
`SETTINGS` and `FORMAT` clauses, hand-written parameters such as `{name:Type}` and table functions
that read files or other servers are refused.

## Prometheus

Prometheus holds metrics: named series of numbers over time, each with labels such as `job` or
`status`. You read them with PromQL. There is no `LIMIT`: a range query is bounded by the time
range and the step.

```promql
up
```

Every target and whether it was reachable (1) or not (0).

```promql
http_requests_total{status="500"}
```

The request counter, only for series with the label `status="500"`.

```promql
sum by (status) (rate(http_requests_total[$__rate_interval]))
```

Requests per second, one line per status.

```promql
topk(5, sum by (path) (rate(http_requests_total[$__rate_interval])))
```

The five busiest paths.

```promql
histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket[$__rate_interval])))
```

The 95th percentile of the request duration.

**Time range and variables:** every query covers the selected range; turn on **Instant query** for
one value at its end. `$__rate_interval` is a safe window for `rate()`; `$__interval`,
`$__interval_ms`, `$__range`, `$__timeFrom` and `$__timeTo` (Unix seconds) are there too.
Variables work only inside quoted strings, such as `job="$job"`; a multi-value variable becomes
`a|b`, so use it with `=~`: `job=~"$job"`.

## InfluxDB

InfluxDB holds measurements (such as `cpu`) with fields (the values) and tags (such as `host`)
over time, in a database or bucket. Depending on the version you write Flux (1.8, 2.x), InfluxQL
(every version) or SQL (3.x).

```flux
from(bucket: v.bucket)
  |> range(start: v.timeRangeStart, stop: v.timeRangeStop)
  |> filter(fn: (r) => r._measurement == "cpu")
  |> limit(n: 100)
```

Flux: the first 100 values of the measurement `cpu` per series within the selected range.

```flux
from(bucket: v.bucket)
  |> range(start: v.timeRangeStart, stop: v.timeRangeStop)
  |> filter(fn: (r) => r._measurement == "cpu" and r._field == "usage")
  |> aggregateWindow(every: v.windowPeriod, fn: mean)
```

Flux: the mean usage per interval, one line per series.

```sql
SELECT mean("usage") FROM "cpu" WHERE $__timeFilter GROUP BY time($__interval), "host" LIMIT 1000
```

InfluxQL: the mean usage per interval and host within the selected range.

```sql
SHOW MEASUREMENTS LIMIT 100
```

InfluxQL: which measurements the database holds.

```sql
SELECT time, host, usage FROM cpu WHERE time >= $__timeFrom AND time <= $__timeTo ORDER BY time DESC LIMIT 100
```

SQL (3.x): the newest rows of `cpu` within the selected range.

**Time range and variables:** in Flux use `v.timeRangeStart`, `v.timeRangeStop`, `v.windowPeriod`
(the interval) and `v.bucket` (the source's bucket); `$__timeFrom`, `$__timeTo`, `$__interval`,
`$__interval_ms` and `$__range` work too. In InfluxQL `$__timeFilter` takes no column, and
`GROUP BY time($__interval)` groups by the interval. In Flux and InfluxQL variables work only
inside strings, such as `r.host == "$host"` or `"host" = '$host'`. `to()` in Flux and `INTO` in
InfluxQL are refused.

## Loki

Loki holds log lines in streams; each stream is named by its labels, such as `{app="shop"}`. You
read them with LogQL: first pick streams by label, then filter the lines.

```logql
{app="shop"}
```

The newest log lines of the `shop` streams (at most 1,000 lines unless you set a lower limit).

```logql
{app="shop"} |= "error"
```

Only lines that contain `error`.

```logql
{app="shop"} | json | status >= 500
```

Reads each line as JSON and keeps those with a `status` of 500 or more.

```logql
sum by (level) (count_over_time({app="shop"}[$__interval]))
```

Number of lines per level and interval: a metric query, which answers a time series.

```logql
sum(rate({app="shop"} |= "error" [$__rate_interval]))
```

Error lines per second.

**Time range and variables:** every query covers the selected range; log queries answer
`documents` (one per line), metric queries a `frame`. `$__interval`, `$__rate_interval`, `$__range`
and the other Prometheus macros work the same way. Variables work only inside quoted strings, such
as `{app="$app"}`; a multi-value variable becomes `a|b` for `=~`.

## Elasticsearch and OpenSearch

Elasticsearch and OpenSearch hold JSON documents in indices, often one index per day
(`logs-2026.11.02`), matched by a pattern such as `logs-*`. You search them with a **Lucene** query
string or with **Query DSL** (a JSON search body). Set the **Number of hits** to keep the answer
small (500 when empty).

```text
status:500
```

Lucene: documents whose field `status` is 500.

```text
status:500 AND path:"/checkout"
```

Lucene: both conditions; quote values with spaces or special characters.

```text
level:error AND NOT service:billing
```

Lucene: errors from every service but one.

```json
{ "query": { "range": { "duration_ms": { "gte": 1000 } } }, "sort": [{ "@timestamp": "desc" }], "size": 100 }
```

Query DSL: the 100 newest documents that took a second or longer.

```json
{ "aggs": { "per_status": { "terms": { "field": "status", "size": 10 } } } }
```

Query DSL: the number of documents per status, as a table with one row per value.

```json
{ "aggs": { "time": { "date_histogram": { "field": "@timestamp", "fixed_interval": "$__interval" } } } }
```

Query DSL: the number of documents per interval, a time series.

**Time range and variables:** when **Filter by the time range** is on, the selected range is always
added as a filter on the **Time field**, so you do not write it yourself. `$__timeFrom` and
`$__timeTo` (Unix ms), `$__interval` and `$__interval_ms` exist too. In Lucene a variable such as
`country:$country` becomes a quoted phrase; in Query DSL a variable or macro is a whole string such
as `"$country"` or `"$__interval"`. **Start from a template** in Explore fills in the common forms.

## CSV and JSON files

A file source reads one CSV, JSON or NDJSON file; CSV answers a `frame`, JSON and NDJSON answer
`documents`. There is no query language: the data source already names the file and how it is
read, so the query is empty and the whole file is read on every run, within the row and size
limits.

You shape the data with **steps** in the **Steps and actions** panel on the right instead:

- **Group** counts or sums per value, such as orders per status.
- **Calculated field** adds a column from an expression, such as `total * 1.19`.
- **Statistics** answers count, sum, mean, median and more per field.
- For JSON documents, **Add projection step** turns chosen fields into table columns first.

See [Calculated fields and statistics](calculated-fields.md) for every step and the expression
language.

**Time range and variables:** a file has no macros. The time range and variables do not filter the
file; it is always read whole.

## HTTP JSON

An HTTP JSON source reads JSON from a web API with `GET` requests and answers `documents`. Instead
of a query language you fill in three fields:

- **Path**: added below the source's URL, such as `orders/open`. It must stay below that URL.
- **Query parameters**: name and value pairs, such as `status` = `paid` or `page_size` = `100`.
- **Path to the documents**: where the list sits in the answer, as a dotted path such as
  `data.items` (numbers pick array elements: `results.0.rows`). Empty uses the source's setting or
  the whole answer.

```json
{ "path": "orders", "params": { "status": "paid", "page_size": 100 }, "documentsPath": "data.items" }
```

Paid orders from `<source URL>/orders?status=paid&page_size=100`, one document per element of
`data.items`.

```json
{ "path": "customers", "params": { "country": "$country" }, "documentsPath": "results" }
```

Customers of the country chosen in a dashboard variable.

**Time range and variables:** Kalzit does not add the time range to the request; whether the API
can filter by time depends on the API. A parameter whose value is exactly `$name` takes the
variable's value; a multi-value variable repeats the parameter (`country=AT&country=CH`). Use
steps on the right to project, group or calculate further.

## MongoDB

MongoDB holds documents (nested JSON-like records) in collections. You read a collection with an
**aggregation pipeline** (a list of stages, each working on the output of the one before) or with
**Find** (a filter, a projection, a sort and a limit). Pick the **Collection** in Explore; the
examples below write it next to the pipeline for completeness (the API takes the pipeline as text).

```json
{ "collection": "orders", "pipeline": [ { "$sort": { "created_at": -1 } }, { "$limit": 100 } ] }
```

The 100 newest orders.

```json
{ "collection": "orders", "pipeline": [
  { "$match": { "status": "paid", "total": { "$gt": 100 } } },
  { "$limit": 100 }
] }
```

Paid orders above 100.

```json
{ "collection": "orders", "pipeline": [
  { "$group": { "_id": "$status", "orders": { "$sum": 1 } } },
  { "$sort": { "orders": -1 } },
  { "$limit": 100 }
] }
```

Number of orders per status, the largest group first.

```json
{ "collection": "orders", "pipeline": [
  { "$match": { "$__timeFilter": "created_at" } },
  { "$lookup": { "from": "customers", "localField": "customer_id", "foreignField": "_id", "as": "customer" } },
  { "$limit": 100 }
] }
```

Orders within the selected range, each with its customer document attached.

```json
{ "collection": "orders", "filter": "{\"status\": \"paid\"}", "projection": "{\"total\": 1, \"created_at\": 1}",
  "sort": "{\"created_at\": -1}", "limit": 100 }
```

The same kind of question with **Find**: paid orders, only two fields, newest first, at most 100.

In the pipeline view each stage can be turned off and previewed (**Preview after stage N**), which
is a good way to see what a stage does. `$out` and `$merge` write and are refused.

**Time range and variables:** `{"$__timeFilter": "created_at"}` inside a `$match` or a filter keeps
the documents in the range; `"$__timeFrom"` and `"$__timeTo"` are its ends as dates and
`"$__interval_ms"` the interval. A variable is written as a whole string, `"${status}"`; a
multi-value variable becomes an array, for `{ "status": { "$in": "${status}" } }`.

## Neo4j and Memgraph

Neo4j and Memgraph hold a graph: nodes with labels (such as `Person`) and relationships with types
(such as `KNOWS`), both with properties. You read them with Cypher, which describes the pattern
you look for with `MATCH` and what to return with `RETURN`. Every query runs in a read
transaction.

```cypher
MATCH (p:Person) RETURN p LIMIT 100
```

The first 100 `Person` nodes.

```cypher
MATCH (p:Person) RETURN p.city AS city, count(*) AS people ORDER BY people DESC LIMIT 100
```

Number of people per city, as a table.

```cypher
MATCH (a:Person)-[k:KNOWS]->(b:Person) WHERE a.city = 'Graz' RETURN a, k, b LIMIT 100
```

People in one city and whom they know, as a graph.

```cypher
MATCH path = shortestPath((a:Person {name: 'Ana'})-[:KNOWS*..4]-(b:Person {name: 'Ben'})) RETURN path
```

The shortest chain of acquaintances between two people, at most four steps; use the **Paths**
panel for it.

```cypher
MATCH (a:Person)-[k:KNOWS]->(b:Person) WHERE k.since >= $__timeFrom AND k.since <= $__timeTo RETURN a, k, b LIMIT 100
```

Acquaintances made within the selected range.

```cypher
CALL db.labels()
```

Which node labels the database holds.

```cypher
CALL community_detection.get() YIELD node, community_id RETURN community_id, count(*) AS size
```

Memgraph with MAGE: how large each community is. Graph algorithms that only read are allowed in
both databases (Neo4j GDS in `stream` and `stats` mode on a graph an administrator projected);
see [Graph algorithms](data-sources.md#graph-algorithms-neo4j-gds-memgraph-mage).

**Time range and variables:** `$__timeFrom` and `$__timeTo` are UTC DateTime values,
`$__timeFromMs`, `$__timeToMs` and `$__interval_ms` whole numbers of milliseconds. Variables are
Cypher parameters, such as `WHERE p.name = $name` or `WHERE p.id IN $ids`. A value picked on a
dashboard is text: compare with `toInteger($id)` when the property holds numbers.

## TigerGraph

TigerGraph holds a graph of vertices (such as `Person`) and edges (such as `KNOWS`) in a named
graph. You read it with GSQL, either as an interpreted query written in Explore (**Write GSQL**) or
by running one of the graph's **installed queries** (**Run an installed query**). An interpreted
query is one `INTERPRET QUERY (...) FOR GRAPH <graph> { ... }`, using the graph of the data
source; a `SELECT` block picks vertices and `PRINT` returns them.

```gsql
INTERPRET QUERY () FOR GRAPH Social {
  start = {Person.*};
  result = SELECT p FROM start:p LIMIT 100;
  PRINT result;
}
```

The first 100 `Person` vertices.

```gsql
INTERPRET QUERY () FOR GRAPH Social {
  start = {Person.*};
  result = SELECT p FROM start:p WHERE p.city == "Graz" ORDER BY p.name LIMIT 100;
  PRINT result;
}
```

People in one city, sorted by name.

```gsql
INTERPRET QUERY () FOR GRAPH Social {
  MapAccum<STRING, SumAccum<INT>> @@per_city;
  start = {Person.*};
  result = SELECT p FROM start:p ACCUM @@per_city += (p.city -> 1);
  PRINT @@per_city;
}
```

Number of people per city, counted in an accumulator.

```gsql
INTERPRET QUERY () FOR GRAPH Social {
  SetAccum<EDGE> @@edges;
  start = {Person.*};
  friends = SELECT t FROM start:s -(KNOWS:e)- Person:t ACCUM @@edges += e LIMIT 100;
  PRINT friends, @@edges;
}
```

People and whom they know, one step along `KNOWS`; printing the edges too answers a graph.

```gsql
INTERPRET QUERY (STRING city) FOR GRAPH Social {
  start = {Person.*};
  result = SELECT p FROM start:p WHERE p.city == city LIMIT 100;
  PRINT result;
}
```

The same filter with a declared parameter `city`, filled in Explore or from a dashboard variable.

**Time range and variables:** GSQL has no macros, and variables never become GSQL text: `$name`
written into the code is refused. Declare a parameter instead, as in the last example; a parameter
left empty takes the dashboard variable of the same name. For a time filter, declare `DATETIME`
parameters and fill them from variables. An installed query lists its parameters with their types
in Explore and follows the same rule.
