//! Sign in, sign out and the current user.

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::IntoResponse;
use axum::{Extension, Json};
use serde::Deserialize;

use super::{MAX_EMAIL_CHARS, Me, me};
use crate::app::AppState;
use crate::auth::{CurrentUser, SessionUser, password, session};
use crate::error::{ApiError, ApiResult};
use crate::extract::JsonBody;
use crate::net::RequestInfo;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LoginRequest {
    email: String,
    password: String,
}

#[derive(sqlx::FromRow)]
struct LoginRow {
    id: String,
    email: String,
    name: String,
    password_hash: Option<String>,
    is_server_admin: i64,
    disabled: i64,
}

pub fn routes() -> Vec<super::table::RouteDef> {
    use super::table::route;
    use crate::authz::Access::{Authenticated, Public};
    use axum::http::Method;
    vec![
        route(Method::POST, "/auth/login", Public, login),
        // Signing out works without a valid session too: it clears the cookie either way.
        route(Method::POST, "/auth/logout", Public, logout),
        route(Method::GET, "/me", Authenticated, current),
    ]
}

fn rate_limited() -> ApiError {
    ApiError::new(StatusCode::TOO_MANY_REQUESTS, "rate_limited", "too many failed sign-ins, wait a few minutes")
}

fn invalid_credentials() -> ApiError {
    // Same answer for unknown email, wrong password and disabled account, so the response does
    // not reveal which accounts exist.
    ApiError::new(StatusCode::UNAUTHORIZED, "invalid_credentials", "email or password is not correct")
}

pub async fn login(
    State(state): State<AppState>,
    Extension(info): Extension<RequestInfo>,
    headers: HeaderMap,
    JsonBody(req): JsonBody<LoginRequest>,
) -> ApiResult<impl IntoResponse> {
    let now = state.clock.now_ms();
    // No account can have such an email or password, so these are refused before they cost a
    // hash or a rate-limit entry.
    let email = req.email.trim().to_lowercase();
    if email.chars().count() > MAX_EMAIL_CHARS || req.password.chars().count() > password::MAX_PASSWORD_CHARS {
        return Err(invalid_credentials());
    }
    let email_key = format!("email:{email}");
    let ip_key = format!("ip:{}", info.client_ip);
    let limiter = &state.login_limiter;
    if !limiter.try_acquire(&[&email_key, &ip_key], now) {
        return Err(rate_limited());
    }

    let row: Option<LoginRow> =
        sqlx::query_as("SELECT id, email, name, password_hash, is_server_admin, disabled FROM users WHERE email = $1")
            .bind(&email)
            .fetch_optional(&state.db)
            .await?;
    let stored = row.as_ref().and_then(|r| r.password_hash.clone());
    let ok = password::verify(req.password, stored).await;
    let audit = |action: &'static str, user_id: Option<String>| crate::audit::AuditEvent {
        org_id: None,
        actor_user_id: None,
        actor_address: Some(info.client_ip.to_string()),
        action,
        resource_type: Some("user"),
        resource_id: None,
        summary: match user_id {
            Some(id) => serde_json::json!({ "userId": id }),
            None => serde_json::json!({}),
        },
        at_ms: now,
    };
    let known_id = row.as_ref().map(|r| r.id.clone());
    let Some(row) = row.filter(|r| ok && r.disabled == 0) else {
        tracing::info!(client = %info.client_ip, "failed sign-in");
        // The id of an existing account is recorded, never the email that was typed.
        crate::audit::record(&mut *state.db.acquire().await?, &audit("auth.sign_in_failed", known_id)).await?;
        return Err(invalid_credentials());
    };
    limiter.reset(&email_key);
    limiter.refund(&ip_key);

    let mut tx = state.db.begin().await?;
    // Lock the user row and confirm it still holds the hash we verified and is still enabled. A
    // password change or a disable takes the same lock, so a sign-in that raced one either sees
    // the change and fails here, or commits first and has its session ended by the change.
    let still_valid = sqlx::query(
        "UPDATE users SET password_hash = password_hash WHERE id = $1 AND password_hash = $2 AND disabled = 0",
    )
    .bind(&row.id)
    .bind(row.password_hash.as_deref())
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if still_valid == 0 {
        return Err(invalid_credentials());
    }
    // Signing in again replaces the session this browser had, instead of leaving it behind.
    if let Some(old) = session::read_cookie(&headers) {
        session::delete(&mut *tx, &old).await?;
    }
    let token = session::create(&mut *tx, &state.config.sessions, now, &row.id).await?;
    let mut event = audit("auth.signed_in", None);
    event.actor_user_id = Some(&row.id);
    event.resource_id = Some(&row.id);
    crate::audit::record(&mut tx, &event).await?;
    tx.commit().await?;
    let user = SessionUser { id: row.id, email: row.email, name: row.name, is_server_admin: row.is_server_admin };
    let mut headers = HeaderMap::new();
    headers.insert(header::SET_COOKIE, session::set_cookie(&token, &state.config.sessions, info.https));
    Ok((headers, Json(me(&state.db, user).await?)))
}

pub async fn logout(
    State(state): State<AppState>,
    Extension(info): Extension<RequestInfo>,
    headers: HeaderMap,
) -> ApiResult<impl IntoResponse> {
    if let Some(token) = session::read_cookie(&headers) {
        session::delete(&state.db, &token).await?;
    }
    let mut out = HeaderMap::new();
    out.insert(header::SET_COOKIE, session::clear_cookie(info.https));
    Ok((StatusCode::NO_CONTENT, out))
}

pub async fn current(State(state): State<AppState>, CurrentUser(user): CurrentUser) -> ApiResult<Json<Me>> {
    Ok(Json(me(&state.db, user).await?))
}
