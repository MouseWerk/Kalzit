//! Whether an AI call may run, and its bookkeeping. Every call names the organization and user it
//! runs for and its purpose; it runs only when `ai.enabled` is on and a provider is in effect for
//! the organization (its own default, else the server's), within the limits per user and
//! organization and the concurrency limits. A call counts and reserves its token budget when it
//! starts (checked and reserved in one step); when it ends, fails or is dropped, a task of its
//! own replaces the reservation with the tokens used and writes the audit entry (who, provider,
//! model, tokens, purpose, outcome; never the prompt or the answer).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::http::StatusCode;
use futures_util::{Stream, StreamExt};
use serde::Serialize;
use serde_json::json;
use tokio_util::sync::CancellationToken;

use super::store::{self, ProviderRow};
use super::{
    AiError, ChatEvent, ChatRequest, ChatResponse, Provider, ProviderConfig, ProviderKind, TokenLimitField, Usage,
};
use crate::app::AppState;
use crate::audit::{self, AuditEvent};
use crate::error::{ApiError, ApiResult};
use crate::settings;

/// Calls running now, on the whole server, per organization and per user, and the lock that
/// makes the check of the limits and the reservation of a call one step.
#[derive(Default)]
pub struct AiRuntime {
    running: Mutex<Running>,
    /// Held from reading the counters until the call's reservation is written, so calls that
    /// start at the same moment see each other's reservations. Within one server process; with
    /// several processes on one database, each may admit one call over a limit.
    admission: tokio::sync::Mutex<()>,
}

#[derive(Default)]
struct Running {
    total: usize,
    per_org: HashMap<String, usize>,
    per_user: HashMap<String, usize>,
}

/// A place among the running calls, given back when dropped.
pub struct Slot {
    runtime: Arc<AiRuntime>,
    org_id: String,
    user_id: String,
}

impl std::fmt::Debug for Slot {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Slot").field("org_id", &self.org_id).field("user_id", &self.user_id).finish()
    }
}

fn release(map: &mut HashMap<String, usize>, key: &str) {
    if let Some(n) = map.get_mut(key) {
        *n -= 1;
        if *n == 0 {
            map.remove(key);
        }
    }
}

impl Drop for Slot {
    fn drop(&mut self) {
        let mut running = self.runtime.running.lock().expect("AI runtime lock");
        running.total = running.total.saturating_sub(1);
        release(&mut running.per_org, &self.org_id);
        release(&mut running.per_user, &self.user_id);
    }
}

/// How long a caller refused for concurrency is asked to wait.
const BUSY_RETRY: Duration = Duration::from_secs(5);

/// The concurrency limits: on the server, per organization, per user.
#[derive(Clone, Copy, Debug)]
struct AtOnce {
    total: usize,
    org: usize,
    user: usize,
}

impl AiRuntime {
    /// A slot when every concurrency limit has room for one more call.
    fn acquire(self: &Arc<Self>, org_id: &str, user_id: &str, max: AtOnce) -> ApiResult<Slot> {
        let mut running = self.running.lock().expect("AI runtime lock");
        if running.per_user.get(user_id).copied().unwrap_or(0) >= max.user {
            return Err(ApiError::rate_limited(format!("at most {} AI calls per user at once", max.user), BUSY_RETRY)
                .because("ai.limit_user_concurrent")
                .param("max", max.user));
        }
        if running.per_org.get(org_id).copied().unwrap_or(0) >= max.org {
            return Err(ApiError::rate_limited(
                format!("at most {} AI calls per organization at once", max.org),
                BUSY_RETRY,
            )
            .because("ai.limit_org_concurrent")
            .param("max", max.org));
        }
        if running.total >= max.total {
            return Err(ApiError::rate_limited(format!("at most {} AI calls at once", max.total), BUSY_RETRY)
                .because("ai.limit_concurrent")
                .param("max", max.total));
        }
        running.total += 1;
        *running.per_org.entry(org_id.to_string()).or_default() += 1;
        *running.per_user.entry(user_id.to_string()).or_default() += 1;
        Ok(Slot { runtime: self.clone(), org_id: org_id.to_string(), user_id: user_id.to_string() })
    }

    /// Calls running now.
    pub fn running(&self) -> usize {
        self.running.lock().expect("AI runtime lock").total
    }
}

/// Who a call runs for and why. `purpose` is a short stable word (`explain_query`, `test`).
#[derive(Clone, Debug)]
pub struct Caller {
    pub org_id: String,
    pub user_id: String,
    pub address: Option<String>,
    pub purpose: &'static str,
    /// The version of the feature's system prompt (`ai::prompts`), for the audit entry.
    pub prompt_version: Option<u32>,
}

/// `ai.enabled` of the server.
pub async fn enabled(state: &AppState) -> ApiResult<bool> {
    Ok(settings::get(state, "ai.enabled").await?.as_bool().unwrap_or(false))
}

/// `ai.enabled` of the organization (on unless its admins turned it off).
pub async fn enabled_in_org(state: &AppState, org_id: &str) -> ApiResult<bool> {
    Ok(settings::get_org(state, org_id, "ai.org_enabled").await?.as_bool().unwrap_or(true))
}

async fn setting_u64(state: &AppState, key: &str) -> ApiResult<u64> {
    settings::get(state, key)
        .await?
        .as_u64()
        .ok_or_else(|| ApiError::internal("settings", format!("{key} is not a whole number")))
}

