//! Request extractors that answer in the API's error format instead of axum's plain text.

use axum::Json;
use axum::extract::{FromRequest, Request};
use serde::de::DeserializeOwned;

use crate::error::ApiError;

/// A JSON body. Malformed JSON, unknown fields and a wrong content type become a `validation`
/// error with axum's explanation as the message.
pub struct JsonBody<T>(pub T);

impl<S: Send + Sync, T: DeserializeOwned> FromRequest<S> for JsonBody<T> {
    type Rejection = ApiError;

    async fn from_request(req: Request, state: &S) -> Result<Self, Self::Rejection> {
        match Json::<T>::from_request(req, state).await {
            Ok(Json(value)) => Ok(Self(value)),
            Err(rejection) => {
                let status = rejection.status();
                let code = if status == axum::http::StatusCode::PAYLOAD_TOO_LARGE {
                    "payload_too_large"
                } else {
                    "validation"
                };
                Err(ApiError::new(status, code, rejection.body_text()))
            }
        }
    }
}
