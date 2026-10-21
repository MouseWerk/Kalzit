//! Helpers the route handlers share: query strings and paging in the API's format, conflicts and
//! audit entries for changes.

use axum::extract::{FromRequestParts, Query};
use axum::http::StatusCode;
use axum::http::request::Parts;
use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::error::{ApiError, ApiResult};
use crate::net::RequestInfo;
use crate::shapes::Page;

/// The page size when the request names none, and the largest it may name
/// (docs/ARCHITECTURE.md, "API conventions").
pub const DEFAULT_LIMIT: u32 = 50;
pub const MAX_LIMIT: u32 = 200;

/// A query string. Values that do not parse and unknown parameters (with `deny_unknown_fields`)
/// become a `validation` error instead of axum's plain text answer.
pub struct QueryParams<T>(pub T);

impl<S: Send + Sync, T: DeserializeOwned> FromRequestParts<S> for QueryParams<T> {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        match Query::<T>::from_request_parts(parts, state).await {
            Ok(Query(value)) => Ok(Self(value)),
            Err(rejection) => Err(ApiError::validation(rejection.body_text())),
        }
    }
}

/// `?limit=&cursor=` for lists without other parameters.
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PageQuery {
    pub limit: Option<u32>,
    pub cursor: Option<String>,
}

/// Keyset paging over `(time, id)`, newest first. Queries filter with
/// `(time < $t OR (time = $t AND id < $i))`, order by `time DESC, id DESC` and fetch
/// `fetch_limit()` rows; `page` cuts the extra row off and turns it into the next cursor.
pub struct Paging {
    limit: u32,
    before_time: i64,
    before_id: String,
}

impl Paging {
    pub fn new(limit: Option<u32>, cursor: Option<&str>) -> ApiResult<Self> {
        let limit = limit.unwrap_or(DEFAULT_LIMIT);
        if limit == 0 || limit > MAX_LIMIT {
            return Err(ApiError::validation(format!("limit must be 1 to {MAX_LIMIT}")).with_field("limit"));
        }
        let Some(cursor) = cursor else {
            // Every row sorts before this, so the first page needs no second query shape.
            return Ok(Self { limit, before_time: i64::MAX, before_id: String::new() });
        };
        let bad = || ApiError::validation("cursor is not valid").with_field("cursor");
        let raw = hex::decode(cursor).map_err(|_| bad())?;
        let text = String::from_utf8(raw).map_err(|_| bad())?;
        let (time, id) = text.split_once(':').ok_or_else(bad)?;
        Ok(Self { limit, before_time: time.parse().map_err(|_| bad())?, before_id: id.to_string() })
    }

    pub fn before_time(&self) -> i64 {
        self.before_time
    }

    pub fn before_id(&self) -> &str {
        &self.before_id
    }

    /// One row more than the page holds, to learn whether another page follows.
    pub fn fetch_limit(&self) -> i64 {
        i64::from(self.limit) + 1
    }

    pub fn page<T>(&self, mut rows: Vec<T>, key: impl Fn(&T) -> (i64, &str)) -> Page<T> {
        let more = rows.len() > self.limit as usize;
        rows.truncate(self.limit as usize);
        let next_cursor = rows.last().filter(|_| more).map(|last| {
            let (time, id) = key(last);
            hex::encode(format!("{time}:{id}"))
        });
        Page { items: rows, next_cursor }
    }
}

pub fn conflict(message: impl Into<String>) -> ApiError {
    ApiError::new(StatusCode::CONFLICT, "conflict", message)
}

/// True for a unique constraint violation, which a concurrent request can cause after the
/// handler's own check passed.
pub fn is_unique_violation(e: &sqlx::Error) -> bool {
    matches!(e, sqlx::Error::Database(d) if d.is_unique_violation())
}

/// Who made a change, for its audit entry.
pub struct Actor<'a> {
    pub user_id: &'a str,
    pub info: &'a RequestInfo,
    pub at_ms: i64,
}

/// Writes the audit entry of a change; call it inside the change's transaction.
pub async fn audit(
    conn: &mut sqlx::AnyConnection,
    actor: &Actor<'_>,
    org_id: Option<&str>,
    action: &str,
    resource: (&str, &str),
    summary: Value,
) -> ApiResult<()> {
    let event = crate::audit::AuditEvent {
        org_id,
        actor_user_id: Some(actor.user_id),
        actor_address: Some(actor.info.client_ip.to_string()),
        action,
        resource_type: Some(resource.0),
        resource_id: Some(resource.1),
        summary,
        at_ms: actor.at_ms,
    };
    crate::audit::record(conn, &event).await?;
    Ok(())
}

/// Description and similar free texts: trimmed, bounded, no control characters except line
/// breaks.
pub fn clean_text(raw: &str, what: &str, max_chars: usize) -> ApiResult<String> {
    let text = raw.trim();
    if text.chars().count() > max_chars {
        return Err(ApiError::validation(format!("{what} may have at most {max_chars} characters")));
    }
    if text.chars().any(|c| c.is_control() && c != '\n') {
        return Err(ApiError::validation(format!("{what} contains control characters")));
    }
    Ok(text.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cursors_round_trip_and_reject_garbage() {
        let first = Paging::new(Some(2), None).unwrap();
        let page = first.page(vec![(30, "c"), (20, "b"), (10, "a")], |r| (r.0, r.1));
        assert_eq!(page.items, [(30, "c"), (20, "b")]);
        let next = Paging::new(Some(2), page.next_cursor.as_deref()).unwrap();
        assert_eq!((next.before_time(), next.before_id()), (20, "b"));
        let last = next.page(vec![(10, "a")], |r| (r.0, r.1));
        assert_eq!(last.next_cursor, None);
        for bad in ["zz", "00", &hex::encode("x:y"), &hex::encode([0xff, 0xfe])] {
            assert_eq!(Paging::new(None, Some(bad)).err().unwrap().field, Some("cursor"), "{bad}");
        }
        assert!(Paging::new(Some(0), None).is_err() && Paging::new(Some(201), None).is_err());
        assert!(Paging::new(Some(200), None).is_ok());
    }

    #[test]
    fn texts_keep_line_breaks_but_not_other_controls() {
        assert_eq!(clean_text("  Prüft\nAudit ", "description", 20).unwrap(), "Prüft\nAudit");
        assert!(clean_text("a\u{0}b", "description", 20).is_err());
        assert!(clean_text(&"ä".repeat(21), "description", 20).is_err());
    }
}