/// The stricter of two limits where 0 is no limit.
fn stricter(a: u64, b: u64) -> u64 {
    match (a, b) {
        (0, x) | (x, 0) => x,
        (a, b) => a.min(b),
    }
}

/// A limit in effect for an organization: the server's, or the organization's when it is lower
/// (`inherit` and 0 follow the server). An organization can only lower a limit.
async fn org_limit(state: &AppState, org_id: &str, key: &str) -> ApiResult<u64> {
    let server = setting_u64(state, key).await?;
    Ok(match settings::get_org(state, org_id, key).await?.as_u64() {
        Some(own) => stricter(server, own),
        None => server,
    })
}

/// How long chats of an organization's members are kept, in days (0: not kept): the server's
/// retention, or the organization's when it is shorter.
pub async fn chat_retention_days(state: &AppState, org_id: &str) -> ApiResult<u64> {
    let server = setting_u64(state, "ai.chat_retention_days").await?;
    Ok(match settings::get_org(state, org_id, "ai.chat_retention_days").await?.as_u64() {
        Some(own) => server.min(own),
        None => server,
    })
}

/// Whether organizations may use their own providers (`ai.allow_org_providers`).
pub async fn org_providers_allowed(state: &AppState) -> ApiResult<bool> {
    Ok(settings::get(state, "ai.allow_org_providers").await?.as_bool().unwrap_or(true))
}

/// The provider in effect for an organization, if any.
pub async fn in_effect(state: &AppState, org_id: &str) -> ApiResult<Option<ProviderRow>> {
    Ok(store::in_effect(&state.db, org_id, org_providers_allowed(state).await?).await?)
}

/// The functions a server provider can be chosen for (`ai.provider_<function>`; board AI.dc.html
/// frame 2): explain and draft, summarize, and the chat.
pub const FUNCTIONS: [&str; 3] = ["explain", "summarize", "chat"];

/// The function of a call's purpose, for the provider chosen for it.
pub fn function_of(purpose: &str) -> Option<&'static str> {
    match purpose {
        "explain_query" | "draft_query" => Some("explain"),
        "summarize_result" => Some("summarize"),
        "chat" => Some("chat"),
        _ => None,
    }
}

/// The provider in effect for one function of an organization: the organization's own default
/// when it has one (and may), else the server provider chosen for the function
/// (`ai.provider_<function>`, while it exists), else the server's default.
pub async fn in_effect_for(state: &AppState, org_id: &str, function: Option<&str>) -> ApiResult<Option<ProviderRow>> {
    let allowed = org_providers_allowed(state).await?;
    if allowed && let Some(own) = store::list(&state.db, Some(org_id)).await?.into_iter().find(|p| p.is_default != 0) {
        return Ok(Some(own));
    }
    if let Some(function) = function {
        let chosen = settings::get(state, &format!("ai.provider_{function}")).await?;
        if let Some(id) = chosen.as_str().filter(|id| !id.is_empty())
            && let Some(row) = store::find(&state.db, None, id).await?
        {
            return Ok(Some(row));
        }
    }
    Ok(store::list(&state.db, None).await?.into_iter().find(|p| p.is_default != 0))
}

/// Whether a provider's address stays in the installation's own network, judged from the address
/// alone: a loopback, private or link-local address, `localhost`, a name without a dot, or a name
/// under a local suffix (`.local`, `.lan`, `.internal`, `.intern`, `.home.arpa`, `.corp`). A
/// gateway there may still forward data further; the providers page says where it goes.
pub fn stays_in_network(base_url: &str) -> bool {
    use std::net::IpAddr;
    let Some(host) = url::Url::parse(base_url).ok().and_then(|u| u.host_str().map(str::to_ascii_lowercase)) else {
        return false;
    };
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    if let Ok(ip) = bare.parse::<IpAddr>() {
        return match ip {
            IpAddr::V4(v4) => v4.is_loopback() || v4.is_private() || v4.is_link_local(),
            IpAddr::V6(v6) => {
                v6.is_loopback() || (v6.segments()[0] & 0xfe00) == 0xfc00 || (v6.segments()[0] & 0xffc0) == 0xfe80
            }
        };
    }
    let local = [".local", ".lan", ".internal", ".intern", ".home.arpa", ".corp", ".localdomain"];
    host == "localhost" || !host.contains('.') || local.iter().any(|s| host.ends_with(s))
}

/// AI can only be switched on while a provider in effect passed its connection test since its
/// address, model or key last changed: for `ai.enabled` the server's default provider (or, while
/// the server has none, an organization's default), for `ai.org_enabled` the provider in effect
/// for the organization. Switching off, and every other setting, is never refused here.
pub async fn check_switch(
    state: &AppState,
    org_id: Option<&str>,
    key: &str,
    value: &serde_json::Value,
) -> ApiResult<()> {
    // A provider chosen for a function is one of the server's, or empty for the default.
    if org_id.is_none() && key.starts_with("ai.provider_") {
        let id = value.as_str().unwrap_or_default();
        if !id.is_empty() && store::find(&state.db, None, id).await?.is_none() {
            return Err(ApiError::validation("the provider is not one of the server's")
                .with_field("value")
                .because("ai.provider_unknown"));
        }
        return Ok(());
    }
    if value.as_bool() != Some(true) {
        return Ok(());
    }
    let tested = match (org_id, key) {
        (None, "ai.enabled") => {
            let server = store::list(&state.db, None).await?.into_iter().find(|p| p.is_default != 0);
            match server {
                Some(p) => p.tested_ok(),
                None => {
                    let rows: Vec<(i64,)> = sqlx::query_as(
                        "SELECT last_test_ok FROM ai_providers WHERE org_id IS NOT NULL AND is_default = 1 \
                         AND last_test_ok = 1",
                    )
                    .fetch_all(&state.db)
                    .await?;
                    !rows.is_empty() && org_providers_allowed(state).await?
                }
            }
        }
        (Some(org), "ai.org_enabled") => in_effect(state, org).await?.is_some_and(|p| p.tested_ok()),
        _ => return Ok(()),
    };
    if tested {
        Ok(())
    } else {
        Err(ApiError::new(
            StatusCode::CONFLICT,
            "conflict",
            "AI can be turned on once a provider in effect passed its connection test",
        )
        .with_field("value")
        .because("ai.enable_needs_tested_provider"))
    }
}

