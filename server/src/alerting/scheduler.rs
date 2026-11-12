//! The scheduler (docs/PLAN.md section 13, "Auswertung"): evaluates every rule that is not
//! paused, of organizations with alerting on, at its interval, on the leading server only.
//!
//! Each rule has a fixed offset within its interval, from its id ([`slot`]), so rules do not all
//! run at the full minute. A rule is due at the latest slot it has not been evaluated for; it
//! starts when the limits allow it: at most `alerting.max_concurrent` evaluations on the server,
//! the organization's `max_concurrent_per_org`, and per data source the lower of the server's and
//! the source's own limit (`Limits::datasource_concurrency`). Organizations take turns, so one with
//! many rules does not hold up the others. A slot that passes before its rule could start is
//! skipped, not caught up: it is counted on the rule (`skipped_evaluations`) and in the metrics.
//!
//! After a restart, or when another server becomes the leader, a rule continues with its current
//! slot unless the database says that slot was evaluated (`alert_rules.last_evaluated_at`, the
//! tick of the last evaluation); slots missed while no server ran are neither caught up nor
//! counted. A clock that goes back is logged, and the rules continue at their current slot.
//!
//! The rules and the organizations' settings are read at most every 10 seconds, and at the next
//! look after a rule or an opt-in changed on this server; a change of an alerting setting, or one
//! made on another server, applies within those 10 seconds.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::time::Duration;

use sha2::{Digest, Sha256};

use crate::app::AppState;
use crate::auth::ratelimit::{Capacity, RateLimiter};
use crate::error::ApiResult;
use crate::locks::MutexExt;

/// How often the scheduler looks for due rules.
const LOOK_EVERY: Duration = Duration::from_secs(1);
/// Previews per person and minute.
pub const PREVIEWS_PER_MINUTE: u32 = 20;
/// Test sends per contact point and minute.
pub const TESTS_PER_MINUTE: u32 = 5;

/// How long the scheduler keeps the rules and organization settings it read before it reads them
/// again; the rule and opt-in routes make it read at the next look ([`Alerting::changed`]).
const REREAD_MS: i64 = 10_000;

/// The rules the scheduler read, with when (monotonic) and the server's limit.
struct Cached {
    read_at: i64,
    candidates: Vec<Candidate>,
    max_total: u64,
}

/// Alerting's part of the server's state.
pub struct Alerting {
    planner: std::sync::Mutex<Planner>,
    cache: std::sync::Mutex<Option<Cached>>,
    /// Wakes the delivery worker after an evaluation recorded a message.
    pub outbox: tokio::sync::Notify,
    /// Wakes the group dispatcher after an evaluation changed a group.
    pub groups: tokio::sync::Notify,
    /// Previews of the rule editor, per person.
    pub previews: RateLimiter,
    /// Test sends, per contact point.
    pub tests: RateLimiter,
}

impl Default for Alerting {
    fn default() -> Self {
        Self {
            planner: std::sync::Mutex::new(Planner::default()),
            cache: std::sync::Mutex::new(None),
            outbox: tokio::sync::Notify::new(),
            groups: tokio::sync::Notify::new(),
            previews: RateLimiter::new(PREVIEWS_PER_MINUTE, 60, Capacity::SMALL),
            tests: RateLimiter::new(TESTS_PER_MINUTE, 60, Capacity::SMALL),
        }
    }
}

impl Alerting {
    /// Rules, sources or alerting settings changed: the scheduler reads them at its next look.
    pub fn changed(&self) {
        *self.cache.lock_or_recover() = None;
    }
}

/// The rule's fixed offset within its interval, from its id.
fn offset(rule_id: &str, interval_ms: i64) -> i64 {
    let digest = Sha256::digest(rule_id.as_bytes());
    let n = u64::from_be_bytes(digest[..8].try_into().expect("8 bytes"));
    i64::try_from(n % u64::try_from(interval_ms.max(1)).unwrap_or(1)).unwrap_or(0)
}

/// The latest scheduled time of the rule at or before `now`: `offset + k * interval`.
pub fn slot(rule_id: &str, interval_ms: i64, now: i64) -> i64 {
    let interval = interval_ms.max(1);
    let offset = offset(rule_id, interval);
    (now - offset).div_euclid(interval) * interval + offset
}

