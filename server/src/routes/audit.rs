//! Reading the audit log (an organization's with `audit:read`, the whole server's for server
//! administrators) and deleting events older than `audit.retention_days`.

use std::collections::HashSet;

use axum::extract::State;
use axum::http::Method;
use axum::{Extension, Json};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::support::{Paging, QueryParams};
use super::table::{RouteDef, route};
use crate::app::AppState;
use crate::audit::{self, AuditEvent};
use crate::authz::{Access, OrgCtx, Permission};
use crate::error::{ApiError, ApiResult};
use crate::folders;
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
    let viewer = Viewer {
        org_id: Some(&ctx.org_id),
        user_id: &ctx.user.id,
        role: &ctx.role,
        sees_every_folder: folders::sees_every_folder(&ctx),
        scrub: (folders::sees_every_folder(&ctx) == 0).then_some(&ctx),
    };
    list(&state, viewer, q).await
}

async fn list_server(
    State(state): State<AppState>,
    QueryParams(mut q): QueryParams<AuditQuery>,
) -> ApiResult<Json<Page<AuditItem>>> {
    let org = q.org_id.take();
    if org.as_deref().is_some_and(|o| o.trim().is_empty()) {
        return Err(ApiError::validation("orgId must not be empty").with_field("orgId"));
    }
    // Server administrators see every event; no folder is hidden from this view.
    let viewer = Viewer { org_id: org.as_deref(), user_id: "", role: "", sees_every_folder: 1, scrub: None };
    list(&state, viewer, q).await
}

/// Whose view of the log: the organization (`None`: the whole server) and, for hiding events about
/// restricted folders and their dashboards, the parameters of `folders::VISIBILITY_CTE`.
struct Viewer<'a> {
    org_id: Option<&'a str>,
    user_id: &'a str,
    role: &'a str,
    sees_every_folder: i64,
    /// The member whose hidden folders are not named in summaries; `None` names everything.
    scrub: Option<&'a OrgCtx>,
}

