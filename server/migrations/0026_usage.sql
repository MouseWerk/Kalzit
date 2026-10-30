-- Usage insights (docs/api/usage.md): how often dashboards are opened, how often and how slowly
-- panels and data sources answer, counted per hour. Never per person: the rows hold an
-- organization, a dashboard, panel or data source id and counts, and no user, session or address.
-- `bucket` is the start of the hour (Unix ms, UTC). The server adds to the counts in batches
-- (`usage::flush`); rows older than `usage.retention_days` are deleted every hour.
--
-- Durations are counted in the 13 ranges of `usage::DURATION_BOUNDS_MS` (`d0` up to 5 ms, ...,
-- `d12` above 30 s), from which the medians and 95th percentiles are estimated, with their sum and
-- the longest one. Dashboard, panel and data source ids have no foreign key: a purged one leaves its
-- rows until they expire, and the reports leave them out.

CREATE TABLE usage_dashboard_views (
    bucket        BIGINT NOT NULL,
    org_id        TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
    dashboard_id  TEXT NOT NULL,
    views         BIGINT NOT NULL,
    PRIMARY KEY (bucket, org_id, dashboard_id)
);

CREATE INDEX usage_dashboard_views_org ON usage_dashboard_views (org_id, bucket);
-- The last view of each dashboard, for the unused dashboards (`usage::report::unused`).
CREATE INDEX usage_dashboard_views_dashboard ON usage_dashboard_views (org_id, dashboard_id, bucket);

-- Runs of a panel's stored queries from the dashboard (`POST .../panels/{panelId}/query`).
-- `cache_hits` counts runs answered entirely from the query cache, `cache_misses` runs of which at
-- least one query ran in its source while the cache was in use.
CREATE TABLE usage_panel_runs (
    bucket          BIGINT NOT NULL,
    org_id          TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
    dashboard_id    TEXT NOT NULL,
    panel_id        TEXT NOT NULL,
    runs            BIGINT NOT NULL,
    errors          BIGINT NOT NULL,
    cache_hits      BIGINT NOT NULL,
    cache_misses    BIGINT NOT NULL,
    result_rows     BIGINT NOT NULL,
    duration_sum_ms BIGINT NOT NULL,
    duration_max_ms BIGINT NOT NULL,
    d0 BIGINT NOT NULL, d1 BIGINT NOT NULL, d2 BIGINT NOT NULL, d3 BIGINT NOT NULL,
    d4 BIGINT NOT NULL, d5 BIGINT NOT NULL, d6 BIGINT NOT NULL, d7 BIGINT NOT NULL,
    d8 BIGINT NOT NULL, d9 BIGINT NOT NULL, d10 BIGINT NOT NULL, d11 BIGINT NOT NULL,
    d12 BIGINT NOT NULL,
    PRIMARY KEY (bucket, org_id, dashboard_id, panel_id)
);

CREATE INDEX usage_panel_runs_org ON usage_panel_runs (org_id, bucket);

-- Every query a data source was asked (free queries, panels, variables, live updates, exports,
-- AI), with its errors by class. Answers from the query cache count as queries and as
-- `cache_hits`; the durations and rows are those of the queries that ran in the source.
CREATE TABLE usage_source_queries (
    bucket           BIGINT NOT NULL,
    org_id           TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
    datasource_id    TEXT NOT NULL,
    queries          BIGINT NOT NULL,
    errors           BIGINT NOT NULL,
    errors_timeout   BIGINT NOT NULL,
    errors_rejected  BIGINT NOT NULL,
    errors_source    BIGINT NOT NULL,
    errors_other     BIGINT NOT NULL,
    cache_hits       BIGINT NOT NULL,
    cache_misses     BIGINT NOT NULL,
    result_rows      BIGINT NOT NULL,
    duration_sum_ms  BIGINT NOT NULL,
    duration_max_ms  BIGINT NOT NULL,
    d0 BIGINT NOT NULL, d1 BIGINT NOT NULL, d2 BIGINT NOT NULL, d3 BIGINT NOT NULL,
    d4 BIGINT NOT NULL, d5 BIGINT NOT NULL, d6 BIGINT NOT NULL, d7 BIGINT NOT NULL,
    d8 BIGINT NOT NULL, d9 BIGINT NOT NULL, d10 BIGINT NOT NULL, d11 BIGINT NOT NULL,
    d12 BIGINT NOT NULL,
    PRIMARY KEY (bucket, org_id, datasource_id)
);

CREATE INDEX usage_source_queries_org ON usage_source_queries (org_id, bucket);
