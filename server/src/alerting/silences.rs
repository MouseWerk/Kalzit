//! Label matchers of silences and notification policies: conditions that must all match an
//! instance's labels (docs/api/alerting.md, "Silences" and "Notification policies"). Regular
//! expressions use the `regex` crate, which runs in linear time, and match the whole value.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::rule::{invalid, is_label_name};
use crate::error::ApiResult;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum MatchOp {
    #[serde(rename = "=")]
    Eq,
    #[serde(rename = "!=")]
    Ne,
    #[serde(rename = "=~")]
    Regex,
    #[serde(rename = "!~")]
    NotRegex,
}

impl MatchOp {
    fn is_regex(self) -> bool {
        matches!(self, MatchOp::Regex | MatchOp::NotRegex)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Matcher {
    pub label: String,
    pub op: MatchOp,
    pub value: String,
}

pub const MAX_MATCHERS: usize = 20;
const MAX_VALUE_CHARS: usize = 256;
/// Compiled size limit of one expression, far above what a label pattern needs.
const REGEX_SIZE_LIMIT: usize = 64 * 1024;
/// Compiled size limit of a notification policy's expression when it is saved new or changed.
/// Every evaluation of a routed rule and the policy pages build the tree with all of them, so they
/// stay small. Expressions stored before keep [`REGEX_SIZE_LIMIT`]: they were accepted under it
/// and go on working; only a changed one must fit.
pub const POLICY_REGEX_SIZE_LIMIT: usize = 8 * 1024;

fn compile(pattern: &str) -> Result<regex::Regex, regex::Error> {
    compile_within(pattern, REGEX_SIZE_LIMIT)
}

fn compile_within(pattern: &str, size_limit: usize) -> Result<regex::Regex, regex::Error> {
    regex::RegexBuilder::new(&format!("^(?:{pattern})$")).size_limit(size_limit).build()
}

/// Checks the matchers a silence is saved with.
pub fn check(matchers: &[Matcher]) -> ApiResult<()> {
    if matchers.is_empty() || matchers.len() > MAX_MATCHERS {
        return Err(invalid(
            "matchers",
            format!("a silence has 1 to {MAX_MATCHERS} label conditions"),
            "alerts.matchers_invalid",
        ));
    }
    check_each(matchers, "matchers", "alerts.matchers_invalid")
}

/// Checks each matcher: a label name, a value of at most 256 characters, a regular expression
/// that compiles. `reason` names a bad name or value.
pub fn check_each(matchers: &[Matcher], field: &'static str, reason: &'static str) -> ApiResult<()> {
    for m in matchers {
        if !is_label_name(&m.label) {
            return Err(invalid(field, format!("{} is not a label name", m.label), reason));
        }
        if m.value.chars().count() > MAX_VALUE_CHARS || m.value.chars().any(char::is_control) {
            return Err(invalid(
                field,
                format!("a condition's value has at most {MAX_VALUE_CHARS} characters"),
                reason,
            ));
        }
        if m.op.is_regex()
            && let Err(e) = compile(&m.value)
        {
            return Err(invalid(
                field,
                format!("{} is not a regular expression: {e}", m.value),
                "alerts.matcher_regex_invalid",
            ));
        }
    }
    Ok(())
}

/// Checks a policy's matchers as [`check_each`] does; an expression that is not among `kept`
/// (the policy's stored matchers) must also compile within [`POLICY_REGEX_SIZE_LIMIT`].
pub fn check_policy(
    matchers: &[Matcher],
    kept: &[Matcher],
    field: &'static str,
    reason: &'static str,
) -> ApiResult<()> {
    check_each(matchers, field, reason)?;
    for m in matchers.iter().filter(|m| m.op.is_regex() && !kept.contains(m)) {
        if compile_within(&m.value, POLICY_REGEX_SIZE_LIMIT).is_err() {
            return Err(invalid(
                field,
                format!(
                    "{} is too large as a regular expression for a policy (at most {POLICY_REGEX_SIZE_LIMIT} bytes compiled)",
                    m.value
                ),
                "alerts.matcher_regex_invalid",
            ));
        }
    }
    Ok(())
}

/// Matchers ready to match (a silence's or a policy's): each regular expression compiled once.
#[derive(Clone, Debug)]
pub struct Compiled {
    matchers: Vec<(Matcher, Option<regex::Regex>)>,
}

impl Compiled {
    /// An `=~` or `!~` value that does not compile (never stored: `check` refuses it) matches
    /// nothing.
    pub fn new(matchers: &[Matcher]) -> Self {
        let matchers =
            matchers.iter().map(|m| (m.clone(), m.op.is_regex().then(|| compile(&m.value).ok()).flatten())).collect();
        Self { matchers }
    }

    /// Whether every matcher matches `labels`. A label the instance lacks counts as empty, so
    /// `team!=lager` matches an instance without `team`.
    pub fn matches(&self, labels: &BTreeMap<String, String>) -> bool {
        self.matchers.iter().all(|(m, re)| {
            let value = labels.get(&m.label).map_or("", String::as_str);
            match m.op {
                MatchOp::Eq => value == m.value,
                MatchOp::Ne => value != m.value,
                MatchOp::Regex => re.as_ref().is_some_and(|re| re.is_match(value)),
                MatchOp::NotRegex => re.as_ref().is_some_and(|re| !re.is_match(value)),
            }
        })
    }
}

/// `Compiled::new(matchers).matches(labels)`, for one check.
pub fn matches(matchers: &[Matcher], labels: &BTreeMap<String, String>) -> bool {
    Compiled::new(matchers).matches(labels)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn m(label: &str, op: MatchOp, value: &str) -> Matcher {
        Matcher { label: label.into(), op, value: value.into() }
    }

    #[test]
    fn all_conditions_must_match() {
        let labels: BTreeMap<String, String> =
            [("team".to_string(), "lager".to_string()), ("instance".to_string(), "lager-api-2".to_string())].into();
        assert!(matches(&[m("team", MatchOp::Eq, "lager"), m("instance", MatchOp::Regex, "lager-api-[23]")], &labels));
        assert!(!matches(&[m("team", MatchOp::Eq, "lager"), m("instance", MatchOp::Regex, "lager-api")], &labels));
        assert!(matches(&[m("region", MatchOp::Ne, "eu")], &labels));
        assert!(!matches(&[m("team", MatchOp::Ne, "lager")], &labels));
        assert!(matches(&[m("instance", MatchOp::NotRegex, "lager-api-test.*")], &labels));
        assert!(!matches(&[m("instance", MatchOp::NotRegex, "lager-api-.*")], &labels));
        // A missing label is empty: `!~` with a pattern that needs a character matches it.
        assert!(matches(&[m("region", MatchOp::NotRegex, "eu.+")], &labels));
    }

    #[test]
    fn matchers_are_checked() {
        assert!(check(&[m("team", MatchOp::Eq, "lager")]).is_ok());
        assert!(check(&[]).is_err());
        assert!(check(&[m("te am", MatchOp::Eq, "x")]).is_err());
        assert!(check(&[m("team", MatchOp::Regex, "(")]).is_err());
        assert!(check(&[m("team", MatchOp::NotRegex, "(")]).is_err());
        assert!(check(&[m("team", MatchOp::Regex, "a{1000}{1000}")]).is_err(), "too large to compile");
        let json = serde_json::json!([{ "label": "team", "op": "!~", "value": "a.*" }]);
        let parsed: Vec<Matcher> = serde_json::from_value(json).unwrap();
        assert_eq!(parsed[0].op, MatchOp::NotRegex);
    }

    #[test]
    fn new_policy_expressions_stay_small_and_stored_ones_keep_working() {
        // What label patterns look like fits the lower limit.
        for pattern in [
            "lager-api-test.*",
            "kritisch|hoch",
            "(eu|us)-(west|east)-[0-9]+",
            "Lager-API.*",
            "[a-z0-9-]{1,63}",
            "prod-.*-db-[0-9]{2}",
        ] {
            assert!(check_policy(&[m("x", MatchOp::Regex, pattern)], &[], "matchers", "r").is_ok(), "{pattern}");
        }
        // A larger one passes for a silence, and for a policy that has it stored already.
        let large = m("instance", MatchOp::Regex, r"\w{20}");
        assert!(check(std::slice::from_ref(&large)).is_ok());
        let e = check_policy(std::slice::from_ref(&large), &[], "matchers", "r").unwrap_err();
        assert_eq!(e.reason.map(|r| r.code).as_deref(), Some("alerts.matcher_regex_invalid"));
        assert!(check_policy(std::slice::from_ref(&large), std::slice::from_ref(&large), "matchers", "r").is_ok());
        // Changed (another label) it is new again.
        let moved = m("host", MatchOp::Regex, r"\w{20}");
        assert!(check_policy(&[moved], std::slice::from_ref(&large), "matchers", "r").is_err());
        // Stored policies are compiled under the higher limit, so they keep matching.
        let labels: BTreeMap<String, String> = [("instance".to_string(), "a".repeat(20))].into();
        assert!(Compiled::new(&[large]).matches(&labels));
    }
}
