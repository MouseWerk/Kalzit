//! Graphite (graphite-web, carbonapi, go-graphite) over its render API, through the one client
//! factory (`crate::http`), which checks every connection and redirect target.
//!
//! Read-only by nature: Kalzit calls only `render`, `metrics/find`, `metrics/index.json`, `tags`
//! and `version`, all reads, and Graphite's functions only compute over what they read. The
//! target is passed to Graphite as written. Graphite has no bind parameters, so variables are put
//! into the text: as metric path parts only when the value consists of name characters, inside a
//! quoted string only without quotes and backslashes, as Graphite servers disagree on escapes
//! (carbonapi reads none); anything else is refused.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;
use std::time::Duration;

use reqwest::header::{AUTHORIZATION, HeaderMap, HeaderValue};
use reqwest::{Method, Url};
use serde::Deserialize;
use serde_json::{Value, json};

use super::Detail;
use super::frame::{Charge, Column, FrameBuilder};
use super::http_source::{self, Auth, Scrubber};
use super::prometheus::parse_url;
use super::{
    Connection, DataSourcePlugin, FieldError, Health, Kind, SettingField, SettingType, SourceError, SourceQuery,
    SourceSchema,
};
use crate::http::{HttpClient, HttpError, HttpOptions};
use crate::shapes::{FieldType, NoticeSeverity, QueryResult, Shape};

const SETTINGS: &[SettingField] = &[
    SettingField::new("url", "datasources.settings.url", SettingType::String).target().required(),
    SettingField::new("basicAuthUser", "datasources.settings.basicAuthUser", SettingType::String).target(),
    SettingField::new("basicAuthPassword", "datasources.settings.basicAuthPassword", SettingType::String).secret(),
    SettingField::new("bearerToken", "datasources.settings.bearerToken", SettingType::String).secret(),
    SettingField::new("caCert", "datasources.settings.caCert", SettingType::Text).target(),
];
/// The client's own limit; the query timeout around each call is usually shorter.
const CLIENT_TIMEOUT: Duration = Duration::from_secs(3600);
/// Schema and health answers are small; this keeps a misbehaving server from filling memory.
const MAX_SMALL_RESPONSE: usize = 16 * 1024 * 1024;
const MAX_SCHEMA_NAMES: usize = 10_000;
/// The server's error text in a message is cut to this many characters.
const MAX_ERROR_CHARS: usize = 300;

