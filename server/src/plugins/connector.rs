//! Kalzit's network connector for plugins (docs/ARCHITECTURE.md, "Network connector"). A plugin
//! process has no network of its own (`sandbox`): for every connection it asks Kalzit, naming
//! the data source, host, port and protocol (`ConnectRequest`). Kalzit checks that the target is
//! one the manifest declares for the data source's settings as the plugin last received them
//! (`Grants`), resolves the name itself, checks every address against the data source target
//! rules (`TargetPolicy`: metadata addresses, `datasources.allowed_targets`) and Kalzit's own
//! addresses (`OwnEndpoints`), connects to the checked address (no second lookup, so no DNS
//! rebinding) and hands the plugin the connected stream:
//!
//! - Linux: the socket itself, over the Unix socket `connector` in the run directory
//!   (`SCM_RIGHTS`). Kalzit keeps no copy; it counts the plugin's connections in its descriptor
//!   table (`/proc/<pid>/fd`) and closes idle ones through a copy taken with `pidfd_getfd`.
//! - Windows: a named pipe per connection that Kalzit relays to the TCP connection. A socket
//!   handle duplicated into the plugin's low integrity AppContainer (`WSADuplicateSocket`)
//!   depends on the Winsock providers of the machine and hides the connection from Kalzit; the
//!   relay works everywhere and lets Kalzit see every connection's end and idle time.
//!
//! Limits: `Options::max_connections` connections per plugin at once, `Options::connection_idle`
//! without traffic, `Options::connect_timeout` per connect. Refused connects are logged with the
//! plugin's output and in the audit log (`plugins.connect_refused`, at most once a minute per
//! target and reason).

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use kalzit_plugin_api::connector::frame;
#[cfg(windows)]
use kalzit_plugin_api::connector::frame_len;
use kalzit_plugin_api::datasource::v1 as pb;
use kalzit_plugin_api::manifest::Manifest;
#[cfg(windows)]
use prost::Message;
use serde_json::{Value, json};
#[cfg(windows)]
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::watch;

use super::supervisor::Logs;
use crate::datasources::targets::{TargetPolicy, canonical_ip};
use crate::datasources::{Connection, Detail};

/// How long a plugin may take to send its request (Windows, one pipe connection per request).
#[cfg(windows)]
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
/// Connector requests Kalzit works on (or waits to read) at once for one process; more are
/// refused at once.
const MAX_PENDING: usize = 16;
/// Refusals of the same target and reason in the audit log at most this often.
const AUDIT_EVERY: Duration = Duration::from_secs(60);

/// The data sources a plugin was handed, with their settings and target rules as of the last
/// call: its connects for a data source may reach only that source's declared targets.
#[derive(Default)]
pub struct Grants {
    by_source: Mutex<HashMap<String, Grant>>,
}

#[derive(Clone)]
struct Grant {
    settings: Value,
    policy: Arc<TargetPolicy>,
}

impl Grants {
    /// Called with every call that hands the plugin a data source.
    pub fn record(&self, conn: &Connection) {
        let grant = Grant { settings: conn.settings().clone(), policy: conn.policy_arc() };
        self.by_source.lock().unwrap_or_else(|e| e.into_inner()).insert(conn.datasource_id().to_string(), grant);
    }

    /// Takes back a data source (changed, deleted, or moved away): connects for it are refused
    /// until a call hands it over again with its current settings.
    pub fn revoke(&self, datasource_id: &str) {
        self.by_source.lock().unwrap_or_else(|e| e.into_inner()).remove(datasource_id);
    }

    fn get(&self, datasource_id: &str) -> Option<Grant> {
        self.by_source.lock().unwrap_or_else(|e| e.into_inner()).get(datasource_id).cloned()
    }
}

/// What the plugin speaks over a connection.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Protocol {
    Tcp,
    Tls,
}

impl Protocol {
    fn name(self) -> &'static str {
        match self {
            Protocol::Tcp => "tcp",
            Protocol::Tls => "tls",
        }
    }
}

/// One target of the manifest for some settings.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Declared {
    pub host: String,
    /// 0 when neither the settings nor the manifest give one.
    pub port: u16,
    pub protocol: Protocol,
    /// The settings field it comes from; `None` for a fixed host.
    pub setting: Option<String>,
}

/// A target setting that holds no usable target.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Unusable {
    pub setting: String,
    pub reason: &'static str,
    pub message: &'static str,
}

/// The manifest's targets for these settings, in the manifest's order. A target setting that is
/// not set yields nothing; one that holds no usable target yields `Unusable`.
pub fn declared(manifest: &Manifest, settings: &Value) -> Vec<Result<Declared, Unusable>> {
    let mut out = Vec::new();
    for target in &manifest.permissions.network {
        let protocol = if target.protocol.as_deref() == Some("tls") { Protocol::Tls } else { Protocol::Tcp };
        if let Some(host) = &target.host {
            out.push(Ok(Declared { host: host.clone(), port: target.port.unwrap_or(0), protocol, setting: None }));
            continue;
        }
        let Some(setting) = &target.setting else { continue };
        let unusable =
            |reason: &'static str, message: &'static str| Err(Unusable { setting: setting.clone(), reason, message });
        let value = match settings.get(setting) {
            None | Some(Value::Null) => continue,
            Some(Value::String(s)) => s.trim(),
            Some(_) => {
                out.push(unusable("settings.expected_text", "the target setting is not text"));
                continue;
            }
        };
        if value.is_empty() {
            out.push(unusable("settings.host_invalid", "the target setting is empty"));
            continue;
        }
        let declared = match target.form.as_deref() {
            Some("url") => {
                let Ok(url) = url::Url::parse(value) else {
                    out.push(unusable("settings.url_invalid", "the URL cannot be parsed"));
                    continue;
                };
                let Some(host) = url.host_str().map(|h| h.trim_matches(['[', ']']).to_string()) else {
                    out.push(unusable("settings.url_no_host", "the URL has no host"));
                    continue;
                };
                let protocol = if matches!(url.scheme(), "https" | "wss") { Protocol::Tls } else { Protocol::Tcp };
                let port = url.port_or_known_default().unwrap_or(443);
                Declared { host, port, protocol, setting: Some(setting.clone()) }
            }
            _ => {
                let port = target
                    .port_setting
                    .as_ref()
                    .and_then(|p| settings.get(p))
                    .and_then(Value::as_u64)
                    .and_then(|p| u16::try_from(p).ok())
                    .or(target.default_port)
                    .unwrap_or(0);
                Declared { host: value.to_string(), port, protocol, setting: Some(setting.clone()) }
            }
        };
        out.push(Ok(declared));
    }
    out
}

