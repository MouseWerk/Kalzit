//! Teams, their members and the roles a team gives its members (docs/api/access.md, "Teams").

use std::collections::BTreeSet;

use axum::extract::{Path, State};
use axum::http::{Method, StatusCode};
use axum::{Extension, Json};
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::support::{Actor, PageQuery, Paging, QueryParams, audit, conflict, is_unique_violation};
use super::table::{RouteDef, route};
use crate::app::AppState;
use crate::authz::{self, Access, BuiltinRole, OrgCtx, Permission, ensure_holds, lock_org, lock_role, resolve_role};
use crate::error::{ApiError, ApiResult};
use crate::extract::JsonBody;
use crate::net::RequestInfo;
use crate::shapes::Page;

/// Bounds the roles one team carries, and with them the lookups per request.
const MAX_TEAM_ROLES: usize = 20;

pub fn routes() -> Vec<RouteDef> {
    use Access::{Org, OrgMember};
    use Permission::{TeamsRead, TeamsWrite};
    vec![
        route(Method::GET, "/orgs/{orgId}/teams", Org(TeamsRead), list),
        route(Method::POST, "/orgs/{orgId}/teams", Org(TeamsWrite), create),
        route(Method::GET, "/orgs/{orgId}/teams/{teamId}", Org(TeamsRead), get_one),
        route(Method::PATCH, "/orgs/{orgId}/teams/{teamId}", Org(TeamsWrite), rename),
        route(Method::DELETE, "/orgs/{orgId}/teams/{teamId}", Org(TeamsWrite), delete),
        route(Method::GET, "/orgs/{orgId}/teams/{teamId}/members", Org(TeamsRead), list_members),
        // Maintainers manage their own team's members without `teams:members`; the handlers
        // check either.
        route(Method::PUT, "/orgs/{orgId}/teams/{teamId}/members/{userId}", OrgMember, put_member),
        route(Method::DELETE, "/orgs/{orgId}/teams/{teamId}/members/{userId}", OrgMember, remove_member),
        route(Method::PUT, "/orgs/{orgId}/teams/{teamId}/roles", Org(TeamsWrite), set_roles),
    ]
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Team {
    id: String,
    name: String,
    /// Built-in role names and custom role ids, sorted.
    roles: Vec<String>,
    member_count: i64,
    created_at: i64,
}

#[derive(sqlx::FromRow)]
struct TeamRow {
    id: String,
    name: String,
    member_count: i64,
    created_at: i64,
}

const TEAM_COLUMNS: &str = "SELECT t.id, t.name, t.created_at, \
     (SELECT COUNT(*) FROM team_members m WHERE m.team_id = t.id) AS member_count FROM teams t";

async fn team_roles<'c, E>(db: E, team_id: &str) -> ApiResult<Vec<String>>
where
    E: sqlx::Executor<'c, Database = sqlx::Any>,
{
    let rows: Vec<(String,)> = sqlx::query_as("SELECT role FROM team_roles WHERE team_id = $1 ORDER BY role")
        .bind(team_id)
        .fetch_all(db)
        .await?;
    Ok(rows.into_iter().map(|(r,)| r).collect())
}

async fn load(conn: &mut sqlx::AnyConnection, org_id: &str, team_id: &str) -> ApiResult<Team> {
    // Built from constants only, so nothing from the request reaches the SQL text.
    let row: TeamRow = sqlx::query_as(sqlx::AssertSqlSafe(format!("{TEAM_COLUMNS} WHERE t.org_id = $1 AND t.id = $2")))
        .bind(org_id)
        .bind(team_id)
        .fetch_optional(&mut *conn)
        .await?
        .ok_or_else(ApiError::not_found)?;
    let roles = team_roles(&mut *conn, &row.id).await?;
    Ok(Team { id: row.id, name: row.name, roles, member_count: row.member_count, created_at: row.created_at })
}

async fn list(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    QueryParams(q): QueryParams<PageQuery>,
) -> ApiResult<Json<Page<Team>>> {
    let paging = Paging::new(q.limit, q.cursor.as_deref())?;
    let rows: Vec<TeamRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "{TEAM_COLUMNS} WHERE t.org_id = $1 AND (t.created_at < $2 OR (t.created_at = $2 AND t.id < $3)) \
         ORDER BY t.created_at DESC, t.id DESC LIMIT $4"
    )))
    .bind(&ctx.org_id)
    .bind(paging.before_time())
    .bind(paging.before_id())
    .bind(paging.fetch_limit())
    .fetch_all(&state.db)
    .await?;
    let page = paging.page(rows, |t| (t.created_at, t.id.as_str()));
    let mut items = Vec::with_capacity(page.items.len());
    for row in page.items {
        let roles = team_roles(&state.db, &row.id).await?;
        items.push(Team {
            id: row.id,
            name: row.name,
            roles,
            member_count: row.member_count,
            created_at: row.created_at,
        });
    }
    Ok(Json(Page { items, next_cursor: page.next_cursor }))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NameRequest {
    name: String,
}

