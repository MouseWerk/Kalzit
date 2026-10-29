//! Data sources: the plugin contract, the built-in kinds, pooled connections and running queries
//! (docs/ARCHITECTURE.md, "Data sources").
//!
//! Built-in kinds implement `DataSourcePlugin`, the same contract external plugins will use (M4).
//! A `Connection` carries one data source's settings and decrypted secrets plus the plugin's
//! pool; it is cached per data source and rebuilt when the settings or the target rules change.

#[cfg(test)]
mod api_tests;
pub mod bolt;
pub mod cache;
pub mod csv;
pub mod cypher;
pub mod detail;
pub mod distribution;
pub mod document_schema;
pub mod elasticsearch;
pub mod file;
pub mod frame;
pub mod graph;
pub mod gsql;
pub mod http_json;
pub mod json_documents;
pub mod mongodb;
pub mod mssql;
pub mod mysql;
pub mod neo4j;
pub mod postgres;
pub mod prometheus;
pub mod registry;
pub mod sample;
pub mod sql;
pub mod sqlite;
pub mod targets;
pub mod tigergraph;

use std::any::Any;
use std::collections::{BTreeMap, HashMap};
use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::http::StatusCode;
use base64::Engine;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;
use sqlx::AnyPool;
use tokio::sync::{OnceCell, Semaphore};
use zeroize::Zeroizing;

use crate::app::AppState;
use crate::authz::OrgCtx;
use crate::config::Config;
use crate::error::{ApiError, ApiResult};
use crate::secrets::Keyring;
use crate::shapes::{
    CacheInfo, CacheStatus, ErrorBody, QueryItem, QueryOutcome, QueryResponse, QueryResult, Shape, TimeRange,
};
pub use detail::Detail;
use frame::ResponseBudget;
use targets::TargetPolicy;

/// The contract every data source kind implements (docs/ARCHITECTURE.md). The kind's display
/// name and settings form live in its registry entry (`Kind`), like a plugin manifest.
#[async_trait::async_trait]
pub trait DataSourcePlugin: Send + Sync {
    fn kind(&self) -> &'static str;
    fn shapes(&self) -> &'static [Shape];
    fn check_settings(&self, settings: &serde_json::Value) -> Result<(), FieldError>;
    /// Checks that need the kind's own code but no network, after the form rules and
    /// `check_settings`: a plugin process answers its `CheckSettings` here. Built-in kinds check
    /// everything in `check_settings`.
    async fn check_settings_remote(&self, _settings: &serde_json::Value) -> Result<(), FieldError> {
        Ok(())
    }
    async fn health(&self, conn: &Connection) -> Health;
    async fn schema(&self, conn: &Connection) -> Result<SourceSchema, SourceError>;
    async fn query(&self, conn: &Connection, req: SourceQuery) -> Result<QueryResult, SourceError>;
    /// The optional parts of this contract the kind implements. A plugin process declares the
    /// same in its `Describe` answer; the host calls nothing a kind does not declare.
    fn capabilities(&self) -> &'static [Capability] {
        &[]
    }
    /// How the values of one field path are spread over the whole result of `req`, computed in
    /// the source (`distribution::run`). Kinds that cannot answer `distribution.unsupported`; the
    /// sets of those that can say so with `DocumentSet::distributable`.
    async fn distribution(
        &self,
        _conn: &Connection,
        _req: SourceQuery,
        _spec: &distribution::DistributionSpec,
    ) -> Result<crate::shapes::FieldDistribution, SourceError> {
        Err(distribution::unsupported(self.kind()))
    }
    /// Whether `check_on_save` needs the source (and its stored secrets) when it is saved.
    fn checks_on_save(&self) -> bool {
        self.capabilities().contains(&Capability::CheckOnSave)
    }
    /// The query that runs the graph step `step` on the result of `query` in the source itself
    /// (`analysis::pushdown`), run with `query` as any query is; `None` when the kind or the
    /// query cannot, and the server runs the step on the result instead.
    fn pushdown(&self, _query: &Value, _step: &crate::analysis::StepKind, _max_rows: usize) -> Option<Value> {
        None
    }
    /// Checks that need the source itself, run when its settings or secrets are saved (MongoDB:
    /// the login may only read). A refusal names the settings field at fault; a source that
    /// cannot be reached is not refused.
    async fn check_on_save(&self, _conn: &Connection) -> Result<(), (&'static str, SourceError)> {
        Ok(())
    }
    /// Changes that may alter the result of `req`, for live updates (docs/api/live.md), each with
    /// the token to continue after it. `Ok(None)` when the kind or the deployment cannot report
    /// changes; live updates then poll. `resume` continues an earlier feed of the same query;
    /// a kind starts afresh when the token's history is gone. A feed must not hold connections
    /// that queries need.
    async fn watch(
        &self,
        _conn: &Connection,
        _req: SourceQuery,
        _resume: Option<ResumeToken>,
    ) -> Result<Option<ChangeFeed>, SourceError> {
        Ok(None)
    }
}

/// An optional part of `DataSourcePlugin`. Plugin processes can declare `CheckOnSave` and `Watch`
/// (protocol version 1); `Distribution` and `Pushdown` build on Kalzit's step language and stay
/// with the built-in kinds for now (docs/ARCHITECTURE.md, "Plugins").
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Capability {
    /// `check_on_save`: checks on the source itself when it is saved.
    CheckOnSave,
    /// `watch`: change feeds for live updates.
    Watch,
    /// `distribution`: field distributions computed in the source.
    Distribution,
    /// `pushdown`: graph steps run in the source.
    Pushdown,
}

/// Where a change feed continues; opaque outside the kind that made it.
#[derive(Clone)]
pub struct ResumeToken(pub Arc<dyn Any + Send + Sync>);

/// One report of a change feed: a change, or (`changed: false`) only a newer position, as after
/// a wait without changes.
pub struct Change {
    pub changed: bool,
    /// Where the feed continues after this report.
    pub token: Option<ResumeToken>,
}

/// Changes reported by a source (`DataSourcePlugin::watch`). An error ends the feed, as does its
/// end (the watched collection was dropped, say).
pub type ChangeFeed = std::pin::Pin<Box<dyn futures_util::Stream<Item = Result<Change, SourceError>> + Send>>;

/// A settings field that is not valid. `field` is the field's name in the kind's settings form.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FieldError {
    pub field: &'static str,
    /// The reason code (`settings.*`), its parameters and the English text.
    pub detail: Detail,
}

impl FieldError {
    pub fn new(field: &'static str, reason: &'static str, message: impl Into<String>) -> Self {
        Self { field, detail: Detail::new(reason, message).with("field", field) }
    }

    pub fn with(mut self, key: &str, value: impl ToString) -> Self {
        self.detail = self.detail.with(key, value);
        self
    }

    pub fn message(&self) -> &str {
        &self.detail.message
    }
}

/// The answer of "Test connection".
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Health {
    pub ok: bool,
    /// The error code when it failed (`datasource_error`, `datasource_target_blocked`, ...).
    pub code: Option<&'static str>,
    /// What to show: `health.connected` and friends with `engine` and `version`, or why it
    /// failed.
    pub detail: Detail,
    /// What works but needs attention, such as a TigerGraph REST++ without authentication. A
    /// warning never makes the test fail and never stops a save.
    pub warnings: Vec<Detail>,
}

impl Health {
    /// The same answer with one more warning.
    pub fn with_warning(mut self, warning: Detail) -> Self {
        self.warnings.push(warning);
        self
    }

    /// Connected: `engine` and `version` for the text; `admin_login` when the login has
    /// administrator rights (which the text advises against).
    pub fn connected(engine: &str, version: &str, admin_login: bool) -> Self {
        let detail = if admin_login {
            Detail::new(
                "health.connected_admin_login",
                format!("{engine} {version}; the login has administrator rights, use a read-only login instead"),
            )
        } else {
            Detail::new("health.connected", format!("{engine} {version}").trim().to_string())
        };
        Self {
            ok: true,
            code: None,
            detail: detail.with("engine", engine).with("version", version),
            warnings: Vec::new(),
        }
    }

    pub fn failed(e: &SourceError) -> Self {
        Self { ok: false, code: Some(e.code()), detail: e.detail(), warnings: Vec::new() }
    }
}

/// The detail of a refused target that a driver hands back as a boxed error: the target rule's
/// own detail, or Kalzit's own database.
pub fn blocked_detail(inner: &(dyn std::error::Error + Send + Sync + 'static)) -> Detail {
    match inner.downcast_ref::<targets::Blocked>() {
        Some(b) => b.0.clone(),
        None => Detail::new("target.own_database", inner.to_string()),
    }
}

/// What a query editor offers for completion: tables and columns, or metrics and labels.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SourceSchema {
    Tables {
        tables: Vec<Table>,
    },
    Metrics {
        metrics: Vec<String>,
        labels: Vec<String>,
    },
    /// Search indices with their mapped fields (Elasticsearch, OpenSearch).
    Indices {
        indices: Vec<Table>,
    },
    /// Field paths sampled from documents (JSON files, HTTP JSON).
    Fields {
        fields: Vec<crate::shapes::FieldSchema>,
    },
    /// Collections with their indexes and sampled field paths (MongoDB).
    Collections {
        database: String,
        collections: Vec<mongodb::CollectionSchema>,
    },
    /// Graph sources: node labels (TigerGraph: vertex types), relationship (edge) types, property
    /// keys, and for TigerGraph the installed queries.
    Graph {
        labels: Vec<String>,
        #[serde(rename = "edgeTypes")]
        edge_types: Vec<String>,
        #[serde(rename = "propertyKeys")]
        property_keys: Vec<String>,
        #[serde(skip_serializing_if = "Vec::is_empty")]
        queries: Vec<String>,
        /// The declared parameters of the queries whose parameters are known (TigerGraph: from
        /// the query info), by query name.
        #[serde(rename = "queryParams", skip_serializing_if = "BTreeMap::is_empty")]
        query_params: BTreeMap<String, Vec<QueryParam>>,
    },
    /// A plugin's schema in one of the forms above, as the plugin sent it (an object whose
    /// `kind` names one of them; `plugins::remote` checks that).
    #[serde(untagged)]
    Plugin(Value),
}

