## Improved

- New data source **Graphite** (graphite-web, carbonapi): targets with Graphite's functions over
  the render API, each series a line with its tags as labels, and metric names suggested in the
  editor. See [Data sources](../../guide/data-sources.md#graphite).
- New data source **Redis** (also Valkey, and with Redis Stack or Redis 8 JSON, search and time
  series): one command that reads per query, as in `redis-cli`; values, hashes, sorted sets, `INFO`
  and time series become tables, stream entries, JSON documents and search hits become
  documents. Only commands that read run; writes, scripts, blocking reads and `KEYS` are refused.
  The schema lists keys found with `SCAN`, with their types. See
  [Data sources](../../guide/data-sources.md#redis).
- New data source **Oracle Database**, without an Oracle Client to install: SQL with the macros
  and variables as bound values, every query in a read-only transaction, and the tables and views
  of the login in the schema. See [Data sources](../../guide/data-sources.md#oracle).
- ClickHouse can also be queried over its **native protocol** (port 9000, or 9440 with TLS), with
  the same read-only checks, parameters and types as over HTTP; a query cut off at a limit is
  cancelled on the server.
- Explore offers starters, a cheat sheet and error hints for Graphite, Redis and Oracle, and the
  query guide has sections for them
  ([Query languages](../../guide/query-languages.md#graphite)).

## Checklist for Windows (manual)

- Add an Oracle source (for example the `gvenzl/oracle-free` container) on a Windows server without
  an Oracle Client installed: **Test connection** shows the Oracle version, and a query returns rows.
- Add a Redis source and a ClickHouse (native protocol) source; **Test connection** succeeds, and
  `SET` in a Redis query is refused because only commands that read run.