/// A host as compared: without brackets and a trailing dot, in lower case.
fn host_key(host: &str) -> String {
    host.trim().trim_start_matches('[').trim_end_matches(']').trim_end_matches('.').to_ascii_lowercase()
}

/// Whether `host:port` over `protocol` is one of the declared targets.
pub fn is_declared(targets: &[Declared], host: &str, port: u16, protocol: Protocol) -> bool {
    let key = host_key(host);
    port != 0 && targets.iter().any(|t| t.port == port && t.protocol == protocol && host_key(&t.host) == key)
}

/// Kalzit's own addresses: where it listens, and its PostgreSQL database. A plugin never
/// reaches them through the connector, whatever its settings say.
#[derive(Clone, Debug, Default)]
pub struct OwnEndpoints {
    /// Every address Kalzit listens on (HTTP and HTTPS; it opens no other listener).
    listen: Vec<SocketAddr>,
    database: Option<(String, u16)>,
    /// The database's addresses as resolved when Kalzit started.
    database_addrs: Vec<IpAddr>,
}

impl OwnEndpoints {
    /// Resolves the database's host once, at start (blocking, before anything is served).
    pub fn from_config(config: &crate::config::Config) -> Self {
        let listen = [config.http_addr(), config.https_addr()].into_iter().flatten().collect();
        let url = config.database_url();
        let database = if url.starts_with("postgres") {
            url::Url::parse(&url)
                .ok()
                .and_then(|u| Some((u.host_str()?.trim_matches(['[', ']']).to_string(), u.port().unwrap_or(5432))))
        } else {
            None
        };
        Self::new(listen, database)
    }

    pub fn new(listen: Vec<SocketAddr>, database: Option<(String, u16)>) -> Self {
        use std::net::ToSocketAddrs;
        let database_addrs = database
            .as_ref()
            .and_then(|(host, port)| (host.as_str(), *port).to_socket_addrs().ok())
            .map(|addrs| addrs.map(|a| canonical_ip(a.ip())).collect())
            .unwrap_or_default();
        Self { listen, database, database_addrs }
    }

    /// Refuses `addr` when it is one of Kalzit's own: a listening address (on any address of
    /// this machine when Kalzit listens on all), or its database. The database's addresses are
    /// those of the start and of a fresh lookup; when neither yields any, every address with the
    /// database's port is refused.
    pub async fn check(&self, addr: SocketAddr) -> Result<(), Detail> {
        let ip = canonical_ip(addr.ip());
        for own in &self.listen {
            if own.port() == addr.port() && (canonical_ip(own.ip()) == ip || is_local(ip)) {
                return Err(Detail::new("target.own_address", format!("{addr} is one of Kalzit's own addresses"))
                    .with("address", addr));
            }
        }
        if let Some((host, port)) = &self.database
            && *port == addr.port()
        {
            let mut own = self.database_addrs.clone();
            let lookup = tokio::time::timeout(Duration::from_secs(5), tokio::net::lookup_host((host.as_str(), *port)));
            if let Ok(Ok(addrs)) = lookup.await {
                own.extend(addrs.map(|a| canonical_ip(a.ip())));
            }
            let local_database = own.iter().any(|o| is_local(*o));
            if own.is_empty() || own.contains(&ip) || (local_database && is_local(ip)) {
                return Err(Detail::new("target.own_database", "Kalzit's own database cannot be a target")
                    .with("address", addr));
            }
        }
        Ok(())
    }
}

/// An address of this machine: loopback, unspecified, or one a socket can be bound to.
fn is_local(ip: IpAddr) -> bool {
    ip.is_loopback() || ip.is_unspecified() || std::net::UdpSocket::bind(SocketAddr::new(ip, 0)).is_ok()
}

/// Everything the connector of one plugin process needs.
pub struct Context {
    pub plugin: String,
    pub manifest: Arc<Manifest>,
    pub grants: Arc<Grants>,
    pub own: Arc<OwnEndpoints>,
    /// The start's token, which every request carries.
    pub token: String,
    pub logs: Arc<Logs>,
    pub audit: Option<sqlx::AnyPool>,
    pub max_connections: usize,
    pub idle: Duration,
    pub connect_timeout: Duration,
    /// When a refusal was last written to the audit log, by target and reason.
    audited: Mutex<HashMap<String, Instant>>,
}

