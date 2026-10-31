//! Service accounts of an organization with their API tokens, and the organization's SCIM token
//! (docs/api/access.md, "Service accounts"). Tokens are made and checked in `auth::api_token`.
//!
//! A service account is an account flagged `service_account` with a membership in its one
//! organization, so the role it holds is checked like anyone's. Managing it follows the guards of
//! members: nobody gives a role, or a token for a role, beyond what they hold, and an API token
//! itself never manages service accounts or tokens.

use axum::extract::{Path, State};
use axum::http::{Method, StatusCode};
use axum::{Extension, Json};
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::support::{Actor, QueryParams, audit, clean_text, conflict, decode_cursor, encode_cursor, page_limit};
use super::table::{RouteDef, route};
use crate::app::AppState;
use crate::auth::api_token::{self, Kind, TokenCaller, refuse_tokens};
use crate::authz::{
    Access, BuiltinRole, OrgCtx, Permission, RoleInfo, ensure_holds, lock_org, lock_role, resolve_role,
};
use crate::collation;
use crate::error::{ApiError, ApiResult};
use crate::extract::JsonBody;
use crate::net::RequestInfo;
use crate::shapes::Page;

pub fn routes() -> Vec<RouteDef> {
    let write = Access::Org(Permission::ServiceAccountsWrite);
    // The SCIM token provisions people and their roles across the organization; its handlers also
    // need every permission of an admin (`ensure_scim_manager`).
    let scim = Access::Org(Permission::ServiceAccountsWrite);
    vec![
        route(Method::GET, "/orgs/{orgId}/service-accounts", write, list),
        route(Method::POST, "/orgs/{orgId}/service-accounts", write, create).changes_rights(),
        route(Method::GET, "/orgs/{orgId}/service-accounts/{accountId}", write, detail),
        route(Method::PATCH, "/orgs/{orgId}/service-accounts/{accountId}", write, update).changes_rights(),
        route(Method::DELETE, "/orgs/{orgId}/service-accounts/{accountId}", write, delete).changes_rights(),
        route(Method::POST, "/orgs/{orgId}/service-accounts/{accountId}/tokens", write, create_token),
        route(Method::POST, "/orgs/{orgId}/service-accounts/{accountId}/tokens/{tokenId}/revoke", write, revoke_token),
        route(Method::GET, "/orgs/{orgId}/scim-token", scim, scim_token),
        route(Method::POST, "/orgs/{orgId}/scim-token", scim, create_scim_token),
        route(Method::DELETE, "/orgs/{orgId}/scim-token", scim, revoke_scim_token),
        route(Method::GET, "/orgs/{orgId}/scim", scim, scim_status),
        route(Method::PUT, "/orgs/{orgId}/scim", scim, set_scim),
    ]
}

const MAX_NAME_CHARS: usize = 50;
const MAX_DESCRIPTION_CHARS: usize = 200;
/// Revoked and expired tokens stay in the lists this long (the audit log keeps them for good).
const KEEP_ENDED_MS: i64 = 90 * 86_400_000;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceAccount {
    id: String,
    name: String,
    description: String,
    /// A role key: `admin`, `editor`, `viewer` or a custom role id; never `owner`.
    role: String,
    disabled: bool,
    /// Tokens neither revoked nor expired.
    active_tokens: i64,
    /// The soonest expiry of an active token.
    next_expiry: Option<i64>,
    last_used_at: Option<i64>,
    created_by_name: Option<String>,
    created_at: i64,
}

#[derive(sqlx::FromRow)]
struct AccountRow {
    id: String,
    name: String,
    description: String,
    role: String,
    disabled: i64,
    active_tokens: i64,
    next_expiry: Option<i64>,
    last_used_at: Option<i64>,
    created_by_name: Option<String>,
    created_at: i64,
}

impl From<AccountRow> for ServiceAccount {
    fn from(r: AccountRow) -> Self {
        Self {
            id: r.id,
            name: r.name,
            description: r.description,
            role: r.role,
            disabled: r.disabled != 0,
            active_tokens: r.active_tokens,
            next_expiry: r.next_expiry,
            last_used_at: r.last_used_at,
            created_by_name: r.created_by_name,
            created_at: r.created_at,
        }
    }
}

