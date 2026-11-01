//! The one HTTP client factory. Every outgoing HTTP request (data sources such as Prometheus)
//! uses a client from here: timeouts, the platform's certificate store plus an optional extra
//! CA, and the target check (`datasources::targets`) on every connection and every redirect. A
//! guard test fails when another module builds its own client.
//!
//! Data source traffic never goes through a proxy (system proxy variables are ignored): a proxy
//! resolves names itself, so the target check could not see the address it connects to.
//! Kalzit's own requests to the internet (catalog, updates, ACME, AI providers) may use the
//! outbound proxy (`client_proxied`, `outbound`). The client resolves and checks every target
//! before the request goes to the proxy, but the proxy resolves the name again, so a name whose
//! answer changes in between (DNS rebinding) is checked by the proxy's own rules only: the proxy
//! must refuse private, loopback, link-local and metadata addresses itself
//! (docs/guide/administration.md, "Outbound proxy"). Plain-http requests of guarded clients (the
//! catalog's packages, an organization's AI provider) leave no room for that: they go to the
//! checked address, with the name in `Host`. HTTPS goes through `CONNECT` by name, because the
//! certificate is checked against the name.

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
    /// The caller's hop check refused a request (the first or a redirect), with its reason.
    #[error("{0}")]
    Refused(crate::datasources::Detail),
    /// The server could not be reached or the connection broke, by its cause
    /// (`target.unresolvable`, `source.connect_*`, `source.connection_lost`).
    #[error("{0}")]
    Connection(crate::datasources::Detail),
}

/// Asked before every hop, the first request and each redirect, with the method and URL that
/// would be sent; an error stops the request before anything is sent there.
pub type HopCheck<'a> = &'a (dyn Fn(&Method, &Url) -> Result<(), crate::datasources::Detail> + Send + Sync);

impl HttpError {
    /// The reason code, parameters and text for the API.
    pub fn detail(&self) -> crate::datasources::Detail {
        use crate::datasources::Detail;
        match self {
            HttpError::Blocked(b) => b.0.clone(),
            HttpError::Refused(d) | HttpError::Connection(d) => d.clone(),
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
            other => Self::Connection(other.detail()),
        }
    }
}

impl From<reqwest::Error> for HttpError {
    fn from(e: reqwest::Error) -> Self {
        if e.is_timeout() {
            return Self::Timeout;
        }
        // A blocked address or a name that does not resolve arrives from the resolver wrapped in
        // connector errors, and so does the I/O error of a refused or broken connection.
        let address =
            e.url().and_then(|u| Some(crate::datasources::connect::address(u.host_str()?, u.port_or_known_default()?)));
        let mut causes = Vec::new();
        let mut source: Option<&(dyn std::error::Error + 'static)> = Some(&e);
        while let Some(err) = source {
            if let Some(blocked) = err.downcast_ref::<Blocked>() {
                return Self::Blocked(blocked.clone());
            }
            if let Some(unresolved) = err.downcast_ref::<ResolveError>() {
                return Self::Connection(unresolved.detail());
            }
            if let Some(io) = err.downcast_ref::<std::io::Error>() {
                if crate::datasources::connect::is_dead(io.kind()) {
                    return Self::Connection(crate::datasources::connect::lost_detail(io));
                }
                if e.is_connect()
                    && let Some(address) = &address
                {
                    return Self::Connection(crate::datasources::connect::connect_failed(address, io, CONNECT_TIMEOUT));
                }
            }
            if !std::ptr::addr_eq(err, &e as &dyn std::error::Error) {
                causes.push(err.to_string());
            }
            source = err.source();
        }
        // The URL may carry query parameters; the message without it is enough. Its causes
        // (a TLS failure, say) follow, since "error sending request" alone says nothing.
        let mut message = e.without_url().to_string();
        for cause in causes {
            if !message.contains(&cause) {
                message.push_str(": ");
                message.push_str(&cause);
            }
        }
        Self::Other(message)
    }
}

/// A client whose every connection goes to a checked address.
pub struct HttpClient {
    client: reqwest::Client,
    policy: Arc<TargetPolicy>,
    guard: Option<LocalGuard>,
    /// The outbound proxy, for the requests it does not bypass.
    proxy: Option<Arc<crate::outbound::OutboundProxy>>,
}

/// Refuses every address of this computer: loopback, unspecified, and any address one of its
/// interfaces holds. Set on a client whose target port is one of Kalzit's own listening ports,
/// so it can never reach Kalzit itself, whatever name or address form points there
/// (`localhost.`, `[::ffff:127.0.0.1]`, the server's own host name or LAN address).
#[derive(Clone, Debug)]
pub struct LocalGuard {
    /// What a refusal answers with.
    pub refused: crate::datasources::Detail,
    /// Also refuse every address that is not public (`is_private`), with this answer: for a
    /// client that must only reach the internet (the plugin catalog's hops to other hosts).
    pub private: Option<crate::datasources::Detail>,
}

impl LocalGuard {
    /// Whether `ip` is an address of this computer. An address is local when a socket can be
    /// bound to it, which holds for exactly the addresses the interfaces have.
    pub fn is_local(ip: std::net::IpAddr) -> bool {
        let ip = ip.to_canonical();
        ip.is_loopback() || ip.is_unspecified() || std::net::UdpSocket::bind((ip, 0)).is_ok()
    }

