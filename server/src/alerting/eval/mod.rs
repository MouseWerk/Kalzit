//! The evaluation core of alerting (docs/PLAN.md, section 13), free of the database and the
//! network: a query result in its native shape goes through the rule's explicit reduce step
//! ([`reduce`]) to one number per instance, the condition decides per instance ([`Condition`]),
//! and the state machine ([`step`]) turns that into the new instance states, the history
//! transitions and the notifications a notifier would send. Nothing here sends, stores or reads
//! a clock; the caller passes `now` and the stored instance states.

mod reduce;
mod state;

use std::collections::BTreeMap;
use std::fmt;

use serde::{Deserialize, Serialize};

pub use reduce::{FIELD_LABEL, Reduced, Reduction, SeriesValue, label_text, reduce};
pub use state::{
    ErrorBehavior, Event, InstanceState, LastNotification, MISSING_EVALUATIONS_TO_END, NoDataBehavior, Notification,
    Outcome, PendingTarget, ResolveReason, RuleTiming, SeriesOutcome, State, Step, Transition, fingerprint, outcome,
    step,
};

/// Labels of a series or instance, sorted by key.
pub type Labels = BTreeMap<String, String>;

/// The reduce step of a rule: how its result, in the shape the query answers with, becomes one
/// number per instance. Stored as JSON with `shape`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "shape", rename_all = "camelCase")]
pub enum ReduceSpec {
    /// Per series of a frame (each number field with its labels; in long tables per label
    /// combination).
    Frame { reducer: FrameReducer },
    /// One instance per rule: the number of documents, or a number field over a path.
    Documents {
        #[serde(flatten)]
        of: DocumentsReduce,
    },
    /// One instance per rule: the number of nodes, edges or paths.
    Graph {
        #[serde(flatten)]
        count: GraphCount,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FrameReducer {
    Last,
    Min,
    Max,
    Mean,
    Sum,
    Count,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "camelCase")]
pub enum DocumentsReduce {
    /// The number of documents in the result; which ones match is the query's business.
    Count,
    /// A field value over a path such as `$.queue.depth` (array elements by index, `items.0`).
    Field { path: String, reducer: FieldReducer },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FieldReducer {
    First,
    Min,
    Max,
    Mean,
    Sum,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "of", rename_all = "camelCase")]
pub enum GraphCount {
    /// Nodes, optionally only those carrying `label`.
    Nodes {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        label: Option<String>,
    },
    /// Edges, optionally only those of `edgeType`.
    Edges {
        #[serde(default, rename = "edgeType", skip_serializing_if = "Option::is_none")]
        edge_type: Option<String>,
    },
    Paths,
}

/// The condition against fixed numbers; met means the instance is on its way to firing.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", deny_unknown_fields)]
pub enum Condition {
    Gt {
        value: f64,
    },
    Gte {
        value: f64,
    },
    Lt {
        value: f64,
    },
    Lte {
        value: f64,
    },
    Eq {
        value: f64,
    },
    Ne {
        value: f64,
    },
    /// `low <= x <= high`.
    Within {
        low: f64,
        high: f64,
    },
    /// `x < low` or `x > high`.
    Outside {
        low: f64,
        high: f64,
    },
}

impl Condition {
    /// Whether `value` meets the condition. Callers never pass NaN ([`reduce`] reports it as an
    /// error); with NaN every comparison is false, and `Ne` true.
    pub fn is_met(&self, value: f64) -> bool {
        match *self {
            Condition::Gt { value: v } => value > v,
            Condition::Gte { value: v } => value >= v,
            Condition::Lt { value: v } => value < v,
            Condition::Lte { value: v } => value <= v,
            Condition::Eq { value: v } => value == v,
            Condition::Ne { value: v } => value != v,
            Condition::Within { low, high } => low <= value && value <= high,
            Condition::Outside { low, high } => value < low || value > high,
        }
    }

