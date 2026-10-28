//! Write Kalzit data source plugins in Rust (docs/plugins/authoring.md).
//!
//! A plugin implements [`DataSource`] and hands it to [`run`]:
//!
//! ```no_run
//! use kalzit_plugin_sdk::{Connection, Context, DataSource, Description, Error, Field, FieldType, Finished,
//!                         Health, Query, Results, Shape};
//! use serde_json::json;
//!
//! struct Hello;
//!
//! impl DataSource for Hello {
//!     fn describe(&self) -> Description {
//!         Description::new("dev.example.hello").shape(Shape::Frame)
//!     }
//!
//!     async fn health(&self, _ctx: &Context, _conn: &Connection) -> Result<Health, Error> {
//!         Ok(Health::connected("Hello", "1"))
//!     }
//!
//!     async fn query(&self, _ctx: Context, _query: Query, out: Results) -> Result<Finished, Error> {
//!         let mut frame = out.frame(vec![Field::new("greeting", FieldType::String)]).await?;
//!         frame.row(vec![json!("hello")]).await?;
//!         frame.finish().await
//!     }
//! }
//!
//! fn main() -> std::process::ExitCode {
//!     kalzit_plugin_sdk::run(Hello)
//! }
//! ```
//!
//! What the SDK does for the plugin (docs/api/plugins.md, "Processes"):
//!
//! - Reads `KALZIT_PLUGIN_ADDRESS`, `KALZIT_PLUGIN_TOKEN`, `KALZIT_PLUGIN_HOST_PID` and
//!   `KALZIT_PLUGIN_CONNECTOR`, serves on the address (Windows: connects to the named pipe Kalzit
//!   created, as an AppContainer cannot create one; Linux: listens on the Unix socket), and prints
//!   the handshake `kalzit-plugin 1 ready` on stdout once it serves. Only Kalzit's process is
//!   served, calls without the start's token are refused.
//! - Network connections go through Kalzit's connector ([`net::connect`]); the plugin has no
//!   network of its own.
//! - Answers `Describe` from [`DataSource::describe`] and keeps what the host announced
//!   ([`HostInfo`], through [`Context::host`]).
//! - Turns the gRPC deadline and `deadline_unix_ms` into one deadline per call: a call that runs
//!   past it ends with `ERROR_KIND_TIMEOUT`. A call the host cancels drops the plugin's future,
//!   so the work stops at its next `.await`.
//! - Streams results in their native shape ([`Results`]), cut into parts of about
//!   [`kalzit_plugin_api::TARGET_PART_BYTES`], and stops asking for more once the query's row or
//!   byte limit is passed (the host cuts the result with its notice).
//! - Maps [`Error`] to the protocol's errors and logs to stderr ([`log`]); stdout carries only
//!   the handshake.
//!
//! Network access: plugins connect on their own for now. Kalzit's network connector (a plugin
//! asks Kalzit for a connection to a declared target) is not part of this version; [`net`] is the
//! place where its client will live.

mod results;
mod service;
mod transport;

pub mod log;
pub mod net;

use std::collections::BTreeMap;
use std::fmt;
use std::future::Future;
use std::process::ExitCode;
use std::sync::Arc;
use std::time::{Duration, SystemTime};

pub use kalzit_plugin_api::datasource::v1 as pb;
pub use results::{
    DocumentWriter, Field, FieldType, Finished, Flow, FrameWriter, GraphWriter, Notice, Results, WatchFeed,
};
pub use serde_json::Value;

/// The environment variables the host starts a plugin with.
pub const ADDRESS_ENV: &str = "KALZIT_PLUGIN_ADDRESS";
pub const TOKEN_ENV: &str = "KALZIT_PLUGIN_TOKEN";
pub const HOST_PID_ENV: &str = "KALZIT_PLUGIN_HOST_PID";

/// The shapes a plugin answers in.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Shape {
    Frame,
    Documents,
    Graph,
}

impl Shape {
    fn pb(self) -> pb::Shape {
        match self {
            Shape::Frame => pb::Shape::Frame,
            Shape::Documents => pb::Shape::Documents,
            Shape::Graph => pb::Shape::Graph,
        }
    }
}

