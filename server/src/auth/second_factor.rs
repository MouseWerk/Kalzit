//! The second factor of a sign-in: an authenticator app (`totp`), passkeys (`passkeys`) and
//! recovery codes (`recovery`), the policy that requires one, the lockout after wrong codes, the
//! half-signed-in state between the two steps of a sign-in, and fresh confirmations for changes
//! that weaken an account (docs/api/access.md, "Second factor").
//!
//! The half-signed-in state is a row of `sign_in_challenges`, named by a random token in its own
//! cookie (`kalzit_pending`, `__Host-kalzit_pending` over HTTPS). It is not a session: no route but
//! those of the second step reads it, so the API stays closed until the second factor passed. It
//! lives five minutes and is deleted by the request that completes it, in the transaction that
//! creates the session, so it signs in once.

use axum::http::{HeaderMap, HeaderValue};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::AnyPool;
use webauthn_rs::prelude::{PublicKeyCredential, SecurityKey};

use super::{passkeys, recovery, session, totp};
use crate::app::AppState;
use crate::authz::Permission;
use crate::error::{ApiError, ApiResult};
use crate::net::RequestInfo;
use crate::secrets::Blob;

/// How long the second step of a sign-in may take.
pub const CHALLENGE_TTL_MS: i64 = 5 * 60_000;
/// How long a fresh confirmation of the second factor allows changes that weaken the account.
pub const CONFIRMATION_TTL_MS: i64 = 5 * 60_000;
/// How long a started setup (app key shown, passkey dialog open) may take on the account page.
pub const CEREMONY_TTL_MS: i64 = 10 * 60_000;
/// Wrong codes (app or recovery) within `FAILURE_WINDOW_MS` before the second step of the account
/// is locked for `LOCKOUT_MS`, whatever device they came from. Passkeys cannot be guessed and are
/// not locked.
pub const MAX_FAILURES: i64 = 5;
pub const FAILURE_WINDOW_MS: i64 = 15 * 60_000;
pub const LOCKOUT_MS: i64 = 15 * 60_000;

pub const POLICY_KEY: &str = "security.two_factor_required";
pub const METHODS_KEY: &str = "security.two_factor_methods";

pub const PENDING_COOKIE: &str = "kalzit_pending";
/// The name over HTTPS (`session::SECURE_COOKIE_NAME` explains `__Host-`).
pub const SECURE_PENDING_COOKIE: &str = "__Host-kalzit_pending";

// ---------------------------------------------------------------------------------------------
// Policy

/// Who must have a second factor. Ordered from lax to strict, so the stricter of two is the max.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Requirement {
    Off,
    Admins,
    Everyone,
}

impl Requirement {
    /// A stored setting value. An organization's `inherit` adds nothing to the server's rule, and
    /// anything unknown counts as `Off` (the registry refuses such values anyway).
    pub fn parse(value: &Value) -> Self {
        match value.as_str() {
            Some("everyone") => Self::Everyone,
            Some("admins") => Self::Admins,
            _ => Self::Off,
        }
    }

    fn applies(self, admin: bool) -> bool {
        match self {
            Self::Off => false,
            Self::Admins => admin,
            Self::Everyone => true,
        }
    }
}

/// What requires the second factor of a person.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RequiredBy {
    Server,
    Org { id: String, name: String },
}

/// One membership as the policy sees it.
#[derive(Clone, Debug)]
pub struct MembershipRule {
    pub org_id: String,
    pub org_name: String,
    pub requirement: Requirement,
    /// The member administers this organization (`is_admin_role`).
    pub admin: bool,
}

/// Whether a second factor is required, and by what. The server's rule is the floor for every
/// organization; an organization can only add to it, so it is never laxer than the server.
/// "Admins" on the server means server admins and the administrators of any organization;
/// in an organization, its administrators.
pub fn resolve(server: Requirement, server_admin: bool, memberships: &[MembershipRule]) -> Option<RequiredBy> {
    let admin_anywhere = server_admin || memberships.iter().any(|m| m.admin);
    if server.applies(admin_anywhere) {
        return Some(RequiredBy::Server);
    }
    memberships
        .iter()
        .find(|m| m.requirement.applies(m.admin))
        .map(|m| RequiredBy::Org { id: m.org_id.clone(), name: m.org_name.clone() })
}

/// Whether `role` administers its organization: it may change members, roles or settings.
pub async fn is_admin_role<'c, E>(db: E, org_id: &str, role: &str) -> ApiResult<bool>
where
    E: sqlx::Executor<'c, Database = sqlx::Any>,
{
    let info = crate::authz::resolve_role(db, org_id, role).await?;
    Ok(info.is_some_and(|r| {
        [Permission::UsersWrite, Permission::RolesWrite, Permission::SettingsWrite]
            .iter()
            .any(|p| r.permissions.contains(p))
    }))
}

pub async fn server_requirement(state: &AppState) -> ApiResult<Requirement> {
    Ok(Requirement::parse(&crate::settings::get(state, POLICY_KEY).await?))
}

pub async fn org_requirement(state: &AppState, org_id: &str) -> ApiResult<Requirement> {
    Ok(Requirement::parse(&crate::settings::get_org(state, org_id, POLICY_KEY).await?))
}

/// The memberships of `user_id` with their rules, read through `db`.
pub async fn memberships(state: &AppState, db: &AnyPool, user_id: &str) -> ApiResult<Vec<MembershipRule>> {
    let rows: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT o.id, o.name, m.role FROM org_members m JOIN orgs o ON o.id = m.org_id WHERE m.user_id = $1 \
         ORDER BY o.name",
    )
    .bind(user_id)
    .fetch_all(db)
    .await?;
    let mut out = Vec::with_capacity(rows.len());
    for (org_id, org_name, role) in rows {
        let admin = is_admin_role(db, &org_id, &role).await?;
        let requirement = org_requirement(state, &org_id).await?;
        out.push(MembershipRule { org_id, org_name, requirement, admin });
    }
    Ok(out)
}

/// What requires a second factor of this person, if anything.
pub async fn required_for(state: &AppState, user_id: &str, server_admin: bool) -> ApiResult<Option<RequiredBy>> {
    let server = server_requirement(state).await?;
    let memberships = memberships(state, &state.db, user_id).await?;
    Ok(resolve(server, server_admin, &memberships))
}

/// What would require a second factor of this person once they join `org_id` with `role`
/// (a membership they already have stays as it is).
pub async fn required_after_joining(
    state: &AppState,
    user_id: &str,
    server_admin: bool,
    org_id: &str,
    org_name: &str,
    role: &str,
) -> ApiResult<Option<RequiredBy>> {
    let server = server_requirement(state).await?;
    let mut memberships = memberships(state, &state.db, user_id).await?;
    if !memberships.iter().any(|m| m.org_id == org_id) {
        memberships.push(MembershipRule {
            org_id: org_id.to_string(),
            org_name: org_name.to_string(),
            requirement: org_requirement(state, org_id).await?,
            admin: is_admin_role(&state.db, org_id, role).await?,
        });
    }
    Ok(resolve(server, server_admin, &memberships))
}

/// Which methods people may set up (`security.two_factor_methods`). Recovery codes always come
/// with them. A method turned off later keeps working for those who have it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Allowed {
    pub passkey: bool,
    pub totp: bool,
}

/// The methods that can be set up through this request. Passkeys need a host name
/// (`passkeys::relying_party`); where they cannot work (Kalzit opened by an IP address), the
/// authenticator app is offered instead even when the setting allows passkeys only, so a required
/// setup, the first owner's at first-run setup included, can never dead-end.
pub async fn allowed(state: &AppState, info: &RequestInfo) -> ApiResult<Allowed> {
    let value = crate::settings::get(state, METHODS_KEY).await?;
    let mut allowed = match value.as_str() {
        Some("passkey") => Allowed { passkey: true, totp: false },
        Some("totp") => Allowed { passkey: false, totp: true },
        _ => Allowed { passkey: true, totp: true },
    };
    if allowed.passkey && relying_party(state, info).await.is_err() {
        allowed = Allowed { passkey: false, totp: true };
    }
    Ok(allowed)
}

