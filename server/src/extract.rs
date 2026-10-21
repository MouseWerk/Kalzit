//! Request extractors that answer in the API's error format instead of axum's plain text.

use axum::Json;
use axum::extract::{FromRequest, Request};
use serde::de::DeserializeOwned;

use crate::error::ApiError;

/// A JSON body. Malformed JSON, unknown fields and a wrong content type become a `validation`
/// error (reason `request.body_invalid`) with axum's explanation as the message and `detail`.
pub struct JsonBody<T>(pub T);

impl<S: Send + Sync, T: DeserializeOwned> FromRequest<S> for JsonBody<T> {
    type Rejection = ApiError;

    async fn from_request(req: Request, state: &S) -> Result<Self, Self::Rejection> {
        match Json::<T>::from_request(req, state).await {
            Ok(Json(value)) => Ok(Self(value)),
            Err(rejection) => {
                let status = rejection.status();
                let detail = rejection.body_text();
                if status == axum::http::StatusCode::PAYLOAD_TOO_LARGE {
                    return Err(ApiError::new(status, "payload_too_large", detail));
                }
                Err(ApiError::new(status, "validation", detail.clone())
                    .because("request.body_invalid")
                    .param("detail", detail))
            }
        }
    }
}
