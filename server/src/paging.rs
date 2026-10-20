//! List paging (`?limit=&cursor=`, answered with `shapes::Page`) and query string parsing in the
//! API's error format.

use axum::extract::{FromRequestParts, Query};
use axum::http::request::Parts;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use crate::error::{ApiError, ApiResult};

pub const DEFAULT_LIMIT: u32 = 50;
pub const MAX_LIMIT: u32 = 200;

/// A query string. Unknown parameters and values of the wrong type are a `validation` error
/// instead of axum's plain-text 400.
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

/// `limit` checked against the API's bounds (1 to 200, default 50).
pub fn limit(raw: Option<u32>) -> ApiResult<usize> {
    match raw.unwrap_or(DEFAULT_LIMIT) {
        n @ 1..=MAX_LIMIT => Ok(n as usize),
        _ => Err(ApiError::validation(format!("limit must be 1 to {MAX_LIMIT}")).with_field("limit")),
    }
}

/// Cursors are opaque to clients: the position of the last item, as hex-encoded JSON, so a
/// client cannot mistake them for something to construct.
pub fn encode_cursor<T: Serialize>(position: &T) -> String {
    hex::encode(serde_json::to_vec(position).unwrap_or_default())
}

pub fn decode_cursor<T: for<'de> Deserialize<'de>>(raw: Option<&str>) -> ApiResult<Option<T>> {
    let Some(raw) = raw else { return Ok(None) };
    let invalid = || ApiError::validation("cursor is not valid; start again without it").with_field("cursor");
    let bytes = hex::decode(raw).map_err(|_| invalid())?;
    serde_json::from_slice(&bytes).map(Some).map_err(|_| invalid())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limits_are_bounded() {
        assert_eq!(limit(None).unwrap(), 50);
        assert_eq!(limit(Some(200)).unwrap(), 200);
        for bad in [0, 201] {
            assert_eq!(limit(Some(bad)).unwrap_err().field, Some("limit"));
        }
    }

    #[test]
    fn cursors_round_trip_and_reject_garbage() {
        let c = encode_cursor(&(1_800_000_000_000_i64, "Ümlaut"));
        assert_eq!(decode_cursor::<(i64, String)>(Some(&c)).unwrap(), Some((1_800_000_000_000, "Ümlaut".into())));
        assert_eq!(decode_cursor::<(i64, String)>(None).unwrap(), None);
        for bad in ["zz", "00", &encode_cursor(&"text")] {
            assert_eq!(decode_cursor::<(i64, String)>(Some(bad)).unwrap_err().code, "validation", "{bad}");
        }
    }
}
