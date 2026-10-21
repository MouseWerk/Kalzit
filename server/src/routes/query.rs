//! Queries: free queries (`POST /orgs/{orgId}/query`) for members with `datasources:query`, and a
//! dashboard's stored queries (a panel's targets, a query variable's options) for whoever may read
//! the dashboard. All of them run through `datasources::run_queries`. Documented in
//! docs/api/datasources.md.
//!
//! Stored queries: reading the dashboard is what authorizes them. Saving a dashboard required
//! `datasources:query` on every data source it uses (`dashboards::check_dashboard_sources`), so a
//! viewer reaches exactly the sources an authorized editor put there, and only with the stored
//! queries; the request contributes only the time range, limits and variable values (bound, never
//! spliced into the query).

use std::collections::{BTreeMap, BTreeSet};

use axum::extract::{Path, State};
use axum::http::{Method, StatusCode};
use axum::{Extension, Json};
use serde_json::Value;

use super::table::{RouteDef, route};
use crate::app::AppState;
use crate::authz::{Access, OrgCtx, Permission, Resource, check_resource};
use crate::dashboards::model::{self, DashboardModel, VariableType};
use crate::datasources::{check_items, check_range, run_queries};
use crate::error::{ApiError, ApiResult};
use crate::extract::JsonBody;
use crate::shapes::{
    ErrorBody, FieldType, PanelQueryRequest, QueryItem, QueryOutcome, QueryRequest, QueryResponse, QueryResult,
    VariableOption, VariableOptionsRequest, VariableOptionsResponse,
};

pub fn routes() -> Vec<RouteDef> {
    vec![
        route(Method::POST, "/orgs/{orgId}/query", Access::Org(Permission::DatasourcesQuery), query),
        // Dashboard routes: `dashboards:read` on the dashboard decides, checked in the handler.
        route(
            Method::POST,
            "/orgs/{orgId}/dashboards/{dashboardId}/panels/{panelId}/query",
            Access::OrgMember,
            panel_query,
        ),
        route(
            Method::POST,
            "/orgs/{orgId}/dashboards/{dashboardId}/variables/{name}/options",
            Access::OrgMember,
            variable_options,
        ),
    ]
}

/// Variables in one request, and the size of all their values together.
const MAX_VARIABLES: usize = 100;
const MAX_VARIABLES_BYTES: usize = 64 * 1024;
/// Options one query variable offers.
pub const MAX_OPTIONS: usize = 10_000;
const OPTIONS_REF_ID: &str = "options";

/// Bounds the variables of a request: count, names and total size.
fn check_variables(variables: &BTreeMap<String, Value>) -> ApiResult<()> {
    let refuse = |m: String| Err(ApiError::validation(m).with_field("variables"));
    if variables.len() > MAX_VARIABLES {
        return refuse(format!("at most {MAX_VARIABLES} variables"));
    }
    if let Some(bad) = variables.keys().find(|k| {
        k.is_empty()
            || k.len() > 64
            || !k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
            || k.starts_with(|c: char| c.is_ascii_digit())
    }) {
        return refuse(format!("{bad:?} is not a variable name"));
    }
    if serde_json::to_string(variables).map_or(usize::MAX, |s| s.len()) > MAX_VARIABLES_BYTES {
        return refuse(format!("variable values exceed {MAX_VARIABLES_BYTES} bytes"));
    }
    Ok(())
}

async fn query(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    JsonBody(req): JsonBody<QueryRequest>,
) -> ApiResult<Json<QueryResponse>> {
    check_items(&req.queries)?;
    check_range(req.time_range)?;
    check_variables(&req.variables)?;
    // Each item is authorized on its own data source; one the caller may not query answers for
    // its refId only. Ids of other organizations are not found when they are run.
    let mut refused = Vec::new();
    let mut allowed = Vec::new();
    for item in req.queries {
        match check_resource(&state.db, &ctx, Permission::DatasourcesQuery, Resource::Datasource(&item.datasource_id))
            .await
        {
            Ok(()) => allowed.push(item),
            Err(e) => refused.push((item.ref_id, e)),
        }
    }
    let mut response = if allowed.is_empty() {
        QueryResponse { results: Default::default() }
    } else {
        run_queries(&state, &ctx, allowed, req.time_range, req.interval_ms, req.max_data_points, &req.variables).await
    };
    for (ref_id, e) in refused {
        let error = ErrorBody { code: e.code.to_string(), message: e.message, field: None };
        response.results.insert(ref_id, QueryOutcome::Err { error });
    }
    Ok(Json(response))
}

