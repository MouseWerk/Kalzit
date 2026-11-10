-- Alerting (docs/PLAN.md section 13, docs/api/alerting.md). Rules, their instances, contact
-- points, silences and history belong to one organization each and go with it. Times are Unix
-- milliseconds, durations seconds, flags 0 or 1.

-- A rule: its own copy of a query (the source's query, the visible steps and fixed variable
-- values as JSON in the source's language), a relative range, a shape-specific reduce step and a
-- condition (JSON, `alerting::rule`), and how it is evaluated. The link to a panel it was made
-- from is kept for the badge; it goes when the dashboard is purged.
CREATE TABLE alert_rules (
    id                   TEXT PRIMARY KEY,
    org_id               TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
    name                 TEXT NOT NULL,
    description          TEXT NOT NULL,
    runbook_url          TEXT,
    datasource_id        TEXT NOT NULL REFERENCES datasources (id) ON DELETE CASCADE,
    query                TEXT NOT NULL,
    range_secs           BIGINT NOT NULL,
    reduce               TEXT NOT NULL,
    condition            TEXT NOT NULL,
    interval_secs        BIGINT NOT NULL,
    for_secs             BIGINT NOT NULL,
    -- `no_data`, `ok` or `firing`.
    no_data_state        TEXT NOT NULL,
    -- `error` or `keep` (hold the last state).
    error_state          TEXT NOT NULL,
    -- JSON object of label names to values.
    labels               TEXT NOT NULL,
    -- 0: no reminder while firing.
    reminder_secs        BIGINT NOT NULL,
    paused               BIGINT NOT NULL DEFAULT 0,
    dashboard_id         TEXT REFERENCES dashboards (id) ON DELETE SET NULL,
    panel_id             TEXT,
    version              BIGINT NOT NULL,
    created_by           TEXT,
    created_at           BIGINT NOT NULL,
    updated_by           TEXT,
    updated_at           BIGINT NOT NULL,
    -- What the scheduler last saw (written by the evaluation, not by the API).
    last_evaluated_at    BIGINT,
    last_duration_ms     BIGINT,
    last_error           TEXT,
    skipped_evaluations  BIGINT NOT NULL DEFAULT 0
);

CREATE INDEX alert_rules_org ON alert_rules (org_id, id);
CREATE INDEX alert_rules_datasource ON alert_rules (datasource_id);
CREATE INDEX alert_rules_dashboard ON alert_rules (dashboard_id);

-- Where to send: `mail` (recipients and language) or `webhook` (URL and language), as JSON in
-- `settings`. A webhook's signing secret lives in `alert_contact_point_secrets`; after a rotation
-- the previous one stays valid until `previous_secret_until`.
CREATE TABLE alert_contact_points (
    id                     TEXT PRIMARY KEY,
    org_id                 TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
    name                   TEXT NOT NULL,
    kind                   TEXT NOT NULL,
    settings               TEXT NOT NULL,
    previous_secret_until  BIGINT,
    -- The last delivery: when, whether it arrived, and why not (status or error, no content).
    last_delivery_at       BIGINT,
    last_delivery_ok       BIGINT,
    last_delivery_error    TEXT,
    version                BIGINT NOT NULL,
    created_by             TEXT,
    created_at             BIGINT NOT NULL,
    updated_by             TEXT,
    updated_at             BIGINT NOT NULL,
    UNIQUE (org_id, name)
);

-- The webhook secrets (`current`, and `previous` during the 24 hours after a rotation), encrypted
-- like data source secrets with `alert-contact-point:<id>` and the field as associated data;
-- `kalzit secrets rotate` re-encrypts these rows too.
CREATE TABLE alert_contact_point_secrets (
    contact_point_id  TEXT NOT NULL REFERENCES alert_contact_points (id) ON DELETE CASCADE,
    field             TEXT NOT NULL,
    key_id            TEXT NOT NULL,
    nonce             TEXT NOT NULL,
    ciphertext        TEXT NOT NULL,
    PRIMARY KEY (contact_point_id, field)
);

-- Rule to contact point (n:m). A contact point in use cannot be deleted (the API refuses).
CREATE TABLE alert_rule_contact_points (
    rule_id           TEXT NOT NULL REFERENCES alert_rules (id) ON DELETE CASCADE,
    contact_point_id  TEXT NOT NULL REFERENCES alert_contact_points (id) ON DELETE CASCADE,
    PRIMARY KEY (rule_id, contact_point_id)
);

CREATE INDEX alert_rule_contact_points_cp ON alert_rule_contact_points (contact_point_id);

-- One row per instance of a rule: the fingerprint is the SHA-256 of the rule id and the sorted
-- labels. State is `ok`, `pending`, `firing`, `no_data` or `error`. Paused rules have none.
CREATE TABLE alert_instances (
    rule_id             TEXT NOT NULL REFERENCES alert_rules (id) ON DELETE CASCADE,
    fingerprint         TEXT NOT NULL,
    org_id              TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
    labels              TEXT NOT NULL,
    state               TEXT NOT NULL,
    state_since         BIGINT NOT NULL,
    pending_since       BIGINT,
    last_evaluated_at   BIGINT,
    last_value          DOUBLE PRECISION,
    last_error          TEXT,
    -- Evaluations in a row in which the series was missing; at 3 the instance ends.
    missing_count       BIGINT NOT NULL DEFAULT 0,
    last_notified_at    BIGINT,
    last_notified_state TEXT,
    PRIMARY KEY (rule_id, fingerprint)
);

CREATE INDEX alert_instances_org ON alert_instances (org_id, state);

-- Silences: label matchers (JSON list of `{label, op, value}`, all must match), a time window
-- and a required comment. Ending one early sets `ended_at` and `ended_by`.
CREATE TABLE alert_silences (
    id          TEXT PRIMARY KEY,
    org_id      TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
    matchers    TEXT NOT NULL,
    starts_at   BIGINT NOT NULL,
    ends_at     BIGINT NOT NULL,
    comment     TEXT NOT NULL,
    created_by  TEXT,
    created_at  BIGINT NOT NULL,
    ended_by    TEXT,
    ended_at    BIGINT
);

CREATE INDEX alert_silences_org ON alert_silences (org_id, ends_at);

-- State changes (`kind = 'transition'`) and deliveries (`kind = 'delivery'`) per instance. Kept
-- after the rule is deleted (rule name copied), until `alerting.history_retention_days`.
CREATE TABLE alert_history (
    id                TEXT PRIMARY KEY,
    org_id            TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
    rule_id           TEXT NOT NULL,
    rule_name         TEXT NOT NULL,
    fingerprint       TEXT NOT NULL,
    labels            TEXT NOT NULL,
    kind              TEXT NOT NULL,
    from_state        TEXT,
    to_state          TEXT,
    value             DOUBLE PRECISION,
    error             TEXT,
    silence_id        TEXT,
    contact_point_id  TEXT,
    -- Deliveries: the event (`firing`, `resolved`, `no_data`, `error`, `reminder`, `test`), the
    -- attempt (1 to 3) and its result (`ok` or the failure, never the content).
    event             TEXT,
    attempt           BIGINT,
    result            TEXT,
    at                BIGINT NOT NULL
);

CREATE INDEX alert_history_org_at ON alert_history (org_id, at, id);
CREATE INDEX alert_history_rule_at ON alert_history (rule_id, at);

-- The per-source opt-in (off by default) and an optional lower number of evaluations that may
-- query the source at once (NULL: the server's `alerting.max_concurrent_per_datasource`).
ALTER TABLE datasources ADD COLUMN alerting_enabled BIGINT NOT NULL DEFAULT 0;
ALTER TABLE datasources ADD COLUMN alerting_max_concurrent BIGINT;

-- The kind of a service account: `standard` (made by people, with a role and tokens) or
-- `alerting`, the organization's fixed alerting identity: no membership and so no role, no
-- tokens, no sign-in, not deletable; its only right is `datasources:query` on sources with
-- `alerting_enabled` (`alerting::service_account`).
ALTER TABLE service_accounts ADD COLUMN kind TEXT NOT NULL DEFAULT 'standard';
CREATE INDEX service_accounts_kind ON service_accounts (org_id, kind);
