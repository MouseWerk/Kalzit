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
use crate::routes::query::{check_variables, readable_model, resolve_variables, stored_items};
use crate::shapes::{DocumentSet, GraphSet, QueryOutcome, QueryResult, TimeRange};

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

/// The value a variable was saved with on the dashboard, if any.
fn saved_value(current: Option<&Value>) -> Option<Value> {
    let value = match current? {
        Value::Object(m) => m.get("value")?.clone(),
        other => other.clone(),
    };
    (!value.is_null()).then_some(value)
}

/// The report's values, and for the variables it leaves open the dashboard's saved ones. Saved
/// values the dashboard would no longer accept are left out, the report's own never.
pub fn variables(model: &DashboardModel, fixed: &BTreeMap<String, Value>) -> ApiResult<BTreeMap<String, Value>> {
    check_variables(fixed)?;
    resolve_variables(model, fixed)?;
    let mut merged = fixed.clone();
    for v in &model.variables {
        if v.kind == VariableType::Constant || merged.contains_key(&v.name) {
            continue;
        }
        if let Some(value) = saved_value(v.current.as_ref()) {
            let mut tried = merged.clone();
            tried.insert(v.name.clone(), value);
            if resolve_variables(model, &tried).is_ok() {
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
pub async fn gather(state: &AppState, ctx: &OrgCtx, spec: &Spec<'_>, now: i64) -> ApiResult<Gathered> {
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
    for batch in chosen.chunks(PANELS_AT_ONCE) {
        let runs = batch
            .iter()
            .map(|panel| panel_or_gap(state, ctx, model, panel, &variables, range, spec.zone, now, timeout));
        outs.extend(futures_util::future::join_all(runs).await);
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
    let run = match stored_items(model, panel, variables, None, &BTreeMap::new()) {
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
        Ok(Ok(out)) => Content::Results(Results { frames: out.frames, documents: out.documents, graphs: out.graphs }),
        Ok(Err(failure)) => {
            unavailable(failure.detail.reason, format!("step {}: {}", failure.index + 1, failure.detail.message))
        }
        Err(e) => unavailable("reports.internal", format!("the steps stopped: {e}")),
    }
}

fn reason_of(e: &ApiError) -> &str {
    e.reason.as_ref().map_or(e.code, |r| r.code.as_str())
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
}
