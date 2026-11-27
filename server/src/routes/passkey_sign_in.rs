//! Signing in with a passkey alone (docs/api/access.md, "Passkey sign-in"): the button "Mit Passkey
//! anmelden" and the passkeys the browser suggests in the address field (WebAuthn conditional
//! mediation). The browser's dialog starts without an account (discoverable credentials); its
//! answer names the account by the passkey's user handle.
//!
//! A passkey whose authenticator verified the person (PIN, fingerprint, face) counts as both
//! factors, so no second step follows. It takes the password's place and follows its rules:
//!
//! - it signs in only accounts that can sign in with a password of their own: not service
//!   accounts, not accounts made by an identity provider or directory without a password, not
//!   while password sign-in is off for the person (the server's or an organization's
//!   `signin.local_password`, `sso::password_sign_in`), never as the break-glass admin's form;
//! - it is off where passkeys are (`security.two_factor_methods` without passkeys, Kalzit opened by
//!   an IP address) and while password sign-in is off on the whole server;
//! - disabled accounts are refused, and every refusal answers alike, so the answer tells nothing
//!   about the account; the reason is recorded for the account (`auth.sign_in_failed` with
//!   `method: passkey`) when the passkey itself held;
//! - each answer counts against the address's budget of failed sign-ins, and a sign-in gives it
//!   back; starting a dialog has its own budget per address, since each start keeps a row;
//! - the started dialog lives five minutes in `passkey_sign_ins`, named by a random token in its
//!   own cookie (`kalzit_passkey`, `__Host-kalzit_passkey` over HTTPS), and is used up by the first
//!   answer, right or wrong; sign counters are checked as for the second step
//!   (`second_factor::record_passkey_use`).
//!
//! "Geteilter oder fremder Computer" (`forgetBrowser`) works as with the password: no device
//! cookie, and a session that ends with the browser and after at most 12 hours.

use axum::extract::State;
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use serde::Deserialize;
use webauthn_rs::prelude::{DiscoverableAuthentication, PublicKeyCredential, SecurityKey};

use super::second_factor::{DeviceCookie, open_session};
use super::table::{RouteDef, route};
use crate::app::AppState;
use crate::auth::ratelimit::{address_key, network_key};
use crate::auth::second_factor as sf;
use crate::auth::{SessionUser, passkeys, session};
use crate::authz::Access::Public;
use crate::error::{ApiError, ApiResult};
use crate::extract::JsonBody;
use crate::net::RequestInfo;

pub const COOKIE: &str = "kalzit_passkey";
/// The name over HTTPS (`session::SECURE_COOKIE_NAME` explains `__Host-`).
pub const SECURE_COOKIE: &str = "__Host-kalzit_passkey";
/// How long a started dialog may wait for its answer. The suggestion in the address field waits
/// while the person types; the page starts a new one before this ends.
pub const CEREMONY_TTL_MS: i64 = 5 * 60_000;
/// Started dialogs per client address in `STARTS_WINDOW_SECS`: each page load starts one for the
/// suggestion in the address field, each click of the button another.
pub const STARTS_PER_ADDRESS: u32 = 60;
pub const STARTS_WINDOW_SECS: u64 = 10 * 60;

pub fn routes() -> Vec<RouteDef> {
    vec![
        route(Method::POST, "/auth/passkey/options", Public, options),
        route(Method::POST, "/auth/passkey", Public, sign_in),
    ]
}

/// Whether people can sign in with a passkey alone through this request: passkeys may be used
/// here (`second_factor::allowed`: the methods setting and a host name) and password sign-in is
/// not off on the whole server. Organizations' rules apply per person at the sign-in.
pub async fn available(state: &AppState, info: &RequestInfo) -> ApiResult<bool> {
    Ok(crate::sso::local_policy(state).await?.local_on && sf::allowed(state, info).await?.passkey)
}

fn off() -> ApiError {
    ApiError::forbidden("signing in with a passkey alone is off on this server").because("passkey_sign_in.off")
}

/// Every refused answer, whatever the reason.
fn refused() -> ApiError {
    ApiError::new(StatusCode::UNAUTHORIZED, "invalid_credentials", "the passkey did not sign you in")
        .because("passkey_sign_in.refused")
}

/// The dialog this answers is unknown or ended: the page starts a new one.
fn expired() -> ApiError {
    ApiError::new(StatusCode::UNAUTHORIZED, "invalid_credentials", "the passkey dialog ended, start it again")
        .because("passkey_sign_in.expired")
}

fn cookie_name(secure: bool) -> &'static str {
    if secure { SECURE_COOKIE } else { COOKIE }
}

fn set_cookie(token: &str, secure: bool) -> HeaderValue {
    let max_age = CEREMONY_TTL_MS / 1000;
    session::cookie_header(&format!("{}={token}; Max-Age={max_age}", cookie_name(secure)), secure)
}

