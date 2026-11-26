//! Databricks SQL over the Statement Execution API (`/api/2.0/sql/statements`) on a SQL
//! warehouse, signed in with a personal access token or OAuth machine-to-machine (a service
//! principal's client ID and secret, exchanged at the workspace's `/oidc/v1/token`).
//!
//! Databricks has no read-only session, so the principal's Unity Catalog privileges are the
//! boundary (docs/guide/warehouses.md recommends only USE CATALOG, USE SCHEMA and SELECT).
//! Kalzit's statement check is the second line: one `SELECT`/`WITH`, no functions that read
//! files, streams or secrets, send HTTP requests or call model endpoints, and no tables named by
//! a file path (``parquet.`/x` ``). Macros and variables are named parameter markers (`:p1`),
//! never text in the statement. The row limit goes to Databricks as `row_limit`; a statement
//! Kalzit stops waiting for is cancelled.

use std::sync::Arc;
use std::time::Duration;

use reqwest::{Method, Url};
use serde::Deserialize;
use serde_json::{Value, json};
use zeroize::Zeroizing;

use super::frame::{Column, FrameBuilder};
use super::http_json::parse_url;
use super::http_source::{Auth as HttpAuth, Scrubber};
use super::sql::{self, Bind, Engine};
use super::warehouse::{self, Answer, CancelGuard, TokenCache};
use super::{
    Connection, DataSourcePlugin, DefaultValue, FieldError, Health, Kind, SettingField, SettingType, SourceError,
    SourceQuery, SourceSchema,
};
use crate::http::{HttpClient, HttpOptions};
use crate::shapes::{FieldType, QueryResult, Shape};

const AUTH_TYPES: &[&str] = &["token", "oauth"];

const SETTINGS: &[SettingField] = &[
    SettingField::new("url", "datasources.settings.workspaceUrl", SettingType::String).target().required(),
    SettingField::new("warehouseId", "datasources.settings.warehouseId", SettingType::String).target().required(),
    SettingField::new("catalog", "datasources.settings.catalog", SettingType::String),
    SettingField::new("schema", "datasources.settings.schema", SettingType::String),
    SettingField::new("authType", "datasources.settings.databricksAuth", SettingType::Select)
        .target()
        .options(AUTH_TYPES)
        .default(DefaultValue::Text("token")),
    SettingField::new("token", "datasources.settings.token", SettingType::String).secret(),
    SettingField::new("clientId", "datasources.settings.clientId", SettingType::String).target(),
    SettingField::new("clientSecret", "datasources.settings.clientSecret", SettingType::String).secret(),
];

/// How long one request waits for the statement before it answers (Databricks allows 5 to 50 s).
const WAIT: &str = "10s";

