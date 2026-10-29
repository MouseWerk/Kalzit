//! ClickHouse over its HTTP interface, through the one client factory (`crate::http`), which
//! checks every connection and redirect target.
//!
//! Read-only twice: every request carries `readonly=1`, so the server refuses writes, DDL,
//! setting changes and most table functions, and the statement check (`sql::check_statement`)
//! accepts only one `SELECT`/`WITH` without `SETTINGS` or `FORMAT` and refuses the table
//! functions that reach files or other servers. Macros and variables are sent as query
//! parameters (`{p1:Int64}` with `param_p1=...`), never as text in the statement. Kalzit asks
//! for `JSONCompactEachRowWithNamesAndTypes` and reads the answer row by row, so it stops at the
//! row and size limits without holding the rest.

use std::sync::Arc;
use std::time::Duration;

use reqwest::header::{HeaderMap, HeaderName};
use reqwest::{Method, Url};
use serde::Deserialize;
use serde_json::value::RawValue;
use serde_json::{Value, json};

use super::Detail;
use super::frame::{Column, FrameBuilder};
use super::http_json::{header_value, parse_url};
use super::sql::{self, Bind, Engine};
use super::{
    Connection, DataSourcePlugin, DefaultValue, FieldError, Health, Kind, SettingField, SettingType, SourceError,
    SourceQuery, SourceSchema,
};
use crate::http::{HttpClient, HttpError, HttpOptions};
use crate::shapes::{FieldType, NoticeSeverity, QueryResult, Shape};

const SETTINGS: &[SettingField] = &[
    SettingField::new("url", "datasources.settings.url", SettingType::String).target().required(),
    SettingField::new("database", "datasources.settings.database", SettingType::String)
        .target()
        .default(DefaultValue::Text("default")),
    SettingField::new("user", "datasources.settings.user", SettingType::String)
        .target()
        .default(DefaultValue::Text("default")),
    SettingField::new("password", "datasources.settings.password", SettingType::String).secret(),
    SettingField::new("caCert", "datasources.settings.caCert", SettingType::Text).target(),
];
/// The client's own limit; the query timeout around each call is usually shorter.
const CLIENT_TIMEOUT: Duration = Duration::from_secs(3600);
/// Health and schema answers are read up to this size.
const MAX_SMALL_RESPONSE: usize = 16 * 1024 * 1024;
const MAX_SCHEMA_COLUMNS: usize = 20_000;
/// The format Kalzit asks for: a line of names, a line of types, then one JSON array per row.
const FORMAT: &str = "JSONCompactEachRowWithNamesAndTypes";
/// ClickHouse's error code for a refused change in read-only mode.
const READONLY_CODE: &str = "164";

pub fn kind() -> Kind {
    Kind {
        name: "ClickHouse",
        hint_key: "datasources.kinds.clickhouse.hint",
        settings: SETTINGS,
        plugin: Arc::new(ClickHouse),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Settings {
    url: String,
    database: Option<String>,
    user: Option<String>,
    ca_cert: Option<String>,
}

pub struct ClickHouse;

struct Client {
    http: HttpClient,
    base: Url,
    database: String,
    headers: HeaderMap,
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
        let mut headers = HeaderMap::new();
        let user = s.user.filter(|u| !u.trim().is_empty()).unwrap_or_else(|| "default".into());
        headers.insert(
            HeaderName::from_static("x-clickhouse-user"),
            header_value(&user, "clickhouse.credentials_invalid")?,
        );
        if let Some(password) = conn.secret("password") {
            headers.insert(
                HeaderName::from_static("x-clickhouse-key"),
                header_value(password, "clickhouse.credentials_invalid")?,
            );
        }
        let database = s.database.filter(|d| !d.trim().is_empty()).unwrap_or_else(|| "default".into());
        Ok(Client { http, base, database, headers })
    })
    .await
}