    /// Bounds are finite numbers and a range has `low <= high`.
    pub fn validate(&self) -> Result<(), String> {
        let finite =
            |v: f64| if v.is_finite() { Ok(()) } else { Err("the condition needs finite numbers".to_string()) };
        match *self {
            Condition::Gt { value }
            | Condition::Gte { value }
            | Condition::Lt { value }
            | Condition::Lte { value }
            | Condition::Eq { value }
            | Condition::Ne { value } => finite(value),
            Condition::Within { low, high } | Condition::Outside { low, high } => {
                finite(low)?;
                finite(high)?;
                if low > high { Err("the lower bound is above the upper bound".into()) } else { Ok(()) }
            }
        }
    }
}

impl ReduceSpec {
    /// A documents path is not empty; checked when a rule is saved.
    pub fn validate(&self) -> Result<(), String> {
        match self {
            ReduceSpec::Documents { of: DocumentsReduce::Field { path, .. } } => {
                let trimmed = reduce::path_parts(path);
                if trimmed.is_empty() || trimmed.iter().any(|p| p.is_empty()) {
                    return Err(format!("invalid field path {path:?}"));
                }
                Ok(())
            }
            _ => Ok(()),
        }
    }
}

/// Why an evaluation ends in the state Error. `code` is stable for the UI's catalogs; `Display`
/// is the English text for history and notifications.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "code", rename_all = "camelCase")]
pub enum EvalError {
    /// The query failed in the source; the text is the source's error as the API reports it.
    QueryFailed {
        message: String,
    },
    Timeout,
    /// The source is not enabled for alerting (any more).
    SourceNotEnabled,
    /// The query answered in another shape than the reduce step expects.
    WrongShape {
        expected: String,
        got: String,
    },
    /// A value where a number is expected is text, a bool, an object, ... (never converted).
    NotANumber {
        field: String,
        found: String,
    },
    /// The reduced value is NaN (e.g. the sum of +Infinity and -Infinity).
    NaN {
        field: String,
    },
    /// More series than the rule may have instances.
    TooManySeries {
        limit: usize,
    },
    /// Two series of the result carry the same labels, so they cannot be told apart.
    DuplicateSeries {
        labels: String,
    },
}

impl EvalError {
    pub fn code(&self) -> &'static str {
        match self {
            EvalError::QueryFailed { .. } => "alerting.query_failed",
            EvalError::Timeout => "alerting.timeout",
            EvalError::SourceNotEnabled => "alerting.source_not_enabled",
            EvalError::WrongShape { .. } => "alerting.wrong_shape",
            EvalError::NotANumber { .. } => "alerting.not_a_number",
            EvalError::NaN { .. } => "alerting.nan",
            EvalError::TooManySeries { .. } => "alerting.too_many_series",
            EvalError::DuplicateSeries { .. } => "alerting.duplicate_series",
        }
    }
}

impl fmt::Display for EvalError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            EvalError::QueryFailed { message } => write!(f, "Query failed: {message}"),
            EvalError::Timeout => f.write_str("The evaluation took too long"),
            EvalError::SourceNotEnabled => f.write_str("Data source is not enabled for alerting"),
            EvalError::WrongShape { expected, got } => {
                write!(f, "The query returned {got}, the rule expects {expected}")
            }
            EvalError::NotANumber { field, found } => write!(f, "{field} holds {found}, not a number"),
            EvalError::NaN { field } => write!(f, "{field} reduces to NaN"),
            EvalError::TooManySeries { limit } => write!(f, "Too many series (more than {limit})"),
            EvalError::DuplicateSeries { labels } => write!(f, "Two series with the same labels: {labels}"),
        }
    }
}

