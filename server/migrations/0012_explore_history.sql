-- Queries a user ran from Explore, private to that user and kept for 30 days. Only the query
-- the user typed is stored, never its result and never a data source's settings or secrets.
-- Entries go with their user, organization and data source; what the user may still query is
-- decided when the rows are read.

CREATE TABLE explore_history (
    id            TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    org_id        TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
    datasource_id TEXT NOT NULL REFERENCES datasources (id) ON DELETE CASCADE,
    query         TEXT NOT NULL,
    shape         TEXT NOT NULL,
    row_count     BIGINT,
    duration_ms   BIGINT,
    created_at    BIGINT NOT NULL
);

CREATE INDEX explore_history_user_org ON explore_history (user_id, org_id, created_at DESC);
