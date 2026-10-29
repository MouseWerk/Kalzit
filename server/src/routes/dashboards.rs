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

use super::folders::{
    OwnedItem, OwnerRequest, OwnerTeam, ResourceAccess, Visibility, check_owner_change, double_option, keep_access,
};
use super::new_id;
use super::support::{QueryParams, clean_text, conflict, decode_cursor, encode_cursor, page_limit};
use super::table::{RouteDef, route};
use crate::app::AppState;
use crate::audit::{self, AuditEvent};
use crate::authz::{self, Access, AccessIndex, OrgCtx, Permission, Resource};
use crate::dashboards::{check_dashboard_sources, library, model};
use crate::error::{ApiError, ApiResult};
use crate::extract::JsonBody;
use crate::folders::{self, Tree};
use crate::net::RequestInfo;
use crate::saved_analyses;
use crate::settings;
use crate::shapes::Page;

const MAX_MESSAGE_CHARS: usize = 500;

pub fn routes() -> Vec<RouteDef> {
    use Access::OrgMember;
    vec![
        route(Method::GET, "/orgs/{orgId}/dashboards", Access::Org(Permission::DashboardsRead), list),
        route(Method::POST, "/orgs/{orgId}/dashboards", OrgMember, create),
        route(Method::POST, "/orgs/{orgId}/dashboards/validate", OrgMember, validate),
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
        route(Method::PUT, "/orgs/{orgId}/dashboards/{dashboardId}/owner", OrgMember, set_owner).changes_rights(),
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
    /// The current version's tags, as a JSON array.
    tags: String,
    owner_team_id: Option<String>,
    team_only: i64,
}

const COLUMNS: &str = "id, folder_id, title, version, created_by, created_at, updated_by, updated_at, deleted_at, tags, \
     owner_team_id, team_only";

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
    tags: Vec<String>,
    access: ResourceAccess,
    /// The team that owns the dashboard; `null` when it belongs to the organization (it may still
    /// live in a team's folder).
    owner_team: Option<OwnerTeam>,
    /// Only the owner team, grants on the dashboard and org admins see it.
    team_only: bool,
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
            // Written by the server from a validated model; an unreadable value shows no tags.
            tags: serde_json::from_str(&r.tags).unwrap_or_default(),
            access: ResourceAccess::dashboard(index.dashboard(&r.id, r.folder_id.as_deref())),
            owner_team: OwnerTeam::of(r.owner_team_id.as_deref(), index),
            team_only: r.team_only != 0,
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
    /// The library panels the model references, by id; a deleted one is missing.
    library_panels: std::collections::BTreeMap<String, library::LinkedPanel>,
    /// The saved analyses the model links (`analysisId`), by id; a purged one is missing.
    analyses: std::collections::BTreeMap<String, saved_analyses::LinkedAnalysis>,
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

async fn fetch<'e, E: sqlx::Executor<'e, Database = sqlx::Any>>(
    db: E,
    org_id: &str,
    id: &str,
) -> ApiResult<Option<DashboardRow>> {
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
pub(super) async fn lock_place(conn: &mut sqlx::AnyConnection, org_id: &str, folder: Option<&str>) -> ApiResult<()> {
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

/// The stored model of the dashboard's current version.
async fn current_model(state: &AppState, row: &DashboardRow) -> ApiResult<model::DashboardModel> {
    let raw = model_at(&mut *state.db.acquire().await?, &row.id, row.version).await?.ok_or_else(|| {
        ApiError::internal("dashboards", format!("dashboard {} lacks its version {}", row.id, row.version))
    })?;
    model::parse(stored_model(&raw)?).map_err(|e| ApiError::internal("dashboards", e))
}

async fn model_at(conn: &mut sqlx::AnyConnection, dashboard_id: &str, version: i64) -> ApiResult<Option<String>> {
    let row: Option<(String,)> =
        sqlx::query_as("SELECT model FROM dashboard_versions WHERE dashboard_id = $1 AND version = $2")
            .bind(dashboard_id)
            .bind(version)
            .fetch_optional(&mut *conn)
            .await?;
    Ok(row.map(|(m,)| m))
}

/// The answer for one dashboard, read through `conn`: after a change, the change's own
/// transaction before its commit, so a failing read can still be answered as "nothing changed".
async fn view(conn: &mut sqlx::AnyConnection, ctx: &OrgCtx, row: DashboardRow) -> ApiResult<Dashboard> {
    let raw = model_at(conn, &row.id, row.version).await?.ok_or_else(|| {
        ApiError::internal("dashboards", format!("dashboard {} lacks its version {}", row.id, row.version))
    })?;
    let index = AccessIndex::load(conn, ctx).await?;
    let model = stored_model(&raw)?;
    let ids: std::collections::BTreeSet<&str> =
        model["panels"].as_array().into_iter().flatten().filter_map(|p| p["libraryPanelId"].as_str()).collect();
    let library_panels = library::linked_panels(conn, &ctx.org_id, &ids).await?;
    let linked: std::collections::BTreeSet<&str> =
        model["panels"].as_array().into_iter().flatten().filter_map(|p| p["analysisId"].as_str()).collect();
    let analyses = saved_analyses::linked_analyses(conn, &ctx.org_id, &linked).await?;
    Ok(Dashboard {
        summary: DashboardSummary::new(&row, &index),
        model,
        created_by: row.created_by,
        library_panels,
        analyses,
    })
}

/// `view` on a pooled connection, where no change is involved.
async fn pool_view(state: &AppState, ctx: &OrgCtx, row: DashboardRow) -> ApiResult<Dashboard> {
    view(&mut *state.db.acquire().await?, ctx, row).await
}

fn parse_model(raw: Value) -> ApiResult<model::DashboardModel> {
    model::parse(raw).map_err(|e| ApiError::validation(e).with_field("model"))
}

/// The panel option checks of a write, against the stored model it replaces (none for a new one).
/// The panels of plugins are checked against the options their manifest declares, as long as the
/// plugin may be shown (`plugins::panels::check_dashboard_options`).
fn check_panels(
    state: &AppState,
    model: &model::DashboardModel,
    previous: Option<&model::DashboardModel>,
) -> ApiResult<()> {
    model::check_panel_options(model, previous)
        .and_then(|()| crate::plugins::panels::check_dashboard_options(state.plugins.panels(), model, previous))
        .map_err(|(panel, detail)| {
            ApiError::validation(detail.clone())
                .with_field("model")
                .because("dashboards.panel_options")
                .param("panel", panel)
                .param("detail", detail)
        })
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
    /// Library panels this version references and the stored one did not; checked again under
    /// the organization's lock, so a library panel deleted meanwhile is not referenced.
    added_library: std::collections::BTreeSet<&'a str>,
    /// Saved analyses this version links and the stored one did not; checked again under the
    /// organization's lock, so an analysis trashed meanwhile is not linked.
    added_analyses: std::collections::BTreeSet<&'a str>,
}

/// The saved analyses `model` links that `previous` did not.
fn added_analyses<'a>(
    model: &'a model::DashboardModel,
    previous: Option<&model::DashboardModel>,
) -> std::collections::BTreeSet<&'a str> {
    let known = previous.map(model::DashboardModel::analysis_ids).unwrap_or_default();
    model.analysis_ids().into_iter().filter(|id| !known.contains(id)).collect()
}

/// The library panels `model` references that `previous` did not.
fn added_library<'a>(
    model: &'a model::DashboardModel,
    previous: Option<&model::DashboardModel>,
) -> std::collections::BTreeSet<&'a str> {
    let known = previous.map(model::DashboardModel::library_panel_ids).unwrap_or_default();
    model.library_panel_ids().into_iter().filter(|id| !known.contains(id)).collect()
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
    forget_removed_panels(conn, dashboard_id, new.model).await?;
    if keep > 0 {
        sqlx::query("DELETE FROM dashboard_versions WHERE dashboard_id = $1 AND version <= $2")
            .bind(dashboard_id)
            .bind(version - keep)
            .execute(&mut *conn)
            .await?;
    }
    Ok(())
}

