-- Saved analyses (docs/api/analyses.md): an Explore query with its analysis steps and the chosen
-- visualization, saved under a name. They live in folders like dashboards and follow the same
-- rules: folder and analysis grants, restricted folders, team spaces and team ownership. Trashed
-- rows carry `deleted_at`; `trash_batch` groups what a folder's trash took along, so a restore
-- brings back exactly that. User ids (`created_by`, `updated_by`) have no foreign key, so the
-- analysis survives when an account is removed.
--
-- `body` is the current version of the analysis as JSON with its own `schemaVersion`; the server
-- migrates older bodies on read. `version` counts saves, for the optimistic check of an update.

CREATE TABLE analyses (
    id              TEXT PRIMARY KEY,
    org_id          TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
    folder_id       TEXT REFERENCES folders (id),
    title           TEXT NOT NULL,
    -- The title in lower case (Unicode rules, from the server), for case-insensitive search.
    search_title    TEXT NOT NULL,
    body            TEXT NOT NULL,
    version         BIGINT NOT NULL,
    created_by      TEXT,
    created_at      BIGINT NOT NULL,
    updated_by      TEXT,
    updated_at      BIGINT NOT NULL,
    deleted_at      BIGINT,
    trash_batch     TEXT,
    owner_team_id   TEXT REFERENCES teams (id),
    -- 1: only the owner team, grants on the analysis and org admins see it.
    team_only       BIGINT NOT NULL DEFAULT 0,
    -- 1 once the analysis was team only or moved out of a restricted folder: purged, its events
    -- stay hidden.
    ever_restricted BIGINT NOT NULL DEFAULT 0
);

CREATE INDEX analyses_org_title ON analyses (org_id, title, id);
CREATE INDEX analyses_folder ON analyses (folder_id);
CREATE INDEX analyses_owner_team ON analyses (owner_team_id);

-- Every save of an analysis, with its author; an overwrite after a version conflict keeps the
-- version it replaced here. Restoring an older one saves it as a new version.
CREATE TABLE analysis_versions (
    analysis_id   TEXT NOT NULL REFERENCES analyses (id) ON DELETE CASCADE,
    version       BIGINT NOT NULL,
    body          TEXT NOT NULL,
    author_id     TEXT,
    -- Set when this version brings back an older one (its number).
    restored_from BIGINT,
    created_at    BIGINT NOT NULL,
    PRIMARY KEY (analysis_id, version)
);

-- The data sources the current version queries, for the list's filter and its "may query" mark.
CREATE TABLE analysis_sources (
    org_id        TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
    analysis_id   TEXT NOT NULL REFERENCES analyses (id) ON DELETE CASCADE,
    datasource_id TEXT NOT NULL,
    PRIMARY KEY (analysis_id, datasource_id)
);

CREATE INDEX analysis_sources_datasource ON analysis_sources (org_id, datasource_id);

-- Which dashboards show an analysis as a linked panel, from each dashboard's current version
-- (trashed dashboards included, they can come back). An analysis in use cannot go to the trash.
CREATE TABLE analysis_uses (
    org_id        TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
    analysis_id   TEXT NOT NULL,
    dashboard_id  TEXT NOT NULL REFERENCES dashboards (id) ON DELETE CASCADE,
    PRIMARY KEY (analysis_id, dashboard_id)
);

CREATE INDEX analysis_uses_dashboard ON analysis_uses (dashboard_id);