/// The optional parts of the contract a plugin implements.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Capability {
    /// [`DataSource::check_on_save`].
    CheckOnSave,
    /// [`DataSource::watch`].
    Watch,
}

/// What the plugin is. It must agree with the manifest (`id`, `shapes`, `capabilities`), or the
/// host refuses the plugin at start.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Description {
    pub kind: String,
    pub shapes: Vec<Shape>,
    pub capabilities: Vec<Capability>,
}

impl Description {
    /// A plugin of the kind `kind` (the manifest's `id`).
    pub fn new(kind: impl Into<String>) -> Self {
        Self { kind: kind.into(), shapes: Vec::new(), capabilities: Vec::new() }
    }

    pub fn shape(mut self, shape: Shape) -> Self {
        if !self.shapes.contains(&shape) {
            self.shapes.push(shape);
        }
        self
    }

    pub fn capability(mut self, capability: Capability) -> Self {
        if !self.capabilities.contains(&capability) {
            self.capabilities.push(capability);
        }
        self
    }
}

/// What the host announced in `Describe`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct HostInfo {
    /// Kalzit's version, such as "0.4.0"; empty until the host described itself.
    pub version: String,
    /// The minor version of protocol 1 the host understands.
    pub protocol_minor: u32,
    /// Additions of protocol 1 the host understands, by name. Use an addition only when it is
    /// listed here.
    pub features: Vec<String>,
}

/// A reason code, its parameters and an English text: what the UI translates and shows.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Detail {
    pub reason: String,
    pub params: BTreeMap<String, String>,
    pub message: String,
}

impl Detail {
    pub fn new(reason: impl Into<String>, message: impl Into<String>) -> Self {
        Self { reason: reason.into(), params: BTreeMap::new(), message: message.into() }
    }

    pub fn with(mut self, key: impl Into<String>, value: impl ToString) -> Self {
        self.params.insert(key.into(), value.to_string());
        self
    }

    fn pb(&self) -> pb::Detail {
        pb::Detail { reason: self.reason.clone(), params: self.params.clone(), message: self.message.clone() }
    }
}

/// The kinds of errors, as Kalzit reports them (`query_rejected`, `datasource_target_blocked`,
/// `query_timeout`, `datasource_error`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ErrorKind {
    /// The query is not allowed, for example because it would write.
    Rejected,
    /// The target is refused.
    Blocked,
    /// The work ran longer than allowed.
    Timeout,
    /// The source failed: connection, login, the database's own error.
    Failed,
    /// The plugin does not implement the call (a gRPC `UNIMPLEMENTED`, not a result).
    Unsupported,
}

/// An error a plugin answers with. Reasons of docs/api/datasources.md that plugins may use
/// (`source.error`, `query.invalid_form`, `query.write_refused`, `settings.url_invalid`, ...)
/// reach the API as they are; any other reason arrives as `plugin.error` with the plugin's reason
/// in its parameters. Never put secrets into the message or the parameters.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Error {
    pub kind: ErrorKind,
    pub detail: Detail,
}

impl Error {
    pub fn new(kind: ErrorKind, reason: impl Into<String>, message: impl Into<String>) -> Self {
        Self { kind, detail: Detail::new(reason, message) }
    }