pub fn kind() -> Kind {
    Kind {
        name: "Graphite",
        hint_key: "datasources.kinds.graphite.hint",
        settings: SETTINGS,
        plugin: Arc::new(Graphite),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Settings {
    url: String,
    basic_auth_user: Option<String>,
    ca_cert: Option<String>,
}

/// `{"target": "sumSeries(app.*.requests)"}`.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct GraphiteQuery {
    target: String,
}

pub struct Graphite;

struct Client {
    http: HttpClient,
    base: Url,
    auth: Option<HeaderValue>,
    scrubber: Scrubber,
}

async fn client(conn: &Connection) -> Result<Arc<Client>, SourceError> {
    conn.shared(|| async {
        let s: Settings = conn.settings_as()?;
        let mut base = parse_url(&s.url).map_err(SourceError::Failed)?;
        if !base.path().ends_with('/') {
            base.set_path(&format!("{}/", base.path()));
        }
        let http = crate::http::client(HttpOptions {
            timeout: CLIENT_TIMEOUT,
            extra_root_pem: s.ca_cert,
            policy: Arc::new(conn.policy().clone()),
        })
        .map_err(|e| SourceError::Failed(e.detail()))?;
        let mut scrubber = Scrubber::new(conn);
        let auth = Auth::basic_or_bearer(
            s.basic_auth_user.as_deref(),
            conn.secret("basicAuthPassword"),
            conn.secret("bearerToken"),
        )
        .map(|a| a.header("graphite.credentials_invalid", &mut scrubber))
        .transpose()?;
        Ok(Client { http, base, auth, scrubber })
    })
    .await
}

impl Client {
    fn failed(&self, e: HttpError) -> SourceError {
        http_source::failed(e, &self.scrubber)
    }

    /// GETs one of the read endpoints and answers its body, or Graphite's error.
    async fn get(
        &self,
        path: &str,
        params: &[(&str, String)],
        max_bytes: usize,
        charge: Option<&mut Charge>,
    ) -> Result<Vec<u8>, SourceError> {
        let mut url = self.base.join(path).map_err(|e| SourceError::failed("internal", e.to_string()))?;
        url.query_pairs_mut().extend_pairs(params.iter().map(|(k, v)| (*k, v.as_str())));
        let mut headers = HeaderMap::new();
        if let Some(auth) = &self.auth {
            headers.insert(AUTHORIZATION, auth.clone());
        }
        let response = self.http.send(Method::GET, url, headers).await.map_err(|e| self.failed(e))?;
        let status = response.status();
        let body = match charge {
            Some(charge) => crate::http::read_counted(response, max_bytes, |n| charge.add(n)).await,
            None => crate::http::read_limited(response, max_bytes).await,
        }
        .map_err(|e| self.failed(e))?;
        if let Some(e) = http_source::unauthorized(status, &body, &self.scrubber) {
            return Err(e);
        }
        if !status.is_success() {
            return Err(graphite_error(status.as_u16(), &self.scrubber.scrub(&String::from_utf8_lossy(&body))));
        }
        Ok(body)
    }

    async fn json(&self, path: &str, params: &[(&str, String)]) -> Result<Value, SourceError> {
        let body = self.get(path, params, MAX_SMALL_RESPONSE, None).await?;
        serde_json::from_slice(&body).map_err(|_| not_graphite())
    }
}

fn not_graphite() -> SourceError {
    SourceError::failed("graphite.not_graphite", "the server answered, but not like Graphite; check the URL")
}

/// Graphite's error page as a source error: its text without markup, cut short.
fn graphite_error(status: u16, body: &str) -> SourceError {
    let mut text = String::new();
    let mut in_tag = false;
    for c in body.chars() {
        match c {
            '<' => in_tag = true,
            '>' => {
                in_tag = false;
                text.push(' ');
            }
            c if !in_tag => text.push(c),
            _ => {}
        }
    }
    let text: String = text.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(MAX_ERROR_CHARS).collect();
    SourceError::failed("graphite.error", format!("Graphite answered {status}: {text}"))
        .with("status", status)
        .with("detail", text)
}

#[async_trait::async_trait]
impl DataSourcePlugin for Graphite {
    fn kind(&self) -> &'static str {
        "graphite"
    }

    fn shapes(&self) -> &'static [Shape] {
        &[Shape::Frame]
    }

    fn check_settings(&self, settings: &Value) -> Result<(), FieldError> {
        let s = Settings::deserialize(settings)
            .map_err(|e| FieldError::new("settings", "settings.invalid", e.to_string()).with("detail", e))?;
        parse_url(&s.url).map_err(|d| FieldError { field: "url", detail: d.with("field", "url") })?;
        super::check_pem("caCert", s.ca_cert.as_deref())?;
        Ok(())
    }

    async fn health(&self, conn: &Connection) -> Health {
        let check = async {
            let c = client(conn).await?;
            let found = c.json("metrics/find", &[("query", "*".into())]).await?;
            if !found.is_array() {
                return Err(not_graphite());
            }
            // graphite-web answers its version as text; carbonapi and others may not.
            let version = c
                .get("version", &[], 1024, None)
                .await
                .ok()
                .map(|b| String::from_utf8_lossy(&b).trim().trim_matches('"').to_string())
                .filter(|v| v.len() <= 40 && !v.contains('<'))
                .unwrap_or_default();
            Ok::<_, SourceError>(version)
        };
        match check.await {
            Ok(version) => Health::connected("Graphite", &version, false),
            Err(e) => Health::failed(&e),
        }
    }

    /// Metric names from the index (graphite-web), else the first two levels of the tree, and
    /// the tag names where the server keeps tags.
    async fn schema(&self, conn: &Connection) -> Result<SourceSchema, SourceError> {
        let c = client(conn).await?;
        let strings = |v: &Value| -> Vec<String> {
            v.as_array()
                .map(|a| a.iter().filter_map(|n| n.as_str().map(String::from)).take(MAX_SCHEMA_NAMES).collect())
                .unwrap_or_default()
        };
        let metrics = match c.json("metrics/index.json", &[]).await {
            Ok(index) => strings(&index),
            Err(_) => {
                let mut names = BTreeSet::new();
                for query in ["*", "*.*"] {
                    let found = c.json("metrics/find", &[("query", query.into())]).await?;
                    for node in found.as_array().into_iter().flatten() {
                        if let Some(id) = node["id"].as_str().or_else(|| node["path"].as_str()) {
                            names.insert(id.to_string());
                        }
                    }
                }
                names.into_iter().take(MAX_SCHEMA_NAMES).collect()
            }
        };
        let labels = match c.json("tags", &[("limit", MAX_SCHEMA_NAMES.to_string())]).await {
            Ok(tags) => tags
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|t| t["tag"].as_str().or_else(|| t.as_str()).map(String::from))
                .filter(|t| t != "name")
                .collect(),
            Err(_) => Vec::new(),
        };
        Ok(SourceSchema::Metrics { metrics, labels })
    }

    async fn query(&self, conn: &Connection, req: SourceQuery) -> Result<QueryResult, SourceError> {
        let q: GraphiteQuery = req.parse()?;
        let target = expand(&q.target, &req)?;
        if target.trim().is_empty() {
            return Err(SourceError::rejected("graphite.empty", "the target is empty"));
        }
        let c = client(conn).await?;
        let max_points = req.max_data_points.unwrap_or(1_000).max(1);
        let params = [
            ("target", target.clone()),
            ("from", (req.range.from.div_euclid(1000)).to_string()),
            ("until", (req.range.to.div_euclid(1000)).to_string()),
            ("format", "json".to_string()),
            ("maxDataPoints", max_points.to_string()),
        ];
        let max_bytes = req.limits.budget.remaining();
        let mut charge = req.limits.budget.charge();
        let body = c.get("render", &params, max_bytes, Some(&mut charge)).await?;
        let series: Vec<RenderSeries> = serde_json::from_slice(&body).map_err(|_| not_graphite())?;
        drop(body);
        let mut frame = to_frame(series, &req);
        frame.executed_query(target);
        let frame = frame.finish();
        drop(charge);
        Ok(QueryResult::Frame { frame })
    }
}

