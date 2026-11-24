//! Prometheus and compatible APIs (Mimir, Thanos, VictoriaMetrics) over HTTP, through the one
//! client factory (`crate::http`), which checks every connection and redirect target.
//!
//! PromQL has no bind parameters. Variables are therefore accepted only inside quoted strings
//! (label values), escaped for that string; a variable anywhere else is refused. Macros expand to
//! numbers and durations Kalzit computes itself.
//!
//! Besides `{"expr": ...}` a query may be a helper (`{"helper": "labelValues", ...}`) for
//! variables: label values, label names, metric names or the lines of a query's result, each as
//! a one-column table, read from the read-only label and query endpoints of the API.

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
/// Prometheus refuses range queries with more than 11,000 points per series.
pub(crate) const MAX_POINTS_PER_SERIES: i64 = 11_000;
const MAX_SCHEMA_NAMES: usize = 10_000;
/// Schema and health answers are small; this keeps a misbehaving server from filling memory.
const MAX_SMALL_RESPONSE: usize = 16 * 1024 * 1024;

pub fn kind() -> Kind {
    Kind {
        name: "Prometheus",
        hint_key: "datasources.kinds.prometheus.hint",
        settings: SETTINGS,
        plugin: Arc::new(Prometheus),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Settings {
    url: String,
    basic_auth_user: Option<String>,
    ca_cert: Option<String>,
}

/// `{"expr": "...", "instant": false, "minStepMs": 15000}`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PromQuery {
    expr: String,
    #[serde(default)]
    instant: bool,
    min_step_ms: Option<u64>,
}

pub struct Prometheus;

struct Client {
    http: HttpClient,
    base: Url,
    auth: Option<HeaderValue>,
    /// The secrets and the base64 of `user:password`, to scrub from errors.
    scrubber: Scrubber,
}

pub(crate) fn parse_url(raw: &str) -> Result<Url, Detail> {
    let url = Url::parse(raw.trim())
        .map_err(|e| Detail::new("settings.url_invalid", format!("the URL is not valid: {e}")).with("detail", e))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(Detail::new("settings.url_scheme", "the URL must start with http:// or https://"));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(Detail::new(
            "settings.url_credentials",
            "the URL must not contain credentials; use the basic auth fields",
        ));
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err(Detail::new(
            "settings.url_query",
            "the URL must not contain a query or fragment; tokens go in the bearer token field",
        ));
    }
    if url.host_str().is_none() {
        return Err(Detail::new("settings.url_no_host", "the URL needs a host"));
    }
    Ok(url)
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
        .map(|a| a.header("prometheus.credentials_invalid", &mut scrubber))
        .transpose()?;
        Ok(Client { http, base, auth, scrubber })
    })
    .await
}

impl Client {
    fn scrub(&self, text: &str) -> String {
        self.scrubber.scrub(text)
    }

    fn failed(&self, e: HttpError) -> SourceError {
        http_source::failed(e, &self.scrubber)
    }

    /// GETs an API path and answers its `data`, or the server's error message. With a charge,
    /// the body is charged to the request's budget as it arrives (and stays charged while the
    /// charge lives), so concurrent queries cannot each hold a whole budget's worth unaccounted.
    async fn api(
        &self,
        path: &str,
        params: &[(&str, String)],
        max_bytes: usize,
        charge: Option<&mut Charge>,
    ) -> Result<(Value, Vec<String>), SourceError> {
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
        let parsed: Value = serde_json::from_slice(&body).map_err(|_| {
            SourceError::failed(
                "prometheus.not_an_api_response",
                format!("the server answered {status} without a Prometheus API response"),
            )
            .with("status", status.as_u16())
        })?;
        if parsed["status"] != "success" {
            let message = parsed["error"].as_str().unwrap_or("unknown error");
            let message = self.scrub(message);
            return Err(SourceError::failed("prometheus.error", format!("Prometheus answered {status}: {message}"))
                .with("status", status.as_u16())
                .with("detail", message));
        }
        let warnings = parsed["warnings"]
            .as_array()
            .map(|w| w.iter().filter_map(|v| v.as_str().map(String::from)).collect())
            .unwrap_or_default();
        Ok((parsed["data"].clone(), warnings))
    }
}

#[async_trait::async_trait]
impl DataSourcePlugin for Prometheus {
    fn kind(&self) -> &'static str {
        "prometheus"
    }

    fn shapes(&self) -> &'static [Shape] {
        &[Shape::Frame]
    }

    fn adhoc_filters(&self) -> bool {
        true
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
            c.api("api/v1/query", &[("query", "1+1".into())], MAX_SMALL_RESPONSE, None).await?;
            Ok::<_, SourceError>(())
        };
        match check.await {
            Ok(()) => Health {
                ok: true,
                code: None,
                warnings: Vec::new(),
                detail: Detail::new("health.prometheus_answered", "the Prometheus API answered")
                    .with("engine", "Prometheus"),
            },
            Err(e) => Health::failed(&e),
        }
    }

    async fn schema(&self, conn: &Connection) -> Result<SourceSchema, SourceError> {
        let c = client(conn).await?;
        let names = |data: Value| -> Vec<String> {
            data.as_array()
                .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).take(MAX_SCHEMA_NAMES).collect())
                .unwrap_or_default()
        };
        let (metrics, _) = c.api("api/v1/label/__name__/values", &[], MAX_SMALL_RESPONSE, None).await?;
        let (labels, _) = c.api("api/v1/labels", &[], MAX_SMALL_RESPONSE, None).await?;
        Ok(SourceSchema::Metrics { metrics: names(metrics), labels: names(labels) })
    }

    async fn query(&self, conn: &Connection, req: SourceQuery) -> Result<QueryResult, SourceError> {
        if req.query.get("helper").is_some() {
            return helper_query(conn, req).await;
        }
        let q: PromQuery = req.parse()?;
        // `$__interval` and `$__rate_interval` follow the step Prometheus is asked for, so a
        // window like `[$__interval]` covers exactly one point.
        let step_ms = step_ms(&q, &req);
        let mut req = req;
        req.interval_ms = step_ms as u64;
        let expr = inject_filters(&expand(&q.expr, &req)?, &req.filters, true)?;
        let c = client(conn).await?;
        let max_bytes = req.limits.budget.remaining();
        let mut charge = req.limits.budget.charge();
        let (data, warnings) = if q.instant {
            let time = seconds(req.range.to);
            c.api("api/v1/query", &[("query", expr.clone()), ("time", time)], max_bytes, Some(&mut charge)).await?
        } else {
            let params = [
                ("query", expr.clone()),
                ("start", seconds(aligned_start(req.range.from, req.range.to, step_ms))),
                ("end", seconds(req.range.to)),
                ("step", seconds(step_ms)),
            ];
            c.api("api/v1/query_range", &params, max_bytes, Some(&mut charge)).await?
        };
        let mut frame = to_frame(&data, &req)?;
        frame.executed_query(expr);
        for w in warnings {
            let w = c.scrub(&w);
            frame.notice(NoticeSeverity::Info, Detail::new("prometheus.warning", w.clone()).with("detail", w));
        }
        let frame = frame.finish();
        // The raw answer is gone now; only the frame's own charge remains.
        drop(data);
        drop(charge);
        Ok(QueryResult::Frame { frame })
    }
}

