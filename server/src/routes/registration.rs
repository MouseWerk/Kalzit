//! Self-registration (docs/api/mail.md, "Self-registration"): off by default. When a server admin
//! turns it on (`registration.*`), people with an address of an allowed domain create an account
//! themselves: the address is confirmed by mail first, then the account is made at once or, with
//! `registration.require_approval`, after a server admin approved it. New accounts join the
//! default organization with the default role, never above editor.
//!
//! Starting takes only the address and answers alike whether or not an account has it; the lookup
//! and the mail run after the answer. Name and password are chosen with the link, by whoever reads
//! the mailbox, so starting a registration for someone else's address gains nothing. Starts are
//! limited per client address (an hour), per email address and on the whole server (a day), wrong
//! links per client address like password links. Every step is in the audit log, with ids only.

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;

use axum::extract::{Path, State};
use axum::http::{Method, StatusCode};
use axum::{Extension, Json};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::support::{Paging, QueryParams, is_unique_violation};
use super::table::{RouteDef, route};
use crate::app::AppState;
use crate::auth::ratelimit::{address_key, network_key};
use crate::auth::{SessionUser, password};
use crate::authz::Access;
use crate::error::{ApiError, ApiResult};
use crate::extract::JsonBody;
use crate::locks::MutexExt;
use crate::mail::{self, links, smtp, templates};
use crate::net::RequestInfo;
use crate::shapes::Page;

/// How long a confirmation link works.
pub const CONFIRM_MS: i64 = 24 * 3_600_000;
/// Decided and expired registrations are kept this long, then deleted with the next request.
pub const KEEP_MS: i64 = 30 * 24 * 3_600_000;
const HOUR_MS: i64 = 3_600_000;
const DAY_MS: i64 = 24 * HOUR_MS;
/// How long a confirmed registration waits for an admin's decision.
pub const PENDING_MS: i64 = 14 * DAY_MS;
/// How long a declined address cannot register again.
pub const DECLINED_MS: i64 = 30 * DAY_MS;
/// Keys each table of start counts holds at most; beyond, new keys are refused (fails closed).
const MAX_KEYS: usize = 100_000;
/// The roles a registration may give.
pub const ROLES: &[&str] = &["viewer", "editor"];

pub fn routes() -> Vec<RouteDef> {
    vec![
        route(Method::GET, "/auth/registration", Access::Public, availability),
        route(Method::POST, "/auth/registration", Access::Public, start),
        route(Method::POST, "/auth/registration/confirm", Access::Public, confirm),
        route(Method::GET, "/admin/registrations", Access::ServerAdmin, list),
        route(Method::POST, "/admin/registrations/{registrationId}/approve", Access::ServerAdmin, approve),
        route(Method::POST, "/admin/registrations/{registrationId}/reject", Access::ServerAdmin, reject),
    ]
}

/// `registration.allowed_domains`: domain names such as `example.com`, lowercase, no wildcard.
pub fn check_domains(key: &str, value: &Value) -> Result<(), String> {
    let items = value.as_array().ok_or_else(|| format!("{key} must be a list of domains"))?;
    if items.len() > 100 {
        return Err(format!("{key} takes at most 100 entries"));
    }
    for item in items {
        let ok = item.as_str().is_some_and(|d| {
            d.len() <= 253
                && d.contains('.')
                && !d.starts_with('.')
                && !d.ends_with('.')
                && d.split('.').all(|label| {
                    !label.is_empty()
                        && label.len() <= 63
                        && !label.starts_with('-')
                        && !label.ends_with('-')
                        && label.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
                })
        });
        if !ok {
            return Err(format!(
                "{key} entries must be lowercase domain names such as example.com (IDN in its xn-- form)"
            ));
        }
    }
    Ok(())
}

