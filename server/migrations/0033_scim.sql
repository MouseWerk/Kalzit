-- SCIM 2.0 provisioning (docs/api/scim.md): an organization's directory creates, changes and
-- deactivates its people and groups with the organization's SCIM token (`api_tokens`,
-- `kind = 'scim'`). Nothing is ever deleted through SCIM: a DELETE deactivates.

-- The organization's switch. Without a row SCIM is on (it still needs a token).
CREATE TABLE scim_orgs (
    org_id      TEXT PRIMARY KEY REFERENCES orgs (id) ON DELETE CASCADE,
    enabled     BIGINT NOT NULL DEFAULT 1,
    updated_at  BIGINT NOT NULL
);

-- A person of the organization's directory and the Kalzit account they are. The SCIM `id` is the
-- account's id; one account may be a SCIM user of several organizations, each with its own row.
-- `user_name_key` is `user_name` in lowercase (userName compares case-insensitively).
-- `attributes` keeps what the directory last sent of `name`, `displayName` and `emails` (JSON).
-- `created_account` 1: SCIM of this organization made the account, so it may change its name and
-- address and lock it. `locked_account` 1: deactivating locked the account itself (it was in no
-- other organization); reactivating unlocks only such an account.
CREATE TABLE scim_users (
    org_id           TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
    user_id          TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    user_name        TEXT NOT NULL,
    user_name_key    TEXT NOT NULL,
    external_id      TEXT,
    attributes       TEXT NOT NULL,
    active           BIGINT NOT NULL DEFAULT 1,
    created_account  BIGINT NOT NULL DEFAULT 0,
    locked_account   BIGINT NOT NULL DEFAULT 0,
    version          BIGINT NOT NULL DEFAULT 1,
    created_at       BIGINT NOT NULL,
    updated_at       BIGINT NOT NULL,
    PRIMARY KEY (org_id, user_id),
    UNIQUE (org_id, user_name_key)
);

CREATE INDEX scim_users_external ON scim_users (org_id, external_id);
CREATE INDEX scim_users_user ON scim_users (user_id);

-- A group of the directory. Its `display_name` (and `external_id`) are matched against the group
-- mapping (`sso_group_mappings` of this organization). A DELETE sets `deactivated_at`: the group
-- stops counting and disappears from SCIM, the row stays for the audit log.
CREATE TABLE scim_groups (
    id                TEXT PRIMARY KEY,
    org_id            TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
    display_name      TEXT NOT NULL,
    display_name_key  TEXT NOT NULL,
    external_id       TEXT,
    version           BIGINT NOT NULL DEFAULT 1,
    created_at        BIGINT NOT NULL,
    updated_at        BIGINT NOT NULL,
    deactivated_at    BIGINT
);

CREATE INDEX scim_groups_org ON scim_groups (org_id, display_name_key);

CREATE TABLE scim_group_members (
    group_id  TEXT NOT NULL REFERENCES scim_groups (id) ON DELETE CASCADE,
    user_id   TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    PRIMARY KEY (group_id, user_id)
);

CREATE INDEX scim_group_members_user ON scim_group_members (user_id);

-- What "IdP entscheidet" mappings gave a SCIM user in the organization (`team_id` empty for the
-- organization role), like `sso_managed` for a provider: these memberships follow the directory.
CREATE TABLE scim_managed (
    user_id  TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    org_id   TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
    team_id  TEXT NOT NULL,
    PRIMARY KEY (user_id, org_id, team_id)
);
