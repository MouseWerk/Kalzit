## Improved

- SQL queries know the time macros Grafana users know: `$__time`, `$__timeEpoch`, `$__timeGroup`
  and `$__timeGroupAlias` (buckets such as `1h`, `$__interval` or an interval variable, with
  `NULL`, `previous` or a number to fill empty buckets), and the Unix epoch macros
  `$__unixEpochFilter`, `$__unixEpochNanoFilter`, `$__unixEpochFrom`, `$__unixEpochTo`,
  `$__unixEpochNanoFrom`, `$__unixEpochNanoTo`, `$__unixEpochGroup` and
  `$__unixEpochGroupAlias`, on every SQL source. Imported Grafana dashboards that use them run
  unchanged, and the import no longer warns about them.
- The Macros section under the SQL editor and the completion list the new macros with a short
  description each.
- When a data source cannot read a value of a query, the error now says so in plain words and
  points at the variables and casts; the technical text stays under the details.

## Fixed

- A dashboard interval variable used in a PostgreSQL query, such as
  `date_bin($bucket::interval, created_at, timestamptz '2000-01-01')`, failed with "insufficient
  data left in message". Text variables now work wherever PostgreSQL expects another type, such as
  an interval or an integer column.

## Checklist for Windows (manual)

- On a PostgreSQL source, add an interval variable `bucket` with `1h,6h,1d` to a dashboard and run
  `SELECT date_bin($bucket::interval, created_at, timestamptz '2000-01-01') AS t, count(*) FROM ...
  GROUP BY 1 ORDER BY 1`: the panel shows one row per bucket for each choice of `bucket`.
- Run `SELECT $__timeGroupAlias(created_at, $bucket, 0), count(*) FROM ... WHERE
  $__timeFilter(created_at) GROUP BY 1 ORDER BY 1`: empty buckets show 0, and the Macros section
  under the editor lists the new macros in German and English.
