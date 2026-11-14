-- Reports (docs/guide/reports.md): a dashboard (all or chosen panels) with a time range and fixed
-- variable values, rendered as PDF and/or CSV on a schedule and sent by mail. Reports and their
-- runs belong to one organization each and go with it, and with their dashboard when it is
-- purged. Times are Unix milliseconds, flags 0 or 1.

-- A report. `panel_ids`, `variables`, `schedule`, `formats` and `recipients` are JSON
-- (`reports::model`). A report runs with the current rights of the person who created it; while a
-- right is missing it is suspended (`suspended_reason`) and resumes at the first scheduled time the
-- right is back. A failure mails the creator at most once a day (`failure_mailed_at`).
CREATE TABLE reports (
    id            TEXT PRIMARY KEY,
    org_id        TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
    name          TEXT NOT NULL,
    description   TEXT NOT NULL,
    dashboard_id  TEXT NOT NULL REFERENCES dashboards (id) ON DELETE CASCADE,
    -- JSON array of panel ids; NULL for every panel of the dashboard.
    panel_ids     TEXT,
    -- NULL for the dashboard's own range.
    time_from     TEXT,
    time_to       TEXT,
    variables     TEXT NOT NULL,
    schedule      TEXT NOT NULL,
    time_zone     TEXT NOT NULL,
    formats       TEXT NOT NULL,
    language      TEXT NOT NULL,
    recipients    TEXT NOT NULL,
    paused        BIGINT NOT NULL DEFAULT 0,
    -- The next scheduled run; NULL while paused.
    next_run_at   BIGINT,
    owner_id      TEXT NOT NULL,
    suspended_reason  TEXT,
    suspended_at      BIGINT,
    failure_mailed_at BIGINT,
    version       BIGINT NOT NULL,
    created_by    TEXT,
    created_at    BIGINT NOT NULL,
    updated_by    TEXT,
    updated_at    BIGINT NOT NULL
);

CREATE INDEX reports_org ON reports (org_id, id);
CREATE INDEX reports_due ON reports (next_run_at);
CREATE INDEX reports_dashboard ON reports (dashboard_id);

-- One run: queued by the schedule or by "send now", claimed by the worker on the leading server
-- with a lease, then finished with its result. A failed first attempt is queued once more after
-- five minutes (`attempt` 2, `not_before`). `sent_to` keeps the addresses reached while the run is
-- open, so a retry does not mail them twice, and is emptied when it ends. The error is a stable
-- code and an English message; never data from the report. Attachments are not kept.
CREATE TABLE report_runs (
    id                   TEXT PRIMARY KEY,
    org_id               TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
    report_id            TEXT NOT NULL REFERENCES reports (id) ON DELETE CASCADE,
    -- `schedule` or `manual`.
    trigger_kind         TEXT NOT NULL,
    triggered_by         TEXT,
    -- The scheduled time of a scheduled run.
    scheduled_for        BIGINT,
    -- `queued`, `running`, `ok`, `partial` (some recipients left out), `failed`, `suspended` or
    -- `skipped`.
    status               TEXT NOT NULL,
    attempt              BIGINT NOT NULL DEFAULT 1,
    not_before           BIGINT NOT NULL,
    sent_to              TEXT,
    created_at           BIGINT NOT NULL,
    started_at           BIGINT,
    finished_at          BIGINT,
    lease_until          BIGINT,
    error_code           TEXT,
    error_message        TEXT,
    recipients           BIGINT NOT NULL DEFAULT 0,
    sent                 BIGINT NOT NULL DEFAULT 0,
    skipped_recipients   BIGINT NOT NULL DEFAULT 0,
    attachment_bytes     BIGINT,
    pages                BIGINT
);

CREATE INDEX report_runs_report ON report_runs (report_id, created_at);
CREATE INDEX report_runs_org ON report_runs (org_id, created_at);
CREATE INDEX report_runs_status ON report_runs (status, created_at);

-- Addresses outside the organization that unsubscribed from a report (one click in the mail),
-- as `audit::email_hash`; runs leave them out.
CREATE TABLE report_unsubscribes (
    report_id   TEXT NOT NULL REFERENCES reports (id) ON DELETE CASCADE,
    email_hash  TEXT NOT NULL,
    created_at  BIGINT NOT NULL,
    PRIMARY KEY (report_id, email_hash)
);
