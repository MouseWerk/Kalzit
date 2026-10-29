//! The ACME client's HTTP: every request goes through Kalzit's one HTTP client (`crate::http`),
//! with the system's certificate store plus the CA of a custom directory, no proxy, and the
//! target check (never a cloud metadata address or Kalzit's own database).

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use axum::body::Bytes;
use axum::http::{Request, Response};
use instant_acme::{BodyWrapper, BytesResponse};
use reqwest::Url;

use crate::datasources::targets::TargetPolicy;
use crate::http::{self, HttpClient, HttpOptions};

const TIMEOUT: Duration = Duration::from_secs(30);
/// ACME answers are small; a certificate chain is a few KiB.
const MAX_RESPONSE_BYTES: usize = 1024 * 1024;

#[derive(Clone)]
pub struct Transport {
    client: Arc<HttpClient>,
}

impl Transport {
    pub fn new(data_dir: &std::path::Path, db_url: &str, directory_ca: Option<&str>) -> Result<Self, http::HttpError> {
        let policy = TargetPolicy::new(data_dir, db_url, &[], &[]);
        let client = http::client(HttpOptions {
            timeout: TIMEOUT,
            extra_root_pem: directory_ca.map(str::to_string),
            policy: Arc::new(policy),
        })?;
        Ok(Self { client: Arc::new(client) })
    }

    /// GET `url` and its body, for the directory check.
    pub async fn get(&self, url: &str) -> Result<(u16, Bytes), String> {
        let url = Url::parse(url).map_err(|e| e.to_string())?;
        let response =
            self.client.send(reqwest::Method::GET, url, Default::default()).await.map_err(|e| e.to_string())?;
        let status = response.status().as_u16();
        let body = http::read_limited(response, MAX_RESPONSE_BYTES).await.map_err(|e| e.to_string())?;
        Ok((status, Bytes::from(body)))
    }

    async fn send(client: Arc<HttpClient>, request: Request<BodyWrapper<Bytes>>) -> Result<BytesResponse, String> {
        let (parts, body) = request.into_parts();
        let body =
            axum::body::to_bytes(axum::body::Body::new(body), MAX_RESPONSE_BYTES).await.map_err(|e| e.to_string())?;
        let url = Url::parse(&parts.uri.to_string()).map_err(|e| e.to_string())?;
        let body = (!body.is_empty()).then(|| body.to_vec());
        let response =
            client.send_with_body(parts.method, url, parts.headers, body).await.map_err(|e| e.to_string())?;
        let status = response.status();
        let headers = response.headers().clone();
        let bytes = http::read_limited(response, MAX_RESPONSE_BYTES).await.map_err(|e| e.to_string())?;
        let mut builder = Response::builder().status(status);
        if let Some(h) = builder.headers_mut() {
            *h = headers;
        }
        let (parts, ()) = builder.body(()).map_err(|e| e.to_string())?.into_parts();
        Ok(BytesResponse { parts, body: Box::new(Bytes::from(bytes)) })
    }
}

impl instant_acme::HttpClient for Transport {
    fn request(
        &self,
        req: Request<BodyWrapper<Bytes>>,
    ) -> Pin<Box<dyn Future<Output = Result<BytesResponse, instant_acme::Error>> + Send>> {
        let client = self.client.clone();
        Box::pin(async move { Self::send(client, req).await.map_err(|e| instant_acme::Error::Other(e.into())) })
    }
}
