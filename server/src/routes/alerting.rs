//! Alerting routes (docs/api/alerting.md): rules, contact points, silences, history, the status
//! with the limits in force, and the per data source opt-in. Everything is scoped to the
//! organization in the path and checked here: `alerts:read` to see, `alerts:write` for rules and
//! silences, `alerts:contacts` for contact points. Every change is audited, never with a secret.

mod contact_points;
mod datasources;
mod history;
mod panels;
mod preview;
mod rules;
mod silences;

use axum::extract::State;
use axum::http::Method;
use axum::{Extension, Json};
use serde::Serialize;

use super::table::{RouteDef, route};
use crate::alerting::limits::{self, Limits, Switch};
use crate::alerting::service_account::{self, Identity};
use crate::app::AppState;
use crate::authz::{Access, OrgCtx, Permission};
use crate::error::ApiResult;

pub fn routes() -> Vec<RouteDef> {
    let read = Access::Org(Permission::AlertsRead);
    let write = Access::Org(Permission::AlertsWrite);
    let contacts = Access::Org(Permission::AlertsContacts);
    vec![
        route(Method::GET, "/orgs/{orgId}/alerting/status", read, status),
        route(Method::GET, "/orgs/{orgId}/alerting/datasources", read, datasources::opted_in),
        // Rules.
        route(Method::GET, "/orgs/{orgId}/alerting/rules", read, rules::list),
        route(Method::POST, "/orgs/{orgId}/alerting/rules", write, rules::create),
        // "Jetzt auswerten": a draft with the editing person's rights (`datasources:query` on its
        // source, checked in the handler); nothing is stored.
        route(Method::POST, "/orgs/{orgId}/alerting/rules/preview", write, preview::preview).long_running(),
        route(Method::GET, "/orgs/{orgId}/alerting/rules/{ruleId}", read, rules::detail),
        route(Method::PUT, "/orgs/{orgId}/alerting/rules/{ruleId}", write, rules::update),
        route(Method::DELETE, "/orgs/{orgId}/alerting/rules/{ruleId}", write, rules::delete),
        route(Method::POST, "/orgs/{orgId}/alerting/rules/{ruleId}/pause", write, rules::pause),
        route(Method::POST, "/orgs/{orgId}/alerting/rules/{ruleId}/resume", write, rules::resume),
        // Contact points: everyone with `alerts:read` sees the short form.
        route(Method::GET, "/orgs/{orgId}/alerting/contact-points", read, contact_points::list),
        route(Method::POST, "/orgs/{orgId}/alerting/contact-points", contacts, contact_points::create),
        route(Method::GET, "/orgs/{orgId}/alerting/contact-points/{contactPointId}", read, contact_points::detail),
        route(Method::PUT, "/orgs/{orgId}/alerting/contact-points/{contactPointId}", contacts, contact_points::update),
        route(
            Method::DELETE,
            "/orgs/{orgId}/alerting/contact-points/{contactPointId}",
            contacts,
            contact_points::delete,
        ),
        route(
            Method::POST,
            "/orgs/{orgId}/alerting/contact-points/{contactPointId}/secret",
            contacts,
            contact_points::rotate_secret,
        ),
        route(
            Method::POST,
            "/orgs/{orgId}/alerting/contact-points/{contactPointId}/test",
            contacts,
            contact_points::test,
        )
        .long_running(),
        // The badges of a dashboard's panels; read access to the dashboard is checked in the handler.
        route(Method::GET, "/orgs/{orgId}/alerting/panels", read, panels::list),
        // Silences.
        route(Method::GET, "/orgs/{orgId}/alerting/silences", read, silences::list),
        route(Method::POST, "/orgs/{orgId}/alerting/silences", write, silences::create),
        route(Method::POST, "/orgs/{orgId}/alerting/silences/preview", write, silences::preview),
        route(Method::POST, "/orgs/{orgId}/alerting/silences/{silenceId}/expire", write, silences::expire),
        // History.
        route(Method::GET, "/orgs/{orgId}/alerting/history", read, history::list),
        // The opt-in of one data source: read by whoever may read the source, set by whoever may
        // edit it (org-wide or by a grant), so both check the source itself.
        route(Method::GET, "/orgs/{orgId}/datasources/{datasourceId}/alerting", Access::OrgMember, datasources::get),
        route(Method::PUT, "/orgs/{orgId}/datasources/{datasourceId}/alerting", Access::OrgMember, datasources::set),
    ]
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceAccountView {
    id: String,
    name: String,
    /// Fixed: `datasources:query`, only on sources opted in to alerting.
    permissions: Vec<&'static str>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// Rules of this organization are evaluated: on for the server and the organization.
    enabled: bool,
    #[serde(flatten)]
    switch: Switch,
    limits: Limits,
    /// `null` until the first opt-in of a data source or the first rule makes it.
    service_account: Option<ServiceAccountView>,
    /// A mail server is set up (Administration > Mail); without one no mail contact point can be made.
    mail_configured: bool,
    rules: i64,
    paused_rules: i64,
    /// Instances per state.
    instances: std::collections::BTreeMap<String, i64>,
}

fn service_account_view(identity: Identity) -> ServiceAccountView {
    ServiceAccountView {
        id: identity.id,
        name: identity.name,
        permissions: service_account::PERMISSIONS.iter().map(|p| p.as_str()).collect(),
    }
}

/// Whether alerting is on, the limits in force, the alerting identity and counts.
async fn status(State(state): State<AppState>, Extension(ctx): Extension<OrgCtx>) -> ApiResult<Json<Status>> {
    let switch = limits::switch(&state, &ctx.org_id).await?;
    let limits = limits::for_org(&state, &ctx.org_id).await?;
    let identity = service_account::existing(&state.db, &ctx.org_id).await?;
    let (rules, paused_rules): (i64, i64) =
        sqlx::query_as("SELECT COUNT(*), COUNT(CASE WHEN paused <> 0 THEN 1 END) FROM alert_rules WHERE org_id = $1")
            .bind(&ctx.org_id)
            .fetch_one(&state.db)
            .await?;
    let counts: Vec<(String, i64)> =
        sqlx::query_as("SELECT state, COUNT(*) FROM alert_instances WHERE org_id = $1 GROUP BY state")
            .bind(&ctx.org_id)
            .fetch_all(&state.db)
            .await?;
    Ok(Json(Status {
        enabled: switch.enabled(),
        switch,
        limits,
        service_account: identity.map(service_account_view),
        mail_configured: crate::mail::settings::effective(&state).await?.configured(),
        rules,
        paused_rules,
        instances: counts.into_iter().collect(),
    }))
}

/// Whether the caller sees what a rule's data says (instance labels, values and the parameters of
/// an evaluation error): only with `datasources:read` or `datasources:query` on its source, as
/// for the query text. Everyone else with `alerts:read` sees states and counts only.
fn data_visible(access: &crate::authz::DatasourceAccess, datasource_id: &str) -> bool {
    access
        .permissions(datasource_id)
        .is_some_and(|held| held.contains(&Permission::DatasourcesRead) || held.contains(&Permission::DatasourcesQuery))
}

/// A stored error as `{code}` only, without the parameters taken from the data. The limits of
/// `alerting.label_too_long` are the server's, not the data's, and stay.
fn error_code_only(error: Option<serde_json::Value>) -> Option<serde_json::Value> {
    error.map(|e| {
        if e.get("code").and_then(|c| c.as_str()) == Some("alerting.label_too_long") {
            e
        } else {
            serde_json::json!({ "code": e.get("code").cloned().unwrap_or_default() })
        }
    })
}

/// The labels silences are matched against for a caller who may not see the rule's data: the
/// rule's name only, so whether a silence matches tells nothing about hidden labels.
fn hidden_silence_labels(rule_name: &str) -> std::collections::BTreeMap<String, String> {
    [(crate::alerting::rule::RULE_NAME_LABEL.to_string(), rule_name.to_string())].into()
}

/// The fingerprint of a hidden instance as the caller sees it: an id that is the same within
/// one answer only, since the fingerprint is a hash of the hidden labels.
fn hidden_fingerprint(index: usize) -> String {
    format!("hidden-{index}")
}

/// A path id that cannot be one of ours is not found, before any query.
fn known_id(id: &str) -> ApiResult<()> {
    if uuid::Uuid::parse_str(id).is_ok() { Ok(()) } else { Err(crate::error::ApiError::not_found()) }
}
