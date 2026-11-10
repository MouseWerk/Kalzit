//! The state machine per instance (docs/PLAN.md, section 13, "Zustände" and
//! "Benachrichtigungen"): from the stored instance states and one evaluation's outcome to the new
//! states, the transitions for the history and the notifications to send. The spellings of states
//! and behaviors are the stored ones (`alerting::rule::STATES`, `NO_DATA_STATES`, `ERROR_STATES`).

use std::time::Duration;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::reduce::{Reduced, is_count, reduce};
use super::{EvalError, Labels};
use crate::alerting::rule::{Condition, Op, Reduce};
use crate::shapes::QueryResult;

/// A series that is missing from this many evaluations in a row ends as an instance.
pub const MISSING_EVALUATIONS_TO_END: u32 = 3;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum State {
    Ok,
    Pending,
    Firing,
    NoData,
    Error,
}

impl State {
    /// Firing, no data and error are reported states: entering one notifies, leaving one for OK
    /// resolves.
    pub fn is_active(self) -> bool {
        matches!(self, State::Firing | State::NoData | State::Error)
    }

    pub fn as_str(self) -> &'static str {
        match self {
            State::Ok => "ok",
            State::Pending => "pending",
            State::Firing => "firing",
            State::NoData => "no_data",
            State::Error => "error",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        [State::Ok, State::Pending, State::Firing, State::NoData, State::Error].into_iter().find(|s| s.as_str() == text)
    }
}

/// What happens when an instance has no data (`alert_rules.no_data_state`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NoDataBehavior {
    /// The state "no data" (after the for-duration).
    NoData,
    Ok,
    /// As if the condition were met.
    Firing,
}

impl NoDataBehavior {
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "no_data" => Some(Self::NoData),
            "ok" => Some(Self::Ok),
            "firing" => Some(Self::Firing),
            _ => None,
        }
    }
}

/// What happens when an evaluation fails (`alert_rules.error_state`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ErrorBehavior {
    /// The state "error" (after the for-duration).
    #[serde(rename = "error")]
    Error,
    /// The instance keeps the state it had.
    #[serde(rename = "keep")]
    Keep,
}

impl ErrorBehavior {
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "error" => Some(Self::Error),
            "keep" => Some(Self::Keep),
            _ => None,
        }
    }
}

/// The parts of a rule the state machine needs.
#[derive(Clone, Debug, PartialEq)]
pub struct RuleTiming {
    pub rule_id: String,
    /// The evaluation interval: a tenth of it is the tolerance for the for-duration and
    /// reminders, so an evaluation that starts a little late still counts as on time.
    pub interval: Duration,
    /// How long a reported state must hold before it is entered; 0 enters it at once.
    pub for_duration: Duration,
    pub no_data: NoDataBehavior,
    pub error: ErrorBehavior,
    /// Reminder while a reported state lasts; `None` is off.
    pub reminder: Option<Duration>,
}

impl RuleTiming {
    /// Whether `wait` has passed from `since` to `tick`, within the tolerance.
    fn elapsed(&self, since: i64, tick: i64, wait: Duration) -> bool {
        let tolerance = millis(self.interval) / 10;
        tick.saturating_sub(since).saturating_add(tolerance) >= millis(wait)
    }
}

/// A reported state the instance is on its way to, and since when.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingTarget {
    pub target: State,
    pub since: i64,
}

/// The last notification of an instance: which state from which start, when, and how many
/// reminders followed it. A resolve is recorded as state OK with the start of the state it
/// resolved. Recorded in the same step that returns the notification; see the scheduler contract
/// in the module docs for why that is enough.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LastNotification {
    pub state: State,
    pub state_since: i64,
    pub at: i64,
    pub reminders: u32,
}

/// One instance as it is stored between evaluations (`alert_instances`). Times are Unix
/// milliseconds, as everywhere in the server (`clock::Clock::now_ms`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstanceState {
    pub fingerprint: String,
    /// The series labels (empty for documents, graphs and frames without series).
    pub labels: Labels,
    pub state: State,
    /// When the instance entered `state`.
    pub since: i64,
    /// The reported state the instance is waiting to enter: the target of "pending" when `state`
    /// is pending, and a change between reported states (firing to error) that is still within
    /// the for-duration otherwise.
    pub pending: Option<PendingTarget>,
    pub last_evaluated_at: Option<i64>,
    pub last_value: Option<f64>,
    pub last_error: Option<EvalError>,
    /// Evaluations in a row this series was missing from the result.
    pub missing: u32,
    pub last_notification: Option<LastNotification>,
}