// ---------------------------------------------------------------------------------------------
// What an account has

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TotpInfo {
    pub created_at: i64,
    pub last_used_at: Option<i64>,
}

#[derive(Serialize, Clone, Debug, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct PasskeyInfo {
    pub id: String,
    pub name: String,
    pub created_at: i64,
    pub last_used_at: Option<i64>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryInfo {
    pub remaining: i64,
    pub total: i64,
    pub created_at: i64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Methods {
    pub totp: Option<TotpInfo>,
    pub passkeys: Vec<PasskeyInfo>,
    pub recovery_codes: Option<RecoveryInfo>,
}

impl Methods {
    /// Methods that count as a second factor; recovery codes only stand in for one.
    pub fn count(&self) -> usize {
        usize::from(self.totp.is_some()) + self.passkeys.len()
    }

    pub fn any(&self) -> bool {
        self.count() > 0
    }

    /// The methods for the second step, the most recently used first.
    pub fn for_prompt(&self) -> (Vec<&'static str>, Option<&'static str>) {
        let mut out = Vec::new();
        if !self.passkeys.is_empty() {
            out.push("passkey");
        }
        if self.totp.is_some() {
            out.push("totp");
        }
        if self.recovery_codes.as_ref().is_some_and(|r| r.remaining > 0) {
            out.push("recovery");
        }
        let passkey_used = self.passkeys.iter().filter_map(|p| p.last_used_at).max();
        let totp_used = self.totp.as_ref().and_then(|t| t.last_used_at);
        let last = match (passkey_used, totp_used) {
            (Some(p), Some(t)) => Some(if t > p { "totp" } else { "passkey" }),
            (Some(_), None) => Some("passkey"),
            (None, Some(_)) => Some("totp"),
            (None, None) => None,
        };
        (out, last)
    }
}

pub async fn methods<'c, E>(db: E, user_id: &str) -> ApiResult<Methods>
where
    E: sqlx::Executor<'c, Database = sqlx::Any> + Copy,
{
    let totp: Option<(i64, Option<i64>)> =
        sqlx::query_as("SELECT created_at, last_used_at FROM user_totp WHERE user_id = $1")
            .bind(user_id)
            .fetch_optional(db)
            .await?;
    let passkeys: Vec<PasskeyInfo> = sqlx::query_as(
        "SELECT id, name, created_at, last_used_at FROM user_passkeys WHERE user_id = $1 ORDER BY created_at, id",
    )
    .bind(user_id)
    .fetch_all(db)
    .await?;
    let codes: (i64, i64, Option<i64>) = sqlx::query_as(
        "SELECT COUNT(*), COALESCE(SUM(CASE WHEN used_at IS NULL THEN 1 ELSE 0 END), 0), MIN(created_at) \
         FROM user_recovery_codes WHERE user_id = $1",
    )
    .bind(user_id)
    .fetch_one(db)
    .await?;
    let recovery_codes = codes.2.map(|created_at| RecoveryInfo { remaining: codes.1, total: codes.0, created_at });
    Ok(Methods {
        totp: totp.map(|(created_at, last_used_at)| TotpInfo { created_at, last_used_at }),
        passkeys,
        recovery_codes,
    })
}

/// A person's second factor as lists of people show it.
#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    /// `passkey`, `totp`.
    pub methods: Vec<&'static str>,
    /// Wrong codes locked the second step until then.
    pub locked_until: Option<i64>,
    /// A second factor is required (here: by the server or the organization of the list).
    pub required: bool,
}

pub fn summary(totp_count: i64, passkey_count: i64, locked_until: Option<i64>, required: bool, now: i64) -> Summary {
    let mut methods = Vec::new();
    if passkey_count > 0 {
        methods.push("passkey");
    }
    if totp_count > 0 {
        methods.push("totp");
    }
    Summary { methods, locked_until: locked_until.filter(|t| *t > now), required }
}

// ---------------------------------------------------------------------------------------------
// Errors

pub fn invalid_code() -> ApiError {
    ApiError::new(axum::http::StatusCode::UNPROCESSABLE_ENTITY, "invalid_code", "the code is not correct")
}

fn locked(until: i64, now: i64) -> ApiError {
    let wait = std::time::Duration::from_millis(u64::try_from(until - now).unwrap_or(0));
    ApiError::rate_limited("too many wrong codes; the second step of this account is locked for a while", wait)
        .because("second_factor.locked")
        .param("until", until)
}

pub fn confirmation_required() -> ApiError {
    ApiError::new(
        axum::http::StatusCode::FORBIDDEN,
        "confirmation_required",
        "confirm with your second factor first (POST /me/security/confirm)",
    )
}

pub fn pending_expired() -> ApiError {
    ApiError::unauthenticated().because("second_factor.pending_expired")
}

// ---------------------------------------------------------------------------------------------
// Lockout

/// The end of the account's lockout, while it lasts.
pub async fn locked_until<'c, E>(db: E, user_id: &str, now: i64) -> ApiResult<Option<i64>>
where
    E: sqlx::Executor<'c, Database = sqlx::Any>,
{
    let row: Option<(i64,)> = sqlx::query_as("SELECT locked_until FROM second_factor_lockouts WHERE user_id = $1")
        .bind(user_id)
        .fetch_optional(db)
        .await?;
    Ok(row.map(|(t,)| t).filter(|t| *t > now))
}

/// Counts a code attempt before the code is checked, under the row's write lock, so parallel
/// guesses cannot all pass before the first failure is counted. Refused while the account is
/// locked, and when more attempts than the budget are under way at once.
async fn begin_attempt(state: &AppState, user_id: &str, now: i64) -> ApiResult<()> {
    let mut tx = crate::db::begin(&state.db).await?;
    sqlx::query(
        "INSERT INTO second_factor_lockouts (user_id, attempts, window_start, locked_until) VALUES ($1, 0, $2, 0) \
         ON CONFLICT (user_id) DO NOTHING",
    )
    .bind(user_id)
    .bind(now)
    .execute(&mut *tx)
    .await?;
    // An attempt older than the window no longer counts: the window starts again.
    sqlx::query(
        "UPDATE second_factor_lockouts SET \
         attempts = CASE WHEN window_start <= $2 THEN 1 ELSE attempts + 1 END, \
         window_start = CASE WHEN window_start <= $2 THEN $3 ELSE window_start END \
         WHERE user_id = $1 AND locked_until <= $3",
    )
    .bind(user_id)
    .bind(now - FAILURE_WINDOW_MS)
    .bind(now)
    .execute(&mut *tx)
    .await?;
    let (attempts, until): (i64, i64) =
        sqlx::query_as("SELECT attempts, locked_until FROM second_factor_lockouts WHERE user_id = $1")
            .bind(user_id)
            .fetch_one(&mut *tx)
            .await?;
    crate::db::commit(tx).await?;
    if until > now {
        return Err(locked(until, now));
    }
    if attempts > MAX_FAILURES {
        // More attempts at once than the budget: the extra ones are not checked.
        return Err(ApiError::rate_limited("too many attempts at once", std::time::Duration::from_secs(1))
            .because("second_factor.busy"));
    }
    Ok(())
}

/// A correct code: the attempts start over.
async fn attempt_succeeded(state: &AppState, user_id: &str) -> ApiResult<()> {
    sqlx::query("UPDATE second_factor_lockouts SET attempts = 0 WHERE user_id = $1")
        .bind(user_id)
        .execute(&state.db)
        .await?;
    Ok(())
}

