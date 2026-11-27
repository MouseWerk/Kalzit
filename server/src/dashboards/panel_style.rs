//! Checks of the style rules of graph panels and of tables made from a graph (`options.style`,
//! `ui/src/panels/graph/style/schema.ts`): a closed shape with the UI's bounds, so a saved
//! dashboard cannot carry unknown targets, free colors or oversized rule lists. Rules are
//! evaluated in the browser; the server only stores them.

use serde::Deserialize;

/// Rules per panel, nodes and edges together.
pub const MAX_STYLE_RULES: usize = 50;
/// Values a rule "per unique value" gives a color of their own.
pub const MAX_VALUE_COLORS: usize = 12;
/// Longest property key, label, edge type, template or condition value of a rule.
pub const MAX_RULE_TEXT_CHARS: usize = 100;
pub const MIN_RULE_SIZE: u32 = 2;
pub const MAX_RULE_SIZE: u32 = 40;
pub const MIN_RULE_WIDTH: u32 = 1;
pub const MAX_RULE_WIDTH: u32 = 8;
pub const MAX_RULE_ID_CHARS: usize = 24;
pub const MAX_ICON_NAME_CHARS: usize = 40;
/// The schema version this server knows.
pub const STYLE_VERSION: u32 = 1;

macro_rules! choice {
    ($name:ident { $($variant:ident = $text:literal),+ $(,)? }) => {
        #[derive(Debug, Deserialize, Clone, Copy, PartialEq, Eq)]
        enum $name {
            $(#[serde(rename = $text)] #[allow(dead_code)] $variant),+
        }
    };
}

// The data palette, two neutral tones and the status tones; never a free color or the accent.
choice!(StyleColor {
    Chart1 = "chart-1",
    Chart2 = "chart-2",
    Chart3 = "chart-3",
    Chart4 = "chart-4",
    Chart5 = "chart-5",
    Chart6 = "chart-6",
    Chart7 = "chart-7",
    Chart8 = "chart-8",
    Neutral = "neutral",
    NeutralStrong = "neutral-strong",
    Good = "good",
    Warning = "warning",
    Critical = "critical",
});
choice!(RuleShape {
    Circle = "circle",
    Square = "square",
    Diamond = "diamond",
    Triangle = "triangle",
    Hexagon = "hexagon",
});
choice!(RuleBorder { None = "none", Solid = "solid", Dashed = "dashed" });
choice!(EdgeDash { Solid = "solid", Dashed = "dashed", Dotted = "dotted" });
choice!(EdgeArrow { Direction = "direction", None = "none" });
choice!(ValueType { Number = "number", Text = "text", Date = "date", Boolean = "boolean" });
choice!(ConditionOp {
    Eq = "eq",
    Ne = "ne",
    Lt = "lt",
    Lte = "lte",
    Gt = "gt",
    Gte = "gte",
    Between = "between",
    Contains = "contains",
    NotContains = "notContains",
    StartsWith = "startsWith",
    On = "on",
    Before = "before",
    After = "after",
    LastDays = "lastDays",
    True = "true",
    False = "false",
    Exists = "exists",
    Missing = "missing",
});

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ValueColor {
    value: String,
    #[allow(dead_code)]
    color: StyleColor,
}

/// When a rule applies: always, on a condition, or per unique value of a property.
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
enum When {
    Always,
    #[serde(rename_all = "camelCase")]
    Condition {
        property: String,
        #[serde(rename = "type")]
        value_type: ValueType,
        op: ConditionOp,
        value: String,
        to: String,
        #[allow(dead_code)]
        case_sensitive: bool,
    },
    Values {
        property: String,
        colors: Vec<ValueColor>,
    },
}

/// A size from a node's number property, from `min` to `max` px (board Graph082, decision 1).
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SizeBy {
    property: String,
    min: u32,
    max: u32,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
#[allow(dead_code)]
struct NodeTargets {
    color: Option<StyleColor>,
    size: Option<u32>,
    #[serde(rename = "sizeBy")]
    size_by: Option<SizeBy>,
    shape: Option<RuleShape>,
    icon: Option<String>,
    border: Option<RuleBorder>,
    label: Option<String>,
    badge: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
#[allow(dead_code)]
struct EdgeTargets {
    color: Option<StyleColor>,
    width: Option<u32>,
    dash: Option<EdgeDash>,
    label: Option<String>,
    arrow: Option<EdgeArrow>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Rule<T> {
    id: String,
    #[allow(dead_code)]
    on: bool,
    scope: String,
    when: When,
    set: T,
}

/// The style of a panel: a versioned list of rules for nodes and one for edges.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GraphStyle {
    version: u32,
    nodes: Vec<Rule<NodeTargets>>,
    edges: Vec<Rule<EdgeTargets>>,
}

fn check_text(what: &str, value: &str) -> Result<(), String> {
    if value.chars().count() > MAX_RULE_TEXT_CHARS {
        return Err(format!("{what} takes at most {MAX_RULE_TEXT_CHARS} characters"));
    }
    if value.chars().any(char::is_control) {
        return Err(format!("{what} contains control characters"));
    }
    Ok(())
}

/// The comparisons each data type takes, as the rule editor offers them.
fn op_fits(value_type: ValueType, op: ConditionOp) -> bool {
    use ConditionOp::{
        After, Before, Between, Contains, Eq, Exists, False, Gt, Gte, LastDays, Lt, Lte, Missing, Ne, NotContains, On,
        StartsWith, True,
    };
    match value_type {
        ValueType::Number => matches!(op, Eq | Ne | Lt | Lte | Gt | Gte | Between | Exists | Missing),
        ValueType::Text => matches!(op, Eq | Ne | Contains | NotContains | StartsWith | Exists | Missing),
        ValueType::Date => matches!(op, On | Before | After | Between | LastDays | Exists | Missing),
        ValueType::Boolean => matches!(op, True | False | Exists | Missing),
    }
}

fn check_when(at: &str, when: &When) -> Result<(), String> {
    match when {
        When::Always => Ok(()),
        When::Condition { property, value_type, op, value, to, .. } => {
            if property.is_empty() {
                return Err(format!("{at}.when.property must not be empty"));
            }
            check_text(&format!("{at}.when.property"), property)?;
            check_text(&format!("{at}.when.value"), value)?;
            check_text(&format!("{at}.when.to"), to)?;
            if op_fits(*value_type, *op) { Ok(()) } else { Err(format!("{at}.when.op does not fit {at}.when.type")) }
        }
        When::Values { property, colors } => {
            if property.is_empty() {
                return Err(format!("{at}.when.property must not be empty"));
            }
            check_text(&format!("{at}.when.property"), property)?;
            if colors.len() > MAX_VALUE_COLORS {
                return Err(format!("{at}.when.colors takes at most {MAX_VALUE_COLORS} values"));
            }
            for color in colors {
                check_text(&format!("{at}.when.colors"), &color.value)?;
            }
            Ok(())
        }
    }
}

fn check_range(what: &str, value: Option<u32>, min: u32, max: u32) -> Result<(), String> {
    match value {
        Some(v) if !(min..=max).contains(&v) => Err(format!("{what} must be {min} to {max}")),
        _ => Ok(()),
    }
}

/// The names of the icon set the UI ships (`ui/src/panels/graph/style/icons/names.txt`, which
/// `ui/scripts/graph-icons.mjs` turns into the drawn set): a rule may name only these.
static ICON_NAMES: std::sync::LazyLock<std::collections::HashSet<&'static str>> = std::sync::LazyLock::new(|| {
    include_str!("../../../ui/src/panels/graph/style/icons/names.txt").split_whitespace().collect()
});

/// Whether the bundled icon set has an icon of this name.
fn is_icon_name(name: &str) -> bool {
    name.len() <= MAX_ICON_NAME_CHARS && ICON_NAMES.contains(name)
}

fn check_rule<T>(at: &str, rule: &Rule<T>, ids: &mut Vec<String>) -> Result<(), String> {
    let id_ok = !rule.id.is_empty()
        && rule.id.len() <= MAX_RULE_ID_CHARS
        && rule.id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    if !id_ok {
        return Err(format!("{at}.id must be 1 to {MAX_RULE_ID_CHARS} letters, digits, hyphens or underscores"));
    }
    if ids.contains(&rule.id) {
        return Err(format!("{at}.id is used by another rule"));
    }
    ids.push(rule.id.clone());
    check_text(&format!("{at}.scope"), &rule.scope)?;
    check_when(at, &rule.when)
}

/// Checks a panel's style; `at` is where it is stored (`options.style`).
pub fn check(at: &str, style: &GraphStyle) -> Result<(), String> {
    if style.version != STYLE_VERSION {
        return Err(format!("{at}.version must be {STYLE_VERSION}"));
    }
    if style.nodes.len() + style.edges.len() > MAX_STYLE_RULES {
        return Err(format!("{at} takes at most {MAX_STYLE_RULES} rules"));
    }
    let mut ids = Vec::new();
    for (i, rule) in style.nodes.iter().enumerate() {
        let at = format!("{at}.nodes[{i}]");
        check_rule(&at, rule, &mut ids)?;
        check_range(&format!("{at}.set.size"), rule.set.size, MIN_RULE_SIZE, MAX_RULE_SIZE)?;
        if let Some(by) = &rule.set.size_by {
            if by.property.is_empty() {
                return Err(format!("{at}.set.sizeBy.property must not be empty"));
            }
            check_text(&format!("{at}.set.sizeBy.property"), &by.property)?;
            check_range(&format!("{at}.set.sizeBy.min"), Some(by.min), MIN_RULE_SIZE, MAX_RULE_SIZE)?;
            check_range(&format!("{at}.set.sizeBy.max"), Some(by.max), MIN_RULE_SIZE, MAX_RULE_SIZE)?;
            if by.min > by.max {
                return Err(format!("{at}.set.sizeBy.min must not be above max"));
            }
        }
        if let Some(icon) = &rule.set.icon
            && !is_icon_name(icon)
        {
            return Err(format!("{at}.set.icon is not an icon name"));
        }
        for (name, text) in [("label", &rule.set.label), ("badge", &rule.set.badge)] {
            if let Some(text) = text {
                check_text(&format!("{at}.set.{name}"), text)?;
            }
        }
    }
    for (i, rule) in style.edges.iter().enumerate() {
        let at = format!("{at}.edges[{i}]");
        check_rule(&at, rule, &mut ids)?;
        check_range(&format!("{at}.set.width"), rule.set.width, MIN_RULE_WIDTH, MAX_RULE_WIDTH)?;
        if let Some(label) = &rule.set.label {
            check_text(&format!("{at}.set.label"), label)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn checked(value: Value) -> Result<(), String> {
        let style: GraphStyle = serde_json::from_value(value).map_err(|e| format!("options.style: {e}"))?;
        check("options.style", &style)
    }

    fn rule(id: &str, when: Value, set: Value) -> Value {
        json!({ "id": id, "on": true, "scope": "Kunde", "when": when, "set": set })
    }

    fn condition(value_type: &str, op: &str) -> Value {
        json!({ "kind": "condition", "property": "umsatz", "type": value_type, "op": op, "value": "1", "to": "2", "caseSensitive": false })
    }

    #[test]
    fn icons_are_only_names_of_the_shipped_set() {
        let with_icon = |icon: &str| {
            checked(
                json!({ "version": 1, "nodes": [rule("r1", json!({ "kind": "always" }), json!({ "icon": icon }))], "edges": [] }),
            )
        };
        for name in include_str!("../../../ui/src/panels/graph/style/icons/names.txt").split_whitespace() {
            assert_eq!(with_icon(name), Ok(()), "{name}");
        }
        assert!(with_icon("not-an-icon").is_err());
        assert!(with_icon("").is_err());
    }

    #[test]
    fn rules_of_every_kind_and_target_pass() {
        let style = json!({
            "version": 1,
            "nodes": [
                rule("r1", json!({ "kind": "always" }), json!({ "icon": "user-round" })),
                rule("r2", json!({ "kind": "values", "property": "segment", "colors": [{ "value": "Premium", "color": "chart-3" }] }), json!({})),
                rule("r3", condition("number", "gte"), json!({ "badge": "Top", "size": 40, "shape": "hexagon" })),
                rule("r4", condition("date", "lastDays"), json!({ "border": "dashed", "label": "{name} (gekündigt)", "color": "critical" })),
                rule("r5", condition("boolean", "false"), json!({ "color": "neutral", "size": 2, "border": "none" })),
                rule("r7", json!({ "kind": "always" }), json!({ "sizeBy": { "property": "pagerank", "min": 5, "max": 17 } })),
                rule("r6", condition("text", "startsWith"), json!({ "shape": "triangle", "color": "neutral-strong" })),
            ],
            "edges": [
                rule("e1", json!({ "kind": "always" }), json!({ "dash": "dotted", "arrow": "none" })),
                rule("e2", condition("number", "between"), json!({ "width": 8, "color": "chart-8", "label": "{menge} x" })),
            ],
        });
        assert_eq!(checked(style), Ok(()));
        assert_eq!(checked(json!({ "version": 1, "nodes": [], "edges": [] })), Ok(()));
    }

    #[test]
    fn every_comparison_fits_only_its_own_data_types() {
        let fits = [
            ("number", vec!["eq", "ne", "lt", "lte", "gt", "gte", "between", "exists", "missing"]),
            ("text", vec!["eq", "ne", "contains", "notContains", "startsWith", "exists", "missing"]),
            ("date", vec!["on", "before", "after", "between", "lastDays", "exists", "missing"]),
            ("boolean", vec!["true", "false", "exists", "missing"]),
        ];
        let all = [
            "eq",
            "ne",
            "lt",
            "lte",
            "gt",
            "gte",
            "between",
            "contains",
            "notContains",
            "startsWith",
            "on",
            "before",
            "after",
            "lastDays",
            "true",
            "false",
            "exists",
            "missing",
        ];
        for (value_type, ops) in &fits {
            for op in all {
                let style = json!({ "version": 1, "nodes": [rule("r1", condition(value_type, op), json!({ "color": "good" }))], "edges": [] });
                assert_eq!(checked(style).is_ok(), ops.contains(&op), "{value_type} {op}");
            }
        }
    }

    #[test]
    fn invalid_styles_are_refused_with_the_place() {
        let long = "x".repeat(MAX_RULE_TEXT_CHARS + 1);
        let always = || json!({ "kind": "always" });
        let nodes = |rules: Value| json!({ "version": 1, "nodes": rules, "edges": [] });
        let edges = |rules: Value| json!({ "version": 1, "nodes": [], "edges": rules });
        let too_many: Vec<Value> =
            (0..=MAX_STYLE_RULES).map(|i| rule(&format!("r{i}"), always(), json!({ "color": "chart-1" }))).collect();
        let too_many_values: Vec<Value> =
            (0..=MAX_VALUE_COLORS).map(|i| json!({ "value": format!("v{i}"), "color": "chart-1" })).collect();
        let cases: Vec<(Value, &str)> = vec![
            (json!({ "version": 2, "nodes": [], "edges": [] }), "options.style.version"),
            (json!({ "version": 1, "nodes": [] }), "missing field"),
            (json!({ "version": 1, "nodes": [], "edges": [], "links": [] }), "unknown field"),
            (nodes(json!(too_many)), "at most 50 rules"),
            (nodes(json!([rule("r1", always(), json!({ "color": "#ff0000" }))])), "options.style"),
            (nodes(json!([rule("r1", always(), json!({ "color": "accent" }))])), "options.style"),
            (
                nodes(json!([rule("r1", always(), json!({ "size": MAX_RULE_SIZE + 1 }))])),
                "options.style.nodes[0].set.size",
            ),
            (nodes(json!([rule("r1", always(), json!({ "size": 1 }))])), "options.style.nodes[0].set.size"),
            (
                nodes(json!([rule("r1", always(), json!({ "sizeBy": { "property": "", "min": 5, "max": 9 } }))])),
                "options.style.nodes[0].set.sizeBy.property",
            ),
            (
                nodes(json!([rule("r1", always(), json!({ "sizeBy": { "property": "p", "min": 9, "max": 5 } }))])),
                "options.style.nodes[0].set.sizeBy.min",
            ),
            (
                nodes(json!([rule("r1", always(), json!({ "sizeBy": { "property": "p", "min": 1, "max": 5 } }))])),
                "options.style.nodes[0].set.sizeBy.min",
            ),
            (
                edges(json!([rule("e1", always(), json!({ "sizeBy": { "property": "p", "min": 5, "max": 9 } }))])),
                "unknown field",
            ),
            (nodes(json!([rule("r1", always(), json!({ "shape": "star" }))])), "options.style"),
            (nodes(json!([rule("r1", always(), json!({ "icon": "../x" }))])), "options.style.nodes[0].set.icon"),
            (nodes(json!([rule("r1", always(), json!({ "icon": "User" }))])), "options.style.nodes[0].set.icon"),
            (nodes(json!([rule("r1", always(), json!({ "border": "glow" }))])), "options.style"),
            (nodes(json!([rule("r1", always(), json!({ "label": long }))])), "options.style.nodes[0].set.label"),
            (nodes(json!([rule("r1", always(), json!({ "badge": "a\u{0}b" }))])), "control characters"),
            (nodes(json!([rule("r1", always(), json!({ "width": 2 }))])), "unknown field"),
            (nodes(json!([rule("", always(), json!({}))])), "options.style.nodes[0].id"),
            (nodes(json!([rule("a b", always(), json!({}))])), "options.style.nodes[0].id"),
            (
                nodes(json!([rule("r1", always(), json!({})), rule("r1", always(), json!({}))])),
                "options.style.nodes[1].id",
            ),
            (nodes(json!([rule("r1", json!({ "kind": "sometimes" }), json!({}))])), "options.style"),
            (nodes(json!([rule("r1", condition("number", "contains"), json!({}))])), "options.style.nodes[0].when.op"),
            (
                nodes(json!([rule("r1", json!({ "kind": "values", "property": "", "colors": [] }), json!({}))])),
                "options.style.nodes[0].when.property",
            ),
            (
                nodes(json!([rule(
                    "r1",
                    json!({ "kind": "values", "property": "segment", "colors": too_many_values }),
                    json!({})
                )])),
                "at most 12 values",
            ),
            (
                edges(json!([rule("e1", always(), json!({ "width": MAX_RULE_WIDTH + 1 }))])),
                "options.style.edges[0].set.width",
            ),
            (edges(json!([rule("e1", always(), json!({ "dash": "wavy" }))])), "options.style"),
            (edges(json!([rule("e1", always(), json!({ "icon": "user" }))])), "unknown field"),
            (edges(json!([rule("e1", always(), json!({ "arrow": "both" }))])), "options.style"),
        ];
        for (style, place) in cases {
            let error = checked(style.clone()).expect_err(&format!("{style} should be refused"));
            assert!(error.contains(place), "{error} should name {place}");
        }
    }

    #[test]
    fn node_and_edge_rules_share_the_limit_and_the_ids() {
        let always = json!({ "kind": "always" });
        let many = |from: usize, count: usize| -> Vec<Value> {
            (from..from + count)
                .map(|i| rule(&format!("r{i}"), always.clone(), json!({ "color": "chart-1" })))
                .collect()
        };
        assert_eq!(checked(json!({ "version": 1, "nodes": many(0, 30), "edges": many(30, 20) })), Ok(()));
        assert!(checked(json!({ "version": 1, "nodes": many(0, 30), "edges": many(30, 21) })).is_err());
        let shared = json!({ "version": 1, "nodes": many(0, 1), "edges": many(0, 1) });
        assert!(checked(shared).unwrap_err().contains("options.style.edges[0].id"));
    }
}
