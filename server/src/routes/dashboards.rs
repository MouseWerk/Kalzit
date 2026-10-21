//! Dashboards: list, create, read, save (every save is a new version), trash, restore, purge and
//! the version history.

use axum::extract::{Path, State};
use axum::http::{Method, StatusCode};
use axum::response::IntoResponse;
use axum::{Extension, Json};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::folders::double_option;
use super::new_id;
use super::table::{RouteDef, route};
use crate::app::AppState;
use crate::audit::{self, AuditEvent};
use crate::authz::{self, Access, OrgCtx, Permission, Resource};
use crate::dashboards::{check_dashboard_sources, model};
use crate::error::{ApiError, ApiResult};
use crate::extract::JsonBody;
use crate::folders::{self, Tree};
use crate::net::RequestInfo;
use crate::paging::{self, QueryParams};
use crate::settings;
use crate::shapes::Page;

const MAX_MESSAGE_CHARS: usize = 500;

pub fn routes() -> Vec<RouteDef> {
    use Permission::{DashboardsDelete, DashboardsRead, DashboardsWrite};
    vec![
        route(Method::GET, "/orgs/{orgId}/dashboards", Access::Org(DashboardsRead), list),
        route(Method::POST, "/orgs/{orgId}/dashboards", Access::Org(DashboardsWrite), create),
        route(Method::GET, "/orgs/{orgId}/dashboards/{dashboardId}", Access::Org(DashboardsRead), get_one),
        route(Method::PUT, "/orgs/{orgId}/dashboards/{dashboardId}", Access::Org(DashboardsWrite), save),
        route(Method::DELETE, "/orgs/{orgId}/dashboards/{dashboardId}", Access::Org(DashboardsDelete), trash),
        route(Method::POST, "/orgs/{orgId}/dashboards/{dashboardId}/restore", Access::Org(DashboardsDelete), restore),
        route(Method::DELETE, "/orgs/{orgId}/dashboards/{dashboardId}/purge", Access::Org(DashboardsDelete), purge),
        route(Method::GET, "/orgs/{orgId}/dashboards/{dashboardId}/versions", Access::Org(DashboardsRead), versions),
        route(
            Method::GET,
            "/orgs/{orgId}/dashboards/{dashboardId}/versions/{version}",
            Access::Org(DashboardsRead),
            version,
        ),
        route(
            Method::POST,
            "/orgs/{orgId}/dashboards/{dashboardId}/versions/{version}/restore",
            Access::Org(DashboardsWrite),
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
    folder_id: Option<String>,
    title: String,
    version: i64,
    created_at: i64,
    updated_at: i64,
    updated_by: Option<String>,
    deleted_at: Option<i64>,
}

impl From<&DashboardRow> for DashboardSummary {
    fn from(r: &DashboardRow) -> Self {
        Self {
            id: r.id.clone(),
            folder_id: r.folder_id.clone(),
            title: r.title.clone(),
            version: r.version,
            created_at: r.created_at,
            updated_at: r.updated_at,
            updated_by: r.updated_by.clone(),
            deleted_at: r.deleted_at,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Dashboard {
    id: String,
    folder_id: Option<String>,
    title: String,
    version: i64,
    /// Migrated to the current `schemaVersion`.
    model: Value,
    created_at: i64,
    created_by: Option<String>,
    updated_at: i64,
    updated_by: Option<String>,
    deleted_at: Option<i64>,
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

fn conflict(message: &str) -> ApiError {
    ApiError::new(StatusCode::CONFLICT, "conflict", message)
}

async fn fetch(db: &sqlx::AnyPool, org_id: &str, id: &str) -> ApiResult<Option<DashboardRow>> {
    Ok(sqlx::query_as(sqlx::AssertSqlSafe(format!("SELECT {COLUMNS} FROM dashboards WHERE org_id = $1 AND id = $2")))
        .bind(org_id)
        .bind(id)
        .fetch_optional(db)
        .await?)
}

/// The dashboard in the path, if the caller sees it (its folder is visible) and may do
/// `permission` on it.
async fn load(state: &AppState, ctx: &OrgCtx, id: &str, permission: Permission) -> ApiResult<DashboardRow> {
    let row = fetch(&state.db, &ctx.org_id, id).await?.ok_or_else(ApiError::not_found)?;
    folders::ensure_visible(&state.db, ctx, row.folder_id.as_deref()).await?;
    authz::check_resource(&state.db, ctx, permission, Resource::Dashboard(id)).await?;
    Ok(row)
}

/// Before the transaction: a folder named in a body is in this organization, visible, and the
/// caller may put dashboards there.
async fn authorize_folder(state: &AppState, ctx: &OrgCtx, folder_id: &str) -> ApiResult<()> {
    folders::ensure_visible(&state.db, ctx, Some(folder_id)).await?;
    authz::check_resource(&state.db, ctx, Permission::DashboardsWrite, Resource::Folder(folder_id)).await
}

/// Inside a transaction that took `folders::lock_structure`: the folder still exists and is not
/// in the trash, so no live dashboard ends up in a trashed or purged folder.
async fn lock_live_folder(conn: &mut sqlx::AnyConnection, org_id: &str, folder_id: &str) -> ApiResult<()> {
    folders::lock_structure(conn, org_id).await?;
    let row: Option<(Option<i64>,)> = sqlx::query_as("SELECT deleted_at FROM folders WHERE org_id = $1 AND id = $2")
        .bind(org_id)
        .bind(folder_id)
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

async fn view(state: &AppState, row: DashboardRow) -> ApiResult<Dashboard> {
    let raw = model_at(&state.db, &row.id, row.version).await?.ok_or_else(|| {
        ApiError::internal("dashboards", format!("dashboard {} lacks its version {}", row.id, row.version))
    })?;
    Ok(Dashboard {
        model: stored_model(&raw)?,
        id: row.id,
        folder_id: row.folder_id,
        title: row.title,
        version: row.version,
        created_at: row.created_at,
        created_by: row.created_by,
        updated_at: row.updated_at,
        updated_by: row.updated_by,
        deleted_at: row.deleted_at,
    })
}

fn parse_model(raw: Value) -> ApiResult<model::DashboardModel> {
    model::parse(raw).map_err(|e| ApiError::validation(e).with_field("model"))
}

fn clean_message(raw: Option<&str>) -> ApiResult<String> {
    let message = raw.unwrap_or("").trim();
    let invalid = message.chars().count() > MAX_MESSAGE_CHARS || message.chars().any(|c| c.is_control() && c != '\n');
    if invalid {
        return Err(ApiError::validation(format!(
            "message takes up to {MAX_MESSAGE_CHARS} characters without control characters"
        ))
        .with_field("message"));
    }
    Ok(message.to_string())
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

/// Deletes the dashboards of one folder with their versions, inside the caller's transaction.
pub(super) async fn purge_in_folder(conn: &mut sqlx::AnyConnection, org_id: &str, folder_id: &str) -> ApiResult<()> {
    sqlx::query(
        "DELETE FROM dashboard_versions WHERE dashboard_id IN \
         (SELECT id FROM dashboards WHERE org_id = $1 AND folder_id = $2)",
    )
    .bind(org_id)
    .bind(folder_id)
    .execute(&mut *conn)
    .await?;
    sqlx::query("DELETE FROM dashboards WHERE org_id = $1 AND folder_id = $2")
        .bind(org_id)
        .bind(folder_id)
        .execute(&mut *conn)
        .await?;
    Ok(())
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

/// Ordered by title, then id. Dashboards in folders the caller does not see are left out by the
/// query itself, so every page is full.
async fn list(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    QueryParams(q): QueryParams<ListQuery>,
) -> ApiResult<Json<Page<DashboardSummary>>> {
    let limit = paging::limit(q.limit)?;
    let after: Option<(String, String)> = paging::decode_cursor(q.cursor.as_deref())?;
    if let Some(folder) = q.folder_id.as_deref() {
        let tree = Tree::load(&state.db, &ctx.org_id).await?;
        if !tree.rows.contains_key(folder) || !tree.visible(&ctx, folder) {
            return Err(ApiError::not_found());
        }
    }
    // Lower case by Unicode rules on both sides: `search_title` is written by the server.
    let pattern = q.q.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(|s| like_contains(&s.to_lowercase()));
    let (after_title, after_id) = after.unzip();
    let mut items: Vec<DashboardSummary> = sqlx::query_as::<_, DashboardRow>(sqlx::AssertSqlSafe(format!(
        "{} SELECT {COLUMNS} FROM dashboards WHERE org_id = $1 \
         AND ((CAST($2 AS BIGINT) = 1 AND deleted_at IS NOT NULL) OR (CAST($2 AS BIGINT) = 0 AND deleted_at IS NULL)) \
         AND (CAST($3 AS TEXT) IS NULL OR folder_id = $3) \
         AND (CAST($4 AS TEXT) IS NULL OR search_title LIKE $4 ESCAPE '\\') \
         AND (CAST($5 AS BIGINT) = 1 OR folder_id IS NULL OR folder_id NOT IN (SELECT id FROM hidden_folders)) \
         AND (CAST($6 AS TEXT) IS NULL OR title > $6 OR (title = $6 AND id > $7)) \
         ORDER BY title, id LIMIT $8",
        folders::HIDDEN_FOLDERS_CTE
    )))
    .bind(&ctx.org_id)
    .bind(q.trashed.unwrap_or(false) as i64)
    .bind(q.folder_id.as_deref())
    .bind(pattern.as_deref())
    .bind(folders::sees_restricted(&ctx) as i64)
    .bind(after_title.as_deref())
    .bind(after_id.as_deref())
    .bind(limit as i64 + 1)
    .fetch_all(&state.db)
    .await?
    .iter()
    .map(DashboardSummary::from)
    .collect();
    let more = items.len() > limit;
    items.truncate(limit);
    let next_cursor = match items.last() {
        Some(last) if more => Some(paging::encode_cursor(&(&last.title, &last.id))),
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
    let model = parse_model(body.model)?;
    let message = clean_message(body.message.as_deref())?;
    if let Some(folder) = body.folder_id.as_deref() {
        authorize_folder(&state, &ctx, folder).await?;
    }
    check_dashboard_sources(&state.db, &ctx, &model).await?;

    let id = new_id();
    let keep = version_retention(&state).await?;
    let now = state.clock.now_ms();
    let mut tx = state.db.begin().await?;
    if let Some(folder) = body.folder_id.as_deref() {
        lock_live_folder(&mut tx, &ctx.org_id, folder).await?;
    }
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
    Ok((StatusCode::CREATED, Json(view(&state, row).await?)))
}

async fn get_one(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Path((_, id)): Path<(String, String)>,
) -> ApiResult<Json<Dashboard>> {
    let row = load(&state, &ctx, &id, Permission::DashboardsRead).await?;
    Ok(Json(view(&state, row).await?))
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

/// Writes a new version on top of `row` (which must still be the stored version). Answers the
/// saved dashboard, or the version conflict with the stored one.
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
    let mut tx = state.db.begin().await?;
    if folder_id != row.folder_id.as_deref()
        && let Some(folder) = folder_id
    {
        lock_live_folder(&mut tx, &ctx.org_id, folder).await?;
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
        return Err(ApiError::version_conflict(json!(view(state, stored).await?)));
    }
    insert_version(&mut tx, &row.id, next, &ctx.user.id, &new, keep, now).await?;
    let (action, summary) = match new.restored_from {
        Some(from) => ("dashboard.version_restored", json!({ "version": next, "restoredFrom": from })),
        None => ("dashboard.saved", json!({ "version": next, "moved": folder_id != row.folder_id.as_deref() })),
    };
    audit::record(&mut tx, &event(ctx, info, action, &row.id, summary, now)).await?;
    tx.commit().await?;
    let saved = fetch(&state.db, &ctx.org_id, &row.id).await?.ok_or_else(ApiError::not_found)?;
    view(state, saved).await
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
    let folder_id = match body.folder_id {
        Some(folder) => folder,
        None => row.folder_id.clone(),
    };
    if folder_id != row.folder_id
        && let Some(folder) = folder_id.as_deref()
    {
        authorize_folder(&state, &ctx, folder).await?;
    }
    if body.version != row.version {
        return Err(ApiError::version_conflict(json!(view(&state, row).await?)));
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
        return Ok(Json(view(&state, row).await?));
    }
    let now = state.clock.now_ms();
    let mut tx = state.db.begin().await?;
    if let Some(folder) = row.folder_id.as_deref() {
        match lock_live_folder(&mut tx, &ctx.org_id, folder).await {
            Ok(()) => {}
            Err(e) if e.code == "validation" => {
                return Err(conflict("the folder is in the trash; restore the folder first"));
            }
            Err(e) => return Err(e),
        }
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
    Ok(Json(view(&state, row).await?))
}

async fn purge(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    Path((_, id)): Path<(String, String)>,
) -> ApiResult<StatusCode> {
    let row = load(&state, &ctx, &id, Permission::DashboardsDelete).await?;
    if row.deleted_at.is_none() {
        return Err(conflict("only dashboards in the trash can be purged; move it to the trash first"));
    }
    let now = state.clock.now_ms();
    let mut tx = state.db.begin().await?;
    sqlx::query("DELETE FROM dashboard_versions WHERE dashboard_id = $1").bind(&id).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM dashboards WHERE org_id = $1 AND id = $2")
        .bind(&ctx.org_id)
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    // Grants on this dashboard (resource_grants, migration 0003) are deleted here as well once
    // both streams are merged; the orchestrator adds that statement.
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
    let limit = paging::limit(q.limit)?;
    let before: Option<i64> = paging::decode_cursor(q.cursor.as_deref())?;
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
        Some(last) if more => Some(paging::encode_cursor(&last.version)),
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