/// One series of `render?format=json`: `[value, seconds]` points, and the tags of tagged series.
#[derive(Deserialize)]
struct RenderSeries {
    target: String,
    #[serde(default)]
    tags: BTreeMap<String, Value>,
    datapoints: Vec<(Option<f64>, Option<i64>)>,
}

/// The series as one wide frame: a time field and one value field per series, each with its
/// tags as labels. The limit counts points: rows times series.
fn to_frame(series: Vec<RenderSeries>, req: &SourceQuery) -> FrameBuilder {
    let mut times = BTreeSet::new();
    let mut columns = vec![Column::new("time", Some(FieldType::Time))];
    let mut points: Vec<BTreeMap<i64, Value>> = Vec::with_capacity(series.len());
    for s in series {
        let mut column = Column::new(s.target, Some(FieldType::Number));
        let labels: BTreeMap<String, String> = s
            .tags
            .into_iter()
            .map(|(k, v)| (k, v.as_str().map_or_else(|| v.to_string(), String::from)))
            .filter(|(k, _)| k != "name")
            .collect();
        column.labels = (!labels.is_empty()).then_some(labels);
        columns.push(column);
        let mut map = BTreeMap::new();
        for (value, seconds) in s.datapoints {
            let Some(t) = seconds.and_then(|s| s.checked_mul(1000)) else { continue };
            times.insert(t);
            map.insert(t, value.and_then(serde_json::Number::from_f64).map_or(Value::Null, Value::Number));
        }
        points.push(map);
    }
    let rows = (req.limits.max_rows / points.len().max(1)).max(1);
    let mut frame = FrameBuilder::new(columns, rows, req.limits.budget.clone());
    for t in times {
        let mut row = vec![json!(t)];
        row.extend(points.iter().map(|p| p.get(&t).cloned().unwrap_or(Value::Null)));
        if !frame.push_row(row) {
            break;
        }
    }
    if points.is_empty() {
        frame.notice(NoticeSeverity::Info, Detail::new("graphite.no_series", "no series matched the target"));
    }
    frame
}

