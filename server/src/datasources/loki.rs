//! Loki over its HTTP API, through the one client factory (`crate::http`), which checks every
//! connection and redirect target.
//!
//! Read-only by construction: Kalzit sends only GET requests to a fixed list of read endpoints
//! (`Endpoint`), and every URL, redirects included, is checked against that list before it is
//! sent, so nothing reaches push, delete or any administrative endpoint. LogQL itself cannot
//! write.
//!
//! Log queries answer `documents`: one document per log line with its time, the line and its
//! stream labels, in the native shape of a log. Metric queries (`rate(...)`, `count_over_time`)
//! answer a `frame` like Prometheus. Variables are accepted only inside quoted strings, as in
//! PromQL (`prometheus::expand`).

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use futures_util::StreamExt;
use reqwest::header::{AUTHORIZATION, HeaderMap, HeaderName};
use reqwest::{Method, Url};
use serde::Deserialize;
use serde_json::{Map, Value, json};

use super::Detail;
use super::frame::Charge;
use super::http_json::{basic_auth, header_value, parse_url};
use super::json_documents::DocumentsBuilder;
use super::prometheus;
use super::{
    Connection, DataSourcePlugin, FieldError, Health, Kind, SettingField, SettingType, SourceError, SourceQuery,
    SourceSchema,
};
use crate::http::{HttpClient, HttpError, HttpOptions};
use crate::shapes::{NoticeSeverity, QueryResult, Shape, typed};

const SETTINGS: &[SettingField] = &[
    SettingField::new("url", "datasources.settings.url", SettingType::String).target().required(),
    SettingField::new("basicAuthUser", "datasources.settings.basicAuthUser", SettingType::String).target(),
    SettingField::new("basicAuthPassword", "datasources.settings.basicAuthPassword", SettingType::String).secret(),
    SettingField::new("bearerToken", "datasources.settings.bearerToken", SettingType::String).secret(),
    SettingField::new("tenantId", "datasources.settings.tenantId", SettingType::String),
    SettingField::new("caCert", "datasources.settings.caCert", SettingType::Text).target(),
];
/// The client's own limit; the query timeout around each call is usually shorter.
const CLIENT_TIMEOUT: Duration = Duration::from_secs(3600);
/// Health and schema answers are read up to this size.
const MAX_SMALL_RESPONSE: usize = 16 * 1024 * 1024;
/// Lines a log query asks for when it does not say (Loki's own default is 100).
const DEFAULT_LINES: u64 = 1_000;
/// Label values the schema reads for completion: of this many labels, this many values each.
const MAX_SCHEMA_LABELS: usize = 50;
const MAX_SCHEMA_VALUES: usize = 200;
/// The schema covers the last six hours, as Loki's own label endpoints do by default.
const SCHEMA_SPAN_MS: i64 = 6 * 3_600_000;
const NS_PER_MS: i128 = 1_000_000;

pub fn kind() -> Kind {
    Kind { name: "Loki", hint_key: "datasources.kinds.loki.hint", settings: SETTINGS, plugin: Arc::new(Loki) }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Settings {
    url: String,
    basic_auth_user: Option<String>,
    tenant_id: Option<String>,
    ca_cert: Option<String>,
}

/// `{"logql": "...", "limit": 1000, "direction": "backward", "instant": false, "minStepMs": 15000}`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LokiQuery {
    logql: String,
    limit: Option<u64>,
    direction: Option<Direction>,
    #[serde(default)]
    instant: bool,
    min_step_ms: Option<u64>,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum Direction {
    /// Newest lines first.
    #[default]
    Backward,
    Forward,
}

impl Direction {
    fn as_str(self) -> &'static str {
        match self {
            Direction::Backward => "backward",
            Direction::Forward => "forward",
        }
    }
}

pub struct Loki;

/// The only requests Kalzit sends to Loki, all GET.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Endpoint<'a> {
    Query,
    QueryRange,
    Labels,
    LabelValues(&'a str),
    BuildInfo,
}