/// `$1` is the organization, `$2` the current time.
const ACCOUNT_COLUMNS: &str = "SELECT a.id, a.name, a.description, m.role, a.disabled, a.created_at, \
     (SELECT COUNT(*) FROM api_tokens t WHERE t.service_account_id = a.id AND t.revoked_at IS NULL \
      AND t.expires_at > $2) AS active_tokens, \
     (SELECT MIN(t.expires_at) FROM api_tokens t WHERE t.service_account_id = a.id AND t.revoked_at IS NULL \
      AND t.expires_at > $2) AS next_expiry, \
     (SELECT MAX(t.last_used_at) FROM api_tokens t WHERE t.service_account_id = a.id) AS last_used_at, \
     (SELECT u.name FROM users u WHERE u.id = a.created_by) AS created_by_name \
     FROM service_accounts a JOIN org_members m ON m.org_id = a.org_id AND m.user_id = a.id \
     WHERE a.org_id = $1";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiToken {
    id: String,
    name: String,
    /// The visible start of the token (`kz_sa_7f3a9c2e`); the rest is never stored.
    prefix: String,
    expires_at: i64,
    /// Addresses and networks the token may be used from; empty for anywhere.
    allowed_ips: Vec<String>,
    created_at: i64,
    created_by_name: Option<String>,
    last_used_at: Option<i64>,
    last_used_address: Option<String>,
    revoked_at: Option<i64>,
    revoked_by_name: Option<String>,
}

#[derive(sqlx::FromRow)]
struct TokenRow {
    id: String,
    name: String,
    prefix: String,
    expires_at: i64,
    allowed_ips: String,
    created_at: i64,
    created_by_name: Option<String>,
    last_used_at: Option<i64>,
    last_used_address: Option<String>,
    revoked_at: Option<i64>,
    revoked_by_name: Option<String>,
}

impl From<TokenRow> for ApiToken {
    fn from(r: TokenRow) -> Self {
        Self {
            id: r.id,
            name: r.name,
            prefix: r.prefix,
            expires_at: r.expires_at,
            allowed_ips: api_token::allow_list_entries(&r.allowed_ips),
            created_at: r.created_at,
            created_by_name: r.created_by_name,
            last_used_at: r.last_used_at,
            last_used_address: r.last_used_address,
            revoked_at: r.revoked_at,
            revoked_by_name: r.revoked_by_name,
        }
    }
}

const TOKEN_COLUMNS: &str = "SELECT t.id, t.name, t.prefix, t.expires_at, t.allowed_ips, t.created_at, \
     (SELECT u.name FROM users u WHERE u.id = t.created_by) AS created_by_name, t.last_used_at, \
     t.last_used_address, t.revoked_at, (SELECT u.name FROM users u WHERE u.id = t.revoked_by) AS revoked_by_name \
     FROM api_tokens t";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceAccountDetail {
    #[serde(flatten)]
    account: ServiceAccount,
    /// Active tokens, and revoked or expired ones of the last 90 days; newest first.
    tokens: Vec<ApiToken>,
}

/// A token as it is made: the only time the token itself is in an answer.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedToken {
    token: String,
    #[serde(flatten)]
    info: ApiToken,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ListQuery {
    limit: Option<u32>,
    cursor: Option<String>,
}

/// Ordered by name (`collation`); the cursor is the last name of the page. Names are unique and
/// differ in more than case, so their sort keys are unique too.
async fn list(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    caller: Option<Extension<TokenCaller>>,
    QueryParams(q): QueryParams<ListQuery>,
) -> ApiResult<Json<Page<ServiceAccount>>> {
    refuse_tokens(caller.as_deref())?;
    let limit = page_limit(q.limit)?;
    let after: String = decode_cursor(q.cursor.as_deref())?.unwrap_or_default();
    let mut rows: Vec<AccountRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "{ACCOUNT_COLUMNS} AND a.sort_name > $3 ORDER BY a.sort_name, a.id LIMIT $4"
    )))
    .bind(&ctx.org_id)
    .bind(state.clock.now_ms())
    .bind(collation::key(&after))
    .bind(i64::from(limit) + 1)
    .fetch_all(&state.read_db)
    .await?;
    let more = rows.len() > limit as usize;
    rows.truncate(limit as usize);
    let next_cursor = rows.last().filter(|_| more).map(|r| encode_cursor(&r.name));
    Ok(Json(Page { items: rows.into_iter().map(ServiceAccount::from).collect(), next_cursor }))
}

async fn load<'c, E>(db: E, org_id: &str, account_id: &str, now_ms: i64) -> ApiResult<ServiceAccount>
where
    E: sqlx::Executor<'c, Database = sqlx::Any>,
{
    let row: Option<AccountRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!("{ACCOUNT_COLUMNS} AND a.id = $3")))
        .bind(org_id)
        .bind(now_ms)
        .bind(account_id)
        .fetch_optional(db)
        .await?;
    row.map(ServiceAccount::from).ok_or_else(ApiError::not_found)
}

