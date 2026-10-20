-- Portable SQL for SQLite and PostgreSQL: text ids (UUIDv7), BIGINT unix milliseconds, BIGINT
-- flags (0/1). Released migrations are never edited; add the next number instead.

CREATE TABLE orgs (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    created_at  BIGINT NOT NULL
);

CREATE TABLE users (
    id              TEXT PRIMARY KEY,
    email           TEXT NOT NULL UNIQUE,
    name            TEXT NOT NULL,
    password_hash   TEXT,
    is_server_admin BIGINT NOT NULL DEFAULT 0,
    disabled        BIGINT NOT NULL DEFAULT 0,
    created_at      BIGINT NOT NULL
);

CREATE TABLE org_members (
    org_id      TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
    user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    role        TEXT NOT NULL,
    created_at  BIGINT NOT NULL,
    PRIMARY KEY (org_id, user_id)
);

CREATE INDEX org_members_user ON org_members (user_id);

-- Only the SHA-256 of a session token is stored; the token itself lives in the cookie.
CREATE TABLE sessions (
    token_hash    TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at    BIGINT NOT NULL,
    last_seen_at  BIGINT NOT NULL,
    expires_at    BIGINT NOT NULL
);

CREATE INDEX sessions_user ON sessions (user_id);
