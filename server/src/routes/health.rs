//! Liveness and readiness for service managers, load balancers and container orchestrators.

use axum::extract::State;
use axum::http::StatusCode;

use crate::app::AppState;

/// The process is up and answering.
pub async fn healthz() -> &'static str {
    "ok"
}

/// The server can do its job: the database answers.
pub async fn readyz(State(state): State<AppState>) -> (StatusCode, &'static str) {
    match sqlx::query("SELECT 1").execute(&state.db).await {
        Ok(_) => (StatusCode::OK, "ready"),
        Err(e) => {
            tracing::warn!("readiness check: database not reachable: {e}");
            (StatusCode::SERVICE_UNAVAILABLE, "database not reachable")
        }
    }
}
