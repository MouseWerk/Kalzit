//! Folders: the tree, create, rename, move, restrict, trash, restore and purge. Trashing a
//! folder trashes everything below it; restoring brings back what was trashed with it.

use axum::extract::{Path, State};
use axum::http::{Method, StatusCode};
use axum::response::IntoResponse;
use axum::{Extension, Json};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Value, json};

use super::table::{RouteDef, route};
use super::{clean_name, new_id};
use crate::app::AppState;
use crate::audit::{self, AuditEvent};
use crate::authz::{self, Access, OrgCtx, Permission, Resource};
use crate::error::{ApiError, ApiResult};
use crate::extract::JsonBody;
use crate::folders::{FolderRow, Tree};
use crate::net::RequestInfo;
use crate::paging::QueryParams;
use crate::shapes::Page;

pub fn routes() -> Vec<RouteDef> {
    use Permission::{FoldersRead, FoldersWrite};
    vec![
        route(Method::GET, "/orgs/{orgId}/folders", Access::Org(FoldersRead), list),
        route(Method::POST, "/orgs/{orgId}/folders", Access::Org(FoldersWrite), create),
        route(Method::PATCH, "/orgs/{orgId}/folders/{folderId}", Access::Org(FoldersWrite), update),
        route(Method::DELETE, "/orgs/{orgId}/folders/{folderId}", Access::Org(FoldersWrite), trash),
        route(Method::POST, "/orgs/{orgId}/folders/{folderId}/restore", Access::Org(FoldersWrite), restore),
        route(Method::DELETE, "/orgs/{orgId}/folders/{folderId}/purge", Access::Org(FoldersWrite), purge),
    ]
}

/// For patch bodies: a missing field is `None`, an explicit `null` is `Some(None)`.
pub fn double_option<'de, D: Deserializer<'de>, T: Deserialize<'de>>(d: D) -> Result<Option<Option<T>>, D::Error> {
    Option::<T>::deserialize(d).map(Some)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Folder {
    id: String,
    parent_id: Option<String>,
    name: String,
    /// The folder's own flag; subfolders of a restricted folder are restricted as well.
    restricted: bool,
    version: i64,
    created_at: i64,
    updated_at: i64,
    deleted_at: Option<i64>,
}