/// Viewers' own state of panels the new version no longer has (`panel_state.rs`) goes with them.
async fn forget_removed_panels(
    conn: &mut sqlx::AnyConnection,
    dashboard_id: &str,
    model: &model::DashboardModel,
) -> ApiResult<()> {
    let ids: Vec<&str> = model.panels.iter().map(|p| p.id.as_str()).collect();
    let mut sql = String::from("DELETE FROM panel_view_state WHERE dashboard_id = $1");
    if !ids.is_empty() {
        let marks: Vec<String> = (0..ids.len()).map(|i| format!("${}", i + 2)).collect();
        sql.push_str(&format!(" AND panel_id NOT IN ({})", marks.join(", ")));
    }
    let mut query = sqlx::query(sqlx::AssertSqlSafe(sql)).bind(dashboard_id);
    for id in ids {
        query = query.bind(id);
    }
    query.execute(&mut *conn).await?;
    Ok(())
}

/// Deletes the dashboards of one folder with their versions and grants, inside the caller's
/// transaction. Answers how many dashboards went.
pub(super) async fn purge_in_folder(conn: &mut sqlx::AnyConnection, org_id: &str, folder_id: &str) -> ApiResult<u64> {
    // Dashboards that once lived in a restricted folder keep their events hidden (see `purge`).
    sqlx::query(
        "INSERT INTO restricted_tombstones (org_id, resource_type, resource_id) \
         SELECT d.org_id, 'dashboard', d.id FROM dashboards d WHERE d.org_id = $1 AND d.folder_id = $2 \
         AND d.ever_restricted = 1 AND NOT EXISTS (SELECT 1 FROM restricted_tombstones t \
         WHERE t.org_id = d.org_id AND t.resource_type = 'dashboard' AND t.resource_id = d.id)",
    )
    .bind(org_id)
    .bind(folder_id)
    .execute(&mut *conn)
    .await?;
    sqlx::query(
        "DELETE FROM resource_grants WHERE org_id = $1 AND resource_type = 'dashboard' AND resource_id IN \
         (SELECT id FROM dashboards WHERE org_id = $1 AND folder_id = $2)",
    )
    .bind(org_id)
    .bind(folder_id)
    .execute(&mut *conn)
    .await?;
    library::purge_dashboard_rows(conn, org_id, "d.folder_id = $2", folder_id).await?;
    // Library panels go with their folder; dashboards elsewhere that showed one say it is gone.
    sqlx::query(
        "DELETE FROM library_panel_uses WHERE library_panel_id IN \
         (SELECT id FROM library_panels WHERE org_id = $1 AND folder_id = $2)",
    )
    .bind(org_id)
    .bind(folder_id)
    .execute(&mut *conn)
    .await?;
    sqlx::query("DELETE FROM library_panels WHERE org_id = $1 AND folder_id = $2")
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
    /// Only dashboards with this tag, any case.
    tag: Option<String>,
    /// A team context: only dashboards outside other teams' spaces, in the team's own spaces and
    /// what was shared with the team (see `folders::TeamScope`).
    team: Option<String>,
    limit: Option<u32>,
    cursor: Option<String>,
}

