//! InfluxDB 1.x, 2.x and 3.x over HTTP, through the one client factory (`crate::http`), which
//! checks every connection and redirect target. Queries in Flux (2.x), InfluxQL (all versions)
//! and SQL (3.x).
//!
//! Read-only on three levels. Kalzit sends requests only to a fixed list of read endpoints
//! (`Endpoint`), checked again for every redirect, so nothing reaches the write and delete APIs.
//! Each language is checked before it is sent (`check_flux`, `check_influxql`, and the SQL
//! statement check): Flux may not call `to()` or `wideTo()`, import packages that reach other
//! systems or name another server; InfluxQL must be one `SELECT` without `INTO`, or a `SHOW`,
//! and is sent by GET, which InfluxDB itself only runs for reads. The token should still only
//! read (docs/guide/data-sources.md).
//!
//! Macros expand to values Kalzit computes; variables are accepted only inside strings (and
//! InfluxQL regular expressions), escaped for them. SQL binds values as named parameters.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;
use std::time::Duration;

use reqwest::header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE, HeaderMap, HeaderValue};
use reqwest::{Method, Url};
use serde::Deserialize;
use serde_json::{Value, json};

use super::Detail;
use super::frame::{Charge, Column, FrameBuilder};
use super::http_json::{basic_auth, header_value, parse_url};
use super::sql::{self, Bind, Engine};
use super::{
    Connection, DataSourcePlugin, DefaultValue, FieldError, Health, Kind, SettingField, SettingType, SourceError,
    SourceQuery, SourceSchema, Table, TableColumn,
};
use crate::http::{HttpClient, HttpError, HttpOptions};
use crate::shapes::{FieldType, QueryResult, Shape};

const SETTINGS: &[SettingField] = &[
    SettingField::new("url", "datasources.settings.url", SettingType::String).target().required(),
    SettingField::new("version", "datasources.settings.influxVersion", SettingType::Select)
        .options(&["v1", "v2", "v3"])
        .default(DefaultValue::Text("v2")),
    SettingField::new("organization", "datasources.settings.organization", SettingType::String),
    SettingField::new("database", "datasources.settings.influxDatabase", SettingType::String),
    SettingField::new("user", "datasources.settings.user", SettingType::String).target(),
    SettingField::new("password", "datasources.settings.password", SettingType::String).secret(),
    SettingField::new("token", "datasources.settings.token", SettingType::String).secret(),
    SettingField::new("caCert", "datasources.settings.caCert", SettingType::Text).target(),
];
/// The client's own limit; the query timeout around each call is usually shorter.
const CLIENT_TIMEOUT: Duration = Duration::from_secs(3600);
/// Health and schema answers are read up to this size.
const MAX_SMALL_RESPONSE: usize = 16 * 1024 * 1024;
const MAX_SCHEMA_COLUMNS: usize = 20_000;
/// Query text is refused beyond this size.
const MAX_QUERY_BYTES: usize = 256 * 1024;

/// The Flux packages a query may import: reading, shaping and computing. Packages that send data
/// or reach other systems (`http`, `sql`, `csv`, `mqtt`, `slack`, `influxdata/influxdb/secrets`,
/// `experimental/http`, ...) are refused.
const FLUX_PACKAGES: &[&str] = &[
    "array",
    "date",
    "date/boundaries",
    "dict",
    "experimental",
    "experimental/aggregate",
    "experimental/array",
    "experimental/date/boundaries",
    "experimental/geo",
    "experimental/query",
    "experimental/table",
    "influxdata/influxdb/schema",
    "influxdata/influxdb/v1",
    "interpolate",
    "join",
    "math",
    "regexp",
    "runtime",
    "sampledata",
    "strings",
    "system",
    "timezone",
    "types",
    "universe",
];
/// Flux functions that write (to a bucket, or wide to one).
const FLUX_WRITERS: &[&str] = &["to", "wideTo"];
/// Call arguments that point a Flux function at another server.
const FLUX_REMOTE_ARGS: &[&str] = &["host", "token"];

pub fn kind() -> Kind {
    Kind {
        name: "InfluxDB",
        hint_key: "datasources.kinds.influxdb.hint",
        settings: SETTINGS,
        plugin: Arc::new(InfluxDb),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
enum Version {
    V1,
    V2,
    V3,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Settings {
    url: String,
    version: Option<Version>,
    organization: Option<String>,
    database: Option<String>,
    user: Option<String>,
    ca_cert: Option<String>,
}

/// One of `{"flux": "..."}`, `{"influxql": "..."}` or `{"sql": "..."}`.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct InfluxQuery {
    flux: Option<String>,
    influxql: Option<String>,
    sql: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Language {
    Flux,
    InfluxQl,
    Sql,
}

impl Language {
    fn name(self) -> &'static str {
        match self {
            Language::Flux => "Flux",
            Language::InfluxQl => "InfluxQL",
            Language::Sql => "SQL",
        }
    }
}

impl InfluxQuery {
    fn language(&self) -> Result<(Language, &str), SourceError> {
        match (&self.flux, &self.influxql, &self.sql) {
            (Some(t), None, None) => Ok((Language::Flux, t)),
            (None, Some(t), None) => Ok((Language::InfluxQl, t)),
            (None, None, Some(t)) => Ok((Language::Sql, t)),
            _ => Err(SourceError::rejected(
                "influxdb.query_form",
                "the query needs exactly one of flux, influxql or sql",
            )),
        }
    }
}

pub struct InfluxDb;

// ---- endpoints ----

/// The only requests Kalzit sends to InfluxDB.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Endpoint {
    /// `GET /ping`: the version (1.x headers, 3.x body).
    Ping,
    /// `GET /health`: the version (2.x).
    Health,
    /// `GET /query`: InfluxQL, which InfluxDB runs by GET only when it reads.
    Query,
    /// `POST /api/v2/query`: Flux.
    Flux,
    /// `GET /api/v2/buckets`: the login check of 2.x.
    Buckets,
    /// `POST /api/v3/query_sql`: SQL.
    Sql,
}

impl Endpoint {
    fn path(self) -> &'static str {
        match self {
            Endpoint::Ping => "ping",
            Endpoint::Health => "health",
            Endpoint::Query => "query",
            Endpoint::Flux => "api/v2/query",
            Endpoint::Buckets => "api/v2/buckets",
            Endpoint::Sql => "api/v3/query_sql",
        }
    }

    fn method(self) -> Method {
        match self {
            Endpoint::Flux | Endpoint::Sql => Method::POST,
            _ => Method::GET,
        }
    }
}

const ENDPOINTS: [Endpoint; 6] =
    [Endpoint::Ping, Endpoint::Health, Endpoint::Query, Endpoint::Flux, Endpoint::Buckets, Endpoint::Sql];

/// Refuses every request that is not one of the endpoints above, below `base`, with its method.
fn check_endpoint(base: &Url, method: &Method, url: &Url) -> Result<(), Detail> {
    let refused = || {
        Detail::new("influxdb.endpoint_not_allowed", format!("{method} {} is not a read endpoint", url.path()))
            .with("path", url.path())
    };
    if url.origin() != base.origin() || url.fragment().is_some() {
        return Err(refused());
    }
    let Some(rest) = url.path().strip_prefix(base.path()) else { return Err(refused()) };
    match ENDPOINTS.iter().find(|e| e.path() == rest) {
        Some(e) if e.method() == *method => Ok(()),
        _ => Err(refused()),
    }
}

// ---- client ----

struct Client {
    http: HttpClient,
    base: Url,
    version: Version,
    organization: Option<String>,
    database: Option<String>,
    headers: HeaderMap,
    basic_token: Option<String>,
}

async fn client(conn: &Connection) -> Result<Arc<Client>, SourceError> {
    conn.shared(|| async {
        let s: Settings = conn.settings_as()?;
        let mut base = parse_url(&s.url, false).map_err(SourceError::Failed)?;
        if !base.path().ends_with('/') {
            base.set_path(&format!("{}/", base.path()));
        }
        let http = crate::http::client(HttpOptions {
            timeout: CLIENT_TIMEOUT,
            extra_root_pem: s.ca_cert,
            policy: Arc::new(conn.policy().clone()),
        })
        .map_err(|e| SourceError::Failed(e.detail()))?;
        let version = s.version.unwrap_or(Version::V2);
        let mut headers = HeaderMap::new();
        let mut basic_token = None;
        match (s.user.filter(|u| !u.is_empty()), conn.secret("token")) {
            (_, Some(token)) => {
                // 2.x takes `Token`, 3.x `Bearer` (and `Token`); 1.x with authentication on
                // takes a token as the password of basic auth, sent below when a user is set.
                let scheme = if version == Version::V3 { "Bearer" } else { "Token" };
                headers
                    .insert(AUTHORIZATION, header_value(&format!("{scheme} {token}"), "influxdb.credentials_invalid")?);
            }
            (Some(user), None) => {
                let (value, token) = basic_auth(&user, conn.secret("password").unwrap_or(""));
                headers.insert(AUTHORIZATION, header_value(&value, "influxdb.credentials_invalid")?);
                basic_token = Some(token);
            }
            (None, None) => {}
        }
        Ok(Client {
            http,
            base,
            version,
            organization: s.organization.filter(|o| !o.trim().is_empty()),
            database: s.database.filter(|d| !d.trim().is_empty()),
            headers,
            basic_token,
        })
    })
    .await
}

