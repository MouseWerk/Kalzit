//! The outbound proxy (docs/guide/administration.md, "Outbound proxy"): the HTTP or HTTPS proxy
//! that Kalzit's own requests to the internet go through, the plugin catalog and its packages,
//! update checks and downloads, ACME and the AI providers. Data sources keep their own
//! connections and never use it.
//!
//! The settings `network.proxy_url`, `network.no_proxy` and `network.proxy_username` live in the
//! settings registry (undo, locked by `KALZIT_SETTING_*`); the password is a secret of its own in
//! `server_secrets`. The proxy never widens what Kalzit may reach: the HTTP client still resolves
//! and checks every target itself before the request goes to the proxy (`http::client_proxied`).

use std::net::IpAddr;
use std::sync::Arc;

use ipnet::IpNet;
use reqwest::Url;
use zeroize::Zeroizing;

use crate::app::AppState;
use crate::datasources::targets::{is_always_blocked, is_host_name, parse_ip_literal};
use crate::error::{ApiError, ApiResult};
use crate::secrets::{Blob, Keyring};

pub const URL_KEY: &str = "network.proxy_url";
pub const NO_PROXY_KEY: &str = "network.no_proxy";
pub const USERNAME_KEY: &str = "network.proxy_username";
/// The password's row in `server_secrets`.
pub const SECRET_OWNER: &str = "network";
pub const PASSWORD_FIELD: &str = "proxy_password";
/// Longer passwords are refused before they are stored.
pub const MAX_PASSWORD_CHARS: usize = 1024;

/// One entry of `network.no_proxy`.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Bypass {
    /// `*`: no request uses the proxy.
    All,
    /// A host name, lowercase.
    Host(String),
    /// `.example.com` or `*.example.com`: the domain and every name below it.
    Domain(String),
    /// An address or a network (`10.0.0.0/8`), for address literals in URLs.
    Net(IpNet),
}

fn normalize(host: &str) -> String {
    host.trim_end_matches('.').to_ascii_lowercase()
}

fn parse_bypass(raw: &str) -> Option<Bypass> {
    let t = raw.trim();
    if t == "*" {
        return Some(Bypass::All);
    }
    if let Ok(net) = t.parse::<IpNet>() {
        return Some(Bypass::Net(net));
    }
    if let Some(ip) = parse_ip_literal(t) {
        return Some(Bypass::Net(IpNet::from(ip)));
    }
    if let Some(domain) = t.strip_prefix("*.").or_else(|| t.strip_prefix('.')) {
        return is_host_name(domain).then(|| Bypass::Domain(normalize(domain)));
    }
    is_host_name(t).then(|| Bypass::Host(normalize(t)))
}

/// Checks a `network.proxy_url` value: empty, or `http://` or `https://` with a host, an
/// optional port and nothing else (no user name, password, path, query or fragment; the
/// credentials have their own fields). An address literal must not be a metadata address.
pub fn check_url(text: &str) -> Result<(), String> {
    if text.is_empty() {
        return Ok(());
    }
    if text.len() > 2048 || text.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("an http:// or https:// address without spaces".into());
    }
    let url = Url::parse(text).map_err(|e| format!("not an address: {e}"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("the address starts with http:// or https://".into());
    }
    let Some(host) = url.host_str().filter(|h| !h.is_empty()) else {
        return Err("the address has no host".into());
    };
    if !url.username().is_empty() || url.password().is_some() {
        return Err("the user name and password have their own fields".into());
    }
    if !matches!(url.path(), "" | "/") || url.query().is_some() || url.fragment().is_some() {
        return Err("the address is only scheme, host and port".into());
    }
    if parse_ip_literal(host).is_some_and(is_always_blocked) {
        return Err(format!("{host} is a link-local or cloud metadata address"));
    }
    Ok(())
}

/// Kalzit's own addresses, which a proxy address must never name: its listeners
/// (`server.http_addr`, `server.https_addr`) and the server of its own database (PostgreSQL).
#[derive(Clone, Debug, Default)]
pub struct OwnAddresses {
    /// The listeners; an unspecified address (`0.0.0.0`, `::`) listens on every address of this
    /// computer, so its loopback names and addresses count.
    pub listeners: Vec<std::net::SocketAddr>,
    /// The host (lowercase, without brackets) and port of Kalzit's own database server.
    pub database: Option<(String, u16)>,
}