/// One declared parameter of an installed query: its name and its type as the query language
/// writes it (`INT`, `SET<STRING>`, `VERTEX<Person>`).
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct QueryParam {
    pub name: String,
    #[serde(rename = "type")]
    pub ty: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Table {
    /// The schema (PostgreSQL, SQL Server) or database (MySQL) the table lives in.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    pub name: String,
    pub columns: Vec<TableColumn>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct TableColumn {
    pub name: String,
    /// The engine's type name, as the engine spells it.
    #[serde(rename = "type")]
    pub data_type: String,
}

impl SourceSchema {
    /// Every name an identifier variable may take: tables (plain and schema-qualified) and
    /// columns.
    pub fn identifiers(&self) -> std::collections::BTreeSet<String> {
        let mut names = std::collections::BTreeSet::new();
        if let SourceSchema::Tables { tables } = self {
            for t in tables {
                names.insert(t.name.clone());
                if let Some(schema) = &t.schema {
                    names.insert(format!("{schema}.{}", t.name));
                }
                names.extend(t.columns.iter().map(|c| c.name.clone()));
            }
        }
        names
    }
}

/// A source failure with its error code (`code()`) and a detail: the reason code, parameters and
/// English text (`detail::Detail`).
#[derive(Debug, thiserror::Error)]
pub enum SourceError {
    /// The query is not allowed (`query_rejected`).
    #[error("{0}")]
    Rejected(Detail),
    /// The target is refused (`datasource_target_blocked`).
    #[error("{0}")]
    Blocked(Detail),
    /// The query ran longer than allowed (`query_timeout`).
    #[error("the query took longer than {0} seconds")]
    Timeout(u64),
    /// The source failed: connection, authentication, the database's own error
    /// (`datasource_error`).
    #[error("{0}")]
    Failed(Detail),
}

impl SourceError {
    pub fn rejected(reason: &'static str, message: impl Into<String>) -> Self {
        SourceError::Rejected(Detail::new(reason, message))
    }

    pub fn failed(reason: &'static str, message: impl Into<String>) -> Self {
        SourceError::Failed(Detail::new(reason, message))
    }

    /// The database's or server's own message, shown as the detail of `source.error`.
    pub fn from_source(message: impl Into<String>) -> Self {
        let message = message.into();
        SourceError::Failed(Detail::new("source.error", message.clone()).with("detail", message))
    }

    /// Adds a parameter to the detail.
    pub fn with(self, key: &str, value: impl ToString) -> Self {
        match self {
            SourceError::Rejected(d) => SourceError::Rejected(d.with(key, value)),
            SourceError::Blocked(d) => SourceError::Blocked(d.with(key, value)),
            SourceError::Failed(d) => SourceError::Failed(d.with(key, value)),
            timeout => timeout,
        }
    }

    /// The reason code, parameters and text.
    pub fn detail(&self) -> Detail {
        match self {
            SourceError::Rejected(d) | SourceError::Blocked(d) | SourceError::Failed(d) => d.clone(),
            SourceError::Timeout(secs) => Detail::new("query.timeout", self.to_string()).with("seconds", secs),
        }
    }

    pub fn code(&self) -> &'static str {
        match self {
            SourceError::Rejected(_) => "query_rejected",
            SourceError::Blocked(_) => "datasource_target_blocked",
            SourceError::Timeout(_) => "query_timeout",
            SourceError::Failed(_) => "datasource_error",
        }
    }

    fn status(&self) -> StatusCode {
        match self {
            SourceError::Rejected(_) | SourceError::Blocked(_) => StatusCode::UNPROCESSABLE_ENTITY,
            SourceError::Timeout(_) => StatusCode::GATEWAY_TIMEOUT,
            SourceError::Failed(_) => StatusCode::BAD_GATEWAY,
        }
    }
}

impl From<sql::Rejected> for SourceError {
    fn from(r: sql::Rejected) -> Self {
        SourceError::Rejected(r)
    }
}

impl From<targets::Blocked> for SourceError {
    fn from(b: targets::Blocked) -> Self {
        SourceError::Blocked(b.0)
    }
}

impl From<targets::ResolveError> for SourceError {
    fn from(e: targets::ResolveError) -> Self {
        match e {
            targets::ResolveError::Blocked(b) => b.into(),
            other => SourceError::Failed(other.detail()),
        }
    }
}

/// One query for a plugin, with macros' inputs and the limits it must keep.
pub struct SourceQuery {
    pub ref_id: String,
    /// The kind's own query form (`{"sql": ...}`, `{"expr": ...}`).
    pub query: Value,
    pub range: TimeRange,
    pub interval_ms: u64,
    pub max_data_points: Option<u32>,
    pub variables: BTreeMap<String, Value>,
    /// Variables that may be used as identifiers; `None` allows all (see `sql::Context`).
    pub identifier_variables: Option<std::collections::BTreeSet<String>>,
    pub limits: Limits,
    /// Continues a `DocumentSet` from its `nextCursor`; frame sources ignore it.
    pub cursor: Option<String>,
}

impl SourceQuery {
    /// The query's fields as the kind's struct; a wrong form is `query_rejected`.
    pub fn parse<T: DeserializeOwned>(&self) -> Result<T, SourceError> {
        T::deserialize(&self.query).map_err(|e| {
            SourceError::rejected("query.invalid_form", format!("the query is not valid: {e}")).with("detail", e)
        })
    }
}

#[derive(Clone, Debug)]
pub struct Limits {
    pub timeout: Duration,
    pub max_rows: usize,
    pub budget: ResponseBudget,
}

/// Kalzit's own database, so a PostgreSQL source pointing at it can be refused after connecting
/// (by identity, not by host name, which has too many aliases).
pub struct OwnDatabase {
    db: AnyPool,
    is_postgres: bool,
    identity: OnceCell<Option<(String, String)>>,
}

impl OwnDatabase {
    pub fn new(db: AnyPool, database_url: &str) -> Self {
        let is_postgres = database_url.starts_with("postgres:") || database_url.starts_with("postgresql:");
        Self { db, is_postgres, identity: OnceCell::new() }
    }

    /// `(system_identifier, current_database())` when Kalzit runs on PostgreSQL.
    pub async fn postgres_identity(&self) -> Result<Option<(String, String)>, SourceError> {
        if !self.is_postgres {
            return Ok(None);
        }
        let identity = self
            .identity
            .get_or_try_init(|| async {
                let row: (String, String) = sqlx::query_as(
                    "SELECT CAST(system_identifier AS TEXT), CAST(current_database() AS TEXT) FROM pg_control_system()",
                )
                .fetch_one(&self.db)
                .await
                .map_err(|e| {
                    tracing::error!("reading the identity of Kalzit's own database: {e}");
                    SourceError::failed(
                        "target.own_database_unverifiable",
                        "cannot verify that the target is not Kalzit's own database",
                    )
                })?;
                Ok::<_, SourceError>(Some(row))
            })
            .await?;
        Ok(identity.clone())
    }
}

/// One data source's settings, secrets and the plugin's pool (built on first use).
pub struct Connection {
    datasource_id: String,
    settings: Value,
    secrets: BTreeMap<String, Zeroizing<String>>,
    policy: Arc<TargetPolicy>,
    own: Arc<OwnDatabase>,
    shared: OnceCell<Arc<dyn Any + Send + Sync>>,
    /// Graph steps this source could not run itself (`with_pushdown`).
    pushdown: PushdownMemo,
}

/// A connection nobody holds anymore closes its SQLite file, also one that was never cached or
/// whose cache entry was replaced while a query still used it.
impl Drop for Connection {
    fn drop(&mut self) {
        if let (Some(pool), Ok(rt)) = (self.sqlite_pool().cloned(), tokio::runtime::Handle::try_current())
            && !pool.is_closed()
        {
            rt.spawn(async move { pool.close().await });
        }
    }
}

impl Connection {
    pub fn new(
        datasource_id: impl Into<String>,
        settings: Value,
        secrets: BTreeMap<String, Zeroizing<String>>,
        policy: Arc<TargetPolicy>,
        own: Arc<OwnDatabase>,
    ) -> Self {
        Self {
            datasource_id: datasource_id.into(),
            settings,
            secrets,
            policy,
            own,
            shared: OnceCell::new(),
            pushdown: PushdownMemo::default(),
        }
    }

    pub fn datasource_id(&self) -> &str {
        &self.datasource_id
    }

    /// The kind's own settings (the common limit fields removed).
    pub fn settings(&self) -> &Value {
        &self.settings
    }

    pub fn settings_as<T: DeserializeOwned>(&self) -> Result<T, SourceError> {
        T::deserialize(&self.settings).map_err(|e| {
            SourceError::failed("settings.stored_invalid", format!("the stored settings are not valid: {e}"))
        })
    }

    pub fn secret(&self, field: &str) -> Option<&str> {
        self.secrets.get(field).map(|s| s.as_str())
    }

    pub fn policy(&self) -> &TargetPolicy {
        &self.policy
    }

    pub fn policy_arc(&self) -> Arc<TargetPolicy> {
        self.policy.clone()
    }

    pub fn own_database(&self) -> &OwnDatabase {
        &self.own
    }

    /// The plugin's pool or client, built once per connection. A failed build is not kept, so
    /// the next query tries again.
    pub async fn shared<T, F, Fut>(&self, init: F) -> Result<Arc<T>, SourceError>
    where
        T: Any + Send + Sync,
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<T, SourceError>>,
    {
        let any = self
            .shared
            .get_or_try_init(|| async { init().await.map(|t| Arc::new(t) as Arc<dyn Any + Send + Sync>) })
            .await?;
        any.clone()
            .downcast::<T>()
            .map_err(|_| SourceError::failed("internal", "internal: connection state of another kind"))
    }

    /// Closes the SQLite pool this connection keeps, if any: the other kinds hold no files.
    async fn close(&self) {
        if let Some(pool) = self.sqlite_pool() {
            pool.close().await;
        }
    }

    fn sqlite_pool(&self) -> Option<&sqlx::sqlite::SqlitePool> {
        self.shared.get().and_then(|s| s.downcast_ref::<sqlx::sqlite::SqlitePool>())
    }

    /// The text without this source's secrets.
    pub fn scrub(&self, text: &str) -> String {
        scrub(text, self.secrets.values().map(|s| s.as_str()))
    }
}

/// Error texts are cut to this length; driver messages sometimes repeat the whole query.
const MAX_ERROR_CHARS: usize = 2_000;

/// Removes every secret from `text`, as written and in the encodings drivers and servers echo
/// (percent-encoded in URLs, base64 in headers), plus `password=...` pairs of connection strings.
pub fn scrub<'a>(text: &str, secrets: impl IntoIterator<Item = &'a str>) -> String {
    let mut forms: Vec<String> = Vec::new();
    for s in secrets.into_iter().filter(|s| !s.is_empty()) {
        forms.push(s.to_string());
        forms.push(percent_encode(s));
        forms.push(base64::engine::general_purpose::STANDARD.encode(s));
    }
    // Longest first, so a secret containing another is replaced whole.
    forms.sort_by_key(|f| std::cmp::Reverse(f.len()));
    let mut out = text.to_string();
    for form in forms {
        out = out.replace(&form, "***");
    }
    let out = redact_password_pairs(&out);
    match out.char_indices().nth(MAX_ERROR_CHARS) {
        Some((cut, _)) => format!("{}...", &out[..cut]),
        None => out,
    }
}

fn percent_encode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// `Password=geheim;` in ADO or libpq strings that a driver repeats in an error.
fn redact_password_pairs(text: &str) -> String {
    const KEYS: &[&str] = &["password=", "pwd=", "pass="];
    let lower = text.to_ascii_lowercase();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < text.len() {
        let hit = KEYS
            .iter()
            .find(|k| lower[i..].starts_with(*k) && (i == 0 || !lower.as_bytes()[i - 1].is_ascii_alphanumeric()));
        if let Some(key) = hit {
            out.push_str(&text[i..i + key.len()]);
            i += key.len();
            let end = text[i..].find([';', '&', ' ', '\'', '"', '\n']).map_or(text.len(), |p| i + p);
            if end > i {
                out.push_str("***");
            }
            i = end;
        } else {
            let ch = text[i..].chars().next().expect("i is on a char boundary");
            out.push(ch);
            i += ch.len_utf8();
        }
    }
    out
}

// ---- settings forms ----

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SettingType {
    String,
    /// Multi-line text, such as a PEM certificate.
    Text,
    Number,
    Bool,
    /// One of `options`.
    Select,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(untagged)]
pub enum DefaultValue {
    Text(&'static str),
    Number(u64),
    Bool(bool),
}

/// One field of a kind's settings form. Secret fields are sent in `secrets`, never in
/// `settings`, and are never returned.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingField {
    pub name: &'static str,
    /// i18n key for the label (`datasources.settings.<name>`).
    pub label_key: &'static str,
    #[serde(rename = "type")]
    pub field_type: SettingType,
    pub required: bool,
    pub secret: bool,
    /// Decides where the stored secrets are sent (host, port, URL, user, TLS checks). Changing it
    /// requires sending every stored secret again, so a secret cannot be redirected.
    pub target: bool,
    #[serde(skip_serializing_if = "<[_]>::is_empty")]
    pub options: &'static [&'static str],
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default: Option<DefaultValue>,
}

impl SettingField {
    pub const fn new(name: &'static str, label_key: &'static str, field_type: SettingType) -> Self {
        Self { name, label_key, field_type, required: false, secret: false, target: false, options: &[], default: None }
    }

    pub const fn required(mut self) -> Self {
        self.required = true;
        self
    }

    pub const fn target(mut self) -> Self {
        self.target = true;
        self
    }

    pub const fn secret(mut self) -> Self {
        self.secret = true;
        self
    }

    pub const fn options(mut self, options: &'static [&'static str]) -> Self {
        self.options = options;
        self
    }

    pub const fn default(mut self, value: DefaultValue) -> Self {
        self.default = Some(value);
        self
    }
}

/// Fields every kind has: limits for this source within the server-wide maxima, and the query
/// cache (`cacheEnabled` defaults per kind, `cache::enabled_by_default`; the kind list shows it).
pub const COMMON_SETTINGS: &[SettingField] = &[
    SettingField::new("queryTimeoutSecs", "datasources.settings.queryTimeoutSecs", SettingType::Number),
    SettingField::new("maxRows", "datasources.settings.maxRows", SettingType::Number),
    SettingField::new("cacheEnabled", "datasources.settings.cacheEnabled", SettingType::Bool),
    SettingField::new("cacheTtlSecs", "datasources.settings.cacheTtlSecs", SettingType::Number)
        .default(DefaultValue::Number(cache::DEFAULT_TTL_SECS)),
];

/// Longest secret accepted (a client key in PEM fits easily).
const MAX_SECRET_BYTES: usize = 64 * 1024;
const MAX_SETTING_BYTES: usize = 64 * 1024;

/// A registered kind (`registry::KindRegistry`): the plugin plus what its manifest says.
pub struct Kind {
    pub name: &'static str,
    /// i18n key of the advice shown on the settings form (use a read-only login).
    pub hint_key: &'static str,
    pub settings: &'static [SettingField],
    pub plugin: Arc<dyn DataSourcePlugin>,
}

