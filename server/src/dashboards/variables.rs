//! A query variable's options after its query ran: the regex filter, the order and the fixed
//! options (docs/api/datasources.md, "Variable options"). The same steps serve the options route
//! of a saved dashboard and the preview of a variable being edited.

use std::cmp::Ordering;

use regex::{Regex, RegexBuilder};

use serde_json::Value;

use super::model::{Variable, VariableSort, VariableType};
use crate::shapes::{VariableOption, VariableOptionsResponse};

/// What a selection of "All" is stored as (`current`) and kept as in the browser; queries never
/// see it: the browser sends the list of every value, or the variable's `allValue`.
pub const ALL: &str = "$__all";

/// The value a variable was saved with (`current`, or its `value`), as stored queries run with it
/// when nobody picked one: share links without values, reports, AI tools. A saved "All" becomes
/// what the browser would send: the custom value for "All", else a custom variable's options.
/// A query variable's "All" without a custom value would need its options query first; it is
/// left out, as is a variable without a saved value.
pub fn saved_value(v: &Variable) -> Option<Value> {
    let value = match v.current.as_ref()? {
        Value::Object(m) => m.get("value")?.clone(),
        other => other.clone(),
    };
    let is_all = match &value {
        Value::String(s) => s == ALL,
        Value::Array(items) => items.iter().any(|i| i.as_str() == Some(ALL)),
        _ => false,
    };
    if !is_all {
        return (!value.is_null()).then_some(value);
    }
    if !v.include_all {
        return None;
    }
    if let Some(all) = &v.all_value {
        return Some(Value::String(all.clone()));
    }
    match (v.kind, v.options.as_ref()) {
        (VariableType::Custom, Some(Value::Array(options))) => Some(Value::Array(
            options
                .iter()
                .filter_map(|o| match o {
                    Value::Object(m) => m.get("value").cloned(),
                    other => Some(other.clone()),
                })
                .filter(|o| matches!(o, Value::String(_) | Value::Number(_) | Value::Bool(_)))
                .collect(),
        )),
        _ => None,
    }
}

/// The compiled program of a variable regex may take this much memory. The engine runs in time
/// linear in the text, so no pattern can make a request hang; this bounds what one may cost.
const MAX_REGEX_BYTES: usize = 1 << 20;

/// A variable's regex: `/pattern/flags` (flags `i`, `m`, `s`) or the bare pattern.
#[derive(Debug)]
pub struct OptionRegex {
    regex: Regex,
    text: Option<usize>,
    value: Option<usize>,
    /// The first unnamed group, used when there is no named one.
    first: Option<usize>,
}

impl OptionRegex {
    pub fn parse(raw: &str) -> Result<Self, String> {
        let (pattern, flags) = match raw.strip_prefix('/').and_then(|rest| rest.rsplit_once('/')) {
            Some((pattern, flags)) => (pattern, flags),
            None => (raw, ""),
        };
        let mut builder = RegexBuilder::new(pattern);
        builder.size_limit(MAX_REGEX_BYTES).dfa_size_limit(MAX_REGEX_BYTES);
        for flag in flags.chars() {
            match flag {
                'i' => builder.case_insensitive(true),
                'm' => builder.multi_line(true),
                's' => builder.dot_matches_new_line(true),
                // `g` changes nothing for one match per value; other tools write it out of habit.
                'g' => &mut builder,
                other => return Err(format!("the flag {other} is unknown; use i, m or s")),
            };
        }
        let regex = builder.build().map_err(|e| match e {
            regex::Error::CompiledTooBig(_) => "the pattern is too large".to_string(),
            other => format!("not a valid regular expression: {}", first_line(&other.to_string())),
        })?;
        let named = |name: &str| regex.capture_names().position(|n| n == Some(name));
        let first = regex.capture_names().enumerate().skip(1).find(|(_, n)| n.is_none()).map(|(i, _)| i);
        Ok(Self { text: named("text"), value: named("value"), first, regex })
    }

