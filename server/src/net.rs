//! Per-request network facts (client address, HTTPS, host) with proxy headers honoured only from
//! trusted proxies, plus the CSRF origin check and the security headers on every response.

use std::net::{IpAddr, SocketAddr};

use axum::extract::connect_info::MockConnectInfo;
use axum::extract::{ConnectInfo, Request, State};
use axum::http::{HeaderMap, HeaderValue, Method, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use ipnet::IpNet;

use crate::app::AppState;
use crate::error::ApiError;

/// Set by the listener: whether the connection itself is TLS.
#[derive(Clone, Copy, Debug)]
pub struct ListenerTls(pub bool);

/// What the handlers need to know about where a request came from.
#[derive(Clone, Debug)]
pub struct RequestInfo {
    pub client_ip: IpAddr,
    /// The user's connection is HTTPS (directly, or at a trusted proxy in front of us).
    pub https: bool,
    /// Host the user addressed, from `Host` or a trusted proxy's `X-Forwarded-Host`.
    pub host: Option<String>,
}

pub async fn request_info(State(state): State<AppState>, mut req: Request, next: Next) -> Response {
    // Listeners insert `ConnectInfo`; tests insert `MockConnectInfo`. Without either the peer is
    // unknown, and an unknown peer must never count as a trusted proxy, so it becomes 0.0.0.0.
    let ext = req.extensions();
    let peer = ext
        .get::<ConnectInfo<SocketAddr>>()
        .map(|c| c.0.ip())
        .or_else(|| ext.get::<MockConnectInfo<SocketAddr>>().map(|m| m.0.ip()))
        .unwrap_or(IpAddr::from([0, 0, 0, 0]));
    let tls = req.extensions().get::<ListenerTls>().map(|t| t.0).unwrap_or(false);
    let info = resolve(peer, tls, req.headers(), &state.config.security.trusted_proxies);
    req.extensions_mut().insert(info);
    next.run(req).await
}

fn resolve(peer: IpAddr, tls: bool, headers: &HeaderMap, trusted: &[IpNet]) -> RequestInfo {
    let is_trusted = |ip: &IpAddr| trusted.iter().any(|net| net.contains(ip));
    let header_str = |name: &str| headers.get(name).and_then(|v| v.to_str().ok()).map(str::trim);
    let host = header_str("host").map(str::to_string);
    if !is_trusted(&peer) {
        return RequestInfo { client_ip: peer, https: tls, host };
    }
    // Walk X-Forwarded-For from the right: the first address that is not one of our proxies is
    // the client. Anything further left was supplied by the client and cannot be trusted.
    let client_ip = header_str("x-forwarded-for")
        .map(|v| {
            v.split(',')
                .rev()
                .filter_map(|s| s.trim().parse::<IpAddr>().ok())
                .find(|ip| !is_trusted(ip))
                .unwrap_or(peer)
        })
        .unwrap_or(peer);
    let https = match header_str("x-forwarded-proto") {
        Some(proto) => proto.eq_ignore_ascii_case("https"),
        None => tls,
    };
    let host = header_str("x-forwarded-host").map(str::to_string).or(host);
    RequestInfo { client_ip, https, host }
}

/// Rejects state-changing requests whose `Origin` is not this server. Together with
/// `SameSite=Lax` cookies this is the CSRF protection. Requests without `Origin` (API clients,
/// curl) carry no ambient browser cookies to abuse, so they pass.
pub async fn origin_check(State(state): State<AppState>, req: Request, next: Next) -> Response {
    if matches!(*req.method(), Method::GET | Method::HEAD | Method::OPTIONS) {
        return next.run(req).await;
    }
    let Some(origin) = req.headers().get(header::ORIGIN).and_then(|v| v.to_str().ok()) else {
        return next.run(req).await;
    };
    let info = req.extensions().get::<RequestInfo>();
    let allowed = match &state.config.server.public_url {
        Some(public) => same_origin_authority(origin, public),
        None => info.and_then(|i| i.host.as_deref()).is_some_and(|host| origin_authority(origin) == Some(host)),
    };
    if !allowed {
        return ApiError::forbidden("cross-origin request rejected").into_response();
    }
    next.run(req).await
}

fn origin_authority(origin: &str) -> Option<&str> {
    let rest = origin.split_once("://")?.1;
    Some(rest.split('/').next().unwrap_or(rest))
}

fn same_origin_authority(origin: &str, public_url: &str) -> bool {
    match (origin_authority(origin), origin_authority(public_url)) {
        (Some(a), Some(b)) => a.eq_ignore_ascii_case(b),
        _ => false,
    }
}

// Inline scripts and styles are not allowed; React sets styles through the CSSOM, which CSP permits.
const CSP: &str = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; \
font-src 'self'; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; \
form-action 'self'; frame-ancestors 'none'";

pub async fn security_headers(State(state): State<AppState>, req: Request, next: Next) -> Response {
    let https = req.extensions().get::<RequestInfo>().is_some_and(|i| i.https);
    let mut res = next.run(req).await;
    let h = res.headers_mut();
    h.insert("content-security-policy", HeaderValue::from_static(CSP));
    h.insert("x-content-type-options", HeaderValue::from_static("nosniff"));
    h.insert("referrer-policy", HeaderValue::from_static("strict-origin-when-cross-origin"));
    h.insert("permissions-policy", HeaderValue::from_static("camera=(), microphone=(), geolocation=()"));
    h.insert("cross-origin-opener-policy", HeaderValue::from_static("same-origin"));
    let sec = &state.config.security;
    if https
        && sec.hsts
        && let Ok(v) = HeaderValue::from_str(&format!("max-age={}", sec.hsts_max_age_secs))
    {
        h.insert("strict-transport-security", v);
    }
    res
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(pairs: &[(&'static str, &'static str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in pairs {
            h.insert(*k, HeaderValue::from_static(v));
        }
        h
    }

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    #[test]
    fn untrusted_peer_cannot_spoof_forwarded_headers() {
        let h = headers(&[("x-forwarded-for", "1.2.3.4"), ("x-forwarded-proto", "https")]);
        let info = resolve(ip("203.0.113.9"), false, &h, &["10.0.0.0/8".parse().unwrap()]);
        assert_eq!(info.client_ip, ip("203.0.113.9"));
        assert!(!info.https);
    }

    #[test]
    fn trusted_proxy_chain_yields_first_untrusted_from_right() {
        let h = headers(&[("x-forwarded-for", "6.6.6.6, 198.51.100.7, 10.0.0.2"), ("x-forwarded-proto", "https")]);
        let info = resolve(ip("10.0.0.1"), false, &h, &["10.0.0.0/8".parse().unwrap()]);
        assert_eq!(info.client_ip, ip("198.51.100.7"));
        assert!(info.https);
    }

    #[test]
    fn origin_authority_compares_host_and_port() {
        assert!(same_origin_authority("https://granit.example.com", "https://granit.example.com/"));
        assert!(!same_origin_authority("https://evil.example", "https://granit.example.com"));
        assert_eq!(origin_authority("http://localhost:3000"), Some("localhost:3000"));
    }
}
