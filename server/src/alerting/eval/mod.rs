//! The evaluation core of alerting (docs/PLAN.md, section 13), free of the database and the
//! network: a query result in its native shape goes through the rule's explicit reduce step
//! ([`reduce`], with the stored `rule::Reduce`) to one number per instance, the stored
//! `rule::Condition` decides per instance ([`outcome`]), and the state machine ([`step`]) turns
//! that into the new instance states, the history transitions and the notifications a notifier
//! would send. Nothing here sends, stores or reads a clock; `alerting::instances` stores what
//! [`step`] returns.
//!
//! # Contract for the scheduler
//!
//! [`step`] is pure: given the stored instances and the same outcome it answers the same. It
//! marks a notification as sent (`InstanceState::last_notification`) when it returns it, so the
//! scheduler must store the returned instances, the transitions and the deliveries to make (one
//! per notification and contact point, keyed by [`Notification::dedup_key`]) in **one
//! transaction**, and only send after that commit, from the stored deliveries. A crash before the
//! commit repeats the evaluation; a crash after it finds the deliveries still to send; a delivery
//! whose key is already recorded is never made twice. `tick` is the scheduled time of the
//! evaluation (the rule's fixed offset in its interval), not the time it happened to run.

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

/// Why an evaluation ends in the state Error. It is stored, shown and sent as its stable code and
/// parameters (`{"code": "alerting.not_a_number", "params": {"field": "$.depth", "found": "text"}}`),
/// which the UI and the notification texts translate; `Display` is an English text for the
/// server log only. A failed query keeps the source's own error out of it: the scheduler logs
/// that on the server (as the API does since 0.5.4), and users see "query failed".
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(into = "StoredError", try_from = "StoredError")]
pub enum EvalError {
    QueryFailed,
    Timeout,
    /// The source is not enabled for alerting (any more).
    SourceNotEnabled,
    /// The stored reduce step cannot be evaluated (a path that does not parse); saving refuses
    /// such rules, so this only follows a stored rule that was changed outside the API.
    InvalidRule,
    /// The query answered in another shape than the reduce step expects.
    WrongShape {
        expected: String,
        got: String,
    },
    /// A value where a number is expected is text, a bool, an object, ... (never converted).
    /// `found` is `text`, `bool`, `array`, `object` or the database type (`date`, `objectId`).
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
    /// The source cut the result at one of its limits, so the reduced value would be wrong. Only
    /// a count whose condition is already decided at the cut count passes (see [`outcome`]).
    Truncated {
        limit: Option<u32>,
        reason: Option<String>,
    },
    /// Counting paths, but the query returned no paths at all (only nodes and edges).
    NoPaths,
}

impl EvalError {
    pub fn code(&self) -> &'static str {
        match self {
            EvalError::QueryFailed => "alerting.query_failed",
            EvalError::Timeout => "alerting.timeout",
            EvalError::SourceNotEnabled => "alerting.source_not_enabled",
            EvalError::InvalidRule => "alerting.invalid_rule",
            EvalError::WrongShape { .. } => "alerting.wrong_shape",
            EvalError::NotANumber { .. } => "alerting.not_a_number",
            EvalError::NaN { .. } => "alerting.nan",
            EvalError::TooManySeries { .. } => "alerting.too_many_series",
            EvalError::DuplicateSeries { .. } => "alerting.duplicate_series",
            EvalError::Truncated { .. } => "alerting.truncated",
            EvalError::NoPaths => "alerting.no_paths",
        }
    }

    /// The values the code's text needs.
    pub fn params(&self) -> BTreeMap<String, String> {
        let pairs: Vec<(&str, String)> = match self {
            EvalError::WrongShape { expected, got } => vec![("expected", expected.clone()), ("got", got.clone())],
            EvalError::NotANumber { field, found } => vec![("field", field.clone()), ("found", found.clone())],
            EvalError::NaN { field } => vec![("field", field.clone())],
            EvalError::TooManySeries { limit } => vec![("limit", limit.to_string())],
            EvalError::DuplicateSeries { labels } => vec![("labels", labels.clone())],
            EvalError::Truncated { limit, reason } => {
                let mut pairs = Vec::new();
                if let Some(limit) = limit {
                    pairs.push(("limit", limit.to_string()));
                }
                if let Some(reason) = reason {
                    pairs.push(("reason", reason.clone()));
                }
                pairs
            }
            _ => Vec::new(),
        };
        pairs.into_iter().map(|(k, v)| (k.to_string(), v)).collect()
    }
}

/// The stored and sent form of an [`EvalError`].
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct StoredError {
    code: String,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    params: BTreeMap<String, String>,
}

impl From<EvalError> for StoredError {
    fn from(error: EvalError) -> Self {
        StoredError { code: error.code().to_string(), params: error.params() }
    }
}

impl TryFrom<StoredError> for EvalError {
    type Error = String;