impl Client {
    fn scrub(&self, text: &str) -> String {
        match &self.basic_token {
            Some(t) => text.replace(t, "***"),
            None => text.to_string(),
        }
    }

    fn failed(&self, e: HttpError) -> SourceError {
        match e {
            HttpError::Blocked(b) => SourceError::Blocked(b.0),
            HttpError::Refused(d) => SourceError::Rejected(d),
            other => SourceError::Failed(other.detail().scrubbed(|t| self.scrub(t))),
        }
    }

    fn database(&self) -> Result<&str, SourceError> {
        self.database.as_deref().ok_or_else(|| {
            SourceError::rejected(
                "influxdb.database_missing",
                "set the database (or bucket) in the data source settings",
            )
        })
    }

    /// Sends one request and answers the response once InfluxDB accepted it; an error answer
    /// becomes `influxdb.error` with InfluxDB's own message.
    async fn send(
        &self,
        endpoint: Endpoint,
        params: &[(&str, String)],
        body: Option<Value>,
        accept: &'static str,
    ) -> Result<reqwest::Response, SourceError> {
        let mut url = self.base.join(endpoint.path()).map_err(|e| SourceError::failed("internal", e.to_string()))?;
        if !params.is_empty() {
            url.query_pairs_mut().extend_pairs(params.iter().map(|(k, v)| (*k, v.as_str())));
        }
        let mut headers = self.headers.clone();
        headers.insert(ACCEPT, HeaderValue::from_static(accept));
        if body.is_some() {
            headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        }
        let base = self.base.clone();
        let hop = move |method: &Method, url: &Url| check_endpoint(&base, method, url);
        let response = self
            .http
            .send_checked(endpoint.method(), url, headers, body.map(|b| b.to_string().into_bytes()), Some(&hop))
            .await
            .map_err(|e| self.failed(e))?;
        if response.status().is_success() {
            return Ok(response);
        }
        let status = response.status();
        let body = crate::http::read_limited(response, MAX_SMALL_RESPONSE).await.map_err(|e| self.failed(e))?;
        let text = String::from_utf8_lossy(&body);
        let message = serde_json::from_slice::<Value>(&body)
            .ok()
            .and_then(|v| v["message"].as_str().or(v["error"].as_str()).map(str::to_string))
            .unwrap_or_else(|| text.trim().to_string());
        Err(self.error(status.as_u16(), &message))
    }

    fn error(&self, status: u16, message: &str) -> SourceError {
        let message = self.scrub(message);
        SourceError::failed("influxdb.error", format!("InfluxDB answered {status}: {message}"))
            .with("status", status)
            .with("detail", message)
    }

    async fn read(
        &self,
        response: reqwest::Response,
        max_bytes: usize,
        charge: Option<&mut Charge>,
    ) -> Result<Vec<u8>, SourceError> {
        match charge {
            Some(charge) => crate::http::read_counted(response, max_bytes, |n| charge.add(n)).await,
            None => crate::http::read_limited(response, max_bytes).await,
        }
        .map_err(|e| self.failed(e))
    }

    /// Runs InfluxQL and answers the first statement's series.
    async fn influxql(
        &self,
        text: &str,
        max_bytes: usize,
        charge: Option<&mut Charge>,
    ) -> Result<Vec<Value>, SourceError> {
        let mut params = vec![("q", text.to_string()), ("epoch", "ms".to_string())];
        if let Some(db) = &self.database {
            params.push(("db", db.clone()));
        }
        let response = self.send(Endpoint::Query, &params, None, "application/json").await?;
        let body = self.read(response, max_bytes, charge).await?;
        let answer: Value = serde_json::from_slice(&body).map_err(|_| not_influx())?;
        let result = &answer["results"][0];
        if let Some(e) = result["error"].as_str().or(answer["error"].as_str()) {
            return Err(self.error(200, e));
        }
        Ok(result["series"].as_array().cloned().unwrap_or_default())
    }

    /// Runs Flux and answers the annotated CSV.
    async fn flux(&self, text: &str, max_bytes: usize, charge: Option<&mut Charge>) -> Result<Vec<u8>, SourceError> {
        let params: Vec<(&str, String)> = self.organization.iter().map(|o| ("org", o.clone())).collect();
        let body = json!({
            "query": text,
            "type": "flux",
            "dialect": { "header": true, "annotations": ["datatype", "group", "default"], "delimiter": ",", "dateTimeFormat": "RFC3339Nano" }
        });
        let response = self.send(Endpoint::Flux, &params, Some(body), "application/csv").await?;
        self.read(response, max_bytes, charge).await
    }

    /// Runs SQL (3.x) and answers the JSON lines.
    async fn sql(
        &self,
        text: &str,
        binds: &[Bind],
        max_bytes: usize,
        charge: Option<&mut Charge>,
    ) -> Result<Vec<u8>, SourceError> {
        let params: serde_json::Map<String, Value> =
            binds.iter().enumerate().map(|(i, b)| (format!("p{}", i + 1), sql_param(b))).collect();
        // InfluxDB 3 answers `format: json` (one array of row objects) with `Accept:
        // application/json`; it refuses `application/jsonl` as an Accept value.
        let body = json!({ "db": self.database()?, "q": text, "format": "json", "params": params });
        let response = self.send(Endpoint::Sql, &[], Some(body), "application/json").await?;
        self.read(response, max_bytes, charge).await
    }
}

fn not_influx() -> SourceError {
    SourceError::failed("influxdb.not_an_api_response", "the server did not answer like InfluxDB")
}

/// A bound value as a JSON parameter; the statement casts each to its type (`sql::Engine::DataFusion`).
fn sql_param(bind: &Bind) -> Value {
    match bind {
        Bind::Null => Value::Null,
        Bind::Bool(b) => json!(b),
        Bind::Int(i) => json!(i),
        Bind::Float(f) => serde_json::Number::from_f64(*f).map_or(Value::Null, Value::Number),
        Bind::Text(t) => json!(t),
        Bind::Time(ms) => json!(rfc3339(*ms)),
        Bind::Interval(ms) => json!(format!("{ms} milliseconds")),
    }
}

/// `2026-10-29T12:00:00.000Z`.
fn rfc3339(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|t| t.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string())
        .unwrap_or_default()
}

