//! One plugin process over its life: started on demand, handshake on stdio, `Describe` checked
//! against the manifest, probed for health, restarted with backoff after a crash, killed on
//! stop, its output kept with size limits (docs/ARCHITECTURE.md, "Process model and
//! transport").
//!
//! Restarts: after the n-th failure in a row (a crash, a failed start, a process that stops
//! answering the health probe) the plugin waits `backoff[n - 1]` (10 s, 30 s, 1, 2, 5 and
//! 10 minutes) and starts again with the next call; after the last wait it stays stopped until
//! an administrator restarts it. A process that ran `stable_after` (10 minutes) before it failed
//! starts the count afresh. A crashed or hanging plugin fails only the calls of its own kind.

use std::collections::{BTreeSet, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use kalzit_plugin_api::datasource::v1 as pb;
use kalzit_plugin_api::datasource::v1::data_source_client::DataSourceClient;
use kalzit_plugin_api::manifest::Manifest;
use serde::Serialize;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::sync::{oneshot, watch};
use tonic::service::interceptor::InterceptedService;
use tonic::transport::Channel;

use super::HostError;
use super::connector::{self, Grants, OwnEndpoints};
use super::package::{PluginAccess, private_dir};
use super::process::{self, Control, Limits};

/// The token every call carries (`kalzit-plugin-token`).
#[derive(Clone)]
pub struct Token(tonic::metadata::MetadataValue<tonic::metadata::Ascii>);

impl tonic::service::Interceptor for Token {
    fn call(&mut self, mut request: tonic::Request<()>) -> Result<tonic::Request<()>, tonic::Status> {
        request.metadata_mut().insert("kalzit-plugin-token", self.0.clone());
        Ok(request)
    }
}

/// A client of one running plugin process.
pub type Client = DataSourceClient<InterceptedService<Channel, Token>>;

/// How the supervisor behaves; tests shorten the times.
#[derive(Clone, Debug)]
pub struct Options {
    /// From the start of the process until it said ready and answered `Describe`.
    pub start_timeout: Duration,
    /// The waits before the next start after the 1st, 2nd, ... failure in a row; after the last
    /// one the plugin stays stopped.
    pub backoff: Vec<Duration>,
    /// A process that ran this long before it failed starts the count of failures afresh.
    pub stable_after: Duration,
    /// How often a running plugin is asked `Describe`; two failed probes in a row kill it.
    pub probe_interval: Duration,
    pub probe_timeout: Duration,
    pub limits: Limits,
    /// Network connections through the connector a plugin may hold at once.
    pub max_connections: usize,
    /// A connection without traffic for this long is closed.
    pub connection_idle: Duration,
    /// How long the connector tries to reach a target.
    pub connect_timeout: Duration,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            start_timeout: Duration::from_secs(10),
            backoff: [10, 30, 60, 120, 300, 600].into_iter().map(Duration::from_secs).collect(),
            stable_after: Duration::from_secs(600),
            probe_interval: Duration::from_secs(30),
            probe_timeout: Duration::from_secs(5),
            limits: Limits::default(),
            max_connections: 64,
            connection_idle: Duration::from_secs(15 * 60),
            connect_timeout: Duration::from_secs(10),
        }
    }
}

/// What to run.
#[derive(Clone, Debug)]
pub struct Launch {
    pub manifest: Arc<Manifest>,
    pub program: PathBuf,
    pub package_dir: PathBuf,
    /// Where each start gets its private run directory.
    pub run_root: PathBuf,
    /// The administrator allows plugins on a Linux host without Landlock.
    pub allow_without_landlock: Arc<std::sync::atomic::AtomicBool>,
    /// Kalzit's own addresses, which the connector never reaches.
    pub own: Arc<OwnEndpoints>,
    /// Where refused connects are recorded (`None` in some tests).
    pub audit: Option<sqlx::AnyPool>,
    /// Kalzit's own files with secrets that others may read: shown in the status, and while a
    /// plugin could read one, plugins do not start.
    pub exposure: Arc<super::host::Exposure>,
}

