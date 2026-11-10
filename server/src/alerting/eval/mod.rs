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
/// number per instance. Its JSON is the stored one of `alert_rules` (`alerting::rule::Reduce`:
/// `shape`, then `function`, `mode`/`path` or `count`/`label`); saving checks it there, reading
/// it here only checks that it can be evaluated.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(try_from = "RawReduce", into = "RawReduce")]
pub enum ReduceSpec {
    /// Per series of a frame (each number field with its labels; in long tables per label
    /// combination).
    Frame { reducer: FrameReducer },
    /// One instance per rule: the number of documents, or a number field over a path.
    Documents { of: DocumentsReduce },
    /// One instance per rule: the number of nodes, edges or paths.
    Graph { count: GraphCount },
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

#[derive(Clone, Debug, PartialEq)]
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

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GraphCount {
    /// Nodes, optionally only those carrying `label`.
    Nodes {
        label: Option<String>,
    },
    /// Edges, optionally only those of `edge_type`.
    Edges {
        edge_type: Option<String>,
    },
    Paths,
}

/// The stored JSON of the reduce step, field for field as `alerting::rule::Reduce`.
#[derive(Serialize, Deserialize)]
#[serde(tag = "shape", rename_all = "camelCase", deny_unknown_fields)]
enum RawReduce {
    Frame {
        function: FrameReducer,
    },
    Documents {
        mode: RawDocumentMode,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        path: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        function: Option<FieldReducer>,
    },
    Graph {
        count: RawGraphCount,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        label: Option<String>,
    },
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum RawDocumentMode {
    Count,
    Field,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum RawGraphCount {
    Nodes,
    Edges,
    Paths,
}

impl TryFrom<RawReduce> for ReduceSpec {
    type Error = String;

    fn try_from(raw: RawReduce) -> Result<Self, String> {
        Ok(match raw {
            RawReduce::Frame { function } => ReduceSpec::Frame { reducer: function },
            RawReduce::Documents { mode: RawDocumentMode::Count, path: None, function: None } => {
                ReduceSpec::Documents { of: DocumentsReduce::Count }
            }
            RawReduce::Documents { mode: RawDocumentMode::Count, .. } => {
                return Err("counting documents takes no path or function".into());
            }
            RawReduce::Documents { mode: RawDocumentMode::Field, path: Some(path), function: Some(reducer) } => {
                let parts = reduce::path_parts(&path);
                if parts.is_empty() || parts.iter().any(|p| p.is_empty()) {
                    return Err(format!("invalid field path {path:?}"));
                }
                ReduceSpec::Documents { of: DocumentsReduce::Field { path, reducer } }
            }
            RawReduce::Documents { mode: RawDocumentMode::Field, .. } => {
                return Err("a field value needs a path and a function".into());
            }
            RawReduce::Graph { count: RawGraphCount::Nodes, label } => {
                ReduceSpec::Graph { count: GraphCount::Nodes { label } }
            }
            RawReduce::Graph { count: RawGraphCount::Edges, label } => {
                ReduceSpec::Graph { count: GraphCount::Edges { edge_type: label } }
            }
            RawReduce::Graph { count: RawGraphCount::Paths, label: None } => {
                ReduceSpec::Graph { count: GraphCount::Paths }
            }
            RawReduce::Graph { count: RawGraphCount::Paths, .. } => {
                return Err("paths are counted without a label".into());
            }
        })
    }
}

impl From<ReduceSpec> for RawReduce {
    fn from(spec: ReduceSpec) -> Self {
        match spec {
            ReduceSpec::Frame { reducer } => RawReduce::Frame { function: reducer },
            ReduceSpec::Documents { of: DocumentsReduce::Count } => {
                RawReduce::Documents { mode: RawDocumentMode::Count, path: None, function: None }
            }
            ReduceSpec::Documents { of: DocumentsReduce::Field { path, reducer } } => {
                RawReduce::Documents { mode: RawDocumentMode::Field, path: Some(path), function: Some(reducer) }
            }
            ReduceSpec::Graph { count: GraphCount::Nodes { label } } => {
                RawReduce::Graph { count: RawGraphCount::Nodes, label }
            }
            ReduceSpec::Graph { count: GraphCount::Edges { edge_type } } => {
                RawReduce::Graph { count: RawGraphCount::Edges, label: edge_type }
            }
            ReduceSpec::Graph { count: GraphCount::Paths } => {
                RawReduce::Graph { count: RawGraphCount::Paths, label: None }
            }
        }
    }
}

/// The condition against fixed numbers; met means the instance is on its way to firing. Its
/// JSON is the stored one (`alerting::rule::Condition`: `op` with `value`, or `low` and `high`).
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(try_from = "RawCondition", into = "RawCondition")]
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
    Inside {
        low: f64,
        high: f64,
    },
    /// `x < low` or `x > high`.
    Outside {
        low: f64,
        high: f64,
    },
}

#[derive(Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum RawOp {
    Gt,
    Gte,
    Lt,
    Lte,
    Eq,
    Ne,
    Outside,
    Inside,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawCondition {
    op: RawOp,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    value: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    low: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    high: Option<f64>,
}

impl TryFrom<RawCondition> for Condition {
    type Error = String;

