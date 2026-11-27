//! Grafana Tempo over its HTTP API, through the one client factory (`crate::http`), which checks
//! every connection and redirect target.
//!
//! Read-only by construction: Kalzit sends only GET requests to a fixed list of read endpoints
//! (`allowed`), checked for every URL and redirect, so nothing reaches the ingest (OTLP) or any
//! administrative endpoint. TraceQL itself cannot write.
//!
//! A trace by id answers the `trace` shape; a TraceQL search answers a `frame` with one row per
//! trace found, and the values of a tag (the services, say) a `frame` too. Variables are accepted
//! only inside quoted strings, as in PromQL (`prometheus::expand`).

use std::collections::BTreeMap;
use std::sync::Arc;

use serde::Deserialize;
use serde_json::Value;

use super::traces::{self, Codes, Endpoints, TraceBuilder, TraceSummary};
use super::{
    Connection, DataSourcePlugin, FieldError, Health, Kind, SettingField, SettingType, SourceError, SourceQuery,
    SourceSchema, prometheus,
};
use crate::shapes::{QueryResult, Shape};

const SETTINGS: &[SettingField] = &[
    SettingField::new("url", "datasources.settings.url", SettingType::String).target().required(),
    SettingField::new("basicAuthUser", "datasources.settings.basicAuthUser", SettingType::String).target(),
    SettingField::new("basicAuthPassword", "datasources.settings.basicAuthPassword", SettingType::String).secret(),
    SettingField::new("bearerToken", "datasources.settings.bearerToken", SettingType::String).secret(),
    SettingField::new("tenantId", "datasources.settings.tenantId", SettingType::String).target(),
    SettingField::new("caCert", "datasources.settings.caCert", SettingType::Text).target(),
];

/// Spans per span set a search asks for when the query does not say (Tempo's own default is 3).
const DEFAULT_SPANS_PER_SET: u32 = 3;
const MAX_SPANS_PER_SET: u32 = 100;
/// Tags and values the schema reads for completion.
const MAX_SCHEMA_TAGS: usize = 500;
const MAX_SCHEMA_VALUES: usize = 200;
/// The tags whose values the schema reads (services and operations to pick from).
const SCHEMA_VALUE_TAGS: [&str; 2] = ["resource.service.name", "name"];

static CODES: Codes = Codes {
    engine: "Tempo",
    endpoint_not_allowed: "tempo.endpoint_not_allowed",
    error: "tempo.error",
    not_an_api_response: "tempo.not_an_api_response",
    credentials_invalid: "tempo.credentials_invalid",
};

/// The only paths Kalzit reads below the base URL, all GET: a trace by id, the search, tags and
/// their values, and the echo and build info for the connection test.
fn allowed(segments: &[&str]) -> bool {
    match segments {
        ["api", "echo"] | ["api", "search"] | ["api", "status", "buildinfo"] => true,
        ["api", "traces", id] | ["api", "v2", "traces", id] => id.bytes().all(|b| b.is_ascii_hexdigit()),
        ["api", "v2", "search", "tags"] => true,
        ["api", "v2", "search", "tag", _, "values"] => true,
        _ => false,
    }
}

static ENDPOINTS: Endpoints = Endpoints { codes: &CODES, allowed };

pub fn kind() -> Kind {
    Kind { name: "Tempo", hint_key: "datasources.kinds.tempo.hint", settings: SETTINGS, plugin: Arc::new(Tempo) }
}

/// Traces a search asks for when the query does not say.
const DEFAULT_SEARCH_LIMIT: usize = 100;

/// One of: a search without a query language (`{"service", "operation", "tags", "minDuration",
/// "maxDuration", "status", "limit"}`, every field optional; Kalzit writes the TraceQL), a
/// TraceQL search (`{"traceql": "...", "limit"}`), both answering a frame of traces;
/// `{"traceId": "..."}` (one trace) or `{"tagValues": "resource.service.name"}` (a frame).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TempoQuery {
    traceql: Option<String>,
    limit: Option<u32>,
    spans_per_span_set: Option<u32>,
    trace_id: Option<String>,
    tag_values: Option<String>,
    service: Option<String>,
    operation: Option<String>,
    #[serde(default)]
    tags: BTreeMap<String, String>,
    min_duration: Option<String>,
    max_duration: Option<String>,
    status: Option<crate::shapes::SpanStatus>,
}