pub fn kind() -> Kind {
    Kind {
        name: "Databricks SQL",
        hint_key: "datasources.kinds.databricks.hint",
        settings: SETTINGS,
        plugin: Arc::new(Databricks),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Settings {
    url: String,
    warehouse_id: String,
    catalog: Option<String>,
    schema: Option<String>,
    auth_type: Option<String>,
    client_id: Option<String>,
}

pub struct Databricks;

enum Auth {
    Token(Zeroizing<String>),
    OAuth { client_id: String, secret: Zeroizing<String> },
}

struct Client {
    http: HttpClient,
    base: Url,
    warehouse_id: String,
    catalog: Option<String>,
    schema: Option<String>,
    auth: Auth,
    tokens: TokenCache,
    scrubber: Scrubber,
}

fn non_empty(s: Option<String>) -> Option<String> {
    s.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

fn valid_warehouse_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric())
}

async fn client(conn: &Connection) -> Result<Arc<Client>, SourceError> {
    conn.shared(|| async {
        let s: Settings = conn.settings_as()?;
        let base = parse_url(&s.url, false).map_err(SourceError::Failed)?;
        let http = crate::http::client(HttpOptions {
            timeout: warehouse::CLIENT_TIMEOUT,
            extra_root_pem: None,
            policy: Arc::new(conn.policy().clone()),
        })
        .map_err(|e| SourceError::failed("source.error", e.to_string()))?;
        let auth = match s.auth_type.as_deref().unwrap_or("token") {
            "oauth" => Auth::OAuth {
                client_id: non_empty(s.client_id).ok_or_else(|| {
                    SourceError::failed("databricks.credentials_missing", "enter the service principal's client ID")
                })?,
                secret: Zeroizing::new(
                    conn.secret("clientSecret")
                        .ok_or_else(|| SourceError::failed("databricks.credentials_missing", "enter the OAuth secret"))?
                        .to_string(),
                ),
            },
            _ => Auth::Token(Zeroizing::new(
                conn.secret("token")
                    .ok_or_else(|| SourceError::failed("databricks.credentials_missing", "enter the access token"))?
                    .to_string(),
            )),
        };
        Ok(Client {
            http,
            base,
            warehouse_id: s.warehouse_id.trim().to_string(),
            catalog: non_empty(s.catalog),
            schema: non_empty(s.schema),
            auth,
            tokens: TokenCache::default(),
            scrubber: Scrubber::new(conn),
        })
    })
    .await
}

/// A bound value as a named parameter (`{"name", "value", "type"}`, values in text; a missing
/// value is NULL). Times are milliseconds for `timestamp_millis`, intervals text such as
/// `30 seconds`.
fn parameter(n: usize, bind: &Bind) -> Value {
    let (ty, value): (&str, Option<String>) = match bind {
        Bind::Null => ("STRING", None),
        Bind::Bool(b) => ("BOOLEAN", Some(b.to_string())),
        Bind::Int(i) => ("BIGINT", Some(i.to_string())),
        Bind::Float(f) if f.is_nan() => ("DOUBLE", Some("NaN".into())),
        Bind::Float(f) if f.is_infinite() => ("DOUBLE", Some(if *f > 0.0 { "Infinity" } else { "-Infinity" }.into())),
        Bind::Float(f) => ("DOUBLE", Some(f.to_string())),
        Bind::Text(t) => ("STRING", Some(t.clone())),
        Bind::Time(ms) => ("BIGINT", Some(ms.to_string())),
        Bind::Interval(ms) => ("STRING", Some(sql::interval_words(*ms))),
    };
    let mut p = json!({ "name": format!("p{n}"), "type": ty });
    if let Some(v) = value {
        p["value"] = json!(v);
    }
    p
}

/// A Databricks error (`{"error_code", "message"}`, or a statement's `status.error`).
fn databricks_error(error: &Value, scrubber: &Scrubber) -> SourceError {
    let code = error["error_code"].as_str().unwrap_or("");
    let message = error["message"].as_str().unwrap_or("");
    if matches!(code, "PERMISSION_DENIED" | "UNAUTHENTICATED" | "401" | "403")
        && message.to_ascii_lowercase().contains("token")
    {
        return super::connect::auth_failed(scrubber.scrub(message));
    }
    warehouse::warehouse_error("databricks.error", "Databricks", code, message, scrubber)
}

impl Client {
    async fn token(&self) -> Result<Zeroizing<String>, SourceError> {
        match &self.auth {
            Auth::Token(t) => Ok(t.clone()),
            Auth::OAuth { client_id, secret } => {
                self.tokens
                    .get(|| async {
                        let mut scrubber = self.scrubber.clone();
                        let mut headers = reqwest::header::HeaderMap::new();
                        let auth = HttpAuth::Basic { user: client_id, password: secret };
                        headers.insert(
                            reqwest::header::AUTHORIZATION,
                            auth.header("databricks.credentials_invalid", &mut scrubber)?,
                        );
                        let body = warehouse::form_body(&[("grant_type", "client_credentials"), ("scope", "all-apis")]);
                        let url = warehouse::join(&self.base, "/oidc/v1/token");
                        let answer = warehouse::send(
                            &self.http,
                            Method::POST,
                            url,
                            headers,
                            body,
                            warehouse::MAX_SMALL_BYTES,
                            &scrubber,
                        )
                        .await?;
                        let json = answer.json().unwrap_or(Value::Null);
                        match json["access_token"].as_str() {
                            Some(t) if answer.status.is_success() => Ok((
                                Zeroizing::new(t.to_string()),
                                Duration::from_secs(json["expires_in"].as_u64().unwrap_or(3600)),
                            )),
                            _ => Err(super::connect::auth_failed(format!(
                                "{}: {}",
                                answer.status,
                                answer.text(&scrubber)
                            ))),
                        }
                    })
                    .await
            }
        }
    }

    async fn send(&self, method: Method, path: &str, body: Option<&Value>) -> Result<Answer, SourceError> {
        let token = self.token().await?;
        let headers = warehouse::bearer(&token, "databricks.credentials_invalid")?;
        let answer = warehouse::send(
            &self.http,
            method,
            warehouse::join(&self.base, path),
            headers,
            body.and_then(warehouse::json_body),
            warehouse::MAX_PAGE_BYTES,
            &self.scrubber,
        )
        .await?;
        if answer.status.as_u16() == 401 || (answer.status.as_u16() == 403 && answer.json().is_none()) {
            self.tokens.clear().await;
            return Err(super::connect::auth_failed(format!("{}: {}", answer.status, answer.text(&self.scrubber))));
        }
        Ok(answer)
    }

    /// The answer as JSON, or the API's error.
    fn json(&self, answer: &Answer) -> Result<Value, SourceError> {
        let json = answer
            .json()
            .ok_or_else(|| warehouse::not_an_api_answer("databricks.not_an_api_response", "Databricks", answer))?;
        if answer.status.is_success() {
            Ok(json)
        } else if json["message"].is_string() {
            Err(databricks_error(&json, &self.scrubber))
        } else {
            Err(warehouse::not_an_api_answer("databricks.not_an_api_response", "Databricks", answer))
        }
    }

    /// Submits a statement and waits until it succeeded: the answer with the manifest and the
    /// first chunk of rows. The guard is armed while it runs.
    async fn run(
        self: &Arc<Self>,
        statement: &str,
        binds: &[Bind],
        max_rows: usize,
        guard: &mut CancelGuard,
    ) -> Result<Value, SourceError> {
        let mut body = json!({
            "statement": statement,
            "warehouse_id": self.warehouse_id,
            "wait_timeout": WAIT,
            "on_wait_timeout": "CONTINUE",
            "disposition": "INLINE",
            "format": "JSON_ARRAY",
            "row_limit": max_rows.saturating_add(1),
        });
        if let Some(c) = &self.catalog {
            body["catalog"] = json!(c);
        }
        if let Some(s) = &self.schema {
            body["schema"] = json!(s);
        }
        if !binds.is_empty() {
            body["parameters"] = Value::Array(binds.iter().enumerate().map(|(i, b)| parameter(i + 1, b)).collect());
        }
        let answer = self.send(Method::POST, "/api/2.0/sql/statements", Some(&body)).await?;
        let mut json = self.json(&answer)?;
        let id = json["statement_id"].as_str().unwrap_or("").to_string();
        let mut attempt = 0;
        loop {
            match json["status"]["state"].as_str().unwrap_or("") {
                "SUCCEEDED" => return Ok(json),
                "PENDING" | "RUNNING" if !id.is_empty() => {
                    let c = self.clone();
                    let i = id.clone();
                    guard.arm(async move { c.cancel(&i).await });
                    tokio::time::sleep(warehouse::poll_delay(attempt)).await;
                    attempt += 1;
                    let answer = self.send(Method::GET, &format!("/api/2.0/sql/statements/{id}"), None).await?;
                    json = self.json(&answer)?;
                }
                "FAILED" => {
                    guard.disarm();
                    return Err(databricks_error(&json["status"]["error"], &self.scrubber));
                }
                state => {
                    guard.disarm();
                    let state = if state.is_empty() { "unknown" } else { state };
                    return Err(SourceError::failed(
                        "databricks.statement_state",
                        format!("the statement ended as {state} without a result"),
                    )
                    .with("state", state));
                }
            }
        }
    }

    /// The next chunk of rows after `result`, when there is one.
    async fn next_chunk(&self, result: &Value) -> Result<Option<Value>, SourceError> {
        let Some(link) = result["next_chunk_internal_link"].as_str() else { return Ok(None) };
        // Only links into this API; the link comes from the answer, so it is not followed blindly.
        if !link.starts_with("/api/2.0/sql/statements/") || link.contains("..") {
            return Err(SourceError::failed(
                "databricks.not_an_api_response",
                "the next part of the result is not an API link",
            ));
        }
        let answer = self.send(Method::GET, link, None).await?;
        self.json(&answer).map(Some)
    }

    async fn cancel(&self, id: &str) {
        if let Err(e) = self.send(Method::POST, &format!("/api/2.0/sql/statements/{id}/cancel"), None).await {
            tracing::debug!("cancelling the Databricks statement failed: {}", e.detail().message);
        }
    }

    /// A small statement read whole, as text rows (health and schema).
    async fn text_rows(self: &Arc<Self>, statement: &str, max_rows: usize) -> Result<Vec<Vec<String>>, SourceError> {
        let mut guard = CancelGuard::default();
        let json = self.run(statement, &[], max_rows, &mut guard).await?;
        let mut rows: Vec<Vec<String>> = Vec::new();
        let mut result = json["result"].clone();
        loop {
            for row in result["data_array"].as_array().into_iter().flatten() {
                rows.push(row.as_array().into_iter().flatten().map(|v| warehouse::text_of(Some(v))).collect());
            }
            if rows.len() >= max_rows {
                break;
            }
            match self.next_chunk(&result).await? {
                Some(next) => result = next,
                None => break,
            }
        }
        guard.disarm();
        rows.truncate(max_rows);
        Ok(rows)
    }
}

#[async_trait::async_trait]
impl DataSourcePlugin for Databricks {
    fn kind(&self) -> &'static str {
        "databricks"
    }

    fn shapes(&self) -> &'static [Shape] {
        &[Shape::Frame]
    }

    fn check_settings(&self, settings: &Value) -> Result<(), FieldError> {
        let s = Settings::deserialize(settings)
            .map_err(|e| FieldError::new("settings", "settings.invalid", e.to_string()).with("detail", e))?;
        parse_url(&s.url, false).map_err(|d| FieldError { field: "url", detail: d.with("field", "url") })?;
        if !valid_warehouse_id(s.warehouse_id.trim()) {
            return Err(FieldError::new(
                "warehouseId",
                "settings.warehouse_id_invalid",
                "the warehouse ID takes letters and digits, as in the warehouse's connection details",
            ));
        }
        if s.auth_type.as_deref() == Some("oauth") && non_empty(s.client_id).is_none() {
            return Err(FieldError::new("clientId", "settings.required", "clientId is required for OAuth"));
        }
        Ok(())
    }

    async fn health(&self, conn: &Connection) -> Health {
        let check = async {
            let c = client(conn).await?;
            let rows = c.text_rows("SELECT version()", 1).await?;
            Ok::<_, SourceError>(rows.first().and_then(|r| r.first()).cloned().unwrap_or_default())
        };
        match check.await {
            Ok(version) => Health::connected("Databricks SQL", version.split_whitespace().next().unwrap_or(""), false),
            Err(e) => Health::failed(&e),
        }
    }

    async fn schema(&self, conn: &Connection) -> Result<SourceSchema, SourceError> {
        let c = client(conn).await?;
        let statement = format!(
            "SELECT table_schema, table_name, column_name, data_type FROM information_schema.columns \
             WHERE table_schema <> 'information_schema' ORDER BY table_schema, table_name, ordinal_position LIMIT {}",
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
        let prepared = sql::prepare_query(self, conn, &req, Engine::Databricks).await?;
        let c = client(conn).await?;
        let mut guard = CancelGuard::default();
        let json = c.run(&prepared.sql, &prepared.binds, req.limits.max_rows, &mut guard).await?;
        let columns_json: Vec<Value> = json["manifest"]["schema"]["columns"].as_array().cloned().unwrap_or_default();
        let decoders: Vec<Decoder> = columns_json.iter().map(Decoder::for_column).collect();
        let columns = columns_json
            .iter()
            .zip(&decoders)
            .map(|(c, d)| Column::new(c["name"].as_str().unwrap_or(""), Some(d.field_type())))
            .collect();
        let mut frame = FrameBuilder::new(columns, req.limits.max_rows, req.limits.budget.clone());
        let mut result = json["result"].clone();
        'chunks: loop {
            for row in result["data_array"].as_array().into_iter().flatten() {
                let cells = row.as_array().cloned().unwrap_or_default();
                let values = decoders.iter().zip(cells.iter()).map(|(d, v)| d.decode(v)).collect();
                if !frame.push_row(values) {
                    break 'chunks;
                }
            }
            match c.next_chunk(&result).await? {
                Some(next) => result = next,
                None => break,
            }
        }
        guard.disarm();
        frame.fill_gaps(prepared.fill);
        frame.executed_query(prepared.sql);
        Ok(QueryResult::Frame { frame: frame.finish() })
    }
}

