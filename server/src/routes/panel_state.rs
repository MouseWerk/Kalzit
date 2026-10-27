//! A viewer's own state of a graph panel on a dashboard: the nodes they pinned and the ones they
//! selected while exploring it (docs/api/dashboard-features.md, "Panel view state"). It belongs
//! to the caller alone and changes neither the panel nor its query.
//!
//! Only node ids are stored, never a node's properties or any other part of a result. Reading
//! and writing need read access to the dashboard, and the panel must be one of its panels; a
//! dashboard the caller cannot read answers like one that does not exist.

use axum::extract::{Path, State};
use axum::http::{Method, StatusCode};
use axum::{Extension, Json};
use serde::{Deserialize, Serialize};

use super::table::{RouteDef, route};
use crate::app::AppState;
use crate::authz::{Access, OrgCtx};
use crate::error::{ApiError, ApiResult};
use crate::extract::JsonBody;

/// Ids kept per list (pinned, selected).
pub const MAX_IDS: usize = 200;
/// Longest node id, in characters (Neo4j element ids are about 50).
pub const MAX_ID_CHARS: usize = 512;
/// Longest panel id in the path, in characters.
const MAX_PANEL_ID_CHARS: usize = 100;

pub fn routes() -> Vec<RouteDef> {
    use Access::OrgMember;
    let path = "/orgs/{orgId}/dashboards/{dashboardId}/panels/{panelId}/view-state";
    vec![
        route(Method::GET, path, OrgMember, get_state),
        route(Method::PUT, path, OrgMember, put_state),
        route(Method::DELETE, path, OrgMember, delete_state),
    ]
}

/// What a viewer keeps of a panel: node ids, in the order they were pinned or selected.
#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ViewState {
    #[serde(default)]
    pub pinned: Vec<String>,
    #[serde(default)]
    pub selected: Vec<String>,
}

fn check_ids(name: &'static str, ids: &[String]) -> ApiResult<()> {
    if ids.len() > MAX_IDS {
        return Err(ApiError::validation(format!("{name} takes at most {MAX_IDS} ids")).with_field(name));
    }
    for id in ids {
        if id.is_empty() || id.chars().count() > MAX_ID_CHARS || id.chars().any(char::is_control) {
            return Err(ApiError::validation(format!(
                "{name} takes ids of 1 to {MAX_ID_CHARS} characters without control characters"
            ))
            .with_field(name));
        }
    }
    let mut seen = std::collections::HashSet::new();
    if !ids.iter().all(|id| seen.insert(id.as_str())) {
        return Err(ApiError::validation(format!("{name} names each id once")).with_field(name));
    }
    Ok(())
}

/// The dashboard must be readable by the caller and hold the panel; anything else is not found.
async fn check_panel(state: &AppState, ctx: &OrgCtx, dashboard_id: &str, panel_id: &str) -> ApiResult<()> {
    if panel_id.is_empty() || panel_id.chars().count() > MAX_PANEL_ID_CHARS {
        return Err(ApiError::not_found());
    }
    let model = super::query::readable_model(state, ctx, dashboard_id)
        .await
        .map_err(|e| if e.code == "forbidden" { ApiError::not_found() } else { e })?;
    if !model.panels.iter().any(|p| p.id == panel_id) {
        return Err(ApiError::not_found());
    }
    Ok(())
}

/// The caller's state of the panel; empty lists when they kept none.
async fn get_state(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Path((_, dashboard_id, panel_id)): Path<(String, String, String)>,
) -> ApiResult<Json<ViewState>> {
    check_panel(&state, &ctx, &dashboard_id, &panel_id).await?;
    let row: Option<(String,)> = sqlx::query_as(
        "SELECT state FROM panel_view_state WHERE user_id = $1 AND org_id = $2 AND dashboard_id = $3 AND panel_id = $4",
    )
    .bind(&ctx.user.id)
    .bind(&ctx.org_id)
    .bind(&dashboard_id)
    .bind(&panel_id)
    .fetch_optional(&state.db)
    .await?;
    // A row this server cannot read (written by hand) counts as none.
    let kept = row.and_then(|(raw,)| serde_json::from_str::<ViewState>(&raw).ok()).unwrap_or_default();
    Ok(Json(kept))
}

/// Replaces the caller's state of the panel. Empty lists remove it.
async fn put_state(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Path((_, dashboard_id, panel_id)): Path<(String, String, String)>,
    JsonBody(body): JsonBody<ViewState>,
) -> ApiResult<Json<ViewState>> {
    check_ids("pinned", &body.pinned)?;
    check_ids("selected", &body.selected)?;
    check_panel(&state, &ctx, &dashboard_id, &panel_id).await?;
    let mut tx = crate::db::begin(&state.db).await?;
    sqlx::query(
        "DELETE FROM panel_view_state WHERE user_id = $1 AND org_id = $2 AND dashboard_id = $3 AND panel_id = $4",
    )
    .bind(&ctx.user.id)
    .bind(&ctx.org_id)
    .bind(&dashboard_id)
    .bind(&panel_id)
    .execute(&mut *tx)
    .await?;
    if !body.pinned.is_empty() || !body.selected.is_empty() {
        let text = serde_json::to_string(&body).map_err(|e| ApiError::internal("panel view state", e))?;
        sqlx::query(
            "INSERT INTO panel_view_state (user_id, org_id, dashboard_id, panel_id, state, updated_at) \
             VALUES ($1, $2, $3, $4, $5, $6)",
        )
        .bind(&ctx.user.id)
        .bind(&ctx.org_id)
        .bind(&dashboard_id)
        .bind(&panel_id)
        .bind(text)
        .bind(state.clock.now_ms())
        .execute(&mut *tx)
        .await?;
    }
    crate::db::commit(tx).await?;
    Ok(Json(body))
}

/// Forgets the caller's state of the panel; also of a dashboard they can no longer read, and
/// without an answer that tells whether there was one.
async fn delete_state(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Path((_, dashboard_id, panel_id)): Path<(String, String, String)>,
) -> ApiResult<StatusCode> {
    let mut tx = crate::db::begin(&state.db).await?;
    sqlx::query(
        "DELETE FROM panel_view_state WHERE user_id = $1 AND org_id = $2 AND dashboard_id = $3 AND panel_id = $4",
    )
    .bind(&ctx.user.id)
    .bind(&ctx.org_id)
    .bind(&dashboard_id)
    .bind(&panel_id)
    .execute(&mut *tx)
    .await?;
    crate::db::commit(tx).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_bounded() {
        assert!(check_ids("pinned", &[]).is_ok());
        assert!(check_ids("pinned", &["4:abc:1".into(), "12".into()]).is_ok());
        assert!(check_ids("pinned", &vec!["x".to_string(); 2]).is_err(), "each id once");
        let many: Vec<String> = (0..=MAX_IDS).map(|i| i.to_string()).collect();
        assert!(check_ids("pinned", &many).is_err());
        assert!(check_ids("selected", &[String::new()]).is_err());
        assert!(check_ids("selected", &["a\nb".into()]).is_err());
        assert!(check_ids("selected", &["x".repeat(MAX_ID_CHARS + 1)]).is_err());
        assert!(check_ids("selected", &["x".repeat(MAX_ID_CHARS)]).is_ok());
    }
}
