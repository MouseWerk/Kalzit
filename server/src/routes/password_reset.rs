//! Password reset by mail (docs/api/mail.md, "Password reset"): a link that works for 60 minutes
//! and once. Asking for one answers the same whether or not an account has the address, and the
//! work behind it (the lookup, the link, the mail) runs after the answer went out, so neither the
//! answer nor its timing tells. An admin can send a member the same link.

use axum::extract::{Path, State};
use axum::http::{Method, StatusCode};
use axum::{Extension, Json};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};

use super::table::{RouteDef, route};
use crate::app::AppState;
use crate::auth::ratelimit::{account_key, address_key, network_key};
use crate::auth::{password, session};
use crate::authz::{Access, OrgCtx, Permission, ensure_holds, resolve_role};
use crate::error::{ApiError, ApiResult};
use crate::extract::JsonBody;
use crate::mail::{self, links, smtp, templates};
use crate::net::RequestInfo;

/// How long a reset link works.
pub const VALID_MS: i64 = 60 * 60_000;
/// Used and expired links are kept this long, then deleted with the next request.
const KEEP_MS: i64 = 24 * 3_600_000;

pub fn routes() -> Vec<RouteDef> {
    vec![
        route(Method::GET, "/auth/password-reset", Access::Public, availability),
        route(Method::POST, "/auth/password-reset", Access::Public, request),
        route(Method::POST, "/auth/password-reset/inspect", Access::Public, inspect),
        route(Method::POST, "/auth/password-reset/complete", Access::Public, complete),
        route(
            Method::POST,
            "/orgs/{orgId}/members/{userId}/password-link",
            Access::Org(Permission::UsersWrite),
            send_member_link,
        ),
    ]
}

/// The SHA-256 of a stored password hash: a link is bound to the password it was asked for under.
fn fingerprint(password_hash: Option<&str>) -> String {
    hex::encode(Sha256::digest(password_hash.unwrap_or_default().as_bytes()))
}

fn unavailable() -> ApiError {
    ApiError::new(StatusCode::CONFLICT, "conflict", "this server sends no mail; an admin can set a new password")
        .because("mail.reset_unavailable")
}