/// A helper query for variables (docs/api/datasources.md, "Prometheus helpers"), in the words
/// other tools write it: `label_values(up{env="prod"}, job)`, `label_names()`, `metrics(up.*)`,
/// `query_result(topk(5, up))`.
#[derive(Debug, Deserialize, PartialEq)]
#[serde(tag = "helper", rename_all = "camelCase", deny_unknown_fields)]
enum Helper {
    /// The values of `label`, optionally only on series of `metric` matching `filter`.
    #[serde(rename_all = "camelCase")]
    LabelValues { label: String, metric: Option<String>, filter: Option<String> },
    /// The label names, optionally only on series of `metric` matching `filter`.
    #[serde(rename_all = "camelCase")]
    LabelNames { metric: Option<String>, filter: Option<String> },
    /// The metric names, optionally only those matching `regex` (anchored, as PromQL does).
    Metrics { regex: Option<String> },
    /// One line per series and sample of an instant query: `name{labels} value timestamp`.
    QueryResult { expr: String },
}

/// What the helper asks for, ready to send: the API path, its parameters and the query as shown.
#[derive(Debug, PartialEq)]
struct HelperRequest {
    path: String,
    params: Vec<(&'static str, String)>,
    /// The helper in the words of `Helper`, with variables filled in.
    shown: String,
    /// The answer's one column.
    column: &'static str,
    /// An instant query whose result becomes lines (`query_result`).
    lines: bool,
}

fn is_label_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn is_metric_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_' || c == ':')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == ':')
}

/// The series selector `metric{filter}` with variables filled in and the ad hoc filters added;
/// empty when there is neither a metric, a filter nor an ad hoc filter. The filter is a list of
/// label matchers and must stay one: braces outside its strings are refused.
fn helper_selector(metric: Option<&str>, filter: Option<&str>, req: &SourceQuery) -> Result<String, SourceError> {
    let metric = metric.map(str::trim).filter(|m| !m.is_empty());
    let filter = filter.map(str::trim).filter(|f| !f.is_empty());
    if let Some(m) = metric
        && !is_metric_name(m)
    {
        return Err(
            SourceError::rejected("prometheus.helper_metric", format!("{m:?} is no metric name")).with("name", m)
        );
    }
    if let Some(f) = filter {
        let mut quote: Option<char> = None;
        let mut escaped = false;
        for c in f.chars() {
            match quote {
                Some(_) if escaped => escaped = false,
                Some(q) if c == '\\' && q != '`' => escaped = true,
                Some(q) if c == q => quote = None,
                Some(_) => {}
                None if matches!(c, '"' | '\'' | '`') => quote = Some(c),
                None if matches!(c, '{' | '}' | '(' | ')' | '[' | ']' | '#') => {
                    return Err(SourceError::rejected(
                        "prometheus.helper_filter",
                        "the label filter is a list of matchers such as env=\"prod\", without braces",
                    ));
                }
                None => {}
            }
        }
        if quote.is_some() {
            return Err(SourceError::rejected("promql.unclosed_quote", "unclosed quote in the query"));
        }
    }
    if metric.is_none() && filter.is_none() && req.filters.is_empty() {
        return Ok(String::new());
    }
    let raw = match (metric, filter) {
        (Some(m), None) => m.to_string(),
        (m, f) => format!("{}{{{}}}", m.unwrap_or(""), f.unwrap_or("")),
    };
    inject_filters(&expand(&raw, req)?, &req.filters, true)
}

/// The API call a helper makes. Label endpoints look at the dashboard's range.
fn helper_request(helper: &Helper, req: &SourceQuery) -> Result<HelperRequest, SourceError> {
    let range = [("start", seconds(req.range.from)), ("end", seconds(req.range.to))];
    let with_match = |selector: &str| {
        let mut params: Vec<(&'static str, String)> = range.to_vec();
        if !selector.is_empty() {
            params.push(("match[]", selector.to_string()));
        }
        params
    };
    match helper {
        Helper::LabelValues { label, metric, filter } => {
            let label = label.trim();
            if !is_label_name(label) {
                return Err(SourceError::rejected("prometheus.helper_label", format!("{label:?} is no label name"))
                    .with("name", label));
            }
            let selector = helper_selector(metric.as_deref(), filter.as_deref(), req)?;
            let shown = if selector.is_empty() {
                format!("label_values({label})")
            } else {
                format!("label_values({selector}, {label})")
            };
            Ok(HelperRequest {
                path: format!("api/v1/label/{label}/values"),
                params: with_match(&selector),
                shown,
                column: "value",
                lines: false,
            })
        }
        Helper::LabelNames { metric, filter } => {
            let selector = helper_selector(metric.as_deref(), filter.as_deref(), req)?;
            Ok(HelperRequest {
                path: "api/v1/labels".into(),
                params: with_match(&selector),
                shown: format!("label_names({selector})"),
                column: "label",
                lines: false,
            })
        }
        Helper::Metrics { regex } => {
            let regex = regex.as_deref().map(str::trim).filter(|r| !r.is_empty());
            let selector = match regex {
                // Escaped into the string first; `expand` then fills in variables, literally.
                Some(r) => {
                    let raw = format!("{{__name__=~\"{}\"}}", escape_for('"', "regex", r)?);
                    inject_filters(&expand(&raw, req)?, &req.filters, true)?
                }
                None if !req.filters.is_empty() => inject_filters("{}", &req.filters, true)?,
                None => String::new(),
            };
            Ok(HelperRequest {
                path: "api/v1/label/__name__/values".into(),
                params: with_match(&selector),
                shown: format!("metrics({})", regex.unwrap_or("")),
                column: "metric",
                lines: false,
            })
        }
        Helper::QueryResult { expr } => {
            let expr = inject_filters(&expand(expr, req)?, &req.filters, true)?;
            Ok(HelperRequest {
                path: "api/v1/query".into(),
                params: vec![("query", expr.clone()), ("time", seconds(req.range.to))],
                shown: format!("query_result({expr})"),
                column: "result",
                lines: true,
            })
        }
    }
}

/// The lines of an instant query's result, as `query_result` shows them.
fn result_lines(data: &Value) -> Vec<String> {
    let point = |p: &Value| {
        let value = p[1].as_str().unwrap_or_default();
        let time = sample_time(&p[0]).map(|t| t.to_string()).unwrap_or_default();
        format!("{value} {time}")
    };
    let labels = |series: &Value| -> BTreeMap<String, String> {
        series["metric"]
            .as_object()
            .map(|m| m.iter().filter_map(|(k, v)| v.as_str().map(|v| (k.clone(), v.to_string()))).collect())
            .unwrap_or_default()
    };
    let empty = Vec::new();
    match data["resultType"].as_str() {
        Some("vector") => data["result"]
            .as_array()
            .unwrap_or(&empty)
            .iter()
            .map(|s| format!("{} {}", series_name(&labels(s)), point(&s["value"])))
            .collect(),
        Some("matrix") => data["result"]
            .as_array()
            .unwrap_or(&empty)
            .iter()
            .flat_map(|s| {
                let name = series_name(&labels(s));
                s["values"]
                    .as_array()
                    .unwrap_or(&empty)
                    .iter()
                    .map(move |p| format!("{name} {}", point(p)))
                    .collect::<Vec<_>>()
            })
            .collect(),
        Some("scalar" | "string") => vec![point(&data["result"])],
        _ => Vec::new(),
    }
}

/// Runs a helper and answers its one-column table, the request as sent in `executedQuery`.
async fn helper_query(conn: &Connection, req: SourceQuery) -> Result<QueryResult, SourceError> {
    let helper: Helper = req.parse()?;
    let call = helper_request(&helper, &req)?;
    let c = client(conn).await?;
    let max_bytes = req.limits.budget.remaining();
    let mut charge = req.limits.budget.charge();
    let (data, warnings) = c.api(&call.path, &call.params, max_bytes, Some(&mut charge)).await?;
    let values: Vec<String> = if call.lines {
        result_lines(&data)
    } else {
        data.as_array().map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect()).unwrap_or_default()
    };
    drop(data);
    let mut frame = FrameBuilder::new(
        vec![Column::new(call.column, Some(FieldType::String))],
        req.limits.max_rows,
        req.limits.budget.clone(),
    );
    frame.executed_query(call.shown);
    for value in values {
        if !frame.push_row(vec![Value::String(value)]) {
            break;
        }
    }
    for w in warnings {
        let w = c.scrub(&w);
        frame.notice(NoticeSeverity::Info, Detail::new("prometheus.warning", w.clone()).with("detail", w));
    }
    let frame = frame.finish();
    drop(charge);
    Ok(QueryResult::Frame { frame })
}

