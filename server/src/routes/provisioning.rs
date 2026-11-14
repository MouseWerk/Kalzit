//! Provisioning sets (docs/guide/provisioning.md): plan, apply, the managed resources, unlocking
//! one, and export. `kalzit provision` calls these with a service account's token; the files
//! come in the request, never from the server's own disk. `provisioning:read` plans and exports,
//! `provisioning:write` applies and unlocks; every kind a set changes also needs its own write
//! permission (`provisioning::engine`).

use axum::extract::{Path, State};
use axum::http::Method;
use axum::{Extension, Json};
use serde::Deserialize;

use super::support::QueryParams;
use super::table::{RouteDef, route};
use crate::app::AppState;
use crate::authz::{Access, OrgCtx, Permission};
use crate::error::{ApiError, ApiResult};
use crate::extract::JsonBody;
use crate::net::RequestInfo;
use crate::provisioning::ResourceKind;
use crate::provisioning::engine::{self, ApplyResult, Export, Plan, Provisioned, SetRequest};
use crate::shapes::Page;

/// A set's files with their YAML around 1 MiB models fit; larger sets are split.
const BODY_LIMIT: usize = 32 * 1024 * 1024;

pub fn routes() -> Vec<RouteDef> {
    let read = Access::Org(Permission::ProvisioningRead);
    let write = Access::Org(Permission::ProvisioningWrite);
    vec![
        route(Method::GET, "/orgs/{orgId}/provisioning/resources", read, list),
        route(Method::POST, "/orgs/{orgId}/provisioning/plan", read, plan).body_limit(BODY_LIMIT).long_running(),
        route(Method::POST, "/orgs/{orgId}/provisioning/apply", write, apply)
            .body_limit(BODY_LIMIT)
            .long_running()
            .changes_rights(),
        route(Method::GET, "/orgs/{orgId}/provisioning/export", read, export).long_running(),
        route(Method::POST, "/orgs/{orgId}/provisioning/resources/{kind}/{uid}/unlock", write, unlock),
    ]
}

/// Every managed resource of the organization, all sets, in one page.
async fn list(State(state): State<AppState>, Extension(ctx): Extension<OrgCtx>) -> ApiResult<Json<Page<Provisioned>>> {
    Ok(Json(Page { items: engine::list(&state, &ctx.org_id).await?, next_cursor: None }))
}

async fn plan(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    JsonBody(mut body): JsonBody<SetRequest>,
) -> ApiResult<Json<Plan>> {
    let set = engine::set_name(body.set.as_deref())?;
    let secrets = engine::secret_values(&mut body)?;
    let docs = engine::documents(&body)?;
    Ok(Json(engine::plan(&state, &ctx, &set, docs, &secrets, body.prune).await?.plan))
}

async fn apply(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    JsonBody(mut body): JsonBody<SetRequest>,
) -> ApiResult<Json<ApplyResult>> {
    let set = engine::set_name(body.set.as_deref())?;
    let secrets = engine::secret_values(&mut body)?;
    let docs = engine::documents(&body)?;
    let prepared = engine::plan(&state, &ctx, &set, docs, &secrets, body.prune).await?;
    Ok(Json(engine::apply(&state, &ctx, &info, prepared).await?))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ExportQuery {
    set: Option<String>,
}

async fn export(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    QueryParams(query): QueryParams<ExportQuery>,
) -> ApiResult<Json<Export>> {
    let set = engine::set_name(query.set.as_deref())?;
    Ok(Json(engine::export(&state, &ctx, &set).await?))
}

async fn unlock(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    Path((_, kind, uid)): Path<(String, String, String)>,
) -> ApiResult<Json<Provisioned>> {
    let kind = ResourceKind::parse(&kind).ok_or_else(ApiError::not_found)?;
    engine::unlock(&state, &ctx, &info, kind, &uid).await?;
    let all = engine::list(&state, &ctx.org_id).await?;
    all.into_iter().find(|p| p.kind == kind && p.uid == uid).map(Json).ok_or_else(ApiError::not_found)
}
