//! A GET request to an HTTP(S) URL that answers JSON, as `documents`. The request goes through
//! the one client factory (`crate::http`), so the target checks apply to the address it connects
//! to and to every redirect; credentials come from stored secrets and never follow a redirect to
//! another origin.
//!
//! A query may add a path below the source's URL and query parameters; it can never leave the
//! source's URL (no `..`, no other host), so the admin's choice of target holds.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use base64::Engine as _;
use reqwest::header::{ACCEPT, AUTHORIZATION, HeaderMap, HeaderName, HeaderValue};
use reqwest::{Method, Url};
use serde::Deserialize;
use serde_json::Value;

use super::Detail;
use super::frame::ResponseBudget;
use super::json_documents::DocumentsBuilder;
use super::{
    Connection, DataSourcePlugin, FieldError, Health, Kind, SettingField, SettingType, SourceError, SourceQuery,
    SourceSchema,
};
use crate::http::{HttpClient, HttpError, HttpOptions};
use crate::shapes::{QueryResult, Shape};

const SETTINGS: &[SettingField] = &[
    SettingField::new("url", "datasources.settings.url", SettingType::String).target().required(),
    SettingField::new("basicAuthUser", "datasources.settings.basicAuthUser", SettingType::String).target(),
    SettingField::new("basicAuthPassword", "datasources.settings.basicAuthPassword", SettingType::String).secret(),
    SettingField::new("bearerToken", "datasources.settings.bearerToken", SettingType::String).secret(),
    SettingField::new("apiKeyHeader", "datasources.settings.apiKeyHeader", SettingType::String).target(),
    SettingField::new("apiKey", "datasources.settings.apiKey", SettingType::String).secret(),
    SettingField::new("caCert", "datasources.settings.caCert", SettingType::Text).target(),
    SettingField::new("documentsPath", "datasources.settings.documentsPath", SettingType::String),
];
/// The client's own limit; the query timeout around each call is usually shorter.
const CLIENT_TIMEOUT: Duration = Duration::from_secs(3600);
/// Health and schema answers are read up to this size.
const MAX_SMALL_RESPONSE: usize = 16 * 1024 * 1024;
/// Error bodies are quoted up to this many characters.
const MAX_ERROR_BODY: usize = 300;
/// Headers an API key may not be sent as: they would change the request itself.
const RESERVED_HEADERS: &[&str] =
    &["host", "content-length", "content-type", "transfer-encoding", "connection", "accept", "authorization"];