/// What the plugin page shows about the process.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// `idle` (not started yet), `running`, `waiting` (for its next start after a failure),
    /// `stopped` (after too many failures, until restarted by hand).
    pub state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<i64>,
    /// Starts so far.
    pub starts: u32,
    /// Failures in a row.
    pub failures: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<StatusError>,
    /// When the next start may happen (Unix milliseconds), while waiting.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_at: Option<i64>,
    /// The sandbox layers of the current or last process, and those this host lacks.
    pub sandbox: Vec<&'static str>,
    pub sandbox_missing: Vec<&'static str>,
    /// Kalzit's own files with secrets that every local account may read (Windows).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<StatusWarning>,
}

/// Something about a plugin's process an administrator should know: a reason the UI translates,
/// its parameters and an English text.
#[derive(Clone, Debug, Serialize)]
pub struct StatusWarning {
    pub reason: &'static str,
    pub params: std::collections::BTreeMap<String, String>,
    pub message: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct StatusError {
    pub reason: &'static str,
    pub message: String,
    pub at: i64,
}

/// One captured line of a plugin's output.
#[derive(Clone, Debug, Serialize)]
pub struct LogLine {
    pub at: i64,
    /// `stdout` or `stderr`; `host` for the host's own notes (dropped lines).
    pub stream: &'static str,
    pub text: String,
}

/// Longest line kept; the rest of a longer line is cut.
pub const MAX_LINE_BYTES: usize = 4 * 1024;
/// Lines and bytes kept per plugin; older lines go first.
pub const MAX_LOG_LINES: usize = 2000;
pub const MAX_LOG_BYTES: usize = 512 * 1024;
/// Lines per second passed on to Kalzit's log and kept; more are counted and dropped.
pub const MAX_LINES_PER_SECOND: u32 = 200;

#[derive(Default)]
struct LogState {
    lines: VecDeque<LogLine>,
    bytes: usize,
    window: Option<Instant>,
    in_window: u32,
    dropped_in_window: u64,
    dropped: u64,
}

/// The output of one plugin, bounded in lines, bytes and rate.
#[derive(Default)]
pub struct Logs {
    state: Mutex<LogState>,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

impl Logs {
    fn keep(state: &mut LogState, line: LogLine) {
        state.bytes += line.text.len();
        state.lines.push_back(line);
        while state.lines.len() > MAX_LOG_LINES || state.bytes > MAX_LOG_BYTES {
            match state.lines.pop_front() {
                Some(old) => state.bytes -= old.text.len(),
                None => break,
            }
        }
    }

    pub fn push(&self, plugin: &str, stream: &'static str, text: String) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let now = Instant::now();
        if state.window.is_none_or(|w| now.duration_since(w) >= Duration::from_secs(1)) {
            if state.dropped_in_window > 0 {
                let note =
                    format!("{} lines dropped (more than {MAX_LINES_PER_SECOND} per second)", state.dropped_in_window);
                tracing::warn!(plugin = %plugin, "{note}");
                Self::keep(&mut state, LogLine { at: now_ms(), stream: "host", text: note });
            }
            state.window = Some(now);
            state.in_window = 0;
            state.dropped_in_window = 0;
        }
        state.in_window += 1;
        if state.in_window > MAX_LINES_PER_SECOND {
            state.dropped_in_window += 1;
            state.dropped += 1;
            return;
        }
        tracing::info!(plugin = %plugin, stream, "{text}");
        Self::keep(&mut state, LogLine { at: now_ms(), stream, text });
    }