const API: [&str; 3] = ["loki", "api", "v1"];

impl Endpoint<'_> {
    fn url(self, base: &Url) -> Result<Url, SourceError> {
        let mut url = base.clone();
        {
            let mut segments = url
                .path_segments_mut()
                .map_err(|_| SourceError::failed("settings.stored_invalid", "the stored URL cannot carry a path"))?;
            segments.pop_if_empty().extend(API);
            match self {
                Endpoint::Query => {
                    segments.push("query");
                }
                Endpoint::QueryRange => {
                    segments.push("query_range");
                }
                Endpoint::Labels => {
                    segments.push("labels");
                }
                Endpoint::LabelValues(name) => {
                    segments.push("label").push(name).push("values");
                }
                Endpoint::BuildInfo => {
                    segments.push("status").push("buildinfo");
                }
            }
        }
        Ok(url)
    }
}

/// Refuses every URL that is not one of the read endpoints below `base` (redirects included).
fn check_endpoint(base: &Url, method: &Method, url: &Url) -> Result<(), Detail> {
    let refused = || {
        Detail::new("loki.endpoint_not_allowed", format!("{method} {} is not a read endpoint", url.path()))
            .with("path", url.path())
    };
    if *method != Method::GET || url.origin() != base.origin() || url.fragment().is_some() {
        return Err(refused());
    }
    let base_path = base.path().trim_end_matches('/');
    let Some(rest) = url.path().strip_prefix(base_path).and_then(|r| r.strip_prefix("/loki/api/v1/")) else {
        return Err(refused());
    };
    let segments: Vec<&str> = rest.split('/').collect();
    let ok = match segments.as_slice() {
        ["query" | "query_range" | "labels"] => true,
        ["status", "buildinfo"] => true,
        ["label", name, "values"] => !name.is_empty() && *name != "." && *name != "..",
        _ => false,
    };
    if ok { Ok(()) } else { Err(refused()) }
}

struct Client {
    http: HttpClient,
    base: Url,
    headers: HeaderMap,
    /// The base64 of `user:password`, to scrub from errors.
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
        let mut headers = HeaderMap::new();
        let mut basic_token = None;
        match (s.basic_auth_user.filter(|u| !u.is_empty()), conn.secret("bearerToken")) {
            (Some(user), _) => {
                let (value, token) = basic_auth(&user, conn.secret("basicAuthPassword").unwrap_or(""));
                headers.insert(AUTHORIZATION, header_value(&value, "loki.credentials_invalid")?);
                basic_token = Some(token);
            }
            (None, Some(token)) => {
                headers.insert(AUTHORIZATION, header_value(&format!("Bearer {token}"), "loki.credentials_invalid")?);
            }
            (None, None) => {}
        }
        if let Some(tenant) = s.tenant_id.filter(|t| !t.trim().is_empty()) {
            headers.insert(
                HeaderName::from_static("x-scope-orgid"),
                header_value(tenant.trim(), "loki.credentials_invalid")?,
            );
        }
        Ok(Client { http, base, headers, basic_token })
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

    /// GETs an endpoint and answers the whole JSON body. With a charge, the body is charged to
    /// the request's budget as it arrives.
    async fn get(
        &self,
        endpoint: Endpoint<'_>,
        params: &[(&str, String)],
        max_bytes: usize,
        charge: Option<&mut Charge>,
    ) -> Result<Value, SourceError> {
        let mut url = endpoint.url(&self.base)?;
        if !params.is_empty() {
            url.query_pairs_mut().extend_pairs(params.iter().map(|(k, v)| (*k, v.as_str())));
        }
        let base = self.base.clone();
        let hop = move |method: &Method, url: &Url| check_endpoint(&base, method, url);
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
            // Loki answers errors as plain text (`parse error at line 1, col 5: ...`).
            let text = String::from_utf8_lossy(&body);
            let message = serde_json::from_slice::<Value>(&body)
                .ok()
                .and_then(|v| v["message"].as_str().or(v["error"].as_str()).map(str::to_string))
                .unwrap_or_else(|| text.trim().to_string());
            let message = self.scrub(&message);
            return Err(SourceError::failed("loki.error", format!("Loki answered {status}: {message}"))
                .with("status", status.as_u16())
                .with("detail", message));
        }
        serde_json::from_slice(&body).map_err(|_| {
            SourceError::failed(
                "loki.not_an_api_response",
                format!("the server answered {status} without a Loki API response"),
            )
            .with("status", status.as_u16())
        })
    }

    /// `data` of a successful answer.
    async fn data(&self, endpoint: Endpoint<'_>, params: &[(&str, String)]) -> Result<Value, SourceError> {
        let answer = self.get(endpoint, params, MAX_SMALL_RESPONSE, None).await?;
        Ok(answer["data"].clone())
    }
}

