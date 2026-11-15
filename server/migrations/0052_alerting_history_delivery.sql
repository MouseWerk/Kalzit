-- Alerting 0.7.3 (docs/api/alerting.md, "History" and "Groups"): who sees the data of a history
-- entry follows the data source its rule had when the entry was written, and every group holds
-- instances of one data source only.

-- The data source of the entry's rule when it was written. Entries from before take the rule's
-- source now; those of deleted rules stay without one (the organization-wide rights decide).
ALTER TABLE alert_history ADD COLUMN datasource_id TEXT;
UPDATE alert_history
    SET datasource_id = (SELECT r.datasource_id FROM alert_rules r WHERE r.id = alert_history.rule_id)
    WHERE rule_id IN (SELECT id FROM alert_rules);

-- The data source of a group's instances. Groups from before have none: their key leaves the
-- source out, and they keep the instances they hold until those resolve, so the update sends
-- nothing twice and loses no resolve; new instances go to groups of their source.
ALTER TABLE alert_groups ADD COLUMN datasource_id TEXT;