impl InstanceState {
    fn new(rule_id: &str, labels: Labels, now: i64) -> Self {
        Self {
            fingerprint: fingerprint(rule_id, &labels),
            labels,
            state: State::Ok,
            since: now,
            pending: None,
            last_evaluated_at: None,
            last_value: None,
            last_error: None,
            missing: 0,
            last_notification: None,
        }
    }
}

/// A duration in milliseconds, saturating.
fn millis(duration: Duration) -> i64 {
    i64::try_from(duration.as_millis()).unwrap_or(i64::MAX)
}

/// SHA-256 (hex) of the rule id and the sorted labels, each length-prefixed so no two inputs
/// share a hash by concatenation.
pub fn fingerprint(rule_id: &str, labels: &Labels) -> String {
    let mut hash = Sha256::new();
    let mut part = |text: &str| {
        hash.update((text.len() as u64).to_be_bytes());
        hash.update(text.as_bytes());
    };
    part(rule_id);
    for (key, value) in labels {
        part(key);
        part(value);
    }
    hex::encode(hash.finalize())
}

/// What one evaluation said about one series.
#[derive(Clone, Debug, PartialEq)]
pub enum SeriesOutcome {
    /// The condition is met by the value.
    Met(f64),
    NotMet(f64),
    /// The series has no value (only empty values, a field missing in every document).
    NoData,
}

/// What one evaluation of a rule said.
#[derive(Clone, Debug, PartialEq)]
pub enum Outcome {
    /// One entry per series of the result. `complete` is false when the source cut the result
    /// (a count decided at its lower bound): series that did not arrive are then not missing.
    Series { series: Vec<(Labels, SeriesOutcome)>, complete: bool },
    /// A frame without a single series: the rule's instance without labels has no data, and
    /// the series instances are missing.
    NoData,
    /// The evaluation failed: applies to every instance of the rule.
    Error(EvalError),
}

/// For a count cut at `n` (the true count is `n` or more): whether the condition is met no
/// matter how many more there are, `None` when that depends on the rest.
fn decided_at_lower_bound(condition: &Condition, n: f64) -> Option<bool> {
    let value = condition.value.unwrap_or(f64::NAN);
    let high = condition.high.unwrap_or(f64::NAN);
    match condition.op {
        Op::Gt if n > value => Some(true),
        Op::Gte if n >= value => Some(true),
        Op::Lt if n >= value => Some(false),
        Op::Lte if n > value => Some(false),
        Op::Eq if n > value => Some(false),
        Op::Ne if n > value => Some(true),
        Op::Inside if n > high => Some(false),
        Op::Outside if n > high => Some(true),
        _ => None,
    }
}

/// Reduces the query's answer (or its failure) and checks the condition per series. A result the
/// source cut is an error, except a count whose condition every series already decides at the
/// count that arrived.
pub fn outcome(
    spec: &Reduce,
    condition: &Condition,
    result: Result<&QueryResult, EvalError>,
    max_instances: usize,
) -> Outcome {
    let reduction = match result.and_then(|r| reduce(spec, r, max_instances)) {
        Ok(reduction) => reduction,
        Err(error) => return Outcome::Error(error),
    };
    let complete = reduction.truncated.is_none();
    if let Some(cut) = reduction.truncated {
        if !is_count(spec) {
            return Outcome::Error(cut);
        }
        let mut series = Vec::with_capacity(reduction.series.len());
        for s in reduction.series {
            let decided = match s.value {
                Reduced::Value(n) => decided_at_lower_bound(condition, n).map(|met| (n, met)),
                Reduced::NoValue => None,
            };
            match decided {
                Some((n, true)) => series.push((s.labels, SeriesOutcome::Met(n))),
                Some((n, false)) => series.push((s.labels, SeriesOutcome::NotMet(n))),
                None => return Outcome::Error(cut),
            }
        }
        if series.is_empty() {
            return Outcome::Error(cut);
        }
        return Outcome::Series { series, complete };
    }
    if reduction.series.is_empty() {
        return Outcome::NoData;
    }
    let series = reduction
        .series
        .into_iter()
        .map(|s| {
            let outcome = match s.value {
                Reduced::Value(v) if condition.holds(v) => SeriesOutcome::Met(v),
                Reduced::Value(v) => SeriesOutcome::NotMet(v),
                Reduced::NoValue => SeriesOutcome::NoData,
            };
            (s.labels, outcome)
        })
        .collect();
    Outcome::Series { series, complete }
}