impl Kind {
    pub fn kind(&self) -> &'static str {
        self.plugin.kind()
    }

    /// The kind's fields followed by the common ones.
    pub fn all_settings(&self) -> impl Iterator<Item = &SettingField> {
        self.settings.iter().chain(COMMON_SETTINGS)
    }

    fn field(&self, name: &str) -> Option<&SettingField> {
        self.all_settings().find(|f| f.name == name)
    }

    /// The target fields whose value differs between two settings objects.
    pub fn changed_targets(&self, old: &Value, new: &Value) -> Vec<&'static str> {
        self.all_settings().filter(|f| f.target && old.get(f.name) != new.get(f.name)).map(|f| f.name).collect()
    }

    /// Checks `settings` against the form and the plugin and returns it without `null`
    /// entries, ready to store.
    pub fn validate_settings(&self, settings: &Value) -> Result<Value, FieldError> {
        let Value::Object(map) = settings else {
            return Err(FieldError::new("settings", "settings.not_object", "settings must be an object"));
        };
        if settings.to_string().len() > MAX_SETTING_BYTES {
            return Err(FieldError::new("settings", "settings.too_large", "settings are too large"));
        }
        let mut clean = serde_json::Map::new();
        for (key, value) in map {
            let Some(field) = self.field(key) else {
                return Err(FieldError::new(
                    "settings",
                    "settings.unknown",
                    format!("{key} is not a setting of {}", self.name),
                )
                .with("name", key));
            };
            if field.secret {
                return Err(FieldError::new(
                    field.name,
                    "settings.secret_in_settings",
                    format!("{key} is a secret; send it in secrets"),
                ));
            }
            if value.is_null() {
                continue;
            }
            let fits = match field.field_type {
                SettingType::String | SettingType::Text => value.is_string(),
                SettingType::Number => value.is_u64(),
                SettingType::Bool => value.is_boolean(),
                SettingType::Select => value.as_str().is_some_and(|v| field.options.contains(&v)),
            };
            if !fits {
                let expected = match field.field_type {
                    SettingType::String | SettingType::Text => "text".to_string(),
                    SettingType::Number => "a whole number of at least 0".to_string(),
                    SettingType::Bool => "true or false".to_string(),
                    SettingType::Select => format!("one of {}", field.options.join(", ")),
                };
                let reason = match field.field_type {
                    SettingType::String | SettingType::Text => "settings.expected_text",
                    SettingType::Number => "settings.expected_number",
                    SettingType::Bool => "settings.expected_bool",
                    SettingType::Select => "settings.expected_option",
                };
                let e = FieldError::new(field.name, reason, format!("{key} must be {expected}"));
                return Err(match field.field_type {
                    SettingType::Select => e.with("options", field.options.join(", ")),
                    _ => e,
                });
            }
            if field.field_type == SettingType::String
                && value.as_str().is_some_and(|s| s.chars().any(char::is_control))
            {
                return Err(FieldError::new(
                    field.name,
                    "settings.control_characters",
                    format!("{key} contains control characters"),
                ));
            }
            clean.insert(key.clone(), value.clone());
        }
        for field in self.all_settings().filter(|f| f.required && !f.secret) {
            let present = clean.get(field.name).is_some_and(|v| v.as_str().is_none_or(|s| !s.trim().is_empty()));
            if !present {
                return Err(FieldError::new(field.name, "settings.required", format!("{} is required", field.name)));
            }
        }
        if let Some(t) = clean.get("queryTimeoutSecs").and_then(Value::as_u64)
            && !(1..=3600).contains(&t)
        {
            return Err(FieldError::new(
                "queryTimeoutSecs",
                "settings.out_of_range",
                "queryTimeoutSecs must be 1 to 3600",
            )
            .with("min", 1)
            .with("max", 3600));
        }
        if let Some(t) = clean.get("cacheTtlSecs").and_then(Value::as_u64)
            && !(1..=cache::MAX_TTL_SECS).contains(&t)
        {
            return Err(FieldError::new(
                "cacheTtlSecs",
                "settings.out_of_range",
                format!("cacheTtlSecs must be 1 to {}", cache::MAX_TTL_SECS),
            )
            .with("min", 1)
            .with("max", cache::MAX_TTL_SECS));
        }
        if clean.get("maxRows").and_then(Value::as_u64) == Some(0) {
            return Err(
                FieldError::new("maxRows", "settings.out_of_range", "maxRows must be at least 1").with("min", 1)
            );
        }
        let clean = Value::Object(clean);
        self.plugin.check_settings(&plugin_settings(&clean))?;
        Ok(clean)
    }

    /// Secret names must be secret fields of this kind.
    pub fn validate_secrets(&self, secrets: &crate::secrets::SecretPatch) -> Result<(), FieldError> {
        for (key, value) in secrets {
            let Some(field) = self.field(key).filter(|f| f.secret) else {
                return Err(FieldError::new(
                    "secrets",
                    "secrets.unknown",
                    format!("{key} is not a secret of {}", self.name),
                )
                .with("name", key));
            };
            if value.as_ref().is_some_and(|v| v.len() > MAX_SECRET_BYTES) {
                return Err(FieldError::new(field.name, "secrets.too_long", format!("{key} is too long")));
            }
        }
        Ok(())
    }
}

/// The settings without the common limit fields, as the plugin sees them.
pub(crate) fn plugin_settings(settings: &Value) -> Value {
    let mut s = settings.clone();
    if let Value::Object(map) = &mut s {
        for f in COMMON_SETTINGS {
            map.remove(f.name);
        }
    }
    s
}

// ---- stored data sources ----

#[derive(Clone, Debug)]
pub struct Datasource {
    pub id: String,
    pub org_id: String,
    pub name: String,
    pub kind: String,
    pub settings: Value,
    pub created_at: i64,
    pub updated_at: i64,
    pub deleted_at: Option<i64>,
}

#[derive(sqlx::FromRow)]
struct DatasourceRow {
    id: String,
    org_id: String,
    name: String,
    kind: String,
    settings: String,
    created_at: i64,
    updated_at: i64,
    deleted_at: Option<i64>,
}

impl TryFrom<DatasourceRow> for Datasource {
    type Error = ApiError;

    fn try_from(r: DatasourceRow) -> Result<Self, ApiError> {
        let settings = serde_json::from_str(&r.settings)
            .map_err(|e| ApiError::internal(&format!("settings of data source {}", r.id), e))?;
        Ok(Self {
            id: r.id,
            org_id: r.org_id,
            name: r.name,
            kind: r.kind,
            settings,
            created_at: r.created_at,
            updated_at: r.updated_at,
            deleted_at: r.deleted_at,
        })
    }
}

const SELECT_DATASOURCE: &str =
    "SELECT id, org_id, name, kind, settings, created_at, updated_at, deleted_at FROM datasources";

fn is_canonical_uuid(id: &str) -> bool {
    uuid::Uuid::parse_str(id).map(|u| u.hyphenated().to_string()).ok().as_deref() == Some(id)
}

/// A data source of `org_id` that is not in the trash. Ids of other organizations, trashed
/// sources and malformed ids are all `not_found`.
pub async fn resolve_in_org<'e, E: sqlx::Executor<'e, Database = sqlx::Any>>(
    db: E,
    org_id: &str,
    datasource_id: &str,
) -> ApiResult<Datasource> {
    find_in_org(db, org_id, datasource_id, false).await
}

/// Like `resolve_in_org`, but `trashed` selects the data sources in the trash instead.
pub(crate) async fn find_in_org<'e, E: sqlx::Executor<'e, Database = sqlx::Any>>(
    db: E,
    org_id: &str,
    datasource_id: &str,
    trashed: bool,
) -> ApiResult<Datasource> {
    if !is_canonical_uuid(datasource_id) {
        return Err(ApiError::not_found());
    }
    let condition = if trashed { "deleted_at IS NOT NULL" } else { "deleted_at IS NULL" };
    let row: Option<DatasourceRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "{SELECT_DATASOURCE} WHERE id = $1 AND org_id = $2 AND {condition}"
    )))
    .bind(datasource_id)
    .bind(org_id)
    .fetch_optional(db)
    .await?;
    row.ok_or_else(ApiError::not_found)?.try_into()
}

// ---- the registry and running queries ----

/// Queries one user may run at the same time; further ones wait (within their timeout).
const MAX_PARALLEL_QUERIES_PER_USER: usize = 8;
/// Queries in one request.
pub const MAX_QUERIES_PER_REQUEST: usize = 50;
/// A pool is rebuilt after this long, so a host name is resolved (and checked) again.
const CONNECTION_REFRESH: Duration = Duration::from_secs(10 * 60);
/// Health checks and schema reads get the query timeout, but never longer than this.
pub(crate) const MAX_HEALTH_TIMEOUT: Duration = Duration::from_secs(30);
/// How long the target rules built from the settings are reused (canonicalized directories).
const POLICY_REFRESH: Duration = Duration::from_secs(60);
/// The range a query may ask for: the years 1 to 9999, as Unix milliseconds.
pub const MIN_TIME_MS: i64 = -62_135_596_800_000;
pub const MAX_TIME_MS: i64 = 253_402_300_799_999;

struct CachedPolicy {
    dirs: Vec<String>,
    allowed: Vec<String>,
    file_dirs: Vec<String>,
    built: Instant,
    policy: Arc<TargetPolicy>,
}

/// The slots a running query holds: one of its user's and one of the server's.
pub struct QuerySlots {
    _user: tokio::sync::OwnedSemaphorePermit,
    _server: tokio::sync::OwnedSemaphorePermit,
}

/// One cache entry. The connection is built once per entry: parallel first queries of a source
/// wait for the same build instead of each opening its own pool and logging in.
struct Cached {
    updated_at: i64,
    policy: Arc<TargetPolicy>,
    built: Instant,
    conn: Arc<OnceCell<Arc<Connection>>>,
}

/// Kalzit's own files outside the data directory that no file or SQLite source may read: the
/// configuration file, the TLS certificate and key and the file of the database URL; and the
/// directories of its secrets (systemd's `$CREDENTIALS_DIRECTORY`).
fn own_files(config: &Config) -> (Vec<std::path::PathBuf>, Vec<std::path::PathBuf>) {
    let files = [
        config.config_file.as_ref(),
        config.tls.cert_file.as_ref(),
        config.tls.key_file.as_ref(),
        config.database_url_file.as_ref(),
    ]
    .into_iter()
    .flatten()
    .cloned()
    .collect();
    let dirs = std::env::var_os("CREDENTIALS_DIRECTORY")
        .filter(|d| !d.is_empty())
        .map(std::path::PathBuf::from)
        .into_iter()
        .collect();
    (files, dirs)
}

/// The data source kinds and the live connections. One per server, in `AppState`.
/// A callback of `DataSources::on_forget`.
pub type ForgetHook = Arc<dyn Fn(&str) + Send + Sync>;

pub struct DataSources {
    kinds: registry::KindRegistry,
    keyring: Arc<Keyring>,
    own: Arc<OwnDatabase>,
    data_dir: std::path::PathBuf,
    database_url: String,
    /// Kalzit's own files and secret directories outside the data directory (`own_files`).
    protected: (Vec<std::path::PathBuf>, Vec<std::path::PathBuf>),
    connections: Mutex<HashMap<String, Cached>>,
    user_slots: Mutex<HashMap<String, Arc<Semaphore>>>,
    /// Queries running at once on the whole server (`datasources.max_parallel_queries`), with the
    /// limit it was built for; a changed setting gets a new semaphore (queries already running
    /// finish on the old one).
    running: Mutex<(usize, Arc<Semaphore>)>,
    /// Result bytes all requests together may hold (`datasources.max_inflight_bytes`); replaced
    /// the same way when the setting changes.
    inflight_bytes: Mutex<(usize, Arc<std::sync::atomic::AtomicUsize>)>,
    policy_cache: Mutex<Option<CachedPolicy>>,
    /// Set by `close`: a connection built after that is closed again instead of handed out.
    closed: std::sync::atomic::AtomicBool,
    /// Plugin kinds organizations blocked, as (organization, kind) (`plugins::host`).
    blocked: std::sync::RwLock<std::collections::HashSet<(String, String)>>,
    /// Called with a data source's id whenever it changes or goes to the trash (`forget`): the
    /// plugin host revokes what plugins were given for it.
    forget_hooks: std::sync::RwLock<Vec<ForgetHook>>,
    /// Answers of read-only queries (`cache`).
    cache: cache::QueryCache,
    /// Setting values for tests, until the settings layers (stream B) can be written to.
    #[cfg(test)]
    pub(crate) test_settings: Mutex<BTreeMap<String, Value>>,
    /// Connections built for the cache, for the single-build test.
    #[cfg(test)]
    pub(crate) connection_builds: std::sync::atomic::AtomicUsize,
}