/// A rule the scheduler may start, with the limits in force for it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Candidate {
    pub rule_id: String,
    pub org_id: String,
    pub datasource_id: String,
    pub interval_ms: i64,
    /// The tick of its last evaluation, as stored.
    pub last_evaluated_at: Option<i64>,
    /// Evaluations of its organization at once.
    pub org_limit: u64,
    /// Evaluations on its data source at once.
    pub datasource_limit: u64,
}

/// An evaluation to start: the rule and its scheduled time.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Start {
    pub rule_id: String,
    pub org_id: String,
    pub datasource_id: String,
    pub tick: i64,
}

#[derive(Clone, Copy, Debug, Default)]
struct RuleState {
    /// The last slot started (or found evaluated in the database).
    done: Option<i64>,
    /// The slot that is due and not started yet.
    owed: Option<i64>,
}

/// Which rules start when: pure, so it can be tested with any clock.
#[derive(Debug, Default)]
pub struct Planner {
    rules: HashMap<String, RuleState>,
    running: HashSet<String>,
    per_org: HashMap<String, u64>,
    per_datasource: HashMap<String, u64>,
    total: u64,
    /// Which organization goes first next time.
    turn: usize,
    /// The time of the last look, to notice a clock that went back.
    last_now: Option<i64>,
}

impl Planner {
    /// The evaluations to start at `now`, and per rule the slots that passed before it could
    /// start (skipped).
    pub fn plan(&mut self, now: i64, candidates: &[Candidate], max_total: u64) -> (Vec<Start>, Vec<(String, i64)>) {
        let mut skipped = Vec::new();
        let mut due: BTreeMap<&str, Vec<(&Candidate, i64)>> = BTreeMap::new();
        let known: HashSet<&str> = candidates.iter().map(|c| c.rule_id.as_str()).collect();
        if let Some(last) = self.last_now
            && now.saturating_add(1000) < last
        {
            // The clock went back: slots done in what is now the future would hold the rules back
            // until the clock catches up. They continue at their current slot instead.
            tracing::warn!(
                "the system clock went back by {} ms; alert rules continue at their current slot",
                last - now
            );
            for rule in self.rules.values_mut() {
                if rule.done.is_some_and(|d| d > now) {
                    rule.done = None;
                    rule.owed = None;
                }
            }
        }
        self.last_now = Some(now);
        // Rules that went (deleted, paused, alerting off) are forgotten unless still running.
        self.rules.retain(|id, _| known.contains(id.as_str()) || self.running.contains(id));
        for c in candidates {
            let s = slot(&c.rule_id, c.interval_ms, now);
            let rule = self.rules.entry(c.rule_id.clone()).or_default();
            // What another server or an earlier run of this one evaluated counts as done.
            // A stored tick beyond the current slot was written under a clock that went back since.
            let stored = c.last_evaluated_at.filter(|l| *l <= now.saturating_add(c.interval_ms));
            rule.done = rule.done.max(stored);
            if rule.done.is_some_and(|d| d >= s) {
                rule.owed = None;
                continue;
            }
            if let Some(owed) = rule.owed
                && owed < s
            {
                // The slot passed before the rule could start.
                skipped.push((c.rule_id.clone(), (s - owed) / c.interval_ms.max(1)));
            }
            rule.owed = Some(s);
            if !self.running.contains(&c.rule_id) {
                due.entry(c.org_id.as_str()).or_default().push((c, s));
            }
        }
        // Organizations take turns: one rule of each in a round, starting with a different one
        // each time.
        let mut queues: Vec<std::collections::VecDeque<(&Candidate, i64)>> = due
            .into_values()
            .map(|mut rules| {
                rules.sort_by_key(|(c, s)| (*s, c.rule_id.clone()));
                rules.into()
            })
            .collect();
        let orgs = queues.len();
        let mut starts = Vec::new();
        if orgs > 0 {
            queues.rotate_left(self.turn % orgs);
            self.turn = self.turn.wrapping_add(1);
        }
        let mut progress = true;
        while progress && self.total < max_total {
            progress = false;
            for queue in queues.iter_mut() {
                if self.total >= max_total {
                    break;
                }
                // The first rule of this organization that the limits allow now.
                let pick = queue.iter().position(|(c, _)| {
                    self.per_org.get(&c.org_id).copied().unwrap_or(0) < c.org_limit
                        && self.per_datasource.get(&c.datasource_id).copied().unwrap_or(0) < c.datasource_limit
                });
                let Some(at) = pick else { continue };
                let (c, s) = queue.remove(at).expect("position is in the queue");
                self.running.insert(c.rule_id.clone());
                *self.per_org.entry(c.org_id.clone()).or_default() += 1;
                *self.per_datasource.entry(c.datasource_id.clone()).or_default() += 1;
                self.total += 1;
                let rule = self.rules.entry(c.rule_id.clone()).or_default();
                rule.done = Some(s);
                rule.owed = None;
                starts.push(Start {
                    rule_id: c.rule_id.clone(),
                    org_id: c.org_id.clone(),
                    datasource_id: c.datasource_id.clone(),
                    tick: s,
                });
                progress = true;
            }
        }
        (starts, skipped)
    }

