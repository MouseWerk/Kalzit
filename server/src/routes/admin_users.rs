//! Accounts on this server, for server administrators (docs/api/access.md, "Server
//! administration").

use axum::extract::{Path, State};
use axum::http::{HeaderMap, Method, StatusCode};
use axum::{Extension, Json};
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::support::{Actor, PageQuery, Paging, QueryParams, audit, conflict, is_unique_violation};
use super::table::{RouteDef, route};
use crate::app::AppState;
use crate::auth::{SessionUser, password, session};
use crate::authz::{Access, ensure_admin_remains, lock_orgs_left_without_owner, lock_server_admins};
use crate::error::{ApiError, ApiResult};
use crate::extract::JsonBody;
use crate::net::RequestInfo;
use crate::shapes::Page;

pub fn routes() -> Vec<RouteDef> {
    vec![
        route(Method::GET, "/admin/users", Access::ServerAdmin, list),
        route(Method::POST, "/admin/users", Access::ServerAdmin, create),
        route(Method::PATCH, "/admin/users/{userId}", Access::ServerAdmin, update).changes_rights(),
    ]
}

#[derive(Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct AdminUser {
    id: String,
    email: String,
    name: String,
    #[sqlx(try_from = "i64")]
    is_server_admin: Flag,
    #[sqlx(try_from = "i64")]
    disabled: Flag,
    created_at: i64,
}

/// A 0/1 column (portable SQL has no boolean) as a JSON boolean.
#[derive(Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(transparent)]
struct Flag(bool);

impl From<i64> for Flag {
    fn from(v: i64) -> Self {
        Flag(v != 0)
    }
}

/// People only: service accounts are managed in their organization (`routes::service_accounts`).
const USER_COLUMNS: &str =
    "SELECT id, email, name, is_server_admin, disabled, created_at FROM users WHERE service_account = 0";

async fn load<'c, E>(db: E, user_id: &str) -> ApiResult<AdminUser>
where
    E: sqlx::Executor<'c, Database = sqlx::Any>,
{
    sqlx::query_as(sqlx::AssertSqlSafe(format!("{USER_COLUMNS} AND id = $1")))
        .bind(user_id)
        .fetch_optional(db)
        .await?
        .ok_or_else(ApiError::not_found)
}

async fn list(
    State(state): State<AppState>,
    QueryParams(q): QueryParams<PageQuery>,
) -> ApiResult<Json<Page<AdminUser>>> {
    let paging = Paging::new(q.limit, q.cursor.as_deref())?;
    let rows: Vec<AdminUser> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "{USER_COLUMNS} AND (created_at < $1 OR (created_at = $1 AND id < $2)) ORDER BY created_at DESC, id DESC LIMIT $3"
    )))
    .bind(paging.before_time())
    .bind(paging.before_id())
    .bind(paging.fetch_limit())
    .fetch_all(&state.db)
    .await?;
    Ok(Json(paging.page(rows, |u| (u.created_at, u.id.as_str()))))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateRequest {
    name: String,
    email: String,
    password: String,
    #[serde(default)]
    is_server_admin: bool,
}

fn email_taken() -> ApiError {
    conflict("an account with this email exists already").with_field("email")
}

