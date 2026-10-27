//! Analysis steps on `frame` results: calculated fields, joins of two queries, statistics, group
//! and pivot (docs/api/settings-dashboards.md, "Analysis steps"). Steps are explicit, ordered and visible: they are stored with
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

pub mod export;
pub mod expr;
pub mod graph;
pub mod projection;
pub mod pushdown;
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
    Calculate {
        frame: String,
        name: String,
        expression: String,
    },
    /// Joins frame `right` onto frame `left` by time or by key fields; the result takes the
    /// place of `left` and `right` is used up.
    Join {
        left: String,
        right: String,
        on: JoinOn,
        mode: JoinMode,
    },
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
    MovingAverage {
        frame: String,
        field: String,
        window: u32,
        name: String,
    },
    /// Pearson's correlation of two fields.
    Correlate {
        frame: String,
        x: String,
        y: String,
    },
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
    Group {
        frame: String,
        by: Vec<String>,
        aggregations: Vec<Aggregation>,
    },
    Pivot {
        frame: String,
        row: String,
        column: String,
        value: String,
        op: Agg,
    },
    /// The projection (docs/PLAN.md, section 1): the `documents` result of query `frame` as a
    /// frame, one column per field path. The steps after it work on that frame; a result that
    /// already is a frame passes unchanged. With `rows` it projects a `graph` result: one row per
    /// node or per edge, optionally only nodes with `label` or edges of `edgeType`; the paths are
    /// property keys, and `@id`, `@labels` (nodes), `@type`, `@from`, `@to` (edges).
    ToFrame {
        frame: String,
        columns: Vec<ProjectionColumn>,
        #[serde(default)]
        rows: Option<GraphRows>,
        #[serde(default)]
        label: Option<String>,
        #[serde(default)]
        edge_type: Option<String>,
    },
    /// Graph to frame: nodes per label (`label`, `nodes`, `share` of all nodes).
    CountLabels {
        frame: String,
    },
    /// Graph to frame: edges per type and the labels of their ends (`type`, `from`, `to`, `edges`).
    CountEdgeTypes {
        frame: String,
    },
    /// Graph to frame: how many nodes have each degree (`degree`, `nodes`), zero included.
    DegreeDistribution {
        frame: String,
        #[serde(default)]
        direction: Direction,
    },
    /// Graph to graph: the `n` nodes with the highest degree (among those with `label`, when
    /// given) and the edges between them.
    TopDegree {
        frame: String,
        n: u32,
        #[serde(default)]
        label: Option<String>,
        #[serde(default)]
        direction: Direction,
    },
    /// Graph to frame: pairs of `label` nodes that share neighbours with the label `via` (over
    /// edges of `edgeType`, either direction): `a`, `b`, `shared`, `neighbours`; pairs with at
    /// least `min` shared neighbours, the `limit` with the most. Nodes are named by their text
    /// property `name`, else by their id.
    SharedNeighbours {
        frame: String,
        label: String,
        via: String,
        #[serde(default)]
        edge_type: Option<String>,
        min: u32,
        limit: u32,
        #[serde(default)]
        name: Option<String>,
    },
}

/// Which edges count for a node's degree.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Direction {
    #[default]
    Both,
    Out,
    In,
}

/// What a graph projection makes rows of.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GraphRows {
    Nodes,
    Edges,
}

/// Nodes a top-N step keeps, and pairs a shared-neighbours step answers at most.
pub const MAX_TOP_NODES: u32 = 1000;
pub const MAX_PAIRS: u32 = 1000;

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectionColumn {
    /// A dotted MongoDB path, array indexes as numbers (`items.0.price`).
    pub path: String,
    /// The column's name; the path when absent.
    #[serde(default)]
    pub name: Option<String>,
    /// The column's type (not `json`); taken from the first value when absent.
    #[serde(default, rename = "type")]
    pub field_type: Option<crate::shapes::FieldType>,
}

impl ProjectionColumn {
    pub fn output_name(&self) -> &str {
        self.name.as_deref().unwrap_or(&self.path)
    }
}