#[async_trait::async_trait]
impl DataSourcePlugin for InfluxDb {
    fn kind(&self) -> &'static str {
        "influxdb"
    }

    fn shapes(&self) -> &'static [Shape] {
        &[Shape::Frame]
    }

    fn check_settings(&self, settings: &Value) -> Result<(), FieldError> {
        let s = Settings::deserialize(settings)
            .map_err(|e| FieldError::new("settings", "settings.invalid", e.to_string()).with("detail", e))?;
        parse_url(&s.url, false).map_err(|d| FieldError { field: "url", detail: d.with("field", "url") })?;
        super::check_pem("caCert", s.ca_cert.as_deref())?;
        Ok(())
    }

    async fn health(&self, conn: &Connection) -> Health {
        let check = async {
            let c = client(conn).await?;
            let version = match c.version {
                Version::V1 => {
                    let response = c.send(Endpoint::Ping, &[], None, "*/*").await?;
                    let v = response.headers().get("x-influxdb-version").and_then(|v| v.to_str().ok()).unwrap_or("");
                    let v = v.to_string();
                    c.influxql("SHOW DATABASES", MAX_SMALL_RESPONSE, None).await?;
                    v
                }
                Version::V2 => {
                    let response = c.send(Endpoint::Health, &[], None, "application/json").await?;
                    let body = c.read(response, MAX_SMALL_RESPONSE, None).await?;
                    let v = serde_json::from_slice::<Value>(&body)
                        .ok()
                        .and_then(|b| b["version"].as_str().map(str::to_string));
                    // The health answer needs no login; the bucket list does.
                    let mut params = vec![("limit", "1".to_string())];
                    if let Some(org) = &c.organization {
                        params.push(("org", org.clone()));
                    }
                    c.send(Endpoint::Buckets, &params, None, "application/json").await?;
                    v.unwrap_or_default()
                }
                Version::V3 => {
                    let response = c.send(Endpoint::Ping, &[], None, "application/json").await?;
                    let body = c.read(response, MAX_SMALL_RESPONSE, None).await?;
                    let v = serde_json::from_slice::<Value>(&body)
                        .ok()
                        .and_then(|b| b["version"].as_str().map(str::to_string));
                    if c.database.is_some() {
                        c.sql("SELECT 1", &[], MAX_SMALL_RESPONSE, None).await?;
                    }
                    v.unwrap_or_default()
                }
            };
            Ok::<_, SourceError>(version)
        };
        match check.await {
            Ok(version) => Health::connected("InfluxDB", &version, false),
            Err(e) => Health::failed(&e),
        }
    }

    async fn schema(&self, conn: &Connection) -> Result<SourceSchema, SourceError> {
        let c = client(conn).await?;
        let Some(db) = c.database.clone() else { return Ok(SourceSchema::Tables { tables: Vec::new() }) };
        let mut tables: BTreeMap<String, Vec<TableColumn>> = BTreeMap::new();
        match c.version {
            Version::V3 => {
                let body = c
                    .sql(
                        &format!(
                            "SELECT table_name, column_name, data_type FROM information_schema.columns \
                             WHERE table_schema = 'iox' ORDER BY table_name, ordinal_position LIMIT {MAX_SCHEMA_COLUMNS}"
                        ),
                        &[],
                        MAX_SMALL_RESPONSE,
                        None,
                    )
                    .await?;
                for row in sql_rows(&body)? {
                    let field = |name: &str| row.iter().find(|(k, _)| k == name).and_then(|(_, v)| v.as_str());
                    let (Some(t), Some(col)) = (field("table_name"), field("column_name")) else {
                        continue;
                    };
                    tables.entry(t.to_string()).or_default().push(TableColumn {
                        name: col.to_string(),
                        data_type: field("data_type").unwrap_or("").to_string(),
                    });
                }
            }
            Version::V1 | Version::V2 => {
                for (statement, kind) in [("SHOW FIELD KEYS", "field"), ("SHOW TAG KEYS", "tag")] {
                    for series in c.influxql(statement, MAX_SMALL_RESPONSE, None).await? {
                        let Some(name) = series["name"].as_str() else { continue };
                        let columns = tables.entry(name.to_string()).or_default();
                        for value in series["values"].as_array().into_iter().flatten() {
                            let Some(key) = value[0].as_str() else { continue };
                            let data_type = value[1].as_str().unwrap_or(kind).to_string();
                            if columns.len() < MAX_SCHEMA_COLUMNS {
                                columns.push(TableColumn { name: key.to_string(), data_type });
                            }
                        }
                    }
                }
            }
        }
        Ok(SourceSchema::Tables {
            tables: tables
                .into_iter()
                .map(|(name, columns)| Table { schema: Some(db.clone()), name, columns })
                .collect(),
        })
    }

    async fn query(&self, conn: &Connection, req: SourceQuery) -> Result<QueryResult, SourceError> {
        let q: InfluxQuery = req.parse()?;
        let (language, text) = q.language()?;
        if text.len() > MAX_QUERY_BYTES {
            return Err(SourceError::rejected("influxdb.query_too_large", "the query is too large")
                .with("bytes", MAX_QUERY_BYTES));
        }
        let c = client(conn).await?;
        let available = match c.version {
            Version::V1 => language != Language::Sql,
            Version::V2 => language != Language::Sql,
            Version::V3 => language != Language::Flux,
        };
        if !available {
            return Err(SourceError::rejected(
                "influxdb.language_unavailable",
                format!("this InfluxDB version does not answer {}", language.name()),
            )
            .with("language", language.name()));
        }
        let max_bytes = req.limits.budget.remaining();
        let mut charge = req.limits.budget.charge();
        let frame = match language {
            Language::Flux => {
                let expanded = expand(text, Language::Flux, &req, c.database.as_deref())?;
                check_flux(&expanded)?;
                let body = c.flux(&expanded, max_bytes, Some(&mut charge)).await?;
                let mut frame = flux_frame(&body, &req).map_err(|e| e.scrubbed(&c))?;
                frame.executed_query(expanded);
                frame
            }
            Language::InfluxQl => {
                let expanded = expand(text, Language::InfluxQl, &req, c.database.as_deref())?;
                check_influxql(&expanded)?;
                let series = c.influxql(&expanded, max_bytes, Some(&mut charge)).await?;
                let mut frame = influxql_frame(&series, &req);
                frame.executed_query(expanded);
                frame
            }
            Language::Sql => {
                let sql_query = super::SourceQuery { query: json!({ "sql": text }), ..clone_req(&req) };
                let prepared = sql::prepare_query(self, conn, &sql_query, Engine::DataFusion).await?;
                let body = c.sql(&prepared.sql, &prepared.binds, max_bytes, Some(&mut charge)).await?;
                let mut frame = jsonl_frame(&body, &req)?;
                frame.executed_query(prepared.sql);
                frame
            }
        };
        let frame = frame.finish();
        drop(charge);
        Ok(QueryResult::Frame { frame })
    }
}

fn clone_req(req: &SourceQuery) -> SourceQuery {
    SourceQuery {
        ref_id: req.ref_id.clone(),
        query: req.query.clone(),
        range: req.range,
        interval_ms: req.interval_ms,
        max_data_points: req.max_data_points,
        variables: req.variables.clone(),
        identifier_variables: req.identifier_variables.clone(),
        limits: req.limits.clone(),
        cursor: req.cursor.clone(),
    }
}

trait Scrubbed {
    fn scrubbed(self, c: &Client) -> SourceError;
}

impl Scrubbed for SourceError {
    fn scrubbed(self, c: &Client) -> SourceError {
        match self {
            SourceError::Failed(d) => SourceError::Failed(d.scrubbed(|t| c.scrub(t))),
            other => other,
        }
    }
}

// ---- macros and variables ----

/// A Flux duration or InfluxQL duration literal (`30s`, `250ms`, `5m`).
fn duration(ms: i64) -> String {
    sql::format_interval(ms.max(1))
}

fn variable_text(name: &str, value: &Value, regex: bool) -> Result<String, SourceError> {
    match value {
        Value::String(s) if regex => Ok(regex_escape(s)),
        Value::String(s) => Ok(s.clone()),
        Value::Number(n) => Ok(n.to_string()),
        Value::Bool(b) => Ok(b.to_string()),
        Value::Array(items) => {
            let parts: Vec<String> = items.iter().map(|v| variable_text(name, v, true)).collect::<Result<_, _>>()?;
            Ok(parts.join("|"))
        }
        _ => Err(SourceError::rejected(
            "influxdb.variable_type",
            format!("variable {name} must be a string, number, boolean or a list of them"),
        )
        .with("name", name)),
    }
}

fn regex_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if "\\.+*?()|[]{}^$".contains(c) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// Escapes text for a string or regular expression of the language: `"..."` in Flux (where `$`
/// would start an interpolation), `'...'` and `/.../` in InfluxQL.
fn escape_in(context: Context, text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match (context, c) {
            // A regular expression keeps its escapes as written.
            (Context::InfluxQlRegex, '\\') => out.push('\\'),
            (_, '\\') => out.push_str("\\\\"),
            (_, '\n') => out.push_str("\\n"),
            (_, '\r') => out.push_str("\\r"),
            (_, '\t') => out.push_str("\\t"),
            (Context::FluxString, '"') => out.push_str("\\\""),
            (Context::FluxString, '$') => out.push_str("\\$"),
            (Context::InfluxQlString, '\'') => out.push_str("\\'"),
            // A slash must not end the literal.
            (Context::InfluxQlRegex, '/') => out.push_str("\\/"),
            (_, c) => out.push(c),
        }
    }
    out
}

/// Where a variable stands.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Context {
    FluxString,
    InfluxQlString,
    InfluxQlRegex,
}

/// Reads `$name`, `${name}` at `i` (a `$`): the name and the end index.
fn read_name(text: &str, i: usize) -> Option<(&str, usize)> {
    let rest = &text[i + 1..];
    if let Some(inner) = rest.strip_prefix('{') {
        let close = inner.find('}')?;
        let name = &inner[..close];
        return name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_').then(|| (name, i + 2 + close + 1));
    }
    let len = rest.find(|c: char| !(c.is_ascii_alphanumeric() || c == '_')).unwrap_or(rest.len());
    (len > 0 && !rest.starts_with(|c: char| c.is_ascii_digit())).then(|| (&rest[..len], i + 1 + len))
}

