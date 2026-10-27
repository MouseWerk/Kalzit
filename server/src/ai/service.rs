//! Whether an AI call may run, and its bookkeeping. Every call names the organization and user it
//! runs for and its purpose; it runs only when `ai.enabled` is on and a provider is in effect for
//! the organization (its own default, else the server's), within the daily limits per user and
//! organization and the concurrency limits. A call counts when it starts; its tokens are added and
//! its audit entry (who, provider, model, tokens, purpose, outcome; never the prompt or the answer)
//! is written when it ends.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::http::StatusCode;
use futures_util::{Stream, StreamExt};
use serde::Serialize;
use serde_json::json;
use tokio_util::sync::CancellationToken;

use super::store::{self, ProviderRow};
use super::{AiError, ChatEvent, ChatRequest, ChatResponse, Provider, ProviderConfig, ProviderKind, Usage};
use crate::app::AppState;
use crate::audit::{self, AuditEvent};
use crate::error::{ApiError, ApiResult};
use crate::settings;

/// Calls running now, on the whole server and per user.
#[derive(Default)]
pub struct AiRuntime {
    running: Mutex<Running>,
}

#[derive(Default)]
struct Running {
    total: usize,
    per_user: HashMap<String, usize>,
}

/// A place among the running calls, given back when dropped.
pub struct Slot {
    runtime: Arc<AiRuntime>,
    user_id: String,
}

impl std::fmt::Debug for Slot {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Slot").field("user_id", &self.user_id).finish()
    }
}

impl Drop for Slot {
    fn drop(&mut self) {
        let mut running = self.runtime.running.lock().expect("AI runtime lock");
        running.total = running.total.saturating_sub(1);
        if let Some(n) = running.per_user.get_mut(&self.user_id) {
            *n -= 1;
            if *n == 0 {
                running.per_user.remove(&self.user_id);
            }
        }
    }
}

/// How long a caller refused for concurrency is asked to wait.
const BUSY_RETRY: Duration = Duration::from_secs(5);

