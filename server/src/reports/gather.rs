//! What a report shows: the chosen panels of the dashboard in its order, each with the results of
//! its stored queries after its analysis steps, run with the rights of `ctx` (the report's owner
//! at a run, the editing person in a preview). Every result keeps its shape (`frame`,
//! `documents`, `graph`); nothing is converted here. A panel that cannot show anything keeps the
//! reason, and the renderers put it where the panel would be.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;
use std::sync::atomic::AtomicBool;

use chrono_tz::Tz;
use serde_json::Value;

use super::range;
use crate::analysis::steps::{self, Control, Input, NamedFrame};
use crate::app::AppState;
use crate::authz::OrgCtx;
use crate::dashboards::model::{DashboardModel, Panel, VariableType};
use crate::error::{ApiError, ApiResult};
use crate::routes::query::{
    AllRights, check_variables, expand_all, panel_uses, readable_model, resolve_variables, stored_items, without_all,
};
use crate::shapes::{DocumentSet, FieldType, GraphSet, QueryOutcome, QueryResult, TimeRange, TraceSet};

/// Data points per series the queries are asked for: about one per point of a chart's width.
const MAX_DATA_POINTS: u32 = 1000;
/// Panels whose queries run at once.
const PANELS_AT_ONCE: usize = 4;
/// The steps' time limit when the setting cannot be read.
const DEFAULT_TIMEOUT_SECS: u64 = 30;

/// What one report holds.
pub struct Gathered {
    pub dashboard_title: String,
    pub range: TimeRange,
    pub zone: Tz,
    /// The variable values the queries ran with, for the cover.
    pub variables: BTreeMap<String, Value>,
    pub panels: Vec<PanelOut>,
}

pub struct PanelOut {
    pub id: String,
    pub title: String,
    /// The panel type (`timeseries`, `table`, `documents`, ...).
    pub kind: String,
    /// The panel's options (a stat's reducer, ...).
    pub options: Value,
    /// The unit values are shown with: the panel's `unit` option or its field default.
    pub unit: Option<String>,
    pub content: Content,
}

/// The results of one panel after its steps, each in its own shape, by reference id.
#[derive(Default)]
pub struct Results {
    pub frames: Vec<NamedFrame>,
    pub documents: Vec<(String, DocumentSet)>,
    pub graphs: Vec<(String, GraphSet)>,
    /// Traces no step made a table or graph of; drawn as a waterfall, never a CSV file.
    pub traces: Vec<(String, TraceSet)>,
    /// Counts before the results were cut to what a PDF draws (`trim`), by reference id:
    /// rows or documents, `<refId>#nodes` and `<refId>#edges` of graphs, `<refId>#spans` of traces.
    pub totals: BTreeMap<String, usize>,
    /// Stat values were reduced already: each numeric field holds its one value.
    pub reduced: bool,
}

pub enum Content {
    Results(Results),
    /// A text panel's text.
    Text(String),
    /// Why the panel shows nothing: a stable code and an English message.
    Unavailable {
        code: String,
        message: String,
    },
}

fn unavailable(code: impl Into<String>, message: impl Into<String>) -> Content {
    Content::Unavailable { code: code.into(), message: message.into() }
}

/// What a report asks for.
pub struct Spec<'a> {
    pub dashboard_id: &'a str,
    pub panel_ids: Option<&'a [String]>,
    pub time_range: Option<(&'a str, &'a str)>,
    pub variables: &'a BTreeMap<String, Value>,
    pub zone: Tz,
}

/// The panels in the order the dashboard shows them: those outside rows from top to bottom and
/// left to right, then each row's panels in the order of the rows.
pub fn ordered(model: &DashboardModel) -> Vec<&Panel> {
    let mut out: Vec<&Panel> = model.panels.iter().filter(|p| p.row_id.is_none()).collect();
    out.sort_by_key(|p| (p.grid.y, p.grid.x));
    for row in &model.rows {
        let mut inside: Vec<&Panel> = model.panels.iter().filter(|p| p.row_id.as_deref() == Some(&row.id)).collect();
        inside.sort_by_key(|p| (p.grid.y, p.grid.x));
        out.extend(inside);
    }
    // Panels of a row that no longer exists, at the end.
    let rows: BTreeSet<&str> = model.rows.iter().map(|r| r.id.as_str()).collect();
    out.extend(model.panels.iter().filter(|p| p.row_id.as_deref().is_some_and(|r| !rows.contains(r))));
    out
}

