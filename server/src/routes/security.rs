//! A person's own second factor (Account > Sign-in and security), the reset of another person's
//! second factor by an admin, and the server's overview of the policy per organization
//! (docs/api/access.md, "Second factor").
//!
//! Changes that weaken an account (removing a method, new recovery codes, replacing the app, a
//! new password) and adding a method to an account that has one need a fresh confirmation with a
//! factor the account has (`POST /me/security/confirm`), at most five minutes old.

use axum::extract::{Path, State};
use axum::http::{HeaderMap, Method, StatusCode};
use axum::{Extension, Json};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::support::{Actor, audit, clean_text, conflict};
use super::table::{RouteDef, route};
use crate::app::AppState;
use crate::auth::second_factor::{self as sf, Allowed, Methods, Proof, RequiredBy};
use crate::auth::{SessionUser, session};
use crate::authz::{Access, OrgCtx, Permission, ensure_holds, resolve_role};
use crate::error::{ApiError, ApiResult};
use crate::extract::JsonBody;
use crate::net::RequestInfo;

pub fn routes() -> Vec<RouteDef> {
    use Access::{Authenticated, Org, ServerAdmin};
    vec![
        route(Method::GET, "/me/security", Authenticated, status),
        route(Method::POST, "/me/security/confirm", Authenticated, confirm),
        route(Method::POST, "/me/security/confirm/passkey", Authenticated, confirm_passkey_options),
        route(Method::POST, "/me/security/totp/setup", Authenticated, totp_setup),
        route(Method::POST, "/me/security/totp", Authenticated, totp_save),
        route(Method::DELETE, "/me/security/totp", Authenticated, totp_remove),
        route(Method::POST, "/me/security/passkeys/setup", Authenticated, passkey_setup),
        route(Method::POST, "/me/security/passkeys", Authenticated, passkey_save),
        route(Method::PATCH, "/me/security/passkeys/{passkeyId}", Authenticated, passkey_rename),
        route(Method::DELETE, "/me/security/passkeys/{passkeyId}", Authenticated, passkey_remove),
        route(Method::POST, "/me/security/recovery-codes", Authenticated, recovery_codes),
        route(
            Method::POST,
            "/orgs/{orgId}/members/{userId}/second-factor/reset",
            Org(Permission::UsersWrite),
            reset_member,
        ),
        route(Method::POST, "/admin/users/{userId}/second-factor/reset", ServerAdmin, reset_user),
        route(Method::GET, "/admin/security/two-factor", ServerAdmin, overview),
    ]
}

/// The session of the request, as stored (the hash of its token).
fn session_hash(headers: &HeaderMap, info: &RequestInfo) -> ApiResult<String> {
    session::read_cookie(headers, info.https).map(|t| session::hash_token(&t)).ok_or_else(ApiError::unauthenticated)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// A second factor is required for this account, and by what.
    required: bool,
    required_by: Option<RequiredBy>,
    /// Methods the server lets people set up.
    allowed: Allowed,
    #[serde(flatten)]
    methods: Methods,
    /// Until when this session's last confirmation allows weakening changes.
    confirmed_until: Option<i64>,
    /// Wrong codes locked the second step until then.
    locked_until: Option<i64>,
    /// The account has a local password.
    has_password: bool,
}

