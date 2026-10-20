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
        let token = session::read_cookie(&parts.headers).ok_or_else(ApiError::unauthenticated)?;
        let now = state.clock.now_ms();
        session::lookup(&state.db, &state.config.sessions, now, &token)
            .await?
            .map(CurrentUser)
            .ok_or_else(ApiError::unauthenticated)
    }
}
