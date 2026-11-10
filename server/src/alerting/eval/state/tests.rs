use std::collections::BTreeMap;
use std::time::Duration;

use proptest::prelude::*;
use serde_json::json;

use super::*;
use crate::alerting::rule::{DocumentMode, FrameFunction, GraphCount};
use crate::shapes::{DocumentSet, Field, FieldType, Frame, GraphSet, OrderedJson, Truncated};

const RULE: &str = "rule-1";

fn at(minute: i64) -> i64 {
    1_800_000_000_000 + minute * 60_000
}

fn rule(for_minutes: u64) -> RuleTiming {
    RuleTiming {
        rule_id: RULE.into(),
        interval: Duration::from_secs(60),
        for_duration: Duration::from_secs(for_minutes * 60),
        no_data: NoDataBehavior::NoData,
        error: ErrorBehavior::Error,
        reminder: None,
    }
}

fn labels(pairs: &[(&str, &str)]) -> Labels {
    pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
}

fn complete(series: Vec<(Labels, SeriesOutcome)>) -> Outcome {
    Outcome::Series { series, complete: true }
}

/// One series without labels.
fn single(outcome: SeriesOutcome) -> Outcome {
    complete(vec![(Labels::new(), outcome)])
}

const MET: SeriesOutcome = SeriesOutcome::Met(5.0);
const NOT: SeriesOutcome = SeriesOutcome::NotMet(1.0);

fn failed() -> Outcome {
    Outcome::Error(EvalError::Timeout)
}

fn never(_: &Labels) -> Option<String> {
    None
}

fn always(_: &Labels) -> Option<String> {
    Some("s1".into())
}

/// Runs the outcomes one minute apart from minute 0; returns the state and the events sent
/// after each step.
fn run(rule: &RuleTiming, outcomes: &[Outcome]) -> Vec<(State, Vec<Event>)> {
    let mut instances = Vec::new();
    outcomes
        .iter()
        .enumerate()
        .map(|(minute, outcome)| {
            let step = step(rule, &instances, outcome, at(minute as i64), &never);
            instances = step.instances;
            let state = instances.first().map_or(State::Ok, |i| i.state);
            (state, step.notifications.iter().map(|n| n.event).collect())
        })
        .collect()
}

use Event::{Error as EErr, Firing as EFire, NoData as ENoData, Resolved as EOk};
use State::{Error as SErr, Firing as SFire, NoData as SNoData, Ok as SOk, Pending as SPend};