impl TempoQuery {
    fn search(&self) -> traces::SearchFields {
        traces::SearchFields {
            service: self.service.clone(),
            operation: self.operation.clone(),
            tags: self.tags.clone(),
            min_duration: self.min_duration.clone(),
            max_duration: self.max_duration.clone(),
            status: self.status,
        }
    }
}

pub struct Tempo;

/// Unix seconds, as Tempo's search takes them; the end rounded up so the range covers it.
fn seconds(ms: i64, up: bool) -> String {
    let s = if up { ms.div_euclid(1000) + i64::from(ms.rem_euclid(1000) > 0) } else { ms.div_euclid(1000) };
    s.to_string()
}

#[async_trait::async_trait]
impl DataSourcePlugin for Tempo {
    fn kind(&self) -> &'static str {
        "tempo"
    }

    fn shapes(&self) -> &'static [Shape] {
        &[Shape::Trace, Shape::Frame]
    }

    fn check_settings(&self, settings: &Value) -> Result<(), FieldError> {
        traces::check_settings(settings)
    }

    async fn health(&self, conn: &Connection) -> Health {
        let check = async {
            let c = traces::client(conn, &ENDPOINTS).await?;
            // The echo answers plain text; the tags need the tenant and login where Tempo asks.
            c.get(&["api", "echo"], &[], traces::MAX_SMALL_RESPONSE, None, false).await?;
            c.json(&["api", "v2", "search", "tags"], &[]).await?;
            let info = c.json(&["api", "status", "buildinfo"], &[]).await.ok();
            Ok::<_, SourceError>(info.and_then(|i| i["version"].as_str().map(str::to_string)).unwrap_or_default())
        };
        match check.await {
            Ok(version) => Health::connected("Tempo", &version, false),
            Err(e) => Health::failed(&e),
        }
    }

    async fn schema(&self, conn: &Connection) -> Result<SourceSchema, SourceError> {
        let c = traces::client(conn, &ENDPOINTS).await?;
        let tags = scoped_tags(&c.json(&["api", "v2", "search", "tags"], &[]).await?, MAX_SCHEMA_TAGS);
        let mut values: BTreeMap<String, Vec<String>> = BTreeMap::new();
        for tag in SCHEMA_VALUE_TAGS {
            // A tag Tempo cannot list values of leaves its list empty.
            let found = c.json(&["api", "v2", "search", "tag", tag, "values"], &[]).await.ok();
            values.insert(tag.to_string(), found.map(|v| tag_values(&v, MAX_SCHEMA_VALUES)).unwrap_or_default());
        }
        Ok(SourceSchema::Labels { labels: tags, values })
    }

    async fn query(&self, conn: &Connection, req: SourceQuery) -> Result<QueryResult, SourceError> {
        let plan = plan(&req)?;
        let c = traces::client(conn, &ENDPOINTS).await?;
        let (traceql, limit, spss) = match plan {
            Plan::Trace(id) => return trace_by_id(&c, &id, &req).await,
            Plan::TagValues(tag) => {
                let range = [("start", seconds(req.range.from, false)), ("end", seconds(req.range.to, true))];
                let data = c.json(&["api", "v2", "search", "tag", &tag, "values"], &range).await?;
                let values = tag_values(&data, req.limits.max_rows).into_iter().map(|v| (v, None)).collect();
                return Ok(QueryResult::Frame { frame: traces::names_frame("value", values, None, &req) });
            }
            Plan::Search { traceql, limit, spss } => (traceql, limit, spss),
        };
        let params = [
            ("q", traceql.clone()),
            ("start", seconds(req.range.from, false)),
            ("end", seconds(req.range.to, true)),
            ("limit", limit.to_string()),
            ("spss", spss.to_string()),
        ];
        let max_bytes = req.limits.budget.remaining();
        let mut charge = req.limits.budget.charge();
        let data = c.get(&["api", "search"], &params, max_bytes, Some(&mut charge), false).await?.json(&CODES)?;
        let rows = summaries(&data);
        drop(data);
        drop(charge);
        let found = rows.len();
        Ok(QueryResult::Frame { frame: traces::summaries_frame(rows, found, &req, limit, traceql) })
    }
}

