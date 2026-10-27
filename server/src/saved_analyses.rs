//! Saved analyses: the model of an Explore query saved under a name (its queries, analysis steps
//! and chosen visualization) and the checks a save goes through. The routes live in
//! `routes/analyses.rs`; docs/api/analyses.md describes the API.
//!
//! The model is JSON with its own `schemaVersion`, migrated on read one step per version like a
//! dashboard's (docs/ARCHITECTURE.md, "Dashboards"). Its queries, steps and visualization are
//! checked as one panel of a dashboard would be: an analysis that saves is one that a dashboard
//! panel can show, and "Add to dashboard" needs no second set of rules.
//!
//! A dashboard panel can link an analysis (`analysisId`, like a library panel's
//! `libraryPanelId`): the panel runs the analysis's current queries and steps with its own
//! visualization and title, and reading the dashboard authorizes running them. Whoever adds a link must be able to read the
//! analysis and query its sources (its queries count as the dashboard's own). An analysis that
//! dashboards link cannot go to the trash (`409`, reason `analysis.in_use`).

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::AnyPool;

use crate::authz::{self, OrgCtx, Permission, Resource};
use crate::dashboards::model::{self, DashboardModel, Target, TimeRange};
use crate::error::{ApiError, ApiResult};

/// The model version this server writes. Version 1 holds the steps in the form of dashboard model
/// version 2 (`dashboards::model::SCHEMA_VERSION`); a change there that touches panels, targets or
/// steps needs a step here too.
pub const SCHEMA_VERSION: u64 = 1;

/// `STEPS[i]` turns a model of schemaVersion `i + 1` into `i + 2`; each step has its own test.
const STEPS: &[model::Step] = &[];

/// The id of the one panel an analysis is checked and run as.
pub const PANEL_ID: &str = "analysis";

/// At least one query: an analysis without one shows nothing.
const MIN_TARGETS: usize = 1;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AnalysisModel {
    pub schema_version: u64,
    pub title: String,
    /// What the analysis answers, in a sentence or two.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// The range the analysis opens with; `null` (or left out) follows the time range in use
    /// where it is opened. A run always names its range.
    #[serde(default)]
    pub time_range: Option<TimeRange>,
    /// The queries, each in its data source's own form, read by the steps by `refId`.
    pub targets: Vec<Target>,
    /// Analysis steps (docs/api/settings-dashboards.md, "Analysis steps"), as a panel's
    /// `transformations`.
    #[serde(default)]
    pub steps: Vec<Value>,
    pub visualization: Visualization,
}

/// How the result is shown: a panel type with its options and field options.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Visualization {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default = "empty_object")]
    pub options: Value,
    #[serde(default = "empty_object")]
    pub field_config: Value,
}

fn empty_object() -> Value {
    Value::Object(Default::default())
}

impl AnalysisModel {
    /// The analysis as a dashboard with one panel (`PANEL_ID`), for the dashboard's checks and
    /// query routes.
    pub fn as_dashboard(&self) -> ApiResult<DashboardModel> {
        serde_json::from_value(self.dashboard_json()).map_err(|e| ApiError::internal("analyses", e))
    }

    /// The analysis as the one panel it is shown as, inside a dashboard (a linked panel) or alone.
    pub fn as_panel(&self) -> ApiResult<model::Panel> {
        self.as_dashboard()?
            .panels
            .into_iter()
            .next()
            .ok_or_else(|| ApiError::internal("analyses", "the analysis has no panel"))
    }

    fn dashboard_json(&self) -> Value {
        let mut panel = json!({
            "id": PANEL_ID,
            "type": self.visualization.kind,
            "title": "",
            "grid": { "x": 0, "y": 0, "w": model::GRID_COLUMNS, "h": 8 },
            "targets": self.targets,
            "transformations": self.steps,
            "options": self.visualization.options,
            "fieldConfig": self.visualization.field_config,
        });
        if let Some(description) = &self.description {
            panel["description"] = json!(description);
        }
        json!({
            "schemaVersion": model::SCHEMA_VERSION,
            "title": self.title,
            // Without a range of its own the checks need one; it is never stored or run.
            "timeRange": self.time_range.clone().unwrap_or(TimeRange { from: "now-6h".into(), to: "now".into() }),
            "panels": [panel],
        })
    }
}

