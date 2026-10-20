//! Route tables: every API route is declared with its access rule, and the router enforces the
//! rule before the handler runs (docs/ARCHITECTURE.md, "Routes declare their access").

use std::collections::{BTreeMap, HashMap};

use axum::Router;
use axum::extract::{FromRequestParts, Path, Request, State};
use axum::middleware::{Next, from_fn_with_state};
use axum::response::{IntoResponse, Response};
use axum::routing::MethodRouter;

use crate::app::AppState;
use crate::auth::{CurrentUser, SessionUser};
use crate::authz::{Access, OrgCtx, effective_permissions};
use crate::error::ApiError;

pub struct RouteDef {
    /// Relative to `/api`, with axum path parameters (`/orgs/{orgId}/teams`).
    pub path: &'static str,
    pub access: Access,
    pub method: MethodRouter<AppState>,
}

pub fn route(path: &'static str, access: Access, method: MethodRouter<AppState>) -> RouteDef {
    RouteDef { path, access, method }
}

/// Builds the API router. Several methods on one path may have different access rules, so each
/// method router gets its own layer before they are merged.
pub fn build(defs: Vec<RouteDef>, state: &AppState) -> Router<AppState> {
    let mut by_path: BTreeMap<&'static str, MethodRouter<AppState>> = BTreeMap::new();
    for def in defs {
        let layered = def.method.route_layer(from_fn_with_state((state.clone(), def.access), enforce));
        let merged = match by_path.remove(def.path) {
            Some(existing) => existing.merge(layered),
            None => layered,
        };
        by_path.insert(def.path, merged);
    }
    by_path.into_iter().fold(Router::new(), |router, (path, method)| router.route(path, method))
}

async fn enforce(State((state, access)): State<(AppState, Access)>, req: Request, next: Next) -> Response {
    match authorize(&state, access, req).await {
        Ok(req) => next.run(req).await,
        Err(e) => e.into_response(),
    }
}

async fn authorize(state: &AppState, access: Access, req: Request) -> Result<Request, ApiError> {
    if matches!(access, Access::Public) {
        return Ok(req);
    }
    let (mut parts, body) = req.into_parts();
    let CurrentUser(user) = CurrentUser::from_request_parts(&mut parts, state).await?;
    match access {
        Access::Public | Access::Authenticated => {}
        Access::ServerAdmin => {
            if user.is_server_admin == 0 {
                return Err(ApiError::forbidden("server administrators only"));
            }
        }
        Access::OrgMember | Access::Org(_) => {
            let Path(params) = Path::<HashMap<String, String>>::from_request_parts(&mut parts, state)
                .await
                .map_err(|_| ApiError::not_found())?;
            let org_id = params.get("orgId").ok_or_else(ApiError::not_found)?.clone();
            let ctx = org_ctx(state, user.clone(), org_id).await?;
            if let Access::Org(permission) = access {
                ctx.check(permission)?;
            }
            parts.extensions.insert(ctx);
        }
    }
    parts.extensions.insert(user);
    Ok(Request::from_parts(parts, body))
}

/// The caller's membership in `org_id`. Non-members get `not_found`, so organization ids cannot
/// be probed.
async fn org_ctx(state: &AppState, user: SessionUser, org_id: String) -> Result<OrgCtx, ApiError> {
    let role: Option<(String,)> = sqlx::query_as("SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2")
        .bind(&org_id)
        .bind(&user.id)
        .fetch_optional(&state.db)
        .await?;
    let Some((role,)) = role else { return Err(ApiError::not_found()) };
    let permissions = effective_permissions(&state.db, &user.id, &org_id, &role).await?;
    Ok(OrgCtx { user, org_id, role, permissions })
}
