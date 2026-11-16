//! Cross-origin requests to the API (CORS, docs/api/settings-dashboards.md, "CORS"): off by
//! default (no CORS headers at all). When `cors.enabled` is on, pages of the origins in
//! `cors.allowed_origins` may call `/api/...` from the browser with the methods and headers the
//! settings list. Origins are `scheme://host[:port]`; `https://*.example.com` stands for every
//! subdomain of `example.com` (never the domain itself, never a bare `*`), and `http://` is only
//! for `localhost`, `127.0.0.1` and `[::1]`. `Access-Control-Allow-Origin` always names the one
//! origin that asked. A wildcard never goes together with the session cookie: with
//! `cors.allow_credentials` on, wildcard entries match nothing. Values set in `kalzit.toml`
//! (`[cors]`) lock the setting.
//!
//! Without `cors.allow_credentials` a cross-origin request never acts on a session: its `Cookie`
//! header is removed before the route sees it, so only API tokens (`Authorization: Bearer`) sign
//! it in. With the switch, the session cookie counts as it does for Kalzit's own pages; the
//! origin check (`net::origin_check`) lets an allowed origin through either way, every other
//! cross-origin request keeps being refused as before.

use axum::extract::{Request, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use serde_json::Value;

use crate::app::AppState;
use crate::error::ApiError;
use crate::net::{RequestInfo, parse_origin};

/// Marks a request from an allowed origin, for the origin check.
#[derive(Clone, Copy, Debug)]
pub struct Approved;

/// The methods `cors.allowed_methods` may name.
pub const METHODS: &[&str] = &["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"];

/// Request headers a browser sends without asking (CORS-safelisted), allowed whatever the
/// settings say.
const SAFELISTED: &[&str] = &["accept", "accept-language", "content-language"];

/// Response headers pages of an allowed origin may read besides the safelisted ones.
const EXPOSED: &str = "Retry-After, X-Request-Id, Content-Disposition";

/// The rules in force, read from the settings.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Policy {
    origins: Vec<Allowed>,
    methods: Vec<String>,
    /// Lowercase.
    headers: Vec<String>,
    credentials: bool,
    max_age_secs: i64,
}

fn strings(value: &Value) -> Vec<String> {
    value.as_array().into_iter().flatten().filter_map(Value::as_str).map(str::to_string).collect()
}

impl Policy {
    /// The policy from the settings' values; `None` when CORS is off or lists no origin.
    pub fn from_values(
        enabled: &Value,
        origins: &Value,
        methods: &Value,
        headers: &Value,
        credentials: &Value,
        max_age: &Value,
    ) -> Option<Self> {
        if enabled.as_bool() != Some(true) {
            return None;
        }
        let origins: Vec<_> = strings(origins).iter().filter_map(|o| allowed_origin(o)).collect();
        if origins.is_empty() {
            return None;
        }
        Some(Self {
            origins,
            methods: strings(methods).into_iter().map(|m| m.to_ascii_uppercase()).collect(),
            headers: strings(headers).into_iter().map(|h| h.to_ascii_lowercase()).collect(),
            credentials: credentials.as_bool() == Some(true),
            max_age_secs: max_age.as_i64().unwrap_or(0).clamp(0, 86_400),
        })
    }

    pub fn allows_origin(&self, origin: &str) -> bool {
        let Some((scheme, host, port)) = exact_origin(origin) else { return false };
        self.origins.iter().any(|a| match a {
            Allowed::Exact(s, h, p) => *s == scheme && *h == host && *p == port,
            // Never with the session cookie.
            Allowed::Subdomains(s, suffix, p) => {
                !self.credentials
                    && *s == scheme
                    && *p == port
                    && host.ends_with(suffix.as_str())
                    && host.len() > suffix.len()
            }
        })
    }

    fn allows_method(&self, method: &str) -> bool {
        self.methods.iter().any(|m| m == method)
    }

    /// Every header of an `Access-Control-Request-Headers` list.
    fn allows_headers(&self, requested: &str) -> bool {
        requested
            .split(',')
            .map(|h| h.trim().to_ascii_lowercase())
            .filter(|h| !h.is_empty())
            .all(|h| SAFELISTED.contains(&h.as_str()) || self.headers.contains(&h))
    }
}