/// The report's values, and for the variables it leaves open the dashboard's saved ones. Saved
/// values the dashboard would no longer accept are left out, the report's own never. An "All"
/// (`$__all`) stays as it is: each run fills it in with the creator's rights (`gather`).
pub fn variables(model: &DashboardModel, fixed: &BTreeMap<String, Value>) -> ApiResult<BTreeMap<String, Value>> {
    check_variables(fixed)?;
    resolve_variables(model, &without_all(model, fixed))?;
    let mut merged = fixed.clone();
    for v in &model.variables {
        if v.kind == VariableType::Constant || merged.contains_key(&v.name) {
            continue;
        }
        if let Some(value) = crate::dashboards::variables::saved_value(v) {
            let mut tried = merged.clone();
            tried.insert(v.name.clone(), value);
            if resolve_variables(model, &without_all(model, &tried)).is_ok() {
                merged = tried;
            }
        }
    }
    Ok(merged)
}

/// The report's range at `now`: its own, else the dashboard's.
pub fn report_range(model: &DashboardModel, spec: &Spec<'_>, now: i64) -> ApiResult<TimeRange> {
    let (from, to) = spec.time_range.unwrap_or((&model.time_range.from, &model.time_range.to));
    range::resolve_range(from, to, now, spec.zone)
        .map_err(|e| ApiError::validation(e.message).with_field("timeRange").because(e.reason))
}

/// Runs the report's panels as `ctx` and keeps what they show. Only the dashboard's stored
/// queries run; the dashboard must be readable by `ctx` (else `not_found`).
pub async fn gather(state: &AppState, ctx: &OrgCtx, spec: &Spec<'_>, now: i64, budget: &Budget) -> ApiResult<Gathered> {
    let model = readable_model(state, ctx, spec.dashboard_id).await?;
    let variables = variables(&model, spec.variables)?;
    let range = report_range(&model, spec, now)?;
    let timeout = crate::settings::get(state, "datasources.query_timeout_secs")
        .await
        .ok()
        .and_then(|v| v.as_u64())
        .unwrap_or(DEFAULT_TIMEOUT_SECS);
    let model = &model;
    let all = ordered(model);
    let mut chosen: Vec<Result<&Panel, String>> = match spec.panel_ids {
        None => all.iter().copied().map(Ok).collect(),
        Some(ids) => ids.iter().map(|id| all.iter().find(|p| &p.id == id).copied().ok_or_else(|| id.clone())).collect(),
    };
    // In the dashboard's order whatever order the report names them in; removed panels at the end.
    chosen.sort_by_key(|p| match p {
        Ok(p) => all.iter().position(|o| o.id == p.id).unwrap_or(usize::MAX),
        Err(_) => usize::MAX,
    });
    // A few panels at a time, in order.
    let mut outs: Vec<PanelOut> = Vec::with_capacity(chosen.len());
    let mut used: u64 = 0;
    for batch in chosen.chunks(PANELS_AT_ONCE) {
        let runs = batch
            .iter()
            .map(|panel| panel_or_gap(state, ctx, model, panel, &variables, range, spec.zone, now, timeout));
        for mut out in futures_util::future::join_all(runs).await {
            if budget.pdf_only {
                trim(&mut out);
            }
            used = used.saturating_add(size_of(&out));
            if used > budget.max_bytes {
                return Err(too_large(budget.max_bytes));
            }
            outs.push(out);
        }
    }
    Ok(Gathered { dashboard_title: model.title.clone(), range, zone: spec.zone, variables, panels: outs })
}

