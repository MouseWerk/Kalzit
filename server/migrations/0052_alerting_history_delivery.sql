-- Alerting 0.7.3 (docs/api/alerting.md, "History"): every delivery entry names the message it
-- belongs to, so the entries that went out together in one attempt can be found again.
ALTER TABLE alert_history ADD COLUMN delivery_id TEXT;

-- Entries of a group's message from before: the entries of one attempt share group, time and
-- attempt. A direct rule's message has entries of one rule only and gets no id.
UPDATE alert_history
    SET delivery_id = 'legacy:' || group_id || ':' || CAST(at AS TEXT) || ':' || CAST(COALESCE(attempt, 0) AS TEXT)
    WHERE kind = 'delivery' AND group_id IS NOT NULL;

CREATE INDEX alert_history_delivery ON alert_history (delivery_id);