/// The policy in force; `None` when off. A settings read that fails counts as off, so nothing
/// opens by accident.
pub async fn policy(state: &AppState) -> Option<Policy> {
    let read = async {
        let get = |key: &'static str| crate::settings::get(state, key);
        Ok::<_, ApiError>(Policy::from_values(
            &get("cors.enabled").await?,
            &get("cors.allowed_origins").await?,
            &get("cors.allowed_methods").await?,
            &get("cors.allowed_headers").await?,
            &get("cors.allow_credentials").await?,
            &get("cors.max_age_secs").await?,
        ))
    };
    match read.await {
        Ok(policy) => policy,
        Err(e) => {
            tracing::warn!("the CORS settings cannot be read, cross-origin requests are refused: {}", e.message);
            None
        }
    }
}

/// An entry of `cors.allowed_origins`.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Allowed {
    Exact(String, String, u16),
    /// `https://*.example.com`: scheme, `.example.com`, port.
    Subdomains(String, String, u16),
}

fn is_localhost(host: &str) -> bool {
    matches!(host, "localhost" | "127.0.0.1" | "[::1]")
}

/// An entry as the policy compares it: an exact origin or `scheme://*.domain[:port]` with at least
/// two labels after the wildcard; `http` only for localhost.
fn allowed_origin(text: &str) -> Option<Allowed> {
    if let Some((scheme, rest)) = text.split_once("://*.") {
        let domain = rest.split(':').next().unwrap_or_default();
        if domain.contains('*') || domain.split('.').filter(|l| !l.is_empty()).count() < 2 || scheme != "https" {
            return None;
        }
        let (s, host, port) = exact_origin(&format!("{scheme}://x.{rest}"))?;
        return Some(Allowed::Subdomains(s, host[1..].to_string(), port));
    }
    let (scheme, host, port) = exact_origin(text)?;
    (scheme == "https" || is_localhost(&host)).then_some(Allowed::Exact(scheme, host, port))
}

/// `scheme://host[:port]` exactly: http or https, a host, no user, path, query or fragment and no
/// wildcard. Answers the compared form.
fn exact_origin(text: &str) -> Option<(String, String, u16)> {
    if text.contains('*') || text.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return None;
    }
    let (_, rest) = text.split_once("://")?;
    if rest.is_empty() || rest.contains(['/', '?', '#', '@']) {
        return None;
    }
    parse_origin(text)
}

fn list<'a>(key: &str, value: &'a Value, max: usize) -> Result<Vec<&'a str>, String> {
    let items = value.as_array().ok_or_else(|| format!("{key} must be a list of texts"))?;
    if items.len() > max {
        return Err(format!("{key} takes at most {max} entries"));
    }
    items.iter().map(|v| v.as_str().ok_or_else(|| format!("{key} entries must be texts"))).collect()
}

/// `cors.allowed_origins`.
pub fn check_origins(key: &str, value: &Value) -> Result<(), String> {
    for origin in list(key, value, 100)? {
        if allowed_origin(origin).is_none() {
            return Err(format!(
                "{key}: {origin:?} is not an origin such as https://app.example.com or https://*.example.com (scheme, host and port only; http only for localhost)"
            ));
        }
    }
    Ok(())
}

/// `cors.allowed_methods`.
pub fn check_methods(key: &str, value: &Value) -> Result<(), String> {
    for method in list(key, value, METHODS.len())? {
        if !METHODS.contains(&method.to_ascii_uppercase().as_str()) {
            return Err(format!("{key}: use only {}", METHODS.join(", ")));
        }
    }
    Ok(())
}

/// `cors.allowed_headers`: header names (RFC 9110 tokens), no wildcard.
pub fn check_headers(key: &str, value: &Value) -> Result<(), String> {
    for name in list(key, value, 50)? {
        let token = !name.is_empty()
            && name.len() <= 100
            && name.bytes().all(|b| b.is_ascii_alphanumeric() || b"!#$%&'+-.^_`|~".contains(&b));
        if !token {
            return Err(format!("{key}: {name:?} is not a header name"));
        }
    }
    Ok(())
}

fn refused(message: &str) -> Response {
    ApiError::new(StatusCode::FORBIDDEN, "cross_origin", message.to_string())
        .because("request.cross_origin_refused")
        .into_response()
}

