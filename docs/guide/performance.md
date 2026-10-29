# Performance and caching

How Kalzit keeps dashboards quick without loading your databases, and what to set when a source
is slow or must always be live.

## The query cache

Kalzit keeps the answers of queries on the server for a while. When you open a dashboard again,
switch back to it or another panel asks the same, the answer comes from memory instead of the
database.

- **Per person.** An answer is kept for the person who ran it. Nobody ever sees an answer someone
  else's rights produced: each person has their own entries, and Kalzit checks your rights on
  every load before it looks into the cache.
- **Refresh asks the database.** The **Refresh** button of a dashboard always runs the queries in
  their sources and keeps the new answers. Opening a dashboard, auto refresh and a new time range
  use the cache.
- **Relative ranges.** For a range that ends now ("Last 6 hours"), Kalzit moves the range back to
  a round step so that loads close together share one answer. The step is the panel's interval,
  at least a second and at most how long the source keeps answers. So the newest point can be up
  to one step old; with the default it is at most a minute.
- **Live stays live.** Live updates (change streams and polling of live dashboards), exports,
  annotations and field distributions always ask the source.
- **Only answers.** Errors and timeouts are never kept: the next load tries again.

### Per data source

Every data source has a **Cache** section in its settings:

- **Cache answers on the server**: on by default for SQL databases (PostgreSQL, MySQL and MariaDB,
  SQL Server, SQLite), Elasticsearch and OpenSearch, Neo4j, Memgraph and TigerGraph; off by default
  for Prometheus, MongoDB, files, HTTP APIs and plugins, whose values are often live.
- **Keep answers for (seconds)**: 60 by default, up to a day. Use a few seconds for data that
  changes often, minutes for expensive reports over data that changes slowly. Turn caching off
  for values that must always be current.

Any change of a data source's settings forgets its kept answers.

### For the server

Under **Settings > Data sources and targets** (Verwaltung > Einstellungen), server administrators
find:

- **Query cache**: on or off for the whole server. Off, nothing is kept and what was kept is let
  go.
- **Query cache memory (bytes)**: how much memory all kept answers may take together (256 MiB by
  default). When it is full, the answers used least recently go first; one answer larger than a
  quarter of it is not kept.
- **Query cache now**: how many answers are kept, how much memory they take and how often loads
  came from the cache since the server started, with **Empty cache**. Emptying is recorded in the
  audit log.

Changes of rights (grants, roles, members, teams, restricted folders) forget the organization's
kept answers at once.

## Seeing what happened

The **Inspect** view of a panel (and Explore's **Inspect** tab) says per query whether the answer
came from the server cache and how old it is, or that it ran in the data source and how long it is
kept. API clients read the `X-Kalzit-Cache` header (`hit`, `miss`, `refresh` or `off`) and the
`cache` part of each answer; `Cache-Control: no-cache` asks the sources directly
([API](../api/datasources.md#query-cache)).

## Other limits that keep the server responsive

- Each query has a time limit (30 s by default) and a row limit (100,000), per source within the
  server's maximum ([Data sources](data-sources.md#limits-on-every-source)).
- At most 8 queries per person and 64 on the whole server run at the same time; more wait.
- The answers of one request may take 128 MiB of memory, those of all running requests 1 GiB.
