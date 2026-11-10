use std::collections::BTreeMap;
use std::time::Duration;

use proptest::prelude::*;
use serde_json::json;

use super::*;
use crate::alerting::eval::{FrameReducer, GraphCount};
use crate::shapes::{Field, FieldType, Frame, GraphSet};

const RULE: &str = "rule-1";

fn at(minute: i64) -> i64 {
    1_800_000_000_000 + minute * 60_000
}

fn rule(for_minutes: u64) -> RuleTiming {
    RuleTiming {
        rule_id: RULE.into(),
        for_duration: Duration::from_secs(for_minutes * 60),
        no_data: NoDataBehavior::NoData,
        error: ErrorBehavior::Error,
        reminder: None,
    }
}

fn labels(pairs: &[(&str, &str)]) -> Labels {
    pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
}

/// One series without labels.
fn single(outcome: SeriesOutcome) -> Outcome {
    Outcome::Series(vec![(Labels::new(), outcome)])
}

const MET: SeriesOutcome = SeriesOutcome::Met(5.0);
const NOT: SeriesOutcome = SeriesOutcome::NotMet(1.0);

fn failed() -> Outcome {
    Outcome::Error(EvalError::Timeout)
}

fn never(_: &Labels) -> bool {
    false
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
            outcomes: vec![single(MET), Outcome::NoData, single(SeriesOutcome::NoData)],
            want: vec![(SFire, vec![EFire]), (SOk, vec![EOk]), (SOk, vec![])],
        },
        Case {
            name: "no data as firing",
            rule: RuleTiming { for_duration: Duration::ZERO, ..with(NoDataBehavior::Firing, ErrorBehavior::Error) },
            outcomes: vec![Outcome::NoData, single(MET)],
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
            rule: with(NoDataBehavior::NoData, ErrorBehavior::KeepLast),
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
            rule: with(NoDataBehavior::NoData, ErrorBehavior::KeepLast),
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
    for (minute, outcome) in [single(MET), single(MET), single(NOT)].iter().enumerate() {
        let step = step(&rule, &instances, outcome, at(minute as i64), &never);
        instances = step.instances;
        all.extend(step.transitions);
    }
    let path: Vec<(State, State, i64, Option<f64>)> = all.iter().map(|t| (t.from, t.to, t.at, t.value)).collect();
    assert_eq!(
        path,
        vec![(SOk, SPend, at(0), Some(5.0)), (SPend, SFire, at(1), Some(5.0)), (SFire, SOk, at(2), Some(1.0)),]
    );
    let instance = &instances[0];
    assert_eq!(instance.state, SOk);
    assert_eq!(instance.since, at(2));
    assert_eq!(instance.last_evaluated_at, Some(at(2)));
    assert_eq!(instance.last_value, Some(1.0));
}