/// Why an instance went back to OK.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResolveReason {
    /// The series was missing from three evaluations in a row ("Serie nicht mehr vorhanden").
    SeriesGone,
    /// The instance without labels that stood for the whole rule (no series, or a failed
    /// evaluation) ended because the result has series again.
    Replaced,
}

impl ResolveReason {
    pub fn as_str(self) -> &'static str {
        match self {
            ResolveReason::SeriesGone => "series_gone",
            ResolveReason::Replaced => "replaced",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "series_gone" => Some(ResolveReason::SeriesGone),
            "replaced" => Some(ResolveReason::Replaced),
            _ => None,
        }
    }
}

/// One state change for the history (`alert_history`, kind `transition`), reported or not.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Transition {
    pub fingerprint: String,
    pub labels: Labels,
    pub from: State,
    pub to: State,
    /// For a change to pending: the reported state it waits for.
    pub pending_target: Option<State>,
    pub at: i64,
    pub value: Option<f64>,
    pub error: Option<EvalError>,
    /// The silence that matched the instance, so nothing was sent for it.
    pub silence_id: Option<String>,
    pub reason: Option<ResolveReason>,
}

/// The kind of a notification, as `Kalzit-Event` names it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Event {
    Firing,
    Resolved,
    NoData,
    Error,
    Reminder,
}

impl Event {
    pub fn as_str(self) -> &'static str {
        match self {
            Event::Firing => "firing",
            Event::Resolved => "resolved",
            Event::NoData => "no_data",
            Event::Error => "error",
            Event::Reminder => "reminder",
        }
    }

    fn entering(state: State) -> Self {
        match state {
            State::NoData => Event::NoData,
            State::Error => Event::Error,
            _ => Event::Firing,
        }
    }
}

/// One instance in the message a notifier sends for this evaluation of the rule.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Notification {
    pub fingerprint: String,
    pub labels: Labels,
    pub event: Event,
    /// The state reported: OK for resolved, for a reminder the state that lasts.
    pub state: State,
    /// The start of the reported state; for resolved, the start of the state that ended.
    pub state_since: i64,
    pub value: Option<f64>,
    pub error: Option<EvalError>,
    /// 0 for the state change itself, n for the n-th reminder.
    pub reminder: u32,
    pub reason: Option<ResolveReason>,
}

impl Notification {
    /// The deduplication key per contact point (docs/PLAN.md, section 13): fingerprint, contact
    /// point, state, the start of the state and the reminder number (0 for the change itself), as
    /// SHA-256 hex. A delivery whose key was already recorded is not made again.
    pub fn dedup_key(&self, contact_point_id: &str) -> String {
        let mut hash = Sha256::new();
        for part in [
            self.fingerprint.as_str(),
            contact_point_id,
            self.state.as_str(),
            &self.state_since.to_string(),
            &self.reminder.to_string(),
        ] {
            hash.update((part.len() as u64).to_be_bytes());
            hash.update(part.as_bytes());
        }
        hex::encode(hash.finalize())
    }
}

/// The result of one evaluation step.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Step {
    /// The instances to store; ended instances are gone.
    pub instances: Vec<InstanceState>,
    pub transitions: Vec<Transition>,
    /// Everything to send, for one message per rule and evaluation.
    pub notifications: Vec<Notification>,
}

/// What an instance gets in this evaluation.
#[derive(Clone, Debug)]
enum Input {
    Series(SeriesOutcome),
    Error(EvalError),
    /// Not in the result: counts towards the end of the instance.
    Missing,
    /// Not in a cut result: nothing is known, nothing changes.
    Unknown,
}

