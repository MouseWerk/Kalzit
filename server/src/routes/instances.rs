//! The Kalzit servers on this database for server administrators (docs/api/settings-dashboards.md,
//! "Instances"): each server's host, version, start and heartbeat, and which one leads
//! (`cluster`).

use axum::Json;
use axum::extract::State;
use axum::http::Method;

use super::table::{RouteDef, route};
use crate::app::AppState;
use crate::authz::Access;
use crate::cluster::ClusterView;
use crate::error::ApiResult;

pub fn routes() -> Vec<RouteDef> {
    vec![route(Method::GET, "/admin/instances", Access::ServerAdmin, list)]
}

async fn list(State(state): State<AppState>) -> ApiResult<Json<ClusterView>> {
    Ok(Json(crate::cluster::view(&state).await?))
}