pub fn kind() -> Kind {
    Kind {
        name: "HTTP JSON",
        hint_key: "datasources.kinds.http_json.hint",
        settings: SETTINGS,
        plugin: Arc::new(HttpJson),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Settings {
    url: String,
    basic_auth_user: Option<String>,
    api_key_header: Option<String>,
    ca_cert: Option<String>,
    documents_path: Option<String>,
}

/// `{"path": "orders/open", "params": {"status": "$status"}, "documentsPath": "data.items"}`, all
/// optional.
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HttpQuery {
    path: Option<String>,
    #[serde(default)]
    params: BTreeMap<String, Value>,
    documents_path: Option<String>,
}

pub struct HttpJson;

/// An `http(s)://` URL without credentials and fragment; `allow_query` decides about `?...`.
pub(crate) fn parse_url(raw: &str, allow_query: bool) -> Result<Url, Detail> {
    let url = Url::parse(raw.trim())
        .map_err(|e| Detail::new("settings.url_invalid", format!("the URL is not valid: {e}")).with("detail", e))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(Detail::new("settings.url_scheme", "the URL must start with http:// or https://"));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(Detail::new(
            "settings.url_credentials",
            "the URL must not contain credentials; use the authentication fields",
        ));
    }
    if (!allow_query && url.query().is_some()) || url.fragment().is_some() {
        return Err(Detail::new(
            "settings.url_query",
            "the URL must not contain a query or fragment; tokens go in the secret fields",
        ));
    }
    if url.host_str().is_none() {
        return Err(Detail::new("settings.url_no_host", "the URL needs a host"));
    }
    Ok(url)
}

/// A request header value from credentials, marked sensitive so it never follows a redirect to
/// another origin. `reason` names the kind's own error.
pub(crate) fn header_value(text: &str, reason: &'static str) -> Result<HeaderValue, SourceError> {
    let mut value = HeaderValue::from_str(text)
        .map_err(|_| SourceError::failed(reason, "the credentials contain characters a header cannot carry"))?;
    value.set_sensitive(true);
    Ok(value)
}

/// `Basic <base64(user:password)>`, and the base64 part to scrub from errors.
pub(crate) fn basic_auth(user: &str, password: &str) -> (String, String) {
    let token = base64::engine::general_purpose::STANDARD.encode(format!("{user}:{password}"));
    (format!("Basic {token}"), token)
}

fn check_header_name(name: &str) -> Result<(), FieldError> {
    let valid = HeaderName::from_bytes(name.as_bytes()).is_ok();
    if !valid || RESERVED_HEADERS.contains(&name.to_ascii_lowercase().as_str()) {
        return Err(FieldError::new(
            "apiKeyHeader",
            "settings.header_name_invalid",
            "the API key header must be a valid header name other than Authorization, Host and the like",
        ));
    }
    Ok(())
}

struct Client {
    http: HttpClient,
    base: Url,
    headers: HeaderMap,
    documents_path: Option<String>,
    /// The stored secrets and the base64 of `user:password`, to scrub from errors.
    secrets: Vec<String>,
}

async fn client(conn: &Connection) -> Result<Arc<Client>, SourceError> {
    conn.shared(|| async {
        let s: Settings = conn.settings_as()?;
        let base = parse_url(&s.url, true).map_err(SourceError::Failed)?;
        let http = crate::http::client(HttpOptions {
            timeout: CLIENT_TIMEOUT,
            extra_root_pem: s.ca_cert,
            policy: Arc::new(conn.policy().clone()),
        })
        .map_err(|e| SourceError::Failed(e.detail()))?;
        let mut headers = HeaderMap::new();
        headers.insert(ACCEPT, HeaderValue::from_static("application/json"));
        let mut basic_token = None;
        let invalid = "http_json.credentials_invalid";
        if let Some(user) = s.basic_auth_user.filter(|u| !u.is_empty()) {
            let (value, token) = basic_auth(&user, conn.secret("basicAuthPassword").unwrap_or(""));
            headers.insert(AUTHORIZATION, header_value(&value, invalid)?);
            basic_token = Some(token);
        } else if let Some(token) = conn.secret("bearerToken") {
            headers.insert(AUTHORIZATION, header_value(&format!("Bearer {token}"), invalid)?);
        }
        if let (Some(name), Some(key)) = (s.api_key_header.filter(|h| !h.is_empty()), conn.secret("apiKey")) {
            let name = HeaderName::from_bytes(name.as_bytes())
                .map_err(|_| SourceError::failed("settings.stored_invalid", "the stored settings are not valid"))?;
            headers.insert(name, header_value(key, invalid)?);
        }
        let mut secrets: Vec<String> = basic_token.into_iter().collect();
        secrets.extend(
            ["basicAuthPassword", "bearerToken", "apiKey"].iter().filter_map(|f| conn.secret(f)).map(String::from),
        );
        Ok(Client { http, base, headers, documents_path: s.documents_path.filter(|p| !p.is_empty()), secrets })
    })
    .await
}

/// A path below the base URL: relative segments only, no `.` or `..` (also percent-encoded),
/// no query or fragment.
/// The segment rules for a path below the source's URL, for paths a query adds and for redirect
/// targets alike: no `.` segment, no segment starting with `..` (servers such as Tomcat read
/// `..;` as `..`), no backslash or control character, and no encoded dot, slash, backslash or
/// percent sign, which a server may decode into one of those.
fn relative_path_ok(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    !(path.contains('\\')
        || ["%2e", "%2f", "%5c", "%25"].iter().any(|e| lower.contains(e))
        || path.split('/').any(|s| s == "." || s.starts_with(".."))
        || path.chars().any(char::is_control))
}

fn join_path(base: &Url, path: &str) -> Result<Url, SourceError> {
    let refused = || {
        SourceError::rejected(
            "http_json.path_invalid",
            "the path must be relative to the source's URL, without .., query or fragment",
        )
    };
    if path.starts_with(['/', '\\'])
        || path.contains(['?', '#'])
        || path.split('/').next().is_some_and(|first| first.contains(':'))
        || !relative_path_ok(path)
    {
        return Err(refused());
    }
    let mut dir = base.clone();
    if !dir.path().ends_with('/') {
        dir.set_path(&format!("{}/", dir.path()));
    }
    let mut url = dir.join(path).map_err(|_| refused())?;
    if url.origin() != base.origin() || !url.path().starts_with(dir.path()) {
        return Err(refused());
    }
    // `join` drops the base's query; keep it.
    url.set_query(base.query());
    Ok(url)
}

/// `$name` or `${name}` as the whole text.
pub(crate) fn variable_name(text: &str) -> Option<&str> {
    let rest = text.strip_prefix('$')?;
    let name = rest.strip_prefix('{').and_then(|r| r.strip_suffix('}')).unwrap_or(rest);
    (!name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')).then_some(name)
}

/// The query parameters: texts, numbers and booleans; a value that is exactly `$name` takes the
/// variable's value (a list repeats the parameter).
fn params(q: &HttpQuery, variables: &BTreeMap<String, Value>) -> Result<Vec<(String, String)>, SourceError> {
    let mut out = Vec::new();
    for (key, value) in &q.params {
        let resolved = match value.as_str().and_then(variable_name) {
            Some(name) => variables.get(name).cloned().ok_or_else(|| {
                SourceError::rejected("http_json.variable_missing", format!("variable {name} has no value"))
                    .with("name", name)
            })?,
            None => value.clone(),
        };
        let items = match resolved {
            Value::Array(items) => items,
            other => vec![other],
        };
        for item in items {
            let text = match item {
                Value::String(s) => s,
                Value::Number(n) => n.to_string(),
                Value::Bool(b) => b.to_string(),
                _ => {
                    return Err(SourceError::rejected(
                        "http_json.param_invalid",
                        format!("the parameter {key} must be a text, number or boolean"),
                    )
                    .with("name", key));
                }
            };
            out.push((key.clone(), text));
        }
    }
    Ok(out)
}

/// The value at a dotted path (`data.items`, `results.0.rows`); numbers index arrays.
fn at_path<'a>(value: &'a Value, path: &str) -> Option<&'a Value> {
    path.split('.').filter(|s| !s.is_empty()).try_fold(value, |v, key| match v {
        Value::Object(map) => map.get(key),
        Value::Array(items) => key.parse::<usize>().ok().and_then(|i| items.get(i)),
        _ => None,
    })
}