/// Expands macros outside strings and variables inside them. Flux also gets the `v` record its
/// own tools fill in: `v.timeRangeStart`, `v.timeRangeStop`, `v.windowPeriod`, `v.bucket`.
fn expand(text: &str, language: Language, req: &SourceQuery, database: Option<&str>) -> Result<String, SourceError> {
    let flux = language == Language::Flux;
    let interval = req.interval_ms as i64;
    let mut out = String::with_capacity(text.len());
    let mut context: Option<Context> = None;
    let mut i = 0;
    let bytes = text.as_bytes();
    while i < text.len() {
        let c = text[i..].chars().next().expect("i is on a char boundary");
        match context {
            Some(_) if c == '\\' => {
                let next = text[i + 1..].chars().next().map_or(0, char::len_utf8);
                out.push_str(&text[i..i + 1 + next]);
                i += 1 + next;
                continue;
            }
            Some(Context::FluxString) if c == '"' => context = None,
            Some(Context::InfluxQlString) if c == '\'' => context = None,
            Some(Context::InfluxQlRegex) if c == '/' => context = None,
            // A Flux interpolation (`${r.x}`) is code, which `check_flux` reads; a variable
            // written `${name}` inside a string is Kalzit's.
            None if flux && c == '"' => context = Some(Context::FluxString),
            None if !flux && c == '\'' => context = Some(Context::InfluxQlString),
            None if !flux && c == '"' => {
                // A quoted identifier: copied whole, nothing expanded.
                let end = skip_quoted(bytes, i, b'"').ok_or_else(unclosed)?;
                out.push_str(&text[i..end]);
                i = end;
                continue;
            }
            None if !flux && c == '/' && regex_follows(&out) => context = Some(Context::InfluxQlRegex),
            None if (flux && text[i..].starts_with("//")) || (!flux && text[i..].starts_with("--")) => {
                let end = text[i..].find('\n').map_or(text.len(), |p| i + p);
                out.push_str(&text[i..end]);
                i = end;
                continue;
            }
            None if !flux && text[i..].starts_with("/*") => {
                let end = text[i + 2..].find("*/").map(|p| i + 2 + p + 2).ok_or_else(unclosed)?;
                out.push_str(&text[i..end]);
                i = end;
                continue;
            }
            None if flux
                && text[i..].starts_with("v.")
                && !text[..i].ends_with(|ch: char| ch.is_alphanumeric() || ch == '_' || ch == '.') =>
            {
                let rest = &text[i + 2..];
                let len = rest.find(|ch: char| !(ch.is_ascii_alphanumeric() || ch == '_')).unwrap_or(rest.len());
                let value = match &rest[..len] {
                    "timeRangeStart" => Some(rfc3339(req.range.from)),
                    "timeRangeStop" => Some(rfc3339(req.range.to)),
                    "windowPeriod" => Some(duration(interval)),
                    "bucket" | "defaultBucket" => {
                        database.map(|d| format!("\"{}\"", escape_in(Context::FluxString, d)))
                    }
                    _ => None,
                };
                if let Some(value) = value {
                    out.push_str(&value);
                    i += 2 + len;
                    continue;
                }
            }
            _ => {}
        }
        if c != '$' {
            out.push(c);
            i += c.len_utf8();
            continue;
        }
        // In a Flux string, `${` followed by something other than a plain name is an
        // interpolation, left for Flux.
        let Some((name, end)) = read_name(text, i) else {
            out.push(c);
            i += 1;
            continue;
        };
        let expansion = match name {
            "__interval" => duration(interval),
            "__interval_ms" => interval.to_string(),
            "__timeFrom" if flux => rfc3339(req.range.from),
            "__timeTo" if flux => rfc3339(req.range.to),
            "__timeFrom" => format!("{}ms", req.range.from),
            "__timeTo" => format!("{}ms", req.range.to),
            "__timeFilter" if !flux => {
                format!("time >= {}ms AND time <= {}ms", req.range.from, req.range.to)
            }
            "__range" => duration(req.range.to.saturating_sub(req.range.from).max(1)),
            m if m.starts_with("__") => {
                return Err(
                    SourceError::rejected("influxdb.macro_unknown", format!("unknown macro ${m}")).with("name", m)
                );
            }
            name => {
                let Some(ctx) = context else {
                    // A Flux interpolation of a record field (`${r.host}`) never reaches here.
                    return Err(SourceError::rejected(
                        "influxdb.variable_outside_string",
                        format!("variable {name} must be inside a quoted string, such as \"${name}\""),
                    )
                    .with("name", name));
                };
                let value = req.variables.get(name).ok_or_else(|| {
                    SourceError::rejected("influxdb.variable_missing", format!("variable {name} has no value"))
                        .with("name", name)
                })?;
                let checked = req.identifier_variables.as_ref().is_some_and(|c| c.contains(name));
                let regex = ctx == Context::InfluxQlRegex && !checked;
                escape_in(ctx, &variable_text(name, value, regex)?)
            }
        };
        out.push_str(&expansion);
        i = end;
    }
    if context.is_some() {
        return Err(unclosed());
    }
    Ok(out)
}

fn unclosed() -> SourceError {
    SourceError::rejected("influxdb.unclosed", "a quote, regular expression or comment is not closed")
}

/// The end of a quoted run starting at `start`, with backslash escapes.
fn skip_quoted(bytes: &[u8], start: usize, quote: u8) -> Option<usize> {
    let mut i = start + 1;
    while i < bytes.len() {
        match bytes[i] {
            b'\\' => i += 2,
            q if q == quote => return Some(i + 1),
            _ => i += 1,
        }
    }
    None
}

/// InfluxQL regular expressions follow `=~` or `!~`.
fn regex_follows(before: &str) -> bool {
    let t = before.trim_end();
    t.ends_with("=~") || t.ends_with("!~")
}

// ---- read-only checks ----

#[derive(Debug, PartialEq)]
enum Token<'a> {
    Ident(&'a str),
    Str(&'a str),
    Punct(char),
    /// A number, duration or time literal.
    Number,
}

/// The tokens of Flux code: strings (their interpolations read as code too), identifiers,
/// numbers and punctuation; comments and regular expressions dropped.
fn flux_tokens(text: &str) -> Result<Vec<Token<'_>>, SourceError> {
    let mut tokens = Vec::new();
    flux_scan(text, &mut tokens)?;
    Ok(tokens)
}

fn flux_scan<'a>(text: &'a str, tokens: &mut Vec<Token<'a>>) -> Result<(), SourceError> {
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i];
        if c == b'/' && bytes.get(i + 1) == Some(&b'/') {
            i = text[i..].find('\n').map_or(text.len(), |p| i + p);
        } else if c == b'"' {
            let start = i + 1;
            i += 1;
            loop {
                match bytes.get(i) {
                    None => return Err(unclosed()),
                    Some(b'\\') => i += 2,
                    Some(b'"') => break,
                    Some(b'$') if bytes.get(i + 1) == Some(&b'{') => {
                        // An interpolation: the code up to its closing brace.
                        let open = i + 2;
                        let mut depth = 1;
                        let mut j = open;
                        while j < bytes.len() && depth > 0 {
                            match bytes[j] {
                                b'{' => depth += 1,
                                b'}' => depth -= 1,
                                b'"' => j = skip_quoted(bytes, j, b'"').ok_or_else(unclosed)? - 1,
                                _ => {}
                            }
                            j += 1;
                        }
                        if depth > 0 {
                            return Err(unclosed());
                        }
                        flux_scan(&text[open..j - 1], tokens)?;
                        i = j;
                    }
                    Some(_) => i += 1,
                }
            }
            tokens.push(Token::Str(&text[start..i]));
            i += 1;
        } else if c == b'/' && regex_may_start(tokens) {
            // A regular expression literal: skipped whole.
            i += 1;
            while i < bytes.len() && bytes[i] != b'/' {
                i += if bytes[i] == b'\\' { 2 } else { 1 };
            }
            i += 1;
        } else if c.is_ascii_alphabetic() || c == b'_' {
            let end =
                text[i..].find(|ch: char| !(ch.is_ascii_alphanumeric() || ch == '_')).map_or(text.len(), |p| i + p);
            tokens.push(Token::Ident(&text[i..end]));
            i = end;
        } else if c.is_ascii_digit() {
            // Numbers, durations (`5m`) and times (`2026-10-29T00:00:00Z`) are values.
            let end = text[i..]
                .find(|ch: char| !(ch.is_ascii_alphanumeric() || matches!(ch, '.' | ':' | '-' | '+')))
                .map_or(text.len(), |p| i + p);
            tokens.push(Token::Number);
            i = end;
        } else if c.is_ascii_whitespace() {
            i += 1;
        } else {
            let ch = text[i..].chars().next().expect("i is on a char boundary");
            tokens.push(Token::Punct(ch));
            i += ch.len_utf8();
        }
    }
    Ok(())
}