impl DataSources {
    pub fn new(config: &Config, db: AnyPool, keyring: Arc<Keyring>) -> Self {
        let database_url = config.database_url();
        Self {
            kinds: registry::KindRegistry::built_in(),
            keyring,
            own: Arc::new(OwnDatabase::new(db, &database_url)),
            data_dir: config.paths.data_dir.clone(),
            database_url,
            protected: own_files(config),
            connections: Mutex::new(HashMap::new()),
            user_slots: Mutex::new(HashMap::new()),
            running: Mutex::new((0, Arc::new(Semaphore::new(0)))),
            inflight_bytes: Mutex::new((0, Arc::new(std::sync::atomic::AtomicUsize::new(0)))),
            policy_cache: Mutex::new(None),
            closed: std::sync::atomic::AtomicBool::new(false),
            blocked: std::sync::RwLock::default(),
            forget_hooks: std::sync::RwLock::default(),
            cache: cache::QueryCache::default(),
            #[cfg(test)]
            test_settings: Mutex::new(BTreeMap::new()),
            #[cfg(test)]
            connection_builds: std::sync::atomic::AtomicUsize::new(0),
        }
    }

    /// Every registered kind, built-ins first.
    pub fn kinds(&self) -> Vec<Arc<Kind>> {
        self.kinds.all()
    }

    pub fn kind(&self, kind: &str) -> Option<Arc<Kind>> {
        self.kinds.get(kind)
    }

    /// The kind registry, where installed plugins add their kinds.
    pub fn registry(&self) -> &registry::KindRegistry {
        &self.kinds
    }

    /// A kind as an organization may use it: `None` also when the organization blocked the
    /// plugin that provides it. Its data sources there then answer `datasource.kind_unavailable`.
    pub fn kind_in_org(&self, org_id: &str, kind: &str) -> Option<Arc<Kind>> {
        if self.is_blocked(org_id, kind) {
            return None;
        }
        self.kinds.get(kind)
    }

    /// Whether `org_id` blocked the plugin `kind`.
    pub fn is_blocked(&self, org_id: &str, kind: &str) -> bool {
        let blocked = self.blocked.read().unwrap_or_else(|e| e.into_inner());
        !blocked.is_empty() && blocked.contains(&(org_id.to_string(), kind.to_string()))
    }

    /// Replaces every block (at start).
    pub fn set_blocks(&self, blocks: Vec<(String, String)>) {
        *self.blocked.write().unwrap_or_else(|e| e.into_inner()) = blocks.into_iter().collect();
    }

    pub fn set_blocked(&self, org_id: &str, kind: &str, blocked: bool) {
        let mut set = self.blocked.write().unwrap_or_else(|e| e.into_inner());
        let key = (org_id.to_string(), kind.to_string());
        if blocked {
            set.insert(key);
        } else {
            set.remove(&key);
        }
    }

    pub fn keyring(&self) -> &Keyring {
        &self.keyring
    }

    /// Closes and drops every cached connection (see `AppState::close`).
    pub async fn close(&self) {
        self.closed.store(true, std::sync::atomic::Ordering::SeqCst);
        let cached: Vec<Arc<Connection>> = self
            .connections
            .lock()
            .expect("connection cache lock")
            .drain()
            .filter_map(|(_, c)| c.conn.get().cloned())
            .collect();
        for conn in cached {
            conn.close().await;
        }
    }

    /// Calls `hook` with every data source `forget` drops.
    pub fn on_forget(&self, hook: ForgetHook) {
        self.forget_hooks.write().unwrap_or_else(|e| e.into_inner()).push(hook);
    }

    /// The query cache.
    pub fn query_cache(&self) -> &cache::QueryCache {
        &self.cache
    }

    /// The server-wide cache settings: `Some(limit in bytes)` while the cache is on. Turned off,
    /// it lets go of everything it kept.
    pub async fn cache_limit(&self, state: &AppState) -> ApiResult<Option<usize>> {
        let on = self.setting(state, "datasources.cache_enabled").await?.as_bool().unwrap_or(false);
        if !on {
            if !self.cache.is_empty() {
                self.cache.clear();
            }
            return Ok(None);
        }
        let limit =
            usize::try_from(self.setting_u64(state, "datasources.cache_max_bytes").await?).unwrap_or(usize::MAX);
        self.cache.limit(limit);
        Ok(Some(limit))
    }

    /// Drops the cached connection and the kept answers after the source changed or went to the
    /// trash.
    pub fn forget(&self, datasource_id: &str) {
        self.cache.forget_datasource(datasource_id);
        for hook in self.forget_hooks.read().unwrap_or_else(|e| e.into_inner()).iter() {
            hook(datasource_id);
        }
        let removed = self.connections.lock().expect("connection cache lock").remove(datasource_id);
        // A SQLite pool closes its file now, not whenever the last query holding it ends.
        if let (Some(conn), Ok(rt)) =
            (removed.and_then(|c| c.conn.get().cloned()), tokio::runtime::Handle::try_current())
        {
            rt.spawn(async move { conn.close().await });
        }
    }

    async fn setting(&self, state: &AppState, key: &str) -> ApiResult<Value> {
        #[cfg(test)]
        if let Some(v) = self.test_settings.lock().expect("test settings lock").get(key) {
            return Ok(v.clone());
        }
        crate::settings::get(state, key).await
    }

    async fn setting_strings(&self, state: &AppState, key: &str) -> ApiResult<Vec<String>> {
        let value = self.setting(state, key).await?;
        Ok(value
            .as_array()
            .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
            .unwrap_or_default())
    }

    async fn setting_u64(&self, state: &AppState, key: &str) -> ApiResult<u64> {
        let value = self.setting(state, key).await?;
        value.as_u64().ok_or_else(|| ApiError::internal("settings", format!("{key} is not a whole number")))
    }

    /// The target rules from the current server settings. Reused while the settings are the
    /// same, so the directories are not canonicalized for every query.
    pub async fn policy(&self, state: &AppState) -> ApiResult<Arc<TargetPolicy>> {
        let dirs = self.setting_strings(state, "datasources.sqlite_dirs").await?;
        let allowed = self.setting_strings(state, "datasources.allowed_targets").await?;
        let file_dirs = self.setting_strings(state, "datasources.file_dirs").await?;
        let mut cache = self.policy_cache.lock().expect("policy cache lock");
        if let Some(c) = cache.as_ref()
            && c.dirs == dirs
            && c.allowed == allowed
            && c.file_dirs == file_dirs
            && c.built.elapsed() < POLICY_REFRESH
        {
            return Ok(c.policy.clone());
        }
        let policy = Arc::new(
            TargetPolicy::new(&self.data_dir, &self.database_url, &dirs, &allowed)
                .with_file_dirs(&file_dirs)
                .with_protected(&self.protected.0, &self.protected.1),
        );
        // Changed target rules may block sources that answered before: no kept answer may be
        // served under other rules than it was read under (a new generation, `cache::Stamp`).
        if cache.as_ref().is_some_and(|c| *c.policy != *policy) {
            self.cache.policy_changed();
        }
        *cache = Some(CachedPolicy { dirs, allowed, file_dirs, built: Instant::now(), policy: policy.clone() });
        Ok(policy)
    }

    /// Waits for a slot of the user and one of the server. The caller's timeout covers the wait.
    pub async fn slots(&self, state: &AppState, user_id: &str) -> Result<QuerySlots, SourceError> {
        let limit = self
            .setting_u64(state, "datasources.max_parallel_queries")
            .await
            .map_err(|e| SourceError::failed("internal", e.message))?
            .max(1) as usize;
        let server = {
            let mut running = self.running.lock().expect("running lock");
            if running.0 != limit {
                *running = (limit, Arc::new(Semaphore::new(limit)));
            }
            running.1.clone()
        };
        let closed = |_| SourceError::failed("server.shutting_down", "the server is shutting down");
        let user = self.user_slots(user_id).acquire_owned().await.map_err(closed)?;
        let server = server.acquire_owned().await.map_err(closed)?;
        Ok(QuerySlots { _user: user, _server: server })
    }

