-- Indexes for lookups by a column that is not the start of a primary key or another index.
--
-- Purging a dashboard deletes its stars, recent views, pins and the viewers' panel state (also
-- through the foreign keys' ON DELETE CASCADE, which looks the rows up by `dashboard_id`), and
-- discards the panel state when panels change; without these, each of those scans the table.
-- Purging a data source deletes its Explore history the same way. The audit log filtered by one
-- person reads that person's events of one organization newest first.

CREATE INDEX dashboard_stars_dashboard ON dashboard_stars (dashboard_id);
CREATE INDEX dashboard_views_dashboard ON dashboard_views (dashboard_id);
CREATE INDEX dashboard_pins_dashboard ON dashboard_pins (dashboard_id);
CREATE INDEX panel_view_state_dashboard ON panel_view_state (dashboard_id);
CREATE INDEX explore_history_datasource ON explore_history (datasource_id);
CREATE INDEX audit_events_org_actor ON audit_events (org_id, actor_user_id, created_at, id);
