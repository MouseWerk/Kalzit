//! Folders: the tree, create, rename, move, restrict, trash, restore and purge. Trashing a
//! folder trashes everything below it; restoring brings back what was trashed with it.
//!
//! Access is decided per folder (`authz::check_resource`), so grants extend a member's rights
//! beyond their role; the routes only require membership. Actions on a whole subtree check every
//! part of it that another restricted folder governs, and its dashboards per folder.
//!
//! Every change of the structure runs in a transaction that starts with `authz::lock_org` and
//! reads the tree through it, so two concurrent moves cannot build a cycle and nothing lands in a
//! folder that is being trashed or purged. Permission checks run before, against the pool: they
//! may read grants and must not wait for a second connection while the transaction holds one.
//! Under the lock the handler checks that what it checked is still what it changes.

use std::collections::BTreeSet;

use axum::extract::{Path, State};
use axum::http::{Method, StatusCode};
use axum::response::IntoResponse;
use axum::{Extension, Json};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Value, json};

use super::support::{QueryParams, conflict};
use super::table::{RouteDef, route};
use super::{clean_name, new_id};
use crate::app::AppState;
use crate::audit::{self, AuditEvent};
use crate::authz::{self, Access, AccessIndex, OrgCtx, Permission, Resource};
use crate::error::{ApiError, ApiResult};
use crate::extract::JsonBody;
use crate::folders::{self, FolderRow, Tree};
use crate::net::RequestInfo;
use crate::shapes::Page;

pub fn routes() -> Vec<RouteDef> {
    use Permission::FoldersRead;
    vec![
        route(Method::GET, "/orgs/{orgId}/folders", Access::Org(FoldersRead), list),
        route(Method::POST, "/orgs/{orgId}/folders", Access::OrgMember, create),
        route(Method::PATCH, "/orgs/{orgId}/folders/{folderId}", Access::OrgMember, update),
        route(Method::DELETE, "/orgs/{orgId}/folders/{folderId}", Access::OrgMember, trash),
        route(Method::POST, "/orgs/{orgId}/folders/{folderId}/restore", Access::OrgMember, restore),
        route(Method::DELETE, "/orgs/{orgId}/folders/{folderId}/purge", Access::OrgMember, purge),
        route(Method::PUT, "/orgs/{orgId}/folders/{folderId}/owner", Access::OrgMember, set_owner),
    ]
}

/// The team that owns a folder or dashboard, named for display.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnerTeam {
    id: String,
    name: String,
}

impl OwnerTeam {
    pub fn of(team_id: Option<&str>, index: &AccessIndex) -> Option<Self> {
        team_id.map(|id| Self { id: id.to_string(), name: index.team_name(id).unwrap_or_default().to_string() })
    }
}

/// Who may see a team-owned folder or dashboard besides its team: everyone with access to the
/// place (`shared`, read only), or nobody without a grant (`team`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Visibility {
    Shared,
    Team,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OwnerRequest {
    /// `null` hands the folder or dashboard to the organization.
    pub owner_team_id: Option<String>,
    pub visibility: Visibility,
}

/// Before a change of owner: the new owner team exists in the organization and the caller may
/// hand content to it, as one of its members or as an org admin.
pub async fn check_new_owner(state: &AppState, ctx: &OrgCtx, team_id: Option<&str>) -> ApiResult<()> {
    let Some(team_id) = team_id else { return Ok(()) };
    let exists: Option<(String,)> = sqlx::query_as("SELECT id FROM teams WHERE org_id = $1 AND id = $2")
        .bind(&ctx.org_id)
        .bind(team_id)
        .fetch_optional(&state.db)
        .await?;
    if exists.is_none() {
        return Err(ApiError::validation("no such team here").with_field("ownerTeamId"));
    }
    if authz::role_sees_restricted(&ctx.permissions) || authz::team_membership(&state.db, ctx, team_id).await?.is_some()
    {
        Ok(())
    } else {
        Err(ApiError::forbidden("only members of a team and org admins can hand content to it"))
    }
}

/// For patch bodies: a missing field is `None`, an explicit `null` is `Some(None)`.
pub fn double_option<'de, D: Deserializer<'de>, T: Deserialize<'de>>(d: D) -> Result<Option<Option<T>>, D::Error> {
    Option::<T>::deserialize(d).map(Some)
}

/// What the caller may do on a folder or dashboard, so the UI offers only what the server would
/// allow (grants included).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
pub struct ResourceAccess {
    write: bool,
    delete: bool,
    /// Manage its grants (and, for folders, its restriction).
    permissions: bool,
}