    /// The kept lines, oldest first, and how many lines were dropped in all.
    pub fn snapshot(&self) -> (Vec<LogLine>, u64) {
        let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        (state.lines.iter().cloned().collect(), state.dropped)
    }
}

/// Reads lines from `reader` without holding more than `MAX_LINE_BYTES` of one line; a longer
/// line is cut and marked.
async fn read_lines(mut reader: impl AsyncRead + Unpin, mut line: impl FnMut(String)) {
    let mut buf: Vec<u8> = Vec::with_capacity(256);
    let mut cut = false;
    let mut chunk = vec![0u8; 8192];
    loop {
        let n = match reader.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        for &b in &chunk[..n] {
            if b == b'\n' {
                let mut text = clean_line(&String::from_utf8_lossy(&buf));
                if cut {
                    text.push_str(" [cut]");
                }
                line(text);
                buf.clear();
                cut = false;
            } else if buf.len() < MAX_LINE_BYTES {
                buf.push(b);
            } else {
                cut = true;
            }
        }
    }
    if !buf.is_empty() {
        line(clean_line(&String::from_utf8_lossy(&buf)));
    }
}

/// A line of a plugin's output without terminal escape sequences and control characters (a
/// tab stays) or bidirectional overrides, so it cannot forge or hide lines of Kalzit's log or a
/// terminal.
fn clean_line(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            // CSI (ESC [ ... final byte) or OSC (ESC ] ... BEL or ESC \); other escapes: one char.
            match chars.peek() {
                Some('[') => {
                    chars.next();
                    for c in chars.by_ref() {
                        if ('@'..='~').contains(&c) {
                            break;
                        }
                    }
                }
                Some(']') => {
                    chars.next();
                    while let Some(c) = chars.next() {
                        if c == '\u{7}' || (c == '\u{1b}' && chars.next_if_eq(&'\\').is_some()) {
                            break;
                        }
                    }
                }
                _ => {
                    chars.next();
                }
            }
        } else if c == '\t'
            || !(c.is_control()
                || matches!(c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}' | '\u{200e}' | '\u{200f}'))
        {
            out.push(c);
        }
    }
    out
}

struct Running {
    client: Client,
    control: Arc<dyn Control>,
    exited: watch::Receiver<Option<String>>,
    /// True once the monitor saw the end and removed the run directory.
    cleaned: watch::Receiver<bool>,
    generation: u64,
    started: Instant,
}

enum State {
    Idle,
    Running(Arc<Running>),
    Waiting(Instant),
    Stopped,
}

/// One plugin's process.
pub struct Supervisor {
    id: String,
    launch: Launch,
    options: Options,
    host_version: String,
    state: tokio::sync::Mutex<State>,
    status: Mutex<Status>,
    logs: Arc<Logs>,
    generation: AtomicU64,
    /// The data sources handed to the plugin, for its connects; kept across restarts.
    grants: Arc<Grants>,
}

/// The first stdout line of a plugin that listens: `kalzit-plugin <protocol> ready`.
pub fn parse_handshake(line: &str) -> Result<u32, HostError> {
    let invalid = || {
        HostError::new("plugin.handshake_invalid", format!("the plugin's handshake {line:?} is not valid"))
            .with("line", line.chars().take(100).collect::<String>())
    };
    let mut parts = line.split(' ');
    let (Some("kalzit-plugin"), Some(version), Some("ready"), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err(invalid());
    };
    let version: u32 = version.parse().map_err(|_| invalid())?;
    if !kalzit_plugin_api::SUPPORTED_PROTOCOL_VERSIONS.contains(&version) {
        return Err(HostError::new(
            "plugin.protocol_unsupported",
            format!("the plugin speaks protocol {version}, which this Kalzit does not"),
        )
        .with("version", version));
    }
    Ok(version)
}

/// Whether a `Describe` answer fits the manifest: protocol, kind, shapes and capabilities.
pub fn check_describe(manifest: &Manifest, answer: &pb::DescribeResponse) -> Result<(), HostError> {
    let contradicts = |what: &str, detail: String| {
        HostError::new(
            "plugin.describe_mismatch",
            format!("the plugin's Describe answer contradicts its manifest: {detail}"),
        )
        .with("field", what)
    };
    if !kalzit_plugin_api::SUPPORTED_PROTOCOL_VERSIONS.contains(&answer.protocol_version)
        || manifest.protocol != Some(answer.protocol_version)
    {
        return Err(contradicts("protocol", format!("protocol {}", answer.protocol_version)));
    }
    if answer.kind != manifest.id {
        return Err(contradicts("kind", format!("kind {:?}", answer.kind)));
    }
    let shapes: BTreeSet<String> = answer
        .shapes
        .iter()
        .filter_map(|s| pb::Shape::try_from(*s).ok())
        .filter_map(super::wire::shape_from)
        .map(|s| shape_name(s).to_string())
        .collect();
    let declared: BTreeSet<String> = manifest.shapes.iter().cloned().collect();
    if shapes != declared {
        return Err(contradicts("shapes", format!("shapes {shapes:?}")));
    }
    let capabilities: BTreeSet<&'static str> = super::wire::capabilities_from(&answer.capabilities)
        .into_iter()
        .map(|c| match c {
            crate::datasources::Capability::CheckOnSave => "check_on_save",
            crate::datasources::Capability::Watch => "watch",
            crate::datasources::Capability::Distribution => "distribution",
            crate::datasources::Capability::Pushdown => "pushdown",
        })
        .collect();
    let declared: BTreeSet<&str> = manifest.capabilities.iter().map(String::as_str).collect();
    if capabilities != declared {
        return Err(contradicts("capabilities", format!("capabilities {capabilities:?}")));
    }
    Ok(())
}

/// The manifest's name of a shape.
pub fn shape_name(shape: crate::shapes::Shape) -> &'static str {
    match shape {
        crate::shapes::Shape::Frame => "frame",
        crate::shapes::Shape::Documents => "documents",
        crate::shapes::Shape::Graph => "graph",
    }
}

