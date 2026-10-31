//! The second step of a sign-in (docs/api/access.md, "Second factor"): after the password (or,
//! later, an identity provider), the person confirms with a passkey, a code of their
//! authenticator app or a recovery code; an account that must have a second factor and has none
//! sets one up here first. Until then only these routes answer, through the half-signed-in state
//! (`auth::second_factor`), and no session exists.

use axum::extract::State;
use axum::http::{HeaderMap, Method, header};
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::support::conflict;
use super::table::{RouteDef, route};
use super::{Me, me};
use crate::app::AppState;
use crate::auth::second_factor::{self as sf, FirstStep, Pending, Prompt, Proof};
use crate::auth::{SessionUser, session};
use crate::authz::Access::Public;
use crate::error::{ApiError, ApiResult};
use crate::extract::JsonBody;
use crate::net::RequestInfo;

pub fn routes() -> Vec<RouteDef> {
    vec![
        route(Method::GET, "/auth/second-factor", Public, current),
        route(Method::POST, "/auth/second-factor", Public, confirm),
        route(Method::POST, "/auth/second-factor/passkey", Public, passkey_options),
        route(Method::POST, "/auth/second-factor/setup/totp", Public, setup_totp),
        route(Method::POST, "/auth/second-factor/setup/passkey", Public, setup_passkey_options),
        route(Method::POST, "/auth/second-factor/setup", Public, setup),
    ]
}

/// What the first step leads to, worked out before its transaction: no second step, or the
/// prompt of the second step (`expiresAt` from now).
pub async fn plan(
    state: &AppState,
    info: &RequestInfo,
    user: &SessionUser,
    first: FirstStep<'_>,
    now: i64,
) -> ApiResult<Option<Prompt>> {
    let Some((setup, required_by)) = sf::second_step(state, &user.id, user.is_server_admin != 0, first).await? else {
        return Ok(None);
    };
    let has = sf::methods(&state.db, &user.id).await?;
    let (methods, last_used) = has.for_prompt();
    Ok(Some(Prompt {
        email: user.email.clone(),
        setup,
        methods,
        last_used,
        allowed: sf::allowed(state, info).await?,
        required_by,
        locked_until: sf::locked_until(&state.db, &user.id, now).await?,
        expires_at: now + sf::CHALLENGE_TTL_MS,
    }))
}

/// The prompt that makes an account without a second factor set one up before it is signed in,
/// whatever the policy says: for the break-glass admin, whom a password alone never lets in
/// (docs/api/sso.md).
pub async fn forced_setup(
    state: &AppState,
    info: &RequestInfo,
    user: &SessionUser,
    required_by: Option<sf::RequiredBy>,
    now: i64,
) -> ApiResult<Prompt> {
    Ok(Prompt {
        email: user.email.clone(),
        setup: true,
        methods: Vec::new(),
        last_used: None,
        allowed: sf::allowed(state, info).await?,
        required_by,
        locked_until: sf::locked_until(&state.db, &user.id, now).await?,
        expires_at: now + sf::CHALLENGE_TTL_MS,
    })
}

/// The device cookie a completed sign-in sets (`auth::device`).
pub enum DeviceCookie<'a> {
    /// Issue (renew) it for the account's current password hash.
    Issue(Option<&'a str>),
    /// "This is not my browser": remove one the browser has.
    Forget,
    /// Leave it as it is (a first step without a password).
    Keep,
}

