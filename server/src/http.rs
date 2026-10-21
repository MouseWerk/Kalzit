//! The one HTTP client factory. Every outgoing HTTP request (data sources such as Prometheus)
//! uses a client from here: timeouts, the platform's certificate store plus an optional extra
//! CA, and the target check (`datasources::targets`) on every connection and every redirect. A
//! guard test fails when another module builds its own client.
//!
//! Data source traffic never goes through a proxy (system proxy variables are ignored): a proxy
//! resolves names itself, so the target check could not see the address it connects to. A
//! configurable proxy that tunnels to the checked address can come later.

use std::sync::Arc;
use std::time::Duration;

use reqwest::header::{AUTHORIZATION, HeaderMap, LOCATION};
use reqwest::{Method, StatusCode, Url};

use crate::datasources::targets::{Blocked, ResolveError, TargetPolicy, parse_ip_literal};

/// Redirects followed per request; each hop is checked like the first.
const MAX_REDIRECTS: usize = 5;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

pub struct HttpOptions {
    /// Whole request including the body; data sources pass their query timeout.
    pub timeout: Duration,
    /// PEM certificates trusted in addition to the platform's store (a private CA).
    pub extra_root_pem: Option<String>,
    pub policy: Arc<TargetPolicy>,
}

#[derive(Debug, thiserror::Error)]
pub enum HttpError {
    #[error(transparent)]
    Blocked(#[from] Blocked),
    #[error("the request timed out")]
    Timeout,
    #[error("the response is larger than {0} bytes")]
    TooLarge(usize),
    #[error("{0}")]
    Other(String),
}

impl HttpError {
    /// The reason code, parameters and text for the API.
    pub fn detail(&self) -> crate::datasources::Detail {
        use crate::datasources::Detail;
        match self {
            HttpError::Blocked(b) => b.0.clone(),
            HttpError::Timeout => Detail::new("http.timeout", self.to_string()),
            HttpError::TooLarge(max) => Detail::new("http.too_large", self.to_string()).with("bytes", max),
            HttpError::Other(message) => Detail::new("http.failed", message.clone()).with("detail", message),
        }
    }
}

impl From<ResolveError> for HttpError {
    fn from(e: ResolveError) -> Self {
        match e {
            ResolveError::Blocked(b) => Self::Blocked(b),
            other => Self::Other(other.to_string()),
        }
    }
}

impl From<reqwest::Error> for HttpError {
    fn from(e: reqwest::Error) -> Self {
        if e.is_timeout() {
            return Self::Timeout;
        }
        // A blocked address from the resolver arrives wrapped in connector errors.
        let mut source: Option<&(dyn std::error::Error + 'static)> = Some(&e);
        while let Some(err) = source {
            if let Some(blocked) = err.downcast_ref::<Blocked>() {
                return Self::Blocked(blocked.clone());
            }
            source = err.source();
        }
        // The URL may carry query parameters; the message without it is enough.
        Self::Other(e.without_url().to_string())
    }
}

/// A client whose every connection goes to a checked address.
pub struct HttpClient {
    client: reqwest::Client,
    policy: Arc<TargetPolicy>,
}

/// Resolves names through the target policy, so the connection uses the checked address.
struct CheckedResolver(Arc<TargetPolicy>);

impl reqwest::dns::Resolve for CheckedResolver {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let policy = self.0.clone();
        let host = name.as_str().to_string();
        Box::pin(async move {
            // Port 0 is replaced by the URL's port.
            // Every returned address passed the check, so the client may try them in turn.
            let addrs =
                policy.resolve_all(&host, 0).await.map_err(|e| -> Box<dyn std::error::Error + Send + Sync> {
                    match e {
                        ResolveError::Blocked(b) => Box::new(b),
                        other => Box::new(other),
                    }
                })?;
            Ok(Box::new(addrs.into_iter()) as reqwest::dns::Addrs)
        })
    }
}

/// rustls needs one process-wide crypto provider for clients built without an explicit one; the
/// server uses ring everywhere.
pub fn ensure_crypto_provider() {
    // Fails only when a provider is already installed, which is fine.
    let _ = rustls::crypto::ring::default_provider().install_default();
}

pub fn client(opts: HttpOptions) -> Result<HttpClient, HttpError> {
    ensure_crypto_provider();
    let mut builder = reqwest::Client::builder()
        .timeout(opts.timeout)
        .connect_timeout(CONNECT_TIMEOUT.min(opts.timeout))
        .user_agent(concat!("Kalzit/", env!("CARGO_PKG_VERSION")))
        // Redirects are followed in `send`, which checks each target first.
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .dns_resolver(Arc::new(CheckedResolver(opts.policy.clone())));
    if let Some(pem) = opts.extra_root_pem.as_deref().filter(|p| !p.trim().is_empty()) {
        for cert in reqwest::Certificate::from_pem_bundle(pem.as_bytes())
            .map_err(|e| HttpError::Other(format!("the CA certificate is not valid PEM: {e}")))?
        {
            builder = builder.add_root_certificate(cert);
        }
    }
    let client = builder.build().map_err(|e| HttpError::Other(format!("building the HTTP client: {e}")))?;
    Ok(HttpClient { client, policy: opts.policy })
}

impl HttpClient {
    /// Sends a request and follows redirects, checking every target. Authorization and every
    /// header marked sensitive are dropped when a redirect leaves the origin, so credentials are
    /// not handed to another host.
    pub async fn send(&self, method: Method, url: Url, headers: HeaderMap) -> Result<reqwest::Response, HttpError> {
        self.send_with_body(method, url, headers, None).await
    }

