-- Provisioning as code (docs/guide/provisioning.md): dashboards, data sources, custom roles and
-- alert rules applied from files through `kalzit provision`. One row per resource a provisioning
-- set manages, named by its `uid` in the files. A set belongs to one organization and owns its
-- resources: a resource has at most one row, so two sets never manage the same one. While the row
-- exists and is not unlocked, the API refuses normal edits of the resource. The row goes with its
-- organization; a resource deleted some other way leaves its row behind, and the next apply makes
-- the resource again.
CREATE TABLE provisioned_resources (
    org_id         TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
    -- The provisioning set (`kalzit provision ... --set`, or `set` in org.yaml).
    set_name       TEXT NOT NULL,
    -- `dashboard`, `datasource`, `role` or `alert_rule`.
    kind           TEXT NOT NULL,
    uid            TEXT NOT NULL,
    resource_id    TEXT NOT NULL,
    -- The file it came from, relative to the set's folder, with `/` between folders.
    source_path    TEXT NOT NULL,
    -- SHA-256 of the file's bytes, as hex.
    checksum       TEXT NOT NULL,
    -- SHA-256 of the resource as applied, in the form an export writes it; a different hash of
    -- the stored resource later means it drifted.
    state_hash     TEXT NOT NULL,
    -- Data sources: an HMAC (with the server's signing key) over the secret references and the
    -- values sent for them, so a changed value is seen without decrypting anything. Empty for the
    -- other kinds.
    secret_digest  TEXT NOT NULL,
    -- Data sources: the secret references as the file gave them (JSON, variable names only, never
    -- a value), so an export writes them back. `{}` for the other kinds.
    secret_refs    TEXT NOT NULL,
    applied_at     BIGINT NOT NULL,
    -- The person or service account that applied it.
    applied_by     TEXT,
    -- An org admin unlocked the resource for edits in an emergency; the next apply of its set
    -- overwrites it and locks it again.
    unlocked_at    BIGINT,
    unlocked_by    TEXT,
    PRIMARY KEY (org_id, kind, uid)
);

CREATE UNIQUE INDEX provisioned_resources_resource ON provisioned_resources (kind, resource_id);
CREATE INDEX provisioned_resources_set ON provisioned_resources (org_id, set_name);

-- What a Grafana import converted, approximated and skipped, kept with the dashboard it made
-- (docs/guide/grafana-import.md). Goes with the dashboard.
CREATE TABLE dashboard_import_reports (
    dashboard_id    TEXT PRIMARY KEY REFERENCES dashboards (id) ON DELETE CASCADE,
    org_id          TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
    -- `grafana`.
    source          TEXT NOT NULL,
    -- The `schemaVersion` of the imported JSON.
    source_version  BIGINT,
    -- JSON: the report's items and counts.
    report          TEXT NOT NULL,
    created_by      TEXT,
    created_at      BIGINT NOT NULL
);