#[test]
fn transitions_table() {
    struct Case {
        name: &'static str,
        rule: RuleTiming,
        outcomes: Vec<Outcome>,
        want: Vec<(State, Vec<Event>)>,
    }
    let with = |no_data, error| RuleTiming { no_data, error, ..rule(2) };
    let cases = vec![
        Case {
            name: "for 0 fires at once and resolves",
            rule: rule(0),
            outcomes: vec![single(NOT), single(MET), single(MET), single(NOT)],
            want: vec![(SOk, vec![]), (SFire, vec![EFire]), (SFire, vec![]), (SOk, vec![EOk])],
        },
        Case {
            name: "pending for the for-duration, then firing",
            rule: rule(2),
            outcomes: vec![single(MET), single(MET), single(MET), single(MET), single(NOT)],
            want: vec![(SPend, vec![]), (SPend, vec![]), (SFire, vec![EFire]), (SFire, vec![]), (SOk, vec![EOk])],
        },
        Case {
            name: "pending ends silently when the condition ends early",
            rule: rule(2),
            outcomes: vec![single(MET), single(NOT), single(MET), single(MET)],
            want: vec![(SPend, vec![]), (SOk, vec![]), (SPend, vec![]), (SPend, vec![])],
        },
        Case {
            name: "no data goes through the for-duration and is reported",
            rule: rule(1),
            outcomes: vec![single(SeriesOutcome::NoData), single(SeriesOutcome::NoData), single(NOT)],
            want: vec![(SPend, vec![]), (SNoData, vec![ENoData]), (SOk, vec![EOk])],
        },
        Case {
            name: "a frame without series is no data",
            rule: rule(0),
            outcomes: vec![Outcome::NoData, Outcome::NoData],
            want: vec![(SNoData, vec![ENoData]), (SNoData, vec![])],
        },
        Case {
            name: "no data as OK makes no state of its own",
            rule: RuleTiming { for_duration: Duration::ZERO, ..with(NoDataBehavior::Ok, ErrorBehavior::Error) },
            outcomes: vec![single(MET), single(SeriesOutcome::NoData), single(SeriesOutcome::NoData)],
            want: vec![(SFire, vec![EFire]), (SOk, vec![EOk]), (SOk, vec![])],
        },
        Case {
            name: "no data as firing",
            rule: RuleTiming { for_duration: Duration::ZERO, ..with(NoDataBehavior::Firing, ErrorBehavior::Error) },
            outcomes: vec![Outcome::NoData, Outcome::NoData],
            want: vec![(SFire, vec![EFire]), (SFire, vec![])],
        },
        Case {
            name: "errors go through the for-duration",
            rule: rule(1),
            outcomes: vec![failed(), failed(), failed(), single(NOT)],
            want: vec![(SPend, vec![]), (SErr, vec![EErr]), (SErr, vec![]), (SOk, vec![EOk])],
        },
        Case {
            name: "keep last state holds firing through errors",
            rule: with(NoDataBehavior::NoData, ErrorBehavior::Keep),
            outcomes: vec![single(MET), single(MET), single(MET), failed(), failed(), single(MET), single(NOT)],
            want: vec![
                (SPend, vec![]),
                (SPend, vec![]),
                (SFire, vec![EFire]),
                (SFire, vec![]),
                (SFire, vec![]),
                (SFire, vec![]),
                (SOk, vec![EOk]),
            ],
        },
        Case {
            name: "keep last state on a new rule stays OK",
            rule: with(NoDataBehavior::NoData, ErrorBehavior::Keep),
            outcomes: vec![failed(), failed(), failed()],
            want: vec![(SOk, vec![]), (SOk, vec![]), (SOk, vec![])],
        },
        Case {
            name: "firing holds while an error is within the for-duration",
            rule: rule(2),
            outcomes: vec![single(MET), single(MET), single(MET), failed(), single(MET), failed(), failed(), failed()],
            want: vec![
                (SPend, vec![]),
                (SPend, vec![]),
                (SFire, vec![EFire]),
                (SFire, vec![]),
                // The error cleared: its for-duration starts over next time.
                (SFire, vec![]),
                (SFire, vec![]),
                (SFire, vec![]),
                (SErr, vec![EErr]),
            ],
        },
        Case {
            name: "pending switches its target and starts over",
            rule: rule(1),
            outcomes: vec![single(MET), failed(), failed()],
            want: vec![(SPend, vec![]), (SPend, vec![]), (SErr, vec![EErr])],
        },
        Case {
            name: "firing to no data with for 0 is reported directly",
            rule: rule(0),
            outcomes: vec![single(MET), single(SeriesOutcome::NoData), single(MET)],
            want: vec![(SFire, vec![EFire]), (SNoData, vec![ENoData]), (SFire, vec![EFire])],
        },
    ];
    for case in cases {
        assert_eq!(run(&case.rule, &case.outcomes), case.want, "{}", case.name);
    }
}

#[test]
fn transitions_are_recorded_for_the_history() {
    let rule = rule(1);
    let mut instances = Vec::new();
    let mut all = Vec::new();
    for (minute, outcome) in [single(MET), failed(), single(MET), single(MET), single(NOT)].iter().enumerate() {
        let step = step(&rule, &instances, outcome, at(minute as i64), &never);
        instances = step.instances;
        all.extend(step.transitions);
    }
    type Step = (State, State, Option<State>, i64, Option<f64>);
    let path: Vec<Step> = all.iter().map(|t| (t.from, t.to, t.pending_target, t.at, t.value)).collect();
    assert_eq!(
        path,
        vec![
            (SOk, SPend, Some(SFire), at(0), Some(5.0)),
            // Pending towards another state: recorded with the new target.
            (SPend, SPend, Some(SErr), at(1), None),
            (SPend, SPend, Some(SFire), at(2), Some(5.0)),
            (SPend, SFire, None, at(3), Some(5.0)),
            (SFire, SOk, None, at(4), Some(1.0)),
        ]
    );
    assert_eq!(all[1].error, Some(EvalError::Timeout));
    let instance = &instances[0];
    assert_eq!((instance.state, instance.since, instance.last_evaluated_at), (SOk, at(4), Some(at(4))));
    assert_eq!(instance.last_value, Some(1.0));
}

