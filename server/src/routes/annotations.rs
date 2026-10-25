//! Annotations of a dashboard: notes at a point or span of time that people write by hand, and the
//! dashboard's annotation queries, whose rows become annotations on every time panel. Documented
//! in docs/api/dashboard-features.md.
//!
//! Whoever may read the dashboard reads its annotations and runs its annotation queries (the same
//! rule as for its stored panel queries). Writing needs read access to the dashboard and either
//! `annotations:write` or write access to the dashboard itself. Events are recorded on the
//! dashboard (`resource_type` `dashboard`), so the audit view hides them with a restricted
//! dashboard.

use axum::extract::{Path, State};
use axum::http::{Method, StatusCode};
use axum::response::IntoResponse;
use axum::{Extension, Json};
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::folders::double_option;
use super::new_id;
use super::query::{check_variables, readable_model, resolve_variables};
use super::support::{Actor, QueryParams, audit, clean_text, conflict, decode_cursor, encode_cursor, page_limit};
use super::table::{RouteDef, route};
use crate::app::AppState;
use crate::authz::{self, Access, OrgCtx, Permission};
use crate::dashboards::model;
use crate::datasources::{MAX_TIME_MS, MIN_TIME_MS, check_range, run_queries_with};
use crate::error::{ApiError, ApiResult};
use crate::extract::JsonBody;
use crate::net::RequestInfo;
use crate::shapes::{Page, QueryItem, QueryResponse, VariableOptionsRequest};

const MAX_TEXT_CHARS: usize = 2000;
const MAX_PANEL_ID_CHARS: usize = 64;

pub fn routes() -> Vec<RouteDef> {
    use Access::OrgMember;
    vec![
        route(Method::GET, "/orgs/{orgId}/dashboards/{dashboardId}/annotations", OrgMember, list),
        route(Method::POST, "/orgs/{orgId}/dashboards/{dashboardId}/annotations", OrgMember, create),
        route(Method::PATCH, "/orgs/{orgId}/dashboards/{dashboardId}/annotations/{annotationId}", OrgMember, update),
        route(Method::DELETE, "/orgs/{orgId}/dashboards/{dashboardId}/annotations/{annotationId}", OrgMember, remove),
        route(
            Method::POST,
            "/orgs/{orgId}/dashboards/{dashboardId}/annotation-queries/{queryId}/query",
            OrgMember,
            run_annotation_query,
        ),
    ]
}

#[derive(Clone, Debug, sqlx::FromRow)]
struct AnnotationRow {
    id: String,
    dashboard_id: String,
    panel_id: Option<String>,
    time_ms: i64,
    time_end_ms: Option<i64>,
    text: String,
    tags: String,
    version: i64,
    created_by: Option<String>,
    created_at: i64,
    updated_by: Option<String>,
    updated_at: i64,
}

const COLUMNS: &str = "id, dashboard_id, panel_id, time_ms, time_end_ms, text, tags, version, created_by, \
                       created_at, updated_by, updated_at";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Annotation {
    id: String,
    dashboard_id: String,
    /// `null`: shown on every time panel of the dashboard.
    panel_id: Option<String>,
    time: i64,
    /// Set for a span of time.
    time_end: Option<i64>,
    text: String,
    tags: Vec<String>,
    version: i64,
    created_by: Option<String>,
    created_at: i64,
    updated_by: Option<String>,
    updated_at: i64,
}

impl From<AnnotationRow> for Annotation {
    fn from(r: AnnotationRow) -> Self {
        Self {
            id: r.id,
            dashboard_id: r.dashboard_id,
            panel_id: r.panel_id,
            time: r.time_ms,
            time_end: r.time_end_ms,
            text: r.text,
            // Written by the server from checked tags; an unreadable value shows none.
            tags: serde_json::from_str(&r.tags).unwrap_or_default(),
            version: r.version,
            created_by: r.created_by,
            created_at: r.created_at,
            updated_by: r.updated_by,
            updated_at: r.updated_at,
        }
    }
}

