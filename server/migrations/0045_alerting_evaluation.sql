-- What the evaluation keeps per instance beyond 0044 (alerting::eval, alerting::instances).

-- The reported state an instance waits for during its for-duration (`firing`, `no_data` or
-- `error`), with `pending_since` as its start; also set while a reported state waits to change
-- into another one.
ALTER TABLE alert_instances ADD COLUMN pending_target TEXT;
-- The start of the state last sent (with `last_notified_state` and `last_notified_at`; a resolve
-- is `ok` with the start of the state it resolved) and how many reminders followed it, so nothing
-- is sent twice after a restart and reminders keep counting.
ALTER TABLE alert_instances ADD COLUMN last_notified_state_since BIGINT;
ALTER TABLE alert_instances ADD COLUMN last_notified_reminders BIGINT NOT NULL DEFAULT 0;

-- Transitions: the target of a change to `pending`, and why an instance went back to `ok` when
-- its series disappeared (`series_gone`) or, for the instance without labels that stood for the
-- whole rule, because the result has series again (`replaced`).
ALTER TABLE alert_history ADD COLUMN pending_target TEXT;
ALTER TABLE alert_history ADD COLUMN reason TEXT;
