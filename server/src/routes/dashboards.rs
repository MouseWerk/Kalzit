//! Dashboards: list, create, read, save (every save is a new version), trash, restore, purge and
//! the version history.
//!
//! Access is decided per dashboard (`authz::check_resource`), so grants extend a member's rights
//! beyond their role; the routes other than the list only require membership. What lives at the
//! top level, outside every folder, needs the org-wide permission.

use axum::extract::{Path, State};
use axum::http::{Method, StatusCode};
use axum::response::IntoResponse;
use axum::{Extension, Json};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::folders::{ResourceAccess, double_option};
use super::new_id;
use super::support::{QueryParams, clean_text, conflict, decode_cursor, encode_cursor, page_limit};
use super::table::{RouteDef, route};
use crate::app::AppState;
use crate::audit::{self, AuditEvent};
use crate::authz::{self, Access, AccessIndex, OrgCtx, Permission, Resource};
use crate::dashboards::{check_dashboard_sources, model};
use crate::error::{ApiError, ApiResult};
use crate::extract::JsonBody;
use crate::folders::{self, Tree};
use crate::net::RequestInfo;
use crate::settings;
use crate::shapes::Page;

const MAX_MESSAGE_CHARS: usize = 500;

pub fn routes() -> Vec<RouteDef> {
    use Access::OrgMember;
    vec![
        route(Method::GET, "/orgs/{orgId}/dashboards", Access::Org(Permission::DashboardsRead), list),
        route(Method::POST, "/orgs/{orgId}/dashboards", OrgMember, create),
        route(Method::GET, "/orgs/{orgId}/dashboards/{dashboardId}", OrgMember, get_one),
        route(Method::PUT, "/orgs/{orgId}/dashboards/{dashboardId}", OrgMember, save),
        route(Method::DELETE, "/orgs/{orgId}/dashboards/{dashboardId}", OrgMember, trash),
        route(Method::POST, "/orgs/{orgId}/dashboards/{dashboardId}/restore", OrgMember, restore),
        route(Method::DELETE, "/orgs/{orgId}/dashboards/{dashboardId}/purge", OrgMember, purge),
        route(Method::GET, "/orgs/{orgId}/dashboards/{dashboardId}/versions", OrgMember, versions),
        route(Method::GET, "/orgs/{orgId}/dashboards/{dashboardId}/versions/{version}", OrgMember, version),
        route(
            Method::POST,
            "/orgs/{orgId}/dashboards/{dashboardId}/versions/{version}/restore",
            OrgMember,
            restore_version,
        ),
    ]
}

#[derive(Clone, Debug, sqlx::FromRow)]
struct DashboardRow {
    id: String,
    folder_id: Option<String>,
    title: String,
    version: i64,
    created_by: Option<String>,
    created_at: i64,
    updated_by: Option<String>,
    updated_at: i64,
    deleted_at: Option<i64>,
}

const COLUMNS: &str = "id, folder_id, title, version, created_by, created_at, updated_by, updated_at, deleted_at";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DashboardSummary {
    id: String,
    /// `null` at the top level, and when the caller cannot see the folder (they reach the
    /// dashboard through a grant on it alone).
    folder_id: Option<String>,
    title: String,
    version: i64,
    created_at: i64,
    updated_at: i64,
    updated_by: Option<String>,
    deleted_at: Option<i64>,
    access: ResourceAccess,
}

