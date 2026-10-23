-- Per-user conveniences: starred dashboards, recently viewed dashboards and personal preferences.
-- Stars and views go with their dashboard when it is purged, and with the user or organization.
-- What a user may see is decided when the rows are read, so a revoked grant hides them at once.

CREATE TABLE dashboard_stars (
    user_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    org_id       TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
    dashboard_id TEXT NOT NULL REFERENCES dashboards (id) ON DELETE CASCADE,
    created_at   BIGINT NOT NULL,
    PRIMARY KEY (user_id, dashboard_id)
);

CREATE INDEX dashboard_stars_user_org ON dashboard_stars (user_id, org_id);

-- One row per user and dashboard with the last time it was opened; the server keeps the newest
-- few per user and organization.
CREATE TABLE dashboard_views (
    user_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    org_id       TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
    dashboard_id TEXT NOT NULL REFERENCES dashboards (id) ON DELETE CASCADE,
    viewed_at    BIGINT NOT NULL,
    PRIMARY KEY (user_id, dashboard_id)
);

CREATE INDEX dashboard_views_user_org ON dashboard_views (user_id, org_id, viewed_at);

-- A column left NULL follows the server default (`appearance.*`) or the browser. The start
-- dashboard has no foreign key: a purged one reads as unset.
CREATE TABLE user_preferences (
    user_id            TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
    language           TEXT,
    theme              TEXT,
    time_zone          TEXT,
    week_start         TEXT,
    start_org_id       TEXT,
    start_dashboard_id TEXT,
    updated_at         BIGINT NOT NULL
);
