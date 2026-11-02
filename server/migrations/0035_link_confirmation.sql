-- A provider identity linked to an existing account because the addresses match stays
-- unconfirmed until the person proved that account once: with its second factor, or with its
-- password when it has none (docs/api/sso.md, "Linking by email"). Links made before stay
-- confirmed.
ALTER TABLE sso_identities ADD COLUMN confirmed BIGINT NOT NULL DEFAULT 1;

-- The second step of such a sign-in asks for the account's password first.
ALTER TABLE sign_in_challenges ADD COLUMN link_password BIGINT NOT NULL DEFAULT 0;

-- How a person joined an organization (docs/api/access.md, "Members"): `invitation`, `creator`,
-- `scim_owned`, `mapping`, `direct` or `legacy`. Only the first four are the person's consent,
-- and only they bind the account to the organization's sign-in rules. Memberships from before
-- are `legacy`.
ALTER TABLE org_members ADD COLUMN joined_by TEXT NOT NULL DEFAULT 'legacy';

-- When the person left this organization or was removed from it: SCIM never adds them back.
ALTER TABLE scim_users ADD COLUMN left_at BIGINT;