/// The step of a range query in milliseconds: the panel's interval, at least the query's minimum
/// step, and wide enough that no series exceeds Prometheus' point limit. An instant query has no
/// step; its interval is the panel's, at least the minimum step.
fn step_ms(q: &PromQuery, req: &SourceQuery) -> i64 {
    let step = (req.interval_ms as i64).max(q.min_step_ms.unwrap_or(0) as i64);
    if q.instant {
        return step.max(1);
    }
    let span = req.range.to.saturating_sub(req.range.from).max(0);
    step.max(span / MAX_POINTS_PER_SERIES + 1).max(1)
}

/// The start of a range query on a multiple of the step, so the points fall on the same times
/// from one refresh to the next instead of moving with the clock. One step later when aligning
/// would ask for more points than Prometheus answers.
pub(crate) fn aligned_start(from: i64, to: i64, step: i64) -> i64 {
    let step = step.max(1);
    let start = from.div_euclid(step) * step;
    if (to - start) / step > MAX_POINTS_PER_SERIES { start + step } else { start }
}

/// Unix seconds with millisecond precision, as Prometheus takes them.
pub(crate) fn seconds(ms: i64) -> String {
    let sign = if ms < 0 { "-" } else { "" };
    format!("{sign}{}.{:03}", ms.unsigned_abs() / 1000, ms.unsigned_abs() % 1000)
}

/// A PromQL duration (`30s`, `250ms`, `5m`).
fn duration(ms: i64) -> String {
    super::sql::format_interval(ms.max(1))
}

fn variable_text(name: &str, value: &Value, in_list: bool) -> Result<String, SourceError> {
    match value {
        Value::String(s) if in_list => Ok(regex_escape(s)),
        Value::String(s) => Ok(s.clone()),
        Value::Number(n) => Ok(n.to_string()),
        Value::Bool(b) => Ok(b.to_string()),
        Value::Array(items) => {
            let parts: Vec<String> = items.iter().map(|v| variable_text(name, v, true)).collect::<Result<_, _>>()?;
            Ok(parts.join("|"))
        }
        _ => Err(SourceError::rejected(
            "promql.variable_type",
            format!("variable {name} must be a string, number, boolean or a list of them"),
        )
        .with("name", name)),
    }
}

/// Values of a multi-value variable are matched literally within `=~"a|b"`.
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

/// Escapes text for a PromQL string in `quote`. Raw strings (backticks) have no escapes, so a
/// value containing a backtick cannot be placed in one.
fn escape_for(quote: char, name: &str, text: &str) -> Result<String, SourceError> {
    if quote == '`' {
        return if text.contains('`') {
            Err(SourceError::rejected(
                "promql.backtick",
                format!("variable {name} contains a backtick and cannot go into a `raw` string"),
            )
            .with("name", name))
        } else {
            Ok(text.to_string())
        };
    }
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c == quote => {
                out.push('\\');
                out.push(c);
            }
            c => out.push(c),
        }
    }
    Ok(out)
}

/// Reads `$name`, `${name}` or `$__macro` at `i` (which is a `$`): the name and the end index.
fn read_name(expr: &str, i: usize) -> Option<(&str, usize)> {
    let rest = &expr[i + 1..];
    if let Some(inner) = rest.strip_prefix('{') {
        let close = inner.find('}')?;
        return Some((&inner[..close], i + 2 + close + 1));
    }
    let len = rest.find(|c: char| !(c.is_ascii_alphanumeric() || c == '_')).unwrap_or(rest.len());
    (len > 0 && !rest.starts_with(|c: char| c.is_ascii_digit())).then(|| (&rest[..len], i + 1 + len))
}

/// Expands macros everywhere and variables inside quoted strings.
pub(crate) fn expand(expr: &str, req: &SourceQuery) -> Result<String, SourceError> {
    let interval = req.interval_ms as i64;
    let mut out = String::with_capacity(expr.len());
    let mut quote: Option<char> = None;
    // Whether the open string is the value of a regex matcher (`=~` or `!~`).
    let mut in_regex = false;
    let mut i = 0;
    while i < expr.len() {
        let c = expr[i..].chars().next().expect("i is on a char boundary");
        match quote {
            Some(q) if c == '\\' && q != '`' => {
                let next = expr[i + 1..].chars().next().map_or(0, char::len_utf8);
                out.push_str(&expr[i..i + 1 + next]);
                i += 1 + next;
                continue;
            }
            Some(q) if c == q => quote = None,
            None if matches!(c, '"' | '\'' | '`') => {
                quote = Some(c);
                let before = out.trim_end();
                in_regex = before.ends_with("=~") || before.ends_with("!~") || before.ends_with("|~");
            }
            None if c == '#' => {
                // A comment runs to the end of the line; nothing in it is expanded.
                let end = expr[i..].find('\n').map_or(expr.len(), |p| i + p);
                out.push_str(&expr[i..end]);
                i = end;
                continue;
            }
            _ => {}
        }
        if c != '$' {
            out.push(c);
            i += c.len_utf8();
            continue;
        }
        let Some((name, end)) = read_name(expr, i) else {
            out.push(c);
            i += 1;
            continue;
        };
        let expansion = match name {
            "__interval" => duration(interval),
            "__interval_ms" => interval.to_string(),
            // Four intervals and at least a minute, so rate() always sees two scrapes.
            "__rate_interval" => duration(interval.saturating_mul(4).max(60_000)),
            "__range" => duration(req.range.to.saturating_sub(req.range.from).max(1)),
            "__timeFrom" => seconds(req.range.from),
            "__timeTo" => seconds(req.range.to),
            m if m.starts_with("__") => {
                return Err(
                    SourceError::rejected("promql.macro_unknown", format!("unknown macro ${m}")).with("name", m)
                );
            }
            name => {
                let Some(q) = quote else {
                    return Err(SourceError::rejected(
                        "promql.variable_outside_string",
                        format!("variable {name} must be inside a quoted label value, such as job=\"${name}\""),
                    )
                    .with("name", name));
                };
                let value = req.variables.get(name).ok_or_else(|| {
                    SourceError::rejected("promql.variable_missing", format!("variable {name} has no value"))
                        .with("name", name)
                })?;
                // In a regex matcher a free value is matched literally, as list entries are; the
                // values of checked (constant and custom) dashboard variables may be patterns.
                let checked = req.identifier_variables.as_ref().is_some_and(|c| c.contains(name));
                escape_for(q, name, &variable_text(name, value, in_regex && !checked)?)?
            }
        };
        out.push_str(&expansion);
        i = end;
    }
    if quote.is_some() {
        return Err(SourceError::rejected("promql.unclosed_quote", "unclosed quote in the query"));
    }
    Ok(out)
}