#[test]
fn errors_are_kept_as_codes() {
    let step = step(&rule(0), &[], &failed(), at(0), &never);
    assert_eq!(step.instances[0].last_error, Some(EvalError::Timeout));
    assert_eq!(step.transitions[0].error, Some(EvalError::Timeout));
    assert_eq!(step.notifications[0].error, Some(EvalError::Timeout));
    assert_eq!(step.notifications[0].value, None);
    assert_eq!(serde_json::to_value(&step.notifications[0]).unwrap()["error"], json!({ "code": "alerting.timeout" }));
}

#[test]
fn the_for_duration_counts_from_the_stored_start_after_a_restart() {
    let rule = rule(5);
    let first = step(&rule, &[], &single(MET), at(0), &never);
    assert_eq!(first.instances[0].state, SPend);
    assert_eq!(first.instances[0].pending.unwrap().since, at(0));
    // The server was off from minute 1 to 30: the first evaluation decides.
    let next = step(&rule, &first.instances, &single(MET), at(30), &never);
    assert_eq!(next.instances[0].state, SFire);
    assert_eq!(next.notifications.len(), 1);
    // Before the for-duration is over it keeps waiting.
    let early = step(&rule, &first.instances, &single(MET), at(4), &never);
    assert_eq!(early.instances[0].state, SPend);
    let due = step(&rule, &early.instances, &single(MET), at(5), &never);
    assert_eq!(due.instances[0].state, SFire);
}

#[test]
fn a_late_tick_still_counts_within_a_tenth_of_the_interval() {
    let rule = rule(2);
    let first = step(&rule, &[], &single(MET), at(0) + 5_000, &never);
    // Two minutes minus the 5 seconds the first evaluation was late: within 6 seconds.
    let due = step(&rule, &first.instances, &single(MET), at(2), &never);
    assert_eq!(due.instances[0].state, SFire);
    let first = step(&rule, &[], &single(MET), at(0) + 7_000, &never);
    let early = step(&rule, &first.instances, &single(MET), at(2), &never);
    assert_eq!(early.instances[0].state, SPend);
}

#[test]
fn reported_firing_is_not_reported_again_after_a_restart() {
    let rule = rule(0);
    let fired = step(&rule, &[], &single(MET), at(0), &never);
    assert_eq!(fired.notifications.len(), 1);
    // The stored state goes through JSON and back.
    let stored: Vec<InstanceState> = serde_json::from_value(serde_json::to_value(&fired.instances).unwrap()).unwrap();
    assert_eq!(stored, fired.instances);
    let again = step(&rule, &stored, &single(MET), at(1), &never);
    assert!(again.notifications.is_empty());
    assert!(again.transitions.is_empty());
}

#[test]
fn reminders_while_firing_lasts() {
    let rule = RuleTiming { reminder: Some(Duration::from_secs(4 * 60)), ..rule(0) };
    let mut instances = Vec::new();
    let mut sent = Vec::new();
    for minute in 0..10 {
        let step = step(&rule, &instances, &single(MET), at(minute), &never);
        instances = step.instances;
        sent.extend(step.notifications.into_iter().map(|n| (minute, n.event, n.reminder)));
    }
    assert_eq!(sent, vec![(0, EFire, 0), (4, Event::Reminder, 1), (8, Event::Reminder, 2)]);
}

#[test]
fn silences_suppress_sending_but_not_evaluation() {
    let rule = rule(0);
    let first = step(&rule, &[], &single(MET), at(0), &always);
    assert_eq!(first.instances[0].state, SFire);
    assert!(first.notifications.is_empty());
    assert_eq!(first.transitions[0].silence_id.as_deref(), Some("s1"));
    // Still silenced: nothing.
    let second = step(&rule, &first.instances, &single(MET), at(1), &always);
    assert!(second.notifications.is_empty());
    // The silence ended while it still fires: reported once.
    let third = step(&rule, &second.instances, &single(MET), at(2), &never);
    assert_eq!(third.notifications.iter().map(|n| n.event).collect::<Vec<_>>(), vec![EFire]);
    assert_eq!(third.notifications[0].state_since, at(0));
    let fourth = step(&rule, &third.instances, &single(MET), at(3), &never);
    assert!(fourth.notifications.is_empty());
}

