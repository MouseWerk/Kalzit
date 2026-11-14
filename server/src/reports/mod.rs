//! Reports (docs/guide/reports.md): a dashboard, all of its panels or some, with a time range and
//! fixed variable values, rendered as PDF and/or CSV on a schedule and sent by mail.
//!
//! - `model`: the report as the API takes and answers it; `schedule` and `range`: when it runs and
//!   which time it shows, both in the report's time zone.
//! - `gather`: runs the panels' stored queries and steps with the rights of the report's owner and
//!   keeps every result in its own shape; `pdf` draws them (Kalzit's own renderer, no browser),
//!   `csv` writes the tables.
//! - `run`: one run, from the rights check to the mail; `worker`: the queue of runs on the leading
//!   server, filled by the schedule and by "send now", and the retention of the history.
//!
//! The routes live in `routes::reports`.

pub mod csv;
pub mod gather;
pub mod model;
pub mod pdf;
pub mod range;
pub mod run;
pub mod schedule;
pub mod worker;

use crate::app::AppState;
use crate::auth::ratelimit::{Capacity, RateLimiter};
use crate::error::ApiResult;

/// Previews per person and minute.
pub const PREVIEWS_PER_MINUTE: u32 = 6;
/// Reports rendered at once on a server (runs and previews together): rendering takes CPU time.
pub const MAX_RENDERING: usize = 2;

/// The reports' part of the server's state.
pub struct Reports {
    /// Wakes the worker after a run was queued.
    pub queued: tokio::sync::Notify,
    /// Places for rendering ([`MAX_RENDERING`]).
    pub rendering: std::sync::Arc<tokio::sync::Semaphore>,
    /// Previews per person.
    pub previews: RateLimiter,
    /// Which organization goes first at the worker's next claim.
    pub turn: std::sync::atomic::AtomicUsize,
}

impl Default for Reports {
    fn default() -> Self {
        Self {
            queued: tokio::sync::Notify::new(),
            rendering: std::sync::Arc::new(tokio::sync::Semaphore::new(MAX_RENDERING)),
            previews: RateLimiter::new(PREVIEWS_PER_MINUTE, 60, Capacity::SMALL),
            turn: std::sync::atomic::AtomicUsize::new(0),
        }
    }
}

/// Whether reports run on this server (`reports.enabled`).
pub async fn enabled(state: &AppState) -> ApiResult<bool> {
    Ok(crate::settings::get(state, "reports.enabled").await?.as_bool().unwrap_or(true))
}

/// Whether reports run for the organization: on for the server and not turned off by it.
pub async fn enabled_for(state: &AppState, org_id: &str) -> ApiResult<bool> {
    Ok(enabled(state).await?
        && crate::settings::get_org(state, org_id, "reports.org_enabled").await?.as_bool().unwrap_or(true))
}

/// Whether the organization lets reports go to addresses outside it.
pub async fn external_allowed(state: &AppState, org_id: &str) -> ApiResult<bool> {
    Ok(crate::settings::get_org(state, org_id, "reports.allow_external_recipients").await?.as_bool().unwrap_or(false))
}

/// The mail domains addresses outside the organization must be in; empty for any.
pub async fn external_domains(state: &AppState, org_id: &str) -> ApiResult<Vec<String>> {
    let value = crate::settings::get_org(state, org_id, "reports.external_domains").await?;
    Ok(value
        .as_array()
        .map(|items| {
            items.iter().filter_map(|d| d.as_str()).map(|d| d.trim().trim_start_matches('@').to_lowercase()).collect()
        })
        .unwrap_or_default())
}

/// Whether `email` (normalized) is in one of `domains` (or `domains` is empty).
pub fn domain_allowed(email: &str, domains: &[String]) -> bool {
    domains.is_empty() || email.rsplit_once('@').is_some_and(|(_, d)| domains.iter().any(|allowed| allowed == d))
}

/// The limits in force (server settings).
pub async fn limits(state: &AppState) -> ApiResult<model::ReportLimits> {
    let int = |v: serde_json::Value, default: u64| v.as_u64().unwrap_or(default);
    Ok(model::ReportLimits {
        max_reports_per_org: int(crate::settings::get(state, "reports.max_reports_per_org").await?, 100),
        max_runs_per_org_hour: int(crate::settings::get(state, "reports.max_runs_per_org_hour").await?, 60),
        max_recipients: int(crate::settings::get(state, "reports.max_recipients").await?, 20),
        max_attachment_bytes: int(crate::settings::get(state, "reports.max_attachment_bytes").await?, 10 << 20),
        history_retention_days: int(crate::settings::get(state, "reports.history_retention_days").await?, 90),
    })
}