    /// Whether `ip` is not a public address: loopback, unspecified, private (RFC 1918), shared
    /// (100.64.0.0/10), IETF protocol assignments (192.0.0.0/24), link-local, broadcast,
    /// documentation and benchmarking ranges, IPv6 unique local, link-local and multicast. An IPv6
    /// address that carries an IPv4 address (mapped, IPv4-compatible `::a.b.c.d`, NAT64
    /// `64:ff9b::/96`, 6to4 `2002::/16`, Teredo `2001::/32` with its server and client) counts as
    /// that IPv4 address; the local-use NAT64 prefix `64:ff9b:1::/48` is always private.
    pub fn is_private(ip: std::net::IpAddr) -> bool {
        use std::net::Ipv4Addr;
        let v4_of = |hi: u16, lo: u16| Ipv4Addr::from((u32::from(hi) << 16) | u32::from(lo));
        match ip.to_canonical() {
            std::net::IpAddr::V4(v4) => Self::is_private_v4(v4),
            std::net::IpAddr::V6(v6) => {
                let s = v6.segments();
                if v6.is_loopback() || v6.is_unspecified() {
                    return true;
                }
                // IPv4-compatible (deprecated) `::a.b.c.d`.
                if s[..6] == [0; 6] {
                    return Self::is_private_v4(v4_of(s[6], s[7]));
                }
                // NAT64: the well-known prefix carries the IPv4 address, the local-use one is local.
                if s[0] == 0x64 && s[1] == 0xff9b {
                    if s[2..6] == [0; 4] {
                        return Self::is_private_v4(v4_of(s[6], s[7]));
                    }
                    if s[2] == 1 {
                        return true;
                    }
                }
                // 6to4.
                if s[0] == 0x2002 {
                    return Self::is_private_v4(v4_of(s[1], s[2]));
                }
                // Teredo: the server's address, and the client's, stored inverted.
                if s[0] == 0x2001 && s[1] == 0 {
                    return Self::is_private_v4(v4_of(s[2], s[3])) || Self::is_private_v4(v4_of(!s[6], !s[7]));
                }
                (s[0] & 0xfe00) == 0xfc00
                    || (s[0] & 0xffc0) == 0xfe80
                    || (s[0] & 0xff00) == 0xff00
                    || (s[0] == 0x2001 && s[1] == 0x0db8)
            }
        }
    }

    fn is_private_v4(v4: std::net::Ipv4Addr) -> bool {
        let [a, b, c, _] = v4.octets();
        v4.is_loopback()
            || v4.is_unspecified()
            || v4.is_private()
            || v4.is_link_local()
            || v4.is_broadcast()
            || v4.is_documentation()
            || (a == 100 && (64..128).contains(&b))
            || (a == 198 && (18..20).contains(&b))
            || (a == 192 && b == 0 && c == 0)
            || a == 0
            || a >= 240
    }