/// The most rows, documents or nodes of one result AI receives (`ai.max_rows_to_model`).
pub async fn max_rows_to_model(state: &AppState) -> ApiResult<usize> {
    Ok(usize::try_from(setting_u64(state, "ai.max_rows_to_model").await?).unwrap_or(usize::MAX))
}

/// The most tool calls of one chat answer (`ai.max_tool_calls`).
pub async fn max_tool_calls(state: &AppState) -> ApiResult<usize> {
    Ok(usize::try_from(setting_u64(state, "ai.max_tool_calls").await?).unwrap_or(usize::MAX))
}

/// The day (UTC) a moment falls on, `YYYY-MM-DD`: the key of the daily counters.
pub fn day_of(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms).unwrap_or_default().format("%Y-%m-%d").to_string()
}

/// Time until the next day (UTC) begins, when the daily limits start over.
fn until_next_day(ms: i64) -> Duration {
    const DAY: i64 = 24 * 60 * 60 * 1000;
    Duration::from_millis((DAY - ms.rem_euclid(DAY)).max(1000) as u64)
}

/// Today's counts of one user in one organization, or of the organization. `tokens` are the
/// tokens used; `reserved` the budgets of calls still running.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Counts {
    pub requests: i64,
    pub tokens: i64,
    pub reserved: i64,
}

pub async fn today(state: &AppState, org_id: &str, user_id: &str) -> ApiResult<(Counts, Counts)> {
    let day = day_of(state.clock.now_ms());
    let rows: Vec<(String, i64, i64, i64, i64)> = sqlx::query_as(
        "SELECT user_id, requests, input_tokens, output_tokens, reserved_tokens FROM ai_usage \
         WHERE day = $1 AND org_id = $2",
    )
    .bind(&day)
    .bind(org_id)
    .fetch_all(&state.db)
    .await?;
    let (mut user, mut org) = (Counts::default(), Counts::default());
    for (who, requests, input, output, reserved) in rows {
        let row = Counts { requests, tokens: input + output, reserved };
        for counts in std::iter::once(&mut org).chain((who == user_id).then_some(&mut user)) {
            counts.requests += row.requests;
            counts.tokens += row.tokens;
            counts.reserved += row.reserved;
        }
    }
    Ok((user, org))
}

/// The first day (UTC) of the month a moment falls in, `YYYY-MM-01`.
fn month_start(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms).unwrap_or_default().format("%Y-%m-01").to_string()
}

/// Time until the next calendar month (UTC) begins, when the monthly limit starts over.
fn until_next_month(ms: i64) -> Duration {
    use chrono::Datelike;
    let now = chrono::DateTime::from_timestamp_millis(ms).unwrap_or_default();
    let (year, month) = if now.month() == 12 { (now.year() + 1, 1) } else { (now.year(), now.month() + 1) };
    let next = chrono::NaiveDate::from_ymd_opt(year, month, 1)
        .and_then(|d| d.and_hms_opt(0, 0, 0))
        .map_or(ms, |d| d.and_utc().timestamp_millis());
    Duration::from_millis((next - ms).max(1000) as u64)
}

/// Tokens all members of an organization used this calendar month (UTC), and the budgets of its
/// calls still running. Rows of deleted users keep counting.
async fn month_usage(state: &AppState, org_id: &str) -> ApiResult<(i64, i64)> {
    let now = state.clock.now_ms();
    let (used, reserved): (i64, i64) = sqlx::query_as(
        "SELECT CAST(COALESCE(SUM(input_tokens + output_tokens), 0) AS BIGINT), \
         CAST(COALESCE(SUM(reserved_tokens), 0) AS BIGINT) FROM ai_usage WHERE org_id = $1 AND day >= $2",
    )
    .bind(org_id)
    .bind(month_start(now))
    .fetch_one(&state.db)
    .await?;
    Ok((used, reserved))
}

/// Tokens all members of an organization used this calendar month (UTC).
pub async fn month_tokens(state: &AppState, org_id: &str) -> ApiResult<i64> {
    Ok(month_usage(state, org_id).await?.0)
}

/// The limits in effect for an organization; 0 is no limit.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Limits {
    /// Calls per member and day.
    pub user_requests: u64,
    /// Tokens per member and day.
    pub user_tokens: u64,
    /// Tokens of the whole organization per calendar month.
    pub org_tokens_month: u64,
}

pub async fn limits(state: &AppState, org_id: &str) -> ApiResult<Limits> {
    Ok(Limits {
        user_requests: org_limit(state, org_id, "ai.user_requests_per_day").await?,
        user_tokens: org_limit(state, org_id, "ai.user_tokens_per_day").await?,
        org_tokens_month: org_limit(state, org_id, "ai.org_tokens_per_month").await?,
    })
}

