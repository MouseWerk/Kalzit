-- Several Kalzit servers on one PostgreSQL database (docs/ARCHITECTURE.md, "Several servers on
-- one database"; docs/operations/high-availability.md). Times are milliseconds of the database's
-- clock, so the servers' own clocks never decide who leads or when a job is due. SQLite has the
-- same tables with one server in them.

-- One row per server process that started on this database: `id` is new at every start, `host`
-- the machine's name, `address` the listeners it serves. A server writes `heartbeat_at` every few
-- seconds and `stopped_at` when it stops cleanly; rows of servers stopped or silent for a day go.
CREATE TABLE cluster_instances (
    id            TEXT PRIMARY KEY,
    host          TEXT NOT NULL,
    version       TEXT NOT NULL,
    address       TEXT NOT NULL,
    started_at    BIGINT NOT NULL,
    heartbeat_at  BIGINT NOT NULL,
    stopped_at    BIGINT
);

-- The leader: the one server that runs the jobs that must run once (retention cleanups, the
-- plugin catalog refresh, certificate orders, update checks). A lease, not a lock held by a
-- connection: the holder renews `expires_at`; another server takes over once it has passed.
-- `term` counts takeovers, `since` is when the current holder took over.
CREATE TABLE cluster_leader (
    id          TEXT PRIMARY KEY,
    holder      TEXT,
    term        BIGINT NOT NULL,
    expires_at  BIGINT NOT NULL,
    since       BIGINT
);

INSERT INTO cluster_leader (id, holder, term, expires_at, since) VALUES ('leader', NULL, 0, 0, NULL);

-- Jobs that run once per interval across all servers: a server claims a run (`holder`,
-- `lease_until`) only when the last finished one (`last_done_at`) is an interval old, so a
-- leader change in the middle of an interval never runs it twice.
CREATE TABLE cluster_jobs (
    name          TEXT PRIMARY KEY,
    holder        TEXT,
    lease_until   BIGINT NOT NULL,
    last_done_at  BIGINT NOT NULL
);

-- Changes the other servers must apply to what they keep in memory (settings, query cache
-- generations, data source connections, plugins, certificates). Read by every server after a
-- NOTIFY and by a periodic poll; kept for an hour. `scope` is an organization or data source id,
-- or empty.
CREATE TABLE cluster_events (
    id          TEXT PRIMARY KEY,
    origin      TEXT NOT NULL,
    kind        TEXT NOT NULL,
    scope       TEXT NOT NULL,
    created_at  BIGINT NOT NULL
);

CREATE INDEX cluster_events_created ON cluster_events (created_at);

-- The ACME account and certificate files (`acme::store`), shared through the database so every
-- server serves the certificate the leader ordered. `envelope` is the file's content as it is on
-- disk: AES-256-GCM encrypted with the secrets key, which all servers share.
CREATE TABLE acme_shared (
    name        TEXT PRIMARY KEY,
    envelope    TEXT NOT NULL,
    updated_at  BIGINT NOT NULL
);

-- Challenge answers of a running order, so the server the certificate authority reaches answers
-- it: `kind` is `http` (`name` the token, `value` the key authorization) or `alpn` (`name` the
-- domain, `value` the digest in hex).
CREATE TABLE acme_challenges (
    kind        TEXT NOT NULL,
    name        TEXT NOT NULL,
    value       TEXT NOT NULL,
    created_at  BIGINT NOT NULL,
    PRIMARY KEY (kind, name)
);

-- Plugin packages as uploaded (base64), so a server that has not unpacked one yet can: the row's
-- manifest in `plugins` is the checked one, and the unpacked package must match it. `dir` is the
-- package directory name in `plugins` (`dir` or `pending_dir`).
CREATE TABLE plugin_packages (
    dir         TEXT PRIMARY KEY,
    archive     TEXT NOT NULL,
    sha256      TEXT NOT NULL,
    created_at  BIGINT NOT NULL
);