    pub fn rejected(reason: impl Into<String>, message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Rejected, reason, message)
    }

    pub fn blocked(reason: impl Into<String>, message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Blocked, reason, message)
    }

    pub fn timeout(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Timeout, "query.timeout", message)
    }

    pub fn failed(reason: impl Into<String>, message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Failed, reason, message)
    }

    /// `source.error` with this text: the source itself failed.
    pub fn source(message: impl Into<String>) -> Self {
        Self::failed("source.error", message)
    }

    /// The query is not in the kind's form (`query.invalid_form`).
    pub fn invalid_query(message: impl Into<String>) -> Self {
        Self::rejected("query.invalid_form", message)
    }

    /// The call is not implemented.
    pub fn unsupported(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Unsupported, "plugin.unsupported_call", message)
    }

    pub fn with(mut self, key: impl Into<String>, value: impl ToString) -> Self {
        self.detail = self.detail.with(key, value);
        self
    }

    pub(crate) fn pb(&self) -> pb::Error {
        let kind = match self.kind {
            ErrorKind::Rejected => pb::ErrorKind::Rejected,
            ErrorKind::Blocked => pb::ErrorKind::Blocked,
            ErrorKind::Timeout => pb::ErrorKind::Timeout,
            ErrorKind::Failed | ErrorKind::Unsupported => pb::ErrorKind::Failed,
        };
        pb::Error { kind: kind as i32, detail: Some(self.detail.pb()) }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} ({})", self.detail.message, self.detail.reason)
    }
}

impl std::error::Error for Error {}

/// A settings field at fault, for [`DataSource::check_settings`] and
/// [`DataSource::check_on_save`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FieldError {
    pub field: String,
    pub error: Error,
}

impl FieldError {
    /// `field` is wrong: a reason (`settings.url_invalid`, `settings.invalid`, ...) and a text.
    pub fn new(field: impl Into<String>, reason: impl Into<String>, message: impl Into<String>) -> Self {
        Self { field: field.into(), error: Error::rejected(reason, message) }
    }
}

/// "Test connection" passed: what connected, and what needs attention without failing the test.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Health {
    pub detail: Detail,
    pub warnings: Vec<Detail>,
}

impl Health {
    /// `health.connected` with the engine and its version.
    pub fn connected(engine: impl Into<String>, version: impl Into<String>) -> Self {
        let (engine, version) = (engine.into(), version.into());
        let message = if version.is_empty() { engine.clone() } else { format!("{engine} {version}") };
        Self {
            detail: Detail::new("health.connected", message).with("engine", engine).with("version", version),
            warnings: Vec::new(),
        }
    }

    pub fn warning(mut self, warning: Detail) -> Self {
        self.warnings.push(warning);
        self
    }
}

/// One data source as the host stored it. `Debug` leaves the secrets out.
#[derive(Clone, PartialEq)]
pub struct Connection {
    pub datasource_id: String,
    /// Changes whenever settings or secrets change: keep pools per id and revision.
    pub revision: u64,
    /// The kind's own settings (a JSON object; the common limit fields removed).
    pub settings: Value,
    /// Secret fields by name. Never log them or echo them in errors.
    pub secrets: BTreeMap<String, String>,
}

impl Connection {
    /// A text setting; `None` when it is missing, empty or not text.
    pub fn text(&self, name: &str) -> Option<&str> {
        self.settings.get(name).and_then(Value::as_str).filter(|s| !s.is_empty())
    }

    /// A secret; `None` when it is missing or empty.
    pub fn secret(&self, name: &str) -> Option<&str> {
        self.secrets.get(name).map(String::as_str).filter(|s| !s.is_empty())
    }

    fn from_pb(c: Option<pb::Connection>) -> Result<Self, Error> {
        let c = c.unwrap_or_default();
        let settings = if c.settings_json.is_empty() {
            Value::Object(Default::default())
        } else {
            serde_json::from_str(&c.settings_json)
                .map_err(|e| Error::failed("plugin.request_invalid", format!("the settings are not JSON: {e}")))?
        };
        Ok(Self {
            datasource_id: c.datasource_id,
            revision: c.revision,
            settings,
            secrets: c.secrets.into_iter().collect(),
        })
    }
}

impl fmt::Debug for Connection {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Connection")
            .field("datasource_id", &self.datasource_id)
            .field("revision", &self.revision)
            .field("settings", &self.settings)
            .field("secrets", &self.secrets.keys().collect::<Vec<_>>())
            .finish()
    }
}

/// The time range of a query, in Unix milliseconds.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TimeRange {
    pub from_ms: i64,
    pub to_ms: i64,
}

/// The limits a result keeps. The host enforces them on what arrives; [`Results`] stops asking
/// for more once they are passed. Zero means no limit.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Limits {
    pub timeout: Duration,
    pub max_rows: u64,
    pub max_response_bytes: u64,
}

