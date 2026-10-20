//! The members of an organization and their roles (docs/api/access.md, "Members").

use axum::extract::{Path, State};
use axum::http::{Method, StatusCode};
use axum::{Extension, Json};
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::support::{Actor, PageQuery, Paging, QueryParams, audit, conflict};
use super::table::{RouteDef, route};
use crate::app::AppState;
use crate::authz::{Access, OrgCtx, Permission, ensure_holds, ensure_owner_remains, lock_owners, resolve_role};
use crate::error::{ApiError, ApiResult};
use crate::extract::JsonBody;
use crate::net::RequestInfo;
use crate::shapes::Page;

pub fn routes() -> Vec<RouteDef> {
    vec![
        route(Method::GET, "/orgs/{orgId}/members", Access::Org(Permission::UsersRead), list),
        route(Method::POST, "/orgs/{orgId}/members", Access::Org(Permission::UsersWrite), add),
        route(Method::PATCH, "/orgs/{orgId}/members/{userId}", Access::Org(Permission::UsersWrite), change_role),
        route(Method::DELETE, "/orgs/{orgId}/members/{userId}", Access::Org(Permission::UsersWrite), remove),
    ]
}

#[derive(Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Member {
    user_id: String,
    email: String,
    name: String,
    /// A built-in role name or a custom role id.
    role: String,
    joined_at: i64,
}

const MEMBER_COLUMNS: &str = "SELECT u.id AS user_id, u.email, u.name, m.role, m.created_at AS joined_at FROM org_members m \
     JOIN users u ON u.id = m.user_id";

async fn load<'c, E>(db: E, org_id: &str, user_id: &str) -> ApiResult<Member>
where
    E: sqlx::Executor<'c, Database = sqlx::Any>,
{
    sqlx::query_as(sqlx::AssertSqlSafe(format!("{MEMBER_COLUMNS} WHERE m.org_id = $1 AND m.user_id = $2")))
        .bind(org_id)
        .bind(user_id)
        .fetch_optional(db)
        .await?
        .ok_or_else(ApiError::not_found)
}

async fn list(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    QueryParams(q): QueryParams<PageQuery>,
) -> ApiResult<Json<Page<Member>>> {
    let paging = Paging::new(q.limit, q.cursor.as_deref())?;
    let rows: Vec<Member> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "{MEMBER_COLUMNS} WHERE m.org_id = $1 AND (m.created_at < $2 OR (m.created_at = $2 AND u.id < $3)) \
         ORDER BY m.created_at DESC, u.id DESC LIMIT $4"
    )))
    .bind(&ctx.org_id)
    .bind(paging.before_time())
    .bind(paging.before_id())
    .bind(paging.fetch_limit())
    .fetch_all(&state.db)
    .await?;
    Ok(Json(paging.page(rows, |m| (m.joined_at, m.user_id.as_str()))))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AddRequest {
    email: String,
    role: String,
}

async fn add(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    JsonBody(req): JsonBody<AddRequest>,
) -> ApiResult<(StatusCode, Json<Member>)> {
    let email = super::normalize_email(&req.email).map_err(|e| e.with_field("email"))?;
    let role = resolve_role(&state.db, &ctx.org_id, &req.role)
        .await?
        .ok_or_else(|| ApiError::validation("no such role").with_field("role"))?;
    ensure_holds(&ctx.permissions, &role.permissions)?;

    let mut tx = state.db.begin().await?;
    let user: Option<(String,)> =
        sqlx::query_as("SELECT id FROM users WHERE email = $1").bind(&email).fetch_optional(&mut *tx).await?;
    // Adding works for existing accounts only; invitations by mail come with `users:invite`.
    let Some((user_id,)) = user else {
        return Err(ApiError::validation("no account has this email").with_field("email"));
    };
    let (existing,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM org_members WHERE org_id = $1 AND user_id = $2")
        .bind(&ctx.org_id)
        .bind(&user_id)
        .fetch_one(&mut *tx)
        .await?;
    if existing > 0 {
        return Err(conflict("this account is already a member").with_field("email"));
    }
    let now = state.clock.now_ms();
    sqlx::query("INSERT INTO org_members (org_id, user_id, role, created_at) VALUES ($1, $2, $3, $4)")
        .bind(&ctx.org_id)
        .bind(&user_id)
        .bind(&role.key)
        .bind(now)
        .execute(&mut *tx)
        .await?;
    let actor = Actor { user_id: &ctx.user.id, info: &info, at_ms: now };
    let summary = json!({ "userId": user_id, "role": role.key });
    audit(&mut tx, &actor, Some(&ctx.org_id), "member.added", ("user", &user_id), summary).await?;
    let member = load(&mut *tx, &ctx.org_id, &user_id).await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(member)))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RoleRequest {
    role: String,
}

