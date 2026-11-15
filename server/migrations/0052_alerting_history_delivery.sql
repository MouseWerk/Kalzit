-- Alerting 0.7.2 fix (docs/api/alerting.md, "History"): every delivery entry names the message it
-- belongs to, so the history can tell which entries went out together. When one of them is of a
-- rule whose data the caller may not see, the group, policy, stage and contact point are left
-- out on all of them.
ALTER TABLE alert_history ADD COLUMN delivery_id TEXT;

-- Entries of a group's message from before: the entries of one attempt share group, time and
-- attempt. A direct rule's message has entries of one rule only and needs no id.
UPDATE alert_history
    SET delivery_id = 'legacy:' || group_id || ':' || CAST(at AS TEXT) || ':' || CAST(COALESCE(attempt, 0) AS TEXT)
    WHERE kind = 'delivery' AND group_id IS NOT NULL;

CREATE INDEX alert_history_delivery ON alert_history (delivery_id);
