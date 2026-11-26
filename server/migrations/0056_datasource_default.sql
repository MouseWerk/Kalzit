-- The default data source of an organization: Explore and new panels start with it when nothing
-- else is chosen (docs/api/datasources.md, "Default data source"). At most one live source per
-- organization carries it; moving a source to the trash takes it away.

ALTER TABLE datasources ADD COLUMN is_default BIGINT NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX datasources_org_default ON datasources (org_id) WHERE is_default = 1;

-- The `uid` of the Grafana dashboard an import made a dashboard from, so a Grafana address
-- (`/d/<uid>`) still opens it.
ALTER TABLE dashboard_import_reports ADD COLUMN source_uid TEXT;
CREATE INDEX dashboard_import_reports_uid ON dashboard_import_reports (org_id, source_uid);
