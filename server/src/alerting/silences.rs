//! Silence matchers: label conditions that must all match an instance's labels for the silence
//! to hold back its notifications (docs/api/alerting.md, "Silences"). Regular expressions use the
//! `regex` crate, which runs in linear time, and match the whole value.

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
    for m in matchers {
        if !is_label_name(&m.label) {
            return Err(invalid("matchers", format!("{} is not a label name", m.label), "alerts.matchers_invalid"));
        }
        if m.value.chars().count() > MAX_VALUE_CHARS || m.value.chars().any(char::is_control) {
            return Err(invalid(
                "matchers",
                format!("a condition's value has at most {MAX_VALUE_CHARS} characters"),
                "alerts.matchers_invalid",
            ));
        }
        if m.op == MatchOp::Regex
            && let Err(e) = compile(&m.value)
        {
            return Err(invalid(
                "matchers",
                format!("{} is not a regular expression: {e}", m.value),
                "alerts.matcher_regex_invalid",
            ));
        }
    }
    Ok(())
}

/// A silence's matchers ready to match: each regular expression compiled once.
pub struct Compiled {
    matchers: Vec<(Matcher, Option<regex::Regex>)>,
}

impl Compiled {
    /// An `=~` value that does not compile (never stored: `check` refuses it) matches nothing.
    pub fn new(matchers: &[Matcher]) -> Self {
        let matchers = matchers
            .iter()
            .map(|m| (m.clone(), (m.op == MatchOp::Regex).then(|| compile(&m.value).ok()).flatten()))
            .collect();
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
    }

    #[test]
    fn matchers_are_checked() {
        assert!(check(&[m("team", MatchOp::Eq, "lager")]).is_ok());
        assert!(check(&[]).is_err());
        assert!(check(&[m("te am", MatchOp::Eq, "x")]).is_err());
        assert!(check(&[m("team", MatchOp::Regex, "(")]).is_err());
        assert!(check(&[m("team", MatchOp::Regex, "a{1000}{1000}")]).is_err(), "too large to compile");
        let json = serde_json::json!([{ "label": "team", "op": "=~", "value": "a.*" }]);
        let parsed: Vec<Matcher> = serde_json::from_value(json).unwrap();
        assert_eq!(parsed[0].op, MatchOp::Regex);
    }
}
