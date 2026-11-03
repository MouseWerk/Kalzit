-- How a session was established (docs/api/access.md, "Organization sign-in rules"), so an
-- organization's rules can be checked on every request into it: `sign_in_method` is `password`,
-- `break_glass`, `directory` or `provider`, and `sign_in_second_factor` the second factor of that
-- sign-in (`totp`, `passkey`, `recovery`, or `provider` when Kalzit took a provider's word for
-- one). Sessions from before keep an empty method and count as signed in with a password.
ALTER TABLE sessions ADD COLUMN sign_in_method TEXT NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN sign_in_second_factor TEXT;