fn duplicate_name() -> ApiError {
    conflict("a team with this name exists already").with_field("name")
}

async fn create(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    JsonBody(req): JsonBody<NameRequest>,
) -> ApiResult<(StatusCode, Json<Team>)> {
    let name = super::clean_name(&req.name, "name").map_err(|e| e.with_field("name"))?;
    let id = super::new_id();
    let now = state.clock.now_ms();
    let mut tx = crate::db::begin(&state.db).await?;
    lock_org(&mut tx, &ctx.org_id).await?;
    sqlx::query("INSERT INTO teams (id, org_id, name, name_key, created_at) VALUES ($1, $2, $3, $4, $5)")
        .bind(&id)
        .bind(&ctx.org_id)
        .bind(&name)
        .bind(name.to_lowercase())
        .bind(now)
        .execute(&mut *tx)
        .await
        .map_err(|e| if is_unique_violation(&e) { duplicate_name() } else { e.into() })?;
    let actor = Actor { user_id: &ctx.user.id, info: &info, at_ms: now };
    audit(&mut tx, &actor, Some(&ctx.org_id), "team.created", ("team", &id), json!({ "teamId": id })).await?;
    let team = load(&mut tx, &ctx.org_id, &id).await?;
    crate::db::commit(tx).await?;
    Ok((StatusCode::CREATED, Json(team)))
}

async fn get_one(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Path((_, team_id)): Path<(String, String)>,
) -> ApiResult<Json<Team>> {
    Ok(Json(load(&mut *state.db.acquire().await?, &ctx.org_id, &team_id).await?))
}

async fn rename(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    Path((_, team_id)): Path<(String, String)>,
    JsonBody(req): JsonBody<NameRequest>,
) -> ApiResult<Json<Team>> {
    let name = super::clean_name(&req.name, "name").map_err(|e| e.with_field("name"))?;
    let mut tx = crate::db::begin(&state.db).await?;
    lock_org(&mut tx, &ctx.org_id).await?;
    let done = sqlx::query("UPDATE teams SET name = $1, name_key = $2 WHERE org_id = $3 AND id = $4")
        .bind(&name)
        .bind(name.to_lowercase())
        .bind(&ctx.org_id)
        .bind(&team_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| if is_unique_violation(&e) { duplicate_name() } else { e.into() })?;
    if done.rows_affected() == 0 {
        return Err(ApiError::not_found());
    }
    let actor = Actor { user_id: &ctx.user.id, info: &info, at_ms: state.clock.now_ms() };
    let summary = json!({ "teamId": team_id, "fields": ["name"] });
    audit(&mut tx, &actor, Some(&ctx.org_id), "team.renamed", ("team", &team_id), summary).await?;
    let team = load(&mut tx, &ctx.org_id, &team_id).await?;
    crate::db::commit(tx).await?;
    Ok(Json(team))
}

