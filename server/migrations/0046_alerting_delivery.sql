-- The delivery of alert notifications (docs/PLAN.md section 13, "Benachrichtigungen";
-- alerting::outbox). An evaluation stores its instances, transitions and the messages to send in
-- one transaction; a worker sends them after the commit, so a crash never loses a message and
-- never makes a second one.

-- One message per rule, evaluation and contact point, with every instance notification that has
-- not been recorded for that contact point before. `message` is the JSON snapshot that is sent
-- (rule, organization, instances with their reduced values, links): never rows, documents or
-- nodes of a result. Up to 3 attempts; `lease_until` keeps two senders off the same message,
-- `sent_to` the mail recipients already reached, so a retry does not mail them again.
CREATE TABLE alert_deliveries (
    id                TEXT PRIMARY KEY,
    org_id            TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
    rule_id           TEXT NOT NULL,
    contact_point_id  TEXT NOT NULL REFERENCES alert_contact_points (id) ON DELETE CASCADE,
    -- `firing`, `resolved`, `no_data`, `error` or `reminder`: the most important event of it.
    event             TEXT NOT NULL,
    message           TEXT NOT NULL,
    attempts          BIGINT NOT NULL DEFAULT 0,
    next_attempt_at   BIGINT NOT NULL,
    lease_until       BIGINT,
    sent_to           TEXT,
    done_at           BIGINT,
    -- `ok`, or why the last attempt failed (`503`, `timeout`), never content.
    result            TEXT,
    created_at        BIGINT NOT NULL
);

CREATE INDEX alert_deliveries_due ON alert_deliveries (done_at, next_attempt_at);

-- The deduplication keys of every notification recorded for a contact point (fingerprint,
-- contact point, state, start of the state, reminder number; `eval::Notification::dedup_key`).
-- A key that is here is never delivered again, after a restart or a change of the leader too.
CREATE TABLE alert_delivery_keys (
    dedup_key    TEXT PRIMARY KEY,
    org_id       TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
    delivery_id  TEXT NOT NULL,
    created_at   BIGINT NOT NULL
);

CREATE INDEX alert_delivery_keys_org ON alert_delivery_keys (org_id, created_at);

-- A resolve still owed: an instance whose reported state was sent ended (its series gone) while a
-- silence held it back. It is sent once when no silence matches its labels any more.
CREATE TABLE alert_owed_resolves (
    rule_id      TEXT NOT NULL REFERENCES alert_rules (id) ON DELETE CASCADE,
    fingerprint  TEXT NOT NULL,
    org_id       TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
    labels       TEXT NOT NULL,
    -- The start of the reported state that ended.
    state_since  BIGINT NOT NULL,
    -- `series_gone` or `replaced`.
    reason       TEXT,
    created_at   BIGINT NOT NULL,
    PRIMARY KEY (rule_id, fingerprint)
);