impl Client {
    fn scrub(&self, text: &str) -> String {
        super::scrub(text, self.secrets.iter().map(String::as_str))
    }

    /// A request (the first or a redirect) must be a GET on the source's origin, at its URL or
    /// below it.
    fn check_hop(&self, method: &Method, url: &Url) -> Result<(), Detail> {
        let path = self.base.path();
        let dir = if path.ends_with('/') { path.to_string() } else { format!("{path}/") };
        let below = url.path() == path || url.path().strip_prefix(dir.as_str()).is_some_and(relative_path_ok);
        if *method == Method::GET && url.origin() == self.base.origin() && below {
            return Ok(());
        }
        Err(Detail::new(
            "http_json.redirect_refused",
            format!("the server redirected to {}, which is not below the data source's URL", url.path()),
        )
        .with("path", url.path()))
    }

    fn failed(&self, e: HttpError) -> SourceError {
        match e {
            HttpError::Blocked(b) => SourceError::Blocked(b.0),
            other => SourceError::Failed(other.detail().scrubbed(|t| self.scrub(t))),
        }
    }

    /// GETs `url` and answers the parsed JSON. With `charge`, the body is charged to the
    /// request's budget as it arrives.
    async fn get(
        &self,
        url: Url,
        max_bytes: usize,
        charge: Option<&mut super::frame::Charge>,
    ) -> Result<(u16, Value), SourceError> {
        // Redirects may only stay below the source's URL, like the paths a query may add.
        let hop = |m: &Method, u: &Url| self.check_hop(m, u);
        let response = self
            .http
            .send_checked(Method::GET, url, self.headers.clone(), None, Some(&hop))
            .await
            .map_err(|e| self.failed(e))?;
        let status = response.status();
        let body = match charge {
            Some(charge) => crate::http::read_counted(response, max_bytes, |n| charge.add(n)).await,
            None => crate::http::read_limited(response, max_bytes).await,
        }
        .map_err(|e| self.failed(e))?;
        if !status.is_success() {
            // Scrubbed whole before it is cut, so a secret across the cut is still found.
            let text = self.scrub(&String::from_utf8_lossy(&body));
            let text: String = text.trim().chars().take(MAX_ERROR_BODY).collect();
            return Err(SourceError::failed("http_json.status", format!("the server answered {status}: {text}"))
                .with("status", status.as_u16())
                .with("detail", text));
        }
        let body = body.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(&body);
        let value = serde_json::from_slice(body).map_err(|e| {
            SourceError::failed("http_json.not_json", format!("the server answered {status} without JSON: {e}"))
                .with("status", status.as_u16())
                .with("detail", e)
        })?;
        Ok((status.as_u16(), value))
    }
}