async fn tokens_of<'c, E>(db: E, account_id: &str, now_ms: i64) -> ApiResult<Vec<ApiToken>>
where
    E: sqlx::Executor<'c, Database = sqlx::Any>,
{
    let rows: Vec<TokenRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "{TOKEN_COLUMNS} WHERE t.service_account_id = $1 AND COALESCE(t.revoked_at, t.expires_at) > $2 \
         ORDER BY t.created_at DESC, t.id DESC"
    )))
    .bind(account_id)
    .bind(now_ms - KEEP_ENDED_MS)
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(ApiToken::from).collect())
}

async fn detail(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    caller: Option<Extension<TokenCaller>>,
    Path((_, account_id)): Path<(String, String)>,
) -> ApiResult<Json<ServiceAccountDetail>> {
    refuse_tokens(caller.as_deref())?;
    let now = state.clock.now_ms();
    let account = load(&state.read_db, &ctx.org_id, &account_id, now).await?;
    let tokens = tokens_of(&state.read_db, &account_id, now).await?;
    Ok(Json(ServiceAccountDetail { account, tokens }))
}

/// Lowercase letters, digits and hyphens, starting with a letter or digit.
fn clean_account_name(raw: &str) -> ApiResult<String> {
    let name = raw.trim();
    let valid = (1..=MAX_NAME_CHARS).contains(&name.len())
        && name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        && !name.starts_with('-');
    if valid {
        Ok(name.to_string())
    } else {
        Err(ApiError::validation(format!(
            "a service account name has 1 to {MAX_NAME_CHARS} lowercase letters, digits and hyphens"
        ))
        .because("serviceaccount.name_invalid")
        .param("max", MAX_NAME_CHARS)
        .with_field("name"))
    }
}

fn name_taken() -> ApiError {
    conflict("another service account of this organization has this name")
        .because("serviceaccount.name_taken")
        .with_field("name")
}

/// The role to give a service account, resolved and locked in the transaction: any role but
/// owner, within what the caller holds.
async fn assignable_role(tx: &mut sqlx::AnyConnection, ctx: &OrgCtx, key: &str) -> ApiResult<RoleInfo> {
    if key == BuiltinRole::Owner.as_str() {
        return Err(ApiError::validation("a service account cannot be an owner")
            .because("serviceaccount.role_owner")
            .with_field("role"));
    }
    let role = lock_role(tx, &ctx.org_id, key)
        .await?
        .ok_or_else(|| ApiError::validation("no such role").with_field("role"))?;
    ensure_holds(&ctx.permissions, &role.permissions)?;
    Ok(role)
}

