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
        // Not an organization route: leaving works with any session of the person, also one that
        // organization's rules would not give them now (password sign-in off, docs/api/access.md).
        route(Method::DELETE, "/me/orgs/{orgId}", Authenticated, leave_org).changes_rights(),
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
    let mut tx = crate::db::begin(&state.db).await?;
    sqlx::query("UPDATE users SET name = $1 WHERE id = $2").bind(&name).bind(&user.id).execute(&mut *tx).await?;
    let actor = Actor { user_id: &user.id, info: &info, at_ms: state.clock.now_ms() };
    let summary = json!({ "userId": user.id, "fields": ["name"] });
    audit(&mut tx, &actor, None, "user.updated", ("user", &user.id), summary).await?;
    // Read before the commit: once it is committed, nothing may fail as "busy, nothing changed".
    let answer = me(&mut tx, SessionUser { name, ..user }).await?;
    crate::db::commit(tx).await?;
    Ok(Json(answer))
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
    let wrong_current = || ApiError::validation("the current password is not correct").with_field("current");
    // No password can be this long, so it is refused before it costs a hash or an attempt.
    if req.current.chars().count() > password::MAX_PASSWORD_CHARS {
        return Err(wrong_current());
    }
    // With a second factor, a new password needs a fresh confirmation of it (`second_factor`).
    if crate::auth::second_factor::methods(&state.db, &user.id).await?.any() {
        let token = session::read_cookie(&headers, info.https).ok_or_else(ApiError::unauthenticated)?;
        crate::auth::second_factor::require_fresh(&state.db, &session::hash_token(&token), now).await?;
    }
    // Its own budget. A failure also counts for the account's sign-ins from all addresses
    // (`AppState::account_limiter`), which does not refuse here: the caller has a session.
    use crate::auth::ratelimit::{account_key, network_key};
    let mono = state.clock.monotonic_ms();
    let limit_key = format!("password:{}", user.id);
    let refused = |wait| ApiError::rate_limited("too many attempts, wait a few minutes", wait);
    let counted = state.password_limiter.try_acquire(&limit_key, &limit_key, mono).map_err(refused)?;
    let busy = || {
        state.password_limiter.refund(&limit_key, &counted);
        refused(std::time::Duration::from_secs(1))
    };
    // A signed-in user has check slots and hashing threads apart from those of sign-ins, so
    // guesses at the sign-in page cannot keep them waiting.
    let slot_key = format!("session:{}", account_key(&user.email));
    let Some(checking) = state
        .password_checks
        .enter(&slot_key, crate::auth::ratelimit::MAX_TRUSTED_IN_FLIGHT_PER_ACCOUNT, std::time::Duration::from_secs(2))
        .await
    else {
        return Err(busy());
    };
    let (stored,): (Option<String>,) =
        sqlx::query_as("SELECT password_hash FROM users WHERE id = $1").bind(&user.id).fetch_one(&state.db).await?;
    let Some(matched) = password::verify(req.current, stored.clone(), &password::TRUSTED).await else {
        return Err(busy());
    };
    // The slot guards the check; hashing the new password has its own lane.
    drop(checking);
    if !matched {
        state.account_limiter.record(&account_key(&user.email), &network_key(info.client_ip), mono);
        return Err(wrong_current());
    }
    state.password_limiter.reset(&limit_key);
    password::check_policy(&req.new).map_err(|e| ApiError::validation(e).with_field("new"))?;
    let hash = password::hash(req.new).await?;

    let mut tx = crate::db::begin(&state.db).await?;
    // Only if the password is still the one just verified: of two changes at once, the second
    // fails as if its current password were wrong.
    let changed = sqlx::query("UPDATE users SET password_hash = $1 WHERE id = $2 AND password_hash = $3")
        .bind(&hash)
        .bind(&user.id)
        .bind(&stored)
        .execute(&mut *tx)
        .await?;
    if changed.rows_affected() == 0 {
        return Err(wrong_current());
    }
    let ended =
        session::delete_for_user(&mut *tx, &user.id, session::read_cookie(&headers, info.https).as_deref()).await?;
    let actor = Actor { user_id: &user.id, info: &info, at_ms: now };
    let summary = json!({ "userId": user.id, "sessionsEnded": ended });
    audit(&mut tx, &actor, None, "user.password_changed", ("user", &user.id), summary).await?;
    crate::db::commit(tx).await?;
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
    Extension(info): Extension<RequestInfo>,
    headers: HeaderMap,
    QueryParams(q): QueryParams<PageQuery>,
) -> ApiResult<Json<Page<SessionView>>> {
    let paging = Paging::new(q.limit, q.cursor.as_deref())?;
    let now = state.clock.now_ms();
    let mut rows: Vec<SessionView> = sqlx::query_as(
        "SELECT id, token_hash, created_at, last_seen_at, expires_at FROM sessions \
         WHERE user_id = $1 AND (created_at < $2 OR (created_at = $2 AND id < $3)) \
         AND expires_at > $5 AND last_seen_at > $6 ORDER BY created_at DESC, id DESC LIMIT $4",
    )
    .bind(&user.id)
    .bind(paging.before_time())
    .bind(paging.before_id())
    .bind(paging.fetch_limit())
    // Ended sessions (past their lifetime or idle limit) stay in the table until the hourly
    // cleanup, but they are gone for the user.
    .bind(now)
    .bind(session::idle_cutoff(&state.config.sessions, now))
    .fetch_all(&state.db)
    .await?;
    let own = session::read_cookie(&headers, info.https).map(|t| session::hash_token(&t));
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
    let mut tx = crate::db::begin(&state.db).await?;
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
    crate::db::commit(tx).await?;
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
    let mut tx = crate::db::begin(&state.db).await?;
    let revoked =
        session::delete_for_user(&mut *tx, &user.id, session::read_cookie(&headers, info.https).as_deref()).await?;
    let actor = Actor { user_id: &user.id, info: &info, at_ms: state.clock.now_ms() };
    audit(&mut tx, &actor, None, "auth.sessions_revoked", ("user", &user.id), json!({ "revoked": revoked })).await?;
    crate::db::commit(tx).await?;
    Ok(Json(Revoked { revoked }))
}

