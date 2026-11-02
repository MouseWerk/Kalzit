//! Organizations on this server, for server administrators (docs/api/access.md, "Server
//! administration").

use axum::extract::{Path, State};
use axum::http::{HeaderMap, Method, StatusCode};
use axum::{Extension, Json};
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::support::{Actor, PageQuery, Paging, QueryParams, audit};
use super::table::{RouteDef, route};
use crate::app::AppState;
use crate::auth::SessionUser;
use crate::authz::{Access, BuiltinRole};
use crate::error::{ApiError, ApiResult};
use crate::extract::JsonBody;
use crate::net::RequestInfo;
use crate::shapes::Page;

pub fn routes() -> Vec<RouteDef> {
    vec![
        route(Method::GET, "/admin/orgs", Access::ServerAdmin, list),
        route(Method::POST, "/admin/orgs", Access::ServerAdmin, create),
        route(Method::PATCH, "/admin/orgs/{orgId}", Access::ServerAdmin, rename),
        route(Method::PATCH, "/admin/orgs/{orgId}/sign-in-rules", Access::ServerAdmin, reset_sign_in_rules),
    ]
}

#[derive(Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct AdminOrg {
    id: String,
    name: String,
    member_count: i64,
    created_at: i64,
}

const ORG_COLUMNS: &str = "SELECT o.id, o.name, o.created_at, \
     (SELECT COUNT(*) FROM org_members m JOIN users u ON u.id = m.user_id \
      WHERE m.org_id = o.id AND u.service_account = 0) AS member_count FROM orgs o";

async fn load<'c, E>(db: E, org_id: &str) -> ApiResult<AdminOrg>
where
    E: sqlx::Executor<'c, Database = sqlx::Any>,
{
    // Built from constants only, so nothing from the request reaches the SQL text.
    sqlx::query_as(sqlx::AssertSqlSafe(format!("{ORG_COLUMNS} WHERE o.id = $1")))
        .bind(org_id)
        .fetch_optional(db)
        .await?
        .ok_or_else(ApiError::not_found)
}

async fn list(
    State(state): State<AppState>,
    QueryParams(q): QueryParams<PageQuery>,
) -> ApiResult<Json<Page<AdminOrg>>> {
    let paging = Paging::new(q.limit, q.cursor.as_deref())?;
    let rows: Vec<AdminOrg> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "{ORG_COLUMNS} WHERE o.created_at < $1 OR (o.created_at = $1 AND o.id < $2) \
         ORDER BY o.created_at DESC, o.id DESC LIMIT $3"
    )))
    .bind(paging.before_time())
    .bind(paging.before_id())
    .bind(paging.fetch_limit())
    .fetch_all(&state.db)
    .await?;
    Ok(Json(paging.page(rows, |o| (o.created_at, o.id.as_str()))))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateRequest {
    name: String,
    /// An existing account that becomes the organization's first owner. Server admins are not
    /// members of every organization, so someone has to own it.
    owner_user_id: String,
}

async fn create(
    State(state): State<AppState>,
    Extension(admin): Extension<SessionUser>,
    Extension(info): Extension<RequestInfo>,
    JsonBody(req): JsonBody<CreateRequest>,
) -> ApiResult<(StatusCode, Json<AdminOrg>)> {
    let name = super::clean_name(&req.name, "name").map_err(|e| e.with_field("name"))?;
    let id = super::new_id();
    let now = state.clock.now_ms();
    let mut tx = crate::db::begin(&state.db).await?;
    // Locks the owner's row, which also makes the transaction write first (docs/ARCHITECTURE.md,
    // "write first"): a disable of that account waits for this to finish.
    let owner =
        sqlx::query("UPDATE users SET disabled = disabled WHERE id = $1 AND disabled = 0 AND service_account = 0")
            .bind(&req.owner_user_id)
            .execute(&mut *tx)
            .await?;
    // A disabled account cannot sign in, so it could not use the organization it owns; a service
    // account belongs to one organization and is never an owner.
    if owner.rows_affected() == 0 {
        return Err(ApiError::validation("no such account, or it is disabled").with_field("ownerUserId"));
    }
    sqlx::query("INSERT INTO orgs (id, name, created_at) VALUES ($1, $2, $3)")
        .bind(&id)
        .bind(&name)
        .bind(now)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "INSERT INTO org_members (org_id, user_id, role, created_at, joined_by) VALUES ($1, $2, $3, $4, 'creator')",
    )
    .bind(&id)
    .bind(&req.owner_user_id)
    .bind(BuiltinRole::Owner.as_str())
    .bind(now)
    .execute(&mut *tx)
    .await?;
    // Owner of another organization now: no SCIM owns the account any more.
    crate::scim::release(&mut tx, &req.owner_user_id, Some(&id)).await?;
    let actor = Actor { user_id: &admin.id, info: &info, at_ms: now };
    let summary = json!({ "orgId": id, "ownerUserId": req.owner_user_id });
    audit(&mut tx, &actor, Some(&id), "org.created", ("org", &id), summary).await?;
    let org = load(&mut *tx, &id).await?;
    crate::db::commit(tx).await?;
    Ok((StatusCode::CREATED, Json(org)))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RenameRequest {
    name: String,
}