impl AiRuntime {
    /// A slot when fewer than `max_total` calls run and fewer than `max_user` of this user's.
    fn acquire(self: &Arc<Self>, user_id: &str, max_total: usize, max_user: usize) -> ApiResult<Slot> {
        let mut running = self.running.lock().expect("AI runtime lock");
        if running.per_user.get(user_id).copied().unwrap_or(0) >= max_user {
            return Err(ApiError::rate_limited(format!("at most {max_user} AI calls per user at once"), BUSY_RETRY)
                .because("ai.limit_user_concurrent")
                .param("max", max_user));
        }
        if running.total >= max_total {
            return Err(ApiError::rate_limited(format!("at most {max_total} AI calls at once"), BUSY_RETRY)
                .because("ai.limit_concurrent")
                .param("max", max_total));
        }
        running.total += 1;
        *running.per_user.entry(user_id.to_string()).or_default() += 1;
        Ok(Slot { runtime: self.clone(), user_id: user_id.to_string() })
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

/// The most rows, documents or nodes of one result AI receives (`ai.max_rows_to_model`).
pub async fn max_rows_to_model(state: &AppState) -> ApiResult<usize> {
    Ok(usize::try_from(setting_u64(state, "ai.max_rows_to_model").await?).unwrap_or(usize::MAX))
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

/// Today's counts of one user in one organization, and of the organization.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Counts {
    pub requests: i64,
    pub tokens: i64,
}

pub async fn today(state: &AppState, org_id: &str, user_id: &str) -> ApiResult<(Counts, Counts)> {
    let day = day_of(state.clock.now_ms());
    let rows: Vec<(String, i64, i64, i64)> = sqlx::query_as(
        "SELECT user_id, requests, input_tokens, output_tokens FROM ai_usage WHERE day = $1 AND org_id = $2",
    )
    .bind(&day)
    .bind(org_id)
    .fetch_all(&state.db)
    .await?;
    let (mut user, mut org) = (Counts::default(), Counts::default());
    for (who, requests, input, output) in rows {
        org.requests += requests;
        org.tokens += input + output;
        if who == user_id {
            user.requests += requests;
            user.tokens += input + output;
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

/// Tokens all members of an organization used this calendar month (UTC).
pub async fn month_tokens(state: &AppState, org_id: &str) -> ApiResult<i64> {
    let now = state.clock.now_ms();
    let (tokens,): (i64,) = sqlx::query_as(
        "SELECT CAST(COALESCE(SUM(input_tokens + output_tokens), 0) AS BIGINT) FROM ai_usage \
         WHERE org_id = $1 AND day >= $2",
    )
    .bind(org_id)
    .bind(month_start(now))
    .fetch_one(&state.db)
    .await?;
    Ok(tokens)
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
/// this month.
fn check_limits(limits: &Limits, user: Counts, org_month_tokens: i64, now: i64) -> ApiResult<()> {
    let over = |limit: u64, used: i64| limit > 0 && used >= i64::try_from(limit).unwrap_or(i64::MAX);
    let daily = [
        (limits.user_requests, user.requests, "ai.limit_user_requests"),
        (limits.user_tokens, user.tokens, "ai.limit_user_tokens"),
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
    let config = ProviderConfig { kind, base_url, model: row.model.clone(), api_key, timeout };
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

/// Checks everything before a call and takes its place: the switch, the provider, the limits.
async fn admit(state: &AppState, caller: &Caller) -> ApiResult<(ProviderRow, Box<dyn Provider>, Slot)> {
    if !enabled(state).await? {
        return Err(unavailable("ai.disabled", "AI is turned off on this server"));
    }
    if !enabled_in_org(state, &caller.org_id).await? {
        return Err(unavailable("ai.org_disabled", "AI is turned off in this organization"));
    }
    let (row, provider) = provider_for(state, &caller.org_id).await?;
    // The person saw what leaves the server, and to which provider, before the first call.
    if !store::notice_acknowledged(&state.db, &caller.user_id, &row.id).await? {
        return Err(unavailable("ai.notice_required", "the AI notice for this provider was not acknowledged yet"));
    }
    let now = state.clock.now_ms();
    let (user, _) = today(state, &caller.org_id, &caller.user_id).await?;
    let month = month_tokens(state, &caller.org_id).await?;
    check_limits(&limits(state, &caller.org_id).await?, user, month, now)?;
    let max_total = setting_u64(state, "ai.max_concurrent").await? as usize;
    let max_user = setting_u64(state, "ai.max_concurrent_per_user").await? as usize;
    let slot = state.ai.acquire(&caller.user_id, max_total, max_user)?;
    // Counted at the start, so calls that run at once cannot all pass the limit.
    count(state, caller, now, 1, Usage::default()).await?;
    Ok((row, provider, slot))
}

async fn count(state: &AppState, caller: &Caller, now: i64, requests: i64, usage: Usage) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO ai_usage (day, org_id, user_id, requests, input_tokens, output_tokens) \
         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (day, org_id, user_id) DO UPDATE SET \
         requests = ai_usage.requests + excluded.requests, \
         input_tokens = ai_usage.input_tokens + excluded.input_tokens, \
         output_tokens = ai_usage.output_tokens + excluded.output_tokens",
    )
    .bind(day_of(now))
    .bind(&caller.org_id)
    .bind(&caller.user_id)
    .bind(requests)
    .bind(i64::try_from(usage.input_tokens).unwrap_or(i64::MAX))
    .bind(i64::try_from(usage.output_tokens).unwrap_or(i64::MAX))
    .execute(&state.db)
    .await?;
    Ok(())
}

/// How a call ended, for its audit entry.
fn outcome(result: &Result<(), AiError>) -> (&'static str, Option<&'static str>) {
    match result {
        Ok(()) => ("ok", None),
        Err(AiError::Cancelled) => ("cancelled", None),
        Err(e) => ("failed", Some(e.detail().reason)),
    }
}

/// Adds the tokens and writes the audit entry of a call that ended.
async fn finish(
    state: &AppState,
    caller: &Caller,
    row: &ProviderRow,
    usage: Usage,
    result: &Result<(), AiError>,
) -> ApiResult<()> {
    let now = state.clock.now_ms();
    count(state, caller, now, 0, usage).await?;
    let (outcome, reason) = outcome(result);
    let mut summary = json!({
        "purpose": caller.purpose,
        "providerKind": row.kind,
        "providerScope": if row.org_id.is_some() { "org" } else { "server" },
        "model": row.model,
        "inputTokens": usage.input_tokens,
        "outputTokens": usage.output_tokens,
        "outcome": outcome,
    });
    if let Some(reason) = reason {
        summary["reason"] = json!(reason);
    }
    let mut tx = crate::db::begin(&state.db).await?;
    audit::record(
        &mut tx,
        &AuditEvent {
            org_id: Some(&caller.org_id),
            actor_user_id: Some(&caller.user_id),
            actor_address: caller.address.clone(),
            action: "ai.called",
            resource_type: Some("ai_provider"),
            resource_id: Some(&row.id),
            summary,
            at_ms: now,
        },
    )
    .await?;
    crate::db::commit(tx).await?;
    Ok(())
}

/// Runs a whole call for `caller` and returns the answer.
pub async fn complete(
    state: &AppState,
    caller: &Caller,
    request: &ChatRequest,
    cancel: &CancellationToken,
) -> ApiResult<ChatResponse> {
    let (row, provider, slot) = admit(state, caller).await?;
    let result = super::complete(provider.as_ref(), request, cancel).await;
    drop(slot);
    let usage = result.as_ref().map(|r| r.usage).unwrap_or_default();
    finish(state, caller, &row, usage, &result.as_ref().map(|_| ()).map_err(Clone::clone)).await?;
    result.map_err(|e| provider_error(&e))
}

/// A streamed call for `caller`. The events come as the provider sends them; when the stream ends
/// or is dropped, the call is counted and audited, and its place among the running calls freed.
/// Dropping the stream cancels the call.
pub async fn stream(
    state: &AppState,
    caller: &Caller,
    request: &ChatRequest,
    cancel: &CancellationToken,
) -> ApiResult<impl Stream<Item = Result<ChatEvent, ApiError>> + Send + use<>> {
    let (row, provider, slot) = admit(state, caller).await?;
    // A token of its own, so dropping the stream stops the provider without touching the caller's.
    let call = cancel.child_token();
    let started = provider.stream(request, &call).await;
    let mut events = match started {
        Ok(events) => events,
        Err(e) => {
            drop(slot);
            finish(state, caller, &row, Usage::default(), &Err(e.clone())).await?;
            return Err(provider_error(&e));
        }
    };
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<ChatEvent, ApiError>>(64);
    let state = state.clone();
    let caller = caller.clone();
    tokio::spawn(async move {
        let _slot = slot;
        let _stop = call.clone().drop_guard();
        let mut usage = Usage::default();
        let mut result = Ok(());
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
                    if let ChatEvent::Usage(u) = &event {
                        usage = *u;
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
        drop(events);
        if let Err(e) = finish(&state, &caller, &row, usage, &result).await {
            tracing::warn!("recording an AI call failed: {}", e.message);
        }
    });
    Ok(futures_util::stream::unfold(rx, |mut rx| async move { rx.recv().await.map(|item| (item, rx)) }))
}

/// What the UI needs to show or hide AI for the signed-in user in one organization.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct AiStatus {
    /// `ai.enabled` of the server and the organization. Off, nothing else is sent.
    pub enabled: bool,
    /// AI can be used here: on, and a provider is in effect for the organization.
    pub usable: bool,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub usage: Option<AiStatusUsage>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct AiStatusProvider {
    /// What the first-use notice is acknowledged for.
    pub id: String,
    /// `openai` or `anthropic`.
    pub kind: String,
    pub model: String,
    /// Where data goes: the host of the provider's base URL (never the whole URL).
    pub host: String,
    /// `org` when the organization's own provider is in effect, else `server`.
    pub scope: String,
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
    fn off() -> Self {
        Self { enabled: false, usable: false, notice_acknowledged: None, reason: None, provider: None, usage: None }
    }
}

pub async fn status(state: &AppState, org_id: &str, user_id: &str) -> ApiResult<AiStatus> {
    if !enabled(state).await? || !enabled_in_org(state, org_id).await? {
        return Ok(AiStatus::off());
    }
    let Some(row) = in_effect(state, org_id).await? else {
        return Ok(AiStatus { enabled: true, reason: Some("ai.no_provider".into()), ..AiStatus::off() });
    };
    let (user, _) = today(state, org_id, user_id).await?;
    let month = month_tokens(state, org_id).await?;
    let limits = limits(state, org_id).await?;
    let acknowledged = store::notice_acknowledged(&state.db, user_id, &row.id).await?;
    let clamp = |n: u64| i64::try_from(n).unwrap_or(i64::MAX);
    let host = url::Url::parse(&row.base_url).ok().and_then(|u| u.host_str().map(str::to_string)).unwrap_or_default();
    Ok(AiStatus {
        enabled: true,
        usable: true,
        notice_acknowledged: Some(acknowledged),
        reason: None,
        provider: Some(AiStatusProvider {
            scope: if row.org_id.is_some() { "org" } else { "server" }.into(),
            id: row.id,
            kind: row.kind,
            model: row.model,
            host,
        }),
        usage: Some(AiStatusUsage {
            requests: user.requests,
            tokens: user.tokens,
            requests_limit: clamp(limits.user_requests),
            tokens_limit: clamp(limits.user_tokens),
            org_tokens_month: month,
            org_tokens_month_limit: clamp(limits.org_tokens_month),
        }),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

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
        let used = Counts { requests: 1_000_000, tokens: 1_000_000_000 };
        assert!(check_limits(&none, used, i64::MAX, 0).is_ok());
        let some = Limits { user_requests: 2, user_tokens: 0, org_tokens_month: 100 };
        let e = check_limits(&some, Counts { requests: 2, tokens: 0 }, 0, 0).unwrap_err();
        assert_eq!(e.reason.unwrap().code, "ai.limit_user_requests");
        let e = check_limits(&some, Counts { requests: 1, tokens: 0 }, 100, 0).unwrap_err();
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
        let a = runtime.acquire("u1", 2, 1).unwrap();
        assert_eq!(runtime.acquire("u1", 2, 1).unwrap_err().reason.unwrap().code, "ai.limit_user_concurrent");
        let b = runtime.acquire("u2", 2, 1).unwrap();
        assert_eq!(runtime.acquire("u3", 2, 1).unwrap_err().reason.unwrap().code, "ai.limit_concurrent");
        drop(a);
        drop(b);
        assert_eq!(runtime.running(), 0);
        assert!(runtime.acquire("u1", 2, 1).is_ok());
    }
}
