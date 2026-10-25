-- Dashboards a user pinned to the sidebar, per organization, in the order the user put them.
-- Pins go with their dashboard when it is purged, and with the user or organization. As with
-- stars, what the user may still read is decided when the rows are read.

CREATE TABLE dashboard_pins (
    user_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    org_id       TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
    dashboard_id TEXT NOT NULL REFERENCES dashboards (id) ON DELETE CASCADE,
    position     BIGINT NOT NULL,
    created_at   BIGINT NOT NULL,
    PRIMARY KEY (user_id, dashboard_id)
);

CREATE INDEX dashboard_pins_user_org ON dashboard_pins (user_id, org_id, position);