/// The dashboard if the caller may read it: (trashed, may write annotations). Unknown dashboards
/// and those the caller cannot see are `not_found`.
async fn dashboard_access(state: &AppState, ctx: &OrgCtx, dashboard_id: &str) -> ApiResult<(bool, bool)> {
    let row: Option<(Option<i64>,)> = sqlx::query_as("SELECT deleted_at FROM dashboards WHERE org_id = $1 AND id = $2")
        .bind(&ctx.org_id)
        .bind(dashboard_id)
        .fetch_optional(&state.db)
        .await?;
    let Some((deleted_at,)) = row else { return Err(ApiError::not_found()) };
    // Audited as a read of the dashboard, so an admin is recorded only where reading it rests on
    // their reach into team content.
    let (held, outsider) = authz::dashboard_reader(&state.db, ctx, dashboard_id)
        .await?
        .filter(|(held, _)| held.contains(&Permission::DashboardsRead))
        .ok_or_else(ApiError::not_found)?;
    // On a dashboard a team owns (itself or through its folder), only the team, grants and org
    // admins annotate: org-wide `annotations:write` counts for everyone else only elsewhere.
    let writes = held.contains(&Permission::AnnotationsWrite)
        || held.contains(&Permission::DashboardsWrite)
        || (ctx.permissions.contains(&Permission::AnnotationsWrite) && !outsider);
    Ok((deleted_at.is_some(), writes))
}

/// Read access, then write access and a dashboard outside the trash.
async fn writable(state: &AppState, ctx: &OrgCtx, dashboard_id: &str) -> ApiResult<()> {
    let (trashed, writes) = dashboard_access(state, ctx, dashboard_id).await?;
    if !writes {
        return Err(ApiError::forbidden("missing permission annotations:write"));
    }
    if trashed {
        return Err(conflict("the dashboard is in the trash; restore it first"));
    }
    Ok(())
}

/// First statement of a change's transaction: the organization's lock (ordered against a trash
/// or purge of the dashboard, which take it too, in `routes/dashboards.rs`), then the dashboard
/// must still be there and outside the trash.
async fn lock_live(conn: &mut sqlx::AnyConnection, org_id: &str, dashboard_id: &str) -> ApiResult<()> {
    authz::lock_org(conn, org_id).await?;
    let live: Option<(Option<i64>,)> =
        sqlx::query_as("SELECT deleted_at FROM dashboards WHERE org_id = $1 AND id = $2")
            .bind(org_id)
            .bind(dashboard_id)
            .fetch_optional(&mut *conn)
            .await?;
    match live {
        None => Err(ApiError::not_found()),
        Some((Some(_),)) => Err(conflict("the dashboard is in the trash; restore it first")),
        Some((None,)) => Ok(()),
    }
}

fn check_time(field: &'static str, t: i64) -> ApiResult<()> {
    if (MIN_TIME_MS..=MAX_TIME_MS).contains(&t) {
        Ok(())
    } else {
        Err(ApiError::validation(format!("{field} must lie within the years 1 to 9999")).with_field(field))
    }
}

fn check_span(time: i64, end: Option<i64>) -> ApiResult<()> {
    check_time("time", time)?;
    if let Some(end) = end {
        check_time("timeEnd", end)?;
        if end < time {
            return Err(ApiError::validation("timeEnd must not be before time").with_field("timeEnd"));
        }
    }
    Ok(())
}

fn clean_annotation_text(raw: &str) -> ApiResult<String> {
    let text = clean_text(raw, "text", MAX_TEXT_CHARS).map_err(|e| e.with_field("text"))?;
    if text.is_empty() {
        return Err(ApiError::validation("text must not be empty").with_field("text"));
    }
    Ok(text)
}

fn tags_json(tags: &[String]) -> ApiResult<String> {
    model::check_tags("tags", tags).map_err(|e| ApiError::validation(e).with_field("tags"))?;
    serde_json::to_string(tags).map_err(|e| ApiError::internal("annotations", e))
}

async fn fetch(
    conn: &mut sqlx::AnyConnection,
    org_id: &str,
    dashboard_id: &str,
    id: &str,
) -> ApiResult<Option<AnnotationRow>> {
    Ok(sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {COLUMNS} FROM annotations WHERE org_id = $1 AND dashboard_id = $2 AND id = $3"
    )))
    .bind(org_id)
    .bind(dashboard_id)
    .bind(id)
    .fetch_optional(conn)
    .await?)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ListQuery {
    /// The range to show, Unix ms; annotations overlapping it are listed.
    from: i64,
    to: i64,
    limit: Option<u32>,
    cursor: Option<String>,
}