/// A `/` starts a regular expression where a value is expected: after an operator, an opening
/// bracket, a comma or a colon, or at the start. After a value (a name, number, string or
/// closing bracket) it divides.
fn regex_may_start(tokens: &[Token<'_>]) -> bool {
    match tokens.last() {
        None => true,
        Some(Token::Punct(p)) => !matches!(p, ')' | ']' | '}'),
        Some(Token::Ident(w)) => matches!(*w, "and" | "or" | "not" | "return" | "if" | "then" | "else"),
        Some(Token::Str(_) | Token::Number) => false,
    }
}

/// Refuses Flux that writes, imports a package that reaches other systems, or names another
/// server or token. Deliberately coarse, so no spelling gets around it:
/// - an import must be exactly `import "<allowed package>"`, without an alias;
/// - `to` and `wideTo` may not appear as a name at all (called, assigned, passed or read from a
///   package such as `experimental.to`);
/// - `host` and `token` may not appear as a name or key (`host: ...`, `"host": ...`, the
///   shorthand `from(bucket: "b", host)`), only as a field read from a record (`r.host`).
fn check_flux(text: &str) -> Result<(), SourceError> {
    let tokens = flux_tokens(text)?;
    for (i, token) in tokens.iter().enumerate() {
        let next = tokens.get(i + 1);
        let after_dot = matches!(tokens.get(i.wrapping_sub(1)), Some(Token::Punct('.')));
        match token {
            Token::Ident("import") => match next {
                Some(Token::Str(package)) if FLUX_PACKAGES.contains(package) => {}
                Some(Token::Str(package)) => {
                    return Err(SourceError::rejected(
                        "flux.package_not_allowed",
                        format!("the package {package} is not allowed: it writes or reaches other systems"),
                    )
                    .with("name", *package));
                }
                _ => {
                    return Err(SourceError::rejected(
                        "flux.import_form",
                        "write imports as import \"package\", without an alias",
                    ));
                }
            },
            Token::Ident(name) if FLUX_WRITERS.contains(name) => {
                return Err(SourceError::rejected(
                    "flux.write_refused",
                    format!("{name}() writes data and is not allowed"),
                )
                .with("name", *name));
            }
            Token::Ident(name) if FLUX_REMOTE_ARGS.contains(name) && !after_dot => {
                return Err(remote_refused(name));
            }
            Token::Str(key) if FLUX_REMOTE_ARGS.contains(key) && next == Some(&Token::Punct(':')) => {
                return Err(remote_refused(key));
            }
            _ => {}
        }
    }
    Ok(())
}

fn remote_refused(name: &str) -> SourceError {
    SourceError::rejected(
        "flux.remote_not_allowed",
        format!("{name} would query another server and is not allowed; read it from a record as r.{name}"),
    )
    .with("name", name)
}

/// The words of InfluxQL code, upper-cased, with `;` kept: strings, quoted identifiers, regular
/// expressions and comments dropped.
fn influxql_words(text: &str) -> Result<Vec<String>, SourceError> {
    let bytes = text.as_bytes();
    let mut words = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i];
        if c == b'\'' || c == b'"' {
            i = skip_quoted(bytes, i, c).ok_or_else(unclosed)?;
        } else if c == b'-' && bytes.get(i + 1) == Some(&b'-') {
            i = text[i..].find('\n').map_or(text.len(), |p| i + p);
        } else if c == b'/' && bytes.get(i + 1) == Some(&b'*') {
            i = text[i + 2..].find("*/").map(|p| i + 2 + p + 2).ok_or_else(unclosed)?;
        } else if c == b'/' && regex_follows(&text[..i]) {
            i = skip_quoted(bytes, i, b'/').ok_or_else(unclosed)?;
        } else if c.is_ascii_alphabetic() || c == b'_' {
            let end =
                text[i..].find(|ch: char| !(ch.is_ascii_alphanumeric() || ch == '_')).map_or(text.len(), |p| i + p);
            words.push(text[i..end].to_ascii_uppercase());
            i = end;
        } else if c == b';' {
            words.push(";".into());
            i += 1;
        } else {
            i += 1;
        }
    }
    Ok(words)
}

/// One `SELECT` without `INTO`, or one `SHOW`.
fn check_influxql(text: &str) -> Result<(), SourceError> {
    let mut words = influxql_words(text)?;
    while words.last().is_some_and(|w| w == ";") {
        words.pop();
    }
    if words.iter().any(|w| w == ";") {
        return Err(SourceError::rejected("influxql.multiple_statements", "only one statement is allowed"));
    }
    match words.first().map(String::as_str) {
        Some("SELECT") if words.iter().any(|w| w == "INTO") => {
            Err(SourceError::rejected("influxql.select_into", "SELECT ... INTO writes data and is not allowed"))
        }
        Some("SELECT" | "SHOW") => Ok(()),
        None => Err(SourceError::rejected("influxql.empty", "the query is empty")),
        Some(_) => Err(SourceError::rejected("influxql.not_read", "only SELECT and SHOW statements are allowed")),
    }
}

// ---- results ----

/// The series' name: the measurement, the column when there are several, and the tags.
fn series_name(measurement: &str, column: &str, many: bool, tags: &BTreeMap<String, String>) -> String {
    let mut name = if many { format!("{measurement}.{column}") } else { measurement.to_string() };
    if !tags.is_empty() {
        let parts: Vec<String> = tags.iter().map(|(k, v)| format!("{k}={}", json!(v))).collect();
        name.push_str(&format!(" {{{}}}", parts.join(", ")));
    }
    name
}

fn value_type(values: impl Iterator<Item = Value>) -> FieldType {
    let mut found = None;
    for v in values {
        let t = match v {
            Value::Null => continue,
            Value::Number(_) => FieldType::Number,
            Value::Bool(_) => FieldType::Bool,
            Value::String(_) => FieldType::String,
            _ => FieldType::Json,
        };
        match found {
            None => found = Some(t),
            Some(f) if f == t => {}
            Some(_) => return FieldType::Json,
        }
    }
    found.unwrap_or(FieldType::String)
}

/// InfluxQL series as one frame. Series over time (`time` first) share one time field and get
/// one value field per series and column, labelled with their tags; other answers (`SHOW ...`)
/// are a table of their columns, with the series' name and tags where there are several.
fn influxql_frame(series: &[Value], req: &SourceQuery) -> FrameBuilder {
    let budget = req.limits.budget.clone();
    let empty = Vec::new();
    let columns_of = |s: &Value| -> Vec<String> {
        s["columns"].as_array().unwrap_or(&empty).iter().map(|c| c.as_str().unwrap_or("").to_string()).collect()
    };
    let timed = !series.is_empty() && series.iter().all(|s| columns_of(s).first().map(String::as_str) == Some("time"));
    if timed {
        let mut columns = vec![Column::new("time", Some(FieldType::Time))];
        let mut samples: Vec<BTreeMap<i64, Value>> = Vec::new();
        let mut times = BTreeSet::new();
        for s in series {
            let names = columns_of(s);
            let tags: BTreeMap<String, String> = s["tags"]
                .as_object()
                .map(|m| m.iter().map(|(k, v)| (k.clone(), v.as_str().unwrap_or("").to_string())).collect())
                .unwrap_or_default();
            let measurement = s["name"].as_str().unwrap_or("");
            let values = s["values"].as_array().unwrap_or(&empty);
            for (col, name) in names.iter().enumerate().skip(1) {
                let mut column = Column::new(
                    series_name(measurement, name, names.len() > 2, &tags),
                    Some(value_type(values.iter().map(|r| r[col].clone()))),
                );
                let mut labels = tags.clone();
                labels.insert("_measurement".into(), measurement.to_string());
                labels.insert("_field".into(), name.clone());
                column.labels = Some(labels);
                columns.push(column);
                let mut map = BTreeMap::new();
                for row in values {
                    if let Some(t) = row[0].as_i64() {
                        times.insert(t);
                        map.insert(t, row[col].clone());
                    }
                }
                samples.push(map);
            }
        }
        let rows = (req.limits.max_rows / samples.len().max(1)).max(1);
        let mut frame = FrameBuilder::new(columns, rows, budget);
        for t in times {
            let mut row = vec![json!(t)];
            row.extend(samples.iter().map(|s| s.get(&t).cloned().unwrap_or(Value::Null)));
            if !frame.push_row(row) {
                break;
            }
        }
        return frame;
    }
    // A table: the first series' columns, and the series' name and tags when they differ.
    let names: Vec<String> = series.first().map(columns_of).unwrap_or_default();
    let tag_keys: BTreeSet<String> =
        series.iter().filter_map(|s| s["tags"].as_object()).flat_map(|m| m.keys().cloned()).collect();
    let with_name = series.len() > 1;
    let mut columns = Vec::new();
    if with_name {
        columns.push(Column::new("name", Some(FieldType::String)));
    }
    columns.extend(tag_keys.iter().map(|k| Column::new(k.clone(), Some(FieldType::String))));
    for (i, n) in names.iter().enumerate() {
        let t = value_type(
            series.iter().flat_map(|s| s["values"].as_array().unwrap_or(&empty).iter().map(move |r| r[i].clone())),
        );
        columns.push(Column::new(n.clone(), Some(t)));
    }
    let mut frame = FrameBuilder::new(columns, req.limits.max_rows, budget);
    'series: for s in series {
        for row in s["values"].as_array().unwrap_or(&empty) {
            let mut out = Vec::new();
            if with_name {
                out.push(s["name"].clone());
            }
            out.extend(tag_keys.iter().map(|k| s["tags"][k].clone()));
            out.extend((0..names.len()).map(|i| row[i].clone()));
            if !frame.push_row(out) {
                break 'series;
            }
        }
    }
    frame
}

/// A Flux column's values by its datatype annotation.
fn flux_type(datatype: &str) -> FieldType {
    match datatype {
        "double" | "long" | "unsignedLong" => FieldType::Number,
        "boolean" => FieldType::Bool,
        t if t.starts_with("dateTime") => FieldType::Time,
        _ => FieldType::String,
    }
}

fn flux_value(raw: &str, ty: FieldType) -> Value {
    if raw.is_empty() {
        return Value::Null;
    }
    match ty {
        FieldType::Number => {
            raw.parse::<f64>().ok().and_then(serde_json::Number::from_f64).map_or(Value::Null, Value::Number)
        }
        FieldType::Bool => json!(raw == "true"),
        FieldType::Time => {
            chrono::DateTime::parse_from_rfc3339(raw).map_or(Value::Null, |t| json!(t.timestamp_millis()))
        }
        _ => json!(raw),
    }
}

/// One table of a Flux answer.
struct FluxTable {
    names: Vec<String>,
    types: Vec<FieldType>,
    group: Vec<bool>,
    rows: Vec<Vec<String>>,
}