    #[cfg(test)]
    pub(crate) fn inflight_available(&self) -> usize {
        self.inflight_bytes.lock().expect("inflight lock").1.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// The limits for one source: its own settings within the server-wide maxima.
    async fn limits(&self, state: &AppState, ds: &Datasource, budget: ResponseBudget) -> ApiResult<Limits> {
        let server_timeout = self.setting_u64(state, "datasources.query_timeout_secs").await?.max(1);
        let server_rows = self.setting_u64(state, "datasources.max_rows").await?.max(1);
        let own = |key: &str| ds.settings.get(key).and_then(Value::as_u64);
        let timeout = own("queryTimeoutSecs").map_or(server_timeout, |t| t.clamp(1, server_timeout));
        let rows = own("maxRows").map_or(server_rows, |r| r.clamp(1, server_rows));
        Ok(Limits { timeout: Duration::from_secs(timeout), max_rows: rows as usize, budget })
    }

    async fn response_budget(&self, state: &AppState) -> ApiResult<ResponseBudget> {
        let max = self.setting_u64(state, "datasources.max_response_bytes").await? as usize;
        let limit = self.setting_u64(state, "datasources.max_inflight_bytes").await? as usize;
        let pool = {
            let mut inflight = self.inflight_bytes.lock().expect("inflight lock");
            if inflight.0 != limit {
                *inflight = (limit, Arc::new(std::sync::atomic::AtomicUsize::new(limit)));
            }
            inflight.1.clone()
        };
        Ok(ResponseBudget::within(max, pool))
    }

    /// The cached connection of a data source, or a new one. Parallel callers that find no
    /// usable entry share one entry and wait for one build; a failed build leaves the entry empty,
    /// so the next caller tries again.
    pub async fn connection(&self, state: &AppState, ds: &Datasource) -> Result<Arc<Connection>, SourceError> {
        let policy = self.policy(state).await.map_err(|e| SourceError::failed("internal", e.message))?;
        let cell = {
            let mut cache = self.connections.lock().expect("connection cache lock");
            match cache.get(&ds.id) {
                Some(c)
                    if c.updated_at == ds.updated_at
                        && *c.policy == *policy
                        && c.built.elapsed() < CONNECTION_REFRESH =>
                {
                    c.conn.clone()
                }
                _ => {
                    let cell = Arc::new(OnceCell::new());
                    let entry = Cached {
                        updated_at: ds.updated_at,
                        policy: policy.clone(),
                        built: Instant::now(),
                        conn: cell.clone(),
                    };
                    cache.insert(ds.id.clone(), entry);
                    cell
                }
            }
        };
        let conn = cell
            .get_or_try_init(|| async {
                #[cfg(test)]
                self.connection_builds.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                self.fresh_connection(state, ds, policy).await
            })
            .await
            .cloned()?;
        // A build that finished after the server began to stop is closed at once: `close` has
        // already gone through the cache. One whose entry was forgotten or replaced meanwhile is
        // used for this query only; dropping it closes its files (`Connection`'s `Drop`).
        if self.closed.load(std::sync::atomic::Ordering::SeqCst) {
            conn.close().await;
            return Err(SourceError::failed("server.shutting_down", "the server is shutting down"));
        }
        Ok(conn)
    }

    /// The cached connection of a data source, if any (tests).
    #[doc(hidden)]
    pub fn cached_connection(&self, datasource_id: &str) -> Option<Arc<Connection>> {
        self.connections.lock().expect("connection cache lock").get(datasource_id).and_then(|c| c.conn.get().cloned())
    }

    /// A connection that is not cached, so "Test connection" never reuses an older pool.
    async fn fresh_connection(
        &self,
        state: &AppState,
        ds: &Datasource,
        policy: Arc<TargetPolicy>,
    ) -> Result<Arc<Connection>, SourceError> {
        let secrets =
            crate::secrets::load_all(&state.db, &self.keyring, &ds.id).await.map_err(|e| secrets_error(&ds.id, e))?;
        Ok(Arc::new(Connection::new(ds.id.clone(), plugin_settings(&ds.settings), secrets, policy, self.own.clone())))
    }

    fn user_slots(&self, user_id: &str) -> Arc<Semaphore> {
        let mut slots = self.user_slots.lock().expect("user slots lock");
        // Forget idle users so the map does not grow with every user ever seen.
        slots.retain(|_, s| Arc::strong_count(s) > 1 || s.available_permits() < MAX_PARALLEL_QUERIES_PER_USER);
        slots
            .entry(user_id.to_string())
            .or_insert_with(|| Arc::new(Semaphore::new(MAX_PARALLEL_QUERIES_PER_USER)))
            .clone()
    }
}

/// `user:password@` between `://` and the next `/` or space becomes `***@`, so a URL that was
/// typed with a login never comes back in a refusal.
pub fn hide_logins(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(i) = rest.find("://") {
        let (head, tail) = rest.split_at(i + 3);
        out.push_str(head);
        let end = tail.find(|c: char| c == '/' || c.is_whitespace()).unwrap_or(tail.len());
        match tail[..end].rfind('@') {
            Some(at) => {
                out.push_str("***@");
                rest = &tail[at + 1..];
            }
            None => rest = tail,
        }
    }
    out.push_str(rest);
    out
}

/// What a failure to read a data source's stored secrets says.
fn secrets_error(datasource_id: &str, e: crate::secrets::LoadError) -> SourceError {
    match e {
        crate::secrets::LoadError::Database(db) => {
            tracing::error!("loading secrets of data source {datasource_id}: {db}");
            SourceError::failed("secrets.unreadable", "the secrets of this data source cannot be read")
        }
        crate::secrets::LoadError::Secret { field, error } => {
            let message = format!("the stored secret {field} {error}; enter it again");
            SourceError::failed("secrets.undecryptable", message).with("field", field)
        }
    }
}

fn outcome_error(code: &str, detail: Detail) -> QueryOutcome {
    QueryOutcome::Err { error: error_body(code, detail) }
}

/// An error code with its detail, as a query outcome or a single-route error carries it.
pub fn error_body(code: &str, detail: Detail) -> ErrorBody {
    ErrorBody {
        code: code.to_string(),
        message: detail.message,
        field: None,
        reason: Some(detail.reason.to_string()),
        params: (!detail.params.is_empty()).then_some(detail.params),
        request_id: None,
        retry_after_secs: None,
    }
}

/// An API error (not found, validation) as a query outcome, with its reason when it has one;
/// `not_found`, `forbidden` and `internal` say everything with their code.
pub fn api_error_body(e: ApiError) -> ErrorBody {
    let (reason, params) = match e.reason {
        Some(r) => (Some(r.code), (!r.params.is_empty()).then_some(r.params)),
        None => (None, None),
    };
    ErrorBody {
        code: e.code.to_string(),
        message: e.message,
        field: e.field.map(str::to_string),
        reason,
        params,
        request_id: e.request_id.map(String::from),
        retry_after_secs: e.retry_after_secs.map(|s| u64::from(s.get())),
    }
}

/// The longest interval a request may ask for: a year.
pub const MAX_INTERVAL_MS: u64 = 365 * 24 * 3_600_000;

/// `intervalMs`, when given, between 1 ms and a year.
pub fn check_interval(interval_ms: Option<u64>) -> ApiResult<()> {
    match interval_ms {
        Some(ms) if !(1..=MAX_INTERVAL_MS).contains(&ms) => {
            Err(ApiError::validation("intervalMs must be 1 ms to one year")
                .with_field("intervalMs")
                .because("query.interval_out_of_range"))
        }
        _ => Ok(()),
    }
}

/// A time range within the years 1 to 9999, `from` not after `to`.
pub fn check_range(range: TimeRange) -> ApiResult<()> {
    let inside = |t: i64| (MIN_TIME_MS..=MAX_TIME_MS).contains(&t);
    if !inside(range.from) || !inside(range.to) {
        return Err(ApiError::validation("timeRange must lie within the years 1 to 9999")
            .with_field("timeRange")
            .because("query.range_out_of_bounds"));
    }
    if range.from > range.to {
        return Err(ApiError::validation("timeRange.from must not be after timeRange.to")
            .with_field("timeRange")
            .because("query.range_reversed"));
    }
    Ok(())
}

/// A bound time as a UTC timestamp; a time outside chrono's range is refused, never bound as
/// NULL.
pub fn bind_time(ms: i64) -> Result<chrono::DateTime<chrono::Utc>, SourceError> {
    chrono::DateTime::from_timestamp_millis(ms).ok_or_else(|| {
        SourceError::rejected("query.time_out_of_range", format!("the time {ms} is out of range")).with("time", ms)
    })
}

/// Checks the shape of a request's queries: 1 to `MAX_QUERIES_PER_REQUEST`, each with a
/// distinct, non-empty `refId`.
pub fn check_items(items: &[QueryItem]) -> ApiResult<()> {
    if items.is_empty() || items.len() > MAX_QUERIES_PER_REQUEST {
        return Err(ApiError::validation(format!("send 1 to {MAX_QUERIES_PER_REQUEST} queries"))
            .with_field("queries")
            .because("query.count")
            .param("max", MAX_QUERIES_PER_REQUEST));
    }
    let mut seen = std::collections::BTreeSet::new();
    for item in items {
        let ref_id = item.ref_id.trim();
        if ref_id.is_empty() || ref_id.chars().count() > 64 || !seen.insert(ref_id) {
            return Err(ApiError::validation("every query needs its own refId of 1 to 64 characters")
                .with_field("queries")
                .because("query.ref_id"));
        }
    }
    Ok(())
}

/// Refuses free queries whose graph steps (`QueryItem::steps`) are not valid: steps of that
/// query, graph steps only. A dashboard's stored steps are not refused as a whole: a step that
/// no longer passes answers its error at the step (`run_queries`).
pub fn check_item_steps(items: &[QueryItem]) -> ApiResult<()> {
    for (i, item) in items.iter().enumerate() {
        query_steps(item).map_err(|e| {
            ApiError::validation(format!("queries[{i}].{e}"))
                .with_field("queries")
                .because("query.steps")
                .param("detail", e)
        })?;
    }
    Ok(())
}

/// The graph steps of a query (`QueryItem::steps`): steps of that query, graph steps only.
pub fn query_steps(item: &QueryItem) -> Result<Vec<crate::analysis::Step>, String> {
    let refs = std::collections::BTreeSet::from([item.ref_id.as_str()]);
    let steps = crate::analysis::check_steps(&item.steps, &refs, "steps")?;
    if let Some(i) = steps.iter().position(|s| !s.kind.is_graph_step()) {
        return Err(format!("steps[{i}]: only graph steps run with the query"));
    }
    Ok(steps)
}

/// The graph steps of a query up to the first one that is not valid, and that one's place with
/// its error: the query still runs with the steps before it.
fn valid_steps(item: &QueryItem) -> (Vec<crate::analysis::Step>, Option<crate::shapes::StepPlace>) {
    let refs = std::collections::BTreeSet::from([item.ref_id.as_str()]);
    let mut steps: Vec<crate::analysis::Step> = Vec::new();
    for (i, raw) in item.steps.iter().enumerate() {
        let checked = crate::analysis::check_steps(std::slice::from_ref(raw), &refs, &format!("steps[{i}]")).and_then(
            |mut one| {
                let step = one.remove(0);
                if !step.kind.is_graph_step() {
                    return Err(format!("steps[{i}]: only graph steps run with the query"));
                }
                if steps.iter().any(|s| s.id == step.id) {
                    return Err(format!("steps[{i}].id {} is used twice", step.id));
                }
                Ok(step)
            },
        );
        match checked {
            Ok(step) => steps.push(step),
            Err(e) => {
                let id = raw.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
                let detail = Detail::new("steps.invalid", format!("the step is not valid: {e}")).with("detail", e);
                let place = crate::shapes::StepPlace {
                    id,
                    ran_in: crate::shapes::RanIn::Server,
                    error: Some(error_body("validation", detail)),
                };
                return (steps, Some(place));
            }
        }
    }
    (steps, None)
}

/// Generated queries a source could not run, by their text, so a refresh does not try them again
/// for a while (an older database without the needed Cypher, a step that is too large for it).
#[derive(Default)]
pub struct PushdownMemo(std::sync::Mutex<HashMap<String, Instant>>);

impl PushdownMemo {
    const FOR: Duration = Duration::from_secs(600);
    const MAX: usize = 256;

    fn refused(&self, query: &Value) -> bool {
        let key = query.to_string();
        let mut map = self.0.lock().unwrap_or_else(|e| e.into_inner());
        match map.get(&key) {
            Some(at) if at.elapsed() < Self::FOR => true,
            Some(_) => {
                map.remove(&key);
                false
            }
            None => false,
        }
    }

    fn remember(&self, query: &Value) {
        let mut map = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if map.len() >= Self::MAX {
            map.clear();
        }
        map.insert(query.to_string(), Instant::now());
    }
}

/// Runs a graph step in the source (`pushed`, the generated query) within `share` of the query's
/// time, and the query as written when the source cannot (an error, a timeout, an answer
/// `accept` refuses); `true` when the step ran in the source. A generated query that failed is
/// not tried again for a while (`memo`).
///
/// `run` gets the time its query may take in the source: `Some(share)` for the generated query,
/// which the source must give up after that time too (a graph source passes it as the
/// transaction timeout), so an abandoned step does not keep running there; `None` for the query
/// as written, which has the query's own time.
pub(crate) async fn with_pushdown<Run, Fut>(
    run: Run,
    pushed: Option<Value>,
    original: Value,
    share: Duration,
    accept: impl Fn(QueryResult) -> Result<QueryResult, Detail>,
    memo: &PushdownMemo,
) -> Result<(QueryResult, bool), SourceError>
where
    Run: Fn(Value, Option<Duration>) -> Fut,
    Fut: Future<Output = Result<QueryResult, SourceError>>,
{
    if let Some(query) = pushed.filter(|q| !memo.refused(q)) {
        let why = match tokio::time::timeout(share, run(query.clone(), Some(share))).await {
            Ok(Ok(result)) => match accept(result) {
                Ok(result) => return Ok((result, true)),
                Err(d) => d.message,
            },
            Ok(Err(e)) => e.detail().message,
            Err(_) => format!("no answer within {} s", share.as_secs()),
        };
        tracing::debug!("graph step not run in the source: {}", scrub(&why, std::iter::empty()));
        memo.remember(&query);
    }
    run(original, None).await.map(|r| (r, false))
}

/// Runs queries in parallel within the caller's concurrency limit and answers per `refId`. One
/// failing query does not fail the others. Data source ids are resolved within the caller's
/// organization; **the caller has already authorized every item** (`datasources:query` for free
/// queries, `dashboards:read` for a dashboard's stored queries).
///
/// Everything runs inside the caller's future, so when the client goes away and the request is
/// dropped, the queries are dropped (cancelled) with it.
pub async fn run_queries(
    state: &AppState,
    ctx: &OrgCtx,
    items: Vec<QueryItem>,
    range: TimeRange,
    interval_ms: Option<u64>,
    max_data_points: Option<u32>,
    variables: &BTreeMap<String, Value>,
) -> QueryResponse {
    run_queries_with(state, ctx, items, range, interval_ms, max_data_points, variables, None).await
}

/// `run_queries`, where only `identifier_variables` may be used as identifiers (a dashboard's
/// stored queries pass the variables whose values the server checked).
#[expect(clippy::too_many_arguments, reason = "the parts of one query request, passed through")]
pub async fn run_queries_with(
    state: &AppState,
    ctx: &OrgCtx,
    items: Vec<QueryItem>,
    range: TimeRange,
    interval_ms: Option<u64>,
    max_data_points: Option<u32>,
    variables: &BTreeMap<String, Value>,
    identifier_variables: Option<&std::collections::BTreeSet<String>>,
) -> QueryResponse {
    let off = cache::CacheUse::off();
    run_queries_cached(state, ctx, items, range, interval_ms, max_data_points, variables, identifier_variables, &off)
        .await
}

/// `run_queries_with`, reading and keeping answers in the query cache as `cache` says (`cache`
/// module; the server setting and each source's own decide whether it applies at all).
#[expect(clippy::too_many_arguments, reason = "the parts of one query request, passed through")]
pub async fn run_queries_cached(
    state: &AppState,
    ctx: &OrgCtx,
    items: Vec<QueryItem>,
    range: TimeRange,
    interval_ms: Option<u64>,
    max_data_points: Option<u32>,
    variables: &BTreeMap<String, Value>,
    identifier_variables: Option<&std::collections::BTreeSet<String>>,
    cache: &cache::CacheUse,
) -> QueryResponse {
    let interval = sql::interval_ms(range, interval_ms, max_data_points);
    let budget = match state.datasources.response_budget(state).await {
        Ok(b) => b,
        Err(e) => {
            let error = api_error_body(e);
            let results = items.into_iter().map(|i| (i.ref_id, QueryOutcome::Err { error: error.clone() })).collect();
            return QueryResponse { results };
        }
    };
    // The server-wide switch and limit, read once per request; when they cannot be read, the
    // queries run without the cache.
    let cache_limit = match cache.mode {
        cache::CacheMode::Off => None,
        _ => state.datasources.cache_limit(state).await.unwrap_or_else(|e| {
            tracing::warn!("query cache settings: {}", e.message);
            None
        }),
    };
    let cache = cache_limit.map(|limit| (cache, limit));
    let run = Run { range, interval_ms: interval, max_data_points, variables, identifier_variables };
    let runs = items.into_iter().map(|item| {
        let budget = budget.clone();
        async move {
            let ref_id = item.ref_id.clone();
            let outcome = run_one(state, ctx, item, run, budget, cache).await;
            (ref_id, outcome)
        }
    });
    QueryResponse { results: futures_util::future::join_all(runs).await.into_iter().collect() }
}

/// The parts of a request every one of its queries runs with.
#[derive(Clone, Copy)]
struct Run<'a> {
    range: TimeRange,
    interval_ms: u64,
    max_data_points: Option<u32>,
    variables: &'a BTreeMap<String, Value>,
    identifier_variables: Option<&'a std::collections::BTreeSet<String>>,
}

