//! Library panels: list, create, read, save, delete and the dashboards that show one. Rights follow
//! the folder (see `dashboards::library`); documented in docs/api/dashboard-features.md.

use axum::extract::{Path, State};
use axum::http::{Method, StatusCode};
use axum::response::IntoResponse;
use axum::{Extension, Json};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::folders::double_option;
use super::support::{Actor, QueryParams, audit, conflict, decode_cursor, encode_cursor, page_limit};
use super::table::{RouteDef, route};
use super::{clean_name, new_id};
use crate::app::AppState;
use crate::authz::{self, Access, AccessIndex, OrgCtx, Permission, Resource};
use crate::dashboards::library::{self, LIBRARY_COLUMNS, LibraryRow, check_place};
use crate::dashboards::{check_dashboard_sources, model};
use crate::error::{ApiError, ApiResult};
use crate::extract::JsonBody;
use crate::folders::{self, Tree};
use crate::net::RequestInfo;
use crate::shapes::Page;

pub fn routes() -> Vec<RouteDef> {
    use Access::OrgMember;
    vec![
        route(Method::GET, "/orgs/{orgId}/library-panels", Access::Org(Permission::DashboardsRead), list),
        route(Method::POST, "/orgs/{orgId}/library-panels", OrgMember, create),
        route(Method::GET, "/orgs/{orgId}/library-panels/{libraryPanelId}", OrgMember, get_one),
        route(Method::PUT, "/orgs/{orgId}/library-panels/{libraryPanelId}", OrgMember, save),
        route(Method::DELETE, "/orgs/{orgId}/library-panels/{libraryPanelId}", OrgMember, remove),
        route(Method::GET, "/orgs/{orgId}/library-panels/{libraryPanelId}/uses", OrgMember, uses),
    ]
}

