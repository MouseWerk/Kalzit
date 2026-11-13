//! Groups of instances across rules (docs/PLAN.md section 13, "Gruppierung und Zeiten" and
//! "Eskalation"; docs/api/alerting.md, "Groups, repetition and escalation").
//!
//! An evaluation of a rule routed through policies calls [`sync`] inside its transaction: every
//! reported instance (firing, no data, error) is stored in the group of each way it takes that
//! delivers (`alert_group_pending`), with its state now; what the group last sent of it stays next
//! to it. An instance that left a group (resolved, gone, or another way) leaves a waiting resolve
//! there when the group had sent it, and goes silently when not.
//!
//! The dispatcher ([`dispatch_due`], every 5 seconds on the leading server) takes the groups that
//! are due and, per group in one transaction: checks the silences, sends the changes once the
//! group wait or group interval allows, repeats an unchanged group after the repeat interval,
//! sends due escalation steps, records each message per contact point through
//! `outbox::record_group` under the deduplication keys (stage `0`, the repetition's number, `e1`
//! to `e3`), and marks what it sent. A crash before the commit repeats all of it, one after it
//! finds the messages in the outbox; a second dispatcher finds the group already handled (its
//! `due_at` moved on). A server that does not lead commits nothing.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use serde::Serialize;
use sqlx::AnyConnection;

use super::eval::{EvalError, Event, InstanceState, Labels, ResolveReason, State};
use super::group_message::{Alert, GroupInfo, GroupLinks, GroupMessage, Kind, PathItem, PolicyRef, VERSION};
use super::message::{Instance, Links, Organization, RuleInfo};
use super::outbox::{self, GroupEntry};
use super::policy::{self, Tree, alert_labels, catch_all_key, group_of};
use super::silences;
use crate::app::AppState;
use crate::error::{ApiError, ApiResult};

/// How often the dispatcher looks at the groups.
pub const LOOK_EVERY_MS: i64 = 5_000;
/// While a silence holds an instance of a group, the group is looked at again this often, so the
/// end of the silence is noticed.
const SILENCE_RECHECK_MS: i64 = 30_000;
/// A group with nothing to do is looked at again after this long at the latest.
const IDLE_RECHECK_MS: i64 = 3_600_000;
/// Groups taken per round of the dispatcher.
const BATCH: i64 = 64;

/// The rule an evaluation syncs.
pub struct RuleRef<'a> {
    pub id: &'a str,
    pub org_id: &'a str,
    pub name: &'a str,
    pub labels: &'a Labels,
}

type PendingRow = (String, String, String, i64, Option<String>, Option<i64>, String);

/// A group an evaluation puts instances in: the policy, the group's labels and the instances with
/// their labels as policies see them.
type Wanted<'a> = (usize, Labels, Vec<(&'a InstanceState, Labels)>);

/// A group's due time moves to its next send at the latest, since one of its instances changed.
const MARK_DUE: &str = "UPDATE alert_groups SET due_at = CASE WHEN next_send_at < due_at THEN next_send_at \
     ELSE due_at END WHERE id = $1";

/// Locks a group's row for the rest of the transaction (a no-op update: the row lock on
/// PostgreSQL, the write lock on SQLite). False when the group is gone.
async fn lock_group(conn: &mut AnyConnection, group_id: &str) -> ApiResult<bool> {
    let n = sqlx::query("UPDATE alert_groups SET due_at = due_at WHERE id = $1")
        .bind(group_id)
        .execute(&mut *conn)
        .await?
        .rows_affected();
    Ok(n == 1)
}

/// Every contact point `labels` reach through the tree: of each way that delivers, the effective
/// ones and those of its escalation steps.
pub fn reached(tree: &Tree, labels: &Labels) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    for route in tree.routes(labels) {
        let node = tree.node(route);
        if !node.effective.delivers {
            continue;
        }
        out.extend(node.effective.contact_point_ids.iter().cloned());
        for step in &node.policy.escalations {
            out.extend(step.contact_point_ids.iter().cloned());
        }
    }
    out
}