    fn try_from(raw: RawCondition) -> Result<Self, String> {
        let finite = |v: Option<f64>| v.filter(|v| v.is_finite());
        let one = || match (finite(raw.value), raw.low, raw.high) {
            (Some(value), None, None) => Ok(value),
            _ => Err("a comparison takes one finite value".to_string()),
        };
        let two = || match (raw.value, finite(raw.low), finite(raw.high)) {
            (None, Some(low), Some(high)) if low <= high => Ok((low, high)),
            _ => Err("outside and inside take a finite low up to high".to_string()),
        };
        Ok(match raw.op {
            RawOp::Gt => Condition::Gt { value: one()? },
            RawOp::Gte => Condition::Gte { value: one()? },
            RawOp::Lt => Condition::Lt { value: one()? },
            RawOp::Lte => Condition::Lte { value: one()? },
            RawOp::Eq => Condition::Eq { value: one()? },
            RawOp::Ne => Condition::Ne { value: one()? },
            RawOp::Inside => {
                let (low, high) = two()?;
                Condition::Inside { low, high }
            }
            RawOp::Outside => {
                let (low, high) = two()?;
                Condition::Outside { low, high }
            }
        })
    }
}

impl From<Condition> for RawCondition {
    fn from(condition: Condition) -> Self {
        let one = |op, value| RawCondition { op, value: Some(value), low: None, high: None };
        let two = |op, low, high| RawCondition { op, value: None, low: Some(low), high: Some(high) };
        match condition {
            Condition::Gt { value } => one(RawOp::Gt, value),
            Condition::Gte { value } => one(RawOp::Gte, value),
            Condition::Lt { value } => one(RawOp::Lt, value),
            Condition::Lte { value } => one(RawOp::Lte, value),
            Condition::Eq { value } => one(RawOp::Eq, value),
            Condition::Ne { value } => one(RawOp::Ne, value),
            Condition::Inside { low, high } => two(RawOp::Inside, low, high),
            Condition::Outside { low, high } => two(RawOp::Outside, low, high),
        }
    }
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
            Condition::Inside { low, high } => low <= value && value <= high,
            Condition::Outside { low, high } => value < low || value > high,
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
            (Condition::Inside { low: 1.0, high: 2.0 }, 1.0, true),
            (Condition::Inside { low: 1.0, high: 2.0 }, 2.0, true),
            (Condition::Inside { low: 1.0, high: 2.0 }, 2.1, false),
            (Condition::Inside { low: 1.0, high: 2.0 }, 0.9, false),
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