async fn run_one(
    state: &AppState,
    ctx: &OrgCtx,
    item: QueryItem,
    run: Run<'_>,
    budget: ResponseBudget,
    cache: Option<(&cache::CacheUse, usize)>,
) -> QueryOutcome {
    let registry = &state.datasources;
    let ds = match resolve_in_org(&state.db, &ctx.org_id, &item.datasource_id).await {
        Ok(ds) => ds,
        Err(e) => return QueryOutcome::Err { error: api_error_body(e) },
    };
    let Some(kind) = registry.kind_in_org(&ds.org_id, &ds.kind) else {
        return outcome_error("datasource_error", kind_unavailable(&ds.kind));
    };
    let mut limits = match registry.limits(state, &ds, budget).await {
        Ok(l) => l,
        Err(e) => return QueryOutcome::Err { error: api_error_body(e) },
    };
    if let Some(limit) = item.limit {
        limits.max_rows = limits.max_rows.min(limit.max(1) as usize);
    }
    // The cache, when the request, the server and the source all use it: the answer kept for
    // this caller, or the key to keep the new one under, with the range it runs with.
    let ttl_ms = cache.and_then(|_| cache::source_ttl_ms(&ds.kind, &ds.settings));
    let (Some((use_, limit)), Some(ttl_ms)) = (cache, ttl_ms) else {
        return execute(state, ctx, &ds, &kind, item, run, limits).await;
    };
    // The current target rules first: a change of them starts a new generation
    // (`DataSources::policy`), so an answer read under the old ones is neither served nor kept.
    if let Err(e) = registry.policy(state).await {
        return QueryOutcome::Err { error: api_error_body(e) };
    }
    let stamp = registry.cache.stamp(&ctx.org_id, &ds.id);
    let now = state.clock.now_ms();
    let range = cache::round_range(run.range, run.interval_ms, ttl_ms, now);
    let caller = cache::Caller {
        org_id: &ctx.org_id,
        user_id: &ctx.user.id,
        role: &ctx.role,
        permissions: ctx.permissions.iter().map(|p| p.as_str()).collect(),
        scope: &use_.scope,
    };
    let key = cache::key(
        &caller,
        &cache::Query {
            datasource_id: &ds.id,
            version: ds.updated_at,
            kind: &ds.kind,
            shapes: kind.plugin.shapes(),
            query: cache::canonical(&item.query),
            steps: item.steps.iter().map(cache::canonical).collect(),
            cursor: item.cursor.as_deref(),
            range,
            interval_ms: run.interval_ms,
            max_data_points: run.max_data_points,
            variables: run.variables,
            identifiers: run.identifier_variables,
            max_rows: limits.max_rows,
        },
    );
    if use_.mode == cache::CacheMode::Use {
        let found = registry.cache.get(&key, stamp, now);
        let served = match found {
            Some(found) => serve_hit(state, ctx, &key, found, &limits).await,
            None => None,
        };
        registry.cache.count(served.is_some());
        if let Some(outcome) = served {
            return outcome;
        }
    }
    let budget = limits.budget.clone();
    let mut outcome = execute(state, ctx, &ds, &kind, item, Run { range, ..run }, limits).await;
    if let QueryOutcome::Ok { result, steps, cache: info } = &mut outcome {
        // A graph step that failed may have run out of time: such an answer is not kept.
        let complete = steps.as_ref().is_none_or(|places| places.iter().all(|p| p.error.is_none()));
        let stored = (&*result, steps.as_ref());
        let kept = complete
            && registry.cache.put(key, (&ctx.org_id, &ctx.user.id), &ds.id, stored, stamp, now, ttl_ms, limit, &budget);
        let status = if use_.mode == cache::CacheMode::Refresh { CacheStatus::Refresh } else { CacheStatus::Miss };
        *info = Some(CacheInfo { status, age_ms: 0, ttl_ms: if kept { ttl_ms as u64 } else { 0 } });
    }
    outcome
}

/// What a hit costs the request: the answer is read only after it got a query slot (hits wait
/// with the other queries of the user and the server) and its bytes were charged against the
/// request's response budget and the server's in-flight pool (`Found::charge`: what it held
/// when it was read, at least twice its stored size). `None` when it does not fit in the
/// query's time or the budget, or no longer reads: then the query runs in its source as a
/// miss, and is cut there as any answer is.
async fn serve_hit(
    state: &AppState,
    ctx: &OrgCtx,
    key: &cache::Key,
    found: cache::Found,
    limits: &Limits,
) -> Option<QueryOutcome> {
    let read = async {
        let _slots = state.datasources.slots(state, &ctx.user.id).await.ok()?;
        if !limits.budget.take(found.charge()) {
            return None;
        }
        let stored = found.parse();
        if stored.is_none() {
            state.datasources.cache.remove(key);
        }
        stored
    };
    let cache::Stored { result, steps } = tokio::time::timeout(limits.timeout, read).await.ok()??;
    Some(QueryOutcome::Ok { result, steps, cache: Some(found.info) })
}

/// Runs one query in its source (and its graph steps), without the cache.
async fn execute(
    state: &AppState,
    ctx: &OrgCtx,
    ds: &Datasource,
    kind: &Kind,
    item: QueryItem,
    run: Run<'_>,
    limits: Limits,
) -> QueryOutcome {
    let registry = &state.datasources;
    let Run { range, interval_ms, max_data_points, variables, identifier_variables } = run;
    let timeout = limits.timeout;
    let started = Instant::now();
    // The valid graph steps; the first may run in the source.
    let (steps, invalid) = valid_steps(&item);
    let first = steps.iter().find(|s| !s.disabled);
    let max_rows = limits.max_rows;
    let pushed = first.and_then(|s| kind.plugin.pushdown(&item.query, &s.kind, max_rows));
    let run = async {
        // Waiting for a free slot counts against the query's own timeout.
        let _slots = registry.slots(state, &ctx.user.id).await?;
        let conn = registry.connection(state, ds).await?;
        let request = |query: Value, time: Option<Duration>| SourceQuery {
            ref_id: item.ref_id.clone(),
            query,
            range,
            interval_ms,
            max_data_points,
            variables: variables.clone(),
            identifier_variables: identifier_variables.cloned(),
            limits: Limits { timeout: time.unwrap_or(limits.timeout), ..limits.clone() },
            cursor: item.cursor.clone(),
        };
        // The source gets half the time for a graph step, so the query as written still has time.
        let result = with_pushdown(
            |query, time| kind.plugin.query(&conn, request(query, time)),
            pushed.clone(),
            item.query.clone(),
            timeout / 2,
            |result| match first {
                Some(step) => crate::analysis::pushdown::normalize(&step.kind, result, max_rows),
                None => Ok(result),
            },
            &conn.pushdown,
        )
        .await;
        Ok::<_, SourceError>((conn, result))
    };
    let outcome = tokio::time::timeout(timeout, run).await;
    match outcome {
        Err(_) => outcome_error("query_timeout", SourceError::Timeout(timeout.as_secs()).detail()),
        Ok(Err(e)) => outcome_error(e.code(), e.detail().scrubbed(|t| scrub(t, std::iter::empty()))),
        Ok(Ok((_, Ok((result, in_source))))) => {
            tracing::debug!(datasource = %ds.id, ref_id = %item.ref_id, ms = started.elapsed().as_millis() as u64, "query done");
            if steps.is_empty() && invalid.is_none() {
                return QueryOutcome::Ok { result, steps: None, cache: None };
            }
            let left = timeout.saturating_sub(started.elapsed()).as_secs().max(1);
            let name = item.ref_id.clone();
            let ran =
                tokio::task::spawn_blocking(move || graph_steps_on_server(&steps, &name, result, in_source, left))
                    .await;
            match ran {
                Ok((result, mut places)) => {
                    // A stored step that is no longer valid says so; the steps before it ran.
                    if let Some(place) = invalid
                        && places.iter().all(|p| p.error.is_none())
                    {
                        places.push(place);
                    }
                    QueryOutcome::Ok { result, steps: Some(places), cache: None }
                }
                Err(e) => outcome_error("internal", Detail::new("steps.failed", e.to_string())),
            }
        }
        Ok(Ok((conn, Err(e)))) => {
            let detail = e.detail().scrubbed(|t| conn.scrub(t));
            tracing::debug!(datasource = %ds.id, code = e.code(), reason = detail.reason, "query failed: {}", detail.message);
            outcome_error(e.code(), detail)
        }
    }
}

/// The graph steps of one query after it answered: the first already ran in the source when
/// `in_source`; the others run here one by one. A failing step keeps the result before it and
/// says why; the steps after it do not run.
fn graph_steps_on_server(
    steps: &[crate::analysis::Step],
    name: &str,
    mut result: QueryResult,
    in_source: bool,
    timeout_secs: u64,
) -> (QueryResult, Vec<crate::shapes::StepPlace>) {
    use crate::shapes::{RanIn, StepPlace};
    let control = crate::analysis::steps::Control::new(
        std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
        timeout_secs,
    );
    let mut places = Vec::new();
    let mut enabled = steps.iter().filter(|s| !s.disabled);
    if in_source && let Some(first) = enabled.next() {
        places.push(StepPlace { id: first.id.clone(), ran_in: RanIn::Database, error: None });
    }
    for step in enabled {
        // Each step reads the graph as the one before left it; a failure keeps that graph.
        let ran = match &result {
            QueryResult::Graph { graph } => crate::analysis::graph::apply(&step.kind, graph, &control),
            _ => Err(Detail::new("steps.not_graph", format!("the result {name} is no graph")).with("frame", name)),
        };
        match ran {
            Ok(crate::analysis::graph::GraphOut::Graph(graph)) => result = QueryResult::Graph { graph },
            Ok(crate::analysis::graph::GraphOut::Frame(frame)) => result = QueryResult::Frame { frame },
            Err(detail) => {
                let error = error_body("validation", detail);
                places.push(StepPlace { id: step.id.clone(), ran_in: RanIn::Server, error: Some(error) });
                break;
            }
        }
        places.push(StepPlace { id: step.id.clone(), ran_in: RanIn::Server, error: None });
    }
    (result, places)
}

/// Opens the change feed of one query for live updates (`DataSourcePlugin::watch`), with the
/// same resolution, limits and target rules as running it. `Ok(None)` when the source cannot
/// report changes. **The caller has already authorized the item**, as for `run_queries`.
#[expect(clippy::too_many_arguments, reason = "the parts of one query request, passed through")]
pub async fn watch_item(
    state: &AppState,
    ctx: &OrgCtx,
    item: &QueryItem,
    range: TimeRange,
    interval_ms: Option<u64>,
    max_data_points: Option<u32>,
    variables: &BTreeMap<String, Value>,
    identifier_variables: Option<&std::collections::BTreeSet<String>>,
    resume: Option<ResumeToken>,
) -> Result<Option<ChangeFeed>, Box<ErrorBody>> {
    let registry = &state.datasources;
    let ds =
        resolve_in_org(&state.db, &ctx.org_id, &item.datasource_id).await.map_err(|e| Box::new(api_error_body(e)))?;
    let Some(kind) = registry.kind_in_org(&ds.org_id, &ds.kind) else { return Ok(None) };
    let budget = registry.response_budget(state).await.map_err(|e| Box::new(api_error_body(e)))?;
    let mut limits = registry.limits(state, &ds, budget).await.map_err(|e| Box::new(api_error_body(e)))?;
    if let Some(limit) = item.limit {
        limits.max_rows = limits.max_rows.min(limit.max(1) as usize);
    }
    let timeout = limits.timeout;
    let open = async {
        let conn = registry.connection(state, &ds).await?;
        let req = SourceQuery {
            ref_id: item.ref_id.clone(),
            query: item.query.clone(),
            range,
            interval_ms: sql::interval_ms(range, interval_ms, max_data_points),
            max_data_points,
            variables: variables.clone(),
            identifier_variables: identifier_variables.cloned(),
            limits,
            cursor: None,
        };
        let feed = kind.plugin.watch(&conn, req, resume).await;
        Ok::<_, SourceError>((conn, feed))
    };
    match tokio::time::timeout(timeout, open).await {
        Err(_) => Err(Box::new(error_body("query_timeout", SourceError::Timeout(timeout.as_secs()).detail()))),
        Ok(Err(e)) => Err(Box::new(error_body(e.code(), e.detail().scrubbed(|t| scrub(t, std::iter::empty()))))),
        Ok(Ok((_, Ok(feed)))) => Ok(feed),
        Ok(Ok((conn, Err(e)))) => Err(Box::new(error_body(e.code(), e.detail().scrubbed(|t| conn.scrub(t))))),
    }
}

/// The kind of a stored source is not available: not registered (a removed or disabled plugin)
/// or blocked for the source's organization.
pub fn kind_unavailable(kind: &str) -> Detail {
    Detail::new("datasource.kind_unavailable", format!("the data source kind {kind} is not available"))
        .with("kind", kind)
}

pub fn kind_unavailable_error(kind: &str) -> ApiError {
    let detail = kind_unavailable(kind);
    ApiError::new(StatusCode::BAD_GATEWAY, "datasource_error", detail.message).with_reason(detail.reason, detail.params)
}