/// Words of PromQL that are no metric names: binary and set operators, modifiers and literals.
const KEYWORDS: &[&str] = &["and", "or", "unless", "atan2", "bool", "offset", "inf", "nan"];
/// Keywords followed by a list of label names in parentheses.
const GROUPING: &[&str] = &["by", "without", "on", "ignoring", "group_left", "group_right"];

/// Ad hoc filters as label matchers (`key="value"`): a key must be a label name, the value goes
/// escaped into a double-quoted string, and `<` and `>` have no PromQL or LogQL matcher.
fn filter_matchers(filters: &[crate::shapes::AdhocFilter], language: &str) -> Result<String, SourceError> {
    use crate::shapes::FilterOperator;
    let mut parts = Vec::with_capacity(filters.len());
    for f in filters {
        let mut key = f.key.chars();
        let label = key.next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
            && key.all(|c| c.is_ascii_alphanumeric() || c == '_');
        if !label {
            return Err(SourceError::rejected(
                "query.filter_key",
                format!("{:?} is not a label name; {language} labels are letters, digits and _", f.key),
            )
            .with("key", &f.key));
        }
        let op = match f.operator {
            FilterOperator::Equal => "=",
            FilterOperator::NotEqual => "!=",
            FilterOperator::Matches => "=~",
            FilterOperator::NotMatches => "!~",
            FilterOperator::Less | FilterOperator::Greater => {
                return Err(SourceError::rejected(
                    "query.filter_operator",
                    format!("{language} labels have no {} comparison; use =, !=, =~ or !~", f.operator.as_str()),
                )
                .with("operator", f.operator.as_str()));
            }
        };
        parts.push(format!("{}{op}\"{}\"", f.key, escape_for('"', &f.key, &f.value)?));
    }
    Ok(parts.join(","))
}

/// The index after the string starting at `start` (a quote); raw strings have no escapes.
fn skip_quoted(expr: &str, start: usize) -> Result<usize, SourceError> {
    let bytes = expr.as_bytes();
    let quote = bytes[start];
    let mut i = start + 1;
    while i < bytes.len() {
        match bytes[i] {
            b'\\' if quote != b'`' => i += 2,
            b if b == quote => return Ok(i + 1),
            _ => i += 1,
        }
    }
    Err(SourceError::rejected("promql.unclosed_quote", "unclosed quote in the query"))
}

/// The index of the bracket closing the one at `start` (`{`, `[` or `(`), strings skipped.
fn closing(expr: &str, start: usize) -> Result<usize, SourceError> {
    let bytes = expr.as_bytes();
    let (open, close) = match bytes[start] {
        b'{' => (b'{', b'}'),
        b'[' => (b'[', b']'),
        _ => (b'(', b')'),
    };
    let mut depth = 0usize;
    let mut i = start;
    while i < bytes.len() {
        match bytes[i] {
            b'"' | b'\'' | b'`' => {
                i = skip_quoted(expr, i)?;
                continue;
            }
            // A comment runs to the end of the line; a bracket in it is no bracket.
            b'#' => {
                i = expr[i..].find('\n').map_or(expr.len(), |p| i + p);
                continue;
            }
            b if b == open => depth += 1,
            b if b == close => {
                depth -= 1;
                if depth == 0 {
                    return Ok(i);
                }
            }
            _ => {}
        }
        i += 1;
    }
    Err(SourceError::rejected("query.unbalanced", "unbalanced brackets in the query"))
}

/// Whether `text` starts with one of `words` (case-insensitive) as a whole word.
fn starts_with_word(text: &str, words: &[&str]) -> bool {
    let end = text.find(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == ':')).unwrap_or(text.len());
    words.iter().any(|w| text[..end].eq_ignore_ascii_case(w))
}

/// `{...}` at `open` with `matchers` added before its closing brace.
fn with_matchers(out: &mut String, expr: &str, open: usize, matchers: &str) -> Result<usize, SourceError> {
    let close = closing(expr, open)?;
    let inner = expr[open + 1..close].trim_end();
    // Matchers added after a comment inside the braces would land in the comment.
    let mut i = 0;
    while i < inner.len() {
        match inner.as_bytes()[i] {
            b'"' | b'\'' | b'`' => i = skip_quoted(inner, i)?,
            b'#' => {
                return Err(SourceError::rejected(
                    "query.filter_comment",
                    "a selector with a comment inside its braces cannot take ad hoc filters",
                ));
            }
            _ => i += 1,
        }
    }
    out.push('{');
    out.push_str(inner);
    if !inner.trim().is_empty() && !inner.ends_with(',') {
        out.push(',');
    }
    out.push_str(matchers);
    out.push('}');
    Ok(close + 1)
}

