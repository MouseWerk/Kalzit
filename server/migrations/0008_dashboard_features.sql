-- What dashboards share beyond their model: annotations written by people, playlists, library
-- panels with the dashboards that show them, and the tags of each dashboard's current version for
-- finding dashboards by tag. User ids have no foreign key, so rows survive a removed account.

CREATE TABLE annotations (
    id            TEXT PRIMARY KEY,
    org_id        TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
    dashboard_id  TEXT NOT NULL REFERENCES dashboards (id) ON DELETE CASCADE,
    -- NULL: the annotation belongs to every time panel of the dashboard.
    panel_id      TEXT,
    time_ms       BIGINT NOT NULL,
    -- Set for a span; NULL for a point in time.
    time_end_ms   BIGINT,
    text          TEXT NOT NULL,
    -- JSON array of texts.
    tags          TEXT NOT NULL,
    version       BIGINT NOT NULL,
    created_by    TEXT,
    created_at    BIGINT NOT NULL,
    updated_by    TEXT,
    updated_at    BIGINT NOT NULL
);

CREATE INDEX annotations_dashboard_time ON annotations (dashboard_id, time_ms, id);

CREATE TABLE playlists (
    id                TEXT PRIMARY KEY,
    org_id            TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
    name              TEXT NOT NULL,
    interval_seconds  BIGINT NOT NULL,
    -- JSON array of {"type": "dashboard", "dashboardId"} and {"type": "tag", "tag"}.
    items             TEXT NOT NULL,
    version           BIGINT NOT NULL,
    created_by        TEXT,
    created_at        BIGINT NOT NULL,
    updated_by        TEXT,
    updated_at        BIGINT NOT NULL
);

CREATE INDEX playlists_org_name ON playlists (org_id, name, id);

CREATE TABLE library_panels (
    id           TEXT PRIMARY KEY,
    org_id       TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
    folder_id    TEXT REFERENCES folders (id),
    name         TEXT NOT NULL,
    -- The name in lower case (Unicode rules, from the server), for case-insensitive search.
    search_name  TEXT NOT NULL,
    -- The panel content as JSON with its schemaVersion; migrated on read.
    model        TEXT NOT NULL,
    version      BIGINT NOT NULL,
    created_by   TEXT,
    created_at   BIGINT NOT NULL,
    updated_by   TEXT,
    updated_at   BIGINT NOT NULL
);

CREATE INDEX library_panels_org_name ON library_panels (org_id, name, id);
CREATE INDEX library_panels_folder ON library_panels (folder_id);

-- Which dashboards show a library panel, from each dashboard's current version (trashed ones
-- included, they can come back).
CREATE TABLE library_panel_uses (
    org_id            TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
    library_panel_id  TEXT NOT NULL,
    dashboard_id      TEXT NOT NULL REFERENCES dashboards (id) ON DELETE CASCADE,
    PRIMARY KEY (library_panel_id, dashboard_id)
);

CREATE INDEX library_panel_uses_dashboard ON library_panel_uses (dashboard_id);

-- The current version's tags as a JSON array, for lists; `dashboard_tags` is for searching.
ALTER TABLE dashboards ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';

CREATE TABLE dashboard_tags (
    org_id        TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
    dashboard_id  TEXT NOT NULL REFERENCES dashboards (id) ON DELETE CASCADE,
    tag           TEXT NOT NULL,
    -- The tag in lower case, for matching regardless of case.
    tag_key       TEXT NOT NULL,
    PRIMARY KEY (dashboard_id, tag_key)
);

CREATE INDEX dashboard_tags_org_tag ON dashboard_tags (org_id, tag_key);