impl ResourceAccess {
    pub fn folder(held: Option<BTreeSet<Permission>>) -> Self {
        let held = held.unwrap_or_default();
        Self {
            write: held.contains(&Permission::FoldersWrite),
            // Trashing a folder needs write on it (and on its parts; see `Subtree::authorize`).
            delete: held.contains(&Permission::FoldersWrite),
            permissions: held.contains(&Permission::FoldersPermissions),
        }
    }

    pub fn dashboard(held: Option<BTreeSet<Permission>>) -> Self {
        let held = held.unwrap_or_default();
        Self {
            write: held.contains(&Permission::DashboardsWrite),
            delete: held.contains(&Permission::DashboardsDelete),
            permissions: held.contains(&Permission::DashboardsShare),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Folder {
    id: String,
    /// `null` at the top level, and when the caller cannot see the parent.
    parent_id: Option<String>,
    name: String,
    /// The folder's own flag; subfolders of a restricted folder are restricted as well.
    restricted: bool,
    /// The team that owns the folder; `null` for folders of the organization.
    owner_team: Option<OwnerTeam>,
    /// A team space: a restricted folder at the top level that a team owns.
    team_space: bool,
    version: i64,
    created_at: i64,
    updated_at: i64,
    deleted_at: Option<i64>,
    access: ResourceAccess,
}

fn folder(row: &FolderRow, parent_id: Option<String>, index: &AccessIndex) -> Folder {
    Folder {
        id: row.id.clone(),
        parent_id,
        name: row.name.clone(),
        restricted: row.restricted != 0,
        owner_team: OwnerTeam::of(row.owner_team_id.as_deref(), index),
        team_space: row.owner_team_id.is_some() && row.restricted != 0 && row.parent_id.is_none(),
        version: row.version,
        created_at: row.created_at,
        updated_at: row.updated_at,
        deleted_at: row.deleted_at,
        access: ResourceAccess::folder(index.folder(&row.id)),
    }
}

/// The folder as the caller sees it: a parent hidden from them is not named.
fn view(row: &FolderRow, tree: &Tree, index: &AccessIndex) -> Folder {
    folder(row, visible_parent(row, tree), index)
}

/// The parent as the caller sees it (`None` when it is hidden from them).
fn visible_parent(row: &FolderRow, tree: &Tree) -> Option<String> {
    row.parent_id.clone().filter(|p| tree.visible(p))
}

/// The answer, read through `conn`: after a change, the change's own transaction before its
/// commit, so a failing read can still be answered as "nothing changed".
async fn answer(conn: &mut sqlx::AnyConnection, ctx: &OrgCtx, folder_id: &str) -> ApiResult<Json<Folder>> {
    let tree = Tree::load(conn, ctx).await?;
    let index = AccessIndex::load(conn, ctx).await?;
    Ok(Json(view(visible_row(&tree, folder_id)?, &tree, &index)))
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

fn changed_meanwhile() -> ApiError {
    conflict("the folder changed in the meantime; load it again and retry")
}

/// The folder in `tree` if the caller sees it: `not_found` otherwise, so hidden ids cannot be
/// probed.
fn visible_row<'t>(tree: &'t Tree, folder_id: &str) -> ApiResult<&'t FolderRow> {
    match tree.rows.get(folder_id) {
        Some(row) if tree.visible(folder_id) => Ok(row),
        _ => Err(ApiError::not_found()),
    }
}

async fn pool_tree(state: &AppState, ctx: &OrgCtx) -> ApiResult<Tree> {
    Tree::load(&mut *state.db.acquire().await?, ctx).await
}

/// Before the transaction: the caller sees the folder and may do `permission` on it.
async fn authorize(state: &AppState, ctx: &OrgCtx, folder_id: &str, permission: Permission) -> ApiResult<()> {
    authz::check_resource(&state.db, ctx, permission, Resource::Folder(folder_id)).await
}

/// A parent named in a body, checked against the locked tree: visible and not trashed.
fn check_parent(tree: &Tree, parent_id: &str) -> ApiResult<()> {
    if visible_row(tree, parent_id)?.deleted_at.is_some() {
        return Err(ApiError::validation("the parent folder is in the trash").with_field("parentId"));
    }
    Ok(())
}

async fn locked_tree(conn: &mut sqlx::AnyConnection, ctx: &OrgCtx) -> ApiResult<Tree> {
    authz::lock_org(conn, &ctx.org_id).await?;
    Tree::load(conn, ctx).await
}

/// Which part of a subtree an action touches.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Part {
    /// Trash: everything not in the trash yet.
    Live,
    /// Restore: what was trashed together, in one batch.
    Batch(String),
    /// Purge and move: everything.
    All,
}

/// The folders, and the folders holding dashboards, that an action on the subtree of a folder
/// touches. Computed before the lock to check rights and again under it to check that nothing
/// joined in between.
#[derive(Debug, PartialEq, Eq)]
struct Subtree {
    folders: BTreeSet<String>,
    dashboard_folders: BTreeSet<String>,
}

impl Subtree {
    async fn of(
        conn: &mut sqlx::AnyConnection,
        ctx: &OrgCtx,
        tree: &Tree,
        folder_id: &str,
        part: &Part,
    ) -> ApiResult<Self> {
        let touched = |r: &FolderRow| match part {
            Part::Live => r.deleted_at.is_none(),
            Part::Batch(b) => r.trash_batch.as_deref() == Some(b.as_str()),
            Part::All => true,
        };
        let mut folders: BTreeSet<String> = BTreeSet::from([folder_id.to_string()]);
        folders.extend(tree.descendants(folder_id).into_iter().filter(|r| touched(r)).map(|r| r.id.clone()));
        let batch = match part {
            Part::Batch(b) => Some(b.as_str()),
            _ => None,
        };
        let mut dashboard_folders = BTreeSet::new();
        for folder in &folders {
            let (n,): (i64,) = sqlx::query_as(
                "SELECT COUNT(*) FROM dashboards WHERE org_id = $1 AND folder_id = $2 \
                 AND (CAST($3 AS BIGINT) = 0 OR deleted_at IS NULL) AND (CAST($4 AS TEXT) IS NULL OR trash_batch = $4)",
            )
            .bind(&ctx.org_id)
            .bind(folder)
            .bind(matches!(part, Part::Live) as i64)
            .bind(batch)
            .fetch_one(&mut *conn)
            .await?;
            if n > 0 {
                dashboard_folders.insert(folder.clone());
            }
        }
        Ok(Self { folders, dashboard_folders })
    }