/// The documents of an answer: the elements of the array at `path` (or of the answer itself),
/// or the value there as one document.
fn documents(
    answer: Value,
    path: Option<&str>,
    max: usize,
    budget: &ResponseBudget,
) -> Result<DocumentsBuilder, SourceError> {
    let value = match path {
        Some(p) => at_path(&answer, p).cloned().ok_or_else(|| {
            SourceError::failed("http_json.path_missing", format!("the answer has nothing at {p}")).with("path", p)
        })?,
        None => answer,
    };
    let mut docs = DocumentsBuilder::new(max, budget.clone());
    match value {
        Value::Array(items) => {
            for item in items {
                if !docs.push(item) {
                    break;
                }
            }
        }
        other => {
            docs.push(other);
        }
    }
    Ok(docs)
}

#[async_trait::async_trait]
impl DataSourcePlugin for HttpJson {
    fn kind(&self) -> &'static str {
        "http_json"
    }

    fn shapes(&self) -> &'static [Shape] {
        &[Shape::Documents]
    }

    fn check_settings(&self, settings: &Value) -> Result<(), FieldError> {
        let s = Settings::deserialize(settings)
            .map_err(|e| FieldError::new("settings", "settings.invalid", e.to_string()).with("detail", e))?;
        parse_url(&s.url, true).map_err(|d| FieldError { field: "url", detail: d.with("field", "url") })?;
        if let Some(h) = s.api_key_header.as_deref().filter(|h| !h.is_empty()) {
            check_header_name(h)?;
        }
        super::check_pem("caCert", s.ca_cert.as_deref())?;
        Ok(())
    }

    async fn health(&self, conn: &Connection) -> Health {
        let check = async {
            let c = client(conn).await?;
            let (status, _) = c.get(c.base.clone(), MAX_SMALL_RESPONSE, None).await?;
            Ok::<_, SourceError>(status)
        };
        match check.await {
            Ok(status) => Health {
                ok: true,
                code: None,
                warnings: Vec::new(),
                detail: Detail::new("health.http_json_answered", format!("the server answered {status} with JSON"))
                    .with("status", status),
            },
            Err(e) => Health::failed(&e),
        }
    }

    async fn schema(&self, conn: &Connection) -> Result<SourceSchema, SourceError> {
        let c = client(conn).await?;
        let (_, answer) = c.get(c.base.clone(), MAX_SMALL_RESPONSE, None).await?;
        let budget = ResponseBudget::new(MAX_SMALL_RESPONSE);
        let docs = documents(answer, c.documents_path.as_deref(), 1_000, &budget)?;
        Ok(SourceSchema::Fields { fields: docs.finish().schema })
    }

    async fn query(&self, conn: &Connection, req: SourceQuery) -> Result<QueryResult, SourceError> {
        let q: HttpQuery =
            if req.query.as_object().is_some_and(|o| o.is_empty()) { HttpQuery::default() } else { req.parse()? };
        let c = client(conn).await?;
        let mut url = match q.path.as_deref().filter(|p| !p.is_empty()) {
            Some(p) => join_path(&c.base, p)?,
            None => c.base.clone(),
        };
        let pairs = params(&q, &req.variables)?;
        if !pairs.is_empty() {
            url.query_pairs_mut().extend_pairs(pairs.iter().map(|(k, v)| (k.as_str(), v.as_str())));
        }
        let budget = &req.limits.budget;
        let mut charge = budget.charge();
        let (_, answer) = c.get(url, budget.remaining(), Some(&mut charge)).await?;
        let path = q.documents_path.as_deref().or(c.documents_path.as_deref());
        // The raw body's charge is given back before the documents are charged.
        drop(charge);
        let docs = documents(answer, path, req.limits.max_rows, budget)?;
        Ok(QueryResult::Documents { documents: docs.finish() })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::datasources::Limits;
    use crate::datasources::json_documents::test_connection;
    use crate::datasources::targets::TargetPolicy;
    use crate::shapes::TimeRange;
    use axum::Router;
    use axum::http::{StatusCode, header};
    use axum::response::IntoResponse;
    use serde_json::json;

    fn policy(allowed: &[&str]) -> TargetPolicy {
        let allowed: Vec<String> = allowed.iter().map(|s| s.to_string()).collect();
        TargetPolicy::new(&std::env::temp_dir().join("kalzit-none"), "sqlite::memory:", &[], &allowed)
    }

    fn req(query: Value, variables: Value, max_rows: usize) -> SourceQuery {
        SourceQuery {
            ref_id: "A".into(),
            query,
            range: TimeRange { from: 0, to: 1 },
            interval_ms: 1000,
            max_data_points: None,
            variables: serde_json::from_value(variables).unwrap(),
            identifier_variables: None,
            cursor: None,
            limits: Limits { timeout: Duration::from_secs(5), max_rows, budget: ResponseBudget::new(1 << 20) },
        }
    }

    #[expect(clippy::disallowed_methods, reason = "a fake upstream server, not an API route")]
    async fn upstream() -> std::net::SocketAddr {
        let app = Router::new()
            .route(
                "/api/orders",
                axum::routing::get(|headers: axum::http::HeaderMap, uri: axum::http::Uri| async move {
                    let auth = headers.get(header::AUTHORIZATION).map(|v| v.to_str().unwrap().to_string());
                    let key = headers.get("x-api-key").map(|v| v.to_str().unwrap().to_string());
                    axum::Json(json!({ "data": { "items": [
                        { "id": 1, "auth": auth, "key": key, "query": uri.query() },
                        { "id": 2 }, { "id": 3 }
                    ] } }))
                }),
            )
            .route("/api/orders/open", axum::routing::get(|| async { axum::Json(json!([{ "offen": true }])) }))
            .route("/api/text", axum::routing::get(|| async { "kein JSON" }))
            .route(
                "/api/fails",
                axum::routing::get(|| async { (StatusCode::FORBIDDEN, "nicht erlaubt").into_response() }),
            )
            .route(
                "/api/to-metadata",
                axum::routing::get(|| async {
                    (StatusCode::FOUND, [(header::LOCATION, "http://169.254.169.254/latest/meta-data")]).into_response()
                }),
            )
            .route("/secret", axum::routing::get(|| async { axum::Json(json!({ "geheim": true })) }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        addr
    }

    #[tokio::test]
    async fn answers_become_documents_with_secrets_from_the_store() {
        let addr = upstream().await;
        let settings = json!({ "url": format!("http://{addr}/api/orders?fix=1"), "documentsPath": "data.items",
                               "apiKeyHeader": "X-Api-Key" });
        let conn = test_connection(settings, &[("bearerToken", "tok"), ("apiKey", "k3y")], policy(&[])).await;
        let r = HttpJson
            .query(&conn, req(json!({ "params": { "land": "$land", "n": 2 } }), json!({ "land": ["AT", "CH"] }), 2))
            .await
            .unwrap();
        let QueryResult::Documents { documents } = r else { panic!("documents") };
        assert_eq!(documents.documents.len(), 2);
        let first = &documents.documents[0].value();
        assert_eq!(first["auth"], "Bearer tok");
        assert_eq!(first["key"], "k3y");
        assert_eq!(first["query"], "fix=1&land=AT&land=CH&n=2");
        assert_eq!(documents.truncated.unwrap().limit, 2);
        assert!(documents.schema.iter().any(|f| f.path == "id"));

        let r =
            HttpJson.query(&conn, req(json!({ "path": "open", "documentsPath": "" }), json!({}), 10)).await.unwrap();
        let QueryResult::Documents { documents } = r else { panic!("documents") };
        assert_eq!(documents.documents, [json!({ "offen": true })]);

        let h = HttpJson.health(&conn).await;
        assert!(h.ok && h.detail.reason == "health.http_json_answered", "{h:?}");
    }

    #[tokio::test]
    async fn queries_cannot_leave_the_source_url() {
        let addr = upstream().await;
        let conn = test_connection(json!({ "url": format!("http://{addr}/api/") }), &[], policy(&[])).await;
        for path in [
            "../secret",
            "/secret",
            "a/../../secret",
            "%2e%2e/secret",
            "http://169.254.169.254/x",
            "x?y=1",
            "x#y",
            "..\\secret",
            "./x",
        ] {
            let e = HttpJson.query(&conn, req(json!({ "path": path }), json!({}), 10)).await.unwrap_err();
            assert_eq!(e.detail().reason, "http_json.path_invalid", "{path}");
        }
        let e = HttpJson.query(&conn, req(json!({ "params": { "a": "$fehlt" } }), json!({}), 10)).await.unwrap_err();
        assert_eq!(e.detail().reason, "http_json.variable_missing");
        let e = HttpJson.query(&conn, req(json!({ "params": { "a": { "x": 1 } } }), json!({}), 10)).await.unwrap_err();
        assert_eq!(e.detail().reason, "http_json.param_invalid");
    }

    #[tokio::test]
    async fn targets_and_redirects_are_checked_and_errors_carry_reasons() {
        let addr = upstream().await;
        let base = format!("http://{addr}/api/");
        let conn = test_connection(json!({ "url": base }), &[], policy(&[])).await;
        let e = HttpJson.query(&conn, req(json!({ "path": "to-metadata" }), json!({}), 10)).await.unwrap_err();
        assert!(matches!(e, SourceError::Blocked(_)), "{e}");
        assert_eq!(e.detail().reason, "target.metadata_address");
        let e = HttpJson.query(&conn, req(json!({ "path": "text" }), json!({}), 10)).await.unwrap_err();
        assert_eq!(e.detail().reason, "http_json.not_json");
        let e = HttpJson.query(&conn, req(json!({ "path": "fails" }), json!({}), 10)).await.unwrap_err();
        assert_eq!((e.detail().reason, e.detail().params["status"].as_str()), ("http_json.status", "403"));
        let e = HttpJson.query(&conn, req(json!({ "documentsPath": "nichts.da" }), json!({}), 10)).await;
        assert_eq!(e.unwrap_err().detail().reason, "http_json.status", "the base answers 404");

        let meta = test_connection(json!({ "url": "http://169.254.169.254/latest" }), &[], policy(&[])).await;
        let e = HttpJson.query(&meta, req(json!({}), json!({}), 10)).await.unwrap_err();
        assert!(matches!(e, SourceError::Blocked(_)), "{e}");
        let only_ten = test_connection(json!({ "url": base }), &[], policy(&["10.0.0.0/8"])).await;
        let e = HttpJson.query(&only_ten, req(json!({}), json!({}), 10)).await.unwrap_err();
        assert_eq!(e.detail().reason, "target.not_allowed");
    }

    #[test]
    fn settings_are_checked() {
        assert!(HttpJson.check_settings(&json!({ "url": "https://api.intern/v1/items?status=open" })).is_ok());
        let field = |v: Value| HttpJson.check_settings(&v).unwrap_err().field;
        assert_eq!(field(json!({ "url": "https://u:p@api.intern" })), "url");
        assert_eq!(field(json!({ "url": "https://api.intern/#x" })), "url");
        assert_eq!(field(json!({ "url": "file:///etc/passwd" })), "url");
        assert_eq!(field(json!({ "url": "https://api.intern", "apiKeyHeader": "Authorization" })), "apiKeyHeader");
        assert_eq!(field(json!({ "url": "https://api.intern", "apiKeyHeader": "kein header" })), "apiKeyHeader");
        assert_eq!(at_path(&json!({ "a": [{ "b": 1 }] }), "a.0.b"), Some(&json!(1)));
    }
}

#[cfg(test)]
mod hardening_tests {
    use super::*;
    use crate::datasources::Limits;
    use crate::datasources::json_documents::test_connection;
    use crate::datasources::targets::TargetPolicy;
    use crate::shapes::TimeRange;
    use axum::Router;
    use axum::response::IntoResponse;
    use serde_json::json;

    fn req(query: Value) -> SourceQuery {
        SourceQuery {
            ref_id: "A".into(),
            query,
            range: TimeRange { from: 0, to: 1 },
            interval_ms: 1000,
            max_data_points: None,
            variables: BTreeMap::new(),
            identifier_variables: None,
            cursor: None,
            limits: Limits { timeout: Duration::from_secs(5), max_rows: 100, budget: ResponseBudget::new(1 << 20) },
        }
    }

    #[test]
    fn paths_stay_below_the_base() {
        let base = Url::parse("https://api.intern/v1/?tenant=7").unwrap();
        for p in [
            "../admin",
            "a/../../admin",
            "%2e%2e/admin",
            "a/%2E./b",
            ".%2e/x",
            "//evil/x",
            r"\\evil\x",
            "http:x",
            "a?x=1",
            "a#f",
            "a\r\nX-Inject: 1",
            "a\t/../b",
            "a/..;/admin",
            "a/%252e%252e/admin",
            "..x/admin",
        ] {
            let r = join_path(&base, p).map(|u| u.to_string()).map_err(|e| e.detail().reason);
            assert_eq!(r, Err("http_json.path_invalid"), "{p:?}");
        }
        // Full-width dots are no dots to a server: the path stays below the base.
        let u = join_path(&base, "\u{FF0E}\u{FF0E}/admin").unwrap();
        assert!(u.path().starts_with("/v1/"), "{u}");
        assert_eq!(join_path(&base, "orders/open").unwrap().as_str(), "https://api.intern/v1/orders/open?tenant=7");
    }

    /// A query author adds `params` to a path of the allowed API that redirects (an open
    /// redirect), and the client follows to any host the target rules allow.
    #[tokio::test]
    async fn redirects_leave_the_base_url() {
        let inner = Router::new().fallback(|| async { axum::Json(json!({ "intern": true })) });
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let inner_addr = l.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(l, inner).await.unwrap() });
        let api = Router::new().fallback(|q: axum::extract::Query<BTreeMap<String, String>>| async move {
            match q.get("next") {
                Some(n) => (axum::http::StatusCode::FOUND, [(axum::http::header::LOCATION, n.clone())]).into_response(),
                None => axum::Json(json!([])).into_response(),
            }
        });
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let api_addr = l.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(l, api).await.unwrap() });
        let policy = TargetPolicy::new(&std::env::temp_dir().join("kalzit-none"), "sqlite::memory:", &[], &[]);
        let conn = test_connection(json!({ "url": format!("http://{api_addr}/v1/") }), &[], policy).await;
        let r = HttpJson
            .query(
                &conn,
                req(json!({ "path": "login", "params": { "next": format!("http://{inner_addr}/admin/users") } })),
            )
            .await;
        let leaked = matches!(&r, Ok(QueryResult::Documents { documents }) if documents.documents.first().is_some_and(|d| d.value()["intern"] == true));
        assert!(!leaked, "the query read another host through a redirect");
        assert_eq!(r.err().map(|e| e.detail().reason), Some("http_json.redirect_refused"));
        // A redirect on the same host but outside the source's URL is refused as well.
        let r = HttpJson
            .query(&conn, req(json!({ "path": "login", "params": { "next": format!("http://{api_addr}/admin") } })))
            .await;
        assert_eq!(r.err().map(|e| e.detail().reason), Some("http_json.redirect_refused"));
        let r = HttpJson
            .query(&conn, req(json!({ "path": "login", "params": { "next": format!("http://{api_addr}/v1/daten") } })))
            .await;
        assert!(r.is_ok(), "a redirect below the URL is followed: {:?}", r.err().map(|e| e.detail()));
    }

    /// The error body is cut to 300 characters before the secrets are scrubbed, so a secret that
    /// straddles the cut is not recognized and its first part is shown.
    #[tokio::test]
    async fn error_bodies_are_scrubbed_before_they_are_cut() {
        let token = "TOKEN-0123456789-abcdefghijklmnopqrstuvwxyz";
        let body = format!("{}{token}", "x".repeat(MAX_ERROR_BODY - 10));
        let app = Router::new().fallback(move || {
            let body = body.clone();
            async move { (axum::http::StatusCode::UNAUTHORIZED, body).into_response() }
        });
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = l.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
        let policy = TargetPolicy::new(&std::env::temp_dir().join("kalzit-none"), "sqlite::memory:", &[], &[]);
        let conn =
            test_connection(json!({ "url": format!("http://{addr}/") }), &[("bearerToken", token)], policy).await;
        let Err(e) = HttpJson.query(&conn, req(json!({}))).await else { panic!("expected an error") };
        let detail = e.detail().scrubbed(|t| conn.scrub(t));
        assert!(!detail.message.contains("TOKEN-0123"), "{}", detail.message);
    }
}