#[test]
fn resolving_an_unsent_state_sends_nothing() {
    let rule = rule(0);
    let fired = step(&rule, &[], &single(MET), at(0), &always);
    let resolved = step(&rule, &fired.instances, &single(NOT), at(1), &never);
    assert_eq!(resolved.instances[0].state, SOk);
    assert_eq!(resolved.transitions.len(), 1);
    assert!(resolved.notifications.is_empty());
}

#[test]
fn a_resolve_during_a_silence_is_sent_once_when_it_ends() {
    let rule = rule(0);
    let fired = step(&rule, &[], &single(MET), at(0), &never);
    assert_eq!(fired.notifications[0].event, EFire);
    // Resolved while silenced: nothing sent yet.
    let resolved = step(&rule, &fired.instances, &single(NOT), at(1), &always);
    assert_eq!(resolved.instances[0].state, SOk);
    assert!(resolved.notifications.is_empty());
    let still = step(&rule, &resolved.instances, &single(NOT), at(2), &always);
    assert!(still.notifications.is_empty());
    // The silence ended: the resolve is owed and sent once, for the firing that started at 0.
    let after = step(&rule, &still.instances, &single(NOT), at(3), &never);
    assert_eq!(after.notifications.len(), 1);
    let resolve = &after.notifications[0];
    assert_eq!((resolve.event, resolve.state, resolve.state_since), (EOk, SOk, at(0)));
    assert!(step(&rule, &after.instances, &single(NOT), at(4), &never).notifications.is_empty());
    // Same key as a resolve sent right away would have had.
    let direct = step(&rule, &fired.instances, &single(NOT), at(1), &never);
    assert_eq!(direct.notifications[0].dedup_key("cp"), resolve.dedup_key("cp"));
}

#[test]
fn silences_match_per_instance() {
    let rule = rule(0);
    let outcome = complete(vec![(labels(&[("host", "a")]), MET), (labels(&[("host", "b")]), MET)]);
    let only_a = |l: &Labels| l.get("host").filter(|h| *h == "a").map(|_| "s1".to_string());
    let step = step(&rule, &[], &outcome, at(0), &only_a);
    assert_eq!(step.notifications.len(), 1);
    assert_eq!(step.notifications[0].labels, labels(&[("host", "b")]));
}

#[test]
fn a_series_missing_three_times_ends_with_a_resolve() {
    let rule = rule(0);
    let a = labels(&[("host", "a")]);
    let b = labels(&[("host", "b")]);
    let both = complete(vec![(a.clone(), MET), (b.clone(), NOT)]);
    let only_b = complete(vec![(b.clone(), NOT)]);
    let mut instances = step(&rule, &[], &both, at(0), &never).instances;
    assert_eq!(instances.len(), 2);
    for minute in 1..=2 {
        let step = step(&rule, &instances, &only_b, at(minute), &never);
        instances = step.instances;
        assert_eq!(instances.len(), 2, "minute {minute}");
        assert!(step.notifications.is_empty());
        let gone = instances.iter().find(|i| i.labels == a).unwrap();
        assert_eq!((gone.state, gone.missing), (SFire, minute as u32));
    }
    let third = step(&rule, &instances, &only_b, at(3), &never);
    assert_eq!(third.instances.len(), 1);
    assert_eq!(third.instances[0].labels, b);
    assert_eq!(third.notifications.len(), 1);
    let resolved = &third.notifications[0];
    assert_eq!((resolved.event, resolved.state, resolved.reason), (EOk, SOk, Some(ResolveReason::SeriesGone)));
    assert_eq!(resolved.labels, a);
    assert_eq!(third.transitions[0].reason, Some(ResolveReason::SeriesGone));
}

