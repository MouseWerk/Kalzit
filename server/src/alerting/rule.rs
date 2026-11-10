//! The stored parts of an alert rule as the API takes them and the evaluation reads them: the
//! query copy, the reduce step per shape, the condition, labels and the behavior on no data and
//! errors (docs/api/alerting.md, "Rules"). Everything here is checked before a rule is saved;
//! what is stored always parses again.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{ApiError, ApiResult};

/// The query a rule runs: the source's own query, the visible steps after it and fixed values of
/// the variables it uses, as `QueryItem` takes them (`shapes::QueryItem`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuleQuery {
    pub query: Value,
    #[serde(default)]
    pub steps: Vec<Value>,
    #[serde(default)]
    pub variables: BTreeMap<String, Value>,
}

pub const MAX_QUERY_BYTES: usize = 64 * 1024;
pub const MAX_STEPS: usize = 20;
pub const MAX_VARIABLES: usize = 50;

impl RuleQuery {
    pub fn check(&self) -> ApiResult<()> {
        if self.query.is_null() {
            return Err(invalid("query", "the query is required", "alerts.query_invalid"));
        }
        if self.steps.len() > MAX_STEPS || self.variables.len() > MAX_VARIABLES {
            return Err(invalid(
                "query",
                format!("a rule's query has at most {MAX_STEPS} steps and {MAX_VARIABLES} variables"),
                "alerts.query_invalid",
            ));
        }
        let bytes = serde_json::to_vec(self).map(|v| v.len()).unwrap_or(usize::MAX);
        if bytes > MAX_QUERY_BYTES {
            return Err(invalid(
                "query",
                format!("the query may have at most {MAX_QUERY_BYTES} bytes"),
                "alerts.query_invalid",
            ));
        }
        Ok(())
    }
}

/// How a `frame` series becomes one number.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FrameFunction {
    Last,
    Min,
    Max,
    Mean,
    Sum,
    Count,
}