async fn create(
    State(state): State<AppState>,
    Extension(admin): Extension<SessionUser>,
    Extension(info): Extension<RequestInfo>,
    JsonBody(req): JsonBody<CreateRequest>,
) -> ApiResult<(StatusCode, Json<AdminUser>)> {
    let name = super::clean_name(&req.name, "name").map_err(|e| e.with_field("name"))?;
    let email = super::normalize_email(&req.email).map_err(|e| e.with_field("email"))?;
    password::check_policy(&req.password).map_err(|e| ApiError::validation(e).with_field("password"))?;
    let hash = password::hash(req.password).await?;

    let id = super::new_id();
    let now = state.clock.now_ms();
    let mut tx = crate::db::begin(&state.db).await?;
    sqlx::query(
        "INSERT INTO users (id, email, name, password_hash, is_server_admin, disabled, created_at) \
         VALUES ($1, $2, $3, $4, $5, 0, $6)",
    )
    .bind(&id)
    .bind(&email)
    .bind(&name)
    .bind(&hash)
    .bind(i64::from(req.is_server_admin))
    .bind(now)
    .execute(&mut *tx)
    .await
    .map_err(|e| if is_unique_violation(&e) { email_taken() } else { e.into() })?;
    let actor = Actor { user_id: &admin.id, info: &info, at_ms: now };
    let summary = json!({ "userId": id, "isServerAdmin": req.is_server_admin });
    audit(&mut tx, &actor, None, "user.created", ("user", &id), summary).await?;
    let user = load(&mut *tx, &id).await?;
    crate::db::commit(tx).await?;
    Ok((StatusCode::CREATED, Json(user)))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UpdateRequest {
    name: Option<String>,
    disabled: Option<bool>,
    is_server_admin: Option<bool>,
    password: Option<String>,
}

async fn update(
    State(state): State<AppState>,
    Extension(admin): Extension<SessionUser>,
    Extension(info): Extension<RequestInfo>,
    headers: HeaderMap,
    Path(user_id): Path<String>,
    JsonBody(req): JsonBody<UpdateRequest>,
) -> ApiResult<Json<AdminUser>> {
    let name =
        req.name.as_deref().map(|n| super::clean_name(n, "name").map_err(|e| e.with_field("name"))).transpose()?;
    let hash = match req.password {
        Some(new) => {
            password::check_policy(&new).map_err(|e| ApiError::validation(e).with_field("password"))?;
            Some(password::hash(new).await?)
        }
        None => None,
    };

    let mut tx = crate::db::begin(&state.db).await?;
    let admins = lock_server_admins(&mut tx).await?;
    let current = load(&mut *tx, &user_id).await?;
    let disabled = req.disabled.unwrap_or(current.disabled.0);
    let is_admin = req.is_server_admin.unwrap_or(current.is_server_admin.0);
    ensure_admin_remains(current.is_server_admin.0 && !current.disabled.0, is_admin && !disabled, admins)?;
    if disabled && !current.disabled.0 && lock_orgs_left_without_owner(&mut tx, &user_id).await? > 0 {
        return Err(conflict(
            "this account is the last enabled owner of an organization; make someone else owner first",
        ));
    }

    let mut fields = Vec::new();
    if let Some(name) = &name {
        sqlx::query("UPDATE users SET name = $1 WHERE id = $2").bind(name).bind(&user_id).execute(&mut *tx).await?;
        fields.push("name");
    }
    if is_admin != current.is_server_admin.0 {
        sqlx::query("UPDATE users SET is_server_admin = $1 WHERE id = $2")
            .bind(i64::from(is_admin))
            .bind(&user_id)
            .execute(&mut *tx)
            .await?;
        fields.push("isServerAdmin");
    }
    if let Some(hash) = &hash {
        sqlx::query("UPDATE users SET password_hash = $1 WHERE id = $2")
            .bind(hash)
            .bind(&user_id)
            .execute(&mut *tx)
            .await?;
        // A new password ends the account's sessions, except the one of the admin setting their
        // own password here.
        let keep = session::read_cookie(&headers, info.https).filter(|_| user_id == admin.id);
        session::delete_for_user(&mut *tx, &user_id, keep.as_deref()).await?;
        fields.push("password");
    }
    let actor = Actor { user_id: &admin.id, info: &info, at_ms: state.clock.now_ms() };
    if !fields.is_empty() {
        let summary = json!({ "userId": user_id, "fields": fields });
        audit(&mut tx, &actor, None, "user.updated", ("user", &user_id), summary).await?;
    }
    if disabled != current.disabled.0 {
        sqlx::query("UPDATE users SET disabled = $1 WHERE id = $2")
            .bind(i64::from(disabled))
            .bind(&user_id)
            .execute(&mut *tx)
            .await?;
        let action = if disabled {
            // A disabled account is signed out everywhere at once, not only when its sessions expire.
            session::delete_for_user(&mut *tx, &user_id, None).await?;
            "user.disabled"
        } else {
            "user.enabled"
        };
        audit(&mut tx, &actor, None, action, ("user", &user_id), json!({ "userId": user_id })).await?;
    }
    let user = load(&mut *tx, &user_id).await?;
    crate::db::commit(tx).await?;
    Ok(Json(user))
}