/// Refuses a call when a limit is used up: the member's of today, or the organization's of
/// this month. Budgets reserved by running calls count as used, so calls that start together
/// cannot all pass a limit.
fn check_limits(limits: &Limits, user: Counts, org_month_tokens: i64, now: i64) -> ApiResult<()> {
    let over = |limit: u64, used: i64| limit > 0 && used >= i64::try_from(limit).unwrap_or(i64::MAX);
    let daily = [
        (limits.user_requests, user.requests, "ai.limit_user_requests"),
        (limits.user_tokens, user.tokens + user.reserved, "ai.limit_user_tokens"),
    ];
    for (limit, used, reason) in daily {
        if over(limit, used) {
            return Err(ApiError::rate_limited("the daily AI limit is used up", until_next_day(now))
                .because(reason)
                .param("max", limit));
        }
    }
    if over(limits.org_tokens_month, org_month_tokens) {
        return Err(ApiError::rate_limited("the organization's monthly AI tokens are used up", until_next_month(now))
            .because("ai.limit_org_tokens")
            .param("max", limits.org_tokens_month));
    }
    Ok(())
}

fn unavailable(reason: &'static str, message: &str) -> ApiError {
    ApiError::new(StatusCode::CONFLICT, "ai_unavailable", message).because(reason)
}

/// The provider in effect for an organization, ready to call, with its row.
pub async fn provider_for(state: &AppState, org_id: &str) -> ApiResult<(ProviderRow, Box<dyn Provider>)> {
    let row =
        in_effect(state, org_id).await?.ok_or_else(|| unavailable("ai.no_provider", "no AI provider is configured"))?;
    let provider = build(state, &row).await?;
    Ok((row, provider))
}

/// The guard that keeps a provider from reaching Kalzit itself, when its base URL's port is one
/// of Kalzit's own listening ports (`http::LocalGuard`).
pub fn local_guard(state: &AppState, base_url: &url::Url) -> Option<crate::http::LocalGuard> {
    let port = base_url.port_or_known_default()?;
    let own = [state.config.http_addr(), state.config.https_addr()];
    own.iter().flatten().any(|l| l.port() == port).then(|| crate::http::LocalGuard {
        refused: crate::datasources::Detail::new("ai.base_url_kalzit", "the address is this Kalzit server"),
    })
}

/// The client for a stored provider, with its key and the current target policy.
pub async fn build(state: &AppState, row: &ProviderRow) -> ApiResult<Box<dyn Provider>> {
    let kind = ProviderKind::parse(&row.kind)
        .ok_or_else(|| ApiError::internal("ai", format!("unknown provider kind {}", row.kind)))?;
    let base_url = url::Url::parse(&row.base_url).map_err(|e| ApiError::internal("ai", e))?;
    let api_key = store::load_key(&state.db, &state.secrets, &row.id).await.map_err(|e| match e {
        crate::secrets::LoadError::Database(e) => ApiError::from(e),
        secret @ crate::secrets::LoadError::Secret { .. } => {
            unavailable("ai.key_unreadable", &format!("the AI provider's key cannot be read: {secret}"))
        }
    })?;
    let timeout = Duration::from_secs(setting_u64(state, "ai.request_timeout_secs").await?);
    let token_limit_field =
        row.token_limit_field.as_deref().and_then(TokenLimitField::parse).unwrap_or(TokenLimitField::Auto);
    let local_guard = local_guard(state, &base_url);
    let config =
        ProviderConfig { kind, base_url, model: row.model.clone(), api_key, timeout, token_limit_field, local_guard };
    let policy = state.datasources.policy(state).await?;
    super::provider(config, policy).map_err(|e| provider_error(&e))
}

/// The API error of a failed call.
pub fn provider_error(e: &AiError) -> ApiError {
    let detail = e.detail();
    let error = match e {
        AiError::Blocked(_) => {
            ApiError::new(StatusCode::UNPROCESSABLE_ENTITY, "datasource_target_blocked", &detail.message)
        }
        AiError::Timeout => ApiError::new(StatusCode::GATEWAY_TIMEOUT, "ai_provider_error", &detail.message),
        _ => ApiError::new(StatusCode::BAD_GATEWAY, "ai_provider_error", &detail.message),
    };
    error.with_reason(detail.reason, detail.params)
}

/// Tokens of a text, estimated at four characters each, for budgets and for calls whose provider
/// sent no usage.
fn estimate_tokens(chars: usize) -> u64 {
    (chars as u64).div_ceil(4)
}

/// The characters of everything a request sends.
fn request_chars(request: &ChatRequest) -> usize {
    let parts: usize = request
        .messages
        .iter()
        .flat_map(|m| &m.parts)
        .map(|p| match p {
            super::Part::Text(t) => t.chars().count(),
            super::Part::ToolCall { name, arguments, .. } => name.len() + arguments.to_string().len(),
            super::Part::ToolResult { content, .. } => content.chars().count(),
        })
        .sum();
    let tools: usize = request
        .tools
        .iter()
        .map(|t| t.name.len() + t.description.chars().count() + t.parameters.to_string().len())
        .sum();
    request.system.as_ref().map_or(0, |s| s.chars().count()) + parts + tools
}

