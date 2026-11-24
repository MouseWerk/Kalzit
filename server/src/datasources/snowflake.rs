//! Snowflake over its SQL API (`/api/v2/statements`), signed in with key-pair authentication: a
//! JWT signed with the user's RSA private key from the secret store.
//!
//! Snowflake has no read-only session or transaction, so the role's privileges are the boundary
//! (docs/guide/warehouses.md recommends a role with only USAGE and SELECT). Kalzit's statement
//! check is the second line: one `SELECT`/`WITH` only (the API runs exactly one statement, as
//! `MULTI_STATEMENT_COUNT` is 1), no stages (`@name`), no `SYSTEM$` functions, no `$$` strings.
//! Macros and variables are positional bindings (`?`), never text in the statement. Every
//! statement runs with the query time limit as Snowflake's own `timeout`, in UTC, with a query
//! tag and at most one row more than the row limit (`ROWS_PER_RESULTSET`); one that Kalzit stops
//! waiting for is cancelled.

use std::io::Read as _;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use reqwest::header::{HeaderName, HeaderValue};
use reqwest::{Method, Url};
use serde::Deserialize;
use serde_json::{Value, json};
use zeroize::Zeroizing;

use super::frame::{Column, FrameBuilder};
use super::http_json::parse_url;
use super::http_source::Scrubber;
use super::sql::{self, Bind, Engine};
use super::warehouse::{self, Answer, CancelGuard, RsaKey, TokenCache};
use super::{
    Connection, DataSourcePlugin, FieldError, Health, Kind, SettingField, SettingType, SourceError, SourceQuery,
    SourceSchema,
};
use crate::http::{HttpClient, HttpOptions};
use crate::shapes::{FieldType, QueryResult, Shape};

const SETTINGS: &[SettingField] = &[
    SettingField::new("account", "datasources.settings.account", SettingType::String).target().required(),
    SettingField::new("user", "datasources.settings.user", SettingType::String).target().required(),
    SettingField::new("privateKey", "datasources.settings.privateKey", SettingType::Text).secret(),
    SettingField::new("warehouse", "datasources.settings.warehouse", SettingType::String).target(),
    SettingField::new("role", "datasources.settings.role", SettingType::String).target(),
    SettingField::new("database", "datasources.settings.database", SettingType::String),
    SettingField::new("schema", "datasources.settings.schema", SettingType::String),
    SettingField::new("url", "datasources.settings.snowflakeUrl", SettingType::String).target(),
];

/// The JWT's lifetime; Snowflake accepts at most one hour.
const JWT_LIFETIME: Duration = Duration::from_secs(3540);
/// The SQL API's codes for a JWT it does not accept.
const JWT_REFUSED: &[&str] = &["390144", "390142", "390318", "390186"];