fn clear_cookie(secure: bool) -> HeaderValue {
    session::cookie_header(&format!("{}=; Max-Age=0", cookie_name(secure)), secure)
}

/// `POST /auth/passkey/options`: options for `navigator.credentials.get` without an account. The
/// page adds the mediation: none for the button, `conditional` for the address field.
async fn options(
    State(state): State<AppState>,
    Extension(info): Extension<RequestInfo>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    if !available(&state, &info).await? {
        return Err(off());
    }
    let mono = state.clock.monotonic_ms();
    state
        .passkey_start_limiter
        .try_acquire(&address_key("passkey-start", info.client_ip), &network_key(info.client_ip), mono)
        .map_err(|wait| ApiError::rate_limited("too many passkey dialogs, wait a few minutes", wait))?;
    let rp = sf::relying_party(&state, &info).await?;
    let (options, ceremony) = passkeys::start_discoverable(&rp)?;
    let stored = serde_json::to_string(&ceremony).map_err(|e| ApiError::internal("passkey sign-in", e))?;
    let token = hex::encode(rand::random::<[u8; 32]>());
    let now = state.clock.now_ms();
    let mut tx = crate::db::begin(&state.db).await?;
    // One dialog per browser: a new one replaces the one before.
    if let Some(old) = session::cookie_value(&headers, cookie_name(info.https)) {
        sqlx::query("DELETE FROM passkey_sign_ins WHERE token_hash = $1")
            .bind(session::hash_token(&old))
            .execute(&mut *tx)
            .await?;
    }
    sqlx::query("INSERT INTO passkey_sign_ins (token_hash, ceremony, created_at, expires_at) VALUES ($1, $2, $3, $4)")
        .bind(session::hash_token(&token))
        .bind(&stored)
        .bind(now)
        .bind(now + CEREMONY_TTL_MS)
        .execute(&mut *tx)
        .await?;
    crate::db::commit(tx).await?;
    let mut out = HeaderMap::new();
    out.insert(header::SET_COOKIE, set_cookie(&token, info.https));
    Ok((out, Json(options)).into_response())
}