    fn check(&self, ip: std::net::IpAddr) -> Result<(), Blocked> {
        if Self::is_local(ip) {
            return Err(Blocked(self.refused.clone()));
        }
        match &self.private {
            Some(refused) if Self::is_private(ip) => Err(Blocked(refused.clone())),
            _ => Ok(()),
        }
    }
}

/// Resolves names through the target policy, so the connection uses the checked address. The
/// outbound proxy's own name (`proxy_host`) is resolved with the rules every address keeps (no
/// metadata address), not the allow-list or guard of the targets: an administrator chose it, and
/// it usually stands in the private network the guards keep targets out of. `proxy_host` is set
/// only when `network.no_proxy` does not name the proxy's host: then no request goes directly to
/// that name, so the only lookup of it is the connection to the proxy. A proxy host that is also
/// bypassed gets the targets' rules like every other name.
struct CheckedResolver(Arc<TargetPolicy>, Option<LocalGuard>, Option<String>);

impl reqwest::dns::Resolve for CheckedResolver {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let host = name.as_str().to_string();
        let is_proxy = self.2.as_deref().is_some_and(|p| p.eq_ignore_ascii_case(host.trim_end_matches('.')));
        let policy = if is_proxy { Arc::new(self.0.without_allow_list()) } else { self.0.clone() };
        let guard = if is_proxy { None } else { self.1.clone() };
        Box::pin(async move {
            let boxed = |b: Blocked| -> Box<dyn std::error::Error + Send + Sync> { Box::new(b) };
            // Port 0 is replaced by the URL's port.
            // Every returned address passed the check, so the client may try them in turn.
            let addrs =
                policy.resolve_all(&host, 0).await.map_err(|e| -> Box<dyn std::error::Error + Send + Sync> {
                    match e {
                        ResolveError::Blocked(b) => boxed(b),
                        other => Box::new(other),
                    }
                })?;
            if let Some(guard) = &guard {
                for addr in &addrs {
                    guard.check(addr.ip()).map_err(boxed)?;
                }
            }
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
    client_guarded(opts, None)
}

/// `client` that also refuses every local address (`LocalGuard`), at the resolver and for
/// address literals.
pub fn client_guarded(opts: HttpOptions, guard: Option<LocalGuard>) -> Result<HttpClient, HttpError> {
    client_proxied(opts, guard, None)
}

/// `client_guarded` whose requests go through the outbound `proxy`, except those its
/// `network.no_proxy` names. Every target is still resolved and checked here first
/// (`check_url`); only then does the proxy connect, by name.
pub fn client_proxied(
    opts: HttpOptions,
    guard: Option<LocalGuard>,
    proxy: Option<Arc<crate::outbound::OutboundProxy>>,
) -> Result<HttpClient, HttpError> {
    ensure_crypto_provider();
    let proxy_host = proxy.as_ref().filter(|p| !p.bypasses_host(&p.host())).map(|p| p.host());
    let mut builder = reqwest::Client::builder()
        .timeout(opts.timeout)
        .connect_timeout(CONNECT_TIMEOUT.min(opts.timeout))
        .user_agent(concat!("Kalzit/", env!("CARGO_PKG_VERSION")))
        // Redirects are followed in `send`, which checks each target first.
        .redirect(reqwest::redirect::Policy::none())
        // No system proxy; the outbound proxy only when one is given.
        .no_proxy()
        .dns_resolver(Arc::new(CheckedResolver(opts.policy.clone(), guard.clone(), proxy_host)));
    if let Some(proxy) = &proxy {
        builder = builder.proxy(proxy.reqwest_proxy());
    }
    if let Some(pem) = opts.extra_root_pem.as_deref().filter(|p| !p.trim().is_empty()) {
        for cert in reqwest::Certificate::from_pem_bundle(pem.as_bytes())
            .map_err(|e| HttpError::Other(format!("the CA certificate is not valid PEM: {e}")))?
        {
            builder = builder.add_root_certificate(cert);
        }
    }
    let client = builder.build().map_err(|e| HttpError::Other(format!("building the HTTP client: {e}")))?;
    Ok(HttpClient { client, policy: opts.policy, guard, proxy })
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
        self.send_checked(method, url, headers, body, None).await
    }

    /// `send_with_body` where `hop` is asked before every request, the first and each redirect,
    /// so a redirect cannot take the request where the caller would never send it (a write
    /// endpoint, another path).
    pub async fn send_checked(
        &self,
        method: Method,
        url: Url,
        headers: HeaderMap,
        body: Option<Vec<u8>>,
        hop: Option<HopCheck<'_>>,
    ) -> Result<reqwest::Response, HttpError> {
        let mut url = url;
        let mut method = method;
        let mut headers = headers;
        let mut body = body;
        for _ in 0..=MAX_REDIRECTS {
            let pinned = self.check_url(&url).await?;
            if let Some(check) = hop {
                check(&method, &url).map_err(HttpError::Refused)?;
            }
            let mut request = self.request(method.clone(), &url, pinned, headers.clone())?;
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

    /// One request that does not follow redirects; a redirect is the answer. For requests with a
    /// body, such as a token request carrying a secret, which must reach exactly this URL.
    pub async fn send_once(
        &self,
        method: Method,
        url: Url,
        headers: HeaderMap,
        body: Option<Vec<u8>>,
    ) -> Result<reqwest::Response, HttpError> {
        let pinned = self.check_url(&url).await?;
        let mut request = self.request(method, &url, pinned, headers)?;
        if let Some(b) = body {
            request = request.body(b);
        }
        Ok(request.send().await?)
    }

    /// The request for `url`; with `pinned`, to that checked address with the URL's host in
    /// `Host`, so the proxy forwards it there without resolving the name again.
    fn request(
        &self,
        method: Method,
        url: &Url,
        pinned: Option<std::net::IpAddr>,
        mut headers: HeaderMap,
    ) -> Result<reqwest::RequestBuilder, HttpError> {
        let Some(ip) = pinned else { return Ok(self.client.request(method, url.clone()).headers(headers)) };
        let host = match url.port() {
            Some(port) => format!("{}:{port}", url.host_str().unwrap_or_default()),
            None => url.host_str().unwrap_or_default().to_string(),
        };
        let value = reqwest::header::HeaderValue::from_str(&host)
            .map_err(|e| HttpError::Other(format!("the host cannot be sent: {e}")))?;
        headers.insert(reqwest::header::HOST, value);
        let mut to = url.clone();
        to.set_ip_host(ip).map_err(|()| HttpError::Other("the checked address cannot be put in the URL".into()))?;
        Ok(self.client.request(method, to).headers(headers))
    }

    /// Names are checked by the resolver when the client connects; this covers the scheme and
    /// address literals, which skip the resolver. With an outbound proxy the name is also
    /// resolved here and every address checked, through the proxy or past it (`no_proxy`), so a
    /// name that leads somewhere refused is refused before anything is sent.
    ///
    /// Answers the address a plain-http request of a guarded client must go to through the proxy
    /// (`request`), so the proxy cannot resolve the name to another address.
    async fn check_url(&self, url: &Url) -> Result<Option<std::net::IpAddr>, HttpError> {
        if !matches!(url.scheme(), "http" | "https") {
            let detail = crate::datasources::Detail::new(
                "target.scheme_not_allowed",
                format!("{} URLs are not allowed", url.scheme()),
            )
            .with("scheme", url.scheme());
            return Err(Blocked(detail).into());
        }
        // Credentials in a URL (a redirect's above all) would be sent as basic auth to wherever
        // it points; sources carry theirs in their own fields.
        if !url.username().is_empty() || url.password().is_some() {
            let detail = crate::datasources::Detail::new(
                "target.url_credentials",
                "the URL contains credentials, which Kalzit does not send",
            );
            return Err(Blocked(detail).into());
        }
        let host = url.host_str().ok_or_else(|| HttpError::Other("the URL has no host".into()))?;
        if let Some(ip) = parse_ip_literal(host) {
            self.policy.check_ip(host, ip)?;
            if let Some(guard) = &self.guard {
                guard.check(ip)?;
            }
            return Ok(None);
        }
        let Some(proxy) = &self.proxy else { return Ok(None) };
        let port = url.port_or_known_default().unwrap_or(443);
        let addrs = self.policy.resolve_all(host, port).await?;
        if let Some(guard) = &self.guard {
            for addr in &addrs {
                guard.check(addr.ip())?;
            }
        }
        let pin = self.guard.is_some() && url.scheme() == "http" && !proxy.bypasses(url);
        Ok(pin.then(|| addrs[0].ip()))
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
        // Every cloud metadata address, in any literal form a URL can carry (the URL parser
        // also turns decimal and octal IPv4 forms into the dotted one).
        for url in [
            "http://100.100.100.200/latest/meta-data/",
            "http://168.63.129.16/machine",
            "http://[fd20:ce::254]/",
            "http://[::ffff:169.254.169.254]/",
            "http://[::ffff:0:a9fe:a9fe]/",
            "http://2852039166/",
            "http://0251.0376.0251.0376/",
        ] {
            let e = c.send(Method::GET, Url::parse(url).unwrap(), HeaderMap::new()).await.unwrap_err();
            assert!(matches!(e, HttpError::Blocked(_)), "{url}: {e}");
        }
        // A name is checked by the client's own resolver, on the address it would connect to.
        crate::datasources::targets::test_hosts::pin(
            "metadata.http-test.invalid",
            &["100.100.100.200".parse().unwrap()],
        );
        let url = Url::parse("http://metadata.http-test.invalid/latest/meta-data/").unwrap();
        let e = c.send(Method::GET, url, HeaderMap::new()).await.unwrap_err();
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
    async fn a_refused_or_unresolvable_target_is_named_by_its_cause() {
        let closed = crate::datasources::connect::tests::closed_port().await;
        let c = test_client(&[]);
        let e = c.send(Method::GET, Url::parse(&format!("http://{closed}/")).unwrap(), HeaderMap::new()).await;
        let d = e.unwrap_err().detail();
        assert_eq!(d.reason, "source.connect_refused", "{d:?}");
        assert_eq!(d.params["address"], closed.to_string());
        let e = c.send(Method::GET, Url::parse("http://does-not-exist.invalid/").unwrap(), HeaderMap::new()).await;
        assert_eq!(e.unwrap_err().detail().reason, "target.unresolvable");
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

    #[test]
    fn the_local_guard_knows_this_computers_addresses_in_every_form() {
        for local in ["127.0.0.1", "127.8.9.10", "::1", "::ffff:127.0.0.1", "0.0.0.0", "::"] {
            assert!(LocalGuard::is_local(local.parse().unwrap()), "{local}");
        }
        for remote in ["192.0.2.1", "198.51.100.7", "::ffff:192.0.2.1", "2001:db8::1"] {
            assert!(!LocalGuard::is_local(remote.parse().unwrap()), "{remote}");
        }
    }

    #[test]
    fn private_addresses_are_known_in_every_form() {
        for private in [
            "10.1.2.3",
            "172.16.0.1",
            "192.168.1.1",
            "127.0.0.1",
            "169.254.169.254",
            "100.64.0.1",
            "0.0.0.0",
            "::1",
            "fd00::1",
            "fe80::1",
            "::ffff:10.0.0.1",
            "192.0.0.8",
            "::10.0.0.1",
            "::127.0.0.1",
            "64:ff9b::a00:1",
            "64:ff9b::7f00:1",
            "64:ff9b:1::1",
            "2002:a00:1::1",
            "2002:7f00:1::",
            "2001:0:a00:1::5efe:1:2",
            "2001:0:4136:e378:8000:63bf:80ff:fffe",
        ] {
            assert!(LocalGuard::is_private(private.parse().unwrap()), "{private}");
        }
        for public in [
            "1.1.1.1",
            "8.8.8.8",
            "2606:4700::1111",
            "::ffff:1.1.1.1",
            "64:ff9b::101:101",
            "2002:101:101::1",
            "2001:0:4136:e378:8000:63bf:f7f7:f7f7",
        ] {
            assert!(!LocalGuard::is_private(public.parse().unwrap()), "{public}");
        }
    }

    #[tokio::test]
    async fn a_guarded_client_refuses_local_targets_by_literal_and_by_name() {
        let guard = LocalGuard {
            refused: crate::datasources::Detail::new("ai.base_url_kalzit", "Kalzit itself"),
            private: None,
        };
        let policy = TargetPolicy::new(std::path::Path::new("."), "sqlite::memory:", &[], &[]);
        let c = client_guarded(
            HttpOptions { timeout: Duration::from_secs(5), extra_root_pem: None, policy: Arc::new(policy) },
            Some(guard),
        )
        .unwrap();
        for url in
            ["http://127.0.0.1:9/", "http://[::ffff:127.0.0.1]:9/", "http://localhost.:9/", "http://localhost:9/"]
        {
            let e = c.send_once(Method::POST, Url::parse(url).unwrap(), HeaderMap::new(), None).await.unwrap_err();
            assert_eq!(e.detail().reason, "ai.base_url_kalzit", "{url}: {e}");
        }
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

    #[tokio::test]
    async fn the_hop_check_sees_every_redirect() {
        let addr = echo_key().await;
        let c = test_client(&[]);
        let hop = redirector(format!("http://{addr}/key")).await;
        let seen = std::sync::Mutex::new(Vec::new());
        let check = |m: &Method, u: &Url| {
            seen.lock().unwrap().push(format!("{m} {}", u.path()));
            if u.path() == "/key" { Err(crate::datasources::Detail::new("http.failed", "refused")) } else { Ok(()) }
        };
        let url = Url::parse(&format!("http://{hop}/")).unwrap();
        let e =
            c.send_checked(Method::POST, url, HeaderMap::new(), Some(b"{}".to_vec()), Some(&check)).await.unwrap_err();
        assert!(matches!(e, HttpError::Refused(_)), "{e}");
        assert_eq!(*seen.lock().unwrap(), ["POST /", "POST /key"]);
    }

    #[tokio::test]
    async fn send_once_does_not_follow_redirects() {
        let addr = upstream().await;
        let c = test_client(&[]);
        let hop = Url::parse(&format!("http://{}/", redirector(format!("http://{addr}/auth")).await)).unwrap();
        let once = c.send_once(Method::POST, hop, HeaderMap::new(), Some(b"secret".to_vec())).await.unwrap();
        assert_eq!(once.status(), StatusCode::TEMPORARY_REDIRECT, "not followed");
        let blocked = Url::parse("http://169.254.169.254/").unwrap();
        assert!(matches!(c.send_once(Method::POST, blocked, HeaderMap::new(), None).await, Err(HttpError::Blocked(_))));
    }

    #[tokio::test]
    async fn urls_with_credentials_are_refused_also_as_redirect_targets() {
        let addr = echo_key().await;
        let c = test_client(&[]);
        for raw in [format!("http://fremd@{addr}/key"), format!("http://fremd:geheim@{addr}/key")] {
            let e = c.send(Method::GET, Url::parse(&raw).unwrap(), HeaderMap::new()).await.unwrap_err();
            assert!(matches!(&e, HttpError::Blocked(b) if b.0.reason == "target.url_credentials"), "{e}");
            let e = c.send_once(Method::GET, Url::parse(&raw).unwrap(), HeaderMap::new(), None).await.unwrap_err();
            assert!(matches!(&e, HttpError::Blocked(b) if b.0.reason == "target.url_credentials"), "{e}");
        }
        let hop = redirector(format!("http://fremd:geheim@{addr}/key")).await;
        let url = Url::parse(&format!("http://{hop}/")).unwrap();
        let e = c.send(Method::GET, url, HeaderMap::new()).await.unwrap_err();
        assert!(matches!(&e, HttpError::Blocked(b) if b.0.reason == "target.url_credentials"), "{e}");
    }

    /// A forward proxy for the tests: answers every request itself with `via proxy` and keeps
    /// the request head it got (request line and headers).
    async fn test_proxy() -> (std::net::SocketAddr, Arc<std::sync::Mutex<Vec<String>>>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let seen: Arc<std::sync::Mutex<Vec<String>>> = Arc::default();
        let kept = seen.clone();
        tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                let kept = kept.clone();
                tokio::spawn(async move {
                    let mut head = Vec::new();
                    let mut buf = [0u8; 1024];
                    while !head.windows(4).any(|w| w == b"\r\n\r\n") {
                        match stream.read(&mut buf).await {
                            Ok(0) | Err(_) => return,
                            Ok(n) => head.extend_from_slice(&buf[..n]),
                        }
                    }
                    kept.lock().unwrap().push(String::from_utf8_lossy(&head).into_owned());
                    let body = "via proxy";
                    let answer =
                        format!("HTTP/1.1 200 OK\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len());
                    let _ = stream.write_all(answer.as_bytes()).await;
                });
            }
        });
        (addr, seen)
    }

    fn proxied(
        allowed: &[&str],
        guard: Option<LocalGuard>,
        proxy: &str,
        no_proxy: &[&str],
        user: Option<(&str, &str)>,
    ) -> HttpClient {
        let allowed: Vec<String> = allowed.iter().map(|s| s.to_string()).collect();
        let no_proxy: Vec<String> = no_proxy.iter().map(|s| s.to_string()).collect();
        let policy = TargetPolicy::new(&std::env::temp_dir().join("kalzit-none"), "sqlite::memory:", &[], &allowed);
        let proxy = crate::outbound::OutboundProxy::new(
            proxy,
            &no_proxy,
            user.map(|(u, _)| u.to_string()),
            user.filter(|(_, p)| !p.is_empty()).map(|(_, p)| zeroize::Zeroizing::new(p.to_string())),
        )
        .unwrap()
        .map(Arc::new);
        let opts = HttpOptions { timeout: Duration::from_secs(5), extra_root_pem: None, policy: Arc::new(policy) };
        client_proxied(opts, guard, proxy).unwrap()
    }

    /// Requests go through the outbound proxy with its credentials, past it for `no_proxy`, and
    /// the proxy reaches nothing the target check refuses: the client resolves and checks every
    /// target first, while the proxy itself may stand in the private network.
    #[tokio::test]
    async fn the_outbound_proxy_carries_requests_but_never_past_the_target_check() {
        use crate::datasources::targets::test_hosts::pin;
        let public: std::net::IpAddr = "93.184.216.34".parse().unwrap();
        pin("release.proxy-test.example", &[public]);
        pin("other.proxy-test.example", &[public]);
        pin("metadata.proxy-test.example", &["169.254.169.254".parse().unwrap()]);
        pin("lan.proxy-test.example", &["10.0.0.5".parse().unwrap()]);
        pin("proxy.proxy-test.example", &["127.0.0.1".parse().unwrap()]);
        let (addr, seen) = test_proxy().await;
        let url = |s: &str| Url::parse(s).unwrap();

        // Through the proxy, with its sign-in; the proxy's name resolves although the target
        // allow-list does not hold it.
        let proxy = format!("http://proxy.proxy-test.example:{}", addr.port());
        let c = proxied(&["release.proxy-test.example"], None, &proxy, &[], Some(("kalzit", "geheim")));
        let r = c.send(Method::GET, url("http://release.proxy-test.example/latest"), HeaderMap::new()).await.unwrap();
        assert_eq!(r.text().await.unwrap(), "via proxy");
        let head = seen.lock().unwrap().last().cloned().unwrap();
        assert!(head.starts_with("GET http://release.proxy-test.example/latest HTTP/1.1"), "{head}");
        let auth = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, "kalzit:geheim");
        assert!(
            head.to_ascii_lowercase().contains(&format!("proxy-authorization: basic {}", auth.to_ascii_lowercase())),
            "{head}"
        );

        // The allow-list still decides, and metadata addresses stay refused, by name and literal.
        let before = seen.lock().unwrap().len();
        let e = c.send(Method::GET, url("http://other.proxy-test.example/"), HeaderMap::new()).await.unwrap_err();
        assert_eq!(e.detail().reason, "target.not_allowed", "{e}");
        let open = proxied(&[], None, &proxy, &[], None);
        for target in ["http://metadata.proxy-test.example/", "http://169.254.169.254/latest/meta-data"] {
            let e = open.send(Method::GET, url(target), HeaderMap::new()).await.unwrap_err();
            assert_eq!(e.detail().reason, "target.metadata_address", "{target}: {e}");
        }
        // A guard that admits only public addresses keeps judging the target, not the proxy.
        let private = crate::datasources::Detail::new("catalog.private_target", "private");
        let guarded =
            proxied(&[], Some(LocalGuard { refused: private.clone(), private: Some(private) }), &proxy, &[], None);
        let e = guarded.send(Method::GET, url("http://lan.proxy-test.example/"), HeaderMap::new()).await.unwrap_err();
        assert_eq!(e.detail().reason, "catalog.private_target", "{e}");
        // Plain http of a guarded client goes to the checked address, the name in `Host`, so the
        // proxy has nothing to resolve again.
        let r = guarded.send(Method::GET, url("http://other.proxy-test.example/x"), HeaderMap::new()).await.unwrap();
        assert_eq!(r.text().await.unwrap(), "via proxy");
        assert_eq!(seen.lock().unwrap().len(), before + 1, "only the allowed request reached the proxy");
        let head = seen.lock().unwrap().last().cloned().unwrap();
        assert!(head.starts_with("GET http://93.184.216.34/x HTTP/1.1"), "{head}");
        assert!(head.to_ascii_lowercase().contains("host: other.proxy-test.example\r\n"), "{head}");
        assert!(!head.to_ascii_lowercase().contains("proxy-authorization"), "{head}");

        // A user name without a password for this proxy sends no sign-in at all.
        let nameless = proxied(&[], None, &proxy, &[], Some(("kalzit", "")));
        nameless.send(Method::GET, url("http://other.proxy-test.example/"), HeaderMap::new()).await.unwrap();
        let head = seen.lock().unwrap().last().cloned().unwrap();
        assert!(!head.to_ascii_lowercase().contains("proxy-authorization"), "{head}");
        let before = seen.lock().unwrap().len();

        // `no_proxy` goes direct.
        let direct = upstream().await;
        let past = proxied(&[], None, &proxy, &["127.0.0.1"], None);
        let r = past.send(Method::GET, url(&format!("http://{direct}/ok")), HeaderMap::new()).await.unwrap();
        assert_eq!(r.text().await.unwrap(), "fertig");
        assert_eq!(seen.lock().unwrap().len(), before);
    }

    /// A proxy host that `no_proxy` also names gets no relaxed rules for targets: with the proxy
    /// on `localhost` and `localhost` bypassed, a guarded client still cannot reach any port of
    /// this computer, by name or by address.
    #[tokio::test]
    async fn a_bypassed_proxy_host_is_no_way_around_the_guard() {
        let (addr, seen) = test_proxy().await;
        let direct = upstream().await;
        let proxy = format!("http://localhost:{}", addr.port());
        let local = crate::datasources::Detail::new("catalog.private_target", "private");
        let guard = LocalGuard { refused: local.clone(), private: Some(local) };
        let c = proxied(&[], Some(guard), &proxy, &["localhost", "127.0.0.1"], None);
        for target in [format!("http://localhost:{}/ok", direct.port()), format!("http://{direct}/ok")] {
            let e = c.send(Method::GET, Url::parse(&target).unwrap(), HeaderMap::new()).await.unwrap_err();
            assert_eq!(e.detail().reason, "catalog.private_target", "{target}: {e}");
        }
        assert!(seen.lock().unwrap().is_empty());
    }
}