/// The statement as sent: without a closing semicolon, and with the format Kalzit reads. The
/// format goes on its own line, so a comment at the end cannot swallow it.
fn statement(sql: &str) -> String {
    let body = sql.trim_end().trim_end_matches(';').trim_end();
    format!("{body}\nFORMAT {FORMAT}")
}

/// A bound value as ClickHouse reads a query parameter's text: strings in its escaped form,
/// `\N` for NULL, times as Unix milliseconds, intervals as the unit `sql` chose.
fn param_value(bind: &Bind) -> String {
    match bind {
        Bind::Null => "\\N".into(),
        Bind::Bool(b) => b.to_string(),
        Bind::Int(i) => i.to_string(),
        Bind::Float(f) if f.is_nan() => "nan".into(),
        Bind::Float(f) if f.is_infinite() => if *f > 0.0 { "inf" } else { "-inf" }.into(),
        Bind::Float(f) => f.to_string(),
        Bind::Text(t) => {
            let mut out = String::with_capacity(t.len());
            for c in t.chars() {
                match c {
                    '\\' => out.push_str("\\\\"),
                    '\t' => out.push_str("\\t"),
                    '\n' => out.push_str("\\n"),
                    '\r' => out.push_str("\\r"),
                    '\0' => out.push_str("\\0"),
                    '\'' => out.push_str("\\'"),
                    c => out.push(c),
                }
            }
            out
        }
        Bind::Time(ms) => ms.to_string(),
        Bind::Interval(ms) if ms % 1000 == 0 => (ms / 1000).to_string(),
        Bind::Interval(ms) => ms.to_string(),
    }
}

/// The query string of one request: the database, the server-side time limit, stopping the
/// query when Kalzit hangs up, read-only mode (last: after it, no setting may change) and the
/// parameters.
fn query_pairs(database: &str, timeout: Duration, binds: &[Bind]) -> Vec<(String, String)> {
    let mut pairs = vec![
        ("database".to_string(), database.to_string()),
        ("max_execution_time".into(), timeout.as_secs().max(1).to_string()),
        ("cancel_http_readonly_queries_on_client_close".into(), "1".into()),
        ("readonly".into(), "1".into()),
    ];
    pairs.extend(binds.iter().enumerate().map(|(i, b)| (format!("param_p{}", i + 1), param_value(b))));
    pairs
}

/// A ClickHouse error text (`Code: 60. DB::Exception: ...`) as a source error; a refusal of
/// read-only mode is a refused write.
fn clickhouse_error(code: Option<&str>, text: &str) -> SourceError {
    let text = text.trim();
    let code = code
        .map(str::to_string)
        .or_else(|| text.strip_prefix("Code: ").and_then(|rest| rest.split(['.', ' ']).next()).map(str::to_string));
    if code.as_deref() == Some(READONLY_CODE) {
        return SourceError::rejected("query.write_refused", format!("the query tried to write: {text}"))
            .with("detail", text);
    }
    SourceError::failed("clickhouse.error", format!("ClickHouse answered an error: {text}"))
        .with("code", code.unwrap_or_default())
        .with("detail", text)
}

impl Client {
    fn failed(&self, e: HttpError) -> SourceError {
        match e {
            HttpError::Blocked(b) => SourceError::Blocked(b.0),
            other => SourceError::Failed(other.detail()),
        }
    }

    /// Sends one statement and answers the response once ClickHouse accepted it.
    async fn send(&self, sql: &str, binds: &[Bind], timeout: Duration) -> Result<reqwest::Response, SourceError> {
        let mut url = self.base.clone();
        url.query_pairs_mut().extend_pairs(query_pairs(&self.database, timeout, binds));
        let response = self
            .http
            .send_with_body(Method::POST, url, self.headers.clone(), Some(statement(sql).into_bytes()))
            .await
            .map_err(|e| self.failed(e))?;
        if response.status().is_success() {
            return Ok(response);
        }
        let status = response.status();
        let code =
            response.headers().get("x-clickhouse-exception-code").and_then(|v| v.to_str().ok()).map(str::to_string);
        let body = crate::http::read_limited(response, MAX_SMALL_RESPONSE).await.map_err(|e| self.failed(e))?;
        let text = String::from_utf8_lossy(&body);
        if code.is_none() && !text.trim_start().starts_with("Code:") {
            return Err(SourceError::failed(
                "clickhouse.not_clickhouse",
                format!("the server answered {status} without a ClickHouse answer"),
            )
            .with("status", status.as_u16()));
        }
        Err(clickhouse_error(code.as_deref(), &text))
    }