/// The tokens a call may use at most: its estimated input and its answer budget. Reserved when it
/// starts, replaced by what it used when it ends.
fn budget(request: &ChatRequest) -> i64 {
    let max = u64::from(request.max_tokens.unwrap_or(super::DEFAULT_MAX_TOKENS));
    i64::try_from(estimate_tokens(request_chars(request)) + max).unwrap_or(i64::MAX)
}

/// What a running call holds: its place, and the budget reserved on its day's row.
struct Admitted {
    row: ProviderRow,
    provider: Box<dyn Provider>,
    // Held, not read: the place is given back when the call is dropped after its settlement.
    _slot: Slot,
    day: String,
    reserved: i64,
}

/// The switches, the provider in effect and the caller's notice: what a call needs before its
/// limits are looked at.
async fn ready_row(state: &AppState, caller: &Caller) -> ApiResult<ProviderRow> {
    if !enabled(state).await? {
        return Err(unavailable("ai.disabled", "AI is turned off on this server"));
    }
    if !enabled_in_org(state, &caller.org_id).await? {
        return Err(unavailable("ai.org_disabled", "AI is turned off in this organization"));
    }
    let row = in_effect_for(state, &caller.org_id, function_of(caller.purpose))
        .await?
        .ok_or_else(|| unavailable("ai.no_provider", "no AI provider is configured"))?;
    // The person saw what leaves the server, and to which provider, before the first call.
    if !store::notice_acknowledged(&state.db, &caller.user_id, &row.id).await? {
        return Err(unavailable("ai.notice_required", "the AI notice for this provider was not acknowledged yet"));
    }
    Ok(row)
}

/// Whether a call for `caller` would be admitted now, before a feature does work for it (such as
/// running a query to summarize): the switches, the provider, the notice and the daily and monthly
/// limits. Nothing is reserved; `stream` checks everything again when the call starts.
pub async fn precheck(state: &AppState, caller: &Caller) -> ApiResult<ProviderRow> {
    let row = ready_row(state, caller).await?;
    let limits = limits(state, &caller.org_id).await?;
    let (user, _) = today(state, &caller.org_id, &caller.user_id).await?;
    let (month_used, month_reserved) = month_usage(state, &caller.org_id).await?;
    check_limits(&limits, user, month_used + month_reserved, state.clock.now_ms())?;
    Ok(row)
}

/// Checks everything before a call and takes its place: the switches, the provider, the notice,
/// the limits and the concurrency. The check and the reservation are one step (`admission`).
async fn admit(state: &AppState, caller: &Caller, request: &ChatRequest) -> ApiResult<Admitted> {
    let row = ready_row(state, caller).await?;
    let provider = build(state, &row).await?;
    let limits = limits(state, &caller.org_id).await?;
    let at_once = AtOnce {
        total: setting_u64(state, "ai.max_concurrent").await? as usize,
        org: setting_u64(state, "ai.max_concurrent_per_org").await? as usize,
        user: setting_u64(state, "ai.max_concurrent_per_user").await? as usize,
    };
    let reserved = budget(request);
    let _admission = state.ai.admission.lock().await;
    let now = state.clock.now_ms();
    let (user, _) = today(state, &caller.org_id, &caller.user_id).await?;
    let (month_used, month_reserved) = month_usage(state, &caller.org_id).await?;
    check_limits(&limits, user, month_used + month_reserved, now)?;
    let slot = state.ai.acquire(&caller.org_id, &caller.user_id, at_once)?;
    let day = day_of(now);
    sqlx::query(
        "INSERT INTO ai_usage (day, org_id, user_id, requests, input_tokens, output_tokens, reserved_tokens) \
         VALUES ($1, $2, $3, 1, 0, 0, $4) ON CONFLICT (day, org_id, user_id) DO UPDATE SET \
         requests = ai_usage.requests + 1, reserved_tokens = ai_usage.reserved_tokens + excluded.reserved_tokens",
    )
    .bind(&day)
    .bind(&caller.org_id)
    .bind(&caller.user_id)
    .bind(reserved)
    .execute(&state.db)
    .await?;
    Ok(Admitted { row, provider, _slot: slot, day, reserved })
}

/// How a call ended, for its audit entry.
fn outcome(result: &Result<(), AiError>) -> (&'static str, Option<&'static str>) {
    match result {
        Ok(()) => ("ok", None),
        Err(AiError::Cancelled) => ("cancelled", None),
        Err(e) => ("failed", Some(e.detail().reason)),
    }
}

/// What a call used, as the provider said or, without its word, estimated.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct Used {
    usage: Usage,
    estimated: bool,
}