/// The tables of an annotated CSV answer. An error reported inside the answer (a table with the
/// columns `error` and `reference`) is an error.
fn flux_tables(body: &[u8], max_rows: usize) -> Result<(Vec<FluxTable>, bool), SourceError> {
    let mut reader = super::csv::Reader::new(body, b',');
    let mut tables: Vec<FluxTable> = Vec::new();
    let mut datatypes: Option<Vec<String>> = None;
    let mut groups: Option<Vec<String>> = None;
    let mut current: Option<FluxTable> = None;
    let mut rows = 0usize;
    let mut cut = false;
    loop {
        let record = match reader.next_record(MAX_SMALL_RESPONSE) {
            Ok(Some(r)) => r,
            Ok(None) => break,
            Err(_) => return Err(not_influx()),
        };
        let fields = record.fields;
        if fields.iter().all(|f| f.is_empty()) {
            // A blank line ends a table.
            tables.extend(current.take());
            continue;
        }
        match fields[0].as_str() {
            "#datatype" => {
                tables.extend(current.take());
                datatypes = Some(fields);
                continue;
            }
            "#group" => {
                groups = Some(fields);
                continue;
            }
            s if s.starts_with('#') => continue,
            _ => {}
        }
        match current.as_mut() {
            None => {
                let types: Vec<FieldType> = datatypes.take().unwrap_or_default().iter().map(|d| flux_type(d)).collect();
                let group = groups.take().unwrap_or_default().iter().map(|g| g == "true").collect();
                if fields.iter().any(|f| f == "error") && fields.iter().any(|f| f == "reference") {
                    // The next line holds the message.
                    let message = reader
                        .next_record(MAX_SMALL_RESPONSE)
                        .ok()
                        .flatten()
                        .and_then(|r| {
                            let at = fields.iter().position(|f| f == "error")?;
                            r.fields.get(at).cloned()
                        })
                        .unwrap_or_default();
                    return Err(SourceError::failed("influxdb.error", format!("InfluxDB answered 200: {message}"))
                        .with("status", 200)
                        .with("detail", message));
                }
                current = Some(FluxTable { names: fields, types, group, rows: Vec::new() });
            }
            Some(table) => {
                if rows >= max_rows {
                    cut = true;
                    continue;
                }
                rows += 1;
                // Tables of the same columns share one block; the `table` column tells them apart.
                let id = table.names.iter().position(|n| n == "table").and_then(|at| fields.get(at)).cloned();
                if let Some(first) = table.rows.first()
                    && table.names.iter().position(|n| n == "table").and_then(|at| first.get(at)).cloned() != id
                {
                    let next = FluxTable {
                        names: table.names.clone(),
                        types: table.types.clone(),
                        group: table.group.clone(),
                        rows: vec![fields],
                    };
                    tables.extend(current.replace(next));
                } else {
                    table.rows.push(fields);
                }
            }
        }
    }
    tables.extend(current.take());
    Ok((tables, cut))
}

/// Columns of every Flux table that are no data: the annotation column, `result` and `table`.
fn flux_data_column(name: &str) -> bool {
    !(name.is_empty() || name == "result" || name == "table")
}

/// A Flux answer as one frame. Time series (every table has `_time` and `_value`) become one
/// time field and a value field per table, labelled with the table's group key; other answers
/// are all tables' rows under the union of their columns.
fn flux_frame(body: &[u8], req: &SourceQuery) -> Result<FrameBuilder, SourceError> {
    let (tables, cut) = flux_tables(body, req.limits.max_rows.saturating_mul(4).max(1))?;
    let budget = req.limits.budget.clone();
    let has = |t: &FluxTable, n: &str| t.names.iter().any(|x| x == n);
    let series = !tables.is_empty() && tables.iter().all(|t| has(t, "_time") && has(t, "_value"));
    let mut frame = if series {
        let mut columns = vec![Column::new("time", Some(FieldType::Time))];
        let mut samples: Vec<BTreeMap<i64, Value>> = Vec::new();
        let mut times = BTreeSet::new();
        for t in &tables {
            let at = |n: &str| t.names.iter().position(|x| x == n);
            let (time_at, value_at) = (at("_time").unwrap_or(0), at("_value").unwrap_or(0));
            let mut labels = BTreeMap::new();
            if let Some(first) = t.rows.first() {
                for (i, name) in t.names.iter().enumerate() {
                    let grouped = t.group.get(i).copied().unwrap_or(false);
                    if grouped && flux_data_column(name) && !matches!(name.as_str(), "_start" | "_stop") {
                        labels.insert(name.clone(), first.get(i).cloned().unwrap_or_default());
                    }
                }
            }
            let mut name = [labels.get("_measurement"), labels.get("_field")]
                .into_iter()
                .flatten()
                .cloned()
                .collect::<Vec<_>>()
                .join(".");
            let tags: Vec<String> =
                labels.iter().filter(|(k, _)| !k.starts_with('_')).map(|(k, v)| format!("{k}={}", json!(v))).collect();
            if !tags.is_empty() {
                name.push_str(&format!(" {{{}}}", tags.join(", ")));
            }
            if name.is_empty() {
                name = "_value".into();
            }
            let ty = t.types.get(value_at).copied().unwrap_or(FieldType::String);
            let mut column = Column::new(name, Some(ty));
            column.labels = Some(labels);
            columns.push(column);
            let mut map = BTreeMap::new();
            for row in &t.rows {
                if let Some(ms) = flux_value(row.get(time_at).map_or("", String::as_str), FieldType::Time).as_i64() {
                    times.insert(ms);
                    map.insert(ms, flux_value(row.get(value_at).map_or("", String::as_str), ty));
                }
            }
            samples.push(map);
        }
        let rows = (req.limits.max_rows / samples.len().max(1)).max(1);
        let mut frame = FrameBuilder::new(columns, rows, budget);
        for t in times {
            let mut row = vec![json!(t)];
            row.extend(samples.iter().map(|s| s.get(&t).cloned().unwrap_or(Value::Null)));
            if !frame.push_row(row) {
                break;
            }
        }
        frame
    } else {
        let mut names: Vec<String> = Vec::new();
        let mut types: Vec<FieldType> = Vec::new();
        for t in &tables {
            for (i, n) in t.names.iter().enumerate() {
                if flux_data_column(n) && !names.contains(n) {
                    names.push(n.clone());
                    types.push(t.types.get(i).copied().unwrap_or(FieldType::String));
                }
            }
        }
        let columns = names.iter().zip(&types).map(|(n, t)| Column::new(n.clone(), Some(*t))).collect();
        let mut frame = FrameBuilder::new(columns, req.limits.max_rows, budget);
        'tables: for t in &tables {
            let positions: Vec<Option<usize>> = names.iter().map(|n| t.names.iter().position(|x| x == n)).collect();
            for row in &t.rows {
                let values = positions
                    .iter()
                    .zip(&types)
                    .map(|(p, ty)| p.and_then(|p| row.get(p)).map_or(Value::Null, |raw| flux_value(raw, *ty)))
                    .collect();
                if !frame.push_row(values) {
                    break 'tables;
                }
            }
        }
        frame
    };
    if cut && !frame.is_full() {
        frame.mark_truncated(
            Detail::new(
                "frame.row_limit",
                format!("only the first {} rows are shown (row limit)", req.limits.max_rows),
            )
            .with("rows", req.limits.max_rows),
        );
    }
    Ok(frame)
}

/// The rows of an SQL answer, each with its columns in the order of the statement: one JSON
/// array of objects (`format: json`), or JSON lines.
fn sql_rows(body: &[u8]) -> Result<Vec<Vec<(String, Value)>>, SourceError> {
    let text = String::from_utf8_lossy(body);
    if text.trim_start().starts_with('[') {
        let rows: Vec<OrderedObject> = serde_json::from_str(&text).map_err(|_| not_influx())?;
        return Ok(rows.into_iter().map(|OrderedObject(entries)| entries).collect());
    }
    text.lines()
        .filter(|l| !l.trim().is_empty())
        .map(|line| serde_json::from_str::<OrderedObject>(line).map(|OrderedObject(e)| e).map_err(|_| not_influx()))
        .collect()
}

/// SQL answers (one object per row, columns in the order of the statement) as a frame; types
/// from the values, `time` and RFC 3339 texts as times.
fn jsonl_frame(body: &[u8], req: &SourceQuery) -> Result<FrameBuilder, SourceError> {
    let mut names: Vec<String> = Vec::new();
    let mut rows: Vec<BTreeMap<String, Value>> = Vec::new();
    let mut cut = false;
    for entries in sql_rows(body)? {
        if rows.len() >= req.limits.max_rows {
            cut = true;
            break;
        }
        let mut row = BTreeMap::new();
        for (k, v) in entries {
            if !names.contains(&k) {
                names.push(k.clone());
            }
            row.insert(k, v);
        }
        rows.push(row);
    }
    let types: Vec<FieldType> = names
        .iter()
        .map(|n| {
            let values: Vec<&Value> = rows.iter().filter_map(|r| r.get(n)).filter(|v| !v.is_null()).collect();
            let times = !values.is_empty()
                && values.iter().all(|v| v.as_str().is_some_and(|s| super::csv::parse_time(s).is_some()));
            if times && (n == "time" || values.iter().all(|v| v.as_str().is_some_and(|s| s.contains('T')))) {
                FieldType::Time
            } else {
                value_type(values.into_iter().cloned())
            }
        })
        .collect();
    let columns = names.iter().zip(&types).map(|(n, t)| Column::new(n.clone(), Some(*t))).collect();
    let mut frame = FrameBuilder::new(columns, req.limits.max_rows, req.limits.budget.clone());
    for row in rows {
        let values = names
            .iter()
            .zip(&types)
            .map(|(n, t)| match (row.get(n), t) {
                (Some(Value::String(s)), FieldType::Time) => {
                    super::csv::parse_time(s).map_or(Value::Null, |ms| json!(ms))
                }
                (Some(v), _) => v.clone(),
                (None, _) => Value::Null,
            })
            .collect();
        if !frame.push_row(values) {
            break;
        }
    }
    if cut && !frame.is_full() {
        frame.mark_truncated(
            Detail::new(
                "frame.row_limit",
                format!("only the first {} rows are shown (row limit)", req.limits.max_rows),
            )
            .with("rows", req.limits.max_rows),
        );
    }
    Ok(frame)
}

