//! Prometheus and compatible APIs (Mimir, Thanos, VictoriaMetrics) over HTTP, through the one
//! client factory (`crate::http`), which checks every connection and redirect target.
//!
//! PromQL has no bind parameters. Variables are therefore accepted only inside quoted strings
//! (label values), escaped for that string; a variable anywhere else is refused. Macros expand to
//! numbers and durations Kalzit computes itself.

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
        let q: PromQuery = req.parse()?;
        // `$__interval` and `$__rate_interval` follow the step Prometheus is asked for, so a
        // window like `[$__interval]` covers exactly one point.
        let step_ms = step_ms(&q, &req);
        let mut req = req;
        req.interval_ms = step_ms as u64;
        let expr = expand(&q.expr, &req)?;
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
        }
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
