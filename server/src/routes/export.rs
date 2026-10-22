//! Export (docs/api/datasources.md, "Export"): a query result after its analysis steps, as a CSV,
//! JSON or Excel file. The server runs the queries and the steps itself, so the file is made only
//! after the same checks as running the query, plus `data:export`:
//!
//! - `POST /orgs/{orgId}/export`: free queries, with `datasources:query` on every data source.
//! - `POST /orgs/{orgId}/dashboards/{dashboardId}/panels/{panelId}/export`: a panel's stored
//!   queries and steps, for whoever may read the dashboard.
//!
//! Every export is written to the audit log. The format is chosen per result shape: frames today;
//! documents (NDJSON) and graphs (GraphML) add their encoders here with M2 and M3.

use std::collections::BTreeSet;

use axum::Extension;
use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{Method, StatusCode, header};
use axum::response::Response;
use serde_json::{Value, json};

use super::query::{api_error, check_variables, readable_model, resolve_variables};
use super::table::{RouteDef, route};
use crate::analysis::steps::{self, Input};
use crate::analysis::{Step, check_steps, export};
use crate::app::AppState;
use crate::audit::{self, AuditEvent};
use crate::authz::{Access, OrgCtx, Permission, Resource, check_resource};
use crate::datasources::detail::Detail;
use crate::datasources::{check_interval, check_items, check_range, run_queries, run_queries_with};
use crate::error::{ApiError, ApiResult};
use crate::extract::JsonBody;
use crate::net::RequestInfo;
use crate::shapes::{
    ExportFormat, ExportLanguage, ExportRequest, PanelExportRequest, QueryItem, QueryOutcome, QueryResponse,
    QueryResult, Shape,
};

pub fn routes() -> Vec<RouteDef> {
    vec![
        // And `datasources:query` per data source (role or grant), checked in the handler.
        route(Method::POST, "/orgs/{orgId}/export", Access::Org(Permission::DataExport), export_query),
        // And `dashboards:read` on the dashboard, checked in the handler.
        route(
            Method::POST,
            "/orgs/{orgId}/dashboards/{dashboardId}/panels/{panelId}/export",
            Access::Org(Permission::DataExport),
            export_panel,
        ),
    ]
}

fn refused(detail: Detail) -> ApiError {
    ApiError::validation(detail.message).with_reason(detail.reason, detail.params)
}

/// What a request asks to be written.
struct Wanted {
    format: ExportFormat,
    language: ExportLanguage,
    frame: Option<String>,
}

async fn export_query(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    JsonBody(req): JsonBody<ExportRequest>,
) -> ApiResult<Response> {
    check_items(&req.queries)?;
    check_range(req.time_range)?;
    check_interval(req.interval_ms)?;
    check_variables(&req.variables)?;
    let refs: BTreeSet<&str> = req.queries.iter().map(|q| q.ref_id.as_str()).collect();
    let steps = check_steps(&req.steps, &refs, "steps")
        .map_err(|e| ApiError::validation(e.clone()).with_field("steps").because("steps.invalid").param("detail", e))?;
    // The file holds what running the queries would show, so the same right decides: each data
    // source must be one the caller may query. Unlike a run, one refusal refuses the file.
    for item in &req.queries {
        check_resource(&state.db, &ctx, Permission::DatasourcesQuery, Resource::Datasource(&item.datasource_id))
            .await?;
    }
    let order: Vec<String> = req.queries.iter().map(|q| q.ref_id.clone()).collect();
    let sources: BTreeSet<String> = req.queries.iter().map(|q| q.datasource_id.clone()).collect();
    let response =
        run_queries(&state, &ctx, req.queries, req.time_range, req.interval_ms, req.max_data_points, &req.variables)
            .await;
    let title = req.title.as_deref().unwrap_or("kalzit-export");
    let wanted = Wanted { format: req.format, language: req.language, frame: req.frame };
    let (file, rows) = produce(response, &order, steps, &wanted).await?;
    let summary = json!({ "format": req.format, "rows": rows, "datasourceIds": sources });
    record(&state, &ctx, &info, None, summary).await?;
    Ok(attachment(file, title))
}

async fn export_panel(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    Path((_, dashboard_id, panel_id)): Path<(String, String, String)>,
    JsonBody(req): JsonBody<PanelExportRequest>,
) -> ApiResult<Response> {
    let model = readable_model(&state, &ctx, &dashboard_id).await?;
    let panel = model.panels.iter().find(|p| p.id == panel_id).ok_or_else(ApiError::not_found)?;
    check_range(req.time_range)?;
    check_interval(req.interval_ms)?;
    check_variables(&req.variables)?;
    let (variables, identifiers) = resolve_variables(&model, &req.variables)?;
    if panel.targets.is_empty() {
        return Err(ApiError::validation("the panel has no query to export").because("export.no_queries"));
    }
    let refs: BTreeSet<&str> = panel.targets.iter().map(|t| t.ref_id.as_str()).collect();
    // Checked when the dashboard was saved; failing here means the stored model is broken.
    let steps = check_steps(&panel.transformations, &refs, "transformations")
        .map_err(|e| ApiError::internal("export", format!("stored steps of panel {panel_id}: {e}")))?;
    let items: Vec<QueryItem> = panel
        .targets
        .iter()
        .map(|t| QueryItem {
            ref_id: t.ref_id.clone(),
            datasource_id: t.datasource_id.clone(),
            query: t.query.clone(),
            cursor: None,
            limit: None,
        })
        .collect();
    check_items(&items)?;
    let order: Vec<String> = items.iter().map(|i| i.ref_id.clone()).collect();
    let response = run_queries_with(
        &state,
        &ctx,
        items,
        req.time_range,
        req.interval_ms,
        req.max_data_points,
        &variables,
        Some(&identifiers),
    )
    .await;
    let title = if panel.title.trim().is_empty() { model.title.as_str() } else { panel.title.as_str() };
    let wanted = Wanted { format: req.format, language: req.language, frame: req.frame };
    let (file, rows) = produce(response, &order, steps, &wanted).await?;
    let summary = json!({ "format": req.format, "rows": rows, "panelId": panel_id });
    record(&state, &ctx, &info, Some(&dashboard_id), summary).await?;
    Ok(attachment(file, title))
}