/// Replaces the call's reservation by what it used, in one statement on the day it started, and
/// writes its audit entry.
async fn finish(state: &AppState, caller: &Caller, admitted: &Admitted, used: Used, result: &Result<(), AiError>) {
    let now = state.clock.now_ms();
    let clamp = |n: u64| i64::try_from(n).unwrap_or(i64::MAX);
    let settled = sqlx::query(
        "UPDATE ai_usage SET reserved_tokens = reserved_tokens - $1, input_tokens = input_tokens + $2, \
         output_tokens = output_tokens + $3 WHERE day = $4 AND org_id = $5 AND user_id = $6",
    )
    .bind(admitted.reserved)
    .bind(clamp(used.usage.input_tokens))
    .bind(clamp(used.usage.output_tokens))
    .bind(&admitted.day)
    .bind(&caller.org_id)
    .bind(&caller.user_id)
    .execute(&state.db)
    .await;
    if let Err(e) = settled {
        tracing::warn!("counting the tokens of an AI call failed: {e}");
    }
    let (outcome, reason) = outcome(result);
    let row = &admitted.row;
    let mut summary = json!({
        "purpose": caller.purpose,
        "providerKind": row.kind,
        "providerScope": if row.org_id.is_some() { "org" } else { "server" },
        "model": row.model,
        "inputTokens": used.usage.input_tokens,
        "outputTokens": used.usage.output_tokens,
        "outcome": outcome,
    });
    if used.estimated {
        summary["estimated"] = json!(true);
    }
    if let Some(version) = caller.prompt_version {
        summary["promptVersion"] = json!(version);
    }
    if let Some(reason) = reason {
        summary["reason"] = json!(reason);
    }
    let event = AuditEvent {
        org_id: Some(&caller.org_id),
        actor_user_id: Some(&caller.user_id),
        actor_address: caller.address.clone(),
        action: "ai.called",
        resource_type: Some("ai_provider"),
        resource_id: Some(&row.id),
        summary,
        at_ms: now,
    };
    let audited = async {
        let mut tx = crate::db::begin(&state.db).await?;
        audit::record(&mut tx, &event).await?;
        crate::db::commit(tx).await
    };
    if let Err(e) = audited.await {
        tracing::warn!("auditing an AI call failed: {e}");
    }
}

/// Runs a whole call for `caller` and returns the answer. Built on `stream`, so a caller that
/// goes away (a dropped request) still leaves the call counted and audited.
pub async fn complete(
    state: &AppState,
    caller: &Caller,
    request: &ChatRequest,
    cancel: &CancellationToken,
) -> ApiResult<ChatResponse> {
    let mut events = std::pin::pin!(stream(state, caller, request, cancel).await?);
    let mut out = ChatResponse::default();
    while let Some(event) = events.next().await {
        out.add(event?);
    }
    Ok(out)
}

/// A streamed call for `caller`. Everything after the admission runs in a task of its own: the
/// events come as the provider sends them, and when the answer ends, fails, or the stream is
/// dropped (which cancels the call), the task gives back the place, settles the tokens and writes
/// the audit entry. A provider that sent no usage is counted by estimate: its input from the
/// request, its output from what arrived; a call cut short counts at least what arrived.
pub async fn stream(
    state: &AppState,
    caller: &Caller,
    request: &ChatRequest,
    cancel: &CancellationToken,
) -> ApiResult<impl Stream<Item = Result<ChatEvent, ApiError>> + Send + use<>> {
    let admitted = admit(state, caller, request).await?;
    // A token of its own, so dropping the stream stops the provider without touching the caller's.
    let call = cancel.child_token();
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<ChatEvent, ApiError>>(64);
    let (started_tx, started_rx) = tokio::sync::oneshot::channel::<Result<(), ApiError>>();
    let state = state.clone();
    let caller = caller.clone();
    let request = request.clone();
    tokio::spawn(async move {
        let _stop = call.clone().drop_guard();
        let input_estimate = estimate_tokens(request_chars(&request));
        let mut reported: Option<Usage> = None;
        let mut received_chars = 0usize;
        let mut result = Ok(());
        let mut started = false;
        match admitted.provider.stream(&request, &call).await {
            Err(e) => {
                let _ = started_tx.send(Err(provider_error(&e)));
                result = Err(e);
            }
            Ok(mut events) => {
                started = true;
                let _ = started_tx.send(Ok(()));
                loop {
                    let next = tokio::select! {
                        () = tx.closed() => {
                            result = Err(AiError::Cancelled);
                            break;
                        }
                        n = events.next() => n,
                    };
                    match next {
                        None => break,
                        Some(Ok(event)) => {
                            match &event {
                                ChatEvent::Usage(u) => reported = Some(*u),
                                ChatEvent::Text(t) => received_chars += t.chars().count(),
                                ChatEvent::ToolCall { name, arguments, .. } => {
                                    received_chars += name.len() + arguments.to_string().len();
                                }
                                ChatEvent::Done(_) => {}
                            }
                            if tx.send(Ok(event)).await.is_err() {
                                result = Err(AiError::Cancelled);
                                break;
                            }
                        }
                        Some(Err(e)) => {
                            let _ = tx.send(Err(provider_error(&e))).await;
                            result = Err(e);
                            break;
                        }
                    }
                }
            }
        }
        let output_estimate = estimate_tokens(received_chars);
        let used = match reported {
            // Refused before the provider answered: nothing was used.
            _ if !started => Used::default(),
            // A call cut short counts at least what arrived, though its last usage was earlier.
            Some(u) if result.is_err() => {
                Used { usage: Usage { output_tokens: u.output_tokens.max(output_estimate), ..u }, estimated: false }
            }
            Some(u) => Used { usage: u, estimated: false },
            None => {
                Used { usage: Usage { input_tokens: input_estimate, output_tokens: output_estimate }, estimated: true }
            }
        };
        // The place is given back only after the call is settled and audited.
        finish(&state, &caller, &admitted, used, &result).await;
        drop(admitted);
    });
    match started_rx.await {
        Ok(Ok(())) => {}
        Ok(Err(e)) => return Err(e),
        Err(_) => return Err(ApiError::internal("ai", "the AI call ended before it started")),
    }
    Ok(futures_util::stream::unfold(rx, |mut rx| async move { rx.recv().await.map(|item| (item, rx)) }))
}