/// The current stored model of a dashboard the caller may read. Unknown, trashed and invisible
/// dashboards are all `not_found`.
async fn readable_model(state: &AppState, ctx: &OrgCtx, dashboard_id: &str) -> ApiResult<DashboardModel> {
    let row: Option<(i64, Option<i64>)> =
        sqlx::query_as("SELECT version, deleted_at FROM dashboards WHERE org_id = $1 AND id = $2")
            .bind(&ctx.org_id)
            .bind(dashboard_id)
            .fetch_optional(&state.db)
            .await?;
    let Some((version, deleted_at)) = row else { return Err(ApiError::not_found()) };
    check_resource(&state.db, ctx, Permission::DashboardsRead, Resource::Dashboard(dashboard_id)).await?;
    if deleted_at.is_some() {
        return Err(ApiError::not_found());
    }
    let (raw,): (String,) =
        sqlx::query_as("SELECT model FROM dashboard_versions WHERE dashboard_id = $1 AND version = $2")
            .bind(dashboard_id)
            .bind(version)
            .fetch_optional(&state.db)
            .await?
            .ok_or_else(|| {
                ApiError::internal("dashboards", format!("dashboard {dashboard_id} lacks version {version}"))
            })?;
    let value: Value = serde_json::from_str(&raw).map_err(|e| ApiError::internal("dashboards", e))?;
    model::parse(value).map_err(|e| ApiError::internal("dashboards", e))
}

/// Variable values may only name variables the dashboard defines.
fn check_known_variables(model: &DashboardModel, variables: &BTreeMap<String, Value>) -> ApiResult<()> {
    let known: BTreeSet<&str> = model.variables.iter().map(|v| v.name.as_str()).collect();
    match variables.keys().find(|k| !known.contains(k.as_str())) {
        Some(unknown) => {
            Err(ApiError::validation(format!("the dashboard has no variable {unknown}")).with_field("variables"))
        }
        None => Ok(()),
    }
}

async fn panel_query(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Path((_, dashboard_id, panel_id)): Path<(String, String, String)>,
    JsonBody(req): JsonBody<PanelQueryRequest>,
) -> ApiResult<Json<QueryResponse>> {
    let model = readable_model(&state, &ctx, &dashboard_id).await?;
    let panel = model.panels.iter().find(|p| p.id == panel_id).ok_or_else(ApiError::not_found)?;
    check_range(req.time_range)?;
    check_variables(&req.variables)?;
    check_known_variables(&model, &req.variables)?;
    let items: Vec<QueryItem> = panel
        .targets
        .iter()
        .map(|t| QueryItem {
            ref_id: t.ref_id.clone(),
            datasource_id: t.datasource_id.clone(),
            query: t.query.clone(),
            cursor: req.cursors.get(&t.ref_id).cloned(),
            limit: req.limit,
        })
        .collect();
    if items.is_empty() {
        return Ok(Json(QueryResponse { results: BTreeMap::new() }));
    }
    check_items(&items)?;
    let response =
        run_queries(&state, &ctx, items, req.time_range, req.interval_ms, req.max_data_points, &req.variables).await;
    Ok(Json(response))
}

async fn variable_options(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Path((_, dashboard_id, name)): Path<(String, String, String)>,
    JsonBody(req): JsonBody<VariableOptionsRequest>,
) -> ApiResult<Json<VariableOptionsResponse>> {
    let model = readable_model(&state, &ctx, &dashboard_id).await?;
    let variable = model.variables.iter().find(|v| v.name == name).ok_or_else(ApiError::not_found)?;
    check_range(req.time_range)?;
    check_variables(&req.variables)?;
    check_known_variables(&model, &req.variables)?;
    if req.variables.contains_key(&name) {
        return Err(ApiError::validation(format!("variable {name} cannot depend on itself")).with_field("variables"));
    }
    let (VariableType::Query, Some(datasource_id), Some(query)) =
        (variable.kind, variable.datasource_id.as_ref(), variable.query.as_ref())
    else {
        return Err(ApiError::validation(format!("{name} is not a query variable")));
    };
    let item = QueryItem {
        ref_id: OPTIONS_REF_ID.into(),
        datasource_id: datasource_id.clone(),
        query: query.clone(),
        cursor: None,
        limit: Some(MAX_OPTIONS as u32),
    };
    let mut response = run_queries(&state, &ctx, vec![item], req.time_range, None, None, &req.variables).await;
    match response.results.remove(OPTIONS_REF_ID) {
        Some(QueryOutcome::Ok { result }) => Ok(Json(options_from(result)?)),
        Some(QueryOutcome::Err { error }) => Err(api_error(error)),
        None => Err(ApiError::internal("variable options", "no outcome for the query")),
    }
}

