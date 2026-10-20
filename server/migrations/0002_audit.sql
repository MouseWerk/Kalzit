-- Audit events: who changed what, when, from where. Written in the same transaction as the change
-- it describes. `summary` is short JSON without secrets or personal content beyond ids.

CREATE TABLE audit_events (
    id              TEXT PRIMARY KEY,
    org_id          TEXT,
    actor_user_id   TEXT,
    actor_address   TEXT,
    action          TEXT NOT NULL,
    resource_type   TEXT,
    resource_id     TEXT,
    summary         TEXT NOT NULL,
    created_at      BIGINT NOT NULL
);

CREATE INDEX audit_events_org_time ON audit_events (org_id, created_at);
CREATE INDEX audit_events_time ON audit_events (created_at);