impl Context {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        plugin: String,
        manifest: Arc<Manifest>,
        grants: Arc<Grants>,
        own: Arc<OwnEndpoints>,
        token: String,
        logs: Arc<Logs>,
        audit: Option<sqlx::AnyPool>,
        limits: (usize, Duration, Duration),
    ) -> Self {
        let (max_connections, idle, connect_timeout) = limits;
        Self {
            plugin,
            manifest,
            grants,
            own,
            token,
            logs,
            audit,
            max_connections,
            idle,
            connect_timeout,
            audited: Mutex::default(),
        }
    }

    /// Checks a request and opens the connection, or says why not (`ErrorKind::Blocked` for a
    /// refusal, `Failed` when the target does not answer).
    async fn open(&self, request: &pb::ConnectRequest) -> Result<(SocketAddr, TcpStream), (pb::ErrorKind, Detail)> {
        let started = Instant::now();
        let blocked = |d: Detail| (pb::ErrorKind::Blocked, d);
        if !same(request.token.as_bytes(), self.token.as_bytes()) {
            return Err(blocked(Detail::new("plugin.token_invalid", "the request carries no valid token")));
        }
        let Some(grant) = self.grants.get(&request.datasource_id) else {
            return Err(blocked(
                Detail::new("plugin.datasource_unknown", "the plugin was not given this data source")
                    .with("datasourceId", &request.datasource_id),
            ));
        };
        let protocol = match pb::TargetProtocol::try_from(request.protocol) {
            Ok(pb::TargetProtocol::Unspecified | pb::TargetProtocol::Tcp) => Protocol::Tcp,
            Ok(pb::TargetProtocol::Tls) => Protocol::Tls,
            Err(_) => return Err(blocked(Detail::new("plugin.protocol_unknown", "the protocol is not tcp or tls"))),
        };
        let port = u16::try_from(request.port).unwrap_or(0);
        let targets: Vec<Declared> = declared(&self.manifest, &grant.settings).into_iter().flatten().collect();
        if !is_declared(&targets, &request.host, port, protocol) {
            return Err(blocked(
                Detail::new(
                    "plugin.target_undeclared",
                    format!(
                        "{}:{} over {} is not a target the manifest declares for this data source",
                        request.host,
                        request.port,
                        protocol.name()
                    ),
                )
                .with("host", &request.host)
                .with("port", request.port),
            ));
        }
        let resolved = tokio::time::timeout(self.connect_timeout, grant.policy.resolve_all(&request.host, port))
            .await
            .map_err(|_| {
                (
                    pb::ErrorKind::Failed,
                    Detail::new("target.unresolvable", format!("{} did not resolve in time", request.host))
                        .with("host", &request.host),
                )
            })?;
        let addrs = resolved.map_err(|e| match e {
            crate::datasources::targets::ResolveError::Blocked(b) => blocked(b.0),
            dns => (pb::ErrorKind::Failed, dns.detail()),
        })?;
        for addr in &addrs {
            self.own.check(*addr).await.map_err(blocked)?;
        }
        // One budget for the whole request, however many addresses the name has.
        let deadline = tokio::time::Instant::from_std(started) + self.connect_timeout;
        let mut last = String::new();
        for addr in addrs {
            match tokio::time::timeout_at(deadline, TcpStream::connect(addr)).await {
                Ok(Ok(stream)) => {
                    let _ = stream.set_nodelay(true);
                    return Ok((addr, stream));
                }
                Ok(Err(e)) => last = format!("{addr}: {e}"),
                Err(_) => {
                    last = format!("{addr}: no answer within {} seconds", self.connect_timeout.as_secs());
                    break;
                }
            }
        }
        Err((
            pb::ErrorKind::Failed,
            Detail::new("target.unreachable", format!("cannot reach {}: {last}", request.host))
                .with("host", &request.host)
                .with("detail", last),
        ))
    }

    /// A refused connect: in the plugin's log and Kalzit's, and in the audit log (bounded).
    fn refused(&self, request: &pb::ConnectRequest, detail: &Detail) {
        let text = format!(
            "connect to {}:{} for data source {} refused ({}): {}",
            request.host, request.port, request.datasource_id, detail.reason, detail.message
        );
        tracing::warn!(plugin = %self.plugin, reason = detail.reason, "{text}");
        self.logs.push(&self.plugin, "host", text);
        let key = format!("{}\n{}\n{}", detail.reason, request.host, request.port);
        {
            let mut audited = self.audited.lock().unwrap_or_else(|e| e.into_inner());
            let now = Instant::now();
            if audited.get(&key).is_some_and(|at| now.duration_since(*at) < AUDIT_EVERY) {
                return;
            }
            if audited.len() > 1000 {
                audited.retain(|_, at| now.duration_since(*at) < AUDIT_EVERY);
            }
            audited.insert(key, now);
        }
        let Some(pool) = self.audit.clone() else { return };
        let plugin = self.plugin.clone();
        let summary = json!({
            "datasourceId": request.datasource_id,
            "host": request.host,
            "port": request.port,
            "reason": detail.reason,
        });
        tokio::spawn(async move {
            let at_ms =
                std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64);
            let event = crate::audit::AuditEvent {
                org_id: None,
                actor_user_id: None,
                actor_address: None,
                action: "plugins.connect_refused",
                resource_type: Some("plugin"),
                resource_id: Some(&plugin),
                summary,
                at_ms,
            };
            let written = match pool.acquire().await {
                Ok(mut conn) => crate::audit::record(&mut conn, &event).await,
                Err(e) => Err(e),
            };
            if let Err(e) = written {
                tracing::error!(plugin = %plugin, "the refused connect could not be written to the audit log: {e}");
            }
        });
    }
}

/// Compares in time independent of where the bytes differ.
fn same(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn error_frame(request_id: u64, kind: pb::ErrorKind, detail: &Detail) -> Vec<u8> {
    frame(&pb::ConnectResponse {
        result: Some(pb::connect_response::Result::Error(pb::Error {
            kind: kind as i32,
            detail: Some(pb::Detail {
                reason: detail.reason.to_string(),
                params: detail.params.clone(),
                message: detail.message.clone(),
            }),
        })),
        request_id,
    })
}

fn connected_frame(request_id: u64, addr: SocketAddr) -> Vec<u8> {
    frame(&pb::ConnectResponse {
        result: Some(pb::connect_response::Result::Connected(pb::Connected { address: addr.to_string() })),
        request_id,
    })
}

/// Reads one request, within `REQUEST_TIMEOUT`.
#[cfg(windows)]
async fn read_request(stream: &mut (impl AsyncRead + Unpin)) -> std::io::Result<pb::ConnectRequest> {
    let read = async {
        let mut prefix = [0u8; 4];
        stream.read_exact(&mut prefix).await?;
        let len = frame_len(prefix)
            .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidData, "the request is too large"))?;
        let mut body = vec![0u8; len];
        stream.read_exact(&mut body).await?;
        pb::ConnectRequest::decode(body.as_slice())
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e.to_string()))
    };
    tokio::time::timeout(REQUEST_TIMEOUT, read)
        .await
        .unwrap_or_else(|_| Err(std::io::Error::new(std::io::ErrorKind::TimedOut, "no request in time")))
}

/// Answers a refusal and records it.
#[cfg(windows)]
async fn refuse(
    ctx: &Context,
    stream: &mut (impl AsyncWrite + Unpin),
    request: &pb::ConnectRequest,
    kind: pb::ErrorKind,
    detail: Detail,
) {
    if kind == pb::ErrorKind::Blocked {
        ctx.refused(request, &detail);
    }
    let _ = stream.write_all(&error_frame(request.request_id, kind, &detail)).await;
    let _ = stream.flush().await;
}

fn exhausted(max: usize) -> Detail {
    Detail::new("plugin.connections_exhausted", format!("the plugin holds {max} connections already")).with("max", max)
}

/// Waits until the process has ended.
async fn ended(exited: &mut watch::Receiver<Option<String>>) {
    loop {
        if exited.borrow_and_update().is_some() {
            return;
        }
        if exited.changed().await.is_err() {
            return;
        }
    }
}

