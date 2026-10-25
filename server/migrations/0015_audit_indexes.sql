-- Audit log pages: an organization's events newest first, by time and id (the page order and
-- cursor), and the events of one resource. Replaces the index on organization and time alone,
-- which left the id order of events with the same time to a sort.

CREATE INDEX audit_events_org_time_id ON audit_events (org_id, created_at, id);
CREATE INDEX audit_events_org_resource ON audit_events (org_id, resource_type, resource_id, created_at, id);
DROP INDEX audit_events_org_time;