/// One label's values for completion; a label whose values cannot be read has none.
async fn label_values(c: &Client, label: String, span: &[(&str, String)]) -> (String, Vec<String>) {
    let values = c.data(Endpoint::LabelValues(&label), span).await.ok();
    let values = values.map(|v| names(&v, MAX_SCHEMA_VALUES)).unwrap_or_default();
    (label, values)
}

/// Unix nanoseconds from milliseconds, as Loki takes them.
fn nanos(ms: i64) -> String {
    (i128::from(ms) * NS_PER_MS).to_string()
}

fn names(data: &Value, max: usize) -> Vec<String> {
    data.as_array()
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).take(max).collect())
        .unwrap_or_default()
}

#[async_trait::async_trait]
impl DataSourcePlugin for Loki {
    fn kind(&self) -> &'static str {
        "loki"
    }

    fn shapes(&self) -> &'static [Shape] {
        &[Shape::Documents, Shape::Frame]
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
            // The build info needs no tenant or login on every setup; the labels do.
            let info = c.get(Endpoint::BuildInfo, &[], MAX_SMALL_RESPONSE, None).await.ok();
            c.data(Endpoint::Labels, &[]).await?;
            Ok::<_, SourceError>(info.and_then(|i| i["version"].as_str().map(str::to_string)).unwrap_or_default())
        };
        match check.await {
            Ok(version) => Health::connected("Loki", &version, false),
            Err(e) => Health::failed(&e),
        }
    }

    async fn schema(&self, conn: &Connection) -> Result<SourceSchema, SourceError> {
        let c = client(conn).await?;
        let now = chrono::Utc::now().timestamp_millis();
        let span = [("start", nanos(now - SCHEMA_SPAN_MS)), ("end", nanos(now))];
        let labels = names(&c.data(Endpoint::Labels, &span).await?, MAX_SCHEMA_LABELS * 20);
        let values: BTreeMap<String, Vec<String>> =
            futures_util::stream::iter(labels.iter().take(MAX_SCHEMA_LABELS).cloned())
                .map(|label| label_values(&c, label, &span))
                .buffer_unordered(4)
                .collect()
                .await;
        Ok(SourceSchema::Labels { labels, values })
    }

    async fn query(&self, conn: &Connection, req: SourceQuery) -> Result<QueryResult, SourceError> {
        let q: LokiQuery = req.parse()?;
        let step_ms = step_ms(&q, &req);
        let mut req = req;
        req.interval_ms = step_ms as u64;
        let expr = prometheus::expand(&q.logql, &req)?;
        if expr.trim().is_empty() {
            return Err(SourceError::rejected("loki.empty", "the LogQL query is empty"));
        }
        let limit = q.limit.unwrap_or(DEFAULT_LINES).clamp(1, req.limits.max_rows as u64);
        let direction = q.direction.unwrap_or_default();
        let c = client(conn).await?;
        let max_bytes = req.limits.budget.remaining();
        let mut charge = req.limits.budget.charge();
        let answer = if q.instant {
            let params = [
                ("query", expr.clone()),
                ("time", nanos(req.range.to)),
                ("limit", limit.to_string()),
                ("direction", direction.as_str().to_string()),
            ];
            c.get(Endpoint::Query, &params, max_bytes, Some(&mut charge)).await?
        } else {
            let params = [
                ("query", expr.clone()),
                ("start", nanos(prometheus::aligned_start(req.range.from, req.range.to, step_ms))),
                ("end", nanos(req.range.to)),
                ("step", prometheus::seconds(step_ms)),
                ("limit", limit.to_string()),
                ("direction", direction.as_str().to_string()),
            ];
            c.get(Endpoint::QueryRange, &params, max_bytes, Some(&mut charge)).await?
        };
        if answer["status"] != "success" {
            let message = c.scrub(answer["error"].as_str().unwrap_or("unknown error"));
            return Err(SourceError::failed("loki.error", format!("Loki answered an error: {message}"))
                .with("status", 200)
                .with("detail", message));
        }
        let warnings: Vec<String> = answer["warnings"]
            .as_array()
            .map(|w| w.iter().filter_map(|v| v.as_str().map(|s| c.scrub(s))).collect())
            .unwrap_or_default();
        let data = &answer["data"];
        let result = if data["resultType"] == "streams" {
            let mut docs = to_documents(data, &req, limit as usize, direction);
            docs.executed_query(expr);
            for w in warnings {
                docs.notice(NoticeSeverity::Info, Detail::new("loki.warning", w.clone()).with("detail", w));
            }
            QueryResult::Documents { documents: docs.finish() }
        } else {
            let mut frame = prometheus::to_frame(data, &req)?;
            frame.executed_query(expr);
            for w in warnings {
                frame.notice(NoticeSeverity::Info, Detail::new("loki.warning", w.clone()).with("detail", w));
            }
            QueryResult::Frame { frame: frame.finish() }
        };
        drop(answer);
        drop(charge);
        Ok(result)
    }
}