/// Opens the session of a completed sign-in inside `tx` (the caller commits): replaces this
/// browser's previous session, records the sign-in, and answers the cookies and `Me`.
#[expect(clippy::too_many_arguments, reason = "the parts of one sign-in, passed on as they are")]
pub async fn open_session(
    tx: &mut sqlx::AnyConnection,
    state: &AppState,
    info: &RequestInfo,
    headers: &HeaderMap,
    user: SessionUser,
    second_factor: Option<&str>,
    device: DeviceCookie<'_>,
    now: i64,
) -> ApiResult<(HeaderMap, Me)> {
    // Signing in again replaces the session this browser had, instead of leaving it behind.
    if let Some(old) = session::read_cookie(headers, info.https) {
        session::delete(&mut *tx, &old).await?;
    }
    let token = session::create(&mut *tx, &state.config.sessions, now, &user.id).await?;
    if second_factor.is_some() {
        // Just confirmed: changes that need a fresh confirmation work right away.
        sf::mark_confirmed(&mut *tx, &session::hash_token(&token), now).await?;
    }
    let event = crate::audit::AuditEvent {
        org_id: None,
        actor_user_id: Some(&user.id),
        actor_address: Some(info.client_ip.to_string()),
        action: "auth.signed_in",
        resource_type: Some("user"),
        resource_id: Some(&user.id),
        summary: match second_factor {
            Some(method) => json!({ "secondFactor": method }),
            None => json!({}),
        },
        at_ms: now,
    };
    crate::audit::record(&mut *tx, &event).await?;
    let device_value = match device {
        DeviceCookie::Issue(hash) => Some(crate::auth::device::issue(&state.secrets, &user.id, hash, now)),
        DeviceCookie::Forget | DeviceCookie::Keep => None,
    };
    let forget = matches!(device, DeviceCookie::Forget);
    let answer = me(&mut *tx, user).await?;
    let mut out = HeaderMap::new();
    out.insert(header::SET_COOKIE, session::set_cookie(&token, &state.config.sessions, info.https));
    // This browser is now a known device of the account (renewed with every sign-in), unless the
    // user said it is not theirs: then it forgets any device it was.
    if let Some(value) = &device_value {
        out.append(header::SET_COOKIE, crate::auth::device::set_cookie(value, info.https));
    } else if forget {
        out.append(header::SET_COOKIE, crate::auth::device::clear_cookie(info.https));
    }
    Ok((out, answer))
}

/// Ends the first step of a sign-in inside `tx` and commits it: with no second step, the session
/// opens; otherwise the half-signed-in state starts and the answer is `{"secondFactor": Prompt}`.
/// For password sign-ins (`routes::auth`) and, through the same call, identity providers.
#[expect(clippy::too_many_arguments, reason = "the parts of one sign-in, passed on as they are")]
pub async fn finish_first_step(
    mut tx: sqlx::Transaction<'static, sqlx::Any>,
    state: &AppState,
    info: &RequestInfo,
    headers: &HeaderMap,
    user: SessionUser,
    first: FirstStep<'_>,
    forget_browser: bool,
    plan: Option<Prompt>,
    now: i64,
) -> ApiResult<Response> {
    let Some(prompt) = plan else {
        let device = match (first, forget_browser) {
            (_, true) => DeviceCookie::Forget,
            // Bound to the password hash; an account without one (made by a provider) gets none.
            (FirstStep::Password { password_hash: Some(hash) }, false) => DeviceCookie::Issue(Some(hash)),
            _ => DeviceCookie::Keep,
        };
        let (out, answer) = open_session(&mut tx, state, info, headers, user, None, device, now).await?;
        crate::db::commit(tx).await?;
        return Ok((out, Json(answer)).into_response());
    };
    // A second step this browser had started before ends here.
    if let Some(old) = sf::read_pending_cookie(headers, info.https) {
        sqlx::query("DELETE FROM sign_in_challenges WHERE token_hash = $1")
            .bind(session::hash_token(&old))
            .execute(&mut *tx)
            .await?;
    }
    let token = sf::create_pending(&mut tx, &user.id, prompt.setup, forget_browser, first, now).await?;
    crate::db::commit(tx).await?;
    let mut out = HeaderMap::new();
    out.insert(header::SET_COOKIE, sf::set_pending_cookie(&token, info.https));
    Ok((out, Json(json!({ "secondFactor": prompt }))).into_response())
}

async fn pending(state: &AppState, info: &RequestInfo, headers: &HeaderMap, now: i64) -> ApiResult<Pending> {
    sf::load_pending(&state.db, headers, info.https, now).await?.ok_or_else(sf::pending_expired)
}