/// `%`, `_` and `\` match themselves in a `LIKE ... ESCAPE '\'` pattern.
pub(super) fn like_contains(needle: &str) -> String {
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
    super::team_context::check_team(&mut conn, &ctx, q.team.as_deref()).await?;
    // Lower case by Unicode rules on both sides: `search_title` is written by the server.
    let pattern = q.q.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(|s| like_contains(&s.to_lowercase()));
    let (after_title, after_id) = after.unzip();
    // A team context (`$12`) leaves out other teams' spaces in the query itself, so pages stay full.
    let sql = format!(
        "{}{} SELECT {COLUMNS} FROM dashboards WHERE org_id = $1 \
         AND ((CAST($5 AS BIGINT) = 1 AND deleted_at IS NOT NULL) OR (CAST($5 AS BIGINT) = 0 AND deleted_at IS NULL)) \
         AND (CAST($6 AS TEXT) IS NULL OR folder_id = $6) \
         AND (CAST($7 AS TEXT) IS NULL OR search_title LIKE $7 ESCAPE '\\') \
         AND {} \
         AND (CAST($8 AS TEXT) IS NULL OR title > $8 OR (title = $8 AND id > $9)) \
         AND (CAST($11 AS TEXT) IS NULL OR id IN \
              (SELECT dashboard_id FROM dashboard_tags WHERE org_id = $1 AND tag_key = $11)) \
         AND (folder_id IS NULL OR folder_id NOT IN (SELECT id FROM scope_out) \
              OR id IN (SELECT resource_id FROM scope_grants WHERE resource_type = 'dashboard')) \
         ORDER BY title, id LIMIT $10",
        folders::VISIBILITY_CTE,
        folders::scope_cte(12),
        folders::dashboard_visible("dashboards"),
    );
    // Built from constants and parameter numbers only, so nothing from the request reaches the SQL.
    let rows: Vec<DashboardRow> = sqlx::query_as(sqlx::AssertSqlSafe(sql))
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
        .bind(q.tag.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(str::to_lowercase))
        .bind(q.team.as_deref())
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
    check_panels(&state, &model, None)?;
    let message = clean_message(body.message.as_deref())?;
    authorize_place(&state, &ctx, body.folder_id.as_deref()).await?;
    check_dashboard_sources(&state.db, &ctx, &model, None).await?;
    library::check_references(&state.db, &ctx, &model, None).await?;
    saved_analyses::check_references(&state.db, &ctx, &model, None).await?;

    let id = new_id();
    let keep = version_retention(&state).await?;
    let now = state.clock.now_ms();
    let mut tx = crate::db::begin(&state.db).await?;
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
    // `lock_place` took the organization's lock; a library panel deleted since the check above
    // is refused here rather than referenced.
    library::recheck_added(&mut tx, &ctx.org_id, &model.library_panel_ids()).await?;
    library::recheck_space_links(&mut tx, &ctx, body.folder_id.as_deref(), &model.library_panel_ids()).await?;
    saved_analyses::recheck_added(&mut tx, &ctx.org_id, &model.analysis_ids()).await?;
    saved_analyses::recheck_audience(&mut tx, &ctx, body.folder_id.as_deref(), &model.analysis_ids()).await?;
    let new = NewVersion {
        model: &model,
        message: &message,
        restored_from: None,
        added_library: added_library(&model, None),
        added_analyses: added_analyses(&model, None),
    };
    insert_version(&mut tx, &id, 1, &ctx.user.id, &new, keep, now).await?;
    library::sync_references(&mut tx, &ctx.org_id, &id, &model).await?;
    saved_analyses::sync_uses(&mut tx, &ctx.org_id, &id, &model).await?;
    let summary = json!({ "folderId": body.folder_id, "version": 1 });
    audit::record(&mut tx, &event(&ctx, &info, "dashboard.created", &id, summary, now)).await?;
    let row = fetch(&mut *tx, &ctx.org_id, &id).await?.ok_or_else(ApiError::not_found)?;
    let answer = view(&mut tx, &ctx, row).await?;
    crate::db::commit(tx).await?;
    Ok((StatusCode::CREATED, Json(answer)))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ValidateModel {
    model: Value,
}

/// Checks a model as a save would (migrations, rules, size) without storing anything, for the
/// JSON editor and imports. Answers the model as it would be stored. Data sources and library
/// panels are checked on save, where the caller's rights on them count.
async fn validate(JsonBody(body): JsonBody<ValidateModel>) -> ApiResult<Json<Value>> {
    let model = parse_model(body.model)?;
    Ok(Json(json!({ "model": model })))
}

async fn get_one(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Path((_, id)): Path<(String, String)>,
) -> ApiResult<Json<Dashboard>> {
    let row = load(&state, &ctx, &id, Permission::DashboardsRead).await?;
    Ok(Json(pool_view(&state, &ctx, row).await?))
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
    let mut moved_out = None;
    let mut tx = crate::db::begin(&state.db).await?;
    // New library panel references take the organization's lock first, as a library panel's
    // delete does, so a reference never outlives the panel it names.
    if !moved && (!new.added_library.is_empty() || !new.added_analyses.is_empty()) {
        authz::lock_org(&mut tx, &ctx.org_id).await?;
    }
    if moved {
        lock_place(&mut tx, &ctx.org_id, folder_id).await?;
        moved_out =
            check_space_move(&mut tx, ctx, row.folder_id.as_deref(), row.owner_team_id.as_deref(), folder_id).await?;
        // Leaving a restricted folder is remembered, so the purge still hides its old events.
        if let Some(old) = row.folder_id.as_deref()
            && folders::restricted_in(&mut tx, &ctx.org_id, old).await?
        {
            sqlx::query("UPDATE dashboards SET ever_restricted = 1 WHERE org_id = $1 AND id = $2")
                .bind(&ctx.org_id)
                .bind(&row.id)
                .execute(&mut *tx)
                .await?;
        }
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
        return Err(ApiError::version_conflict(json!(pool_view(state, ctx, stored).await?)));
    }
    library::recheck_added(&mut tx, &ctx.org_id, &new.added_library).await?;
    // A move takes every library panel along; otherwise only the new ones need a look.
    let linked = if moved { new.model.library_panel_ids() } else { new.added_library.clone() };
    library::recheck_space_links(&mut tx, ctx, folder_id, &linked).await?;
    saved_analyses::recheck_added(&mut tx, &ctx.org_id, &new.added_analyses).await?;
    let linked = if moved { new.model.analysis_ids() } else { new.added_analyses.clone() };
    saved_analyses::recheck_audience(&mut tx, ctx, folder_id, &linked).await?;
    insert_version(&mut tx, &row.id, next, &ctx.user.id, &new, keep, now).await?;
    library::sync_references(&mut tx, &ctx.org_id, &row.id, new.model).await?;
    saved_analyses::sync_uses(&mut tx, &ctx.org_id, &row.id, new.model).await?;
    let (action, summary) = match new.restored_from {
        Some(from) => ("dashboard.version_restored", json!({ "version": next, "restoredFrom": from })),
        None => ("dashboard.saved", json!({ "version": next, "moved": moved })),
    };
    audit::record(&mut tx, &event(ctx, info, action, &row.id, summary, now)).await?;
    if let Some(summary) = moved_out {
        audit::record(&mut tx, &event(ctx, info, "team_space.moved_out", &row.id, summary, now)).await?;
    }
    let saved = fetch(&mut *tx, &ctx.org_id, &row.id).await?.ok_or_else(ApiError::not_found)?;
    let answer = view(&mut tx, ctx, saved).await?;
    crate::db::commit(tx).await?;
    Ok(answer)
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
        // Moving into or out of a restricted folder changes who sees the dashboard: a permissions
        // change on both sides, as for folders. Between the open tree and team spaces, edit
        // rights on both sides (the dashboard's and the new place's, checked here) are enough.
        let tree = Tree::load(&mut *state.db.acquire().await?, &ctx).await?;
        let governing = |folder: Option<&str>| folder.and_then(|f| tree.governing(f));
        if tree.crossing_needs_permissions(governing(row.folder_id.as_deref()), governing(folder_id.as_deref())) {
            for place in [row.folder_id.as_deref(), folder_id.as_deref()].into_iter().flatten() {
                authz::check_resource(&state.db, &ctx, Permission::FoldersPermissions, Resource::Folder(place))
                    .await
                    // The caller sees the dashboard; that its folder is hidden from them is no secret
                    // worth a 404 here, the move is simply not theirs to make.
                    .map_err(|e| {
                        if e.code == "not_found" {
                            ApiError::forbidden("missing permission folders:permissions")
                        } else {
                            e
                        }
                    })?;
            }
        }
    }
    if body.version != row.version {
        return Err(ApiError::version_conflict(json!(pool_view(&state, &ctx, row).await?)));
    }
    let stored = current_model(&state, &row).await?;
    check_panels(&state, &model, Some(&stored))?;
    check_dashboard_sources(&state.db, &ctx, &model, Some(&stored)).await?;
    library::check_references(&state.db, &ctx, &model, Some(&stored)).await?;
    saved_analyses::check_references(&state.db, &ctx, &model, Some(&stored)).await?;
    let new = NewVersion {
        model: &model,
        message: &message,
        restored_from: None,
        added_library: added_library(&model, Some(&stored)),
        added_analyses: added_analyses(&model, Some(&stored)),
    };
    Ok(Json(write_version(&state, &ctx, &info, &row, folder_id.as_deref(), new).await?))
}