fn header_value(text: &str) -> Option<HeaderValue> {
    HeaderValue::from_str(text).ok()
}

/// The answer to a preflight (`OPTIONS` with `Access-Control-Request-Method`) from an allowed
/// origin, or its refusal.
fn preflight(policy: &Policy, origin: &str, headers: &HeaderMap) -> Response {
    let method = headers.get(header::ACCESS_CONTROL_REQUEST_METHOD).and_then(|v| v.to_str().ok()).unwrap_or_default();
    if !policy.allows_method(method) {
        return refused("this method is not allowed for cross-origin requests");
    }
    let requested =
        headers.get(header::ACCESS_CONTROL_REQUEST_HEADERS).and_then(|v| v.to_str().ok()).unwrap_or_default();
    if !policy.allows_headers(requested) {
        return refused("a requested header is not allowed for cross-origin requests");
    }
    let mut res = StatusCode::NO_CONTENT.into_response();
    let h = res.headers_mut();
    if let Some(v) = header_value(origin) {
        h.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, v);
    }
    if let Some(v) = header_value(&policy.methods.join(", ")) {
        h.insert(header::ACCESS_CONTROL_ALLOW_METHODS, v);
    }
    if !policy.headers.is_empty()
        && let Some(v) = header_value(&policy.headers.join(", "))
    {
        h.insert(header::ACCESS_CONTROL_ALLOW_HEADERS, v);
    }
    if policy.credentials {
        h.insert(header::ACCESS_CONTROL_ALLOW_CREDENTIALS, HeaderValue::from_static("true"));
    }
    if let Some(v) = header_value(&policy.max_age_secs.to_string()) {
        h.insert(header::ACCESS_CONTROL_MAX_AGE, v);
    }
    h.insert(header::VARY, HeaderValue::from_static("Origin"));
    res
}