/// The group a key stands for, made when missing: beyond the organization's limit the
/// catch-all group of the policy. Answers its id, locked.
async fn group_for(
    conn: &mut AnyConnection,
    org_id: &str,
    key: &str,
    node: &policy::Node,
    group_labels: &Labels,
    max_groups: u64,
    now: i64,
) -> ApiResult<String> {
    // Two tries: a group the dispatcher deleted between finding and locking it is made anew.
    for _ in 0..2 {
        let existing: Option<(String,)> =
            sqlx::query_as("SELECT id FROM alert_groups WHERE org_id = $1 AND group_key = $2")
                .bind(org_id)
                .bind(key)
                .fetch_optional(&mut *conn)
                .await?;
        if let Some((id,)) = existing {
            if lock_group(conn, &id).await? {
                return Ok(id);
            }
            continue;
        }
        let (count,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM alert_groups WHERE org_id = $1")
            .bind(org_id)
            .fetch_one(&mut *conn)
            .await?;
        let catch_all = u64::try_from(count).unwrap_or(0) >= max_groups;
        let (key, labels) = if catch_all {
            (catch_all_key(&node.policy.id), Labels::new())
        } else {
            (key.to_string(), group_labels.clone())
        };
        let wait = node.effective.group_wait_secs.saturating_mul(1000);
        sqlx::query(
            "INSERT INTO alert_groups (id, org_id, policy_id, group_key, labels, catch_all, created_at, next_send_at, \
             due_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8) ON CONFLICT (org_id, group_key) DO NOTHING",
        )
        .bind(crate::routes::new_id())
        .bind(org_id)
        .bind(&node.policy.id)
        .bind(&key)
        .bind(serde_json::to_string(&labels).expect("labels always serialize"))
        .bind(i64::from(catch_all))
        .bind(now)
        .bind(now.saturating_add(wait))
        .execute(&mut *conn)
        .await?;
        let made: Option<(String,)> =
            sqlx::query_as("SELECT id FROM alert_groups WHERE org_id = $1 AND group_key = $2")
                .bind(org_id)
                .bind(&key)
                .fetch_optional(&mut *conn)
                .await?;
        if let Some((id,)) = made
            && lock_group(conn, &id).await?
        {
            return Ok(id);
        }
    }
    Err(ApiError::internal("alert group", format!("group {key} could not be made")))
}

/// Stores the rule's reported instances in the groups of their ways, inside the evaluation's
/// transaction (see the module docs). `instances` are the rule's instances after the evaluation.
///
/// Locks come first, in one order: the groups the rule is in now (by id), then the groups it
/// enters (by key); only then are the rule's rows read, so a dispatcher that sent in the meantime
/// is seen (PostgreSQL reads what was committed before each statement).
pub async fn sync(
    conn: &mut AnyConnection,
    rule: &RuleRef<'_>,
    instances: &[InstanceState],
    tree: &Tree,
    max_groups: u64,
    now: i64,
) -> ApiResult<()> {
    let current: Vec<(String,)> =
        sqlx::query_as("SELECT DISTINCT group_id FROM alert_group_pending WHERE rule_id = $1 ORDER BY group_id")
            .bind(rule.id)
            .fetch_all(&mut *conn)
            .await?;
    for (id,) in &current {
        lock_group(conn, id).await?;
    }
    // Where each reported instance belongs now, by group key: the policy, the group's labels and
    // the instances with their labels as policies see them.
    let mut desired: BTreeMap<String, Wanted<'_>> = BTreeMap::new();
    // What each reported instance still reaches, for the resolves of the groups it leaves.
    let mut still: HashMap<&str, BTreeSet<String>> = HashMap::new();
    for instance in instances.iter().filter(|i| i.state.is_active()) {
        let labels = alert_labels(&instance.labels, rule.labels, rule.name);
        still.insert(&instance.fingerprint, reached(tree, &labels));
        for route in tree.routes(&labels) {
            let node = tree.node(route);
            if !node.effective.delivers {
                continue;
            }
            let (key, group_labels) = group_of(&node.policy.id, &node.effective.group_by, &labels);
            desired.entry(key).or_insert_with(|| (route, group_labels, Vec::new())).2.push((instance, labels.clone()));
        }
    }
    let mut group_ids: BTreeMap<&str, String> = BTreeMap::new();
    for (key, (route, group_labels, _)) in &desired {
        let id = group_for(conn, rule.org_id, key, tree.node(*route), group_labels, max_groups, now).await?;
        group_ids.insert(key.as_str(), id);
    }
    let existing: Vec<PendingRow> = sqlx::query_as(
        "SELECT group_id, fingerprint, state, state_since, sent_state, sent_state_since, labels \
         FROM alert_group_pending WHERE rule_id = $1",
    )
    .bind(rule.id)
    .fetch_all(&mut *conn)
    .await?;
    let mut kept: BTreeSet<(String, String)> = BTreeSet::new();
    for (key, (_, _, members)) in &desired {
        let group_id = &group_ids[key.as_str()];
        for (instance, labels) in members {
            if !kept.insert((group_id.clone(), instance.fingerprint.clone())) {
                continue;
            }
            let stored = existing.iter().find(|r| r.0 == *group_id && r.1 == instance.fingerprint);
            let error =
                instance.last_error.as_ref().map(|e| serde_json::to_string(e).expect("errors always serialize"));
            let instance_labels = serde_json::to_string(&instance.labels).expect("labels always serialize");
            let match_labels = serde_json::to_string(labels).expect("labels always serialize");
            let changed = match stored {
                Some(row) => {
                    sqlx::query(
                        "UPDATE alert_group_pending SET labels = $1, match_labels = $2, state = $3, state_since = $4, \
                         value = $5, error = $6, reason = NULL, skip_contact_points = NULL, updated_at = $7 \
                         WHERE group_id = $8 AND rule_id = $9 AND fingerprint = $10",
                    )
                    .bind(&instance_labels)
                    .bind(&match_labels)
                    .bind(instance.state.as_str())
                    .bind(instance.since)
                    .bind(instance.last_value)
                    .bind(&error)
                    .bind(now)
                    .bind(group_id)
                    .bind(rule.id)
                    .bind(&instance.fingerprint)
                    .execute(&mut *conn)
                    .await?;
                    row.2 != instance.state.as_str() || row.3 != instance.since
                }
                None => {
                    sqlx::query(
                        "INSERT INTO alert_group_pending (group_id, rule_id, fingerprint, org_id, labels, match_labels, \
                         state, state_since, value, error, joined_at, updated_at) \
                         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)",
                    )
                    .bind(group_id)
                    .bind(rule.id)
                    .bind(&instance.fingerprint)
                    .bind(rule.org_id)
                    .bind(&instance_labels)
                    .bind(&match_labels)
                    .bind(instance.state.as_str())
                    .bind(instance.since)
                    .bind(instance.last_value)
                    .bind(&error)
                    .bind(now)
                    .execute(&mut *conn)
                    .await?;
                    true
                }
            };
            if changed {
                sqlx::query(MARK_DUE).bind(group_id).execute(&mut *conn).await?;
            }
        }
    }
    // Instances that left a group: a waiting resolve where the group sent them, else they go.
    for (group_id, fingerprint, state, _, sent_state, sent_since, labels) in &existing {
        if kept.contains(&(group_id.clone(), fingerprint.clone())) {
            continue;
        }
        let now_instance = instances.iter().find(|i| i.fingerprint == *fingerprint);
        match (sent_state, sent_since) {
            (Some(sent), Some(since)) if sent != "ok" => {
                if state == "ok" {
                    continue;
                }
                let reason = match now_instance {
                    Some(i) if i.state.is_active() => Some(ResolveReason::Rerouted),
                    Some(_) => None,
                    None if labels == "{}" => Some(ResolveReason::Replaced),
                    None => Some(ResolveReason::SeriesGone),
                };
                // Rerouted: the contact points the instance reaches on its new way keep it.
                let skip = (reason == Some(ResolveReason::Rerouted))
                    .then(|| still.get(fingerprint.as_str()).cloned().unwrap_or_default());
                resolve_row(
                    conn,
                    group_id,
                    rule.id,
                    fingerprint,
                    *since,
                    now_instance.and_then(|i| i.last_value),
                    reason,
                    skip.as_ref(),
                    now,
                )
                .await?;
            }
            _ => {
                sqlx::query(
                    "DELETE FROM alert_group_pending WHERE group_id = $1 AND rule_id = $2 AND fingerprint = $3",
                )
                .bind(group_id)
                .bind(rule.id)
                .bind(fingerprint)
                .execute(&mut *conn)
                .await?;
                // An empty group is cleared up by the dispatcher.
                sqlx::query("UPDATE alert_groups SET due_at = $1 WHERE id = $2")
                    .bind(now)
                    .bind(group_id)
                    .execute(&mut *conn)
                    .await?;
            }
        }
    }
    Ok(())
}

/// Turns a member that the group sent into a waiting resolve.
#[allow(clippy::too_many_arguments)]
async fn resolve_row(
    conn: &mut AnyConnection,
    group_id: &str,
    rule_id: &str,
    fingerprint: &str,
    since: i64,
    value: Option<f64>,
    reason: Option<ResolveReason>,
    skip: Option<&BTreeSet<String>>,
    now: i64,
) -> ApiResult<()> {
    sqlx::query(
        "UPDATE alert_group_pending SET state = 'ok', state_since = $1, value = $2, error = NULL, reason = $3, \
         skip_contact_points = $4, updated_at = $5 WHERE group_id = $6 AND rule_id = $7 AND fingerprint = $8",
    )
    .bind(since)
    .bind(value)
    .bind(reason.map(ResolveReason::as_str))
    .bind(skip.map(|s| serde_json::to_string(s).expect("ids always serialize")))
    .bind(now)
    .bind(group_id)
    .bind(rule_id)
    .bind(fingerprint)
    .execute(&mut *conn)
    .await?;
    sqlx::query(MARK_DUE).bind(group_id).execute(&mut *conn).await?;
    Ok(())
}

/// A rule leaves the policies (it became direct, with `direct_contact_points`): what its groups
/// sent of it waits as a resolve for the contact points the rule no longer reaches, the rest goes.
/// Inside the caller's transaction.
pub async fn leave(
    conn: &mut AnyConnection,
    rule_id: &str,
    direct_contact_points: &[String],
    now: i64,
) -> ApiResult<()> {
    let groups: Vec<(String,)> =
        sqlx::query_as("SELECT DISTINCT group_id FROM alert_group_pending WHERE rule_id = $1 ORDER BY group_id")
            .bind(rule_id)
            .fetch_all(&mut *conn)
            .await?;
    for (id,) in &groups {
        lock_group(conn, id).await?;
    }
    sqlx::query("DELETE FROM alert_group_pending WHERE rule_id = $1 AND (sent_state IS NULL OR sent_state = 'ok')")
        .bind(rule_id)
        .execute(&mut *conn)
        .await?;
    let skip: BTreeSet<&String> = direct_contact_points.iter().collect();
    sqlx::query(
        "UPDATE alert_group_pending SET state = 'ok', state_since = sent_state_since, error = NULL, reason = $1, \
         skip_contact_points = $2, updated_at = $3 WHERE rule_id = $4 AND state <> 'ok'",
    )
    .bind(ResolveReason::Rerouted.as_str())
    .bind(serde_json::to_string(&skip).expect("ids always serialize"))
    .bind(now)
    .bind(rule_id)
    .execute(&mut *conn)
    .await?;
    for (id,) in groups {
        sqlx::query("UPDATE alert_groups SET due_at = $1 WHERE id = $2")
            .bind(now)
            .bind(&id)
            .execute(&mut *conn)
            .await?;
    }
    Ok(())
}

/// The organization's silences changed: its groups are looked at again at once, so an escalation
/// holds (or goes on) from now.
pub async fn recheck(conn: &mut AnyConnection, org_id: &str, now: i64) -> ApiResult<()> {
    sqlx::query("UPDATE alert_groups SET due_at = $1 WHERE org_id = $2 AND due_at > $1")
        .bind(now)
        .bind(org_id)
        .execute(&mut *conn)
        .await?;
    Ok(())
}

/// A rule's instances end without a notification (it was paused): it leaves its groups silently.
pub async fn forget(conn: &mut AnyConnection, rule_id: &str, now: i64) -> ApiResult<()> {
    let groups: Vec<(String,)> =
        sqlx::query_as("SELECT DISTINCT group_id FROM alert_group_pending WHERE rule_id = $1 ORDER BY group_id")
            .bind(rule_id)
            .fetch_all(&mut *conn)
            .await?;
    sqlx::query("DELETE FROM alert_group_pending WHERE rule_id = $1").bind(rule_id).execute(&mut *conn).await?;
    for (id,) in groups {
        sqlx::query("UPDATE alert_groups SET due_at = $1 WHERE id = $2")
            .bind(now)
            .bind(&id)
            .execute(&mut *conn)
            .await?;
    }
    Ok(())
}

#[derive(Clone, Debug, sqlx::FromRow)]
struct GroupRow {
    id: String,
    org_id: String,
    policy_id: String,
    group_key: String,
    labels: String,
    catch_all: i64,
    created_at: i64,
    next_send_at: i64,
    due_at: i64,
    first_sent_at: Option<i64>,
    last_sent_at: Option<i64>,
    repeats: i64,
    firing_since: Option<i64>,
    paused_at: Option<i64>,
    escalation_level: i64,
}

const GROUP_COLUMNS: &str = "SELECT id, org_id, policy_id, group_key, labels, catch_all, created_at, next_send_at, \
     due_at, first_sent_at, last_sent_at, repeats, firing_since, paused_at, escalation_level FROM alert_groups";

#[derive(Clone, Debug, sqlx::FromRow)]
struct MemberRow {
    rule_id: String,
    fingerprint: String,
    labels: String,
    match_labels: String,
    state: String,
    state_since: i64,
    value: Option<f64>,
    error: Option<String>,
    reason: Option<String>,
    sent_state: Option<String>,
    sent_state_since: Option<i64>,
    skip_contact_points: Option<String>,
    joined_at: i64,
}

/// A member of a group as the dispatcher sees it.
#[derive(Clone, Debug)]
struct Member {
    row: MemberRow,
    state: State,
    silenced: bool,
}

impl Member {
    /// A change waits: the state or its start differ from what the group sent.
    fn changed(&self) -> bool {
        self.row.sent_state.as_deref() != Some(self.state.as_str())
            || self.row.sent_state_since != Some(self.row.state_since)
    }

    fn reporting(&self) -> bool {
        self.state.is_active()
    }
}

/// What the dispatcher decided for a group, before anything is stored: the pure part, tested
/// with a fake clock.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Plan {
    /// Send the changes (stage `0`).
    pub change: bool,
    /// Send a repetition with this number.
    pub repeat: Option<u32>,
    /// Send these escalation steps.
    pub escalate: Vec<u32>,
    pub firing_since: Option<i64>,
    pub paused_at: Option<i64>,
    /// The step reached after this round; back to 0 when nothing fires any more.
    pub escalation_level: i64,
    pub due_at: i64,
}

