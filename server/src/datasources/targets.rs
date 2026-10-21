//! Where data sources may connect (docs/ARCHITECTURE.md, "Data sources", targets).
//!
//! Private networks and localhost are allowed: self-hosted databases live there. Always refused
//! are Kalzit's own data directory and database, link-local and cloud metadata addresses, and
//! SQLite files outside the directories a server admin allowed. An admin may further restrict
//! sources to a list of hosts and networks (`datasources.allowed_targets`).
//!
//! A host name is resolved once per connect, the resolved address is checked, and the caller
//! connects to that address, so a name cannot resolve to an allowed address for the check and a
//! blocked one for the connection (DNS rebinding).

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::path::{Path, PathBuf};

use ipnet::IpNet;

/// A refused target. The message names the rule, never a secret.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct Blocked(pub String);

#[derive(Debug, thiserror::Error)]
pub enum ResolveError {
    #[error(transparent)]
    Blocked(#[from] Blocked),
    #[error("cannot reach {host}: {reason}")]
    Dns { host: String, reason: String },
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum AllowedTarget {
    Net(IpNet),
    /// A host name as configured, lowercase.
    Host(String),
    /// `*.example.com`: any name ending in `.example.com`.
    Suffix(String),
}

/// The target rules in force, built from the server settings when a connection is set up.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TargetPolicy {
    /// Canonical, so a symlink or junction into it is still recognized.
    data_dir: PathBuf,
    /// Kalzit's own SQLite database when it lives outside the data directory.
    own_sqlite: Option<PathBuf>,
    sqlite_dirs: Vec<PathBuf>,
    /// `None` = no restriction. A configured list whose entries are all invalid restricts to
    /// nothing rather than allowing everything.
    allowed: Option<Vec<AllowedTarget>>,
}

impl TargetPolicy {
    /// `sqlite_dirs` and `allowed_targets` come from the server settings; invalid entries are
    /// skipped with a warning (which only narrows what is allowed).
    pub fn new(data_dir: &Path, own_db_url: &str, sqlite_dirs: &[String], allowed_targets: &[String]) -> Self {
        let data_dir = canonical_or_absolute(data_dir);
        let own_sqlite = own_sqlite_path(own_db_url).map(|p| canonical_or_absolute(&p));
        let sqlite_dirs = sqlite_dirs
            .iter()
            .filter_map(|d| match std::fs::canonicalize(d) {
                Ok(p) if p.is_dir() => Some(p),
                Ok(_) => {
                    tracing::warn!("datasources.sqlite_dirs: {d} is not a directory, ignored");
                    None
                }
                Err(e) => {
                    tracing::warn!("datasources.sqlite_dirs: {d} cannot be used ({e}), ignored");
                    None
                }
            })
            .collect();
        let allowed = (!allowed_targets.is_empty()).then(|| {
            allowed_targets
                .iter()
                .filter_map(|t| {
                    let parsed = parse_allowed(t);
                    if parsed.is_none() {
                        tracing::warn!("datasources.allowed_targets: {t:?} is not a host, address or network, ignored");
                    }
                    parsed
                })
                .collect()
        });
        Self { data_dir, own_sqlite, sqlite_dirs, allowed }
    }

    /// The canonical file a SQLite source may open, or why not.
    pub fn check_sqlite_path(&self, raw: &str) -> Result<PathBuf, Blocked> {
        let path = Path::new(raw);
        if !path.is_absolute() {
            return Err(Blocked("the SQLite path must be absolute".into()));
        }
        // Symlinks and junctions are resolved first, so a link inside an allowed directory
        // cannot point at a file elsewhere.
        let canonical =
            std::fs::canonicalize(path).map_err(|e| Blocked(format!("the SQLite file cannot be opened: {e}")))?;
        if canonical.starts_with(&self.data_dir) {
            return Err(Blocked("Kalzit's own data directory cannot be a data source".into()));
        }
        if let Some(own) = &self.own_sqlite
            && is_same_database_file(&canonical, own)
        {
            return Err(Blocked("Kalzit's own database cannot be a data source".into()));
        }
        if !self.sqlite_dirs.iter().any(|dir| canonical.starts_with(dir)) {
            return Err(Blocked(
                "the SQLite file is outside the directories allowed in datasources.sqlite_dirs".into(),
            ));
        }
        if !canonical.is_file() {
            return Err(Blocked("the SQLite path is not a file".into()));
        }
        Ok(strip_verbatim(canonical))
    }