use traces::form_error;

/// What a query asks of Tempo, checked and with its variables put in.
enum Plan {
    Trace(String),
    TagValues(String),
    Search { traceql: String, limit: usize, spss: u32 },
}

fn plan(req: &SourceQuery) -> Result<Plan, SourceError> {
    let q: TempoQuery = req.parse()?;
    let fields = q.search();
    // The search fields are one form; `{}` and `{"limit": 50}` are a search too.
    let searching = q.traceql.is_none() && q.trace_id.is_none() && q.tag_values.is_none();
    let forms = [q.traceql.is_some(), q.trace_id.is_some(), q.tag_values.is_some(), !fields.is_empty()];
    if forms.iter().filter(|f| **f).count() > 1 {
        return Err(form_error("give one of the search fields, traceql, traceId or tagValues"));
    }
    if q.traceql.is_none() && !searching && (q.limit.is_some() || q.spans_per_span_set.is_some()) {
        return Err(form_error("limit and spansPerSpanSet belong to a search"));
    }
    let limit = traces::search_limit(q.limit, DEFAULT_SEARCH_LIMIT);
    let spss = q.spans_per_span_set.unwrap_or(DEFAULT_SPANS_PER_SET).clamp(1, MAX_SPANS_PER_SET);
    if searching {
        let traceql = traces::traceql(&fields.bind(req)?);
        return Ok(Plan::Search { traceql, limit, spss });
    }
    if let Some(id) = &q.trace_id {
        return Ok(Plan::Trace(traces::check_trace_id(&traces::with_variables(id, req)?)?));
    }
    if let Some(tag) = &q.tag_values {
        let tag = traces::with_variables(tag, req)?.trim().to_string();
        if tag.is_empty() || tag.chars().count() > 200 || tag.chars().any(|c| c.is_control() || c == '/') {
            return Err(form_error("tagValues names a tag, such as resource.service.name"));
        }
        return Ok(Plan::TagValues(tag));
    }
    let traceql = prometheus::expand(q.traceql.as_deref().unwrap_or_default(), req)?;
    if traceql.trim().is_empty() {
        return Err(SourceError::rejected("tempo.empty", "the TraceQL query is empty"));
    }
    Ok(Plan::Search { traceql, limit, spss })
}

/// The checks a query goes through before anything is sent (for the guides' queries).
#[cfg(test)]
pub(crate) fn check(req: &SourceQuery) -> Result<(), SourceError> {
    plan(req).map(|_| ())
}

/// One trace in the `trace` shape. Tempo answers 404 for an id it does not hold.
async fn trace_by_id(c: &traces::Client, id: &str, req: &SourceQuery) -> Result<QueryResult, SourceError> {
    let max_bytes = req.limits.budget.remaining();
    let mut charge = req.limits.budget.charge();
    let answer = c.get(&["api", "traces", id], &[], max_bytes, Some(&mut charge), true).await?;
    if answer.status == reqwest::StatusCode::NOT_FOUND {
        return Err(SourceError::failed("trace.not_found", format!("there is no trace {id}")).with("id", id));
    }
    let doc = answer.json(&CODES)?;
    drop(answer);
    let mut builder = TraceBuilder::new(req.limits.budget.clone());
    builder.executed_query(format!("trace {id}"));
    traces::otlp_spans(&doc, &mut builder);
    drop(doc);
    drop(charge);
    let mut trace = builder.finish();
    traces::as_asked(&mut trace, id);
    Ok(QueryResult::Trace { trace })
}