/// The member's current role inside the transaction, after the owner rows are locked, with the
/// guards every change of a member passes: the caller holds what the member had (nobody changes
/// someone with more rights than themselves), and an owner remains.
async fn current_role_checked(
    tx: &mut sqlx::AnyConnection,
    ctx: &OrgCtx,
    user_id: &str,
    new_role: Option<&str>,
) -> ApiResult<String> {
    let owners = lock_owners(tx, &ctx.org_id).await?;
    let current: Option<(String,)> = sqlx::query_as("SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2")
        .bind(&ctx.org_id)
        .bind(user_id)
        .fetch_optional(&mut *tx)
        .await?;
    let Some((current,)) = current else { return Err(ApiError::not_found()) };
    if let Some(info) = resolve_role(&mut *tx, &ctx.org_id, &current).await? {
        ensure_holds(&ctx.permissions, &info.permissions)?;
    }
    ensure_owner_remains(&current, new_role, owners)?;
    Ok(current)
}

async fn change_role(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    Path((_, user_id)): Path<(String, String)>,
    JsonBody(req): JsonBody<RoleRequest>,
) -> ApiResult<Json<Member>> {
    let role = resolve_role(&state.db, &ctx.org_id, &req.role)
        .await?
        .ok_or_else(|| ApiError::validation("no such role").with_field("role"))?;
    ensure_holds(&ctx.permissions, &role.permissions)?;

    let mut tx = state.db.begin().await?;
    let previous = current_role_checked(&mut tx, &ctx, &user_id, Some(&role.key)).await?;
    if previous != role.key {
        sqlx::query("UPDATE org_members SET role = $1 WHERE org_id = $2 AND user_id = $3")
            .bind(&role.key)
            .bind(&ctx.org_id)
            .bind(&user_id)
            .execute(&mut *tx)
            .await?;
        let actor = Actor { user_id: &ctx.user.id, info: &info, at_ms: state.clock.now_ms() };
        let summary = json!({ "userId": user_id, "from": previous, "to": role.key });
        audit(&mut tx, &actor, Some(&ctx.org_id), "member.role_changed", ("user", &user_id), summary).await?;
    }
    let member = load(&mut *tx, &ctx.org_id, &user_id).await?;
    tx.commit().await?;
    Ok(Json(member))
}

async fn remove(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    Path((_, user_id)): Path<(String, String)>,
) -> ApiResult<StatusCode> {
    let mut tx = state.db.begin().await?;
    current_role_checked(&mut tx, &ctx, &user_id, None).await?;
    // Team memberships and grants in this organization go with the membership; the account and
    // its memberships elsewhere stay.
    sqlx::query("DELETE FROM team_members WHERE user_id = $1 AND team_id IN (SELECT id FROM teams WHERE org_id = $2)")
        .bind(&user_id)
        .bind(&ctx.org_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM resource_grants WHERE org_id = $1 AND subject_type = 'user' AND subject_id = $2")
        .bind(&ctx.org_id)
        .bind(&user_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM org_members WHERE org_id = $1 AND user_id = $2")
        .bind(&ctx.org_id)
        .bind(&user_id)
        .execute(&mut *tx)
        .await?;
    let actor = Actor { user_id: &ctx.user.id, info: &info, at_ms: state.clock.now_ms() };
    audit(&mut tx, &actor, Some(&ctx.org_id), "member.removed", ("user", &user_id), json!({ "userId": user_id }))
        .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}
