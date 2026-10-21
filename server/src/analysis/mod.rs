//! Analysis steps on `frame` results: calculated fields, joins of two queries, statistics, group
//! and pivot (docs/api/analysis.md). Steps are explicit, ordered and visible: they are stored with
//! the panel (`transformations`) or sent with an Explore export, each can be disabled, and the
//! query's own result stays as it was. Nothing here runs unless a step asks for it.
//!
//! Where they run: the browser runs them for what it shows (`ui/src/analysis/`); the server runs
//! the same steps here for exports, so a file holds what the panel shows and the permission check
//! stays on the server. Both engines pass the cases in `conformance.json`.
//!
//! Pushdown (later): steps work on results already held in memory, bounded by the query's row
//! limit. Heavy work belongs in the database (SQL `GROUP BY`, Mongo `$group`, Cypher
//! aggregation); a later version will turn a leading group, reduce or pivot step into the query
//! for sources that can do it, and run here only what the source cannot.

pub mod expr;
pub mod export;
pub mod stats;
pub mod steps;

use std::collections::BTreeSet;

use serde::Deserialize;
use serde_json::Value;

/// Steps per panel or export.
pub const MAX_STEPS: usize = 50;
/// Field lists of one step (statistics over fields, group-by fields, aggregations).
pub const MAX_STEP_FIELDS: usize = 50;
pub const MAX_GROUP_BY: usize = 10;
pub const MAX_PERCENTILES: usize = 10;
pub const MAX_WINDOW: u32 = 10_000;
const MAX_NAME_CHARS: usize = 200;
const MAX_REF_CHARS: usize = 64;