#[expect(clippy::too_many_arguments, reason = "the parts of one panel's run, passed through")]
async fn panel_or_gap(
    state: &AppState,
    ctx: &OrgCtx,
    model: &DashboardModel,
    panel: &Result<&Panel, String>,
    variables: &BTreeMap<String, Value>,
    range: TimeRange,
    zone: Tz,
    now: i64,
    timeout: u64,
) -> PanelOut {
    match panel {
        Err(id) => PanelOut {
            id: id.clone(),
            title: String::new(),
            kind: String::new(),
            options: Value::Null,
            unit: None,
            content: unavailable("reports.panel_removed", "this panel is no longer on the dashboard"),
        },
        Ok(panel) => panel_out(state, ctx, model, panel, variables, range, zone, now, timeout).await,
    }
}

#[expect(clippy::too_many_arguments, reason = "the parts of one panel's run, passed through")]
async fn panel_out(
    state: &AppState,
    ctx: &OrgCtx,
    model: &DashboardModel,
    panel: &Panel,
    variables: &BTreeMap<String, Value>,
    range: TimeRange,
    zone: Tz,
    now: i64,
    timeout: u64,
) -> PanelOut {
    // A linked library panel or saved analysis brings its queries and steps, which the dashboard
    // authorizes like its own (as `query::panel_query`).
    let linked = match crate::dashboards::linked_content(&state.db, &ctx.org_id, panel).await {
        Ok(linked) => linked,
        Err(e) => {
            return PanelOut {
                id: panel.id.clone(),
                title: panel.title.clone(),
                kind: panel.kind.clone(),
                options: Value::Null,
                unit: None,
                content: unavailable("reports.panel_link_missing", e.message),
            };
        }
    };
    let shown = linked.as_ref().unwrap_or(panel);
    let title = if panel.title.trim().is_empty() { shown.title.clone() } else { panel.title.clone() };
    let content = content_of(state, ctx, model, shown, variables, range, zone, now, timeout).await;
    let unit = shown
        .options
        .get("unit")
        .or_else(|| shown.field_config.pointer("/defaults/unit"))
        .and_then(Value::as_str)
        .filter(|u| !u.is_empty())
        .map(str::to_string);
    PanelOut { id: panel.id.clone(), title, kind: shown.kind.clone(), options: shown.options.clone(), unit, content }
}

