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
    /// The user's connection is HTTPS (directly, or at a trusted proxy in front of us). The
    /// session cookie is then `Secure` with the `__Host-` prefix; a browser would not send such a
    /// cookie back over plain HTTP, so it follows the request's scheme, not `server.public_url`.
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

pub(crate) fn resolve(peer: IpAddr, tls: bool, headers: &HeaderMap, trusted: &[IpNet]) -> RequestInfo {
    // Dual-stack sockets on Linux report IPv4 peers as ::ffff:a.b.c.d; compare them as IPv4 so
    // `10.0.0.0/8` matches the same proxy on Linux and Windows.
    let peer = peer.to_canonical();
    let is_trusted = |ip: &IpAddr| trusted.iter().any(|net| net.contains(ip));
    let host = single_header(headers, "host");
    if !is_trusted(&peer) {
        return RequestInfo { client_ip: peer, https: tls, host };
    }
    // Proxies either extend one X-Forwarded-For line or add another (HAProxy), so all lines are
    // read in order. Walk from the right: each trusted hop vouches for the entry to its left. The
    // first untrusted address is the client. An entry that is not an address ends the walk at the
    // last hop we could vouch for, so client-supplied garbage cannot shift the result.
    let forwarded: Vec<&str> = headers
        .get_all("x-forwarded-for")
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect();
    let mut client_ip = peer;
    for entry in forwarded.iter().rev() {
        let Some(ip) = parse_forwarded_ip(entry) else { break };
        client_ip = ip;
        if !is_trusted(&ip) {
            break;
        }
    }
    // The leftmost scheme is the one the user's browser spoke to the first proxy.
    let https = match single_header(headers, "x-forwarded-proto") {
        Some(proto) => proto.split(',').next().is_some_and(|p| p.trim().eq_ignore_ascii_case("https")),
        None => tls,
    };
    let host = single_header(headers, "x-forwarded-host")
        .and_then(|h| h.split(',').next().map(|h| h.trim().to_string()))
        .or(host);
    RequestInfo { client_ip, https, host }
}

fn single_header(headers: &HeaderMap, name: &str) -> Option<String> {
    headers.get(name).and_then(|v| v.to_str().ok()).map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// `203.0.113.5`, `203.0.113.5:51234` (IIS ARR), `2001:db8::1` or `[2001:db8::1]:443`.
fn parse_forwarded_ip(entry: &str) -> Option<IpAddr> {
    let entry = entry.trim_matches('"');
    entry
        .parse::<IpAddr>()
        .ok()
        .or_else(|| entry.parse::<SocketAddr>().ok().map(|s| s.ip()))
        .or_else(|| entry.strip_prefix('[')?.strip_suffix(']')?.parse().ok())
        .map(|ip: IpAddr| ip.to_canonical())
}

/// Rejects state-changing requests whose `Origin` is not this server. Together with
/// `SameSite=Lax` cookies this is the CSRF protection. Requests without `Origin` (API clients,
/// curl) carry no ambient browser cookies to abuse, so they pass.
pub async fn origin_check(State(state): State<AppState>, req: Request, next: Next) -> Response {
    if matches!(*req.method(), Method::GET | Method::HEAD | Method::OPTIONS) {
        return next.run(req).await;
    }
    // A SAML provider posts its answer from its own origin (HTTP-POST binding). The ACS acts on
    // no cookie: it only accepts a signed answer to a request Kalzit made, and the session opens
    // in the next step, which needs the browser that started the sign-in (`routes::saml`).
    if is_saml_acs(req.uri().path()) {
        return next.run(req).await;
    }
    if let Err(e) = check_origin(&state, req.headers(), req.extensions().get::<RequestInfo>()) {
        return e.into_response();
    }
    next.run(req).await
}

/// `/auth/saml/<slug>/acs`, with a valid slug.
fn is_saml_acs(path: &str) -> bool {
    path.strip_prefix("/auth/saml/").and_then(|rest| rest.strip_suffix("/acs")).is_some_and(crate::sso::valid_slug)
}

/// Refuses a request whose `Origin` is not this server; one without `Origin` passes (see
/// `origin_check`). Also for WebSocket handshakes, which are GET requests that a page of any site
/// could open with the user's cookies (`routes::live`).
pub(crate) fn check_origin(state: &AppState, headers: &HeaderMap, info: Option<&RequestInfo>) -> Result<(), ApiError> {
    let Some(origin) = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()) else {
        return Ok(());
    };
    let host = info.and_then(|i| i.host.as_deref());
    let allowed = match &state.config.server.public_url {
        Some(public) => matches!((parse_origin(origin), parse_origin(public)), (Some(a), Some(b)) if a == b),
        None => host.is_some_and(|h| origin_matches_host(origin, h)),
    };
    if !allowed {
        tracing::warn!(
            origin,
            host,
            "rejected a cross-origin request; behind a reverse proxy, set server.public_url or security.trusted_proxies"
        );
        // Its own code, so the UI can tell the admin which setting to check instead of "no access".
        return Err(ApiError::new(
            axum::http::StatusCode::FORBIDDEN,
            "cross_origin",
            "cross-origin request rejected; behind a reverse proxy set server.public_url or security.trusted_proxies",
        ));
    }
    Ok(())
}