/// The traces of a search answer (`{"traces": [...]}`), as Tempo lists them.
fn summaries(data: &Value) -> Vec<TraceSummary> {
    let empty = Vec::new();
    data["traces"]
        .as_array()
        .unwrap_or(&empty)
        .iter()
        .map(|t| {
            // A span set per matching condition; `spanSet` in older versions.
            let matched: u64 = match t["spanSets"].as_array() {
                Some(sets) => sets.iter().map(|s| s["matched"].as_u64().unwrap_or(0)).sum(),
                None => t["spanSet"]["matched"].as_u64().unwrap_or(0),
            };
            let start_ns: i128 = t["startTimeUnixNano"].as_str().and_then(|s| s.parse().ok()).unwrap_or(0);
            let text = |key: &str| t[key].as_str().filter(|s| !s.is_empty() && !s.starts_with('<')).map(str::to_string);
            TraceSummary {
                trace_id: traces::hex_id_128(t["traceID"].as_str().unwrap_or_default()),
                root_service: text("rootServiceName"),
                root_operation: text("rootTraceName"),
                start: start_ns.div_euclid(1000) as i64,
                duration_ms: t["durationMs"].as_f64().unwrap_or(0.0),
                counts: vec![("matchedSpans", matched)],
            }
        })
        .collect()
}

/// The tags of `/api/v2/search/tags` with their scope (`resource.service.name`, `span.http.method`);
/// intrinsics as they are.
fn scoped_tags(data: &Value, max: usize) -> Vec<String> {
    let empty = Vec::new();
    let mut out = Vec::new();
    for scope in data["scopes"].as_array().unwrap_or(&empty) {
        let name = scope["name"].as_str().unwrap_or_default();
        for tag in traces::names(&scope["tags"], max) {
            let full = if name.is_empty() || name == "intrinsic" { tag } else { format!("{name}.{tag}") };
            if out.len() >= max {
                return out;
            }
            if !out.contains(&full) {
                out.push(full);
            }
        }
    }
    out
}