impl DashboardSummary {
    fn new(r: &DashboardRow, index: &AccessIndex) -> Self {
        Self {
            id: r.id.clone(),
            folder_id: visible_folder(r, index),
            title: r.title.clone(),
            version: r.version,
            created_at: r.created_at,
            updated_at: r.updated_at,
            updated_by: r.updated_by.clone(),
            deleted_at: r.deleted_at,
            access: ResourceAccess::dashboard(index.dashboard(&r.id, r.folder_id.as_deref())),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Dashboard {
    #[serde(flatten)]
    summary: DashboardSummary,
    /// Migrated to the current `schemaVersion`.
    model: Value,
    created_by: Option<String>,
}

/// The folder as the caller sees it: `None` when it is hidden from them.
fn visible_folder(row: &DashboardRow, index: &AccessIndex) -> Option<String> {
    row.folder_id.clone().filter(|f| index.folder(f).is_some())
}

fn event<'a>(
    ctx: &'a OrgCtx,
    info: &RequestInfo,
    action: &'a str,
    id: &'a str,
    summary: Value,
    now: i64,
) -> AuditEvent<'a> {
    AuditEvent {
        org_id: Some(&ctx.org_id),
        actor_user_id: Some(&ctx.user.id),
        actor_address: Some(info.client_ip.to_string()),
        action,
        resource_type: Some("dashboard"),
        resource_id: Some(id),
        summary,
        at_ms: now,
    }
}

async fn fetch(db: &sqlx::AnyPool, org_id: &str, id: &str) -> ApiResult<Option<DashboardRow>> {
    Ok(sqlx::query_as(sqlx::AssertSqlSafe(format!("SELECT {COLUMNS} FROM dashboards WHERE org_id = $1 AND id = $2")))
        .bind(org_id)
        .bind(id)
        .fetch_optional(db)
        .await?)
}

/// The dashboard in the path, if the caller sees it (`not_found` otherwise, also inside a
/// restricted folder without access) and may do `permission` on it.
async fn load(state: &AppState, ctx: &OrgCtx, id: &str, permission: Permission) -> ApiResult<DashboardRow> {
    let row = fetch(&state.db, &ctx.org_id, id).await?.ok_or_else(ApiError::not_found)?;
    authz::check_resource(&state.db, ctx, permission, Resource::Dashboard(id)).await?;
    Ok(row)
}

/// Before the transaction: the caller may put dashboards into `folder` (`None`: the top level,
/// which takes the org-wide permission).
async fn authorize_place(state: &AppState, ctx: &OrgCtx, folder: Option<&str>) -> ApiResult<()> {
    match folder {
        Some(folder) => {
            authz::check_resource(&state.db, ctx, Permission::DashboardsWrite, Resource::Folder(folder)).await
        }
        None => ctx.check(Permission::DashboardsWrite),
    }
}

/// Locks the organization (`authz::lock_org`, first statement of the transaction) and, for a
/// folder, checks that it still exists and is not in the trash, so no live dashboard ends up in a
/// trashed or purged folder.
async fn lock_place(conn: &mut sqlx::AnyConnection, org_id: &str, folder: Option<&str>) -> ApiResult<()> {
    authz::lock_org(conn, org_id).await?;
    let Some(folder) = folder else { return Ok(()) };
    let row: Option<(Option<i64>,)> = sqlx::query_as("SELECT deleted_at FROM folders WHERE org_id = $1 AND id = $2")
        .bind(org_id)
        .bind(folder)
        .fetch_optional(&mut *conn)
        .await?;
    match row {
        None => Err(ApiError::not_found()),
        Some((Some(_),)) => Err(ApiError::validation("the folder is in the trash").with_field("folderId")),
        Some((None,)) => Ok(()),
    }
}

fn stored_model(raw: &str) -> ApiResult<Value> {
    let value: Value = serde_json::from_str(raw).map_err(|e| ApiError::internal("dashboards", e))?;
    // A model this server cannot read (written by a newer version) is an operator problem.
    model::migrate(value).map_err(|e| ApiError::internal("dashboards", e))
}

async fn model_at(db: &sqlx::AnyPool, dashboard_id: &str, version: i64) -> ApiResult<Option<String>> {
    let row: Option<(String,)> =
        sqlx::query_as("SELECT model FROM dashboard_versions WHERE dashboard_id = $1 AND version = $2")
            .bind(dashboard_id)
            .bind(version)
            .fetch_optional(db)
            .await?;
    Ok(row.map(|(m,)| m))
}

/// The answer for one dashboard, read outside any transaction.
async fn view(state: &AppState, ctx: &OrgCtx, row: DashboardRow) -> ApiResult<Dashboard> {
    let raw = model_at(&state.db, &row.id, row.version).await?.ok_or_else(|| {
        ApiError::internal("dashboards", format!("dashboard {} lacks its version {}", row.id, row.version))
    })?;
    let index = AccessIndex::load(&mut *state.db.acquire().await?, ctx).await?;
    Ok(Dashboard {
        summary: DashboardSummary::new(&row, &index),
        model: stored_model(&raw)?,
        created_by: row.created_by,
    })
}

fn parse_model(raw: Value) -> ApiResult<model::DashboardModel> {
    model::parse(raw).map_err(|e| ApiError::validation(e).with_field("model"))
}

fn clean_message(raw: Option<&str>) -> ApiResult<String> {
    clean_text(raw.unwrap_or(""), "message", MAX_MESSAGE_CHARS).map_err(|e| e.with_field("message"))
}

/// One save: what goes into the new version row.
struct NewVersion<'a> {
    model: &'a model::DashboardModel,
    message: &'a str,
    /// The version this one brings back, for a restore.
    restored_from: Option<i64>,
}