/// One query.
#[derive(Clone, Debug, PartialEq)]
pub struct Query {
    pub connection: Connection,
    pub ref_id: String,
    /// The kind's own query form.
    pub query: Value,
    pub range: Option<TimeRange>,
    pub interval_ms: u64,
    pub max_data_points: Option<u32>,
    /// Dashboard variables by name. Use them as bind parameters, never as text in the query.
    pub variables: Value,
    /// The variables that may be used as identifiers; `None` when all may.
    pub identifier_variables: Option<Vec<String>>,
    pub limits: Limits,
    /// Continues a document set from its `next_cursor`.
    pub cursor: Option<String>,
}

impl Query {
    fn from_pb(q: pb::QueryRequest) -> Result<Self, Error> {
        let json = |text: &str, what: &str| -> Result<Value, Error> {
            if text.is_empty() {
                return Ok(Value::Null);
            }
            serde_json::from_str(text).map_err(|e| Error::invalid_query(format!("the {what} is not JSON: {e}")))
        };
        let limits = q.limits.unwrap_or_default();
        Ok(Self {
            query: json(&q.query_json, "query")?,
            variables: json(&q.variables_json, "variables")?,
            connection: Connection::from_pb(q.connection)?,
            ref_id: q.ref_id,
            range: q.range.map(|r| TimeRange { from_ms: r.from_ms, to_ms: r.to_ms }),
            interval_ms: q.interval_ms,
            max_data_points: q.max_data_points,
            identifier_variables: q.identifier_variables_restricted.then_some(q.identifier_variables),
            limits: Limits {
                timeout: Duration::from_millis(limits.timeout_ms),
                max_rows: limits.max_rows,
                max_response_bytes: limits.max_response_bytes,
            },
            cursor: q.cursor,
        })
    }
}

/// What a call knows besides its request: when the host gives up on it, and what the host is.
#[derive(Clone, Debug)]
pub struct Context {
    deadline: Option<SystemTime>,
    host: Arc<HostInfo>,
}

impl Context {
    pub(crate) fn new(deadline: Option<SystemTime>, host: Arc<HostInfo>) -> Self {
        Self { deadline, host }
    }

    /// When the host gives up on the call. Hand it to the driver where it takes one; the SDK ends
    /// the call with a timeout when it passes.
    pub fn deadline(&self) -> Option<SystemTime> {
        self.deadline
    }

    /// The time left until the deadline (zero once it passed).
    pub fn remaining(&self) -> Option<Duration> {
        self.deadline.map(|d| d.duration_since(SystemTime::now()).unwrap_or_default())
    }

    pub fn host(&self) -> &HostInfo {
        &self.host
    }
}

/// A data source plugin. Only [`describe`](DataSource::describe), [`health`](DataSource::health)
/// and [`query`](DataSource::query) are required; the host never calls `check_on_save` or `watch`
/// unless [`Description`] lists their capability.
///
/// The methods are `async fn` in an implementation; their futures must be `Send`.
pub trait DataSource: Send + Sync + 'static {
    /// The kind, shapes and capabilities; must agree with the manifest.
    fn describe(&self) -> Description;

    /// Checks settings as the form sent them, without network. The manifest's field rules are
    /// checked by the host before.
    fn check_settings(&self, settings: &Value) -> Result<(), FieldError> {
        let _ = settings;
        Ok(())
    }

    /// "Test connection".
    fn health(&self, ctx: &Context, conn: &Connection) -> impl Future<Output = Result<Health, Error>> + Send;

    /// Completion data for the query editor, in one of the schema forms of
    /// docs/api/datasources.md (`{"kind": "tables", ...}`, `fields`, `collections`, `graph`, ...).
    fn schema(&self, ctx: &Context, conn: &Connection) -> impl Future<Output = Result<Value, Error>> + Send {
        let _ = (ctx, conn);
        async { Err(Error::unsupported("this plugin offers no schema")) }
    }

    /// One query. Start the result in its shape with `out`, write its batches and finish it; the
    /// returned [`Finished`] proves the result was ended. An `Err` ends the result with that
    /// error (parts sent before are dropped by the host).
    fn query(&self, ctx: Context, query: Query, out: Results) -> impl Future<Output = Result<Finished, Error>> + Send;

    /// Capability `CheckOnSave`: checks on the source itself when settings or secrets are saved
    /// (the login may only read, for example). A source that cannot be reached is not refused.
    fn check_on_save(&self, ctx: &Context, conn: &Connection) -> impl Future<Output = Result<(), FieldError>> + Send {
        let _ = (ctx, conn);
        async { Ok(()) }
    }

    /// Capability `Watch`: reports changes that may alter the query's result through `feed`
    /// until the host ends the call. `resume` continues an earlier feed of the same query.
    fn watch(
        &self,
        ctx: Context,
        query: Query,
        resume: Option<Vec<u8>>,
        feed: WatchFeed,
    ) -> impl Future<Output = Result<(), Error>> + Send {
        let _ = (ctx, query, resume);
        async move { feed.unsupported().await }
    }

    /// The host forgot a data source (settings changed, source deleted): close its pools.
    fn release(&self, datasource_id: &str) {
        let _ = datasource_id;
    }
}