    fn try_from(stored: StoredError) -> Result<Self, String> {
        let mut params = stored.params;
        let mut take = |key: &str| params.remove(key).ok_or_else(|| format!("{} needs {key}", stored.code));
        Ok(match stored.code.as_str() {
            "alerting.query_failed" => EvalError::QueryFailed,
            "alerting.timeout" => EvalError::Timeout,
            "alerting.source_not_enabled" => EvalError::SourceNotEnabled,
            "alerting.invalid_rule" => EvalError::InvalidRule,
            "alerting.wrong_shape" => EvalError::WrongShape { expected: take("expected")?, got: take("got")? },
            "alerting.not_a_number" => EvalError::NotANumber { field: take("field")?, found: take("found")? },
            "alerting.nan" => EvalError::NaN { field: take("field")? },
            "alerting.too_many_series" => {
                EvalError::TooManySeries { limit: take("limit")?.parse().map_err(|_| "limit is a number".to_string())? }
            }
            "alerting.duplicate_series" => EvalError::DuplicateSeries { labels: take("labels")? },
            "alerting.truncated" => EvalError::Truncated {
                limit: take("limit").ok().and_then(|l| l.parse().ok()),
                reason: take("reason").ok(),
            },
            "alerting.no_paths" => EvalError::NoPaths,
            other => return Err(format!("unknown error code {other}")),
        })
    }
}

impl fmt::Display for EvalError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            EvalError::QueryFailed => f.write_str("The query failed"),
            EvalError::Timeout => f.write_str("The evaluation took too long"),
            EvalError::SourceNotEnabled => f.write_str("Data source is not enabled for alerting"),
            EvalError::InvalidRule => f.write_str("The rule's reduce step cannot be evaluated"),
            EvalError::WrongShape { expected, got } => {
                write!(f, "The query returned {got}, the rule expects {expected}")
            }
            EvalError::NotANumber { field, found } => write!(f, "{field} holds {found}, not a number"),
            EvalError::NaN { field } => write!(f, "{field} reduces to NaN"),
            EvalError::TooManySeries { limit } => write!(f, "Too many series (more than {limit})"),
            EvalError::DuplicateSeries { labels } => write!(f, "Two series with the same labels: {labels}"),
            EvalError::Truncated { limit, reason } => {
                f.write_str("The result was cut at a limit of the source")?;
                if let Some(limit) = limit {
                    write!(f, " ({limit})")?;
                }
                if let Some(reason) = reason {
                    write!(f, ": {reason}")?;
                }
                Ok(())
            }
            EvalError::NoPaths => f.write_str("The query returned no paths to count"),
        }
    }
}

impl std::error::Error for EvalError {}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn errors_are_stored_as_code_and_params() {
        let cases = [
            (EvalError::QueryFailed, json!({ "code": "alerting.query_failed" })),
            (EvalError::Timeout, json!({ "code": "alerting.timeout" })),
            (EvalError::SourceNotEnabled, json!({ "code": "alerting.source_not_enabled" })),
            (EvalError::InvalidRule, json!({ "code": "alerting.invalid_rule" })),
            (
                EvalError::WrongShape { expected: "frame".into(), got: "graph".into() },
                json!({ "code": "alerting.wrong_shape", "params": { "expected": "frame", "got": "graph" } }),
            ),
            (
                EvalError::NotANumber { field: "$.depth".into(), found: "text".into() },
                json!({ "code": "alerting.not_a_number", "params": { "field": "$.depth", "found": "text" } }),
            ),
            (EvalError::NaN { field: "v".into() }, json!({ "code": "alerting.nan", "params": { "field": "v" } })),
            (
                EvalError::TooManySeries { limit: 100 },
                json!({ "code": "alerting.too_many_series", "params": { "limit": "100" } }),
            ),
            (
                EvalError::DuplicateSeries { labels: "{a=\"1\"}".into() },
                json!({ "code": "alerting.duplicate_series", "params": { "labels": "{a=\"1\"}" } }),
            ),
            (
                EvalError::Truncated { limit: Some(1000), reason: Some("graph.node_limit".into()) },
                json!({ "code": "alerting.truncated", "params": { "limit": "1000", "reason": "graph.node_limit" } }),
            ),
            (EvalError::Truncated { limit: None, reason: None }, json!({ "code": "alerting.truncated" })),
            (EvalError::NoPaths, json!({ "code": "alerting.no_paths" })),
        ];
        for (error, stored) in cases {
            assert_eq!(serde_json::to_value(&error).unwrap(), stored);
            assert_eq!(serde_json::from_value::<EvalError>(stored.clone()).unwrap(), error, "{stored}");
            assert_eq!(stored["code"], error.code());
        }
        assert!(serde_json::from_value::<EvalError>(json!({ "code": "alerting.nope" })).is_err());
        assert!(serde_json::from_value::<EvalError>(json!({ "code": "alerting.nan" })).is_err());
        assert_eq!(
            EvalError::NotANumber { field: "$.depth".into(), found: "text".into() }.to_string(),
            "$.depth holds text, not a number"
        );
    }
}