#[expect(clippy::too_many_arguments, reason = "the parts of one panel's run, passed through")]
async fn content_of(
    state: &AppState,
    ctx: &OrgCtx,
    model: &DashboardModel,
    panel: &Panel,
    variables: &BTreeMap<String, Value>,
    range: TimeRange,
    zone: Tz,
    now: i64,
    timeout: u64,
) -> Content {
    if panel.kind == "text" {
        let text = panel.options.get("content").and_then(Value::as_str).unwrap_or_default();
        return Content::Text(text.to_string());
    }
    // The panel's own range: relative to now, then moved back.
    let mut range = range;
    if let Some(from) = panel.time_from.as_deref() {
        match range::resolve(from, now, zone, false) {
            Ok(start) => range = TimeRange { from: start, to: now },
            Err(e) => return unavailable(e.reason, e.message),
        }
    }
    if let Some(by) = panel.time_shift.as_deref() {
        match range::shift(range, by, zone) {
            Ok(shifted) => range = shifted,
            Err(e) => return unavailable(e.reason, e.message),
        }
    }
    // An "All" the panel uses is filled in as the creator, over the panel's range; failing, the
    // panel says why instead of running with an empty list.
    let variables = match expand_all(state, ctx, model, variables, range, &panel_uses(panel), AllRights::Query).await {
        Ok(variables) => variables,
        Err(e) => return unavailable(reason_of(&e).to_string(), e.message),
    };
    let run = match stored_items(state, ctx, model, panel, &variables, None, &BTreeMap::new()).await {
        Ok(run) => run,
        Err(e) => return unavailable(reason_of(&e).to_string(), e.message),
    };
    if run.items.is_empty() {
        return unavailable("reports.panel_no_queries", "this panel has no query to run");
    }
    if let Err(e) = crate::datasources::check_items(&run.items) {
        return unavailable(reason_of(&e).to_string(), e.message);
    }
    let refs: BTreeSet<&str> = panel.targets.iter().map(|t| t.ref_id.as_str()).collect();
    let steps = match crate::analysis::check_steps(&panel.transformations, &refs, "transformations") {
        Ok(steps) => steps,
        Err(e) => return unavailable("steps.invalid", e),
    };
    let order: Vec<String> = run.items.iter().map(|i| i.ref_id.clone()).collect();
    let mut response = crate::datasources::run_queries_with(
        state,
        ctx,
        run.items,
        range,
        None,
        Some(MAX_DATA_POINTS),
        &run.variables,
        Some(&run.identifiers),
    )
    .await;
    let mut inputs = Vec::new();
    let mut done = BTreeSet::new();
    for ref_id in &order {
        match response.results.remove(ref_id) {
            Some(QueryOutcome::Ok { result, steps: ran, .. }) => {
                done.extend(ran.into_iter().flatten().filter(|p| p.error.is_none()).map(|p| p.id));
                let input = match result {
                    QueryResult::Frame { frame } => Input::Frame(frame),
                    QueryResult::Documents { documents } => Input::Documents(documents),
                    QueryResult::Graph { graph } => Input::Graph(graph),
                    QueryResult::Trace { trace } => Input::Trace(trace),
                };
                inputs.push((ref_id.clone(), input));
            }
            Some(QueryOutcome::Err { error }) => {
                let code = error.reason.clone().unwrap_or_else(|| error.code.clone());
                return unavailable(code, format!("query {ref_id}: {}", error.message));
            }
            None => return unavailable("reports.query_missing", format!("query {ref_id} gave no answer")),
        }
    }
    let control = Control::new(Arc::new(AtomicBool::new(false)), timeout);
    let ran = tokio::task::spawn_blocking(move || steps::run_outputs(&steps, inputs, &control, &done)).await;
    match ran {
        Ok(Ok(out)) => Content::Results(Results {
            frames: out.frames,
            documents: out.documents,
            graphs: out.graphs,
            traces: out.traces,
            ..Default::default()
        }),
        Ok(Err(failure)) => {
            unavailable(failure.detail.reason, format!("step {}: {}", failure.index + 1, failure.detail.message))
        }
        Err(e) => unavailable("reports.internal", format!("the steps stopped: {e}")),
    }
}

fn reason_of(e: &ApiError) -> &str {
    e.reason.as_ref().map_or(e.code, |r| r.code.as_str())
}

/// How much of the panels' results one report may hold while it is made: a multiple of the
/// largest mail (`reports.max_attachment_bytes`), since files are smaller than the results they
/// come from (compressed, cut to what a PDF draws). A report that needs more fails with
/// `reports.results_too_large` instead of holding the server's memory.
pub struct Budget {
    pub max_bytes: u64,
    /// Only a PDF is made: every result is cut to what it draws right after its panel ran.
    pub pdf_only: bool,
}

/// Results per byte of mail a report may hold.
pub const RESULTS_PER_MAIL_BYTE: u64 = 8;

impl Budget {
    pub fn new(max_attachment_bytes: u64, pdf_only: bool) -> Self {
        Self { max_bytes: max_attachment_bytes.saturating_mul(RESULTS_PER_MAIL_BYTE), pdf_only }
    }
}

fn too_large(max: u64) -> ApiError {
    ApiError::new(
        axum::http::StatusCode::PAYLOAD_TOO_LARGE,
        "payload_too_large",
        format!(
            "the panels' results exceed the {max} bytes a report may hold; pick fewer panels or a shorter time range"
        ),
    )
    .because("reports.results_too_large")
    .param("max", max)
}

/// About the bytes a value takes.
fn value_size(v: &Value) -> u64 {
    match v {
        Value::Null | Value::Bool(_) => 5,
        Value::Number(_) => 12,
        Value::String(s) => s.len() as u64 + 2,
        other => other.to_string().len() as u64,
    }
}