/// A wrong code. The one that uses up the budget locks the account's second step and is audited.
/// Answers the error the request gets.
async fn attempt_failed(state: &AppState, info: &RequestInfo, user_id: &str, method: &str, now: i64) -> ApiError {
    match record_failure(state, info, user_id, method, now).await {
        Ok(Some(until)) => {
            notify(state, user_id, Notice::Locked);
            locked(until, now)
        }
        Ok(None) => invalid_code(),
        Err(e) => e,
    }
}

async fn record_failure(
    state: &AppState,
    info: &RequestInfo,
    user_id: &str,
    method: &str,
    now: i64,
) -> ApiResult<Option<i64>> {
    let mut tx = crate::db::begin(&state.db).await?;
    let until = now + LOCKOUT_MS;
    let locked_now = sqlx::query(
        "UPDATE second_factor_lockouts SET locked_until = $2, attempts = 0, window_start = $3 \
         WHERE user_id = $1 AND attempts >= $4 AND locked_until <= $3",
    )
    .bind(user_id)
    .bind(until)
    .bind(now)
    .bind(MAX_FAILURES)
    .execute(&mut *tx)
    .await?
    .rows_affected()
        > 0;
    let event = |action| crate::audit::AuditEvent {
        org_id: None,
        actor_user_id: Some(user_id),
        actor_address: Some(info.client_ip.to_string()),
        action,
        resource_type: Some("user"),
        resource_id: Some(user_id),
        summary: serde_json::json!({ "userId": user_id, "method": method }),
        at_ms: now,
    };
    crate::audit::record(&mut tx, &event("auth.second_factor_failed")).await?;
    if locked_now {
        let mut lock = event("auth.second_factor_locked");
        lock.summary = serde_json::json!({ "userId": user_id, "until": until });
        crate::audit::record(&mut tx, &lock).await?;
    }
    crate::db::commit(tx).await?;
    Ok(locked_now.then_some(until))
}

// ---------------------------------------------------------------------------------------------
// Ceremonies: what a started setup or passkey dialog keeps on the server until its answer

/// Whose ceremony: the half-signed-in state of a sign-in, or a session.
#[derive(Clone, Copy)]
pub enum Owner<'a> {
    Pending(&'a str),
    Session(&'a str),
}

impl Owner<'_> {
    fn table(&self) -> &'static str {
        match self {
            Owner::Pending(_) => "sign_in_challenges",
            Owner::Session(_) => "sessions",
        }
    }

    fn hash(&self) -> &str {
        match self {
            Owner::Pending(h) | Owner::Session(h) => h,
        }
    }
}

pub const CEREMONY_TOTP_SETUP: &str = "totp_setup";
pub const CEREMONY_PASSKEY_SETUP: &str = "passkey_setup";
pub const CEREMONY_PASSKEY_CHECK: &str = "passkey_check";

pub async fn store_ceremony(db: &AnyPool, owner: Owner<'_>, kind: &str, value: &str, expires_at: i64) -> ApiResult<()> {
    let sql = format!(
        "UPDATE {} SET ceremony_kind = $1, ceremony = $2, ceremony_expires_at = $3 WHERE token_hash = $4",
        owner.table()
    );
    sqlx::query(sqlx::AssertSqlSafe(sql))
        .bind(kind)
        .bind(value)
        .bind(expires_at)
        .bind(owner.hash())
        .execute(db)
        .await?;
    Ok(())
}

/// The ceremony of `kind`, if one is under way and not expired.
async fn peek_ceremony(db: &AnyPool, owner: Owner<'_>, kind: &str, now: i64) -> ApiResult<Option<String>> {
    let sql = format!(
        "SELECT ceremony FROM {} WHERE token_hash = $1 AND ceremony_kind = $2 AND ceremony_expires_at > $3",
        owner.table()
    );
    let row: Option<(Option<String>,)> =
        sqlx::query_as(sqlx::AssertSqlSafe(sql)).bind(owner.hash()).bind(kind).bind(now).fetch_optional(db).await?;
    Ok(row.and_then(|(c,)| c))
}

/// Takes the ceremony: of two requests with the same answer, one gets it.
async fn take_ceremony(db: &AnyPool, owner: Owner<'_>, kind: &str, now: i64) -> ApiResult<Option<String>> {
    let Some(value) = peek_ceremony(db, owner, kind, now).await? else { return Ok(None) };
    let sql = format!(
        "UPDATE {} SET ceremony_kind = NULL, ceremony = NULL, ceremony_expires_at = NULL \
         WHERE token_hash = $1 AND ceremony_kind = $2 AND ceremony = $3",
        owner.table()
    );
    let taken = sqlx::query(sqlx::AssertSqlSafe(sql))
        .bind(owner.hash())
        .bind(kind)
        .bind(&value)
        .execute(db)
        .await?
        .rows_affected();
    Ok((taken == 1).then_some(value))
}

// ---------------------------------------------------------------------------------------------
// The authenticator app

fn totp_owner(user_id: &str) -> String {
    format!("user:{user_id}")
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredBlob {
    key_id: String,
    nonce: String,
    ciphertext: String,
}

/// A new app key for `user_id`, kept encrypted with the ceremony until the first code confirms it.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TotpSetup {
    /// The key in groups of four, for typing by hand.
    pub secret: String,
    pub uri: String,
    pub qr: Option<totp::QrCode>,
    /// The issuer and account the app shows.
    pub issuer: String,
    pub account: String,
}

pub async fn start_totp(
    state: &AppState,
    info: &RequestInfo,
    owner: Owner<'_>,
    user_id: &str,
    email: &str,
    now: i64,
) -> ApiResult<TotpSetup> {
    let secret = totp::generate_secret();
    let encoded = totp::encode_secret(&secret);
    let blob = state.secrets.encrypt(&totp_owner(user_id), "totp-setup", &encoded);
    let stored =
        serde_json::to_string(&StoredBlob { key_id: blob.key_id, nonce: blob.nonce, ciphertext: blob.ciphertext })
            .map_err(|e| ApiError::internal("app setup", e))?;
    let expires = match owner {
        Owner::Pending(_) => now + CHALLENGE_TTL_MS,
        Owner::Session(_) => now + CEREMONY_TTL_MS,
    };
    store_ceremony(&state.db, owner, CEREMONY_TOTP_SETUP, &stored, expires).await?;
    let product = crate::settings::get(state, "appearance.product_name").await?;
    let product = product.as_str().filter(|p| !p.trim().is_empty()).unwrap_or("Kalzit").to_string();
    let host = state
        .config
        .server
        .public_url
        .as_deref()
        .and_then(|u| url::Url::parse(u).ok())
        .and_then(|u| u.host_str().map(str::to_string))
        .or_else(|| info.host.as_deref().map(|h| h.split(':').next().unwrap_or(h).to_string()));
    let issuer = match host {
        Some(host) => format!("{product} ({host})"),
        None => product,
    };
    let uri = totp::otpauth_uri(&issuer, email, &encoded);
    Ok(TotpSetup { secret: totp::grouped(&encoded), qr: totp::qr_code(&uri), uri, issuer, account: email.to_string() })
}

