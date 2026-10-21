//! Free queries (`POST /orgs/{orgId}/query`) for members with `datasources:query`. The panel and
//! variable-options routes run a dashboard's stored queries through the same
//! `datasources::run_queries`. Documented in docs/api/datasources.md.

use axum::extract::State;
use axum::http::Method;
use axum::{Extension, Json};

use super::table::{RouteDef, route};
use crate::app::AppState;
use crate::authz::{Access, OrgCtx, Permission, Resource, check_resource};
use crate::datasources::{check_items, check_range, run_queries};
use crate::error::ApiResult;
use crate::extract::JsonBody;
use crate::shapes::{ErrorBody, QueryOutcome, QueryRequest, QueryResponse};

pub fn routes() -> Vec<RouteDef> {
    vec![route(Method::POST, "/orgs/{orgId}/query", Access::Org(Permission::DatasourcesQuery), query)]
}

async fn query(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    JsonBody(req): JsonBody<QueryRequest>,
) -> ApiResult<Json<QueryResponse>> {
    check_items(&req.queries)?;
    check_range(req.time_range)?;
    // Each item is authorized on its own data source; one the caller may not query answers for
    // its refId only. Ids of other organizations are not found when they are run.
    let mut refused = Vec::new();
    let mut allowed = Vec::new();
    for item in req.queries {
        match check_resource(&state.db, &ctx, Permission::DatasourcesQuery, Resource::Datasource(&item.datasource_id))
            .await
        {
            Ok(()) => allowed.push(item),
            Err(e) => refused.push((item.ref_id, e)),
        }
    }
    let mut response = if allowed.is_empty() {
        QueryResponse { results: Default::default() }
    } else {
        run_queries(&state, &ctx, allowed, req.time_range, req.interval_ms, req.max_data_points, &req.variables).await
    };
    for (ref_id, e) in refused {
        let error = ErrorBody { code: e.code.to_string(), message: e.message, field: None };
        response.results.insert(ref_id, QueryOutcome::Err { error });
    }
    Ok(Json(response))
}