impl OwnAddresses {
    pub fn of(config: &crate::config::Config) -> Self {
        let listeners = [&config.server.http_addr, &config.server.https_addr]
            .into_iter()
            .filter_map(|a| a.trim().parse::<std::net::SocketAddr>().ok())
            .collect();
        let url = config.database_url();
        let database =
            Url::parse(&url).ok().filter(|u| matches!(u.scheme(), "postgres" | "postgresql")).and_then(|u| {
                let host = normalize_numeric(&normalize(u.host_str()?.trim_matches(['[', ']'])));
                (!host.is_empty()).then_some((host, u.port().unwrap_or(5432)))
            });
        Self { listeners, database }
    }
}

/// A host as an `http://` address would name it: numeric IPv4 forms that are not dotted quads
/// (`2130706433`, `0x7f000001`, `0177.1`) become the address they mean. Addresses of other schemes
/// (`postgres://`) keep their host as written, which still reaches the same address.
fn normalize_numeric(host: &str) -> String {
    if host.is_empty()
        || parse_ip_literal(host).is_some()
        || !host.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.')
    {
        return host.to_string();
    }
    match Url::parse(&format!("http://{host}/")).ok().and_then(|u| u.host().map(|h| h.to_owned())) {
        Some(url::Host::Ipv4(ip)) => ip.to_string(),
        _ => host.to_string(),
    }
}

/// Whether `ip` is an address of this computer: a socket can be bound to it. Cheap, needs no list
/// of interfaces, and works the same on Windows and Linux.
fn is_local_address(ip: IpAddr) -> bool {
    let ip = crate::datasources::targets::canonical_ip(ip);
    if ip.is_loopback() {
        return true;
    }
    if ip.is_unspecified() || ip.is_multicast() {
        return false;
    }
    std::net::UdpSocket::bind(std::net::SocketAddr::new(ip, 0)).is_ok()
}

/// The addresses `host` resolves to, canonical; empty when it does not resolve within a few
/// seconds (the names were compared already).
async fn resolve(host: &str, port: u16) -> Vec<IpAddr> {
    if let Some(ip) = parse_ip_literal(host) {
        return vec![crate::datasources::targets::canonical_ip(ip)];
    }
    let lookup = tokio::net::lookup_host((host.to_string(), port));
    match tokio::time::timeout(std::time::Duration::from_secs(3), lookup).await {
        Ok(Ok(addrs)) => addrs.map(|a| crate::datasources::targets::canonical_ip(a.ip())).collect(),
        _ => Vec::new(),
    }
}

/// Whether `host` names this computer by its loopback name or address.
fn is_loopback_host(host: &str) -> bool {
    host == "localhost"
        || host.ends_with(".localhost")
        || parse_ip_literal(host).is_some_and(|ip| crate::datasources::targets::canonical_ip(ip).is_loopback())
}

/// Refuses a proxy address (`network.proxy_url`) that names Kalzit itself: one of its listeners or
/// its own database server. Requests sent there would reach Kalzit's own API or database with
/// Kalzit's requests and the proxy's sign-in. Names are compared as written here;
/// `check_not_own_resolved` also compares the addresses they resolve to.
pub fn check_not_own(text: &str, own: &OwnAddresses) -> Result<(), String> {
    let Ok(url) = Url::parse(text) else { return Ok(()) };
    let Some(host) = url.host_str() else { return Ok(()) };
    let host = normalize(host.trim_matches(['[', ']']));
    let Some(port) = url.port_or_known_default() else { return Ok(()) };
    let ip = parse_ip_literal(&host).map(crate::datasources::targets::canonical_ip);
    for listener in &own.listeners {
        if listener.port() != port {
            continue;
        }
        let at = crate::datasources::targets::canonical_ip(listener.ip());
        let same = ip == Some(at)
            || ((at.is_unspecified() || at.is_loopback())
                && (is_loopback_host(&host) || ip.is_some_and(|i| i.is_unspecified())));
        if same {
            return Err(format!("{host}:{port} is Kalzit's own listener"));
        }
    }
    if let Some((db_host, db_port)) = &own.database
        && *db_port == port
        && (*db_host == host || (is_loopback_host(db_host) && is_loopback_host(&host)))
    {
        return Err(format!("{host}:{port} is Kalzit's own database server"));
    }
    Ok(())
}