/// How a field of `documents` becomes one number.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DocumentFunction {
    First,
    Min,
    Max,
    Mean,
    Sum,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DocumentMode {
    /// The number of documents in the result.
    Count,
    /// A field's value over `path`, reduced with `function`.
    Field,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GraphCount {
    Nodes,
    Edges,
    Paths,
}

/// The reduce step, by the shape of the query's result. Its JSON carries `shape`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "shape", rename_all = "camelCase", deny_unknown_fields)]
pub enum Reduce {
    /// Each series (numeric field with its labels) becomes an instance.
    Frame { function: FrameFunction },
    /// One instance per rule.
    #[serde(rename_all = "camelCase")]
    Documents {
        mode: DocumentMode,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        path: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        function: Option<DocumentFunction>,
    },
    /// One instance per rule; `label` keeps only nodes with that label or edges of that type.
    #[serde(rename_all = "camelCase")]
    Graph {
        count: GraphCount,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        label: Option<String>,
    },
}

const MAX_PATH_CHARS: usize = 256;
const MAX_GRAPH_LABEL_CHARS: usize = 128;

impl Reduce {
    pub fn parse(value: &Value) -> ApiResult<Self> {
        let reduce: Reduce = serde_json::from_value(value.clone())
            .map_err(|e| invalid("reduce", format!("reduce: {e}"), "alerts.reduce_invalid"))?;
        reduce.check()?;
        Ok(reduce)
    }

    fn check(&self) -> ApiResult<()> {
        match self {
            Reduce::Frame { .. } => Ok(()),
            Reduce::Documents { mode: DocumentMode::Count, path: None, function: None } => Ok(()),
            Reduce::Documents { mode: DocumentMode::Count, .. } => {
                Err(invalid("reduce", "counting documents takes no path or function", "alerts.reduce_invalid"))
            }
            Reduce::Documents { mode: DocumentMode::Field, path: Some(path), function: Some(_) } => {
                let ok = path.starts_with("$.")
                    && path.len() > 2
                    && path.chars().count() <= MAX_PATH_CHARS
                    && !path.chars().any(|c| c.is_control() || c.is_whitespace());
                if ok {
                    Ok(())
                } else {
                    Err(invalid(
                        "reduce",
                        format!("path is a field path like $.queue.depth, at most {MAX_PATH_CHARS} characters"),
                        "alerts.reduce_path_invalid",
                    ))
                }
            }
            Reduce::Documents { mode: DocumentMode::Field, .. } => {
                Err(invalid("reduce", "a field value needs a path and a function", "alerts.reduce_invalid"))
            }
            Reduce::Graph { count: GraphCount::Paths, label: Some(_) } => {
                Err(invalid("reduce", "paths are counted without a label", "alerts.reduce_invalid"))
            }
            Reduce::Graph { label: Some(label), .. } => {
                let ok = !label.trim().is_empty()
                    && label.chars().count() <= MAX_GRAPH_LABEL_CHARS
                    && !label.chars().any(char::is_control);
                if ok {
                    Ok(())
                } else {
                    Err(invalid(
                        "reduce",
                        format!("label needs 1 to {MAX_GRAPH_LABEL_CHARS} characters"),
                        "alerts.reduce_invalid",
                    ))
                }
            }
            Reduce::Graph { .. } => Ok(()),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Op {
    Gt,
    Gte,
    Lt,
    Lte,
    Eq,
    Ne,
    /// Below `low` or above `high`.
    Outside,
    /// From `low` to `high`, both included.
    Inside,
}

/// The condition against fixed numbers: `value` for the comparisons, `low` and `high` for
/// `outside` and `inside`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Condition {
    pub op: Op,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub low: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub high: Option<f64>,
}

impl Condition {
    pub fn parse(value: &Value) -> ApiResult<Self> {
        let condition: Condition = serde_json::from_value(value.clone())
            .map_err(|e| invalid("condition", format!("condition: {e}"), "alerts.condition_invalid"))?;
        let finite = |v: Option<f64>| v.is_some_and(f64::is_finite);
        let ok = match condition.op {
            Op::Outside | Op::Inside => {
                condition.value.is_none()
                    && finite(condition.low)
                    && finite(condition.high)
                    && condition.low < condition.high
            }
            _ => finite(condition.value) && condition.low.is_none() && condition.high.is_none(),
        };
        if !ok {
            return Err(invalid(
                "condition",
                "a comparison takes one finite value; outside and inside take low below high",
                "alerts.condition_invalid",
            ));
        }
        Ok(condition)
    }

    /// Whether `x` meets the condition.
    pub fn holds(&self, x: f64) -> bool {
        let value = self.value.unwrap_or(f64::NAN);
        let (low, high) = (self.low.unwrap_or(f64::NAN), self.high.unwrap_or(f64::NAN));
        match self.op {
            Op::Gt => x > value,
            Op::Gte => x >= value,
            Op::Lt => x < value,
            Op::Lte => x <= value,
            Op::Eq => x == value,
            Op::Ne => x != value,
            Op::Outside => x < low || x > high,
            Op::Inside => x >= low && x <= high,
        }
    }
}

/// What a rule's instance becomes when the query has no data.
pub const NO_DATA_STATES: &[&str] = &["no_data", "ok", "firing"];
/// What it becomes when the evaluation fails: the error state, or the last state kept.
pub const ERROR_STATES: &[&str] = &["error", "keep"];
/// The states of an instance.
pub const STATES: &[&str] = &["ok", "pending", "firing", "no_data", "error"];

pub const MAX_LABELS: usize = 20;
const MAX_LABEL_NAME_CHARS: usize = 64;
const MAX_LABEL_VALUE_CHARS: usize = 256;
/// Every instance carries the rule's name under this label; rules cannot set it themselves.
pub const RULE_NAME_LABEL: &str = "alertname";

/// A label name: a letter or `_`, then letters, digits and `_`.
pub fn is_label_name(name: &str) -> bool {
    let mut chars = name.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
        && name.len() <= MAX_LABEL_NAME_CHARS
}

pub fn check_labels(labels: &BTreeMap<String, String>) -> ApiResult<()> {
    if labels.len() > MAX_LABELS {
        return Err(invalid("labels", format!("a rule has at most {MAX_LABELS} labels"), "alerts.labels_invalid"));
    }
    for (name, value) in labels {
        if !is_label_name(name) || name == RULE_NAME_LABEL || name.starts_with("__") {
            return Err(invalid(
                "labels",
                format!("{name} is not a label name (letters, digits and _, not alertname or __...)"),
                "alerts.labels_invalid",
            ));
        }
        if value.is_empty() || value.chars().count() > MAX_LABEL_VALUE_CHARS || value.chars().any(char::is_control) {
            return Err(invalid(
                "labels",
                format!("the value of {name} needs 1 to {MAX_LABEL_VALUE_CHARS} characters"),
                "alerts.labels_invalid",
            ));
        }
    }
    Ok(())
}

pub fn invalid(field: &'static str, message: impl Into<String>, reason: &'static str) -> ApiError {
    ApiError::validation(message).with_field(field).because(reason)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reduce_steps_follow_the_shape() {
        for ok in [
            json!({ "shape": "frame", "function": "last" }),
            json!({ "shape": "documents", "mode": "count" }),
            json!({ "shape": "documents", "mode": "field", "path": "$.queue.depth", "function": "max" }),
            json!({ "shape": "graph", "count": "paths" }),
            json!({ "shape": "graph", "count": "nodes", "label": "Dienst" }),
        ] {
            let parsed = Reduce::parse(&ok).unwrap_or_else(|e| panic!("{ok}: {}", e.message));
            assert_eq!(serde_json::to_value(&parsed).unwrap(), ok, "round trip");
        }
        for bad in [
            json!({ "function": "last" }),
            json!({ "shape": "frame", "function": "median" }),
            json!({ "shape": "frame", "function": "last", "extra": 1 }),
            json!({ "shape": "documents", "mode": "count", "path": "$.a" }),
            json!({ "shape": "documents", "mode": "field", "function": "max" }),
            json!({ "shape": "documents", "mode": "field", "path": "queue.depth", "function": "max" }),
            json!({ "shape": "documents", "mode": "field", "path": "$.a", "function": "count" }),
            json!({ "shape": "graph", "count": "paths", "label": "X" }),
            json!({ "shape": "graph", "count": "edges", "label": " " }),
            json!({ "shape": "table" }),
        ] {
            assert!(Reduce::parse(&bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn conditions_take_one_value_or_two_bounds() {
        let gt = Condition::parse(&json!({ "op": "gt", "value": 1.5 })).unwrap();
        assert!(gt.holds(1.84) && !gt.holds(1.5));
        let outside = Condition::parse(&json!({ "op": "outside", "low": 10, "high": 20 })).unwrap();
        assert!(outside.holds(9.0) && outside.holds(21.0) && !outside.holds(10.0));
        let inside = Condition::parse(&json!({ "op": "inside", "low": 10, "high": 20 })).unwrap();
        assert!(inside.holds(10.0) && inside.holds(20.0) && !inside.holds(20.5));
        for bad in [
            json!({ "op": "gt" }),
            json!({ "op": "gt", "value": 1, "low": 0 }),
            json!({ "op": "inside", "low": 5, "high": 5 }),
            json!({ "op": "inside", "value": 1, "low": 0, "high": 2 }),
            json!({ "op": "between", "value": 1 }),
            json!({ "op": "eq", "value": "1" }),
        ] {
            assert!(Condition::parse(&bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn labels_are_names_and_short_values() {
        let ok: BTreeMap<String, String> = [("team".into(), "lager".into()), ("_x1".into(), "ä".into())].into();
        assert!(check_labels(&ok).is_ok());
        for (name, value) in [("alertname", "x"), ("1a", "x"), ("a-b", "x"), ("__x", "x"), ("a", ""), ("a", "x\ny")] {
            let bad: BTreeMap<String, String> = [(name.to_string(), value.to_string())].into();
            assert!(check_labels(&bad).is_err(), "{name}={value:?}");
        }
        let many: BTreeMap<String, String> = (0..=MAX_LABELS).map(|i| (format!("l{i}"), "v".to_string())).collect();
        assert!(check_labels(&many).is_err());
    }
}