    /// An evaluation ended.
    pub fn finished(&mut self, start: &Start) {
        if self.running.remove(&start.rule_id) {
            self.total = self.total.saturating_sub(1);
            for (map, key) in [(&mut self.per_org, &start.org_id), (&mut self.per_datasource, &start.datasource_id)] {
                if let Some(n) = map.get_mut(key) {
                    *n = n.saturating_sub(1);
                    if *n == 0 {
                        map.remove(key);
                    }
                }
            }
        }
    }

    /// Forgets what it knew of the rules (not the running evaluations): another server led for
    /// a while, so the database decides again.
    fn forget(&mut self) {
        self.rules.retain(|id, _| self.running.contains(id));
    }
}

type CandidateRow = (String, String, String, i64, Option<i64>, Option<i64>);

/// The rules to consider now, with the limits in force, from organizations with alerting on.
/// Empty while alerting is off for the server. Also answers the server's limit of evaluations.
async fn candidates(state: &AppState) -> ApiResult<(Vec<Candidate>, u64)> {
    let server_on = crate::settings::get(state, "alerting.enabled").await?.as_bool().unwrap_or(true);
    if !server_on {
        return Ok((Vec::new(), 0));
    }
    let rows: Vec<CandidateRow> = sqlx::query_as(
        "SELECT r.id, r.org_id, r.datasource_id, r.interval_secs, r.last_evaluated_at, d.alerting_max_concurrent \
         FROM alert_rules r JOIN datasources d ON d.id = r.datasource_id WHERE r.paused = 0 ORDER BY r.org_id, r.id",
    )
    .fetch_all(&state.db)
    .await?;
    let mut orgs: HashMap<String, Option<super::limits::Limits>> = HashMap::new();
    let mut max_total = 0;
    let mut out = Vec::with_capacity(rows.len());
    for (rule_id, org_id, datasource_id, interval_secs, last_evaluated_at, source_limit) in rows {
        if !orgs.contains_key(&org_id) {
            let on = super::limits::switch(state, &org_id).await?.enabled();
            let limits = if on { Some(super::limits::for_org(state, &org_id).await?) } else { None };
            orgs.insert(org_id.clone(), limits);
        }
        let Some(limits) = orgs.get(&org_id).and_then(Option::as_ref) else { continue };
        max_total = limits.max_concurrent;
        out.push(Candidate {
            rule_id,
            org_id,
            datasource_id,
            interval_ms: interval_secs.saturating_mul(1000).max(1000),
            last_evaluated_at,
            org_limit: limits.max_concurrent_per_org,
            datasource_limit: limits.datasource_concurrency(source_limit),
        });
    }
    Ok((out, max_total))
}

/// Plans one look at the rules: the evaluations to start now. Skipped slots are counted on their
/// rules here. Nothing on a server that does not lead.
pub async fn due(state: &AppState) -> ApiResult<Vec<Start>> {
    if state.cluster.coordinated() && !state.cluster.is_leader() {
        state.alerting.planner.lock_or_recover().forget();
        state.alerting.changed();
        return Ok(Vec::new());
    }
    let mono = state.clock.monotonic_ms();
    let cached = {
        let cache = state.alerting.cache.lock_or_recover();
        cache
            .as_ref()
            .filter(|c| mono >= c.read_at && mono - c.read_at < REREAD_MS)
            .map(|c| (c.candidates.clone(), c.max_total))
    };
    let (candidates, max_total) = match cached {
        Some(found) => found,
        None => {
            let (candidates, max_total) = candidates(state).await?;
            *state.alerting.cache.lock_or_recover() =
                Some(Cached { read_at: mono, candidates: candidates.clone(), max_total });
            (candidates, max_total)
        }
    };
    let now = state.clock.now_ms();
    let (starts, skipped) = state.alerting.planner.lock_or_recover().plan(now, &candidates, max_total);
    for (rule_id, n) in skipped {
        state.metrics.alert_skipped(u64::try_from(n).unwrap_or(0));
        sqlx::query("UPDATE alert_rules SET skipped_evaluations = skipped_evaluations + $1 WHERE id = $2")
            .bind(n)
            .bind(&rule_id)
            .execute(&state.db)
            .await?;
    }
    Ok(starts)
}