/// A move across team spaces of a dashboard or saved analysis in `from_folder` that `owner` owns,
/// read through the move's transaction after the organization's lock. Out of a space (into the
/// open tree or another space) only maintainers of the space's team and org admins move content;
/// team editors move within the space. An item another team owns needs the same right for that
/// team, and goes into a team space of another team only through org admins. Answers the summary
/// of the `team_space.moved_out` event, or `None` when the move leaves no space.
pub(super) async fn check_space_move(
    conn: &mut sqlx::AnyConnection,
    ctx: &OrgCtx,
    from_folder: Option<&str>,
    owner: Option<&str>,
    to: Option<&str>,
) -> ApiResult<Option<Value>> {
    let tree = Tree::load(&mut *conn, ctx).await?;
    let from = from_folder.and_then(|f| tree.space_of(f));
    let into = to.and_then(|f| tree.space_of(f));
    if from.map(|(s, _)| s) == into.map(|(s, _)| s) {
        return Ok(None);
    }
    let admin = authz::role_sees_restricted(&ctx.permissions);
    if let (Some((_, team)), Some(owner)) = (into, owner)
        && owner != team
        && !admin
    {
        return Err(ApiError::forbidden("content another team owns goes into a team space only through org admins"));
    }
    let Some((space, team)) = from else { return Ok(None) };
    let index = AccessIndex::load(&mut *conn, ctx).await?;
    let may_take = |team: &str| admin || index.is_maintainer(team);
    if !may_take(team) || owner.is_some_and(|owner| !may_take(owner)) {
        return Err(ApiError::forbidden(
            "only maintainers of the team and org admins move content out of its team space",
        ));
    }
    Ok(Some(json!({ "spaceId": space, "teamId": team, "from": from_folder, "to": to })))
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
    let mut tx = crate::db::begin(&state.db).await?;
    // Ordered against annotation changes, which check under the same lock that the dashboard is
    // outside the trash.
    authz::lock_org(&mut tx, &ctx.org_id).await?;
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
    crate::db::commit(tx).await?;
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
        return Ok(Json(pool_view(&state, &ctx, row).await?));
    }
    let now = state.clock.now_ms();
    let mut tx = crate::db::begin(&state.db).await?;
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
        let row = fetch(&mut *tx, &ctx.org_id, &id).await?.ok_or_else(ApiError::not_found)?;
        let answer = view(&mut tx, &ctx, row).await?;
        crate::db::commit(tx).await?;
        return Ok(Json(answer));
    }
    // Restored or purged by someone else meanwhile: nothing changed here, answer what is stored.
    drop(tx);
    let row = fetch(&state.db, &ctx.org_id, &id).await?.ok_or_else(ApiError::not_found)?;
    Ok(Json(pool_view(&state, &ctx, row).await?))
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
    let mut tx = crate::db::begin(&state.db).await?;
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
    let (ever_restricted,): (i64,) = sqlx::query_as(
        "SELECT CASE WHEN team_only = 1 THEN 1 ELSE ever_restricted END FROM dashboards WHERE org_id = $1 AND id = $2",
    )
    .bind(&ctx.org_id)
    .bind(&id)
    .fetch_one(&mut *tx)
    .await?;
    let restricted_now = match folder.as_deref() {
        Some(folder) => folders::restricted_in(&mut tx, &ctx.org_id, folder).await?,
        None => false,
    };
    if restricted_now || ever_restricted != 0 {
        // Restricted content keeps its audit events hidden once it is gone.
        folders::tombstone_dashboard(&mut tx, &ctx.org_id, &id).await?;
    }
    library::purge_dashboard_rows(&mut tx, &ctx.org_id, "d.id = $2", &id).await?;
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
    crate::db::commit(tx).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Sets the team that owns a dashboard and who else sees it (`team`: team only). Changing either
