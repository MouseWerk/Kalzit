-- A provider identity linked to an existing account because the addresses match stays
-- unconfirmed until the person proved that account once: with its second factor, or with its
-- password when it has none (docs/api/sso.md, "Linking by email"). Links made before stay
-- confirmed.
ALTER TABLE sso_identities ADD COLUMN confirmed BIGINT NOT NULL DEFAULT 1;

-- The second step of such a sign-in asks for the account's password first.
ALTER TABLE sign_in_challenges ADD COLUMN link_password BIGINT NOT NULL DEFAULT 0;
