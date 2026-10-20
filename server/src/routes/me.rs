//! The signed-in user's own account and sessions (docs/api/access.md, "Self service").

use axum::extract::{Path, State};
use axum::http::{HeaderMap, Method, StatusCode};
use axum::{Extension, Json};
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::support::{Actor, PageQuery, Paging, QueryParams, audit};
use super::table::{RouteDef, route};
use super::{Me, me};
use crate::app::AppState;
use crate::auth::{SessionUser, password, session};
use crate::authz::Access;
use crate::error::{ApiError, ApiResult};
use crate::extract::JsonBody;
use crate::net::RequestInfo;
use crate::shapes::Page;

pub fn routes() -> Vec<RouteDef> {
    use Access::Authenticated;
    vec![
        route(Method::PATCH, "/me", Authenticated, update),
        route(Method::POST, "/me/password", Authenticated, change_password),
        route(Method::GET, "/me/sessions", Authenticated, list_sessions),
        route(Method::DELETE, "/me/sessions/{sessionId}", Authenticated, end_session),
        route(Method::POST, "/me/sessions/revoke-others", Authenticated, end_other_sessions),
    ]
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct UpdateRequest {
    name: String,
}

async fn update(
    State(state): State<AppState>,
    Extension(user): Extension<SessionUser>,
    Extension(info): Extension<RequestInfo>,
    JsonBody(req): JsonBody<UpdateRequest>,
) -> ApiResult<Json<Me>> {
    let name = super::clean_name(&req.name, "name").map_err(|e| e.with_field("name"))?;
    let mut tx = state.db.begin().await?;
    sqlx::query("UPDATE users SET name = $1 WHERE id = $2").bind(&name).bind(&user.id).execute(&mut *tx).await?;
    let actor = Actor { user_id: &user.id, info: &info, at_ms: state.clock.now_ms() };
    let summary = json!({ "userId": user.id, "fields": ["name"] });
    audit(&mut tx, &actor, None, "user.updated", ("user", &user.id), summary).await?;
    tx.commit().await?;
    Ok(Json(me(&state.db, SessionUser { name, ..user }).await?))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PasswordRequest {
    current: String,
    new: String,
}

/// Changes the password after checking the current one, and ends every other session: whoever
/// knew the old password is signed out.
async fn change_password(
    State(state): State<AppState>,
    Extension(user): Extension<SessionUser>,
    Extension(info): Extension<RequestInfo>,
    headers: HeaderMap,
    JsonBody(req): JsonBody<PasswordRequest>,
) -> ApiResult<StatusCode> {
    let now = state.clock.now_ms();
    // A stolen session must not become a way to guess the password at full speed.
    let limit_key = format!("password:{}", user.id);
    if req.current.chars().count() > password::MAX_PASSWORD_CHARS
        || !state.login_limiter.try_acquire(&[&limit_key], now)
    {
        return Err(ApiError::new(
            StatusCode::TOO_MANY_REQUESTS,
            "rate_limited",
            "too many attempts, wait a few minutes",
        ));
    }
    let (stored,): (Option<String>,) =
        sqlx::query_as("SELECT password_hash FROM users WHERE id = $1").bind(&user.id).fetch_one(&state.db).await?;
    if !password::verify(req.current, stored).await {
        return Err(ApiError::validation("the current password is not correct").with_field("current"));
    }
    state.login_limiter.reset(&limit_key);
    password::check_policy(&req.new).map_err(|e| ApiError::validation(e).with_field("new"))?;
    let hash = password::hash(req.new).await.map_err(|e| ApiError::internal("hashing password", e))?;

    let mut tx = state.db.begin().await?;
    sqlx::query("UPDATE users SET password_hash = $1 WHERE id = $2")
        .bind(&hash)
        .bind(&user.id)
        .execute(&mut *tx)
        .await?;
    let ended = session::delete_for_user(&mut *tx, &user.id, session::read_cookie(&headers).as_deref()).await?;
    let actor = Actor { user_id: &user.id, info: &info, at_ms: now };
    let summary = json!({ "userId": user.id, "sessionsEnded": ended });
    audit(&mut tx, &actor, None, "user.password_changed", ("user", &user.id), summary).await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct SessionView {
    id: String,
    created_at: i64,
    last_seen_at: i64,
    expires_at: i64,
    /// The session of this request.
    #[sqlx(skip)]
    current: bool,
    #[serde(skip)]
    token_hash: String,
}

async fn list_sessions(
    State(state): State<AppState>,
    Extension(user): Extension<SessionUser>,
    headers: HeaderMap,
    QueryParams(q): QueryParams<PageQuery>,
) -> ApiResult<Json<Page<SessionView>>> {
    let paging = Paging::new(q.limit, q.cursor.as_deref())?;
    let mut rows: Vec<SessionView> = sqlx::query_as(
        "SELECT id, token_hash, created_at, last_seen_at, expires_at FROM sessions \
         WHERE user_id = $1 AND (created_at < $2 OR (created_at = $2 AND id < $3)) \
         ORDER BY created_at DESC, id DESC LIMIT $4",
    )
    .bind(&user.id)
    .bind(paging.before_time())
    .bind(paging.before_id())
    .bind(paging.fetch_limit())
    .fetch_all(&state.db)
    .await?;
    let own = session::read_cookie(&headers).map(|t| session::hash_token(&t));
    for row in &mut rows {
        row.current = own.as_deref() == Some(row.token_hash.as_str());
    }
    Ok(Json(paging.page(rows, |s| (s.created_at, s.id.as_str()))))
}

async fn end_session(
    State(state): State<AppState>,
    Extension(user): Extension<SessionUser>,
    Extension(info): Extension<RequestInfo>,
    Path(session_id): Path<String>,
) -> ApiResult<StatusCode> {
    let mut tx = state.db.begin().await?;
    // Another user's session id answers like an unknown one.
    let done = sqlx::query("DELETE FROM sessions WHERE id = $1 AND user_id = $2")
        .bind(&session_id)
        .bind(&user.id)
        .execute(&mut *tx)
        .await?;
    if done.rows_affected() == 0 {
        return Err(ApiError::not_found());
    }
    let actor = Actor { user_id: &user.id, info: &info, at_ms: state.clock.now_ms() };
    audit(&mut tx, &actor, None, "auth.session_ended", ("user", &user.id), json!({ "sessionId": session_id })).await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Revoked {
    revoked: u64,
}

async fn end_other_sessions(
    State(state): State<AppState>,
    Extension(user): Extension<SessionUser>,
    Extension(info): Extension<RequestInfo>,
    headers: HeaderMap,
) -> ApiResult<Json<Revoked>> {
    let mut tx = state.db.begin().await?;
    let revoked = session::delete_for_user(&mut *tx, &user.id, session::read_cookie(&headers).as_deref()).await?;
    let actor = Actor { user_id: &user.id, info: &info, at_ms: state.clock.now_ms() };
    audit(&mut tx, &actor, None, "auth.sessions_revoked", ("user", &user.id), json!({ "revoked": revoked })).await?;
    tx.commit().await?;
    Ok(Json(Revoked { revoked }))
}