#[test]
fn a_series_that_comes_back_resets_its_count() {
    let rule = rule(0);
    let a = labels(&[("host", "a")]);
    let b = labels(&[("host", "b")]);
    let both = complete(vec![(a.clone(), NOT), (b.clone(), NOT)]);
    let only_b = complete(vec![(b, NOT)]);
    let mut instances = step(&rule, &[], &both, at(0), &never).instances;
    for (minute, outcome) in [&only_b, &only_b, &both, &only_b, &only_b].into_iter().enumerate() {
        instances = step(&rule, &instances, outcome, at(minute as i64 + 1), &never).instances;
    }
    let back = instances.iter().find(|i| i.labels == a).unwrap();
    assert_eq!(back.missing, 2);
    // A missing OK or pending instance ends without a message.
    let ended = step(&rule, &instances, &only_b, at(9), &never);
    assert_eq!(ended.instances.len(), 1);
    assert!(ended.notifications.is_empty());
}

#[test]
fn a_cut_result_does_not_make_series_missing() {
    let rule = rule(0);
    let a = labels(&[("host", "a")]);
    let b = labels(&[("host", "b")]);
    let mut instances = step(&rule, &[], &complete(vec![(a.clone(), MET), (b.clone(), NOT)]), at(0), &never).instances;
    let cut = Outcome::Series { series: vec![(b, NOT)], complete: false };
    for minute in 1..=5 {
        instances = step(&rule, &instances, &cut, at(minute), &never).instances;
    }
    let kept = instances.iter().find(|i| i.labels == a).unwrap();
    assert_eq!((kept.state, kept.missing), (SFire, 0));
}

#[test]
fn rule_wide_errors_apply_to_every_instance_and_do_not_count_as_missing() {
    let rule = rule(0);
    let series = complete(vec![(labels(&[("host", "a")]), NOT), (labels(&[("host", "b")]), NOT)]);
    let mut instances = step(&rule, &[], &series, at(0), &never).instances;
    for minute in 1..=5 {
        instances = step(&rule, &instances, &failed(), at(minute), &never).instances;
    }
    assert_eq!(instances.len(), 2);
    assert!(instances.iter().all(|i| i.state == SErr && i.missing == 0));
}

#[test]
fn a_frame_without_series_ends_its_series_and_has_no_data_once() {
    for no_data in [NoDataBehavior::NoData, NoDataBehavior::Ok, NoDataBehavior::Firing] {
        let rule = RuleTiming { no_data, ..rule(0) };
        let series = complete(vec![(labels(&[("host", "a")]), MET), (labels(&[("host", "b")]), NOT)]);
        let mut instances = step(&rule, &[], &series, at(0), &never).instances;
        let mut events = Vec::new();
        for minute in 1..=3 {
            let step = step(&rule, &instances, &Outcome::NoData, at(minute), &never);
            instances = step.instances;
            events.extend(step.notifications.iter().map(|n| (n.labels.is_empty(), n.event)));
        }
        // The series end after three evaluations without them; one instance without labels stays.
        assert_eq!(instances.len(), 1, "{no_data:?}");
        assert!(instances[0].labels.is_empty());
        let want_state = match no_data {
            NoDataBehavior::NoData => SNoData,
            NoDataBehavior::Ok => SOk,
            NoDataBehavior::Firing => SFire,
        };
        assert_eq!(instances[0].state, want_state, "{no_data:?}");
        // The firing series resolves as gone, whatever the no-data behavior.
        assert!(events.contains(&(false, EOk)), "{no_data:?}: {events:?}");
    }
}

#[test]
fn a_new_rule_without_series_gets_one_instance_without_labels() {
    let step = step(&rule(0), &[], &Outcome::NoData, at(0), &never);
    assert_eq!(step.instances.len(), 1);
    assert!(step.instances[0].labels.is_empty());
    assert_eq!(step.instances[0].fingerprint, fingerprint(RULE, &Labels::new()));
}

#[test]
fn fingerprints_are_deterministic_and_distinct() {
    let a = fingerprint("r1", &labels(&[("a", "1"), ("b", "2")]));
    assert_eq!(a.len(), 64);
    // Labels are sorted, so the order they come in does not matter.
    let mut reversed = BTreeMap::new();
    reversed.insert("b".to_string(), "2".to_string());
    reversed.insert("a".to_string(), "1".to_string());
    assert_eq!(a, fingerprint("r1", &reversed));
    assert_ne!(a, fingerprint("r2", &labels(&[("a", "1"), ("b", "2")])));
    // No collisions by moving characters between parts.
    assert_ne!(fingerprint("r", &labels(&[("ab", "c")])), fingerprint("r", &labels(&[("a", "bc")])));
    assert_ne!(fingerprint("ra", &labels(&[("b", "c")])), fingerprint("r", &labels(&[("ab", "c")])));
    assert_ne!(fingerprint("r", &Labels::new()), fingerprint("r", &labels(&[("", "")])));
}