/// Builds ad hoc filters into every selector of an expanded query, as label matchers.
///
/// PromQL (`metric_names`): every vector selector, a metric name with or without braces and a
/// bare `{...}`; function and aggregation names, keywords, label lists after `by`, `on` and the
/// like, durations and numbers are left alone. LogQL: every stream selector `{...}`. Strings and
/// comments are skipped, so a filter value never lands in them unescaped and text in a string is
/// never taken for a selector.
pub(crate) fn inject_filters(
    expr: &str,
    filters: &[crate::shapes::AdhocFilter],
    metric_names: bool,
) -> Result<String, SourceError> {
    if filters.is_empty() {
        return Ok(expr.to_string());
    }
    let language = if metric_names { "PromQL" } else { "LogQL" };
    let matchers = filter_matchers(filters, language)?;
    let bytes = expr.as_bytes();
    let mut out = String::with_capacity(expr.len() + matchers.len() * 2);
    let mut found = false;
    let mut i = 0;
    let next_char =
        |from: usize| expr[from..].char_indices().find(|(_, c)| !c.is_whitespace()).map(|(p, c)| (from + p, c));
    while i < bytes.len() {
        let c = expr[i..].chars().next().expect("i is on a char boundary");
        match c {
            '"' | '\'' | '`' => {
                let end = skip_quoted(expr, i)?;
                out.push_str(&expr[i..end]);
                i = end;
            }
            '#' => {
                let end = expr[i..].find('\n').map_or(expr.len(), |p| i + p);
                out.push_str(&expr[i..end]);
                i = end;
            }
            '{' => {
                i = with_matchers(&mut out, expr, i, &matchers)?;
                found = true;
            }
            '[' if metric_names => {
                let end = closing(expr, i)? + 1;
                out.push_str(&expr[i..end]);
                i = end;
            }
            c if metric_names && c.is_ascii_digit() => {
                // A number or a duration (`5m`, `1e3`, `0x1f`): never a name.
                let end = expr[i..]
                    .find(|ch: char| !(ch.is_ascii_alphanumeric() || ch == '.' || ch == '_'))
                    .map_or(expr.len(), |p| i + p);
                out.push_str(&expr[i..end]);
                i = end;
            }
            c if metric_names && (c.is_ascii_alphabetic() || c == '_' || c == ':') => {
                let end = expr[i..]
                    .find(|ch: char| !(ch.is_ascii_alphanumeric() || ch == '_' || ch == ':'))
                    .map_or(expr.len(), |p| i + p);
                let word = &expr[i..end];
                out.push_str(word);
                let lower = word.to_ascii_lowercase();
                let next = next_char(end);
                if GROUPING.contains(&lower.as_str()) {
                    // `by (job, instance)`: label names, no selectors.
                    if let Some((p, '(')) = next {
                        let close = closing(expr, p)? + 1;
                        out.push_str(&expr[end..close]);
                        i = close;
                    } else {
                        i = end;
                    }
                } else if KEYWORDS.contains(&lower.as_str())
                    || matches!(next, Some((_, '(')))
                    || next.is_some_and(|(p, _)| starts_with_word(&expr[p..], &["by", "without"]))
                {
                    // Functions, keywords, and aggregations written `sum by (job) (...)`.
                    i = end;
                } else if let Some((p, '{')) = next {
                    out.push_str(&expr[end..p]);
                    i = with_matchers(&mut out, expr, p, &matchers)?;
                    found = true;
                } else {
                    out.push('{');
                    out.push_str(&matchers);
                    out.push('}');
                    i = end;
                    found = true;
                }
            }
            c => {
                out.push(c);
                i += c.len_utf8();
            }
        }
    }
    if !found {
        return Err(SourceError::rejected(
            "query.filter_no_selector",
            format!("the {language} query has no selector the filters could narrow"),
        ));
    }
    Ok(out)
}

/// `expand` with just variables and the checked ones, for tests elsewhere (how a dashboard's
/// resolved values reach PromQL).
#[cfg(test)]
pub(crate) fn expand_for_test(
    expr: &str,
    variables: &BTreeMap<String, Value>,
    checked: &BTreeSet<String>,
) -> Result<String, SourceError> {
    let req = SourceQuery {
        ref_id: "A".into(),
        query: json!({}),
        range: crate::shapes::TimeRange { from: 0, to: 60_000 },
        interval_ms: 15_000,
        max_data_points: None,
        variables: variables.clone(),
        identifier_variables: Some(checked.clone()),
        limits: super::Limits {
            timeout: Duration::from_secs(5),
            max_rows: 1000,
            budget: super::frame::ResponseBudget::new(1 << 20),
        },
        cursor: None,
        filters: Vec::new(),
    };
    expand(expr, &req)
}

/// A sample value as a JSON number; NaN and infinities have no JSON form.
fn sample(v: &Value) -> Value {
    v.as_str()
        .and_then(|s| s.parse::<f64>().ok())
        .and_then(serde_json::Number::from_f64)
        .map_or(Value::Null, Value::Number)
}

fn sample_time(v: &Value) -> Option<i64> {
    v.as_f64().map(|s| (s * 1000.0).round() as i64)
}

fn series_name(labels: &BTreeMap<String, String>) -> String {
    let metric = labels.get("__name__").cloned().unwrap_or_default();
    let rest: Vec<String> =
        labels.iter().filter(|(k, _)| *k != "__name__").map(|(k, v)| format!("{k}={}", json!(v))).collect();
    if rest.is_empty() && !metric.is_empty() { metric } else { format!("{metric}{{{}}}", rest.join(", ")) }
}