/// A query outcome's error as the answer of a single-query route.
fn api_error(error: ErrorBody) -> ApiError {
    let (status, code) = match error.code.as_str() {
        "not_found" => (StatusCode::NOT_FOUND, "not_found"),
        "forbidden" => (StatusCode::FORBIDDEN, "forbidden"),
        "query_rejected" => (StatusCode::UNPROCESSABLE_ENTITY, "query_rejected"),
        "datasource_target_blocked" => (StatusCode::UNPROCESSABLE_ENTITY, "datasource_target_blocked"),
        "query_timeout" => (StatusCode::GATEWAY_TIMEOUT, "query_timeout"),
        "validation" => (StatusCode::UNPROCESSABLE_ENTITY, "validation"),
        _ => (StatusCode::BAD_GATEWAY, "datasource_error"),
    };
    ApiError::new(status, code, error.message)
}

/// The options of a query variable: values from the frame's first field, labels from the second
/// (or the value), distinct by value, at most `MAX_OPTIONS`.
fn options_from(result: QueryResult) -> ApiResult<VariableOptionsResponse> {
    let QueryResult::Frame { frame } = result else {
        return Err(ApiError::validation("a variable's query must answer a table (frame)"));
    };
    let fields = frame.fields();
    let mut truncated = frame.meta().is_some_and(|m| m.rows_truncated);
    let Some(values) = fields.first() else {
        return Ok(VariableOptionsResponse { options: Vec::new(), truncated });
    };
    let labels = fields.get(1);
    let mut seen = BTreeSet::new();
    let mut options = Vec::new();
    for (row, raw) in values.values.iter().enumerate() {
        let Some(value) = as_text(raw, values.field_type) else { continue };
        if !seen.insert(value.clone()) {
            continue;
        }
        if options.len() == MAX_OPTIONS {
            truncated = true;
            break;
        }
        let label = labels.and_then(|l| as_text(&l.values[row], l.field_type)).unwrap_or_else(|| value.clone());
        options.push(VariableOption { value, label });
    }
    Ok(VariableOptionsResponse { options, truncated })
}

/// A cell as option text: int64 stays its decimal string, time becomes ISO 8601 in UTC; `null`
/// has no option.
fn as_text(value: &Value, field_type: FieldType) -> Option<String> {
    match (field_type, value) {
        (_, Value::Null) => None,
        (FieldType::Time, Value::Number(n)) => n
            .as_i64()
            .and_then(chrono::DateTime::from_timestamp_millis)
            .map(|t| t.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)),
        (_, Value::String(s)) => Some(s.clone()),
        (_, other) => Some(other.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shapes::{Field, Frame, FrameMeta};
    use serde_json::json;

    fn field(name: &str, field_type: FieldType, values: Vec<Value>) -> Field {
        Field { name: name.into(), field_type, unit: None, values, labels: None }
    }

    #[test]
    fn options_are_distinct_text_with_labels() {
        let frame = Frame::new(vec![
            field("id", FieldType::Int64, vec![json!("9007199254740993"), json!("2"), json!("2"), Value::Null]),
            field("name", FieldType::String, vec![json!("Groß"), json!("Klein"), json!("Doppelt"), json!("Leer")]),
        ])
        .unwrap();
        let r = options_from(QueryResult::Frame { frame }).unwrap();
        assert_eq!(
            r.options,
            [
                VariableOption { value: "9007199254740993".into(), label: "Groß".into() },
                VariableOption { value: "2".into(), label: "Klein".into() },
            ]
        );
        assert!(!r.truncated);

        let frame = Frame::new(vec![field("t", FieldType::Time, vec![json!(1_735_725_600_000_i64)])])
            .unwrap()
            .with_meta(FrameMeta { rows_truncated: true, ..Default::default() });
        let r = options_from(QueryResult::Frame { frame }).unwrap();
        assert_eq!(r.options[0].value, "2025-01-01T10:00:00.000Z");
        assert_eq!(r.options[0].label, r.options[0].value);
        assert!(r.truncated);

        let many = (0..MAX_OPTIONS + 5).map(|i| json!(i)).collect();
        let frame = Frame::new(vec![field("n", FieldType::Number, many)]).unwrap();
        let r = options_from(QueryResult::Frame { frame }).unwrap();
        assert_eq!((r.options.len(), r.truncated), (MAX_OPTIONS, true));
    }

    #[test]
    fn variables_are_bounded() {
        assert!(check_variables(&BTreeMap::from([("land".into(), json!("AT"))])).is_ok());
        assert!(check_variables(&BTreeMap::from([("1x".into(), json!(1))])).is_err());
        assert!(check_variables(&BTreeMap::from([("a b".into(), json!(1))])).is_err());
        let big = BTreeMap::from([("v".into(), json!("x".repeat(MAX_VARIABLES_BYTES)))]);
        assert!(check_variables(&big).is_err());
        let many: BTreeMap<String, Value> = (0..=MAX_VARIABLES).map(|i| (format!("v{i}"), json!(i))).collect();
        assert!(check_variables(&many).is_err());
    }
}
