-- Service accounts and API tokens (docs/api/access.md, "Service accounts").
--
-- A service account belongs to one organization and acts there with one role. It is an account
-- like a person's (`users`, flagged with `service_account = 1`) and a member of its organization
-- (`org_members` holds its role), so rights, grants and the audit log treat it like anyone else.
-- It has no password and no email of its own (a made-up `.invalid` address fills the column), it
-- never signs in, and the lists of people leave it out. Deleting the account deletes its row
-- here, its membership and its tokens.
ALTER TABLE users ADD COLUMN service_account BIGINT NOT NULL DEFAULT 0;

CREATE TABLE service_accounts (
    id           TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
    org_id       TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
    -- Lowercase letters, digits and hyphens, unique in the organization.
    name         TEXT NOT NULL,
    description  TEXT NOT NULL,
    -- A disabled account's tokens are refused; they come back when it is enabled again.
    disabled     BIGINT NOT NULL DEFAULT 0,
    created_by   TEXT,
    created_at   BIGINT NOT NULL,
    UNIQUE (org_id, name)
);

-- Tokens of service accounts (`kind = 'service_account'`) and the SCIM token of an organization
-- (`kind = 'scim'`, no service account). Only the SHA-256 of a token is stored; `prefix` is its
-- visible start (`kz_sa_7f3a9c2e`), which names it in lists and in the audit log. Revoked and
-- expired tokens stay as rows, so lists can show them for a while; the hash of a revoked one is
-- never accepted again.
CREATE TABLE api_tokens (
    id                  TEXT PRIMARY KEY,
    org_id              TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
    kind                TEXT NOT NULL,
    service_account_id  TEXT REFERENCES service_accounts (id) ON DELETE CASCADE,
    name                TEXT NOT NULL,
    prefix              TEXT NOT NULL,
    token_hash          TEXT NOT NULL UNIQUE,
    -- Addresses and networks the token may be used from, one per line in canonical form; empty
    -- for anywhere.
    allowed_ips         TEXT NOT NULL,
    expires_at          BIGINT NOT NULL,
    created_by          TEXT,
    created_at          BIGINT NOT NULL,
    last_used_at        BIGINT,
    last_used_address   TEXT,
    revoked_at          BIGINT,
    revoked_by          TEXT
);

CREATE INDEX api_tokens_account ON api_tokens (service_account_id, created_at);

-- A change made with an API token names the token next to its service account: its id and prefix.
ALTER TABLE audit_events ADD COLUMN actor_token_id TEXT;
ALTER TABLE audit_events ADD COLUMN actor_token_prefix TEXT;
CREATE INDEX api_tokens_org_kind ON api_tokens (org_id, kind, created_at);