/// Checks the first code of a started app setup. On success the key is returned (the caller
/// stores it with `save_totp` in its transaction) with the step the code used, and the ceremony
/// is cleared; a wrong code leaves the setup open for another try.
pub async fn check_totp_setup(
    state: &AppState,
    info: &RequestInfo,
    owner: Owner<'_>,
    user_id: &str,
    code: &str,
    now: i64,
) -> ApiResult<(Vec<u8>, i64)> {
    let code = totp::normalize(code).ok_or_else(|| invalid_code().with_field("code"))?;
    let stored = peek_ceremony(&state.db, owner, CEREMONY_TOTP_SETUP, now)
        .await?
        .ok_or_else(|| ApiError::validation("start the app setup again").because("second_factor.setup_expired"))?;
    let blob: StoredBlob = serde_json::from_str(&stored).map_err(|e| ApiError::internal("app setup", e))?;
    let blob = Blob { key_id: blob.key_id, nonce: blob.nonce, ciphertext: blob.ciphertext };
    let encoded = state
        .secrets
        .decrypt(&totp_owner(user_id), "totp-setup", &blob)
        .map_err(|e| ApiError::internal("app setup", e))?;
    let secret = totp::decode_secret(&encoded).ok_or_else(|| ApiError::internal("app setup", "damaged key"))?;
    // Guessing the first code is limited like any other code.
    begin_attempt(state, user_id, now).await?;
    match totp::matching_step(&secret, &code, now, i64::MIN) {
        Some(step) => {
            attempt_succeeded(state, user_id).await?;
            take_ceremony(&state.db, owner, CEREMONY_TOTP_SETUP, now).await?;
            Ok((secret, step))
        }
        None => Err(match attempt_failed(state, info, user_id, "totp", now).await {
            e if e.code == "invalid_code" => e.with_field("code"),
            e => e,
        }),
    }
}