/// The group's times and counters as the plan reads them.
#[derive(Clone, Debug, Default)]
pub struct Times {
    pub next_send_at: i64,
    pub last_sent_at: Option<i64>,
    pub repeats: i64,
    pub firing_since: Option<i64>,
    pub paused_at: Option<i64>,
    pub escalation_level: i64,
}

/// The members of a group in short, for the plan.
#[derive(Clone, Debug, Default)]
pub struct Counts {
    /// Changes that are not silenced.
    pub changes: usize,
    /// Reporting instances that were sent, not silenced, unchanged.
    pub steady: usize,
    /// Firing instances that are not silenced, and the earliest start of their firing in this
    /// group (no earlier than the group took them).
    pub firing: usize,
    pub firing_from: Option<i64>,
    /// Firing instances held by a silence.
    pub firing_silenced: usize,
    /// Instances held by a silence.
    pub silenced: usize,
}

/// Decides what a group sends at `now` (see the module docs and docs/api/alerting.md).
pub fn plan(
    times: &Times,
    counts: &Counts,
    effective: &policy::Effective,
    steps: &[policy::Escalation],
    now: i64,
) -> Plan {
    let mut out = Plan { firing_since: times.firing_since, paused_at: times.paused_at, ..Plan::default() };
    // The escalation's count: from the first firing instance that is not silenced, held while
    // every firing instance is silenced, and over when nothing fires.
    if counts.firing > 0 {
        match (out.firing_since, out.paused_at) {
            (None, _) => {
                out.firing_since = Some(counts.firing_from.unwrap_or(now).min(now));
                out.paused_at = None;
            }
            (Some(since), Some(paused)) => {
                out.firing_since = Some(since.saturating_add(now.saturating_sub(paused)));
                out.paused_at = None;
            }
            (Some(_), None) => {}
        }
    } else if counts.firing_silenced > 0 {
        if out.firing_since.is_some() && out.paused_at.is_none() {
            out.paused_at = Some(now);
        }
    } else {
        out.firing_since = None;
        out.paused_at = None;
    }
    out.change = counts.changes > 0 && now >= times.next_send_at;
    let repeat_ms = effective.repeat_ms();
    if !out.change
        && counts.steady > 0
        && let (Some(every), Some(last)) = (repeat_ms, times.last_sent_at)
        && now >= last.saturating_add(every)
    {
        out.repeat = Some(u32::try_from(times.repeats + 1).unwrap_or(u32::MAX));
    }
    // No step before the group's first message.
    let sent = times.last_sent_at.is_some() || out.change;
    let mut level = if out.firing_since.is_none() { 0 } else { times.escalation_level };
    if let (Some(since), None, true, true) = (out.firing_since, out.paused_at, counts.firing > 0, sent) {
        for step in steps {
            if step.level <= level {
                continue;
            }
            if now >= since.saturating_add(step.wait_secs.saturating_mul(1000)) {
                out.escalate.push(u32::try_from(step.level).unwrap_or(0));
                level = step.level;
            } else {
                break;
            }
        }
    }
    // When to look again.
    let interval_ms = effective.group_interval_secs.saturating_mul(1000);
    let next_send = if out.change { now.saturating_add(interval_ms) } else { times.next_send_at };
    let last_sent = if out.change || out.repeat.is_some() { Some(now) } else { times.last_sent_at };
    let mut due = Vec::new();
    if counts.changes > 0 && !out.change {
        due.push(next_send);
    }
    if counts.silenced > 0 {
        due.push(now.saturating_add(SILENCE_RECHECK_MS));
    }
    if let (Some(every), Some(last)) = (repeat_ms, last_sent)
        && (counts.steady > 0 || out.change)
    {
        due.push(last.saturating_add(every));
    }
    if let (Some(since), None, true) = (out.firing_since, out.paused_at, sent)
        && let Some(step) = steps.iter().find(|s| s.level > level)
    {
        due.push(since.saturating_add(step.wait_secs.saturating_mul(1000)));
    }
    out.escalation_level = level;
    out.due_at = due.into_iter().min().unwrap_or(now.saturating_add(IDLE_RECHECK_MS)).max(now.saturating_add(1000));
    out
}

