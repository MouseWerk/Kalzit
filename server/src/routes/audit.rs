//! Reading the audit log (an organization's with `audit:read`, the whole server's for server
//! administrators) and deleting events older than `audit.retention_days`.

use axum::extract::State;
use axum::http::Method;
use axum::{Extension, Json};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::table::{RouteDef, route};
use crate::app::AppState;
use crate::audit::{self, AuditEvent};
use crate::authz::{Access, OrgCtx, Permission};
use crate::error::{ApiError, ApiResult};
use crate::paging::{self, QueryParams};
use crate::settings;
use crate::shapes::Page;

const DAY_MS: i64 = 24 * 3600 * 1000;

pub fn routes() -> Vec<RouteDef> {
    vec![
        route(Method::GET, "/orgs/{orgId}/audit", Access::Org(Permission::AuditRead), list_org),
        route(Method::GET, "/admin/audit", Access::ServerAdmin, list_server),
    ]
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuditQuery {
    /// User id of the actor.
    actor: Option<String>,
    /// Prefix of the action: `dashboard.` or `dashboard.saved`.
    action: Option<String>,
    resource_type: Option<String>,
    resource_id: Option<String>,
    /// Unix ms, inclusive.
    from: Option<i64>,
    /// Unix ms, exclusive.
    to: Option<i64>,
    limit: Option<u32>,
    cursor: Option<String>,
    /// Server view only: one organization.
    org_id: Option<String>,
}

#[derive(sqlx::FromRow)]
struct AuditRow {
    id: String,
    org_id: Option<String>,
    actor_user_id: Option<String>,
    actor_name: Option<String>,
    actor_address: Option<String>,
    action: String,
    resource_type: Option<String>,
    resource_id: Option<String>,
    summary: String,
    created_at: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditItem {
    id: String,
    org_id: Option<String>,
    actor_user_id: Option<String>,
    /// The actor's current name; `null` for the system or a removed account.
    actor_name: Option<String>,
    actor_address: Option<String>,
    action: String,
    resource_type: Option<String>,
    resource_id: Option<String>,
    summary: Value,
    created_at: i64,
}

async fn list_org(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    QueryParams(q): QueryParams<AuditQuery>,
) -> ApiResult<Json<Page<AuditItem>>> {
    if q.org_id.is_some() {
        return Err(ApiError::validation("orgId is a filter of the server view only").with_field("orgId"));
    }
    list(&state, Some(ctx.org_id.as_str()), q).await
}

async fn list_server(
    State(state): State<AppState>,
    QueryParams(mut q): QueryParams<AuditQuery>,
) -> ApiResult<Json<Page<AuditItem>>> {
    let org = q.org_id.take();
    list(&state, org.as_deref(), q).await
}

/// Newest first; `org_id` `None` lists every event of the server, sign-ins included.
async fn list(state: &AppState, org_id: Option<&str>, q: AuditQuery) -> ApiResult<Json<Page<AuditItem>>> {
    let limit = paging::limit(q.limit)?;
    let after: Option<(i64, String)> = paging::decode_cursor(q.cursor.as_deref())?;
    if let (Some(from), Some(to)) = (q.from, q.to)
        && from > to
    {
        return Err(ApiError::validation("from must not be after to").with_field("from"));
    }
    let (after_ms, after_id) = after.unzip();
    // Absent filters are bound as NULL; the casts give PostgreSQL the parameter types.
    let rows: Vec<AuditRow> = sqlx::query_as(
        "SELECT e.id, e.org_id, e.actor_user_id, u.name AS actor_name, e.actor_address, e.action, e.resource_type, \
         e.resource_id, e.summary, e.created_at \
         FROM audit_events e LEFT JOIN users u ON u.id = e.actor_user_id \
         WHERE (CAST($1 AS TEXT) IS NULL OR e.org_id = $1) \
         AND (CAST($2 AS TEXT) IS NULL OR e.actor_user_id = $2) \
         AND (CAST($3 AS TEXT) IS NULL OR SUBSTR(e.action, 1, LENGTH(CAST($3 AS TEXT))) = $3) \
         AND (CAST($4 AS TEXT) IS NULL OR e.resource_type = $4) \
         AND (CAST($5 AS TEXT) IS NULL OR e.resource_id = $5) \
         AND (CAST($6 AS BIGINT) IS NULL OR e.created_at >= $6) \
         AND (CAST($7 AS BIGINT) IS NULL OR e.created_at < $7) \
         AND (CAST($8 AS BIGINT) IS NULL OR e.created_at < $8 OR (e.created_at = $8 AND e.id < $9)) \
         ORDER BY e.created_at DESC, e.id DESC LIMIT $10",
    )
    .bind(org_id)
    .bind(q.actor.as_deref())
    .bind(q.action.as_deref().filter(|a| !a.is_empty()))
    .bind(q.resource_type.as_deref())
    .bind(q.resource_id.as_deref())
    .bind(q.from)
    .bind(q.to)
    .bind(after_ms)
    .bind(after_id.as_deref())
    .bind(limit as i64 + 1)
    .fetch_all(&state.db)
    .await?;

    let more = rows.len() > limit;
    let mut items = Vec::with_capacity(limit);
    for r in rows.into_iter().take(limit) {
        let summary = serde_json::from_str(&r.summary)
            .map_err(|e| ApiError::internal("audit", format!("summary of event {} is not JSON: {e}", r.id)))?;
        items.push(AuditItem {
            id: r.id,
            org_id: r.org_id,
            actor_user_id: r.actor_user_id,
            actor_name: r.actor_name,
            actor_address: r.actor_address,
            action: r.action,
            resource_type: r.resource_type,
            resource_id: r.resource_id,
            summary,
            created_at: r.created_at,
        });
    }
    let next_cursor = match items.last() {
        Some(last) if more => Some(paging::encode_cursor(&(last.created_at, &last.id))),
        _ => None,
    };
    Ok(Json(Page { items, next_cursor }))
}

/// Deletes events older than `audit.retention_days` and records how many went. Answers the
/// number deleted.
pub async fn purge_expired(state: &AppState) -> ApiResult<u64> {
    let days = settings::get(state, "audit.retention_days").await?;
    let days = days.as_i64().ok_or_else(|| ApiError::internal("audit", "audit.retention_days is not a number"))?;
    let now = state.clock.now_ms();
    let cutoff = now.saturating_sub(days.saturating_mul(DAY_MS));
    let mut tx = state.db.begin().await?;
    let deleted = sqlx::query("DELETE FROM audit_events WHERE created_at < $1")
        .bind(cutoff)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    if deleted > 0 {
        let event = AuditEvent {
            org_id: None,
            actor_user_id: None,
            actor_address: None,
            action: "audit.expired",
            resource_type: None,
            resource_id: None,
            summary: json!({ "deleted": deleted, "before": cutoff }),
            at_ms: now,
        };
        audit::record(&mut tx, &event).await?;
    }
    tx.commit().await?;
    Ok(deleted)
}

/// Runs `purge_expired` every hour, like the session cleanup.
pub fn spawn_retention(state: AppState) {
    const INTERVAL: std::time::Duration = std::time::Duration::from_secs(3600);
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(INTERVAL);
        loop {
            tick.tick().await;
            match purge_expired(&state).await {
                Ok(0) => {}
                Ok(n) => tracing::info!("deleted {n} audit events past their retention"),
                Err(e) => tracing::warn!("deleting old audit events failed, will retry in an hour: {}", e.message),
            }
        }
    });
}