/// Leaves an organization: the person's own decision, which no rule of that organization can
/// prevent, except that its last owner stays (docs/api/access.md, "Leaving an organization").
async fn leave_org(
    State(state): State<AppState>,
    Extension(user): Extension<SessionUser>,
    Extension(info): Extension<RequestInfo>,
    Path(org_id): Path<String>,
) -> ApiResult<StatusCode> {
    let mut tx = crate::db::begin(&state.db).await?;
    // The organization's row first, then its owner rows (lock order in `authz`), so a concurrent
    // removal or demotion of the other owners is seen here.
    crate::authz::lock_org(&mut tx, &org_id).await?;
    let other_owners = crate::authz::lock_owners(&mut tx, &org_id, &user.id).await?;
    let role: Option<(String,)> = sqlx::query_as(
        "SELECT m.role FROM org_members m JOIN users u ON u.id = m.user_id \
         WHERE m.org_id = $1 AND m.user_id = $2 AND u.service_account = 0",
    )
    .bind(&org_id)
    .bind(&user.id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some((role,)) = role else { return Err(ApiError::not_found()) };
    if role == crate::authz::BuiltinRole::Owner.as_str() && other_owners == 0 {
        return Err(
            super::support::conflict("the last owner of an organization cannot leave it").because("members.last_owner")
        );
    }
    super::members::remove_membership(&mut tx, &org_id, &user.id).await?;
    // A leave sticks: this organization's SCIM never adds the person back.
    super::members::left(&mut tx, &org_id, &user.id, state.clock.now_ms()).await?;
    let actor = Actor { user_id: &user.id, info: &info, at_ms: state.clock.now_ms() };
    let summary = json!({ "userId": user.id, "role": role });
    audit(&mut tx, &actor, Some(&org_id), "member.left", ("user", &user.id), summary).await?;
    crate::db::commit(tx).await?;
    Ok(StatusCode::NO_CONTENT)
}