/// What one dispatcher round needs of an organization, read once.
struct OrgView {
    tree: Tree,
    silences: Vec<(String, silences::Compiled)>,
    org_name: String,
    public: Option<String>,
}

/// Looks at every group that is due and sends what it owes. Answers the number of messages
/// recorded. Nothing on a server that does not lead.
pub async fn dispatch_due(state: &AppState) -> ApiResult<usize> {
    let mut recorded = 0;
    let mut orgs: HashMap<String, OrgView> = HashMap::new();
    let mut seen: BTreeSet<String> = BTreeSet::new();
    loop {
        if state.cluster.coordinated() && !state.cluster.is_leader() {
            return Ok(recorded);
        }
        let now = state.clock.now_ms();
        let due: Vec<(String, String)> =
            sqlx::query_as("SELECT id, org_id FROM alert_groups WHERE due_at <= $1 ORDER BY due_at, id LIMIT $2")
                .bind(now)
                .bind(BATCH)
                .fetch_all(&state.db)
                .await?;
        let fresh: Vec<(String, String)> = due.into_iter().filter(|(id, _)| seen.insert(id.clone())).collect();
        if fresh.is_empty() {
            break;
        }
        for (group_id, org_id) in fresh {
            if !orgs.contains_key(&org_id) {
                orgs.insert(org_id.clone(), org_view(state, &org_id, now).await?);
            }
            let view = &orgs[&org_id];
            match dispatch_one(state, view, &group_id).await {
                Ok(n) => recorded += n,
                Err(e) => tracing::warn!("alert group {group_id}: {}", e.message),
            }
        }
    }
    if recorded > 0 {
        state.alerting.outbox.notify_one();
    }
    Ok(recorded)
}

async fn org_view(state: &AppState, org_id: &str, now: i64) -> ApiResult<OrgView> {
    let mut conn = state.db.acquire().await?;
    let tree = Tree::new(org_id, policy::load(&mut conn, org_id).await?);
    let silences = super::evaluate::active_silences(&mut conn, org_id, now).await?;
    let org_name: Option<String> =
        sqlx::query_scalar("SELECT name FROM orgs WHERE id = $1").bind(org_id).fetch_optional(&mut *conn).await?;
    Ok(OrgView { tree, silences, org_name: org_name.unwrap_or_default(), public: crate::mail::public_url(state) })
}

type RuleInfoRow = (String, String, String, Option<String>, String, String, String, Option<String>, Option<String>);

async fn rule_infos(
    conn: &mut AnyConnection,
    ids: &BTreeSet<String>,
    public: Option<&str>,
) -> ApiResult<HashMap<String, (RuleInfo, Links)>> {
    let mut out = HashMap::new();
    for id in ids {
        let row: Option<RuleInfoRow> = sqlx::query_as(
            "SELECT id, name, description, runbook_url, labels, reduce, condition, dashboard_id, panel_id \
             FROM alert_rules WHERE id = $1",
        )
        .bind(id)
        .fetch_optional(&mut *conn)
        .await?;
        let Some((id, name, description, runbook_url, labels, reduce, condition, dashboard_id, panel_id)) = row else {
            continue;
        };
        let broken = |what: &str| ApiError::internal("alert rule", format!("stored {what} of {id} does not parse"));
        let info = RuleInfo {
            id: id.clone(),
            name,
            description,
            runbook_url,
            labels: serde_json::from_str(&labels).map_err(|_| broken("labels"))?,
            reduce: serde_json::from_str(&reduce).map_err(|_| broken("reduce"))?,
            condition: serde_json::from_str(&condition).map_err(|_| broken("condition"))?,
        };
        let dashboard = dashboard_id.as_deref().map(|d| (d, panel_id.as_deref()));
        let links = Links::new(public, &id, dashboard);
        out.insert(id, (info, links));
    }
    Ok(out)
}

fn alert_of(member: &Member, rules: &HashMap<String, (RuleInfo, Links)>, kind: Kind, repeat: u32) -> Option<Alert> {
    let (rule, links) = rules.get(&member.row.rule_id)?;
    let changed = member.changed();
    let event = match (kind, member.state) {
        (_, State::Ok) => Event::Resolved,
        (Kind::Repeat, _) => Event::Reminder,
        (_, s) => Event::entering(s),
    };
    let error: Option<EvalError> = member.row.error.as_deref().and_then(|e| serde_json::from_str(e).ok());
    Some(Alert {
        instance: Instance {
            fingerprint: member.row.fingerprint.clone(),
            labels: serde_json::from_str(&member.row.labels).unwrap_or_default(),
            event,
            state: member.state,
            state_since: member.row.state_since,
            value: member.row.value,
            error,
            reminder: if kind == Kind::Repeat { repeat } else { 0 },
            reason: member.row.reason.as_deref().and_then(ResolveReason::parse),
        },
        changed: kind == Kind::Change && changed,
        rule: rule.clone(),
        links: links.clone(),
    })
}

