pub mod password;
pub mod ratelimit;
pub mod session;

use axum::extract::FromRequestParts;
use axum::http::request::Parts;

use crate::app::AppState;
use crate::error::ApiError;
pub use session::SessionUser;

/// Extractor for handlers that need a signed-in user; answers 401 otherwise.
pub struct CurrentUser(pub SessionUser);

impl FromRequestParts<AppState> for CurrentUser {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        // The access layer already looked the session up for this request.
        if let Some(user) = parts.extensions.get::<SessionUser>() {
            return Ok(CurrentUser(user.clone()));
        }
        let secure = parts.extensions.get::<crate::net::RequestInfo>().is_some_and(|i| i.https);
        let token = session::read_cookie(&parts.headers, secure).ok_or_else(ApiError::unauthenticated)?;
        let now = state.clock.now_ms();
        session::lookup(&state.read_db, &state.db, &state.touches, &state.config.sessions, now, &token)
            .await?
            .map(CurrentUser)
            .ok_or_else(ApiError::unauthenticated)
    }
}