    /// Checks one address, reached through `host` (the name as configured, for the allow-list).
    pub fn check_ip(&self, host: &str, ip: IpAddr) -> Result<(), Blocked> {
        if is_always_blocked(ip) {
            return Err(Blocked(format!("{ip} is a link-local or cloud metadata address")));
        }
        let Some(allowed) = &self.allowed else { return Ok(()) };
        let ip = canonical_ip(ip);
        let name = normalize_host(host);
        let ok = allowed.iter().any(|t| match t {
            AllowedTarget::Net(net) => net.contains(&ip),
            AllowedTarget::Host(h) => *h == name,
            AllowedTarget::Suffix(s) => name.ends_with(s.as_str()) && name.len() > s.len(),
        });
        if ok { Ok(()) } else { Err(Blocked(format!("{host} is not in datasources.allowed_targets"))) }
    }

    /// The checks that need no network: an address literal, or a host name against the
    /// allow-list. Used when settings are saved, for early feedback.
    pub fn precheck_host(&self, host: &str) -> Result<(), Blocked> {
        if let Some(ip) = parse_ip_literal(host) {
            return self.check_ip(host, ip);
        }
        let Some(allowed) = &self.allowed else { return Ok(()) };
        // With network entries the name may still resolve into an allowed network.
        if allowed.iter().any(|t| matches!(t, AllowedTarget::Net(_))) {
            return Ok(());
        }
        self.check_ip(host, IpAddr::V4(Ipv4Addr::UNSPECIFIED))
    }

    /// Resolves `host` once and returns the first address that passes the checks. Any always
    /// blocked address in the answer refuses the whole name.
    pub async fn resolve(&self, host: &str, port: u16) -> Result<SocketAddr, ResolveError> {
        Ok(self.resolve_all(host, port).await?[0])
    }

    /// Every address of `host` that passes the checks, in resolver order (never empty).
    pub async fn resolve_all(&self, host: &str, port: u16) -> Result<Vec<SocketAddr>, ResolveError> {
        if let Some(ip) = parse_ip_literal(host) {
            self.check_ip(host, ip)?;
            return Ok(vec![SocketAddr::new(ip, port)]);
        }
        let addrs: Vec<SocketAddr> = tokio::net::lookup_host((normalize_host(host).as_str(), port))
            .await
            .map_err(|e| ResolveError::Dns { host: host.to_string(), reason: e.to_string() })?
            .collect();
        if addrs.is_empty() {
            return Err(ResolveError::Dns { host: host.to_string(), reason: "no addresses".into() });
        }
        if let Some(bad) = addrs.iter().find(|a| is_always_blocked(a.ip())) {
            return Err(
                Blocked(format!("{host} resolves to {}, a link-local or cloud metadata address", bad.ip())).into()
            );
        }
        let mut allowed = Vec::new();
        let mut last = None;
        for addr in addrs {
            match self.check_ip(host, addr.ip()) {
                Ok(()) => allowed.push(addr),
                Err(e) => last = Some(e),
            }
        }
        match last {
            Some(e) if allowed.is_empty() => Err(e.into()),
            _ => Ok(allowed),
        }
    }

    /// The checked address a driver should connect to. With several candidates (`localhost` is
    /// often `::1` and `127.0.0.1`, with the database listening on only one) the first that
    /// accepts a TCP connection wins; a single candidate is used without a probe, so servers
    /// that count aborted connections (MySQL) see none.
    pub async fn pick_address(
        &self,
        host: &str,
        port: u16,
        timeout: std::time::Duration,
    ) -> Result<SocketAddr, ResolveError> {
        let addrs = self.resolve_all(host, port).await?;
        if let [only] = addrs.as_slice() {
            return Ok(*only);
        }
        Ok(self.connect(host, port, timeout).await?.0)
    }

