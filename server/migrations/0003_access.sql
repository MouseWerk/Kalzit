-- Teams, custom roles and resource grants (docs/ARCHITECTURE.md, "Authorization").
--
-- A role is named by a key: a built-in name (`owner`, `admin`, `editor`, `viewer`) or the id of a
-- custom role of the same organization. `org_members.role` and `team_roles.role` hold such keys,
-- so they carry no foreign key; deleting a custom role cleans up its keys in the same transaction.

CREATE TABLE teams (
    id          TEXT PRIMARY KEY,
    org_id      TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    -- The name in lowercase (Unicode-aware, computed by the server), so names that differ only in
    -- case cannot both exist; SQLite's own lower() folds ASCII only.
    name_key    TEXT NOT NULL,
    created_at  BIGINT NOT NULL,
    UNIQUE (org_id, name_key)
);

-- `role` is `member` or `maintainer`; maintainers may manage the members of their team.
CREATE TABLE team_members (
    team_id     TEXT NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
    user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    role        TEXT NOT NULL,
    created_at  BIGINT NOT NULL,
    PRIMARY KEY (team_id, user_id)
);

CREATE INDEX team_members_user ON team_members (user_id);

CREATE TABLE roles (
    id           TEXT PRIMARY KEY,
    org_id       TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    name_key     TEXT NOT NULL,
    description  TEXT NOT NULL,
    created_at   BIGINT NOT NULL,
    UNIQUE (org_id, name_key)
);

-- `permission` is the catalog name (`dashboards:read`); names the server no longer knows grant
-- nothing.
CREATE TABLE role_permissions (
    role_id     TEXT NOT NULL REFERENCES roles (id) ON DELETE CASCADE,
    permission  TEXT NOT NULL,
    PRIMARY KEY (role_id, permission)
);

CREATE TABLE team_roles (
    team_id  TEXT NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
    role     TEXT NOT NULL,
    PRIMARY KEY (team_id, role)
);

-- Subjects (user, team, role) and resources (folder, dashboard, datasource) point at several
-- tables each, so there are no foreign keys on them: removing a subject or purging a resource
-- deletes its grants in the same transaction.
CREATE TABLE resource_grants (
    id             TEXT PRIMARY KEY,
    org_id         TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
    subject_type   TEXT NOT NULL,
    subject_id     TEXT NOT NULL,
    resource_type  TEXT NOT NULL,
    resource_id    TEXT NOT NULL,
    level          TEXT NOT NULL,
    created_by     TEXT,
    created_at     BIGINT NOT NULL,
    UNIQUE (org_id, resource_type, resource_id, subject_type, subject_id)
);

CREATE INDEX resource_grants_subject ON resource_grants (org_id, subject_type, subject_id);

-- Sessions get an opaque id for "show and end my sessions"; the token hash stays internal.
-- Sessions from before this migration have no id and are ended: their users sign in once more.
DELETE FROM sessions;
ALTER TABLE sessions ADD COLUMN id TEXT NOT NULL DEFAULT '';
CREATE UNIQUE INDEX sessions_id ON sessions (id);