/// The source error as an API error, scrubbed of the connection's secrets.
pub fn api_error(e: SourceError, conn: Option<&Connection>) -> ApiError {
    let detail = match conn {
        Some(c) => e.detail().scrubbed(|t| c.scrub(t)),
        None => e.detail().scrubbed(|t| scrub(t, std::iter::empty())),
    };
    ApiError::new(e.status(), e.code(), detail.message).with_reason(detail.reason, detail.params)
}

/// "Test connection": `ok`, a `reason` code the UI translates with its `params` (`engine`,
/// `version`, or what failed), the English `message` as fallback, the latency, and the error
/// code when it failed.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthReport {
    pub ok: bool,
    pub reason: &'static str,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub params: BTreeMap<String, String>,
    pub message: String,
    pub latency_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<&'static str>,
    /// What works but needs attention (`Health::warnings`); the test still passed.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<HealthWarning>,
}

/// One warning of "Test connection": a `reason` code the UI translates with its `params`, and
/// the English `message` as fallback.
#[derive(Debug, Serialize)]
pub struct HealthWarning {
    pub reason: &'static str,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub params: BTreeMap<String, String>,
    pub message: String,
}

fn health_warnings(health: &Health, conn: &Connection) -> Vec<HealthWarning> {
    health
        .warnings
        .iter()
        .map(|w| {
            let w = w.clone().scrubbed(|t| conn.scrub(t));
            HealthWarning { reason: w.reason, params: w.params, message: w.message }
        })
        .collect()
}

/// The target checks that need no network: the SQLite path, and the `host` or `url` setting
/// when it is an address literal or the allow-list decides by name. Answers the field at fault.
pub fn precheck_targets(
    policy: &TargetPolicy,
    kind: &Kind,
    settings: &Value,
) -> Result<(), (targets::Blocked, &'static str)> {
    if kind.kind() == "sqlite"
        && let Some(path) = settings.get("path").and_then(Value::as_str)
    {
        policy.check_sqlite_path(path).map_err(|b| (b, "path"))?;
    }
    if kind.kind() == "file"
        && let Some(path) = settings.get("path").and_then(Value::as_str)
    {
        policy.check_file_path(path).map_err(|b| (b, "path"))?;
    }
    if let Some(host) = settings.get("host").and_then(Value::as_str) {
        policy.precheck_host(host).map_err(|b| (b, "host"))?;
    }
    for host in settings.get("hosts").and_then(Value::as_str).map(mongodb::host_names).unwrap_or_default() {
        policy.precheck_host(&host).map_err(|b| (b, "hosts"))?;
    }
    for field in ["url", "restppUrl"] {
        let url_host = settings
            .get(field)
            .and_then(Value::as_str)
            .and_then(|u| reqwest::Url::parse(u).ok())
            .and_then(|u| u.host_str().map(String::from));
        if let Some(host) = url_host {
            policy.precheck_host(&host).map_err(|b| (b, field))?;
        }
    }
    Ok(())
}

/// The kind's checks on the source itself before settings or secrets are saved
/// (`DataSourcePlugin::check_on_save`): `settings` as they will be stored, the stored secrets of
/// `datasource_id` (when it exists) with `patch` applied. A refused target answers
/// `datasource_target_blocked`, any other refusal `validation`, both naming the field.
pub async fn check_on_save(
    state: &AppState,
    kind: &Kind,
    datasource_id: Option<&str>,
    settings: &Value,
    patch: &crate::secrets::SecretPatch,
) -> ApiResult<()> {
    if !kind.plugin.checks_on_save() {
        return Ok(());
    }
    let registry = &state.datasources;
    let mut secrets = match datasource_id {
        // Unreadable secrets are reported when connecting; the save itself may replace them.
        Some(id) => crate::secrets::load_all(&state.db, &registry.keyring, id).await.unwrap_or_default(),
        None => BTreeMap::new(),
    };
    for (field, value) in patch {
        match value {
            Some(v) => secrets.insert(field.clone(), v.clone()),
            None => secrets.remove(field),
        };
    }
    let policy = registry.policy(state).await?;
    let id = datasource_id.unwrap_or("new");
    let conn = Connection::new(id, plugin_settings(settings), secrets, policy, registry.own.clone());
    let check = tokio::time::timeout(MAX_HEALTH_TIMEOUT, kind.plugin.check_on_save(&conn)).await;
    match check {
        Ok(Err((field, e))) => {
            let detail = e.detail().scrubbed(|t| conn.scrub(t));
            Err(match e {
                SourceError::Blocked(_) => ApiError::new(StatusCode::UNPROCESSABLE_ENTITY, e.code(), detail.message),
                _ => ApiError::validation(detail.message),
            }
            .with_field(field)
            .with_reason(detail.reason, detail.params))
        }
        Ok(Ok(())) | Err(_) => Ok(()),
    }
}

/// "Test connection" with the cached connection, counted against the caller's query slots.
pub async fn check_health(state: &AppState, user_id: &str, ds: &Datasource) -> ApiResult<HealthReport> {
    let report = run_health(state, user_id, ds).await?;
    store_last_test(&state.db, &ds.id, &report, state.clock.now_ms()).await;
    Ok(report)
}

/// The last "Test connection" of a stored data source, as `datasource_health` keeps it: whether
/// it passed, its warnings and when it ran (Unix milliseconds).
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LastTest {
    pub ok: bool,
    /// `{reason, params?, message}` each, as in `HealthReport::warnings`.
    pub warnings: Vec<Value>,
    pub tested_at: i64,
}

/// Keeps a test's outcome for the data source page. A failure to write only loses the note (the
/// source may have been deleted meanwhile), so it is logged, not answered.
async fn store_last_test(db: &AnyPool, datasource_id: &str, report: &HealthReport, at: i64) {
    let warnings = serde_json::to_string(&report.warnings).unwrap_or_else(|_| "[]".into());
    let stored = sqlx::query(
        "INSERT INTO datasource_health (datasource_id, ok, warnings, tested_at) VALUES ($1, $2, $3, $4) \
         ON CONFLICT (datasource_id) DO UPDATE SET ok = excluded.ok, warnings = excluded.warnings, \
         tested_at = excluded.tested_at",
    )
    .bind(datasource_id)
    .bind(i64::from(report.ok))
    .bind(warnings)
    .bind(at)
    .execute(db)
    .await;
    if let Err(e) = stored {
        tracing::warn!("could not keep the connection test of data source {datasource_id}: {e}");
    }
}

/// The stored last test of a data source, if one ran since its settings or secrets last changed.
pub async fn last_test(conn: &mut sqlx::AnyConnection, datasource_id: &str) -> ApiResult<Option<LastTest>> {
    let row: Option<(i64, String, i64)> =
        sqlx::query_as("SELECT ok, warnings, tested_at FROM datasource_health WHERE datasource_id = $1")
            .bind(datasource_id)
            .fetch_optional(&mut *conn)
            .await?;
    Ok(row.map(|(ok, warnings, tested_at)| LastTest {
        ok: ok != 0,
        warnings: serde_json::from_str::<Vec<Value>>(&warnings).unwrap_or_default(),
        tested_at,
    }))
}

/// Drops the stored last test: after the settings or secrets changed it no longer applies.
pub async fn forget_last_test(conn: &mut sqlx::AnyConnection, datasource_id: &str) -> ApiResult<()> {
    sqlx::query("DELETE FROM datasource_health WHERE datasource_id = $1")
        .bind(datasource_id)
        .execute(&mut *conn)
        .await?;
    Ok(())
}

async fn run_health(state: &AppState, user_id: &str, ds: &Datasource) -> ApiResult<HealthReport> {
    let registry = &state.datasources;
    let kind = registry.kind_in_org(&ds.org_id, &ds.kind).ok_or_else(|| kind_unavailable_error(&ds.kind))?;
    let budget = registry.response_budget(state).await?;
    let timeout = registry.limits(state, ds, budget).await?.timeout.min(MAX_HEALTH_TIMEOUT);
    let started = Instant::now();
    let failed = |e: SourceError, conn: Option<&Connection>| {
        let detail = match conn {
            Some(c) => e.detail().scrubbed(|t| c.scrub(t)),
            None => e.detail(),
        };
        HealthReport {
            ok: false,
            reason: detail.reason,
            params: detail.params,
            message: detail.message,
            latency_ms: started.elapsed().as_millis() as u64,
            code: Some(e.code()),
            warnings: Vec::new(),
        }
    };
    let policy = registry.policy(state).await?;
    // The plugin's health answer has no error code, so a target refused by the rules is
    // reported as such before the plugin runs.
    if let Err((blocked, _)) = precheck_targets(&policy, &kind, &ds.settings) {
        return Ok(failed(blocked.into(), None));
    }
    let run = async {
        let _slots = registry.slots(state, user_id).await?;
        let conn = registry.connection(state, ds).await?;
        let health = kind.plugin.health(&conn).await;
        Ok::<_, SourceError>((conn, health))
    };
    let (conn, health) = match tokio::time::timeout(timeout, run).await {
        Ok(Ok(done)) => done,
        Ok(Err(e)) => return Ok(failed(e, None)),
        Err(_) => return Ok(failed(SourceError::Timeout(timeout.as_secs()), None)),
    };
    if !health.ok {
        // The next query should not reuse a pool that just failed.
        registry.forget(&ds.id);
    }
    let warnings = health_warnings(&health, &conn);
    let detail = health.detail.scrubbed(|t| conn.scrub(t));
    Ok(HealthReport {
        ok: health.ok,
        reason: detail.reason,
        params: detail.params,
        message: detail.message,
        latency_ms: started.elapsed().as_millis() as u64,
        code: if health.ok { None } else { Some(health.code.unwrap_or("datasource_error")) },
        warnings,
    })
}

/// "Test connection" for settings that are not stored (the add and edit forms): the same checks
/// and the same health probe as a stored source gets, on a connection that is used once and not
/// cached. `settings` are the ones to test, `patch` the secrets typed in the form on top of the
/// stored ones of `datasource_id` (an edit; a new source has none). Nothing is written, nothing
/// of it is logged; messages are scrubbed of the secrets like everywhere else. The target rules
/// (private networks, Kalzit's own database, file folders) are the ones saving applies.
pub async fn check_unsaved(
    state: &AppState,
    user_id: &str,
    kind: &Kind,
    datasource_id: Option<&str>,
    settings: &Value,
    patch: &crate::secrets::SecretPatch,
) -> ApiResult<HealthReport> {
    let registry = &state.datasources;
    let server_timeout = registry.setting_u64(state, "datasources.query_timeout_secs").await?.max(1);
    let own = settings.get("queryTimeoutSecs").and_then(Value::as_u64);
    let timeout =
        Duration::from_secs(own.map_or(server_timeout, |t| t.clamp(1, server_timeout))).min(MAX_HEALTH_TIMEOUT);
    let started = Instant::now();
    let report = |ok: bool, detail: Detail, code: Option<&'static str>| HealthReport {
        ok,
        reason: detail.reason,
        params: detail.params,
        message: detail.message,
        latency_ms: started.elapsed().as_millis() as u64,
        code,
        warnings: Vec::new(),
    };
    let policy = registry.policy(state).await?;
    if let Err((blocked, _)) = precheck_targets(&policy, kind, settings) {
        let e: SourceError = blocked.into();
        let mut detail = e.detail();
        detail.message = hide_logins(&detail.message);
        return Ok(report(false, detail, Some(e.code())));
    }
    let mut secrets = match datasource_id {
        Some(id) => match crate::secrets::load_all(&state.db, &registry.keyring, id).await {
            Ok(secrets) => secrets,
            Err(e) => {
                let e = secrets_error(id, e);
                return Ok(report(false, e.detail(), Some(e.code())));
            }
        },
        None => BTreeMap::new(),
    };
    for (field, value) in patch {
        match value {
            Some(v) => secrets.insert(field.clone(), v.clone()),
            None => secrets.remove(field),
        };
    }
    let conn = Arc::new(Connection::new(
        // Never the stored id (nothing cached under it may be touched) and never a shared one.
        format!("unsaved-{}", uuid::Uuid::now_v7()),
        plugin_settings(settings),
        secrets,
        policy,
        registry.own.clone(),
    ));
    let run = async {
        let _slots = registry.slots(state, user_id).await?;
        if kind.plugin.checks_on_save()
            && let Err((_, e)) = kind.plugin.check_on_save(&conn).await
        {
            return Err(e);
        }
        Ok::<_, SourceError>(kind.plugin.health(&conn).await)
    };
    let outcome = tokio::time::timeout(timeout, run).await;
    // The probe's SQLite pool is closed before the answer, not dropped: a dropped pool closes
    // its connections later, in the background, and until then the file stays open (on Windows
    // it cannot be moved or deleted).
    conn.close().await;
    let health = match outcome {
        Ok(Ok(health)) => health,
        Ok(Err(e)) => {
            let detail = e.detail().scrubbed(|t| conn.scrub(t));
            return Ok(report(false, detail, Some(e.code())));
        }
        Err(_) => {
            let e = SourceError::Timeout(timeout.as_secs());
            return Ok(report(false, e.detail(), Some(e.code())));
        }
    };
    let warnings = health_warnings(&health, &conn);
    let detail = health.detail.scrubbed(|t| conn.scrub(t));
    let code = if health.ok { None } else { Some(health.code.unwrap_or("datasource_error")) };
    Ok(HealthReport { warnings, ..report(health.ok, detail, code) })
}

