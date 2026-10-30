//! Usage insights (docs/api/usage.md): an organization's for members with `audit:read` (admins
//! and owners), every organization's or one's for server administrators. Counts per dashboard,
//! panel and data source only; nothing here is per person.

use axum::Extension;
use axum::Json;
use axum::extract::State;
use axum::http::Method;
use serde::Deserialize;

use super::support::QueryParams;
use super::table::{RouteDef, route};
use crate::app::AppState;
use crate::authz::{Access, OrgCtx, Permission};
use crate::error::{ApiError, ApiResult};
use crate::usage::report::{self, Report, Scope, Unused};

pub fn routes() -> Vec<RouteDef> {
    vec![
        route(Method::GET, "/orgs/{orgId}/usage", Access::Org(Permission::AuditRead), org_report),
        route(Method::GET, "/orgs/{orgId}/usage/unused", Access::Org(Permission::AuditRead), org_unused),
        route(Method::GET, "/admin/usage", Access::ServerAdmin, server_report),
        route(Method::GET, "/admin/usage/unused", Access::ServerAdmin, server_unused),
    ]
}

/// `?from=&to=` (Unix ms) of a report; the server view also takes `orgId`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReportQuery {
    from: i64,
    to: i64,
    org_id: Option<String>,
}

/// `?days=` of the unused dashboards (default 30); the server view also takes `orgId`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UnusedQuery {
    days: Option<i64>,
    org_id: Option<String>,
}

const DEFAULT_UNUSED_DAYS: i64 = 30;

fn no_org_filter(org_id: Option<&String>) -> ApiResult<()> {
    match org_id {
        Some(_) => Err(ApiError::validation("orgId is a filter of the server view only").with_field("orgId")),
        None => Ok(()),
    }
}

async fn org_report(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    QueryParams(q): QueryParams<ReportQuery>,
) -> ApiResult<Json<Report>> {
    no_org_filter(q.org_id.as_ref())?;
    let sources = report::visible_sources(&state, &ctx).await?;
    Ok(Json(report::report(&state, Scope::member(&ctx, sources.as_deref()), q.from, q.to).await?))
}

async fn org_unused(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    QueryParams(q): QueryParams<UnusedQuery>,
) -> ApiResult<Json<Unused>> {
    no_org_filter(q.org_id.as_ref())?;
    let days = q.days.unwrap_or(DEFAULT_UNUSED_DAYS);
    Ok(Json(report::unused(&state, Scope::member(&ctx, None), days, state.clock.now_ms()).await?))
}

/// The organization a server view is narrowed to: `None` for all, `not_found` for one that does
/// not exist.
async fn server_org(state: &AppState, org_id: Option<String>) -> ApiResult<Option<String>> {
    let Some(org_id) = org_id else { return Ok(None) };
    let found: Option<(String,)> =
        sqlx::query_as("SELECT id FROM orgs WHERE id = $1").bind(&org_id).fetch_optional(&state.db).await?;
    match found {
        Some(_) => Ok(Some(org_id)),
        None => Err(ApiError::not_found()),
    }
}

async fn server_report(
    State(state): State<AppState>,
    QueryParams(q): QueryParams<ReportQuery>,
) -> ApiResult<Json<Report>> {
    let org = server_org(&state, q.org_id).await?;
    Ok(Json(report::report(&state, Scope::server(org.as_deref()), q.from, q.to).await?))
}

async fn server_unused(
    State(state): State<AppState>,
    QueryParams(q): QueryParams<UnusedQuery>,
) -> ApiResult<Json<Unused>> {
    let org = server_org(&state, q.org_id).await?;
    let days = q.days.unwrap_or(DEFAULT_UNUSED_DAYS);
    Ok(Json(report::unused(&state, Scope::server(org.as_deref()), days, state.clock.now_ms()).await?))
}
