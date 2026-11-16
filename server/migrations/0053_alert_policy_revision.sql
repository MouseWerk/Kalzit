-- Alerting 0.7.2 follow-up: a counter of the changes to an organization's notification policies.
-- Every change of the tree raises it in its own transaction, so every server of a cluster knows
-- from the database whether the compiled tree it keeps is still the stored one.
ALTER TABLE orgs ADD COLUMN alert_policy_revision BIGINT NOT NULL DEFAULT 0;