#[test]
fn errors_keep_their_text() {
    let step = step(&rule(0), &[], &failed(), at(0), &never);
    assert_eq!(step.instances[0].last_error.as_deref(), Some("The evaluation took too long"));
    assert_eq!(step.transitions[0].error.as_deref(), Some("The evaluation took too long"));
    assert_eq!(step.notifications[0].error.as_deref(), Some("The evaluation took too long"));
    assert_eq!(step.notifications[0].value, None);
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
fn reported_firing_is_not_reported_again_after_a_restart() {
    let rule = rule(0);
    let fired = step(&rule, &[], &single(MET), at(0), &never);
    assert_eq!(fired.notifications.len(), 1);
    // The stored state goes through JSON (the database) and back.
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
    // Reminders have their own keys; the first firing key stays the same.
    let a = step(&rule, &[], &single(MET), at(0), &never).notifications[0].dedup_key("cp");
    let b = step(&rule, &[], &single(MET), at(0), &never).notifications[0].dedup_key("cp");
    assert_eq!(a, b);
}

#[test]
fn silences_suppress_sending_but_not_evaluation() {
    let rule = rule(0);
    let silenced = |_: &Labels| true;
    let first = step(&rule, &[], &single(MET), at(0), &silenced);
    assert_eq!(first.instances[0].state, SFire);
    assert!(first.notifications.is_empty());
    assert!(first.transitions[0].silenced);
    // Still silenced: nothing.
    let second = step(&rule, &first.instances, &single(MET), at(1), &silenced);
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
    let silenced = |_: &Labels| true;
    let fired = step(&rule, &[], &single(MET), at(0), &silenced);
    let resolved = step(&rule, &fired.instances, &single(NOT), at(1), &never);
    assert_eq!(resolved.instances[0].state, SOk);
    assert_eq!(resolved.transitions.len(), 1);
    assert!(resolved.notifications.is_empty());
}

#[test]
fn silences_match_per_instance() {
    let rule = rule(0);
    let outcome = Outcome::Series(vec![(labels(&[("host", "a")]), MET), (labels(&[("host", "b")]), MET)]);
    let only_a = |l: &Labels| l.get("host").is_some_and(|h| h == "a");
    let step = step(&rule, &[], &outcome, at(0), &only_a);
    assert_eq!(step.notifications.len(), 1);
    assert_eq!(step.notifications[0].labels, labels(&[("host", "b")]));
}

#[test]
fn a_series_missing_three_times_ends_with_a_resolve() {
    let rule = rule(0);
    let a = labels(&[("host", "a")]);
    let b = labels(&[("host", "b")]);
    let both = Outcome::Series(vec![(a.clone(), MET), (b.clone(), NOT)]);
    let only_b = Outcome::Series(vec![(b.clone(), NOT)]);
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
    let both = Outcome::Series(vec![(a.clone(), NOT), (b.clone(), NOT)]);
    let only_b = Outcome::Series(vec![(b, NOT)]);
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
fn rule_wide_errors_apply_to_every_instance_and_do_not_count_as_missing() {
    let rule = rule(0);
    let series = Outcome::Series(vec![(labels(&[("host", "a")]), NOT), (labels(&[("host", "b")]), NOT)]);
    let mut instances = step(&rule, &[], &series, at(0), &never).instances;
    for minute in 1..=5 {
        instances = step(&rule, &instances, &failed(), at(minute), &never).instances;
    }
    assert_eq!(instances.len(), 2);
    assert!(instances.iter().all(|i| i.state == SErr && i.missing == 0));
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
    let rule = rule(0);
    let fired = step(&rule, &[], &single(MET), at(0), &never);
    let firing = &fired.notifications[0];
    let base = firing.dedup_key("cp-1");
    assert_eq!(base.len(), 64);
    assert_ne!(base, firing.dedup_key("cp-2"));
    let resolved = step(&rule, &fired.instances, &single(NOT), at(1), &never);
    assert_ne!(base, resolved.notifications[0].dedup_key("cp-1"));
    // The same state again later has a new start, so a new key.
    let again = step(&rule, &resolved.instances, &single(MET), at(2), &never);
    assert_eq!(again.notifications[0].event, EFire);
    assert_ne!(base, again.notifications[0].dedup_key("cp-1"));
    assert_eq!(serde_json::to_value(firing.event).unwrap(), json!("firing"));
    assert_eq!(serde_json::to_value(Event::NoData).unwrap(), json!("no_data"));
    assert_eq!(Event::NoData.as_str(), "no_data");
}

fn frame_result(fields: Vec<Field>) -> QueryResult {
    QueryResult::Frame { frame: Frame::new(fields).unwrap() }
}

#[test]
fn outcomes_from_results() {
    let spec = ReduceSpec::Frame { reducer: FrameReducer::Last };
    let gt = Condition::Gt { value: 1.5 };
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
        Outcome::Series(vec![
            (labels(&[("job", "a")]), SeriesOutcome::Met(1.84)),
            (labels(&[("job", "b")]), SeriesOutcome::NotMet(1.0)),
            (labels(&[("job", "c")]), SeriesOutcome::NoData),
        ])
    );
    assert_eq!(outcome(&spec, &gt, Ok(&frame_result(vec![])), 100), Outcome::NoData);
    assert_eq!(outcome(&spec, &gt, Err(EvalError::SourceNotEnabled), 100), Outcome::Error(EvalError::SourceNotEnabled));
    let graph = QueryResult::Graph { graph: GraphSet::default() };
    assert_eq!(
        outcome(
            &ReduceSpec::Graph { count: GraphCount::Nodes { label: None } },
            &Condition::Eq { value: 0.0 },
            Ok(&graph),
            100
        ),
        single(SeriesOutcome::Met(0.0))
    );
    assert!(matches!(outcome(&spec, &gt, Ok(&graph), 100), Outcome::Error(EvalError::WrongShape { .. })));
}

fn any_outcome() -> impl Strategy<Value = Outcome> {
    let series = prop_oneof![
        (0.0f64..10.0).prop_map(SeriesOutcome::Met),
        (0.0f64..10.0).prop_map(SeriesOutcome::NotMet),
        Just(SeriesOutcome::NoData),
    ];
    prop_oneof![
        4 => prop::collection::vec((prop::sample::select(vec!["a", "b", "c"]), series), 0..3).prop_map(|list| {
            // Each host once per result, as the reduce step guarantees.
            let mut seen = std::collections::BTreeSet::new();
            Outcome::Series(
                list.into_iter()
                    .filter(|(h, _)| seen.insert(*h))
                    .map(|(h, s)| (labels(&[("host", h)]), s))
                    .collect(),
            )
        }),
        1 => Just(Outcome::NoData),
        1 => Just(Outcome::Error(EvalError::Timeout)),
    ]
}

proptest! {
    #![proptest_config(ProptestConfig::default())]

    /// Over any sequence of outcomes: a notification is never sent twice with the same key,
    /// fingerprints stay unique, and every instance's state is consistent with its pending start.
    #[test]
    fn invariants_over_random_sequences(
        outcomes in prop::collection::vec(any_outcome(), 1..40),
        for_minutes in 0u64..4,
        reminder in prop::option::of(1u64..5),
        no_data in prop::sample::select(vec![NoDataBehavior::NoData, NoDataBehavior::Ok, NoDataBehavior::Firing]),
        error in prop::sample::select(vec![ErrorBehavior::Error, ErrorBehavior::KeepLast]),
    ) {
        let rule = RuleTiming {
            no_data,
            error,
            reminder: reminder.map(|m| Duration::from_secs(m * 60)),
            ..rule(for_minutes)
        };
        let mut instances: Vec<InstanceState> = Vec::new();
        let mut keys = std::collections::HashSet::new();
        for (minute, outcome) in outcomes.iter().enumerate() {
            let now = at(minute as i64);
            let step = step(&rule, &instances, outcome, now, &never);
            // Same input, same output.
            prop_assert_eq!(&step, &super::step(&rule, &instances, outcome, now, &never));
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