/// The entry of a member in a change's message: keyed when it changed. A resolve because the
/// instance took another way skips the contact points it still reaches there, and is keyed with
/// its own stage `r`, so it never takes the key of the new way's resolve; it frees the key of the
/// firing it resolves, so a later return of the instance is sent again.
fn change_entry(m: &Member, alert: Alert) -> GroupEntry {
    if !m.changed() {
        return GroupEntry::shown(alert);
    }
    if m.state == State::Ok && m.row.reason.as_deref() == Some(ResolveReason::Rerouted.as_str()) {
        let skip = m.row.skip_contact_points.as_deref().and_then(|s| serde_json::from_str(s).ok()).unwrap_or_default();
        let release = m.row.sent_state.as_deref().and_then(State::parse);
        return GroupEntry { alert, keyed: true, stage: Some(REROUTED_STAGE.to_string()), skip, release };
    }
    GroupEntry::keyed(alert)
}

/// The stage of a resolve sent because the instance took another way.
pub const REROUTED_STAGE: &str = "r";

/// Most important first: firing, error, no data, then resolved; by rule and labels after that.
fn order(a: &Member, b: &Member) -> std::cmp::Ordering {
    let rank = |m: &Member| match m.state {
        State::Firing => 0,
        State::Error => 1,
        State::NoData => 2,
        _ => 3,
    };
    rank(a).cmp(&rank(b)).then_with(|| a.row.rule_id.cmp(&b.row.rule_id)).then_with(|| a.row.labels.cmp(&b.row.labels))
}

/// Handles one group in one transaction. Answers the number of messages recorded.
async fn dispatch_one(state: &AppState, view: &OrgView, group_id: &str) -> ApiResult<usize> {
    let now = state.clock.now_ms();
    let mut tx = crate::db::begin(&state.db).await?;
    // The group's row first: two dispatchers (a change of the leader) take it one after the other,
    // and the second finds it handled.
    sqlx::query("UPDATE alert_groups SET due_at = due_at WHERE id = $1").bind(group_id).execute(&mut *tx).await?;
    let group: Option<GroupRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!("{GROUP_COLUMNS} WHERE id = $1")))
        .bind(group_id)
        .fetch_optional(&mut *tx)
        .await?;
    let Some(group) = group.filter(|g| g.due_at <= now) else { return Ok(0) };
    let members: Vec<MemberRow> = sqlx::query_as(
        "SELECT rule_id, fingerprint, labels, match_labels, state, state_since, value, error, reason, sent_state, \
         sent_state_since, skip_contact_points, joined_at FROM alert_group_pending WHERE group_id = $1",
    )
    .bind(group_id)
    .fetch_all(&mut *tx)
    .await?;
    let Some(index) = view.tree.find(&group.policy_id) else {
        // The policy went after the tree was read; its groups go with it.
        return Ok(0);
    };
    if members.is_empty() {
        sqlx::query("DELETE FROM alert_groups WHERE id = $1").bind(group_id).execute(&mut *tx).await?;
        return commit_if_leading(state, tx).await.map(|_| 0);
    }
    let node = view.tree.node(index);
    let mut members: Vec<Member> = members
        .into_iter()
        .map(|row| {
            let labels: Labels = serde_json::from_str(&row.match_labels).unwrap_or_default();
            let silenced = view.silences.iter().any(|(_, m)| m.matches(&labels));
            let state = State::parse(&row.state).unwrap_or(State::Ok);
            Member { row, state, silenced }
        })
        .collect();
    members.sort_by(order);
    let open: Vec<&Member> = members.iter().filter(|m| !m.silenced).collect();
    let counts = Counts {
        changes: open.iter().filter(|m| m.changed()).count(),
        steady: open.iter().filter(|m| m.reporting() && !m.changed()).count(),
        firing: open.iter().filter(|m| m.state == State::Firing).count(),
        firing_from: open
            .iter()
            .filter(|m| m.state == State::Firing)
            .map(|m| m.row.state_since.max(m.row.joined_at))
            .min(),
        firing_silenced: members.iter().filter(|m| m.silenced && m.state == State::Firing).count(),
        silenced: members.iter().filter(|m| m.silenced).count(),
    };
    let times = Times {
        next_send_at: group.next_send_at,
        last_sent_at: group.last_sent_at,
        repeats: group.repeats,
        firing_since: group.firing_since,
        paused_at: group.paused_at,
        escalation_level: group.escalation_level,
    };
    let steps = &node.policy.escalations;
    let decided = plan(&times, &counts, &node.effective, steps, now);
    let mut recorded = 0;
    if decided.change || decided.repeat.is_some() || !decided.escalate.is_empty() {
        let rule_ids: BTreeSet<String> = members.iter().map(|m| m.row.rule_id.clone()).collect();
        let rules = rule_infos(&mut tx, &rule_ids, view.public.as_deref()).await?;
        let path = view.tree.path(index);
        let labels: Labels = serde_json::from_str(&group.labels).unwrap_or_default();
        let template = |kind: Kind, stage: String, level: u32, repeat: u32| GroupMessage {
            version: VERSION,
            event: String::new(),
            delivery_id: String::new(),
            organization: Organization { id: group.org_id.clone(), name: view.org_name.clone() },
            group: GroupInfo {
                id: group.id.clone(),
                key: group.group_key.clone(),
                labels: labels.clone(),
                catch_all: group.catch_all != 0,
                policy: PolicyRef {
                    id: node.policy.id.clone(),
                    name: node.policy.name.clone(),
                    path: path
                        .iter()
                        .map(|n| PathItem { id: n.policy.id.clone(), name: n.policy.name.clone() })
                        .collect(),
                },
                kind,
                stage,
                level,
                repeat,
                firing_since: decided.firing_since,
            },
            alerts: Vec::new(),
            omitted_alerts: 0,
            truncated: false,
            links: GroupLinks::new(view.public.as_deref(), &labels),
            sent_at: now,
        };
        // The contact points of the policy, and those of the steps reached so far.
        let mut reached: Vec<String> = node.effective.contact_point_ids.clone();
        for step in steps.iter().filter(|s| s.level <= group.escalation_level) {
            for cp in &step.contact_point_ids {
                if !reached.contains(cp) {
                    reached.push(cp.clone());
                }
            }
        }
        if decided.change {
            let entries: Vec<GroupEntry> = open
                .iter()
                .filter(|m| m.changed() || m.reporting())
                .filter_map(|m| alert_of(m, &rules, Kind::Change, 0).map(|alert| change_entry(m, alert)))
                .collect();
            let mut entries = entries;
            entries.sort_by_key(|e| !e.keyed);
            recorded +=
                outbox::record_group(&mut tx, &template(Kind::Change, "0".into(), 0, 0), &reached, &entries, now)
                    .await?;
        }
        if let Some(n) = decided.repeat {
            let entries: Vec<GroupEntry> = open
                .iter()
                .filter(|m| m.reporting() && !m.changed())
                .filter_map(|m| alert_of(m, &rules, Kind::Repeat, n).map(GroupEntry::keyed))
                .collect();
            recorded +=
                outbox::record_group(&mut tx, &template(Kind::Repeat, n.to_string(), 0, n), &reached, &entries, now)
                    .await?;
        }
        for level in &decided.escalate {
            let Some(step) = steps.iter().find(|s| s.level == i64::from(*level)) else { continue };
            let entries: Vec<GroupEntry> = open
                .iter()
                .filter(|m| m.reporting())
                .filter_map(|m| alert_of(m, &rules, Kind::Escalation, 0).map(GroupEntry::keyed))
                .collect();
            let stage = format!("e{level}");
            recorded += outbox::record_group(
                &mut tx,
                &template(Kind::Escalation, stage, *level, 0),
                &step.contact_point_ids,
                &entries,
                now,
            )
            .await?;
        }
        if decided.change {
            // What was sent is marked; a sent resolve is the end of the instance in the group.
            for m in open.iter().filter(|m| m.changed()) {
                if m.state == State::Ok {
                    sqlx::query(
                        "DELETE FROM alert_group_pending WHERE group_id = $1 AND rule_id = $2 AND fingerprint = $3",
                    )
                    .bind(group_id)
                    .bind(&m.row.rule_id)
                    .bind(&m.row.fingerprint)
                    .execute(&mut *tx)
                    .await?;
                } else {
                    sqlx::query(
                        "UPDATE alert_group_pending SET sent_state = $1, sent_state_since = $2 \
                         WHERE group_id = $3 AND rule_id = $4 AND fingerprint = $5",
                    )
                    .bind(m.state.as_str())
                    .bind(m.row.state_since)
                    .bind(group_id)
                    .bind(&m.row.rule_id)
                    .bind(&m.row.fingerprint)
                    .execute(&mut *tx)
                    .await?;
                }
            }
        }
    }
    let interval_ms = node.effective.group_interval_secs.saturating_mul(1000);
    let level = decided.escalation_level;
    sqlx::query(
        "UPDATE alert_groups SET next_send_at = $1, due_at = $2, first_sent_at = $3, last_sent_at = $4, repeats = $5, \
         firing_since = $6, paused_at = $7, escalation_level = $8 WHERE id = $9",
    )
    .bind(if decided.change { now.saturating_add(interval_ms) } else { group.next_send_at })
    .bind(decided.due_at)
    .bind(group.first_sent_at.or((decided.change || decided.repeat.is_some()).then_some(now)))
    .bind(if decided.change || decided.repeat.is_some() { Some(now) } else { group.last_sent_at })
    .bind(decided.repeat.map_or(group.repeats, i64::from))
    .bind(decided.firing_since)
    .bind(decided.paused_at)
    .bind(level)
    .bind(group_id)
    .execute(&mut *tx)
    .await?;
    // A group whose last resolve went out is gone.
    let (left,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM alert_group_pending WHERE group_id = $1")
        .bind(group_id)
        .fetch_one(&mut *tx)
        .await?;
    if left == 0 {
        sqlx::query("DELETE FROM alert_groups WHERE id = $1").bind(group_id).execute(&mut *tx).await?;
    }
    if commit_if_leading(state, tx).await? { Ok(recorded) } else { Ok(0) }
}