    /// The caller may change every part: `folders:write` on each folder that another restricted
    /// folder governs (the rest follows from the top folder), `dashboards:delete` on each folder
    /// whose dashboards go along. Hidden content is `forbidden` (`Tree::check_subtree_visible`).
    async fn authorize(&self, state: &AppState, ctx: &OrgCtx, tree: &Tree, folder_id: &str) -> ApiResult<()> {
        tree.check_subtree_visible(folder_id)?;
        let top = tree.governing(folder_id);
        for folder in &self.folders {
            if folder != folder_id && tree.governing(folder) != top {
                authorize(state, ctx, folder, Permission::FoldersWrite).await.map_err(as_forbidden)?;
            }
        }
        for folder in &self.dashboard_folders {
            authorize(state, ctx, folder, Permission::DashboardsDelete).await.map_err(as_forbidden)?;
        }
        Ok(())
    }

    /// Under the lock: nothing joined the subtree since `checked` was authorized.
    fn check_unchanged(&self, checked: &Subtree) -> ApiResult<()> {
        if self.folders == checked.folders && self.dashboard_folders.is_subset(&checked.dashboard_folders) {
            Ok(())
        } else {
            Err(changed_meanwhile())
        }
    }
}

/// A part the caller cannot see was already refused by `check_subtree_visible`; anything else
/// that fails on a part is a missing right on something they see.
fn as_forbidden(e: ApiError) -> ApiError {
    if e.code == "not_found" { ApiError::forbidden("the folder contains content you may not change") } else { e }
}

/// Before the lock: the folder is visible, the caller may write it and every part of the subtree
/// the action touches (`pick` says which, from the folder's state; `None`: nothing to do). Answers
/// what was checked, for `Subtree::check_unchanged` under the lock.
async fn authorize_subtree(
    state: &AppState,
    ctx: &OrgCtx,
    folder_id: &str,
    pick: impl Fn(&FolderRow) -> Option<Part>,
) -> ApiResult<Option<(Part, Subtree)>> {
    authorize(state, ctx, folder_id, Permission::FoldersWrite).await?;
    let tree = pool_tree(state, ctx).await?;
    let Some(part) = pick(visible_row(&tree, folder_id)?) else { return Ok(None) };
    let subtree = Subtree::of(&mut *state.db.acquire().await?, ctx, &tree, folder_id, &part).await?;
    subtree.authorize(state, ctx, &tree, folder_id).await?;
    Ok(Some((part, subtree)))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ListQuery {
    /// `true` lists what was put in the trash (each trashed subtree once, by its top folder).
    trashed: Option<bool>,
    /// A team context: only folders outside other teams' spaces, the team's own spaces and what
    /// was shared with the team (see `folders::TeamScope`).
    team: Option<String>,
}

async fn list(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    QueryParams(q): QueryParams<ListQuery>,
) -> ApiResult<Json<Page<FolderNode>>> {
    let mut conn = state.db.acquire().await?;
    let tree = Tree::load(&mut conn, &ctx).await?;
    let index = AccessIndex::load(&mut conn, &ctx).await?;
    let scope = super::team_context::scope(&mut conn, &ctx, q.team.as_deref()).await?;
    drop(conn);
    let visible = |r: &&FolderRow| tree.visible(&r.id) && scope.as_ref().is_none_or(|s| s.folder(&r.id));
    if q.trashed.unwrap_or(false) {
        let mut roots: Vec<&FolderRow> = tree
            .rows
            .values()
            .filter(|r| {
                let parent_batch =
                    r.parent_id.as_deref().and_then(|p| tree.rows.get(p)).and_then(|p| p.trash_batch.as_deref());
                r.deleted_at.is_some() && parent_batch != r.trash_batch.as_deref()
            })
            .filter(visible)
            .collect();
        roots.sort_by(|a, b| b.deleted_at.cmp(&a.deleted_at).then_with(|| a.id.cmp(&b.id)));
        let items =
            roots.into_iter().map(|r| FolderNode { folder: view(r, &tree, &index), children: Vec::new() }).collect();
        return Ok(Json(Page { items, next_cursor: None }));
    }
    // A folder the caller reaches through a grant below a restricted folder they cannot see hangs
    // at the top, without naming its hidden parent.
    let active: Vec<FolderRow> = tree
        .rows
        .values()
        .filter(|r| r.deleted_at.is_none())
        .filter(visible)
        .map(|r| FolderRow { parent_id: visible_parent(r, &tree), ..r.clone() })
        .collect();
    let active: Vec<&FolderRow> = active.iter().collect();
    // The tree is one answer: folders are few compared with dashboards, and the UI shows them all.
    Ok(Json(Page { items: nest(&active, None, &index), next_cursor: None }))
}

fn nest(rows: &[&FolderRow], parent: Option<&str>, index: &AccessIndex) -> Vec<FolderNode> {
    let mut level: Vec<&FolderRow> = rows.iter().copied().filter(|r| r.parent_id.as_deref() == parent).collect();
    level.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()).then_with(|| a.id.cmp(&b.id)));
    level
        .into_iter()
        .map(|r| FolderNode { folder: folder(r, r.parent_id.clone(), index), children: nest(rows, Some(&r.id), index) })
        .collect()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateFolder {
    name: String,
    #[serde(default)]
    parent_id: Option<String>,
    #[serde(default)]
    restricted: bool,
    /// Creates a team space: a restricted folder at the top level owned by this team, which its
    /// members see and nobody else without a grant.
    #[serde(default)]
    owner_team_id: Option<String>,
}

async fn create(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    JsonBody(body): JsonBody<CreateFolder>,
) -> ApiResult<impl IntoResponse> {
    let name = clean_name(&body.name, "name").map_err(|e| e.with_field("name"))?;
    let space = body.owner_team_id.as_deref();
    match (body.parent_id.as_deref(), space) {
        (Some(_), Some(_)) => {
            return Err(ApiError::validation("a team space lives at the top level").with_field("parentId"));
        }
        // Team maintainers and org admins create team spaces; the space is the team's, so the
        // org-wide folder permissions do not decide it.
        (None, Some(team)) => {
            let maintainer = authz::team_membership(&state.db, &ctx, team).await?.as_deref() == Some("maintainer");
            if !maintainer && !authz::role_sees_restricted(&ctx.permissions) {
                return Err(ApiError::forbidden("only maintainers of the team and org admins create its team space"));
            }
            check_new_owner(&state, &ctx, Some(team)).await?;
        }
        (Some(parent), None) => {
            authorize(&state, &ctx, parent, Permission::FoldersWrite).await?;
            if body.restricted {
                // Restriction decides who sees the folder at all, so it is a permissions change.
                authorize(&state, &ctx, parent, Permission::FoldersPermissions).await?;
            }
        }
        // The top level belongs to no folder, so only the org-wide permissions count.
        (None, None) => {
            ctx.check(Permission::FoldersWrite)?;
            if body.restricted {
                ctx.check(Permission::FoldersPermissions)?;
            }
        }
    }
    let id = new_id();
    let now = state.clock.now_ms();
    let mut tx = crate::db::begin(&state.db).await?;
    let tree = locked_tree(&mut tx, &ctx).await?;
    if let Some(parent) = body.parent_id.as_deref() {
        check_parent(&tree, parent)?;
        tree.check_placement(None, parent)?;
    }
    let restricted = body.restricted || space.is_some();
    sqlx::query(
        "INSERT INTO folders (id, org_id, parent_id, name, restricted, version, created_by, created_at, updated_at, \
         owner_team_id) VALUES ($1, $2, $3, $4, $5, 1, $6, $7, $7, $8)",
    )
    .bind(&id)
    .bind(&ctx.org_id)
    .bind(body.parent_id.as_deref())
    .bind(&name)
    .bind(restricted as i64)
    .bind(&ctx.user.id)
    .bind(now)
    .bind(space)
    .execute(&mut *tx)
    .await?;
    let summary = json!({ "parentId": body.parent_id, "restricted": restricted, "ownerTeamId": space });
    audit::record(&mut tx, &event(&ctx, &info, "folder.created", &id, summary, now)).await?;
    if restricted && space.is_none() {
        keep_access(&mut tx, &ctx, &info, &id, now).await?;
    }
    let created = answer(&mut tx, &ctx, &id).await?;
    crate::db::commit(tx).await?;
    Ok((StatusCode::CREATED, created))
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

/// A member who restricts a folder (or creates one restricted) through a grant, not through
/// org-wide `folders:permissions`, would lose sight of it at once: grants above a restricted
/// folder do not reach into it. They get an `admin` grant on it in the same transaction, which
/// they may hand out since they hold its permissions there.
async fn keep_access(
    conn: &mut sqlx::AnyConnection,
    ctx: &OrgCtx,
    info: &RequestInfo,
    folder_id: &str,
    now: i64,
) -> ApiResult<()> {
    if authz::role_sees_restricted(&ctx.permissions) {
        return Ok(());
    }
    let existing: Option<(String, String)> = sqlx::query_as(
        "SELECT id, level FROM resource_grants WHERE org_id = $1 AND resource_type = 'folder' AND resource_id = $2 \
         AND subject_type = 'user' AND subject_id = $3",
    )
    .bind(&ctx.org_id)
    .bind(folder_id)
    .bind(&ctx.user.id)
    .fetch_optional(&mut *conn)
    .await?;
    let (action, summary) = match existing {
        Some((_, level)) if level == "admin" => return Ok(()),
        Some((id, level)) => {
            sqlx::query("UPDATE resource_grants SET level = 'admin' WHERE id = $1")
                .bind(&id)
                .execute(&mut *conn)
                .await?;
            ("grant.changed", json!({ "grantId": id, "from": level, "to": "admin" }))
        }
        None => {
            let id = new_id();
            sqlx::query(
                "INSERT INTO resource_grants (id, org_id, subject_type, subject_id, resource_type, resource_id, level, \
                 created_by, created_at) VALUES ($1, $2, 'user', $3, 'folder', $4, 'admin', $3, $5)",
            )
            .bind(&id)
            .bind(&ctx.org_id)
            .bind(&ctx.user.id)
            .bind(folder_id)
            .bind(now)
            .execute(&mut *conn)
            .await?;
            (
                "grant.created",
                json!({ "grantId": id, "subjectType": "user", "subjectId": ctx.user.id, "level": "admin" }),
            )
        }
    };
    audit::record(conn, &event(ctx, info, action, folder_id, summary, now)).await?;
    Ok(())
}

/// The restricted folder that would govern `folder` under `parent`: the folder itself when it is
/// restricted, else the nearest restricted folder above the new place.
fn governing_after_move(tree: &Tree, folder: &FolderRow, parent: Option<&str>) -> Option<String> {
    if folder.restricted != 0 {
        return Some(folder.id.clone());
    }
    parent.and_then(|p| tree.governing(p)).map(str::to_string)
}

async fn update(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    Path((_, folder_id)): Path<(String, String)>,
    JsonBody(body): JsonBody<UpdateFolder>,
) -> ApiResult<Json<Folder>> {
    let name = body.name.as_deref().map(|n| clean_name(n, "name").map_err(|e| e.with_field("name"))).transpose()?;
    authorize(&state, &ctx, &folder_id, Permission::FoldersWrite).await?;
    let tree = pool_tree(&state, &ctx).await?;
    let before = visible_row(&tree, &folder_id)?.clone();
    // The caller names the parent as they see it; a parent hidden from them reads as `null`, and
    // sending that back unchanged is no move.
    let new_parent = body.parent_id.clone().filter(|p| *p != visible_parent(&before, &tree));
    let mut checked = None;
    if let Some(parent) = &new_parent {
        match parent.as_deref() {
            Some(parent) => authorize(&state, &ctx, parent, Permission::FoldersWrite).await?,
            // The top level belongs to no folder, so only the org-wide permission counts, as on create.
            None => ctx.check(Permission::FoldersWrite)?,
        }
        let subtree = Subtree::of(&mut *state.db.acquire().await?, &ctx, &tree, &folder_id, &Part::All).await?;
        tree.check_subtree_visible(&folder_id)?;
        let top = tree.governing(&folder_id);
        for folder in &subtree.folders {
            if *folder != folder_id && tree.governing(folder) != top {
                authorize(&state, &ctx, folder, Permission::FoldersWrite).await.map_err(as_forbidden)?;
            }
        }
        // Moving into or out of a restricted folder changes who sees the folder: a permissions
        // change on both sides. Between the open tree and team spaces, edit rights on both
        // sides (checked above) are enough.
        let after = governing_after_move(&tree, &before, parent.as_deref());
        if tree.crossing_needs_permissions(top, after.as_deref()) {
            authorize(&state, &ctx, &folder_id, Permission::FoldersPermissions).await?;
            if let Some(parent) = parent.as_deref() {
                authorize(&state, &ctx, parent, Permission::FoldersPermissions).await?;
            }
        }
        checked = Some(subtree);
    }
    if body.restricted.is_some_and(|r| r != (before.restricted != 0)) {
        // Restriction decides who sees the folder at all, so it is a permissions change; an
        // admin grant on the folder allows it.
        authorize(&state, &ctx, &folder_id, Permission::FoldersPermissions).await?;
    }

    let mut tx = crate::db::begin(&state.db).await?;
    let tree = locked_tree(&mut tx, &ctx).await?;
    let current = visible_row(&tree, &folder_id)?.clone();
    if current.deleted_at.is_some() {
        return Err(conflict("the folder is in the trash; restore it first"));
    }
    // Checked under the lock: a version that moved on since `before` means someone else changed
    // the folder, so the checks above may have looked at an older state.
    if body.version != current.version || current.version != before.version {
        let index = AccessIndex::load(&mut tx, &ctx).await?;
        return Err(ApiError::version_conflict(json!(view(&current, &tree, &index))));
    }
    let mut next = current.clone();
    let mut changed: Vec<&str> = Vec::new();
    if let Some(name) = name
        && name != current.name
    {
        next.name = name;
        changed.push("name");
    }
    if let (Some(parent), Some(checked)) = (new_parent, &checked) {
        // Moving hidden content along would also let the depth check reveal its levels.
        tree.check_subtree_visible(&folder_id)?;
        // Placement first: the loser of two opposite moves learns of the cycle, not just that
        // something changed.
        if let Some(parent) = parent.as_deref() {
            check_parent(&tree, parent)?;
            tree.check_placement(Some(&folder_id), parent)?;
        }
        Subtree::of(&mut tx, &ctx, &tree, &folder_id, &Part::All).await?.check_unchanged(checked)?;
        next.parent_id = parent;
        changed.push("parentId");
    }
    if let Some(restricted) = body.restricted
        && restricted != (current.restricted != 0)
    {
        next.restricted = restricted as i64;
        changed.push("restricted");
    }
    if !changed.is_empty() {
        let now = state.clock.now_ms();
        sqlx::query(
            "UPDATE folders SET name = $1, parent_id = $2, restricted = $3, version = $4, updated_at = $5 \
             WHERE org_id = $6 AND id = $7",
        )
        .bind(&next.name)
        .bind(next.parent_id.as_deref())
        .bind(next.restricted)
        .bind(current.version + 1)
        .bind(now)
        .bind(&ctx.org_id)
        .bind(&folder_id)
        .execute(&mut *tx)
        .await?;
        let summary = json!({ "fields": changed });
        audit::record(&mut tx, &event(&ctx, &info, "folder.updated", &folder_id, summary, now)).await?;
        if next.restricted != 0 && current.restricted == 0 {
            keep_access(&mut tx, &ctx, &info, &folder_id, now).await?;
        }
    }
    let updated = answer(&mut tx, &ctx, &folder_id).await?;
    crate::db::commit(tx).await?;
    Ok(updated)
}

/// Sets the team that owns a folder and who else sees it (`team`: a restricted folder). Changing
/// either decides who sees and edits the folder, so it needs `folders:permissions` on it (team
/// maintainers hold it inside their team's folders); the new owner team must be the caller's
/// unless they are an org admin.
async fn set_owner(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    Path((_, folder_id)): Path<(String, String)>,
    JsonBody(body): JsonBody<OwnerRequest>,
) -> ApiResult<Json<Folder>> {
    authorize(&state, &ctx, &folder_id, Permission::FoldersPermissions).await?;
    check_new_owner(&state, &ctx, body.owner_team_id.as_deref()).await?;
    let restricted = body.visibility == Visibility::Team;
    let tree = pool_tree(&state, &ctx).await?;
    let before = visible_row(&tree, &folder_id)?.clone();
    let mut tx = crate::db::begin(&state.db).await?;
    let tree = locked_tree(&mut tx, &ctx).await?;
    let current = visible_row(&tree, &folder_id)?.clone();
    if current.deleted_at.is_some() {
        return Err(conflict("the folder is in the trash; restore it first"));
    }
    if current.version != before.version {
        return Err(changed_meanwhile());
    }
    let unchanged = current.owner_team_id == body.owner_team_id && (current.restricted != 0) == restricted;
    if !unchanged {
        let now = state.clock.now_ms();
        sqlx::query(
            "UPDATE folders SET owner_team_id = $1, restricted = $2, version = $3, updated_at = $4 \
             WHERE org_id = $5 AND id = $6",
        )
        .bind(body.owner_team_id.as_deref())
        .bind(restricted as i64)
        .bind(current.version + 1)
        .bind(now)
        .bind(&ctx.org_id)
        .bind(&folder_id)
        .execute(&mut *tx)
        .await?;
        let summary = json!({
            "from": current.owner_team_id, "to": body.owner_team_id, "visibility": body.visibility,
        });
        audit::record(&mut tx, &event(&ctx, &info, "folder.owner_changed", &folder_id, summary, now)).await?;
        // Whoever restricts a folder without belonging to its new owner team keeps sight of it.
        let member = match body.owner_team_id.as_deref() {
            Some(team) => authz::team_membership(&mut *tx, &ctx, team).await?.is_some(),
            None => false,
        };
        if restricted && !member {
            keep_access(&mut tx, &ctx, &info, &folder_id, now).await?;
        }
    }
    let updated = answer(&mut tx, &ctx, &folder_id).await?;
    crate::db::commit(tx).await?;
    Ok(updated)
}

async fn trash(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    Path((_, folder_id)): Path<(String, String)>,
) -> ApiResult<StatusCode> {
    let checked = authorize_subtree(&state, &ctx, &folder_id, |r| r.deleted_at.is_none().then_some(Part::Live)).await?;
    let mut tx = crate::db::begin(&state.db).await?;
    let tree = locked_tree(&mut tx, &ctx).await?;
    if visible_row(&tree, &folder_id)?.deleted_at.is_some() {
        return Ok(StatusCode::NO_CONTENT);
    }
    let Some((_, checked)) = checked else { return Err(changed_meanwhile()) };
    tree.check_subtree_visible(&folder_id)?;
    let subtree = Subtree::of(&mut tx, &ctx, &tree, &folder_id, &Part::Live).await?;
    subtree.check_unchanged(&checked)?;
    let now = state.clock.now_ms();
    let batch = new_id();
    let mut dashboards = 0;
    for folder in &subtree.folders {
        sqlx::query(
            "UPDATE folders SET deleted_at = $1, trash_batch = $2 WHERE org_id = $3 AND id = $4 AND deleted_at IS NULL",
        )
        .bind(now)
        .bind(&batch)
        .bind(&ctx.org_id)
        .bind(folder)
        .execute(&mut *tx)
        .await?;
        dashboards += sqlx::query(
            "UPDATE dashboards SET deleted_at = $1, trash_batch = $2 \
             WHERE org_id = $3 AND folder_id = $4 AND deleted_at IS NULL",
        )
        .bind(now)
        .bind(&batch)
        .bind(&ctx.org_id)
        .bind(folder)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    }
    let summary = json!({ "folders": subtree.folders.len(), "dashboards": dashboards });
    audit::record(&mut tx, &event(&ctx, &info, "folder.trashed", &folder_id, summary, now)).await?;
    crate::db::commit(tx).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn restore(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    Path((_, folder_id)): Path<(String, String)>,
) -> ApiResult<Json<Folder>> {
    let checked = authorize_subtree(&state, &ctx, &folder_id, |r| r.trash_batch.clone().map(Part::Batch)).await?;
    let mut tx = crate::db::begin(&state.db).await?;
    let tree = locked_tree(&mut tx, &ctx).await?;
    let current = visible_row(&tree, &folder_id)?.clone();
    let Some(batch) = current.trash_batch.clone() else {
        // Not in the trash: nothing to change; the transaction ends with the answer.
        return answer(&mut tx, &ctx, &folder_id).await;
    };
    let parent = current.parent_id.as_deref().and_then(|p| tree.rows.get(p));
    if parent.is_some_and(|p| p.deleted_at.is_some()) {
        return Err(conflict("the parent folder is in the trash; restore it first"));
    }
    // A different batch under the lock means the folder was restored and trashed again since.
    let part = Part::Batch(batch.clone());
    let Some((_, checked)) = checked.filter(|(p, _)| *p == part) else { return Err(changed_meanwhile()) };
    tree.check_subtree_visible(&folder_id)?;
    Subtree::of(&mut tx, &ctx, &tree, &folder_id, &part).await?.check_unchanged(&checked)?;
    // Everything trashed together with this folder lies below it: a batch starts at the folder
    // that was trashed, and its parts cannot be restored on their own while it is in the trash.
    let folders =
        sqlx::query("UPDATE folders SET deleted_at = NULL, trash_batch = NULL WHERE org_id = $1 AND trash_batch = $2")
            .bind(&ctx.org_id)
            .bind(&batch)
            .execute(&mut *tx)
            .await?
            .rows_affected();
    let dashboards = sqlx::query(
        "UPDATE dashboards SET deleted_at = NULL, trash_batch = NULL WHERE org_id = $1 AND trash_batch = $2",
    )
    .bind(&ctx.org_id)
    .bind(&batch)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    let now = state.clock.now_ms();
    let summary = json!({ "folders": folders, "dashboards": dashboards });
    audit::record(&mut tx, &event(&ctx, &info, "folder.restored", &folder_id, summary, now)).await?;
    let restored = answer(&mut tx, &ctx, &folder_id).await?;
    crate::db::commit(tx).await?;
    Ok(restored)
}

async fn purge(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    Path((_, folder_id)): Path<(String, String)>,
) -> ApiResult<StatusCode> {
    let not_trashed = || conflict("only folders in the trash can be purged; move it to the trash first");
    let checked = authorize_subtree(&state, &ctx, &folder_id, |r| r.deleted_at.is_some().then_some(Part::All)).await?;
    let mut tx = crate::db::begin(&state.db).await?;
    let tree = locked_tree(&mut tx, &ctx).await?;
    // Checked under the lock, where restores wait: a folder restored in the meantime stays.
    if visible_row(&tree, &folder_id)?.deleted_at.is_none() {
        return Err(not_trashed());
    }
    let Some((_, checked)) = checked else { return Err(changed_meanwhile()) };
    tree.check_subtree_visible(&folder_id)?;
    Subtree::of(&mut tx, &ctx, &tree, &folder_id, &Part::All).await?.check_unchanged(&checked)?;
    // Everything below goes, whatever its own state: nothing may be left without its folder.
    let mut ordered: Vec<&str> = vec![&folder_id];
    ordered.extend(tree.descendants(&folder_id).into_iter().map(|r| r.id.as_str()));
    let mut dashboards = 0;
    for folder in &ordered {
        // Restricted content keeps its audit events hidden once it is gone.
        if tree.governing(folder).is_some() {
            folders::tombstone_folder(&mut tx, &ctx.org_id, folder).await?;
        }
        dashboards += super::dashboards::purge_in_folder(&mut tx, &ctx.org_id, folder).await?;
    }
    // Children before parents, so no folder is left pointing at a deleted one. Grants point at
    // resources without a foreign key, so they go in the same transaction.
    for folder in ordered.iter().rev() {
        sqlx::query("DELETE FROM resource_grants WHERE org_id = $1 AND resource_type = 'folder' AND resource_id = $2")
            .bind(&ctx.org_id)
            .bind(*folder)
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM folders WHERE org_id = $1 AND id = $2")
            .bind(&ctx.org_id)
            .bind(*folder)
            .execute(&mut *tx)
            .await?;
    }
    let now = state.clock.now_ms();
    let summary = json!({ "folders": ordered.len(), "dashboards": dashboards });
    audit::record(&mut tx, &event(&ctx, &info, "folder.purged", &folder_id, summary, now)).await?;
    crate::db::commit(tx).await?;
    Ok(StatusCode::NO_CONTENT)
}