/// One evaluation at the scheduled time `tick`: `previous` are the stored instances of the rule,
/// `silenced_by` names the silence that matches an instance's labels now, if any. Same input,
/// same output.
pub fn step(
    rule: &RuleTiming,
    previous: &[InstanceState],
    outcome: &Outcome,
    tick: i64,
    silenced_by: &dyn Fn(&Labels) -> Option<String>,
) -> Step {
    let mut inputs: Vec<(InstanceState, Input)> = Vec::new();
    match outcome {
        Outcome::Series { series, complete } => {
            let mut taken = vec![false; previous.len()];
            for (labels, outcome) in series {
                let fp = fingerprint(&rule.rule_id, labels);
                let instance = match previous.iter().position(|p| p.fingerprint == fp) {
                    Some(i) => {
                        taken[i] = true;
                        previous[i].clone()
                    }
                    None => InstanceState::new(&rule.rule_id, labels.clone(), tick),
                };
                inputs.push((instance, Input::Series(outcome.clone())));
            }
            let rest = if *complete { Input::Missing } else { Input::Unknown };
            inputs.extend(previous.iter().zip(taken).filter(|(_, t)| !t).map(|(p, _)| (p.clone(), rest.clone())));
        }
        Outcome::NoData => {
            // The rule has no series: its instance without labels takes the no-data verdict, and
            // series instances are missing (they end after three evaluations).
            let placeholder = fingerprint(&rule.rule_id, &Labels::new());
            let no_data = Input::Series(SeriesOutcome::NoData);
            match previous.iter().find(|p| p.fingerprint == placeholder) {
                Some(p) => inputs.push((p.clone(), no_data)),
                None => inputs.push((InstanceState::new(&rule.rule_id, Labels::new(), tick), no_data)),
            }
            inputs
                .extend(previous.iter().filter(|p| p.fingerprint != placeholder).map(|p| (p.clone(), Input::Missing)));
        }
        Outcome::Error(error) => {
            if previous.is_empty() {
                inputs.push((InstanceState::new(&rule.rule_id, Labels::new(), tick), Input::Error(error.clone())));
            } else {
                inputs.extend(previous.iter().map(|p| (p.clone(), Input::Error(error.clone()))));
            }
        }
    }

    let mut out = Step::default();
    for (mut instance, input) in inputs {
        let silence = silenced_by(&instance.labels);
        let ended = match input {
            Input::Missing => {
                instance.missing += 1;
                if instance.missing >= MISSING_EVALUATIONS_TO_END {
                    end(rule, &mut instance, tick, silence, &mut out);
                    true
                } else {
                    // Missing for now: the state holds, but a for-duration in progress starts over.
                    interrupt(&mut instance, tick, &silence, &mut out);
                    settle(rule, &mut instance, tick, silence.is_some(), None, &mut out);
                    false
                }
            }
            Input::Unknown => {
                interrupt(&mut instance, tick, &silence, &mut out);
                settle(rule, &mut instance, tick, silence.is_some(), None, &mut out);
                false
            }
            Input::Series(outcome) => {
                instance.missing = 0;
                evaluate(rule, &mut instance, Ok(outcome), tick, silence, &mut out);
                false
            }
            Input::Error(error) => {
                instance.missing = 0;
                evaluate(rule, &mut instance, Err(error), tick, silence, &mut out);
                false
            }
        };
        if !ended {
            out.instances.push(instance);
        }
    }
    out
}

fn evaluate(
    rule: &RuleTiming,
    instance: &mut InstanceState,
    input: Result<SeriesOutcome, EvalError>,
    tick: i64,
    silence: Option<String>,
    out: &mut Step,
) {
    instance.last_evaluated_at = Some(tick);
    let desired = match input {
        Ok(SeriesOutcome::Met(v)) => {
            instance.last_value = Some(v);
            instance.last_error = None;
            Some(State::Firing)
        }
        Ok(SeriesOutcome::NotMet(v)) => {
            instance.last_value = Some(v);
            instance.last_error = None;
            None
        }
        Ok(SeriesOutcome::NoData) => {
            instance.last_value = None;
            instance.last_error = None;
            match rule.no_data {
                NoDataBehavior::NoData => Some(State::NoData),
                NoDataBehavior::Ok => None,
                NoDataBehavior::Firing => Some(State::Firing),
            }
        }
        Err(error) => {
            instance.last_value = None;
            instance.last_error = Some(error);
            match rule.error {
                ErrorBehavior::Error => Some(State::Error),
                ErrorBehavior::Keep => {
                    interrupt(instance, tick, &silence, out);
                    settle(rule, instance, tick, silence.is_some(), None, out);
                    return;
                }
            }
        }
    };

    match desired {
        None => {
            instance.pending = None;
            if instance.state != State::Ok {
                transition(instance, State::Ok, tick, &silence, None, out);
            }
        }
        Some(target) if instance.state == target => instance.pending = None,
        Some(target) => {
            let pending = match instance.pending {
                Some(p) if p.target == target => p,
                _ => PendingTarget { target, since: tick },
            };
            if rule.elapsed(pending.since, tick, rule.for_duration) {
                instance.pending = None;
                transition(instance, target, tick, &silence, None, out);
            } else {
                let switched = instance.pending.is_some_and(|p| p.target != target);
                instance.pending = Some(pending);
                if instance.state == State::Ok || (instance.state == State::Pending && switched) {
                    // Pending (again, towards another target): recorded with the target.
                    transition(instance, State::Pending, tick, &silence, None, out);
                }
                // A reported state holds until the new one is due.
            }
        }
    }
    settle(rule, instance, tick, silence.is_some(), None, out);
}