/// Stores the app key of `user_id`, replacing one it had.
pub async fn save_totp(
    conn: &mut sqlx::AnyConnection,
    state: &AppState,
    user_id: &str,
    secret: &[u8],
    used_step: i64,
    now: i64,
) -> ApiResult<()> {
    let blob = state.secrets.encrypt(&totp_owner(user_id), "totp", &totp::encode_secret(secret));
    sqlx::query("DELETE FROM user_totp WHERE user_id = $1").bind(user_id).execute(&mut *conn).await?;
    sqlx::query(
        "INSERT INTO user_totp (user_id, key_id, nonce, ciphertext, last_step, created_at, last_used_at) \
         VALUES ($1, $2, $3, $4, $5, $6, NULL)",
    )
    .bind(user_id)
    .bind(&blob.key_id)
    .bind(&blob.nonce)
    .bind(&blob.ciphertext)
    // The code that confirmed the key cannot sign in again.
    .bind(used_step)
    .bind(now)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// The owner and field the app keys are encrypted for, for `secrets::rotate`.
pub fn totp_secret_binding(user_id: &str) -> (String, &'static str) {
    (totp_owner(user_id), "totp")
}

async fn verify_totp(state: &AppState, info: &RequestInfo, user_id: &str, code: &str, now: i64) -> ApiResult<()> {
    let code = totp::normalize(code).ok_or_else(|| invalid_code().with_field("code"))?;
    let row: Option<(String, String, String, i64)> =
        sqlx::query_as("SELECT key_id, nonce, ciphertext, last_step FROM user_totp WHERE user_id = $1")
            .bind(user_id)
            .fetch_optional(&state.db)
            .await?;
    let Some((key_id, nonce, ciphertext, last_step)) = row else {
        return Err(ApiError::validation("no authenticator app is set up").because("second_factor.no_totp"));
    };
    begin_attempt(state, user_id, now).await?;
    let secret = state
        .secrets
        .decrypt(&totp_owner(user_id), "totp", &Blob { key_id, nonce, ciphertext })
        .map_err(|e| ApiError::internal("reading the app key", e))?;
    let secret = totp::decode_secret(&secret).ok_or_else(|| ApiError::internal("reading the app key", "damaged"))?;
    if let Some(step) = totp::matching_step(&secret, &code, now, last_step) {
        // Each step once: of two requests with the same code, the second finds the step used.
        let used =
            sqlx::query("UPDATE user_totp SET last_step = $2, last_used_at = $3 WHERE user_id = $1 AND last_step < $2")
                .bind(user_id)
                .bind(step)
                .bind(now)
                .execute(&state.db)
                .await?
                .rows_affected();
        if used == 1 {
            attempt_succeeded(state, user_id).await?;
            return Ok(());
        }
    }
    Err(attempt_failed(state, info, user_id, "totp", now).await)
}

// ---------------------------------------------------------------------------------------------
// Recovery codes

/// Replaces the account's recovery codes with a new set; answers them for display, once.
pub async fn new_recovery_codes(conn: &mut sqlx::AnyConnection, user_id: &str, now: i64) -> ApiResult<Vec<String>> {
    sqlx::query("DELETE FROM user_recovery_codes WHERE user_id = $1").bind(user_id).execute(&mut *conn).await?;
    let codes = recovery::generate();
    for code in &codes {
        let plain = recovery::normalize(code).expect("generated codes are valid");
        sqlx::query(
            "INSERT INTO user_recovery_codes (user_id, code_hash, created_at, used_at) VALUES ($1, $2, $3, NULL)",
        )
        .bind(user_id)
        .bind(recovery::hash(user_id, &plain))
        .bind(now)
        .execute(&mut *conn)
        .await?;
    }
    Ok(codes)
}

/// Uses one recovery code; answers how many remain.
async fn verify_recovery(state: &AppState, info: &RequestInfo, user_id: &str, code: &str, now: i64) -> ApiResult<i64> {
    let plain = recovery::normalize(code).ok_or_else(|| invalid_code().with_field("code"))?;
    begin_attempt(state, user_id, now).await?;
    let stored: Vec<(String,)> =
        sqlx::query_as("SELECT code_hash FROM user_recovery_codes WHERE user_id = $1 AND used_at IS NULL")
            .bind(user_id)
            .fetch_all(&state.db)
            .await?;
    let stored: Vec<String> = stored.into_iter().map(|(h,)| h).collect();
    let candidate = recovery::hash(user_id, &plain);
    if let Some(hash) = recovery::find(&stored, &candidate) {
        let mut tx = crate::db::begin(&state.db).await?;
        // Single use: of two requests with the same code, the second finds it used.
        let used = sqlx::query(
            "UPDATE user_recovery_codes SET used_at = $3 WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL",
        )
        .bind(user_id)
        .bind(hash)
        .bind(now)
        .execute(&mut *tx)
        .await?
        .rows_affected();
        if used == 1 {
            let (remaining,): (i64,) =
                sqlx::query_as("SELECT COUNT(*) FROM user_recovery_codes WHERE user_id = $1 AND used_at IS NULL")
                    .bind(user_id)
                    .fetch_one(&mut *tx)
                    .await?;
            let event = crate::audit::AuditEvent {
                org_id: None,
                actor_user_id: Some(user_id),
                actor_address: Some(info.client_ip.to_string()),
                action: "auth.recovery_code_used",
                resource_type: Some("user"),
                resource_id: Some(user_id),
                summary: serde_json::json!({ "userId": user_id, "remaining": remaining }),
                at_ms: now,
            };
            crate::audit::record(&mut tx, &event).await?;
            crate::db::commit(tx).await?;
            attempt_succeeded(state, user_id).await?;
            notify(state, user_id, Notice::RecoveryCodeUsed);
            return Ok(remaining);
        }
    }
    Err(attempt_failed(state, info, user_id, "recovery", now).await)
}

// ---------------------------------------------------------------------------------------------
// Passkeys

/// The relying party of this request (`passkeys::relying_party`), named after the product.
pub async fn relying_party(state: &AppState, info: &RequestInfo) -> ApiResult<webauthn_rs::prelude::Webauthn> {
    let product = crate::settings::get(state, "appearance.product_name").await?;
    let name = product.as_str().filter(|p| !p.trim().is_empty()).unwrap_or("Kalzit").to_string();
    passkeys::relying_party(state.config.server.public_url.as_deref(), info, &name)
}

/// The stored passkeys of `user_id`: row id and key.
pub async fn stored_passkeys<'c, E>(db: E, user_id: &str) -> ApiResult<Vec<(String, SecurityKey)>>
where
    E: sqlx::Executor<'c, Database = sqlx::Any>,
{
    let rows: Vec<(String, String)> =
        sqlx::query_as("SELECT id, credential FROM user_passkeys WHERE user_id = $1 ORDER BY created_at, id")
            .bind(user_id)
            .fetch_all(db)
            .await?;
    rows.into_iter()
        .map(|(id, json)| {
            serde_json::from_str::<SecurityKey>(&json).map(|k| (id, k)).map_err(|e| ApiError::internal("passkey", e))
        })
        .collect()
}

/// Options for the browser's passkey dialog to confirm with one of the account's passkeys.
pub async fn start_passkey_check(
    state: &AppState,
    info: &RequestInfo,
    owner: Owner<'_>,
    user_id: &str,
    now: i64,
) -> ApiResult<Value> {
    let keys: Vec<SecurityKey> = stored_passkeys(&state.db, user_id).await?.into_iter().map(|(_, k)| k).collect();
    if keys.is_empty() {
        return Err(ApiError::validation("no passkey is set up").because("second_factor.no_passkey"));
    }
    let rp = relying_party(state, info).await?;
    let (options, ceremony) = passkeys::start_authentication(&rp, &keys)?;
    let stored = serde_json::to_string(&ceremony).map_err(|e| ApiError::internal("passkey sign-in", e))?;
    let expires = match owner {
        Owner::Pending(_) => now + CHALLENGE_TTL_MS,
        Owner::Session(_) => now + CEREMONY_TTL_MS,
    };
    store_ceremony(&state.db, owner, CEREMONY_PASSKEY_CHECK, &stored, expires).await?;
    serde_json::to_value(options).map_err(|e| ApiError::internal("passkey sign-in", e))
}

/// The sign counter of a stored passkey (webauthn-rs keeps it as `cred.counter`).
fn stored_counter(json: &str) -> u32 {
    serde_json::from_str::<Value>(json)
        .ok()
        .and_then(|v| v["cred"]["counter"].as_u64())
        .and_then(|n| u32::try_from(n).ok())
        .unwrap_or(0)
}

/// Whether an assertion's counter may follow the stored one. Authenticators without a counter
/// (synced passkeys) always send 0; once either side counts, the new value must be greater.
fn counter_advances(stored: u32, new: u32) -> bool {
    (stored == 0 && new == 0) || new > stored
}

fn passkey_refused() -> ApiError {
    invalid_code().because("second_factor.passkey_refused")
}

async fn verify_passkey(
    state: &AppState,
    info: &RequestInfo,
    owner: Owner<'_>,
    user_id: &str,
    answer: &PublicKeyCredential,
    now: i64,
) -> ApiResult<()> {
    // The started dialog is used up by this answer, right or wrong.
    let Some(stored) = take_ceremony(&state.db, owner, CEREMONY_PASSKEY_CHECK, now).await? else {
        return Err(passkey_refused());
    };
    let ceremony = serde_json::from_str(&stored).map_err(|e| ApiError::internal("passkey sign-in", e))?;
    let rp = relying_party(state, info).await?;
    let Some(result) = passkeys::finish_authentication(&rp, answer, &ceremony) else {
        return Err(passkey_refused());
    };
    let wanted = passkeys::credential_key(result.cred_id());
    let mut tx = crate::db::begin(&state.db).await?;
    // The passkey's row is locked before it is read, so two sign-ins with it at once run one after
    // the other and each compares its counter with what the other stored.
    sqlx::query("UPDATE user_passkeys SET last_used_at = last_used_at WHERE user_id = $1 AND credential_id = $2")
        .bind(user_id)
        .bind(&wanted)
        .execute(&mut *tx)
        .await?;
    let row: Option<(String, String)> =
        sqlx::query_as("SELECT id, credential FROM user_passkeys WHERE user_id = $1 AND credential_id = $2")
            .bind(user_id)
            .bind(&wanted)
            .fetch_optional(&mut *tx)
            .await?;
    let Some((id, json)) = row else { return Err(passkey_refused()) };
    let mut key: SecurityKey = serde_json::from_str(&json).map_err(|e| ApiError::internal("passkey", e))?;
    // The counter as stored now, not as the dialog's start saw it: a counter that does not go
    // beyond it (a replay, a cloned authenticator, or a sign-in that raced this one) is refused, and
    // the stored counter never moves back.
    if !counter_advances(stored_counter(&json), result.counter()) {
        return Err(passkey_refused());
    }
    key.update_credential(&result);
    let json = serde_json::to_string(&key).map_err(|e| ApiError::internal("passkey", e))?;
    sqlx::query("UPDATE user_passkeys SET credential = $1, last_used_at = $2 WHERE id = $3")
        .bind(&json)
        .bind(now)
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    crate::db::commit(tx).await?;
    Ok(())
}

/// Options for the browser's dialog that creates a passkey, for `user_id`.
pub async fn start_passkey_setup(
    state: &AppState,
    info: &RequestInfo,
    owner: Owner<'_>,
    user: &session::SessionUser,
    now: i64,
) -> ApiResult<Value> {
    let existing: Vec<SecurityKey> = stored_passkeys(&state.db, &user.id).await?.into_iter().map(|(_, k)| k).collect();
    let rp = relying_party(state, info).await?;
    let (options, ceremony) = passkeys::start_registration(&rp, &user.id, &user.email, &user.name, &existing)?;
    let stored = serde_json::to_string(&ceremony).map_err(|e| ApiError::internal("passkey setup", e))?;
    let expires = match owner {
        Owner::Pending(_) => now + CHALLENGE_TTL_MS,
        Owner::Session(_) => now + CEREMONY_TTL_MS,
    };
    store_ceremony(&state.db, owner, CEREMONY_PASSKEY_SETUP, &stored, expires).await?;
    serde_json::to_value(options).map_err(|e| ApiError::internal("passkey setup", e))
}

/// Checks the browser's answer to a started passkey setup; the caller stores the key with
/// `save_passkey`.
pub async fn finish_passkey_setup(
    state: &AppState,
    info: &RequestInfo,
    owner: Owner<'_>,
    answer: &webauthn_rs::prelude::RegisterPublicKeyCredential,
    now: i64,
) -> ApiResult<SecurityKey> {
    let Some(stored) = take_ceremony(&state.db, owner, CEREMONY_PASSKEY_SETUP, now).await? else {
        return Err(ApiError::validation("start adding the passkey again").because("second_factor.setup_expired"));
    };
    let ceremony = serde_json::from_str(&stored).map_err(|e| ApiError::internal("passkey setup", e))?;
    let rp = relying_party(state, info).await?;
    passkeys::finish_registration(&rp, answer, &ceremony)
}

pub const MAX_PASSKEY_NAME_CHARS: usize = 60;

pub fn clean_passkey_name(raw: Option<&str>) -> ApiResult<String> {
    let name = raw.map(str::trim).unwrap_or_default();
    if name.is_empty() {
        return Ok("Passkey".to_string());
    }
    if name.chars().count() > MAX_PASSKEY_NAME_CHARS || name.chars().any(char::is_control) {
        return Err(ApiError::validation(format!("a passkey name has at most {MAX_PASSKEY_NAME_CHARS} characters"))
            .with_field("name"));
    }
    Ok(name.to_string())
}

/// Stores a new passkey of `user_id`; answers its id. A passkey already stored (here or for
/// another account) is a conflict.
pub async fn save_passkey(
    conn: &mut sqlx::AnyConnection,
    user_id: &str,
    name: &str,
    key: &SecurityKey,
    now: i64,
) -> ApiResult<String> {
    let id = crate::routes::new_id();
    let json = serde_json::to_string(key).map_err(|e| ApiError::internal("passkey", e))?;
    sqlx::query(
        "INSERT INTO user_passkeys (id, user_id, credential_id, name, credential, created_at, last_used_at) \
         VALUES ($1, $2, $3, $4, $5, $6, NULL)",
    )
    .bind(&id)
    .bind(user_id)
    .bind(passkeys::credential_key(key.cred_id()))
    .bind(name)
    .bind(&json)
    .bind(now)
    .execute(&mut *conn)
    .await
    .map_err(|e| {
        if crate::routes::support::is_unique_violation(&e) {
            crate::routes::support::conflict("this passkey is already registered")
                .because("second_factor.passkey_known")
        } else {
            e.into()
        }
    })?;
    Ok(id)
}

// ---------------------------------------------------------------------------------------------
// Checking a factor

/// A second factor as the requests of the second step and of confirmations send it.
#[derive(Deserialize)]
#[serde(tag = "method", rename_all = "camelCase", deny_unknown_fields)]
pub enum Proof {
    Totp { code: String },
    Recovery { code: String },
    Passkey { credential: Box<PublicKeyCredential> },
}

/// What a checked factor was.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Verified {
    Totp,
    Passkey,
    Recovery { remaining: i64 },
}