/// Commits unless this server stopped leading in the meantime (the new leader handles it).
async fn commit_if_leading(state: &AppState, tx: sqlx::Transaction<'static, sqlx::Any>) -> ApiResult<bool> {
    if state.cluster.coordinated() && !state.cluster.is_leader() {
        return Ok(false);
    }
    crate::db::commit(tx).await?;
    Ok(true)
}

/// Runs the dispatcher on the leading server every 5 seconds, and right after an evaluation that
/// changed a group.
pub fn spawn(state: AppState) {
    let stopping = state.background.stopping();
    let background = state.background.clone();
    background.spawn(async move {
        loop {
            let leads = !state.cluster.coordinated() || state.cluster.is_leader();
            if leads && let Err(e) = dispatch_due(&state).await {
                tracing::warn!("alert groups: {}", e.message);
            }
            tokio::select! {
                () = stopping.cancelled() => return,
                () = state.alerting.groups.notified() => {}
                () = tokio::time::sleep(std::time::Duration::from_millis(LOOK_EVERY_MS as u64)) => {}
            }
        }
    });
}

/// A group as `GET /alerting/groups` answers it. A group with members the caller may not see
/// (`dataHidden`) was chosen by data labels, so everything that names or follows from its policy
/// is left out (`null`): which policy it is, its timing and its escalation.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupView {
    pub id: String,
    pub policy_id: Option<String>,
    /// Empty when `dataHidden`.
    pub labels: Labels,
    /// The caller may not read or query the source of every rule in the group: its labels (taken
    /// from the instances) and its policy are left out.
    pub data_hidden: bool,
    pub catch_all: bool,
    /// `waiting`, `firing`, `error`, `no_data` or `ok`.
    pub state: String,
    pub instances: i64,
    pub firing_instances: i64,
    pub silenced_instances: i64,
    pub created_at: i64,
    pub firing_since: Option<i64>,
    pub last_sent_at: Option<i64>,
    pub next_send_at: Option<i64>,
    pub next_repeat_at: Option<i64>,
    pub repeats: Option<i64>,
    pub escalation_level: Option<i64>,
    pub escalation_paused: Option<bool>,
    pub next_escalation_at: Option<i64>,
}

/// The answer of `GET /alerting/groups`: the groups, and how many groups exist whose members the
/// caller may not see (in all, whatever the policy filter).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupList {
    pub items: Vec<GroupView>,
    pub next_cursor: Option<String>,
    pub hidden_groups: i64,
}

/// One member of a group, in short.
struct Short {
    state: String,
    silenced: bool,
    rule_id: String,
}

/// Whether a group has a member of a rule the caller may not see.
fn hidden_group(members: &[Short], visible_rules: &HashSet<String>) -> bool {
    members.iter().any(|m| !visible_rules.contains(&m.rule_id))
}