    /// A small statement read whole: its column names and rows.
    async fn rows(&self, sql: &str) -> Result<Vec<Vec<Value>>, SourceError> {
        let response = self.send(sql, &[], super::MAX_HEALTH_TIMEOUT).await?;
        let body = crate::http::read_limited(response, MAX_SMALL_RESPONSE).await.map_err(|e| self.failed(e))?;
        let text = String::from_utf8_lossy(&body);
        let mut rows = Vec::new();
        for (i, line) in text.lines().enumerate().filter(|(_, l)| !l.trim().is_empty()) {
            let row: Vec<Value> = serde_json::from_str(line).map_err(|_| clickhouse_error(None, line))?;
            // The names and the types.
            if i >= 2 {
                rows.push(row);
            }
        }
        Ok(rows)
    }
}

#[async_trait::async_trait]
impl DataSourcePlugin for ClickHouse {
    fn kind(&self) -> &'static str {
        "clickhouse"
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
            let rows = c.rows("SELECT version()").await?;
            Ok::<_, SourceError>(rows.first().and_then(|r| r.first()).and_then(Value::as_str).unwrap_or("").to_string())
        };
        match check.await {
            Ok(version) => Health::connected("ClickHouse", &version, false),
            Err(e) => Health::failed(&e),
        }
    }

    async fn schema(&self, conn: &Connection) -> Result<SourceSchema, SourceError> {
        let c = client(conn).await?;
        let rows = c
            .rows(&format!(
                "SELECT database, table, name, type FROM system.columns WHERE database = currentDatabase() \
                 ORDER BY table, position LIMIT {MAX_SCHEMA_COLUMNS}"
            ))
            .await?;
        let text = |v: Option<&Value>| v.and_then(Value::as_str).unwrap_or("").to_string();
        let rows = rows.iter().map(|r| (text(r.first()), text(r.get(1)), text(r.get(2)), text(r.get(3)))).collect();
        Ok(SourceSchema::Tables { tables: super::postgres::group_columns(rows) })
    }

    async fn query(&self, conn: &Connection, req: SourceQuery) -> Result<QueryResult, SourceError> {
        let prepared = sql::prepare_query(self, conn, &req, Engine::ClickHouse).await?;
        let c = client(conn).await?;
        let response = c.send(&prepared.sql, &prepared.binds, req.limits.timeout).await?;
        let server_zone = response
            .headers()
            .get("x-clickhouse-timezone")
            .and_then(|v| v.to_str().ok())
            .and_then(|z| z.parse::<chrono_tz::Tz>().ok())
            .unwrap_or(chrono_tz::UTC);
        let mut reader = Reader::new(server_zone);
        let mut response = response;
        let mut frame: Option<FrameBuilder> = None;
        let mut pending: Vec<u8> = Vec::new();
        let mut stopped = false;
        'read: while let Some(chunk) = response.chunk().await.map_err(|e| c.failed(e.into()))? {
            pending.extend_from_slice(&chunk);
            while let Some(end) = pending.iter().position(|b| *b == b'\n') {
                let line: Vec<u8> = pending.drain(..=end).collect();
                if !reader.line(&line, &req, &mut frame)? {
                    stopped = true;
                    break 'read;
                }
            }
            if pending.len() > req.limits.budget.remaining().max(1 << 20) {
                // One row larger than the whole answer may be.
                if let Some(f) = frame.as_mut() {
                    f.mark_truncated(Detail::new(
                        "frame.size_limit",
                        "the result was cut off at the response size limit",
                    ));
                }
                stopped = true;
                break;
            }
        }
        if !stopped && !pending.is_empty() {
            reader.line(&pending, &req, &mut frame)?;
        }
        // Dropping the response closes the connection; ClickHouse stops the query when it can
        // no longer write the rest.
        drop(response);
        let mut frame = match frame {
            Some(f) => f,
            None => FrameBuilder::new(Vec::new(), req.limits.max_rows, req.limits.budget.clone()),
        };
        frame.executed_query(prepared.sql);
        for (name, type_name) in reader.unsupported {
            let message = format!("{name} has the type {type_name}, which is shown as text; convert it in the query");
            frame.notice(
                NoticeSeverity::Info,
                Detail::new("frame.type_unsupported", message).with("column", name).with("type", type_name),
            );
        }
        Ok(QueryResult::Frame { frame: frame.finish() })
    }
}