/// Starts per client address (an hour), per email address (a day) and on the whole server (a day),
/// against limits read from the settings at each start.
#[derive(Default)]
pub struct Limits {
    by_address: Mutex<HashMap<String, VecDeque<i64>>>,
    by_email: Mutex<HashMap<String, VecDeque<i64>>>,
    all: Mutex<HashMap<String, VecDeque<i64>>>,
}

/// Counts a start for `key` when fewer than `max` happened in the last `window` ms; else how long
/// until the oldest leaves the window.
fn count(
    table: &Mutex<HashMap<String, VecDeque<i64>>>,
    key: &str,
    max: i64,
    window: i64,
    now: i64,
) -> Result<(), std::time::Duration> {
    let mut map = table.lock_or_recover();
    if map.len() >= MAX_KEYS && !map.contains_key(key) {
        map.retain(|_, times| times.back().is_some_and(|t| *t > now - window));
        if map.len() >= MAX_KEYS {
            return Err(std::time::Duration::from_secs(60));
        }
    }
    let times = map.entry(key.to_string()).or_default();
    while times.front().is_some_and(|t| *t <= now - window) {
        times.pop_front();
    }
    if times.len() as i64 >= max {
        let wait = times.front().map_or(window, |t| t + window - now).max(1000);
        return Err(std::time::Duration::from_millis(wait as u64));
    }
    times.push_back(now);
    Ok(())
}

fn uncount(table: &Mutex<HashMap<String, VecDeque<i64>>>, key: &str) {
    if let Some(times) = table.lock_or_recover().get_mut(key) {
        times.pop_back();
    }
}

/// What the registration settings say, read at once.
struct Rules {
    enabled: bool,
    domains: Vec<String>,
    org_id: String,
    role: String,
    approval: bool,
    per_ip_hour: i64,
    per_email_day: i64,
    per_server_day: i64,
}

async fn rules(state: &AppState) -> ApiResult<Rules> {
    let get = |key: &'static str| crate::settings::get(state, key);
    let strings = |v: Value| -> Vec<String> {
        v.as_array().into_iter().flatten().filter_map(Value::as_str).map(str::to_string).collect()
    };
    Ok(Rules {
        enabled: get("registration.enabled").await?.as_bool() == Some(true),
        domains: strings(get("registration.allowed_domains").await?),
        org_id: get("registration.default_org").await?.as_str().unwrap_or_default().to_string(),
        role: get("registration.default_role").await?.as_str().unwrap_or("viewer").to_string(),
        approval: get("registration.require_approval").await?.as_bool() != Some(false),
        per_ip_hour: get("registration.max_per_ip_hour").await?.as_i64().unwrap_or(5),
        per_email_day: get("registration.max_per_email_day").await?.as_i64().unwrap_or(3),
        per_server_day: get("registration.max_per_server_day").await?.as_i64().unwrap_or(50),
    })
}

/// Why registration cannot be used now, or `None` when it can: on, links can go out by mail, the
/// default organization exists and lets its members sign in with a password, the role is one a
/// registration may give.
async fn unavailable_because(state: &AppState, rules: &Rules) -> ApiResult<Option<&'static str>> {
    if !rules.enabled {
        return Ok(Some("signup.disabled"));
    }
    // Only for named domains: an open registration for every address is not offered.
    if rules.domains.is_empty() {
        return Ok(Some("signup.no_domains"));
    }
    if !mail::can_send_links(state).await? {
        return Ok(Some("signup.mail_unavailable"));
    }
    if !ROLES.contains(&rules.role.as_str()) {
        return Ok(Some("signup.no_organization"));
    }
    let org: Option<(String,)> =
        sqlx::query_as("SELECT id FROM orgs WHERE id = $1").bind(&rules.org_id).fetch_optional(&state.db).await?;
    if org.is_none() {
        return Ok(Some("signup.no_organization"));
    }
    if !crate::sso::password_sign_in_allowed_in(state, &rules.org_id).await? {
        return Ok(Some("signup.password_sign_in_off"));
    }
    Ok(None)
}