    /// The option this value gives, or `None` when the value does not match.
    fn apply(&self, option: &VariableOption) -> Option<VariableOption> {
        let caps = self.regex.captures(&option.value)?;
        let group = |i: Option<usize>| i.and_then(|i| caps.get(i)).map(|m| m.as_str().to_string());
        if self.text.is_some() || self.value.is_some() {
            let value = group(self.value).unwrap_or_else(|| option.value.clone());
            let label = group(self.text).unwrap_or_else(|| {
                if self.value.is_some() && option.label == option.value { value.clone() } else { option.label.clone() }
            });
            return Some(VariableOption { value, label });
        }
        match group(self.first) {
            Some(both) => Some(VariableOption { value: both.clone(), label: both }),
            None => Some(option.clone()),
        }
    }
}

fn first_line(text: &str) -> String {
    text.lines().map(str::trim).filter(|l| !l.is_empty()).last().unwrap_or(text).to_string()
}

/// Applies the variable's regex, order and fixed options to the options its query gave. Options
/// stay distinct by value: an extracted value seen before, or a fixed one the query also gave,
/// is listed once. `unmatched` counts the values the regex left out.
pub fn refine(mut answer: VariableOptionsResponse, variable: &Variable) -> Result<VariableOptionsResponse, String> {
    if let Some(raw) = &variable.regex {
        let regex = OptionRegex::parse(raw)?;
        let mut seen = std::collections::BTreeSet::new();
        let mut unmatched = 0u32;
        let mut kept = Vec::with_capacity(answer.options.len());
        for option in &answer.options {
            match regex.apply(option) {
                Some(o) if seen.insert(o.value.clone()) => kept.push(o),
                Some(_) => {}
                None => unmatched += 1,
            }
        }
        answer.options = kept;
        answer.unmatched = (unmatched > 0).then_some(unmatched);
    }
    if let Some(sort) = variable.sort {
        sort_options(&mut answer.options, sort);
    }
    for o in &variable.static_options {
        if !answer.options.iter().any(|x| x.value == o.value) {
            let label = o.label.clone().filter(|l| !l.is_empty()).unwrap_or_else(|| o.value.clone());
            answer.options.push(VariableOption { value: o.value.clone(), label });
        }
    }
    Ok(answer)
}