/// The active groups of the organization (of one policy), by policy and labels. `visible_rules`
/// are the rules whose data the caller may see; filtered by a policy, the groups the caller may
/// not see are left out, since being in a policy's group tells what their labels are.
pub async fn views(
    state: &AppState,
    org_id: &str,
    policy_id: Option<&str>,
    visible_rules: &HashSet<String>,
) -> ApiResult<GroupList> {
    let mut conn = state.db.acquire().await?;
    let tree = Tree::new(org_id, policy::load(&mut conn, org_id).await?);
    let now = state.clock.now_ms();
    let silences = super::evaluate::active_silences(&mut conn, org_id, now).await?;
    let groups: Vec<GroupRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "{GROUP_COLUMNS} WHERE org_id = $1 ORDER BY policy_id, labels, id"
    )))
    .bind(org_id)
    .fetch_all(&mut *conn)
    .await?;
    let rows: Vec<(String, String, String, String, String)> = sqlx::query_as(
        "SELECT p.group_id, p.state, p.match_labels, p.rule_id, r.name FROM alert_group_pending p \
         JOIN alert_rules r ON r.id = p.rule_id WHERE p.org_id = $1",
    )
    .bind(org_id)
    .fetch_all(&mut *conn)
    .await?;
    let mut members: HashMap<String, Vec<Short>> = HashMap::new();
    for (group_id, member_state, labels, rule_id, rule_name) in rows {
        // A member whose labels the caller may not see is matched by its rule's name only, so
        // `silencedInstances` tells nothing about hidden labels.
        let labels: Labels = if visible_rules.contains(&rule_id) {
            serde_json::from_str(&labels).unwrap_or_default()
        } else {
            [(super::rule::RULE_NAME_LABEL.to_string(), rule_name)].into()
        };
        let silenced = silences.iter().any(|(_, m)| m.matches(&labels));
        members.entry(group_id).or_default().push(Short { state: member_state, silenced, rule_id });
    }
    let mut out = Vec::new();
    let mut hidden_groups = 0;
    for g in groups {
        let Some(mine) = members.get(&g.id).filter(|m| !m.is_empty()) else { continue };
        let hidden = hidden_group(mine, visible_rules);
        hidden_groups += i64::from(hidden);
        if policy_id.is_some_and(|p| hidden || p != g.policy_id) {
            continue;
        }
        let node = tree.find(&g.policy_id).map(|i| tree.node(i));
        let worst = ["firing", "error", "no_data"].into_iter().find(|s| mine.iter().any(|m| m.state == *s));
        let state = match (g.first_sent_at, worst) {
            (None, _) => "waiting",
            (Some(_), Some(s)) => s,
            (Some(_), None) => "ok",
        };
        let next_repeat_at = node
            .and_then(|n| n.effective.repeat_ms())
            .zip(g.last_sent_at)
            .filter(|_| worst.is_some())
            .map(|(every, last)| last.saturating_add(every));
        let next_escalation_at = node.and_then(|n| {
            let step = n.policy.escalations.iter().find(|s| s.level > g.escalation_level)?;
            let since = g.firing_since.filter(|_| g.paused_at.is_none() && g.last_sent_at.is_some())?;
            Some(since.saturating_add(step.wait_secs.saturating_mul(1000)))
        });
        let count = |f: &dyn Fn(&Short) -> bool| i64::try_from(mine.iter().filter(|m| f(m)).count()).unwrap_or(0);
        let shown = !hidden;
        out.push(GroupView {
            policy_id: shown.then(|| g.policy_id.clone()),
            labels: if hidden { Labels::new() } else { serde_json::from_str(&g.labels).unwrap_or_default() },
            data_hidden: hidden,
            catch_all: shown && g.catch_all != 0,
            state: state.to_string(),
            instances: count(&|_| true),
            firing_instances: count(&|m| m.state == "firing"),
            silenced_instances: count(&|m| m.silenced),
            created_at: g.created_at,
            firing_since: g.firing_since,
            last_sent_at: g.last_sent_at,
            next_send_at: shown.then_some(g.next_send_at),
            next_repeat_at: next_repeat_at.filter(|_| shown),
            repeats: shown.then_some(g.repeats),
            escalation_level: shown.then_some(g.escalation_level),
            escalation_paused: shown.then_some(g.paused_at.is_some()),
            next_escalation_at: next_escalation_at.filter(|_| shown),
            id: g.id,
        });
    }
    Ok(GroupList { items: out, next_cursor: None, hidden_groups })
}