/// `check_not_own`, and then by address: every address the proxy's host resolves to is compared
/// with the loopback addresses and Kalzit's listeners (an unspecified listener, `0.0.0.0` or `::`,
/// with every address of this computer), and with the addresses of its own database server.
///
/// The limit: the proxy's name is resolved here, when the setting is saved and whenever the proxy
/// is taken into use (`current`); a name whose answer changes between this check and the request
/// is not caught. An address of this computer that is no listener's and a database reached through
/// another computer's port forwarding are not either.
pub async fn check_not_own_resolved(text: &str, own: &OwnAddresses) -> Result<(), String> {
    check_not_own(text, own)?;
    let Ok(url) = Url::parse(text) else { return Ok(()) };
    let Some(host) = url.host_str() else { return Ok(()) };
    let host = normalize(host.trim_matches(['[', ']']));
    let Some(port) = url.port_or_known_default() else { return Ok(()) };
    let ips = resolve(&host, port).await;
    let db_ips = match &own.database {
        Some((db_host, db_port)) if *db_port == port => resolve(db_host, *db_port).await,
        _ => Vec::new(),
    };
    check_addresses(&host, port, &ips, own, &db_ips)
}

/// The comparison of `check_not_own_resolved`: `ips` are the proxy's addresses, `db_ips` those of
/// Kalzit's own database server.
fn check_addresses(host: &str, port: u16, ips: &[IpAddr], own: &OwnAddresses, db_ips: &[IpAddr]) -> Result<(), String> {
    for listener in own.listeners.iter().filter(|l| l.port() == port) {
        let at = crate::datasources::targets::canonical_ip(listener.ip());
        let hit = ips.iter().any(|ip| {
            *ip == at
                || ((at.is_loopback() || at.is_unspecified()) && ip.is_loopback())
                || (at.is_unspecified() && is_local_address(*ip))
        });
        if hit {
            return Err(format!("{host}:{port} resolves to Kalzit's own listener"));
        }
    }
    if own.database.as_ref().is_some_and(|(_, db_port)| *db_port == port) {
        let db_local = db_ips.iter().any(|ip| is_local_address(*ip));
        if ips.iter().any(|ip| db_ips.contains(ip) || (db_local && is_local_address(*ip))) {
            return Err(format!("{host}:{port} resolves to Kalzit's own database server"));
        }
    }
    Ok(())
}

/// Checks a `network.no_proxy` entry.
pub fn check_bypass(text: &str) -> Result<(), String> {
    parse_bypass(text)
        .map(|_| ())
        .ok_or_else(|| format!("{text} is not a host name, .domain, *.domain, address, network (10.0.0.0/8) or *"))
}

/// The proxy in force.
#[derive(Clone)]
pub struct OutboundProxy {
    url: Url,
    bypass: Vec<Bypass>,
    username: Option<String>,
    password: Option<Zeroizing<String>>,
}

impl std::fmt::Debug for OutboundProxy {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OutboundProxy")
            .field("url", &self.url.as_str())
            .field("bypass", &self.bypass)
            .field("username", &self.username)
            .field("password", &self.password.as_ref().map(|_| "<set>"))
            .finish()
    }
}

impl OutboundProxy {
    /// The proxy of `url` (checked as `check_url`), with the `no_proxy` entries that parse
    /// and the credentials. `None` for an empty URL.
    pub fn new(
        url: &str,
        no_proxy: &[String],
        username: Option<String>,
        password: Option<Zeroizing<String>>,
    ) -> Result<Option<Self>, String> {
        check_url(url)?;
        if url.is_empty() {
            return Ok(None);
        }
        let url = Url::parse(url).map_err(|e| e.to_string())?;
        let bypass = no_proxy.iter().filter_map(|e| parse_bypass(e)).collect();
        let username = username.filter(|u| !u.is_empty());
        Ok(Some(Self { url, bypass, username, password }))
    }

    pub fn url(&self) -> &Url {
        &self.url
    }

    /// The proxy's host as reqwest resolves it, lowercase and without brackets.
    pub fn host(&self) -> String {
        normalize(self.url.host_str().unwrap_or_default().trim_matches(['[', ']']))
    }

    /// Whether a request to `url` goes past the proxy (`network.no_proxy`).
    pub fn bypasses(&self, url: &Url) -> bool {
        url.host_str().is_none_or(|host| self.bypasses_host(host))
    }