/// Newest first. Events about folders and dashboards the viewer cannot see are left out, as the
/// resources themselves are, also once restricted content is purged (`restricted_tombstones`).
async fn list(state: &AppState, viewer: Viewer<'_>, q: AuditQuery) -> ApiResult<Json<Page<AuditItem>>> {
    let paging = Paging::new(q.limit, q.cursor.as_deref())?;
    if let (Some(from), Some(to)) = (q.from, q.to)
        && from > to
    {
        return Err(ApiError::validation("from must not be after to").with_field("from"));
    }
    // Absent filters are bound as NULL; the casts give PostgreSQL the parameter types.
    let rows: Vec<AuditRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "{} SELECT e.id, e.org_id, e.actor_user_id, u.name AS actor_name, e.actor_address, e.action, e.resource_type, \
         e.resource_id, e.summary, e.created_at \
         FROM audit_events e LEFT JOIN users u ON u.id = e.actor_user_id \
         WHERE (CAST($1 AS TEXT) IS NULL OR e.org_id = $1) \
         AND (CAST($5 AS TEXT) IS NULL OR e.actor_user_id = $5) \
         AND (CAST($6 AS TEXT) IS NULL OR SUBSTR(e.action, 1, LENGTH(CAST($6 AS TEXT))) = $6) \
         AND (CAST($7 AS TEXT) IS NULL OR e.resource_type = $7) \
         AND (CAST($8 AS TEXT) IS NULL OR e.resource_id = $8) \
         AND (CAST($9 AS BIGINT) IS NULL OR e.created_at >= $9) \
         AND (CAST($10 AS BIGINT) IS NULL OR e.created_at < $10) \
         AND (e.created_at < $11 OR (e.created_at = $11 AND e.id < $12)) \
         AND NOT ( \
           (COALESCE(e.resource_type, '') = 'folder' \
            AND COALESCE(e.resource_id, '') IN (SELECT id FROM hidden_folders)) \
           OR (COALESCE(e.resource_type, '') = 'dashboard' AND COALESCE(e.resource_id, '') IN \
             (SELECT d.id FROM dashboards d WHERE d.org_id = $1 AND d.folder_id IN (SELECT id FROM hidden_folders) \
              AND d.id NOT IN (SELECT resource_id FROM caller_grants WHERE resource_type = 'dashboard')))) \
         AND (CAST($4 AS BIGINT) = 1 OR NOT EXISTS (SELECT 1 FROM restricted_tombstones t \
              WHERE t.org_id = e.org_id AND t.resource_type = COALESCE(e.resource_type, '') \
              AND t.resource_id = COALESCE(e.resource_id, ''))) \
         ORDER BY e.created_at DESC, e.id DESC LIMIT $13",
        folders::VISIBILITY_CTE
    )))
    .bind(viewer.org_id)
    .bind(viewer.user_id)
    .bind(viewer.role)
    .bind(viewer.sees_every_folder)
    .bind(q.actor.as_deref())
    .bind(q.action.as_deref().filter(|a| !a.is_empty()))
    .bind(q.resource_type.as_deref())
    .bind(q.resource_id.as_deref())
    .bind(q.from)
    .bind(q.to)
    .bind(paging.before_time())
    .bind(paging.before_id())
    .bind(paging.fetch_limit())
    .fetch_all(&state.db)
    .await?;

    // Summaries name folders (`parentId`, `folderId`); those the viewer cannot see, or that were
    // restricted when they were purged, are not named.
    let unnamed: HashSet<String> = match viewer.scrub {
        Some(ctx) => {
            let mut conn = state.db.acquire().await?;
            let mut ids = folders::hidden_folder_ids(&mut conn, ctx).await?;
            let gone: Vec<(String,)> = sqlx::query_as(
                "SELECT resource_id FROM restricted_tombstones WHERE org_id = $1 AND resource_type = 'folder'",
            )
            .bind(&ctx.org_id)
            .fetch_all(&mut *conn)
            .await?;
            ids.extend(gone.into_iter().map(|(id,)| id));
            ids
        }
        None => HashSet::new(),
    };
    let mut items = Vec::with_capacity(rows.len());
    for r in rows {
        let mut summary: Value = serde_json::from_str(&r.summary)
            .map_err(|e| ApiError::internal("audit", format!("summary of event {} is not JSON: {e}", r.id)))?;
        for key in ["parentId", "folderId"] {
            if summary.get(key).and_then(Value::as_str).is_some_and(|id| unnamed.contains(id)) {
                summary[key] = Value::Null;
            }
        }
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
    Ok(Json(paging.page(items, |e| (e.created_at, e.id.as_str()))))
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Built-in roles that read the audit log also see restricted folders, so this runs the
    /// query directly, as for a custom role with `audit:read` alone.
    #[tokio::test]
    async fn events_about_hidden_folders_and_their_dashboards_are_left_out() {
        let db = crate::db::connect("sqlite::memory:", 1).await.unwrap();
        let clock = std::sync::Arc::new(crate::clock::ManualClock::new(0));
        let state =
            AppState::new(crate::config::Config::default(), db.clone(), clock, Some("fixed-code-0123456789".into()))
                .await
                .unwrap();
        for sql in [
            "INSERT INTO orgs (id, name, created_at) VALUES ('o', 'O', 0)",
            "INSERT INTO folders (id, org_id, parent_id, name, restricted, version, created_at, updated_at) VALUES \
             ('secret', 'o', NULL, 'S', 1, 1, 0, 0), ('inner', 'o', 'secret', 'I', 0, 1, 0, 0), \
             ('open', 'o', NULL, 'O', 0, 1, 0, 0)",
            "INSERT INTO dashboards (id, org_id, folder_id, title, search_title, version, created_at, updated_at) VALUES \
             ('hidden', 'o', 'inner', 'H', 'h', 1, 0, 0), ('shown', 'o', 'open', 'S', 's', 1, 0, 0)",
            "INSERT INTO audit_events (id, org_id, action, resource_type, resource_id, summary, created_at) VALUES \
             ('1', 'o', 'folder.created', 'folder', 'secret', '{}', 1), \
             ('2', 'o', 'folder.created', 'folder', 'inner', '{}', 2), \
             ('3', 'o', 'dashboard.saved', 'dashboard', 'hidden', '{}', 3), \
             ('4', 'o', 'dashboard.saved', 'dashboard', 'shown', '{}', 4), \
             ('5', 'o', 'folder.created', 'folder', 'open', '{}', 5), \
             ('6', 'o', 'settings.updated', NULL, NULL, '{}', 6)",
        ] {
            sqlx::query(sql).execute(&db).await.unwrap();
        }
        let ids = |page: Page<AuditItem>| page.items.into_iter().map(|e| e.id).collect::<Vec<_>>();
        let query = || serde_json::from_value::<AuditQuery>(serde_json::json!({})).unwrap();
        let viewer = || Viewer { org_id: Some("o"), user_id: "u", role: "viewer", sees_every_folder: 0, scrub: None };
        let limited = list(&state, viewer(), query()).await.unwrap().0;
        assert_eq!(ids(limited), ["6", "5", "4"]);
        let admin = Viewer { sees_every_folder: 1, ..viewer() };
        assert_eq!(ids(list(&state, admin, query()).await.unwrap().0).len(), 6);

        // A grant on the inner folder shows it and its dashboard, not the restricted folder above.
        sqlx::query(
            "INSERT INTO resource_grants (id, org_id, subject_type, subject_id, resource_type, resource_id, level, \
             created_at) VALUES ('g', 'o', 'role', 'viewer', 'folder', 'inner', 'view', 0)",
        )
        .execute(&db)
        .await
        .unwrap();
        assert_eq!(ids(list(&state, viewer(), query()).await.unwrap().0), ["6", "5", "4", "3", "2"]);
    }
}