fn invalid_link() -> ApiError {
    ApiError::not_found().because("mail.reset_invalid")
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Availability {
    /// A mail server and the public address are set, so links can be sent.
    available: bool,
}

async fn availability(State(state): State<AppState>) -> ApiResult<Json<Availability>> {
    Ok(Json(Availability { available: mail::can_send_links(&state).await? }))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RequestBody {
    email: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Requested {
    /// Always true: the answer says nothing about the address.
    accepted: bool,
}

fn too_many(wait: std::time::Duration) -> ApiError {
    ApiError::rate_limited("too many requests for a new password, wait a few minutes", wait)
}

async fn request(
    State(state): State<AppState>,
    Extension(info): Extension<RequestInfo>,
    JsonBody(body): JsonBody<RequestBody>,
) -> ApiResult<(StatusCode, Json<Requested>)> {
    if !mail::can_send_links(&state).await? {
        return Err(unavailable());
    }
    let email = body.email.trim().to_lowercase();
    let mono = state.clock.monotonic_ms();
    let network = network_key(info.client_ip);
    let address = address_key("reset", info.client_ip);
    let counted = state.mail.reset_address.try_acquire(&address, &network, mono).map_err(too_many)?;
    if let Err(wait) = state.mail.reset_network.try_acquire(&network, &network, mono) {
        state.mail.reset_address.refund(&address, &counted);
        return Err(too_many(wait));
    }
    // Counted for every address, with or without an account, so the limit tells nothing either.
    state.mail.reset_account.try_count(&account_key(&email), &network, mono).map_err(too_many)?;
    if email.chars().count() <= super::MAX_EMAIL_CHARS && email.contains('@') {
        let background = state.clone();
        let client = info.client_ip;
        state.mail.spawn(&state, async move {
            if let Err(e) = process(&background, &email, client).await {
                tracing::warn!("a requested password link was not sent: {}", e.message);
            }
        });
    }
    Ok((StatusCode::ACCEPTED, Json(Requested { accepted: true })))
}

#[derive(sqlx::FromRow)]
struct Account {
    id: String,
    email: String,
    password_hash: Option<String>,
}

/// After the answer: the account, its link and the mail.
async fn process(state: &AppState, email: &str, client: std::net::IpAddr) -> ApiResult<()> {
    let account: Option<Account> =
        sqlx::query_as("SELECT id, email, password_hash FROM users WHERE email = $1 AND disabled = 0")
            .bind(email)
            .fetch_optional(&state.db)
            .await?;
    let Some(account) = account else { return Ok(()) };
    let lang = mail::language(state, Some(&account.id)).await?;
    let host = mail::host(state);
    let content = match &account.password_hash {
        Some(_) => {
            let token = issue(state, &account, None, &client.to_string()).await?;
            let public = mail::public_url(state).ok_or_else(unavailable)?;
            templates::password_reset(lang, &mail::link(&public, "reset-password", &token), &host)
        }
        None => {
            record(state, &account, None, &client.to_string(), true).await?;
            templates::password_elsewhere(lang, &host)
        }
    };
    let effective = mail::settings::effective(state).await?;
    mail::send(state, &effective, &account.email, &content).await.map_err(smtp::SendError::into_api)?;
    Ok(())
}

async fn record(
    state: &AppState,
    account: &Account,
    admin: Option<(&str, &str)>,
    address: &str,
    elsewhere: bool,
) -> ApiResult<()> {
    let mut tx = crate::db::begin(&state.db).await?;
    audit_requested(&mut tx, state, account, admin, address, elsewhere).await?;
    crate::db::commit(tx).await?;
    Ok(())
}

async fn audit_requested(
    tx: &mut sqlx::AnyConnection,
    state: &AppState,
    account: &Account,
    admin: Option<(&str, &str)>,
    address: &str,
    elsewhere: bool,
) -> ApiResult<()> {
    let mut summary = json!({ "userId": account.id });
    if elsewhere {
        summary["passwordElsewhere"] = json!(true);
    }
    let event = crate::audit::AuditEvent {
        org_id: admin.map(|(_, org)| org),
        actor_user_id: admin.map(|(id, _)| id),
        actor_address: Some(address.to_string()),
        action: "auth.password_reset_requested",
        resource_type: Some("user"),
        resource_id: Some(&account.id),
        summary,
        at_ms: state.clock.now_ms(),
    };
    crate::audit::record(tx, &event).await?;
    Ok(())
}

/// A new link for the account; earlier unused ones stop working.
async fn issue(state: &AppState, account: &Account, admin: Option<(&str, &str)>, address: &str) -> ApiResult<String> {
    let now = state.clock.now_ms();
    let token = links::new_token();
    let mut tx = crate::db::begin(&state.db).await?;
    sqlx::query("DELETE FROM password_resets WHERE expires_at < $1 OR (user_id = $2 AND used_at IS NULL)")
        .bind(now - KEEP_MS)
        .bind(&account.id)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "INSERT INTO password_resets (token_hash, user_id, email, password_fingerprint, created_at, expires_at) \
         VALUES ($1, $2, $3, $4, $5, $6)",
    )
    .bind(links::hash(&token))
    .bind(&account.id)
    .bind(&account.email)
    .bind(fingerprint(account.password_hash.as_deref()))
    .bind(now)
    .bind(now + VALID_MS)
    .execute(&mut *tx)
    .await?;
    audit_requested(&mut tx, state, account, admin, address, false).await?;
    crate::db::commit(tx).await?;
    Ok(token)
}

#[derive(sqlx::FromRow)]
struct Pending {
    user_id: String,
    email: String,
    password_fingerprint: String,
    expires_at: i64,
    used_at: Option<i64>,
    current_email: String,
    password_hash: Option<String>,
    disabled: i64,
}

/// The link's account, when the link still works: unused, not expired, and the account still
/// has the address and the password it was asked for under.
async fn find(state: &AppState, info: &RequestInfo, token: &str) -> ApiResult<Pending> {
    let mono = state.clock.monotonic_ms();
    let key = address_key("link", info.client_ip);
    if let Some(wait) = state.mail.link_failures.wait(&key, mono) {
        return Err(ApiError::rate_limited("too many links that do not work, wait a few minutes", wait));
    }
    let now = state.clock.now_ms();
    let found: Option<Pending> = if links::is_token(token) {
        sqlx::query_as(
            "SELECT r.user_id, r.email, r.password_fingerprint, r.expires_at, r.used_at, u.email AS current_email, \
             u.password_hash, u.disabled FROM password_resets r JOIN users u ON u.id = r.user_id \
             WHERE r.token_hash = $1",
        )
        .bind(links::hash(token))
        .fetch_optional(&state.db)
        .await?
    } else {
        None
    };
    let works = found.filter(|p| {
        p.used_at.is_none()
            && p.expires_at > now
            && p.current_email == p.email
            && p.disabled == 0
            && p.password_fingerprint == fingerprint(p.password_hash.as_deref())
    });
    works.ok_or_else(|| {
        state.mail.link_failures.record(&key, &network_key(info.client_ip), mono);
        invalid_link()
    })
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TokenBody {
    token: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkInfo {
    email: String,
    expires_at: i64,
}

async fn inspect(
    State(state): State<AppState>,
    Extension(info): Extension<RequestInfo>,
    JsonBody(body): JsonBody<TokenBody>,
) -> ApiResult<Json<LinkInfo>> {
    let found = find(&state, &info, &body.token).await?;
    Ok(Json(LinkInfo { email: found.email, expires_at: found.expires_at }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CompleteBody {
    token: String,
    password: String,
}

async fn complete(
    State(state): State<AppState>,
    Extension(info): Extension<RequestInfo>,
    JsonBody(body): JsonBody<CompleteBody>,
) -> ApiResult<StatusCode> {
    let found = find(&state, &info, &body.token).await?;
    password::check_policy(&body.password).map_err(|e| ApiError::validation(e).with_field("password"))?;
    let hash = password::hash(body.password).await?;
    let now = state.clock.now_ms();
    let token_hash = links::hash(&body.token);
    let mut tx = crate::db::begin(&state.db).await?;
    // The link is used up first: of two at once, the second finds it taken.
    let used = sqlx::query(
        "UPDATE password_resets SET used_at = $1 WHERE token_hash = $2 AND used_at IS NULL AND expires_at > $1",
    )
    .bind(now)
    .bind(&token_hash)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    // Only over the password the link was asked for under (a sign-in or change in between wins).
    let changed =
        sqlx::query("UPDATE users SET password_hash = $1 WHERE id = $2 AND password_hash = $3 AND disabled = 0")
            .bind(&hash)
            .bind(&found.user_id)
            .bind(found.password_hash.as_deref())
            .execute(&mut *tx)
            .await?
            .rows_affected();
    if used == 0 || changed == 0 {
        return Err(invalid_link());
    }
    sqlx::query("DELETE FROM password_resets WHERE user_id = $1 AND token_hash <> $2")
        .bind(&found.user_id)
        .bind(&token_hash)
        .execute(&mut *tx)
        .await?;
    // Whoever knew the old password, or took over a session, is signed out: always.
    let ended = session::delete_for_user(&mut *tx, &found.user_id, None).await?;
    let event = crate::audit::AuditEvent {
        org_id: None,
        actor_user_id: Some(&found.user_id),
        actor_address: Some(info.client_ip.to_string()),
        action: "auth.password_reset_completed",
        resource_type: Some("user"),
        resource_id: Some(&found.user_id),
        summary: json!({ "userId": found.user_id, "sessionsEnded": ended }),
        at_ms: now,
    };
    crate::audit::record(&mut tx, &event).await?;
    crate::db::commit(tx).await?;
    // Whoever locked the account out with wrong passwords has no say over the new one.
    state.account_limiter.reset(&account_key(&found.email));
    Ok(StatusCode::NO_CONTENT)
}

/// "Send password link" from the members page: the same link as asking for one, to a member the
/// admin may change.
async fn send_member_link(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    Path((_, user_id)): Path<(String, String)>,
) -> ApiResult<Json<smtp::Delivered>> {
    if !mail::can_send_links(&state).await? {
        return Err(unavailable());
    }
    let member: Option<(String,)> = sqlx::query_as("SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2")
        .bind(&ctx.org_id)
        .bind(&user_id)
        .fetch_optional(&state.db)
        .await?;
    let Some((role,)) = member else { return Err(ApiError::not_found()) };
    // Nobody acts on someone who holds more than they do here: the member's role, their teams'
    // roles and their own grants in this organization.
    {
        let mut conn = state.db.acquire().await?;
        let mut held = resolve_role(&mut *conn, &ctx.org_id, &role).await?.map(|r| r.permissions).unwrap_or_default();
        held.extend(super::members::held_through_membership(&mut conn, &ctx.org_id, &user_id).await?);
        ensure_holds(&ctx.permissions, &held)?;
    }
    let account: Account = sqlx::query_as("SELECT id, email, password_hash FROM users WHERE id = $1 AND disabled = 0")
        .bind(&user_id)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(ApiError::not_found)?;
    // A server admin's password is a server matter: only another server admin sends its link.
    let (target_admin,): (i64,) =
        sqlx::query_as("SELECT is_server_admin FROM users WHERE id = $1").bind(&user_id).fetch_one(&state.db).await?;
    if target_admin != 0 && ctx.user.is_server_admin == 0 {
        return Err(ApiError::forbidden("only a server admin sends a password link to a server admin"));
    }
    if account.password_hash.is_none() {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "conflict",
            "this account signs in without a password of its own",
        )
        .because("mail.reset_password_elsewhere"));
    }
    let mono = state.clock.monotonic_ms();
    state
        .mail
        .reset_account
        .try_acquire(&account_key(&account.email), &network_key(info.client_ip), mono)
        .map_err(too_many)?;
    let token = issue(&state, &account, Some((&ctx.user.id, &ctx.org_id)), &info.client_ip.to_string()).await?;
    let public = mail::public_url(&state).ok_or_else(unavailable)?;
    let lang = mail::language(&state, Some(&account.id)).await?;
    let content = templates::password_reset(lang, &mail::link(&public, "reset-password", &token), &mail::host(&state));
    let effective = mail::settings::effective(&state).await?;
    let delivered = mail::send(&state, &effective, &account.email, &content).await.map_err(|mut e| {
        // The form's fields are not on this page; the answer names the mail server's reply.
        e.field = None;
        e.into_api()
    })?;
    Ok(Json(delivered))
}