/// Evaluates `start` and frees its place, however it ended.
pub async fn run(state: &AppState, start: &Start) {
    if let Err(e) = super::evaluate::evaluate(state, &start.rule_id, start.tick).await {
        tracing::warn!(rule_id = %start.rule_id, "alert rule evaluation failed: {}", e.message);
        if let Err(e) = super::evaluate::record_failure(state, &start.rule_id, start.tick).await {
            tracing::warn!(rule_id = %start.rule_id, "the failed evaluation cannot be recorded: {}", e.message);
        }
    }
    state.alerting.planner.lock_or_recover().finished(start);
}

/// One look at the rules with every due evaluation run to its end (tests drive the scheduler with
/// a manual clock through this).
#[doc(hidden)]
pub async fn run_due(state: &AppState) -> ApiResult<usize> {
    let starts = due(state).await?;
    let n = starts.len();
    futures_util::future::join_all(starts.iter().map(|s| run(state, s))).await;
    Ok(n)
}

/// Runs the scheduler, the group dispatcher and the delivery worker until the server stops.
pub fn spawn(state: AppState) {
    super::outbox::spawn(state.clone());
    super::groups::spawn(state.clone());
    let stopping = state.background.stopping();
    let background = state.background.clone();
    background.spawn(async move {
        loop {
            tokio::select! {
                () = stopping.cancelled() => return,
                () = tokio::time::sleep(LOOK_EVERY) => {}
            }
            match due(&state).await {
                Ok(starts) => {
                    for start in starts {
                        let state = state.clone();
                        state.background.clone().spawn(async move { run(&state, &start).await });
                    }
                }
                Err(e) => tracing::warn!("alerting scheduler: {}", e.message),
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIN: i64 = 60_000;

    fn rule(id: &str, org: &str, ds: &str) -> Candidate {
        Candidate {
            rule_id: id.into(),
            org_id: org.into(),
            datasource_id: ds.into(),
            interval_ms: MIN,
            last_evaluated_at: None,
            org_limit: 4,
            datasource_limit: 2,
        }
    }

    #[test]
    fn slots_have_a_fixed_offset_within_the_interval() {
        let a = slot("rule-a", MIN, 10 * MIN + 59_999);
        let b = slot("rule-b", MIN, 10 * MIN + 59_999);
        assert_ne!(a.rem_euclid(MIN), b.rem_euclid(MIN), "different rules, different offsets");
        for now in [10 * MIN, 10 * MIN + 30_000, 11 * MIN - 1] {
            let s = slot("rule-a", MIN, now);
            assert!(s <= now && now - s < MIN);
            assert_eq!(s.rem_euclid(MIN), a.rem_euclid(MIN));
        }
    }

    #[test]
    fn a_rule_runs_once_per_slot_with_a_fake_clock() {
        let mut p = Planner::default();
        let rules = [rule("r", "o", "d")];
        let t0 = slot("r", MIN, 100 * MIN);
        let (starts, skipped) = p.plan(t0, &rules, 8);
        assert_eq!(starts.len(), 1);
        assert_eq!(starts[0].tick, t0);
        assert!(skipped.is_empty());
        p.finished(&starts[0]);
        // The same slot again: nothing; the next one: once more, at its scheduled time.
        assert!(p.plan(t0 + 30_000, &rules, 8).0.is_empty());
        let (starts, _) = p.plan(t0 + MIN + 5, &rules, 8);
        assert_eq!(starts[0].tick, t0 + MIN);
    }

    #[test]
    fn a_slot_that_passes_while_the_rule_runs_is_skipped_not_caught_up() {
        let mut p = Planner::default();
        let rules = [rule("r", "o", "d")];
        let t0 = slot("r", MIN, 100 * MIN);
        let (first, _) = p.plan(t0, &rules, 8);
        // Still running at the next two slots.
        let (starts, skipped) = p.plan(t0 + MIN, &rules, 8);
        assert!(starts.is_empty() && skipped.is_empty());
        let (starts, skipped) = p.plan(t0 + 2 * MIN, &rules, 8);
        assert!(starts.is_empty());
        assert_eq!(skipped, vec![("r".to_string(), 1)]);
        p.finished(&first[0]);
        let (starts, skipped) = p.plan(t0 + 2 * MIN + 10, &rules, 8);
        assert_eq!(starts[0].tick, t0 + 2 * MIN, "the current slot, not the missed one");
        assert!(skipped.is_empty());
    }

    #[test]
    fn a_restart_continues_with_the_current_slot() {
        let t0 = slot("r", MIN, 100 * MIN);
        let mut stored = rule("r", "o", "d");
        stored.last_evaluated_at = Some(t0);
        // A new planner (after a restart) knows the slot from the database.
        let mut p = Planner::default();
        assert!(p.plan(t0 + 10, std::slice::from_ref(&stored), 8).0.is_empty());
        // Down for an hour: the current slot runs, nothing is caught up or counted.
        let mut p = Planner::default();
        let (starts, skipped) = p.plan(t0 + 60 * MIN + 1, &[stored], 8);
        assert_eq!(starts[0].tick, t0 + 60 * MIN);
        assert!(skipped.is_empty());
    }

    #[test]
    fn a_clock_that_goes_back_does_not_hold_rules_back() {
        let mut p = Planner::default();
        let rules = [rule("r", "o", "d")];
        let t0 = slot("r", MIN, 1000 * MIN);
        let (first, _) = p.plan(t0, &rules, 8);
        p.finished(&first[0]);
        // A day back: the rule continues at its slot of that time, not a day later.
        let back = t0 - 1440 * MIN;
        let (starts, _) = p.plan(back + 1, &rules, 8);
        assert_eq!(starts.len(), 1);
        assert_eq!(starts[0].tick, slot("r", MIN, back + 1));
        // A stored tick from the future is no reason to wait either.
        let mut stored = rule("r2", "o", "d2");
        stored.last_evaluated_at = Some(t0);
        let mut p = Planner::default();
        assert_eq!(p.plan(back, &[stored], 8).0.len(), 1);
    }

    #[test]
    fn limits_hold_and_organizations_take_turns() {
        let mut p = Planner::default();
        let mut rules = Vec::new();
        for i in 0..6 {
            rules.push(Candidate { org_limit: 4, datasource_limit: 10, ..rule(&format!("a{i}"), "big", "d-big") });
        }
        rules.push(Candidate { datasource_limit: 10, ..rule("b0", "small", "d-small") });
        // Every slot due at once: look after the latest offset.
        let now = 100 * MIN + MIN - 1;
        let (starts, _) = p.plan(now, &rules, 3);
        assert_eq!(starts.len(), 3, "the server's limit");
        assert!(starts.iter().any(|s| s.org_id == "small"), "the small organization is not held up: {starts:?}");
        for s in &starts {
            p.finished(s);
        }
        // Per organization and per data source.
        let mut p = Planner::default();
        let rules: Vec<Candidate> = (0..6)
            .map(|i| Candidate { org_limit: 4, datasource_limit: 2, ..rule(&format!("a{i}"), "o", "d") })
            .collect();
        assert_eq!(p.plan(now, &rules, 8).0.len(), 2, "two on one data source");
        let mut p = Planner::default();
        let rules: Vec<Candidate> = (0..6)
            .map(|i| Candidate { org_limit: 4, datasource_limit: 2, ..rule(&format!("a{i}"), "o", &format!("d{i}")) })
            .collect();
        assert_eq!(p.plan(now, &rules, 8).0.len(), 4, "four in one organization");
    }

    #[test]
    fn rules_that_wait_for_a_place_are_skipped_once_their_slot_passes() {
        let mut p = Planner::default();
        let rules = [
            Candidate { datasource_limit: 1, ..rule("x", "o", "d") },
            Candidate { datasource_limit: 1, ..rule("y", "o", "d") },
        ];
        let now = 100 * MIN + MIN - 1;
        let (first, _) = p.plan(now, &rules, 8);
        assert_eq!(first.len(), 1);
        let waiting = if first[0].rule_id == "x" { "y" } else { "x" };
        // The one waiting misses its slot while the other keeps running.
        let (starts, skipped) = p.plan(now + MIN, &rules, 8);
        assert!(starts.is_empty());
        assert_eq!(skipped, vec![(waiting.to_string(), 1)]);
    }
}
