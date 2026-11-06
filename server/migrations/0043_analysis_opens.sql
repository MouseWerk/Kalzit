-- When each person last opened a saved analysis, for the list's "last opened" order
-- (docs/api/analyses.md). One row per user and analysis; rows go with the analysis when it is
-- purged, and with the user or organization. What a user may see is decided when rows are read.

CREATE TABLE analysis_opens (
    user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    org_id      TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
    analysis_id TEXT NOT NULL REFERENCES analyses (id) ON DELETE CASCADE,
    opened_at   BIGINT NOT NULL,
    PRIMARY KEY (user_id, analysis_id)
);

CREATE INDEX analysis_opens_analysis ON analysis_opens (analysis_id);
