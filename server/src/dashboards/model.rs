//! The dashboard model: JSON with a `schemaVersion`. Stored models are migrated to the current
//! version on read, one step per version (docs/ARCHITECTURE.md, "Dashboards"); saved models are
//! migrated the same way and then validated.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The version this server writes. A model with a higher version comes from a newer Kalzit and is
/// refused rather than guessed at.
pub const SCHEMA_VERSION: u64 = 1;

/// `STEPS[i]` turns a model of schemaVersion `i + 1` into `i + 2`; each step has its own test.
/// A step changes only what its version changed and sets the new `schemaVersion`.
type Step = fn(Value) -> Result<Value, String>;
const STEPS: &[Step] = &[];

/// The grid has 24 columns; rows are unbounded but a dashboard this tall is a mistake.
pub const GRID_COLUMNS: u32 = 24;
const MAX_GRID_Y: u32 = 10_000;
const MAX_PANEL_HEIGHT: u32 = 200;
const MAX_PANELS: usize = 500;
const MAX_TARGETS: usize = 50;
const MAX_VARIABLES: usize = 100;
const MAX_ID_CHARS: usize = 64;
pub const MAX_TITLE_CHARS: usize = 200;
/// Refreshing faster than this only loads the data sources.
const MIN_REFRESH_SECONDS: u32 = 5;
const MAX_REFRESH_SECONDS: u32 = 24 * 3600;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DashboardModel {
    pub schema_version: u64,
    pub title: String,
    pub time_range: TimeRange,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refresh_seconds: Option<u32>,
    #[serde(default)]
    pub variables: Vec<Variable>,
    #[serde(default)]
    pub panels: Vec<Panel>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TimeRange {
    pub from: String,
    pub to: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum VariableType {
    /// Options come from a query against `datasourceId`.
    Query,
    /// Options listed in `options`.
    Custom,
    Constant,
    Textbox,
    Interval,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Variable {
    pub name: String,
    #[serde(rename = "type")]
    pub kind: VariableType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub datasource_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub query: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current: Option<Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Panel {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub title: String,
    pub grid: Grid,
    #[serde(default)]
    pub targets: Vec<Target>,
    #[serde(default)]
    pub transformations: Vec<Value>,
    #[serde(default = "empty_object")]
    pub options: Value,
    #[serde(default = "empty_object")]
    pub field_config: Value,
}

fn empty_object() -> Value {
    Value::Object(Default::default())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Grid {
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Target {
    pub ref_id: String,
    pub datasource_id: String,
    pub query: Value,
}

impl DashboardModel {
    /// Every data source the stored queries use: panel targets and query variables.
    pub fn datasource_ids(&self) -> BTreeSet<&str> {
        let targets = self.panels.iter().flat_map(|p| p.targets.iter().map(|t| t.datasource_id.as_str()));
        let variables = self.variables.iter().filter_map(|v| v.datasource_id.as_deref());
        targets.chain(variables).collect()
    }
}

/// Migrates a stored or submitted model to `SCHEMA_VERSION` and parses and validates it.
pub fn parse(raw: Value) -> Result<DashboardModel, String> {
    let current = migrate(raw)?;
    let model: DashboardModel = serde_json::from_value(current).map_err(|e| format!("model: {e}"))?;
    validate(&model)?;
    Ok(model)
}

pub fn migrate(raw: Value) -> Result<Value, String> {
    migrate_with(raw, STEPS, SCHEMA_VERSION)
}

fn migrate_with(mut model: Value, steps: &[Step], current: u64) -> Result<Value, String> {
    let Some(mut version) = model.get("schemaVersion").and_then(Value::as_u64) else {
        return Err("model.schemaVersion must be a whole number".into());
    };
    if version == 0 {
        return Err("model.schemaVersion starts at 1".into());
    }
    if version > current {
        return Err(format!(
            "model.schemaVersion {version} comes from a newer Kalzit; this server reads up to {current}"
        ));
    }
    while version < current {
        let step =
            steps.get(version as usize - 1).ok_or_else(|| format!("no migration from schemaVersion {version}"))?;
        model = step(model).map_err(|e| format!("migrating from schemaVersion {version}: {e}"))?;
        let next = model.get("schemaVersion").and_then(Value::as_u64);
        if next != Some(version + 1) {
            return Err(format!("migration from schemaVersion {version} did not produce {}", version + 1));
        }
        version += 1;
    }
    Ok(model)
}

fn check_text(what: &str, value: &str, min: usize, max: usize) -> Result<(), String> {
    let chars = value.chars().count();
    if chars < min || chars > max {
        return Err(format!("{what} needs {min} to {max} characters"));
    }
    if value.chars().any(char::is_control) {
        return Err(format!("{what} contains control characters"));
    }
    Ok(())
}

fn check_id(what: &str, value: &str) -> Result<(), String> {
    check_text(what, value, 1, MAX_ID_CHARS)?;
    if value.trim() != value {
        return Err(format!("{what} must not start or end with spaces"));
    }
    Ok(())
}

/// Variable names appear in queries as `$name`, so they are identifiers.
fn is_identifier(name: &str) -> bool {
    let mut chars = name.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

pub fn validate(model: &DashboardModel) -> Result<(), String> {
    if model.schema_version != SCHEMA_VERSION {
        return Err(format!("model.schemaVersion must be {SCHEMA_VERSION}"));
    }
    if model.title.trim().is_empty() {
        return Err("model.title must not be empty".into());
    }
    check_text("model.title", &model.title, 1, MAX_TITLE_CHARS)?;
    check_range(&model.time_range).map_err(|e| format!("model.timeRange: {e}"))?;
    if let Some(r) = model.refresh_seconds
        && !(MIN_REFRESH_SECONDS..=MAX_REFRESH_SECONDS).contains(&r)
    {
        return Err(format!("model.refreshSeconds must be {MIN_REFRESH_SECONDS} to {MAX_REFRESH_SECONDS}"));
    }

    if model.variables.len() > MAX_VARIABLES {
        return Err(format!("model.variables takes at most {MAX_VARIABLES} entries"));
    }
    let mut names = BTreeSet::new();
    for (i, v) in model.variables.iter().enumerate() {
        let at = format!("model.variables[{i}]");
        if v.name.chars().count() > MAX_ID_CHARS || !is_identifier(&v.name) {
            return Err(format!("{at}.name must be a name of letters, digits and _ (up to {MAX_ID_CHARS})"));
        }
        if !names.insert(v.name.as_str()) {
            return Err(format!("{at}.name {} is used twice", v.name));
        }
        if let Some(label) = &v.label {
            check_text(&format!("{at}.label"), label, 0, MAX_TITLE_CHARS)?;
        }
        match (v.kind, &v.datasource_id) {
            (VariableType::Query, Some(id)) => check_id(&format!("{at}.datasourceId"), id)?,
            (VariableType::Query, None) => return Err(format!("{at}.datasourceId is required for a query variable")),
            (_, Some(_)) => return Err(format!("{at}.datasourceId belongs only to query variables")),
            (_, None) => {}
        }
    }

    if model.panels.len() > MAX_PANELS {
        return Err(format!("model.panels takes at most {MAX_PANELS} entries"));
    }
    let mut ids = BTreeSet::new();
    for (i, p) in model.panels.iter().enumerate() {
        let at = format!("model.panels[{i}]");
        check_id(&format!("{at}.id"), &p.id)?;
        if !ids.insert(p.id.as_str()) {
            return Err(format!("{at}.id {} is used twice", p.id));
        }
        check_id(&format!("{at}.type"), &p.kind)?;
        check_text(&format!("{at}.title"), &p.title, 0, MAX_TITLE_CHARS)?;
        check_grid(&p.grid).map_err(|e| format!("{at}.grid: {e}"))?;
        if p.targets.len() > MAX_TARGETS {
            return Err(format!("{at}.targets takes at most {MAX_TARGETS} entries"));
        }
        let mut ref_ids = BTreeSet::new();
        for (j, t) in p.targets.iter().enumerate() {
            let at = format!("{at}.targets[{j}]");
            check_id(&format!("{at}.refId"), &t.ref_id)?;
            if !ref_ids.insert(t.ref_id.as_str()) {
                return Err(format!("{at}.refId {} is used twice in this panel", t.ref_id));
            }
            check_id(&format!("{at}.datasourceId"), &t.datasource_id)?;
        }
    }
    Ok(())
}

fn check_grid(g: &Grid) -> Result<(), String> {
    if g.w == 0 || g.w > GRID_COLUMNS {
        return Err(format!("w must be 1 to {GRID_COLUMNS}"));
    }
    if g.x + g.w > GRID_COLUMNS {
        return Err(format!("x + w must not exceed {GRID_COLUMNS} columns"));
    }
    if g.h == 0 || g.h > MAX_PANEL_HEIGHT {
        return Err(format!("h must be 1 to {MAX_PANEL_HEIGHT}"));
    }
    if g.y > MAX_GRID_Y {
        return Err(format!("y must be 0 to {MAX_GRID_Y}"));
    }
    Ok(())
}

/// A time range as JSON (`{"from": "now-6h", "to": "now"}`), for settings that hold one.
pub fn check_time_range(value: &Value) -> Result<(), String> {
    let range: TimeRange =
        serde_json::from_value(value.clone()).map_err(|_| "must be {\"from\", \"to\"}".to_string())?;
    check_range(&range)
}

fn check_range(range: &TimeRange) -> Result<(), String> {
    for (what, t) in [("from", &range.from), ("to", &range.to)] {
        if !is_time(t) {
            return Err(format!("{what} must be \"now\", relative like \"now-6h\" or an ISO time"));
        }
    }
    Ok(())
}

/// `now`, `now-6h`, `now-1d/d`, `now+15m`; or an ISO 8601 date or date-time with zone.
fn is_time(s: &str) -> bool {
    if let Some(rest) = s.strip_prefix("now") {
        return is_relative(rest);
    }
    is_iso_time(s)
}

const UNITS: &[char] = &['s', 'm', 'h', 'd', 'w', 'M', 'y'];

fn is_relative(mut rest: &str) -> bool {
    while let Some(after_sign) = rest.strip_prefix(['+', '-']) {
        let digits = after_sign.chars().take_while(char::is_ascii_digit).count();
        // Five digits cover a century in hours; more is a typo.
        if digits == 0 || digits > 5 {
            return false;
        }
        let mut tail = after_sign[digits..].chars();
        if !tail.next().is_some_and(|u| UNITS.contains(&u)) {
            return false;
        }
        rest = tail.as_str();
    }
    match rest.strip_prefix('/') {
        Some(unit) => unit.chars().count() == 1 && unit.chars().all(|u| UNITS.contains(&u)),
        None => rest.is_empty(),
    }
}

fn is_iso_time(s: &str) -> bool {
    let bytes = s.as_bytes();
    let num = |range: std::ops::Range<usize>, max: u32| -> Option<u32> {
        let part = s.get(range)?;
        if !part.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        part.parse().ok().filter(|n| *n <= max)
    };
    let date_ok = s.len() >= 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && num(0..4, 9999).is_some()
        && num(5..7, 12).is_some_and(|m| m >= 1)
        && num(8..10, 31).is_some_and(|d| d >= 1);
    if !date_ok {
        return false;
    }
    if s.len() == 10 {
        return true;
    }
    if bytes[10] != b'T' || s.len() < 16 || bytes[13] != b':' {
        return false;
    }
    if num(11..13, 23).is_none() || num(14..16, 59).is_none() {
        return false;
    }
    let mut rest = &s[16..];
    if let Some(secs) = rest.strip_prefix(':') {
        if secs.get(..2).is_none_or(|p| !p.bytes().all(|b| b.is_ascii_digit()) || p > "60") {
            return false;
        }
        rest = &secs[2..];
        if let Some(frac) = rest.strip_prefix('.') {
            let digits = frac.bytes().take_while(u8::is_ascii_digit).count();
            if digits == 0 || digits > 9 {
                return false;
            }
            rest = &frac[digits..];
        }
    }
    match rest {
        "Z" => true,
        offset => {
            let ob = offset.as_bytes();
            offset.len() == 6
                && matches!(ob[0], b'+' | b'-')
                && ob[3] == b':'
                && offset[1..3].parse::<u32>().is_ok_and(|h| h <= 23)
                && offset[4..6].parse::<u32>().is_ok_and(|m| m <= 59)
                && offset[1..3].bytes().chain(offset[4..6].bytes()).all(|b| b.is_ascii_digit())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample() -> Value {
        json!({
            "schemaVersion": 1,
            "title": "Umsatz Übersicht",
            "timeRange": { "from": "now-6h", "to": "now" },
            "variables": [
                { "name": "region", "type": "query", "datasourceId": "ds-2", "query": "SELECT region FROM r" },
                { "name": "step", "type": "custom", "options": ["1m", "5m"] }
            ],
            "panels": [
                { "id": "p1", "type": "timeseries", "title": "Bestellungen", "grid": { "x": 0, "y": 0, "w": 12, "h": 8 },
                  "targets": [ { "refId": "A", "datasourceId": "ds-1", "query": { "sql": "SELECT 1" } },
                               { "refId": "B", "datasourceId": "ds-1", "query": {} } ] },
                { "id": "p2", "type": "text", "grid": { "x": 12, "y": 0, "w": 12, "h": 8 } }
            ]
        })
    }

    /// The model with one field set (added if missing); the last path element is an object key.
    fn with(mut model: Value, path: &[&str], value: Value) -> Value {
        let (key, parent) = path.split_last().unwrap();
        let pointer: String = parent.iter().map(|p| format!("/{p}")).collect();
        model.pointer_mut(&pointer).unwrap().as_object_mut().unwrap().insert(key.to_string(), value);
        model
    }

    #[test]
    fn a_valid_model_round_trips_with_defaults_filled_in() {
        let model = parse(sample()).unwrap();
        assert_eq!(model.panels[1].targets.len(), 0);
        let back = serde_json::to_value(&model).unwrap();
        assert_eq!(back["panels"][1]["options"], json!({}));
        assert_eq!(back["panels"][1]["fieldConfig"], json!({}));
        assert_eq!(parse(back).unwrap(), model);
        assert_eq!(model.datasource_ids().into_iter().collect::<Vec<_>>(), ["ds-1", "ds-2"]);
    }

    #[test]
    fn invalid_models_are_refused_with_the_place() {
        for (path, value, expect) in [
            (vec!["panels", "0", "grid", "w"], json!(0), "panels[0].grid: w"),
            (vec!["panels", "0", "grid", "w"], json!(25), "panels[0].grid: w"),
            (vec!["panels", "1", "grid", "x"], json!(13), "panels[1].grid: x + w"),
            (vec!["panels", "0", "grid", "h"], json!(0), "panels[0].grid: h"),
            (vec!["panels", "0", "grid", "y"], json!(-1), "model"),
            (vec!["panels", "1", "id"], json!("p1"), "panels[1].id p1 is used twice"),
            (vec!["panels", "0", "id"], json!(""), "panels[0].id"),
            (vec!["panels", "0", "targets", "1", "refId"], json!("A"), "refId A is used twice"),
            (vec!["panels", "0", "targets", "0", "datasourceId"], json!(""), "datasourceId"),
            (vec!["variables", "1", "name"], json!("region"), "used twice"),
            (vec!["variables", "1", "name"], json!("1st"), "variables[1].name"),
            (vec!["variables", "0", "datasourceId"], Value::Null, "required for a query variable"),
            (vec!["variables", "1", "datasourceId"], json!("ds-1"), "only to query variables"),
            (vec!["title"], json!("  "), "model.title"),
            (vec!["title"], json!("x".repeat(201)), "model.title"),
            (vec!["timeRange", "from"], json!("gestern"), "timeRange"),
            (vec!["refreshSeconds"], json!(1), "refreshSeconds"),
            (vec!["unknownField"], json!(1), "unknown field"),
            (vec!["panels", "0", "colour"], json!("red"), "unknown field"),
        ] {
            let err = parse(with(sample(), &path, value)).unwrap_err();
            assert!(err.contains(expect), "{path:?}: {err}");
        }
    }

    #[test]
    fn panel_ids_may_be_unicode() {
        let model = with(sample(), &["panels", "0", "id"], json!("Übersicht 1"));
        assert!(parse(model).is_ok());
    }

    #[test]
    fn times_accept_relative_and_iso_forms() {
        for ok in [
            "now",
            "now-6h",
            "now-1d/d",
            "now/w",
            "now+15m",
            "now-1M-2d",
            "2026-02-28",
            "2026-10-20T08:15Z",
            "2026-10-20T08:15:30.123+02:00",
            "2026-10-20T23:59:60Z",
        ] {
            assert!(is_time(ok), "{ok}");
        }
        for bad in [
            "",
            "now-",
            "now-6",
            "now-6x",
            "now/",
            "now/dd",
            "now-999999h",
            "2026-13-01",
            "2026-10-20T24:00Z",
            "2026-10-20T08:15",
            "2026-10-20 08:15Z",
            "2026-10-20T08:15+2",
            "2026-1ä-20",
            "tomorrow",
        ] {
            assert!(!is_time(bad), "{bad}");
        }
    }

    #[test]
    fn the_step_list_covers_every_version() {
        assert_eq!(STEPS.len() as u64, SCHEMA_VERSION - 1);
        assert_eq!(migrate(sample()).unwrap(), sample(), "the current version passes unchanged");
    }

    #[test]
    fn newer_or_missing_versions_are_refused_clearly() {
        let err = migrate(with(sample(), &["schemaVersion"], json!(2))).unwrap_err();
        assert!(err.contains("newer Kalzit") && err.contains("up to 1"), "{err}");
        for bad in [json!(0), json!("1"), Value::Null, json!(-1)] {
            assert!(migrate(with(sample(), &["schemaVersion"], bad.clone())).is_err(), "{bad}");
        }
    }

    /// The step runner with made-up steps, since version 1 has none yet.
    #[test]
    fn steps_run_in_order_and_must_advance_the_version() {
        fn one_to_two(mut m: Value) -> Result<Value, String> {
            m["schemaVersion"] = json!(2);
            m["trail"] = json!("a");
            Ok(m)
        }
        fn two_to_three(mut m: Value) -> Result<Value, String> {
            m["schemaVersion"] = json!(3);
            m["trail"] = json!(format!("{}b", m["trail"].as_str().unwrap()));
            Ok(m)
        }
        fn forgets_the_version(m: Value) -> Result<Value, String> {
            Ok(m)
        }
        let steps: &[Step] = &[one_to_two, two_to_three];
        let v1 = json!({ "schemaVersion": 1 });
        assert_eq!(migrate_with(v1.clone(), steps, 3).unwrap(), json!({ "schemaVersion": 3, "trail": "ab" }));
        let v2 = json!({ "schemaVersion": 2, "trail": "x" });
        assert_eq!(migrate_with(v2, steps, 3).unwrap()["trail"], "xb");
        let err = migrate_with(v1.clone(), &[forgets_the_version], 2).unwrap_err();
        assert!(err.contains("did not produce 2"), "{err}");
        assert!(migrate_with(v1, &[], 2).unwrap_err().contains("no migration from schemaVersion 1"));
    }

    #[test]
    fn time_range_settings_use_the_same_rules() {
        assert!(check_time_range(&json!({ "from": "now-24h", "to": "now" })).is_ok());
        assert!(check_time_range(&json!({ "from": "now-24h" })).is_err());
        assert!(check_time_range(&json!("now-24h")).is_err());
    }
}