/// The service account's current role, after the guard every change of an account passes: the
/// caller holds what the account holds, so nobody acts for an account stronger than themselves.
async fn current_role_checked(tx: &mut sqlx::AnyConnection, ctx: &OrgCtx, account_id: &str) -> ApiResult<String> {
    let current: Option<(String,)> = sqlx::query_as(
        "SELECT m.role FROM service_accounts a JOIN org_members m ON m.org_id = a.org_id AND m.user_id = a.id \
         WHERE a.org_id = $1 AND a.id = $2",
    )
    .bind(&ctx.org_id)
    .bind(account_id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some((current,)) = current else { return Err(ApiError::not_found()) };
    let held = resolve_role(&mut *tx, &ctx.org_id, &current).await?.map(|r| r.permissions).unwrap_or_default();
    ensure_holds(&ctx.permissions, &held)?;
    Ok(current)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CreateRequest {
    name: String,
    #[serde(default)]
    description: String,
    role: String,
}

async fn create(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    caller: Option<Extension<TokenCaller>>,
    JsonBody(req): JsonBody<CreateRequest>,
) -> ApiResult<(StatusCode, Json<ServiceAccount>)> {
    refuse_tokens(caller.as_deref())?;
    let name = clean_account_name(&req.name)?;
    let description =
        clean_text(&req.description, "description", MAX_DESCRIPTION_CHARS).map_err(|e| e.with_field("description"))?;
    let mut tx = crate::db::begin(&state.db).await?;
    lock_org(&mut tx, &ctx.org_id).await?;
    let role = assignable_role(&mut tx, &ctx, &req.role).await?;
    let (taken,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM service_accounts WHERE org_id = $1 AND name = $2")
        .bind(&ctx.org_id)
        .bind(&name)
        .fetch_one(&mut *tx)
        .await?;
    if taken > 0 {
        return Err(name_taken());
    }
    let id = super::new_id();
    let now = state.clock.now_ms();
    // The account has no password and never signs in; the email column needs a unique value
    // that no mail server would accept.
    sqlx::query(
        "INSERT INTO users (id, email, name, password_hash, is_server_admin, disabled, created_at, service_account, \
         email_confirmed) VALUES ($1, $2, $3, NULL, 0, 0, $4, 1, 0)",
    )
    .bind(&id)
    .bind(format!("{id}@service-account.invalid"))
    .bind(&name)
    .bind(now)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "INSERT INTO service_accounts (id, org_id, name, description, disabled, created_by, created_at, sort_name) \
         VALUES ($1, $2, $3, $4, 0, $5, $6, $7)",
    )
    .bind(&id)
    .bind(&ctx.org_id)
    .bind(&name)
    .bind(&description)
    .bind(&ctx.user.id)
    .bind(now)
    .bind(collation::key(&name))
    .execute(&mut *tx)
    .await?;
    sqlx::query("INSERT INTO org_members (org_id, user_id, role, created_at) VALUES ($1, $2, $3, $4)")
        .bind(&ctx.org_id)
        .bind(&id)
        .bind(&role.key)
        .bind(now)
        .execute(&mut *tx)
        .await?;
    let actor = Actor { user_id: &ctx.user.id, info: &info, at_ms: now };
    let summary = json!({ "serviceAccountId": id, "role": role.key });
    audit(&mut tx, &actor, Some(&ctx.org_id), "service_account.created", ("service_account", &id), summary).await?;
    let account = load(&mut *tx, &ctx.org_id, &id, now).await?;
    crate::db::commit(tx).await?;
    Ok((StatusCode::CREATED, Json(account)))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct UpdateRequest {
    description: Option<String>,
    role: Option<String>,
    disabled: Option<bool>,
}

async fn update(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    caller: Option<Extension<TokenCaller>>,
    Path((_, account_id)): Path<(String, String)>,
    JsonBody(req): JsonBody<UpdateRequest>,
) -> ApiResult<Json<ServiceAccount>> {
    refuse_tokens(caller.as_deref())?;
    let description = req
        .description
        .as_deref()
        .map(|d| clean_text(d, "description", MAX_DESCRIPTION_CHARS).map_err(|e| e.with_field("description")))
        .transpose()?;
    let mut tx = crate::db::begin(&state.db).await?;
    lock_org(&mut tx, &ctx.org_id).await?;
    let role = match &req.role {
        Some(key) => Some(assignable_role(&mut tx, &ctx, key).await?),
        None => None,
    };
    let previous = current_role_checked(&mut tx, &ctx, &account_id).await?;
    let now = state.clock.now_ms();
    let actor = Actor { user_id: &ctx.user.id, info: &info, at_ms: now };
    let resource = ("service_account", account_id.as_str());
    if let Some(description) = &description {
        let changed = sqlx::query("UPDATE service_accounts SET description = $1 WHERE id = $2 AND description <> $1")
            .bind(description)
            .bind(&account_id)
            .execute(&mut *tx)
            .await?
            .rows_affected();
        if changed > 0 {
            let summary = json!({ "serviceAccountId": account_id, "fields": ["description"] });
            audit(&mut tx, &actor, Some(&ctx.org_id), "service_account.updated", resource, summary).await?;
        }
    }
    if let Some(role) = role.filter(|r| r.key != previous) {
        sqlx::query("UPDATE org_members SET role = $1 WHERE org_id = $2 AND user_id = $3")
            .bind(&role.key)
            .bind(&ctx.org_id)
            .bind(&account_id)
            .execute(&mut *tx)
            .await?;
        let summary = json!({ "serviceAccountId": account_id, "from": previous, "to": role.key });
        audit(&mut tx, &actor, Some(&ctx.org_id), "service_account.role_changed", resource, summary).await?;
    }
    if let Some(disabled) = req.disabled {
        let changed = sqlx::query("UPDATE service_accounts SET disabled = $1 WHERE id = $2 AND disabled <> $1")
            .bind(i64::from(disabled))
            .bind(&account_id)
            .execute(&mut *tx)
            .await?
            .rows_affected();
        if changed > 0 {
            let action = if disabled { "service_account.disabled" } else { "service_account.enabled" };
            let summary = json!({ "serviceAccountId": account_id });
            audit(&mut tx, &actor, Some(&ctx.org_id), action, resource, summary).await?;
        }
    }
    let account = load(&mut *tx, &ctx.org_id, &account_id, now).await?;
    crate::db::commit(tx).await?;
    Ok(Json(account))
}

async fn delete(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    caller: Option<Extension<TokenCaller>>,
    Path((_, account_id)): Path<(String, String)>,
) -> ApiResult<StatusCode> {
    refuse_tokens(caller.as_deref())?;
    let mut tx = crate::db::begin(&state.db).await?;
    lock_org(&mut tx, &ctx.org_id).await?;
    current_role_checked(&mut tx, &ctx, &account_id).await?;
    // Grants name their subject without a foreign key; the rest goes with the account row.
    sqlx::query("DELETE FROM resource_grants WHERE org_id = $1 AND subject_type = 'user' AND subject_id = $2")
        .bind(&ctx.org_id)
        .bind(&account_id)
        .execute(&mut *tx)
        .await?;
    for sql in [
        "DELETE FROM api_tokens WHERE service_account_id = $1",
        "DELETE FROM org_members WHERE user_id = $1",
        "DELETE FROM service_accounts WHERE id = $1",
        "DELETE FROM users WHERE id = $1 AND service_account = 1",
    ] {
        sqlx::query(sql).bind(&account_id).execute(&mut *tx).await?;
    }
    let actor = Actor { user_id: &ctx.user.id, info: &info, at_ms: state.clock.now_ms() };
    let summary = json!({ "serviceAccountId": account_id });
    audit(&mut tx, &actor, Some(&ctx.org_id), "service_account.deleted", ("service_account", &account_id), summary)
        .await?;
    crate::db::commit(tx).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TokenRequest {
    name: String,
    /// Days from now (1 to 365), or `expiresAt`; neither means 90 days.
    expires_in_days: Option<i64>,
    expires_at: Option<i64>,
    #[serde(default)]
    allowed_ips: Vec<String>,
}

async fn load_token<'c, E>(db: E, token_id: &str) -> ApiResult<ApiToken>
where
    E: sqlx::Executor<'c, Database = sqlx::Any>,
{
    let row: Option<TokenRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!("{TOKEN_COLUMNS} WHERE t.id = $1")))
        .bind(token_id)
        .fetch_optional(db)
        .await?;
    row.map(ApiToken::from).ok_or_else(ApiError::not_found)
}

struct TokenSpec<'a> {
    kind: Kind,
    account_id: Option<&'a str>,
    name: &'a str,
    expires_at: i64,
    allowed_ips: &'a str,
}

/// Writes a new token in the transaction and answers it with its text.
async fn insert_token(
    tx: &mut sqlx::AnyConnection,
    ctx: &OrgCtx,
    spec: &TokenSpec<'_>,
    now: i64,
) -> ApiResult<CreatedToken> {
    let new = api_token::generate(spec.kind);
    let id = super::new_id();
    sqlx::query(
        "INSERT INTO api_tokens (id, org_id, kind, service_account_id, name, prefix, token_hash, allowed_ips, \
         expires_at, created_by, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)",
    )
    .bind(&id)
    .bind(&ctx.org_id)
    .bind(spec.kind.as_str())
    .bind(spec.account_id)
    .bind(spec.name)
    .bind(&new.prefix)
    .bind(&new.hash)
    .bind(spec.allowed_ips)
    .bind(spec.expires_at)
    .bind(&ctx.user.id)
    .bind(now)
    .execute(&mut *tx)
    .await?;
    Ok(CreatedToken { token: new.token, info: load_token(&mut *tx, &id).await? })
}

async fn create_token(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    caller: Option<Extension<TokenCaller>>,
    Path((_, account_id)): Path<(String, String)>,
    JsonBody(req): JsonBody<TokenRequest>,
) -> ApiResult<(StatusCode, Json<CreatedToken>)> {
    refuse_tokens(caller.as_deref())?;
    let name = super::clean_name(&req.name, "name").map_err(|e| e.with_field("name"))?;
    let now = state.clock.now_ms();
    let expires_at = api_token::expiry(now, req.expires_in_days, req.expires_at)?;
    let allowed_ips = api_token::allow_list(&req.allowed_ips)?;
    let mut tx = crate::db::begin(&state.db).await?;
    lock_org(&mut tx, &ctx.org_id).await?;
    // A token acts with the account's role, so making one is handing that role out.
    current_role_checked(&mut tx, &ctx, &account_id).await?;
    let spec = TokenSpec {
        kind: Kind::ServiceAccount,
        account_id: Some(&account_id),
        name: &name,
        expires_at,
        allowed_ips: &allowed_ips,
    };
    let created = insert_token(&mut tx, &ctx, &spec, now).await?;
    let actor = Actor { user_id: &ctx.user.id, info: &info, at_ms: now };
    let summary = json!({
        "serviceAccountId": account_id,
        "tokenId": created.info.id,
        "prefix": created.info.prefix,
        "expiresAt": expires_at,
        "allowedIps": created.info.allowed_ips.len(),
    });
    let resource = ("service_account", account_id.as_str());
    audit(&mut tx, &actor, Some(&ctx.org_id), "service_account.token_created", resource, summary).await?;
    crate::db::commit(tx).await?;
    Ok((StatusCode::CREATED, Json(created)))
}

async fn revoke_token(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    caller: Option<Extension<TokenCaller>>,
    Path((_, account_id, token_id)): Path<(String, String, String)>,
) -> ApiResult<Json<ApiToken>> {
    refuse_tokens(caller.as_deref())?;
    let mut tx = crate::db::begin(&state.db).await?;
    lock_org(&mut tx, &ctx.org_id).await?;
    current_role_checked(&mut tx, &ctx, &account_id).await?;
    let now = state.clock.now_ms();
    let found: Option<(String, Option<i64>)> = sqlx::query_as(
        "SELECT prefix, revoked_at FROM api_tokens WHERE id = $1 AND service_account_id = $2 AND org_id = $3",
    )
    .bind(&token_id)
    .bind(&account_id)
    .bind(&ctx.org_id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some((prefix, revoked_at)) = found else { return Err(ApiError::not_found()) };
    // Revoking twice answers the token as it is; only the first one is recorded.
    if revoked_at.is_none() {
        sqlx::query("UPDATE api_tokens SET revoked_at = $1, revoked_by = $2 WHERE id = $3")
            .bind(now)
            .bind(&ctx.user.id)
            .bind(&token_id)
            .execute(&mut *tx)
            .await?;
        let actor = Actor { user_id: &ctx.user.id, info: &info, at_ms: now };
        let summary = json!({ "serviceAccountId": account_id, "tokenId": token_id, "prefix": prefix });
        let resource = ("service_account", account_id.as_str());
        audit(&mut tx, &actor, Some(&ctx.org_id), "service_account.token_revoked", resource, summary).await?;
    }
    let token = load_token(&mut *tx, &token_id).await?;
    crate::db::commit(tx).await?;
    Ok(Json(token))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScimTokenState {
    /// The organization's SCIM token, unless it has none or it was revoked.
    token: Option<ApiToken>,
}

async fn current_scim<'c, E>(db: E, org_id: &str) -> ApiResult<Option<ApiToken>>
where
    E: sqlx::Executor<'c, Database = sqlx::Any>,
{
    let row: Option<TokenRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "{TOKEN_COLUMNS} WHERE t.org_id = $1 AND t.kind = 'scim' AND t.revoked_at IS NULL \
         ORDER BY t.created_at DESC, t.id DESC LIMIT 1"
    )))
    .bind(org_id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(ApiToken::from))
}