impl std::error::Error for EvalError {}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn conditions_compare_as_written() {
        let cases: &[(Condition, f64, bool)] = &[
            (Condition::Gt { value: 1.0 }, 1.0, false),
            (Condition::Gt { value: 1.0 }, 1.5, true),
            (Condition::Gte { value: 1.0 }, 1.0, true),
            (Condition::Gte { value: 1.0 }, 0.9, false),
            (Condition::Lt { value: 1.0 }, 1.0, false),
            (Condition::Lt { value: 1.0 }, -3.0, true),
            (Condition::Lte { value: 1.0 }, 1.0, true),
            (Condition::Lte { value: 1.0 }, 1.1, false),
            (Condition::Eq { value: 0.0 }, 0.0, true),
            (Condition::Eq { value: 0.0 }, -0.0, true),
            (Condition::Eq { value: 2.0 }, 2.000_001, false),
            (Condition::Ne { value: 2.0 }, 2.0, false),
            (Condition::Ne { value: 2.0 }, 3.0, true),
            (Condition::Within { low: 1.0, high: 2.0 }, 1.0, true),
            (Condition::Within { low: 1.0, high: 2.0 }, 2.0, true),
            (Condition::Within { low: 1.0, high: 2.0 }, 2.1, false),
            (Condition::Within { low: 1.0, high: 2.0 }, 0.9, false),
            (Condition::Outside { low: 1.0, high: 2.0 }, 1.0, false),
            (Condition::Outside { low: 1.0, high: 2.0 }, 2.0, false),
            (Condition::Outside { low: 1.0, high: 2.0 }, 0.5, true),
            (Condition::Outside { low: 1.0, high: 2.0 }, 2.5, true),
            (Condition::Gt { value: 1e300 }, f64::INFINITY, true),
            (Condition::Lt { value: -1e300 }, f64::NEG_INFINITY, true),
        ];
        for (condition, value, met) in cases {
            assert_eq!(condition.is_met(*value), *met, "{condition:?} with {value}");
        }
    }

    #[test]
    fn conditions_validate_their_bounds() {
        assert!(Condition::Gt { value: 1.0 }.validate().is_ok());
        assert!(Condition::Gt { value: f64::NAN }.validate().is_err());
        assert!(Condition::Lt { value: f64::INFINITY }.validate().is_err());
        assert!(Condition::Within { low: 1.0, high: 1.0 }.validate().is_ok());
        assert!(Condition::Within { low: 2.0, high: 1.0 }.validate().is_err());
        assert!(Condition::Outside { low: 0.0, high: f64::NAN }.validate().is_err());
    }

    #[test]
    fn rule_json_round_trips() {
        let cases = [
            json!({ "shape": "frame", "reducer": "last" }),
            json!({ "shape": "documents", "mode": "count" }),
            json!({ "shape": "documents", "mode": "field", "path": "$.queue.depth", "reducer": "mean" }),
            json!({ "shape": "graph", "of": "nodes", "label": "Server" }),
            json!({ "shape": "graph", "of": "nodes" }),
            json!({ "shape": "graph", "of": "edges", "edgeType": "CALLS" }),
            json!({ "shape": "graph", "of": "paths" }),
        ];
        for case in cases {
            let spec: ReduceSpec = serde_json::from_value(case.clone()).unwrap();
            assert_eq!(serde_json::to_value(&spec).unwrap(), case);
        }
        let within: Condition = serde_json::from_value(json!({ "op": "within", "low": 1, "high": 2.5 })).unwrap();
        assert_eq!(within, Condition::Within { low: 1.0, high: 2.5 });
        assert_eq!(serde_json::to_value(Condition::Gte { value: 3.0 }).unwrap(), json!({ "op": "gte", "value": 3.0 }));
        assert!(serde_json::from_value::<ReduceSpec>(json!({ "shape": "frame", "reducer": "median" })).is_err());
        assert!(serde_json::from_value::<Condition>(json!({ "op": "gt", "value": 1, "extra": 2 })).is_err());
    }

    #[test]
    fn documents_paths_are_checked() {
        let field = |path: &str| ReduceSpec::Documents {
            of: DocumentsReduce::Field { path: path.into(), reducer: FieldReducer::First },
        };
        assert!(field("$.queue.depth").validate().is_ok());
        assert!(field("queue.depth").validate().is_ok());
        assert!(field("$.").validate().is_err());
        assert!(field("").validate().is_err());
        assert!(field("a..b").validate().is_err());
    }

    #[test]
    fn errors_have_codes_and_texts() {
        let error = EvalError::NotANumber { field: "$.depth".into(), found: "text".into() };
        assert_eq!(error.code(), "alerting.not_a_number");
        assert_eq!(error.to_string(), "$.depth holds text, not a number");
        assert_eq!(serde_json::to_value(&error).unwrap()["code"], "notANumber");
    }
}