/// How a column's values are read, from its ClickHouse type.
#[derive(Clone, Debug, PartialEq)]
enum Decoder {
    Number,
    Int64,
    Decimal,
    Bool,
    Text,
    Date,
    /// With the column's own zone, else the server's.
    DateTime(Option<chrono_tz::Tz>),
    Json,
    /// Shown as its JSON text.
    Other,
}

impl Decoder {
    fn for_type(type_name: &str) -> Self {
        let t = unwrap_type(type_name);
        let base = t.split('(').next().unwrap_or(t).trim();
        match base {
            "Int8" | "Int16" | "Int32" | "UInt8" | "UInt16" | "UInt32" | "Float32" | "Float64" | "BFloat16" => {
                Self::Number
            }
            "Int64" | "UInt64" | "Int128" | "UInt128" | "Int256" | "UInt256" => Self::Int64,
            "Decimal" | "Decimal32" | "Decimal64" | "Decimal128" | "Decimal256" => Self::Decimal,
            "Bool" | "Boolean" => Self::Bool,
            "String" | "FixedString" | "UUID" | "Enum8" | "Enum16" | "Enum" | "IPv4" | "IPv6" => Self::Text,
            "Date" | "Date32" => Self::Date,
            "DateTime" | "DateTime64" => Self::DateTime(type_zone(t)),
            "Array" | "Map" | "Tuple" | "Nested" | "JSON" | "Object" | "Variant" | "Dynamic" => Self::Json,
            _ => Self::Other,
        }
    }

    fn field_type(&self) -> FieldType {
        match self {
            Self::Number => FieldType::Number,
            Self::Int64 => FieldType::Int64,
            Self::Decimal => FieldType::Decimal,
            Self::Bool => FieldType::Bool,
            Self::Text | Self::Other => FieldType::String,
            Self::Date => FieldType::Date,
            Self::DateTime(_) => FieldType::Time,
            Self::Json => FieldType::Json,
        }
    }