#[test]
fn dedup_keys_differ_by_every_part() {
    let rule = RuleTiming { reminder: Some(Duration::from_secs(60)), ..rule(0) };
    let fired = step(&rule, &[], &single(MET), at(0), &never);
    let firing = &fired.notifications[0];
    let base = firing.dedup_key("cp-1");
    assert_eq!(base.len(), 64);
    assert_eq!(base, step(&rule, &[], &single(MET), at(0), &never).notifications[0].dedup_key("cp-1"));
    assert_ne!(base, firing.dedup_key("cp-2"));
    let reminded = step(&rule, &fired.instances, &single(MET), at(1), &never);
    assert_eq!(reminded.notifications[0].event, Event::Reminder);
    assert_ne!(base, reminded.notifications[0].dedup_key("cp-1"));
    let resolved = step(&rule, &fired.instances, &single(NOT), at(1), &never);
    assert_ne!(base, resolved.notifications[0].dedup_key("cp-1"));
    // The same state again later has a new start, so a new key.
    let again = step(&rule, &resolved.instances, &single(MET), at(2), &never);
    assert_eq!(again.notifications[0].event, EFire);
    assert_ne!(base, again.notifications[0].dedup_key("cp-1"));
}

#[test]
fn stored_spellings() {
    for (state, text) in [(SOk, "ok"), (SPend, "pending"), (SFire, "firing"), (SNoData, "no_data"), (SErr, "error")] {
        assert_eq!(state.as_str(), text);
        assert_eq!(State::parse(text), Some(state));
        assert_eq!(serde_json::to_value(state).unwrap(), json!(text));
        assert!(crate::alerting::rule::STATES.contains(&text));
    }
    for text in crate::alerting::rule::NO_DATA_STATES {
        let behavior = NoDataBehavior::parse(text).unwrap();
        assert_eq!(serde_json::to_value(behavior).unwrap(), json!(text));
    }
    for text in crate::alerting::rule::ERROR_STATES {
        let behavior = ErrorBehavior::parse(text).unwrap();
        assert_eq!(serde_json::to_value(behavior).unwrap(), json!(text));
    }
    assert_eq!(serde_json::to_value(Event::NoData).unwrap(), json!("no_data"));
    assert_eq!(ResolveReason::parse("series_gone"), Some(ResolveReason::SeriesGone));
    assert_eq!(serde_json::to_value(ResolveReason::SeriesGone).unwrap(), json!("series_gone"));
}

fn frame_result(fields: Vec<Field>) -> QueryResult {
    QueryResult::Frame { frame: Frame::new(fields).unwrap() }
}

fn condition(value: serde_json::Value) -> Condition {
    Condition::parse(&value).unwrap()
}

#[test]
fn outcomes_from_results() {
    let spec = Reduce::Frame { function: FrameFunction::Last };
    let gt = condition(json!({ "op": "gt", "value": 1.5 }));
    let field = |name: &str, values: Vec<serde_json::Value>| Field {
        name: name.into(),
        field_type: FieldType::Number,
        unit: None,
        values,
        labels: Some(labels(&[("job", name)])),
    };
    let result =
        frame_result(vec![field("a", vec![json!(1.84)]), field("b", vec![json!(1)]), field("c", vec![json!(null)])]);
    assert_eq!(
        outcome(&spec, &gt, Ok(&result), 100),
        complete(vec![
            (labels(&[("job", "a")]), SeriesOutcome::Met(1.84)),
            (labels(&[("job", "b")]), SeriesOutcome::NotMet(1.0)),
            (labels(&[("job", "c")]), SeriesOutcome::NoData),
        ])
    );
    assert_eq!(outcome(&spec, &gt, Ok(&frame_result(vec![])), 100), Outcome::NoData);
    assert_eq!(outcome(&spec, &gt, Err(EvalError::SourceNotEnabled), 100), Outcome::Error(EvalError::SourceNotEnabled));
    let graph = QueryResult::Graph { graph: GraphSet::default() };
    let nodes = Reduce::Graph { count: GraphCount::Nodes, label: None };
    assert_eq!(
        outcome(&nodes, &condition(json!({ "op": "eq", "value": 0 })), Ok(&graph), 100),
        single(SeriesOutcome::Met(0.0))
    );
    assert!(matches!(outcome(&spec, &gt, Ok(&graph), 100), Outcome::Error(EvalError::WrongShape { .. })));
}