async fn current(
    State(state): State<AppState>,
    Extension(info): Extension<RequestInfo>,
    headers: HeaderMap,
) -> ApiResult<Json<Prompt>> {
    let now = state.clock.now_ms();
    let pending = pending(&state, &info, &headers, now).await?;
    let required_by = sf::required_for(&state, &pending.user_id, pending.is_server_admin != 0).await?;
    Ok(Json(sf::prompt(&state, &info, &pending, required_by, now).await?))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SignedIn {
    me: Me,
    /// After a recovery code: how many are left.
    #[serde(skip_serializing_if = "Option::is_none")]
    recovery_codes_remaining: Option<i64>,
    /// After a forced setup: the new recovery codes, shown once.
    #[serde(skip_serializing_if = "Option::is_none")]
    recovery_codes: Option<Vec<String>>,
}

/// Completes the sign-in of `pending` inside `tx` and commits it.
#[expect(clippy::too_many_arguments, reason = "the parts of one sign-in, passed on as they are")]
async fn complete(
    mut tx: sqlx::Transaction<'static, sqlx::Any>,
    state: &AppState,
    info: &RequestInfo,
    headers: &HeaderMap,
    pending: &Pending,
    method: &str,
    taken: sf::Taken,
    now: i64,
) -> ApiResult<(HeaderMap, Me)> {
    let device = if pending.forget_browser != 0 {
        DeviceCookie::Forget
    } else if taken.first_step == "password" && taken.password_hash.is_some() {
        DeviceCookie::Issue(taken.password_hash.as_deref())
    } else {
        DeviceCookie::Keep
    };
    // After a provider, its group mapping applies now that the sign-in is complete (`sso::signin`);
    // what an earlier, abandoned one kept goes with any other first step.
    let touched = if taken.first_step == "provider" {
        crate::sso::signin::apply_deferred(&mut tx, state, info, &pending.user_id, now).await?
    } else {
        sqlx::query("DELETE FROM sso_pending_mappings WHERE user_id = $1")
            .bind(&pending.user_id)
            .execute(&mut *tx)
            .await?;
        Default::default()
    };
    let (mut out, answer) =
        open_session(&mut tx, state, info, headers, pending.user(), Some(method), device, now).await?;
    crate::db::commit(tx).await?;
    crate::sso::rights_changed(state, &touched).await;
    out.append(header::SET_COOKIE, sf::clear_pending_cookie(info.https));
    Ok((out, answer))
}

/// The second step with a factor the account has.
async fn confirm(
    State(state): State<AppState>,
    Extension(info): Extension<RequestInfo>,
    headers: HeaderMap,
    JsonBody(proof): JsonBody<Proof>,
) -> ApiResult<Response> {
    let now = state.clock.now_ms();
    let pending = pending(&state, &info, &headers, now).await?;
    if pending.setup != 0 {
        return Err(ApiError::validation("set up a second factor first").because("second_factor.setup_needed"));
    }
    let verified = sf::verify(&state, &info, pending.owner(), &pending.user_id, &proof, now).await?;
    let mut tx = crate::db::begin(&state.db).await?;
    let Some(taken) = sf::take_pending(&mut tx, &pending, now).await? else { return Err(sf::pending_expired()) };
    let (out, me) = complete(tx, &state, &info, &headers, &pending, verified.method(), taken, now).await?;
    let remaining = match verified {
        sf::Verified::Recovery { remaining } => Some(remaining),
        _ => None,
    };
    let body = SignedIn { me, recovery_codes_remaining: remaining, recovery_codes: None };
    Ok((out, Json(body)).into_response())
}

async fn passkey_options(
    State(state): State<AppState>,
    Extension(info): Extension<RequestInfo>,
    headers: HeaderMap,
) -> ApiResult<Json<Value>> {
    let now = state.clock.now_ms();
    let pending = pending(&state, &info, &headers, now).await?;
    Ok(Json(sf::start_passkey_check(&state, &info, pending.owner(), &pending.user_id, now).await?))
}

/// A forced setup only: an account that must have a second factor and has none.
async fn setup_pending(state: &AppState, info: &RequestInfo, headers: &HeaderMap, now: i64) -> ApiResult<Pending> {
    let pending = pending(state, info, headers, now).await?;
    if pending.setup == 0 {
        return Err(ApiError::forbidden("this account confirms with its second factor"));
    }
    Ok(pending)
}

fn method_not_allowed() -> ApiError {
    ApiError::forbidden("this method is turned off on this server").because("second_factor.method_off")
}

async fn setup_totp(
    State(state): State<AppState>,
    Extension(info): Extension<RequestInfo>,
    headers: HeaderMap,
) -> ApiResult<Json<sf::TotpSetup>> {
    let now = state.clock.now_ms();
    let pending = setup_pending(&state, &info, &headers, now).await?;
    if !sf::allowed(&state, &info).await?.totp {
        return Err(method_not_allowed());
    }
    Ok(Json(sf::start_totp(&state, &info, pending.owner(), &pending.user_id, &pending.email, now).await?))
}

async fn setup_passkey_options(
    State(state): State<AppState>,
    Extension(info): Extension<RequestInfo>,
    headers: HeaderMap,
) -> ApiResult<Json<Value>> {
    let now = state.clock.now_ms();
    let pending = setup_pending(&state, &info, &headers, now).await?;
    if !sf::allowed(&state, &info).await?.passkey {
        return Err(method_not_allowed());
    }
    Ok(Json(sf::start_passkey_setup(&state, &info, pending.owner(), &pending.user(), now).await?))
}

#[derive(Deserialize)]
#[serde(tag = "method", rename_all = "camelCase", deny_unknown_fields)]
pub enum SetupRequest {
    Totp { code: String },
    Passkey { name: Option<String>, credential: Box<webauthn_rs::prelude::RegisterPublicKeyCredential> },
}

/// Finishes a forced setup: stores the new factor with a first set of recovery codes and signs
/// the person in.
async fn setup(
    State(state): State<AppState>,
    Extension(info): Extension<RequestInfo>,
    headers: HeaderMap,
    JsonBody(req): JsonBody<SetupRequest>,
) -> ApiResult<Response> {
    let now = state.clock.now_ms();
    let pending = setup_pending(&state, &info, &headers, now).await?;
    let allowed = sf::allowed(&state, &info).await?;
    enum New {
        Totp(Vec<u8>, i64),
        Passkey(String, Box<webauthn_rs::prelude::SecurityKey>),
    }
    let new = match &req {
        SetupRequest::Totp { code } => {
            if !allowed.totp {
                return Err(method_not_allowed());
            }
            let (secret, step) =
                sf::check_totp_setup(&state, &info, pending.owner(), &pending.user_id, code, now).await?;
            New::Totp(secret, step)
        }
        SetupRequest::Passkey { name, credential } => {
            if !allowed.passkey {
                return Err(method_not_allowed());
            }
            let name = sf::clean_passkey_name(name.as_deref())?;
            let key = sf::finish_passkey_setup(&state, &info, pending.owner(), credential, now).await?;
            New::Passkey(name, Box::new(key))
        }
    };
    let mut tx = crate::db::begin(&state.db).await?;
    let Some(taken) = sf::take_pending(&mut tx, &pending, now).await? else { return Err(sf::pending_expired()) };
    // Still no method, checked under the account's row lock that taking the state holds: a forced
    // setup never replaces an app or the recovery codes the account got meanwhile.
    let (has,): (i64,) = sqlx::query_as(
        "SELECT (SELECT COUNT(*) FROM user_totp WHERE user_id = $1) + (SELECT COUNT(*) FROM user_passkeys WHERE user_id = $1)",
    )
    .bind(&pending.user_id)
    .fetch_one(&mut *tx)
    .await?;
    if has > 0 {
        return Err(
            conflict("the account has a second factor already; sign in with it").because("second_factor.setup_done")
        );
    }
    let (method, summary) = match &new {
        New::Totp(secret, step) => {
            sf::save_totp(&mut tx, &state, &pending.user_id, secret, *step, now).await?;
            ("totp", json!({ "userId": pending.user_id, "method": "totp" }))
        }
        New::Passkey(name, key) => {
            let id = sf::save_passkey(&mut tx, &pending.user_id, name, key, now).await?;
            ("passkey", json!({ "userId": pending.user_id, "method": "passkey", "passkeyId": id }))
        }
    };
    let codes = sf::new_recovery_codes(&mut tx, &pending.user_id, now).await?;
    let event = crate::audit::AuditEvent {
        org_id: None,
        actor_user_id: Some(&pending.user_id),
        actor_address: Some(info.client_ip.to_string()),
        action: "user.second_factor_enrolled",
        resource_type: Some("user"),
        resource_id: Some(&pending.user_id),
        summary,
        at_ms: now,
    };
    crate::audit::record(&mut tx, &event).await?;
    let (out, me) = complete(tx, &state, &info, &headers, &pending, method, taken, now).await?;
    // The first setup, which the person just did themselves while signing in, changes nothing they
    // need to be told about by mail.
    let body = SignedIn { me, recovery_codes_remaining: None, recovery_codes: Some(codes) };
    Ok((out, Json(body)).into_response())
}