/// The file from the queries' outcomes: every query must have answered (a file never holds less
/// than asked for without saying so), then the steps run and the chosen frame is encoded.
async fn produce(
    mut response: QueryResponse,
    order: &[String],
    steps: Vec<Step>,
    wanted: &Wanted,
) -> ApiResult<(export::File, usize)> {
    let mut inputs = Vec::new();
    // Results that are no frame: exported only after a projection made one of them.
    let mut other_shapes = Vec::new();
    for ref_id in order {
        match response.results.remove(ref_id) {
            Some(QueryOutcome::Ok { result: QueryResult::Frame { frame } }) => {
                inputs.push((ref_id.clone(), Input::Frame(frame)))
            }
            Some(QueryOutcome::Ok { result: QueryResult::Documents { documents } }) => {
                other_shapes.push((ref_id.clone(), Shape::Documents));
                inputs.push((ref_id.clone(), Input::Documents(documents)));
            }
            Some(QueryOutcome::Ok { result }) => other_shapes.push((ref_id.clone(), result.shape())),
            Some(QueryOutcome::Err { error }) => return Err(api_error(error)),
            None => return Err(ApiError::internal("export", format!("no outcome for {ref_id}"))),
        }
    }
    let (format, language, frame) = (wanted.format, wanted.language, wanted.frame.clone());
    // Steps and encoding take CPU time; they run off the request threads.
    let work = tokio::task::spawn_blocking(move || -> Result<(export::File, usize), ApiError> {
        let frames = steps::run_inputs(&steps, inputs).map_err(|f| {
            let message = format!("step {}: {}", f.index + 1, f.detail.message);
            ApiError::validation(message).with_field("steps").with_reason(f.detail.reason, f.detail.params)
        })?;
        let chosen = match &frame {
            Some(name) => frames.iter().find(|f| &f.name == name),
            None => frames.first(),
        };
        let Some(chosen) = chosen else {
            let shape = other_shapes.iter().find(|(r, _)| frame.as_ref().is_none_or(|f| f == r)).map(|(_, s)| *s);
            return Err(match shape {
                Some(shape) => {
                    let shape =
                        serde_json::to_value(shape).ok().and_then(|v| v.as_str().map(String::from)).unwrap_or_default();
                    refused(
                        Detail::new("export.shape_unsupported", format!("{shape} results cannot be exported yet"))
                            .with("shape", shape),
                    )
                }
                None => {
                    let name = frame.unwrap_or_default();
                    refused(
                        Detail::new("export.frame_missing", format!("there is no table {name} to export"))
                            .with("frame", &name),
                    )
                    .with_field("frame")
                }
            });
        };
        let file = export::encode(&chosen.frame, &chosen.name, format, language).map_err(refused)?;
        Ok((file, chosen.frame.rows()))
    });
    work.await.map_err(|e| ApiError::internal("export", e))?
}

async fn record(
    state: &AppState,
    ctx: &OrgCtx,
    info: &RequestInfo,
    dashboard_id: Option<&str>,
    summary: Value,
) -> ApiResult<()> {
    let mut tx = crate::db::begin(&state.db).await?;
    let event = AuditEvent {
        org_id: Some(&ctx.org_id),
        actor_user_id: Some(&ctx.user.id),
        actor_address: Some(info.client_ip.to_string()),
        action: "data.exported",
        resource_type: dashboard_id.map(|_| "dashboard"),
        resource_id: dashboard_id,
        summary,
        at_ms: state.clock.now_ms(),
    };
    audit::record(&mut tx, &event).await?;
    crate::db::commit(tx).await?;
    Ok(())
}

fn attachment(file: export::File, title: &str) -> Response {
    let name = export::file_name(title, file.extension);
    let mut response = Response::new(Body::from(file.bytes));
    *response.status_mut() = StatusCode::OK;
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, header::HeaderValue::from_static(file.content_type));
    // `file_name` leaves only ASCII letters, digits, `-`, `_` and the dot: always a valid header.
    if let Ok(value) = header::HeaderValue::from_str(&format!("attachment; filename=\"{name}\"")) {
        headers.insert(header::CONTENT_DISPOSITION, value);
    }
    headers.insert(header::CACHE_CONTROL, header::HeaderValue::from_static("no-store"));
    response
}

#[cfg(test)]
#[path = "export_tests.rs"]
mod tests;