/// The SCIM token is for people (no API token) who hold every permission of an admin: it will
/// create, change and lock members and map groups to roles up to admin.
fn ensure_scim_manager(ctx: &OrgCtx, caller: Option<&TokenCaller>) -> ApiResult<()> {
    refuse_tokens(caller)?;
    ensure_holds(&ctx.permissions, &BuiltinRole::Admin.permissions())
}

async fn scim_token(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    caller: Option<Extension<TokenCaller>>,
) -> ApiResult<Json<ScimTokenState>> {
    ensure_scim_manager(&ctx, caller.as_deref())?;
    Ok(Json(ScimTokenState { token: current_scim(&state.read_db, &ctx.org_id).await? }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ScimTokenRequest {
    expires_in_days: Option<i64>,
    expires_at: Option<i64>,
}

/// Revokes the organization's SCIM tokens that are still in force; answers how many.
async fn revoke_scim(tx: &mut sqlx::AnyConnection, ctx: &OrgCtx, now: i64) -> ApiResult<Vec<(String, String)>> {
    let current: Vec<(String, String)> =
        sqlx::query_as("SELECT id, prefix FROM api_tokens WHERE org_id = $1 AND kind = 'scim' AND revoked_at IS NULL")
            .bind(&ctx.org_id)
            .fetch_all(&mut *tx)
            .await?;
    sqlx::query("UPDATE api_tokens SET revoked_at = $1, revoked_by = $2 WHERE org_id = $3 AND kind = 'scim' AND revoked_at IS NULL")
        .bind(now)
        .bind(&ctx.user.id)
        .bind(&ctx.org_id)
        .execute(&mut *tx)
        .await?;
    Ok(current)
}

/// Makes a new SCIM token; the one before it stops working at once (one per organization).
async fn create_scim_token(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    caller: Option<Extension<TokenCaller>>,
    JsonBody(req): JsonBody<ScimTokenRequest>,
) -> ApiResult<(StatusCode, Json<CreatedToken>)> {
    ensure_scim_manager(&ctx, caller.as_deref())?;
    let now = state.clock.now_ms();
    let expires_at = api_token::expiry(now, req.expires_in_days, req.expires_at)?;
    let mut tx = crate::db::begin(&state.db).await?;
    lock_org(&mut tx, &ctx.org_id).await?;
    let actor = Actor { user_id: &ctx.user.id, info: &info, at_ms: now };
    for (id, prefix) in revoke_scim(&mut tx, &ctx, now).await? {
        let summary = json!({ "tokenId": id, "prefix": prefix, "replaced": true });
        audit(&mut tx, &actor, Some(&ctx.org_id), "scim.token_revoked", ("api_token", &id), summary).await?;
    }
    let spec = TokenSpec { kind: Kind::Scim, account_id: None, name: "SCIM", expires_at, allowed_ips: "" };
    let created = insert_token(&mut tx, &ctx, &spec, now).await?;
    let summary = json!({ "tokenId": created.info.id, "prefix": created.info.prefix, "expiresAt": expires_at });
    audit(&mut tx, &actor, Some(&ctx.org_id), "scim.token_created", ("api_token", &created.info.id), summary).await?;
    crate::db::commit(tx).await?;
    Ok((StatusCode::CREATED, Json(created)))
}

async fn revoke_scim_token(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    caller: Option<Extension<TokenCaller>>,
) -> ApiResult<StatusCode> {
    ensure_scim_manager(&ctx, caller.as_deref())?;
    let now = state.clock.now_ms();
    let mut tx = crate::db::begin(&state.db).await?;
    lock_org(&mut tx, &ctx.org_id).await?;
    let revoked = revoke_scim(&mut tx, &ctx, now).await?;
    if revoked.is_empty() {
        return Err(ApiError::not_found());
    }
    let actor = Actor { user_id: &ctx.user.id, info: &info, at_ms: now };
    for (id, prefix) in revoked {
        let summary = json!({ "tokenId": id, "prefix": prefix });
        audit(&mut tx, &actor, Some(&ctx.org_id), "scim.token_revoked", ("api_token", &id), summary).await?;
    }
    crate::db::commit(tx).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// How far back "the last error" of SCIM looks.
const LAST_ERROR_MS: i64 = 30 * 86_400_000;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScimStatus {
    /// The organization's switch; off refuses every SCIM request (`scim.disabled`).
    enabled: bool,
    /// The base URL to enter in the directory.
    endpoint: String,
    token: Option<ApiToken>,
    stats: ScimStats,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScimStats {
    /// The start of the counted span (`since`).
    since: i64,
    created: i64,
    deactivated: i64,
    /// Existing accounts linked to new SCIM users (`scim.user_linked`).
    linked: i64,
    /// Active SCIM groups, and those of them a group mapping of this organization names.
    groups: i64,
    mapped_groups: i64,
    /// The latest refused SCIM request or refused SCIM token of the last 30 days.
    last_error: Option<ScimLastError>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScimLastError {
    at: i64,
    /// The audit action: `scim.request_refused` or `api_token.refused`.
    action: String,
    reason: Option<String>,
    status: Option<i64>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ScimStatusQuery {
    /// Unix ms: count creations and deactivations from here (the start of the viewer's day);
    /// within the last 31 days, 24 hours ago by default.
    since: Option<i64>,
}

async fn load_scim_status(
    state: &AppState,
    info: &RequestInfo,
    org_id: &str,
    since: Option<i64>,
) -> ApiResult<ScimStatus> {
    let now = state.clock.now_ms();
    let since = since.unwrap_or(now - 86_400_000).clamp(now - 31 * 86_400_000, now);
    let db = &state.read_db;
    let count = |action: &'static str| {
        sqlx::query_as::<_, (i64,)>(
            "SELECT COUNT(*) FROM audit_events WHERE org_id = $1 AND action = $2 AND created_at >= $3",
        )
        .bind(org_id)
        .bind(action)
        .bind(since)
        .fetch_one(db)
    };
    let (created,) = count("scim.user_created").await?;
    let (deactivated,) = count("scim.user_deactivated").await?;
    let (linked,) = count("scim.user_linked").await?;
    let (groups,): (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM scim_groups WHERE org_id = $1 AND deactivated_at IS NULL")
            .bind(org_id)
            .fetch_one(db)
            .await?;
    let (mapped_groups,): (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM scim_groups g WHERE g.org_id = $1 AND g.deactivated_at IS NULL AND EXISTS \
         (SELECT 1 FROM sso_group_mappings m WHERE m.org_id = $2 \
          AND (m.group_name = g.display_name OR m.group_name = g.external_id))",
    )
    .bind(org_id)
    .bind(org_id)
    .fetch_one(db)
    .await?;
    let last: Option<(i64, String, String)> = sqlx::query_as(
        "SELECT created_at, action, summary FROM audit_events WHERE org_id = $1 AND created_at >= $2 \
         AND (action = 'scim.request_refused' OR (action = 'api_token.refused' AND resource_id IN \
         (SELECT id FROM api_tokens WHERE org_id = $3 AND kind = 'scim'))) ORDER BY created_at DESC, id DESC LIMIT 1",
    )
    .bind(org_id)
    .bind(now - LAST_ERROR_MS)
    .bind(org_id)
    .fetch_optional(db)
    .await?;
    let last_error = last.map(|(at, action, summary)| {
        let summary: serde_json::Value = serde_json::from_str(&summary).unwrap_or_default();
        ScimLastError {
            at,
            action,
            reason: summary["reason"].as_str().map(str::to_string),
            status: summary["status"].as_i64(),
        }
    });
    Ok(ScimStatus {
        enabled: crate::scim::enabled(db, org_id).await?,
        endpoint: crate::scim::base_url(state, info, org_id),
        token: current_scim(db, org_id).await?,
        stats: ScimStats { since, created, deactivated, linked, groups, mapped_groups, last_error },
    })
}

/// The organization's SCIM: switch, base URL, token and what it did lately.
async fn scim_status(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    caller: Option<Extension<TokenCaller>>,
    QueryParams(q): QueryParams<ScimStatusQuery>,
) -> ApiResult<Json<ScimStatus>> {
    ensure_scim_manager(&ctx, caller.as_deref())?;
    Ok(Json(load_scim_status(&state, &info, &ctx.org_id, q.since).await?))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ScimSwitch {
    enabled: bool,
}

/// Turns SCIM on or off for the organization; the token stays. Applies at once (undo turns it back).
async fn set_scim(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    caller: Option<Extension<TokenCaller>>,
    JsonBody(req): JsonBody<ScimSwitch>,
) -> ApiResult<Json<ScimStatus>> {
    ensure_scim_manager(&ctx, caller.as_deref())?;
    let now = state.clock.now_ms();
    let mut tx = crate::db::begin(&state.db).await?;
    lock_org(&mut tx, &ctx.org_id).await?;
    let before = crate::scim::enabled(&mut *tx, &ctx.org_id).await?;
    if before != req.enabled {
        sqlx::query(
            "INSERT INTO scim_orgs (org_id, enabled, updated_at) VALUES ($1, $2, $3) \
             ON CONFLICT (org_id) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at",
        )
        .bind(&ctx.org_id)
        .bind(i64::from(req.enabled))
        .bind(now)
        .execute(&mut *tx)
        .await?;
        let actor = Actor { user_id: &ctx.user.id, info: &info, at_ms: now };
        let action = if req.enabled { "scim.turned_on" } else { "scim.turned_off" };
        audit(&mut tx, &actor, Some(&ctx.org_id), action, ("org", &ctx.org_id), json!({ "orgId": ctx.org_id })).await?;
    }
    crate::db::commit(tx).await?;
    Ok(Json(load_scim_status(&state, &info, &ctx.org_id, None).await?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_lowercase_letters_digits_and_hyphens() {
        for good in ["export-nightly", "ci2", "a", &"x".repeat(50)] {
            assert_eq!(clean_account_name(good).unwrap(), good);
        }
        assert_eq!(clean_account_name("  probe ").unwrap(), "probe");
        for bad in ["", "Export", "-x", "a b", "a_b", "ä", &"x".repeat(51)] {
            let e = clean_account_name(bad).unwrap_err();
            assert_eq!(e.field, Some("name"), "{bad}");
        }
    }
}