impl Verified {
    pub fn method(self) -> &'static str {
        match self {
            Verified::Totp => "totp",
            Verified::Passkey => "passkey",
            Verified::Recovery { .. } => "recovery",
        }
    }
}

/// Checks a factor of `user_id`. Codes count against the account's lockout (and the address's
/// sign-in budget, which a correct code gives back); passkeys are checked against the dialog
/// `owner` started.
pub async fn verify(
    state: &AppState,
    info: &RequestInfo,
    owner: Owner<'_>,
    user_id: &str,
    proof: &Proof,
    now: i64,
) -> ApiResult<Verified> {
    if let Proof::Passkey { credential } = proof {
        verify_passkey(state, info, owner, user_id, credential, now).await?;
        return Ok(Verified::Passkey);
    }
    // On top of the lockout of the account: the address's budget of failed sign-ins.
    use super::ratelimit::{address_key, network_key};
    let ip_key = address_key("login", info.client_ip);
    let network = network_key(info.client_ip);
    let mono = state.clock.monotonic_ms();
    let counted = state
        .login_limiter
        .try_acquire(&ip_key, &network, mono)
        .map_err(|wait| ApiError::rate_limited("too many failed sign-ins, wait a few minutes", wait))?;
    let result = match proof {
        Proof::Totp { code } => verify_totp(state, info, user_id, code, now).await.map(|()| Verified::Totp),
        Proof::Recovery { code } => {
            verify_recovery(state, info, user_id, code, now).await.map(|remaining| Verified::Recovery { remaining })
        }
        Proof::Passkey { .. } => unreachable!("handled above"),
    };
    // Only wrong codes use the budget up; a refusal before the check (a lockout, a code that
    // cannot be one) and a correct code give the attempt back.
    if !matches!(&result, Err(e) if e.code == "invalid_code" && e.field.is_none()) {
        state.login_limiter.refund(&ip_key, &counted);
    }
    result
}

// ---------------------------------------------------------------------------------------------
// Fresh confirmation of a session

/// Records that this session just confirmed the second factor.
pub async fn mark_confirmed<'c, E>(db: E, session_hash: &str, now: i64) -> ApiResult<()>
where
    E: sqlx::Executor<'c, Database = sqlx::Any>,
{
    sqlx::query("UPDATE sessions SET second_factor_at = $1 WHERE token_hash = $2")
        .bind(now)
        .bind(session_hash)
        .execute(db)
        .await?;
    Ok(())
}

/// Until when the session's last confirmation allows weakening changes.
pub async fn confirmed_until<'c, E>(db: E, session_hash: &str, now: i64) -> ApiResult<Option<i64>>
where
    E: sqlx::Executor<'c, Database = sqlx::Any>,
{
    let row: Option<(Option<i64>,)> = sqlx::query_as("SELECT second_factor_at FROM sessions WHERE token_hash = $1")
        .bind(session_hash)
        .fetch_optional(db)
        .await?;
    Ok(row.and_then(|(at,)| at).map(|at| at + CONFIRMATION_TTL_MS).filter(|until| *until > now))
}

/// Refuses with `confirmation_required` unless the session confirmed its second factor within
/// `CONFIRMATION_TTL_MS`.
pub async fn require_fresh<'c, E>(db: E, session_hash: &str, now: i64) -> ApiResult<()>
where
    E: sqlx::Executor<'c, Database = sqlx::Any>,
{
    match confirmed_until(db, session_hash, now).await? {
        Some(_) => Ok(()),
        None => Err(confirmation_required()),
    }
}

/// Changing who must have a second factor, or which methods people may set up, weakens or
/// strengthens every account at once: an admin who has a second factor confirms it first, within
/// `CONFIRMATION_TTL_MS`, as for their own weakening changes. Other settings pass.
pub async fn require_fresh_for_setting(
    state: &AppState,
    user_id: &str,
    headers: &HeaderMap,
    secure: bool,
    key: &str,
    now: i64,
) -> ApiResult<()> {
    if key != POLICY_KEY && key != METHODS_KEY {
        return Ok(());
    }
    if !methods(&state.db, user_id).await?.any() {
        return Ok(());
    }
    let token = session::read_cookie(headers, secure).ok_or_else(ApiError::unauthenticated)?;
    require_fresh(&state.db, &session::hash_token(&token), now).await
}

// ---------------------------------------------------------------------------------------------
// The half-signed-in state

/// How the person passed the first step of the sign-in. The hook for sign-ins through an identity
/// provider (OIDC, SAML): a provider may say it checked a second factor itself, and Kalzit then
/// takes its word only when the provider's own switch says so (`provider_mfa_trusted`); by
/// default Kalzit asks for its own second factor. LDAP always uses Kalzit's second factor.
#[derive(Clone, Copy, Debug)]
pub enum FirstStep<'a> {
    /// A local password; its hash binds the half-signed-in state, so a password changed meanwhile
    /// ends it. `break_glass` marks the break-glass admin's sign-in while password sign-in is off
    /// (docs/api/sso.md), which the recorded sign-in names.
    Password { password_hash: Option<&'a str>, break_glass: bool },
    /// A directory password (LDAP) of the directory `provider_id`: always Kalzit's second factor.
    /// `sync_run` is the run of the directory sync that disabled the account, when it did: the
    /// account is enabled only when the second step succeeds and that very record still stands
    /// (`take_pending`).
    Directory { provider_id: &'a str, sync_run: Option<&'a str> },
    /// An identity provider. `mfa_done` is the provider's claim (such as OIDC `amr`) and
    /// `provider_mfa_trusted` the provider's switch in Kalzit, off by default.
    Provider { provider_id: &'a str, mfa_done: bool, provider_mfa_trusted: bool },
}

impl FirstStep<'_> {
    /// Whether Kalzit asks for its own second factor after this first step.
    pub fn asks_second_factor(&self) -> bool {
        !matches!(self, FirstStep::Provider { mfa_done: true, provider_mfa_trusted: true, .. })
    }

    fn sync_run(&self) -> Option<&str> {
        match self {
            FirstStep::Directory { sync_run, .. } => *sync_run,
            _ => None,
        }
    }

    fn password_hash(&self) -> Option<&str> {
        match self {
            FirstStep::Password { password_hash, .. } => *password_hash,
            _ => None,
        }
    }

    /// The directory or identity provider of this first step.
    pub fn provider_id(&self) -> Option<&str> {
        match self {
            FirstStep::Directory { provider_id, .. } | FirstStep::Provider { provider_id, .. } => Some(provider_id),
            FirstStep::Password { .. } => None,
        }
    }

    fn break_glass(&self) -> bool {
        matches!(self, FirstStep::Password { break_glass: true, .. })
    }

    /// How the sign-in recorded for this first step names it (`auth::sign_ins`).
    pub fn via(&self) -> crate::auth::sign_ins::Via {
        crate::auth::sign_ins::Via {
            first_step: self.label().to_string(),
            break_glass: self.break_glass(),
            provider_id: self.provider_id().map(str::to_string),
            provider_mfa: matches!(self, FirstStep::Provider { mfa_done: true, provider_mfa_trusted: true, .. }),
        }
    }

    pub fn label(&self) -> &'static str {
        match self {
            FirstStep::Password { .. } => "password",
            FirstStep::Directory { .. } => "directory",
            FirstStep::Provider { .. } => "provider",
        }
    }
}