async fn rename(
    State(state): State<AppState>,
    Extension(admin): Extension<SessionUser>,
    Extension(info): Extension<RequestInfo>,
    Path(org_id): Path<String>,
    JsonBody(req): JsonBody<RenameRequest>,
) -> ApiResult<Json<AdminOrg>> {
    let name = super::clean_name(&req.name, "name").map_err(|e| e.with_field("name"))?;
    let mut tx = crate::db::begin(&state.db).await?;
    let done =
        sqlx::query("UPDATE orgs SET name = $1 WHERE id = $2").bind(&name).bind(&org_id).execute(&mut *tx).await?;
    if done.rows_affected() == 0 {
        return Err(ApiError::not_found());
    }
    let actor = Actor { user_id: &admin.id, info: &info, at_ms: state.clock.now_ms() };
    let summary = json!({ "orgId": org_id, "fields": ["name"] });
    audit(&mut tx, &actor, Some(&org_id), "org.renamed", ("org", &org_id), summary).await?;
    let org = load(&mut *tx, &org_id).await?;
    crate::db::commit(tx).await?;
    Ok(Json(org))
}

/// The organization sign-in rules a server admin can put back to the server's (`inherit`) when they
/// shut everyone out of an organization (docs/api/access.md, "Organization sign-in rules").
const SIGN_IN_RULES: [&str; 2] = ["signin.local_password", "security.two_factor_required"];

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SignInRulesRequest {
    /// Only `inherit`: the server's rule applies again.
    local_password: Option<String>,
    two_factor_required: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SignInRules {
    local_password: serde_json::Value,
    two_factor_required: serde_json::Value,
}

/// Puts an organization's sign-in rules back to the server's, for a server admin who confirmed
/// their own second factor within the last minutes. The recovery when the organization's rules
/// shut out everyone who could change them.
async fn reset_sign_in_rules(
    State(state): State<AppState>,
    Extension(admin): Extension<SessionUser>,
    Extension(info): Extension<RequestInfo>,
    headers: HeaderMap,
    Path(org_id): Path<String>,
    JsonBody(req): JsonBody<SignInRulesRequest>,
) -> ApiResult<Json<SignInRules>> {
    use crate::auth::second_factor as sf;
    let mut keys = Vec::new();
    for (key, value, field) in [
        (SIGN_IN_RULES[0], &req.local_password, "localPassword"),
        (SIGN_IN_RULES[1], &req.two_factor_required, "twoFactorRequired"),
    ] {
        match value.as_deref() {
            None => {}
            Some("inherit") => keys.push(key),
            Some(_) => return Err(ApiError::validation(format!("{field} can only be inherit")).with_field(field)),
        }
    }
    if keys.is_empty() {
        return Err(ApiError::validation("name a rule to put back").with_field("localPassword"));
    }
    let now = state.clock.now_ms();
    if !sf::methods(&state.db, &admin.id).await?.any() {
        return Err(
            ApiError::forbidden("set up your own second factor first").because("second_factor.admin_needs_factor")
        );
    }
    let token = crate::auth::session::read_cookie(&headers, info.https).ok_or_else(ApiError::unauthenticated)?;
    sf::require_fresh(&state.db, &crate::auth::session::hash_token(&token), now).await?;
    load(&state.db, &org_id).await?;
    let mut tx = crate::db::begin(&state.db).await?;
    crate::authz::lock_org(&mut tx, &org_id).await?;
    let mut changed = Vec::new();
    for key in &keys {
        let stored: Option<(i64, String)> =
            sqlx::query_as("SELECT version, value FROM org_settings WHERE org_id = $1 AND key = $2")
                .bind(&org_id)
                .bind(key)
                .fetch_optional(&mut *tx)
                .await?;
        let Some((version, value)) = stored else { continue };
        // Already the server's rule (never set, reset, or `inherit` stored).
        if value == "null" || value == "\"inherit\"" {
            continue;
        }
        if crate::settings::reset(&mut tx, Some(&org_id), key, version, &admin.id, now).await?.is_none() {
            return Err(ApiError::new(StatusCode::CONFLICT, "conflict", "the rule changed meanwhile; try again"));
        }
        changed.push(*key);
    }
    let actor = Actor { user_id: &admin.id, info: &info, at_ms: now };
    let summary = json!({ "orgId": org_id, "keys": changed });
    audit(&mut tx, &actor, Some(&org_id), "org.sign_in_rules_reset", ("org", &org_id), summary).await?;
    crate::db::commit(tx).await?;
    crate::settings::cache(&state).invalidate(Some(&org_id));
    Ok(Json(SignInRules {
        local_password: crate::settings::get_org(&state, &org_id, SIGN_IN_RULES[0]).await?,
        two_factor_required: crate::settings::get_org(&state, &org_id, SIGN_IN_RULES[1]).await?,
    }))
}