async fn status(
    State(state): State<AppState>,
    Extension(user): Extension<SessionUser>,
    Extension(info): Extension<RequestInfo>,
    headers: HeaderMap,
) -> ApiResult<Json<Status>> {
    let now = state.clock.now_ms();
    let hash = session_hash(&headers, &info)?;
    let required_by = sf::required_for(&state, &user.id, user.is_server_admin != 0).await?;
    let (password,): (Option<String>,) =
        sqlx::query_as("SELECT password_hash FROM users WHERE id = $1").bind(&user.id).fetch_one(&state.db).await?;
    Ok(Json(Status {
        required: required_by.is_some(),
        required_by,
        allowed: sf::allowed(&state, &info).await?,
        methods: sf::methods(&state.db, &user.id).await?,
        confirmed_until: sf::confirmed_until(&state.db, &hash, now).await?,
        locked_until: sf::locked_until(&state.db, &user.id, now).await?,
        has_password: password.is_some(),
    }))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Confirmed {
    confirmed_until: i64,
}

/// A fresh confirmation with a factor the account has.
async fn confirm(
    State(state): State<AppState>,
    Extension(user): Extension<SessionUser>,
    Extension(info): Extension<RequestInfo>,
    headers: HeaderMap,
    JsonBody(proof): JsonBody<Proof>,
) -> ApiResult<Json<Confirmed>> {
    let now = state.clock.now_ms();
    let hash = session_hash(&headers, &info)?;
    let verified = sf::verify(&state, &info, sf::Owner::Session(&hash), &user.id, &proof, now).await?;
    let mut tx = crate::db::begin(&state.db).await?;
    sf::mark_confirmed(&mut *tx, &hash, now).await?;
    let actor = Actor { user_id: &user.id, info: &info, at_ms: now };
    let summary = json!({ "userId": user.id, "method": verified.method() });
    audit(&mut tx, &actor, None, "user.second_factor_confirmed", ("user", &user.id), summary).await?;
    crate::db::commit(tx).await?;
    Ok(Json(Confirmed { confirmed_until: now + sf::CONFIRMATION_TTL_MS }))
}

async fn confirm_passkey_options(
    State(state): State<AppState>,
    Extension(user): Extension<SessionUser>,
    Extension(info): Extension<RequestInfo>,
    headers: HeaderMap,
) -> ApiResult<Json<Value>> {
    let now = state.clock.now_ms();
    let hash = session_hash(&headers, &info)?;
    Ok(Json(sf::start_passkey_check(&state, &info, sf::Owner::Session(&hash), &user.id, now).await?))
}

fn method_off() -> ApiError {
    ApiError::forbidden("this method is turned off on this server").because("second_factor.method_off")
}

/// Adding to an account that already has a factor, or replacing one, needs a fresh confirmation:
/// a stolen session must not plant a factor of its own.
async fn require_fresh_if_any(state: &AppState, user_id: &str, hash: &str, now: i64) -> ApiResult<Methods> {
    let has = sf::methods(&state.db, user_id).await?;
    if has.any() {
        sf::require_fresh(&state.db, hash, now).await?;
    }
    Ok(has)
}

async fn totp_setup(
    State(state): State<AppState>,
    Extension(user): Extension<SessionUser>,
    Extension(info): Extension<RequestInfo>,
    headers: HeaderMap,
) -> ApiResult<Json<sf::TotpSetup>> {
    let now = state.clock.now_ms();
    let hash = session_hash(&headers, &info)?;
    if !sf::allowed(&state, &info).await?.totp {
        return Err(method_off());
    }
    require_fresh_if_any(&state, &user.id, &hash, now).await?;
    Ok(Json(sf::start_totp(&state, &info, sf::Owner::Session(&hash), &user.id, &user.email, now).await?))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CodeRequest {
    code: String,
}

/// New recovery codes, when the change gave the account its first factor.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Saved {
    #[serde(skip_serializing_if = "Option::is_none")]
    passkey: Option<sf::PasskeyInfo>,
    recovery_codes: Option<Vec<String>>,
}

async fn enrolled(
    tx: &mut sqlx::AnyConnection,
    actor: &Actor<'_>,
    user_id: &str,
    first: bool,
    summary: Value,
) -> ApiResult<Option<Vec<String>>> {
    let codes = if first { Some(sf::new_recovery_codes(&mut *tx, user_id, actor.at_ms).await?) } else { None };
    audit(&mut *tx, actor, None, "user.second_factor_enrolled", ("user", user_id), summary).await?;
    Ok(codes)
}

async fn totp_save(
    State(state): State<AppState>,
    Extension(user): Extension<SessionUser>,
    Extension(info): Extension<RequestInfo>,
    headers: HeaderMap,
    JsonBody(req): JsonBody<CodeRequest>,
) -> ApiResult<Json<Saved>> {
    let now = state.clock.now_ms();
    let hash = session_hash(&headers, &info)?;
    if !sf::allowed(&state, &info).await?.totp {
        return Err(method_off());
    }
    let has = require_fresh_if_any(&state, &user.id, &hash, now).await?;
    let (secret, step) =
        sf::check_totp_setup(&state, &info, sf::Owner::Session(&hash), &user.id, &req.code, now).await?;
    let mut tx = crate::db::begin(&state.db).await?;
    sf::save_totp(&mut tx, &state, &user.id, &secret, step, now).await?;
    let actor = Actor { user_id: &user.id, info: &info, at_ms: now };
    let summary = json!({ "userId": user.id, "method": "totp", "replaced": has.totp.is_some() });
    let codes = enrolled(&mut tx, &actor, &user.id, !has.any(), summary).await?;
    crate::db::commit(tx).await?;
    sf::notify(&state, &user.id, sf::Notice::Changed);
    Ok(Json(Saved { passkey: None, recovery_codes: codes }))
}

fn last_method() -> ApiError {
    conflict("this is the last method and a second factor is required; set up another one first")
        .because("second_factor.last_method")
}

/// Refuses removing the account's last method while a second factor is required; answers whether
/// one is required, for the check inside the transaction (`after_removal`).
async fn guard_last(state: &AppState, user: &SessionUser, has: &Methods) -> ApiResult<bool> {
    // The break-glass admin keeps a factor always: a password alone never opens the server
    // (docs/api/sso.md).
    let break_glass = crate::sso::local_policy(state).await?.break_glass.as_deref() == Some(user.id.as_str());
    let required = break_glass || sf::required_for(state, &user.id, user.is_server_admin != 0).await?.is_some();
    if has.count() <= 1 && required {
        return Err(last_method());
    }
    Ok(required)
}

/// Locks the account's row first in a transaction that removes a method, so two removals of the
/// same account at once run one after the other and the second sees what the first left.
async fn lock_account(tx: &mut sqlx::AnyConnection, user_id: &str) -> ApiResult<()> {
    sqlx::query("UPDATE users SET disabled = disabled WHERE id = $1").bind(user_id).execute(&mut *tx).await?;
    Ok(())
}

/// After a removal, inside its transaction: the methods are counted again, so removals that raced
/// past `guard_last` cannot take the last one while it is required (the transaction is then rolled
/// back). Without any method left, the recovery codes have nothing to stand in for.
async fn after_removal(tx: &mut sqlx::AnyConnection, user_id: &str, required: bool) -> ApiResult<()> {
    let (left,): (i64,) = sqlx::query_as(
        "SELECT (SELECT COUNT(*) FROM user_totp WHERE user_id = $1) + (SELECT COUNT(*) FROM user_passkeys WHERE user_id = $1)",
    )
    .bind(user_id)
    .fetch_one(&mut *tx)
    .await?;
    if left == 0 && required {
        return Err(last_method());
    }
    if left == 0 {
        sqlx::query("DELETE FROM user_recovery_codes WHERE user_id = $1").bind(user_id).execute(&mut *tx).await?;
    }
    Ok(())
}

async fn totp_remove(
    State(state): State<AppState>,
    Extension(user): Extension<SessionUser>,
    Extension(info): Extension<RequestInfo>,
    headers: HeaderMap,
) -> ApiResult<StatusCode> {
    let now = state.clock.now_ms();
    let hash = session_hash(&headers, &info)?;
    sf::require_fresh(&state.db, &hash, now).await?;
    let has = sf::methods(&state.db, &user.id).await?;
    if has.totp.is_none() {
        return Err(ApiError::not_found());
    }
    let required = guard_last(&state, &user, &has).await?;
    let mut tx = crate::db::begin(&state.db).await?;
    lock_account(&mut tx, &user.id).await?;
    sqlx::query("DELETE FROM user_totp WHERE user_id = $1").bind(&user.id).execute(&mut *tx).await?;
    after_removal(&mut tx, &user.id, required).await?;
    let actor = Actor { user_id: &user.id, info: &info, at_ms: now };
    let summary = json!({ "userId": user.id, "method": "totp" });
    audit(&mut tx, &actor, None, "user.second_factor_removed", ("user", &user.id), summary).await?;
    crate::db::commit(tx).await?;
    sf::notify(&state, &user.id, sf::Notice::Changed);
    Ok(StatusCode::NO_CONTENT)
}

async fn passkey_setup(
    State(state): State<AppState>,
    Extension(user): Extension<SessionUser>,
    Extension(info): Extension<RequestInfo>,
    headers: HeaderMap,
) -> ApiResult<Json<Value>> {
    let now = state.clock.now_ms();
    let hash = session_hash(&headers, &info)?;
    if !sf::allowed(&state, &info).await?.passkey {
        return Err(method_off());
    }
    require_fresh_if_any(&state, &user.id, &hash, now).await?;
    Ok(Json(sf::start_passkey_setup(&state, &info, sf::Owner::Session(&hash), &user, now).await?))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PasskeyRequest {
    name: Option<String>,
    credential: Box<webauthn_rs::prelude::RegisterPublicKeyCredential>,
}

async fn passkey_save(
    State(state): State<AppState>,
    Extension(user): Extension<SessionUser>,
    Extension(info): Extension<RequestInfo>,
    headers: HeaderMap,
    JsonBody(req): JsonBody<PasskeyRequest>,
) -> ApiResult<(StatusCode, Json<Saved>)> {
    let now = state.clock.now_ms();
    let hash = session_hash(&headers, &info)?;
    if !sf::allowed(&state, &info).await?.passkey {
        return Err(method_off());
    }
    let name = sf::clean_passkey_name(req.name.as_deref())?;
    let has = require_fresh_if_any(&state, &user.id, &hash, now).await?;
    let key = sf::finish_passkey_setup(&state, &info, sf::Owner::Session(&hash), &req.credential, now).await?;
    let mut tx = crate::db::begin(&state.db).await?;
    let id = sf::save_passkey(&mut tx, &user.id, &name, &key, now).await?;
    let actor = Actor { user_id: &user.id, info: &info, at_ms: now };
    let summary = json!({ "userId": user.id, "method": "passkey", "passkeyId": id });
    let codes = enrolled(&mut tx, &actor, &user.id, !has.any(), summary).await?;
    crate::db::commit(tx).await?;
    sf::notify(&state, &user.id, sf::Notice::Changed);
    let passkey = sf::PasskeyInfo { id, name, created_at: now, last_used_at: None };
    Ok((StatusCode::CREATED, Json(Saved { passkey: Some(passkey), recovery_codes: codes })))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RenameRequest {
    name: String,
}

async fn passkey_rename(
    State(state): State<AppState>,
    Extension(user): Extension<SessionUser>,
    Extension(info): Extension<RequestInfo>,
    Path(passkey_id): Path<String>,
    JsonBody(req): JsonBody<RenameRequest>,
) -> ApiResult<Json<sf::PasskeyInfo>> {
    let name = sf::clean_passkey_name(Some(&req.name))?;
    let mut tx = crate::db::begin(&state.db).await?;
    // Another person's passkey answers like an unknown one.
    let changed = sqlx::query("UPDATE user_passkeys SET name = $1 WHERE id = $2 AND user_id = $3")
        .bind(&name)
        .bind(&passkey_id)
        .bind(&user.id)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    if changed == 0 {
        return Err(ApiError::not_found());
    }
    let actor = Actor { user_id: &user.id, info: &info, at_ms: state.clock.now_ms() };
    let summary = json!({ "userId": user.id, "passkeyId": passkey_id });
    audit(&mut tx, &actor, None, "user.passkey_renamed", ("user", &user.id), summary).await?;
    let passkey: sf::PasskeyInfo =
        sqlx::query_as("SELECT id, name, created_at, last_used_at FROM user_passkeys WHERE id = $1")
            .bind(&passkey_id)
            .fetch_one(&mut *tx)
            .await?;
    crate::db::commit(tx).await?;
    Ok(Json(passkey))
}

async fn passkey_remove(
    State(state): State<AppState>,
    Extension(user): Extension<SessionUser>,
    Extension(info): Extension<RequestInfo>,
    headers: HeaderMap,
    Path(passkey_id): Path<String>,
) -> ApiResult<StatusCode> {
    let now = state.clock.now_ms();
    let hash = session_hash(&headers, &info)?;
    let has = sf::methods(&state.db, &user.id).await?;
    if !has.passkeys.iter().any(|p| p.id == passkey_id) {
        return Err(ApiError::not_found());
    }
    sf::require_fresh(&state.db, &hash, now).await?;
    let required = guard_last(&state, &user, &has).await?;
    let mut tx = crate::db::begin(&state.db).await?;
    lock_account(&mut tx, &user.id).await?;
    let removed = sqlx::query("DELETE FROM user_passkeys WHERE id = $1 AND user_id = $2")
        .bind(&passkey_id)
        .bind(&user.id)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    if removed == 0 {
        return Err(ApiError::not_found());
    }
    after_removal(&mut tx, &user.id, required).await?;
    let actor = Actor { user_id: &user.id, info: &info, at_ms: now };
    let summary = json!({ "userId": user.id, "method": "passkey", "passkeyId": passkey_id });
    audit(&mut tx, &actor, None, "user.second_factor_removed", ("user", &user.id), summary).await?;
    crate::db::commit(tx).await?;
    sf::notify(&state, &user.id, sf::Notice::Changed);
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Codes {
    recovery_codes: Vec<String>,
}

async fn recovery_codes(
    State(state): State<AppState>,
    Extension(user): Extension<SessionUser>,
    Extension(info): Extension<RequestInfo>,
    headers: HeaderMap,
) -> ApiResult<Json<Codes>> {
    let now = state.clock.now_ms();
    let hash = session_hash(&headers, &info)?;
    if !sf::methods(&state.db, &user.id).await?.any() {
        return Err(ApiError::validation("set up a second factor first").because("second_factor.none"));
    }
    sf::require_fresh(&state.db, &hash, now).await?;
    let mut tx = crate::db::begin(&state.db).await?;
    let codes = sf::new_recovery_codes(&mut tx, &user.id, now).await?;
    let actor = Actor { user_id: &user.id, info: &info, at_ms: now };
    audit(&mut tx, &actor, None, "user.recovery_codes_generated", ("user", &user.id), json!({ "userId": user.id }))
        .await?;
    crate::db::commit(tx).await?;
    sf::notify(&state, &user.id, sf::Notice::Changed);
    Ok(Json(Codes { recovery_codes: codes }))
}

// ---------------------------------------------------------------------------------------------
// Reset by an admin

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ResetRequest {
    #[serde(default)]
    reason: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ResetDone {
    removed: sf::Removed,
    sessions_ended: u64,
}

/// The checks every reset passes: not one's own, and confirmed with the admin's own second
/// factor just before.
async fn check_resetter(state: &AppState, admin: &SessionUser, target: &str, hash: &str, now: i64) -> ApiResult<()> {
    if admin.id == target {
        return Err(
            ApiError::forbidden("change your own second factor under Account").because("second_factor.reset_self")
        );
    }
    if !sf::methods(&state.db, &admin.id).await?.any() {
        return Err(
            ApiError::forbidden("set up your own second factor first").because("second_factor.admin_needs_factor")
        );
    }
    sf::require_fresh(&state.db, hash, now).await
}

async fn do_reset(
    state: &AppState,
    info: &RequestInfo,
    admin: &SessionUser,
    org_id: Option<&str>,
    target: &str,
    reason: Option<String>,
    now: i64,
) -> ApiResult<ResetDone> {
    let reason = reason.map(|r| clean_text(&r, "reason", 200).map_err(|e| e.with_field("reason"))).transpose()?;
    if crate::sso::local_policy(state).await?.break_glass.as_deref() == Some(target) {
        return Err(conflict(
            "the break-glass admin's second factor cannot be reset; choose another break-glass admin first",
        )
        .because("sso.break_glass_protected"));
    }
    let mut tx = crate::db::begin(&state.db).await?;
    let removed = sf::remove_all(&mut tx, target).await?;
    // Whoever holds a session of the account now signs in again, with the new factor.
    let sessions_ended = session::delete_for_user(&mut *tx, target, None).await?;
    let actor = Actor { user_id: &admin.id, info, at_ms: now };
    let mut summary = json!({ "userId": target, "removed": removed, "sessionsEnded": sessions_ended });
    if let Some(reason) = reason.filter(|r| !r.is_empty()) {
        summary["reason"] = json!(reason);
    }
    audit(&mut tx, &actor, org_id, "user.second_factor_reset", ("user", target), summary).await?;
    crate::db::commit(tx).await?;
    sf::notify(state, target, sf::Notice::Reset);
    Ok(ResetDone { removed, sessions_ended })
}

/// An organization admin resets a member's second factor. Only for members of this organization
/// alone who are not server admins and hold nothing the admin does not: the account is shared by
/// every organization it belongs to, so beyond that it takes a server admin.
async fn reset_member(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    headers: HeaderMap,
    Path((_, user_id)): Path<(String, String)>,
    JsonBody(req): JsonBody<ResetRequest>,
) -> ApiResult<Json<ResetDone>> {
    let now = state.clock.now_ms();
    let hash = session_hash(&headers, &info)?;
    let member: Option<(String, i64)> = sqlx::query_as(
        "SELECT m.role, u.is_server_admin FROM org_members m JOIN users u ON u.id = m.user_id \
         WHERE m.org_id = $1 AND m.user_id = $2",
    )
    .bind(&ctx.org_id)
    .bind(&user_id)
    .fetch_optional(&state.db)
    .await?;
    let Some((role, server_admin)) = member else { return Err(ApiError::not_found()) };
    check_resetter(&state, &ctx.user, &user_id, &hash, now).await?;
    let held = resolve_role(&state.db, &ctx.org_id, &role).await?.map(|r| r.permissions).unwrap_or_default();
    ensure_holds(&ctx.permissions, &held)?;
    let (elsewhere,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM org_members WHERE user_id = $1 AND org_id <> $2")
        .bind(&user_id)
        .bind(&ctx.org_id)
        .fetch_one(&state.db)
        .await?;
    if server_admin != 0 || elsewhere > 0 {
        return Err(ApiError::forbidden("only a server admin can reset the second factor of this account")
            .because("second_factor.reset_needs_server_admin"));
    }
    Ok(Json(do_reset(&state, &info, &ctx.user, Some(&ctx.org_id), &user_id, req.reason, now).await?))
}

async fn reset_user(
    State(state): State<AppState>,
    Extension(admin): Extension<SessionUser>,
    Extension(info): Extension<RequestInfo>,
    headers: HeaderMap,
    Path(user_id): Path<String>,
    JsonBody(req): JsonBody<ResetRequest>,
) -> ApiResult<Json<ResetDone>> {
    let now = state.clock.now_ms();
    let hash = session_hash(&headers, &info)?;
    let exists: Option<(String,)> =
        sqlx::query_as("SELECT id FROM users WHERE id = $1").bind(&user_id).fetch_optional(&state.db).await?;
    if exists.is_none() {
        return Err(ApiError::not_found());
    }
    check_resetter(&state, &admin, &user_id, &hash, now).await?;
    Ok(Json(do_reset(&state, &info, &admin, None, &user_id, req.reason, now).await?))
}

// ---------------------------------------------------------------------------------------------
// The server's overview

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OrgPolicy {
    id: String,
    name: String,
    /// The organization's own value: `inherit`, `admins` or `everyone`.
    policy: Value,
    /// What applies there: the stricter of the server's and the organization's.
    effective: sf::Requirement,
    /// Members who must have a second factor and have none: they set one up at their next sign-in.
    missing: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Overview {
    server: sf::Requirement,
    orgs: Vec<OrgPolicy>,
}

async fn overview(State(state): State<AppState>) -> ApiResult<Json<Overview>> {
    let server = sf::server_requirement(&state).await?;
    let orgs: Vec<(String, String)> =
        sqlx::query_as("SELECT id, name FROM orgs ORDER BY name, id").fetch_all(&state.db).await?;
    // Members without any method, per organization.
    let without: Vec<(String, String, String, i64)> = sqlx::query_as(
        "SELECT m.org_id, m.user_id, m.role, u.is_server_admin FROM org_members m JOIN users u ON u.id = m.user_id \
         WHERE u.disabled = 0 AND NOT EXISTS (SELECT 1 FROM user_totp t WHERE t.user_id = u.id) \
         AND NOT EXISTS (SELECT 1 FROM user_passkeys p WHERE p.user_id = u.id)",
    )
    .fetch_all(&state.db)
    .await?;
    let mut out = Vec::with_capacity(orgs.len());
    for (id, name) in orgs {
        let policy = crate::settings::get_org(&state, &id, sf::POLICY_KEY).await?;
        let own = sf::Requirement::parse(&policy);
        let mut missing = 0;
        for (_, _, role, server_admin) in without.iter().filter(|(org, ..)| *org == id) {
            let admin = sf::is_admin_role(&state.db, &id, role).await?;
            let rule = sf::MembershipRule { org_id: id.clone(), org_name: name.clone(), requirement: own, admin };
            if sf::resolve(server, *server_admin != 0, std::slice::from_ref(&rule)).is_some() {
                missing += 1;
            }
        }
        out.push(OrgPolicy { id, name, policy, effective: server.max(own), missing });
    }
    Ok(Json(Overview { server, orgs: out }))
}