    /// Resolves and checks `host`, then opens a TCP connection to the first checked address that
    /// answers (`localhost` is often `::1` and `127.0.0.1`, with the database on only one).
    pub async fn connect(
        &self,
        host: &str,
        port: u16,
        timeout: std::time::Duration,
    ) -> Result<(SocketAddr, tokio::net::TcpStream), ResolveError> {
        let mut last = String::new();
        for addr in self.resolve_all(host, port).await? {
            match tokio::time::timeout(timeout, tokio::net::TcpStream::connect(addr)).await {
                Ok(Ok(stream)) => return Ok((addr, stream)),
                Ok(Err(e)) => last = format!("{addr}: {e}"),
                Err(_) => last = format!("{addr}: no answer within {} seconds", timeout.as_secs()),
            }
        }
        Err(ResolveError::Dns { host: host.to_string(), reason: format!("cannot connect ({last})") })
    }
}

/// Link-local (including the cloud metadata endpoint 169.254.169.254) and the AWS IPv6 metadata
/// address, also when written as an IPv4-mapped, -compatible or NAT64 address.
pub fn is_always_blocked(ip: IpAddr) -> bool {
    const AWS_V6_METADATA: Ipv6Addr = Ipv6Addr::new(0xfd00, 0xec2, 0, 0, 0, 0, 0, 0x254);
    match canonical_ip(ip) {
        IpAddr::V4(v4) => v4.is_link_local(),
        IpAddr::V6(v6) => (v6.segments()[0] & 0xffc0) == 0xfe80 || v6 == AWS_V6_METADATA,
    }
}

/// IPv6 forms that carry an IPv4 address are compared as that address.
fn canonical_ip(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V6(v6) => {
            let s = v6.segments();
            // 64:ff9b::/96, the well-known NAT64 prefix (RFC 6052).
            if s[..6] == [0x64, 0xff9b, 0, 0, 0, 0] {
                return IpAddr::V4(Ipv4Addr::new((s[6] >> 8) as u8, s[6] as u8, (s[7] >> 8) as u8, s[7] as u8));
            }
            if let Some(v4) = v6.to_ipv4_mapped() {
                return IpAddr::V4(v4);
            }
            // Deprecated IPv4-compatible addresses (::a.b.c.d), but not :: and ::1.
            if s[..6] == [0; 6] && (s[6] != 0 || s[7] > 1) {
                return IpAddr::V4(Ipv4Addr::new((s[6] >> 8) as u8, s[6] as u8, (s[7] >> 8) as u8, s[7] as u8));
            }
            IpAddr::V6(v6)
        }
        v4 => v4,
    }
}

pub fn parse_ip_literal(host: &str) -> Option<IpAddr> {
    let inner = host.strip_prefix('[').and_then(|h| h.strip_suffix(']')).unwrap_or(host);
    inner.parse().ok()
}

fn normalize_host(host: &str) -> String {
    host.trim_end_matches('.').to_ascii_lowercase()
}

fn parse_allowed(raw: &str) -> Option<AllowedTarget> {
    let t = raw.trim();
    if let Ok(net) = t.parse::<IpNet>() {
        return Some(AllowedTarget::Net(net));
    }
    if let Some(ip) = parse_ip_literal(t) {
        return Some(AllowedTarget::Net(IpNet::from(canonical_ip(ip))));
    }
    if let Some(suffix) = t.strip_prefix("*.") {
        return is_host_name(suffix).then(|| AllowedTarget::Suffix(format!(".{}", normalize_host(suffix))));
    }
    is_host_name(t).then(|| AllowedTarget::Host(normalize_host(t)))
}

/// A DNS name: letters, digits, `-`, `_` and dots, at most 253 characters.
pub fn is_host_name(s: &str) -> bool {
    let s = s.trim_end_matches('.');
    !s.is_empty()
        && s.len() <= 253
        && s.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        })
}

/// The file of a `sqlite:` database URL (as built by `config::sqlite_url` or written by hand).
fn own_sqlite_path(url: &str) -> Option<PathBuf> {
    let rest = url.strip_prefix("sqlite:")?;
    let rest = rest.strip_prefix("//").unwrap_or(rest);
    let path = rest.split('?').next()?;
    if path.is_empty() || path == ":memory:" {
        return None;
    }
    let decoded = path.replace("%3F", "?").replace("%23", "#").replace("%25", "%");
    Some(PathBuf::from(decoded))
}

/// The database file itself or one of SQLite's companion files (`-wal`, `-shm`, `-journal`).
fn is_same_database_file(candidate: &Path, own: &Path) -> bool {
    if candidate == own {
        return true;
    }
    let (Some(c), Some(o)) = (candidate.to_str(), own.to_str()) else { return false };
    ["-wal", "-shm", "-journal"].iter().any(|suffix| c.strip_suffix(suffix) == Some(o))
}

fn canonical_or_absolute(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf()))
}