pub fn kind() -> Kind {
    Kind {
        name: "Snowflake",
        hint_key: "datasources.kinds.snowflake.hint",
        settings: SETTINGS,
        plugin: Arc::new(Snowflake),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Settings {
    account: String,
    user: String,
    warehouse: Option<String>,
    role: Option<String>,
    database: Option<String>,
    schema: Option<String>,
    url: Option<String>,
}

pub struct Snowflake;

struct Client {
    http: HttpClient,
    base: Url,
    /// `ACCOUNT.USER` as the JWT names the subject.
    subject: String,
    key: RsaKey,
    context: Value,
    tokens: TokenCache,
    scrubber: Scrubber,
}

/// Account identifiers: the organization-account form (`myorg-myaccount`) or a locator with an
/// optional region and cloud (`xy12345.eu-central-1.aws`).
fn valid_account(a: &str) -> bool {
    !a.is_empty() && a.len() <= 255 && a.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
}

/// The account as the JWT names it: upper case, without region or cloud (`XY12345`), and with
/// the organization form kept (`MYORG-MYACCOUNT`).
fn jwt_account(account: &str) -> String {
    account.split('.').next().unwrap_or(account).to_ascii_uppercase()
}

/// `https://<account>.snowflakecomputing.com`; underscores in the account name become hyphens
/// in the host name.
fn default_url(account: &str) -> String {
    format!("https://{}.snowflakecomputing.com", account.to_ascii_lowercase().replace('_', "-"))
}

fn non_empty(s: Option<String>) -> Option<String> {
    s.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

async fn client(conn: &Connection) -> Result<Arc<Client>, SourceError> {
    conn.shared(|| async {
        let s: Settings = conn.settings_as()?;
        let account = s.account.trim().to_string();
        let url = non_empty(s.url).unwrap_or_else(|| default_url(&account));
        let base = parse_url(&url, false).map_err(SourceError::Failed)?;
        let http = crate::http::client(HttpOptions {
            timeout: warehouse::CLIENT_TIMEOUT,
            extra_root_pem: None,
            policy: Arc::new(conn.policy().clone()),
        })
        .map_err(|e| SourceError::failed("source.error", e.to_string()))?;
        let pem = conn.secret("privateKey").ok_or_else(|| {
            SourceError::failed("snowflake.private_key_missing", "enter the user's private key (PEM)")
        })?;
        let key = RsaKey::from_pem(pem, "snowflake.private_key_invalid")?;
        let mut context = serde_json::Map::new();
        for (name, value) in
            [("warehouse", s.warehouse), ("role", s.role), ("database", s.database), ("schema", s.schema)]
        {
            if let Some(v) = non_empty(value) {
                context.insert(name.into(), json!(v));
            }
        }
        Ok(Client {
            http,
            base,
            subject: format!("{}.{}", jwt_account(&account), s.user.trim().to_ascii_uppercase()),
            key,
            context: Value::Object(context),
            tokens: TokenCache::default(),
            scrubber: Scrubber::new(conn),
        })
    })
    .await
}

/// A bound value as a binding (`{"type", "value"}`, values in text). Times are milliseconds read
/// with scale 3, intervals text such as `30 seconds`.
fn binding(bind: &Bind) -> Value {
    let (ty, value): (&str, Option<String>) = match bind {
        Bind::Null => ("TEXT", None),
        Bind::Bool(b) => ("BOOLEAN", Some(b.to_string())),
        Bind::Int(i) => ("FIXED", Some(i.to_string())),
        Bind::Float(f) => ("REAL", Some(f.to_string())),
        Bind::Text(t) => ("TEXT", Some(t.clone())),
        Bind::Time(ms) => ("FIXED", Some(ms.to_string())),
        Bind::Interval(ms) => ("TEXT", Some(sql::interval_words(*ms))),
    };
    json!({ "type": ty, "value": value })
}

fn bindings(binds: &[Bind]) -> Value {
    Value::Object(binds.iter().enumerate().map(|(i, b)| ((i + 1).to_string(), binding(b))).collect())
}

/// A Snowflake error answer (`{"code", "message", "sqlState"}`) as a source error.
fn snowflake_error(json: &Value, scrubber: &Scrubber) -> SourceError {
    let code = json["code"].as_str().unwrap_or("");
    let message = json["message"].as_str().unwrap_or("");
    if JWT_REFUSED.contains(&code) {
        return super::connect::auth_failed(scrubber.scrub(message));
    }
    warehouse::warehouse_error("snowflake.error", "Snowflake", code, message, scrubber)
}

impl Client {
    async fn token(&self) -> Result<Zeroizing<String>, SourceError> {
        self.tokens
            .get(|| async {
                let now = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs());
                let fingerprint = self.key.public_key_fingerprint();
                let claims = json!({
                    "iss": format!("{}.{fingerprint}", self.subject),
                    "sub": self.subject,
                    "iat": now,
                    "exp": now + JWT_LIFETIME.as_secs(),
                });
                let jwt = self.key.sign_jwt(&json!({ "alg": "RS256", "typ": "JWT" }), &claims)?;
                Ok((jwt, JWT_LIFETIME))
            })
            .await
    }

    async fn send(&self, method: Method, path: &str, body: Option<&Value>, max: usize) -> Result<Answer, SourceError> {
        let token = self.token().await?;
        let mut headers = warehouse::bearer(&token, "snowflake.private_key_invalid")?;
        headers.insert(
            HeaderName::from_static("x-snowflake-authorization-token-type"),
            HeaderValue::from_static("KEYPAIR_JWT"),
        );
        let answer = warehouse::send(
            &self.http,
            method,
            warehouse::join(&self.base, path),
            headers,
            body.and_then(warehouse::json_body),
            max,
            &self.scrubber,
        )
        .await?;
        if answer.status.as_u16() == 401 {
            self.tokens.clear().await;
            let detail = answer.json().map_or_else(
                || answer.text(&self.scrubber),
                |j| self.scrubber.scrub(j["message"].as_str().unwrap_or("")),
            );
            return Err(super::connect::auth_failed(detail));
        }
        Ok(answer)
    }

    /// Submits a statement and waits for it: the first answer with its rows and the statement's
    /// handle. The guard is armed while it runs.
    async fn run(
        self: &Arc<Self>,
        statement: &str,
        binds: &[Bind],
        max_rows: usize,
        timeout: Duration,
        guard: &mut CancelGuard,
    ) -> Result<(Value, String), SourceError> {
        let mut body = json!({
            "statement": statement,
            "timeout": timeout.as_secs().max(1),
            "parameters": {
                "timezone": "UTC",
                "query_tag": "kalzit",
                "multi_statement_count": "1",
                "rows_per_resultset": max_rows.saturating_add(1).to_string(),
            },
        });
        for (k, v) in self.context.as_object().into_iter().flatten() {
            body[k] = v.clone();
        }
        if !binds.is_empty() {
            body["bindings"] = bindings(binds);
        }
        let path = format!("/api/v2/statements?requestId={}", uuid::Uuid::now_v7());
        let mut answer = self.send(Method::POST, &path, Some(&body), warehouse::MAX_PAGE_BYTES).await?;
        let mut attempt = 0;
        loop {
            let json = answer
                .json()
                .ok_or_else(|| warehouse::not_an_api_answer("snowflake.not_an_api_response", "Snowflake", &answer))?;
            let handle = json["statementHandle"].as_str().unwrap_or("").to_string();
            match answer.status.as_u16() {
                200 => return Ok((json, handle)),
                // Still running (code 333334), or too many requests for now.
                202 | 429 if !handle.is_empty() => {
                    let c = self.clone();
                    let h = handle.clone();
                    guard.arm(async move { c.cancel(&h).await });
                    tokio::time::sleep(warehouse::poll_delay(attempt)).await;
                    attempt += 1;
                    answer = self
                        .send(Method::GET, &format!("/api/v2/statements/{handle}"), None, warehouse::MAX_PAGE_BYTES)
                        .await?;
                }
                _ if json["message"].is_string() => return Err(snowflake_error(&json, &self.scrubber)),
                _ => return Err(warehouse::not_an_api_answer("snowflake.not_an_api_response", "Snowflake", &answer)),
            }
        }
    }

    /// One more result partition; Snowflake sends those compressed.
    async fn partition(&self, handle: &str, n: usize) -> Result<Vec<Vec<Value>>, SourceError> {
        let answer = self
            .send(Method::GET, &format!("/api/v2/statements/{handle}?partition={n}"), None, warehouse::MAX_PAGE_BYTES)
            .await?;
        if !answer.status.is_success() {
            let json = answer.json().unwrap_or(Value::Null);
            return Err(snowflake_error(&json, &self.scrubber));
        }
        let gzip = answer
            .headers
            .get(reqwest::header::CONTENT_ENCODING)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v.eq_ignore_ascii_case("gzip"));
        let body = if gzip {
            let mut out = Vec::new();
            flate2::read::GzDecoder::new(answer.body.as_slice())
                .take(warehouse::MAX_PAGE_BYTES as u64 + 1)
                .read_to_end(&mut out)
                .map_err(|e| {
                    SourceError::failed(
                        "snowflake.not_an_api_response",
                        format!("a result part is not valid gzip: {e}"),
                    )
                })?;
            if out.len() > warehouse::MAX_PAGE_BYTES {
                return Err(SourceError::failed("http.too_large", "a result part is too large")
                    .with("bytes", warehouse::MAX_PAGE_BYTES));
            }
            out
        } else {
            answer.body
        };
        let json: Value = serde_json::from_slice(&body)
            .map_err(|_| SourceError::failed("snowflake.not_an_api_response", "a result part is not JSON"))?;
        // A partition is the bare array of rows, or a result set with `data`.
        let rows = json.as_array().or(json["data"].as_array()).cloned().unwrap_or_default();
        Ok(rows.into_iter().map(|r| r.as_array().cloned().unwrap_or_default()).collect())
    }

    async fn cancel(&self, handle: &str) {
        if let Err(e) = self
            .send(Method::POST, &format!("/api/v2/statements/{handle}/cancel"), None, warehouse::MAX_SMALL_BYTES)
            .await
        {
            tracing::debug!("cancelling the Snowflake statement failed: {}", e.detail().message);
        }
    }

    /// A small statement read whole, as text rows (health and schema).
    async fn text_rows(self: &Arc<Self>, statement: &str, max_rows: usize) -> Result<Vec<Vec<String>>, SourceError> {
        let mut guard = CancelGuard::default();
        let (json, handle) = self.run(statement, &[], max_rows, super::MAX_HEALTH_TIMEOUT, &mut guard).await?;
        let mut rows: Vec<Vec<Value>> =
            json["data"].as_array().into_iter().flatten().map(|r| r.as_array().cloned().unwrap_or_default()).collect();
        let parts = json["resultSetMetaData"]["partitionInfo"].as_array().map_or(1, Vec::len);
        for n in 1..parts {
            if rows.len() >= max_rows {
                break;
            }
            rows.extend(self.partition(&handle, n).await?);
        }
        guard.disarm();
        rows.truncate(max_rows);
        Ok(rows.into_iter().map(|r| r.iter().map(|v| warehouse::text_of(Some(v))).collect()).collect())
    }
}

#[async_trait::async_trait]
impl DataSourcePlugin for Snowflake {
    fn kind(&self) -> &'static str {
        "snowflake"
    }

    /// Typed SQL takes ad hoc filters where it writes `$__filter` (`sql::prepare`).
    fn adhoc_filters(&self) -> bool {
        true
    }

    fn shapes(&self) -> &'static [Shape] {
        &[Shape::Frame]
    }

    fn check_settings(&self, settings: &Value) -> Result<(), FieldError> {
        let s = Settings::deserialize(settings)
            .map_err(|e| FieldError::new("settings", "settings.invalid", e.to_string()).with("detail", e))?;
        if !valid_account(s.account.trim()) {
            return Err(FieldError::new(
                "account",
                "settings.account_invalid",
                "the account identifier takes letters, digits, hyphens, underscores and dots, such as myorg-myaccount",
            ));
        }
        if let Some(url) = non_empty(s.url) {
            parse_url(&url, false).map_err(|d| FieldError { field: "url", detail: d.with("field", "url") })?;
        }
        Ok(())
    }

    async fn health(&self, conn: &Connection) -> Health {
        let check = async {
            let c = client(conn).await?;
            let rows = c.text_rows("SELECT CURRENT_VERSION()", 1).await?;
            Ok::<_, SourceError>(rows.first().and_then(|r| r.first()).cloned().unwrap_or_default())
        };
        match check.await {
            Ok(version) => Health::connected("Snowflake", &version, false),
            Err(e) => Health::failed(&e),
        }
    }

    async fn schema(&self, conn: &Connection) -> Result<SourceSchema, SourceError> {
        let c = client(conn).await?;
        let statement = format!(
            "SELECT table_schema, table_name, column_name, data_type FROM information_schema.columns \
             WHERE table_schema <> 'INFORMATION_SCHEMA' ORDER BY table_schema, table_name, ordinal_position LIMIT {}",
            warehouse::MAX_SCHEMA_COLUMNS
        );
        let rows = c.text_rows(&statement, warehouse::MAX_SCHEMA_COLUMNS).await?;
        let rows = rows
            .into_iter()
            .map(|r| {
                let at = |i: usize| r.get(i).cloned().unwrap_or_default();
                (at(0), at(1), at(2), at(3))
            })
            .collect();
        Ok(SourceSchema::Tables { tables: warehouse::tables(rows) })
    }

    async fn query(&self, conn: &Connection, req: SourceQuery) -> Result<QueryResult, SourceError> {
        let prepared = sql::prepare_query(self, conn, &req, Engine::Snowflake).await?;
        let c = client(conn).await?;
        let mut guard = CancelGuard::default();
        let (json, handle) =
            c.run(&prepared.sql, &prepared.binds, req.limits.max_rows, req.limits.timeout, &mut guard).await?;
        let meta = &json["resultSetMetaData"];
        let row_type: Vec<Value> = meta["rowType"].as_array().cloned().unwrap_or_default();
        let decoders: Vec<Decoder> = row_type.iter().map(Decoder::for_column).collect();
        let columns = row_type
            .iter()
            .zip(&decoders)
            .map(|(c, d)| Column::new(c["name"].as_str().unwrap_or(""), Some(d.field_type())))
            .collect();
        let mut frame = FrameBuilder::new(columns, req.limits.max_rows, req.limits.budget.clone());
        let push = |frame: &mut FrameBuilder, rows: &[Value]| {
            for row in rows {
                let cells = row.as_array().cloned().unwrap_or_default();
                let values = decoders.iter().zip(cells.iter()).map(|(d, v)| d.decode(v)).collect();
                if !frame.push_row(values) {
                    return false;
                }
            }
            true
        };
        let parts = meta["partitionInfo"].as_array().map_or(1, Vec::len);
        let mut more = push(&mut frame, json["data"].as_array().map_or(&[][..], Vec::as_slice));
        for n in 1..parts {
            if !more {
                break;
            }
            let rows: Vec<Value> = c.partition(&handle, n).await?.into_iter().map(Value::Array).collect();
            more = push(&mut frame, &rows);
        }
        guard.disarm();
        frame.executed_query(prepared.sql);
        Ok(QueryResult::Frame { frame: frame.finish() })
    }
}