/// Characters a metric path part may hold, so a value cannot add a function, an argument or a
/// wildcard: letters, digits and `_ - : #` (dots join parts and stay allowed).
fn path_safe(text: &str, checked: bool) -> bool {
    !text.is_empty()
        && text.chars().all(|c| {
            c.is_alphanumeric() || matches!(c, '_' | '-' | ':' | '.' | '#' | '@') || (checked && matches!(c, '*' | '?'))
        })
}

fn variable_text(name: &str, value: &Value) -> Result<Vec<String>, SourceError> {
    match value {
        Value::String(s) => Ok(vec![s.clone()]),
        Value::Number(n) => Ok(vec![n.to_string()]),
        Value::Bool(b) => Ok(vec![b.to_string()]),
        Value::Array(items) => items.iter().map(|v| variable_text(name, v).map(|mut t| t.remove(0))).collect(),
        _ => Err(SourceError::rejected(
            "graphite.variable_type",
            format!("variable {name} must be a string, number, boolean or a list of them"),
        )
        .with("name", name)),
    }
}

/// Reads `$name`, `${name}` or `$__macro` at `i` (a `$`): the name and the end index.
fn read_name(text: &str, i: usize) -> Option<(&str, usize)> {
    let rest = &text[i + 1..];
    if let Some(inner) = rest.strip_prefix('{') {
        let close = inner.find('}')?;
        return Some((&inner[..close], i + 2 + close + 1));
    }
    let len = rest.find(|c: char| !(c.is_ascii_alphanumeric() || c == '_')).unwrap_or(rest.len());
    (len > 0 && !rest.starts_with(|c: char| c.is_ascii_digit())).then(|| (&rest[..len], i + 1 + len))
}

/// A Graphite duration in seconds (`60s`), which every Graphite reads alike.
fn seconds(ms: i64) -> String {
    format!("{}s", (ms / 1000).max(1))
}