/// About the bytes a panel's results take.
pub fn size_of(out: &PanelOut) -> u64 {
    match &out.content {
        Content::Results(r) => {
            let frames: u64 =
                r.frames.iter().flat_map(|f| f.frame.fields()).flat_map(|f| f.values.iter().map(value_size)).sum();
            let documents: u64 =
                r.documents.iter().flat_map(|(_, d)| d.documents.iter().map(|doc| doc.get().len() as u64)).sum();
            let graphs: u64 = r.graphs.iter().map(|(_, g)| serde_json::to_vec(g).map_or(0, |b| b.len() as u64)).sum();
            let traces: u64 = r.traces.iter().map(|(_, t)| serde_json::to_vec(t).map_or(0, |b| b.len() as u64)).sum();
            frames + documents + graphs + traces
        }
        Content::Text(t) => t.len() as u64,
        Content::Unavailable { message, .. } => message.len() as u64,
    }
}

/// Frames as they are with only the rows `keep` names.
fn rows_of(frame: &crate::shapes::Frame, keep: &[usize]) -> crate::shapes::Frame {
    let fields = frame
        .fields()
        .iter()
        .map(|f| crate::shapes::Field {
            values: keep.iter().filter_map(|i| f.values.get(*i).cloned()).collect(),
            ..f.clone()
        })
        .collect();
    let cut = crate::shapes::Frame::new(fields).expect("every field keeps the same rows");
    match frame.meta() {
        Some(meta) => cut.with_meta(meta.clone()),
        None => cut,
    }
}