fn unavailable(reason: &'static str) -> ApiError {
    ApiError::new(StatusCode::CONFLICT, "conflict", "self-registration is not available on this server").because(reason)
}

fn invalid_link() -> ApiError {
    ApiError::not_found().because("signup.invalid_link")
}

/// The domain part of a normalized address.
fn domain_of(email: &str) -> &str {
    email.rsplit_once('@').map_or("", |(_, d)| d)
}

/// Whether `email`'s domain is exactly one of `domains` (compared in the IDNA form, so
/// `bücher.example` matches `xn--bcher-kva.example`); never for an empty list.
fn domain_allowed(domains: &[String], email: &str) -> bool {
    let key = super::email_key(email);
    let domain = domain_of(&key);
    domains.iter().any(|d| d == domain)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Availability {
    /// The sign-in page may offer "Create account".
    available: bool,
    /// An admin approves each account after its address is confirmed.
    requires_approval: bool,
    /// The domains that may register. Only filled while available.
    allowed_domains: Vec<String>,
}

async fn availability(State(state): State<AppState>) -> ApiResult<Json<Availability>> {
    let rules = rules(&state).await?;
    let available = unavailable_because(&state, &rules).await?.is_none();
    Ok(Json(Availability {
        available,
        requires_approval: available && rules.approval,
        allowed_domains: if available { rules.domains } else { Vec::new() },
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StartBody {
    email: String,
    /// `de` or `en`, for the mails; else the server's default.
    #[serde(default)]
    language: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Started {
    /// Always true: the answer says nothing about the address.
    accepted: bool,
}

async fn start(
    State(state): State<AppState>,
    Extension(info): Extension<RequestInfo>,
    JsonBody(body): JsonBody<StartBody>,
) -> ApiResult<(StatusCode, Json<Started>)> {
    let rules = rules(&state).await?;
    if let Some(reason) = unavailable_because(&state, &rules).await? {
        return Err(unavailable(reason));
    }
    let email = super::normalize_email(&body.email).map_err(|e| e.with_field("email"))?;
    if !domain_allowed(&rules.domains, &email) {
        return Err(ApiError::forbidden("addresses of this domain cannot register here")
            .with_field("email")
            .because("signup.domain_not_allowed"));
    }
    let language = match body.language.as_deref() {
        None => None,
        Some(l @ ("de" | "en")) => Some(l.to_string()),
        Some(_) => return Err(ApiError::validation("language must be de or en").with_field("language")),
    };
    let now = state.clock.now_ms();
    let address = address_key("registration", info.client_ip);
    let email_budget = super::email_key(&email);
    let too_many =
        |wait| ApiError::rate_limited("too many registrations, wait a while", wait).because("signup.too_many");
    let limits = &state.registration;
    count(&limits.by_address, &address, rules.per_ip_hour, HOUR_MS, now).map_err(too_many)?;
    if let Err(wait) = count(&limits.by_email, &email_budget, rules.per_email_day, DAY_MS, now) {
        uncount(&limits.by_address, &address);
        return Err(too_many(wait));
    }
    if let Err(wait) = count(&limits.all, "", rules.per_server_day, DAY_MS, now) {
        uncount(&limits.by_address, &address);
        uncount(&limits.by_email, &email_budget);
        return Err(too_many(wait));
    }
    // No password here: whoever starts a registration need not own the address. The name and the
    // password are set with the link (`confirm`), by whoever reads the mailbox.
    let background = state.clone();
    let client = info.client_ip.to_string();
    state.mail.spawn(&state, async move {
        if let Err(e) = record_start(&background, &email, language, &client, rules.approval).await {
            tracing::warn!("a registration was not recorded or its mail not sent: {}", e.message);
        }
    });
    Ok((StatusCode::ACCEPTED, Json(Started { accepted: true })))
}

/// After the answer: nothing when an account has the address; else the registration, its link
/// and the mail.
async fn record_start(
    state: &AppState,
    email: &str,
    language: Option<String>,
    client: &str,
    approval: bool,
) -> ApiResult<()> {
    let key = super::email_key(email);
    let now = state.clock.now_ms();
    let mut tx = crate::db::begin(&state.db).await?;
    // Open registrations past their time go at once; decided ones after `KEEP_MS`, so a declined
    // address stays blocked for `DECLINED_MS`.
    sqlx::query(
        "DELETE FROM registrations WHERE (status IN ('unconfirmed', 'pending') AND expires_at < $1) \
         OR (status IN ('approved', 'rejected') AND decided_at < $2)",
    )
    .bind(now)
    .bind(now - KEEP_MS.max(DECLINED_MS))
    .execute(&mut *tx)
    .await?;
    let declined: Option<(String,)> = sqlx::query_as(
        "SELECT id FROM registrations WHERE email_key = $1 AND status = 'rejected' AND decided_at > $2 LIMIT 1",
    )
    .bind(&key)
    .bind(now - DECLINED_MS)
    .fetch_optional(&mut *tx)
    .await?;
    if declined.is_some() || !super::all_accounts_with_email(&mut tx, email).await?.is_empty() {
        crate::db::commit(tx).await?;
        return Ok(());
    }
    // A newer start replaces an unconfirmed one of the same address: only the last link works.
    sqlx::query("DELETE FROM registrations WHERE email_key = $1 AND status = 'unconfirmed'")
        .bind(&key)
        .execute(&mut *tx)
        .await?;
    let id = super::new_id();
    let token = links::new_token();
    sqlx::query(
        "INSERT INTO registrations (id, email, email_key, name, password_hash, language, token_hash, status, \
         client_address, created_at, expires_at) VALUES ($1, $2, $3, '', '', $4, $5, 'unconfirmed', $6, $7, $8)",
    )
    .bind(&id)
    .bind(email)
    .bind(&key)
    .bind(language.as_deref())
    .bind(links::hash(&token))
    .bind(client)
    .bind(now)
    .bind(now + CONFIRM_MS)
    .execute(&mut *tx)
    .await?;
    audit(&mut tx, None, client, "auth.registration_started", &id, json!({ "registrationId": id }), now).await?;
    crate::db::commit(tx).await?;
    let lang = match language.as_deref() {
        Some(l) => templates::Lang::parse(l),
        None => mail::language(state, None).await?,
    };
    let public = mail::public_url(state).ok_or_else(|| unavailable("signup.mail_unavailable"))?;
    let content =
        templates::registration_confirm(lang, &mail::link(&public, "register", &token), &mail::host(state), approval);
    let effective = mail::settings::effective(state).await?;
    mail::send(state, &effective, email, &content).await.map_err(smtp::SendError::into_api)?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn audit(
    tx: &mut sqlx::AnyConnection,
    actor: Option<&str>,
    address: &str,
    action: &str,
    registration_id: &str,
    summary: Value,
    at_ms: i64,
) -> ApiResult<()> {
    let event = crate::audit::AuditEvent {
        org_id: None,
        actor_user_id: actor,
        actor_address: Some(address.to_string()),
        action,
        resource_type: Some("registration"),
        resource_id: Some(registration_id),
        summary,
        at_ms,
    };
    crate::audit::record(tx, &event).await?;
    Ok(())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ConfirmBody {
    token: String,
    /// The name of the new account.
    name: String,
    /// Its password, chosen here by whoever reads the mailbox, never at the start.
    password: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Confirmed {
    /// `approved`: the account exists, sign in. `pending`: an admin approves it first.
    status: &'static str,
}

#[derive(sqlx::FromRow)]
struct Pending {
    id: String,
    email: String,
    name: String,
    password_hash: String,
    language: Option<String>,
}

async fn confirm(
    State(state): State<AppState>,
    Extension(info): Extension<RequestInfo>,
    JsonBody(body): JsonBody<ConfirmBody>,
) -> ApiResult<Json<Confirmed>> {
    let mono = state.clock.monotonic_ms();
    let key = address_key("link", info.client_ip);
    if let Some(wait) = state.mail.link_failures.wait(&key, mono) {
        return Err(ApiError::rate_limited("too many links that do not work, wait a few minutes", wait));
    }
    let now = state.clock.now_ms();
    let found: Option<Pending> = if links::is_token(&body.token) {
        sqlx::query_as(
            "SELECT id, email, name, password_hash, language FROM registrations \
             WHERE token_hash = $1 AND status = 'unconfirmed' AND expires_at > $2",
        )
        .bind(links::hash(&body.token))
        .bind(now)
        .fetch_optional(&state.db)
        .await?
    } else {
        None
    };
    let Some(mut found) = found else {
        state.mail.link_failures.record(&key, &network_key(info.client_ip), mono);
        return Err(invalid_link());
    };
    let rules = rules(&state).await?;
    if let Some(reason) = unavailable_because(&state, &rules).await? {
        return Err(unavailable(reason));
    }
    if !domain_allowed(&rules.domains, &found.email) {
        return Err(
            ApiError::forbidden("addresses of this domain cannot register here").because("signup.domain_not_allowed")
        );
    }
    found.name = super::clean_name(&body.name, "name").map_err(|e| e.with_field("name"))?;
    password::check_policy(&body.password).map_err(|e| ApiError::validation(e).with_field("password"))?;
    found.password_hash = password::hash(body.password).await?;
    let address = info.client_ip.to_string();
    let mut tx = crate::db::begin(&state.db).await?;
    // Marked first: of two confirmations at once, the second finds it taken.
    let status = if rules.approval { "pending" } else { "confirmed" };
    let marked = sqlx::query(
        "UPDATE registrations SET status = $1, confirmed_at = $2, expires_at = $4, name = $5, password_hash = $6 \
         WHERE id = $3 AND status = 'unconfirmed' AND expires_at > $2",
    )
    .bind(status)
    .bind(now)
    .bind(&found.id)
    // A confirmed registration waits for a decision 14 days from now.
    .bind(now + PENDING_MS)
    .bind(&found.name)
    .bind(&found.password_hash)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if marked == 0 {
        return Err(invalid_link());
    }
    audit(
        &mut tx,
        None,
        &address,
        "auth.registration_confirmed",
        &found.id,
        json!({ "registrationId": found.id }),
        now,
    )
    .await?;
    if rules.approval {
        crate::db::commit(tx).await?;
        notify_admins(&state);
        return Ok(Json(Confirmed { status: "pending" }));
    }
    let user_id = create_account(&mut tx, &found, &rules.org_id, &rules.role, None, now).await?;
    audit(
        &mut tx,
        Some(&user_id),
        &address,
        "auth.registered",
        &found.id,
        json!({ "registrationId": found.id, "userId": user_id, "orgId": rules.org_id, "role": rules.role }),
        now,
    )
    .await?;
    crate::db::commit(tx).await?;
    Ok(Json(Confirmed { status: "approved" }))
}

fn account_exists() -> ApiError {
    ApiError::new(StatusCode::CONFLICT, "conflict", "an account with this address exists already")
        .because("signup.account_exists")
}

/// The account of a registration with its membership, and the registration marked approved.
async fn create_account(
    tx: &mut sqlx::AnyConnection,
    found: &Pending,
    org_id: &str,
    role: &str,
    decided_by: Option<&str>,
    now: i64,
) -> ApiResult<String> {
    if !ROLES.contains(&role) {
        return Err(ApiError::validation("a registration gives viewer or editor").with_field("role"));
    }
    super::lock_email(tx, &found.email).await?;
    if !super::all_accounts_with_email(tx, &found.email).await?.is_empty() {
        return Err(account_exists());
    }
    let user_id = super::new_id();
    sqlx::query(
        "INSERT INTO users (id, email, name, password_hash, is_server_admin, disabled, created_at, email_confirmed) \
         VALUES ($1, $2, $3, $4, 0, 0, $5, 1)",
    )
    .bind(&user_id)
    .bind(&found.email)
    .bind(&found.name)
    .bind(&found.password_hash)
    .bind(now)
    .execute(&mut *tx)
    .await
    .map_err(|e| if is_unique_violation(&e) { account_exists() } else { e.into() })?;
    // The person asked to join by registering: the organization's sign-in rules bind them
    // (`authz::CONSENTED_JOINS`).
    sqlx::query(
        "INSERT INTO org_members (org_id, user_id, role, created_at, joined_by) VALUES ($1, $2, $3, $4, 'registration')",
    )
    .bind(org_id)
    .bind(&user_id)
    .bind(role)
    .bind(now)
    .execute(&mut *tx)
    .await?;
    if let Some(language) = &found.language {
        sqlx::query("INSERT INTO user_preferences (user_id, language, updated_at) VALUES ($1, $2, $3)")
            .bind(&user_id)
            .bind(language)
            .bind(now)
            .execute(&mut *tx)
            .await?;
    }
    // The password hash has done its job; the registration keeps no secret.
    sqlx::query(
        "UPDATE registrations SET status = 'approved', password_hash = '', user_id = $1, org_id = $2, role = $3, \
         decided_at = $4, decided_by = $5 WHERE id = $6",
    )
    .bind(&user_id)
    .bind(org_id)
    .bind(role)
    .bind(now)
    .bind(decided_by)
    .bind(&found.id)
    .execute(&mut *tx)
    .await?;
    Ok(user_id)
}

/// Tells the server admins by mail that a registration waits, in the background.
fn notify_admins(state: &AppState) {
    let background = state.clone();
    state.mail.spawn(state, async move {
        let run = async {
            let effective = mail::settings::effective(&background).await?;
            let Some(public) = mail::public_url(&background).filter(|_| effective.configured()) else { return Ok(()) };
            let admins: Vec<(String, String)> =
                sqlx::query_as("SELECT id, email FROM users WHERE is_server_admin = 1 AND disabled = 0 ORDER BY id")
                    .fetch_all(&background.db)
                    .await?;
            let link = format!("{public}/admin/server/registrations");
            for (admin_id, email) in admins {
                let lang = mail::language(&background, Some(&admin_id)).await?;
                let content = templates::registration_pending(lang, &link, &mail::host(&background));
                if let Err(e) = mail::send(&background, &effective, &email, &content).await {
                    tracing::warn!(admin = %admin_id, "the registration notice was not sent: {}", e.message);
                }
            }
            Ok::<(), ApiError>(())
        };
        if let Err(e) = run.await {
            tracing::warn!("the registration notice was not sent: {}", e.message);
        }
    });
}

#[derive(Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Registration {
    id: String,
    email: String,
    name: String,
    /// `unconfirmed`, `pending` (confirmed, waits for approval), `approved` or `rejected`.
    status: String,
    org_id: Option<String>,
    role: Option<String>,
    user_id: Option<String>,
    created_at: i64,
    expires_at: i64,
    confirmed_at: Option<i64>,
    decided_at: Option<i64>,
    decided_by: Option<String>,
}

const COLUMNS: &str = "SELECT id, email, name, status, org_id, role, user_id, created_at, expires_at, confirmed_at, \
                       decided_at, decided_by FROM registrations";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ListQuery {
    limit: Option<u32>,
    cursor: Option<String>,
    /// Only registrations in this state.
    status: Option<String>,
}

async fn list(
    State(state): State<AppState>,
    QueryParams(q): QueryParams<ListQuery>,
) -> ApiResult<Json<Page<Registration>>> {
    let paging = Paging::new(q.limit, q.cursor.as_deref())?;
    let status = match q.status.as_deref() {
        None => None,
        Some(s @ ("unconfirmed" | "pending" | "approved" | "rejected")) => Some(s.to_string()),
        Some(_) => {
            return Err(ApiError::validation("status must be unconfirmed, pending, approved or rejected")
                .because("request.query_invalid")
                .param("detail", "status"));
        }
    };
    let filter = if status.is_some() { "status = $4 AND " } else { "" };
    let query = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "{COLUMNS} WHERE {filter}(created_at < $1 OR (created_at = $1 AND id < $2)) \
         ORDER BY created_at DESC, id DESC LIMIT $3"
    )))
    .bind(paging.before_time())
    .bind(paging.before_id())
    .bind(paging.fetch_limit());
    let query = match status {
        Some(s) => query.bind(s),
        None => query,
    };
    let rows: Vec<Registration> = query.fetch_all(&state.db).await?;
    Ok(Json(paging.page(rows, |r| (r.created_at, r.id.as_str()))))
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ApproveBody {
    /// Another organization than the default one.
    #[serde(default)]
    org_id: Option<String>,
    /// `viewer` or `editor`; else the default role.
    #[serde(default)]
    role: Option<String>,
}

async fn decide_target(state: &AppState, id: &str) -> ApiResult<Pending> {
    sqlx::query_as("SELECT id, email, name, password_hash, language FROM registrations WHERE id = $1 AND status = 'pending' AND expires_at > $2")
        .bind(id)
        .bind(state.clock.now_ms())
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| ApiError::not_found().because("signup.not_pending"))
}

async fn approve(
    State(state): State<AppState>,
    Extension(admin): Extension<SessionUser>,
    Extension(info): Extension<RequestInfo>,
    Path(id): Path<String>,
    JsonBody(body): JsonBody<ApproveBody>,
) -> ApiResult<Json<Registration>> {
    let found = decide_target(&state, &id).await?;
    let rules = rules(&state).await?;
    let org_id = body.org_id.unwrap_or(rules.org_id);
    let role = body.role.unwrap_or(rules.role);
    if !ROLES.contains(&role.as_str()) {
        return Err(ApiError::validation("a registration gives viewer or editor")
            .with_field("role")
            .because("signup.role_too_high"));
    }
    let org: Option<(String,)> =
        sqlx::query_as("SELECT id FROM orgs WHERE id = $1").bind(&org_id).fetch_optional(&state.db).await?;
    if org.is_none() {
        return Err(ApiError::validation("the organization does not exist")
            .with_field("orgId")
            .because("signup.no_organization"));
    }
    let now = state.clock.now_ms();
    let mut tx = crate::db::begin(&state.db).await?;
    let still: Option<(String,)> =
        sqlx::query_as("SELECT id FROM registrations WHERE id = $1 AND status = 'pending' AND expires_at > $2")
            .bind(&id)
            .bind(now)
            .fetch_optional(&mut *tx)
            .await?;
    if still.is_none() {
        return Err(ApiError::not_found().because("signup.not_pending"));
    }
    let user_id = create_account(&mut tx, &found, &org_id, &role, Some(&admin.id), now).await?;
    audit(
        &mut tx,
        Some(&admin.id),
        &info.client_ip.to_string(),
        "auth.registration_approved",
        &id,
        json!({ "registrationId": id, "userId": user_id, "orgId": org_id, "role": role }),
        now,
    )
    .await?;
    crate::db::commit(tx).await?;
    tell_approved(&state, &found);
    load(&state, &id).await.map(Json)
}

fn tell_approved(state: &AppState, found: &Pending) {
    let background = state.clone();
    let (email, language) = (found.email.clone(), found.language.clone());
    state.mail.spawn(state, async move {
        let run = async {
            let effective = mail::settings::effective(&background).await?;
            let Some(public) = mail::public_url(&background).filter(|_| effective.configured()) else { return Ok(()) };
            let lang = match language.as_deref() {
                Some(l) => templates::Lang::parse(l),
                None => mail::language(&background, None).await?,
            };
            let content = templates::registration_approved(lang, &format!("{public}/login"), &mail::host(&background));
            mail::send(&background, &effective, &email, &content).await.map_err(smtp::SendError::into_api)?;
            Ok::<(), ApiError>(())
        };
        if let Err(e) = run.await {
            tracing::warn!("the approval mail of a registration was not sent: {}", e.message);
        }
    });
}

async fn reject(
    State(state): State<AppState>,
    Extension(admin): Extension<SessionUser>,
    Extension(info): Extension<RequestInfo>,
    Path(id): Path<String>,
) -> ApiResult<Json<Registration>> {
    let now = state.clock.now_ms();
    let mut tx = crate::db::begin(&state.db).await?;
    let marked = sqlx::query(
        "UPDATE registrations SET status = 'rejected', password_hash = '', decided_at = $1, decided_by = $2 \
         WHERE id = $3 AND status IN ('pending', 'unconfirmed')",
    )
    .bind(now)
    .bind(&admin.id)
    .bind(&id)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if marked == 0 {
        return Err(ApiError::not_found().because("signup.not_pending"));
    }
    audit(
        &mut tx,
        Some(&admin.id),
        &info.client_ip.to_string(),
        "auth.registration_rejected",
        &id,
        json!({ "registrationId": id }),
        now,
    )
    .await?;
    crate::db::commit(tx).await?;
    load(&state, &id).await.map(Json)
}

async fn load(state: &AppState, id: &str) -> ApiResult<Registration> {
    sqlx::query_as(sqlx::AssertSqlSafe(format!("{COLUMNS} WHERE id = $1")))
        .bind(id)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(ApiError::not_found)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn domains_are_plain_lowercase_names() {
        assert!(check_domains("k", &json!(["example.com", "xn--bcher-kva.example", "a-b.co.uk"])).is_ok());
        for bad in [
            json!(["*.example.com"]),
            json!(["Example.com"]),
            json!(["example"]),
            json!([".example.com"]),
            json!(["-a.com"]),
            json!("x"),
        ] {
            assert!(check_domains("k", &bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn domains_compare_in_their_idna_form() {
        let allowed = vec!["xn--bcher-kva.example".to_string()];
        assert!(domain_allowed(&allowed, "anna@b\u{fc}cher.example"));
        assert!(domain_allowed(&allowed, "anna@xn--bcher-kva.example"));
        assert!(!domain_allowed(&allowed, "anna@sub.xn--bcher-kva.example"));
        assert!(!domain_allowed(&allowed, "anna@example.com"));
        assert!(!domain_allowed(&[], "anna@example.com"));
    }

    #[test]
    fn starts_are_counted_per_window() {
        let table = Mutex::default();
        assert!(count(&table, "a", 2, HOUR_MS, 0).is_ok());
        assert!(count(&table, "a", 2, HOUR_MS, 1000).is_ok());
        let wait = count(&table, "a", 2, HOUR_MS, 2000).unwrap_err();
        assert_eq!(wait, std::time::Duration::from_millis(HOUR_MS as u64 - 2000));
        assert!(count(&table, "b", 2, HOUR_MS, 2000).is_ok());
        assert!(count(&table, "a", 2, HOUR_MS, HOUR_MS + 1).is_ok());
        uncount(&table, "a");
        assert!(count(&table, "a", 2, HOUR_MS, HOUR_MS + 2).is_ok());
        assert!(count(&table, "c", 1, DAY_MS, 0).is_ok());
        assert!(count(&table, "c", 1, DAY_MS, HOUR_MS * 23).is_err());
    }
}