/// What the UI needs to show or hide AI for the signed-in user in one organization.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct AiStatus {
    /// `ai.enabled` of the server and the organization. Off, nothing else is sent but
    /// `orgProvidersAllowed`.
    pub enabled: bool,
    /// AI can be used here: on, and a provider is in effect for the organization.
    pub usable: bool,
    /// Whether the server lets organizations use a provider of their own
    /// (`ai.allow_org_providers`), so an organization's AI page knows before AI is on.
    pub org_providers_allowed: bool,
    /// Whether the caller acknowledged the first-use notice for the provider in effect; the UI
    /// shows the notice before the first call otherwise (`POST .../ai/notice`).
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub notice_acknowledged: Option<bool>,
    /// Why it cannot be used when it is on (`ai.no_provider`).
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub provider: Option<AiStatusProvider>,
    /// The provider of each function (explain and draft, summarize, the chat).
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub functions: Option<AiStatusFunctions>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub usage: Option<AiStatusUsage>,
    /// The paragraph the administrators added to the first-use notice (`ai.notice_text`), when set.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub notice_text: Option<String>,
    /// The most rows, documents or nodes of one result AI receives (`ai.max_rows_to_model`).
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub max_rows_to_model: Option<i64>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct AiStatusProvider {
    /// What the first-use notice is acknowledged for.
    pub id: String,
    /// The name the administrators gave it.
    pub name: String,
    /// `openai` or `anthropic`.
    pub kind: String,
    pub model: String,
    /// Where data goes: the host of the provider's base URL (never the whole URL).
    pub host: String,
    /// `org` when the organization's own provider is in effect, else `server`.
    pub scope: String,
    /// Host and port of the base URL (`llm.intern:11434`), never the path or credentials.
    pub endpoint: String,
    /// Whether data leaves the installation's own network, judged from the address
    /// (`stays_in_network`).
    pub leaves_network: bool,
    /// The last connection test: passed, failed, or (absent) not tested since the last change.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub reachable: Option<bool>,
    /// Whether the caller acknowledged the first-use notice for this provider.
    pub notice_acknowledged: bool,
}

/// The provider in effect for each function, when the server chose one per function (board
/// AI.dc.html frame 2). Equal to `provider` where nothing was chosen.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct AiStatusFunctions {
    pub explain: AiStatusProvider,
    pub summarize: AiStatusProvider,
    pub chat: AiStatusProvider,
}

/// The caller's tokens and calls today, the organization's tokens this month, and the limits
/// (0: none). Counts only; Kalzit shows no prices.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct AiStatusUsage {
    pub requests: i64,
    pub tokens: i64,
    pub requests_limit: i64,
    pub tokens_limit: i64,
    pub org_tokens_month: i64,
    pub org_tokens_month_limit: i64,
}

impl AiStatus {
    fn off(org_providers_allowed: bool) -> Self {
        Self {
            enabled: false,
            usable: false,
            org_providers_allowed,
            notice_acknowledged: None,
            reason: None,
            provider: None,
            functions: None,
            usage: None,
            notice_text: None,
            max_rows_to_model: None,
        }
    }
}

/// A provider as the status names it, with the caller's acknowledgement of its notice.
async fn status_provider(state: &AppState, user_id: &str, row: ProviderRow) -> ApiResult<AiStatusProvider> {
    let url = url::Url::parse(&row.base_url).ok();
    let host = url.as_ref().and_then(|u| u.host_str().map(str::to_string)).unwrap_or_default();
    let endpoint = match url.as_ref().and_then(url::Url::port_or_known_default) {
        Some(port) if !host.is_empty() => format!("{host}:{port}"),
        _ => host.clone(),
    };
    Ok(AiStatusProvider {
        notice_acknowledged: store::notice_acknowledged(&state.db, user_id, &row.id).await?,
        leaves_network: !stays_in_network(&row.base_url),
        reachable: row.last_test_ok.map(|ok| ok != 0),
        scope: if row.org_id.is_some() { "org" } else { "server" }.into(),
        endpoint,
        id: row.id,
        name: row.name,
        kind: row.kind,
        model: row.model,
        host,
    })
}