/// A JSON object with its keys in their written order.
struct OrderedObject(Vec<(String, Value)>);

impl<'de> Deserialize<'de> for OrderedObject {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Visit;
        impl<'de> serde::de::Visitor<'de> for Visit {
            type Value = OrderedObject;
            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("a JSON object")
            }
            fn visit_map<A: serde::de::MapAccess<'de>>(self, mut map: A) -> Result<OrderedObject, A::Error> {
                let mut entries = Vec::new();
                while let Some(entry) = map.next_entry::<String, Value>()? {
                    entries.push(entry);
                }
                Ok(OrderedObject(entries))
            }
        }
        deserializer.deserialize_map(Visit)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::datasources::Limits;
    use crate::datasources::frame::ResponseBudget;
    use crate::shapes::TimeRange;

    fn req(vars: Value) -> SourceQuery {
        SourceQuery {
            ref_id: "A".into(),
            query: json!({}),
            range: TimeRange { from: 1_800_000_000_000, to: 1_800_003_600_000 },
            interval_ms: 30_000,
            max_data_points: None,
            variables: serde_json::from_value(vars).unwrap(),
            identifier_variables: None,
            limits: Limits { timeout: Duration::from_secs(5), max_rows: 1000, budget: ResponseBudget::new(1 << 20) },
            cursor: None,
        }
    }

    #[test]
    fn flux_gets_its_time_range_and_escaped_variables() {
        let r = req(json!({ "host": "a\"b$c", "hosts": ["x.1", "y"] }));
        let out = expand(
            "from(bucket: v.bucket)\n  |> range(start: v.timeRangeStart, stop: v.timeRangeStop)\n  |> filter(fn: (r) => r.host == \"$host\" and r.cpu != \"${hosts}\")\n  |> aggregateWindow(every: v.windowPeriod, fn: mean) // $kommentar",
            Language::Flux,
            &r,
            Some("metriken"),
        )
        .unwrap();
        assert_eq!(
            out,
            "from(bucket: \"metriken\")\n  |> range(start: 2027-01-15T08:00:00.000Z, stop: 2027-01-15T09:00:00.000Z)\n  |> filter(fn: (r) => r.host == \"a\\\"b\\$c\" and r.cpu != \"x\\\\.1|y\")\n  |> aggregateWindow(every: 30s, fn: mean) // $kommentar"
        );
        // A Flux interpolation stays Flux's; a variable outside a string is refused.
        assert_eq!(
            expand("map(fn: (r) => ({r with s: \"${r.host}\"}))", Language::Flux, &r, None).unwrap(),
            "map(fn: (r) => ({r with s: \"${r.host}\"}))"
        );
        let reason = |text: &str| expand(text, Language::Flux, &r, None).unwrap_err().detail().reason;
        assert_eq!(reason("filter(fn: (r) => r.x == $host)"), "influxdb.variable_outside_string");
        assert_eq!(reason("range(start: $__nix)"), "influxdb.macro_unknown");
        assert_eq!(reason("filter(fn: (r) => r.x == \"$fehlt\")"), "influxdb.variable_missing");
        assert_eq!(reason("filter(fn: (r) => r.x == \"offen)"), "influxdb.unclosed");
        assert_eq!(
            expand("range(start: $__timeFrom, stop: $__timeTo)", Language::Flux, &r, None).unwrap(),
            "range(start: 2027-01-15T08:00:00.000Z, stop: 2027-01-15T09:00:00.000Z)"
        );
    }

    #[test]
    fn flux_that_writes_or_reaches_out_is_refused() {
        let reason = |text: &str| check_flux(text).unwrap_err().detail().reason;
        assert_eq!(reason("from(bucket: \"a\") |> range(start: -1h) |> to(bucket: \"b\")"), "flux.write_refused");
        assert_eq!(reason("import \"experimental\"\nx |> experimental.to(bucket: \"b\")"), "flux.write_refused");
        assert_eq!(
            reason("import \"influxdata/influxdb\"\nx |> influxdb.wideTo(bucket: \"b\")"),
            "flux.package_not_allowed"
        );
        assert_eq!(reason("import \"http\"\nhttp.post(url: \"http://x\")"), "flux.package_not_allowed");
        assert_eq!(reason("import \"sql\"\nsql.from(driverName: \"postgres\")"), "flux.package_not_allowed");
        assert_eq!(reason("import \"csv\"\ncsv.from(file: \"/etc/passwd\")"), "flux.package_not_allowed");
        assert_eq!(reason("from(bucket: \"a\", host: \"https://other\", token: \"t\")"), "flux.remote_not_allowed");
        // A write hidden in a string interpolation is code too.
        assert_eq!(reason("x = \"${to(bucket: \"b\")}\""), "flux.write_refused");
        // Aliased imports, aliased writers, shorthand and string keys, division taken for a regex.
        assert_eq!(reason("import r \"experimental/http/requests\"\nr.get(url: \"http://x\")"), "flux.import_form");
        assert_eq!(reason("import s \"strings\""), "flux.import_form");
        assert_eq!(
            reason("w = to\nfrom(bucket: \"a\") |> range(start: -1h) |> w(bucket: \"b\")"),
            "flux.write_refused"
        );
        assert_eq!(reason("import \"experimental\"\ne = experimental.to\nx |> e(bucket: \"b\")"), "flux.write_refused");
        assert_eq!(reason("f(fn: to)"), "flux.write_refused");
        assert_eq!(reason("host = \"https://other\"\nfrom(bucket: \"b\", host)"), "flux.remote_not_allowed");
        assert_eq!(reason("o = {\"host\": \"https://other\"}"), "flux.remote_not_allowed");
        assert_eq!(reason("from(bucket: \"b\", token)"), "flux.remote_not_allowed");
        assert_eq!(reason("x = 4 / 2\ny = to(bucket: \"b\") / 1"), "flux.write_refused");
        assert_eq!(reason("x = 10 /to(bucket: \"b\")/ 2"), "flux.write_refused");
        // Reads pass: record fields read as r.host, strings, regexes, division, comments.
        check_flux(
            "import \"strings\"\nfrom(bucket: \"a\") |> range(start: -1h)\n |> filter(fn: (r) => r.host =~ /to\\(/ and r[\"host\"] == \"to(\")\n |> map(fn: (r) => ({r with _value: r._value / 2.0, name: strings.toUpper(v: r.host)}))\n // to(bucket: \"x\")\n |> yield(name: \"mean\")",
        )
        .unwrap();
    }

    #[test]
    fn influxql_reads_only() {
        let reason = |text: &str| check_influxql(text).unwrap_err().detail().reason;
        assert_eq!(reason("SELECT mean(usage) INTO kopie FROM cpu GROUP BY *"), "influxql.select_into");
        assert_eq!(reason("DROP MEASUREMENT cpu"), "influxql.not_read");
        assert_eq!(reason("DELETE FROM cpu WHERE time < now()"), "influxql.not_read");
        assert_eq!(reason("CREATE DATABASE x"), "influxql.not_read");
        assert_eq!(reason("SELECT * FROM cpu; DROP DATABASE x"), "influxql.multiple_statements");
        assert_eq!(reason("  "), "influxql.empty");
        check_influxql("SELECT \"into\" FROM cpu WHERE host = 'into' AND x =~ /into/;").unwrap();
        check_influxql("show tag keys from cpu").unwrap();
        // Variables in strings and regular expressions, macros outside.
        let r = req(json!({ "host": "a'b", "hosts": ["x.1", "y/z"] }));
        let out = expand(
            "SELECT mean(\"usage\") FROM cpu WHERE host = '$host' AND dc =~ /^${hosts}$/ AND $__timeFilter GROUP BY time($__interval)",
            Language::InfluxQl,
            &r,
            None,
        )
        .unwrap();
        assert_eq!(
            out,
            "SELECT mean(\"usage\") FROM cpu WHERE host = 'a\\'b' AND dc =~ /^x\\.1|y\\/z$/ AND time >= 1800000000000ms AND time <= 1800003600000ms GROUP BY time(30s)"
        );
        assert_eq!(
            expand("SELECT * FROM cpu WHERE host = $host", Language::InfluxQl, &r, None).unwrap_err().detail().reason,
            "influxdb.variable_outside_string"
        );
    }

    #[test]
    fn sql_binds_named_parameters_and_refuses_writes() {
        let vars = BTreeMap::from([("host".to_string(), json!("a"))]);
        let ctx = sql::Context {
            range: TimeRange { from: 1_800_000_000_000, to: 1_800_003_600_000 },
            interval_ms: 60_000,
            variables: &vars,
            identifiers: None,
            identifier_variables: None,
        };
        let p = sql::prepare(
            "SELECT date_bin($__interval, time) AS t, avg(usage) FROM cpu WHERE $__timeFilter(time) AND host = $host GROUP BY 1",
            Engine::DataFusion,
            &ctx,
        )
        .unwrap();
        assert_eq!(
            p.sql,
            "SELECT date_bin(CAST($p1 AS INTERVAL), time) AS t, avg(usage) FROM cpu WHERE (time BETWEEN CAST($p2 AS TIMESTAMP) AND CAST($p3 AS TIMESTAMP)) AND host = CAST($p4 AS VARCHAR) GROUP BY 1"
        );
        assert_eq!(sql_param(&p.binds[0]), json!("60000 milliseconds"));
        assert_eq!(sql_param(&p.binds[1]), json!("2027-01-15T08:00:00.000Z"));
        for refused in
            ["DELETE FROM cpu", "INSERT INTO cpu VALUES (1)", "SELECT 1; SELECT 2", "SELECT * FROM cpu WHERE x = $1"]
        {
            assert!(sql::prepare(refused, Engine::DataFusion, &ctx).is_err(), "{refused}");
        }
    }

    #[test]
    fn only_read_endpoints_are_reached() {
        let base = Url::parse("https://influx.intern/basis/").unwrap();
        let ok = |m: Method, path: &str| check_endpoint(&base, &m, &base.join(path).unwrap()).is_ok();
        assert!(ok(Method::GET, "query?q=SHOW+DATABASES"));
        assert!(ok(Method::POST, "api/v2/query?org=o"));
        assert!(ok(Method::POST, "api/v3/query_sql"));
        assert!(!ok(Method::POST, "query"), "InfluxQL only by GET");
        assert!(!ok(Method::POST, "write?db=x"));
        assert!(!ok(Method::POST, "api/v2/write"));
        assert!(!ok(Method::POST, "api/v2/delete"));
        assert!(!ok(Method::POST, "api/v3/write_lp"));
        assert!(!ok(Method::GET, "/query"), "outside the base path");
    }

    #[test]
    fn flux_tables_become_series_with_their_group_keys() {
        let csv = "#datatype,string,long,dateTime:RFC3339,dateTime:RFC3339,dateTime:RFC3339,double,string,string,string\r\n\
#group,false,false,true,true,false,false,true,true,true\r\n\
#default,_result,,,,,,,,\r\n\
,result,table,_start,_stop,_time,_value,_field,_measurement,host\r\n\
,,0,2027-01-15T08:00:00Z,2027-01-15T09:00:00Z,2027-01-15T08:00:00Z,1.5,usage,cpu,a\r\n\
,,0,2027-01-15T08:00:00Z,2027-01-15T09:00:00Z,2027-01-15T08:00:30Z,2.5,usage,cpu,a\r\n\
,,1,2027-01-15T08:00:00Z,2027-01-15T09:00:00Z,2027-01-15T08:00:30Z,7,usage,cpu,b\r\n\
\r\n";
        let frame = flux_frame(csv.as_bytes(), &req(json!({}))).unwrap().finish();
        let f = frame.fields();
        assert_eq!(f.len(), 3);
        assert_eq!(f[0].values, [json!(1_800_000_000_000_i64), json!(1_800_000_030_000_i64)]);
        assert_eq!(f[1].name, "cpu.usage {host=\"a\"}");
        assert_eq!(f[1].labels.as_ref().unwrap()["host"], "a");
        assert_eq!(f[1].values, [json!(1.5), json!(2.5)]);
        assert_eq!(f[2].values, [Value::Null, json!(7.0)]);

        let error = "#datatype,string,string\r\n#group,true,true\r\n#default,,\r\n,error,reference\r\n,failed to compile,897\r\n";
        assert_eq!(flux_frame(error.as_bytes(), &req(json!({}))).err().unwrap().detail().reason, "influxdb.error");
    }

    #[test]
    fn influxql_series_and_sql_lines_become_frames() {
        let series = vec![
            json!({ "name": "cpu", "tags": { "host": "a" }, "columns": ["time", "mean"], "values": [[1800000000000_i64, 1.5], [1800000030000_i64, null]] }),
            json!({ "name": "cpu", "tags": { "host": "b" }, "columns": ["time", "mean"], "values": [[1800000030000_i64, 3]] }),
        ];
        let frame = influxql_frame(&series, &req(json!({}))).finish();
        assert_eq!(frame.fields()[1].name, "cpu {host=\"a\"}");
        assert_eq!(frame.fields()[2].values, [Value::Null, json!(3)]);
        let show = vec![json!({ "name": "databases", "columns": ["name"], "values": [["_internal"], ["metriken"]] })];
        let frame = influxql_frame(&show, &req(json!({}))).finish();
        assert_eq!(frame.fields()[0].name, "name");
        assert_eq!(frame.fields()[0].values, [json!("_internal"), json!("metriken")]);

        let lines = "{\"time\":\"2027-01-15T08:00:00\",\"host\":\"a\",\"usage\":1.5}\n{\"time\":\"2027-01-15T08:00:30\",\"usage\":2}\n";
        let frame = jsonl_frame(lines.as_bytes(), &req(json!({}))).unwrap().finish();
        // The JSON array InfluxDB 3 answers with `format: json` reads the same.
        let array = format!("[{}]", lines.trim().replace('\n', ","));
        assert_eq!(jsonl_frame(array.as_bytes(), &req(json!({}))).unwrap().finish(), frame);
        let names: Vec<&str> = frame.fields().iter().map(|f| f.name.as_str()).collect();
        assert_eq!(names, ["time", "host", "usage"]);
        assert_eq!(frame.fields()[0].field_type, FieldType::Time);
        assert_eq!(frame.fields()[0].values[1], json!(1_800_000_030_000_i64));
        assert_eq!(frame.fields()[1].values, [json!("a"), Value::Null]);
    }
}

