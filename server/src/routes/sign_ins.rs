//! Recent sign-ins (docs/api/access.md, "Recent sign-ins"): a person's own, and any person's for
//! server administrators. Read from the audit log by `auth::sign_ins`.

use axum::Extension;
use axum::Json;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, Method};

use super::support::{PageQuery, Paging, QueryParams};
use super::table::{RouteDef, route};
use crate::app::AppState;
use crate::auth::sign_ins::{self, SignIn};
use crate::auth::{SessionUser, session};
use crate::authz::Access;
use crate::error::{ApiError, ApiResult};
use crate::net::RequestInfo;
use crate::shapes::Page;

pub fn routes() -> Vec<RouteDef> {
    vec![
        route(Method::GET, "/me/sign-ins", Access::Authenticated, own),
        route(Method::GET, "/admin/users/{userId}/sign-ins", Access::ServerAdmin, of_user),
    ]
}

/// The signed-in person's own sign-ins; the one of this session is marked `current`.
async fn own(
    State(state): State<AppState>,
    Extension(user): Extension<SessionUser>,
    Extension(info): Extension<RequestInfo>,
    headers: HeaderMap,
    QueryParams(q): QueryParams<PageQuery>,
) -> ApiResult<Json<Page<SignIn>>> {
    let paging = Paging::new(q.limit, q.cursor.as_deref())?;
    let current: Option<(String,)> = match session::read_cookie(&headers, info.https) {
        Some(token) => {
            sqlx::query_as("SELECT id FROM sessions WHERE token_hash = $1 AND user_id = $2")
                .bind(session::hash_token(&token))
                .bind(&user.id)
                .fetch_optional(&state.db)
                .await?
        }
        None => None,
    };
    let current = current.map(|(id,)| id);
    Ok(Json(sign_ins::list(&state.db, &user.id, &paging, current.as_deref()).await?))
}

/// A person's sign-ins, for server administrators (the user page). Service accounts never sign
/// in and answer like an unknown account.
async fn of_user(
    State(state): State<AppState>,
    Path(user_id): Path<String>,
    QueryParams(q): QueryParams<PageQuery>,
) -> ApiResult<Json<Page<SignIn>>> {
    let paging = Paging::new(q.limit, q.cursor.as_deref())?;
    let found: Option<(String,)> = sqlx::query_as("SELECT id FROM users WHERE id = $1 AND service_account = 0")
        .bind(&user_id)
        .fetch_optional(&state.db)
        .await?;
    if found.is_none() {
        return Err(ApiError::not_found());
    }
    Ok(Json(sign_ins::list(&state.db, &user_id, &paging, None).await?))
}