    /// `send` with a request body. A redirect keeps the method and body only for 307 and 308;
    /// any other redirect continues as a GET without body, as browsers do.
    pub async fn send_with_body(
        &self,
        method: Method,
        url: Url,
        headers: HeaderMap,
        body: Option<Vec<u8>>,
    ) -> Result<reqwest::Response, HttpError> {
        let mut url = url;
        let mut method = method;
        let mut headers = headers;
        let mut body = body;
        for _ in 0..=MAX_REDIRECTS {
            self.check_url(&url).await?;
            let mut request = self.client.request(method.clone(), url.clone()).headers(headers.clone());
            if let Some(b) = &body {
                request = request.body(b.clone());
            }
            let response = request.send().await?;
            if !response.status().is_redirection() {
                return Ok(response);
            }
            let Some(location) = response.headers().get(LOCATION).and_then(|l| l.to_str().ok()) else {
                return Ok(response);
            };
            let next = url.join(location).map_err(|e| HttpError::Other(format!("invalid redirect target: {e}")))?;
            if next.origin() != url.origin() {
                headers.remove(AUTHORIZATION);
                let sensitive: Vec<_> =
                    headers.iter().filter(|(_, v)| v.is_sensitive()).map(|(k, _)| k.clone()).collect();
                for name in sensitive {
                    headers.remove(name);
                }
            }
            let keeps_method =
                matches!(response.status(), StatusCode::TEMPORARY_REDIRECT | StatusCode::PERMANENT_REDIRECT);
            if response.status() == StatusCode::SEE_OTHER || (!keeps_method && body.is_some()) {
                method = Method::GET;
                body = None;
                headers.remove(reqwest::header::CONTENT_TYPE);
            }
            url = next;
        }
        Err(HttpError::Other(format!("more than {MAX_REDIRECTS} redirects")))
    }