/// Expands macros and variables. Inside a quoted string a value may hold no quote or backslash; outside, it
/// must be a path part (`servers.$host.cpu`), several values becoming `{a,b}`.
pub(crate) fn expand(target: &str, req: &SourceQuery) -> Result<String, SourceError> {
    let mut out = String::with_capacity(target.len());
    let mut quote: Option<char> = None;
    let mut i = 0;
    while i < target.len() {
        let c = target[i..].chars().next().expect("i is on a char boundary");
        match quote {
            Some(_) if c == '\\' => {
                let next = target[i + 1..].chars().next().map_or(0, char::len_utf8);
                out.push_str(&target[i..i + 1 + next]);
                i += 1 + next;
                continue;
            }
            Some(q) if c == q => quote = None,
            None if matches!(c, '"' | '\'') => quote = Some(c),
            _ => {}
        }
        if c != '$' {
            out.push(c);
            i += c.len_utf8();
            continue;
        }
        let Some((name, end)) = read_name(target, i) else {
            out.push(c);
            i += 1;
            continue;
        };
        let expansion = match name {
            "__interval" => seconds(req.interval_ms as i64),
            "__interval_ms" => req.interval_ms.to_string(),
            "__range" => seconds(req.range.to.saturating_sub(req.range.from)),
            "__timeFrom" => req.range.from.div_euclid(1000).to_string(),
            "__timeTo" => req.range.to.div_euclid(1000).to_string(),
            m if m.starts_with("__") => {
                return Err(
                    SourceError::rejected("graphite.macro_unknown", format!("unknown macro ${m}")).with("name", m)
                );
            }
            name => {
                let value = req.variables.get(name).ok_or_else(|| {
                    SourceError::rejected("graphite.variable_missing", format!("variable {name} has no value"))
                        .with("name", name)
                })?;
                let parts = variable_text(name, value)?;
                match quote {
                    // Graphite servers disagree on escapes inside strings (carbonapi reads none),
                    // so a value that would need one is refused rather than escaped.
                    Some(_) => {
                        let joined = parts.join(",");
                        if joined.contains(['"', '\'', '\\']) {
                            return Err(SourceError::rejected(
                                "graphite.variable_quote",
                                format!("variable {name} contains a quote or backslash and cannot go inside quotes"),
                            )
                            .with("name", name));
                        }
                        joined
                    }
                    None => {
                        let checked = req.identifier_variables.as_ref().is_some_and(|c| c.contains(name));
                        if parts.is_empty() || parts.iter().any(|p| !path_safe(p, checked)) {
                            return Err(SourceError::rejected(
                                "graphite.variable_characters",
                                format!("variable {name} may hold only letters, digits and _ - : . # @ outside quotes"),
                            )
                            .with("name", name));
                        }
                        if parts.len() == 1 { parts[0].clone() } else { format!("{{{}}}", parts.join(",")) }
                    }
                }
            }
        };
        out.push_str(&expansion);
        i = end;
    }
    if quote.is_some() {
        return Err(SourceError::rejected("graphite.unclosed_quote", "unclosed quote in the target"));
    }
    Ok(out)
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
            interval_ms: 60_000,
            max_data_points: None,
            variables: serde_json::from_value(vars).unwrap(),
            identifier_variables: None,
            limits: Limits { timeout: Duration::from_secs(5), max_rows: 1000, budget: ResponseBudget::new(1 << 20) },
            cursor: None,
            filters: Vec::new(),
        }
    }

    fn reason(target: &str, vars: Value) -> &'static str {
        expand(target, &req(vars)).unwrap_err().detail().reason
    }

    #[test]
    fn variables_become_path_parts_or_escaped_strings() {
        let vars = json!({ "host": "web-01", "hosts": ["a", "b"], "label": "Wien Süd, Linz", "n": 3 });
        let r = req(vars.clone());
        assert_eq!(expand("servers.$host.cpu", &r).unwrap(), "servers.web-01.cpu");
        assert_eq!(expand("servers.${hosts}.cpu", &r).unwrap(), "servers.{a,b}.cpu");
        assert_eq!(expand("alias(x, \"$label\")", &r).unwrap(), "alias(x, \"Wien Süd, Linz\")");
        assert_eq!(expand("alias(x, '$label')", &r).unwrap(), "alias(x, 'Wien Süd, Linz')");
        // Inside quotes a quote or backslash is refused, not escaped: carbonapi reads no escapes.
        for value in ["it's", "say \"x\"", "a\\", "\\'"] {
            for target in ["alias(x, \"$v\")", "alias(x, '$v')"] {
                assert_eq!(reason(target, json!({ "v": value })), "graphite.variable_quote", "{target} {value}");
            }
        }
        assert_eq!(reason("alias(x, '$v')", json!({ "v": ["a", "b'c"] })), "graphite.variable_quote");
        assert_eq!(expand("summarize(x, \"$__interval\", \"sum\")", &r).unwrap(), "summarize(x, \"60s\", \"sum\")");
        assert_eq!(expand("movingAverage(x, $n)", &r).unwrap(), "movingAverage(x, 3)");
        assert_eq!(expand("seriesByTag('name=cpu')", &r).unwrap(), "seriesByTag('name=cpu')");
        assert_eq!(reason("servers.$x.cpu", json!({ "x": "a),sumSeries(b" })), "graphite.variable_characters");
        assert_eq!(reason("servers.$x.cpu", json!({ "x": "*" })), "graphite.variable_characters");
        assert_eq!(reason("servers.$x.cpu", json!({ "x": [] })), "graphite.variable_characters");
        assert_eq!(reason("servers.$fehlt", json!({})), "graphite.variable_missing");
        assert_eq!(reason("x.$__nope", json!({})), "graphite.macro_unknown");
        assert_eq!(reason("alias(x, \"offen)", json!({})), "graphite.unclosed_quote");
        assert_eq!(reason("x.$o", json!({ "o": { "a": 1 } })), "graphite.variable_type");
        // A checked dashboard variable may hold a wildcard.
        let mut checked = req(json!({ "x": "web-*" }));
        checked.identifier_variables = Some(["x".to_string()].into());
        assert_eq!(expand("servers.$x.cpu", &checked).unwrap(), "servers.web-*.cpu");
        // `$` that starts no name stays as written.
        assert_eq!(expand("x.$1", &r).unwrap(), "x.$1");
    }

    #[test]
    fn series_become_one_wide_frame_with_tags_as_labels() {
        let series: Vec<RenderSeries> = serde_json::from_value(json!([
            { "target": "a.cpu", "tags": { "name": "a.cpu", "dc": "graz" }, "datapoints": [[1.5, 60], [null, 120]] },
            { "target": "b.cpu", "datapoints": [[2.0, 120], [3.0, null]] }
        ]))
        .unwrap();
        let frame = to_frame(series, &req(json!({}))).finish();
        let f = frame.fields();
        assert_eq!(f[0].values, [json!(60_000), json!(120_000)]);
        assert_eq!(f[1].values, [json!(1.5), Value::Null]);
        assert_eq!(f[1].labels.as_ref().unwrap()["dc"], "graz");
        assert!(!f[1].labels.as_ref().unwrap().contains_key("name"));
        assert_eq!(f[2].values, [Value::Null, json!(2.0)]);
        let empty = to_frame(Vec::new(), &req(json!({}))).finish();
        assert_eq!(serde_json::to_value(&empty).unwrap()["meta"]["notices"][0]["code"], "graphite.no_series");
    }

    #[test]
    fn error_pages_lose_their_markup() {
        let e = graphite_error(400, "<html><body><h1>Bad</h1><p>unknown function foo</p></body></html>");
        assert_eq!(e.detail().reason, "graphite.error");
        assert_eq!(e.detail().params["detail"], "Bad unknown function foo");
        assert_eq!(e.detail().params["status"], "400");
    }

    /// A fake graphite-web: find, version, index, tags and render; it records the requests.
    #[expect(clippy::disallowed_methods, reason = "a fake Graphite, not an API route")]
    async fn fake() -> (String, Arc<std::sync::Mutex<Vec<String>>>) {
        use axum::extract::RawQuery;
        use axum::routing::get;
        let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
        let log = seen.clone();
        let app = axum::Router::new()
            .route("/graphite/metrics/find", get(|| async { axum::Json(json!([{ "id": "app", "leaf": 0 }])) }))
            .route("/graphite/version", get(|| async { "1.1.10" }))
            .route("/graphite/metrics/index.json", get(|| async { axum::Json(json!(["app.requests", "app.errors"])) }))
            .route("/graphite/tags", get(|| async { axum::Json(json!([{ "tag": "dc" }, { "tag": "name" }])) }))
            .route(
                "/graphite/render",
                get(move |RawQuery(q): RawQuery| {
                    let log = log.clone();
                    async move {
                        log.lock().unwrap().push(q.unwrap_or_default());
                        axum::Json(json!([{ "target": "app.requests", "datapoints": [[5.0, 1_800_000_060]] }]))
                    }
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/graphite", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (url, seen)
    }

    #[tokio::test]
    async fn renders_reads_the_schema_and_answers_health() {
        let (url, seen) = fake().await;
        let policy = super::super::targets::TargetPolicy::new(
            &std::env::temp_dir().join("kalzit-none"),
            "sqlite::memory:",
            &[],
            &[],
        );
        let conn = super::super::json_documents::test_connection(json!({ "url": url }), &[], policy).await;
        let h = Graphite.health(&conn).await;
        assert!(h.ok, "{:?}", h.detail);
        assert_eq!(h.detail.params["version"], "1.1.10");
        let SourceSchema::Metrics { metrics, labels } = Graphite.schema(&conn).await.unwrap() else {
            panic!("metrics")
        };
        assert_eq!(metrics, ["app.requests", "app.errors"]);
        assert_eq!(labels, ["dc"]);
        let mut r = req(json!({ "m": "requests" }));
        r.query = json!({ "target": "app.$m" });
        let QueryResult::Frame { frame } = Graphite.query(&conn, r).await.unwrap() else { panic!("frame") };
        assert_eq!(frame.fields()[1].values, [json!(5.0)]);
        let q = seen.lock().unwrap()[0].clone();
        assert!(q.contains("target=app.requests") && q.contains("format=json"), "{q}");
        assert!(q.contains("from=1800000000") && q.contains("until=1800003600"), "{q}");
    }
}