/// The layer before the origin check. Requests without `Origin`, from Kalzit's own origin or
/// outside `/api` pass untouched.
pub async fn layer(State(state): State<AppState>, mut req: Request, next: Next) -> Response {
    let path = req.uri().path();
    if !(path == "/api" || path.starts_with("/api/")) {
        return next.run(req).await;
    }
    let Some(origin) = req.headers().get(header::ORIGIN).and_then(|v| v.to_str().ok()).map(str::to_string) else {
        return next.run(req).await;
    };
    if crate::net::is_own_origin(&state, &origin, req.extensions().get::<RequestInfo>()) {
        return next.run(req).await;
    }
    let is_preflight =
        req.method() == Method::OPTIONS && req.headers().contains_key(header::ACCESS_CONTROL_REQUEST_METHOD);
    let allowed = policy(&state).await.filter(|p| p.allows_origin(&origin));
    let Some(policy) = allowed else {
        if is_preflight {
            return refused("this origin may not call the API");
        }
        // No CORS headers: the browser keeps the answer from the page, and the origin check
        // refuses anything that changes data.
        return next.run(req).await;
    };
    if is_preflight {
        return preflight(&policy, &origin, req.headers());
    }
    if !policy.allows_method(req.method().as_str()) {
        return refused("this method is not allowed for cross-origin requests");
    }
    if !policy.credentials {
        req.headers_mut().remove(header::COOKIE);
    }
    req.extensions_mut().insert(Approved);
    let mut res = next.run(req).await;
    let h = res.headers_mut();
    if let Some(v) = header_value(&origin) {
        h.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, v);
    }
    if policy.credentials {
        h.insert(header::ACCESS_CONTROL_ALLOW_CREDENTIALS, HeaderValue::from_static("true"));
    }
    h.insert(header::ACCESS_CONTROL_EXPOSE_HEADERS, HeaderValue::from_static(EXPOSED));
    h.append(header::VARY, HeaderValue::from_static("Origin"));
    res
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn policy(credentials: bool) -> Policy {
        Policy::from_values(
            &json!(true),
            &json!(["https://app.example.com", "http://localhost:5173"]),
            &json!(["GET", "POST"]),
            &json!(["Authorization", "Content-Type"]),
            &json!(credentials),
            &json!(600),
        )
        .unwrap()
    }

    #[test]
    fn origins_are_exact() {
        let p = policy(false);
        assert!(p.allows_origin("https://app.example.com"));
        assert!(p.allows_origin("https://APP.example.com:443"));
        assert!(p.allows_origin("http://localhost:5173"));
        for other in [
            "https://app.example.com.evil.test",
            "http://app.example.com",
            "https://example.com",
            "http://localhost:5174",
            "null",
            "",
        ] {
            assert!(!p.allows_origin(other), "{other}");
        }
    }

    #[test]
    fn wildcards_cover_subdomains_only_and_never_with_the_cookie() {
        let p = |credentials: bool| {
            Policy::from_values(
                &json!(true),
                &json!(["https://*.example.com"]),
                &json!(["GET"]),
                &json!([]),
                &json!(credentials),
                &json!(0),
            )
            .unwrap()
        };
        assert!(p(false).allows_origin("https://app.example.com"));
        assert!(p(false).allows_origin("https://a.b.example.com"));
        assert!(!p(false).allows_origin("https://example.com"));
        assert!(!p(false).allows_origin("https://evilexample.com"));
        assert!(!p(false).allows_origin("http://app.example.com"));
        assert!(!p(true).allows_origin("https://app.example.com"));
    }

    #[test]
    fn off_or_without_origins_is_no_policy() {
        let none = |enabled: Value, origins: Value| {
            Policy::from_values(&enabled, &origins, &json!([]), &json!([]), &json!(false), &json!(0)).is_none()
        };
        assert!(none(json!(false), json!(["https://a.example"])));
        assert!(none(json!(true), json!([])));
        assert!(none(json!(true), json!(["*"])));
    }

    #[test]
    fn settings_refuse_wildcards_paths_and_unknown_methods() {
        assert!(
            check_origins("k", &json!(["https://a.example", "http://[::1]:8080", "https://*.example.com"])).is_ok()
        );
        for bad in [
            json!(["*"]),
            json!(["https://*.com"]),
            json!(["http://*.example.com"]),
            json!(["https://*.*.example.com"]),
            json!(["http://app.example.com"]),
            json!(["https://a.example/"]),
            json!(["ftp://a"]),
            json!(["https://u@a.example"]),
            json!("x"),
        ] {
            assert!(check_origins("k", &bad).is_err(), "{bad}");
        }
        assert!(check_methods("k", &json!(["get", "DELETE"])).is_ok());
        assert!(check_methods("k", &json!(["TRACE"])).is_err());
        assert!(check_headers("k", &json!(["X-Kalzit-Client", "Authorization"])).is_ok());
        assert!(check_headers("k", &json!(["*"])).is_err());
        assert!(check_headers("k", &json!(["a b"])).is_err());
    }

    #[test]
    fn preflights_check_method_and_headers() {
        let p = policy(true);
        let mut h = HeaderMap::new();
        h.insert(header::ACCESS_CONTROL_REQUEST_METHOD, HeaderValue::from_static("POST"));
        h.insert(header::ACCESS_CONTROL_REQUEST_HEADERS, HeaderValue::from_static("content-type, authorization"));
        let ok = preflight(&p, "https://app.example.com", &h);
        assert_eq!(ok.status(), StatusCode::NO_CONTENT);
        assert_eq!(ok.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN], "https://app.example.com");
        assert_eq!(ok.headers()[header::ACCESS_CONTROL_ALLOW_CREDENTIALS], "true");
        assert_eq!(ok.headers()[header::ACCESS_CONTROL_MAX_AGE], "600");
        h.insert(header::ACCESS_CONTROL_REQUEST_METHOD, HeaderValue::from_static("DELETE"));
        assert_eq!(preflight(&p, "https://app.example.com", &h).status(), StatusCode::FORBIDDEN);
        h.insert(header::ACCESS_CONTROL_REQUEST_METHOD, HeaderValue::from_static("GET"));
        h.insert(header::ACCESS_CONTROL_REQUEST_HEADERS, HeaderValue::from_static("x-other"));
        assert_eq!(preflight(&p, "https://app.example.com", &h).status(), StatusCode::FORBIDDEN);
        h.insert(header::ACCESS_CONTROL_REQUEST_HEADERS, HeaderValue::from_static("accept-language"));
        assert_eq!(preflight(&p, "https://app.example.com", &h).status(), StatusCode::NO_CONTENT);
    }
}