#[derive(Clone, Copy, Debug, Default, Serialize)]
pub struct LibraryAccess {
    write: bool,
    delete: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryPanel {
    id: String,
    /// `null` at the top level, and when the caller cannot see the folder.
    folder_id: Option<String>,
    name: String,
    /// The panel content, migrated to the current `schemaVersion`.
    model: Value,
    version: i64,
    /// How many dashboards the caller may read show it (trashed ones included); others are not
    /// counted, so their number tells nothing about content the caller cannot see.
    uses: i64,
    created_at: i64,
    updated_at: i64,
    updated_by: Option<String>,
    access: LibraryAccess,
}

/// Per library panel, how many dashboards the caller may read show it.
async fn visible_uses(
    conn: &mut sqlx::AnyConnection,
    ctx: &OrgCtx,
    index: &AccessIndex,
    only: Option<&str>,
) -> ApiResult<std::collections::HashMap<String, i64>> {
    let rows: Vec<(String, String, Option<String>)> = sqlx::query_as(
        "SELECT u.library_panel_id, d.id, d.folder_id FROM library_panel_uses u \
         JOIN dashboards d ON d.id = u.dashboard_id \
         WHERE d.org_id = $1 AND (CAST($2 AS TEXT) IS NULL OR u.library_panel_id = $2)",
    )
    .bind(&ctx.org_id)
    .bind(only)
    .fetch_all(&mut *conn)
    .await?;
    let mut out = std::collections::HashMap::new();
    for (panel, dashboard, folder) in rows {
        if index.dashboard(&dashboard, folder.as_deref()).is_some_and(|p| p.contains(&Permission::DashboardsRead)) {
            *out.entry(panel).or_insert(0) += 1;
        }
    }
    Ok(out)
}

async fn use_count<'e, E: sqlx::Executor<'e, Database = sqlx::Any>>(db: E, id: &str) -> ApiResult<i64> {
    let (n,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM library_panel_uses WHERE library_panel_id = $1")
        .bind(id)
        .fetch_one(db)
        .await?;
    Ok(n)
}

fn view(row: LibraryRow, uses: i64, index: &AccessIndex, ctx: &OrgCtx) -> ApiResult<LibraryPanel> {
    let held = match row.folder_id.as_deref() {
        Some(folder) => index.folder(folder).unwrap_or_default(),
        None => ctx.permissions.clone(),
    };
    let folder_id = row.folder_id.clone().filter(|f| index.folder(f).is_some());
    Ok(LibraryPanel {
        model: library::stored_content(&row.model)?,
        id: row.id,
        folder_id,
        name: row.name,
        version: row.version,
        uses,
        created_at: row.created_at,
        updated_at: row.updated_at,
        updated_by: row.updated_by,
        access: LibraryAccess {
            write: held.contains(&Permission::DashboardsWrite),
            delete: held.contains(&Permission::DashboardsDelete),
        },
    })
}

async fn answer(conn: &mut sqlx::AnyConnection, ctx: &OrgCtx, row: LibraryRow) -> ApiResult<LibraryPanel> {
    let index = AccessIndex::load(conn, ctx).await?;
    let uses = visible_uses(conn, ctx, &index, Some(&row.id)).await?.get(&row.id).copied().unwrap_or(0);
    view(row, uses, &index, ctx)
}

/// The library panel in the path if the caller may do `permission` on it; one in a folder they
/// cannot see is `not_found`.
async fn load(state: &AppState, ctx: &OrgCtx, id: &str, permission: Permission) -> ApiResult<LibraryRow> {
    let row = library::fetch(&state.db, &ctx.org_id, id).await?.ok_or_else(ApiError::not_found)?;
    // In a trashed folder it is gone until the folder comes back, as in the list.
    if library::in_trashed_folder(&state.db, &ctx.org_id, row.folder_id.as_deref()).await? {
        return Err(ApiError::not_found());
    }
    match check_place(&state.db, ctx, Permission::DashboardsRead, row.folder_id.as_deref()).await {
        Err(e) if e.code == "forbidden" => return Err(ApiError::not_found()),
        other => other?,
    }
    check_place(&state.db, ctx, permission, row.folder_id.as_deref()).await?;
    Ok(row)
}

/// The content as a one-panel dashboard, for the data source check every save of stored queries
/// goes through.
fn as_dashboard(content: &Value) -> ApiResult<model::DashboardModel> {
    let panel = model::library_panel_as_panel(content).map_err(|e| ApiError::internal("library panels", e))?;
    Ok(model::DashboardModel {
        schema_version: model::SCHEMA_VERSION,
        title: "library".into(),
        time_range: model::TimeRange { from: "now-1h".into(), to: "now".into() },
        refresh_seconds: None,
        variables: Vec::new(),
        panels: vec![panel],
        tags: Vec::new(),
        rows: Vec::new(),
        annotations: Vec::new(),
        links: Vec::new(),
        time_zone: None,
        week_start: None,
        fiscal_year_start_month: None,
        now_delay: None,
        refresh_intervals: Vec::new(),
        shared_cursor: None,
    })
}

/// The panel option checks dashboards run, for the content a write stores: always on create, and
/// on a save only when type, options or field options differ from the `previous` content, so a
/// stored library panel that predates a rule can still be renamed, moved or have its queries
/// changed. The panel of a plugin is checked against the options its manifest declares, while the
/// plugin may be shown. The refusal names the panel (its title, else the library panel name).
fn check_options(state: &AppState, content: &Value, previous: Option<&Value>, name: &str) -> ApiResult<()> {
    let model = as_dashboard(content)?;
    let previous = previous.map(as_dashboard).transpose()?;
    let panel = model.panels[0].title.trim();
    let panel = if panel.is_empty() { name } else { panel };
    model::check_panel_options(&model, previous.as_ref()).map_err(|(_, detail)| {
        let detail = detail.replacen("model.panels[0]", "model", 1);
        ApiError::validation(detail.clone())
            .with_field("model")
            .because("dashboards.panel_options")
            .param("panel", panel)
            .param("detail", detail)
    })?;
    crate::plugins::panels::check_dashboard_options(state.plugins.panels(), &model, previous.as_ref()).map_err(|r| {
        let detail = r.detail.replacen("model.panels[0]", "model", 1);
        r.into_error(panel, detail)
    })
}

fn parse_content(raw: Value) -> ApiResult<Value> {
    model::parse_library_panel(raw).map_err(|e| ApiError::validation(e).with_field("model"))
}

/// Inside the transaction: the organization is locked and the folder still exists outside the
/// trash.
async fn lock_folder(conn: &mut sqlx::AnyConnection, org_id: &str, folder: Option<&str>) -> ApiResult<()> {
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ListQuery {
    folder_id: Option<String>,
    /// Part of the name, any case.
    q: Option<String>,
    limit: Option<u32>,
    cursor: Option<String>,
}

/// Ordered by name, then id; library panels in folders the caller cannot see, or in the trash,
/// are left out.
async fn list(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    QueryParams(q): QueryParams<ListQuery>,
) -> ApiResult<Json<Page<LibraryPanel>>> {
    let limit = page_limit(q.limit)? as usize;
    let after: Option<(String, String)> = decode_cursor(q.cursor.as_deref())?;
    let (after_name, after_id) = after.unzip();
    let mut conn = state.db.acquire().await?;
    if let Some(folder) = q.folder_id.as_deref() {
        let tree = Tree::load(&mut conn, &ctx).await?;
        if !tree.rows.contains_key(folder) || !tree.visible(folder) {
            return Err(ApiError::not_found());
        }
    }
    let pattern = q.q.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(|s| {
        let escaped = s.to_lowercase().replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_");
        format!("%{escaped}%")
    });
    let rows: Vec<LibraryRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "{} SELECT {LIBRARY_COLUMNS} FROM library_panels WHERE org_id = $1 \
         AND (folder_id IS NULL OR (folder_id NOT IN (SELECT id FROM hidden_folders) \
              AND folder_id IN (SELECT id FROM folders WHERE org_id = $1 AND deleted_at IS NULL))) \
         AND (CAST($5 AS TEXT) IS NULL OR folder_id = $5) \
         AND (CAST($6 AS TEXT) IS NULL OR search_name LIKE $6 ESCAPE '\\') \
         AND (CAST($7 AS TEXT) IS NULL OR name > $7 OR (name = $7 AND id > $8)) \
         ORDER BY name, id LIMIT $9",
        folders::VISIBILITY_CTE
    )))
    .bind(&ctx.org_id)
    .bind(&ctx.user.id)
    .bind(&ctx.role)
    .bind(folders::sees_every_folder(&ctx))
    .bind(q.folder_id.as_deref())
    .bind(pattern.as_deref())
    .bind(after_name.as_deref())
    .bind(after_id.as_deref())
    .bind(limit as i64 + 1)
    .fetch_all(&mut *conn)
    .await?;
    let index = AccessIndex::load(&mut conn, &ctx).await?;
    // Every count in one query, not one per row.
    let counts = visible_uses(&mut conn, &ctx, &index, None).await?;
    let mut items = Vec::new();
    for row in rows {
        let uses = counts.get(&row.id).copied().unwrap_or(0);
        items.push(view(row, uses, &index, &ctx)?);
    }
    let more = items.len() > limit;
    items.truncate(limit);
    let next_cursor = match items.last() {
        Some(last) if more => Some(encode_cursor(&(&last.name, &last.id))),
        _ => None,
    };
    Ok(Json(Page { items, next_cursor }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateLibraryPanel {
    name: String,
    #[serde(default)]
    folder_id: Option<String>,
    model: Value,
}

async fn create(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    JsonBody(body): JsonBody<CreateLibraryPanel>,
) -> ApiResult<impl IntoResponse> {
    let name = clean_name(&body.name, "name").map_err(|e| e.with_field("name"))?;
    let content = parse_content(body.model)?;
    check_options(&state, &content, None, &name)?;
    check_place(&state.db, &ctx, Permission::DashboardsWrite, body.folder_id.as_deref()).await?;
    check_dashboard_sources(&state.db, &ctx, &as_dashboard(&content)?, None).await?;
    let id = new_id();
    let now = state.clock.now_ms();
    let text = serde_json::to_string(&content).map_err(|e| ApiError::internal("library panels", e))?;
    let mut tx = crate::db::begin(&state.db).await?;
    lock_folder(&mut tx, &ctx.org_id, body.folder_id.as_deref()).await?;
    sqlx::query(
        "INSERT INTO library_panels (id, org_id, folder_id, name, search_name, model, version, created_by, \
         created_at, updated_by, updated_at) VALUES ($1, $2, $3, $4, $5, $6, 1, $7, $8, $7, $8)",
    )
    .bind(&id)
    .bind(&ctx.org_id)
    .bind(body.folder_id.as_deref())
    .bind(&name)
    .bind(name.to_lowercase())
    .bind(&text)
    .bind(&ctx.user.id)
    .bind(now)
    .execute(&mut *tx)
    .await?;
    let actor = Actor { user_id: &ctx.user.id, info: &info, at_ms: now };
    audit(&mut tx, &actor, Some(&ctx.org_id), "library_panel.created", ("library_panel", &id), json!({ "version": 1 }))
        .await?;
    let row = library::fetch(&mut *tx, &ctx.org_id, &id).await?.ok_or_else(ApiError::not_found)?;
    let out = answer(&mut tx, &ctx, row).await?;
    crate::db::commit(tx).await?;
    Ok((StatusCode::CREATED, Json(out)))
}

async fn get_one(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Path((_, id)): Path<(String, String)>,
) -> ApiResult<Json<LibraryPanel>> {
    let row = load(&state, &ctx, &id, Permission::DashboardsRead).await?;
    Ok(Json(answer(&mut *state.db.acquire().await?, &ctx, row).await?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveLibraryPanel {
    version: i64,
    name: String,
    model: Value,
    /// Moves it; `null` is the top level, a missing field keeps the folder.
    #[serde(default, deserialize_with = "double_option")]
    folder_id: Option<Option<String>>,
}

/// Saves new content: every dashboard showing the library panel shows the new one.
async fn save(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    Path((_, id)): Path<(String, String)>,
    JsonBody(body): JsonBody<SaveLibraryPanel>,
) -> ApiResult<Json<LibraryPanel>> {
    let row = load(&state, &ctx, &id, Permission::DashboardsWrite).await?;
    let name = clean_name(&body.name, "name").map_err(|e| e.with_field("name"))?;
    let content = parse_content(body.model)?;
    let index = AccessIndex::load(&mut *state.db.acquire().await?, &ctx).await?;
    let shown = row.folder_id.clone().filter(|f| index.folder(f).is_some());
    let folder_id = match body.folder_id {
        Some(folder) if folder != shown => folder,
        _ => row.folder_id.clone(),
    };
    if folder_id != row.folder_id {
        check_place(&state.db, &ctx, Permission::DashboardsWrite, folder_id.as_deref()).await?;
        // Into or out of a restricted folder changes who sees it: a permissions change, as for
        // dashboards; between the open tree and team spaces edit rights on both sides suffice.
        let tree = Tree::load(&mut *state.db.acquire().await?, &ctx).await?;
        let governing = |folder: Option<&str>| folder.and_then(|f| tree.governing(f));
        if tree.crossing_needs_permissions(governing(row.folder_id.as_deref()), governing(folder_id.as_deref())) {
            for place in [row.folder_id.as_deref(), folder_id.as_deref()].into_iter().flatten() {
                authz::check_resource(&state.db, &ctx, Permission::FoldersPermissions, Resource::Folder(place))
                    .await
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
        let current = answer(&mut *state.db.acquire().await?, &ctx, row).await?;
        return Err(ApiError::version_conflict(json!(current)));
    }
    let previous = library::stored_content(&row.model)?;
    check_options(&state, &content, Some(&previous), &name)?;
    check_dashboard_sources(&state.db, &ctx, &as_dashboard(&content)?, Some(&as_dashboard(&previous)?)).await?;
    let text = serde_json::to_string(&content).map_err(|e| ApiError::internal("library panels", e))?;
    let now = state.clock.now_ms();
    let mut tx = crate::db::begin(&state.db).await?;
    let mut moved_out = None;
    if folder_id != row.folder_id {
        lock_folder(&mut tx, &ctx.org_id, folder_id.as_deref()).await?;
        moved_out = check_space_move(&mut tx, &ctx, &id, row.folder_id.as_deref(), folder_id.as_deref()).await?;
    }
    let updated = sqlx::query(
        "UPDATE library_panels SET name = $1, search_name = $2, model = $3, folder_id = $4, version = version + 1, \
         updated_by = $5, updated_at = $6 WHERE org_id = $7 AND id = $8 AND version = $9",
    )
    .bind(&name)
    .bind(name.to_lowercase())
    .bind(&text)
    .bind(folder_id.as_deref())
    .bind(&ctx.user.id)
    .bind(now)
    .bind(&ctx.org_id)
    .bind(&id)
    .bind(row.version)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if updated == 0 {
        drop(tx);
        let stored = library::fetch(&state.db, &ctx.org_id, &id).await?.ok_or_else(ApiError::not_found)?;
        let current = answer(&mut *state.db.acquire().await?, &ctx, stored).await?;
        return Err(ApiError::version_conflict(json!(current)));
    }
    let actor = Actor { user_id: &ctx.user.id, info: &info, at_ms: now };
    let summary = json!({ "version": row.version + 1, "moved": folder_id != row.folder_id });
    audit(&mut tx, &actor, Some(&ctx.org_id), "library_panel.saved", ("library_panel", &id), summary).await?;
    if let Some(summary) = moved_out {
        audit(&mut tx, &actor, Some(&ctx.org_id), "team_space.moved_out", ("library_panel", &id), summary).await?;
    }
    let saved = library::fetch(&mut *tx, &ctx.org_id, &id).await?.ok_or_else(ApiError::not_found)?;
    let out = answer(&mut tx, &ctx, saved).await?;
    crate::db::commit(tx).await?;
    Ok(Json(out))
}

/// Moves of a library panel across team spaces (docs/api/access.md, "Team spaces"), read through
/// the move's transaction after the organization's lock: out of a space only by maintainers of
/// its team and org admins, as for dashboards; into a space only while no dashboard outside that
/// space shows it, since those would show content their viewers may no longer see. Answers the
/// summary of the `team_space.moved_out` event, or `None` when the move leaves no space.
async fn check_space_move(
    conn: &mut sqlx::AnyConnection,
    ctx: &OrgCtx,
    id: &str,
    from: Option<&str>,
    to: Option<&str>,
) -> ApiResult<Option<Value>> {
    let tree = Tree::load(&mut *conn, ctx).await?;
    let from_space = from.and_then(|f| tree.space_of(f));
    let to_space = to.and_then(|f| tree.space_of(f));
    if from_space.map(|(s, _)| s) == to_space.map(|(s, _)| s) {
        return Ok(None);
    }
    if let Some((_, team)) = from_space
        && !authz::role_sees_restricted(&ctx.permissions)
        && authz::team_membership(&mut *conn, ctx, team).await?.as_deref() != Some("maintainer")
    {
        return Err(ApiError::forbidden(
            "only maintainers of the team and org admins move content out of its team space",
        ));
    }
    if let Some((space, _)) = to_space {
        let users: Vec<(Option<String>,)> = sqlx::query_as(
            "SELECT d.folder_id FROM library_panel_uses u JOIN dashboards d ON d.id = u.dashboard_id \
             WHERE u.library_panel_id = $1 AND d.org_id = $2",
        )
        .bind(id)
        .bind(&ctx.org_id)
        .fetch_all(&mut *conn)
        .await?;
        if users.iter().any(|(folder,)| folder.as_deref().and_then(|f| tree.space_of(f)).map(|(s, _)| s) != Some(space))
        {
            return Err(conflict(
                "dashboards outside the team space show this library panel; remove it from them first",
            ));
        }
    }
    Ok(from_space.map(|(space, team)| json!({ "spaceId": space, "teamId": team, "from": from, "to": to })))
}

/// Only a library panel no dashboard shows can be deleted (trashed dashboards count); it is gone
/// for good.
async fn remove(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    Path((_, id)): Path<(String, String)>,
) -> ApiResult<StatusCode> {
    load(&state, &ctx, &id, Permission::DashboardsDelete).await?;
    let now = state.clock.now_ms();
    let mut tx = crate::db::begin(&state.db).await?;
    // A dashboard saved at this very moment may still add a reference; it then shows the panel
    // as deleted, as after a folder purge.
    authz::lock_org(&mut tx, &ctx.org_id).await?;
    // Without the number: some of them may be dashboards the caller cannot see.
    if use_count(&mut *tx, &id).await? > 0 {
        return Err(conflict("dashboards still show the library panel; remove it from them first"));
    }
    sqlx::query("DELETE FROM library_panels WHERE org_id = $1 AND id = $2")
        .bind(&ctx.org_id)
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    let actor = Actor { user_id: &ctx.user.id, info: &info, at_ms: now };
    audit(&mut tx, &actor, Some(&ctx.org_id), "library_panel.deleted", ("library_panel", &id), json!({})).await?;
    crate::db::commit(tx).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Use {
    id: String,
    title: String,
    deleted_at: Option<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Uses {
    /// The dashboards showing it that the caller may see, by title. Others are not counted, so
    /// nothing tells about content the caller cannot see.
    items: Vec<Use>,
}

async fn uses(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Path((_, id)): Path<(String, String)>,
) -> ApiResult<Json<Uses>> {
    load(&state, &ctx, &id, Permission::DashboardsRead).await?;
    let mut conn = state.db.acquire().await?;
    let rows: Vec<(String, Option<String>, String, Option<i64>)> = sqlx::query_as(
        "SELECT d.id, d.folder_id, d.title, d.deleted_at FROM library_panel_uses u \
         JOIN dashboards d ON d.id = u.dashboard_id WHERE u.library_panel_id = $1 AND d.org_id = $2 \
         ORDER BY d.title, d.id",
    )
    .bind(&id)
    .bind(&ctx.org_id)
    .fetch_all(&mut *conn)
    .await?;
    let index = AccessIndex::load(&mut conn, &ctx).await?;
    let items = rows
        .into_iter()
        .filter(|(dashboard, folder, _, _)| {
            index.dashboard(dashboard, folder.as_deref()).is_some_and(|p| p.contains(&Permission::DashboardsRead))
        })
        .map(|(id, _, title, deleted_at)| Use { id, title, deleted_at })
        .collect();
    Ok(Json(Uses { items }))
}