/// Takes the dialog this browser started: of two answers, one gets it, and an expired one is gone.
async fn take(
    state: &AppState,
    headers: &HeaderMap,
    secure: bool,
    now: i64,
) -> ApiResult<Option<DiscoverableAuthentication>> {
    let Some(token) = session::cookie_value(headers, cookie_name(secure)) else { return Ok(None) };
    let hash = session::hash_token(&token);
    let row: Option<(String, i64)> =
        sqlx::query_as("SELECT ceremony, expires_at FROM passkey_sign_ins WHERE token_hash = $1")
            .bind(&hash)
            .fetch_optional(&state.db)
            .await?;
    let Some((ceremony, expires_at)) = row else { return Ok(None) };
    let taken = sqlx::query("DELETE FROM passkey_sign_ins WHERE token_hash = $1 AND ceremony = $2")
        .bind(&hash)
        .bind(&ceremony)
        .execute(&state.db)
        .await?
        .rows_affected();
    if taken != 1 || expires_at <= now {
        return Ok(None);
    }
    serde_json::from_str(&ceremony).map(Some).map_err(|e| ApiError::internal("passkey sign-in", e))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SignInRequest {
    credential: Box<PublicKeyCredential>,
    /// "Geteilter oder fremder Computer", as with the password (`routes::auth::LoginRequest`).
    #[serde(default, rename = "forgetBrowser")]
    forget_browser: bool,
}

/// The account a passkey names, with the passkey as stored.
#[derive(sqlx::FromRow)]
struct Account {
    id: String,
    email: String,
    name: String,
    is_server_admin: i64,
    disabled: i64,
    password_hash: Option<String>,
    credential: String,
}

/// Records a refused sign-in for the account the passkey named, when the passkey itself held
/// (`reason`), or without an account. The answer is the same whatever happens to the entry.
async fn record_refusal(
    state: &AppState,
    info: &RequestInfo,
    headers: &HeaderMap,
    user_id: Option<&str>,
    reason: &str,
    now: i64,
) {
    tracing::info!(client = %info.client_ip, "failed sign-in with a passkey");
    let agent = crate::auth::sign_ins::user_agent(headers);
    let event = crate::audit::AuditEvent {
        org_id: None,
        actor_user_id: None,
        actor_address: Some(info.client_ip.to_string()),
        action: "auth.sign_in_failed",
        resource_type: Some("user"),
        resource_id: user_id,
        summary: match user_id {
            Some(id) => serde_json::json!({ "userId": id, "reason": reason, "method": "passkey", "userAgent": agent }),
            None => serde_json::json!({ "method": "passkey" }),
        },
        at_ms: now,
    };
    let recorded = match state.db.acquire().await {
        Ok(mut conn) => crate::audit::record(&mut conn, &event).await,
        Err(e) => Err(e),
    };
    if let Err(e) = recorded {
        tracing::warn!(client = %info.client_ip, "recording a failed sign-in in the audit log failed: {e}");
    }
}

/// `POST /auth/passkey`: the browser's answer to a dialog from `options`; a session, or one
/// refusal for every reason.
async fn sign_in(
    State(state): State<AppState>,
    Extension(info): Extension<RequestInfo>,
    headers: HeaderMap,
    JsonBody(req): JsonBody<SignInRequest>,
) -> ApiResult<Response> {
    let now = state.clock.now_ms();
    if !available(&state, &info).await? {
        return Err(off());
    }
    // The address's budget of failed sign-ins, shared with passwords and codes.
    let ip_key = address_key("login", info.client_ip);
    let network = network_key(info.client_ip);
    let mono = state.clock.monotonic_ms();
    let counted = state
        .login_limiter
        .try_acquire(&ip_key, &network, mono)
        .map_err(|wait| ApiError::rate_limited("too many failed sign-ins, wait a few minutes", wait))?;
    // No dialog to answer is no guess at a passkey: the attempt is given back.
    let Some(ceremony) = take(&state, &headers, info.https, now).await? else {
        state.login_limiter.refund(&ip_key, &counted);
        return Err(expired());
    };
    let rp = sf::relying_party(&state, &info).await?;
    let Some((user_id, credential_id)) = passkeys::identify_discoverable(&rp, &req.credential) else {
        record_refusal(&state, &info, &headers, None, "credentials", now).await;
        return Err(refused());
    };
    let account: Option<Account> = sqlx::query_as(
        "SELECT u.id, u.email, u.name, u.is_server_admin, u.disabled, u.password_hash, p.credential \
         FROM users u JOIN user_passkeys p ON p.user_id = u.id \
         WHERE u.id = $1 AND p.credential_id = $2 AND u.service_account = 0",
    )
    .bind(&user_id)
    .bind(&credential_id)
    .fetch_optional(&state.db)
    .await?;
    let Some(account) = account else {
        record_refusal(&state, &info, &headers, None, "credentials", now).await;
        return Err(refused());
    };
    let key: SecurityKey = serde_json::from_str(&account.credential).map_err(|e| ApiError::internal("passkey", e))?;
    // The signature, the origin, the challenge and the person's verification on the device; then
    // the counter, under the passkey's lock.
    let held = match passkeys::finish_discoverable(&rp, &req.credential, ceremony, &key) {
        Some(result) => sf::record_passkey_use(&state, &account.id, &result, now).await?,
        None => false,
    };
    if !held {
        record_refusal(&state, &info, &headers, Some(&account.id), "credentials", now).await;
        return Err(refused());
    }
    // The passkey held. The account's rules come after, so their reasons are recorded only for
    // the person whose passkey it is.
    if account.disabled != 0 {
        record_refusal(&state, &info, &headers, Some(&account.id), "disabled", now).await;
        return Err(refused());
    }
    let password_allowed = account.password_hash.is_some()
        && crate::sso::password_sign_in(&state, &account.id, false).await? == crate::sso::PasswordSignIn::Allowed;
    if !password_allowed {
        record_refusal(&state, &info, &headers, Some(&account.id), "password_off", now).await;
        return Err(refused());
    }
    state.login_limiter.refund(&ip_key, &counted);

    let user = SessionUser {
        id: account.id.clone(),
        email: account.email,
        name: account.name,
        is_server_admin: account.is_server_admin,
    };
    let mut tx = crate::db::begin(&state.db).await?;
    // The account still enabled, under its row's lock: a disable that raced this sign-in either
    // comes first and refuses it, or ends the session it opens.
    let enabled = sqlx::query("UPDATE users SET disabled = disabled WHERE id = $1 AND disabled = 0")
        .bind(&user.id)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    if enabled == 0 {
        return Err(refused());
    }
    // A second step this browser had begun with a password ends here.
    let pending = sf::read_pending_cookie(&headers, info.https);
    if let Some(old) = &pending {
        sqlx::query("DELETE FROM sign_in_challenges WHERE token_hash = $1")
            .bind(session::hash_token(old))
            .execute(&mut *tx)
            .await?;
    }
    let via = crate::auth::sign_ins::Via {
        first_step: "passkey".into(),
        break_glass: false,
        provider_id: None,
        provider_mfa: false,
    };
    // No device cookie: it is bound to a password hash (`auth::device`), and a passkey needs no
    // password budget.
    let device = if req.forget_browser { DeviceCookie::Forget } else { DeviceCookie::Keep };
    let (mut out, me) =
        open_session(&mut tx, &state, &info, &headers, user, &via, Some("passkey"), device, now).await?;
    crate::db::commit(tx).await?;
    out.append(header::SET_COOKIE, clear_cookie(info.https));
    if pending.is_some() {
        out.append(header::SET_COOKIE, sf::clear_pending_cookie(info.https));
    }
    Ok((out, Json(me)).into_response())
}
