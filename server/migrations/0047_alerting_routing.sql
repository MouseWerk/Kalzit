-- Alerting 0.7.2 (docs/PLAN.md section 13, "Routing, Gruppierung, Eskalation"; docs/api/alerting.md, "Notification
-- policies"): a tree of notification policies per organization, groups of instances across rules,
-- repetition and escalation, Slack and Teams. Times are Unix milliseconds, durations seconds,
-- flags 0 or 1.

-- The policy tree. The root ("Standard") has no parent, its id is the organization's id, and it
-- sets every time and `group_by` itself; below it a NULL inherits. `matchers` is a JSON list of
-- `{label, op, value}` (as silences), `group_by` a JSON list of label names (`[]` one group for
-- the policy, `["..."]` one group per instance). `repeat_interval_secs` 0 is off.
CREATE TABLE alert_policies (
    id                    TEXT PRIMARY KEY,
    org_id                TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
    parent_id             TEXT REFERENCES alert_policies (id) ON DELETE CASCADE,
    position              BIGINT NOT NULL,
    name                  TEXT NOT NULL,
    matchers              TEXT NOT NULL,
    group_by              TEXT,
    group_wait_secs       BIGINT,
    group_interval_secs   BIGINT,
    repeat_interval_secs  BIGINT,
    continue_matching     BIGINT NOT NULL DEFAULT 0,
    version               BIGINT NOT NULL,
    created_by            TEXT,
    created_at            BIGINT NOT NULL,
    updated_by            TEXT,
    updated_at            BIGINT NOT NULL
);

CREATE INDEX alert_policies_org ON alert_policies (org_id, parent_id, position);
CREATE UNIQUE INDEX alert_policies_root ON alert_policies (org_id) WHERE parent_id IS NULL;

-- A policy's contact points: level 0 for the policy itself, 1 to 3 for its escalation steps.
CREATE TABLE alert_policy_contact_points (
    policy_id         TEXT NOT NULL REFERENCES alert_policies (id) ON DELETE CASCADE,
    level             BIGINT NOT NULL,
    contact_point_id  TEXT NOT NULL REFERENCES alert_contact_points (id) ON DELETE CASCADE,
    PRIMARY KEY (policy_id, level, contact_point_id)
);

CREATE INDEX alert_policy_contact_points_cp ON alert_policy_contact_points (contact_point_id);

-- The escalation steps of a policy: how long its group must have fired.
CREATE TABLE alert_policy_escalations (
    policy_id  TEXT NOT NULL REFERENCES alert_policies (id) ON DELETE CASCADE,
    level      BIGINT NOT NULL,
    wait_secs  BIGINT NOT NULL,
    PRIMARY KEY (policy_id, level)
);

-- A group: the instances of one policy with the same values of its `group_by` labels, across
-- rules. `group_key` is the SHA-256 of the policy id and those values. `next_send_at` is the
-- earliest time a change may be sent (group wait, then group interval), `due_at` when the
-- dispatcher looks at the group next. `firing_since` starts the escalation count and moves on by
-- the time `paused_at` held it (every firing instance silenced). A group without instances is
-- deleted after its resolve was sent.
CREATE TABLE alert_groups (
    id                TEXT PRIMARY KEY,
    org_id            TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
    policy_id         TEXT NOT NULL REFERENCES alert_policies (id) ON DELETE CASCADE,
    group_key         TEXT NOT NULL,
    labels            TEXT NOT NULL,
    catch_all         BIGINT NOT NULL DEFAULT 0,
    created_at        BIGINT NOT NULL,
    next_send_at      BIGINT NOT NULL,
    due_at            BIGINT NOT NULL,
    first_sent_at     BIGINT,
    last_sent_at      BIGINT,
    repeats           BIGINT NOT NULL DEFAULT 0,
    firing_since      BIGINT,
    paused_at         BIGINT,
    escalation_level  BIGINT NOT NULL DEFAULT 0,
    UNIQUE (org_id, group_key)
);

CREATE INDEX alert_groups_due ON alert_groups (due_at);
CREATE INDEX alert_groups_policy ON alert_groups (policy_id);

-- The instances of a group and what waits to be sent: the instance's state now (`state`,
-- `state_since`, value or error), and what the group last sent of it (`sent_state`,
-- `sent_state_since`). The two differ while a change waits for the group's next message. A
-- resolve waits as state `ok` with the start of the state it resolves; the row goes once it was
-- sent (or at once when nothing of the instance was ever sent). `labels` are the instance's
-- labels, `match_labels` those with the rule's labels and `alertname`, as silences see them.
CREATE TABLE alert_group_pending (
    group_id          TEXT NOT NULL REFERENCES alert_groups (id) ON DELETE CASCADE,
    rule_id           TEXT NOT NULL REFERENCES alert_rules (id) ON DELETE CASCADE,
    fingerprint       TEXT NOT NULL,
    org_id            TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
    labels            TEXT NOT NULL,
    match_labels      TEXT NOT NULL,
    state             TEXT NOT NULL,
    state_since       BIGINT NOT NULL,
    value             DOUBLE PRECISION,
    error             TEXT,
    -- `series_gone`, `replaced` or `rerouted` for a waiting resolve.
    reason            TEXT,
    sent_state        TEXT,
    sent_state_since  BIGINT,
    updated_at        BIGINT NOT NULL,
    PRIMARY KEY (group_id, rule_id, fingerprint)
);

CREATE INDEX alert_group_pending_rule ON alert_group_pending (rule_id);

-- How a rule's instances are delivered: `policies` (through the tree) or `direct` (to its own
-- contact points, as in 0.7.0). Rules of 0.7.0 with contact points stay direct, so the update
-- changes no delivery; the others go through the tree.
ALTER TABLE alert_rules ADD COLUMN routing TEXT NOT NULL DEFAULT 'policies';
UPDATE alert_rules SET routing = 'direct'
    WHERE EXISTS (SELECT 1 FROM alert_rule_contact_points l WHERE l.rule_id = alert_rules.id);

-- A group's messages: its group, policy and stage (`0`, the repetition's number, `e1` to `e3`);
-- empty for direct rules. `rule_id` is empty for a group's message.
ALTER TABLE alert_deliveries ADD COLUMN group_id TEXT;
ALTER TABLE alert_deliveries ADD COLUMN policy_id TEXT;
ALTER TABLE alert_deliveries ADD COLUMN stage TEXT;
ALTER TABLE alert_history ADD COLUMN group_id TEXT;
ALTER TABLE alert_history ADD COLUMN policy_id TEXT;
ALTER TABLE alert_history ADD COLUMN stage TEXT;

-- The root of every organization, without contact points: group by `alertname`, 30 seconds,
-- 5 minutes, 4 hours (one message per rule, as in 0.7.0).
INSERT INTO alert_policies (id, org_id, parent_id, position, name, matchers, group_by, group_wait_secs,
    group_interval_secs, repeat_interval_secs, continue_matching, version, created_at, updated_at)
    SELECT id, id, NULL, 0, 'Standard', '[]', '["alertname"]', 30, 300, 14400, 0, 1, created_at, created_at
    FROM orgs;