#[cfg(target_os = "linux")]
pub use linux::{Listener, listen, serve};
#[cfg(windows)]
pub use windows::{Listener, listen, serve};

/// Plugins run on Windows and Linux only.
#[cfg(not(any(windows, target_os = "linux")))]
pub struct Listener;

#[cfg(not(any(windows, target_os = "linux")))]
impl Listener {
    #[cfg(unix)]
    pub fn take_plugin_end(&mut self) -> Option<std::os::fd::OwnedFd> {
        None
    }
}

#[cfg(not(any(windows, target_os = "linux")))]
pub fn listen(_: &std::path::Path, _: &str, _: &str, _: &str) -> std::io::Result<(Listener, String)> {
    Err(std::io::Error::new(std::io::ErrorKind::Unsupported, "plugins run on Windows and Linux only"))
}

#[cfg(not(any(windows, target_os = "linux")))]
pub fn serve(_: Listener, _: Arc<Context>, _: u32, _: watch::Receiver<Option<String>>) {}

#[cfg(target_os = "linux")]
mod linux {
    use std::collections::HashSet;
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::{Duration, Instant};

    use prost::Message;
    use tokio::io::unix::AsyncFd;
    use tokio::sync::{Semaphore, watch};

    use super::{Context, MAX_PENDING, connected_frame, ended, error_frame, exhausted};
    use kalzit_plugin_api::connector::frame_body;
    use kalzit_plugin_api::datasource::v1 as pb;

    /// A handed-over socket that is not in a descriptor table yet counts this long at most,
    /// unless it still waits in the plugin's queue.
    const IN_FLIGHT: Duration = Duration::from_secs(10);

    /// The connector's socket pair: Kalzit's end, and the plugin's until it is handed over as
    /// descriptor 4 (`process::CONNECTOR_FD`). A pair reaches nobody else, and the plugin needs
    /// no socket of its own to use it.
    pub struct Listener {
        ours: OwnedFd,
        theirs: Option<OwnedFd>,
    }

    impl Listener {
        pub fn take_plugin_end(&mut self) -> Option<OwnedFd> {
            self.theirs.take()
        }
    }

