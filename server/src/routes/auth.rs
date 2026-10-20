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
    use axum::routing::{get, post};
    vec![
        route("/auth/login", Public, post(login)),
        // Signing out works without a valid session too: it clears the cookie either way.
        route("/auth/logout", Public, post(logout)),
        route("/me", Authenticated, get(current)),
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
    let Some(row) = row.filter(|r| ok && r.disabled == 0) else {
        tracing::info!(client = %info.client_ip, "failed sign-in");
        return Err(invalid_credentials());
    };
    limiter.reset(&email_key);
    limiter.refund(&ip_key);

    // Signing in again replaces the session this browser had, instead of leaving it behind.
    if let Some(old) = session::read_cookie(&headers) {
        session::delete(&state.db, &old).await?;
    }
    let token = session::create(&state.db, &state.config.sessions, now, &row.id).await?;
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
