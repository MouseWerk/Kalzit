-- Folders, dashboards and every saved version of a dashboard. Trashed rows carry `deleted_at`;
-- purging deletes them. User ids (`created_by`, `author_id`) have no foreign key, so the history
-- survives when an account is removed.

CREATE TABLE folders (
    id          TEXT PRIMARY KEY,
    org_id      TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
    parent_id   TEXT REFERENCES folders (id),
    name        TEXT NOT NULL,
    restricted  BIGINT NOT NULL DEFAULT 0,
    version     BIGINT NOT NULL,
    created_by  TEXT,
    created_at  BIGINT NOT NULL,
    updated_at  BIGINT NOT NULL,
    deleted_at  BIGINT
);

CREATE INDEX folders_org_parent ON folders (org_id, parent_id);

CREATE TABLE dashboards (
    id          TEXT PRIMARY KEY,
    org_id      TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
    folder_id   TEXT REFERENCES folders (id),
    title       TEXT NOT NULL,
    version     BIGINT NOT NULL,
    created_by  TEXT,
    created_at  BIGINT NOT NULL,
    updated_by  TEXT,
    updated_at  BIGINT NOT NULL,
    deleted_at  BIGINT
);

CREATE INDEX dashboards_org_title ON dashboards (org_id, title, id);
CREATE INDEX dashboards_folder ON dashboards (folder_id);

CREATE TABLE dashboard_versions (
    dashboard_id  TEXT NOT NULL REFERENCES dashboards (id) ON DELETE CASCADE,
    version       BIGINT NOT NULL,
    model         TEXT NOT NULL,
    message       TEXT NOT NULL,
    author_id     TEXT,
    -- Set when this version brings back an older one (its number).
    restored_from BIGINT,
    created_at    BIGINT NOT NULL,
    PRIMARY KEY (dashboard_id, version)
);