/// One step as stored: `{"id", "type", "disabled"?, ...}`.
#[derive(Clone, Debug, PartialEq)]
pub struct Step {
    pub id: String,
    pub disabled: bool,
    pub kind: StepKind,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase", deny_unknown_fields)]
pub enum StepKind {
    /// A new field computed by an expression over the fields of `frame`.
    Calculate { frame: String, name: String, expression: String },
    /// Joins frame `right` onto frame `left` by time or by key fields; the result takes the
    /// place of `left` and `right` is used up.
    Join { left: String, right: String, on: JoinOn, mode: JoinMode },
    /// Statistics per field: one row per field, one column per measure.
    Reduce {
        frame: String,
        fields: Vec<String>,
        stats: Vec<Stat>,
        #[serde(default)]
        percentiles: Vec<f64>,
    },
    /// The least-squares line of `field` over `x` (the frame's time field, else the row number).
    Trend {
        frame: String,
        field: String,
        #[serde(default)]
        x: Option<String>,
        output: TrendOutput,
        #[serde(default)]
        name: Option<String>,
    },
    MovingAverage { frame: String, field: String, window: u32, name: String },
    /// Pearson's correlation of two fields.
    Correlate { frame: String, x: String, y: String },
    /// Each value next to the value one period earlier (UTC calendar).
    Compare {
        frame: String,
        field: String,
        #[serde(default)]
        time: Option<String>,
        period: Period,
        output: CompareOutput,
        name: String,
    },
    Group { frame: String, by: Vec<String>, aggregations: Vec<Aggregation> },
    Pivot { frame: String, row: String, column: String, value: String, op: Agg },
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(tag = "by", rename_all = "camelCase", rename_all_fields = "camelCase", deny_unknown_fields)]
pub enum JoinOn {
    /// The first time field of each frame.
    Time,
    Key { left_field: String, right_field: String },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum JoinMode {
    Inner,
    Left,
    Outer,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Stat {
    Count,
    Sum,
    Mean,
    Median,
    Min,
    Max,
    Stddev,
    Percentile,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TrendOutput {
    /// A new field with the line's value at every row.
    Fitted,
    /// One row: slope (per day over time), intercept, r2, n.
    Summary,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Period {
    Week,
    Month,
    Year,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CompareOutput {
    Previous,
    Difference,
    Percent,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Agg {
    Count,
    Sum,
    Mean,
    Median,
    Min,
    Max,
    Stddev,
    First,
    Last,
}

impl Agg {
    pub fn as_str(self) -> &'static str {
        match self {
            Agg::Count => "count",
            Agg::Sum => "sum",
            Agg::Mean => "mean",
            Agg::Median => "median",
            Agg::Min => "min",
            Agg::Max => "max",
            Agg::Stddev => "stddev",
            Agg::First => "first",
            Agg::Last => "last",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Aggregation {
    pub field: String,
    pub op: Agg,
    /// The result field's name; `op(field)` when absent.
    #[serde(default)]
    pub name: Option<String>,
}

impl Aggregation {
    pub fn output_name(&self) -> String {
        self.name.clone().unwrap_or_else(|| format!("{}({})", self.op.as_str(), self.field))
    }
}

impl StepKind {
    /// The frames this step reads.
    pub fn frames(&self) -> Vec<&str> {
        match self {
            StepKind::Join { left, right, .. } => vec![left, right],
            StepKind::Calculate { frame, .. }
            | StepKind::Reduce { frame, .. }
            | StepKind::Trend { frame, .. }
            | StepKind::MovingAverage { frame, .. }
            | StepKind::Correlate { frame, .. }
            | StepKind::Compare { frame, .. }
            | StepKind::Group { frame, .. }
            | StepKind::Pivot { frame, .. } => vec![frame],
        }
    }
}

fn check_text(what: &str, value: &str, max: usize) -> Result<(), String> {
    let chars = value.chars().count();
    if chars == 0 || chars > max {
        return Err(format!("{what} needs 1 to {max} characters"));
    }
    if value.chars().any(char::is_control) {
        return Err(format!("{what} contains control characters"));
    }
    Ok(())
}

fn check_list(what: &str, items: &[String], min: usize, max: usize) -> Result<(), String> {
    if items.len() < min || items.len() > max {
        return Err(format!("{what} takes {min} to {max} entries"));
    }
    for (i, item) in items.iter().enumerate() {
        check_text(&format!("{what}[{i}]"), item, MAX_NAME_CHARS)?;
    }
    Ok(())
}

/// One step from its stored JSON.
pub fn parse_step(value: &Value) -> Result<Step, String> {
    let Value::Object(map) = value else { return Err("must be an object".into()) };
    let mut rest = map.clone();
    let id = match rest.remove("id") {
        Some(Value::String(s)) => s,
        _ => return Err("id must be text".into()),
    };
    let disabled = match rest.remove("disabled") {
        None => false,
        Some(Value::Bool(b)) => b,
        Some(_) => return Err("disabled must be true or false".into()),
    };
    let kind: StepKind = serde_json::from_value(Value::Object(rest)).map_err(|e| e.to_string())?;
    Ok(Step { id, disabled, kind })
}

/// Parses and bounds a list of steps whose frames must be among `frames` (the reference ids of
/// the queries they follow). Expressions are parsed here; their fields and types are checked
/// against the data when the step runs, since only then the fields are known. Errors name the
/// place (`at[2].expression: ...`).
pub fn check_steps(raw: &[Value], frames: &BTreeSet<&str>, at: &str) -> Result<Vec<Step>, String> {
    if raw.len() > MAX_STEPS {
        return Err(format!("{at} takes at most {MAX_STEPS} entries"));
    }
    let mut ids = BTreeSet::new();
    let mut steps = Vec::with_capacity(raw.len());
    for (i, value) in raw.iter().enumerate() {
        let at = format!("{at}[{i}]");
        let step = parse_step(value).map_err(|e| format!("{at}: {e}"))?;
        check_text(&format!("{at}.id"), &step.id, MAX_REF_CHARS)?;
        if !ids.insert(step.id.clone()) {
            return Err(format!("{at}.id {} is used twice", step.id));
        }
        for frame in step.kind.frames() {
            check_text(&format!("{at}.frame"), frame, MAX_REF_CHARS)?;
            if !frames.contains(frame) {
                return Err(format!("{at}: there is no query {frame}"));
            }
        }
        check_kind(&step.kind, &at)?;
        steps.push(step);
    }
    Ok(steps)
}

fn check_kind(kind: &StepKind, at: &str) -> Result<(), String> {
    let name = |n: &str| check_text(&format!("{at}.name"), n, MAX_NAME_CHARS);
    let field = |what: &str, f: &str| check_text(&format!("{at}.{what}"), f, MAX_NAME_CHARS);
    match kind {
        StepKind::Calculate { name: n, expression, .. } => {
            name(n)?;
            expr::parse(expression).map_err(|e| format!("{at}.expression: {e}"))?;
        }
        StepKind::Join { left, right, on, .. } => {
            if left == right {
                return Err(format!("{at}: a query cannot be joined with itself"));
            }
            if let JoinOn::Key { left_field, right_field } = on {
                field("on.leftField", left_field)?;
                field("on.rightField", right_field)?;
            }
        }
        StepKind::Reduce { fields, stats, percentiles, .. } => {
            check_list(&format!("{at}.fields"), fields, 1, MAX_STEP_FIELDS)?;
            if stats.is_empty() || stats.iter().collect::<BTreeSet<_>>().len() != stats.len() {
                return Err(format!("{at}.stats needs at least one measure, each once"));
            }
            let wants = stats.contains(&Stat::Percentile);
            if wants != !percentiles.is_empty() || percentiles.len() > MAX_PERCENTILES {
                return Err(format!("{at}.percentiles: give 1 to {MAX_PERCENTILES} with the percentile measure, none without"));
            }
            let mut seen = BTreeSet::new();
            for p in percentiles {
                if !(0.0..=100.0).contains(p) || !seen.insert(expr::number_text(*p)) {
                    return Err(format!("{at}.percentiles must be distinct numbers from 0 to 100"));
                }
            }
        }
        StepKind::Trend { field: f, x, output, name: n, .. } => {
            field("field", f)?;
            if let Some(x) = x {
                field("x", x)?;
            }
            match (output, n) {
                (TrendOutput::Fitted, Some(n)) => name(n)?,
                (TrendOutput::Fitted, None) => return Err(format!("{at}.name is required for the fitted line")),
                (TrendOutput::Summary, Some(_)) => return Err(format!("{at}.name belongs only to the fitted line")),
                (TrendOutput::Summary, None) => {}
            }
        }
        StepKind::MovingAverage { field: f, window, name: n, .. } => {
            field("field", f)?;
            name(n)?;
            if !(1..=MAX_WINDOW).contains(window) {
                return Err(format!("{at}.window must be 1 to {MAX_WINDOW} rows"));
            }
        }
        StepKind::Correlate { x, y, .. } => {
            field("x", x)?;
            field("y", y)?;
        }
        StepKind::Compare { field: f, time, name: n, .. } => {
            field("field", f)?;
            if let Some(t) = time {
                field("time", t)?;
            }
            name(n)?;
        }
        StepKind::Group { by, aggregations, .. } => {
            check_list(&format!("{at}.by"), by, 1, MAX_GROUP_BY)?;
            if aggregations.len() > MAX_STEP_FIELDS {
                return Err(format!("{at}.aggregations takes at most {MAX_STEP_FIELDS} entries"));
            }
            for (i, a) in aggregations.iter().enumerate() {
                field(&format!("aggregations[{i}].field"), &a.field)?;
                if let Some(n) = &a.name {
                    check_text(&format!("{at}.aggregations[{i}].name"), n, MAX_NAME_CHARS)?;
                }
            }
        }
        StepKind::Pivot { row, column, value, .. } => {
            field("row", row)?;
            field("column", column)?;
            field("value", value)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn frames() -> BTreeSet<&'static str> {
        BTreeSet::from(["A", "B"])
    }

    fn check(steps: Value) -> Result<Vec<Step>, String> {
        check_steps(steps.as_array().unwrap(), &frames(), "steps")
    }

    #[test]
    fn every_kind_parses() {
        let steps = check(json!([
            { "id": "1", "type": "calculate", "frame": "A", "name": "Brutto", "expression": "betrag * 1.19" },
            { "id": "2", "type": "join", "left": "A", "right": "B", "on": { "by": "time" }, "mode": "outer" },
            { "id": "3", "type": "join", "left": "B", "right": "A", "mode": "inner",
              "on": { "by": "key", "leftField": "land", "rightField": "land" }, "disabled": true },
            { "id": "4", "type": "reduce", "frame": "A", "fields": ["betrag"], "stats": ["mean", "percentile"], "percentiles": [90, 99.5] },
            { "id": "5", "type": "trend", "frame": "A", "field": "betrag", "output": "fitted", "name": "Trend" },
            { "id": "6", "type": "trend", "frame": "A", "field": "betrag", "x": "zeit", "output": "summary" },
            { "id": "7", "type": "movingAverage", "frame": "A", "field": "betrag", "window": 7, "name": "Schnitt" },
            { "id": "8", "type": "correlate", "frame": "A", "x": "a", "y": "b" },
            { "id": "9", "type": "compare", "frame": "A", "field": "betrag", "period": "month", "output": "percent", "name": "Vormonat" },
            { "id": "10", "type": "group", "frame": "A", "by": ["land"], "aggregations": [{ "field": "betrag", "op": "sum" }] },
            { "id": "11", "type": "pivot", "frame": "A", "row": "land", "column": "jahr", "value": "betrag", "op": "mean" }
        ]))
        .unwrap();
        assert_eq!(steps.len(), 11);
        assert!(steps[2].disabled && !steps[0].disabled);
        assert_eq!(steps[1].kind, StepKind::Join { left: "A".into(), right: "B".into(), on: JoinOn::Time, mode: JoinMode::Outer });
        let StepKind::Group { aggregations, .. } = &steps[9].kind else { panic!() };
        assert_eq!(aggregations[0].output_name(), "sum(betrag)");
    }

    #[test]
    fn invalid_steps_are_refused_with_the_place() {
        let base = json!({ "id": "s", "type": "calculate", "frame": "A", "name": "x", "expression": "1" });
        let with = |key: &str, value: Value| {
            let mut s = base.clone();
            s[key] = value;
            json!([s])
        };
        for (steps, expect) in [
            (json!([1]), "steps[0]: must be an object"),
            (with("id", json!(3)), "steps[0]: id must be text"),
            (with("id", json!("")), "steps[0].id"),
            (with("disabled", json!("ja")), "disabled"),
            (with("type", json!("magic")), "unknown variant"),
            (with("colour", json!("red")), "unknown field"),
            (with("frame", json!("Z")), "there is no query Z"),
            (with("name", json!("")), "steps[0].name"),
            (with("name", json!("a\nb")), "control characters"),
            (with("expression", json!("1 +")), "steps[0].expression: unexpected input at 4"),
            (with("expression", json!("x".repeat(2001))), "more than 2000"),
            (json!([base, base]), "steps[1].id s is used twice"),
            (json!([{ "id": "j", "type": "join", "left": "A", "right": "A", "on": { "by": "time" }, "mode": "left" }]), "with itself"),
            (json!([{ "id": "j", "type": "join", "left": "A", "right": "B", "on": { "by": "key" }, "mode": "left" }]), "missing field"),
            (json!([{ "id": "r", "type": "reduce", "frame": "A", "fields": [], "stats": ["sum"] }]), "fields takes 1 to 50"),
            (json!([{ "id": "r", "type": "reduce", "frame": "A", "fields": ["a"], "stats": ["sum", "sum"] }]), "each once"),
            (json!([{ "id": "r", "type": "reduce", "frame": "A", "fields": ["a"], "stats": ["percentile"] }]), "percentiles"),
            (json!([{ "id": "r", "type": "reduce", "frame": "A", "fields": ["a"], "stats": ["sum"], "percentiles": [5] }]), "none without"),
            (json!([{ "id": "r", "type": "reduce", "frame": "A", "fields": ["a"], "stats": ["percentile"], "percentiles": [101] }]), "0 to 100"),
            (json!([{ "id": "r", "type": "reduce", "frame": "A", "fields": ["a"], "stats": ["percentile"], "percentiles": [5, 5.0] }]), "distinct"),
            (json!([{ "id": "t", "type": "trend", "frame": "A", "field": "a", "output": "fitted" }]), "name is required"),
            (json!([{ "id": "t", "type": "trend", "frame": "A", "field": "a", "output": "summary", "name": "n" }]), "only to the fitted"),
            (json!([{ "id": "m", "type": "movingAverage", "frame": "A", "field": "a", "window": 0, "name": "n" }]), "window"),
            (json!([{ "id": "m", "type": "movingAverage", "frame": "A", "field": "a", "window": 10001, "name": "n" }]), "window"),
            (json!([{ "id": "m", "type": "movingAverage", "frame": "A", "field": "a", "window": -1, "name": "n" }]), "invalid value"),
            (json!([{ "id": "g", "type": "group", "frame": "A", "by": [], "aggregations": [] }]), "by takes 1 to 10"),
            (json!([{ "id": "g", "type": "group", "frame": "A", "by": ["a"], "aggregations": [{ "field": "b", "op": "avg" }] }]), "unknown variant"),
        ] {
            let err = check(steps.clone()).unwrap_err();
            assert!(err.contains(expect), "{steps}: {err}");
        }
        let many: Vec<Value> = (0..=MAX_STEPS)
            .map(|i| json!({ "id": format!("s{i}"), "type": "calculate", "frame": "A", "name": "x", "expression": "1" }))
            .collect();
        assert!(check(json!(many)).unwrap_err().contains("at most 50"));
    }
}
