-- What a viewer keeps of their own exploration of a graph panel: the node ids they pinned and
-- the ones they selected, per user, dashboard and panel. Only ids are stored, never a node's
-- properties or any other part of a result. Rows go with their user, organization and dashboard;
-- whether the user may still read the dashboard is decided when a row is read or written.

CREATE TABLE panel_view_state (
    user_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    org_id       TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
    dashboard_id TEXT NOT NULL REFERENCES dashboards (id) ON DELETE CASCADE,
    panel_id     TEXT NOT NULL,
    state        TEXT NOT NULL,
    updated_at   BIGINT NOT NULL,
    PRIMARY KEY (user_id, dashboard_id, panel_id)
);
