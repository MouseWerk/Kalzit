-- Data sources of an organization. `settings` is JSON without secrets; passwords, tokens and keys
-- live encrypted in `datasource_secrets` (server/src/secrets.rs). Deleting moves a data source to
-- the trash (`deleted_at`); its secrets stay until it is purged.

CREATE TABLE datasources (
    id          TEXT PRIMARY KEY,
    org_id      TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    kind        TEXT NOT NULL,
    settings    TEXT NOT NULL,
    created_at  BIGINT NOT NULL,
    updated_at  BIGINT NOT NULL,
    deleted_at  BIGINT
);

-- Names are unique among the data sources in use; a trashed one may share its name with a new one
-- (restoring it then answers `conflict`).
CREATE UNIQUE INDEX datasources_org_name ON datasources (org_id, name) WHERE deleted_at IS NULL;
CREATE INDEX datasources_org ON datasources (org_id, id);

-- One row per secret field. AES-256-GCM with the data source id and field name as associated
-- data, so a blob cannot be moved to another source or field; `key_id` names the key that
-- encrypted it (rotation re-encrypts every row). Nonce and ciphertext are base64.
CREATE TABLE datasource_secrets (
    datasource_id  TEXT NOT NULL REFERENCES datasources (id) ON DELETE CASCADE,
    field          TEXT NOT NULL,
    key_id         TEXT NOT NULL,
    nonce          TEXT NOT NULL,
    ciphertext     TEXT NOT NULL,
    PRIMARY KEY (datasource_id, field)
);