/// Where and for whom the plugin serves: what the host put into the environment.
#[derive(Clone)]
pub struct Config {
    /// The named pipe (Windows) or Unix socket (Linux) to listen on.
    pub address: String,
    /// The token every call carries (`kalzit-plugin-token`).
    pub token: String,
    /// Kalzit's process id: the only process that may connect.
    pub host_pid: u32,
}

impl fmt::Debug for Config {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Config").field("address", &self.address).field("host_pid", &self.host_pid).finish()
    }
}

impl Config {
    /// Reads the environment the host starts a plugin with.
    pub fn from_env() -> Result<Self, String> {
        let var = |name: &str| std::env::var(name).map_err(|_| format!("{name} is not set; Kalzit starts plugins"));
        let address = var(ADDRESS_ENV)?;
        let token = var(TOKEN_ENV)?;
        let host_pid = var(HOST_PID_ENV)?.parse().map_err(|_| format!("{HOST_PID_ENV} is not a process id"))?;
        if token.is_empty() {
            return Err(format!("{TOKEN_ENV} is empty"));
        }
        Ok(Self { address, token, host_pid })
    }
}

/// Serves `plugin` as Kalzit started it, until Kalzit ends the process. Call it first in `main`,
/// before any thread starts: it takes the token out of the process's environment variables, so
/// processes the plugin starts do not inherit it, and builds the async runtime itself. The
/// environment the process started with stays readable to the plugin's own processes
/// (`/proc/<pid>/environ` on Linux); the token is worth nothing outside this start of this
/// plugin. Fails when the environment is not Kalzit's or the address cannot be served on.
pub fn run<P: DataSource>(plugin: P) -> ExitCode {
    let config = match Config::from_env() {
        Ok(config) => config,
        Err(e) => {
            log::error(&e);
            return ExitCode::FAILURE;
        }
    };
    // The network connector keeps the token it needs before the environment loses it.
    net::init(kalzit_plugin_api::connector::Connector::from_env());
    // SAFETY: `run` is documented to be called before any other thread exists, so nothing reads
    // the environment concurrently.
    unsafe { std::env::remove_var(TOKEN_ENV) };
    let runtime = match tokio::runtime::Builder::new_multi_thread().enable_all().build() {
        Ok(runtime) => runtime,
        Err(e) => {
            log::error(&format!("the async runtime could not start: {e}"));
            return ExitCode::FAILURE;
        }
    };
    match runtime.block_on(serve(plugin, config)) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            log::error(&format!("serving failed: {e}"));
            ExitCode::FAILURE
        }
    }
}

/// Serves `plugin` on `config` inside a runtime the caller runs: listens, prints the handshake
/// and answers calls until the listener fails. Most plugins call [`run`] instead.
pub async fn serve<P: DataSource>(plugin: P, config: Config) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    service::serve(plugin, config).await
}