/// `\\?\C:\x` (what canonicalize answers on Windows) as `C:\x`, which SQLite opens like any other
/// path. UNC and other verbatim forms are kept.
fn strip_verbatim(path: PathBuf) -> PathBuf {
    #[cfg(windows)]
    if let Some(s) = path.to_str()
        && let Some(rest) = s.strip_prefix(r"\\?\")
        && rest.as_bytes().get(1) == Some(&b':')
    {
        return PathBuf::from(rest);
    }
    path
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    fn policy(allowed: &[&str]) -> TargetPolicy {
        let dir = std::env::temp_dir();
        TargetPolicy::new(
            &dir.join("kalzit-data"),
            "sqlite::memory:",
            &[],
            &allowed.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
        )
    }

    #[test]
    fn metadata_and_link_local_are_always_blocked() {
        for bad in [
            "169.254.169.254",
            "169.254.0.1",
            "fe80::1",
            "febf::1",
            "fd00:ec2::254",
            "::ffff:169.254.169.254",
            "64:ff9b::a9fe:a9fe",
            "::a9fe:a9fe",
        ] {
            assert!(is_always_blocked(ip(bad)), "{bad}");
            assert!(policy(&[]).check_ip("x", ip(bad)).is_err(), "{bad}");
        }
        for ok in ["127.0.0.1", "10.0.0.5", "192.168.1.1", "::1", "::", "fd00:ec2::253", "fec0::1", "8.8.8.8"] {
            assert!(!is_always_blocked(ip(ok)), "{ok}");
            assert!(policy(&[]).check_ip("x", ip(ok)).is_ok(), "{ok}");
        }
    }

    #[test]
    fn allow_list_restricts_by_network_and_name() {
        let p = policy(&["10.0.0.0/8", "db.example.com", "*.intern.example", "192.168.1.7", "kein gültiger eintrag"]);
        assert!(p.check_ip("anything", ip("10.1.2.3")).is_ok());
        assert!(p.check_ip("anything", ip("::ffff:10.1.2.3")).is_ok());
        assert!(p.check_ip("anything", ip("192.168.1.7")).is_ok());
        assert!(p.check_ip("DB.Example.com.", ip("203.0.113.1")).is_ok());
        assert!(p.check_ip("pg.intern.example", ip("203.0.113.1")).is_ok());
        assert!(p.check_ip("intern.example", ip("203.0.113.1")).is_err());
        assert!(p.check_ip("evil-db.example.com", ip("203.0.113.1")).is_err());
        assert!(p.check_ip("127.0.0.1", ip("127.0.0.1")).is_err());
        // The allow-list never lifts the metadata block.
        assert!(policy(&["169.254.0.0/16"]).check_ip("x", ip("169.254.169.254")).is_err());
        // A configured list with only invalid entries allows nothing.
        assert!(policy(&["???"]).check_ip("x", ip("10.0.0.1")).is_err());
    }

    #[test]
    fn prechecks_need_no_network() {
        assert!(policy(&[]).precheck_host("169.254.169.254").is_err());
        assert!(policy(&[]).precheck_host("[fe80::1]").is_err());
        assert!(policy(&[]).precheck_host("db.example.com").is_ok());
        assert!(policy(&["db.example.com"]).precheck_host("other.example.com").is_err());
        assert!(policy(&["10.0.0.0/8"]).precheck_host("other.example.com").is_ok(), "may resolve into the network");
    }

    #[tokio::test]
    async fn resolution_checks_the_address_it_returns() {
        let p = policy(&[]);
        assert_eq!(p.resolve("127.0.0.1", 5432).await.unwrap(), "127.0.0.1:5432".parse().unwrap());
        assert_eq!(p.resolve("[::1]", 5432).await.unwrap(), "[::1]:5432".parse().unwrap());
        assert!(matches!(p.resolve("169.254.169.254", 80).await, Err(ResolveError::Blocked(_))));
        let localhost = p.resolve("localhost", 9090).await.unwrap();
        assert!(localhost.ip().is_loopback() && localhost.port() == 9090);
        let only_ten = policy(&["10.0.0.0/8"]);
        assert!(matches!(only_ten.resolve("localhost", 1).await, Err(ResolveError::Blocked(_))));
        assert!(matches!(p.resolve("does-not-exist.invalid", 1).await, Err(ResolveError::Dns { .. })));
    }

    #[test]
    fn sqlite_paths_must_be_inside_allowed_directories() {
        let root = tempfile::tempdir().unwrap();
        let data = root.path().join("data");
        let allowed = root.path().join("erlaubt mit Ümlaut");
        let other = root.path().join("anderswo");
        for d in [&data, &allowed, &other] {
            std::fs::create_dir_all(d).unwrap();
        }
        std::fs::write(data.join("kalzit.db"), b"").unwrap();
        std::fs::write(allowed.join("umsatz.db"), b"").unwrap();
        std::fs::write(other.join("geheim.db"), b"").unwrap();
        let own_url = crate::config::sqlite_url(&data.join("kalzit.db"));
        let dirs = vec![allowed.to_string_lossy().to_string(), data.to_string_lossy().to_string()];
        let p = TargetPolicy::new(&data, &own_url, &dirs, &[]);

        let ok = p.check_sqlite_path(allowed.join("umsatz.db").to_str().unwrap()).unwrap();
        assert!(ok.ends_with("umsatz.db"));
        assert!(!ok.to_string_lossy().starts_with(r"\\?\"));
        // The data directory stays refused even when an admin lists it.
        let e = p.check_sqlite_path(data.join("kalzit.db").to_str().unwrap()).unwrap_err();
        assert!(e.0.contains("data directory"), "{e}");
        assert!(p.check_sqlite_path(other.join("geheim.db").to_str().unwrap()).is_err());
        let sneaky = allowed.join("..").join("anderswo").join("geheim.db");
        assert!(p.check_sqlite_path(sneaky.to_str().unwrap()).is_err());
        assert!(p.check_sqlite_path("relativ/umsatz.db").is_err());
        assert!(p.check_sqlite_path(allowed.join("fehlt.db").to_str().unwrap()).is_err());
        assert!(p.check_sqlite_path(allowed.to_str().unwrap()).is_err(), "a directory is not a database");

        // Nothing is allowed until an admin lists a directory.
        let none = TargetPolicy::new(&data, &own_url, &[], &[]);
        assert!(none.check_sqlite_path(allowed.join("umsatz.db").to_str().unwrap()).is_err());
    }

    #[test]
    fn links_out_of_allowed_directories_are_refused() {
        let root = tempfile::tempdir().unwrap();
        let data = root.path().join("data");
        let allowed = root.path().join("allowed");
        std::fs::create_dir_all(&data).unwrap();
        std::fs::create_dir_all(&allowed).unwrap();
        std::fs::write(data.join("kalzit.db"), b"").unwrap();
        let link = allowed.join("link");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&data, &link).unwrap();
        #[cfg(windows)]
        {
            // A junction needs no special rights, unlike a symlink.
            let status =
                std::process::Command::new("cmd").args(["/C", "mklink", "/J"]).arg(&link).arg(&data).output().unwrap();
            assert!(status.status.success(), "{}", String::from_utf8_lossy(&status.stderr));
        }
        let p = TargetPolicy::new(&data, "sqlite::memory:", &[allowed.to_string_lossy().to_string()], &[]);
        let e = p.check_sqlite_path(link.join("kalzit.db").to_str().unwrap()).unwrap_err();
        assert!(e.0.contains("data directory"), "{e}");
    }

    #[test]
    fn own_database_outside_the_data_directory_is_refused() {
        let root = tempfile::tempdir().unwrap();
        let data = root.path().join("data");
        let shared = root.path().join("shared");
        std::fs::create_dir_all(&data).unwrap();
        std::fs::create_dir_all(&shared).unwrap();
        for f in ["kalzit.db", "kalzit.db-wal", "andere.db"] {
            std::fs::write(shared.join(f), b"").unwrap();
        }
        let own_url = crate::config::sqlite_url(&shared.join("kalzit.db"));
        let p = TargetPolicy::new(&data, &own_url, &[shared.to_string_lossy().to_string()], &[]);
        assert!(p.check_sqlite_path(shared.join("kalzit.db").to_str().unwrap()).is_err());
        assert!(p.check_sqlite_path(shared.join("kalzit.db-wal").to_str().unwrap()).is_err());
        assert!(p.check_sqlite_path(shared.join("andere.db").to_str().unwrap()).is_ok());
    }

    #[test]
    fn host_names() {
        assert!(is_host_name("db-1.example.com"));
        assert!(is_host_name("my_db"));
        assert!(!is_host_name("user@db"));
        assert!(!is_host_name("db/x"));
        assert!(!is_host_name(""));
        assert!(!is_host_name("db..x"));
        assert!(!is_host_name("dö.example"));
    }
}