/// How many versions to keep per dashboard (0: all). Read before the transaction opens, so the
/// lookup never waits for a second connection while the transaction holds one.
async fn version_retention(state: &AppState) -> ApiResult<i64> {
    Ok(settings::get(state, "dashboards.version_retention").await?.as_i64().unwrap_or(0))
}

/// Writes version `version` by `author` and drops versions beyond `keep`.
async fn insert_version(
    conn: &mut sqlx::AnyConnection,
    dashboard_id: &str,
    version: i64,
    author: &str,
    new: &NewVersion<'_>,
    keep: i64,
    now: i64,
) -> ApiResult<()> {
    let text = serde_json::to_string(new.model).map_err(|e| ApiError::internal("dashboards", e))?;
    sqlx::query(
        "INSERT INTO dashboard_versions (dashboard_id, version, model, message, author_id, restored_from, created_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $7)",
    )
    .bind(dashboard_id)
    .bind(version)
    .bind(&text)
    .bind(new.message)
    .bind(author)
    .bind(new.restored_from)
    .bind(now)
    .execute(&mut *conn)
    .await?;
    if keep > 0 {
        sqlx::query("DELETE FROM dashboard_versions WHERE dashboard_id = $1 AND version <= $2")
            .bind(dashboard_id)
            .bind(version - keep)
            .execute(&mut *conn)
            .await?;
    }
    Ok(())
}

