-- What a session proved or tried beyond its sign-in (docs/api/access.md, "Second factor" and
-- "Self service"): `provider_confirmed_at` is when the session last signed in again at its
-- OpenID Connect provider with `max_age=0`, which the first second factor of an account that signs
-- in there needs; `wrong_passwords` counts the wrong passwords entered in the session since the
-- last right one, so repeated guesses are audited and the person told once.
ALTER TABLE sessions ADD COLUMN provider_confirmed_at BIGINT;
ALTER TABLE sessions ADD COLUMN wrong_passwords INTEGER NOT NULL DEFAULT 0;
-- A re-authentication at the provider (`purpose` `reauth`) belongs to the session that started
-- it: the SHA-256 of its token, so only that session takes the result.
ALTER TABLE sso_sign_ins ADD COLUMN session_hash TEXT;