/// A cut result: only a count whose condition is decided at the count that arrived passes; every
/// other reduce step is the error `alerting.truncated`, for all three shapes.
#[test]
fn cut_results_count_only_when_the_condition_is_already_decided() {
    let cut_error = |limit, reason: &str| Outcome::Error(EvalError::Truncated { limit, reason: Some(reason.into()) });
    // Graph: 3 nodes arrived, the source stopped at 3.
    let graph = QueryResult::Graph {
        graph: GraphSet {
            nodes: (0..3)
                .map(|i| crate::shapes::Node { id: i.to_string(), labels: vec![], properties: BTreeMap::new() })
                .collect(),
            truncated: Some(Truncated { limit: 3, reason: Some("graph.node_limit".into()) }),
            ..GraphSet::default()
        },
    };
    let nodes = Reduce::Graph { count: GraphCount::Nodes, label: None };
    let cases = [
        (json!({ "op": "gt", "value": 2 }), Some(true)),
        (json!({ "op": "gte", "value": 3 }), Some(true)),
        (json!({ "op": "gt", "value": 3 }), None),
        (json!({ "op": "lt", "value": 3 }), Some(false)),
        (json!({ "op": "lt", "value": 4 }), None),
        (json!({ "op": "lte", "value": 2 }), Some(false)),
        (json!({ "op": "lte", "value": 3 }), None),
        (json!({ "op": "eq", "value": 2 }), Some(false)),
        (json!({ "op": "eq", "value": 3 }), None),
        (json!({ "op": "ne", "value": 2 }), Some(true)),
        (json!({ "op": "inside", "low": 0, "high": 2 }), Some(false)),
        (json!({ "op": "inside", "low": 0, "high": 5 }), None),
        (json!({ "op": "outside", "low": 0, "high": 2 }), Some(true)),
        (json!({ "op": "outside", "low": 0, "high": 5 }), None),
    ];
    for (c, decided) in cases {
        let got = outcome(&nodes, &condition(c.clone()), Ok(&graph), 100);
        let want = match decided {
            Some(true) => Outcome::Series { series: vec![(Labels::new(), SeriesOutcome::Met(3.0))], complete: false },
            Some(false) => {
                Outcome::Series { series: vec![(Labels::new(), SeriesOutcome::NotMet(3.0))], complete: false }
            }
            None => cut_error(Some(3), "graph.node_limit"),
        };
        assert_eq!(got, want, "{c}");
    }

    // Documents: a count may decide, a field value never.
    let docs = QueryResult::Documents {
        documents: DocumentSet {
            documents: vec![OrderedJson::from(json!({ "v": 9 }))],
            truncated: Some(Truncated { limit: 1, reason: Some("documents.limit".into()) }),
            ..DocumentSet::default()
        },
    };
    let count = Reduce::Documents { mode: DocumentMode::Count, path: None, function: None };
    let field = Reduce::Documents {
        mode: DocumentMode::Field,
        path: Some("$.v".into()),
        function: Some(crate::alerting::rule::DocumentFunction::Max),
    };
    let gte1 = condition(json!({ "op": "gte", "value": 1 }));
    assert_eq!(
        outcome(&count, &gte1, Ok(&docs), 100),
        Outcome::Series { series: vec![(Labels::new(), SeriesOutcome::Met(1.0))], complete: false }
    );
    assert_eq!(outcome(&field, &gte1, Ok(&docs), 100), cut_error(Some(1), "documents.limit"));

    // Frames: a count per series may decide when all of them do; other functions never.
    let frame = QueryResult::Frame {
        frame: Frame::new(vec![Field {
            name: "v".into(),
            field_type: FieldType::Number,
            unit: None,
            values: vec![json!(1), json!(2)],
            labels: None,
        }])
        .unwrap()
        .with_meta(crate::shapes::FrameMeta { rows_truncated: true, ..Default::default() }),
    };
    let frame_count = Reduce::Frame { function: FrameFunction::Count };
    assert!(matches!(
        outcome(&frame_count, &condition(json!({ "op": "gt", "value": 1 })), Ok(&frame), 100),
        Outcome::Series { complete: false, .. }
    ));
    assert_eq!(
        outcome(&frame_count, &condition(json!({ "op": "gt", "value": 5 })), Ok(&frame), 100),
        cut_error(None, "rows_truncated")
    );
    assert_eq!(
        outcome(
            &Reduce::Frame { function: FrameFunction::Max },
            &condition(json!({ "op": "gt", "value": 0 })),
            Ok(&frame),
            100
        ),
        cut_error(None, "rows_truncated")
    );
}

