-- LDAP and Active Directory (docs/api/sso.md, "LDAP and Active Directory"): providers of the kind
-- `ldap` live in `sso_providers` (their settings in `config`, the bind password in
-- `sso_provider_secrets`); these tables hold the runs of the directory sync and the accounts it
-- disabled.

-- One run of the sync of a provider. `status`: running, done, halted (it would have disabled more
-- than `threshold` percent of `accounts` and changed nothing), failed (nothing changed) or applied
-- (a halted run an admin applied anyway, through the run named `applied_run`). `pending` is the
-- JSON list a halted run would disable: [{"userId", "reason"}].
CREATE TABLE ldap_sync_runs (
    id                TEXT PRIMARY KEY,
    provider_id       TEXT NOT NULL REFERENCES sso_providers (id) ON DELETE CASCADE,
    trigger_kind      TEXT NOT NULL,
    status            TEXT NOT NULL,
    started_at        BIGINT NOT NULL,
    finished_at       BIGINT,
    checked           BIGINT NOT NULL DEFAULT 0,
    changed           BIGINT NOT NULL DEFAULT 0,
    deactivated       BIGINT NOT NULL DEFAULT 0,
    reactivated       BIGINT NOT NULL DEFAULT 0,
    skipped           BIGINT NOT NULL DEFAULT 0,
    would_deactivate  BIGINT NOT NULL DEFAULT 0,
    accounts          BIGINT NOT NULL DEFAULT 0,
    threshold         BIGINT NOT NULL,
    error             TEXT,
    pending           TEXT,
    applied_by        TEXT,
    applied_at        BIGINT,
    applied_run       TEXT
);

CREATE INDEX ldap_sync_runs_provider ON ldap_sync_runs (provider_id, started_at);

-- At most one running sync per provider, across every server that shares the database.
CREATE UNIQUE INDEX ldap_sync_runs_one_running ON ldap_sync_runs (provider_id) WHERE status = 'running';

-- An account the sync disabled, and why (`not_in_directory`, `disabled_in_directory`,
-- `no_mapped_group`). Only these accounts are enabled again by the sync or a directory sign-in;
-- an account an admin disabled stays disabled. The row goes when the account is enabled.
CREATE TABLE ldap_deactivations (
    user_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    provider_id  TEXT NOT NULL REFERENCES sso_providers (id) ON DELETE CASCADE,
    run_id       TEXT NOT NULL,
    reason       TEXT NOT NULL,
    login        TEXT,
    at           BIGINT NOT NULL,
    PRIMARY KEY (user_id, provider_id)
);