/// Sorts stably, so equal names keep the query's order.
pub fn sort_options(options: &mut [VariableOption], sort: VariableSort) {
    let number = |o: &VariableOption| o.value.trim().parse::<f64>().ok().filter(|n| n.is_finite());
    let by_number = |a: &VariableOption, b: &VariableOption| match (number(a), number(b)) {
        (Some(x), Some(y)) => x.partial_cmp(&y).unwrap_or(Ordering::Equal),
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        (None, None) => Ordering::Equal,
    };
    match sort {
        VariableSort::Alphabetical => options.sort_by(|a, b| a.label.cmp(&b.label)),
        VariableSort::AlphabeticalDesc => options.sort_by(|a, b| b.label.cmp(&a.label)),
        VariableSort::CaseInsensitive => options.sort_by_cached_key(|o| o.label.to_lowercase()),
        VariableSort::CaseInsensitiveDesc => {
            options.sort_by(|a, b| b.label.to_lowercase().cmp(&a.label.to_lowercase()));
        }
        VariableSort::Numerical => options.sort_by(by_number),
        // Values that are no numbers stay last either way.
        VariableSort::NumericalDesc => options.sort_by(|a, b| match (number(a), number(b)) {
            (Some(_), Some(_)) => by_number(b, a),
            _ => by_number(a, b),
        }),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn options(values: &[&str]) -> VariableOptionsResponse {
        VariableOptionsResponse {
            options: values.iter().map(|v| VariableOption { value: v.to_string(), label: v.to_string() }).collect(),
            truncated: false,
            unmatched: None,
        }
    }

    fn variable(extra: serde_json::Value) -> Variable {
        let mut v = json!({ "name": "job", "type": "query", "datasourceId": "ds", "query": "x" });
        v.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        serde_json::from_value(v).unwrap()
    }

    fn pairs(answer: &VariableOptionsResponse) -> Vec<(String, String)> {
        answer.options.iter().map(|o| (o.label.clone(), o.value.clone())).collect()
    }

    #[test]
    fn named_groups_take_name_and_value_apart() {
        let v = variable(json!({ "regex": "/(?<text>.+)-prod/" }));
        let answer = refine(options(&["api-prod", "web-prod", "api-staging"]), &v).unwrap();
        assert_eq!(
            pairs(&answer),
            [("api".into(), "api-prod".into()), ("web".into(), "web-prod".into())] as [(String, String); 2]
        );
        assert_eq!(answer.unmatched, Some(1));

        let v = variable(json!({ "regex": "(?<value>[a-z]+)-(?<text>\\w+)" }));
        let answer = refine(options(&["api-Produktion"]), &v).unwrap();
        assert_eq!(pairs(&answer), [("Produktion".to_string(), "api".to_string())]);

        // One unnamed group is both; extracted values stay distinct.
        let v = variable(json!({ "regex": "/^(\\w+)-/i" }));
        let answer = refine(options(&["API-1", "API-2", "web-1"]), &v).unwrap();
        assert_eq!(answer.options.iter().map(|o| o.value.as_str()).collect::<Vec<_>>(), ["API", "web"]);
        assert_eq!(answer.unmatched, None);
    }

    #[test]
    fn bad_patterns_are_refused_with_a_reason() {
        assert!(OptionRegex::parse("/(?<text>.+-prod/").unwrap_err().contains("not a valid"));
        assert!(OptionRegex::parse("/a/x").unwrap_err().contains("flag x"));
        // Lookaround and backreferences do not exist in a linear-time engine.
        assert!(OptionRegex::parse("(a)\\1").is_err());
        assert!(OptionRegex::parse("a(?=b)").is_err());
        assert!(OptionRegex::parse(&format!("(\\w{{100}}){{{}}}", 1000)).unwrap_err().contains("too large"));
    }

    #[test]
    fn a_saved_all_becomes_what_the_browser_sends() {
        let custom = |extra: serde_json::Value| -> Variable {
            let mut v = json!({ "name": "r", "type": "custom", "options": ["nord", { "value": "sued", "label": "Süd" }] });
            v.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
            serde_json::from_value(v).unwrap()
        };
        assert_eq!(saved_value(&custom(json!({ "includeAll": true, "current": ALL }))), Some(json!(["nord", "sued"])));
        assert_eq!(
            saved_value(&custom(json!({ "includeAll": true, "allValue": "%", "current": { "value": [ALL] } }))),
            Some(json!("%"))
        );
        assert_eq!(saved_value(&custom(json!({ "current": ALL }))), None);
        assert_eq!(saved_value(&custom(json!({ "current": { "value": "nord" } }))), Some(json!("nord")));
        assert_eq!(saved_value(&variable(json!({ "includeAll": true, "current": ALL }))), None);
        assert_eq!(saved_value(&variable(json!({ "includeAll": true, "allValue": ".*", "current": ALL }))), Some(json!(".*")));
    }

    #[test]
    fn sorting_and_fixed_options() {
        let sorted = |sort: &str, values: &[&str]| {
            let v = variable(json!({ "sort": sort }));
            refine(options(values), &v).unwrap().options.into_iter().map(|o| o.value).collect::<Vec<_>>()
        };
        assert_eq!(sorted("alphabetical", &["b", "B", "a"]), ["B", "a", "b"]);
        assert_eq!(sorted("alphabeticalDesc", &["b", "c", "a"]), ["c", "b", "a"]);
        assert_eq!(sorted("caseInsensitive", &["b", "B", "a"]), ["a", "b", "B"]);
        assert_eq!(sorted("caseInsensitiveDesc", &["b", "C", "a"]), ["C", "b", "a"]);
        assert_eq!(sorted("numerical", &["10", "x", "9", "1.5"]), ["1.5", "9", "10", "x"]);
        assert_eq!(sorted("numericalDesc", &["10", "x", "9"]), ["10", "9", "x"]);

        let v = variable(json!({
            "sort": "alphabetical",
            "staticOptions": [{ "value": "_int", "label": "intern" }, { "value": "a" }, { "value": "unbekannt" }]
        }));
        let answer = refine(options(&["b", "a"]), &v).unwrap();
        assert_eq!(
            pairs(&answer),
            [("a", "a"), ("b", "b"), ("intern", "_int"), ("unbekannt", "unbekannt")]
                .map(|(l, v)| (l.to_string(), v.to_string()))
        );
    }
}
