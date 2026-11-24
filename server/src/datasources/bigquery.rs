//! Google BigQuery over its REST API (`bigquery/v2`), signed in with a service account key or
//! with workload identity federation (an `external_account` configuration whose subject token is
//! a file in a directory a server administrator allowed).
//!
//! Read-only twice, on top of the service account's roles (only BigQuery Data Viewer and Job
//! User): every query is first sent as a dry run, which BigQuery answers with the statement type,
//! and anything but `SELECT` is refused before it runs; and the statement check
//! (`sql::check_statement`) accepts only one `SELECT`/`WITH` without federated queries or remote
//! model calls. The token asks for the `bigquery` scope: `jobs.insert` (the dry run) and
//! `jobs.cancel` do not accept `bigquery.readonly`, so the roles and the dry run are what keep a
//! source read-only, not the scope. The dry run
//! also estimates the bytes the query reads: the result carries the estimate as a notice, and a
//! query above the source's `maximumBytesBilled` is refused before it runs (BigQuery enforces
//! the same limit itself). Macros and variables are positional query parameters (`?`), never
//! text in the statement. A query Kalzit stops waiting for is cancelled, and the job carries the
//! query time limit (`jobTimeoutMs`) so BigQuery stops it too.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use reqwest::{Method, Url};
use serde::Deserialize;
use serde_json::{Value, json};
use zeroize::Zeroizing;

use super::Detail;
use super::frame::{Column, FrameBuilder};
use super::http_json::parse_url;
use super::http_source::Scrubber;
use super::sql::{self, Bind, Engine};
use super::warehouse::{self, Answer, CancelGuard, RsaKey, TokenCache};
use super::{
    Connection, DataSourcePlugin, DefaultValue, FieldError, Health, Kind, SettingField, SettingType, SourceError,
    SourceQuery, SourceSchema,
};
use crate::http::{HttpClient, HttpOptions};
use crate::shapes::{FieldType, NoticeSeverity, QueryResult, Shape};

const DEFAULT_URL: &str = "https://bigquery.googleapis.com";
const AUTH_TYPES: &[&str] = &["serviceAccountKey", "workloadIdentity"];
/// BigQuery's own scope. `bigquery.readonly` would be narrower, but `jobs.insert` (the dry run)
/// and `jobs.cancel` refuse it; the service account's roles limit what the token may do.
const SCOPE: &str = "https://www.googleapis.com/auth/bigquery";
/// How long one `jobs.query` / `getQueryResults` call waits for the job before it answers.
const WAIT_MS: u64 = 10_000;
/// Rows per page asked for (BigQuery also caps a page at 10 MB).
const PAGE_ROWS: usize = 10_000;
/// The largest token file read for workload identity federation.
const MAX_SUBJECT_TOKEN_BYTES: u64 = 64 * 1024;

const SETTINGS: &[SettingField] = &[
    SettingField::new("project", "datasources.settings.project", SettingType::String).target().required(),
    SettingField::new("location", "datasources.settings.location", SettingType::String),
    SettingField::new("dataset", "datasources.settings.dataset", SettingType::String),
    SettingField::new("authType", "datasources.settings.bigqueryAuth", SettingType::Select)
        .target()
        .options(AUTH_TYPES)
        .default(DefaultValue::Text("serviceAccountKey")),
    SettingField::new("serviceAccountKey", "datasources.settings.serviceAccountKey", SettingType::Text).secret(),
    SettingField::new("credentialConfig", "datasources.settings.credentialConfig", SettingType::Text).target(),
    SettingField::new("maximumBytesBilled", "datasources.settings.maximumBytesBilled", SettingType::Number),
    SettingField::new("url", "datasources.settings.apiUrl", SettingType::String)
        .target()
        .default(DefaultValue::Text(DEFAULT_URL)),
];