/// Columns of one projection, and the longest field path.
pub const MAX_PROJECTION_COLUMNS: usize = 200;
pub const MAX_PATH_CHARS: usize = 500;

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(tag = "by", rename_all = "camelCase", rename_all_fields = "camelCase", deny_unknown_fields)]
pub enum JoinOn {
    /// The first time field of each frame.
    Time,
    Key {
        left_field: String,
        right_field: String,
    },
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
            StepKind::ToFrame { frame, .. }
            | StepKind::CountLabels { frame }
            | StepKind::CountEdgeTypes { frame }
            | StepKind::DegreeDistribution { frame, .. }
            | StepKind::TopDegree { frame, .. }
            | StepKind::SharedNeighbours { frame, .. } => vec![frame],
        }
    }

    /// Whether the step reads a graph. Graph steps run where the query runs (in the database
    /// when the source can, else on the server), before the steps that read frames.
    pub fn is_graph_step(&self) -> bool {
        matches!(
            self,
            StepKind::CountLabels { .. }
                | StepKind::CountEdgeTypes { .. }
                | StepKind::DegreeDistribution { .. }
                | StepKind::TopDegree { .. }
                | StepKind::SharedNeighbours { .. }
                | StepKind::ToFrame { rows: Some(_), .. }
        )
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
                return Err(format!(
                    "{at}.percentiles: give 1 to {MAX_PERCENTILES} with the percentile measure, none without"
                ));
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
        StepKind::CountLabels { .. } | StepKind::CountEdgeTypes { .. } | StepKind::DegreeDistribution { .. } => {}
        StepKind::TopDegree { n, label, .. } => {
            if !(1..=MAX_TOP_NODES).contains(n) {
                return Err(format!("{at}.n must be 1 to {MAX_TOP_NODES}"));
            }
            if let Some(l) = label {
                field("label", l)?;
            }
        }
        StepKind::SharedNeighbours { label, via, edge_type, min, limit, name: n, .. } => {
            field("label", label)?;
            field("via", via)?;
            if label == via {
                return Err(format!("{at}.via must be another label than label"));
            }
            if let Some(t) = edge_type {
                field("edgeType", t)?;
            }
            if let Some(n) = n {
                field("name", n)?;
            }
            if *min < 1 {
                return Err(format!("{at}.min must be at least 1"));
            }
            if !(1..=MAX_PAIRS).contains(limit) {
                return Err(format!("{at}.limit must be 1 to {MAX_PAIRS}"));
            }
        }
        StepKind::ToFrame { columns, rows, label, edge_type, .. } => {
            match (rows, label, edge_type) {
                (None, Some(_), _) | (None, _, Some(_)) => {
                    return Err(format!("{at}: label and edgeType belong to a projection of a graph (rows)"));
                }
                (Some(GraphRows::Edges), Some(_), _) => return Err(format!("{at}.label belongs to rows of nodes")),
                (Some(GraphRows::Nodes), _, Some(_)) => return Err(format!("{at}.edgeType belongs to rows of edges")),
                _ => {}
            }
            if let Some(l) = label {
                field("label", l)?;
            }
            if let Some(t) = edge_type {
                field("edgeType", t)?;
            }
            if columns.is_empty() || columns.len() > MAX_PROJECTION_COLUMNS {
                return Err(format!("{at}.columns takes 1 to {MAX_PROJECTION_COLUMNS} entries"));
            }
            let mut names = BTreeSet::new();
            for (i, c) in columns.iter().enumerate() {
                let at = format!("{at}.columns[{i}]");
                check_text(&format!("{at}.path"), &c.path, MAX_PATH_CHARS)?;
                if let Some(n) = &c.name {
                    check_text(&format!("{at}.name"), n, MAX_NAME_CHARS)?;
                }
                if matches!(
                    c.field_type,
                    Some(
                        crate::shapes::FieldType::Json
                            | crate::shapes::FieldType::Decimal
                            | crate::shapes::FieldType::Date
                    )
                ) {
                    return Err(format!("{at}.type must be string, number, int64, bool or time"));
                }
                if !names.insert(c.output_name()) {
                    return Err(format!("{at}: a column is already named {}", c.output_name()));
                }
            }
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

    /// Numbers agree exactly; a case marked `"ulp": true` (exp, ln, log10, pow, whose platform
    /// libraries may round the last bit differently) within one unit in the last place.
    fn close(a: &Value, b: &Value, ulp: bool) -> bool {
        match (a.as_f64(), b.as_f64()) {
            (Some(x), Some(y)) if a.is_number() && b.is_number() => {
                x == y || (ulp && x.signum() == y.signum() && x.to_bits().abs_diff(y.to_bits()) <= 1)
            }
            _ => a == b,
        }
    }

    fn same_values(got: &[Value], want: &Value, ulp: bool) -> bool {
        let want = want.as_array().unwrap();
        got.len() == want.len() && got.iter().zip(want).all(|(g, w)| close(g, w, ulp))
    }

    /// The cases both engines share (`conformance.json`); the UI runs them in
    /// `ui/src/analysis/conformance.test.ts`.
    #[test]
    fn conformance_cases() {
        use crate::shapes::{Field, Frame};
        let cases: Value = serde_json::from_str(include_str!("conformance.json")).unwrap();
        let frame = |name: &str| -> Frame {
            let fields: Vec<Field> = serde_json::from_value(cases["frames"][name].clone()).unwrap();
            Frame::new(fields).unwrap()
        };
        for case in cases["expressions"].as_array().unwrap() {
            let text = case["expression"].as_str().unwrap();
            let f = frame(case["frame"].as_str().unwrap());
            let ulp = case.get("ulp").and_then(Value::as_bool).unwrap_or(false);
            let calendar = case.get("calendar").map_or_else(expr::Calendar::default, |c| {
                let zone = c.get("timeZone").map(|z| z.as_str().unwrap().parse::<chrono_tz::Tz>().unwrap());
                let week_start = c.get("weekStart").map_or(crate::dashboards::model::WeekStart::Monday, |w| {
                    serde_json::from_value(w.clone()).unwrap()
                });
                expr::Calendar::new(zone, week_start)
            });
            let outcome = expr::parse(text).and_then(|e| expr::compile_in(&e, f.fields(), calendar)).and_then(|c| {
                let cells: Result<Vec<Value>, _> = (0..f.rows()).map(|row| c.cell(f.fields(), row)).collect();
                Ok((c.result, cells?))
            });
            match (outcome, case.get("error")) {
                (Ok((result, got)), None) => {
                    assert!(same_values(&got, &case["values"], ulp), "{text}: {got:?}");
                    let t = serde_json::to_value(result.field_type()).unwrap();
                    assert_eq!(t, case["type"], "{text}");
                }
                (Err(e), Some(want)) => {
                    assert_eq!(e.reason, want["reason"].as_str().unwrap(), "{text}");
                    assert_eq!(serde_json::to_value(&e.params).unwrap(), want["params"], "{text}");
                }
                (got, _) => panic!("{text}: {got:?}"),
            }
        }
        for case in cases["steps"].as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            let inputs: Vec<(String, steps::Input)> = case["frames"]
                .as_object()
                .unwrap()
                .iter()
                .map(|(n, source)| {
                    let source = source.as_str().unwrap();
                    let input = match (cases["documents"].get(source), cases["graphs"].get(source)) {
                        (Some(set), _) => steps::Input::Documents(serde_json::from_value(set.clone()).unwrap()),
                        (_, Some(graph)) => steps::Input::Graph(serde_json::from_value(graph.clone()).unwrap()),
                        _ => steps::Input::Frame(frame(source)),
                    };
                    (n.clone(), input)
                })
                .collect();
            let list: Vec<Step> = case["steps"].as_array().unwrap().iter().map(|s| parse_step(s).unwrap()).collect();
            let ran = steps::run_shapes(&list, inputs, &steps::Control::unbounded(), &BTreeSet::new());
            match (ran, case.get("error")) {
                (Ok((out, graphs)), None) => {
                    for (graph_name, want) in case.get("expectGraphs").and_then(Value::as_object).into_iter().flatten() {
                        let got = &graphs.iter().find(|(n, _)| n == graph_name).unwrap().1;
                        let ids = |v: Vec<&str>| json!(v);
                        assert_eq!(ids(got.nodes.iter().map(|n| n.id.as_str()).collect()), want["nodes"], "{name}");
                        assert_eq!(ids(got.edges.iter().map(|e| e.id.as_str()).collect()), want["edges"], "{name}");
                        assert_eq!(serde_json::to_value(&got.schema).unwrap(), want["schema"], "{name}");
                    }
                    if let Some(order) = case.get("outputOrder") {
                        let got: Vec<&str> = out.iter().map(|f| f.name.as_str()).collect();
                        assert_eq!(json!(got), *order, "{name}");
                    }
                    for (frame_name, want) in case.get("expect").and_then(Value::as_object).into_iter().flatten() {
                        let got = &out.iter().find(|f| &f.name == frame_name).unwrap().frame;
                        if let Some(names) = want.get("names") {
                            let got_names: Vec<&str> = got.fields().iter().map(|f| f.name.as_str()).collect();
                            assert_eq!(json!(got_names), *names, "{name}");
                        }
                        for field in want["fields"].as_array().unwrap() {
                            let f = got.fields().iter().find(|f| f.name == field["name"]).unwrap();
                            assert_eq!(serde_json::to_value(f.field_type).unwrap(), field["type"], "{name}");
                            assert!(
                                same_values(&f.values, &field["values"], false),
                                "{name} {}: {:?}",
                                f.name,
                                f.values
                            );
                        }
                    }
                    for gone in case.get("gone").and_then(Value::as_array).into_iter().flatten() {
                        assert!(!out.iter().any(|f| f.name == gone.as_str().unwrap()), "{name}");
                    }
                }
                (Err(failure), Some(want)) => {
                    assert_eq!(failure.index as u64, want["index"].as_u64().unwrap(), "{name}");
                    assert_eq!(failure.detail.reason, want["reason"].as_str().unwrap(), "{name}");
                    assert_eq!(serde_json::to_value(&failure.detail.params).unwrap(), want["params"], "{name}");
                }
                (got, _) => panic!("{name}: {got:?}"),
            }
        }
    }

    /// The projection step: `{"id", "type": "toFrame", "frame", "columns": [{path, name?, type?}]}`.
    #[test]
    fn projections_are_bounded() {
        let steps = check(json!([
            { "id": "p", "type": "toFrame", "frame": "A", "columns": [
                { "path": "at" }, { "path": "items.0.price", "name": "Preis", "type": "number" }
            ] },
            { "id": "c", "type": "calculate", "frame": "A", "name": "x", "expression": "Preis * 2" }
        ]))
        .unwrap();
        let StepKind::ToFrame { frame, columns, .. } = &steps[0].kind else { panic!() };
        assert_eq!((frame.as_str(), columns.len()), ("A", 2));
        assert_eq!(columns[1].field_type, Some(crate::shapes::FieldType::Number));
        let one = |columns: Value| json!([{ "id": "p", "type": "toFrame", "frame": "A", "columns": columns }]);
        for (bad, expect) in [
            (
                json!([{ "id": "p", "type": "toFrame", "frame": "C", "columns": [{ "path": "a" }] }]),
                "there is no query C",
            ),
            (json!([{ "type": "toFrame", "frame": "A", "columns": [{ "path": "a" }] }]), "id must be text"),
            (json!([{ "id": "p", "type": "toFrame", "refId": "A", "columns": [{ "path": "a" }] }]), "unknown field"),
            (one(json!([])), "columns takes 1 to 200"),
            (one(json!(vec![json!({ "path": "a" }); 201])), "columns takes 1 to 200"),
            (one(json!([{ "path": "" }])), "columns[0].path needs 1 to 500"),
            (one(json!([{ "path": "x".repeat(501) }])), "columns[0].path needs 1 to 500"),
            (one(json!([{ "path": "a", "colour": 1 }])), "unknown field"),
            (one(json!([{ "path": "a", "type": "decimal" }])), "columns[0].type must be"),
            (one(json!([{ "path": "a", "type": "date" }])), "columns[0].type must be"),
            (one(json!([{ "path": "a", "type": "money" }])), "unknown variant"),
            (one(json!([{ "path": "a", "type": "json" }])), "columns[0].type must be"),
            (one(json!([{ "path": "a", "name": "" }])), "columns[0].name"),
            (one(json!([{ "path": "a", "name": "a\nb" }])), "columns[0].name"),
            (one(json!([{ "path": "a" }, { "path": "b", "name": "a" }])), "columns[1]: a column is already named a"),
        ] {
            let err = check(bad.clone()).unwrap_err();
            assert!(err.contains(expect), "{bad}: {err}");
        }
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
        assert_eq!(
            steps[1].kind,
            StepKind::Join { left: "A".into(), right: "B".into(), on: JoinOn::Time, mode: JoinMode::Outer }
        );
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
            (
                json!([{ "id": "j", "type": "join", "left": "A", "right": "A", "on": { "by": "time" }, "mode": "left" }]),
                "with itself",
            ),
            (
                json!([{ "id": "j", "type": "join", "left": "A", "right": "B", "on": { "by": "key" }, "mode": "left" }]),
                "missing field",
            ),
            (
                json!([{ "id": "r", "type": "reduce", "frame": "A", "fields": [], "stats": ["sum"] }]),
                "fields takes 1 to 50",
            ),
            (
                json!([{ "id": "r", "type": "reduce", "frame": "A", "fields": ["a"], "stats": ["sum", "sum"] }]),
                "each once",
            ),
            (
                json!([{ "id": "r", "type": "reduce", "frame": "A", "fields": ["a"], "stats": ["percentile"] }]),
                "percentiles",
            ),
            (
                json!([{ "id": "r", "type": "reduce", "frame": "A", "fields": ["a"], "stats": ["sum"], "percentiles": [5] }]),
                "none without",
            ),
            (
                json!([{ "id": "r", "type": "reduce", "frame": "A", "fields": ["a"], "stats": ["percentile"], "percentiles": [101] }]),
                "0 to 100",
            ),
            (
                json!([{ "id": "r", "type": "reduce", "frame": "A", "fields": ["a"], "stats": ["percentile"], "percentiles": [5, 5.0] }]),
                "distinct",
            ),
            (
                json!([{ "id": "t", "type": "trend", "frame": "A", "field": "a", "output": "fitted" }]),
                "name is required",
            ),
            (
                json!([{ "id": "t", "type": "trend", "frame": "A", "field": "a", "output": "summary", "name": "n" }]),
                "only to the fitted",
            ),
            (
                json!([{ "id": "m", "type": "movingAverage", "frame": "A", "field": "a", "window": 0, "name": "n" }]),
                "window",
            ),
            (
                json!([{ "id": "m", "type": "movingAverage", "frame": "A", "field": "a", "window": 10001, "name": "n" }]),
                "window",
            ),
            (
                json!([{ "id": "m", "type": "movingAverage", "frame": "A", "field": "a", "window": -1, "name": "n" }]),
                "invalid value",
            ),
            (json!([{ "id": "g", "type": "group", "frame": "A", "by": [], "aggregations": [] }]), "by takes 1 to 10"),
            (
                json!([{ "id": "g", "type": "group", "frame": "A", "by": ["a"], "aggregations": [{ "field": "b", "op": "avg" }] }]),
                "unknown variant",
            ),
        ] {
            let err = check(steps.clone()).unwrap_err();
            assert!(err.contains(expect), "{steps}: {err}");
        }
        let many: Vec<Value> = (0..=MAX_STEPS)
            .map(
                |i| json!({ "id": format!("s{i}"), "type": "calculate", "frame": "A", "name": "x", "expression": "1" }),
            )
            .collect();
        assert!(check(json!(many)).unwrap_err().contains("at most 50"));
    }
}