/// How a column's values are read, from its `rowType` entry.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Decoder {
    Int,
    Decimal,
    Number,
    Text,
    Bool,
    Date,
    TimeOfDay,
    Timestamp,
    Json,
}

impl Decoder {
    fn for_column(column: &Value) -> Self {
        match column["type"].as_str().unwrap_or("").to_ascii_lowercase().as_str() {
            "fixed" if column["scale"].as_u64().unwrap_or(0) == 0 => Self::Int,
            "fixed" | "decfloat" => Self::Decimal,
            "real" => Self::Number,
            "boolean" => Self::Bool,
            "date" => Self::Date,
            "time" => Self::TimeOfDay,
            "timestamp_ntz" | "timestamp_ltz" | "timestamp_tz" => Self::Timestamp,
            "variant" | "object" | "array" | "map" | "vector" => Self::Json,
            _ => Self::Text,
        }
    }

    fn field_type(self) -> FieldType {
        match self {
            Self::Int => FieldType::Int64,
            Self::Decimal => FieldType::Decimal,
            Self::Number => FieldType::Number,
            Self::Text | Self::TimeOfDay => FieldType::String,
            Self::Bool => FieldType::Bool,
            Self::Date => FieldType::Date,
            Self::Timestamp => FieldType::Time,
            Self::Json => FieldType::Json,
        }
    }

    fn decode(self, v: &Value) -> Value {
        let Some(text) = v.as_str() else { return Value::Null };
        match self {
            Self::Int => warehouse::int_text(text),
            Self::Decimal => warehouse::decimal_text(text).map_or(Value::Null, Value::String),
            Self::Number => warehouse::number_text(text),
            Self::Text => Value::String(text.to_string()),
            Self::Bool => match text {
                "true" | "1" => Value::Bool(true),
                "false" | "0" => Value::Bool(false),
                _ => Value::Null,
            },
            // Days since the epoch.
            Self::Date => text.trim().parse::<i64>().map_or(Value::Null, |d| json!(d * 86_400_000)),
            Self::TimeOfDay => text.trim().parse::<f64>().map_or(Value::Null, |s| json!(warehouse::time_of_day(s))),
            // Seconds since the epoch; TIMESTAMP_TZ adds its offset after a space, which does not
            // change the instant.
            Self::Timestamp => {
                text.split_whitespace().next().and_then(warehouse::seconds_text_ms).map_or(Value::Null, |ms| json!(ms))
            }
            Self::Json => warehouse::json_text(text),
        }
    }
}

#[cfg(test)]
mod tests;
