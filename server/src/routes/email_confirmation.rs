//! Confirming an account's email address by mail (docs/api/mail.md, "Email confirmation"). An
//! account made from an invitation link an admin passed on (rather than mailed) starts with its
//! address unconfirmed: nobody showed that the person reads that mailbox. Until its owner confirms
//! it here, the account is not added to an organization by address, and single sign-on never
//! links to it by address (`confirmed_account_by_email`).
//!
//! Confirming needs a session of the same account: a link proves that someone reads the mailbox,
//! and only together with the account's own session does it prove that the account's owner does.
//! Otherwise someone could make an account for another person's address and have that person
//! click the link.

use axum::extract::State;
use axum::http::{Method, StatusCode};
use axum::{Extension, Json};
use serde::Deserialize;
use serde_json::json;

use super::support::{Actor, audit};
use super::table::{RouteDef, route};
use crate::app::AppState;
use crate::auth::SessionUser;
use crate::auth::ratelimit::{address_key, network_key};
use crate::authz::Access;
use crate::error::{ApiError, ApiResult};
use crate::extract::JsonBody;
use crate::mail::{self, links, smtp, templates};
use crate::net::RequestInfo;

/// How long a confirmation link works.
pub const VALID_MS: i64 = 24 * 3_600_000;

pub fn routes() -> Vec<RouteDef> {
    vec![
        route(Method::POST, "/me/email-confirmation", Access::Authenticated, request),
        route(Method::POST, "/me/email-confirmation/confirm", Access::Authenticated, confirm),
    ]
}

/// The account with this address, for single sign-on: only one whose address is confirmed and
/// that is enabled. A provider's claim of an address never takes over an account whose owner
/// never showed they read it; such an account signs in with its password and confirms first.
pub async fn confirmed_account_by_email<'c, E>(db: E, email: &str) -> ApiResult<Option<String>>
where
    E: sqlx::Executor<'c, Database = sqlx::Any>,
{
    let row: Option<(String,)> =
        sqlx::query_as("SELECT id FROM users WHERE email = $1 AND email_confirmed = 1 AND disabled = 0")
            .bind(email)
            .fetch_optional(db)
            .await?;
    Ok(row.map(|(id,)| id))
}

/// Sends the signed-in user a link that confirms their address.
async fn request(
    State(state): State<AppState>,
    Extension(user): Extension<SessionUser>,
    Extension(info): Extension<RequestInfo>,
) -> ApiResult<Json<smtp::Delivered>> {
    let (confirmed,): (i64,) =
        sqlx::query_as("SELECT email_confirmed FROM users WHERE id = $1").bind(&user.id).fetch_one(&state.db).await?;
    if confirmed != 0 {
        return Err(ApiError::new(StatusCode::CONFLICT, "conflict", "the address is confirmed already")
            .because("mail.email_confirmed_already"));
    }
    let Some(public) = mail::public_url(&state) else {
        return Err(unavailable());
    };
    let effective = mail::settings::effective(&state).await?;
    if !effective.configured() {
        return Err(unavailable());
    }
    let mono = state.clock.monotonic_ms();
    let key = format!("confirm:{}", user.id);
    state
        .mail
        .reset_account
        .try_acquire(&key, &network_key(info.client_ip), mono)
        .map_err(|wait| ApiError::rate_limited("too many confirmation mails, wait a while", wait))?;
    let now = state.clock.now_ms();
    let token = links::new_token();
    let mut tx = crate::db::begin(&state.db).await?;
    sqlx::query("DELETE FROM email_confirmations WHERE user_id = $1 OR expires_at < $2")
        .bind(&user.id)
        .bind(now)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "INSERT INTO email_confirmations (token_hash, user_id, email, created_at, expires_at) VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(links::hash(&token))
    .bind(&user.id)
    .bind(&user.email)
    .bind(now)
    .bind(now + VALID_MS)
    .execute(&mut *tx)
    .await?;
    let actor = Actor { user_id: &user.id, info: &info, at_ms: now };
    audit(&mut tx, &actor, None, "user.email_confirmation_requested", ("user", &user.id), json!({ "userId": user.id }))
        .await?;
    crate::db::commit(tx).await?;
    let lang = mail::language(&state, Some(&user.id)).await?;
    let content = templates::confirm_email(lang, &mail::link(&public, "confirm-email", &token), &mail::host(&state));
    let delivered = mail::send(&state, &effective, &user.email, &content).await.map_err(|mut e| {
        e.field = None;
        e.into_api()
    })?;
    Ok(Json(delivered))
}

fn unavailable() -> ApiError {
    ApiError::new(StatusCode::CONFLICT, "conflict", "this server sends no mail").because("mail.reset_unavailable")
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TokenBody {
    token: String,
}

async fn confirm(
    State(state): State<AppState>,
    Extension(user): Extension<SessionUser>,
    Extension(info): Extension<RequestInfo>,
    JsonBody(body): JsonBody<TokenBody>,
) -> ApiResult<StatusCode> {
    let mono = state.clock.monotonic_ms();
    let key = address_key("link", info.client_ip);
    if let Some(wait) = state.mail.link_failures.wait(&key, mono) {
        return Err(ApiError::rate_limited("too many links that do not work, wait a few minutes", wait));
    }
    let now = state.clock.now_ms();
    let invalid = || {
        state.mail.link_failures.record(&key, &network_key(info.client_ip), mono);
        ApiError::not_found().because("mail.confirm_invalid")
    };
    if !links::is_token(&body.token) {
        return Err(invalid());
    }
    let hash = links::hash(&body.token);
    let mut tx = crate::db::begin(&state.db).await?;
    let found: Option<(String, String)> = sqlx::query_as(
        "SELECT c.user_id, c.email FROM email_confirmations c JOIN users u ON u.id = c.user_id \
         WHERE c.token_hash = $1 AND c.used_at IS NULL AND c.expires_at > $2 AND u.email = c.email \
         AND c.user_id = $3",
    )
    .bind(&hash)
    .bind(now)
    // Only the account the link was made for, signed in: another account's link answers like an
    // unknown one.
    .bind(&user.id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some((user_id, _)) = found else { return Err(invalid()) };
    let used = sqlx::query("UPDATE email_confirmations SET used_at = $1 WHERE token_hash = $2 AND used_at IS NULL")
        .bind(now)
        .bind(&hash)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    if used == 0 {
        return Err(invalid());
    }
    sqlx::query("UPDATE users SET email_confirmed = 1 WHERE id = $1").bind(&user_id).execute(&mut *tx).await?;
    let event = crate::audit::AuditEvent {
        org_id: None,
        actor_user_id: Some(&user_id),
        actor_address: Some(info.client_ip.to_string()),
        action: "user.email_confirmed",
        resource_type: Some("user"),
        resource_id: Some(&user_id),
        summary: json!({ "userId": user_id }),
        at_ms: now,
    };
    crate::audit::record(&mut tx, &event).await?;
    crate::db::commit(tx).await?;
    Ok(StatusCode::NO_CONTENT)
}
