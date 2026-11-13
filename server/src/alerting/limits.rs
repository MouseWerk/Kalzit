//! Alerting's switch and limits in force for an organization: the server's settings, with an
//! organization's own values only where they are stricter (fewer, shorter, or a longer shortest
//! interval). An organization's value beyond the server's is ignored, never an error, so a later
//! change of the server's limit applies at once.

use serde::Serialize;

use crate::app::AppState;
use crate::error::ApiResult;
use crate::settings;

/// The limits in force for one organization.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Limits {
    pub min_interval_secs: u64,
    pub evaluation_timeout_secs: u64,
    pub max_concurrent: u64,
    pub max_concurrent_per_org: u64,
    pub max_concurrent_per_datasource: u64,
    pub max_rules_per_org: u64,
    pub max_instances_per_rule: u64,
    pub max_contact_points_per_rule: u64,
    /// Active and planned silences of one organization.
    pub max_silences_per_org: u64,
    pub max_contact_points_per_org: u64,
    /// Messages one organization sends per hour (first attempts).
    pub max_messages_per_org_hour: u64,
    pub webhook_max_bytes: u64,
    pub history_retention_days: u64,
    /// Notification policies of one organization, the root included.
    pub max_policies_per_org: u64,
    /// Levels below the root.
    pub max_policy_depth: u64,
    /// Groups with instances in one organization; beyond, new instances go to a catch-all group.
    pub max_active_groups_per_org: u64,
}

async fn server_u64(state: &AppState, key: &str) -> ApiResult<u64> {
    let value = settings::get(state, key).await?;
    let fallback = settings::find(key, settings::Scope::Server).and_then(|d| (d.default)().as_u64()).unwrap_or(0);
    Ok(value.as_u64().unwrap_or(fallback))
}

/// The organization's own value (`None` while it inherits).
async fn org_u64(state: &AppState, org_id: &str, key: &str) -> ApiResult<Option<u64>> {
    Ok(settings::get_org(state, org_id, key).await?.as_u64())
}

/// The server's limit, or the organization's when it is lower.
async fn lower(state: &AppState, org_id: &str, key: &str) -> ApiResult<u64> {
    let server = server_u64(state, key).await?;
    Ok(org_u64(state, org_id, key).await?.map_or(server, |own| own.min(server)))
}

pub async fn for_org(state: &AppState, org_id: &str) -> ApiResult<Limits> {
    let server_interval = server_u64(state, "alerting.min_interval_secs").await?;
    let min_interval_secs = org_u64(state, org_id, "alerting.min_interval_secs")
        .await?
        .map_or(server_interval, |own| own.max(server_interval));
    Ok(Limits {
        min_interval_secs,
        evaluation_timeout_secs: lower(state, org_id, "alerting.evaluation_timeout_secs").await?,
        max_concurrent: server_u64(state, "alerting.max_concurrent").await?,
        max_concurrent_per_org: lower(state, org_id, "alerting.max_concurrent_per_org").await?,
        max_concurrent_per_datasource: server_u64(state, "alerting.max_concurrent_per_datasource").await?,
        max_rules_per_org: lower(state, org_id, "alerting.max_rules_per_org").await?,
        max_instances_per_rule: lower(state, org_id, "alerting.max_instances_per_rule").await?,
        max_contact_points_per_rule: lower(state, org_id, "alerting.max_contact_points_per_rule").await?,
        max_silences_per_org: lower(state, org_id, "alerting.max_silences_per_org").await?,
        max_contact_points_per_org: lower(state, org_id, "alerting.max_contact_points_per_org").await?,
        max_messages_per_org_hour: lower(state, org_id, "alerting.max_messages_per_org_hour").await?,
        webhook_max_bytes: server_u64(state, "alerting.webhook_max_bytes").await?,
        history_retention_days: lower(state, org_id, "alerting.history_retention_days").await?,
        max_policies_per_org: lower(state, org_id, "alerting.max_policies_per_org").await?,
        max_policy_depth: lower(state, org_id, "alerting.max_policy_depth").await?,
        max_active_groups_per_org: lower(state, org_id, "alerting.max_active_groups_per_org").await?,
    })
}

impl Limits {
    /// Evaluations that may query one data source at once: the server's
    /// `alerting.max_concurrent_per_datasource`, or the source's own `alerting_max_concurrent`
    /// when it is lower.
    pub fn datasource_concurrency(&self, source: Option<i64>) -> u64 {
        let server = self.max_concurrent_per_datasource;
        source.and_then(|n| u64::try_from(n).ok()).filter(|n| *n > 0).map_or(server, |n| n.min(server))
    }
}

/// Whether rules are evaluated: on for the server (`alerting.enabled`) and for the organization
/// (`alerting.org_enabled`). Rules are kept either way.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Switch {
    pub server_enabled: bool,
    pub org_enabled: bool,
}

impl Switch {
    pub fn enabled(self) -> bool {
        self.server_enabled && self.org_enabled
    }
}

pub async fn switch(state: &AppState, org_id: &str) -> ApiResult<Switch> {
    let server_enabled = settings::get(state, "alerting.enabled").await?.as_bool().unwrap_or(true);
    let org_enabled = settings::get_org(state, org_id, "alerting.org_enabled").await?.as_bool().unwrap_or(true);
    Ok(Switch { server_enabled, org_enabled })
}