/// Everything the team's roles allow, so that taking them away from its members (deleting the
/// team, removing a member) or handing them out (adding a member) needs the caller to hold it.
async fn team_permissions(
    conn: &mut sqlx::AnyConnection,
    org_id: &str,
    team_id: &str,
) -> ApiResult<BTreeSet<Permission>> {
    let mut out = BTreeSet::new();
    for key in team_roles(&mut *conn, team_id).await? {
        if let Some(info) = resolve_role(&mut *conn, org_id, &key).await? {
            out.extend(info.permissions);
        }
    }
    Ok(out)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DeleteQuery {
    /// Who takes over the team's spaces, folders and dashboards: another team's id, or `org`.
    transfer_to: Option<String>,
}

/// Hands everything the team owns to `to` (`None`: the organization) inside the deletion's
/// transaction. Answers how many folders and dashboards changed hands.
async fn hand_over(conn: &mut sqlx::AnyConnection, org_id: &str, team_id: &str, to: Option<&str>) -> ApiResult<u64> {
    let mut moved = 0;
    for sql in [
        "UPDATE folders SET owner_team_id = $1, version = version + 1 WHERE org_id = $2 AND owner_team_id = $3",
        "UPDATE dashboards SET owner_team_id = $1 WHERE org_id = $2 AND owner_team_id = $3",
    ] {
        moved += sqlx::query(sql).bind(to).bind(org_id).bind(team_id).execute(&mut *conn).await?.rows_affected();
    }
    Ok(moved)
}

/// Whether the caller maintains the team.
async fn maintains(conn: &mut sqlx::AnyConnection, ctx: &OrgCtx, team_id: &str) -> ApiResult<bool> {
    Ok(authz::team_membership(&mut *conn, ctx, team_id).await?.as_deref() == Some("maintainer"))
}

async fn delete(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    Path((_, team_id)): Path<(String, String)>,
    QueryParams(q): QueryParams<DeleteQuery>,
) -> ApiResult<StatusCode> {
    let mut tx = crate::db::begin(&state.db).await?;
    lock_org(&mut tx, &ctx.org_id).await?;
    load(&mut tx, &ctx.org_id, &team_id).await?;
    ensure_holds(&ctx.permissions, &team_permissions(&mut tx, &ctx.org_id, &team_id).await?)?;
    // A team's spaces, folders and dashboards are handed over before it goes: to another team, or
    // to the organization (where only org admins and grants reach team-only content).
    let (owned,): (i64,) = sqlx::query_as(
        "SELECT (SELECT COUNT(*) FROM folders WHERE org_id = $1 AND owner_team_id = $2) \
         + (SELECT COUNT(*) FROM dashboards WHERE org_id = $1 AND owner_team_id = $2)",
    )
    .bind(&ctx.org_id)
    .bind(&team_id)
    .fetch_one(&mut *tx)
    .await?;
    let transfer = match q.transfer_to.as_deref() {
        None | Some("org") => None,
        Some(other) if other == team_id => {
            return Err(ApiError::validation("a team cannot take over its own content").with_field("transferTo"));
        }
        Some(other) => {
            let found: Option<(String,)> = sqlx::query_as("SELECT id FROM teams WHERE org_id = $1 AND id = $2")
                .bind(&ctx.org_id)
                .bind(other)
                .fetch_optional(&mut *tx)
                .await?;
            if found.is_none() {
                return Err(ApiError::validation("no such team here").with_field("transferTo"));
            }
            Some(other)
        }
    };
    if owned > 0 && q.transfer_to.is_none() {
        return Err(
            conflict("the team owns team spaces, folders or dashboards; hand them over first").with_field("transferTo")
        );
    }
    // Team spaces and team-only content change hands only through org admins or maintainers of
    // both teams (of the one going, for a handover to the organization): `teams:write` alone
    // would let a custom role carry a team's hidden content to a team it maintains.
    let (restricted,): (i64,) = sqlx::query_as(
        "SELECT (SELECT COUNT(*) FROM folders WHERE org_id = $1 AND owner_team_id = $2 AND restricted = 1) \
         + (SELECT COUNT(*) FROM dashboards WHERE org_id = $1 AND owner_team_id = $2 AND team_only = 1)",
    )
    .bind(&ctx.org_id)
    .bind(&team_id)
    .fetch_one(&mut *tx)
    .await?;
    let mut admin_access = false;
    if restricted > 0 {
        let mut both = maintains(&mut tx, &ctx, &team_id).await?;
        if let Some(other) = transfer {
            both = both && maintains(&mut tx, &ctx, other).await?;
        }
        if !both && !authz::role_sees_restricted(&ctx.permissions) {
            return Err(ApiError::forbidden(
                "the team owns team spaces or team-only content; only org admins or maintainers of both teams hand it over",
            ));
        }
        admin_access = !both;
    }
    let handed = hand_over(&mut tx, &ctx.org_id, &team_id, transfer).await?;
    if admin_access {
        let actor = Actor { user_id: &ctx.user.id, info: &info, at_ms: state.clock.now_ms() };
        let access = json!({ "action": "team.deleted", "teamId": team_id, "transferTo": q.transfer_to });
        audit(&mut tx, &actor, Some(&ctx.org_id), "team_space.admin_access", ("team", &team_id), access).await?;
    }
    sqlx::query("DELETE FROM team_contexts WHERE org_id = $1 AND team_id = $2")
        .bind(&ctx.org_id)
        .bind(&team_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM resource_grants WHERE org_id = $1 AND subject_type = 'team' AND subject_id = $2")
        .bind(&ctx.org_id)
        .bind(&team_id)
        .execute(&mut *tx)
        .await?;
    // Explicit rather than through ON DELETE CASCADE, which SQLite applies only with foreign keys
    // switched on for the connection.
    for sql in ["DELETE FROM team_members WHERE team_id = $1", "DELETE FROM team_roles WHERE team_id = $1"] {
        sqlx::query(sql).bind(&team_id).execute(&mut *tx).await?;
    }
    sqlx::query("DELETE FROM teams WHERE org_id = $1 AND id = $2")
        .bind(&ctx.org_id)
        .bind(&team_id)
        .execute(&mut *tx)
        .await?;
    let actor = Actor { user_id: &ctx.user.id, info: &info, at_ms: state.clock.now_ms() };
    let summary = json!({ "teamId": team_id, "transferTo": q.transfer_to, "handedOver": handed });
    audit(&mut tx, &actor, Some(&ctx.org_id), "team.deleted", ("team", &team_id), summary).await?;
    crate::db::commit(tx).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct TeamMember {
    user_id: String,
    email: String,
    name: String,
    /// `member` or `maintainer`.
    role: String,
    added_at: i64,
}

const TEAM_MEMBER_COLUMNS: &str = "SELECT u.id AS user_id, u.email, u.name, m.role, m.created_at AS added_at \
     FROM team_members m JOIN users u ON u.id = m.user_id";

async fn list_members(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Path((_, team_id)): Path<(String, String)>,
    QueryParams(q): QueryParams<PageQuery>,
) -> ApiResult<Json<Page<TeamMember>>> {
    let paging = Paging::new(q.limit, q.cursor.as_deref())?;
    load(&mut *state.db.acquire().await?, &ctx.org_id, &team_id).await?;
    let rows: Vec<TeamMember> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "{TEAM_MEMBER_COLUMNS} WHERE m.team_id = $1 AND (m.created_at < $2 OR (m.created_at = $2 AND u.id < $3)) \
         ORDER BY m.created_at DESC, u.id DESC LIMIT $4"
    )))
    .bind(&team_id)
    .bind(paging.before_time())
    .bind(paging.before_id())
    .bind(paging.fetch_limit())
    .fetch_all(&state.db)
    .await?;
    Ok(Json(paging.page(rows, |m| (m.added_at, m.user_id.as_str()))))
}