    /// Whether `network.no_proxy` names `host` (a name or an address literal).
    pub fn bypasses_host(&self, host: &str) -> bool {
        let host = normalize(host.trim_matches(['[', ']']));
        let ip: Option<IpAddr> = parse_ip_literal(&host);
        self.bypass.iter().any(|b| match b {
            Bypass::All => true,
            Bypass::Host(h) => *h == host,
            Bypass::Domain(d) => host == *d || host.strip_suffix(d.as_str()).is_some_and(|rest| rest.ends_with('.')),
            Bypass::Net(net) => ip.is_some_and(|ip| net.contains(&crate::datasources::targets::canonical_ip(ip))),
        })
    }

    /// The proxy as reqwest takes it: every request through it, except those `bypasses` names.
    /// The sign-in goes only with a user name and a password stored for this proxy; without the
    /// password (none, or one set for another address) no sign-in is sent at all.
    pub fn reqwest_proxy(self: &Arc<Self>) -> reqwest::Proxy {
        let this = self.clone();
        let target = self.url.clone();
        let mut proxy = reqwest::Proxy::custom(move |url| (!this.bypasses(url)).then(|| target.clone()));
        if let (Some(user), Some(password)) = (&self.username, &self.password) {
            proxy = proxy.basic_auth(user, password.as_str());
        }
        proxy
    }
}

/// The proxy in force from the server settings and the stored password; `None` when
/// `network.proxy_url` is empty.
pub async fn current(state: &AppState) -> ApiResult<Option<Arc<OutboundProxy>>> {
    let url = crate::settings::get(state, URL_KEY).await?;
    let url = url.as_str().unwrap_or_default();
    if url.is_empty() {
        return Ok(None);
    }
    let no_proxy: Vec<String> = crate::settings::get(state, NO_PROXY_KEY)
        .await?
        .as_array()
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();
    let username = crate::settings::get(state, USERNAME_KEY).await?.as_str().map(String::from);
    let password = match username.as_deref() {
        Some(u) if !u.is_empty() => load_password(&state.db, &state.secrets, url).await?,
        _ => None,
    };
    // A proxy stored before this check existed, or set through the environment, is refused too.
    check_not_own_resolved(url, &OwnAddresses::of(&state.config))
        .await
        .map_err(|e| ApiError::internal("outbound proxy", e))?;
    let proxy =
        OutboundProxy::new(url, &no_proxy, username, password).map_err(|e| ApiError::internal("outbound proxy", e))?;
    Ok(proxy.map(Arc::new))
}

/// `current` for work that runs on its own (update checks and downloads, ACME). It fails closed:
/// when the proxy setting or its password cannot be read, nothing goes out directly instead.
/// The error is logged at error level, and the caller records the message where operations see
/// it (the update check, the certificate status).
pub async fn current_or_refuse(state: &AppState, purpose: &str) -> Result<Option<Arc<OutboundProxy>>, String> {
    current(state).await.map_err(|e| {
        tracing::error!(
            "the outbound proxy setting cannot be read, so {purpose} does not go out until it is fixed: {}",
            e.message
        );
        format!("the outbound proxy setting cannot be read: {}", e.message)
    })
}

/// What the secret holds: the password with the proxy address it was set for. A password is only
/// ever sent to that proxy; after the address changes it is not used until it is set again, so
/// changing the address cannot hand it to another host.
#[derive(serde::Serialize, serde::Deserialize)]
struct StoredPassword {
    proxy: String,
    password: String,
}

/// The stored password and the proxy address it was set for.
pub async fn stored_password(db: &sqlx::AnyPool, keyring: &Keyring) -> ApiResult<Option<(String, Zeroizing<String>)>> {
    let row: Option<(String, String, String)> =
        sqlx::query_as("SELECT key_id, nonce, ciphertext FROM server_secrets WHERE owner = $1 AND field = $2")
            .bind(SECRET_OWNER)
            .bind(PASSWORD_FIELD)
            .fetch_optional(db)
            .await?;
    let Some((key_id, nonce, ciphertext)) = row else { return Ok(None) };
    let plain = keyring
        .decrypt(SECRET_OWNER, PASSWORD_FIELD, &Blob { key_id, nonce, ciphertext })
        .map_err(|e| ApiError::internal("decrypting the proxy password", e))?;
    let stored: StoredPassword =
        serde_json::from_str(&plain).map_err(|e| ApiError::internal("reading the proxy password", e))?;
    Ok(Some((stored.proxy, Zeroizing::new(stored.password))))
}

/// The stored password when it was set for the proxy at `url`.
pub async fn load_password(db: &sqlx::AnyPool, keyring: &Keyring, url: &str) -> ApiResult<Option<Zeroizing<String>>> {
    Ok(stored_password(db, keyring).await?.filter(|(proxy, _)| proxy == url).map(|(_, password)| password))
}