    /// Names are checked by the resolver when the client connects (there is no proxy); this
    /// covers the scheme and address literals, which skip the resolver.
    async fn check_url(&self, url: &Url) -> Result<(), HttpError> {
        if !matches!(url.scheme(), "http" | "https") {
            let detail = crate::datasources::Detail::new(
                "target.scheme_not_allowed",
                format!("{} URLs are not allowed", url.scheme()),
            )
            .with("scheme", url.scheme());
            return Err(Blocked(detail).into());
        }
        let host = url.host_str().ok_or_else(|| HttpError::Other("the URL has no host".into()))?;
        if let Some(ip) = parse_ip_literal(host) {
            self.policy.check_ip(host, ip)?;
        }
        Ok(())
    }
}

/// Reads a body up to `max` bytes; a larger body is an error instead of a truncated document.
pub async fn read_limited(response: reqwest::Response, max: usize) -> Result<Vec<u8>, HttpError> {
    read_counted(response, max, |_| true).await
}

/// Like `read_limited`, and `admit` is asked before each chunk is kept (to charge a budget as
/// the data arrives); a refusal ends the read as too large.
pub async fn read_counted(
    mut response: reqwest::Response,
    max: usize,
    mut admit: impl FnMut(usize) -> bool,
) -> Result<Vec<u8>, HttpError> {
    if response.content_length().is_some_and(|len| len > max as u64) {
        return Err(HttpError::TooLarge(max));
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        if body.len() + chunk.len() > max || !admit(chunk.len()) {
            return Err(HttpError::TooLarge(max));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::Router;
    use axum::http::header;
    use axum::response::IntoResponse;

    #[expect(clippy::disallowed_methods, reason = "a fake upstream server, not an API route")]
    async fn upstream() -> std::net::SocketAddr {
        let app = Router::new()
            .route("/ok", axum::routing::get(|| async { "fertig" }))
            .route(
                "/to-metadata",
                axum::routing::get(|| async {
                    (StatusCode::FOUND, [(header::LOCATION, "http://169.254.169.254/latest/meta-data")]).into_response()
                }),
            )
            .route(
                "/to-ok",
                axum::routing::get(|| async { (StatusCode::FOUND, [(header::LOCATION, "/ok")]).into_response() }),
            )
            .route("/big", axum::routing::get(|| async { "x".repeat(10_000) }))
            .route(
                "/auth",
                axum::routing::get(|headers: axum::http::HeaderMap| async move {
                    headers.get(header::AUTHORIZATION).map(|v| v.to_str().unwrap().to_string()).unwrap_or_default()
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        addr
    }

    fn test_client(allowed: &[&str]) -> HttpClient {
        let allowed: Vec<String> = allowed.iter().map(|s| s.to_string()).collect();
        let policy = TargetPolicy::new(&std::env::temp_dir().join("kalzit-none"), "sqlite::memory:", &[], &allowed);
        client(HttpOptions { timeout: Duration::from_secs(5), extra_root_pem: None, policy: Arc::new(policy) }).unwrap()
    }

    #[tokio::test]
    async fn follows_checked_redirects_and_refuses_blocked_ones() {
        let addr = upstream().await;
        let c = test_client(&[]);
        let base = Url::parse(&format!("http://{addr}")).unwrap();
        let r = c.send(Method::GET, base.join("/to-ok").unwrap(), HeaderMap::new()).await.unwrap();
        assert_eq!(r.text().await.unwrap(), "fertig");
        let e = c.send(Method::GET, base.join("/to-metadata").unwrap(), HeaderMap::new()).await.unwrap_err();
        assert!(matches!(e, HttpError::Blocked(_)), "{e}");
        let e = c.send(Method::GET, Url::parse("http://[fe80::1]/").unwrap(), HeaderMap::new()).await.unwrap_err();
        assert!(matches!(e, HttpError::Blocked(_)), "{e}");
        let e = c.send(Method::GET, Url::parse("file:///etc/passwd").unwrap(), HeaderMap::new()).await.unwrap_err();
        assert!(matches!(e, HttpError::Blocked(_)), "{e}");
    }

    #[tokio::test]
    async fn the_allow_list_applies_to_names_resolved_by_the_client() {
        let addr = upstream().await;
        let c = test_client(&["10.0.0.0/8"]);
        let url = Url::parse(&format!("http://localhost:{}/ok", addr.port())).unwrap();
        let e = c.send(Method::GET, url, HeaderMap::new()).await.unwrap_err();
        assert!(matches!(e, HttpError::Blocked(_)), "{e}");
        let ok = test_client(&["localhost"]);
        let url = Url::parse(&format!("http://localhost:{}/ok", addr.port())).unwrap();
        assert!(ok.send(Method::GET, url, HeaderMap::new()).await.is_ok());
    }

    #[tokio::test]
    async fn bodies_are_limited() {
        let addr = upstream().await;
        let c = test_client(&[]);
        let url = Url::parse(&format!("http://{addr}/big")).unwrap();
        let r = c.send(Method::GET, url.clone(), HeaderMap::new()).await.unwrap();
        assert!(matches!(read_limited(r, 1000).await, Err(HttpError::TooLarge(1000))));
        let r = c.send(Method::GET, url, HeaderMap::new()).await.unwrap();
        assert_eq!(read_limited(r, 10_000).await.unwrap().len(), 10_000);
    }

    /// Every HTTP client comes from this module, so none skips the target check, the proxy
    /// settings or the timeouts.
    #[test]
    fn no_other_module_builds_an_http_client() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let forbidden = [
            "reqwest::Client",
            "reqwest::ClientBuilder",
            "Client::builder",
            "Client::new(",
            "reqwest::get(",
            "hyper::client",
            "hyper_util::client",
            "legacy::Client",
        ];
        let mut stack = vec![root.clone()];
        let mut offenders = Vec::new();
        while let Some(dir) = stack.pop() {
            for entry in std::fs::read_dir(&dir).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    stack.push(path);
                    continue;
                }
                if path.extension().is_none_or(|e| e != "rs") || path == root.join("http.rs") {
                    continue;
                }
                let text = std::fs::read_to_string(&path).unwrap();
                for needle in forbidden {
                    if text.contains(needle) {
                        offenders.push(format!("{}: {needle}", path.display()));
                    }
                }
            }
        }
        assert!(offenders.is_empty(), "build HTTP clients with crate::http::client: {offenders:#?}");
    }

    #[expect(clippy::disallowed_methods, reason = "a fake upstream server, not an API route")]
    async fn redirector(target: String) -> std::net::SocketAddr {
        let app = Router::new().route(
            "/",
            axum::routing::any(move || async move {
                (StatusCode::TEMPORARY_REDIRECT, [(header::LOCATION, target)]).into_response()
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        addr
    }

    #[tokio::test]
    async fn authorization_does_not_follow_a_redirect_to_another_origin() {
        let addr = upstream().await;
        let c = test_client(&[]);
        let mut headers = HeaderMap::new();
        headers.insert(AUTHORIZATION, "Bearer geheim".parse().unwrap());
        let same = Url::parse(&format!("http://{addr}/auth")).unwrap();
        let r = c.send(Method::GET, same, headers.clone()).await.unwrap();
        assert_eq!(r.text().await.unwrap(), "Bearer geheim");
        // Same host, other port: another origin.
        let hop = redirector(format!("http://{addr}/auth")).await;
        let r = c.send(Method::GET, Url::parse(&format!("http://{hop}/")).unwrap(), headers).await.unwrap();
        assert_eq!(r.text().await.unwrap(), "");
    }

    #[expect(clippy::disallowed_methods, reason = "a fake upstream server, not an API route")]
    async fn echo_key() -> std::net::SocketAddr {
        let app = Router::new().route(
            "/key",
            axum::routing::any(|method: Method, headers: axum::http::HeaderMap, body: String| async move {
                let key = headers.get("x-api-key").map(|v| v.to_str().unwrap().to_string()).unwrap_or_default();
                format!("{method} {key} {body}")
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        addr
    }

    #[tokio::test]
    async fn sensitive_headers_and_bodies_follow_redirects_only_where_safe() {
        let addr = echo_key().await;
        let c = test_client(&[]);
        let mut headers = HeaderMap::new();
        let mut key = reqwest::header::HeaderValue::from_static("geheim");
        key.set_sensitive(true);
        headers.insert("x-api-key", key);
        let same = Url::parse(&format!("http://{addr}/key")).unwrap();
        let r = c.send_with_body(Method::POST, same, headers.clone(), Some(b"{}".to_vec())).await.unwrap();
        assert_eq!(r.text().await.unwrap(), "POST geheim {}");
        // A 307 to another origin keeps the method and body, but not the sensitive header.
        let hop = redirector(format!("http://{addr}/key")).await;
        let url = Url::parse(&format!("http://{hop}/")).unwrap();
        let r = c.send_with_body(Method::POST, url, headers, Some(b"{}".to_vec())).await.unwrap();
        assert_eq!(r.text().await.unwrap(), "POST  {}");
    }
}
