//! The alert badge of a dashboard's panels (docs/api/alerting.md, "Panel badges"): per panel the
//! rules made from it, their states and conditions, and whether silences hold back what fires.
//! Only for people who may read the dashboard and have `alerts:read`.

use std::collections::BTreeMap;

use axum::extract::State;
use axum::{Extension, Json};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::known_id;
use crate::alerting::evaluate::{active_silences, with_rule_name};
use crate::app::AppState;
use crate::authz::{DatasourceAccess, OrgCtx, Permission, Resource, check_resource};
use crate::error::{ApiError, ApiResult};
use crate::routes::support::QueryParams;
use crate::shapes::Page;

/// Instances listed per rule in the badge's popover.
const MAX_INSTANCES: usize = 10;
/// Most severe first.
const SEVERITY: [&str; 5] = ["firing", "error", "no_data", "pending", "ok"];

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PanelsQuery {
    dashboard_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BadgeInstance {
    labels: BTreeMap<String, String>,
    state: String,
    state_since: i64,
    pending_target: Option<String>,
    last_value: Option<f64>,
    silenced: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BadgeRule {
    id: String,
    name: String,
    /// The most severe state of its instances; `null` while it has none.
    state: Option<String>,
    paused: bool,
    /// The caller may neither read nor query the rule's source: the instances carry no labels
    /// and no values.
    data_hidden: bool,
    /// The condition, for the dashed line of the limit.
    condition: Value,
    instance_counts: BTreeMap<String, i64>,
    /// Every instance that is not OK is held back by a silence.
    silenced: bool,
    /// The instances that are not OK, most severe first, at most 10.
    instances: Vec<BadgeInstance>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PanelBadge {
    panel_id: String,
    /// The most severe state of its rules.
    state: Option<String>,
    /// Every rule that is not OK is silenced.
    silenced: bool,
    rules: Vec<BadgeRule>,
}

fn rank(state: &str) -> usize {
    SEVERITY.iter().position(|s| *s == state).unwrap_or(SEVERITY.len())
}

fn worst<'a>(states: impl Iterator<Item = &'a str>) -> Option<String> {
    states.min_by_key(|s| rank(s)).map(str::to_string)
}

type InstanceRow = (String, String, String, i64, Option<String>, Option<f64>);

/// `GET /orgs/{orgId}/alerting/panels?dashboardId=` (`alerts:read` and read access to the dashboard).
pub async fn list(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    QueryParams(q): QueryParams<PanelsQuery>,
) -> ApiResult<Json<Page<PanelBadge>>> {
    known_id(&q.dashboard_id)?;
    let found: Option<(String,)> =
        sqlx::query_as("SELECT id FROM dashboards WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL")
            .bind(&q.dashboard_id)
            .bind(&ctx.org_id)
            .fetch_optional(&state.db)
            .await?;
    if found.is_none() {
        return Err(ApiError::not_found());
    }
    check_resource(&state.db, &ctx, Permission::DashboardsRead, Resource::Dashboard(&q.dashboard_id)).await?;
    let access = DatasourceAccess::load(&state.db, &ctx).await?;
    let rules: Vec<(String, String, String, i64, String, String)> = sqlx::query_as(
        "SELECT id, name, panel_id, paused, condition, datasource_id FROM alert_rules \
         WHERE org_id = $1 AND dashboard_id = $2 AND panel_id IS NOT NULL ORDER BY panel_id, name, id",
    )
    .bind(&ctx.org_id)
    .bind(&q.dashboard_id)
    .fetch_all(&state.db)
    .await?;
    let mut conn = state.db.acquire().await?;
    let silences = active_silences(&mut conn, &ctx.org_id, state.clock.now_ms()).await?;
    let mut panels: BTreeMap<String, Vec<BadgeRule>> = BTreeMap::new();
    for (id, name, panel_id, paused, condition, datasource_id) in rules {
        let visible = super::data_visible(&access, &datasource_id);
        let rows: Vec<InstanceRow> = sqlx::query_as(
            "SELECT labels, state, fingerprint, state_since, pending_target, last_value FROM alert_instances \
             WHERE rule_id = $1",
        )
        .bind(&id)
        .fetch_all(&mut *conn)
        .await?;
        let mut counts: BTreeMap<String, i64> = BTreeMap::new();
        let mut instances = Vec::new();
        for (labels, instance_state, _, since, pending_target, last_value) in rows {
            *counts.entry(instance_state.clone()).or_default() += 1;
            if instance_state == "ok" {
                continue;
            }
            let labels: BTreeMap<String, String> = serde_json::from_str(&labels).unwrap_or_default();
            let all = with_rule_name(&labels, &name);
            let silenced = silences.iter().any(|(_, m)| m.matches(&all));
            instances.push(BadgeInstance {
                labels: if visible { labels } else { BTreeMap::new() },
                state: instance_state,
                state_since: since,
                pending_target,
                last_value: last_value.filter(|_| visible),
                silenced,
            });
        }
        instances.sort_by(|a, b| rank(&a.state).cmp(&rank(&b.state)).then(a.state_since.cmp(&b.state_since)));
        let silenced = !instances.is_empty() && instances.iter().all(|i| i.silenced);
        instances.truncate(MAX_INSTANCES);
        let rule_state = worst(counts.iter().filter(|(_, n)| **n > 0).map(|(s, _)| s.as_str()));
        panels.entry(panel_id).or_default().push(BadgeRule {
            id,
            name,
            state: rule_state,
            paused: paused != 0,
            data_hidden: !visible,
            condition: serde_json::from_str(&condition).unwrap_or(Value::Null),
            instance_counts: counts,
            silenced,
            instances,
        });
    }
    let items = panels
        .into_iter()
        .map(|(panel_id, rules)| {
            let state = worst(rules.iter().filter_map(|r| r.state.as_deref()));
            let not_ok: Vec<&BadgeRule> =
                rules.iter().filter(|r| r.state.as_deref().is_some_and(|s| s != "ok")).collect();
            let silenced = !not_ok.is_empty() && not_ok.iter().all(|r| r.silenced);
            PanelBadge { panel_id, state, silenced, rules }
        })
        .collect();
    Ok(Json(Page { items, next_cursor: None }))
}