/// An origin as (scheme, host, port), lowercased and with the scheme's default port filled in,
/// so `https://Kalzit.example:443` and `https://kalzit.example` compare equal.
pub(crate) fn parse_origin(url: &str) -> Option<(String, String, u16)> {
    let (scheme, rest) = url.split_once("://")?;
    let scheme = scheme.to_ascii_lowercase();
    let default_port = match scheme.as_str() {
        "http" => 80,
        "https" => 443,
        _ => return None,
    };
    let authority = rest.split('/').next()?;
    let (host, port) = split_host_port(authority)?;
    Some((scheme, host, port.unwrap_or(default_port)))
}

/// Without `public_url` the scheme cannot be compared reliably (a TLS proxy may not be listed as
/// trusted), so the Origin's host and port must match the Host header. A Host without a port
/// means the default port of the Origin's scheme, never "any port": another service on
/// `kalzit.example:8080` is a different origin.
fn origin_matches_host(origin: &str, host_header: &str) -> bool {
    let Some((scheme, host, port)) = parse_origin(origin) else { return false };
    let Some((h, p)) = split_host_port(host_header) else { return false };
    let default_port = if scheme == "https" { 443 } else { 80 };
    h == host && p.unwrap_or(default_port) == port
}

/// `host`, `host:port`, `[v6]`, `[v6]:port`; lowercased. Rejects user info and paths.
pub(crate) fn split_host_port(authority: &str) -> Option<(String, Option<u16>)> {
    if authority.is_empty() || authority.contains(['@', '/', ' ']) {
        return None;
    }
    let (host, port) = if let Some(rest) = authority.strip_prefix('[') {
        let (h, after) = rest.split_once(']')?;
        (format!("[{h}]"), after.strip_prefix(':'))
    } else {
        match authority.rsplit_once(':') {
            Some((h, p)) => (h.to_string(), Some(p)),
            None => (authority.to_string(), None),
        }
    };
    let port = match port {
        Some(p) => Some(p.parse::<u16>().ok()?),
        None => None,
    };
    (!host.is_empty()).then(|| (host.to_ascii_lowercase(), port))
}

// Inline scripts and styles are not allowed; React sets styles through the CSSOM, which CSP permits.
const CSP: &str = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; \
font-src 'self'; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; \
form-action 'self'; frame-ancestors 'none'";