/// Oldest first, so a chart can draw them in order.
async fn list(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Path((_, dashboard_id)): Path<(String, String)>,
    QueryParams(q): QueryParams<ListQuery>,
) -> ApiResult<Json<Page<Annotation>>> {
    let limit = page_limit(q.limit)? as usize;
    let after: Option<(i64, String)> = decode_cursor(q.cursor.as_deref())?;
    check_range(crate::shapes::TimeRange { from: q.from, to: q.to }).map_err(|e| e.with_field("from"))?;
    dashboard_access(&state, &ctx, &dashboard_id).await?;
    let (after_time, after_id) = after.unzip();
    let rows: Vec<AnnotationRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {COLUMNS} FROM annotations WHERE org_id = $1 AND dashboard_id = $2 \
         AND time_ms <= $4 AND COALESCE(time_end_ms, time_ms) >= $3 \
         AND (CAST($5 AS BIGINT) IS NULL OR time_ms > $5 OR (time_ms = $5 AND id > $6)) \
         ORDER BY time_ms, id LIMIT $7"
    )))
    .bind(&ctx.org_id)
    .bind(&dashboard_id)
    .bind(q.from)
    .bind(q.to)
    .bind(after_time)
    .bind(after_id.as_deref())
    .bind(limit as i64 + 1)
    .fetch_all(&state.db)
    .await?;
    let mut items: Vec<Annotation> = rows.into_iter().map(Annotation::from).collect();
    let more = items.len() > limit;
    items.truncate(limit);
    let next_cursor = match items.last() {
        Some(last) if more => Some(encode_cursor(&(last.time, &last.id))),
        _ => None,
    };
    Ok(Json(Page { items, next_cursor }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateAnnotation {
    time: i64,
    #[serde(default)]
    time_end: Option<i64>,
    text: String,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    panel_id: Option<String>,
}

async fn create(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    Path((_, dashboard_id)): Path<(String, String)>,
    JsonBody(body): JsonBody<CreateAnnotation>,
) -> ApiResult<impl IntoResponse> {
    check_span(body.time, body.time_end)?;
    let text = clean_annotation_text(&body.text)?;
    let tags = tags_json(&body.tags)?;
    if let Some(panel) = &body.panel_id
        && (panel.is_empty() || panel.chars().count() > MAX_PANEL_ID_CHARS || panel.chars().any(char::is_control))
    {
        return Err(
            ApiError::validation(format!("panelId needs 1 to {MAX_PANEL_ID_CHARS} characters")).with_field("panelId")
        );
    }
    writable(&state, &ctx, &dashboard_id).await?;
    if let Some(panel) = &body.panel_id {
        let model = readable_model(&state, &ctx, &dashboard_id).await?;
        if !model.panels.iter().any(|p| &p.id == panel) {
            return Err(
                ApiError::validation(format!("panelId {panel} is not a panel of the dashboard")).with_field("panelId")
            );
        }
    }
    let id = new_id();
    let now = state.clock.now_ms();
    let mut tx = crate::db::begin(&state.db).await?;
    lock_live(&mut tx, &ctx.org_id, &dashboard_id).await?;
    sqlx::query(
        "INSERT INTO annotations (id, org_id, dashboard_id, panel_id, time_ms, time_end_ms, text, tags, version, \
         created_by, created_at, updated_by, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, $9, $10, $9, $10)",
    )
    .bind(&id)
    .bind(&ctx.org_id)
    .bind(&dashboard_id)
    .bind(body.panel_id.as_deref())
    .bind(body.time)
    .bind(body.time_end)
    .bind(&text)
    .bind(&tags)
    .bind(&ctx.user.id)
    .bind(now)
    .execute(&mut *tx)
    .await?;
    let actor = Actor { user_id: &ctx.user.id, info: &info, at_ms: now };
    let summary = json!({ "annotationId": id });
    audit(&mut tx, &actor, Some(&ctx.org_id), "annotation.created", ("dashboard", &dashboard_id), summary).await?;
    let row = fetch(&mut tx, &ctx.org_id, &dashboard_id, &id).await?.ok_or_else(ApiError::not_found)?;
    crate::db::commit(tx).await?;
    Ok((StatusCode::CREATED, Json(Annotation::from(row))))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateAnnotation {
    version: i64,
    time: Option<i64>,
    /// `null` turns a span back into a point in time.
    #[serde(default, deserialize_with = "double_option")]
    time_end: Option<Option<i64>>,
    text: Option<String>,
    tags: Option<Vec<String>>,
}

async fn update(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    Path((_, dashboard_id, id)): Path<(String, String, String)>,
    JsonBody(body): JsonBody<UpdateAnnotation>,
) -> ApiResult<Json<Annotation>> {
    let text = body.text.as_deref().map(clean_annotation_text).transpose()?;
    let tags = body.tags.as_deref().map(tags_json).transpose()?;
    writable(&state, &ctx, &dashboard_id).await?;
    let mut conn = state.db.acquire().await?;
    let row = fetch(&mut conn, &ctx.org_id, &dashboard_id, &id).await?.ok_or_else(ApiError::not_found)?;
    drop(conn);
    let time = body.time.unwrap_or(row.time_ms);
    let time_end = body.time_end.unwrap_or(row.time_end_ms);
    check_span(time, time_end)?;
    if body.version != row.version {
        return Err(ApiError::version_conflict(json!(Annotation::from(row))));
    }
    let now = state.clock.now_ms();
    let mut tx = crate::db::begin(&state.db).await?;
    lock_live(&mut tx, &ctx.org_id, &dashboard_id).await?;
    let updated = sqlx::query(
        "UPDATE annotations SET time_ms = $1, time_end_ms = $2, text = $3, tags = $4, version = version + 1, \
         updated_by = $5, updated_at = $6 WHERE org_id = $7 AND dashboard_id = $8 AND id = $9 AND version = $10",
    )
    .bind(time)
    .bind(time_end)
    .bind(text.as_deref().unwrap_or(&row.text))
    .bind(tags.as_deref().unwrap_or(&row.tags))
    .bind(&ctx.user.id)
    .bind(now)
    .bind(&ctx.org_id)
    .bind(&dashboard_id)
    .bind(&id)
    .bind(row.version)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if updated == 0 {
        drop(tx);
        let mut conn = state.db.acquire().await?;
        let current = fetch(&mut conn, &ctx.org_id, &dashboard_id, &id).await?.ok_or_else(ApiError::not_found)?;
        return Err(ApiError::version_conflict(json!(Annotation::from(current))));
    }
    let actor = Actor { user_id: &ctx.user.id, info: &info, at_ms: now };
    let mut changed = Vec::new();
    for (name, set) in [
        ("time", body.time.is_some()),
        ("timeEnd", body.time_end.is_some()),
        ("text", text.is_some()),
        ("tags", tags.is_some()),
    ] {
        if set {
            changed.push(name);
        }
    }
    let summary = json!({ "annotationId": id, "fields": changed });
    audit(&mut tx, &actor, Some(&ctx.org_id), "annotation.updated", ("dashboard", &dashboard_id), summary).await?;
    let saved = fetch(&mut tx, &ctx.org_id, &dashboard_id, &id).await?.ok_or_else(ApiError::not_found)?;
    crate::db::commit(tx).await?;
    Ok(Json(Annotation::from(saved)))
}

async fn remove(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    Path((_, dashboard_id, id)): Path<(String, String, String)>,
) -> ApiResult<StatusCode> {
    writable(&state, &ctx, &dashboard_id).await?;
    let now = state.clock.now_ms();
    let mut tx = crate::db::begin(&state.db).await?;
    lock_live(&mut tx, &ctx.org_id, &dashboard_id).await?;
    let gone = sqlx::query("DELETE FROM annotations WHERE org_id = $1 AND dashboard_id = $2 AND id = $3")
        .bind(&ctx.org_id)
        .bind(&dashboard_id)
        .bind(&id)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    if gone == 0 {
        return Err(ApiError::not_found());
    }
    let actor = Actor { user_id: &ctx.user.id, info: &info, at_ms: now };
    let summary = json!({ "annotationId": id });
    audit(&mut tx, &actor, Some(&ctx.org_id), "annotation.deleted", ("dashboard", &dashboard_id), summary).await?;
    crate::db::commit(tx).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Runs one stored annotation query of the dashboard, as the panel route runs a panel's: the
/// answer carries its outcome under the query's id.
async fn run_annotation_query(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Path((_, dashboard_id, query_id)): Path<(String, String, String)>,
    JsonBody(req): JsonBody<VariableOptionsRequest>,
) -> ApiResult<Json<QueryResponse>> {
    let model = readable_model(&state, &ctx, &dashboard_id).await?;
    let query = model.annotations.iter().find(|a| a.id == query_id).ok_or_else(ApiError::not_found)?;
    check_range(req.time_range)?;
    check_variables(&req.variables)?;
    let (variables, identifiers) = resolve_variables(&model, &req.variables)?;
    let item = QueryItem {
        ref_id: query.id.clone(),
        datasource_id: query.datasource_id.clone(),
        query: query.query.clone(),
        cursor: None,
        limit: None,
    };
    let response =
        run_queries_with(&state, &ctx, vec![item], req.time_range, None, None, &variables, Some(&identifiers)).await;
    Ok(Json(response))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spans_must_not_run_backwards_or_off_the_calendar() {
        assert!(check_span(10, None).is_ok() && check_span(10, Some(10)).is_ok());
        assert_eq!(check_span(10, Some(9)).unwrap_err().field, Some("timeEnd"));
        assert_eq!(check_span(MAX_TIME_MS + 1, None).unwrap_err().field, Some("time"));
        assert!(clean_annotation_text("  \n ").is_err());
        assert_eq!(clean_annotation_text(" Release 2.1\nmit Fix ").unwrap(), "Release 2.1\nmit Fix");
    }
}