/// Moves the instance to `to` and records the transition.
fn transition(
    instance: &mut InstanceState,
    to: State,
    tick: i64,
    silence: &Option<String>,
    reason: Option<ResolveReason>,
    out: &mut Step,
) {
    let from = instance.state;
    instance.state = to;
    instance.since = tick;
    out.transitions.push(Transition {
        fingerprint: instance.fingerprint.clone(),
        labels: instance.labels.clone(),
        from,
        to,
        pending_target: if to == State::Pending { instance.pending.map(|p| p.target) } else { None },
        at: tick,
        value: instance.last_value,
        error: instance.last_error.clone(),
        silence_id: silence.clone(),
        reason,
    });
}

/// Sends what the instance owes, unless it is silenced: a reported state not sent yet (new, or
/// entered while silenced), a due reminder, or the resolve of a sent state that has ended (also
/// one that ended while silenced).
fn settle(
    rule: &RuleTiming,
    instance: &mut InstanceState,
    tick: i64,
    silenced: bool,
    reason: Option<ResolveReason>,
    out: &mut Step,
) {
    if silenced {
        return;
    }
    let last = instance.last_notification;
    if instance.state.is_active() {
        match last {
            Some(last) if last.state == instance.state && last.state_since == instance.since => {
                let Some(every) = rule.reminder else { return };
                if rule.elapsed(last.at, tick, every) {
                    notify(
                        instance,
                        Event::Reminder,
                        instance.state,
                        instance.since,
                        last.reminders + 1,
                        None,
                        tick,
                        out,
                    );
                }
            }
            _ => notify(instance, Event::entering(instance.state), instance.state, instance.since, 0, None, tick, out),
        }
    } else if let Some(last) = last
        && last.state.is_active()
    {
        notify(instance, Event::Resolved, State::Ok, last.state_since, 0, reason, tick, out);
    }
}

#[allow(clippy::too_many_arguments)]
fn notify(
    instance: &mut InstanceState,
    event: Event,
    state: State,
    state_since: i64,
    reminder: u32,
    reason: Option<ResolveReason>,
    tick: i64,
    out: &mut Step,
) {
    instance.last_notification = Some(LastNotification { state, state_since, at: tick, reminders: reminder });
    out.notifications.push(Notification {
        fingerprint: instance.fingerprint.clone(),
        labels: instance.labels.clone(),
        event,
        state,
        state_since,
        value: instance.last_value,
        error: instance.last_error.clone(),
        reminder,
        reason,
    });
}

/// An evaluation that saw nothing of the instance (missing, cut away, or failed while the rule
/// keeps the last state): the condition was not observed, so a for-duration in progress starts
/// over. Pending goes back to OK; a reported state holds.
fn interrupt(instance: &mut InstanceState, tick: i64, silence: &Option<String>, out: &mut Step) {
    if instance.pending.take().is_some() && instance.state == State::Pending {
        transition(instance, State::Ok, tick, silence, None, out);
    }
}

/// Ends an instance whose series is gone: a reported state resolves with the reason (sent when
/// it was sent and is not silenced), pending goes back to OK silently, OK simply ends.
fn end(rule: &RuleTiming, instance: &mut InstanceState, tick: i64, silence: Option<String>, out: &mut Step) {
    instance.last_value = None;
    instance.last_error = None;
    instance.pending = None;
    let reason = instance.state.is_active().then_some(if instance.labels.is_empty() {
        ResolveReason::Replaced
    } else {
        ResolveReason::SeriesGone
    });
    if instance.state != State::Ok {
        transition(instance, State::Ok, tick, &silence, reason, out);
    }
    settle(rule, instance, tick, silence.is_some(), reason, out);
}

#[cfg(test)]
mod tests;