/// The values of `/api/v2/search/tag/{tag}/values` (`{"tagValues": [{"type", "value"}]}`).
fn tag_values(data: &Value, max: usize) -> Vec<String> {
    let empty = Vec::new();
    data["tagValues"]
        .as_array()
        .unwrap_or(&empty)
        .iter()
        .filter_map(|v| v["value"].as_str().map(str::to_string))
        .take(max)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::{Method, Url};
    use serde_json::json;

    #[test]
    fn only_read_endpoints_are_reached() {
        let base = Url::parse("https://tempo.intern/proxy/").unwrap();
        let ok =
            |path: &str| traces::check_endpoint(&ENDPOINTS, &base, &Method::GET, &base.join(path).unwrap()).is_ok();
        assert!(ok("api/search?q=%7B%7D"));
        assert!(ok("api/traces/4bf92f3577b34da6a3ce929d0e0e4736"));
        assert!(ok("api/v2/search/tags"));
        assert!(ok("api/v2/search/tag/resource.service.name/values"));
        assert!(ok("api/echo"));
        assert!(!ok("v1/traces"), "the OTLP receiver");
        assert!(!ok("api/traces/../../flush"));
        assert!(!ok("api/traces/xyz"));
        assert!(!ok("flush"));
        assert!(!ok("shutdown"));
        assert!(!ok("/api/search"), "outside the base path");
        let post = base.join("api/search").unwrap();
        assert!(traces::check_endpoint(&ENDPOINTS, &base, &Method::POST, &post).is_err(), "only GET");
        let other = Url::parse("https://anders.intern/proxy/api/search").unwrap();
        assert!(traces::check_endpoint(&ENDPOINTS, &base, &Method::GET, &other).is_err());
        let refused = traces::check_endpoint(&ENDPOINTS, &base, &Method::GET, &base.join("flush").unwrap());
        assert_eq!(refused.unwrap_err().reason, "tempo.endpoint_not_allowed");
    }

    #[test]
    fn search_answers_become_summaries() {
        let data = json!({ "traces": [
            { "traceID": "2f3e0cee77ae5dc9c17ade3689eb2e5", "rootServiceName": "shop", "rootTraceName": "checkout",
              "startTimeUnixNano": "1800000000000500000", "durationMs": 557,
              "spanSets": [{ "spans": [], "matched": 2 }, { "spans": [], "matched": 1 }] },
            { "traceID": "ab", "rootServiceName": "<root span not yet received>",
              "startTimeUnixNano": "1800000001000000000", "spanSet": { "matched": 4 } }
        ] });
        let rows = summaries(&data);
        assert_eq!(rows[0].trace_id, "02f3e0cee77ae5dc9c17ade3689eb2e5");
        assert_eq!(rows[0].root_operation.as_deref(), Some("checkout"));
        assert_eq!(rows[0].start, 1_800_000_000_000_500);
        assert_eq!(rows[0].duration_ms, 557.0);
        assert_eq!(rows[0].counts, [("matchedSpans", 3)]);
        assert_eq!(rows[1].root_service, None, "a placeholder is no service");
        assert_eq!(rows[1].trace_id, "000000000000000000000000000000ab", "Tempo ids are 128 bits");
        assert_eq!(rows[1].counts, [("matchedSpans", 4)]);
        assert_eq!(rows[1].duration_ms, 0.0);
    }

    #[test]
    fn tags_carry_their_scope() {
        let data = json!({ "scopes": [
            { "name": "resource", "tags": ["service.name", "host.name"] },
            { "name": "span", "tags": ["http.method"] },
            { "name": "intrinsic", "tags": ["duration", "name"] }
        ] });
        assert_eq!(
            scoped_tags(&data, 10),
            ["resource.service.name", "resource.host.name", "span.http.method", "duration", "name"]
        );
        assert_eq!(scoped_tags(&data, 2).len(), 2);
        let values = json!({ "tagValues": [{ "type": "string", "value": "kasse" }, { "type": "int", "value": "3" }] });
        assert_eq!(tag_values(&values, 10), ["kasse", "3"]);
    }

    fn planned(query: serde_json::Value) -> Result<Plan, SourceError> {
        let req = SourceQuery {
            ref_id: "A".into(),
            query,
            range: crate::shapes::TimeRange { from: 1_800_000_000_000, to: 1_800_003_600_000 },
            interval_ms: 15_000,
            max_data_points: None,
            variables: serde_json::from_value(json!({ "svc": "kasse" })).unwrap(),
            identifier_variables: None,
            limits: crate::datasources::Limits {
                timeout: std::time::Duration::from_secs(5),
                max_rows: 1000,
                budget: crate::datasources::frame::ResponseBudget::new(1 << 20),
                pattern: Default::default(),
            },
            cursor: None,
            filters: Vec::new(),
        };
        plan(&req)
    }

    /// A search without a query language becomes TraceQL, which the answer shows; 100 traces by
    /// default, at most 1000.
    #[test]
    fn searches_without_traceql_write_it() {
        let Ok(Plan::Search { traceql, limit, spss }) =
            planned(json!({ "service": "$svc", "status": "error", "tags": { "http.status_code": "500" } }))
        else {
            panic!("a search")
        };
        assert_eq!(traceql, r#"{ resource.service.name = "kasse" && .http.status_code = 500 && status = error }"#);
        assert_eq!((limit, spss), (100, 3));
        let Ok(Plan::Search { traceql, limit, .. }) = planned(json!({ "limit": 5000 })) else { panic!() };
        assert_eq!((traceql.as_str(), limit), ("{}", 1000));
        let Ok(Plan::Search { traceql, .. }) = planned(json!({ "traceql": "{ span.x = \"$svc\" }" })) else { panic!() };
        assert_eq!(traceql, "{ span.x = \"kasse\" }");
        for bad in [
            json!({ "traceql": "{}", "service": "a" }),
            json!({ "traceId": "ab", "service": "a" }),
            json!({ "traceId": "ab", "limit": 3 }),
            json!({ "tagValues": "a/b" }),
            json!({ "traceql": " " }),
        ] {
            assert!(planned(bad.clone()).is_err(), "{bad}");
        }
        assert!(matches!(planned(json!({ "traceId": "ab" })), Ok(Plan::Trace(id)) if id == "00000000000000ab"));
    }

    #[test]
    fn search_ranges_cover_the_whole_range() {
        assert_eq!(seconds(1_800_000_000_999, false), "1800000000");
        assert_eq!(seconds(1_800_000_000_001, true), "1800000001");
        assert_eq!(seconds(1_800_000_000_000, true), "1800000000");
    }
}