fn random_hex(bytes: usize) -> String {
    let data: Vec<u8> = (0..bytes).map(|_| rand::random::<u8>()).collect();
    hex::encode(data)
}

impl Supervisor {
    pub fn new(launch: Launch, options: Options) -> Arc<Self> {
        let warnings = launch.exposure.warnings.clone();
        Arc::new(Self {
            id: launch.manifest.id.clone(),
            launch,
            options,
            host_version: env!("CARGO_PKG_VERSION").to_string(),
            state: tokio::sync::Mutex::new(State::Idle),
            status: Mutex::new(Status { state: "idle", warnings, ..Default::default() }),
            logs: Arc::default(),
            generation: AtomicU64::new(0),
            grants: Arc::default(),
        })
    }

    /// The data sources the plugin was handed, with their settings (`connector`).
    pub fn grants(&self) -> &Grants {
        &self.grants
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn manifest(&self) -> &Arc<Manifest> {
        &self.launch.manifest
    }

    pub fn status(&self) -> Status {
        self.status.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    pub fn logs(&self) -> &Logs {
        &self.logs
    }

    fn set_status(&self, change: impl FnOnce(&mut Status)) {
        change(&mut self.status.lock().unwrap_or_else(|e| e.into_inner()));
    }

    /// A client of the running process, started if it is not running. While the plugin waits
    /// after a failure, or is stopped, calls fail at once with the reason.
    pub async fn client(self: &Arc<Self>) -> Result<Client, HostError> {
        let mut state = self.state.lock().await;
        if let State::Running(running) = &*state {
            let ended = running.exited.borrow().clone();
            match ended {
                None => return Ok(running.client.clone()),
                Some(how) => {
                    let running = running.clone();
                    self.failed_locked(&mut state, crashed(&how), Some(running.started.elapsed()));
                }
            }
        }
        match &*state {
            State::Running(_) | State::Idle => {}
            State::Waiting(until) if Instant::now() >= *until => {}
            State::Waiting(until) => {
                let seconds = until.saturating_duration_since(Instant::now()).as_secs().max(1);
                return Err(HostError::new(
                    "plugin.restarting",
                    format!("the plugin failed and starts again in {seconds} seconds"),
                )
                .with("seconds", seconds));
            }
            State::Stopped => {
                return Err(HostError::new(
                    "plugin.stopped",
                    "the plugin failed too often and is stopped until an administrator restarts it",
                ));
            }
        }
        match self.start().await {
            Ok(running) => {
                let client = running.client.clone();
                *state = State::Running(running);
                Ok(client)
            }
            Err(e) => {
                self.failed_locked(&mut state, e.clone(), None);
                Err(e)
            }
        }
    }

    /// Records a failure and decides the next state.
    fn failed_locked(&self, state: &mut State, error: HostError, ran_for: Option<Duration>) {
        tracing::warn!(plugin = %self.id, reason = error.reason, "plugin failed: {}", error.message);
        let mut status = self.status.lock().unwrap_or_else(|e| e.into_inner());
        if ran_for.is_some_and(|d| d >= self.options.stable_after) {
            status.failures = 0;
        }
        status.failures += 1;
        status.pid = None;
        status.last_error = Some(StatusError { reason: error.reason, message: error.message, at: now_ms() });
        match self.options.backoff.get(status.failures as usize - 1) {
            Some(wait) => {
                *state = State::Waiting(Instant::now() + *wait);
                status.state = "waiting";
                status.retry_at = Some(now_ms() + wait.as_millis() as i64);
            }
            None => {
                *state = State::Stopped;
                status.state = "stopped";
                status.retry_at = None;
            }
        }
    }

    /// Ends the process (if any) and leaves the plugin idle: the next call starts it again.
    /// With `reset`, the count of failures starts afresh (a restart by hand).
    pub async fn stop(&self, reset: bool) {
        let mut state = self.state.lock().await;
        let running = match &*state {
            State::Running(running) => Some(running.clone()),
            _ => None,
        };
        if let Some(running) = &running {
            running.control.kill();
        }
        // A monitor that sees the end later finds another generation and leaves the state.
        self.generation.fetch_add(1, Ordering::SeqCst);
        *state = State::Idle;
        self.set_status(|s| {
            s.state = "idle";
            s.pid = None;
            s.retry_at = None;
            if reset {
                s.failures = 0;
            }
        });
        // Its files are gone when this returns (the package may be removed next).
        if let Some(running) = running {
            let mut cleaned = running.cleaned.clone();
            let _ = tokio::time::timeout(Duration::from_secs(10), cleaned.wait_for(|c| *c)).await;
        }
    }

    async fn start(self: &Arc<Self>) -> Result<Arc<Running>, HostError> {
        if super::sandbox::runs_as_root() {
            return Err(HostError::new(
                "plugin.root_refused",
                "plugins do not run while Kalzit runs as root; run Kalzit as its own account",
            ));
        }
        if let Some(path) = self.launch.exposure.readable_by_plugins.first() {
            return Err(HostError::new(
                "plugin.secrets_exposed",
                format!(
                    "{path} holds secrets that a plugin could read; limit it to SYSTEM, Administrators and the account Kalzit runs as"
                ),
            )
            .with("path", path));
        }
        let require_landlock = cfg!(target_os = "linux") && !self.launch.allow_without_landlock.load(Ordering::SeqCst);
        let landlock_missing = || {
            HostError::new(
                "plugin.landlock_missing",
                "this host offers no Landlock, so the plugin's file system access cannot be limited; an administrator can allow plugins without it",
            )
        };
        if require_landlock && !super::sandbox::landlock_available() {
            return Err(landlock_missing());
        }
        let app_container_sid = super::sandbox::app_container(&self.launch.run_root, &self.id).map_err(|e| {
            HostError::new("plugin.start_failed", format!("the plugin's AppContainer cannot be prepared: {e}"))
                .with("detail", e)
        })?;
        let random = random_hex(16);
        let run_dir = self.launch.run_root.join(&random[..12]);
        let start_sid = super::package::start_sid();
        let access = PluginAccess::Modify(start_sid.clone());
        private_dir(&run_dir, &access)?;
        let tmp = run_dir.join("tmp");
        private_dir(&tmp, &access)?;
        let token = random_hex(32);
        // The plugin's connection and Kalzit's network connector, both Kalzit's before it starts.
        let opened = process::Endpoint::new(&run_dir, &random, &start_sid, &app_container_sid).and_then(|endpoint| {
            connector::listen(&run_dir, &random, &start_sid, &app_container_sid).map(|c| (endpoint, c))
        });
        #[allow(unused_mut)]
        let (mut endpoint, (mut listener, connector_address)) = match opened {
            Ok(opened) => opened,
            Err(e) => {
                let _ = std::fs::remove_dir_all(&run_dir);
                return Err(HostError::new(
                    "plugin.start_failed",
                    format!("the plugin's connection or network connector cannot be opened: {e}"),
                )
                .with("detail", e));
            }
        };
        let plugin_address = endpoint.address.clone();
        // Linux: the plugin gets both connections as descriptors, connected already; it may
        // open no socket of its own. Kalzit's copies of the plugin's ends close after the start.
        #[cfg(unix)]
        let handed = [
            endpoint.take_plugin_end().map(|fd| (fd, process::HOST_FD)),
            listener.take_plugin_end().map(|fd| (fd, process::CONNECTOR_FD)),
        ];
        #[cfg(unix)]
        let inherit: Vec<(i32, i32)> = {
            use std::os::fd::AsRawFd;
            handed.iter().flatten().map(|(fd, to)| (fd.as_raw_fd(), *to)).collect()
        };
        #[cfg(not(unix))]
        let inherit = Vec::new();
        let mut endpoint = Some(endpoint);
        let spec = process::Spec {
            program: self.launch.program.clone(),
            args: Vec::new(),
            package_dir: self.launch.package_dir.clone(),
            run_dir: run_dir.clone(),
            tmp_dir: tmp.clone(),
            env: process::environment(&plugin_address, &token, &tmp, &connector_address),
            limits: self.options.limits.clone(),
            plugin_sid: super::package::plugin_sid(&self.id),
            start_sid,
            app_container_sid,
            require_landlock,
            inherit,
        };
        let spawned = process::spawn(&spec);
        #[cfg(unix)]
        drop(handed);
        let mut child = match spawned {
            Ok(child) => child,
            Err(e) => {
                let _ = std::fs::remove_dir_all(&run_dir);
                #[cfg(target_os = "linux")]
                if e.raw_os_error() == Some(super::sandbox::LANDLOCK_REFUSED) && require_landlock {
                    return Err(landlock_missing());
                }
                return Err(HostError::new("plugin.start_failed", format!("the plugin could not be started: {e}"))
                    .with("detail", e));
            }
        };
        self.set_status(|s| {
            s.starts += 1;
            s.sandbox = child.layers.clone();
            s.sandbox_missing = child.missing.clone();
            s.warnings = self.launch.exposure.warnings.clone();
            // Allowed by the administrator, but said with every start.
            if cfg!(target_os = "linux") && !child.layers.contains(&"landlock") {
                s.warnings.push(StatusWarning {
                    reason: "plugin.without_landlock",
                    params: Default::default(),
                    message:
                        "the plugin runs without Landlock (allowed without it): its file system access is not limited"
                            .to_string(),
                });
            }
        });
        // The child refuses to run without it already; this holds should it report otherwise.
        if require_landlock && !child.layers.contains(&"landlock") {
            child.control.kill();
            cleanup(child.exited.clone(), &run_dir).await;
            return Err(landlock_missing());
        }
        tracing::info!(plugin = %self.id, pid = child.pid, sandbox = ?child.layers, missing = ?child.missing, "plugin process started");
        let context = connector::Context::new(
            self.id.clone(),
            self.launch.manifest.clone(),
            self.grants.clone(),
            self.launch.own.clone(),
            token.clone(),
            self.logs.clone(),
            self.launch.audit.clone(),
            (self.options.max_connections, self.options.connection_idle, self.options.connect_timeout),
        );
        connector::serve(listener, Arc::new(context), child.pid, child.exited.clone());

        // Output: the handshake on stdout, everything else into the plugin's log.
        let (handshake_tx, handshake_rx) = oneshot::channel::<String>();
        let logs = self.logs.clone();
        let id = self.id.clone();
        let stdout = std::mem::replace(&mut child.stdout, Box::new(tokio::io::empty()));
        tokio::spawn(async move {
            let mut handshake = Some(handshake_tx);
            read_lines(stdout, |line| {
                if handshake.is_some() && line.starts_with("kalzit-plugin ") {
                    if let Some(tx) = handshake.take() {
                        let _ = tx.send(line);
                    }
                } else {
                    logs.push(&id, "stdout", line);
                }
            })
            .await;
        });
        let logs = self.logs.clone();
        let id = self.id.clone();
        let stderr = std::mem::replace(&mut child.stderr, Box::new(tokio::io::empty()));
        tokio::spawn(async move { read_lines(stderr, |line| logs.push(&id, "stderr", line)).await });

        let started = Instant::now();
        let control = child.control.clone();
        let mut exited = child.exited.clone();
        let ready = async {
            let line = tokio::select! {
                line = handshake_rx => line.map_err(|_| HostError::new("plugin.exited", "the plugin ended before it was ready"))?,
                () = ended(&mut exited) => {
                    let how = exited.borrow().clone().unwrap_or_default();
                    return Err(HostError::new("plugin.exited", format!("the plugin ended before it was ready ({how})")).with("exit", how));
                }
            };
            parse_handshake(&line)?;
            let endpoint = endpoint.take().ok_or_else(|| HostError::new("plugin.start_failed", "no endpoint"))?;
            let channel = process::channel(endpoint, child.pid).await.map_err(|e| {
                let detail = error_chain(&e);
                HostError::new(
                    "plugin.connect_failed",
                    format!("the plugin's connection could not be opened: {detail}"),
                )
                .with("detail", detail)
            })?;
            let value = token.parse().map_err(|_| HostError::new("plugin.start_failed", "the token is not ASCII"))?;
            let client = DataSourceClient::with_interceptor(channel, Token(value))
                .max_decoding_message_size(kalzit_plugin_api::MAX_MESSAGE_BYTES)
                .max_encoding_message_size(kalzit_plugin_api::MAX_MESSAGE_BYTES);
            let answer = describe(&client, &self.host_version).await?;
            check_describe(&self.launch.manifest, &answer)?;
            Ok::<_, HostError>(client)
        };
        let client = match tokio::time::timeout(self.options.start_timeout, ready).await {
            Ok(Ok(client)) => client,
            failed => {
                control.kill();
                let error = match failed {
                    Ok(Err(e)) => e,
                    _ => HostError::new(
                        "plugin.start_timeout",
                        format!(
                            "the plugin was not ready within {} seconds",
                            self.options.start_timeout.as_secs().max(1)
                        ),
                    ),
                };
                cleanup(child.exited.clone(), &run_dir).await;
                return Err(error);
            }
        };
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let (cleaned_tx, cleaned) = watch::channel(false);
        let running = Arc::new(Running { client, control, exited: child.exited.clone(), cleaned, generation, started });
        self.set_status(|s| {
            s.state = "running";
            s.pid = Some(child.pid);
            s.started_at = Some(now_ms());
            s.retry_at = None;
        });
        tokio::spawn(self.clone().monitor(running.clone(), run_dir, cleaned_tx));
        Ok(running)
    }

    /// Watches a running process: probes its health, and records its end.
    async fn monitor(self: Arc<Self>, running: Arc<Running>, run_dir: PathBuf, cleaned: watch::Sender<bool>) {
        let mut exited = running.exited.clone();
        let mut probe = tokio::time::interval(self.options.probe_interval);
        probe.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        probe.tick().await;
        let mut misses = 0;
        let mut unresponsive = false;
        loop {
            tokio::select! {
                () = ended(&mut exited) => break,
                _ = probe.tick() => {
                    let answered =
                        tokio::time::timeout(self.options.probe_timeout, describe(&running.client, &self.host_version)).await;
                    if matches!(answered, Ok(Ok(_))) {
                        misses = 0;
                    } else {
                        misses += 1;
                        if misses >= 2 {
                            unresponsive = true;
                            running.control.kill();
                        }
                    }
                }
            }
        }
        let how = exited.borrow().clone().unwrap_or_default();
        cleanup(running.exited.clone(), &run_dir).await;
        let _ = cleaned.send(true);
        let mut state = self.state.lock().await;
        let current = matches!(&*state, State::Running(r) if r.generation == running.generation)
            && self.generation.load(Ordering::SeqCst) == running.generation;
        if current {
            let error = if unresponsive {
                HostError::new("plugin.unresponsive", "the plugin stopped answering its health checks and was ended")
            } else {
                crashed(&how)
            };
            self.failed_locked(&mut state, error, Some(running.started.elapsed()));
        }
    }

    /// Kills the process for good (Kalzit stops, the plugin is removed or disabled).
    pub async fn shutdown(&self) {
        self.stop(false).await;
    }
}

/// An error with its causes, for the log and the plugin's status.
pub fn error_chain(e: &(dyn std::error::Error + 'static)) -> String {
    let mut text = e.to_string();
    let mut source = e.source();
    while let Some(s) = source {
        text.push_str(": ");
        text.push_str(&s.to_string());
        source = s.source();
    }
    text
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

fn crashed(how: &str) -> HostError {
    HostError::new("plugin.crashed", format!("the plugin process ended ({how})")).with("exit", how)
}

/// Removes a run directory once its process has ended (killed processes end at once; the wait
/// is bounded all the same). Windows may hold a file a moment after the end.
async fn cleanup(mut exited: watch::Receiver<Option<String>>, run_dir: &std::path::Path) {
    let _ = tokio::time::timeout(Duration::from_secs(10), ended(&mut exited)).await;
    for _ in 0..50 {
        if !run_dir.exists() || std::fs::remove_dir_all(run_dir).is_ok() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    tracing::warn!("the plugin run directory {} could not be removed", run_dir.display());
}

async fn describe(client: &Client, host_version: &str) -> Result<pb::DescribeResponse, HostError> {
    let mut request = tonic::Request::new(pb::DescribeRequest {
        protocol_version: kalzit_plugin_api::PROTOCOL_VERSION,
        host_version: host_version.to_string(),
        protocol_minor: kalzit_plugin_api::PROTOCOL_MINOR,
        features: kalzit_plugin_api::FEATURES.iter().map(|f| f.to_string()).collect(),
    });
    request.set_timeout(Duration::from_secs(5));
    client.clone().describe(request).await.map(tonic::Response::into_inner).map_err(|s| {
        let detail = error_chain(&s);
        HostError::new("plugin.describe_failed", format!("the plugin did not answer Describe: {detail}"))
            .with("detail", detail)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handshakes_name_a_supported_protocol() {
        assert_eq!(parse_handshake("kalzit-plugin 1 ready"), Ok(1));
        assert_eq!(parse_handshake("kalzit-plugin 2 ready").unwrap_err().reason, "plugin.protocol_unsupported");
        for bad in ["kalzit-plugin ready", "kalzit-plugin 1 ready now", "kalzit-plugin x ready", "hello"] {
            assert_eq!(parse_handshake(bad).unwrap_err().reason, "plugin.handshake_invalid", "{bad}");
        }
    }

    fn manifest() -> Manifest {
        kalzit_plugin_api::manifest::parse(
            "manifest = 1\nid = \"dev.example.t\"\nname = \"T\"\nversion = \"1.0.0\"\nkind = \"datasource\"\n\
             min_kalzit = \"0.1.0\"\nshapes = [\"frame\", \"graph\"]\nprotocol = 1\ncapabilities = [\"watch\"]\n\n\
             [binaries]\nlinux-x64 = \"p\"\n\n[files]\n\"p\" = \"3f1a2b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708\"\n",
        )
        .unwrap()
    }

    #[test]
    fn describe_answers_must_fit_the_manifest() {
        let ok = pb::DescribeResponse {
            protocol_version: 1,
            kind: "dev.example.t".into(),
            shapes: vec![pb::Shape::Graph as i32, pb::Shape::Frame as i32],
            capabilities: vec![pb::Capability::Watch as i32, 99],
        };
        check_describe(&manifest(), &ok).unwrap();
        let cases = [
            pb::DescribeResponse { kind: "dev.example.other".into(), ..ok.clone() },
            pb::DescribeResponse { protocol_version: 2, ..ok.clone() },
            pb::DescribeResponse { shapes: vec![pb::Shape::Frame as i32], ..ok.clone() },
            pb::DescribeResponse { capabilities: vec![], ..ok.clone() },
            pb::DescribeResponse { capabilities: vec![1, 2], ..ok.clone() },
        ];
        for case in cases {
            assert_eq!(check_describe(&manifest(), &case).unwrap_err().reason, "plugin.describe_mismatch", "{case:?}");
        }
    }

    #[tokio::test]
    async fn long_lines_are_cut_and_lines_split() {
        let input = format!("eins\r\nzwei\n{}\ndrei", "x".repeat(MAX_LINE_BYTES + 10));
        let mut lines = Vec::new();
        read_lines(input.as_bytes(), |l| lines.push(l)).await;
        assert_eq!(lines.len(), 4);
        assert_eq!(lines[0], "eins");
        assert_eq!(lines[1], "zwei");
        assert!(lines[2].ends_with(" [cut]") && lines[2].len() == MAX_LINE_BYTES + 6);
        assert_eq!(lines[3], "drei");
    }

    #[test]
    fn escape_sequences_and_control_characters_are_removed() {
        assert_eq!(clean_line("\u{1b}[31mrot\u{1b}[0m\tok\r"), "rot\tok");
        assert_eq!(clean_line("a\u{1b}]0;title\u{7}b\u{8}c"), "abc");
        assert_eq!(clean_line("fake\nline\u{202e}"), "fakeline");
    }

    #[test]
    fn logs_are_bounded_in_rate_and_size() {
        let logs = Logs::default();
        for i in 0..1000 {
            logs.push("dev.example.t", "stderr", format!("line {i}"));
        }
        let (lines, dropped) = logs.snapshot();
        assert_eq!(lines.len(), MAX_LINES_PER_SECOND as usize);
        assert_eq!(dropped, 1000 - u64::from(MAX_LINES_PER_SECOND));
        let logs = Logs::default();
        {
            let mut state = logs.state.lock().unwrap();
            for _ in 0..MAX_LOG_LINES + 10 {
                Logs::keep(&mut state, LogLine { at: 0, stream: "stderr", text: "x".repeat(1000) });
            }
            assert!(state.bytes <= MAX_LOG_BYTES && state.lines.len() <= MAX_LOG_LINES);
        }
    }
}
