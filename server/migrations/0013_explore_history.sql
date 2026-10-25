-- Queries a user ran from Explore, private to that user and kept for 30 days. Only the query
-- the user typed is stored, never its result and never a data source's settings or secrets.
-- Entries go with their user, organization and data source; what the user may still query is
-- decided when the rows are read.
--
-- `search_text` is the text of the query (every string in it) in lower case, made by the server,
-- so a search compares the same way on SQLite and PostgreSQL, also for letters like Ä.

CREATE TABLE explore_history (
    id            TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    org_id        TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
    datasource_id TEXT NOT NULL REFERENCES datasources (id) ON DELETE CASCADE,
    query         TEXT NOT NULL,
    search_text   TEXT NOT NULL,
    shape         TEXT NOT NULL,
    row_count     BIGINT,
    duration_ms   BIGINT,
    created_at    BIGINT NOT NULL
);

CREATE INDEX explore_history_user_org ON explore_history (user_id, org_id, created_at DESC);
-- The retention job deletes by age across all users.
CREATE INDEX explore_history_created ON explore_history (created_at);