/// A matrix or vector as one wide frame: a time field and one value field per series, carrying
/// the series' labels. A range query's series share the step grid, so rows line up.
pub(crate) fn to_frame(data: &Value, req: &SourceQuery) -> Result<FrameBuilder, SourceError> {
    let kind = data["resultType"].as_str().unwrap_or("");
    let budget = req.limits.budget.clone();
    match kind {
        "matrix" | "vector" => {
            let empty = Vec::new();
            let result = data["result"].as_array().unwrap_or(&empty);
            let mut columns = vec![Column::new("time", Some(FieldType::Time))];
            let mut samples: Vec<BTreeMap<i64, Value>> = Vec::with_capacity(result.len());
            let mut times = BTreeSet::new();
            // +Inf and -Inf have no JSON number; they are shown empty, and a notice says so.
            let mut infinite = 0usize;
            for series in result {
                let labels: BTreeMap<String, String> = series["metric"]
                    .as_object()
                    .map(|m| m.iter().filter_map(|(k, v)| v.as_str().map(|v| (k.clone(), v.to_string()))).collect())
                    .unwrap_or_default();
                let mut column = Column::new(series_name(&labels), Some(FieldType::Number));
                column.labels = Some(labels);
                columns.push(column);
                let points: Vec<&Value> = if kind == "matrix" {
                    series["values"].as_array().map(|a| a.iter().collect()).unwrap_or_default()
                } else {
                    vec![&series["value"]]
                };
                let mut map = BTreeMap::new();
                for p in points {
                    if let Some(t) = sample_time(&p[0]) {
                        times.insert(t);
                        if p[1].as_str().and_then(|s| s.parse::<f64>().ok()).is_some_and(f64::is_infinite) {
                            infinite += 1;
                        }
                        map.insert(t, sample(&p[1]));
                    }
                }
                samples.push(map);
            }
            // The limit counts points: rows times series.
            let rows = (req.limits.max_rows / samples.len().max(1)).max(1);
            let mut frame = FrameBuilder::new(columns, rows, budget);
            for t in times {
                let mut row = vec![json!(t)];
                row.extend(samples.iter().map(|s| s.get(&t).cloned().unwrap_or(Value::Null)));
                if !frame.push_row(row) {
                    break;
                }
            }
            if infinite > 0 {
                let message = format!("{infinite} infinite values (+Inf or -Inf) are shown empty");
                frame.notice(NoticeSeverity::Info, Detail::new("prometheus.infinite", message).with("count", infinite));
            }
            Ok(frame)
        }
        "scalar" | "string" => {
            let field_type = if kind == "scalar" { FieldType::Number } else { FieldType::String };
            let columns = vec![Column::new("time", Some(FieldType::Time)), Column::new("value", Some(field_type))];
            let mut frame = FrameBuilder::new(columns, 1, budget);
            let r = &data["result"];
            let value = if kind == "scalar" { sample(&r[1]) } else { r[1].clone() };
            frame.push_row(vec![sample_time(&r[0]).map_or(Value::Null, |t| json!(t)), value]);
            Ok(frame)
        }
        other => Err(SourceError::failed("prometheus.result_type", format!("unexpected result type {other:?}"))
            .with("type", other)),
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
            interval_ms: 15_000,
            max_data_points: None,
            variables: serde_json::from_value(vars).unwrap(),
            identifier_variables: None,
            limits: Limits { timeout: Duration::from_secs(5), max_rows: 1000, budget: ResponseBudget::new(1 << 20) },
            cursor: None,
            filters: Vec::new(),
        }
    }

    fn helper(query: Value, vars: Value, filters: &[crate::shapes::AdhocFilter]) -> Result<HelperRequest, String> {
        let mut r = req(vars);
        r.query = query;
        r.filters = filters.to_vec();
        let h: Helper = r.parse().map_err(|e| e.detail().reason.to_string())?;
        helper_request(&h, &r).map_err(|e| e.detail().reason.to_string())
    }

    fn param<'a>(call: &'a HelperRequest, name: &str) -> Option<&'a str> {
        call.params.iter().find(|(k, _)| *k == name).map(|(_, v)| v.as_str())
    }

    /// The four helpers ask the read-only label and query endpoints, with the selector built
    /// from metric, filter and variables, and show the query in the words of other tools.
    #[test]
    fn helpers_ask_the_label_and_query_endpoints() {
        let call = helper(
            json!({"helper": "labelValues", "label": "job", "metric": "up", "filter": "env=\"$env\""}),
            json!({"env": "prod"}),
            &[],
        )
        .unwrap();
        assert_eq!(call.path, "api/v1/label/job/values");
        assert_eq!(param(&call, "match[]"), Some("up{env=\"prod\"}"));
        assert_eq!(param(&call, "start"), Some("1800000000.000"));
        assert_eq!(param(&call, "end"), Some("1800003600.000"));
        assert_eq!(call.shown, "label_values(up{env=\"prod\"}, job)");
        assert_eq!(call.column, "value");

        let call = helper(json!({"helper": "labelValues", "label": "job"}), json!({}), &[]).unwrap();
        assert_eq!(param(&call, "match[]"), None);
        assert_eq!(call.shown, "label_values(job)");

        let call = helper(json!({"helper": "labelNames", "metric": "up"}), json!({}), &[]).unwrap();
        assert_eq!((call.path.as_str(), param(&call, "match[]")), ("api/v1/labels", Some("up")));
        assert_eq!(call.shown, "label_names(up)");
        let f = [filter("env", "=", "prod")];
        let call = helper(json!({"helper": "labelNames", "metric": "up"}), json!({}), &f).unwrap();
        assert_eq!(param(&call, "match[]"), Some("up{env=\"prod\"}"));

        let call = helper(json!({"helper": "metrics", "regex": "node_.*"}), json!({}), &[]).unwrap();
        assert_eq!(call.path, "api/v1/label/__name__/values");
        assert_eq!(param(&call, "match[]"), Some("{__name__=~\"node_.*\"}"));
        assert_eq!(call.shown, "metrics(node_.*)");
        let call = helper(json!({"helper": "metrics"}), json!({}), &[]).unwrap();
        assert_eq!(param(&call, "match[]"), None);

        let call =
            helper(json!({"helper": "queryResult", "expr": "topk(3, up{job=\"$job\"})"}), json!({"job": "api"}), &[])
                .unwrap();
        assert_eq!(call.path, "api/v1/query");
        assert_eq!(param(&call, "query"), Some("topk(3, up{job=\"api\"})"));
        assert_eq!(param(&call, "time"), Some("1800003600.000"));
        assert!(call.lines);
    }

    /// Names are checked, a filter stays a list of matchers, values stay inside their strings,
    /// and the ad hoc filters narrow every helper.
    #[test]
    fn helper_inputs_cannot_leave_their_place() {
        let reason = |q: Value, v: Value| helper(q, v, &[]).unwrap_err();
        assert_eq!(reason(json!({"helper": "labelValues", "label": "job/../x"}), json!({})), "prometheus.helper_label");
        assert_eq!(reason(json!({"helper": "labelValues", "label": "a b"}), json!({})), "prometheus.helper_label");
        assert_eq!(
            reason(json!({"helper": "labelValues", "label": "job", "metric": "up{x=\"1\"}"}), json!({})),
            "prometheus.helper_metric"
        );
        for filter in ["env=\"a\"} or vector(1) or up{", "env=\"a\"} # x", "a=\"b\")"] {
            assert_eq!(
                reason(json!({"helper": "labelNames", "filter": filter}), json!({})),
                "prometheus.helper_filter",
                "{filter}"
            );
        }
        assert_eq!(reason(json!({"helper": "labelNames", "filter": "a=\"b"}), json!({})), "promql.unclosed_quote");
        assert_eq!(
            reason(json!({"helper": "labelNames", "filter": "env=$env"}), json!({"env": "x"})),
            "promql.variable_outside_string"
        );
        assert_eq!(reason(json!({"helper": "nope"}), json!({})), "query.invalid_form");
        assert_eq!(reason(json!({"helper": "metrics", "extra": 1}), json!({})), "query.invalid_form");

        // A value with quotes and braces stays one escaped string.
        let call =
            helper(json!({"helper": "labelNames", "filter": "env=\"$env\""}), json!({"env": "a\"} or up{b=\""}), &[])
                .unwrap();
        assert_eq!(param(&call, "match[]"), Some("{env=\"a\\\"} or up{b=\\\"\"}"));
        // A regex with a quote is escaped too.
        let call = helper(json!({"helper": "metrics", "regex": "a\"b"}), json!({}), &[]).unwrap();
        assert_eq!(param(&call, "match[]"), Some("{__name__=~\"a\\\"b\"}"));

        let f = [filter("env", "=", "prod")];
        let call = helper(json!({"helper": "labelValues", "label": "job"}), json!({}), &f).unwrap();
        assert_eq!(param(&call, "match[]"), Some("{env=\"prod\"}"));
        let call = helper(json!({"helper": "metrics"}), json!({}), &f).unwrap();
        assert_eq!(param(&call, "match[]"), Some("{env=\"prod\"}"));
        let call = helper(json!({"helper": "queryResult", "expr": "up"}), json!({}), &f).unwrap();
        assert_eq!(param(&call, "query"), Some("up{env=\"prod\"}"));
    }

    #[test]
    fn query_results_become_lines() {
        let vector = json!({"resultType": "vector", "result": [
            {"metric": {"__name__": "up", "job": "api"}, "value": [1800000000.5, "1"]},
            {"metric": {}, "value": [1800000000, "NaN"]}
        ]});
        assert_eq!(result_lines(&vector), vec!["up{job=\"api\"} 1 1800000000500", "{} NaN 1800000000000"]);
        let scalar = json!({"resultType": "scalar", "result": [1800000000, "42"]});
        assert_eq!(result_lines(&scalar), vec!["42 1800000000000"]);
        let matrix = json!({"resultType": "matrix", "result": [
            {"metric": {"__name__": "up"}, "values": [[1, "1"], [2, "0"]]}
        ]});
        assert_eq!(result_lines(&matrix), vec!["up 1 1000", "up 0 2000"]);
    }

    fn filter(key: &str, operator: &str, value: &str) -> crate::shapes::AdhocFilter {
        serde_json::from_value(json!({ "key": key, "operator": operator, "value": value })).unwrap()
    }

    fn promql(expr: &str, filters: &[crate::shapes::AdhocFilter]) -> Result<String, &'static str> {
        inject_filters(expr, filters, true).map_err(|e| e.detail().reason)
    }

    /// Ad hoc filters reach every vector selector, and nothing else: not function or
    /// aggregation names, keywords, label lists, durations, numbers, strings or comments.
    #[test]
    fn filters_reach_every_selector_and_nothing_else() {
        let env = [filter("env", "=", "prod")];
        let cases = [
            ("up", r#"up{env="prod"}"#),
            ("up{}", r#"up{env="prod"}"#),
            (r#"up{job="a",}"#, r#"up{job="a",env="prod"}"#),
            (r#"{__name__="up"}"#, r#"{__name__="up",env="prod"}"#),
            (
                r#"rate(http_requests_total{code="500"} [5m])"#,
                r#"rate(http_requests_total{code="500",env="prod"} [5m])"#,
            ),
            (
                "sum by (job) (rate(a[5m:1m])) / on(instance) group_left(team) b offset 1h",
                r#"sum by (job) (rate(a{env="prod"}[5m:1m])) / on(instance) group_left(team) b{env="prod"} offset 1h"#,
            ),
            (
                "histogram_quantile(0.95, sum without (pod) (rate(lat_bucket[5m]))) > bool 1e3",
                r#"histogram_quantile(0.95, sum without (pod) (rate(lat_bucket{env="prod"}[5m]))) > bool 1e3"#,
            ),
            (
                r#"label_replace(up, "dst", "$1", "src", "(.*)") and node:cpu:rate5m @ start()"#,
                r#"label_replace(up{env="prod"}, "dst", "$1", "src", "(.*)") and node:cpu:rate5m{env="prod"} @ start()"#,
            ),
            ("up # also { here }\n", "up{env=\"prod\"} # also { here }\n"),
        ];
        for (expr, want) in cases {
            assert_eq!(promql(expr, &env).unwrap(), want, "{expr}");
        }
        // Without filters the query stays as written; without any selector they cannot apply.
        assert_eq!(promql("sum(up)", &[]).unwrap(), "sum(up)");
        assert_eq!(promql("vector(1) + time()", &env).unwrap_err(), "query.filter_no_selector");
        let several = [filter("env", "!=", "dev"), filter("job", "=~", "api|web"), filter("pod", "!~", "x.*")];
        assert_eq!(promql("up", &several).unwrap(), r#"up{env!="dev",job=~"api|web",pod!~"x.*"}"#);
    }

    /// Values go escaped into a double-quoted string, keys must be label names and `<` and `>`
    /// are refused: no value or key can end the string or the selector.
    #[test]
    fn filter_values_and_keys_cannot_leave_their_place() {
        let one = |value: &str| promql("up", &[filter("job", "=", value)]).unwrap();
        assert_eq!(one(r#"a"} or vector(1) #"#), r#"up{job="a\"} or vector(1) #"}"#);
        assert_eq!(one(r"a\"), r#"up{job="a\\"}"#);
        assert_eq!(one("a\nb\r\tc"), r#"up{job="a\nb\r\tc"}"#);
        assert_eq!(one("}{'`$x"), r#"up{job="}{'`$x"}"#);
        for key in ["job\"", "a.b", "1a", "a b", "job}", "", "a=\"b\",c"] {
            assert_eq!(promql("up", &[filter(key, "=", "x")]).unwrap_err(), "query.filter_key", "{key:?}");
        }
        for op in ["<", ">"] {
            assert_eq!(promql("up", &[filter("job", op, "1")]).unwrap_err(), "query.filter_operator");
        }
        // A comment inside braces: its brackets do not count, and matchers cannot follow it.
        let env = [filter("env", "=", "prod")];
        assert_eq!(promql("up{job=\"a\" # }\n}", &env).unwrap_err(), "query.filter_comment");
        assert_eq!(promql("sum(up # )\n)", &env).unwrap(), "sum(up{env=\"prod\"} # )\n)");
        // LogQL: every stream selector, strings and line filters untouched.
        let logql = |expr: &str, f: &[crate::shapes::AdhocFilter]| inject_filters(expr, f, false);
        let level = [filter("level", "=", "error\"}")];
        assert_eq!(
            logql(r#"sum(rate({app="api"} |= "x{y}" | json [5m]))"#, &level).unwrap(),
            r#"sum(rate({app="api",level="error\"}"} |= "x{y}" | json [5m]))"#
        );
        assert!(logql(r#"{app="a"}"#, &[filter("le vel", "=", "x")]).is_err());
        assert!(logql(r#"{app="a"}"#, &[filter("n", ">", "1")]).is_err());
    }

    #[test]
    fn range_starts_are_aligned_to_the_step() {
        // Two refreshes a few seconds apart ask for the same point times.
        assert_eq!(aligned_start(1_800_000_007_123, 1_800_003_600_000, 15_000), 1_800_000_000_000);
        assert_eq!(aligned_start(1_800_000_011_900, 1_800_003_604_000, 15_000), 1_800_000_000_000);
        assert_eq!(aligned_start(1_800_000_015_000, 1_800_003_600_000, 15_000), 1_800_000_015_000);
        assert_eq!(aligned_start(-7, 100, 10), -10);
        // Never more points than Prometheus answers: then the first aligned point is left out.
        let step = 1_000;
        let to = (MAX_POINTS_PER_SERIES + 1) * step;
        assert_eq!(aligned_start(999, to, step), 1_000);
        assert!((to - aligned_start(999, to, step)) / step <= MAX_POINTS_PER_SERIES);
    }

    #[test]
    fn macros_expand_and_variables_stay_inside_strings() {
        let r = req(json!({ "job": "api\"} or vector(1) #", "insts": ["a.b:9090", "c"] }));
        let out =
            expand(r#"rate(http_requests_total{job="$job", instance=~"${insts}"}[$__rate_interval])"#, &r).unwrap();
        assert_eq!(out, r#"rate(http_requests_total{job="api\"} or vector(1) #", instance=~"a\\.b:9090|c"}[1m])"#);
        assert_eq!(expand("sum(x) @ $__timeTo", &r).unwrap(), "sum(x) @ 1800003600.000");
        assert_eq!(expand("avg_over_time(x[$__interval])", &r).unwrap(), "avg_over_time(x[15s])");
        assert_eq!(expand("x{a='$job'}", &r).unwrap(), "x{a='api\"} or vector(1) #'}");
        assert!(matches!(expand("x > $job", &r), Err(SourceError::Rejected(_))));
        assert!(matches!(expand("x{a=\"$fehlt\"}", &r), Err(SourceError::Rejected(_))));
        assert!(matches!(expand("x[$__unbekannt]", &r), Err(SourceError::Rejected(_))));
        assert!(matches!(expand("x{a=`$job`}", &req(json!({ "job": "a`b" }))), Err(SourceError::Rejected(_))));
        assert_eq!(expand("x # $job ist ein Kommentar", &r).unwrap(), "x # $job ist ein Kommentar");
        assert!(matches!(expand("x{a=\"offen}", &r), Err(SourceError::Rejected(_))));

        // A free single value is matched literally in a regex matcher, not as a pattern.
        let r = req(json!({ "job": ".+" }));
        assert_eq!(expand(r#"up{job=~"$job"}"#, &r).unwrap(), r#"up{job=~"\\.\\+"}"#);
        assert_eq!(expand(r#"up{job!~ '$job'}"#, &r).unwrap(), r#"up{job!~ '\\.\\+'}"#);
        assert_eq!(
            expand(r#"up{job="$job"}"#, &r).unwrap(),
            r#"up{job=".+"}"#,
            "an equality matcher is literal anyway"
        );
        // A checked dashboard variable keeps its pattern.
        let mut checked = req(json!({ "job": ".+" }));
        checked.identifier_variables = Some(["job".to_string()].into());
        assert_eq!(expand(r#"up{job=~"$job"}"#, &checked).unwrap(), r#"up{job=~".+"}"#);
    }

    #[test]
    fn urls_must_not_carry_credentials() {
        assert!(parse_url("https://prom.intern:9090/prometheus").is_ok());
        assert!(parse_url("https://user:pw@prom.intern").unwrap_err().message.contains("credentials"));
        assert!(parse_url("https://prom.intern/?token=abc").is_err());
        assert!(parse_url("ftp://prom.intern").is_err());
        assert!(parse_url("prom.intern:9090").is_err());
    }

    #[test]
    fn matrices_become_wide_frames_with_labels() {
        let data = json!({
            "resultType": "matrix",
            "result": [
                { "metric": { "__name__": "up", "job": "api" }, "values": [[1800000000, "1"], [1800000015, "0"]] },
                { "metric": { "__name__": "up", "job": "db" }, "values": [[1800000015, "NaN"]] }
            ]
        });
        let frame = to_frame(&data, &req(json!({}))).unwrap().finish();
        assert_eq!(frame.rows(), 2);
        let f = frame.fields();
        assert_eq!(f[0].values, [json!(1_800_000_000_000_i64), json!(1_800_000_015_000_i64)]);
        assert_eq!(f[1].name, "up{job=\"api\"}");
        assert_eq!(f[1].labels.as_ref().unwrap()["job"], "api");
        assert_eq!(f[1].values, [json!(1.0), json!(0.0)]);
        assert_eq!(f[2].values, [Value::Null, Value::Null]);
        // NaN is "no value"; the infinities are shown empty too, and a notice says how many.
        assert!(frame.meta().is_none_or(|m| m.notices.is_empty()));
        let infinite = json!({
            "resultType": "matrix",
            "result": [{ "metric": { "__name__": "ratio" }, "values": [[1800000000, "+Inf"], [1800000015, "-Inf"], [1800000030, "2"]] }]
        });
        let frame = to_frame(&infinite, &req(json!({}))).unwrap().finish();
        assert_eq!(frame.fields()[1].values, [Value::Null, Value::Null, json!(2.0)]);
        let notices = &frame.meta().unwrap().notices;
        assert_eq!(notices.len(), 1);
        assert_eq!(notices[0].code, "prometheus.infinite");
        assert_eq!(notices[0].params.as_ref().unwrap()["count"], "2");

        let scalar = to_frame(&json!({ "resultType": "scalar", "result": [1800000000.5, "2"] }), &req(json!({})))
            .unwrap()
            .finish();
        assert_eq!(scalar.fields()[0].values, [json!(1_800_000_000_500_i64)]);
        assert_eq!(scalar.fields()[1].values, [json!(2.0)]);
        assert_eq!(seconds(-1500), "-1.500");
    }
}

/// PromQL expressions are scanned by hand for variables and macros: any text gets a result or a
/// refusal, never a panic.
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
            interval_ms: 15_000,
            max_data_points: None,
            variables: serde_json::from_value(json!({ "job": "api\"}`'", "insts": ["a.b:9090", "c"] })).unwrap(),
            identifier_variables: None,
            limits: Limits { timeout: Duration::from_secs(5), max_rows: 100, budget: ResponseBudget::new(1 << 20) },
            cursor: None,
            filters: Vec::new(),
        }
    }

    fn promql_like() -> impl Strategy<Value = String> {
        let piece = prop_oneof![
            prop::sample::select(vec![
                "rate(",
                "sum by (",
                "{",
                "}",
                "[",
                "]",
                "=~",
                "!~",
                "\"",
                "'",
                "`",
                "\\",
                "#",
                "\n",
                "$job",
                "${insts}",
                "${insts:",
                "$__rate_interval",
                "$__timeTo",
                "$",
                "@ ",
                "offset ",
            ])
            .prop_map(str::to_string),
            "[a-zA-Z_0-9 .,=:-]{0,6}",
            "\\PC{0,3}",
        ];
        prop::collection::vec(piece, 0..24).prop_map(|p| p.concat())
    }

    /// A sample value as Prometheus writes it (a string), or something else a broken server sends.
    fn sample_value() -> impl Strategy<Value = Value> {
        prop_oneof![
            prop::sample::select(vec!["1.5", "-0", "+Inf", "-Inf", "NaN", "1e308", "1e999", "x", ""])
                .prop_map(Value::from),
            any::<f64>().prop_map(|f| json!(f)),
            Just(Value::Null),
        ]
    }

    /// A time in seconds, including ones far outside any date range.
    fn sample_time_value() -> impl Strategy<Value = Value> {
        prop_oneof![
            (1_700_000_000.0f64..1_900_000_000.0).prop_map(|f| json!(f)),
            any::<f64>().prop_map(|f| json!(f)),
            any::<i64>().prop_map(Value::from),
            Just(Value::from("1700000000")),
        ]
    }

    fn point() -> impl Strategy<Value = Value> {
        prop_oneof![
            4 => (sample_time_value(), sample_value()).prop_map(|(t, v)| json!([t, v])),
            1 => prop::collection::vec(sample_value(), 0..4).prop_map(Value::Array),
            1 => sample_value(),
        ]
    }

    /// One series of a matrix or vector: labels, points and the point key of the other kind.
    fn series() -> impl Strategy<Value = Value> {
        let labels = prop::collection::btree_map(
            prop::sample::select(vec!["__name__", "job", "instance", "le", ""]).prop_map(str::to_string),
            prop_oneof![3 => "\\PC{0,8}".prop_map(Value::from), 1 => any::<i64>().prop_map(Value::from)],
            0..4,
        );
        (labels, prop::collection::vec(point(), 0..12), point(), any::<bool>()).prop_map(
            |(labels, values, value, with_metric)| {
                let mut s = serde_json::Map::new();
                if with_metric {
                    s.insert("metric".into(), json!(labels));
                }
                s.insert("values".into(), Value::Array(values));
                s.insert("value".into(), value);
                Value::Object(s)
            },
        )
    }

    /// The `data` of an answer: a result type and a result shaped like it, or not quite.
    fn answer_data() -> impl Strategy<Value = Value> {
        let kind = prop::sample::select(vec!["matrix", "vector", "scalar", "string", "streams", ""]);
        let result = prop_oneof![
            4 => prop::collection::vec(series(), 0..6).prop_map(Value::Array),
            1 => point(),
            1 => sample_value(),
        ];
        (kind, result).prop_map(|(kind, result)| json!({ "resultType": kind, "result": result }))
    }

    proptest! {
        // 256 cases (proptest's default), bounded for CI; PROPTEST_CASES raises it locally.
        #![proptest_config(ProptestConfig::default())]

        #[test]
        fn expand_never_panics_on_any_text(expr in "\\PC{0,200}") {
            let _ = expand(&expr, &req());
        }

        #[test]
        fn expand_never_panics_on_promql_like_text(expr in promql_like()) {
            let _ = expand(&expr, &req());
        }

        /// An answer shaped like Prometheus's, or broken in any part, is a frame or an error.
        #[test]
        fn answers_never_panic(data in answer_data()) {
            let _ = to_frame(&data, &req());
        }
    }
}
