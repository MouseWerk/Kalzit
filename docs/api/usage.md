# Usage insights API

How often dashboards are opened and how often, how slowly and how reliably panels and data
sources answer, counted per hour. The UI shows it under Verwaltung > Nutzung (Administration >
Usage).

## Privacy: nothing per person

- Counts are kept per organization and dashboard, panel or data source, and per hour. Kalzit
  stores no user id, session, client address, user agent, query text or result for them; the
  tables have no column for one (a server test pins their columns).
- A dashboard opened by one person and by ten people counts the same way: as views. Nobody, also
  no server administrator, can read from these counts who looked at what.
- Counts are deleted after `usage.retention_days` (90 by default, at most 365). Recording can be
  turned off with `usage.enabled`; off, nothing new is counted, and what was counted stays until
  it expires.

## What is counted

| Table | Key | Counts |
|---|---|---|
| `usage_dashboard_views` | hour, organization, dashboard | views: each `POST /orgs/{orgId}/dashboards/{dashboardId}/views` (the UI sends it when a dashboard opens) |
| `usage_panel_runs` | hour, organization, dashboard, panel | runs of a panel's stored queries from its dashboard (`POST .../panels/{panelId}/query`): errors (a run with at least one failed query), cache hits (every answer from the query cache) and misses (at least one query ran in its source with the cache in use), rows, durations |
| `usage_source_queries` | hour, organization, data source | every query asked of a data source (free queries, panels, variables, live updates, exports, annotations, AI): errors by class, cache hits and misses, rows and durations of the queries that ran in the source |

Error classes: `timeout` (`query_timeout`), `rejected` (`query_rejected`, refused before it ran),
`source` (`datasource_error`, `datasource_target_blocked`) and `other`. A query for a data source
that does not exist in the organization is not counted. Rows are frame rows, documents, or nodes
plus edges.

Durations are counted in 13 ranges (up to 5, 10, 25, 50, 100, 250, 500 ms, 1, 2.5, 5, 10, 30 s
and above), with their sum and the longest one. Medians (`p50Ms`) and 95th percentiles (`p95Ms`)
are estimated from the ranges, interpolated inside the range they fall in and never above the
longest one.

### Recording

Recording adds the event to the counts of its hour in memory; it never waits for the database
and never fails a request. Every 15 seconds, and once more when the server stops, the counts are
added to the stored rows in one transaction. The memory holds at most 20,000 hour buckets between
two writes; an event for a new bucket while it is full is dropped and counted (`dropped` in the
answers, since the server started). When the database is busy, the counts are kept for the next
write. Each server instance writes its own counts; the hourly retention job is idempotent.

## Who may read

| Route | Access |
|---|---|
| `GET /api/orgs/{orgId}/usage` | `audit:read` in the organization (admins and owners) |
| `GET /api/orgs/{orgId}/usage/unused` | `audit:read` in the organization |
| `GET /api/admin/usage` | server administrators: every organization, or one with `orgId` |
| `GET /api/admin/usage/unused` | server administrators |

Viewers and editors get `403 forbidden`; members of another organization `404 not_found`. A
member with `audit:read` who does not see every folder (a custom role without
`folders:permissions`) gets no counts of dashboards and panels in restricted folders or team
spaces they cannot see, also not in the totals and the trend; data sources are listed for every
reader. Dashboards and data sources in the trash or purged are left out of the lists. Server
administrators see every dashboard, also of organizations they are not a member of. `orgId` on the
organization routes is a `validation` error; an `orgId` of no organization on the server routes is
`not_found`.

## Report

`GET /orgs/{orgId}/usage?from=&to=` and `GET /admin/usage?from=&to=&orgId=`

`from` and `to` are Unix ms; the report covers the hours that start from the hour of `from` up to
before `to`. `to` must be after `from` and the period at most 366 days (`validation` otherwise).

```ts
{
  from: number; to: number;
  stepMs: number;          // the trend's step: an hour for periods up to 3 days, else a day (UTC)
  recording: boolean;      // usage.enabled now
  retentionDays: number;
  since: number | null;    // the oldest hour kept for this scope; nothing older is known
  dropped: number;         // events this server dropped since it started (buffer full)
  totals: { views, panelRuns, panelErrors, queries, queryErrors, cacheHits, cacheMisses };
  trend: { at, views, panelRuns, panelErrors, queries, queryErrors }[];  // a point per step, zeros included
  dashboards: { orgId, orgName, id, title, views, lastViewedAt }[];      // most viewed, at most 20
  slowPanels: PanelUsage[];      // by p95, then median, at most 20
  failingPanels: PanelUsage[];   // panels with errors, by share of failed runs, then errors, at most 20
  sources: SourceUsage[];        // every data source asked in the period, most queries first
}
PanelUsage = { orgId, orgName, dashboardId, dashboardTitle, panelId, panelTitle, runs, errors,
               cacheHits, cacheMisses, rows, p50Ms: number | null, p95Ms: number | null, maxMs }
SourceUsage = { orgId, orgName, id, name, kind, queries, errors, errorsTimeout, errorsRejected,
                errorsSource, errorsOther, cacheHits, cacheMisses, rows,
                p50Ms: number | null, p95Ms: number | null, maxMs }
```

`lastViewedAt` is the start of the last hour with a view in the period. Panels that are no longer
on their dashboard are left out; titles are those of the dashboard's current version. The
durations of a source are those of the queries that ran in it: a cache hit counts as a query and a
hit, not as a duration. The cache hit rate is `cacheHits / (cacheHits + cacheMisses)`.

## Unused dashboards

`GET /orgs/{orgId}/usage/unused?days=` and `GET /admin/usage/unused?days=&orgId=`

Dashboards (not in the trash) without a view in the last `days` days (default 30, 1 to 365),
counted in whole hours.

```ts
{
  days: number;
  since: number;                  // no view from this moment on
  recordedSince: number | null;   // the oldest hour kept for this scope
  items: { orgId, orgName, id, title, createdAt, lastViewedAt: number | null }[];  // at most 200
  total: number;                  // all of them
}
```

Dashboards never opened within the retention come first (`lastViewedAt` null), then the longest
unopened, then by title. When `recordedSince` is after `since`, recording began within the window
and a dashboard may have been opened before it; the UI says so.