    pub fn listen(
        _run_dir: &std::path::Path,
        _random: &str,
        _start_sid: &str,
        _container_sid: &str,
    ) -> std::io::Result<(Listener, String)> {
        let mut fds = [0 as RawFd; 2];
        // SAFETY: `fds` has room for both ends; both are owned below.
        let made = unsafe {
            libc::socketpair(
                libc::AF_UNIX,
                libc::SOCK_SEQPACKET | libc::SOCK_CLOEXEC | libc::SOCK_NONBLOCK,
                0,
                fds.as_mut_ptr(),
            )
        };
        if made != 0 {
            return Err(std::io::Error::last_os_error());
        }
        // SAFETY: both ends were just made and are owned here.
        let (ours, theirs) = unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) };
        // The plugin's end blocks like any inherited descriptor; its client sets what it needs.
        // SAFETY: plain flag changes on an owned descriptor.
        unsafe {
            let flags = libc::fcntl(theirs.as_raw_fd(), libc::F_GETFL);
            libc::fcntl(theirs.as_raw_fd(), libc::F_SETFL, flags & !libc::O_NONBLOCK);
        }
        Ok((Listener { ours, theirs: Some(theirs) }, format!("fd:{}", super::super::process::CONNECTOR_FD)))
    }

    /// A socket handed to the plugin.
    struct Passed {
        inode: u64,
        at: Instant,
        /// Seen in a descriptor table of the plugin, or received for sure: from then on its
        /// absence means it is closed.
        seen: bool,
    }

    /// The sockets handed to one process, and connects under way.
    #[derive(Default)]
    struct Slots {
        passed: Vec<Passed>,
        pending: usize,
    }

    /// Why the plugin's connections cannot be counted.
    const UNCOUNTABLE: &str = "a process of the plugin hides its descriptors (not dumpable), so its connections cannot be counted; new connections are refused";

    struct Process {
        /// The plugin's process id, which is also its session: every process it starts stays
        /// in that session (`setsid` and `setpgid` are refused in the sandbox).
        pid: u32,
        socket: AsyncFd<OwnedFd>,
        slots: std::sync::Mutex<Slots>,
        warned: AtomicBool,
    }

    /// The processes of the session `session`.
    fn session(session: u32) -> Vec<u32> {
        let Ok(dir) = std::fs::read_dir("/proc") else { return vec![session] };
        let mut out = Vec::new();
        for entry in dir.flatten() {
            let Ok(pid) = entry.file_name().to_string_lossy().parse::<u32>() else { continue };
            let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else { continue };
            // After the name in parentheses: state, ppid, pgrp, session.
            let Some(rest) = stat.rsplit_once(')').map(|(_, r)| r) else { continue };
            if rest.split_whitespace().nth(3).and_then(|s| s.parse::<u32>().ok()) == Some(session) {
                out.push(pid);
            }
        }
        if !out.contains(&session) {
            out.push(session);
        }
        out
    }

    impl Process {
        /// Every socket of every process of the plugin, by (process, descriptor, inode); `None`
        /// when a descriptor table cannot be read.
        fn sockets(&self) -> Option<Vec<(u32, RawFd, u64)>> {
            let mut out = Vec::new();
            for pid in session(self.pid) {
                let dir = match std::fs::read_dir(format!("/proc/{pid}/fd")) {
                    Ok(dir) => dir,
                    // Ended in the meantime.
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                    Err(_) => return None,
                };
                for entry in dir.flatten() {
                    let Ok(fd) = entry.file_name().to_string_lossy().parse::<RawFd>() else { continue };
                    let Ok(link) = std::fs::read_link(entry.path()) else { continue };
                    let link = link.to_string_lossy();
                    if let Some(inode) = link.strip_prefix("socket:[").and_then(|s| s.strip_suffix(']'))
                        && let Ok(inode) = inode.parse()
                    {
                        out.push((pid, fd, inode));
                    }
                }
            }
            Some(out)
        }

        fn warn_once(&self, ctx: &Context, text: &str) {
            if !self.warned.swap(true, Ordering::SeqCst) {
                tracing::warn!(plugin = %ctx.plugin, "{text}");
                ctx.logs.push(&ctx.plugin, "host", text.to_string());
            }
        }

        /// Bytes Kalzit sent that the plugin has not read yet (`SIOCOUTQ`).
        fn unread(&self) -> usize {
            let mut n: libc::c_int = 0;
            // SAFETY: an ioctl that writes one int.
            let r = unsafe { libc::ioctl(self.socket.get_ref().as_raw_fd(), libc::TIOCOUTQ, &raw mut n) };
            if r == 0 { usize::try_from(n).unwrap_or(0) } else { 1 }
        }

        /// Forgets sockets the plugin no longer holds and reserves a slot, or says why not.
        fn reserve(&self, ctx: &Context) -> Result<(), super::Detail> {
            let Some(live) = self.sockets() else {
                self.warn_once(ctx, UNCOUNTABLE);
                return Err(super::Detail::new("plugin.connections_uncountable", UNCOUNTABLE));
            };
            let unread = self.unread();
            let live: HashSet<u64> = live.into_iter().map(|(_, _, inode)| inode).collect();
            let mut slots = self.slots.lock().unwrap_or_else(|e| e.into_inner());
            let now = Instant::now();
            slots.passed.retain_mut(|p| {
                if live.contains(&p.inode) {
                    p.seen = true;
                    true
                } else {
                    // Not in a table: closed, unless it still waits in the plugin's queue.
                    !p.seen && unread > 0 && now.duration_since(p.at) < IN_FLIGHT
                }
            });
            if slots.passed.len() + slots.pending >= ctx.max_connections {
                return Err(exhausted(ctx.max_connections));
            }
            slots.pending += 1;
            Ok(())
        }

        fn release(&self, inode: Option<u64>) {
            let mut slots = self.slots.lock().unwrap_or_else(|e| e.into_inner());
            slots.pending = slots.pending.saturating_sub(1);
            if let Some(inode) = inode {
                slots.passed.push(Passed { inode, at: Instant::now(), seen: false });
            }
        }

        /// Closes the handed-over sockets that saw no data for `ctx.idle`, in whichever process
        /// of the plugin holds them, through a copy taken with `pidfd_getfd`; `shutdown` ends
        /// the connection for every holder.
        fn sweep(&self, ctx: &Context) {
            let Some(live) = self.sockets() else {
                self.warn_once(ctx, UNCOUNTABLE);
                return;
            };
            let passed: HashSet<u64> =
                self.slots.lock().unwrap_or_else(|e| e.into_inner()).passed.iter().map(|p| p.inode).collect();
            let mut closed = HashSet::new();
            for (pid, fd, inode) in live.into_iter().filter(|(_, _, i)| passed.contains(i)) {
                if closed.contains(&inode) {
                    continue;
                }
                // SAFETY: a descriptor of the plugin's process, owned below.
                let pidfd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid as libc::pid_t, 0) };
                if pidfd < 0 {
                    continue;
                }
                // SAFETY: just opened, owned here.
                let pidfd = unsafe { OwnedFd::from_raw_fd(pidfd as RawFd) };
                // SAFETY: a copy of the process's descriptor into this process, owned below.
                let copy = unsafe { libc::syscall(libc::SYS_pidfd_getfd, pidfd.as_raw_fd(), fd, 0) };
                if copy < 0 {
                    let e = std::io::Error::last_os_error();
                    self.warn_once(ctx, &format!("idle connections of the plugin cannot be closed: {e}"));
                    return;
                }
                // SAFETY: just received, owned here.
                let copy = unsafe { OwnedFd::from_raw_fd(copy as RawFd) };
                // SAFETY: plain queries on the copy into stack buffers of their size.
                unsafe {
                    let mut stat: libc::stat = std::mem::zeroed();
                    if libc::fstat(copy.as_raw_fd(), &raw mut stat) != 0 || stat.st_ino != inode {
                        continue;
                    }
                    let mut info: libc::tcp_info = std::mem::zeroed();
                    let mut len = std::mem::size_of::<libc::tcp_info>() as libc::socklen_t;
                    if libc::getsockopt(
                        copy.as_raw_fd(),
                        libc::IPPROTO_TCP,
                        libc::TCP_INFO,
                        (&raw mut info).cast(),
                        &raw mut len,
                    ) != 0
                    {
                        continue;
                    }
                    let quiet =
                        Duration::from_millis(u64::from(info.tcpi_last_data_recv.min(info.tcpi_last_data_sent)));
                    if quiet >= ctx.idle {
                        libc::shutdown(copy.as_raw_fd(), libc::SHUT_RDWR);
                        closed.insert(inode);
                        ctx.logs.push(
                            &ctx.plugin,
                            "host",
                            format!("a connection was closed after {} seconds without traffic", quiet.as_secs()),
                        );
                    }
                }
            }
        }

        /// Sends one answer, with `fd` attached when given.
        async fn send(&self, bytes: &[u8], fd: Option<RawFd>) -> std::io::Result<()> {
            loop {
                let mut guard = self.socket.writable().await?;
                match guard.try_io(|inner| send_message(inner.as_raw_fd(), bytes, fd)) {
                    Ok(result) => return result,
                    Err(_would_block) => continue,
                }
            }
        }
    }

    /// One message, with `fd` attached when given.
    fn send_message(socket: RawFd, bytes: &[u8], fd: Option<RawFd>) -> std::io::Result<()> {
        let mut control = [0u64; 4];
        let mut iov = libc::iovec { iov_base: bytes.as_ptr().cast_mut().cast(), iov_len: bytes.len() };
        // SAFETY: a zeroed msghdr is valid; the buffers outlive the call; the control message is
        // built within `control` by the kernel's own macros.
        unsafe {
            let mut msg: libc::msghdr = std::mem::zeroed();
            msg.msg_iov = &raw mut iov;
            msg.msg_iovlen = 1;
            if let Some(fd) = fd {
                msg.msg_control = control.as_mut_ptr().cast();
                msg.msg_controllen = libc::CMSG_SPACE(std::mem::size_of::<RawFd>() as u32) as _;
                let cmsg = libc::CMSG_FIRSTHDR(&raw const msg);
                (*cmsg).cmsg_level = libc::SOL_SOCKET;
                (*cmsg).cmsg_type = libc::SCM_RIGHTS;
                (*cmsg).cmsg_len = libc::CMSG_LEN(std::mem::size_of::<RawFd>() as u32) as _;
                libc::CMSG_DATA(cmsg).cast::<RawFd>().write_unaligned(fd);
            }
            if libc::sendmsg(socket, &raw const msg, libc::MSG_NOSIGNAL) < 0 {
                Err(std::io::Error::last_os_error())
            } else {
                Ok(())
            }
        }
    }

    /// One request: checked, connected, answered.
    async fn handle(ctx: Arc<Context>, process: Arc<Process>, request: pb::ConnectRequest) {
        let id = request.request_id;
        if let Err(detail) = process.reserve(&ctx) {
            ctx.refused(&request, &detail);
            let _ = process.send(&error_frame(id, pb::ErrorKind::Blocked, &detail), None).await;
            return;
        }
        let (addr, tcp) = match ctx.open(&request).await {
            Ok(opened) => opened,
            Err((kind, detail)) => {
                process.release(None);
                if kind == pb::ErrorKind::Blocked {
                    ctx.refused(&request, &detail);
                }
                let _ = process.send(&error_frame(id, kind, &detail), None).await;
                return;
            }
        };
        let Ok(tcp) = tcp.into_std() else {
            process.release(None);
            return;
        };
        // SAFETY: fstat into a stack buffer of its size.
        let inode = unsafe {
            let mut stat: libc::stat = std::mem::zeroed();
            (libc::fstat(tcp.as_raw_fd(), &raw mut stat) == 0).then_some(stat.st_ino)
        };
        let sent = process.send(&connected_frame(id, addr), Some(tcp.as_raw_fd())).await;
        // Kalzit's copy goes; the plugin holds the only one.
        drop(tcp);
        process.release(if sent.is_ok() { inode } else { None });
    }

    /// Serves the plugin process `pid` until it ends or closes its end of the pair.
    pub fn serve(listener: Listener, ctx: Arc<Context>, pid: u32, mut exited: watch::Receiver<Option<String>>) {
        // SAFETY: an `OwnedFd` keeps its one open descriptor until the `AsyncFd` drops it.
        let socket = match unsafe { AsyncFd::register(listener.ours) }.map_err(std::io::Error::from) {
            Ok(socket) => socket,
            Err(e) => {
                tracing::error!(plugin = %ctx.plugin, "the network connector cannot be served: {e}");
                return;
            }
        };
        let process =
            Arc::new(Process { pid, socket, slots: std::sync::Mutex::default(), warned: AtomicBool::new(false) });
        let pending = Arc::new(Semaphore::new(MAX_PENDING));
        tokio::spawn(async move {
            let every = (ctx.idle / 4).clamp(Duration::from_millis(500), Duration::from_secs(30));
            let mut sweep = tokio::time::interval(every);
            sweep.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            let mut buf = vec![0u8; kalzit_plugin_api::connector::MAX_MESSAGE_BYTES + 4];
            loop {
                tokio::select! {
                    () = ended(&mut exited) => break,
                    _ = sweep.tick() => process.sweep(&ctx),
                    readable = process.socket.readable() => {
                        let Ok(mut guard) = readable else { break };
                        // SAFETY: one message into a buffer of its size; nothing is passed to Kalzit.
                        let read = guard.try_io(|inner| {
                            let n = unsafe { libc::recv(inner.as_raw_fd(), buf.as_mut_ptr().cast(), buf.len(), 0) };
                            if n < 0 { Err(std::io::Error::last_os_error()) } else { Ok(n as usize) }
                        });
                        let n = match read {
                            Err(_would_block) => continue,
                            Ok(Ok(0)) | Ok(Err(_)) => break,
                            Ok(Ok(n)) => n,
                        };
                        let Some(request) = frame_body(&buf[..n]).and_then(|b| pb::ConnectRequest::decode(b).ok()) else {
                            tracing::warn!(plugin = %ctx.plugin, "the plugin sent the connector a message that is not a request");
                            continue;
                        };
                        match pending.clone().try_acquire_owned() {
                            Ok(permit) => {
                                let (ctx, process) = (ctx.clone(), process.clone());
                                tokio::spawn(async move {
                                    handle(ctx, process, request).await;
                                    drop(permit);
                                });
                            }
                            Err(_) => {
                                let detail = super::Detail::new(
                                    "plugin.connector_busy",
                                    format!("the plugin has {MAX_PENDING} connection requests under way already"),
                                )
                                .with("max", MAX_PENDING);
                                ctx.refused(&request, &detail);
                                let _ = process.send(&error_frame(request.request_id, pb::ErrorKind::Blocked, &detail), None).await;
                            }
                        }
                    }
                }
            }
        });
    }
}

