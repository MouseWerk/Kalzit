-- Signing in with a passkey alone (docs/api/access.md, "Passkey sign-in"): a started browser
-- dialog that does not know the account yet (discoverable credentials). Only the SHA-256 of the
-- token in the `kalzit_passkey` cookie is kept; the answer takes the row, right or wrong, and an
-- unanswered dialog ends after five minutes.
CREATE TABLE passkey_sign_ins (
    token_hash  TEXT PRIMARY KEY,
    ceremony    TEXT NOT NULL,
    created_at  BIGINT NOT NULL,
    expires_at  BIGINT NOT NULL
);

CREATE INDEX passkey_sign_ins_expires ON passkey_sign_ins (expires_at);
