-- Single sign-on (docs/api/sso.md): identity providers, the people linked to them, the mapping of
-- their groups to organizations, teams and roles, and sign-ins on their way through a provider.
-- OIDC is the first kind; SAML and LDAP use the same tables with their own `config`.

-- `config` is the kind's settings as JSON, without secrets; secrets are in
-- `sso_provider_secrets`, encrypted with the secrets key and bound to `sso-provider:<id>`.
-- `slug` is part of the redirect URI and never changes. `position` orders the buttons on the
-- sign-in page; `enabled` 0 pauses the provider. `checked_at` is the last successful connection
-- check, `last_sign_in_at` the last sign-in through it.
CREATE TABLE sso_providers (
    id                  TEXT PRIMARY KEY,
    slug                TEXT NOT NULL UNIQUE,
    kind                TEXT NOT NULL,
    name                TEXT NOT NULL,
    position            BIGINT NOT NULL,
    enabled             BIGINT NOT NULL DEFAULT 1,
    config              TEXT NOT NULL,
    create_accounts     BIGINT NOT NULL DEFAULT 1,
    trust_provider_mfa  BIGINT NOT NULL DEFAULT 0,
    checked_at          BIGINT,
    last_sign_in_at     BIGINT,
    version             BIGINT NOT NULL DEFAULT 1,
    created_at          BIGINT NOT NULL,
    updated_at          BIGINT NOT NULL
);

CREATE TABLE sso_provider_secrets (
    provider_id  TEXT NOT NULL REFERENCES sso_providers (id) ON DELETE CASCADE,
    field        TEXT NOT NULL,
    key_id       TEXT NOT NULL,
    nonce        TEXT NOT NULL,
    ciphertext   TEXT NOT NULL,
    PRIMARY KEY (provider_id, field)
);

-- A person at a provider (`subject`, OIDC `sub`) and the Kalzit account it signs in to.
CREATE TABLE sso_identities (
    provider_id      TEXT NOT NULL REFERENCES sso_providers (id) ON DELETE CASCADE,
    subject          TEXT NOT NULL,
    user_id          TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    username         TEXT,
    created_at       BIGINT NOT NULL,
    last_sign_in_at  BIGINT NOT NULL,
    PRIMARY KEY (provider_id, subject)
);

CREATE INDEX sso_identities_user ON sso_identities (user_id);

-- The groups of an identity at its last sign-in.
CREATE TABLE sso_identity_groups (
    provider_id  TEXT NOT NULL,
    subject      TEXT NOT NULL,
    group_name   TEXT NOT NULL,
    PRIMARY KEY (provider_id, subject, group_name),
    FOREIGN KEY (provider_id, subject) REFERENCES sso_identities (provider_id, subject) ON DELETE CASCADE
);

CREATE INDEX sso_identity_groups_group ON sso_identity_groups (provider_id, group_name);

-- A provider group gives a role in an organization and optionally a team. `idp_decides` 1: role
-- and membership follow the provider; 0: the role is a minimum that admins may raise.
CREATE TABLE sso_group_mappings (
    id           TEXT PRIMARY KEY,
    provider_id  TEXT NOT NULL REFERENCES sso_providers (id) ON DELETE CASCADE,
    group_name   TEXT NOT NULL,
    org_id       TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
    team_id      TEXT REFERENCES teams (id) ON DELETE CASCADE,
    role         TEXT NOT NULL,
    idp_decides  BIGINT NOT NULL DEFAULT 0,
    created_at   BIGINT NOT NULL,
    updated_at   BIGINT NOT NULL
);

CREATE INDEX sso_group_mappings_provider ON sso_group_mappings (provider_id, group_name);

-- What "IdP entscheidet" mappings of a provider gave a person at the last sign-in through it: the
-- organization (`team_id` empty) and the teams. These memberships follow the provider: they end
-- when no such group matches any more, and an organization role listed here is locked in Members.
CREATE TABLE sso_managed (
    user_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    provider_id  TEXT NOT NULL REFERENCES sso_providers (id) ON DELETE CASCADE,
    org_id       TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
    team_id      TEXT NOT NULL,
    PRIMARY KEY (user_id, provider_id, org_id, team_id)
);

-- A sign-in or an admin's test sign-in on its way through a provider. `state_hash` is the SHA-256
-- of the `state` sent to the provider, `binding_hash` that of the cookie of the browser that
-- started it. `nonce` and the PKCE `verifier` are random values used once. A test sign-in keeps
-- the form it tests in `draft` (without the secret; the secret is in `draft_secret_*`, encrypted
-- like provider secrets and bound to `sso-test:<id>`), the admin in `created_by` and its outcome
-- in `result`. Rows are deleted after use and, by a periodic job, once expired.
CREATE TABLE sso_sign_ins (
    id                  TEXT PRIMARY KEY,
    state_hash          TEXT NOT NULL UNIQUE,
    binding_hash        TEXT NOT NULL,
    provider_id         TEXT,
    purpose             TEXT NOT NULL,
    nonce               TEXT NOT NULL,
    verifier            TEXT,
    redirect_uri        TEXT NOT NULL,
    return_to           TEXT NOT NULL,
    draft               TEXT,
    draft_secret_key_id TEXT,
    draft_secret_nonce  TEXT,
    draft_secret        TEXT,
    created_by          TEXT,
    status              TEXT NOT NULL,
    result              TEXT,
    created_at          BIGINT NOT NULL,
    expires_at          BIGINT NOT NULL
);

CREATE INDEX sso_sign_ins_expires ON sso_sign_ins (expires_at);