#[cfg(test)]
mod review_followup_tests {
    use super::*;

    /// A redirect target below the base path in name only: servers that treat `..;` as `..`
    /// (Tomcat, Jetty) or decode `%2f` / `%25` again resolve it outside the base.
    #[test]
    fn redirect_hops_follow_the_path_rules() {
        let base = Url::parse("http://api.intern/v1/").unwrap();
        let policy = crate::datasources::targets::TargetPolicy::new(
            &std::env::temp_dir().join("kalzit-none"),
            "sqlite::memory:",
            &[],
            &[],
        );
        let http = crate::http::client(crate::http::HttpOptions {
            timeout: Duration::from_secs(5),
            extra_root_pem: None,
            policy: Arc::new(policy),
        })
        .unwrap();
        let c = Client { http, base: base.clone(), headers: HeaderMap::new(), documents_path: None, secrets: vec![] };
        let mut passed = Vec::new();
        for loc in ["/v1/..;/admin", "/v1/%2e%2e%2fadmin", "/v1/%252e%252e/admin", "/v1/a/..%3b/admin"] {
            let url = base.join(loc).unwrap();
            if c.check_hop(&Method::GET, &url).is_ok() {
                passed.push(url.to_string());
            }
        }
        assert!(passed.is_empty(), "followed: {passed:#?}");
        for ok in ["/v1/", "/v1/daten/2026", "/v1/a.b/..c"] {
            let url = base.join(ok).unwrap();
            let followed = c.check_hop(&Method::GET, &url).is_ok();
            assert_eq!(followed, !ok.ends_with("..c"), "{url}");
        }
        assert!(c.check_hop(&Method::POST, &base).is_err(), "only GET");
    }
}
