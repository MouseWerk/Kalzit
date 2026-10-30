-- The second factor of a sign-in (docs/api/access.md, "Second factor").

-- The key of a person's authenticator app (TOTP, RFC 6238), AES-GCM encrypted with the secrets key
-- and bound to `user:<id>` / `totp`. `last_step` is the last 30-second step whose code was used, so
-- a code works once.
CREATE TABLE user_totp (
    user_id       TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
    key_id        TEXT NOT NULL,
    nonce         TEXT NOT NULL,
    ciphertext    TEXT NOT NULL,
    last_step     BIGINT NOT NULL,
    created_at    BIGINT NOT NULL,
    last_used_at  BIGINT
);

-- Passkeys (WebAuthn). `credential` is the public key with its sign counter as webauthn-rs keeps
-- it (JSON); `credential_id` (base64url) is unique across all accounts.
CREATE TABLE user_passkeys (
    id             TEXT PRIMARY KEY,
    user_id        TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    credential_id  TEXT NOT NULL UNIQUE,
    name           TEXT NOT NULL,
    credential     TEXT NOT NULL,
    created_at     BIGINT NOT NULL,
    last_used_at   BIGINT
);

CREATE INDEX user_passkeys_user ON user_passkeys (user_id);

-- Recovery codes: only a SHA-256 of each, bound to the account; `used_at` once used.
CREATE TABLE user_recovery_codes (
    user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    code_hash   TEXT NOT NULL,
    created_at  BIGINT NOT NULL,
    used_at     BIGINT,
    PRIMARY KEY (user_id, code_hash)
);

-- Code attempts per account in the current window, and the end of a lockout after too many wrong
-- codes.
CREATE TABLE second_factor_lockouts (
    user_id       TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
    attempts      BIGINT NOT NULL,
    window_start  BIGINT NOT NULL,
    locked_until  BIGINT NOT NULL
);

-- The half-signed-in state between the first step of a sign-in and the second factor: only the
-- SHA-256 of the token in the `kalzit_pending` cookie. Not a session; it lives five minutes and
-- is deleted when the sign-in completes. `password_fingerprint` notices a password changed
-- meanwhile; `ceremony` holds a started passkey dialog or app setup until its answer.
CREATE TABLE sign_in_challenges (
    token_hash            TEXT PRIMARY KEY,
    user_id               TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    setup                 BIGINT NOT NULL,
    forget_browser        BIGINT NOT NULL,
    first_step            TEXT NOT NULL,
    password_fingerprint  TEXT,
    created_at            BIGINT NOT NULL,
    expires_at            BIGINT NOT NULL,
    ceremony_kind         TEXT,
    ceremony              TEXT,
    ceremony_expires_at   BIGINT
);

CREATE INDEX sign_in_challenges_user ON sign_in_challenges (user_id);

-- A session's last fresh confirmation of the second factor, and a started passkey dialog or app
-- setup of the account page.
ALTER TABLE sessions ADD COLUMN second_factor_at BIGINT;
ALTER TABLE sessions ADD COLUMN ceremony_kind TEXT;
ALTER TABLE sessions ADD COLUMN ceremony TEXT;
ALTER TABLE sessions ADD COLUMN ceremony_expires_at BIGINT;