/// The step of a metric query, as for Prometheus: the panel's interval, at least the query's
/// minimum step, and wide enough to stay within Loki's point limit per series.
fn step_ms(q: &LokiQuery, req: &SourceQuery) -> i64 {
    let step = (req.interval_ms as i64).max(q.min_step_ms.unwrap_or(0) as i64);
    if q.instant {
        return step.max(1);
    }
    let span = req.range.to.saturating_sub(req.range.from).max(0);
    step.max(span / prometheus::MAX_POINTS_PER_SERIES + 1).max(1)
}

/// The log lines of all streams as documents, newest first (or oldest first going forward):
/// `{"time": {"$type": "date", "value": ms}, "timestampNs": "...", "line": "...", "labels": {...}}`,
/// with `metadata` where Loki has structured metadata for the line.
fn to_documents(data: &Value, req: &SourceQuery, limit: usize, direction: Direction) -> DocumentsBuilder {
    let mut lines: Vec<(i128, &str, &Value, Option<&Value>)> = Vec::new();
    let empty = Vec::new();
    for stream in data["result"].as_array().unwrap_or(&empty) {
        let labels = &stream["stream"];
        for entry in stream["values"].as_array().unwrap_or(&empty) {
            let (Some(ts), Some(line)) = (entry[0].as_str().and_then(|t| t.parse::<i128>().ok()), entry[1].as_str())
            else {
                continue;
            };
            lines.push((ts, line, labels, entry.get(2).filter(|m| m.as_object().is_some_and(|o| !o.is_empty()))));
        }
    }
    match direction {
        Direction::Backward => lines.sort_by_key(|a| std::cmp::Reverse(a.0)),
        Direction::Forward => lines.sort_by_key(|a| a.0),
    }
    let mut docs = DocumentsBuilder::new(req.limits.max_rows, req.limits.budget.clone());
    let total = lines.len();
    for (ts, line, labels, metadata) in lines {
        let ms = ts.div_euclid(NS_PER_MS);
        let mut doc = Map::new();
        doc.insert("time".into(), typed("date", ms.to_string()));
        doc.insert("timestampNs".into(), json!(ts.to_string()));
        doc.insert("line".into(), json!(line));
        doc.insert("labels".into(), labels.clone());
        if let Some(m) = metadata {
            doc.insert("metadata".into(), m.clone());
        }
        if !docs.push(Value::Object(doc)) {
            break;
        }
    }
    // Loki stopped at the line limit: there may be more lines in the range.
    if total >= limit {
        docs.mark_limit(limit);
    }
    docs
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
            interval_ms: 15_000,
            max_data_points: None,
            variables: serde_json::from_value(vars).unwrap(),
            identifier_variables: None,
            limits: Limits { timeout: Duration::from_secs(5), max_rows: 1000, budget: ResponseBudget::new(1 << 20) },
            cursor: None,
        }
    }

    #[test]
    fn variables_stay_inside_strings_and_line_filters_match_literally() {
        let r = req(json!({ "app": "api\" or 1", "suche": "a.b" }));
        let out = prometheus::expand(r#"sum(rate({app="$app"} |~ "$suche" [$__interval]))"#, &r).unwrap();
        assert_eq!(out, r#"sum(rate({app="api\" or 1"} |~ "a\\.b" [15s]))"#);
        assert!(matches!(prometheus::expand("{app=\"x\"} |= $app", &r), Err(SourceError::Rejected(_))));
    }

    #[test]
    fn only_read_endpoints_are_reached() {
        let base = Url::parse("https://loki.intern/proxy/").unwrap();
        let ok = |path: &str| check_endpoint(&base, &Method::GET, &base.join(path).unwrap()).is_ok();
        assert!(ok("loki/api/v1/query_range?query=x"));
        assert!(ok("loki/api/v1/label/app/values"));
        assert!(ok("loki/api/v1/status/buildinfo"));
        assert!(!ok("loki/api/v1/push"));
        assert!(!ok("loki/api/v1/delete"));
        assert!(!ok("loki/api/v1/tail"));
        assert!(!ok("/loki/api/v1/query"), "outside the base path");
        assert!(!ok("loki/api/v1/label/../../push/values"));
        assert!(check_endpoint(&base, &Method::POST, &base.join("loki/api/v1/query").unwrap()).is_err(), "only GET");
        let other = Url::parse("https://anders.intern/proxy/loki/api/v1/query").unwrap();
        assert!(check_endpoint(&base, &Method::GET, &other).is_err());
        assert_eq!(
            Endpoint::LabelValues("a/b").url(&base).unwrap().as_str(),
            "https://loki.intern/proxy/loki/api/v1/label/a%2Fb/values"
        );
    }

    #[test]
    fn log_lines_become_documents_newest_first() {
        let data = json!({
            "resultType": "streams",
            "result": [
                { "stream": { "app": "api", "level": "error" },
                  "values": [["1800000001000000123", "Fehler A"], ["1800000003000000000", "Fehler C", { "trace_id": "t1" }]] },
                { "stream": { "app": "web" }, "values": [["1800000002000000000", "Hinweis B"]] }
            ]
        });
        let set = to_documents(&data, &req(json!({})), 1000, Direction::Backward).finish();
        let lines: Vec<Value> = set.documents.iter().map(|d| d.value()["line"].clone()).collect();
        assert_eq!(lines, [json!("Fehler C"), json!("Hinweis B"), json!("Fehler A")]);
        let first = set.documents[0].value();
        assert_eq!(first["time"], json!({ "$type": "date", "value": "1800000003000" }));
        assert_eq!(first["labels"]["level"], "error");
        assert_eq!(first["metadata"]["trace_id"], "t1");
        assert_eq!(set.documents[2].value()["timestampNs"], "1800000001000000123");
        assert!(set.truncated.is_none());
        // Exactly the asked number of lines: Loki may have more.
        let set = to_documents(&data, &req(json!({})), 3, Direction::Forward).finish();
        assert_eq!(set.documents[0].value()["line"], "Fehler A");
        assert_eq!(set.truncated.unwrap().reason.as_deref(), Some("documents.limit"));
    }
}
