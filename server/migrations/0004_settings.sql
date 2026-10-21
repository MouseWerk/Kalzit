-- Settings changed in the UI. The effective value of a server setting is environment > file >
-- this table > the default from `settings::REGISTRY`; organization settings are this table >
-- default. `value` is JSON text, `version` counts the saves (a setting never saved is version 0).

CREATE TABLE server_settings (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL,
    version     BIGINT NOT NULL,
    updated_by  TEXT,
    updated_at  BIGINT NOT NULL
);

CREATE TABLE org_settings (
    org_id      TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
    key         TEXT NOT NULL,
    value       TEXT NOT NULL,
    version     BIGINT NOT NULL,
    updated_by  TEXT,
    updated_at  BIGINT NOT NULL,
    PRIMARY KEY (org_id, key)
);
