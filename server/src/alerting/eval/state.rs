//! The state machine per instance (docs/PLAN.md, section 13, "Zustände" and
//! "Benachrichtigungen"): from the stored instance states and one evaluation's outcome to the new
//! states, the transitions for the history and the notifications to send.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::reduce::{Reduced, reduce};
use super::{Condition, EvalError, Labels, ReduceSpec};
use crate::shapes::QueryResult;

/// A series that is missing from this many evaluations in a row ends as an instance.
pub const MISSING_EVALUATIONS_TO_END: u32 = 3;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
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
}

/// What happens when an instance has no data.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NoDataBehavior {
    /// The state "no data" (after the for-duration).
    NoData,
    Ok,
    /// As if the condition were met.
    Firing,
}

/// What happens when an evaluation fails.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ErrorBehavior {
    /// The state "error" (after the for-duration).
    Error,
    /// The instance keeps the state it had.
    KeepLast,
}

/// The parts of a rule the state machine needs.
#[derive(Clone, Debug, PartialEq)]
pub struct RuleTiming {
    pub rule_id: String,
    /// How long a reported state must hold before it is entered; 0 enters it at once.
    pub for_duration: Duration,
    pub no_data: NoDataBehavior,
    pub error: ErrorBehavior,
    /// Reminder while a reported state lasts; `None` is off.
    pub reminder: Option<Duration>,
}

/// A reported state the instance is on its way to, and since when.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingTarget {
    pub target: State,
    pub since: i64,
}

/// The last notification of an instance: which state from which start, when, and how many
/// reminders followed it. With it, nothing is sent twice after a restart or a change of leader.
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
    /// The reported state the instance is waiting to enter: the start of "pending" when `state`
    /// is pending, and a change between reported states (firing to error) that is still within
    /// the for-duration otherwise.
    pub pending: Option<PendingTarget>,
    pub last_evaluated_at: Option<i64>,
    pub last_value: Option<f64>,
    pub last_error: Option<String>,
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

    fn notified(&self) -> bool {
        self.last_notification.is_some_and(|n| n.state == self.state && n.state_since == self.since)
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
    /// One entry per series of the result.
    Series(Vec<(Labels, SeriesOutcome)>),
    /// A frame without a single series: applies to every instance of the rule.
    NoData,
    /// The evaluation failed: applies to every instance of the rule.
    Error(EvalError),
}

/// Reduces the query's answer (or its failure) and checks the condition per series.
pub fn outcome(
    spec: &ReduceSpec,
    condition: &Condition,
    result: Result<&QueryResult, EvalError>,
    max_instances: usize,
) -> Outcome {
    let reduction = match result.and_then(|r| reduce(spec, r, max_instances)) {
        Ok(reduction) => reduction,
        Err(error) => return Outcome::Error(error),
    };
    if reduction.series.is_empty() {
        return Outcome::NoData;
    }
    Outcome::Series(
        reduction
            .series
            .into_iter()
            .map(|s| {
                let outcome = match s.value {
                    Reduced::Value(v) if condition.is_met(v) => SeriesOutcome::Met(v),
                    Reduced::Value(v) => SeriesOutcome::NotMet(v),
                    Reduced::NoValue => SeriesOutcome::NoData,
                };
                (s.labels, outcome)
            })
            .collect(),
    )
}

/// Why an instance went back to OK.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ResolveReason {
    /// The series was missing from three evaluations in a row ("Serie nicht mehr vorhanden").
    SeriesGone,
}

/// One state change for the history (`alert_history`), reported or not.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Transition {
    pub fingerprint: String,
    pub labels: Labels,
    pub from: State,
    pub to: State,
    pub at: i64,
    pub value: Option<f64>,
    pub error: Option<String>,
    /// A silence matched the instance, so nothing was sent for it.
    pub silenced: bool,
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
    /// The state reported (OK for resolved; for a reminder the state that lasts).
    pub state: State,
    pub state_since: i64,
    pub value: Option<f64>,
    pub error: Option<String>,
    /// 0 for the state change itself, n for the n-th reminder.
    pub reminder: u32,
    pub reason: Option<ResolveReason>,
}

impl Notification {
    /// The deduplication key per contact point: fingerprint, contact point, state and the start
    /// of the state, plus the reminder number (0 for the change itself), as SHA-256 hex. A
    /// delivery whose key was already recorded is not triggered again.
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
    /// Everything that changed and is to be sent, for one message per rule and evaluation.
    pub notifications: Vec<Notification>,
}

/// One evaluation at `now`: `previous` are the stored instances of the rule, `is_silenced` says
/// whether a silence matches an instance's labels now. Deterministic: same input, same output.
pub fn step(
    rule: &RuleTiming,
    previous: &[InstanceState],
    outcome: &Outcome,
    now: i64,
    is_silenced: &dyn Fn(&Labels) -> bool,
) -> Step {
    let mut out = Step::default();
    // What each instance gets this time; `None` for a series missing from the result.
    let mut inputs: Vec<(InstanceState, Option<Input>)> = Vec::new();
    match outcome {
        Outcome::Series(series) => {
            let mut taken = vec![false; previous.len()];
            for (labels, outcome) in series {
                let fp = fingerprint(&rule.rule_id, labels);
                let instance = match previous.iter().position(|p| p.fingerprint == fp) {
                    Some(i) => {
                        taken[i] = true;
                        previous[i].clone()
                    }
                    None => InstanceState::new(&rule.rule_id, labels.clone(), now),
                };
                inputs.push((instance, Some(Input::Series(outcome.clone()))));
            }
            for (instance, taken) in previous.iter().zip(taken) {
                if !taken {
                    inputs.push((instance.clone(), None));
                }
            }
        }
        Outcome::NoData | Outcome::Error(_) => {
            let input = match outcome {
                Outcome::Error(e) => Input::Error(e.to_string()),
                _ => Input::Series(SeriesOutcome::NoData),
            };
            if previous.is_empty() {
                inputs.push((InstanceState::new(&rule.rule_id, Labels::new(), now), Some(input)));
            } else {
                inputs.extend(previous.iter().map(|p| (p.clone(), Some(input.clone()))));
            }
        }
    }

    for (mut instance, input) in inputs {
        let silenced = is_silenced(&instance.labels);
        let ended = match input {
            Some(input) => {
                instance.missing = 0;
                evaluate(rule, &mut instance, input, now, silenced, &mut out);
                false
            }
            None => {
                instance.missing += 1;
                if instance.missing >= MISSING_EVALUATIONS_TO_END {
                    end(&mut instance, now, silenced, &mut out);
                    true
                } else {
                    // Missing for now: the state holds, but nothing advances.
                    remind(rule, &mut instance, now, silenced, &mut out);
                    false
                }
            }
        };
        if !ended {
            out.instances.push(instance);
        }
    }
    out
}

