//! The alerting opt-in of data sources (docs/api/alerting.md, "Data sources"). Off by default;
//! whoever may edit a source (`datasources:write`, org-wide or by a grant on it) turns it on or
//! off, which decides whether the organization's alerting identity may query it.

use axum::extract::{Path, State};
use axum::{Extension, Json};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::alerting::rule::invalid;
use crate::alerting::service_account;
use crate::app::AppState;
use crate::authz::{DatasourceAccess, OrgCtx, Permission, Resource, check_resource};
use crate::error::ApiResult;
use crate::extract::JsonBody;
use crate::net::RequestInfo;
use crate::routes::support::{Actor, audit};
use crate::shapes::Page;

const MAX_CONCURRENT: i64 = 100;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Optin {
    datasource_id: String,
    enabled: bool,
    /// Fewer evaluations at once on this source than the server's
    /// `alerting.max_concurrent_per_datasource`; `null` follows the server.
    max_concurrent: Option<i64>,
    /// Rules on this source, and how many of them fire.
    rules: i64,
    firing_rules: i64,
}

async fn load(state: &AppState, org_id: &str, datasource_id: &str) -> ApiResult<Optin> {
    let (enabled, max_concurrent): (i64, Option<i64>) = sqlx::query_as(
        "SELECT alerting_enabled, alerting_max_concurrent FROM datasources WHERE id = $1 AND org_id = $2",
    )
    .bind(datasource_id)
    .bind(org_id)
    .fetch_one(&state.db)
    .await?;
    let (rules, firing_rules): (i64, i64) = sqlx::query_as(
        "SELECT COUNT(*), COUNT(CASE WHEN EXISTS (SELECT 1 FROM alert_instances i WHERE i.rule_id = r.id \
         AND i.state = 'firing') THEN 1 END) FROM alert_rules r WHERE r.org_id = $1 AND r.datasource_id = $2",
    )
    .bind(org_id)
    .bind(datasource_id)
    .fetch_one(&state.db)
    .await?;
    Ok(Optin { datasource_id: datasource_id.to_string(), enabled: enabled != 0, max_concurrent, rules, firing_rules })
}

/// The opt-in of one source, for everyone who may read the source.
pub async fn get(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Path((_, datasource_id)): Path<(String, String)>,
) -> ApiResult<Json<Optin>> {
    let ds = crate::datasources::find_in_org(&state.db, &ctx.org_id, &datasource_id, false).await?;
    check_resource(&state.db, &ctx, Permission::DatasourcesRead, Resource::Datasource(&ds.id)).await?;
    Ok(Json(load(&state, &ctx.org_id, &ds.id).await?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Body {
    enabled: bool,
    /// Absent or `null`: follow the server.
    max_concurrent: Option<i64>,
}

/// Turns alerting on or off for a source. Turned off, its rules stay and go to the error state
/// at their next evaluation ("source not opted in to alerting").
pub async fn set(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    Path((_, datasource_id)): Path<(String, String)>,
    JsonBody(body): JsonBody<Body>,
) -> ApiResult<Json<Optin>> {
    let ds = crate::datasources::find_in_org(&state.db, &ctx.org_id, &datasource_id, false).await?;
    check_resource(&state.db, &ctx, Permission::DatasourcesWrite, Resource::Datasource(&ds.id)).await?;
    if body.max_concurrent.is_some_and(|n| !(1..=MAX_CONCURRENT).contains(&n)) {
        return Err(invalid("maxConcurrent", "maxConcurrent is 1 to 100, or null", "alerts.max_concurrent_invalid"));
    }
    let before = load(&state, &ctx.org_id, &ds.id).await?;
    if before.enabled != body.enabled || before.max_concurrent != body.max_concurrent {
        let now = state.clock.now_ms();
        let mut tx = crate::db::begin(&state.db).await?;
        crate::authz::lock_org(&mut tx, &ctx.org_id).await?;
        if body.enabled {
            service_account::ensure(&mut tx, &ctx.org_id, now).await?;
        }
        sqlx::query(
            "UPDATE datasources SET alerting_enabled = $1, alerting_max_concurrent = $2 WHERE id = $3 AND org_id = $4",
        )
        .bind(i64::from(body.enabled))
        .bind(body.max_concurrent)
        .bind(&ds.id)
        .bind(&ctx.org_id)
        .execute(&mut *tx)
        .await?;
        let actor = Actor { user_id: &ctx.user.id, info: &info, at_ms: now };
        let summary = json!({ "enabled": body.enabled, "maxConcurrent": body.max_concurrent });
        audit(&mut tx, &actor, Some(&ctx.org_id), "datasource.alerting_changed", ("datasource", &ds.id), summary)
            .await?;
        crate::db::commit(tx).await?;
    }
    Ok(Json(load(&state, &ctx.org_id, &ds.id).await?))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OptedIn {
    datasource_id: String,
    name: String,
    kind: String,
}

/// The sources opted in to alerting that the caller may query, for the rule editor.
pub async fn opted_in(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
) -> ApiResult<Json<Page<OptedIn>>> {
    let access = DatasourceAccess::load(&state.db, &ctx).await?;
    let rows: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT id, name, kind FROM datasources WHERE org_id = $1 AND deleted_at IS NULL AND alerting_enabled <> 0",
    )
    .bind(&ctx.org_id)
    .fetch_all(&state.db)
    .await?;
    let mut items: Vec<OptedIn> = rows
        .into_iter()
        .filter(|(id, _, _)| access.allows(Permission::DatasourcesQuery, id))
        .map(|(datasource_id, name, kind)| OptedIn { datasource_id, name, kind })
        .collect();
    items.sort_by(|a, b| {
        crate::collation::compare(&a.name, &b.name).then_with(|| a.datasource_id.cmp(&b.datasource_id))
    });
    Ok(Json(Page { items, next_cursor: None }))
}
