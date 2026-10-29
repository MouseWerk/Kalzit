-- Mail, invitations and password reset (docs/ARCHITECTURE.md, "Mail, invitations and password
-- reset"). Links carry a random 256-bit token; only its SHA-256 is stored for the lookup.

-- An invitation to an organization by email, with the role (and optionally a team) it gives.
-- Pending while `accepted_at` is NULL and `expires_at` lies ahead; revoking deletes the row, so a
-- revoked link answers like an unknown one. While pending, the token is also kept encrypted with
-- the secrets key (`token_key_id`, `token_nonce`, `token_ciphertext`, associated data
-- `invitation:<id>` and `token`), so an admin can copy the link again; accepting clears it.
CREATE TABLE invitations (
    id                TEXT PRIMARY KEY,
    org_id            TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
    email             TEXT NOT NULL,
    -- A role key as `org_members.role` holds it.
    role              TEXT NOT NULL,
    team_id           TEXT REFERENCES teams (id) ON DELETE SET NULL,
    token_hash        TEXT NOT NULL UNIQUE,
    token_key_id      TEXT,
    token_nonce       TEXT,
    token_ciphertext  TEXT,
    invited_by        TEXT REFERENCES users (id) ON DELETE SET NULL,
    created_at        BIGINT NOT NULL,
    expires_at        BIGINT NOT NULL,
    accepted_at       BIGINT,
    accepted_by       TEXT REFERENCES users (id) ON DELETE SET NULL,
    -- `none` (no mail server: the link is copied), `pending`, `sent` (the mail server accepted
    -- it) or `failed` (with the server's answer in `delivery_detail`).
    delivery          TEXT NOT NULL,
    delivery_detail   TEXT,
    delivered_at      BIGINT
);

CREATE INDEX invitations_org_time ON invitations (org_id, created_at, id);
CREATE INDEX invitations_org_email ON invitations (org_id, email);

-- Password reset links: 60 minutes, single use. `password_fingerprint` is the SHA-256 of the
-- password hash at the time of the request, so a link no longer works once the password changed
-- some other way; `email` binds it to the address the mail went to.
CREATE TABLE password_resets (
    token_hash            TEXT PRIMARY KEY,
    user_id               TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    email                 TEXT NOT NULL,
    password_fingerprint  TEXT NOT NULL,
    created_at            BIGINT NOT NULL,
    expires_at            BIGINT NOT NULL,
    used_at               BIGINT
);

CREATE INDEX password_resets_user ON password_resets (user_id);
CREATE INDEX password_resets_expiry ON password_resets (expires_at);

-- Secrets of server settings (the mail server's password), encrypted like data source secrets:
-- AES-256-GCM with `owner` and `field` as associated data; rotation re-encrypts these rows too.
CREATE TABLE server_secrets (
    owner       TEXT NOT NULL,
    field       TEXT NOT NULL,
    key_id      TEXT NOT NULL,
    nonce       TEXT NOT NULL,
    ciphertext  TEXT NOT NULL,
    PRIMARY KEY (owner, field)
);

-- Whether the account's email address was shown to reach its owner: an account made through an
-- invitation link that went by mail is confirmed; one made through a link an admin copied is not,
-- until its owner confirms the address by mail (`email_confirmations`). Unconfirmed accounts are
-- never added to an organization by address, and single sign-on never links to one by address.
-- Accounts from before are taken as confirmed.
ALTER TABLE users ADD COLUMN email_confirmed BIGINT NOT NULL DEFAULT 1;

-- Links that confirm an account's email address: 24 hours, single use, bound to the address.
CREATE TABLE email_confirmations (
    token_hash  TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    email       TEXT NOT NULL,
    created_at  BIGINT NOT NULL,
    expires_at  BIGINT NOT NULL,
    used_at     BIGINT
);

CREATE INDEX email_confirmations_user ON email_confirmations (user_id);