/// The schema for query editors, counted against the caller's query slots.
pub async fn read_schema(state: &AppState, user_id: &str, ds: &Datasource) -> ApiResult<SourceSchema> {
    let registry = &state.datasources;
    let kind = registry.kind_in_org(&ds.org_id, &ds.kind).ok_or_else(|| kind_unavailable_error(&ds.kind))?;
    let budget = registry.response_budget(state).await?;
    let timeout = registry.limits(state, ds, budget).await?.timeout;
    let run = async {
        let _slots = registry.slots(state, user_id).await?;
        let conn = registry.connection(state, ds).await?;
        let schema = kind.plugin.schema(&conn).await;
        Ok::<_, SourceError>((conn, schema))
    };
    match tokio::time::timeout(timeout, run).await {
        Err(_) => Err(api_error(SourceError::Timeout(timeout.as_secs()), None)),
        Ok(Err(e)) => Err(api_error(e, None)),
        Ok(Ok((conn, Err(e)))) => Err(api_error(e, Some(&conn))),
        Ok(Ok((_, Ok(schema)))) => Ok(schema),
    }
}

// ---- helpers shared by the built-in kinds ----

/// Host names and address literals; no user info, paths, ports or spaces.
pub fn check_host(field: &'static str, host: &str) -> Result<(), FieldError> {
    let ok = targets::parse_ip_literal(host).is_some() || targets::is_host_name(host);
    if ok {
        Ok(())
    } else if host.contains('@') {
        Err(FieldError::new(
            field,
            "settings.host_credentials",
            "the host must not contain credentials; use the user and password fields",
        ))
    } else {
        Err(FieldError::new(
            field,
            "settings.host_invalid",
            "the host must be a host name or an IP address, without port or path",
        ))
    }
}

pub fn check_port(field: &'static str, port: Option<u64>) -> Result<(), FieldError> {
    match port {
        Some(p) if !(1..=65535).contains(&p) => {
            Err(FieldError::new(field, "settings.port_invalid", "the port must be 1 to 65535"))
        }
        _ => Ok(()),
    }
}

/// A PEM certificate field, if set, must hold at least one certificate.
pub fn check_pem(field: &'static str, pem: Option<&str>) -> Result<(), FieldError> {
    match pem {
        Some(p) if !p.trim().is_empty() && !p.contains("-----BEGIN CERTIFICATE-----") => Err(FieldError::new(
            field,
            "settings.pem_invalid",
            "the CA certificate must be in PEM format (-----BEGIN CERTIFICATE-----)",
        )),
        _ => Ok(()),
    }
}

/// For drivers that must connect by name (strict TLS modes): resolves and checks the name again
/// right before each new pooled connection, as an error the driver hands back.
pub async fn recheck_name(policy: &TargetPolicy, host: &str, port: u16) -> Result<(), sqlx::Error> {
    match policy.resolve_all(host, port).await {
        Ok(_) => Ok(()),
        Err(targets::ResolveError::Blocked(b)) => Err(sqlx::Error::Configuration(Box::new(b))),
        Err(other) => Err(sqlx::Error::Configuration(other.to_string().into())),
    }
}

/// Unix milliseconds from a UTC date and time.
pub fn naive_to_ms(t: chrono::NaiveDateTime) -> i64 {
    t.and_utc().timestamp_millis()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame_of(label: &str) -> QueryResult {
        let field = crate::shapes::Field {
            name: "x".into(),
            field_type: crate::shapes::FieldType::String,
            unit: None,
            values: vec![serde_json::json!(label)],
            labels: None,
        };
        QueryResult::Frame { frame: crate::shapes::Frame::new(vec![field]).unwrap() }
    }

    /// A graph step the source does not answer in its share of the time runs on the server
    /// instead, within the query's time; a source that failed is not asked again for a while.
    #[tokio::test]
    async fn a_slow_or_failing_pushdown_falls_back_and_is_remembered() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let memo = PushdownMemo::default();
        let pushed_runs = AtomicUsize::new(0);
        let share = Duration::from_millis(50);
        let run = |q: Value, time: Option<Duration>| {
            let pushed = q == serde_json::json!("pushed");
            // The source is told to give up a pushed step after its share, not the whole time.
            assert_eq!(time, pushed.then_some(share));
            if pushed {
                pushed_runs.fetch_add(1, Ordering::SeqCst);
            }
            async move {
                if pushed {
                    tokio::time::sleep(Duration::from_secs(5)).await;
                    Ok(frame_of("database"))
                } else {
                    Ok(frame_of("as written"))
                }
            }
        };
        let started = Instant::now();
        let pushed = Some(serde_json::json!("pushed"));
        let original = serde_json::json!("original");
        let (result, in_source) = with_pushdown(run, pushed.clone(), original.clone(), share, Ok, &memo).await.unwrap();
        assert!(!in_source);
        assert_eq!(result, frame_of("as written"));
        assert!(started.elapsed() < Duration::from_secs(2), "the fallback did not wait for the source");
        // Not tried again: the next refresh runs the query as written at once.
        let (_, in_source) = with_pushdown(run, pushed.clone(), original.clone(), share, Ok, &memo).await.unwrap();
        assert!(!in_source);
        assert_eq!(pushed_runs.load(Ordering::SeqCst), 1);
        // An answer the step refuses (too many pairs) falls back too.
        let memo = PushdownMemo::default();
        let fast = |q: Value, _: Option<Duration>| async move {
            Ok(frame_of(if q == serde_json::json!("pushed") { "db" } else { "as written" }))
        };
        let refuse = |_: QueryResult| Err(Detail::new("steps.too_many_cells", "too many"));
        let (result, in_source) =
            with_pushdown(fast, pushed.clone(), original.clone(), share, refuse, &memo).await.unwrap();
        assert_eq!((result, in_source), (frame_of("as written"), false));
        let (result, in_source) =
            with_pushdown(fast, pushed, original, share, Ok, &PushdownMemo::default()).await.unwrap();
        assert_eq!((result, in_source), (frame_of("db"), true));
    }

    /// A stored step that no longer passes the checks does not refuse its query: the steps
    /// before it run, and it answers its error.
    #[test]
    fn an_invalid_stored_step_stops_there() {
        let item = QueryItem {
            ref_id: "A".into(),
            datasource_id: "d".into(),
            query: serde_json::json!({}),
            cursor: None,
            limit: None,
            steps: vec![
                serde_json::json!({ "id": "a", "type": "countLabels", "frame": "A" }),
                serde_json::json!({ "id": "b", "type": "topDegree", "frame": "A", "n": 0 }),
                serde_json::json!({ "id": "c", "type": "countLabels", "frame": "A" }),
            ],
        };
        let (steps, invalid) = valid_steps(&item);
        assert_eq!(steps.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), ["a"]);
        let invalid = invalid.unwrap();
        assert_eq!(invalid.id, "b");
        assert_eq!(invalid.error.unwrap().reason.as_deref(), Some("steps.invalid"));
        assert!(query_steps(&item).is_err(), "a free query is refused as a whole");
    }

    /// TLS paths written relative in `kalzit.toml` are resolved against the file's folder before
    /// they are compared, so the files the server serves are the ones refused.
    #[test]
    fn relative_tls_paths_from_the_configuration_are_protected() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("etc");
        std::fs::create_dir_all(folder.join("certs")).unwrap();
        for f in ["certs/cert.pem", "certs/key.pem"] {
            std::fs::write(folder.join(f), b"").unwrap();
        }
        let file = folder.join("kalzit.toml");
        std::fs::write(&file, "[tls]\ncert_file = \"certs/cert.pem\"\nkey_file = \"certs/key.pem\"\n").unwrap();
        let config = Config::from_file(Some(&file), Vec::<(String, String)>::new()).unwrap();
        let (files, _) = own_files(&config);
        assert!(files.contains(&std::path::absolute(&file).unwrap()), "{files:?}");
        assert!(files.contains(&folder.join("certs/key.pem")), "{files:?}");
        assert!(files.contains(&folder.join("certs/cert.pem")), "{files:?}");
        let allowed = folder.to_string_lossy().to_string();
        let policy =
            TargetPolicy::new(&dir.path().join("data"), "sqlite::memory:", std::slice::from_ref(&allowed), &[])
                .with_file_dirs(&[allowed])
                .with_protected(&files, &[]);
        for f in ["kalzit.toml", "certs/key.pem", "certs/cert.pem"] {
            let path = folder.join(f).to_string_lossy().to_string();
            assert!(policy.check_sqlite_path(&path).is_err(), "{f}");
            assert!(policy.check_file_path(&path).is_err(), "{f}");
        }
    }

    #[test]
    fn scrub_removes_secrets_in_every_form() {
        let secret = "s3cr3t+Grün/1";
        let text = format!(
            "auth failed for {secret}; url=postgres://u:{}@h/db; header=Basic {}; Password=hunter2;Server=x",
            percent_encode(secret),
            base64::engine::general_purpose::STANDARD.encode(secret)
        );
        let out = scrub(&text, [secret]);
        assert!(!out.contains("s3cr3t"), "{out}");
        assert!(!out.contains(&base64::engine::general_purpose::STANDARD.encode(secret)), "{out}");
        assert!(!out.contains("hunter2"), "{out}");
        assert!(out.contains("Password=***;Server=x"), "{out}");
        assert_eq!(
            scrub("nichts Geheimes, pwd ohne Gleichheitszeichen", ["x".repeat(0).as_str()]),
            "nichts Geheimes, pwd ohne Gleichheitszeichen"
        );
        let long = "ä".repeat(MAX_ERROR_CHARS + 10);
        assert_eq!(scrub(&long, []).chars().count(), MAX_ERROR_CHARS + 3);
    }

    #[test]
    fn settings_are_checked_against_the_form() {
        let kind = postgres::kind();
        let ok = kind
            .validate_settings(&serde_json::json!({
                "host": "db.intern", "port": 5432, "database": "shop", "user": "leser", "sslMode": "require",
                "maxRows": 500, "caCert": null
            }))
            .unwrap();
        assert!(ok.get("caCert").is_none(), "null means not set");
        let bad = |v: Value| kind.validate_settings(&v).unwrap_err();
        assert_eq!(
            bad(serde_json::json!({ "host": "h", "database": "d", "user": "u", "password": "x" })).field,
            "password"
        );
        assert_eq!(bad(serde_json::json!({ "host": "h", "database": "d", "user": "u", "wer": 1 })).field, "settings");
        assert_eq!(bad(serde_json::json!({ "database": "d", "user": "u" })).field, "host");
        assert_eq!(bad(serde_json::json!({ "host": "h", "database": "d", "user": "u", "port": "5432" })).field, "port");
        assert_eq!(
            bad(serde_json::json!({ "host": "h", "database": "d", "user": "u", "sslMode": "egal" })).field,
            "sslMode"
        );
        assert_eq!(bad(serde_json::json!({ "host": "u:p@h", "database": "d", "user": "u" })).field, "host");
        assert_eq!(
            bad(serde_json::json!({ "host": "h", "database": "d", "user": "u", "queryTimeoutSecs": 0 })).field,
            "queryTimeoutSecs"
        );
        assert_eq!(bad(serde_json::json!([])).field, "settings");
        let secrets: crate::secrets::SecretPatch =
            [("token".to_string(), Some(zeroize::Zeroizing::new("x".to_string())))].into();
        assert_eq!(kind.validate_secrets(&secrets).unwrap_err().field, "secrets");
    }

    #[test]
    fn every_url_setting_is_prechecked() {
        let policy = TargetPolicy::new(&std::env::temp_dir().join("kalzit-none"), "sqlite::memory:", &[], &[]);
        let kind = tigergraph::kind();
        let ok = serde_json::json!({ "url": "http://tg.intern:14240", "graph": "g", "user": "u" });
        assert!(precheck_targets(&policy, &kind, &ok).is_ok());
        let mut restpp = ok.clone();
        restpp["restppUrl"] = serde_json::json!("http://169.254.169.254/restpp");
        assert_eq!(precheck_targets(&policy, &kind, &restpp).unwrap_err().1, "restppUrl");
    }

    #[test]
    fn canonical_ids_only() {
        assert!(is_canonical_uuid("0199f0a0-0000-7000-8000-000000000000"));
        assert!(!is_canonical_uuid("0199F0A0-0000-7000-8000-000000000000"));
        assert!(!is_canonical_uuid("x' OR 1=1 --"));
    }
}