fn any_outcome() -> impl Strategy<Value = Outcome> {
    let series = prop_oneof![
        (0.0f64..10.0).prop_map(SeriesOutcome::Met),
        (0.0f64..10.0).prop_map(SeriesOutcome::NotMet),
        Just(SeriesOutcome::NoData),
    ];
    prop_oneof![
        4 => (prop::collection::vec((prop::sample::select(vec!["a", "b", "c"]), series), 0..3), any::<bool>())
            .prop_map(|(list, complete)| {
                // Each host once per result, as the reduce step guarantees.
                let mut seen = std::collections::BTreeSet::new();
                Outcome::Series {
                    series: list
                        .into_iter()
                        .filter(|(h, _)| seen.insert(*h))
                        .map(|(h, s)| (labels(&[("host", h)]), s))
                        .collect(),
                    complete,
                }
            }),
        1 => Just(Outcome::NoData),
        1 => Just(Outcome::Error(EvalError::Timeout)),
    ]
}

proptest! {
    #![proptest_config(ProptestConfig::default())]

    /// Over any sequence of outcomes and silences: a notification is never sent twice with the
    /// same key, fingerprints stay unique, every instance's state is consistent with its pending
    /// target, and nothing is sent for a silenced instance.
    #[test]
    fn invariants_over_random_sequences(
        outcomes in prop::collection::vec((any_outcome(), any::<bool>()), 1..40),
        for_minutes in 0u64..4,
        reminder in prop::option::of(1u64..5),
        no_data in prop::sample::select(vec![NoDataBehavior::NoData, NoDataBehavior::Ok, NoDataBehavior::Firing]),
        error in prop::sample::select(vec![ErrorBehavior::Error, ErrorBehavior::Keep]),
    ) {
        let rule = RuleTiming {
            no_data,
            error,
            reminder: reminder.map(|m| Duration::from_secs(m * 60)),
            ..rule(for_minutes)
        };
        let mut instances: Vec<InstanceState> = Vec::new();
        let mut keys = std::collections::HashSet::new();
        for (minute, (outcome, silenced)) in outcomes.iter().enumerate() {
            let now = at(minute as i64);
            let silence = |_: &Labels| silenced.then(|| "s".to_string());
            let step = step(&rule, &instances, outcome, now, &silence);
            // Same input, same output.
            prop_assert_eq!(&step, &super::step(&rule, &instances, outcome, now, &silence));
            prop_assert!(!silenced || step.notifications.is_empty());
            for n in &step.notifications {
                prop_assert!(keys.insert(n.dedup_key("cp")), "sent twice: {:?}", n);
                prop_assert!(n.event == Event::Resolved || n.state.is_active());
            }
            let mut fps = std::collections::HashSet::new();
            for i in &step.instances {
                prop_assert!(fps.insert(i.fingerprint.clone()));
                prop_assert_eq!(&i.fingerprint, &fingerprint(RULE, &i.labels));
                prop_assert!(i.missing < MISSING_EVALUATIONS_TO_END);
                if i.state == State::Pending {
                    prop_assert!(i.pending.is_some());
                }
                if i.state == State::Ok {
                    prop_assert!(i.pending.is_none());
                }
                if let Some(p) = i.pending {
                    prop_assert!(p.target.is_active() && p.target != i.state);
                }
            }
            instances = step.instances;
        }
    }
}