#[derive(Clone, Debug)]
enum Input {
    Series(SeriesOutcome),
    Error(String),
}

fn evaluate(rule: &RuleTiming, instance: &mut InstanceState, input: Input, now: i64, silenced: bool, out: &mut Step) {
    instance.last_evaluated_at = Some(now);
    let desired = match input {
        Input::Series(SeriesOutcome::Met(v)) => {
            instance.last_value = Some(v);
            instance.last_error = None;
            Some(State::Firing)
        }
        Input::Series(SeriesOutcome::NotMet(v)) => {
            instance.last_value = Some(v);
            instance.last_error = None;
            None
        }
        Input::Series(SeriesOutcome::NoData) => {
            instance.last_value = None;
            instance.last_error = None;
            match rule.no_data {
                NoDataBehavior::NoData => Some(State::NoData),
                NoDataBehavior::Ok => None,
                NoDataBehavior::Firing => Some(State::Firing),
            }
        }
        Input::Error(message) => {
            instance.last_value = None;
            instance.last_error = Some(message);
            match rule.error {
                ErrorBehavior::Error => Some(State::Error),
                ErrorBehavior::KeepLast => {
                    remind(rule, instance, now, silenced, out);
                    return;
                }
            }
        }
    };

    match desired {
        None => {
            instance.pending = None;
            if instance.state != State::Ok {
                transition(instance, State::Ok, now, silenced, None, out);
            }
        }
        Some(target) if instance.state == target => instance.pending = None,
        Some(target) => {
            let pending = match instance.pending {
                Some(p) if p.target == target => p,
                _ => PendingTarget { target, since: now },
            };
            if now.saturating_sub(pending.since) >= millis(rule.for_duration) {
                instance.pending = None;
                transition(instance, target, now, silenced, None, out);
            } else {
                instance.pending = Some(pending);
                if instance.state == State::Ok {
                    transition(instance, State::Pending, now, silenced, None, out);
                }
                // From pending it stays pending; a reported state holds until the new one is due.
            }
        }
    }
    remind(rule, instance, now, silenced, out);
}

/// Moves the instance to `to`, records the transition and, for the end of a reported state that
/// was sent, the resolve notification.
fn transition(
    instance: &mut InstanceState,
    to: State,
    now: i64,
    silenced: bool,
    reason: Option<ResolveReason>,
    out: &mut Step,
) {
    let from = instance.state;
    let was_sent = from.is_active() && instance.notified();
    instance.state = to;
    instance.since = now;
    out.transitions.push(Transition {
        fingerprint: instance.fingerprint.clone(),
        labels: instance.labels.clone(),
        from,
        to,
        at: now,
        value: instance.last_value,
        error: instance.last_error.clone(),
        silenced,
        reason,
    });
    if to == State::Ok && was_sent && !silenced {
        notify(instance, Event::Resolved, 0, reason, now, out);
    }
}

/// Sends what a reported state still owes: the state itself when it was not sent yet (a new
/// state, or one entered while silenced), or a due reminder.
fn remind(rule: &RuleTiming, instance: &mut InstanceState, now: i64, silenced: bool, out: &mut Step) {
    if !instance.state.is_active() || silenced {
        return;
    }
    match instance.last_notification {
        Some(last) if last.state == instance.state && last.state_since == instance.since => {
            let Some(every) = rule.reminder else { return };
            if now.saturating_sub(last.at) >= millis(every) {
                notify(instance, Event::Reminder, last.reminders + 1, None, now, out);
            }
        }
        _ => notify(instance, Event::entering(instance.state), 0, None, now, out),
    }
}

fn notify(
    instance: &mut InstanceState,
    event: Event,
    reminder: u32,
    reason: Option<ResolveReason>,
    now: i64,
    out: &mut Step,
) {
    instance.last_notification =
        Some(LastNotification { state: instance.state, state_since: instance.since, at: now, reminders: reminder });
    out.notifications.push(Notification {
        fingerprint: instance.fingerprint.clone(),
        labels: instance.labels.clone(),
        event,
        state: instance.state,
        state_since: instance.since,
        value: instance.last_value,
        error: instance.last_error.clone(),
        reminder,
        reason,
    });
}

/// Ends an instance whose series is gone: a reported state resolves with the reason, pending
/// goes back to OK silently, OK simply ends.
fn end(instance: &mut InstanceState, now: i64, silenced: bool, out: &mut Step) {
    if instance.state != State::Ok {
        instance.last_value = None;
        let reason = instance.state.is_active().then_some(ResolveReason::SeriesGone);
        transition(instance, State::Ok, now, silenced, reason, out);
    }
}

#[cfg(test)]
mod tests;
