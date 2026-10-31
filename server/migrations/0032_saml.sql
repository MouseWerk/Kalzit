-- SAML 2.0 (docs/api/sso.md, "SAML 2.0"): providers of the kind `saml` live in `sso_providers`
-- (their pinned entity ID, sign-in URL and signing certificates in `config`; SAML has no secret on
-- Kalzit's side). A sign-in on its way through one is a row of `sso_sign_ins`: `state_hash` is the
-- SHA-256 of the AuthnRequest ID, `nonce` the ID itself, `redirect_uri` the ACS, and `result`
-- the checked assertion between the ACS and the step that opens the session.

-- The assertions used, by the provider's entity ID, until they would be refused anyway: an
-- assertion signs in once (docs/api/sso.md, "Replay").
CREATE TABLE saml_assertions (
    issuer        TEXT NOT NULL,
    assertion_id  TEXT NOT NULL,
    expires_at    BIGINT NOT NULL,
    PRIMARY KEY (issuer, assertion_id)
);

CREATE INDEX saml_assertions_expires ON saml_assertions (expires_at);