pub async fn security_headers(State(state): State<AppState>, req: Request, next: Next) -> Response {
    let https = req.extensions().get::<RequestInfo>().is_some_and(|i| i.https);
    let mut res = next.run(req).await;
    let h = res.headers_mut();
    // A response with a stricter policy of its own keeps it: the frame of a panel plugin
    // (`plugins::panels`) is sandboxed and may run only its bundle.
    for (name, value) in [
        ("content-security-policy", CSP),
        ("referrer-policy", "strict-origin-when-cross-origin"),
        ("permissions-policy", "camera=(), microphone=(), geolocation=()"),
    ] {
        if !h.contains_key(name) {
            h.insert(name, HeaderValue::from_static(value));
        }
    }
    h.insert("x-content-type-options", HeaderValue::from_static("nosniff"));
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

    #[test]
    fn only_the_saml_acs_skips_the_origin_check() {
        assert!(is_saml_acs("/auth/saml/partnerportal/acs"));
        for other in [
            "/auth/saml/partnerportal/finish",
            "/auth/saml//acs",
            "/auth/saml/a/b/acs",
            "/api/auth/saml/p/acs",
            "/auth/saml/Partner/acs",
            "/auth/oidc/p/acs",
        ] {
            assert!(!is_saml_acs(other), "{other}");
        }
    }

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

    fn trusted() -> Vec<IpNet> {
        vec!["10.0.0.0/8".parse().unwrap()]
    }

    #[test]
    fn every_forwarded_for_line_is_read() {
        // HAProxy adds a second line instead of extending the client's one.
        let mut h = HeaderMap::new();
        h.append("x-forwarded-for", HeaderValue::from_static("1.1.1.1"));
        h.append("x-forwarded-for", HeaderValue::from_static("203.0.113.5"));
        assert_eq!(resolve(ip("10.0.0.1"), false, &h, &trusted()).client_ip, ip("203.0.113.5"));
    }

    #[test]
    fn forwarded_entries_with_ports_are_understood() {
        for (xff, client) in [
            ("1.1.1.1, 203.0.113.5:51234", "203.0.113.5"),
            ("1.1.1.1, [2001:db8::7]:443", "2001:db8::7"),
            ("\"2001:db8::8\"", "2001:db8::8"),
        ] {
            let h = headers(&[("x-forwarded-for", xff)]);
            assert_eq!(resolve(ip("10.0.0.1"), false, &h, &trusted()).client_ip, ip(client), "{xff}");
        }
    }

    #[test]
    fn garbage_in_forwarded_for_does_not_reach_further_left() {
        let h = headers(&[("x-forwarded-for", "6.6.6.6, unknown, 10.0.0.9")]);
        assert_eq!(resolve(ip("10.0.0.1"), false, &h, &trusted()).client_ip, ip("10.0.0.9"));
    }

    #[test]
    fn ipv4_mapped_peers_match_ipv4_proxies() {
        let h = headers(&[("x-forwarded-for", "203.0.113.5"), ("x-forwarded-proto", "https")]);
        let info = resolve(ip("::ffff:10.0.0.1"), false, &h, &trusted());
        assert_eq!(info.client_ip, ip("203.0.113.5"));
        assert!(info.https);
        let alone = resolve(ip("::ffff:203.0.113.9"), false, &HeaderMap::new(), &trusted());
        assert_eq!(alone.client_ip, ip("203.0.113.9"));
    }

    #[test]
    fn leftmost_forwarded_proto_wins() {
        let h = headers(&[("x-forwarded-proto", "https, http")]);
        assert!(resolve(ip("10.0.0.1"), false, &h, &trusted()).https);
    }

    #[test]
    fn origins_are_normalized() {
        assert_eq!(parse_origin("https://Kalzit.Example:443"), parse_origin("https://kalzit.example/"));
        assert_ne!(parse_origin("http://kalzit.example"), parse_origin("https://kalzit.example"));
        assert_eq!(parse_origin("ftp://kalzit.example"), None);
        assert_eq!(parse_origin("https://user@kalzit.example"), None);
    }

    #[test]
    fn origin_against_host_header() {
        assert!(origin_matches_host("http://localhost:3000", "localhost:3000"));
        assert!(origin_matches_host("https://Kalzit.example", "kalzit.example"));
        assert!(origin_matches_host("https://kalzit.example", "kalzit.example:443"));
        assert!(origin_matches_host("http://[::1]:3000", "[::1]:3000"));
        assert!(!origin_matches_host("https://evil.example", "kalzit.example"));
        assert!(!origin_matches_host("http://localhost:3001", "localhost:3000"));
        assert!(!origin_matches_host("http://kalzit.example:8080", "kalzit.example"));
        assert!(!origin_matches_host("https://kalzit.example:9999", "kalzit.example"));
        assert!(!origin_matches_host("null", "kalzit.example"));
    }
}
