//! Invitations to an organization by email (docs/api/mail.md, "Invitations"): an admin invites
//! with a role (and a team); the link works for seven days and once. With a mail server the link
//! goes by mail, without one the admin copies it. "Resend" makes a new link and starts the seven
//! days again; revoking deletes the invitation, so its link answers like an unknown one.
//!
//! Accepting needs no session: a new person sets name and password, someone with an account
//! signs in first and joins. Single sign-on, once there, accepts through `redeem` after the
//! provider confirmed the invited address (`sso_options` lists what the page offers).

use axum::extract::{Path, State};
use axum::http::{HeaderMap, Method, StatusCode};
use axum::response::IntoResponse;
use axum::{Extension, Json};
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::support::{Actor, PageQuery, Paging, QueryParams, audit, conflict, is_unique_violation};
use super::table::{RouteDef, route};
use crate::app::AppState;
use crate::auth::{SessionUser, password, session};
use crate::authz::{Access, OrgCtx, Permission, ensure_holds, lock_org, lock_role, resolve_role};
use crate::error::{ApiError, ApiResult};
use crate::extract::JsonBody;
use crate::mail::{self, links, smtp, templates};
use crate::net::RequestInfo;
use crate::shapes::Page;

/// How long an invitation link works.
pub const VALID_MS: i64 = 7 * 24 * 3_600_000;
/// Addresses one request may invite.
pub const MAX_EMAILS: usize = 50;
/// Accepted invitations stay this long (for "already accepted"), expired ones this long after
/// they ended (for "expired on ..."); then they are deleted when the next one is made.
pub const KEEP_ACCEPTED_MS: i64 = 30 * 24 * 3_600_000;
pub const KEEP_EXPIRED_MS: i64 = 90 * 24 * 3_600_000;

pub fn routes() -> Vec<RouteDef> {
    use Permission::UsersInvite;
    vec![
        route(Method::GET, "/orgs/{orgId}/invitations", Access::Org(UsersInvite), list),
        route(Method::POST, "/orgs/{orgId}/invitations", Access::Org(UsersInvite), create),
        route(Method::GET, "/orgs/{orgId}/invitations/{invitationId}/link", Access::Org(UsersInvite), copy_link),
        route(Method::POST, "/orgs/{orgId}/invitations/{invitationId}/resend", Access::Org(UsersInvite), resend),
        route(Method::DELETE, "/orgs/{orgId}/invitations/{invitationId}", Access::Org(UsersInvite), revoke),
        route(Method::POST, "/auth/invitation", Access::Public, inspect),
        route(Method::POST, "/auth/invitation/accept", Access::Public, accept),
    ]
}

#[derive(Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Invitation {
    id: String,
    email: String,
    /// A built-in role name or a custom role id.
    role: String,
    team_id: Option<String>,
    team_name: Option<String>,
    invited_by_name: Option<String>,
    created_at: i64,
    expires_at: i64,
    /// `none` (copy the link), `pending`, `sent` or `failed`.
    delivery: String,
    /// The mail server's answer when the mail failed.
    delivery_detail: Option<String>,
    delivered_at: Option<i64>,
    /// `pending` or `expired`.
    #[sqlx(skip)]
    state: &'static str,
}

const COLUMNS: &str = "SELECT i.id, i.email, i.role, i.team_id, t.name AS team_name, u.name AS invited_by_name, \
     i.created_at, i.expires_at, i.delivery, i.delivery_detail, i.delivered_at FROM invitations i \
     LEFT JOIN teams t ON t.id = i.team_id LEFT JOIN users u ON u.id = i.invited_by";

fn with_state(mut row: Invitation, now: i64) -> Invitation {
    row.state = if row.expires_at > now { "pending" } else { "expired" };
    row
}

async fn load<'c, E>(db: E, org_id: &str, id: &str, now: i64) -> ApiResult<Invitation>
where
    E: sqlx::Executor<'c, Database = sqlx::Any>,
{
    let row: Option<Invitation> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "{COLUMNS} WHERE i.org_id = $1 AND i.id = $2 AND i.accepted_at IS NULL"
    )))
    .bind(org_id)
    .bind(id)
    .fetch_optional(db)
    .await?;
    row.map(|r| with_state(r, now)).ok_or_else(ApiError::not_found)
}

async fn list(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    QueryParams(q): QueryParams<PageQuery>,
) -> ApiResult<Json<Page<Invitation>>> {
    let paging = Paging::new(q.limit, q.cursor.as_deref())?;
    let now = state.clock.now_ms();
    let rows: Vec<Invitation> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "{COLUMNS} WHERE i.org_id = $1 AND i.accepted_at IS NULL \
         AND (i.created_at < $2 OR (i.created_at = $2 AND i.id < $3)) ORDER BY i.created_at DESC, i.id DESC LIMIT $4"
    )))
    .bind(&ctx.org_id)
    .bind(paging.before_time())
    .bind(paging.before_id())
    .bind(paging.fetch_limit())
    .fetch_all(&state.db)
    .await?;
    let rows = rows.into_iter().map(|r| with_state(r, now)).collect();
    Ok(Json(paging.page(rows, |i| (i.created_at, i.id.as_str()))))
}

