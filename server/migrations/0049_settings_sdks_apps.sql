-- Self-registration, scheduled backups and app plugins (docs/PLAN.md sections 7 and 8, M7).
-- Times are Unix milliseconds.

-- Self-registrations (docs/api/mail.md, "Self-registration"). `status` is `unconfirmed` (the
-- link went out), `pending` (confirmed, an admin approves), `confirmed` (passing on to the
-- account), `approved` (the account exists, `user_id`) or `rejected`. `email_key` is the address
-- in its compared form (`routes::email_key`). Name and password hash are empty until the link is
-- confirmed; only the SHA-256 of the link's token is kept, and the password hash is cleared once
-- the account exists or the registration is rejected. Decided and expired rows are deleted after
-- 30 days.
CREATE TABLE registrations (
    id              TEXT PRIMARY KEY,
    email           TEXT NOT NULL,
    email_key       TEXT NOT NULL,
    name            TEXT NOT NULL,
    password_hash   TEXT NOT NULL,
    language        TEXT,
    token_hash      TEXT NOT NULL UNIQUE,
    status          TEXT NOT NULL,
    org_id          TEXT,
    role            TEXT,
    user_id         TEXT,
    client_address  TEXT NOT NULL,
    created_at      BIGINT NOT NULL,
    expires_at      BIGINT NOT NULL,
    confirmed_at    BIGINT,
    decided_at      BIGINT,
    decided_by      TEXT
);

CREATE INDEX registrations_list ON registrations (created_at, id);
CREATE INDEX registrations_email ON registrations (email_key, status);

-- The history of backups to the backup target (docs/api/backups.md): `kind` is `scheduled` or
-- `manual`, `status` `running`, `succeeded` or `failed` (with a `backup.*` reason). Kept a year.
CREATE TABLE backup_runs (
    id             TEXT PRIMARY KEY,
    kind           TEXT NOT NULL,
    target_kind    TEXT NOT NULL,
    status         TEXT NOT NULL,
    file_name      TEXT,
    size_bytes     BIGINT,
    deleted_count  BIGINT NOT NULL DEFAULT 0,
    reason         TEXT,
    detail         TEXT,
    started_by     TEXT,
    started_at     BIGINT NOT NULL,
    finished_at    BIGINT
);

CREATE INDEX backup_runs_started ON backup_runs (started_at, id);
CREATE INDEX backup_runs_kind ON backup_runs (kind, started_at);

-- App plugins (docs/api/plugins.md, "App plugins"): the least role an organization lets use an
-- app (`viewer`, `editor`, `admin`, `owner`; no row: `viewer`), and each app's own storage per
-- organization, JSON values by key, at most 50 MiB per app and organization (`size_bytes` counts
-- key and value). Blocking an app is the plugin block every plugin has (`plugin_org_blocks`).
CREATE TABLE app_org_settings (
    org_id      TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
    plugin_id   TEXT NOT NULL,
    min_role    TEXT NOT NULL,
    updated_by  TEXT,
    updated_at  BIGINT NOT NULL,
    PRIMARY KEY (org_id, plugin_id)
);

CREATE TABLE app_storage (
    org_id      TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
    plugin_id   TEXT NOT NULL,
    key         TEXT NOT NULL,
    value       TEXT NOT NULL,
    size_bytes  BIGINT NOT NULL,
    updated_by  TEXT,
    updated_at  BIGINT NOT NULL,
    PRIMARY KEY (org_id, plugin_id, key)
);