/// Deletes the dashboards of one folder with their versions and grants, inside the caller's
/// transaction. Answers how many dashboards went.
pub(super) async fn purge_in_folder(conn: &mut sqlx::AnyConnection, org_id: &str, folder_id: &str) -> ApiResult<u64> {
    sqlx::query(
        "DELETE FROM resource_grants WHERE org_id = $1 AND resource_type = 'dashboard' AND resource_id IN \
         (SELECT id FROM dashboards WHERE org_id = $1 AND folder_id = $2)",
    )
    .bind(org_id)
    .bind(folder_id)
    .execute(&mut *conn)
    .await?;
    sqlx::query(
        "DELETE FROM dashboard_versions WHERE dashboard_id IN \
         (SELECT id FROM dashboards WHERE org_id = $1 AND folder_id = $2)",
    )
    .bind(org_id)
    .bind(folder_id)
    .execute(&mut *conn)
    .await?;
    let gone = sqlx::query("DELETE FROM dashboards WHERE org_id = $1 AND folder_id = $2")
        .bind(org_id)
        .bind(folder_id)
        .execute(&mut *conn)
        .await?
        .rows_affected();
    Ok(gone)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ListQuery {
    folder_id: Option<String>,
    /// Part of the title, any case.
    q: Option<String>,
    /// `true` lists the trash instead.
    trashed: Option<bool>,
    limit: Option<u32>,
    cursor: Option<String>,
}

/// `%`, `_` and `\` match themselves in a `LIKE ... ESCAPE '\'` pattern.
fn like_contains(needle: &str) -> String {
    let escaped = needle.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_");
    format!("%{escaped}%")
}

/// Ordered by title, then id. Dashboards the caller does not see (in a restricted folder without
/// access, and no grant on the dashboard itself) are left out by the query itself, so every page
/// is full.
async fn list(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    QueryParams(q): QueryParams<ListQuery>,
) -> ApiResult<Json<Page<DashboardSummary>>> {
    let limit = page_limit(q.limit)? as usize;
    let after: Option<(String, String)> = decode_cursor(q.cursor.as_deref())?;
    let mut conn = state.db.acquire().await?;
    if let Some(folder) = q.folder_id.as_deref() {
        let tree = Tree::load(&mut conn, &ctx).await?;
        if !tree.rows.contains_key(folder) || !tree.visible(folder) {
            return Err(ApiError::not_found());
        }
    }
    let index = AccessIndex::load(&mut conn, &ctx).await?;
    // Lower case by Unicode rules on both sides: `search_title` is written by the server.
    let pattern = q.q.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(|s| like_contains(&s.to_lowercase()));
    let (after_title, after_id) = after.unzip();
    let rows: Vec<DashboardRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "{} SELECT {COLUMNS} FROM dashboards WHERE org_id = $1 \
         AND ((CAST($5 AS BIGINT) = 1 AND deleted_at IS NOT NULL) OR (CAST($5 AS BIGINT) = 0 AND deleted_at IS NULL)) \
         AND (CAST($6 AS TEXT) IS NULL OR folder_id = $6) \
         AND (CAST($7 AS TEXT) IS NULL OR search_title LIKE $7 ESCAPE '\\') \
         AND (folder_id IS NULL OR folder_id NOT IN (SELECT id FROM hidden_folders) \
              OR id IN (SELECT resource_id FROM caller_grants WHERE resource_type = 'dashboard')) \
         AND (CAST($8 AS TEXT) IS NULL OR title > $8 OR (title = $8 AND id > $9)) \
         ORDER BY title, id LIMIT $10",
        folders::VISIBILITY_CTE
    )))
    .bind(&ctx.org_id)
    .bind(&ctx.user.id)
    .bind(&ctx.role)
    .bind(folders::sees_every_folder(&ctx))
    .bind(q.trashed.unwrap_or(false) as i64)
    .bind(q.folder_id.as_deref())
    .bind(pattern.as_deref())
    .bind(after_title.as_deref())
    .bind(after_id.as_deref())
    .bind(limit as i64 + 1)
    .fetch_all(&mut *conn)
    .await?;
    let mut items: Vec<DashboardSummary> = rows.iter().map(|r| DashboardSummary::new(r, &index)).collect();
    let more = items.len() > limit;
    items.truncate(limit);
    let next_cursor = match items.last() {
        Some(last) if more => Some(encode_cursor(&(&last.title, &last.id))),
        _ => None,
    };
    Ok(Json(Page { items, next_cursor }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateDashboard {
    #[serde(default)]
    folder_id: Option<String>,
    model: Value,
    #[serde(default)]
    message: Option<String>,
}

async fn create(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    JsonBody(body): JsonBody<CreateDashboard>,
) -> ApiResult<impl IntoResponse> {
    let mut raw = body.model;
    // A new dashboard without a time range starts with the organization's default.
    if let Some(fields) = raw.as_object_mut()
        && !fields.contains_key("timeRange")
    {
        let default = settings::get_org(&state, &ctx.org_id, "dashboards.default_time_range").await?;
        fields.insert("timeRange".into(), default);
    }
    let model = parse_model(raw)?;
    let message = clean_message(body.message.as_deref())?;
    authorize_place(&state, &ctx, body.folder_id.as_deref()).await?;
    check_dashboard_sources(&state.db, &ctx, &model).await?;

    let id = new_id();
    let keep = version_retention(&state).await?;
    let now = state.clock.now_ms();
    let mut tx = state.db.begin().await?;
    lock_place(&mut tx, &ctx.org_id, body.folder_id.as_deref()).await?;
    sqlx::query(
        "INSERT INTO dashboards (id, org_id, folder_id, title, search_title, version, created_by, created_at, \
         updated_by, updated_at) VALUES ($1, $2, $3, $4, $5, 1, $6, $7, $6, $7)",
    )
    .bind(&id)
    .bind(&ctx.org_id)
    .bind(body.folder_id.as_deref())
    .bind(&model.title)
    .bind(model.title.to_lowercase())
    .bind(&ctx.user.id)
    .bind(now)
    .execute(&mut *tx)
    .await?;
    let new = NewVersion { model: &model, message: &message, restored_from: None };
    insert_version(&mut tx, &id, 1, &ctx.user.id, &new, keep, now).await?;
    let summary = json!({ "folderId": body.folder_id, "version": 1 });
    audit::record(&mut tx, &event(&ctx, &info, "dashboard.created", &id, summary, now)).await?;
    tx.commit().await?;
    let row = fetch(&state.db, &ctx.org_id, &id).await?.ok_or_else(ApiError::not_found)?;
    Ok((StatusCode::CREATED, Json(view(&state, &ctx, row).await?)))
}

async fn get_one(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Path((_, id)): Path<(String, String)>,
) -> ApiResult<Json<Dashboard>> {
    let row = load(&state, &ctx, &id, Permission::DashboardsRead).await?;
    Ok(Json(view(&state, &ctx, row).await?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveDashboard {
    model: Value,
    version: i64,
    #[serde(default)]
    message: Option<String>,
    /// Moves the dashboard; `null` is the top level, a missing field keeps the folder.
    #[serde(default, deserialize_with = "double_option")]
    folder_id: Option<Option<String>>,
}

/// Writes a new version on top of `row` (which must still be the stored version), in `folder_id`.
/// Answers the saved dashboard, or the version conflict with the stored one.
async fn write_version(
    state: &AppState,
    ctx: &OrgCtx,
    info: &RequestInfo,
    row: &DashboardRow,
    folder_id: Option<&str>,
    new: NewVersion<'_>,
) -> ApiResult<Dashboard> {
    let keep = version_retention(state).await?;
    let now = state.clock.now_ms();
    let next = row.version + 1;
    let moved = folder_id != row.folder_id.as_deref();
    let mut tx = state.db.begin().await?;
    if moved {
        lock_place(&mut tx, &ctx.org_id, folder_id).await?;
    }
    let updated = sqlx::query(
        "UPDATE dashboards SET title = $1, search_title = $2, folder_id = $3, version = $4, updated_by = $5, \
         updated_at = $6 WHERE org_id = $7 AND id = $8 AND version = $9 AND deleted_at IS NULL",
    )
    .bind(&new.model.title)
    .bind(new.model.title.to_lowercase())
    .bind(folder_id)
    .bind(next)
    .bind(&ctx.user.id)
    .bind(now)
    .bind(&ctx.org_id)
    .bind(&row.id)
    .bind(row.version)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if updated == 0 {
        drop(tx);
        let stored = load(state, ctx, &row.id, Permission::DashboardsRead).await?;
        if stored.deleted_at.is_some() {
            return Err(conflict("the dashboard is in the trash; restore it first"));
        }
        return Err(ApiError::version_conflict(json!(view(state, ctx, stored).await?)));
    }
    insert_version(&mut tx, &row.id, next, &ctx.user.id, &new, keep, now).await?;
    let (action, summary) = match new.restored_from {
        Some(from) => ("dashboard.version_restored", json!({ "version": next, "restoredFrom": from })),
        None => ("dashboard.saved", json!({ "version": next, "moved": moved })),
    };
    audit::record(&mut tx, &event(ctx, info, action, &row.id, summary, now)).await?;
    tx.commit().await?;
    let saved = fetch(&state.db, &ctx.org_id, &row.id).await?.ok_or_else(ApiError::not_found)?;
    view(state, ctx, saved).await
}

async fn save(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    Path((_, id)): Path<(String, String)>,
    JsonBody(body): JsonBody<SaveDashboard>,
) -> ApiResult<Json<Dashboard>> {
    let row = load(&state, &ctx, &id, Permission::DashboardsWrite).await?;
    if row.deleted_at.is_some() {
        return Err(conflict("the dashboard is in the trash; restore it first"));
    }
    let model = parse_model(body.model)?;
    let message = clean_message(body.message.as_deref())?;
    // The caller names the folder as they see it; a folder hidden from them reads as `null`, and
    // sending that back unchanged is no move.
    let index = AccessIndex::load(&mut *state.db.acquire().await?, &ctx).await?;
    let folder_id = match body.folder_id {
        Some(folder) if folder != visible_folder(&row, &index) => folder,
        _ => row.folder_id.clone(),
    };
    if folder_id != row.folder_id {
        authorize_place(&state, &ctx, folder_id.as_deref()).await?;
    }
    if body.version != row.version {
        return Err(ApiError::version_conflict(json!(view(&state, &ctx, row).await?)));
    }
    check_dashboard_sources(&state.db, &ctx, &model).await?;
    let new = NewVersion { model: &model, message: &message, restored_from: None };
    Ok(Json(write_version(&state, &ctx, &info, &row, folder_id.as_deref(), new).await?))
}

async fn trash(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    Path((_, id)): Path<(String, String)>,
) -> ApiResult<StatusCode> {
    let row = load(&state, &ctx, &id, Permission::DashboardsDelete).await?;
    if row.deleted_at.is_some() {
        return Ok(StatusCode::NO_CONTENT);
    }
    let now = state.clock.now_ms();
    let mut tx = state.db.begin().await?;
    sqlx::query(
        "UPDATE dashboards SET deleted_at = $1, trash_batch = $2 WHERE org_id = $3 AND id = $4 AND deleted_at IS NULL",
    )
    .bind(now)
    .bind(new_id())
    .bind(&ctx.org_id)
    .bind(&id)
    .execute(&mut *tx)
    .await?;
    audit::record(&mut tx, &event(&ctx, &info, "dashboard.trashed", &id, json!({}), now)).await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn restore(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    Path((_, id)): Path<(String, String)>,
) -> ApiResult<Json<Dashboard>> {
    let row = load(&state, &ctx, &id, Permission::DashboardsDelete).await?;
    if row.deleted_at.is_none() {
        return Ok(Json(view(&state, &ctx, row).await?));
    }
    let now = state.clock.now_ms();
    let mut tx = state.db.begin().await?;
    // The lock orders this against a purge of the dashboard or its folder: whichever comes
    // second sees what the first left.
    match lock_place(&mut tx, &ctx.org_id, row.folder_id.as_deref()).await {
        Ok(()) => {}
        Err(e) if e.code == "validation" => {
            return Err(conflict("the folder is in the trash; restore the folder first"));
        }
        Err(e) => return Err(e),
    }
    let restored = sqlx::query(
        "UPDATE dashboards SET deleted_at = NULL, trash_batch = NULL \
         WHERE org_id = $1 AND id = $2 AND deleted_at IS NOT NULL",
    )
    .bind(&ctx.org_id)
    .bind(&id)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if restored == 1 {
        audit::record(&mut tx, &event(&ctx, &info, "dashboard.restored", &id, json!({}), now)).await?;
        tx.commit().await?;
    } else {
        // Restored or purged by someone else meanwhile: answer what is stored now.
        drop(tx);
    }
    let row = fetch(&state.db, &ctx.org_id, &id).await?.ok_or_else(ApiError::not_found)?;
    Ok(Json(view(&state, &ctx, row).await?))
}

async fn purge(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    Path((_, id)): Path<(String, String)>,
) -> ApiResult<StatusCode> {
    let not_trashed = || conflict("only dashboards in the trash can be purged; move it to the trash first");
    let row = load(&state, &ctx, &id, Permission::DashboardsDelete).await?;
    if row.deleted_at.is_none() {
        return Err(not_trashed());
    }
    let now = state.clock.now_ms();
    let mut tx = state.db.begin().await?;
    // Restores and grant changes lock the organization too, so the state read here holds until
    // the commit: a dashboard restored since the check above stays.
    authz::lock_org(&mut tx, &ctx.org_id).await?;
    let current: Option<(Option<String>, Option<i64>)> =
        sqlx::query_as("SELECT folder_id, deleted_at FROM dashboards WHERE org_id = $1 AND id = $2")
            .bind(&ctx.org_id)
            .bind(&id)
            .fetch_optional(&mut *tx)
            .await?;
    let folder = match current {
        None => return Err(ApiError::not_found()),
        Some((_, None)) => return Err(not_trashed()),
        Some((folder, Some(_))) => folder,
    };
    if let Some(folder) = folder.as_deref()
        && folders::restricted_in(&mut tx, &ctx.org_id, folder).await?
    {
        // Restricted content keeps its audit events hidden once it is gone.
        folders::tombstone_dashboard(&mut tx, &ctx.org_id, &id).await?;
    }
    sqlx::query("DELETE FROM dashboard_versions WHERE dashboard_id = $1").bind(&id).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM resource_grants WHERE org_id = $1 AND resource_type = 'dashboard' AND resource_id = $2")
        .bind(&ctx.org_id)
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM dashboards WHERE org_id = $1 AND id = $2 AND deleted_at IS NOT NULL")
        .bind(&ctx.org_id)
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    audit::record(&mut tx, &event(&ctx, &info, "dashboard.purged", &id, json!({}), now)).await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct VersionSummary {
    version: i64,
    message: String,
    author_id: Option<String>,
    /// The author's current name; `null` once the account is removed.
    author_name: Option<String>,
    restored_from: Option<i64>,
    created_at: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Version {
    #[serde(flatten)]
    summary: VersionSummary,
    model: Value,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VersionsQuery {
    limit: Option<u32>,
    cursor: Option<String>,
}

const VERSION_COLUMNS: &str = "v.version, v.message, v.author_id, u.name AS author_name, v.restored_from, v.created_at";

/// Newest version first.
async fn versions(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Path((_, id)): Path<(String, String)>,
    QueryParams(q): QueryParams<VersionsQuery>,
) -> ApiResult<Json<Page<VersionSummary>>> {
    let limit = page_limit(q.limit)? as usize;
    let before: Option<i64> = decode_cursor(q.cursor.as_deref())?;
    load(&state, &ctx, &id, Permission::DashboardsRead).await?;
    let mut items: Vec<VersionSummary> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {VERSION_COLUMNS} FROM dashboard_versions v LEFT JOIN users u ON u.id = v.author_id \
         WHERE v.dashboard_id = $1 AND (CAST($2 AS BIGINT) IS NULL OR v.version < $2) \
         ORDER BY v.version DESC LIMIT $3"
    )))
    .bind(&id)
    .bind(before)
    .bind(limit as i64 + 1)
    .fetch_all(&state.db)
    .await?;
    let more = items.len() > limit;
    items.truncate(limit);
    let next_cursor = match items.last() {
        Some(last) if more => Some(encode_cursor(&last.version)),
        _ => None,
    };
    Ok(Json(Page { items, next_cursor }))
}

/// A version number as the API writes it: digits only, no sign, no leading zero, so one version
/// has exactly one path.
fn parse_version_number(raw: &str) -> Option<i64> {
    let canonical = !raw.is_empty() && raw.bytes().all(|b| b.is_ascii_digit()) && (raw == "0" || !raw.starts_with('0'));
    if canonical { raw.parse().ok() } else { None }
}

/// One stored version with its model, or `not_found` (also for a number that is not a number).
async fn load_version(state: &AppState, dashboard_id: &str, raw: &str) -> ApiResult<(VersionSummary, String)> {
    let number = parse_version_number(raw).ok_or_else(ApiError::not_found)?;
    #[derive(sqlx::FromRow)]
    struct Row {
        #[sqlx(flatten)]
        summary: VersionSummary,
        model: String,
    }
    let row: Option<Row> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {VERSION_COLUMNS}, v.model FROM dashboard_versions v LEFT JOIN users u ON u.id = v.author_id \
         WHERE v.dashboard_id = $1 AND v.version = $2"
    )))
    .bind(dashboard_id)
    .bind(number)
    .fetch_optional(&state.db)
    .await?;
    row.map(|r| (r.summary, r.model)).ok_or_else(ApiError::not_found)
}

async fn version(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Path((_, id, number)): Path<(String, String, String)>,
) -> ApiResult<Json<Version>> {
    load(&state, &ctx, &id, Permission::DashboardsRead).await?;
    let (summary, raw) = load_version(&state, &id, &number).await?;
    Ok(Json(Version { summary, model: stored_model(&raw)? }))
}

/// Saves an older version's model as a new version; the history keeps everything in between.
async fn restore_version(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    Path((_, id, number)): Path<(String, String, String)>,
) -> ApiResult<Json<Dashboard>> {
    let row = load(&state, &ctx, &id, Permission::DashboardsWrite).await?;
    if row.deleted_at.is_some() {
        return Err(conflict("the dashboard is in the trash; restore it first"));
    }
    let (summary, raw) = load_version(&state, &id, &number).await?;
    let stored: Value = serde_json::from_str(&raw).map_err(|e| ApiError::internal("dashboards", e))?;
    // Rules may have tightened since that version was saved; it must pass today's.
    let model = parse_model(stored)?;
    check_dashboard_sources(&state.db, &ctx, &model).await?;
    let new = NewVersion { model: &model, message: "", restored_from: Some(summary.version) };
    Ok(Json(write_version(&state, &ctx, &info, &row, row.folder_id.as_deref(), new).await?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_numbers_are_canonical() {
        assert_eq!(parse_version_number("12"), Some(12));
        assert_eq!(parse_version_number("0"), Some(0));
        for bad in ["+1", "01", "-1", "", " 1", "1e2", "99999999999999999999"] {
            assert_eq!(parse_version_number(bad), None, "{bad}");
        }
    }

    #[test]
    fn search_patterns_match_wildcards_literally() {
        assert_eq!(like_contains("50%_a\\b"), "%50\\%\\_a\\\\b%");
    }
}
