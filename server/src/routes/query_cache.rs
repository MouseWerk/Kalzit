//! The server's query cache for server administrators (docs/api/datasources.md, "Query cache"):
//! how full it is and how often it answers, and emptying it. Its settings are server settings
//! (`datasources.cache_enabled`, `datasources.cache_max_bytes`).

use axum::extract::State;
use axum::http::{Method, StatusCode};
use axum::{Extension, Json};
use serde::Serialize;
use serde_json::json;

use super::table::{RouteDef, route};
use crate::app::AppState;
use crate::audit::{self, AuditEvent};
use crate::auth::SessionUser;
use crate::authz::Access;
use crate::error::ApiResult;
use crate::net::RequestInfo;

pub fn routes() -> Vec<RouteDef> {
    vec![
        route(Method::GET, "/admin/query-cache", Access::ServerAdmin, stats),
        route(Method::DELETE, "/admin/query-cache", Access::ServerAdmin, clear),
    ]
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CacheView {
    /// `datasources.cache_enabled`.
    enabled: bool,
    /// `datasources.cache_max_bytes`.
    max_bytes: u64,
    /// Answers kept now and the bytes they take.
    entries: usize,
    bytes: usize,
    /// Answers served from the cache and runs it could not answer, since the server started.
    hits: u64,
    misses: u64,
}

async fn stats(State(state): State<AppState>) -> ApiResult<Json<CacheView>> {
    let enabled = crate::settings::get(&state, "datasources.cache_enabled").await?.as_bool().unwrap_or(false);
    let max_bytes = crate::settings::get(&state, "datasources.cache_max_bytes").await?.as_u64().unwrap_or(0);
    let s = state.datasources.query_cache().stats();
    Ok(Json(CacheView { enabled, max_bytes, entries: s.entries, bytes: s.bytes, hits: s.hits, misses: s.misses }))
}

/// Forgets every kept answer; the next load of each query asks its source. Audited.
async fn clear(
    State(state): State<AppState>,
    Extension(user): Extension<SessionUser>,
    Extension(info): Extension<RequestInfo>,
) -> ApiResult<StatusCode> {
    let entries = state.datasources.query_cache().stats().entries;
    let mut conn = state.db.acquire().await?;
    let event = AuditEvent {
        org_id: None,
        actor_user_id: Some(&user.id),
        actor_address: Some(info.client_ip.to_string()),
        action: "query_cache.cleared",
        resource_type: None,
        resource_id: None,
        summary: json!({ "entries": entries }),
        at_ms: state.clock.now_ms(),
    };
    audit::record(&mut conn, &event).await?;
    state.datasources.query_cache().clear();
    // The other servers on the same database empty theirs too.
    state.cluster.publish(crate::cluster::Change::CacheCleared);
    Ok(StatusCode::NO_CONTENT)
}