pub fn kind() -> Kind {
    Kind {
        name: "Google BigQuery",
        hint_key: "datasources.kinds.bigquery.hint",
        settings: SETTINGS,
        plugin: Arc::new(BigQuery),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Settings {
    project: String,
    location: Option<String>,
    dataset: Option<String>,
    auth_type: Option<String>,
    credential_config: Option<String>,
    maximum_bytes_billed: Option<u64>,
    url: Option<String>,
}

/// A service account key file (the fields Kalzit reads).
#[derive(Deserialize)]
struct ServiceAccountKey {
    #[serde(rename = "type")]
    key_type: Option<String>,
    client_email: String,
    private_key: Zeroizing<String>,
    private_key_id: Option<String>,
    token_uri: Option<String>,
}

/// A workload identity federation configuration (`type: external_account`).
#[derive(Deserialize)]
struct ExternalAccountConfig {
    #[serde(rename = "type")]
    config_type: String,
    audience: String,
    subject_token_type: String,
    token_url: String,
    service_account_impersonation_url: Option<String>,
    credential_source: CredentialSource,
}

#[derive(Deserialize)]
struct CredentialSource {
    file: Option<String>,
    url: Option<String>,
    environment_id: Option<String>,
    executable: Option<Value>,
    format: Option<CredentialFormat>,
}

#[derive(Deserialize)]
struct CredentialFormat {
    #[serde(rename = "type")]
    format_type: Option<String>,
    subject_token_field_name: Option<String>,
}

pub struct BigQuery;

enum Auth {
    ServiceAccount {
        email: String,
        key_id: Option<String>,
        key: RsaKey,
        token_uri: Url,
    },
    External {
        audience: String,
        token_type: String,
        token_url: Url,
        impersonation: Option<Url>,
        file: PathBuf,
        field: Option<String>,
    },
}

struct Client {
    http: HttpClient,
    base: Url,
    project: String,
    location: Option<String>,
    dataset: Option<String>,
    max_bytes: Option<u64>,
    auth: Auth,
    tokens: TokenCache,
    scrubber: Scrubber,
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

/// Project IDs are lower-case letters, digits, hyphens, and for older ones a domain with `:`.
fn valid_project(p: &str) -> bool {
    !p.is_empty()
        && p.len() <= 100
        && p.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"-.:".contains(&b))
}

fn valid_dataset(d: &str) -> bool {
    !d.is_empty() && d.len() <= 1024 && d.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

fn valid_location(l: &str) -> bool {
    !l.is_empty() && l.len() <= 64 && l.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

fn non_empty(s: Option<String>) -> Option<String> {
    s.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

fn parse_external(text: &str) -> Result<ExternalAccountConfig, Detail> {
    let config: ExternalAccountConfig = serde_json::from_str(text).map_err(|e| {
        Detail::new("bigquery.credential_config_invalid", format!("the credential configuration is not valid: {e}"))
            .with("detail", e)
    })?;
    if config.config_type != "external_account" {
        return Err(Detail::new(
            "bigquery.credential_config_invalid",
            "the credential configuration must be of type external_account",
        )
        .with("detail", "type"));
    }
    let source = &config.credential_source;
    if source.file.is_none() || source.url.is_some() || source.environment_id.is_some() || source.executable.is_some() {
        return Err(Detail::new(
            "bigquery.credential_source_unsupported",
            "only a credential source with a file is supported (no URL, AWS or executable sources)",
        ));
    }
    Ok(config)
}

async fn client(conn: &Connection) -> Result<Arc<Client>, SourceError> {
    conn.shared(|| async {
        let s: Settings = conn.settings_as()?;
        let base = parse_url(s.url.as_deref().unwrap_or(DEFAULT_URL), false).map_err(SourceError::Failed)?;
        let http = crate::http::client(HttpOptions {
            timeout: warehouse::CLIENT_TIMEOUT,
            extra_root_pem: None,
            policy: Arc::new(conn.policy().clone()),
        })
        .map_err(|e| SourceError::failed("source.error", e.to_string()))?;
        let auth = match s.auth_type.as_deref().unwrap_or("serviceAccountKey") {
            "workloadIdentity" => {
                let text = s.credential_config.as_deref().unwrap_or("");
                let config = parse_external(text).map_err(SourceError::Failed)?;
                let path = config.credential_source.file.clone().unwrap_or_default();
                let file = conn.policy().check_file_path(&path)?;
                let url = |raw: &str| parse_url(raw, false).map_err(SourceError::Failed);
                let format = config.credential_source.format.as_ref();
                let field = match format.and_then(|f| f.format_type.as_deref()) {
                    Some("json") => Some(
                        format
                            .and_then(|f| f.subject_token_field_name.clone())
                            .unwrap_or_else(|| "access_token".to_string()),
                    ),
                    _ => None,
                };
                Auth::External {
                    audience: config.audience,
                    token_type: config.subject_token_type,
                    token_url: url(&config.token_url)?,
                    impersonation: config.service_account_impersonation_url.as_deref().map(url).transpose()?,
                    file,
                    field,
                }
            }
            _ => {
                let text = conn.secret("serviceAccountKey").ok_or_else(|| {
                    SourceError::failed("bigquery.key_missing", "enter the service account key (a JSON key file)")
                })?;
                let key: ServiceAccountKey = serde_json::from_str(text).map_err(|e| {
                    SourceError::failed(
                        "bigquery.key_invalid",
                        "the service account key is not a valid JSON key file of a service account",
                    )
                    .with("detail", e.to_string().split(" at line").next().unwrap_or("").to_string())
                })?;
                if key.key_type.as_deref().is_some_and(|t| t != "service_account") {
                    return Err(SourceError::failed(
                        "bigquery.key_invalid",
                        "the key file is not a service account key",
                    )
                    .with("detail", "type"));
                }
                let token_uri = key.token_uri.as_deref().unwrap_or("https://oauth2.googleapis.com/token");
                Auth::ServiceAccount {
                    email: key.client_email,
                    key_id: key.private_key_id,
                    key: RsaKey::from_pem(&key.private_key, "bigquery.key_invalid")?,
                    token_uri: parse_url(token_uri, false).map_err(SourceError::Failed)?,
                }
            }
        };
        Ok(Client {
            http,
            base,
            project: s.project.trim().to_string(),
            location: non_empty(s.location),
            dataset: non_empty(s.dataset),
            max_bytes: s.maximum_bytes_billed.filter(|b| *b > 0),
            auth,
            tokens: TokenCache::default(),
            scrubber: Scrubber::new(conn),
        })
    })
    .await
}

/// A bound value as a positional query parameter. Times and intervals are INT64 milliseconds;
/// the statement turns them into a TIMESTAMP or INTERVAL (`sql::engine_placeholder`).
fn parameter(bind: &Bind) -> Value {
    let (ty, value): (&str, Option<String>) = match bind {
        Bind::Null => ("STRING", None),
        Bind::Bool(b) => ("BOOL", Some(b.to_string())),
        Bind::Int(i) => ("INT64", Some(i.to_string())),
        Bind::Float(f) if f.is_nan() => ("FLOAT64", Some("NaN".into())),
        Bind::Float(f) if f.is_infinite() => ("FLOAT64", Some(if *f > 0.0 { "Infinity" } else { "-Infinity" }.into())),
        Bind::Float(f) => ("FLOAT64", Some(f.to_string())),
        Bind::Text(t) => ("STRING", Some(t.clone())),
        Bind::Time(ms) | Bind::Interval(ms) => ("INT64", Some(ms.to_string())),
    };
    let value = value.map_or_else(|| json!({}), |v| json!({ "value": v }));
    json!({ "parameterType": { "type": ty }, "parameterValue": value })
}

/// A BigQuery error (`{"error": {"code", "message", "errors": [{"reason"}]}}` or a job's
/// `errorResult`) as a source error.
fn bigquery_error(reason: &str, message: &str, scrubber: &Scrubber) -> SourceError {
    let message = scrubber.scrub(message.trim());
    match reason {
        "bytesBilledLimitExceeded" => SourceError::rejected(
            "bigquery.bytes_limit",
            format!("the query would read more bytes than the source allows: {message}"),
        )
        .with("detail", message),
        _ => SourceError::Failed(
            Detail::new("bigquery.error", format!("BigQuery answered an error: {message}"))
                .with("code", reason)
                .with("detail", message),
        ),
    }
}

impl Client {
    async fn token(&self) -> Result<Zeroizing<String>, SourceError> {
        self.tokens.get(|| self.fetch_token()).await
    }

    async fn fetch_token(&self) -> Result<(Zeroizing<String>, Duration), SourceError> {
        match &self.auth {
            Auth::ServiceAccount { email, key_id, key, token_uri } => {
                let now = now_secs();
                let mut header = json!({ "alg": "RS256", "typ": "JWT" });
                if let Some(id) = key_id {
                    header["kid"] = json!(id);
                }
                let claims =
                    json!({ "iss": email, "scope": SCOPE, "aud": token_uri.as_str(), "iat": now, "exp": now + 3600 });
                let assertion = key.sign_jwt(&header, &claims)?;
                let body = warehouse::form_body(&[
                    ("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer"),
                    ("assertion", &assertion),
                ]);
                let answer = self.token_request(token_uri.clone(), Default::default(), body).await?;
                token_of(&answer, "access_token", "expires_in", &self.scrubber)
            }
            Auth::External { audience, token_type, token_url, impersonation, file, field } => {
                let subject = read_subject_token(file, field.as_deref()).await?;
                let body = warehouse::form_body(&[
                    ("grant_type", "urn:ietf:params:oauth:grant-type:token-exchange"),
                    ("audience", audience),
                    ("scope", SCOPE),
                    ("requested_token_type", "urn:ietf:params:oauth:token-type:access_token"),
                    ("subject_token_type", token_type),
                    ("subject_token", &subject),
                ]);
                let answer = self.token_request(token_url.clone(), Default::default(), body).await?;
                let federated = token_of(&answer, "access_token", "expires_in", &self.scrubber)?;
                let Some(url) = impersonation else { return Ok(federated) };
                let headers = warehouse::bearer(&federated.0, "bigquery.key_invalid")?;
                let body = warehouse::json_body(&json!({ "scope": [SCOPE], "lifetime": "3600s" }));
                let answer = self.token_request(url.clone(), headers, body).await?;
                let (token, _) = token_of(&answer, "accessToken", "", &self.scrubber)?;
                Ok((token, Duration::from_secs(3600)))
            }
        }
    }

    async fn token_request(
        &self,
        url: Url,
        headers: reqwest::header::HeaderMap,
        body: Option<(&'static str, Vec<u8>)>,
    ) -> Result<Answer, SourceError> {
        let answer =
            warehouse::send(&self.http, Method::POST, url, headers, body, warehouse::MAX_SMALL_BYTES, &self.scrubber)
                .await?;
        if answer.status.is_success() {
            return Ok(answer);
        }
        let text = answer.text(&self.scrubber);
        Err(super::connect::auth_failed(format!("{}: {text}", answer.status)))
    }

    /// One API call with the access token; a refused token is fetched again once.
    async fn call(&self, method: Method, path: &str, body: Option<&Value>, max: usize) -> Result<Value, SourceError> {
        for attempt in 0..2 {
            let token = self.token().await?;
            let headers = warehouse::bearer(&token, "bigquery.key_invalid")?;
            let url = warehouse::join(&self.base, path);
            let answer = warehouse::send(
                &self.http,
                method.clone(),
                url,
                headers,
                body.and_then(warehouse::json_body),
                max,
                &self.scrubber,
            )
            .await?;
            if answer.status.as_u16() == 401 && attempt == 0 {
                self.tokens.clear().await;
                continue;
            }
            if let Some(e) = warehouse::refused_login(&answer, &self.scrubber) {
                return Err(e);
            }
            let Some(json) = answer.json() else {
                return Err(warehouse::not_an_api_answer("bigquery.not_an_api_response", "BigQuery", &answer));
            };
            if answer.status.is_success() {
                return Ok(json);
            }
            let error = &json["error"];
            let Some(message) = error["message"].as_str() else {
                return Err(warehouse::not_an_api_answer("bigquery.not_an_api_response", "BigQuery", &answer));
            };
            let reason = error["errors"][0]["reason"].as_str().unwrap_or(error["status"].as_str().unwrap_or(""));
            return Err(bigquery_error(reason, message, &self.scrubber));
        }
        Err(super::connect::auth_failed("401 Unauthorized"))
    }

    fn dataset_reference(&self) -> Option<Value> {
        self.dataset.as_ref().map(|d| json!({ "projectId": self.project, "datasetId": d }))
    }

    /// The dry run: the statement type, which must be `SELECT`, and the bytes it would read.
    async fn dry_run(&self, sql_text: &str, params: &[Value]) -> Result<u64, SourceError> {
        let mut query = json!({
            "query": sql_text,
            "useLegacySql": false,
            "parameterMode": "POSITIONAL",
            "queryParameters": params,
        });
        if let Some(d) = self.dataset_reference() {
            query["defaultDataset"] = d;
        }
        let mut job_reference = json!({ "projectId": self.project });
        if let Some(l) = &self.location {
            job_reference["location"] = json!(l);
        }
        let body = json!({ "configuration": { "dryRun": true, "query": query }, "jobReference": job_reference });
        let job = self
            .call(
                Method::POST,
                &format!("/bigquery/v2/projects/{}/jobs", self.project),
                Some(&body),
                warehouse::MAX_SMALL_BYTES,
            )
            .await?;
        let statistics = &job["statistics"];
        let statement = statistics["query"]["statementType"].as_str().unwrap_or("");
        if statement != "SELECT" {
            let shown = if statement.is_empty() { "unknown" } else { statement };
            return Err(SourceError::rejected(
                "bigquery.not_select",
                format!("BigQuery reads this statement as {shown}; only SELECT queries are run"),
            )
            .with("type", shown));
        }
        let bytes = statistics["query"]["totalBytesProcessed"]
            .as_str()
            .or(statistics["totalBytesProcessed"].as_str())
            .and_then(|b| b.parse().ok())
            .unwrap_or(0);
        Ok(bytes)
    }

    /// Starts the query and waits for it: the first answer with rows, and the job's id and
    /// location for the further pages. The guard is armed once the job exists.
    async fn run(
        &self,
        sql_text: &str,
        params: &[Value],
        page_rows: usize,
        timeout: Duration,
        guard: &mut CancelGuard,
        client: &Arc<Client>,
    ) -> Result<(Value, String, Option<String>), SourceError> {
        let mut body = json!({
            "query": sql_text,
            "useLegacySql": false,
            "parameterMode": "POSITIONAL",
            "queryParameters": params,
            "maxResults": page_rows,
            "timeoutMs": WAIT_MS,
            "jobTimeoutMs": timeout.as_millis().max(1000).to_string(),
            "formatOptions": { "useInt64Timestamp": true },
            "requestId": uuid::Uuid::now_v7().to_string(),
            "labels": { "client": "kalzit" },
        });
        if let Some(d) = self.dataset_reference() {
            body["defaultDataset"] = d;
        }
        if let Some(l) = &self.location {
            body["location"] = json!(l);
        }
        if let Some(b) = self.max_bytes {
            body["maximumBytesBilled"] = json!(b.to_string());
        }
        let mut answer = self
            .call(
                Method::POST,
                &format!("/bigquery/v2/projects/{}/queries", self.project),
                Some(&body),
                warehouse::MAX_PAGE_BYTES,
            )
            .await?;
        let job = answer["jobReference"]["jobId"].as_str().unwrap_or("").to_string();
        let location = answer["jobReference"]["location"].as_str().map(str::to_string).or(self.location.clone());
        if !job.is_empty() {
            let (c, job, location) = (client.clone(), job.clone(), location.clone());
            guard.arm(async move { c.cancel(&job, location.as_deref()).await });
        }
        while answer["jobComplete"] != json!(true) {
            if job.is_empty() {
                return Err(SourceError::failed("bigquery.not_an_api_response", "BigQuery answered without a job"));
            }
            answer = self.results(&job, location.as_deref(), page_rows, None).await?;
        }
        if let Some(e) = answer["errors"].as_array().and_then(|e| e.first()) {
            return Err(bigquery_error(
                e["reason"].as_str().unwrap_or(""),
                e["message"].as_str().unwrap_or(""),
                &self.scrubber,
            ));
        }
        Ok((answer, job, location))
    }

    /// `jobs.getQueryResults`: waits up to `WAIT_MS` for the job, then answers a page.
    async fn results(
        &self,
        job: &str,
        location: Option<&str>,
        page_rows: usize,
        page_token: Option<&str>,
    ) -> Result<Value, SourceError> {
        let mut url = Url::parse("http://x/").expect("a valid URL");
        {
            let mut q = url.query_pairs_mut();
            q.append_pair("maxResults", &page_rows.to_string());
            q.append_pair("timeoutMs", &WAIT_MS.to_string());
            q.append_pair("formatOptions.useInt64Timestamp", "true");
            if let Some(l) = location {
                q.append_pair("location", l);
            }
            if let Some(t) = page_token {
                q.append_pair("pageToken", t);
            }
        }
        let path = format!(
            "/bigquery/v2/projects/{}/queries/{}?{}",
            self.project,
            encode_segment(job),
            url.query().unwrap_or("")
        );
        self.call(Method::GET, &path, None, warehouse::MAX_PAGE_BYTES).await
    }

    async fn cancel(&self, job: &str, location: Option<&str>) {
        let query = location.map(|l| format!("?location={}", encode_segment(l))).unwrap_or_default();
        let path = format!("/bigquery/v2/projects/{}/jobs/{}/cancel{query}", self.project, encode_segment(job));
        if let Err(e) = self.call(Method::POST, &path, None, warehouse::MAX_SMALL_BYTES).await {
            tracing::debug!("cancelling the BigQuery job failed: {}", e.detail().message);
        }
    }

    /// A small statement read whole, as text rows (health and schema).
    async fn text_rows(self: &Arc<Self>, sql_text: &str, max_rows: usize) -> Result<Vec<Vec<String>>, SourceError> {
        let mut guard = CancelGuard::default();
        let (mut answer, job, location) =
            self.run(sql_text, &[], max_rows.min(PAGE_ROWS), super::MAX_HEALTH_TIMEOUT, &mut guard, self).await?;
        let mut rows = Vec::new();
        loop {
            for row in answer["rows"].as_array().into_iter().flatten() {
                rows.push(
                    row["f"].as_array().into_iter().flatten().map(|c| warehouse::text_of(Some(&c["v"]))).collect(),
                );
            }
            match answer["pageToken"].as_str() {
                Some(t) if rows.len() < max_rows => {
                    let t = t.to_string();
                    answer = self.results(&job, location.as_deref(), PAGE_ROWS, Some(&t)).await?;
                }
                _ => break,
            }
        }
        guard.disarm();
        rows.truncate(max_rows);
        Ok(rows)
    }

    fn columns_view(&self) -> String {
        match (&self.dataset, &self.location) {
            (Some(d), _) => format!("`{}`.`{d}`.INFORMATION_SCHEMA.COLUMNS", self.project),
            (None, l) => {
                format!(
                    "`{}`.`region-{}`.INFORMATION_SCHEMA.COLUMNS",
                    self.project,
                    l.as_deref().unwrap_or("us").to_lowercase()
                )
            }
        }
    }
}

fn encode_segment(s: &str) -> String {
    url::form_urlencoded::byte_serialize(s.as_bytes()).collect()
}

fn token_of(
    answer: &Answer,
    field: &str,
    expires: &str,
    scrubber: &Scrubber,
) -> Result<(Zeroizing<String>, Duration), SourceError> {
    let json = answer.json().unwrap_or(Value::Null);
    let Some(token) = json[field].as_str().filter(|t| !t.is_empty()) else {
        return Err(super::connect::auth_failed(format!("the token answer has no {field}: {}", answer.text(scrubber))));
    };
    let secs = json[expires].as_u64().unwrap_or(3600);
    Ok((Zeroizing::new(token.to_string()), Duration::from_secs(secs)))
}

/// The subject token of workload identity federation: the file's text, or one field of it as
/// JSON.
async fn read_subject_token(file: &PathBuf, field: Option<&str>) -> Result<Zeroizing<String>, SourceError> {
    let unreadable = |e: String| {
        SourceError::failed("bigquery.subject_token_unreadable", format!("the token file cannot be read: {e}"))
            .with("detail", e)
    };
    let meta = tokio::fs::metadata(file).await.map_err(|e| unreadable(e.to_string()))?;
    if meta.len() > MAX_SUBJECT_TOKEN_BYTES {
        return Err(unreadable("the file is too large".into()));
    }
    let text = Zeroizing::new(tokio::fs::read_to_string(file).await.map_err(|e| unreadable(e.to_string()))?);
    match field {
        None => Ok(Zeroizing::new(text.trim().to_string())),
        Some(field) => {
            let json: Value = serde_json::from_str(&text).map_err(|_| unreadable("the file is not JSON".into()))?;
            json[field]
                .as_str()
                .map(|t| Zeroizing::new(t.to_string()))
                .ok_or_else(|| unreadable(format!("the file has no field {field}")))
        }
    }
}

#[async_trait::async_trait]
impl DataSourcePlugin for BigQuery {
    fn kind(&self) -> &'static str {
        "bigquery"
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
        if !valid_project(s.project.trim()) {
            return Err(FieldError::new(
                "project",
                "settings.project_invalid",
                "the project ID takes lower-case letters, digits, hyphens, dots and colons",
            ));
        }
        if let Some(l) = s.location.as_deref().map(str::trim).filter(|l| !l.is_empty())
            && !valid_location(l)
        {
            return Err(FieldError::new(
                "location",
                "settings.location_invalid",
                "the location takes letters, digits and hyphens, such as EU or europe-west3",
            ));
        }
        if let Some(d) = s.dataset.as_deref().map(str::trim).filter(|d| !d.is_empty())
            && !valid_dataset(d)
        {
            return Err(FieldError::new(
                "dataset",
                "settings.dataset_invalid",
                "the dataset takes letters, digits and underscores",
            ));
        }
        if let Some(url) = &s.url {
            parse_url(url, false).map_err(|d| FieldError { field: "url", detail: d.with("field", "url") })?;
        }
        if s.auth_type.as_deref() == Some("workloadIdentity") {
            let text = s.credential_config.as_deref().unwrap_or("");
            if text.trim().is_empty() {
                return Err(FieldError::new(
                    "credentialConfig",
                    "settings.required",
                    "credentialConfig is required for workload identity",
                ));
            }
            let config = parse_external(text)
                .map_err(|d| FieldError { field: "credentialConfig", detail: d.with("field", "credentialConfig") })?;
            for url in [Some(config.token_url.as_str()), config.service_account_impersonation_url.as_deref()]
                .into_iter()
                .flatten()
            {
                parse_url(url, false).map_err(|d| FieldError {
                    field: "credentialConfig",
                    detail: d.with("field", "credentialConfig"),
                })?;
            }
        }
        Ok(())
    }

    async fn health(&self, conn: &Connection) -> Health {
        let check = async {
            let c = client(conn).await?;
            c.text_rows("SELECT 1", 1).await?;
            Ok::<_, SourceError>(c.location.clone().unwrap_or_default())
        };
        match check.await {
            Ok(location) => Health::connected("BigQuery", &location, false),
            Err(e) => Health::failed(&e),
        }
    }

    async fn schema(&self, conn: &Connection) -> Result<SourceSchema, SourceError> {
        let c = client(conn).await?;
        let sql_text = format!(
            "SELECT table_schema, table_name, column_name, data_type FROM {} \
             ORDER BY table_schema, table_name, ordinal_position LIMIT {}",
            c.columns_view(),
            warehouse::MAX_SCHEMA_COLUMNS
        );
        let rows = c.text_rows(&sql_text, warehouse::MAX_SCHEMA_COLUMNS).await?;
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
        let prepared = sql::prepare_query(self, conn, &req, Engine::BigQuery).await?;
        let c = client(conn).await?;
        let params: Vec<Value> = prepared.binds.iter().map(parameter).collect();
        let estimate = c.dry_run(&prepared.sql, &params).await?;
        if let Some(limit) = c.max_bytes
            && estimate > limit
        {
            return Err(SourceError::rejected(
                "bigquery.bytes_limit",
                format!("the query would read {estimate} bytes, more than the {limit} bytes this source allows"),
            )
            .with("bytes", estimate)
            .with("limit", limit));
        }
        let page_rows = req.limits.max_rows.saturating_add(1).min(PAGE_ROWS);
        let mut guard = CancelGuard::default();
        let (mut answer, job, location) =
            c.run(&prepared.sql, &params, page_rows, req.limits.timeout, &mut guard, &c).await?;
        let schema: Vec<Value> = answer["schema"]["fields"].as_array().cloned().unwrap_or_default();
        let columns =
            schema.iter().map(|f| Column::new(f["name"].as_str().unwrap_or(""), Some(field_type(f)))).collect();
        let mut frame = FrameBuilder::new(columns, req.limits.max_rows, req.limits.budget.clone());
        'pages: loop {
            for row in answer["rows"].as_array().into_iter().flatten() {
                let cells = row["f"].as_array().cloned().unwrap_or_default();
                let values = schema.iter().zip(cells.iter()).map(|(f, cell)| decode(f, &cell["v"])).collect();
                if !frame.push_row(values) {
                    break 'pages;
                }
            }
            match answer["pageToken"].as_str() {
                Some(t) => {
                    let t = t.to_string();
                    answer = c.results(&job, location.as_deref(), page_rows, Some(&t)).await?;
                }
                None => break,
            }
        }
        guard.disarm();
        frame.executed_query(prepared.sql);
        frame.notice(
            NoticeSeverity::Info,
            Detail::new("bigquery.bytes_estimate", format!("the query reads about {estimate} bytes"))
                .with("bytes", estimate),
        );
        Ok(QueryResult::Frame { frame: frame.finish() })
    }
}

/// The frame type of a BigQuery schema field.
fn field_type(field: &Value) -> FieldType {
    if field["mode"] == "REPEATED" {
        return FieldType::Json;
    }
    match field["type"].as_str().unwrap_or("") {
        "INTEGER" | "INT64" => FieldType::Int64,
        "FLOAT" | "FLOAT64" => FieldType::Number,
        "NUMERIC" | "BIGNUMERIC" | "DECIMAL" | "BIGDECIMAL" => FieldType::Decimal,
        "BOOLEAN" | "BOOL" => FieldType::Bool,
        "TIMESTAMP" | "DATETIME" => FieldType::Time,
        "DATE" => FieldType::Date,
        "RECORD" | "STRUCT" | "JSON" => FieldType::Json,
        _ => FieldType::String,
    }
}

/// One cell (`v`) as its frame value.
fn decode(field: &Value, v: &Value) -> Value {
    if v.is_null() {
        return Value::Null;
    }
    if field["mode"] == "REPEATED" {
        let inner = json!({ "name": field["name"], "type": field["type"], "fields": field["fields"] });
        return Value::Array(v.as_array().into_iter().flatten().map(|item| json_value(&inner, &item["v"])).collect());
    }
    let text = v.as_str().unwrap_or("");
    match field["type"].as_str().unwrap_or("") {
        "INTEGER" | "INT64" => warehouse::int_text(text),
        "FLOAT" | "FLOAT64" => warehouse::number_text(text),
        "NUMERIC" | "BIGNUMERIC" | "DECIMAL" | "BIGDECIMAL" => {
            warehouse::decimal_text(text).map_or(Value::Null, Value::String)
        }
        "BOOLEAN" | "BOOL" => match text {
            "true" => Value::Bool(true),
            "false" => Value::Bool(false),
            _ => Value::Null,
        },
        // Microseconds since the epoch (`useInt64Timestamp`), or seconds in older answers.
        "TIMESTAMP" => match text.parse::<i64>() {
            Ok(us) => json!(us.div_euclid(1000)),
            Err(_) => warehouse::seconds_text_ms(text).map_or(Value::Null, |ms| json!(ms)),
        },
        "DATETIME" | "DATE" => warehouse::datetime_text_ms(text).map_or(Value::Null, |ms| json!(ms)),
        "RECORD" | "STRUCT" | "JSON" => json_value(field, v),
        _ => Value::String(text.to_string()),
    }
}

/// A cell as plain JSON: records as objects by their field names, JSON text parsed, numbers and
/// booleans as BigQuery wrote them in text.
fn json_value(field: &Value, v: &Value) -> Value {
    if v.is_null() {
        return Value::Null;
    }
    match field["type"].as_str().unwrap_or("") {
        "RECORD" | "STRUCT" => {
            let names = field["fields"].as_array().cloned().unwrap_or_default();
            let cells = v["f"].as_array().cloned().unwrap_or_default();
            let mut object = serde_json::Map::new();
            for (f, cell) in names.iter().zip(cells.iter()) {
                let value = if f["mode"] == "REPEATED" {
                    Value::Array(cell["v"].as_array().into_iter().flatten().map(|i| json_value(f, &i["v"])).collect())
                } else {
                    json_value(f, &cell["v"])
                };
                object.insert(f["name"].as_str().unwrap_or("").to_string(), value);
            }
            Value::Object(object)
        }
        "JSON" => warehouse::json_text(v.as_str().unwrap_or("")),
        "FLOAT" | "FLOAT64" => warehouse::number_text(v.as_str().unwrap_or("")),
        "BOOLEAN" | "BOOL" => json!(v.as_str() == Some("true")),
        _ => v.clone(),
    }
}

#[cfg(test)]
mod tests;