/// The number of groups with instances per policy of the organization, counting only groups all
/// of whose members are of `visible_rules` (a group the caller may not see would tell its
/// policy's labels), and the number of the others.
pub async fn active_per_policy(
    conn: &mut AnyConnection,
    org_id: &str,
    visible_rules: &HashSet<String>,
) -> ApiResult<(HashMap<String, i64>, i64)> {
    let rows: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT g.id, g.policy_id, p.rule_id FROM alert_groups g JOIN alert_group_pending p ON p.group_id = g.id \
         WHERE g.org_id = $1",
    )
    .bind(org_id)
    .fetch_all(&mut *conn)
    .await?;
    let mut groups: HashMap<String, (String, bool)> = HashMap::new();
    for (group_id, policy_id, rule_id) in rows {
        let entry = groups.entry(group_id).or_insert((policy_id, false));
        entry.1 |= !visible_rules.contains(&rule_id);
    }
    let mut counts: HashMap<String, i64> = HashMap::new();
    let mut hidden = 0;
    for (policy_id, is_hidden) in groups.into_values() {
        if is_hidden {
            hidden += 1;
        } else {
            *counts.entry(policy_id).or_default() += 1;
        }
    }
    Ok((counts, hidden))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::alerting::policy::{Effective, Escalation};

    const SEC: i64 = 1000;
    const MIN: i64 = 60 * SEC;

    fn effective(wait: i64, interval: i64, repeat: i64) -> Effective {
        Effective {
            group_by: vec!["alertname".into()],
            group_wait_secs: wait,
            group_interval_secs: interval,
            repeat_interval_secs: repeat,
            contact_point_ids: vec!["cp".into()],
            contact_points_from: None,
            delivers: true,
        }
    }

    fn steps() -> Vec<Escalation> {
        vec![
            Escalation { level: 1, wait_secs: 15 * 60, contact_point_ids: vec!["on-call".into()] },
            Escalation { level: 2, wait_secs: 45 * 60, contact_point_ids: vec!["lead".into()] },
        ]
    }

    fn firing(n: usize, from: i64) -> Counts {
        Counts { firing: n, firing_from: Some(from), ..Counts::default() }
    }

    /// Applies a plan the way the dispatcher stores it.
    fn apply(t: &mut Times, p: &Plan, e: &Effective, now: i64) {
        if p.change {
            t.next_send_at = now + e.group_interval_secs * SEC;
        }
        if p.change || p.repeat.is_some() {
            t.last_sent_at = Some(now);
        }
        if let Some(n) = p.repeat {
            t.repeats = i64::from(n);
        }
        t.firing_since = p.firing_since;
        t.paused_at = p.paused_at;
        if let Some(l) = p.escalate.last() {
            t.escalation_level = i64::from(*l);
        }
    }

    /// The board's timeline: wait 30 s, interval 5 min, repeat 1 h, steps after 15 and 45 minutes;
    /// a silence holds the count, step 2 is dropped when the group resolves first.
    #[test]
    fn grouping_timing_follows_wait_interval_repeat_and_escalation_with_a_fake_clock() {
        let e = effective(30, 300, 3600);
        let start = 1_000 * MIN;
        let mut t = Times { next_send_at: start + 30 * SEC, ..Times::default() };

        // 14:02:00 the first instance fires: nothing before the group wait.
        let p = plan(&t, &Counts { changes: 1, ..firing(1, start) }, &e, &steps(), start);
        assert!(!p.change);
        assert_eq!(p.firing_since, Some(start));
        assert_eq!(p.due_at, start + 30 * SEC);
        apply(&mut t, &p, &e, start);
        // 14:02:30 two instances, first message.
        let now = start + 30 * SEC;
        let p = plan(&t, &Counts { changes: 2, ..firing(2, start) }, &e, &steps(), now);
        assert!(p.change && p.repeat.is_none() && p.escalate.is_empty());
        apply(&mut t, &p, &e, now);
        assert_eq!(t.next_send_at, now + 5 * MIN);
        // 14:04 a third: waits for the group interval.
        let now = start + 2 * MIN;
        let p = plan(&t, &Counts { changes: 1, steady: 2, ..firing(3, start) }, &e, &steps(), now);
        assert!(!p.change);
        assert_eq!(p.due_at, start + 30 * SEC + 5 * MIN);
        apply(&mut t, &p, &e, now);
        // 14:07:30 the change goes out.
        let now = start + 30 * SEC + 5 * MIN;
        let p = plan(&t, &Counts { changes: 1, steady: 2, ..firing(3, start) }, &e, &steps(), now);
        assert!(p.change);
        apply(&mut t, &p, &e, now);
        // The next look is step 1 at 14:17.
        let p = plan(&t, &Counts { steady: 3, ..firing(3, start) }, &e, &steps(), now + SEC);
        assert_eq!(p.due_at, start + 15 * MIN);
        // 14:17 step 1.
        let now = start + 15 * MIN;
        let p = plan(&t, &Counts { steady: 3, ..firing(3, start) }, &e, &steps(), now);
        assert_eq!(p.escalate, [1]);
        assert!(!p.change && p.repeat.is_none());
        apply(&mut t, &p, &e, now);
        // 14:32 silenced: the count holds.
        let silenced = Counts { firing_silenced: 3, silenced: 3, ..Counts::default() };
        let now = start + 30 * MIN;
        let p = plan(&t, &silenced, &e, &steps(), now);
        assert_eq!(p.paused_at, Some(now));
        assert!(p.escalate.is_empty());
        assert_eq!(p.due_at, now + SILENCE_RECHECK_MS);
        apply(&mut t, &p, &e, now);
        // Still silenced at 14:47, past step 2's 45 minutes: nothing.
        let p = plan(&t, &silenced, &e, &steps(), start + 45 * MIN);
        assert!(p.escalate.is_empty());
        // 15:32 the silence ends: the count goes on from 30 minutes, step 2 is 15 minutes away.
        let now = start + 90 * MIN;
        let p = plan(&t, &Counts { steady: 3, ..firing(3, start) }, &e, &steps(), now);
        assert_eq!(p.paused_at, None);
        assert_eq!(p.firing_since, Some(start + 60 * MIN));
        assert!(p.escalate.is_empty());
        // The repeat, an hour after the last message (14:07:30), is long due.
        assert_eq!(p.repeat, Some(1));
        apply(&mut t, &p, &e, now);
        assert_eq!(t.last_sent_at, Some(now));
        // Resolved before step 2: the count is over, step 2 is dropped.
        let now = start + 100 * MIN;
        let p = plan(&t, &Counts { changes: 3, ..Counts::default() }, &e, &steps(), now);
        assert!(p.change);
        assert_eq!(p.firing_since, None);
        assert!(p.escalate.is_empty());
    }

    #[test]
    fn repeats_count_from_the_last_message_and_can_be_off() {
        let now = 500 * MIN;
        let t = Times { next_send_at: 0, last_sent_at: Some(now - 4 * 60 * MIN), repeats: 2, ..Times::default() };
        let p = plan(&t, &Counts { steady: 1, ..firing(1, 0) }, &effective(30, 300, 4 * 3600), &[], now);
        assert_eq!(p.repeat, Some(3));
        let p = plan(&t, &Counts { steady: 1, ..firing(1, 0) }, &effective(30, 300, 0), &[], now);
        assert_eq!(p.repeat, None, "off");
        // A repeat shorter than the interval acts as the interval.
        let t = Times { last_sent_at: Some(now - 2 * MIN), ..t };
        let p = plan(&t, &Counts { steady: 1, ..firing(1, 0) }, &effective(30, 300, 60), &[], now);
        assert_eq!(p.repeat, None);
        // Nothing to repeat without a reporting instance that was sent.
        let t = Times { last_sent_at: Some(now - 5 * 60 * MIN), ..t };
        assert_eq!(plan(&t, &Counts::default(), &effective(30, 300, 3600), &[], now).repeat, None);
    }

    #[test]
    fn steps_that_are_all_due_at_once_go_out_in_order() {
        let now = 500 * MIN;
        let t = Times { firing_since: Some(now - 50 * MIN), last_sent_at: Some(now - MIN), ..Times::default() };
        let p = plan(&t, &Counts { steady: 1, ..firing(1, now - 50 * MIN) }, &effective(30, 300, 0), &steps(), now);
        assert_eq!(p.escalate, [1, 2]);
        // Nothing firing (only errors): no step.
        let p = plan(&t, &Counts { steady: 1, ..Counts::default() }, &effective(30, 300, 0), &steps(), now);
        assert!(p.escalate.is_empty());
        assert_eq!(p.firing_since, None);
    }

    #[test]
    fn no_step_before_the_first_message_and_the_level_resets_when_nothing_fires() {
        let now = 500 * MIN;
        // Long firing (it came from another way), but the group has not sent yet: its wait first.
        let t = Times { next_send_at: now + 30 * SEC, ..Times::default() };
        let p = plan(&t, &Counts { changes: 1, ..firing(1, now - 50 * MIN) }, &effective(30, 300, 0), &steps(), now);
        assert!(!p.change && p.escalate.is_empty());
        assert_eq!(p.due_at, now + 30 * SEC);
        // Sent: the steps follow (counted from the firing start the dispatcher gives).
        let t = Times { last_sent_at: Some(now), escalation_level: 2, firing_since: Some(now - 50 * MIN), ..t };
        let p = plan(&t, &Counts { steady: 1, ..firing(1, now - 50 * MIN) }, &effective(30, 300, 0), &steps(), now);
        assert_eq!(p.escalation_level, 2);
        // Nothing fires any more: the level is 0 again, so the next firing starts from step 1.
        let p = plan(&t, &Counts { steady: 1, ..Counts::default() }, &effective(30, 300, 0), &steps(), now);
        assert_eq!(p.escalation_level, 0);
        assert_eq!(p.firing_since, None);
    }
}
