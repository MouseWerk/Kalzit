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

fn compile(pattern: &str) -> Result<regex::Regex, regex::Error> {
    regex::RegexBuilder::new(&format!("^(?:{pattern})$")).size_limit(REGEX_SIZE_LIMIT).build()
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
}