/// Messages of the dashboard checks name the panel's place; this names the analysis's.
fn rename(message: String) -> String {
    message
        .replace("model.panels[0].transformations", "model.steps")
        .replace("model.panels[0].options", "model.visualization.options")
        .replace("model.panels[0].fieldConfig", "model.visualization.fieldConfig")
        .replace("model.panels[0].type", "model.visualization.type")
        .replace("model.panels[0]", "model")
}

pub fn migrate(raw: Value) -> Result<Value, String> {
    model::migrate_with(raw, STEPS, SCHEMA_VERSION)
}

/// Migrates a stored or submitted model to `SCHEMA_VERSION`, parses it and checks it as a
/// dashboard panel (size, title, time range, queries, steps). Visualization options are left to
/// `check_visualization`, which writes run on top.
pub fn parse(raw: Value) -> Result<AnalysisModel, String> {
    let current = migrate(raw)?;
    let analysis: AnalysisModel = serde_json::from_value(current).map_err(|e| format!("model: {e}"))?;
    if analysis.schema_version != SCHEMA_VERSION {
        return Err(format!("model.schemaVersion must be {SCHEMA_VERSION}"));
    }
    if analysis.targets.len() < MIN_TARGETS {
        return Err("model.targets needs at least one query".into());
    }
    model::parse(analysis.dashboard_json()).map_err(rename)?;
    Ok(analysis)
}

/// Checks the visualization's options and field options, unless they are the same as in
/// `previous` (the stored model): a stored analysis that predates a rule can still be saved while
/// its visualization is left as it is, as with dashboards.
pub fn check_visualization(analysis: &AnalysisModel, previous: Option<&AnalysisModel>) -> ApiResult<()> {
    let model = analysis.as_dashboard()?;
    let previous = previous.map(AnalysisModel::as_dashboard).transpose()?;
    // The reason of a dashboard panel's options, named after the analysis.
    model::check_panel_options(&model, previous.as_ref()).map_err(|(_, detail)| {
        let detail = rename(detail);
        ApiError::validation(detail.clone())
            .with_field("model")
            .because("dashboards.panel_options")
            .param("panel", &analysis.title)
            .param("detail", detail)
    })
}

/// Saving needs the right to query every data source the new or changed queries use, exactly as
/// for a dashboard's stored queries (`dashboards::check_dashboard_sources`): whoever may read the
/// analysis runs them later without that right of their own.
pub async fn check_sources(
    db: &AnyPool,
    ctx: &OrgCtx,
    analysis: &AnalysisModel,
    previous: Option<&AnalysisModel>,
) -> ApiResult<()> {
    let previous = previous.map(AnalysisModel::as_dashboard).transpose()?;
    crate::dashboards::check_dashboard_sources(db, ctx, &analysis.as_dashboard()?, previous.as_ref()).await
}

/// An analysis as a dashboard that links it reads it: enough to draw and run the panel.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkedAnalysis {
    pub id: String,
    pub title: String,
    pub version: i64,
    pub model: Value,
}

/// What links need of a stored analysis.
#[derive(Clone, Debug, sqlx::FromRow)]
struct LinkRow {
    id: String,
    folder_id: Option<String>,
    title: String,
    body: String,
    version: i64,
    deleted_at: Option<i64>,
    team_only: i64,
}

