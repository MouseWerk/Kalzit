-- What a session proved beyond its sign-in (docs/api/access.md, "Organization sign-in rules" and
-- "Second factor"): `sign_in_provider_id` is the identity provider or directory of the sign-in, so
-- a provider's second factor counts only while that provider is enabled and Kalzit still takes
-- its word for one; `password_confirmed_at` is when the session last confirmed the account's
-- password, which the first second factor of an account with a password needs.
ALTER TABLE sessions ADD COLUMN sign_in_provider_id TEXT;
ALTER TABLE sessions ADD COLUMN password_confirmed_at BIGINT;