pub async fn status(state: &AppState, org_id: &str, user_id: &str) -> ApiResult<AiStatus> {
    let allowed = org_providers_allowed(state).await?;
    if !enabled(state).await? || !enabled_in_org(state, org_id).await? {
        return Ok(AiStatus::off(allowed));
    }
    let Some(row) = in_effect(state, org_id).await? else {
        return Ok(AiStatus { enabled: true, reason: Some("ai.no_provider".into()), ..AiStatus::off(allowed) });
    };
    let (user, _) = today(state, org_id, user_id).await?;
    let month = month_tokens(state, org_id).await?;
    let limits = limits(state, org_id).await?;
    let acknowledged = store::notice_acknowledged(&state.db, user_id, &row.id).await?;
    let clamp = |n: u64| i64::try_from(n).unwrap_or(i64::MAX);
    let notice_text = settings::get(state, "ai.notice_text")
        .await?
        .as_str()
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(str::to_string);
    let max_rows = i64::try_from(max_rows_to_model(state).await?).unwrap_or(i64::MAX);
    let provider = status_provider(state, user_id, row).await?;
    let mut by_function = Vec::new();
    for function in FUNCTIONS {
        by_function.push(match in_effect_for(state, org_id, Some(function)).await? {
            Some(row) if row.id != provider.id => status_provider(state, user_id, row).await?,
            _ => provider.clone(),
        });
    }
    let [explain, summarize, chat]: [AiStatusProvider; 3] =
        by_function.try_into().map_err(|_| ApiError::internal("ai", "one provider per function"))?;
    Ok(AiStatus {
        enabled: true,
        usable: true,
        org_providers_allowed: allowed,
        notice_acknowledged: Some(acknowledged),
        reason: None,
        provider: Some(provider),
        functions: Some(AiStatusFunctions { explain, summarize, chat }),
        usage: Some(AiStatusUsage {
            requests: user.requests,
            tokens: user.tokens,
            requests_limit: clamp(limits.user_requests),
            tokens_limit: clamp(limits.user_tokens),
            org_tokens_month: month,
            org_tokens_month_limit: clamp(limits.org_tokens_month),
        }),
        notice_text,
        max_rows_to_model: Some(max_rows),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn addresses_in_the_own_network_are_told_apart() {
        for own in [
            "http://localhost:11434/v1",
            "http://127.0.0.1:8000",
            "http://10.0.0.5/v1",
            "http://192.168.1.2",
            "http://[::1]:1/",
            "http://[fd00::1]/",
            "http://ollama:11434",
            "https://llm.intern/v1",
            "https://gpu.corp/v1",
        ] {
            assert!(stays_in_network(own), "{own}");
        }
        for out in ["https://api.anthropic.com", "https://api.openai.com/v1", "http://8.8.8.8", "not a url"] {
            assert!(!stays_in_network(out), "{out}");
        }
        assert_eq!(function_of("draft_query"), Some("explain"));
        assert_eq!(function_of("summarize_result"), Some("summarize"));
        assert_eq!(function_of("test"), None);
    }

    #[test]
    fn days_are_utc() {
        assert_eq!(day_of(0), "1970-01-01");
        assert_eq!(day_of(1_800_000_000_000), "2027-01-15");
        assert_eq!(until_next_day(0), Duration::from_secs(24 * 60 * 60));
        assert_eq!(until_next_day(24 * 60 * 60 * 1000 - 1), Duration::from_secs(1));
    }

    #[test]
    fn limits_of_zero_are_no_limit() {
        let none = Limits { user_requests: 0, user_tokens: 0, org_tokens_month: 0 };
        let used = Counts { requests: 1_000_000, tokens: 1_000_000_000, reserved: 0 };
        assert!(check_limits(&none, used, i64::MAX, 0).is_ok());
        let some = Limits { user_requests: 2, user_tokens: 0, org_tokens_month: 100 };
        let e = check_limits(&some, Counts { requests: 2, tokens: 0, reserved: 0 }, 0, 0).unwrap_err();
        assert_eq!(e.reason.unwrap().code, "ai.limit_user_requests");
        let e = check_limits(&some, Counts { requests: 1, tokens: 0, reserved: 0 }, 100, 0).unwrap_err();
        assert_eq!(e.reason.as_ref().unwrap().code, "ai.limit_org_tokens");
        assert!(e.retry_after_secs.unwrap().get() > 24 * 60 * 60, "until the month ends");
    }

    #[test]
    fn an_organization_only_lowers_limits() {
        assert_eq!(stricter(200, 50), 50);
        assert_eq!(stricter(200, 500), 200);
        assert_eq!(stricter(0, 50), 50, "the server has none, the organization sets one");
        assert_eq!(stricter(200, 0), 200, "0 in the organization follows the server");
    }

    #[test]
    fn months_are_utc() {
        // 2027-01-15 10:40 UTC: the next month starts on 2027-02-01.
        let now = 1_800_000_000_000;
        assert_eq!(month_start(now), "2027-01-01");
        let feb = chrono::NaiveDate::from_ymd_opt(2027, 2, 1).unwrap().and_hms_opt(0, 0, 0).unwrap();
        assert_eq!(until_next_month(now).as_millis() as i64, feb.and_utc().timestamp_millis() - now);
        let december = chrono::NaiveDate::from_ymd_opt(2026, 12, 31).unwrap().and_hms_opt(23, 0, 0).unwrap();
        assert_eq!(until_next_month(december.and_utc().timestamp_millis()), Duration::from_secs(3600));
    }

    #[test]
    fn slots_are_given_back() {
        let runtime = Arc::new(AiRuntime::default());
        let max = AtOnce { total: 3, org: 2, user: 1 };
        let code = |e: ApiError| e.reason.unwrap().code;
        let a = runtime.acquire("o1", "u1", max).unwrap();
        assert_eq!(code(runtime.acquire("o1", "u1", max).unwrap_err()), "ai.limit_user_concurrent");
        let b = runtime.acquire("o1", "u2", max).unwrap();
        assert_eq!(code(runtime.acquire("o1", "u3", max).unwrap_err()), "ai.limit_org_concurrent");
        let c = runtime.acquire("o2", "u4", max).unwrap();
        assert_eq!(code(runtime.acquire("o3", "u5", max).unwrap_err()), "ai.limit_concurrent");
        drop((a, b, c));
        assert_eq!(runtime.running(), 0);
        assert!(runtime.acquire("o1", "u1", max).is_ok());
    }

    #[test]
    fn budgets_cover_the_input_and_the_answer() {
        let request = ChatRequest { messages: vec![super::super::Message::user("x".repeat(40))], ..Default::default() };
        assert_eq!(budget(&request), 10 + i64::from(super::super::DEFAULT_MAX_TOKENS));
        let small = ChatRequest { max_tokens: Some(16), ..request };
        assert_eq!(budget(&small), 26);
        assert_eq!(estimate_tokens(0), 0);
        assert_eq!(estimate_tokens(5), 2);
    }
}