    fn decode(&self, raw: &RawValue, server_zone: chrono_tz::Tz) -> Value {
        let text = raw.get();
        if text == "null" {
            return Value::Null;
        }
        let parsed = || serde_json::from_str::<Value>(text).unwrap_or(Value::Null);
        match self {
            Self::Number => match parsed() {
                Value::Number(n) => Value::Number(n),
                Value::String(s) => {
                    s.parse::<f64>().ok().and_then(serde_json::Number::from_f64).map_or(Value::Null, Value::Number)
                }
                _ => Value::Null,
            },
            Self::Int64 => match parsed() {
                Value::String(s) => Value::String(s),
                Value::Number(n) => Value::String(n.to_string()),
                _ => Value::Null,
            },
            Self::Decimal => {
                // The number as ClickHouse wrote it, every digit kept.
                let digits = text.trim_matches('"');
                let plain = !digits.is_empty()
                    && digits.trim_start_matches('-').bytes().all(|b| b.is_ascii_digit() || b == b'.');
                if plain { Value::String(digits.to_string()) } else { Value::Null }
            }
            Self::Bool => match parsed() {
                Value::Bool(b) => Value::Bool(b),
                Value::Number(n) => Value::Bool(n.as_i64() != Some(0)),
                _ => Value::Null,
            },
            Self::Text => match parsed() {
                Value::String(s) => Value::String(s),
                other => Value::String(other.to_string()),
            },
            Self::Date => parsed()
                .as_str()
                .and_then(|s| chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").ok())
                .and_then(|d| d.and_hms_opt(0, 0, 0))
                .map_or(Value::Null, |t| json!(super::naive_to_ms(t))),
            Self::DateTime(zone) => parsed()
                .as_str()
                .and_then(|s| datetime_ms(s, zone.unwrap_or(server_zone)))
                .map_or(Value::Null, |ms| json!(ms)),
            Self::Json => parsed(),
            Self::Other => Value::String(text.to_string()),
        }
    }
}

/// The type inside `Nullable(...)` and `LowCardinality(...)`.
fn unwrap_type(type_name: &str) -> &str {
    let mut t = type_name.trim();
    loop {
        let inner =
            ["Nullable(", "LowCardinality("].iter().find_map(|w| t.strip_prefix(w).and_then(|r| r.strip_suffix(')')));
        match inner {
            Some(i) => t = i.trim(),
            None => return t,
        }
    }
}

/// The zone of `DateTime('Europe/Berlin')` or `DateTime64(3, 'UTC')`.
fn type_zone(type_name: &str) -> Option<chrono_tz::Tz> {
    let start = type_name.find('\'')?;
    let end = type_name[start + 1..].find('\'')? + start + 1;
    type_name[start + 1..end].parse().ok()
}

/// `2026-10-29 12:00:00[.123456]` in `zone` as Unix milliseconds.
fn datetime_ms(text: &str, zone: chrono_tz::Tz) -> Option<i64> {
    use chrono::TimeZone as _;
    let naive = chrono::NaiveDateTime::parse_from_str(text, "%Y-%m-%d %H:%M:%S%.f").ok()?;
    zone.from_local_datetime(&naive).earliest().map(|t| t.timestamp_millis())
}

/// Reads the answer line by line: names, types, then rows into the frame.
struct Reader {
    server_zone: chrono_tz::Tz,
    names: Option<Vec<String>>,
    decoders: Vec<Decoder>,
    unsupported: Vec<(String, String)>,
}

impl Reader {
    fn new(server_zone: chrono_tz::Tz) -> Self {
        Self { server_zone, names: None, decoders: Vec::new(), unsupported: Vec::new() }
    }