async fn fetch_link<'e, E: sqlx::Executor<'e, Database = sqlx::Any>>(
    db: E,
    org_id: &str,
    id: &str,
) -> ApiResult<Option<LinkRow>> {
    Ok(sqlx::query_as(
        "SELECT id, folder_id, title, body, version, deleted_at, team_only FROM analyses WHERE org_id = $1 AND id = $2",
    )
    .bind(org_id)
    .bind(id)
    .fetch_optional(db)
    .await?)
}

/// A stored model, migrated and parsed. A model this server cannot read is an operator problem.
pub fn stored(raw: &str) -> ApiResult<AnalysisModel> {
    let value: Value = serde_json::from_str(raw).map_err(|e| ApiError::internal("analyses", e))?;
    parse(value).map_err(|e| ApiError::internal("analyses", e))
}

/// The panel a dashboard's linked slot shows: the analysis's queries, steps and visualization in
/// the slot's place. Reading the dashboard is what authorizes it, as for a library panel; the
/// caller checked that. A purged analysis is `not_found` (a slot left pointing at it shows that).
pub async fn linked_panel(db: &AnyPool, org_id: &str, slot: &model::Panel) -> ApiResult<model::Panel> {
    let id = slot.analysis_id.as_deref().ok_or_else(ApiError::not_found)?;
    let row = fetch_link(db, org_id, id).await?.ok_or_else(ApiError::not_found)?;
    let mut panel = stored(&row.body)?.as_panel()?;
    panel.id = slot.id.clone();
    panel.grid = slot.grid;
    panel.title = slot.title.clone();
    Ok(panel)
}

/// The analyses `ids` names that exist in the organization, for a dashboard's answer. Reading the
/// dashboard is what shows them, as it runs the dashboard's stored queries: a viewer need not see
/// the analysis's folder.
pub async fn linked_analyses(
    conn: &mut sqlx::AnyConnection,
    org_id: &str,
    ids: &BTreeSet<&str>,
) -> ApiResult<BTreeMap<String, LinkedAnalysis>> {
    let mut out = BTreeMap::new();
    for id in ids {
        let Some(row) = fetch_link(&mut *conn, org_id, id).await? else { continue };
        // One unreadable analysis leaves its slot empty instead of the whole dashboard failing.
        let model = match stored(&row.body)
            .and_then(|m| serde_json::to_value(m).map_err(|e| ApiError::internal("analyses", e)))
        {
            Ok(model) => model,
            Err(e) => {
                tracing::warn!("analysis {id} cannot be read, its slots stay empty: {}", e.message);
                continue;
            }
        };
        out.insert(row.id.clone(), LinkedAnalysis { id: row.id, title: row.title, version: row.version, model });
    }
    Ok(out)
}

/// The stored queries of the analyses a dashboard links, as (data source, query text); they count
/// as the dashboard's own (`dashboards::check_dashboard_sources`). A missing or unreadable one has
/// none; the reference check reports a missing one.
pub async fn linked_queries(db: &AnyPool, org_id: &str, ids: &BTreeSet<&str>) -> ApiResult<BTreeSet<(String, String)>> {
    let mut out = BTreeSet::new();
    for id in ids {
        let Some(row) = fetch_link(db, org_id, id).await? else { continue };
        match stored(&row.body) {
            // The graph steps run with their query in the data source, so they are part of it.
            Ok(m) => out.extend(m.targets.into_iter().map(|t| {
                let steps = crate::routes::query::graph_steps_of(&m.steps, &t.ref_id);
                (t.datasource_id, serde_json::json!([t.query, steps]).to_string())
            })),
            Err(e) => tracing::warn!("analysis {id} cannot be read, its queries are left out: {}", e.message),
        }
    }
    Ok(out)
}

fn missing(id: &str) -> ApiError {
    ApiError::validation(format!("analysis {id} does not exist")).with_field("model")
}