/// What the second step needs: answered by `POST /auth/login` (as `secondFactor`) and by
/// `GET /auth/second-factor`.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Prompt {
    pub email: String,
    /// The account has no second factor and must set one up before it is signed in.
    pub setup: bool,
    /// The methods the account can use now (`passkey`, `totp`, `recovery`), the last used first
    /// among passkey and app.
    pub methods: Vec<&'static str>,
    pub last_used: Option<&'static str>,
    /// Methods the account may set up.
    pub allowed: Allowed,
    pub required_by: Option<RequiredBy>,
    pub locked_until: Option<i64>,
    pub expires_at: i64,
}

/// The second step a person still has to take after the first, if any.
pub async fn second_step(
    state: &AppState,
    user_id: &str,
    server_admin: bool,
    first: FirstStep<'_>,
) -> ApiResult<Option<(bool, Option<RequiredBy>)>> {
    if !first.asks_second_factor() {
        return Ok(None);
    }
    let has = methods(&state.db, user_id).await?;
    let required = required_for(state, user_id, server_admin).await?;
    if has.any() {
        Ok(Some((false, required)))
    } else if required.is_some() {
        Ok(Some((true, required)))
    } else {
        Ok(None)
    }
}

/// The half-signed-in state as stored.
#[derive(Clone, Debug, sqlx::FromRow)]
pub struct Pending {
    pub token_hash: String,
    pub user_id: String,
    pub email: String,
    pub name: String,
    pub is_server_admin: i64,
    pub setup: i64,
    pub forget_browser: i64,
    pub password_fingerprint: Option<String>,
    pub expires_at: i64,
}

impl Pending {
    pub fn owner(&self) -> Owner<'_> {
        Owner::Pending(&self.token_hash)
    }

    pub fn user(&self) -> session::SessionUser {
        session::SessionUser {
            id: self.user_id.clone(),
            email: self.email.clone(),
            name: self.name.clone(),
            is_server_admin: self.is_server_admin,
        }
    }
}

/// A fingerprint of a password hash, so the state notices a password changed meanwhile without
/// keeping a copy of the hash.
pub fn password_fingerprint(hash: Option<&str>) -> Option<String> {
    use sha2::Digest;
    hash.map(|h| hex::encode(sha2::Sha256::digest(format!("kalzit-pending\0{h}").as_bytes())))
}

/// Starts the second step for `user_id`; answers the token for the cookie.
pub async fn create_pending(
    conn: &mut sqlx::AnyConnection,
    user_id: &str,
    setup: bool,
    forget_browser: bool,
    first: FirstStep<'_>,
    now: i64,
) -> ApiResult<String> {
    let token = hex::encode(rand::random::<[u8; 32]>());
    sqlx::query(
        "INSERT INTO sign_in_challenges (token_hash, user_id, setup, forget_browser, first_step, password_fingerprint, \
         created_at, expires_at, ldap_sync_run, provider_id, break_glass) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)",
    )
    .bind(session::hash_token(&token))
    .bind(user_id)
    .bind(i64::from(setup))
    .bind(i64::from(forget_browser))
    .bind(first.label())
    .bind(password_fingerprint(first.password_hash()))
    .bind(now)
    .bind(now + CHALLENGE_TTL_MS)
    .bind(first.sync_run())
    .bind(first.provider_id())
    .bind(i64::from(first.break_glass()))
    .execute(conn)
    .await?;
    Ok(token)
}

/// The half-signed-in state of the request, unless it expired or its account was disabled.
pub async fn load_pending(db: &AnyPool, headers: &HeaderMap, secure: bool, now: i64) -> ApiResult<Option<Pending>> {
    let Some(token) = read_pending_cookie(headers, secure) else { return Ok(None) };
    let pending: Option<Pending> = sqlx::query_as(
        "SELECT c.token_hash, c.user_id, u.email, u.name, u.is_server_admin, c.setup, c.forget_browser, \
         c.password_fingerprint, c.expires_at FROM sign_in_challenges c JOIN users u ON u.id = c.user_id \
         WHERE c.token_hash = $1 AND (u.disabled = 0 OR (c.first_step = 'directory' AND EXISTS \
         (SELECT 1 FROM ldap_deactivations d WHERE d.user_id = u.id AND d.run_id = c.ldap_sync_run)))",
    )
    .bind(session::hash_token(&token))
    .fetch_optional(db)
    .await?;
    Ok(pending.filter(|p| p.expires_at > now))
}

/// The account as the completed second step found it.
pub struct Taken {
    /// The current password hash, for the device cookie.
    pub password_hash: Option<String>,
    pub first_step: String,
    /// The directory or identity provider of the first step.
    pub provider_id: Option<String>,
    /// The first step was the break-glass admin's password.
    pub break_glass: bool,
}

impl Taken {
    /// How the recorded sign-in names the first step (`auth::sign_ins`).
    pub fn via(&self) -> crate::auth::sign_ins::Via {
        crate::auth::sign_ins::Via {
            first_step: self.first_step.clone(),
            break_glass: self.break_glass,
            provider_id: self.provider_id.clone(),
            provider_mfa: false,
        }
    }
}

/// Ends the half-signed-in state for good, inside the transaction that signs the person in;
/// `None` when another request took it first or the account changed meanwhile (disabled, a new
/// password).
pub async fn take_pending(conn: &mut sqlx::AnyConnection, pending: &Pending, now: i64) -> ApiResult<Option<Taken>> {
    let first: Option<(String, Option<String>, Option<String>, i64)> = sqlx::query_as(
        "SELECT first_step, ldap_sync_run, provider_id, break_glass FROM sign_in_challenges \
         WHERE token_hash = $1 AND expires_at > $2",
    )
    .bind(&pending.token_hash)
    .bind(now)
    .fetch_optional(&mut *conn)
    .await?;
    let taken = sqlx::query("DELETE FROM sign_in_challenges WHERE token_hash = $1 AND expires_at > $2")
        .bind(&pending.token_hash)
        .bind(now)
        .execute(&mut *conn)
        .await?
        .rows_affected();
    let Some((first_step, sync_run, provider_id, break_glass)) = first.filter(|_| taken == 1) else {
        return Ok(None);
    };
    // Under the user row's lock, as a sign-in with a password takes it (`routes::auth::login`): a
    // password change or a disable that raced this either is seen here or ends the new session.
    sqlx::query("UPDATE users SET disabled = disabled WHERE id = $1")
        .bind(&pending.user_id)
        .execute(&mut *conn)
        .await?;
    let row: Option<(Option<String>, i64)> = sqlx::query_as("SELECT password_hash, disabled FROM users WHERE id = $1")
        .bind(&pending.user_id)
        .fetch_optional(&mut *conn)
        .await?;
    let Some((password_hash, mut disabled)) = row else { return Ok(None) };
    let same_password = match &pending.password_fingerprint {
        Some(fingerprint) => password_fingerprint(password_hash.as_deref()).as_deref() == Some(fingerprint.as_str()),
        None => true,
    };
    // A directory confirmed an account its sync had disabled (`sso::directory::finish`): it is
    // enabled now that the second step succeeded too, never before, and only when the sync's
    // record the first step saw still stands. An account disabled after the first step (by the
    // sync or an admin) stays disabled.
    if disabled != 0
        && first_step == "directory"
        && same_password
        && let Some(run) = &sync_run
        && crate::sso::directory::enable_sync_disabled(conn, None, &pending.user_id, run, now).await?
    {
        disabled = 0;
    }
    Ok((disabled == 0 && same_password).then_some(Taken {
        password_hash,
        first_step,
        provider_id,
        break_glass: break_glass != 0,
    }))
}