/// Cuts a panel's results to what its PDF card draws, keeping the counts for its notes.
pub fn trim(out: &mut PanelOut) {
    use super::pdf::{
        MAX_BARS, MAX_DOCUMENTS, MAX_GRAPH_EDGES, MAX_GRAPH_NODES, MAX_POINTS, MAX_SPANS, MAX_TABLE_ROWS,
    };
    let kind = out.kind.clone();
    let reducer = out.options.get("reducer").and_then(Value::as_str).unwrap_or("last").to_string();
    let Content::Results(r) = &mut out.content else { return };
    for f in &mut r.frames {
        let rows = f.frame.rows();
        r.totals.insert(f.name.clone(), rows);
        let keep: Vec<usize> = match kind.as_str() {
            "stat" | "gauge" | "bargauge" => {
                // The value the card shows, per numeric field, as one row.
                let fields = f
                    .frame
                    .fields()
                    .iter()
                    .filter(|x| matches!(x.field_type, FieldType::Number | FieldType::Int64 | FieldType::Decimal))
                    .map(|x| {
                        let values: Vec<f64> = x.values.iter().filter_map(crate::analysis::steps::number_at).collect();
                        let v = super::pdf::reduce(&values, &reducer);
                        crate::shapes::Field {
                            field_type: FieldType::Number,
                            values: vec![v.map_or(Value::Null, Value::from)],
                            ..x.clone()
                        }
                    })
                    .collect();
                if let Ok(frame) = crate::shapes::Frame::new(fields) {
                    f.frame = frame;
                    r.reduced = true;
                }
                continue;
            }
            "timeseries" if rows > MAX_POINTS => {
                let step = rows.div_ceil(MAX_POINTS);
                (0..rows).step_by(step).collect()
            }
            "timeseries" => continue,
            "bar" => (0..rows.min(MAX_BARS)).collect(),
            _ => (0..rows.min(MAX_TABLE_ROWS)).collect(),
        };
        if keep.len() < rows {
            f.frame = rows_of(&f.frame, &keep);
        }
    }
    for (name, set) in &mut r.documents {
        r.totals.insert(name.clone(), set.documents.len());
        set.documents.truncate(MAX_DOCUMENTS);
        set.schema.clear();
    }
    for (name, g) in &mut r.graphs {
        r.totals.insert(format!("{name}#nodes"), g.nodes.len());
        r.totals.insert(format!("{name}#edges"), g.edges.len());
        g.nodes.truncate(MAX_GRAPH_NODES);
        let kept: BTreeSet<&str> = g.nodes.iter().map(|n| n.id.as_str()).collect();
        let edges: Vec<crate::shapes::Edge> = g
            .edges
            .iter()
            .filter(|e| kept.contains(e.from.as_str()) && kept.contains(e.to.as_str()))
            .take(MAX_GRAPH_EDGES)
            .cloned()
            .collect();
        g.edges = edges;
        g.paths = None;
    }
    for (name, t) in &mut r.traces {
        r.totals.insert(format!("{name}#spans"), t.spans.len());
        t.spans.truncate(MAX_SPANS);
        // The waterfall shows names, times and status; attributes, events and links stay out.
        for s in &mut t.spans {
            s.attributes.clear();
            s.resource.clear();
            s.events.clear();
            s.links.clear();
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn model(value: Value) -> DashboardModel {
        crate::dashboards::model::parse(value).unwrap()
    }

    #[test]
    fn panels_follow_the_dashboard_and_its_rows() {
        let m = model(json!({
            "schemaVersion": 2, "title": "Lager", "timeRange": { "from": "now-6h", "to": "now" },
            "rows": [{ "id": "r1", "title": "Unten" }],
            "panels": [
                { "id": "in-row", "type": "text", "grid": { "x": 0, "y": 0, "w": 12, "h": 4 }, "rowId": "r1" },
                { "id": "right", "type": "text", "grid": { "x": 12, "y": 0, "w": 12, "h": 4 } },
                { "id": "left", "type": "text", "grid": { "x": 0, "y": 0, "w": 12, "h": 4 } },
                { "id": "below", "type": "text", "grid": { "x": 0, "y": 4, "w": 24, "h": 4 } }
            ]
        }));
        let ids: Vec<&str> = ordered(&m).iter().map(|p| p.id.as_str()).collect();
        assert_eq!(ids, ["left", "right", "below", "in-row"]);
    }

    #[test]
    fn open_variables_take_the_saved_value_fixed_ones_are_checked() {
        let m = model(json!({
            "schemaVersion": 2, "title": "Lager", "timeRange": { "from": "now-6h", "to": "now" },
            "variables": [
                { "name": "region", "type": "custom", "options": ["nord", "sued"], "current": { "value": "nord" } },
                { "name": "host", "type": "textbox", "current": "a" }
            ]
        }));
        let got = variables(&m, &BTreeMap::new()).unwrap();
        assert_eq!(got, BTreeMap::from([("region".into(), json!("nord")), ("host".into(), json!("a"))]));
        let fixed = BTreeMap::from([("region".to_string(), json!("sued"))]);
        assert_eq!(variables(&m, &fixed).unwrap()["region"], json!("sued"));
        let outside = BTreeMap::from([("region".to_string(), json!("west"))]);
        assert!(variables(&m, &outside).is_err());
        let unknown = BTreeMap::from([("nope".to_string(), json!("x"))]);
        assert!(variables(&m, &unknown).is_err());
    }

    /// "All" is kept as the marker, the report's own and a saved one: each run reads the values
    /// anew (`expand_all`) instead of a list frozen when the report was made.
    #[test]
    fn all_stays_the_marker_until_the_run() {
        let m = model(json!({
            "schemaVersion": 2, "title": "Lager", "timeRange": { "from": "now-6h", "to": "now" },
            "variables": [
                { "name": "job", "type": "query", "datasourceId": "ds", "query": { "sql": "SELECT 1" },
                  "multi": true, "includeAll": true, "current": "$__all" },
                { "name": "region", "type": "custom", "options": ["nord", "sued"], "multi": true, "includeAll": true },
                { "name": "host", "type": "custom", "options": ["a"] }
            ]
        }));
        assert_eq!(variables(&m, &BTreeMap::new()).unwrap()["job"], json!("$__all"));
        let fixed = BTreeMap::from([("region".to_string(), json!(["$__all"]))]);
        let got = variables(&m, &fixed).unwrap();
        assert_eq!((got["region"].clone(), got["job"].clone()), (json!(["$__all"]), json!("$__all")));
        // The marker of a variable that offers no "All" is still refused.
        let not_offered = BTreeMap::from([("host".to_string(), json!("$__all"))]);
        assert!(variables(&m, &not_offered).is_err());
    }
}