    /// Takes one line; false once the frame is full.
    fn line(&mut self, line: &[u8], req: &SourceQuery, frame: &mut Option<FrameBuilder>) -> Result<bool, SourceError> {
        let text = String::from_utf8_lossy(line);
        let text = text.trim();
        if text.is_empty() {
            return Ok(true);
        }
        // An error after the first rows arrives as text in the body.
        let row: Vec<&RawValue> = serde_json::from_str(text).map_err(|_| clickhouse_error(None, text))?;
        let Some(names) = self.names.clone() else {
            self.names =
                Some(row.iter().map(|r| serde_json::from_str::<String>(r.get()).unwrap_or_default()).collect());
            return Ok(true);
        };
        if frame.is_none() {
            let types: Vec<String> =
                row.iter().map(|r| serde_json::from_str::<String>(r.get()).unwrap_or_default()).collect();
            self.decoders = types.iter().map(|t| Decoder::for_type(t)).collect();
            for ((name, t), d) in names.iter().zip(&types).zip(&self.decoders) {
                if *d == Decoder::Other {
                    self.unsupported.push((name.clone(), t.clone()));
                }
            }
            let columns =
                names.iter().zip(&self.decoders).map(|(n, d)| Column::new(n.clone(), Some(d.field_type()))).collect();
            *frame = Some(FrameBuilder::new(columns, req.limits.max_rows, req.limits.budget.clone()));
            return Ok(true);
        }
        let values = self.decoders.iter().zip(row.iter()).map(|(d, raw)| d.decode(raw, self.server_zone)).collect();
        Ok(frame.as_mut().is_some_and(|f| f.push_row(values)))
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;
    use crate::datasources::Limits;
    use crate::datasources::frame::ResponseBudget;
    use crate::shapes::TimeRange;

    fn req() -> SourceQuery {
        SourceQuery {
            ref_id: "A".into(),
            query: json!({}),
            range: TimeRange { from: 1_800_000_000_000, to: 1_800_003_600_000 },
            interval_ms: 60_000,
            max_data_points: None,
            variables: BTreeMap::from([("land".into(), json!("Öster'reich\\")), ("ids".into(), json!([1, 2]))]),
            identifier_variables: None,
            limits: Limits { timeout: Duration::from_secs(5), max_rows: 2, budget: ResponseBudget::new(1 << 20) },
            cursor: None,
        }
    }

    fn prepare(sql_text: &str) -> Result<sql::Prepared, sql::Rejected> {
        let r = req();
        let ctx = sql::Context {
            range: r.range,
            interval_ms: r.interval_ms,
            variables: &r.variables,
            identifiers: None,
            identifier_variables: None,
        };
        sql::prepare(sql_text, Engine::ClickHouse, &ctx)
    }

    #[test]
    fn macros_and_variables_become_query_parameters() {
        let p = prepare(
            "SELECT toStartOfInterval(t, $__interval) AS t, count() FROM events \
             WHERE $__timeFilter(t) AND land = $land AND id IN ($ids) GROUP BY t ORDER BY t",
        )
        .unwrap();
        assert_eq!(
            p.sql,
            "SELECT toStartOfInterval(t, toIntervalSecond({p1:Int64})) AS t, count() FROM events \
             WHERE (t BETWEEN fromUnixTimestamp64Milli({p2:Int64}, 'UTC') AND fromUnixTimestamp64Milli({p3:Int64}, 'UTC')) \
             AND land = {p4:String} AND id IN ({p5:Int64}, {p6:Int64}) GROUP BY t ORDER BY t"
        );
        let pairs = query_pairs("db", Duration::from_secs(30), &p.binds);
        assert_eq!(pairs[0], ("database".into(), "db".into()));
        assert_eq!(pairs[1], ("max_execution_time".into(), "30".into()));
        assert_eq!(pairs[2], ("cancel_http_readonly_queries_on_client_close".into(), "1".into()));
        assert_eq!(pairs[3], ("readonly".into(), "1".into()), "read-only mode comes after the settings");
        assert_eq!(pairs[4], ("param_p1".into(), "60".into()));
        assert_eq!(pairs[5], ("param_p2".into(), "1800000000000".into()));
        assert_eq!(pairs[7], ("param_p4".into(), "Öster\\'reich\\\\".into()));
        assert_eq!(param_value(&Bind::Null), "\\N");
        assert_eq!(param_value(&Bind::Interval(250)), "250");
        assert_eq!(statement("SELECT 1; "), format!("SELECT 1\nFORMAT {FORMAT}"));
        assert_eq!(statement("SELECT 1 -- Ende"), format!("SELECT 1 -- Ende\nFORMAT {FORMAT}"));
        // A variable inside a string stays text.
        assert_eq!(prepare("SELECT '$land' AS x").unwrap().sql, "SELECT '$land' AS x");
    }

    #[test]
    fn writes_settings_formats_and_outside_reads_are_refused() {
        let reason = |sql_text: &str| prepare(sql_text).unwrap_err().reason;
        assert_eq!(reason("INSERT INTO t VALUES (1)"), "sql.not_select");
        assert!(prepare("ALTER TABLE t DELETE WHERE 1").is_err());
        assert_eq!(reason("DROP TABLE t"), "sql.not_select");
        assert_eq!(reason("SELECT 1; DROP TABLE t"), "sql.multiple_statements");
        assert_eq!(reason("SELECT * FROM t SETTINGS readonly = 0"), "sql.settings_clause");
        assert_eq!(reason("SELECT * FROM t FORMAT CSV"), "sql.format_clause");
        assert_eq!(reason("SELECT * FROM url('http://169.254.169.254/', CSV)"), "sql.function_not_allowed");
        assert_eq!(reason("SELECT * FROM file('/etc/passwd')"), "sql.function_not_allowed");
        assert_eq!(reason("SELECT * FROM remote('db:9000', system.users)"), "sql.function_not_allowed");
        assert_eq!(reason("SELECT * FROM s3('https://x/y.csv')"), "sql.function_not_allowed");
        assert_eq!(reason("SELECT * FROM t WHERE x = {name:String}"), "sql.placeholder");
        // Text that looks like Kalzit's own parameters, in comments, strings or quoted names,
        // stays text for the checker: what it checks is what ClickHouse runs.
        for hidden in [
            "-- {p1:\nSELECT * FROM url('http://169.254.169.254/latest', CSV) -- }\nSELECT 1",
            "SELECT 1 /* {p1: */ FROM url('http://x/', CSV) /* } */",
            "SELECT '{p1:' AS a, * FROM url('http://x/', CSV) AS `}`",
            "SELECT `{p1:` FROM file('/etc/passwd') AS `}`",
            "-- {p1:\nKILL QUERY WHERE 1 -- }\nSELECT 1",
        ] {
            assert!(prepare(hidden).is_err(), "{hidden}");
        }
        assert_eq!(reason("SELECT 1 AS a\0, 2"), "sql.nul_character");
        // ClickHouse reads `\`` and `\"` inside quoted names as escapes; the checker would end the
        // name there and see a column where ClickHouse sees url().
        for escaped in [
            "SELECT `a\\` FROM url('http://169.254.169.254/', CSV) AS `b` FROM t",
            "SELECT `a\\`, url('http://x/', CSV) AS `` FROM t",
            "SELECT \"a\\\", file('/etc/passwd') AS \"b\" FROM t",
            "SELECT \"x\\\\\" FROM t",
        ] {
            assert_eq!(reason(escaped), "sql.identifier_backslash", "{escaped}");
        }
        prepare("SELECT `Zeit punkt`, \"Land\" FROM t").unwrap();
        assert_eq!(reason("SELECT 1 # Kommentar"), "sql.hash_comment");
        assert_eq!(reason("SELECT a$land FROM t"), "sql.dollar_in_name");
        prepare("SELECT a FROM t WHERE land = $land").unwrap();
        for statement in
            ["KILL QUERY WHERE 1", "SHOW CREATE USER default", "SHOW GRANTS", "SHOW ACCESS", "SYSTEM RELOAD CONFIG"]
        {
            assert!(prepare(statement).is_err(), "{statement}");
        }
        assert_eq!(reason("SELECT file('/etc/passwd')"), "sql.function_not_allowed");
        for function in [
            "oss('x')",
            "cosn('x')",
            "icebergLocal('/x')",
            "deltaLakeAzure('x')",
            "hudiCluster('c', 'x')",
            "icebergS3Cluster('c', 'x')",
        ] {
            assert_eq!(reason(&format!("SELECT * FROM {function}")), "sql.function_not_allowed", "{function}");
        }
        // Reads pass, including ClickHouse's own syntax.
        prepare("SELECT count() FROM t FINAL WHERE x > 1 LIMIT 10").unwrap();
        prepare("SELECT 1 -- Kommentar").unwrap();
        prepare("SELECT '# kein Kommentar' AS a").unwrap();
        prepare("SELECT '{name:String}' AS text").unwrap();
    }

    #[test]
    fn identifier_variables_never_carry_quotes_backslashes_or_nul() {
        let names: std::collections::BTreeSet<String> =
            ["events", "a`b", "a\\b", "a\"b", "a\0b"].iter().map(|s| s.to_string()).collect();
        for (value, ok) in [("events", true), ("a`b", false), ("a\\b", false), ("a\"b", false), ("a\0b", false)] {
            let vars = BTreeMap::from([("t".to_string(), json!(value))]);
            let ctx = sql::Context {
                range: req().range,
                interval_ms: 1000,
                variables: &vars,
                identifiers: Some(&names),
                identifier_variables: None,
            };
            let p = sql::prepare("SELECT * FROM ${t:identifier}", Engine::ClickHouse, &ctx);
            match ok {
                true => assert_eq!(p.unwrap().sql, "SELECT * FROM `events`"),
                false => assert_eq!(p.unwrap_err().reason, "sql.identifier_characters", "{value:?}"),
            }
        }
    }

    #[test]
    fn errors_name_refused_writes() {
        let e = clickhouse_error(
            Some("164"),
            "Code: 164. DB::Exception: Cannot execute query in readonly mode. (READONLY)",
        );
        assert_eq!(e.detail().reason, "query.write_refused");
        let e =
            clickhouse_error(None, "Code: 60. DB::Exception: Unknown table expression identifier 'x'. (UNKNOWN_TABLE)");
        assert_eq!(e.detail().reason, "clickhouse.error");
        assert_eq!(e.detail().params["code"], "60");
    }

    #[test]
    fn rows_become_a_frame_with_types_and_zones() {
        let mut reader = Reader::new(chrono_tz::Europe::Berlin);
        let r = req();
        let mut frame = None;
        let lines = [
            r#"["t","t_utc","n","big","price","name","day","tags","ok"]"#,
            r#"["DateTime","DateTime64(3, 'UTC')","Nullable(UInt32)","Int64","Decimal(10, 2)","LowCardinality(String)","Date","Array(String)","Bool"]"#,
            r#"["2026-10-29 13:00:00","2026-10-29 12:00:00.250",7,"9007199254740993",12.50,"Graz","2026-10-29",["a","b"],true]"#,
            r#"["2026-10-29 14:00:00","2026-10-29 13:00:00.000",null,"1",-1.00,"Linz","2026-10-30",[],false]"#,
            r#"["2026-10-29 15:00:00","2026-10-29 14:00:00.000",1,"2",0.00,"Wien","2026-10-31",[],true]"#,
        ];
        let mut results = Vec::new();
        for line in lines {
            results.push(reader.line(line.as_bytes(), &r, &mut frame).unwrap());
        }
        assert_eq!(results, [true, true, true, true, false], "the row limit is two");
        let frame = frame.unwrap().finish();
        let f = frame.fields();
        let types: Vec<FieldType> = f.iter().map(|f| f.field_type).collect();
        assert_eq!(
            types,
            [
                FieldType::Time,
                FieldType::Time,
                FieldType::Number,
                FieldType::Int64,
                FieldType::Decimal,
                FieldType::String,
                FieldType::Date,
                FieldType::Json,
                FieldType::Bool
            ]
        );
        // 13:00 in Berlin (summer time until 25 October, so winter time here) is 12:00 UTC.
        assert_eq!(f[0].values[0], json!(1_793_275_200_000_i64));
        assert_eq!(f[1].values[0], json!(1_793_275_200_250_i64));
        assert_eq!(f[2].values, [json!(7), Value::Null]);
        assert_eq!(f[3].values[0], json!("9007199254740993"));
        assert_eq!(f[4].values, [json!("12.50"), json!("-1.00")]);
        assert_eq!(f[7].values[0], json!(["a", "b"]));
        let error = reader.line(b"Code: 241. DB::Exception: Memory limit exceeded", &r, &mut None);
        assert!(error.is_err());
    }
}