/// decides who sees and edits the dashboard, so it needs `dashboards:share` on it (the owner
/// team's editors hold it, members outside the team do not); the new owner team must be the
/// caller's unless they are an org admin.
async fn set_owner(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    Path((_, id)): Path<(String, String)>,
    JsonBody(body): JsonBody<OwnerRequest>,
) -> ApiResult<Json<Dashboard>> {
    // Before the lock, for `not_found` on what the caller cannot see and the admin audit; every
    // rule is checked again under the lock, where nothing can change it meanwhile.
    load(&state, &ctx, &id, Permission::DashboardsShare).await?;
    let team_only = body.visibility == Visibility::Team;
    let now = state.clock.now_ms();
    let mut tx = crate::db::begin(&state.db).await?;
    authz::lock_org(&mut tx, &ctx.org_id).await?;
    let row = fetch(&mut *tx, &ctx.org_id, &id).await?.ok_or_else(ApiError::not_found)?;
    if row.deleted_at.is_some() {
        return Err(conflict("the dashboard is in the trash; restore it first"));
    }
    if body.version.is_some_and(|v| v != row.version) {
        let current = view(&mut tx, &ctx, row).await?;
        return Err(ApiError::version_conflict(json!(current)));
    }
    let held =
        check_owner_change(&mut tx, &ctx, OwnedItem::Dashboard { id: &id, folder: row.folder_id.as_deref() }, &body)
            .await?;
    let member = match body.owner_team_id.as_deref() {
        Some(team) => authz::team_membership(&mut *tx, &ctx, team).await?.is_some(),
        None => false,
    };
    let changed = sqlx::query(
        "UPDATE dashboards SET owner_team_id = $1, team_only = $2, \
         ever_restricted = CASE WHEN $2 = 1 THEN 1 ELSE ever_restricted END \
         WHERE org_id = $3 AND id = $4 AND deleted_at IS NULL \
         AND (COALESCE(owner_team_id, '') <> COALESCE(CAST($1 AS TEXT), '') OR team_only <> $2)",
    )
    .bind(body.owner_team_id.as_deref())
    .bind(team_only as i64)
    .bind(&ctx.org_id)
    .bind(&id)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if changed > 0 {
        let summary = json!({ "from": row.owner_team_id, "to": body.owner_team_id, "visibility": body.visibility });
        audit::record(&mut tx, &event(&ctx, &info, "dashboard.owner_changed", &id, summary, now)).await?;
        // Whoever makes a dashboard team only without belonging to its team keeps sight of it,
        // as on restricting a folder, with no more than they held.
        if team_only && !member {
            keep_access(&mut tx, &ctx, &info, Resource::Dashboard(&id), &held, now).await?;
        }
    }
    let saved = fetch(&mut *tx, &ctx.org_id, &id).await?.ok_or_else(ApiError::not_found)?;
    let answer = view(&mut tx, &ctx, saved).await?;
    crate::db::commit(tx).await?;
    Ok(Json(answer))
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
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RestoreQuery {
    /// The current version the caller saw; a dashboard saved since answers `version_conflict`,
    /// so restoring an old version never silently replaces a save the caller has not seen.
    expected_version: Option<i64>,
}

async fn restore_version(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    Path((_, id, number)): Path<(String, String, String)>,
    QueryParams(q): QueryParams<RestoreQuery>,
) -> ApiResult<Json<Dashboard>> {
    let row = load(&state, &ctx, &id, Permission::DashboardsWrite).await?;
    if row.deleted_at.is_some() {
        return Err(conflict("the dashboard is in the trash; restore it first"));
    }
    if q.expected_version.is_some_and(|v| v != row.version) {
        return Err(ApiError::version_conflict(json!(pool_view(&state, &ctx, row).await?)));
    }
    let (summary, raw) = load_version(&state, &id, &number).await?;
    let stored: Value = serde_json::from_str(&raw).map_err(|e| ApiError::internal("dashboards", e))?;
    // Rules may have tightened since that version was saved; it must pass today's.
    let model = parse_model(stored)?;
    let current = current_model(&state, &row).await?;
    check_panels(&state, &model, Some(&current))?;
    check_dashboard_sources(&state.db, &ctx, &model, Some(&current)).await?;
    library::check_references(&state.db, &ctx, &model, Some(&current)).await?;
    saved_analyses::check_references(&state.db, &ctx, &model, Some(&current)).await?;
    let new = NewVersion {
        model: &model,
        message: "",
        restored_from: Some(summary.version),
        added_library: added_library(&model, Some(&current)),
        added_analyses: added_analyses(&model, Some(&current)),
    };
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
