-- The dashboard list's "last changed" order (`sort=updated`): newest first per organization,
-- with the id as the tie-break its cursor uses.
CREATE INDEX dashboards_org_updated ON dashboards (org_id, updated_at, id);