/// Every analysis the dashboard links and `previous` (the stored version) did not must exist in
/// the organization, be outside the trash and be readable by the caller (`analyses:read`); one
/// they cannot see is `422 validation` on `model`, as if it did not exist.
pub async fn check_references(
    db: &AnyPool,
    ctx: &OrgCtx,
    dashboard: &DashboardModel,
    previous: Option<&DashboardModel>,
) -> ApiResult<()> {
    let known = previous.map(DashboardModel::analysis_ids).unwrap_or_default();
    for id in dashboard.analysis_ids().difference(&known) {
        let row = fetch_link(db, &ctx.org_id, id).await?.ok_or_else(|| missing(id))?;
        if row.deleted_at.is_some() {
            return Err(missing(id));
        }
        match authz::check_resource(db, ctx, Permission::AnalysesRead, Resource::Analysis(id)).await {
            Ok(()) => {}
            Err(e) if e.code == "not_found" || e.code == "forbidden" => return Err(missing(id)),
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

/// Inside the save's transaction, after the organization's lock: every analysis the save adds is
/// still there and outside the trash. Trashing an analysis takes the same lock before it counts
/// the uses, so either the trash sees this save's link and refuses, or this check refuses the save.
pub async fn recheck_added(conn: &mut sqlx::AnyConnection, org_id: &str, ids: &BTreeSet<&str>) -> ApiResult<()> {
    for id in ids {
        let row = fetch_link(&mut *conn, org_id, id).await?.ok_or_else(|| missing(id))?;
        if row.deleted_at.is_some() {
            return Err(missing(id));
        }
    }
    Ok(())
}

/// The audience rule of links: a dashboard shows an analysis to everyone who reads the dashboard,
/// so it may link only an analysis whose audience is not narrower than the dashboard's. A team-only
/// analysis is never linked; one that a restricted folder (a team space included) governs is
/// linked only by dashboards that the same restricted folder governs. Open analyses go anywhere.
pub fn audience_fits(
    tree: &crate::folders::Tree,
    analysis_folder: Option<&str>,
    analysis_team_only: bool,
    dashboard_folder: Option<&str>,
) -> bool {
    if analysis_team_only {
        return false;
    }
    match analysis_folder.and_then(|f| tree.governing(f)) {
        None => true,
        Some(governing) => dashboard_folder.and_then(|f| tree.governing(f)) == Some(governing),
    }
}

/// Inside the save's transaction after the organization's lock: every analysis in `ids` fits the
/// audience of a dashboard at `place` (`audience_fits`), for everyone, org admins included, since
/// the dashboard's readers would see what the analysis's audience rule keeps from them (`403`).
pub async fn recheck_audience(
    conn: &mut sqlx::AnyConnection,
    ctx: &OrgCtx,
    place: Option<&str>,
    ids: &BTreeSet<&str>,
) -> ApiResult<()> {
    if ids.is_empty() {
        return Ok(());
    }
    let tree = crate::folders::Tree::load(&mut *conn, ctx).await?;
    for id in ids {
        let Some(row) = fetch_link(&mut *conn, &ctx.org_id, id).await? else { continue };
        if !audience_fits(&tree, row.folder_id.as_deref(), row.team_only != 0, place) {
            return Err(ApiError::forbidden(format!(
                "analysis {id} is team only or lies in a restricted folder or team space; a dashboard links it \
                 only inside that folder, where its readers may see it"
            )));
        }
    }
    Ok(())
}

/// Records which analyses the dashboard's current version links, inside the save's transaction.
pub async fn sync_uses(
    conn: &mut sqlx::AnyConnection,
    org_id: &str,
    dashboard_id: &str,
    dashboard: &DashboardModel,
) -> ApiResult<()> {
    sqlx::query("DELETE FROM analysis_uses WHERE dashboard_id = $1").bind(dashboard_id).execute(&mut *conn).await?;
    for id in dashboard.analysis_ids() {
        sqlx::query("INSERT INTO analysis_uses (org_id, analysis_id, dashboard_id) VALUES ($1, $2, $3)")
            .bind(org_id)
            .bind(id)
            .bind(dashboard_id)
            .execute(&mut *conn)
            .await?;
    }
    Ok(())
}

/// Records which data sources the analysis's current version queries, inside the save's
/// transaction.
pub async fn sync_sources(
    conn: &mut sqlx::AnyConnection,
    org_id: &str,
    analysis_id: &str,
    analysis: &AnalysisModel,
) -> ApiResult<()> {
    sqlx::query("DELETE FROM analysis_sources WHERE analysis_id = $1").bind(analysis_id).execute(&mut *conn).await?;
    let ids: BTreeSet<&str> = analysis.targets.iter().map(|t| t.datasource_id.as_str()).collect();
    for id in ids {
        sqlx::query("INSERT INTO analysis_sources (org_id, analysis_id, datasource_id) VALUES ($1, $2, $3)")
            .bind(org_id)
            .bind(analysis_id)
            .bind(id)
            .execute(&mut *conn)
            .await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid() -> Value {
        json!({
            "schemaVersion": 1,
            "title": "Umsatz je Land",
            "timeRange": { "from": "now-7d", "to": "now" },
            "targets": [{ "refId": "A", "datasourceId": "ds", "query": { "sql": "SELECT 1" } }],
            "steps": [{ "id": "s1", "type": "reduce", "frame": "A", "fields": ["amount"], "stats": ["sum"] }],
            "visualization": { "type": "table" }
        })
    }

    #[test]
    fn a_valid_model_round_trips_with_defaults() {
        let a = parse(valid()).unwrap();
        assert_eq!(a.visualization.options, json!({}));
        let back = serde_json::to_value(&a).unwrap();
        assert_eq!(parse(back).unwrap(), a);
        let d = a.as_dashboard().unwrap();
        assert_eq!(d.panels.len(), 1);
        assert_eq!(d.panels[0].targets, a.targets);
        assert_eq!(d.panels[0].transformations, a.steps);
    }

    #[test]
    fn errors_name_the_place_in_the_analysis() {
        let cases = [
            (json!({ "title": "" }), "model.title"),
            (json!({ "targets": [] }), "model.targets"),
            (json!({ "timeRange": { "from": "gestern", "to": "now" } }), "model.timeRange"),
            (
                json!({ "steps": [{ "id": "s1", "type": "reduce", "frame": "B", "fields": ["amount"], "stats": ["sum"] }] }),
                "model.steps[0]",
            ),
            (json!({ "visualization": { "type": " " } }), "model.visualization.type"),
            (json!({ "dashboard": true }), "model:"),
            (json!({ "schemaVersion": 2 }), "model.schemaVersion"),
        ];
        for (change, place) in cases {
            let mut raw = valid();
            for (k, v) in change.as_object().unwrap() {
                raw[k] = v.clone();
            }
            let e = parse(raw).unwrap_err();
            assert!(e.starts_with(place), "{change}: {e}");
        }
        // Two queries with one refId cannot be told apart by the steps.
        let mut raw = valid();
        raw["targets"] = json!([
            { "refId": "A", "datasourceId": "ds", "query": {} },
            { "refId": "A", "datasourceId": "ds", "query": {} }
        ]);
        assert!(parse(raw).unwrap_err().contains("model.targets[1].refId"));
    }

    #[test]
    fn visualization_options_are_checked_only_when_they_change() {
        let mut raw = valid();
        raw["visualization"] = json!({ "type": "timeseries", "options": { "lineWidth": 9 } });
        let bad = parse(raw).unwrap();
        let e = check_visualization(&bad, None).unwrap_err();
        assert_eq!(e.field, Some("model"));
        assert!(e.message.starts_with("model.visualization.options.lineWidth"), "{}", e.message);
        // The stored model had it already: a save that leaves it alone passes.
        assert!(check_visualization(&bad, Some(&bad)).is_ok());
        assert!(check_visualization(&parse(valid()).unwrap(), None).is_ok());
    }
}
