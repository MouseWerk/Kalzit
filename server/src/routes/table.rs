//! Route tables: every API route is declared with its access rule, and the router enforces the
//! rule before the handler runs (docs/ARCHITECTURE.md, "Routes declare their access").

use std::collections::{BTreeMap, HashMap};

use axum::Router;
use axum::extract::{FromRequestParts, Path, Request, State};
use axum::handler::Handler;
use axum::http::{Method, StatusCode};
use axum::middleware::{Next, from_fn_with_state};
use axum::response::{IntoResponse, Response};
use axum::routing::{MethodFilter, MethodRouter, on};

use crate::app::AppState;
use crate::auth::{CurrentUser, SessionUser};
use crate::authz::{Access, OrgCtx, effective_permissions};
use crate::error::ApiError;

pub struct RouteDef {
    /// The one HTTP method this route answers; tests call every declared route with it.
    pub method: Method,
    /// Relative to `/api`, with axum path parameters (`/orgs/{orgId}/teams`).
    pub path: &'static str,
    pub access: Access,
    /// The route changes who may see what (grants, roles, members, teams, folders, owners, trash,
    /// plugins, organization settings, AI data rules): once it succeeds, the query cache serves
    /// none of the organization's kept answers any more (none at all for a server route; a new
    /// generation, `datasources::cache::Stamp`).
    pub changes_rights: bool,
    handler: MethodRouter<AppState>,
}

/// `route(Method::GET, "/orgs/{orgId}", Access::OrgMember, handler)`. The method router is built
/// here from `method`, so a route cannot answer a method it did not declare.
pub fn route<H, T>(method: Method, path: &'static str, access: Access, handler: H) -> RouteDef
where
    H: Handler<T, AppState>,
    T: 'static,
{
    let filter = MethodFilter::try_from(method.clone()).expect("route tables use standard HTTP methods");
    RouteDef { method, path, access, changes_rights: false, handler: on(filter, handler) }
}

impl RouteDef {
    /// Sets the request body limit of this route (below or above axum's default of 2 MiB); a larger body answers
    /// `413 payload_too_large` before the handler reads it.
    pub fn body_limit(mut self, bytes: usize) -> Self {
        self.handler = self.handler.layer(axum::extract::DefaultBodyLimit::max(bytes));
        self
    }

    /// Marks a route that changes rights (`changes_rights`).
    pub fn changes_rights(mut self) -> Self {
        self.changes_rights = true;
        self
    }
}

/// Builds the API router. Several methods on one path may have different access rules, so each
/// method router gets its own layer before they are merged.
#[expect(clippy::disallowed_methods, reason = "this is where route tables become routes, with their access layer")]
pub fn build(defs: Vec<RouteDef>, state: &AppState) -> Router<AppState> {
    let mut by_path: BTreeMap<&'static str, MethodRouter<AppState>> = BTreeMap::new();
    for def in defs {
        let layered =
            def.handler.route_layer(from_fn_with_state((state.clone(), def.access, def.changes_rights), enforce));
        let merged = match by_path.remove(def.path) {
            Some(existing) => existing.merge(layered),
            None => layered,
        };
        by_path.insert(def.path, merged);
    }
    // A method nobody declared answers in the API's error format, not with an empty 405.
    by_path
        .into_iter()
        .fold(Router::new(), |router, (path, method)| router.route(path, method.fallback(method_not_allowed)))
}

async fn method_not_allowed() -> ApiError {
    ApiError::new(StatusCode::METHOD_NOT_ALLOWED, "method_not_allowed", "this method is not supported here")
}

async fn enforce(
    State((state, access, changes_rights)): State<(AppState, Access, bool)>,
    req: Request,
    next: Next,
) -> Response {
    match authorize(&state, access, req).await {
        Ok(req) if changes_rights => {
            let org_id = req.extensions().get::<OrgCtx>().map(|c| c.org_id.clone());
            // Bumped when the handler ends, also when the client goes away and the request is
            // dropped mid-change, after a commit it can no longer see.
            let _bump = state.datasources.query_cache().bump_on_drop(org_id);
            next.run(req).await
        }
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
            // Organization ids are canonical UUIDs (lowercase, hyphenated); anything else cannot
            // exist, so it needs no lookup.
            if uuid::Uuid::parse_str(&org_id).map(|u| u.hyphenated().to_string()).ok().as_deref() != Some(&org_id) {
                return Err(ApiError::not_found());
            }
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
/// be probed. Read through the read pool, so a queue of writers never holds up the check.
pub(crate) async fn org_ctx(state: &AppState, user: SessionUser, org_id: String) -> Result<OrgCtx, ApiError> {
    let role: Option<(String,)> = sqlx::query_as("SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2")
        .bind(&org_id)
        .bind(&user.id)
        .fetch_optional(&state.read_db)
        .await?;
    let Some((role,)) = role else { return Err(ApiError::not_found()) };
    let permissions = effective_permissions(&state.read_db, &user.id, &org_id, &role).await?;
    Ok(OrgCtx { user, org_id, role, permissions, at_ms: state.clock.now_ms() })
}