/// Stores the password for the proxy at `url` (`Some((url, password))`) or removes it (`None`)
/// inside the caller's transaction.
pub async fn store_password(
    conn: &mut sqlx::AnyConnection,
    keyring: &Keyring,
    password: Option<(&str, &str)>,
) -> ApiResult<()> {
    sqlx::query("DELETE FROM server_secrets WHERE owner = $1 AND field = $2")
        .bind(SECRET_OWNER)
        .bind(PASSWORD_FIELD)
        .execute(&mut *conn)
        .await?;
    if let Some((url, plain)) = password.filter(|(_, p)| !p.is_empty()) {
        let text = Zeroizing::new(
            serde_json::to_string(&StoredPassword { proxy: url.to_string(), password: plain.to_string() })
                .map_err(|e| ApiError::internal("storing the proxy password", e))?,
        );
        let blob = keyring.encrypt(SECRET_OWNER, PASSWORD_FIELD, &text);
        sqlx::query("INSERT INTO server_secrets (owner, field, key_id, nonce, ciphertext) VALUES ($1, $2, $3, $4, $5)")
            .bind(SECRET_OWNER)
            .bind(PASSWORD_FIELD)
            .bind(&blob.key_id)
            .bind(&blob.nonce)
            .bind(&blob.ciphertext)
            .execute(&mut *conn)
            .await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn proxy(no_proxy: &[&str]) -> OutboundProxy {
        let no_proxy: Vec<String> = no_proxy.iter().map(|s| s.to_string()).collect();
        OutboundProxy::new("http://proxy.example.test:3128", &no_proxy, None, None).unwrap().unwrap()
    }

    fn url(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn a_proxy_never_names_kalzits_own_listener_or_database() {
        let own = OwnAddresses {
            listeners: vec!["0.0.0.0:3000".parse().unwrap(), "10.0.0.7:3443".parse().unwrap()],
            database: Some(("db.example.test".into(), 5432)),
        };
        for bad in [
            "http://localhost:3000",
            "http://127.0.0.1:3000",
            "http://[::1]:3000",
            "http://0.0.0.0:3000",
            "https://10.0.0.7:3443",
            "http://DB.example.test:5432",
        ] {
            assert!(check_not_own(bad, &own).is_err(), "{bad}");
        }
        for good in ["", "http://localhost:3128", "http://proxy.example.test:5432", "http://db.example.test:3128"] {
            assert!(check_not_own(good, &own).is_ok(), "{good}");
        }
        // A database on this computer: any loopback name of the same port.
        let local = OwnAddresses { listeners: Vec::new(), database: Some(("localhost".into(), 5432)) };
        assert!(check_not_own("http://127.0.0.1:5432", &local).is_err());
    }

    #[test]
    fn a_proxy_is_compared_with_kalzit_by_the_addresses_it_resolves_to() {
        let ip = |s: &str| s.parse::<IpAddr>().unwrap();
        let own = OwnAddresses {
            listeners: vec!["0.0.0.0:3000".parse().unwrap(), "10.0.0.7:3443".parse().unwrap()],
            database: Some(("db.example.test".into(), 5432)),
        };
        // A name that resolves to a loopback address, to the listener's address, or (for an
        // unspecified listener) to any address of this computer.
        assert!(check_addresses("proxy.test", 3000, &[ip("127.0.0.1")], &own, &[]).is_err());
        assert!(check_addresses("proxy.test", 3000, &[ip("::ffff:127.0.0.1")], &own, &[]).is_err());
        assert!(check_addresses("proxy.test", 3443, &[ip("192.0.2.1"), ip("10.0.0.7")], &own, &[]).is_err());
        assert!(check_addresses("proxy.test", 3443, &[ip("10.0.0.8")], &own, &[]).is_ok());
        assert!(check_addresses("proxy.test", 3128, &[ip("127.0.0.1")], &own, &[]).is_ok());
        // The database: the same address, or both on this computer.
        assert!(check_addresses("proxy.test", 5432, &[ip("192.0.2.9")], &own, &[ip("192.0.2.9")]).is_err());
        assert!(check_addresses("proxy.test", 5432, &[ip("192.0.2.9")], &own, &[ip("192.0.2.10")]).is_ok());
        assert!(check_addresses("proxy.test", 5432, &[ip("127.0.0.1")], &own, &[ip("127.0.0.1")]).is_err());
        assert!(check_addresses("proxy.test", 5432, &[ip("127.0.0.2")], &own, &[ip("::1")]).is_err());
        // An address of this computer that is not loopback, where the computer has one.
        if let Some(local) = std::net::UdpSocket::bind("0.0.0.0:0")
            .and_then(|s| s.connect("192.0.2.1:9").map(|()| s))
            .and_then(|s| s.local_addr())
            .ok()
            .map(|a| a.ip())
            .filter(|ip| !ip.is_unspecified() && !ip.is_loopback())
        {
            assert!(is_local_address(local), "{local}");
            assert!(check_addresses("proxy.test", 3000, &[local], &own, &[]).is_err(), "{local}");
        }
        assert!(!is_local_address(ip("192.0.2.200")));
    }

    #[tokio::test]
    async fn a_name_of_this_computer_is_refused_by_address() {
        let own = OwnAddresses { listeners: vec!["127.0.0.1:3000".parse().unwrap()], database: None };
        assert!(resolve("localhost", 3000).await.iter().all(|ip| ip.is_loopback()));
        assert!(check_not_own_resolved("http://localhost:3000", &own).await.is_err());
        assert!(check_not_own_resolved("http://0x7f.1:3000", &own).await.is_err());
        assert!(check_not_own_resolved("http://localhost:3128", &own).await.is_ok());
    }

    #[test]
    fn numeric_hosts_of_the_database_are_normalized() {
        assert_eq!(normalize_numeric("2130706433"), "127.0.0.1");
        assert_eq!(normalize_numeric("0x7f000001"), "127.0.0.1");
        assert_eq!(normalize_numeric("0177.0.0.1"), "127.0.0.1");
        assert_eq!(normalize_numeric("127.1"), "127.0.0.1");
        assert_eq!(normalize_numeric("db.example.test"), "db.example.test");
        assert_eq!(normalize_numeric("::1"), "::1");
        let mut config = crate::config::Config::default();
        config.database.url = Some("postgres://kalzit@0x7f000001:5432/kalzit".into());
        let own = OwnAddresses::of(&config);
        assert_eq!(own.database, Some(("127.0.0.1".into(), 5432)));
        assert!(check_not_own("http://localhost:5432", &own).is_err());
    }

    #[test]
    fn proxy_urls_are_scheme_host_and_port_only() {
        for good in
            ["", "http://proxy:3128", "https://proxy.example.com", "http://10.0.0.5:8080/", "http://[fd00::1]:3128"]
        {
            assert!(check_url(good).is_ok(), "{good}");
        }
        for bad in [
            "proxy:3128",
            "socks5://proxy:1080",
            "ftp://proxy",
            "http://user:secret@proxy:3128",
            "http://proxy:3128/path",
            "http://proxy:3128/?a=1",
            "http://169.254.169.254",
            "http://proxy :3128",
        ] {
            assert!(check_url(bad).is_err(), "{bad}");
        }
        assert!(OutboundProxy::new("", &[], None, None).unwrap().is_none());
    }

    #[test]
    fn no_proxy_entries_match_hosts_domains_and_networks() {
        let p = proxy(&["localhost", ".corp.example", "*.intern.test", "10.0.0.0/8", "fd00::1"]);
        assert!(p.bypasses(&url("http://localhost:8080/")));
        assert!(p.bypasses(&url("https://CORP.example/")));
        assert!(p.bypasses(&url("https://ca.corp.example/directory")));
        assert!(p.bypasses(&url("https://a.b.intern.test/")));
        assert!(p.bypasses(&url("http://10.1.2.3/")));
        assert!(p.bypasses(&url("http://[fd00::1]/")));
        assert!(!p.bypasses(&url("https://notcorp.example/")));
        assert!(!p.bypasses(&url("https://plugins.kalzit.dev/index.json")));
        assert!(!p.bypasses(&url("http://11.0.0.1/")));
        assert!(proxy(&["*"]).bypasses(&url("https://api.github.com/")));
        for bad in ["", "http://x", "a b", "*.", "10.0.0.0/33"] {
            assert!(check_bypass(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn the_password_is_never_printed() {
        let p = OutboundProxy::new(
            "http://proxy:3128",
            &[],
            Some("kalzit".into()),
            Some(Zeroizing::new("geheim-4711".to_string())),
        )
        .unwrap()
        .unwrap();
        let printed = format!("{p:?}");
        assert!(!printed.contains("geheim"), "{printed}");
        assert!(printed.contains("kalzit"), "{printed}");
    }
}