impl From<&FolderRow> for Folder {
    fn from(r: &FolderRow) -> Self {
        Self {
            id: r.id.clone(),
            parent_id: r.parent_id.clone(),
            name: r.name.clone(),
            restricted: r.restricted != 0,
            version: r.version,
            created_at: r.created_at,
            updated_at: r.updated_at,
            deleted_at: r.deleted_at,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderNode {
    #[serde(flatten)]
    folder: Folder,
    children: Vec<FolderNode>,
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
        resource_type: Some("folder"),
        resource_id: Some(id),
        summary,
        at_ms: now,
    }
}

fn conflict(message: &str) -> ApiError {
    ApiError::new(StatusCode::CONFLICT, "conflict", message)
}

/// The organization's folders and the one in the path, if the caller sees it and may do
/// `permission` on it.
async fn load(state: &AppState, ctx: &OrgCtx, folder_id: &str, permission: Permission) -> ApiResult<(Tree, FolderRow)> {
    let tree = Tree::load(&state.db, &ctx.org_id).await?;
    let row = tree.rows.get(folder_id).cloned().ok_or_else(ApiError::not_found)?;
    if !tree.visible(ctx, folder_id) {
        return Err(ApiError::not_found());
    }
    authz::check_resource(&state.db, ctx, permission, Resource::Folder(folder_id)).await?;
    Ok((tree, row))
}

/// A parent named in a body: in this organization, visible, not trashed, and writable.
async fn check_parent(state: &AppState, ctx: &OrgCtx, tree: &Tree, parent_id: &str) -> ApiResult<()> {
    let parent = tree.rows.get(parent_id).ok_or_else(ApiError::not_found)?;
    if !tree.visible(ctx, parent_id) {
        return Err(ApiError::not_found());
    }
    if parent.deleted_at.is_some() {
        return Err(ApiError::validation("the parent folder is in the trash").with_field("parentId"));
    }
    authz::check_resource(&state.db, ctx, Permission::FoldersWrite, Resource::Folder(parent_id)).await
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ListQuery {
    /// `true` lists what was put in the trash (each trashed subtree once, by its top folder).
    trashed: Option<bool>,
}

async fn list(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    QueryParams(q): QueryParams<ListQuery>,
) -> ApiResult<Json<Page<FolderNode>>> {
    let tree = Tree::load(&state.db, &ctx.org_id).await?;
    let visible = |r: &&FolderRow| tree.visible(&ctx, &r.id);
    if q.trashed.unwrap_or(false) {
        let mut roots: Vec<&FolderRow> = tree
            .rows
            .values()
            .filter(|r| {
                let parent_deleted = r.parent_id.as_deref().and_then(|p| tree.rows.get(p)).and_then(|p| p.deleted_at);
                r.deleted_at.is_some() && parent_deleted != r.deleted_at
            })
            .filter(visible)
            .collect();
        roots.sort_by(|a, b| b.deleted_at.cmp(&a.deleted_at).then_with(|| a.id.cmp(&b.id)));
        let items = roots.into_iter().map(|r| FolderNode { folder: r.into(), children: Vec::new() }).collect();
        return Ok(Json(Page { items, next_cursor: None }));
    }
    let active: Vec<&FolderRow> = tree.rows.values().filter(|r| r.deleted_at.is_none()).filter(visible).collect();
    // The tree is one answer: folders are few compared with dashboards, and the UI shows them all.
    Ok(Json(Page { items: nest(&active, None), next_cursor: None }))
}

fn nest(rows: &[&FolderRow], parent: Option<&str>) -> Vec<FolderNode> {
    let mut level: Vec<&FolderRow> = rows.iter().copied().filter(|r| r.parent_id.as_deref() == parent).collect();
    level.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()).then_with(|| a.id.cmp(&b.id)));
    level.into_iter().map(|r| FolderNode { folder: r.into(), children: nest(rows, Some(&r.id)) }).collect()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateFolder {
    name: String,
    #[serde(default)]
    parent_id: Option<String>,
    #[serde(default)]
    restricted: bool,
}

async fn create(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    JsonBody(body): JsonBody<CreateFolder>,
) -> ApiResult<impl IntoResponse> {
    let name = clean_name(&body.name, "name").map_err(|e| e.with_field("name"))?;
    if body.restricted {
        ctx.check(Permission::FoldersPermissions)?;
    }
    let tree = Tree::load(&state.db, &ctx.org_id).await?;
    if let Some(parent) = body.parent_id.as_deref() {
        check_parent(&state, &ctx, &tree, parent).await?;
        tree.check_placement(None, parent)?;
    }
    let id = new_id();
    let now = state.clock.now_ms();
    let row = FolderRow {
        id: id.clone(),
        parent_id: body.parent_id.clone(),
        name,
        restricted: body.restricted as i64,
        version: 1,
        created_by: Some(ctx.user.id.clone()),
        created_at: now,
        updated_at: now,
        deleted_at: None,
    };
    let mut tx = state.db.begin().await?;
    sqlx::query(
        "INSERT INTO folders (id, org_id, parent_id, name, restricted, version, created_by, created_at, updated_at) \
         VALUES ($1, $2, $3, $4, $5, 1, $6, $7, $7)",
    )
    .bind(&row.id)
    .bind(&ctx.org_id)
    .bind(row.parent_id.as_deref())
    .bind(&row.name)
    .bind(row.restricted)
    .bind(&ctx.user.id)
    .bind(now)
    .execute(&mut *tx)
    .await?;
    let summary = json!({ "parentId": row.parent_id, "restricted": body.restricted });
    audit::record(&mut tx, &event(&ctx, &info, "folder.created", &id, summary, now)).await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(Folder::from(&row))))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateFolder {
    #[serde(default)]
    name: Option<String>,
    /// `null` moves the folder to the top level.
    #[serde(default, deserialize_with = "double_option")]
    parent_id: Option<Option<String>>,
    #[serde(default)]
    restricted: Option<bool>,
    version: i64,
}

async fn update(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    Path((_, folder_id)): Path<(String, String)>,
    JsonBody(body): JsonBody<UpdateFolder>,
) -> ApiResult<Json<Folder>> {
    let (tree, current) = load(&state, &ctx, &folder_id, Permission::FoldersWrite).await?;
    if current.deleted_at.is_some() {
        return Err(conflict("the folder is in the trash; restore it first"));
    }
    let mut next = current.clone();
    let mut changed: Vec<&str> = Vec::new();
    if let Some(name) = &body.name {
        let name = clean_name(name, "name").map_err(|e| e.with_field("name"))?;
        if name != current.name {
            next.name = name;
            changed.push("name");
        }
    }
    if let Some(parent) = &body.parent_id
        && *parent != current.parent_id
    {
        if let Some(parent) = parent.as_deref() {
            check_parent(&state, &ctx, &tree, parent).await?;
            tree.check_placement(Some(&folder_id), parent)?;
        }
        next.parent_id = parent.clone();
        changed.push("parentId");
    }
    if let Some(restricted) = body.restricted
        && restricted != (current.restricted != 0)
    {
        // Restriction decides who sees the folder at all, so it is a permissions change.
        ctx.check(Permission::FoldersPermissions)?;
        next.restricted = restricted as i64;
        changed.push("restricted");
    }
    if body.version != current.version {
        return Err(ApiError::version_conflict(json!(Folder::from(&current))));
    }
    if changed.is_empty() {
        return Ok(Json(Folder::from(&current)));
    }

    let now = state.clock.now_ms();
    next.version = current.version + 1;
    next.updated_at = now;
    let mut tx = state.db.begin().await?;
    let updated = sqlx::query(
        "UPDATE folders SET name = $1, parent_id = $2, restricted = $3, version = $4, updated_at = $5 \
         WHERE org_id = $6 AND id = $7 AND version = $8 AND deleted_at IS NULL",
    )
    .bind(&next.name)
    .bind(next.parent_id.as_deref())
    .bind(next.restricted)
    .bind(next.version)
    .bind(now)
    .bind(&ctx.org_id)
    .bind(&folder_id)
    .bind(current.version)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if updated == 0 {
        drop(tx);
        let (_, stored) = load(&state, &ctx, &folder_id, Permission::FoldersRead).await?;
        return Err(ApiError::version_conflict(json!(Folder::from(&stored))));
    }
    audit::record(&mut tx, &event(&ctx, &info, "folder.updated", &folder_id, json!({ "fields": changed }), now))
        .await?;
    tx.commit().await?;
    Ok(Json(Folder::from(&next)))
}

/// Dashboards in `folders` that are not in the trash; anything else counts too when `all`.
async fn count_dashboards(conn: &mut sqlx::AnyConnection, org_id: &str, folders: &[&str], all: bool) -> ApiResult<i64> {
    let mut total = 0;
    for folder in folders {
        let (n,): (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM dashboards WHERE org_id = $1 AND folder_id = $2 AND ($3 = 1 OR deleted_at IS NULL)",
        )
        .bind(org_id)
        .bind(*folder)
        .bind(all as i64)
        .fetch_one(&mut *conn)
        .await?;
        total += n;
    }
    Ok(total)
}

async fn trash(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    Path((_, folder_id)): Path<(String, String)>,
) -> ApiResult<StatusCode> {
    let (tree, current) = load(&state, &ctx, &folder_id, Permission::FoldersWrite).await?;
    if current.deleted_at.is_some() {
        return Ok(StatusCode::NO_CONTENT);
    }
    let mut folders: Vec<&str> = vec![&folder_id];
    folders.extend(tree.descendants(&folder_id).into_iter().filter(|r| r.deleted_at.is_none()).map(|r| r.id.as_str()));
    let now = state.clock.now_ms();
    let mut tx = state.db.begin().await?;
    let dashboards = count_dashboards(&mut tx, &ctx.org_id, &folders, false).await?;
    if dashboards > 0 {
        ctx.check(Permission::DashboardsDelete)?;
    }
    // One timestamp for the whole subtree: restore brings back exactly what went with it.
    for folder in &folders {
        sqlx::query("UPDATE folders SET deleted_at = $1 WHERE org_id = $2 AND id = $3 AND deleted_at IS NULL")
            .bind(now)
            .bind(&ctx.org_id)
            .bind(*folder)
            .execute(&mut *tx)
            .await?;
        sqlx::query(
            "UPDATE dashboards SET deleted_at = $1 WHERE org_id = $2 AND folder_id = $3 AND deleted_at IS NULL",
        )
        .bind(now)
        .bind(&ctx.org_id)
        .bind(*folder)
        .execute(&mut *tx)
        .await?;
    }
    let summary = json!({ "folders": folders.len(), "dashboards": dashboards });
    audit::record(&mut tx, &event(&ctx, &info, "folder.trashed", &folder_id, summary, now)).await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn restore(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    Path((_, folder_id)): Path<(String, String)>,
) -> ApiResult<Json<Folder>> {
    let (tree, current) = load(&state, &ctx, &folder_id, Permission::FoldersWrite).await?;
    let Some(deleted_at) = current.deleted_at else {
        return Ok(Json(Folder::from(&current)));
    };
    let parent = current.parent_id.as_deref().and_then(|p| tree.rows.get(p));
    if parent.is_some_and(|p| p.deleted_at.is_some()) {
        return Err(conflict("the parent folder is in the trash; restore it first"));
    }
    let mut folders: Vec<&str> = vec![&folder_id];
    folders.extend(
        tree.descendants(&folder_id).into_iter().filter(|r| r.deleted_at == Some(deleted_at)).map(|r| r.id.as_str()),
    );
    let now = state.clock.now_ms();
    let mut tx = state.db.begin().await?;
    let mut dashboards = 0;
    for folder in &folders {
        sqlx::query("UPDATE folders SET deleted_at = NULL WHERE org_id = $1 AND id = $2 AND deleted_at = $3")
            .bind(&ctx.org_id)
            .bind(*folder)
            .bind(deleted_at)
            .execute(&mut *tx)
            .await?;
        dashboards += sqlx::query(
            "UPDATE dashboards SET deleted_at = NULL WHERE org_id = $1 AND folder_id = $2 AND deleted_at = $3",
        )
        .bind(&ctx.org_id)
        .bind(*folder)
        .bind(deleted_at)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    }
    let summary = json!({ "folders": folders.len(), "dashboards": dashboards });
    audit::record(&mut tx, &event(&ctx, &info, "folder.restored", &folder_id, summary, now)).await?;
    tx.commit().await?;
    let mut restored = current;
    restored.deleted_at = None;
    Ok(Json(Folder::from(&restored)))
}

async fn purge(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    Path((_, folder_id)): Path<(String, String)>,
) -> ApiResult<StatusCode> {
    let (tree, current) = load(&state, &ctx, &folder_id, Permission::FoldersWrite).await?;
    if current.deleted_at.is_none() {
        return Err(conflict("only folders in the trash can be purged; move it to the trash first"));
    }
    // Everything below goes, whatever its own state: nothing may be left without its folder.
    let mut folders: Vec<&str> = vec![&folder_id];
    folders.extend(tree.descendants(&folder_id).into_iter().map(|r| r.id.as_str()));
    let now = state.clock.now_ms();
    let mut tx = state.db.begin().await?;
    let dashboards = count_dashboards(&mut tx, &ctx.org_id, &folders, true).await?;
    if dashboards > 0 {
        ctx.check(Permission::DashboardsDelete)?;
    }
    for folder in &folders {
        super::dashboards::purge_in_folder(&mut tx, &ctx.org_id, folder).await?;
    }
    // Children before parents, so no folder is left pointing at a deleted one.
    for folder in folders.iter().rev() {
        sqlx::query("DELETE FROM folders WHERE org_id = $1 AND id = $2")
            .bind(&ctx.org_id)
            .bind(*folder)
            .execute(&mut *tx)
            .await?;
    }
    // Grants on these folders (resource_grants, migration 0003) are deleted here as well once
    // both streams are merged; the orchestrator adds that statement.
    let summary = json!({ "folders": folders.len(), "dashboards": dashboards });
    audit::record(&mut tx, &event(&ctx, &info, "folder.purged", &folder_id, summary, now)).await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}
