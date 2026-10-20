//! The organization itself, as its members see it.

use axum::extract::State;
use axum::http::Method;
use axum::routing::get;
use axum::{Extension, Json};
use serde::Serialize;

use super::table::{RouteDef, route};
use crate::app::AppState;
use crate::authz::{Access, OrgCtx};
use crate::error::ApiResult;

pub fn routes() -> Vec<RouteDef> {
    vec![route(Method::GET, "/orgs/{orgId}", Access::OrgMember, get(current))]
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrgView {
    id: String,
    name: String,
    role: String,
    /// What the caller may do here, so the UI can hide what would be refused anyway. The server
    /// checks every request regardless.
    permissions: Vec<&'static str>,
}

async fn current(State(state): State<AppState>, Extension(ctx): Extension<OrgCtx>) -> ApiResult<Json<OrgView>> {
    let (name,): (String,) =
        sqlx::query_as("SELECT name FROM orgs WHERE id = $1").bind(&ctx.org_id).fetch_one(&state.db).await?;
    Ok(Json(OrgView {
        id: ctx.org_id,
        name,
        role: ctx.role,
        permissions: ctx.permissions.iter().map(|p| p.as_str()).collect(),
    }))
}