/// How a column's values are read, from its `type_name`.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Decoder {
    Int64,
    Number,
    Decimal,
    Bool,
    Text,
    Date,
    Timestamp,
    Json,
}

impl Decoder {
    fn for_column(column: &Value) -> Self {
        match column["type_name"].as_str().unwrap_or("") {
            "LONG" | "BIGINT" => Self::Int64,
            "BYTE" | "SHORT" | "INT" | "TINYINT" | "SMALLINT" | "INTEGER" | "FLOAT" | "DOUBLE" => Self::Number,
            "DECIMAL" => Self::Decimal,
            "BOOLEAN" => Self::Bool,
            "DATE" => Self::Date,
            "TIMESTAMP" | "TIMESTAMP_NTZ" => Self::Timestamp,
            "ARRAY" | "STRUCT" | "MAP" | "VARIANT" => Self::Json,
            _ => Self::Text,
        }
    }

    fn field_type(self) -> FieldType {
        match self {
            Self::Int64 => FieldType::Int64,
            Self::Number => FieldType::Number,
            Self::Decimal => FieldType::Decimal,
            Self::Bool => FieldType::Bool,
            Self::Text => FieldType::String,
            Self::Date => FieldType::Date,
            Self::Timestamp => FieldType::Time,
            Self::Json => FieldType::Json,
        }
    }

    fn decode(self, v: &Value) -> Value {
        let Some(text) = v.as_str() else { return Value::Null };
        match self {
            Self::Int64 => warehouse::int_text(text),
            Self::Number => warehouse::number_text(text),
            Self::Decimal => warehouse::decimal_text(text).map_or(Value::Null, Value::String),
            Self::Bool => match text {
                "true" => Value::Bool(true),
                "false" => Value::Bool(false),
                _ => Value::Null,
            },
            Self::Text => Value::String(text.to_string()),
            Self::Date | Self::Timestamp => warehouse::datetime_text_ms(text).map_or(Value::Null, |ms| json!(ms)),
            Self::Json => warehouse::json_text(text),
        }
    }
}

#[cfg(test)]
mod tests;
