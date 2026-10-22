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
    /// A finer, stable reason the UI translates (data source errors list theirs in
    /// docs/api/datasources.md), with the values its text needs. Boxed, so every `ApiResult`
    /// stays small.
    pub reason: Option<Box<Reason>>,
}

#[derive(Debug, Default)]
pub struct Reason {
    pub code: String,
    pub params: std::collections::BTreeMap<String, String>,
}

pub type ApiResult<T> = Result<T, ApiError>;

impl ApiError {
    pub fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        debug_assert!(ERROR_CODES.contains(&code), "error code {code} is missing from ERROR_CODES");
        Self { status, code, message: message.into(), field: None, current: None, reason: None }
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

    /// Adds the reason code and its parameters. Reasons are literals, so a test can check each one
    /// against docs/api/datasources.md.
    pub fn with_reason(self, reason: &'static str, params: std::collections::BTreeMap<String, String>) -> Self {
        self.with_reason_string(reason.to_string(), params)
    }

    /// Like `with_reason`, for a reason that was already checked where it was made and is only
    /// passed on (a query outcome answered by a single-query route).
    pub fn with_reason_string(mut self, reason: String, params: std::collections::BTreeMap<String, String>) -> Self {
        self.reason = Some(Box::new(Reason { code: reason, params }));
        self
    }

    /// Adds a reason code without parameters; `param` adds them one by one.
    pub fn because(self, reason: &'static str) -> Self {
        self.with_reason(reason, Default::default())
    }

    pub fn param(mut self, key: &str, value: impl ToString) -> Self {
        debug_assert!(self.reason.is_some(), "param({key}) needs a reason first");
        if let Some(r) = self.reason.as_mut() {
            r.params.insert(key.to_string(), value.to_string());
        }
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
        // Once this request committed a change, "busy, nothing changed" would be untrue.
        if crate::db::committed() {
            return Self::internal("database, after a commit", e);
        }
        match contention(&e) {
            Some(Contention::Busy) => {
                tracing::warn!("database busy, answering 503: {e}");
                Self::busy()
            }
            Some(Contention::Deadlock) => {
                // The client may retry, but a deadlock means two transactions took their locks in
                // different orders: a bug in the lock order (authz.rs).
                tracing::error!("database deadlock, answering 503; check the lock order: {e}");
                Self::busy()
            }
            // A pool without a free connection is an outage or leaked connections, and
            // SQLITE_LOCKED a conflict inside one connection: faults, not contention.
            None => Self::internal("database", e),
        }
    }
}

impl ApiError {
    /// The database could not give this request its lock in time (other writers, a backup). It
    /// is only answered where nothing was committed yet, so the client may simply send the request
    /// again (`Retry-After`).
    pub fn busy() -> Self {
        Self::new(StatusCode::SERVICE_UNAVAILABLE, "busy", "the database is busy; try again in a moment")
    }
}

enum Contention {
    Busy,
    Deadlock,
}

/// Lock contention, as opposed to a fault: SQLite's `SQLITE_BUSY` (with its extended codes), and
/// PostgreSQL's serialization failure, lock timeout and deadlock.
fn contention(e: &sqlx::Error) -> Option<Contention> {
    let sqlx::Error::Database(d) = e else { return None };
    if d.try_downcast_ref::<sqlx::sqlite::SqliteError>().is_some() {
        return sqlite_contention(d.code().as_deref());
    }
    if d.try_downcast_ref::<sqlx::postgres::PgDatabaseError>().is_some() {
        return postgres_contention(d.code().as_deref());
    }
    None
}

/// SQLite's extended result codes keep the primary code in the low byte; only SQLITE_BUSY (5:
/// another connection holds the lock) is contention. SQLITE_LOCKED (6) is a conflict inside one
/// connection, a bug.
fn sqlite_contention(code: Option<&str>) -> Option<Contention> {
    let primary = code.and_then(|c| c.parse::<i32>().ok()).map(|c| c & 0xff);
    (primary == Some(5)).then_some(Contention::Busy)
}

fn postgres_contention(code: Option<&str>) -> Option<Contention> {
    match code {
        Some("40001" | "55P03") => Some(Contention::Busy),
        Some("40P01") => Some(Contention::Deadlock),
        _ => None,
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let mut error = json!({ "code": self.code, "message": self.message });
        if let Some(field) = self.field {
            error["field"] = json!(field);
        }
        if let Some(reason) = self.reason {
            error["reason"] = json!(reason.code);
            if !reason.params.is_empty() {
                error["params"] = json!(reason.params);
            }
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
        let busy = ApiError::busy();
        assert_eq!((busy.status, busy.code), (StatusCode::SERVICE_UNAVAILABLE, "busy"));
        let res = busy.into_response();
        assert_eq!(res.headers().get(axum::http::header::RETRY_AFTER).unwrap(), "1");
        // An exhausted pool is an outage or a leak, not contention.
        assert_eq!(ApiError::from(sqlx::Error::PoolTimedOut).code, "internal");
        assert_eq!(ApiError::from(sqlx::Error::RowNotFound).code, "internal");
    }

    /// SQLITE_BUSY from a real lock is busy; SQLITE_LOCKED (a conflict within one connection) is
    /// a fault.
    #[tokio::test]
    async fn only_sqlite_busy_is_contention() {
        use sqlx::Connection;
        sqlx::any::install_default_drivers();
        let dir = tempfile::tempdir().unwrap();
        let url = crate::config::sqlite_url(&dir.path().join("k.db"));
        let mut holder = sqlx::AnyConnection::connect(&url).await.unwrap();
        sqlx::query("CREATE TABLE t (x BIGINT)").execute(&mut holder).await.unwrap();
        sqlx::query("BEGIN IMMEDIATE").execute(&mut holder).await.unwrap();
        let mut other = sqlx::AnyConnection::connect(&url).await.unwrap();
        sqlx::query("PRAGMA busy_timeout = 10").execute(&mut other).await.unwrap();
        let busy = sqlx::query("INSERT INTO t VALUES (1)").execute(&mut other).await.unwrap_err();
        assert_eq!(ApiError::from(busy).code, "busy");

        // Extended codes: BUSY_RECOVERY (261) and BUSY_SNAPSHOT (517) are busy; LOCKED (6) and
        // LOCKED_SHAREDCACHE (262) are not.
        for (code, busy) in [("5", true), ("261", true), ("517", true), ("6", false), ("262", false), ("1", false)] {
            assert_eq!(sqlite_contention(Some(code)).is_some(), busy, "{code}");
        }
        assert!(matches!(postgres_contention(Some("40P01")), Some(Contention::Deadlock)));
        assert!(matches!(postgres_contention(Some("40001")), Some(Contention::Busy)));
        assert!(postgres_contention(Some("23505")).is_none());
        holder.close().await.unwrap();
        other.close().await.unwrap();
        dir.close().unwrap();
    }

    #[test]
    fn codes_are_unique() {
        let mut seen = std::collections::BTreeSet::new();
        assert!(ERROR_CODES.iter().all(|c| seen.insert(*c)));
    }
}