/// InfluxQL, Flux and SQL texts and the server's answers are read by hand-written scanners:
/// they answer with a result or an error, never a panic.
#[cfg(test)]
mod property_tests {
    use super::*;
    use crate::datasources::Limits;
    use crate::datasources::frame::ResponseBudget;
    use crate::shapes::TimeRange;
    use proptest::prelude::*;

    fn req() -> SourceQuery {
        SourceQuery {
            ref_id: "A".into(),
            query: json!({}),
            range: TimeRange { from: 1_800_000_000_000, to: 1_800_003_600_000 },
            interval_ms: 30_000,
            max_data_points: None,
            variables: serde_json::from_value(json!({ "host": "a\"b'c$d", "hosts": ["x.1", "y/z"] })).unwrap(),
            identifier_variables: None,
            limits: Limits { timeout: Duration::from_secs(5), max_rows: 100, budget: ResponseBudget::new(1 << 20) },
            cursor: None,
        }
    }

    /// Text built from the pieces the scanners care about.
    fn query_like() -> impl Strategy<Value = String> {
        let piece = prop_oneof![
            prop::sample::select(vec![
                "SELECT ",
                "INTO ",
                "DROP ",
                "from(bucket: ",
                "|> ",
                "to(",
                "import ",
                "$host",
                "${hosts}",
                "$__timeFilter",
                "$__interval",
                "$",
                "v.timeRangeStart",
                "\"",
                "'",
                "`",
                "/",
                "\\",
                "//",
                "--",
                "/*",
                "*/",
                ";",
                "=~",
                "(",
                ")",
                "\n",
            ])
            .prop_map(str::to_string),
            "[a-zA-Z_0-9 .,=-]{0,6}",
            "\\PC{0,3}",
        ];
        prop::collection::vec(piece, 0..24).prop_map(|p| p.concat())
    }

    fn scan(text: &str) {
        let r = req();
        let _ = check_influxql(text);
        let _ = check_flux(text);
        for language in [Language::Flux, Language::InfluxQl, Language::Sql] {
            let _ = expand(text, language, &r, Some("db"));
        }
    }

    proptest! {
        // 256 cases (proptest's default), bounded for CI; PROPTEST_CASES raises it locally.
        #![proptest_config(ProptestConfig::default())]

        #[test]
        fn scanners_never_panic_on_any_text(text in "\\PC{0,200}") {
            scan(&text);
        }

        #[test]
        fn scanners_never_panic_on_query_like_text(text in query_like()) {
            scan(&text);
        }

        /// Annotated CSV and JSON lines come from the server; a broken or hostile answer is an error.
        #[test]
        fn answers_never_panic(
            body in prop::collection::vec(any::<u8>(), 0..400),
            csv in "(#[a-z,]{0,12}\r?\n|[a-z0-9,\"_:.-]{0,16}\r?\n){0,12}",
        ) {
            let r = req();
            let _ = flux_tables(&body, 10);
            let _ = flux_tables(csv.as_bytes(), 10);
            let _ = flux_frame(&body, &r);
            let _ = flux_frame(csv.as_bytes(), &r);
            let _ = jsonl_frame(&body, &r);
            let _ = sql_rows(&body);
        }
    }
}