    /// The JSON is the stored one of `alerting::rule` (`Reduce`, `Condition`): every example
    /// that type accepts reads here and writes back unchanged.
    #[test]
    fn stored_rule_json_round_trips() {
        let cases = [
            json!({ "shape": "frame", "function": "last" }),
            json!({ "shape": "documents", "mode": "count" }),
            json!({ "shape": "documents", "mode": "field", "path": "$.queue.depth", "function": "max" }),
            json!({ "shape": "graph", "count": "paths" }),
            json!({ "shape": "graph", "count": "nodes", "label": "Dienst" }),
            json!({ "shape": "graph", "count": "nodes" }),
            json!({ "shape": "graph", "count": "edges", "label": "CALLS" }),
        ];
        for case in cases {
            let spec: ReduceSpec = serde_json::from_value(case.clone()).unwrap_or_else(|e| panic!("{case}: {e}"));
            assert_eq!(serde_json::to_value(&spec).unwrap(), case);
        }
        let edges: ReduceSpec =
            serde_json::from_value(json!({ "shape": "graph", "count": "edges", "label": "CALLS" })).unwrap();
        assert_eq!(edges, ReduceSpec::Graph { count: GraphCount::Edges { edge_type: Some("CALLS".into()) } });
        for bad in [
            json!({ "function": "last" }),
            json!({ "shape": "frame", "function": "median" }),
            json!({ "shape": "frame", "function": "last", "extra": 1 }),
            json!({ "shape": "documents", "mode": "count", "path": "$.a" }),
            json!({ "shape": "documents", "mode": "field", "function": "max" }),
            json!({ "shape": "documents", "mode": "field", "path": "$.", "function": "max" }),
            json!({ "shape": "documents", "mode": "field", "path": "a..b", "function": "max" }),
            json!({ "shape": "documents", "mode": "field", "path": "$.a", "function": "count" }),
            json!({ "shape": "graph", "count": "paths", "label": "X" }),
            json!({ "shape": "table" }),
        ] {
            assert!(serde_json::from_value::<ReduceSpec>(bad.clone()).is_err(), "{bad}");
        }

        let conditions = [
            (json!({ "op": "gt", "value": 1.5 }), Condition::Gt { value: 1.5 }),
            (json!({ "op": "gte", "value": 1.0 }), Condition::Gte { value: 1.0 }),
            (json!({ "op": "lt", "value": 1.0 }), Condition::Lt { value: 1.0 }),
            (json!({ "op": "lte", "value": 1.0 }), Condition::Lte { value: 1.0 }),
            (json!({ "op": "eq", "value": 0.0 }), Condition::Eq { value: 0.0 }),
            (json!({ "op": "ne", "value": 2.0 }), Condition::Ne { value: 2.0 }),
            (json!({ "op": "inside", "low": 10.0, "high": 20.0 }), Condition::Inside { low: 10.0, high: 20.0 }),
            (json!({ "op": "outside", "low": 10.0, "high": 20.0 }), Condition::Outside { low: 10.0, high: 20.0 }),
        ];
        for (text, condition) in conditions {
            assert_eq!(serde_json::from_value::<Condition>(text.clone()).unwrap(), condition);
            assert_eq!(serde_json::to_value(condition).unwrap(), text);
        }
        for bad in [
            json!({ "op": "gt" }),
            json!({ "op": "gt", "value": 1, "low": 0 }),
            json!({ "op": "inside", "low": 5, "high": 4 }),
            json!({ "op": "inside", "value": 1, "low": 0, "high": 2 }),
            json!({ "op": "between", "value": 1 }),
            json!({ "op": "eq", "value": "1" }),
            json!({ "op": "gt", "value": 1, "extra": 2 }),
        ] {
            assert!(serde_json::from_value::<Condition>(bad.clone()).is_err(), "{bad}");
        }
    }

    #[test]
    fn errors_have_codes_and_texts() {
        let error = EvalError::NotANumber { field: "$.depth".into(), found: "text".into() };
        assert_eq!(error.code(), "alerting.not_a_number");
        assert_eq!(error.to_string(), "$.depth holds text, not a number");
        assert_eq!(serde_json::to_value(&error).unwrap()["code"], "notANumber");
    }
}