/// The team exists in the organization and the caller may manage its members: through
/// `teams:members`, or as one of its maintainers.
async fn ensure_may_manage_members(conn: &mut sqlx::AnyConnection, ctx: &OrgCtx, team_id: &str) -> ApiResult<()> {
    let found: Option<(String,)> = sqlx::query_as("SELECT id FROM teams WHERE org_id = $1 AND id = $2")
        .bind(&ctx.org_id)
        .bind(team_id)
        .fetch_optional(&mut *conn)
        .await?;
    if found.is_none() {
        return Err(ApiError::not_found());
    }
    if ctx.permissions.contains(&Permission::TeamsMembers) {
        return Ok(());
    }
    let maintainer: Option<(String,)> =
        sqlx::query_as("SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2 AND role = 'maintainer'")
            .bind(team_id)
            .bind(&ctx.user.id)
            .fetch_optional(&mut *conn)
            .await?;
    match maintainer {
        Some(_) => Ok(()),
        None => Err(ApiError::forbidden("missing permission teams:members")),
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PutMemberRequest {
    #[serde(default)]
    role: Option<String>,
}

async fn put_member(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    Path((_, team_id, user_id)): Path<(String, String, String)>,
    JsonBody(req): JsonBody<PutMemberRequest>,
) -> ApiResult<Json<TeamMember>> {
    let role = req.role.unwrap_or_else(|| "member".into());
    if role != "member" && role != "maintainer" {
        return Err(ApiError::validation("role must be member or maintainer").with_field("role"));
    }
    let mut tx = crate::db::begin(&state.db).await?;
    lock_org(&mut tx, &ctx.org_id).await?;
    ensure_may_manage_members(&mut tx, &ctx, &team_id).await?;
    let in_org: Option<(String,)> = sqlx::query_as("SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2")
        .bind(&ctx.org_id)
        .bind(&user_id)
        .fetch_optional(&mut *tx)
        .await?;
    if in_org.is_none() {
        return Err(ApiError::not_found());
    }
    // Joining a team hands out its roles.
    ensure_holds(&ctx.permissions, &team_permissions(&mut tx, &ctx.org_id, &team_id).await?)?;
    // And its team spaces and team-only content: that is for the team's maintainers, and for org
    // admins, whose access to a team's content is audited.
    let (owned,): (i64,) = sqlx::query_as(
        "SELECT (SELECT COUNT(*) FROM folders WHERE org_id = $1 AND owner_team_id = $2 AND restricted = 1) \
         + (SELECT COUNT(*) FROM dashboards WHERE org_id = $1 AND owner_team_id = $2 AND team_only = 1)",
    )
    .bind(&ctx.org_id)
    .bind(&team_id)
    .fetch_one(&mut *tx)
    .await?;
    let maintainer = authz::team_membership(&mut *tx, &ctx, &team_id).await?.as_deref() == Some("maintainer");
    let admin_access = owned > 0 && !maintainer;
    if admin_access && !authz::role_sees_restricted(&ctx.permissions) {
        return Err(ApiError::forbidden(
            "the team owns team spaces or team-only content; only its maintainers and org admins add members",
        ));
    }
    let current: Option<(String,)> =
        sqlx::query_as("SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2")
            .bind(&team_id)
            .bind(&user_id)
            .fetch_optional(&mut *tx)
            .await?;
    let now = state.clock.now_ms();
    let actor = Actor { user_id: &ctx.user.id, info: &info, at_ms: now };
    let summary = json!({ "teamId": team_id, "userId": user_id, "role": role });
    match current {
        None => {
            sqlx::query("INSERT INTO team_members (team_id, user_id, role, created_at) VALUES ($1, $2, $3, $4)")
                .bind(&team_id)
                .bind(&user_id)
                .bind(&role)
                .bind(now)
                .execute(&mut *tx)
                .await?;
            audit(&mut tx, &actor, Some(&ctx.org_id), "team.member_added", ("team", &team_id), summary.clone()).await?;
            if admin_access {
                let access = json!({ "action": "team.member_added", "teamId": team_id, "userId": user_id });
                audit(&mut tx, &actor, Some(&ctx.org_id), "team_space.admin_access", ("team", &team_id), access)
                    .await?;
            }
        }
        Some((previous,)) if previous != role => {
            sqlx::query("UPDATE team_members SET role = $1 WHERE team_id = $2 AND user_id = $3")
                .bind(&role)
                .bind(&team_id)
                .bind(&user_id)
                .execute(&mut *tx)
                .await?;
            audit(&mut tx, &actor, Some(&ctx.org_id), "team.member_changed", ("team", &team_id), summary).await?;
        }
        Some(_) => {}
    }
    let member: TeamMember =
        sqlx::query_as(sqlx::AssertSqlSafe(format!("{TEAM_MEMBER_COLUMNS} WHERE m.team_id = $1 AND m.user_id = $2")))
            .bind(&team_id)
            .bind(&user_id)
            .fetch_one(&mut *tx)
            .await?;
    crate::db::commit(tx).await?;
    Ok(Json(member))
}

async fn remove_member(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    Path((_, team_id, user_id)): Path<(String, String, String)>,
) -> ApiResult<StatusCode> {
    let mut tx = crate::db::begin(&state.db).await?;
    lock_org(&mut tx, &ctx.org_id).await?;
    ensure_may_manage_members(&mut tx, &ctx, &team_id).await?;
    ensure_holds(&ctx.permissions, &team_permissions(&mut tx, &ctx.org_id, &team_id).await?)?;
    let done = sqlx::query("DELETE FROM team_members WHERE team_id = $1 AND user_id = $2")
        .bind(&team_id)
        .bind(&user_id)
        .execute(&mut *tx)
        .await?;
    if done.rows_affected() == 0 {
        return Err(ApiError::not_found());
    }
    // A team context on a team the member left falls back on the next read; dropping it here
    // keeps the stored choice honest.
    sqlx::query("DELETE FROM team_contexts WHERE org_id = $1 AND user_id = $2 AND team_id = $3")
        .bind(&ctx.org_id)
        .bind(&user_id)
        .bind(&team_id)
        .execute(&mut *tx)
        .await?;
    let actor = Actor { user_id: &ctx.user.id, info: &info, at_ms: state.clock.now_ms() };
    let summary = json!({ "teamId": team_id, "userId": user_id });
    audit(&mut tx, &actor, Some(&ctx.org_id), "team.member_removed", ("team", &team_id), summary).await?;
    crate::db::commit(tx).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RolesRequest {
    roles: Vec<String>,
}

async fn set_roles(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    Path((_, team_id)): Path<(String, String)>,
    JsonBody(req): JsonBody<RolesRequest>,
) -> ApiResult<Json<Team>> {
    let keys: BTreeSet<String> = req.roles.into_iter().collect();
    if keys.len() > MAX_TEAM_ROLES {
        return Err(ApiError::validation(format!("a team can have at most {MAX_TEAM_ROLES} roles")).with_field("roles"));
    }
    let mut tx = crate::db::begin(&state.db).await?;
    lock_org(&mut tx, &ctx.org_id).await?;
    load(&mut tx, &ctx.org_id, &team_id).await?;
    let mut changed = team_permissions(&mut tx, &ctx.org_id, &team_id).await?;
    for key in &keys {
        // Owners are members with that org role, so the last-owner rule can hold.
        if key == BuiltinRole::Owner.as_str() {
            return Err(ApiError::validation("owner cannot be a team role").with_field("roles"));
        }
        let info = lock_role(&mut tx, &ctx.org_id, key)
            .await?
            .ok_or_else(|| ApiError::validation(format!("no such role: {key}")).with_field("roles"))?;
        changed.extend(info.permissions);
    }
    // Both what the members gain and what they lose.
    ensure_holds(&ctx.permissions, &changed)?;
    sqlx::query("DELETE FROM team_roles WHERE team_id = $1").bind(&team_id).execute(&mut *tx).await?;
    for key in &keys {
        sqlx::query("INSERT INTO team_roles (team_id, role) VALUES ($1, $2)")
            .bind(&team_id)
            .bind(key)
            .execute(&mut *tx)
            .await?;
    }
    let actor = Actor { user_id: &ctx.user.id, info: &info, at_ms: state.clock.now_ms() };
    let summary = json!({ "teamId": team_id, "roles": keys });
    audit(&mut tx, &actor, Some(&ctx.org_id), "team.roles_changed", ("team", &team_id), summary).await?;
    let team = load(&mut tx, &ctx.org_id, &team_id).await?;
    crate::db::commit(tx).await?;
    Ok(Json(team))
}