pub async fn prompt(
    state: &AppState,
    info: &RequestInfo,
    pending: &Pending,
    required_by: Option<RequiredBy>,
    now: i64,
) -> ApiResult<Prompt> {
    let has = methods(&state.db, &pending.user_id).await?;
    let (methods, last_used) = has.for_prompt();
    Ok(Prompt {
        email: pending.email.clone(),
        setup: pending.setup != 0,
        methods,
        last_used,
        allowed: allowed(state, info).await?,
        required_by,
        locked_until: locked_until(&state.db, &pending.user_id, now).await?,
        expires_at: pending.expires_at,
    })
}

fn pending_cookie_name(secure: bool) -> &'static str {
    if secure { SECURE_PENDING_COOKIE } else { PENDING_COOKIE }
}

pub fn read_pending_cookie(headers: &HeaderMap, secure: bool) -> Option<String> {
    session::cookie_value(headers, pending_cookie_name(secure))
}

pub fn set_pending_cookie(token: &str, secure: bool) -> HeaderValue {
    let max_age = CHALLENGE_TTL_MS / 1000;
    session::cookie_header(&format!("{}={token}; Max-Age={max_age}", pending_cookie_name(secure)), secure)
}

pub fn clear_pending_cookie(secure: bool) -> HeaderValue {
    session::cookie_header(&format!("{}=; Max-Age=0", pending_cookie_name(secure)), secure)
}

// ---------------------------------------------------------------------------------------------
// Removing

/// What a reset removed.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Removed {
    pub totp: bool,
    pub passkeys: i64,
    pub recovery_codes: i64,
}

/// Removes every second factor of `user_id` (an admin's reset): app, passkeys, recovery codes,
/// the lockout and any half-signed-in state.
pub async fn remove_all(conn: &mut sqlx::AnyConnection, user_id: &str) -> ApiResult<Removed> {
    let count = |table: &str| format!("SELECT COUNT(*) FROM {table} WHERE user_id = $1");
    let (totp,): (i64,) =
        sqlx::query_as(sqlx::AssertSqlSafe(count("user_totp"))).bind(user_id).fetch_one(&mut *conn).await?;
    let (passkeys,): (i64,) =
        sqlx::query_as(sqlx::AssertSqlSafe(count("user_passkeys"))).bind(user_id).fetch_one(&mut *conn).await?;
    let (recovery_codes,): (i64,) =
        sqlx::query_as(sqlx::AssertSqlSafe(format!("{} AND used_at IS NULL", count("user_recovery_codes"))))
            .bind(user_id)
            .fetch_one(&mut *conn)
            .await?;
    let before = Removed { totp: totp > 0, passkeys, recovery_codes };
    for table in ["user_totp", "user_passkeys", "user_recovery_codes", "second_factor_lockouts", "sign_in_challenges"] {
        sqlx::query(sqlx::AssertSqlSafe(format!("DELETE FROM {table} WHERE user_id = $1")))
            .bind(user_id)
            .execute(&mut *conn)
            .await?;
    }
    Ok(before)
}

// ---------------------------------------------------------------------------------------------
// Mail to the person

/// What the person is told by mail.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Notice {
    Locked,
    RecoveryCodeUsed,
    Changed,
    Reset,
}

/// Tells the person about a change of their second factor by mail, when the server can send
/// mail (`mail::notify_second_factor`); without a mail server nothing is sent and the audit log is
/// the record.
pub fn notify(state: &AppState, user_id: &str, notice: Notice) {
    crate::mail::notify_second_factor(state, user_id, notice);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn org(id: &str, requirement: Requirement, admin: bool) -> MembershipRule {
        MembershipRule { org_id: id.into(), org_name: id.to_uppercase(), requirement, admin }
    }

    #[test]
    fn the_server_rule_is_the_floor_and_organizations_only_add() {
        use Requirement::*;
        // Off everywhere: nothing.
        assert_eq!(resolve(Off, false, &[org("a", Off, true)]), None);
        // The server for everyone: an organization that "inherits" cannot lift it.
        assert_eq!(resolve(Everyone, false, &[org("a", Off, false)]), Some(RequiredBy::Server));
        // The server for admins: server admins and organization admins, nobody else.
        assert_eq!(resolve(Admins, true, &[]), Some(RequiredBy::Server));
        assert_eq!(resolve(Admins, false, &[org("a", Off, true)]), Some(RequiredBy::Server));
        assert_eq!(resolve(Admins, false, &[org("a", Off, false)]), None);
        // An organization stricter than the server: its members, or its admins.
        let required = resolve(Off, false, &[org("a", Off, false), org("b", Everyone, false)]);
        assert_eq!(required, Some(RequiredBy::Org { id: "b".into(), name: "B".into() }));
        assert_eq!(resolve(Off, false, &[org("a", Admins, false)]), None);
        assert_eq!(
            resolve(Off, false, &[org("a", Admins, true)]),
            Some(RequiredBy::Org { id: "a".into(), name: "A".into() })
        );
        // Admin in one organization does not make a member of another with "admins" need one there.
        assert_eq!(resolve(Off, false, &[org("a", Off, true), org("b", Admins, false)]), None);
    }

    #[test]
    fn stored_values_parse_and_inherit_adds_nothing() {
        assert_eq!(Requirement::parse(&serde_json::json!("everyone")), Requirement::Everyone);
        assert_eq!(Requirement::parse(&serde_json::json!("admins")), Requirement::Admins);
        assert_eq!(Requirement::parse(&serde_json::json!("inherit")), Requirement::Off);
        assert_eq!(Requirement::parse(&serde_json::json!("off")), Requirement::Off);
        assert!(Requirement::Everyone > Requirement::Admins && Requirement::Admins > Requirement::Off);
    }

    #[test]
    fn a_provider_is_trusted_only_when_its_switch_and_claim_both_say_so() {
        let ask = |mfa_done, trusted| {
            FirstStep::Provider { provider_id: "sso", mfa_done, provider_mfa_trusted: trusted }.asks_second_factor()
        };
        assert!(ask(false, false) && ask(true, false) && ask(false, true));
        assert!(!ask(true, true));
        assert!(FirstStep::Directory { provider_id: "ldap", sync_run: None }.asks_second_factor());
        assert!(FirstStep::Password { password_hash: None, break_glass: false }.asks_second_factor());
    }

    #[test]
    fn a_passkey_counter_only_moves_forward() {
        assert!(counter_advances(0, 0), "authenticators without a counter");
        assert!(counter_advances(0, 1) && counter_advances(5, 6));
        assert!(!counter_advances(5, 5), "a replay");
        assert!(!counter_advances(5, 3), "an older counter");
        assert!(!counter_advances(5, 0), "a counter that stopped counting");
        assert_eq!(stored_counter(r#"{"cred":{"counter":7}}"#), 7);
        assert_eq!(stored_counter("not json"), 0);
    }

    #[test]
    fn the_last_used_method_comes_first() {
        let mut m = Methods { totp: None, passkeys: vec![], recovery_codes: None };
        assert_eq!(m.for_prompt(), (vec![], None));
        m.totp = Some(TotpInfo { created_at: 1, last_used_at: Some(50) });
        m.passkeys.push(PasskeyInfo { id: "p".into(), name: "Laptop".into(), created_at: 1, last_used_at: Some(40) });
        m.recovery_codes = Some(RecoveryInfo { remaining: 0, total: 10, created_at: 1 });
        assert_eq!(m.for_prompt(), (vec!["passkey", "totp"], Some("totp")));
        m.recovery_codes = Some(RecoveryInfo { remaining: 2, total: 10, created_at: 1 });
        assert_eq!(m.for_prompt().0, vec!["passkey", "totp", "recovery"]);
        assert_eq!(m.count(), 2);
    }
}
