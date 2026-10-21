//! API errors: a machine-readable code for the UI (which translates it) and an English message
//! for logs and API clients.

use axum::Json;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::json;

/// Every error code the API answers with. The UI's `ErrorCode` type is generated from this list
/// and a UI test checks that each code has a translation; `ApiError::new` refuses other codes in
/// debug builds, so a new code cannot ship untranslated.
pub const ERROR_CODES: &[&str] = &[
    "validation",
    "unauthenticated",
    "forbidden",
    "not_found",
    "method_not_allowed",
    "payload_too_large",
    "conflict",
    "version_conflict",
    "rate_limited",
    "cross_origin",
    "invalid_credentials",
    "setup_done",
    "invalid_setup_token",
    "datasource_error",
    "datasource_target_blocked",
    "query_timeout",
    "query_rejected",
    "busy",
    "internal",
];

#[derive(Debug)]
pub struct ApiError {
    pub status: StatusCode,
    pub code: &'static str,
    pub message: String,
    /// The request field a `validation` error is about (its JSON name), so the UI can mark it.
    pub field: Option<&'static str>,
    /// For `version_conflict`: the stored resource, sent next to `error` as `current`.
    pub current: Option<serde_json::Value>,
}

pub type ApiResult<T> = Result<T, ApiError>;

impl ApiError {
    pub fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        debug_assert!(ERROR_CODES.contains(&code), "error code {code} is missing from ERROR_CODES");
        Self { status, code, message: message.into(), field: None, current: None }
    }

    /// The caller edited an older version; `current` is the stored resource to merge with.
    pub fn version_conflict(current: serde_json::Value) -> Self {
        let mut e = Self::new(StatusCode::CONFLICT, "version_conflict", "a newer version was saved in the meantime");
        e.current = Some(current);
        e
    }

    pub fn with_field(mut self, field: &'static str) -> Self {
        self.field = Some(field);
        self
    }

    pub fn validation(message: impl Into<String>) -> Self {
        Self::new(StatusCode::UNPROCESSABLE_ENTITY, "validation", message)
    }

    pub fn unauthenticated() -> Self {
        Self::new(StatusCode::UNAUTHORIZED, "unauthenticated", "sign in first")
    }

    pub fn forbidden(message: impl Into<String>) -> Self {
        Self::new(StatusCode::FORBIDDEN, "forbidden", message)
    }

    pub fn not_found() -> Self {
        Self::new(StatusCode::NOT_FOUND, "not_found", "no such resource")
    }

    /// An unexpected failure. The cause is logged; the client only learns that it happened.
    pub fn internal(context: &str, cause: impl std::fmt::Display) -> Self {
        tracing::error!("{context}: {cause}");
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, "internal", "internal error, see the server log")
    }
}

impl From<sqlx::Error> for ApiError {
    fn from(e: sqlx::Error) -> Self {
        if is_contention(&e) {
            tracing::warn!("database busy, answering 503: {e}");
            return Self::busy();
        }
        Self::internal("database", e)
    }
}

impl ApiError {
    /// The database could not give this request its lock in time (other writers, a backup). The
    /// request changed nothing; the client may simply send it again (`Retry-After`).
    pub fn busy() -> Self {
        Self::new(StatusCode::SERVICE_UNAVAILABLE, "busy", "the database is busy; try again in a moment")
    }
}

/// Lock contention, as opposed to a fault: SQLite's `SQLITE_BUSY` and `SQLITE_LOCKED` (with their
/// extended codes), PostgreSQL's serialization failure, deadlock and lock timeout, and a pool that
/// had no free connection in time.
fn is_contention(e: &sqlx::Error) -> bool {
    match e {
        sqlx::Error::PoolTimedOut => true,
        sqlx::Error::Database(d) => {
            if d.try_downcast_ref::<sqlx::sqlite::SqliteError>().is_some() {
                // Extended result codes keep the primary code in the low byte.
                let primary = d.code().and_then(|c| c.parse::<i32>().ok()).map(|c| c & 0xff);
                matches!(primary, Some(5 | 6))
            } else if d.try_downcast_ref::<sqlx::postgres::PgDatabaseError>().is_some() {
                matches!(d.code().as_deref(), Some("40001" | "40P01" | "55P03"))
            } else {
                false
            }
        }
        _ => false,
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let mut error = json!({ "code": self.code, "message": self.message });
        if let Some(field) = self.field {
            error["field"] = json!(field);
        }
        let mut body = json!({ "error": error });
        if let Some(current) = self.current {
            body["current"] = current;
        }
        let mut res = (self.status, Json(body)).into_response();
        if self.code == "busy" {
            // Locks are held for milliseconds; a second is plenty before trying again.
            res.headers_mut().insert(axum::http::header::RETRY_AFTER, axum::http::HeaderValue::from_static("1"));
        }
        res
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use http_body_util::BodyExt;

    #[tokio::test]
    async fn version_conflict_carries_the_current_resource() {
        let res = ApiError::version_conflict(json!({ "version": 4, "title": "Umsatz" })).into_response();
        assert_eq!(res.status(), StatusCode::CONFLICT);
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["error"]["code"], "version_conflict");
        assert_eq!(body["current"]["version"], 4);
    }

    #[tokio::test]
    async fn contention_is_busy_with_a_retry_hint_and_faults_stay_internal() {
        let busy = ApiError::from(sqlx::Error::PoolTimedOut);
        assert_eq!((busy.status, busy.code), (StatusCode::SERVICE_UNAVAILABLE, "busy"));
        let res = busy.into_response();
        assert_eq!(res.headers().get(axum::http::header::RETRY_AFTER).unwrap(), "1");
        assert_eq!(ApiError::from(sqlx::Error::RowNotFound).code, "internal");
    }

    #[test]
    fn codes_are_unique() {
        let mut seen = std::collections::BTreeSet::new();
        assert!(ERROR_CODES.iter().all(|c| seen.insert(*c)));
    }
}