/// Links point to `server.public_url`; without it no link can be made.
fn public_url(state: &AppState) -> ApiResult<String> {
    mail::public_url(state).ok_or_else(|| {
        ApiError::new(StatusCode::CONFLICT, "conflict", "set server.public_url so links point to this server")
            .because("mail.public_url_missing")
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateRequest {
    emails: Vec<String>,
    role: String,
    #[serde(default)]
    team_id: Option<String>,
}

/// One invitation made or renewed by a request, with what its mail needs.
struct Issued {
    id: String,
    email: String,
    token: String,
    token_hash: String,
    expires_at: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IssuedView {
    invitation: Invitation,
    /// The link, when no mail server is set up and the admin passes it on.
    link: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Created {
    items: Vec<IssuedView>,
    /// The mails went to the mail server (see each invitation's `delivery`).
    mailed: bool,
}

/// What the mails of one request share.
struct Letter {
    org_id: String,
    org_name: String,
    inviter: String,
    role_key: String,
    role_name: String,
    team_name: Option<String>,
}

/// The role to give: within the organization, locked so it cannot be deleted meanwhile, and
/// within what the caller holds.
async fn assignable_role(tx: &mut sqlx::AnyConnection, ctx: &OrgCtx, key: &str) -> ApiResult<crate::authz::RoleInfo> {
    let role = lock_role(tx, &ctx.org_id, key)
        .await?
        .ok_or_else(|| ApiError::validation("no such role").with_field("role"))?;
    ensure_holds(&ctx.permissions, &role.permissions)?;
    Ok(role)
}

/// The team an invitation names, with the guards of adding a member to it (`teams::ensure_may_join`):
/// its name, and whether bringing someone in is an org admin's access to its team spaces, which
/// the caller audits.
async fn team_of(tx: &mut sqlx::AnyConnection, ctx: &OrgCtx, team_id: &str) -> ApiResult<(String, bool)> {
    // Joining a team is a change of its members.
    ctx.check(Permission::TeamsMembers)?;
    let team: Option<(String,)> = sqlx::query_as("SELECT name FROM teams WHERE id = $1 AND org_id = $2")
        .bind(team_id)
        .bind(&ctx.org_id)
        .fetch_optional(&mut *tx)
        .await?;
    let Some((name,)) = team else {
        return Err(ApiError::validation("no such team").with_field("teamId"));
    };
    let admin_access = super::teams::ensure_may_join(tx, ctx, team_id).await?;
    Ok((name, admin_access))
}

/// Everything an invitation hands out: its role and its team's roles. Acting on an invitation
/// (copying its link, revoking it) needs all of it, like inviting.
async fn ensure_holds_invitation(
    tx: &mut sqlx::AnyConnection,
    ctx: &OrgCtx,
    role: &str,
    team_id: Option<&str>,
) -> ApiResult<()> {
    let mut wanted = resolve_role(&mut *tx, &ctx.org_id, role).await?.map(|r| r.permissions).unwrap_or_default();
    if let Some(team_id) = team_id {
        wanted.extend(super::teams::team_permissions(&mut *tx, &ctx.org_id, team_id).await?);
    }
    ensure_holds(&ctx.permissions, &wanted)
}

/// Counts `n` invitations against the organization's hourly budget (`mail::INVITES_PER_ORG`);
/// all or none.
fn count_invitations(state: &AppState, org_id: &str, n: usize) -> ApiResult<()> {
    let key = format!("invites:{org_id}");
    let mono = state.clock.monotonic_ms();
    let mut counted = Vec::new();
    for _ in 0..n {
        match state.mail.invites.try_acquire(&key, &key, mono) {
            Ok(c) => counted.push(c),
            Err(wait) => {
                for c in &counted {
                    state.mail.invites.refund(&key, c);
                }
                return Err(ApiError::rate_limited("too many invitations in this organization, wait a while", wait)
                    .because("mail.invite_limit")
                    .param("max", crate::mail::INVITES_PER_ORG));
            }
        }
    }
    Ok(())
}

async fn is_member(tx: &mut sqlx::AnyConnection, org_id: &str, email: &str) -> ApiResult<bool> {
    // The person with the address in any of its forms (`routes::email_key`).
    for user_id in super::accounts_with_email(&mut *tx, email).await? {
        let (n,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM org_members WHERE org_id = $1 AND user_id = $2")
            .bind(org_id)
            .bind(&user_id)
            .fetch_one(&mut *tx)
            .await?;
        if n > 0 {
            return Ok(true);
        }
    }
    Ok(false)
}

fn email_problem(message: &str, reason: &'static str, email: &str) -> ApiError {
    let status = if reason == "mail.address_invalid" { StatusCode::UNPROCESSABLE_ENTITY } else { StatusCode::CONFLICT };
    let code = if status == StatusCode::CONFLICT { "conflict" } else { "validation" };
    ApiError::new(status, code, message.to_string()).with_field("emails").because(reason).param("email", email)
}

/// Writes a fresh token to the invitation, starts its days and resets its delivery. Only a link the
/// admin passes on (`delivery` `none`) keeps a sealed copy for "Copy link"; a link that goes by
/// mail is never shown again, so only its mailbox can open it.
async fn issue_token(
    tx: &mut sqlx::AnyConnection,
    state: &AppState,
    id: &str,
    now: i64,
    delivery: &str,
) -> ApiResult<(String, String, i64)> {
    let token = links::new_token();
    let token_hash = links::hash(&token);
    let sealed = (delivery == "none").then(|| links::seal(&state.secrets, id, &token));
    let expires_at = now + VALID_MS;
    sqlx::query(
        "UPDATE invitations SET token_hash = $1, token_key_id = $2, token_nonce = $3, token_ciphertext = $4, \
         created_at = $5, expires_at = $6, delivery = $7, delivery_detail = NULL, delivered_at = NULL WHERE id = $8",
    )
    .bind(&token_hash)
    .bind(sealed.as_ref().map(|b| b.key_id.as_str()))
    .bind(sealed.as_ref().map(|b| b.nonce.as_str()))
    .bind(sealed.as_ref().map(|b| b.ciphertext.as_str()))
    .bind(now)
    .bind(expires_at)
    .bind(delivery)
    .bind(id)
    .execute(&mut *tx)
    .await?;
    Ok((token, token_hash, expires_at))
}

async fn create(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    JsonBody(req): JsonBody<CreateRequest>,
) -> ApiResult<(StatusCode, Json<Created>)> {
    let public = public_url(&state)?;
    if req.emails.is_empty() || req.emails.len() > MAX_EMAILS {
        return Err(ApiError::validation(format!("invite 1 to {MAX_EMAILS} addresses at once"))
            .with_field("emails")
            .because("mail.invite_count")
            .param("max", MAX_EMAILS));
    }
    let mut emails = Vec::new();
    for raw in &req.emails {
        let email = super::normalize_email(raw)
            .ok()
            .filter(|e| mail::settings::is_address(e))
            .ok_or_else(|| email_problem("not a complete email address", "mail.address_invalid", raw.trim()))?;
        if !emails.contains(&email) {
            emails.push(email);
        }
    }
    let mailing = mail::settings::effective(&state).await?;
    let delivery = if mailing.configured() { "pending" } else { "none" };
    let now = state.clock.now_ms();
    count_invitations(&state, &ctx.org_id, emails.len())?;

    let mut tx = crate::db::begin(&state.db).await?;
    lock_org(&mut tx, &ctx.org_id).await?;
    let role = assignable_role(&mut tx, &ctx, &req.role).await?;
    let (team_name, team_admin_access) = match &req.team_id {
        Some(team_id) => {
            let (name, admin) = team_of(&mut tx, &ctx, team_id).await?;
            (Some(name), admin)
        }
        None => (None, false),
    };
    // Old rows go first, so an expired invitation of the same address makes room for the new one.
    sqlx::query(
        "DELETE FROM invitations WHERE org_id = $1 AND (accepted_at < $2 OR (accepted_at IS NULL AND expires_at < $3))",
    )
    .bind(&ctx.org_id)
    .bind(now - KEEP_ACCEPTED_MS)
    .bind(now - KEEP_EXPIRED_MS)
    .execute(&mut *tx)
    .await?;
    clear_expired_links(&mut tx, now).await?;
    let mut issued = Vec::new();
    for email in &emails {
        // A service account's made-up address (in any form, `routes::email_key`) is no mailbox
        // and no person to invite.
        if super::all_accounts_with_email(&mut tx, email).await?.iter().any(|(_, service)| *service) {
            return Err(email_problem("this address belongs to a service account", "mail.address_invalid", email));
        }
        if is_member(&mut tx, &ctx.org_id, email).await? {
            return Err(email_problem("this address is already a member", "mail.invite_already_member", email));
        }
        let open: Option<(String, i64)> = sqlx::query_as(
            "SELECT id, expires_at FROM invitations WHERE org_id = $1 AND email = $2 AND accepted_at IS NULL",
        )
        .bind(&ctx.org_id)
        .bind(email)
        .fetch_optional(&mut *tx)
        .await?;
        match open {
            Some((_, expires_at)) if expires_at > now => {
                return Err(email_problem("this address has an open invitation", "mail.invite_pending", email));
            }
            // An expired invitation of the address is replaced.
            Some((old, _)) => {
                sqlx::query("DELETE FROM invitations WHERE id = $1").bind(&old).execute(&mut *tx).await?;
            }
            None => {}
        }
        let id = super::new_id();
        // A placeholder hash, replaced with the real one right away (the column is unique).
        sqlx::query(
            "INSERT INTO invitations (id, org_id, email, role, team_id, token_hash, invited_by, created_at, \
             expires_at, delivery) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
        )
        .bind(&id)
        .bind(&ctx.org_id)
        .bind(email)
        .bind(&role.key)
        .bind(req.team_id.as_deref())
        .bind(format!("new:{id}"))
        .bind(&ctx.user.id)
        .bind(now)
        .bind(now + VALID_MS)
        .bind(delivery)
        .execute(&mut *tx)
        .await?;
        let (token, token_hash, expires_at) = issue_token(&mut tx, &state, &id, now, delivery).await?;
        let actor = Actor { user_id: &ctx.user.id, info: &info, at_ms: now };
        let summary = json!({ "invitationId": id, "role": role.key, "teamId": req.team_id });
        audit(&mut tx, &actor, Some(&ctx.org_id), "invitation.created", ("invitation", &id), summary).await?;
        if let (true, Some(team_id)) = (team_admin_access, &req.team_id) {
            let access = json!({ "action": "invitation.created", "teamId": team_id, "invitationId": id });
            super::teams::audit_admin_access(&mut tx, &actor, &ctx.org_id, team_id, access).await?;
        }
        issued.push(Issued { id, email: email.clone(), token, token_hash, expires_at });
    }
    let (org_name,): (String,) =
        sqlx::query_as("SELECT name FROM orgs WHERE id = $1").bind(&ctx.org_id).fetch_one(&mut *tx).await?;
    crate::db::commit(tx).await?;

    let letter = Letter {
        org_id: ctx.org_id.clone(),
        org_name,
        inviter: ctx.user.name.clone(),
        role_key: role.key.clone(),
        role_name: role.name.clone(),
        team_name,
    };
    let items = finish(&state, &ctx, &info, &mailing, &letter, &public, issued).await?;
    Ok((StatusCode::CREATED, Json(Created { items, mailed: mailing.configured() })))
}

/// After the commit: sends the mails (with a mail server) and answers the invitations as they
/// are now, with their links when the admin passes them on.
async fn finish(
    state: &AppState,
    ctx: &OrgCtx,
    info: &RequestInfo,
    mailing: &mail::settings::Effective,
    letter: &Letter,
    public: &str,
    issued: Vec<Issued>,
) -> ApiResult<Vec<IssuedView>> {
    if mailing.configured() {
        send_all(state, ctx, info, mailing, letter, public, &issued).await;
    }
    let now = state.clock.now_ms();
    let mut out = Vec::new();
    for item in issued {
        let invitation = load(&state.db, &ctx.org_id, &item.id, now).await?;
        let link = (!mailing.configured()).then(|| mail::link(public, "invite", &item.token));
        out.push(IssuedView { invitation, link });
    }
    Ok(out)
}

/// Sends each invitation's mail and records how it went. When the mail server itself fails, the
/// rest are marked with the same answer instead of waiting for it again.
async fn send_all(
    state: &AppState,
    ctx: &OrgCtx,
    info: &RequestInfo,
    mailing: &mail::settings::Effective,
    letter: &Letter,
    public: &str,
    issued: &[Issued],
) {
    let zone = mail::time_zone(state, Some(&letter.org_id)).await.unwrap_or(None);
    let host = mail::host(state);
    let mut broken: Option<smtp::SendError> = None;
    for item in issued {
        let result = match &broken {
            Some(e) => Err(e.clone()),
            None => {
                let recipient: Option<(String,)> =
                    sqlx::query_as("SELECT id FROM users WHERE email = $1 AND service_account = 0")
                        .bind(&item.email)
                        .fetch_optional(&state.db)
                        .await
                        .unwrap_or(None);
                let lang = mail::language(state, recipient.as_ref().map(|(id,)| id.as_str()))
                    .await
                    .unwrap_or(templates::Lang::En);
                let role = templates::role_label(lang, &letter.role_key, &letter.role_name);
                let expires = templates::moment(item.expires_at, zone.as_deref(), lang);
                let link = mail::link(public, "invite", &item.token);
                let content = templates::invitation(
                    lang,
                    &templates::Invitation {
                        inviter: &letter.inviter,
                        org: &letter.org_name,
                        role: &role,
                        team: letter.team_name.as_deref(),
                        expires: &expires,
                        link: &link,
                        host: &host,
                    },
                );
                mail::send(state, mailing, &item.email, &content).await
            }
        };
        if let Err(e) = &result
            && e.connection
        {
            broken = Some(e.clone());
        }
        if let Err(e) = record_delivery(state, ctx, info, item, &result).await {
            tracing::warn!(invitation = %item.id, "recording how an invitation mail went failed: {}", e.message);
        }
    }
}

async fn record_delivery(
    state: &AppState,
    ctx: &OrgCtx,
    info: &RequestInfo,
    item: &Issued,
    result: &Result<smtp::Delivered, smtp::SendError>,
) -> ApiResult<()> {
    let now = state.clock.now_ms();
    let (delivery, detail) = match result {
        Ok(_) => ("sent", None),
        Err(e) => ("failed", Some(e.detail())),
    };
    let mut tx = crate::db::begin(&state.db).await?;
    // Only for the link this mail carried: a resend in between has its own delivery.
    let updated = sqlx::query(
        "UPDATE invitations SET delivery = $1, delivery_detail = $2, delivered_at = $3 WHERE id = $4 AND token_hash = $5",
    )
    .bind(delivery)
    .bind(detail.as_deref())
    .bind(now)
    .bind(&item.id)
    .bind(&item.token_hash)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if updated == 1
        && let Some(detail) = &detail
    {
        let actor = Actor { user_id: &ctx.user.id, info, at_ms: now };
        // The server's answer often repeats the address; the audit log keeps no emails.
        let reply: Vec<&str> =
            detail.split_whitespace().map(|w| if w.contains('@') { "<address>" } else { w }).collect();
        let summary = json!({ "invitationId": item.id, "reply": reply.join(" ") });
        audit(&mut tx, &actor, Some(&ctx.org_id), "invitation.delivery_failed", ("invitation", &item.id), summary)
            .await?;
    }
    crate::db::commit(tx).await?;
    Ok(())
}

/// A pending invitation's sealed token (`mail::links::seal`).
#[derive(sqlx::FromRow)]
struct Sealed {
    expires_at: i64,
    token_key_id: Option<String>,
    token_nonce: Option<String>,
    token_ciphertext: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkView {
    link: String,
    expires_at: i64,
}

async fn copy_link(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    Path((_, id)): Path<(String, String)>,
) -> ApiResult<Json<LinkView>> {
    let public = public_url(&state)?;
    let now = state.clock.now_ms();
    let row: Option<Sealed> = sqlx::query_as(
        "SELECT expires_at, token_key_id, token_nonce, token_ciphertext FROM invitations \
         WHERE org_id = $1 AND id = $2 AND accepted_at IS NULL",
    )
    .bind(&ctx.org_id)
    .bind(&id)
    .fetch_optional(&state.db)
    .await?;
    let delivery: Option<(String, String, Option<String>)> = sqlx::query_as(
        "SELECT delivery, role, team_id FROM invitations WHERE org_id = $1 AND id = $2 AND accepted_at IS NULL",
    )
    .bind(&ctx.org_id)
    .bind(&id)
    .fetch_optional(&state.db)
    .await?;
    let Some((delivery, role, team_id)) = delivery else { return Err(ApiError::not_found()) };
    {
        let mut conn = state.db.acquire().await?;
        ensure_holds_invitation(&mut conn, &ctx, &role, team_id.as_deref()).await?;
    }
    // A link that went by mail is opened from that mailbox only; it can be sent again.
    if delivery != "none" {
        return Err(ApiError::new(StatusCode::CONFLICT, "conflict", "the link went by mail; send it again instead")
            .because("mail.invite_link_by_mail"));
    }
    let Some(Sealed {
        expires_at,
        token_key_id: Some(key_id),
        token_nonce: Some(nonce),
        token_ciphertext: Some(ciphertext),
    }) = row
    else {
        return Err(ApiError::not_found());
    };
    if expires_at <= now {
        let mut conn = state.db.acquire().await?;
        clear_expired_links(&mut conn, now).await?;
        return Err(ApiError::new(StatusCode::CONFLICT, "conflict", "the invitation has expired; send it again")
            .because("mail.invite_expired"));
    }
    let blob = crate::secrets::Blob { key_id, nonce, ciphertext };
    let token = links::unseal(&state.secrets, &id, &blob).ok_or_else(|| {
        ApiError::new(StatusCode::CONFLICT, "conflict", "the link cannot be shown again; send the invitation again")
            .because("mail.invite_link_unavailable")
    })?;
    // Showing a working link is recorded like making one.
    let mut tx = crate::db::begin(&state.db).await?;
    let actor = Actor { user_id: &ctx.user.id, info: &info, at_ms: now };
    audit(
        &mut tx,
        &actor,
        Some(&ctx.org_id),
        "invitation.link_copied",
        ("invitation", &id),
        json!({ "invitationId": id }),
    )
    .await?;
    crate::db::commit(tx).await?;
    Ok(Json(LinkView { link: mail::link(&public, "invite", &token), expires_at }))
}

async fn resend(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    Path((_, id)): Path<(String, String)>,
) -> ApiResult<Json<IssuedView>> {
    let public = public_url(&state)?;
    let mailing = mail::settings::effective(&state).await?;
    let delivery = if mailing.configured() { "pending" } else { "none" };
    let now = state.clock.now_ms();
    let mut tx = crate::db::begin(&state.db).await?;
    lock_org(&mut tx, &ctx.org_id).await?;
    let current = load(&mut *tx, &ctx.org_id, &id, now).await?;
    let role = assignable_role(&mut tx, &ctx, &current.role).await.map_err(|e| {
        if e.code == "validation" {
            // The role was deleted since: the invitation cannot be renewed as it is.
            conflict("the invitation's role no longer exists; revoke it and invite again")
                .because("mail.invite_role_gone")
        } else {
            e
        }
    })?;
    let team_admin_access = match &current.team_id {
        Some(team_id) => team_of(&mut tx, &ctx, team_id).await?.1,
        None => false,
    };
    count_invitations(&state, &ctx.org_id, 1)?;
    if is_member(&mut tx, &ctx.org_id, &current.email).await? {
        return Err(email_problem("this address is already a member", "mail.invite_already_member", &current.email));
    }
    let (token, token_hash, expires_at) = issue_token(&mut tx, &state, &id, now, delivery).await?;
    let actor = Actor { user_id: &ctx.user.id, info: &info, at_ms: now };
    let summary = json!({ "invitationId": id, "wasExpired": current.state == "expired" });
    audit(&mut tx, &actor, Some(&ctx.org_id), "invitation.resent", ("invitation", &id), summary).await?;
    if let (true, Some(team_id)) = (team_admin_access, &current.team_id) {
        let access = json!({ "action": "invitation.resent", "teamId": team_id, "invitationId": id });
        super::teams::audit_admin_access(&mut tx, &actor, &ctx.org_id, team_id, access).await?;
    }
    let (org_name,): (String,) =
        sqlx::query_as("SELECT name FROM orgs WHERE id = $1").bind(&ctx.org_id).fetch_one(&mut *tx).await?;
    crate::db::commit(tx).await?;
    let letter = Letter {
        org_id: ctx.org_id.clone(),
        org_name,
        inviter: ctx.user.name.clone(),
        role_key: role.key.clone(),
        role_name: role.name.clone(),
        team_name: current.team_name.clone(),
    };
    let issued = vec![Issued { id, email: current.email.clone(), token, token_hash, expires_at }];
    let mut items = finish(&state, &ctx, &info, &mailing, &letter, &public, issued).await?;
    Ok(Json(items.remove(0)))
}

async fn revoke(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    Path((_, id)): Path<(String, String)>,
) -> ApiResult<StatusCode> {
    let now = state.clock.now_ms();
    let mut tx = crate::db::begin(&state.db).await?;
    let current = load(&mut *tx, &ctx.org_id, &id, now).await?;
    ensure_holds_invitation(&mut tx, &ctx, &current.role, current.team_id.as_deref()).await?;
    sqlx::query("DELETE FROM invitations WHERE org_id = $1 AND id = $2 AND accepted_at IS NULL")
        .bind(&ctx.org_id)
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    let actor = Actor { user_id: &ctx.user.id, info: &info, at_ms: now };
    let summary = json!({ "invitationId": id, "wasExpired": current.state == "expired" });
    audit(&mut tx, &actor, Some(&ctx.org_id), "invitation.revoked", ("invitation", &id), summary).await?;
    crate::db::commit(tx).await?;
    Ok(StatusCode::NO_CONTENT)
}

// --- Accepting, without a session ---

/// An invitation found by its token.
#[derive(sqlx::FromRow)]
pub struct Found {
    pub id: String,
    pub org_id: String,
    pub email: String,
    pub role: String,
    pub team_id: Option<String>,
    pub expires_at: i64,
    pub accepted_at: Option<i64>,
    pub token_hash: String,
    /// `sent`: the link went by mail, so whoever opens it reads that mailbox.
    pub delivery: String,
    org_name: String,
    team_name: Option<String>,
    invited_by_name: Option<String>,
}

fn invalid_link() -> ApiError {
    // Revoked and unknown links answer alike, so valid links cannot be told from guesses.
    ApiError::not_found().because("mail.invite_invalid")
}

/// Looks a token up, counting unknown ones against the client address.
async fn find(state: &AppState, info: &RequestInfo, token: &str) -> ApiResult<Found> {
    use crate::auth::ratelimit::{address_key, network_key};
    let mono = state.clock.monotonic_ms();
    let key = address_key("link", info.client_ip);
    if let Some(wait) = state.mail.link_failures.wait(&key, mono) {
        return Err(ApiError::rate_limited("too many links that do not work, wait a few minutes", wait));
    }
    let found: Option<Found> = if links::is_token(token) {
        sqlx::query_as(
            "SELECT i.id, i.org_id, i.email, i.role, i.team_id, i.expires_at, i.accepted_at, i.token_hash, \
             i.delivery, o.name AS org_name, \
             t.name AS team_name, u.name AS invited_by_name FROM invitations i JOIN orgs o ON o.id = i.org_id \
             LEFT JOIN teams t ON t.id = i.team_id LEFT JOIN users u ON u.id = i.invited_by WHERE i.token_hash = $1",
        )
        .bind(links::hash(token))
        .fetch_optional(&state.db)
        .await?
    } else {
        None
    };
    match found {
        Some(found) => Ok(found),
        None => {
            state.mail.link_failures.record(&key, &network_key(info.client_ip), mono);
            Err(invalid_link())
        }
    }
}

/// The accounts with `email` in any of its forms (`routes::email_key`).
async fn accounts_with(state: &AppState, email: &str) -> ApiResult<usize> {
    let mut conn = state.db.acquire().await?;
    Ok(super::accounts_with_email(&mut conn, email).await?.len())
}

/// The signed-in user of this browser, if any.
async fn signed_in(state: &AppState, info: &RequestInfo, headers: &HeaderMap) -> ApiResult<Option<SessionUser>> {
    let Some(token) = session::read_cookie(headers, info.https) else { return Ok(None) };
    session::lookup(&state.read_db, &state.db, &state.touches, &state.config.sessions, state.clock.now_ms(), &token)
        .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SsoOption {
    pub id: String,
    pub name: String,
}

/// The single sign-on providers an invitation page offers (`id` is the provider's slug, for its
/// start route): the enabled ones. Signed in through one with the invited address, the person
/// joins with the token alone.
pub async fn sso_options(state: &AppState, _org_id: &str) -> ApiResult<Vec<SsoOption>> {
    Ok(crate::sso::store::all(&state.read_db)
        .await?
        .into_iter()
        .filter(|p| p.enabled != 0)
        .map(|p| SsoOption { id: p.slug, name: p.name })
        .collect())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TokenBody {
    token: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignedInView {
    name: String,
    email: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InvitationInfo {
    org_name: String,
    inviter_name: Option<String>,
    email: String,
    role: String,
    /// A custom role's name; built-in roles are translated by the UI.
    role_name: String,
    team_name: Option<String>,
    expires_at: i64,
    /// `valid`, `expired` or `accepted`.
    state: &'static str,
    /// An account with the invited address exists on this server.
    account_exists: bool,
    /// The browser's signed-in account, if any.
    signed_in_as: Option<SignedInView>,
    /// A password of Kalzit's own may be set.
    password: bool,
    sso: Vec<SsoOption>,
}

async fn inspect(
    State(state): State<AppState>,
    Extension(info): Extension<RequestInfo>,
    headers: HeaderMap,
    JsonBody(body): JsonBody<TokenBody>,
) -> ApiResult<Json<InvitationInfo>> {
    let found = find(&state, &info, &body.token).await?;
    let now = state.clock.now_ms();
    let Some(role) = resolve_role(&state.db, &found.org_id, &found.role).await? else {
        return Err(invalid_link());
    };
    let state_name = if found.accepted_at.is_some() {
        "accepted"
    } else if found.expires_at <= now {
        "expired"
    } else {
        "valid"
    };
    // An unused account SCIM made is taken over by a mailed invitation (`scim_claimable`), like a new one.
    let claimable = found.delivery == "sent" && scim_claimable(&state, &found.email).await?.is_some();
    let accounts = if claimable { 0 } else { accounts_with(&state, &found.email).await? };
    let signed = signed_in(&state, &info, &headers).await?;
    Ok(Json(InvitationInfo {
        sso: sso_options(&state, &found.org_id).await?,
        org_name: found.org_name,
        inviter_name: found.invited_by_name,
        email: found.email,
        role: role.key,
        role_name: role.name,
        team_name: found.team_name,
        expires_at: found.expires_at,
        state: state_name,
        account_exists: accounts > 0,
        signed_in_as: signed.map(|u| SignedInView { name: u.name, email: u.email }),
        password: crate::sso::password_sign_in_allowed_in(&state, &found.org_id).await?,
    }))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AcceptBody {
    token: String,
    /// For a new account.
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    password: Option<String>,
}

fn expired() -> ApiError {
    ApiError::new(StatusCode::CONFLICT, "conflict", "the invitation has expired").because("mail.invite_expired")
}

fn used() -> ApiError {
    ApiError::new(StatusCode::CONFLICT, "conflict", "the invitation was accepted already").because("mail.invite_used")
}

/// Makes `user_id` a member as the invitation says and marks it accepted, inside the caller's
/// transaction. The caller has made sure the account is the invited address (a session of that
/// account, a new account with it, or a single sign-on provider that confirmed it). The
/// organization's row is locked first (`authz` lock order).
pub async fn redeem(tx: &mut sqlx::AnyConnection, found: &Found, user_id: &str, now: i64) -> ApiResult<()> {
    lock_org(tx, &found.org_id).await?;
    // Marking it first makes two accepts of one link run one after the other: the second finds it
    // taken.
    let marked = sqlx::query(
        "UPDATE invitations SET accepted_at = $1, accepted_by = $2, token_key_id = NULL, token_nonce = NULL, \
         token_ciphertext = NULL WHERE id = $3 AND token_hash = $4 AND accepted_at IS NULL AND expires_at > $1",
    )
    .bind(now)
    .bind(user_id)
    .bind(&found.id)
    .bind(&found.token_hash)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if marked == 0 {
        return Err(if found.expires_at <= now { expired() } else { used() });
    }
    let Some(role) = lock_role(tx, &found.org_id, &found.role).await? else {
        return Err(invalid_link());
    };
    let (members,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM org_members WHERE org_id = $1 AND user_id = $2")
        .bind(&found.org_id)
        .bind(user_id)
        .fetch_one(&mut *tx)
        .await?;
    if members == 0 {
        sqlx::query("INSERT INTO org_members (org_id, user_id, role, created_at) VALUES ($1, $2, $3, $4)")
            .bind(&found.org_id)
            .bind(user_id)
            .bind(&role.key)
            .bind(now)
            .execute(&mut *tx)
            .await?;
        // In another organization now: no other organization's SCIM owns the account any more.
        crate::scim::release(&mut *tx, user_id, Some(&found.org_id)).await?;
    }
    if let Some(team_id) = &found.team_id {
        let (in_team,): (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM team_members WHERE team_id = $1 AND user_id = $2")
                .bind(team_id)
                .bind(user_id)
                .fetch_one(&mut *tx)
                .await?;
        if in_team == 0 {
            sqlx::query("INSERT INTO team_members (team_id, user_id, role, created_at) VALUES ($1, $2, 'member', $3)")
                .bind(team_id)
                .bind(user_id)
                .bind(now)
                .execute(&mut *tx)
                .await?;
        }
    }
    Ok(())
}

async fn accept(
    State(state): State<AppState>,
    Extension(info): Extension<RequestInfo>,
    headers: HeaderMap,
    JsonBody(body): JsonBody<AcceptBody>,
) -> ApiResult<axum::response::Response> {
    let found = find(&state, &info, &body.token).await?;
    let now = state.clock.now_ms();
    if found.accepted_at.is_some() {
        return Err(used());
    }
    if found.expires_at <= now {
        return Err(expired());
    }
    let audit_event = |user_id: &str, new_account: bool| {
        let summary = json!({
            "invitationId": found.id, "userId": user_id, "role": found.role, "teamId": found.team_id,
            "newAccount": new_account,
            // A link that was passed on rather than mailed: its account's address is unconfirmed.
            "viaCopiedLink": found.delivery != "sent",
        });
        (summary, user_id.to_string())
    };
    // A link that went by mail proves the address reaches its owner.
    let mailed = found.delivery == "sent";
    if let Some(user) = signed_in(&state, &info, &headers).await? {
        // Joining with the account this browser is signed in with: only the invited address (in
        // either form of its domain, as a provider's account may keep it).
        if !super::same_email(&user.email, &found.email) {
            return Err(ApiError::new(StatusCode::CONFLICT, "conflict", "signed in with another account")
                .because("mail.invite_other_account"));
        }
        // The new membership may require a second factor this account does not have: this
        // session ends together with the redemption, and the account sets one up before it gets a
        // session with the membership, as at a sign-in (`routes::second_factor`).
        use crate::auth::second_factor as sf;
        let server_admin = user.is_server_admin != 0;
        let required =
            sf::required_after_joining(&state, &user.id, server_admin, &found.org_id, &found.org_name, &found.role)
                .await?;
        let setup_needed = required.is_some() && !sf::methods(&state.db, &user.id).await?.any();
        let mut tx = crate::db::begin(&state.db).await?;
        redeem(&mut tx, &found, &user.id, now).await?;
        if mailed {
            sqlx::query("UPDATE users SET email_confirmed = 1 WHERE id = $1").bind(&user.id).execute(&mut *tx).await?;
            crate::scim::release(&mut tx, &user.id, None).await?;
        }
        if setup_needed && let Some(token) = session::read_cookie(&headers, info.https) {
            session::delete(&mut *tx, &token).await?;
        }
        let (summary, id) = audit_event(&user.id, false);
        let actor = Actor { user_id: &id, info: &info, at_ms: now };
        audit(&mut tx, &actor, Some(&found.org_id), "invitation.accepted", ("invitation", &found.id), summary).await?;
        crate::db::commit(tx).await?;
        if setup_needed {
            let required = sf::required_for(&state, &user.id, server_admin).await?.or(required);
            let prompt = super::second_factor::forced_setup(&state, &info, &user, required, now).await?;
            let (hash,): (Option<String>,) = sqlx::query_as("SELECT password_hash FROM users WHERE id = $1")
                .bind(&user.id)
                .fetch_one(&state.db)
                .await?;
            // An account without a password of its own (made by a provider) binds nothing to one.
            let first = sf::FirstStep::Password { password_hash: hash.as_deref() };
            let tx = crate::db::begin(&state.db).await?;
            let mut answer = super::second_factor::finish_first_step(
                tx,
                &state,
                &info,
                &headers,
                user,
                first,
                false,
                Some(prompt),
                now,
            )
            .await?;
            answer.headers_mut().append(axum::http::header::SET_COOKIE, session::clear_cookie(info.https));
            return Ok(answer);
        }
        let mut conn = state.db.acquire().await?;
        let answer = super::me(&mut conn, user).await?;
        return Ok(Json(answer).into_response());
    }
    // An account SCIM of another organization made for this address, which nobody ever used, never
    // blocks or captures the invitation: a mailed link proves the mailbox, so its owner takes the
    // account over (docs/api/scim.md, "Accounts").
    let claim = if mailed { scim_claimable(&state, &found.email).await? } else { None };
    if claim.is_none() && accounts_with(&state, &found.email).await? > 0 {
        return Err(account_exists());
    }
    // With password sign-in off for the server or the inviting organization (docs/api/sso.md), a
    // new person gets no password: they sign in through an identity provider, then open the link
    // again and join with that account (the branch above).
    if !crate::sso::password_sign_in_allowed_in(&state, &found.org_id).await? {
        return Err(ApiError::forbidden(
            "password sign-in is off here; sign in through a provider, then open the link again",
        )
        .because("sso.password_sign_in_off"));
    }
    let name = super::clean_name(body.name.as_deref().unwrap_or_default(), "name").map_err(|e| e.with_field("name"))?;
    let new_password = body.password.unwrap_or_default();
    password::check_policy(&new_password).map_err(|e| ApiError::validation(e).with_field("password"))?;
    let hash = password::hash(new_password).await?;
    let mut tx = crate::db::begin(&state.db).await?;
    let user_id = match &claim {
        Some(id) => {
            // Only while it is still unused, checked again in this transaction: no password, no
            // provider identity, unconfirmed, not disabled, and still made by SCIM.
            let taken = sqlx::query(
                "UPDATE users SET name = $1, password_hash = $2, email_confirmed = 1 \
                 WHERE id = $3 AND password_hash IS NULL AND email_confirmed = 0 AND disabled = 0 \
                 AND is_server_admin = 0 AND service_account = 0 \
                 AND NOT EXISTS (SELECT 1 FROM sso_identities i WHERE i.user_id = $4) \
                 AND EXISTS (SELECT 1 FROM scim_users s WHERE s.user_id = $5 AND s.created_account = 1)",
            )
            .bind(&name)
            .bind(&hash)
            .bind(id)
            .bind(id)
            .bind(id)
            .execute(&mut *tx)
            .await?
            .rows_affected();
            if taken == 0 {
                return Err(account_exists());
            }
            crate::scim::release(&mut tx, id, None).await?;
            id.clone()
        }
        None => {
            let user_id = super::new_id();
            sqlx::query(
                "INSERT INTO users (id, email, name, password_hash, is_server_admin, disabled, created_at, \
                 email_confirmed) VALUES ($1, $2, $3, $4, 0, 0, $5, $6)",
            )
            .bind(&user_id)
            .bind(&found.email)
            .bind(&name)
            .bind(&hash)
            .bind(now)
            // Only a link that reached the address by mail confirms it.
            .bind(i64::from(mailed))
            .execute(&mut *tx)
            .await
            .map_err(|e| if is_unique_violation(&e) { account_exists() } else { e.into() })?;
            user_id
        }
    };
    redeem(&mut tx, &found, &user_id, now).await?;
    let (mut summary, id) = audit_event(&user_id, claim.is_none());
    if claim.is_some() {
        summary["claimedScimAccount"] = json!(true);
    }
    let actor = Actor { user_id: &id, info: &info, at_ms: now };
    audit(&mut tx, &actor, Some(&found.org_id), "invitation.accepted", ("invitation", &found.id), summary).await?;
    // The account and its membership first: the sign-in rules below read them, so a second factor
    // the organization (or the server) requires is asked for like at any sign-in. Should the sign-in
    // fail after this, the person signs in with the password just set.
    crate::db::commit(tx).await?;
    let user = SessionUser { id: user_id, email: found.email.clone(), name, is_server_admin: 0 };
    let first = crate::auth::second_factor::FirstStep::Password { password_hash: Some(&hash) };
    let plan = super::second_factor::plan(&state, &info, &user, first, now).await?;
    let mut tx = crate::db::begin(&state.db).await?;
    // The sign-in's lock, as in `auth::login`: the account must still be enabled and hold the
    // password just set, so one disabled (or changed) in between gets no session.
    let still_valid = sqlx::query(
        "UPDATE users SET password_hash = password_hash WHERE id = $1 AND password_hash = $2 AND disabled = 0",
    )
    .bind(&user.id)
    .bind(&hash)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if still_valid == 0 {
        return Err(ApiError::new(StatusCode::UNAUTHORIZED, "invalid_credentials", "the account cannot sign in"));
    }
    super::second_factor::finish_first_step(tx, &state, &info, &headers, user, first, false, plan, now).await
}

/// Forgets the sealed copies of expired links: they can no longer be copied, and a rotation of the
/// secrets key need not carry them.
pub async fn clear_expired_links(conn: &mut sqlx::AnyConnection, now: i64) -> ApiResult<()> {
    sqlx::query(
        "UPDATE invitations SET token_key_id = NULL, token_nonce = NULL, token_ciphertext = NULL \
         WHERE expires_at <= $1 AND token_key_id IS NOT NULL",
    )
    .bind(now)
    .execute(conn)
    .await?;
    Ok(())
}

/// The account with `email` when SCIM of an organization made it and nobody ever used it: no
/// password, no provider identity, unconfirmed, not a server admin or service account. Its address
/// was only the directory's word, so a mailed invitation's owner may take it over.
async fn scim_claimable(state: &AppState, email: &str) -> ApiResult<Option<String>> {
    let mut conn = state.db.acquire().await?;
    let ids = super::accounts_with_email(&mut conn, email).await?;
    let [id] = ids.as_slice() else { return Ok(None) };
    let row: Option<(i64,)> = sqlx::query_as(
        "SELECT 1 FROM users u WHERE u.id = $1 AND u.password_hash IS NULL AND u.email_confirmed = 0 \
         AND u.disabled = 0 AND u.is_server_admin = 0 AND u.service_account = 0 \
         AND NOT EXISTS (SELECT 1 FROM sso_identities i WHERE i.user_id = u.id) \
         AND EXISTS (SELECT 1 FROM scim_users s WHERE s.user_id = u.id AND s.created_account = 1)",
    )
    .bind(id)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(row.map(|_| id.clone()))
}

fn account_exists() -> ApiError {
    ApiError::new(StatusCode::CONFLICT, "conflict", "an account with this address exists; sign in to join")
        .because("mail.invite_account_exists")
}
