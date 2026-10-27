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

fn rate_limited(wait: std::time::Duration) -> ApiError {
    ApiError::rate_limited("too many failed sign-ins, wait a few minutes", wait)
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
    use crate::auth::ratelimit::{CLEAN_ADDRESS_FAILURES, account_key, address_key, network_key};
    let mono = state.clock.monotonic_ms();
    let ip_key = address_key("login", info.client_ip);
    let network = network_key(info.client_ip);
    // The account's budget at this address: guesses from elsewhere never use it up.
    let pair_key = format!("account:{email}|{ip_key}");
    let account_key = account_key(&email);
    state.login_limiter.try_acquire(&ip_key, &network, mono).map_err(rate_limited)?;
    let refuse = |wait| {
        state.login_limiter.refund(&ip_key);
        rate_limited(wait)
    };
    let pair_failures = state.pair_limiter.try_acquire(&pair_key, &network, mono).map_err(refuse)?;
    // Refused after both counted: neither attempt counts.
    let refuse = |wait| {
        state.pair_limiter.refund(&pair_key);
        refuse(wait)
    };
    // The waits named below are the whole window, so they tell nothing about the account or
    // the network.
    let window = state.login_limiter.window();
    // An IPv6 site (/48) whose failures for all accounts are used up: only attempts whose
    // account at this address is clean go on, so others' typos never make the owner dirty.
    let ipv6 = info.client_ip.to_canonical().is_ipv6();
    if ipv6 && pair_failures > CLEAN_ADDRESS_FAILURES && state.network_limiter.wait(&network, mono).is_some() {
        return Err(refuse(window));
    }

    let row: Option<LoginRow> =
        sqlx::query_as("SELECT id, email, name, password_hash, is_server_admin, disabled FROM users WHERE email = $1")
            .bind(&email)
            .fetch_optional(&state.read_db)
            .await?;
    // A browser this account signed in with before is not held to the account's shared budget;
    // everyone else is, and an account the full table cannot count is refused (fail closed).
    let device = crate::auth::device::read_cookie(&headers, info.https);
    let known_device = row.as_ref().zip(device.as_deref()).is_some_and(|(r, value)| {
        crate::auth::device::is_known(&state.secrets, value, &r.id, r.password_hash.as_deref(), now)
    });
    if !known_device && state.account_limiter.check(&account_key, &network, mono).is_err() {
        return Err(refuse(window));
    }
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
        state.account_limiter.record(&account_key, &network, mono);
        if ipv6 {
            state.network_limiter.record(&network, &network, mono);
        }
        // The id of an existing account is recorded, never the email that was typed.
        // A failed sign-in answers the same whatever happens to its audit entry: a busy database
        // must not turn it into "try again", which would invite repeated password guesses past
        // the point where the attempt was already counted.
        let recorded = match state.db.acquire().await {
            Ok(mut conn) => crate::audit::record(&mut conn, &audit("auth.sign_in_failed", known_id)).await,
            Err(e) => Err(e),
        };
        if let Err(e) = recorded {
            tracing::warn!(client = %info.client_ip, "recording a failed sign-in in the audit log failed: {e}");
        }
        return Err(invalid_credentials());
    };
    state.pair_limiter.reset(&pair_key);
    state.login_limiter.refund(&ip_key);

    let mut tx = crate::db::begin(&state.db).await?;
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
    if let Some(old) = session::read_cookie(&headers, info.https) {
        session::delete(&mut *tx, &old).await?;
    }
    let token = session::create(&mut *tx, &state.config.sessions, now, &row.id).await?;
    let mut event = audit("auth.signed_in", None);
    event.actor_user_id = Some(&row.id);
    event.resource_id = Some(&row.id);
    crate::audit::record(&mut tx, &event).await?;
    // Read before the commit: once it is committed, nothing may fail as "busy, nothing changed".
    let device = crate::auth::device::issue(&state.secrets, &row.id, row.password_hash.as_deref(), now);
    let user = SessionUser { id: row.id, email: row.email, name: row.name, is_server_admin: row.is_server_admin };
    let answer = me(&mut *tx, user).await?;
    crate::db::commit(tx).await?;
    let mut headers = HeaderMap::new();
    headers.insert(header::SET_COOKIE, session::set_cookie(&token, &state.config.sessions, info.https));
    // This browser is now a known device of the account (renewed with every sign-in).
    headers.append(header::SET_COOKIE, crate::auth::device::set_cookie(&device, info.https));
    Ok((headers, Json(answer)))
}

pub async fn logout(
    State(state): State<AppState>,
    Extension(info): Extension<RequestInfo>,
    headers: HeaderMap,
) -> ApiResult<impl IntoResponse> {
    if let Some(token) = session::read_cookie(&headers, info.https) {
        let mut tx = crate::db::begin(&state.db).await?;
        let user: Option<(String,)> = sqlx::query_as("SELECT user_id FROM sessions WHERE token_hash = $1")
            .bind(session::hash_token(&token))
            .fetch_optional(&mut *tx)
            .await?;
        session::delete(&mut *tx, &token).await?;
        // Only a session that still existed is recorded; an old cookie signs out silently.
        if let Some((user_id,)) = &user {
            let event = crate::audit::AuditEvent {
                org_id: None,
                actor_user_id: Some(user_id),
                actor_address: Some(info.client_ip.to_string()),
                action: "auth.signed_out",
                resource_type: Some("user"),
                resource_id: Some(user_id),
                summary: serde_json::json!({}),
                at_ms: state.clock.now_ms(),
            };
            crate::audit::record(&mut tx, &event).await?;
        }
        crate::db::commit(tx).await?;
    }
    let mut out = HeaderMap::new();
    out.insert(header::SET_COOKIE, session::clear_cookie(info.https));
    Ok((StatusCode::NO_CONTENT, out))
}

pub async fn current(State(state): State<AppState>, CurrentUser(user): CurrentUser) -> ApiResult<Json<Me>> {
    Ok(Json(me(&state.db, user).await?))
}
