//! Organizations on this server, for server administrators (docs/api/access.md, "Server
//! administration").

use axum::extract::{Path, State};
use axum::http::{Method, StatusCode};
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
    let owner = sqlx::query("UPDATE users SET disabled = disabled WHERE id = $1 AND disabled = 0")
        .bind(&req.owner_user_id)
        .execute(&mut *tx)
        .await?;
    // A disabled account cannot sign in, so it could not use the organization it owns.
    if owner.rows_affected() == 0 {
        return Err(ApiError::validation("no such account, or it is disabled").with_field("ownerUserId"));
    }
    sqlx::query("INSERT INTO orgs (id, name, created_at) VALUES ($1, $2, $3)")
        .bind(&id)
        .bind(&name)
        .bind(now)
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO org_members (org_id, user_id, role, created_at) VALUES ($1, $2, $3, $4)")
        .bind(&id)
        .bind(&req.owner_user_id)
        .bind(BuiltinRole::Owner.as_str())
        .bind(now)
        .execute(&mut *tx)
        .await?;
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
