-- Sharing 0.7.4 (docs/PLAN.md, M7; docs/api/sharing.md): public links to a dashboard and
-- snapshots of its panel results. Both belong to one organization and one dashboard and go with
-- them. Tokens are kept only as their SHA-256 (`token_hash`). Times are Unix milliseconds, flags 0
-- or 1. Nothing about visitors is stored: `views` is a plain count. Revoking is final
-- (`revoked_at`); revoked and expired rows are deleted 30 days later (`sharing::spawn_cleanup`).

-- A public live link: whoever has its token sees the dashboard and runs its stored panel queries
-- with the rights its creator holds at that moment. `time_from`/`time_to` are the range the page
-- opens with (relative or ISO texts, as in the dashboard model), `max_window_ms` how far back a
-- visitor may look (`now - max_window_ms` to now), `variables` the fixed values (JSON object). The
-- creator going (user deleted) leaves `created_by` NULL, and the link stays suspended.
CREATE TABLE public_links (
    id              TEXT PRIMARY KEY,
    org_id          TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
    dashboard_id    TEXT NOT NULL REFERENCES dashboards (id) ON DELETE CASCADE,
    token_hash      TEXT NOT NULL UNIQUE,
    created_by      TEXT REFERENCES users (id) ON DELETE SET NULL,
    created_at      BIGINT NOT NULL,
    expires_at      BIGINT NOT NULL,
    max_window_ms   BIGINT NOT NULL,
    time_from       TEXT NOT NULL,
    time_to         TEXT NOT NULL,
    variables       TEXT NOT NULL,
    revoked_at      BIGINT,
    revoked_by      TEXT,
    views           BIGINT NOT NULL DEFAULT 0,
    last_viewed_at  BIGINT
);

CREATE INDEX public_links_org ON public_links (org_id, created_at, id);
CREATE INDEX public_links_dashboard ON public_links (dashboard_id);
CREATE INDEX public_links_creator ON public_links (created_by);
CREATE INDEX public_links_expires ON public_links (expires_at);
CREATE INDEX public_links_revoked ON public_links (revoked_at);

-- A snapshot: the panel results of a dashboard frozen when it was made, in their native shapes
-- (`results`: a JSON object of panel ids to query answers), with the dashboard as visitors see
-- it (`model`, sanitized) and the absolute range they were run for. `datasource_ids` (JSON list)
-- are the sources the results came from, so a public snapshot stops when its creator may no
-- longer query them. `size_bytes` is the stored size of `model` and `results` together. A public
-- snapshot has a `token_hash`; an internal one has none and is seen by members who may read the
-- dashboard.
CREATE TABLE snapshots (
    id              TEXT PRIMARY KEY,
    org_id          TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
    dashboard_id    TEXT NOT NULL REFERENCES dashboards (id) ON DELETE CASCADE,
    title           TEXT NOT NULL,
    public          BIGINT NOT NULL DEFAULT 0,
    token_hash      TEXT UNIQUE,
    created_by      TEXT REFERENCES users (id) ON DELETE SET NULL,
    created_at      BIGINT NOT NULL,
    expires_at      BIGINT NOT NULL,
    range_from      BIGINT NOT NULL,
    range_to        BIGINT NOT NULL,
    model           TEXT NOT NULL,
    results         TEXT NOT NULL,
    datasource_ids  TEXT NOT NULL,
    size_bytes      BIGINT NOT NULL,
    revoked_at      BIGINT,
    revoked_by      TEXT,
    views           BIGINT NOT NULL DEFAULT 0,
    last_viewed_at  BIGINT
);

CREATE INDEX snapshots_org ON snapshots (org_id, created_at, id);
CREATE INDEX snapshots_dashboard ON snapshots (dashboard_id, created_at, id);
CREATE INDEX snapshots_creator ON snapshots (created_by);
CREATE INDEX snapshots_expires ON snapshots (expires_at);
CREATE INDEX snapshots_revoked ON snapshots (revoked_at);