#[cfg(windows)]
mod windows {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{Duration, Instant};

    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpStream;
    use tokio::net::windows::named_pipe::NamedPipeServer;
    use tokio::sync::{OwnedSemaphorePermit, Semaphore, watch};

    use super::super::process::windows_pipe::{client_pid, create, sddl};
    use super::{Context, MAX_PENDING, connected_frame, ended, exhausted, read_request, refuse};
    use kalzit_plugin_api::datasource::v1 as pb;

    pub struct Listener {
        first: NamedPipeServer,
        address: String,
        sddl: String,
    }

    /// The connector's pipe, for Kalzit's account, the start and the plugin's AppContainer; its
    /// first instance is created before the plugin starts (nobody else can own the name).
    pub fn listen(
        _run_dir: &std::path::Path,
        random: &str,
        start_sid: &str,
        container_sid: &str,
    ) -> std::io::Result<(Listener, String)> {
        let sddl = sddl(start_sid, container_sid)?;
        let address = format!(r"\\.\pipe\kalzit-connector-{random}");
        let first = create(&address, &sddl, true)?;
        Ok((Listener { first, address: address.clone(), sddl }, address))
    }

    /// Relays between the pipe and the connection until either side ends it or nothing passes
    /// for `idle`; the end of the TCP connection ends the pipe.
    async fn relay(ctx: &Context, pipe: NamedPipeServer, tcp: TcpStream) {
        let start = Instant::now();
        let last = AtomicU64::new(0);
        let touch = || last.store(start.elapsed().as_millis() as u64, Ordering::Relaxed);
        let (mut pipe_read, mut pipe_write) = tokio::io::split(pipe);
        let (mut tcp_read, mut tcp_write) = tcp.into_split();
        let up = async {
            let mut buf = vec![0u8; 16 * 1024];
            loop {
                match pipe_read.read(&mut buf).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if tcp_write.write_all(&buf[..n]).await.is_err() {
                            break;
                        }
                        touch();
                    }
                }
            }
            let _ = tcp_write.shutdown().await;
        };
        let down = async {
            let mut buf = vec![0u8; 16 * 1024];
            loop {
                match tcp_read.read(&mut buf).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if pipe_write.write_all(&buf[..n]).await.is_err() {
                            break;
                        }
                        touch();
                    }
                }
            }
        };
        let quiet = async {
            let every = (ctx.idle / 4).clamp(Duration::from_millis(250), Duration::from_secs(30));
            loop {
                tokio::time::sleep(every).await;
                let since = start.elapsed().saturating_sub(Duration::from_millis(last.load(Ordering::Relaxed)));
                if since >= ctx.idle {
                    ctx.logs.push(
                        &ctx.plugin,
                        "host",
                        format!("a connection was closed after {} seconds without traffic", since.as_secs()),
                    );
                    return;
                }
            }
        };
        tokio::pin!(up, down, quiet);
        let mut up_done = false;
        loop {
            tokio::select! {
                () = &mut up, if !up_done => up_done = true,
                () = &mut down => break,
                () = &mut quiet => break,
            }
        }
    }

    async fn handle(
        ctx: Arc<Context>,
        slots: Arc<Semaphore>,
        mut pipe: NamedPipeServer,
        pending: OwnedSemaphorePermit,
    ) {
        let read = read_request(&mut pipe).await;
        drop(pending);
        let Ok(request) = read else { return };
        let Ok(permit) = slots.try_acquire_owned() else {
            let detail = exhausted(ctx.max_connections);
            refuse(&ctx, &mut pipe, &request, pb::ErrorKind::Blocked, detail).await;
            return;
        };
        let (addr, tcp) = match ctx.open(&request).await {
            Ok(opened) => opened,
            Err((kind, detail)) => {
                refuse(&ctx, &mut pipe, &request, kind, detail).await;
                return;
            }
        };
        if pipe.write_all(&connected_frame(request.request_id, addr)).await.is_err() {
            return;
        }
        relay(&ctx, pipe, tcp).await;
        drop(permit);
    }

    /// Serves the plugin process `pid` until it ends: only its pipe connections are answered.
    pub fn serve(listener: Listener, ctx: Arc<Context>, pid: u32, mut exited: watch::Receiver<Option<String>>) {
        let slots = Arc::new(Semaphore::new(ctx.max_connections));
        // Pipe connections whose request is not read yet: each holds a buffer until it is.
        let pending = Arc::new(Semaphore::new(MAX_PENDING));
        tokio::spawn(async move {
            let Listener { first, address, sddl } = listener;
            let mut server = first;
            loop {
                tokio::select! {
                    () = ended(&mut exited) => break,
                    connected = server.connect() => {
                        if connected.is_err() || client_pid(&server) != Some(pid) {
                            if connected.is_ok() {
                                tracing::warn!(plugin = %ctx.plugin, "a connection to the connector from another process was refused");
                            }
                            match create(&address, &sddl, false) {
                                Ok(next) => server = next,
                                Err(e) => {
                                    tracing::error!(plugin = %ctx.plugin, "the connector's next pipe instance cannot be created: {e}");
                                    break;
                                }
                            }
                            continue;
                        }
                        let next = match create(&address, &sddl, false) {
                            Ok(next) => next,
                            Err(e) => {
                                tracing::error!(plugin = %ctx.plugin, "the connector's next pipe instance cannot be created: {e}");
                                break;
                            }
                        };
                        let current = std::mem::replace(&mut server, next);
                        let Ok(permit) = pending.clone().try_acquire_owned() else {
                            tracing::warn!(plugin = %ctx.plugin, "too many connector requests under way; one was closed");
                            continue;
                        };
                        tokio::spawn(handle(ctx.clone(), slots.clone(), current, permit));
                    }
                }
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::datasources::targets::test_hosts;

    fn manifest(extra: &str) -> Manifest {
        kalzit_plugin_api::manifest::parse(&format!(
            "manifest = 1\nid = \"dev.example.t\"\nname = \"T\"\nversion = \"1.0.0\"\nkind = \"datasource\"\n\
             min_kalzit = \"0.1.0\"\nshapes = [\"frame\"]\nprotocol = 1\n\n\
             [[settings]]\nname = \"host\"\nlabel = {{ en = \"Host\" }}\ntype = \"string\"\ntarget = true\n\n\
             [[settings]]\nname = \"port\"\nlabel = {{ en = \"Port\" }}\ntype = \"number\"\ntarget = true\n\n\
             [[settings]]\nname = \"url\"\nlabel = {{ en = \"URL\" }}\ntype = \"string\"\ntarget = true\n\n\
             {extra}\n[binaries]\nlinux-x64 = \"p\"\n\n[files]\n\"p\" = \"3f1a2b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708\"\n"
        ))
        .unwrap()
    }

    const TARGETS: &str = "[[permissions.network]]\nsetting = \"host\"\nform = \"host\"\nport_setting = \"port\"\n\
         default_port = 6379\nprotocol = \"tls\"\n\n[[permissions.network]]\nsetting = \"url\"\nform = \"url\"\n\n\
         [[permissions.network]]\nhost = \"api.example.com\"\nport = 443\nprotocol = \"tls\"\n";

    #[test]
    fn targets_come_from_the_current_settings() {
        let m = manifest(TARGETS);
        let settings = json!({ "host": "DB.example.test.", "url": "http://[::1]:8080/x" });
        let targets: Vec<Declared> = declared(&m, &settings).into_iter().flatten().collect();
        assert_eq!(targets.len(), 3, "{targets:?}");
        assert!(is_declared(&targets, "db.example.test", 6379, Protocol::Tls));
        assert!(!is_declared(&targets, "db.example.test", 6379, Protocol::Tcp), "the protocol counts");
        assert!(!is_declared(&targets, "db.example.test", 6380, Protocol::Tls), "the port counts");
        assert!(!is_declared(&targets, "other.example.test", 6379, Protocol::Tls));
        assert!(is_declared(&targets, "[::1]", 8080, Protocol::Tcp));
        assert!(is_declared(&targets, "api.example.com", 443, Protocol::Tls));

        let settings = json!({ "host": "db", "port": 7000, "url": "https://search.example.test" });
        let targets: Vec<Declared> = declared(&m, &settings).into_iter().flatten().collect();
        assert!(is_declared(&targets, "db", 7000, Protocol::Tls));
        assert!(!is_declared(&targets, "db", 6379, Protocol::Tls), "the port setting wins over the default");
        assert!(is_declared(&targets, "search.example.test", 443, Protocol::Tls), "https is TLS on 443");

        let bad = declared(&m, &json!({ "host": "  ", "url": "kein url" }));
        let reasons: Vec<&str> = bad.iter().filter_map(|r| r.as_ref().err()).map(|u| u.reason).collect();
        assert_eq!(reasons, ["settings.host_invalid", "settings.url_invalid"]);
    }

    fn context(own: OwnEndpoints) -> (Context, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let grants = Arc::new(Grants::default());
        let policy = Arc::new(TargetPolicy::new(&dir.path().join("data"), "sqlite::memory:", &[], &[]));
        let settings = json!({ "host": "127.0.0.1", "port": 1, "url": "http://rebound.example.test:8080" });
        grants.by_source.lock().unwrap().insert("ds".into(), Grant { settings, policy });
        let ctx = Context::new(
            "dev.example.t".into(),
            Arc::new(manifest(TARGETS)),
            grants,
            Arc::new(own),
            "token".into(),
            Arc::default(),
            None,
            (4, Duration::from_secs(60), Duration::from_secs(2)),
        );
        (ctx, dir)
    }

    fn request(host: &str, port: u32, protocol: pb::TargetProtocol) -> pb::ConnectRequest {
        pb::ConnectRequest {
            token: "token".into(),
            datasource_id: "ds".into(),
            host: host.into(),
            port,
            protocol: protocol as i32,
            request_id: 1,
        }
    }

    async fn reason(ctx: &Context, r: pb::ConnectRequest) -> &'static str {
        match ctx.open(&r).await {
            Ok(_) => "connected",
            Err((_, d)) => d.reason,
        }
    }

    #[tokio::test]
    async fn connects_are_checked_before_anything_is_reached() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (ctx, _dir) = context(OwnEndpoints::new(vec!["0.0.0.0:3999".parse().unwrap()], None));
        // The settings name port 1; this test's listener is on another port, so a declared
        // target with the listener's port is set up through the grant.
        ctx.grants.by_source.lock().unwrap().get_mut("ds").unwrap().settings["port"] = json!(port);
        assert_eq!(reason(&ctx, request("127.0.0.1", port.into(), pb::TargetProtocol::Tls)).await, "connected");

        let mut wrong = request("127.0.0.1", port.into(), pb::TargetProtocol::Tls);
        wrong.token = "tokem".into();
        assert_eq!(reason(&ctx, wrong).await, "plugin.token_invalid");
        let mut unknown = request("127.0.0.1", port.into(), pb::TargetProtocol::Tls);
        unknown.datasource_id = "other".into();
        assert_eq!(reason(&ctx, unknown).await, "plugin.datasource_unknown");
        // A changed or deleted data source is taken back.
        let saved = ctx.grants.get("ds").unwrap();
        ctx.grants.revoke("ds");
        assert_eq!(
            reason(&ctx, request("127.0.0.1", port.into(), pb::TargetProtocol::Tls)).await,
            "plugin.datasource_unknown"
        );
        ctx.grants.by_source.lock().unwrap().insert("ds".into(), saved);
        assert_eq!(
            reason(&ctx, request("127.0.0.1", u32::from(port) + 1, pb::TargetProtocol::Tls)).await,
            "plugin.target_undeclared"
        );
        assert_eq!(
            reason(&ctx, request("127.0.0.1", port.into(), pb::TargetProtocol::Tcp)).await,
            "plugin.target_undeclared"
        );
        assert_eq!(
            reason(&ctx, request("127.0.0.1", 70_000, pb::TargetProtocol::Tls)).await,
            "plugin.target_undeclared"
        );

        // A name that resolves to a metadata address when the plugin connects (DNS rebinding
        // after the check of the settings) is refused, whatever the manifest says.
        test_hosts::pin("rebound.example.test", &["169.254.169.254".parse().unwrap()]);
        assert_eq!(
            reason(&ctx, request("rebound.example.test", 8080, pb::TargetProtocol::Tcp)).await,
            "target.metadata_address"
        );

        // Kalzit's own port on this machine.
        ctx.grants.by_source.lock().unwrap().get_mut("ds").unwrap().settings["port"] = json!(3999);
        assert_eq!(reason(&ctx, request("127.0.0.1", 3999, pb::TargetProtocol::Tls)).await, "target.own_address");
        drop(listener);
    }

    #[tokio::test]
    async fn kalzits_own_addresses_and_database_are_refused() {
        let own = OwnEndpoints::new(
            vec!["127.0.0.1:3000".parse().unwrap(), "0.0.0.0:3443".parse().unwrap()],
            Some(("localhost".into(), 5432)),
        );
        for bad in ["127.0.0.1:3000", "127.0.0.1:3443", "[::1]:3443", "[::ffff:127.0.0.1]:3443", "127.0.0.1:5432"] {
            assert!(own.check(bad.parse().unwrap()).await.is_err(), "{bad}");
        }
        for good in ["127.0.0.1:3001", "192.0.2.10:3443", "192.0.2.10:5432"] {
            assert!(own.check(good.parse().unwrap()).await.is_ok(), "{good}");
        }
        // A database whose name resolves neither at start nor now: its port is refused anywhere.
        let unknown = OwnEndpoints::new(Vec::new(), Some(("kalzit-db.invalid".into(), 5432)));
        assert!(unknown.check("192.0.2.10:5432".parse().unwrap()).await.is_err());
        assert!(unknown.check("192.0.2.10:5433".parse().unwrap()).await.is_ok());
        let config = crate::config::Config::from_sources(
            "[server]\nhttp_addr = \"127.0.0.1:4000\"\n[database]\nurl = \"postgres://k:p@db.internal:6543/kalzit\"\n",
            Vec::new(),
        )
        .unwrap();
        let own = OwnEndpoints::from_config(&config);
        assert_eq!(own.listen, vec!["127.0.0.1:4000".parse::<SocketAddr>().unwrap()]);
        assert_eq!(own.database, Some(("db.internal".to_string(), 6543)));
    }
}
