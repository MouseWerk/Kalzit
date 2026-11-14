//! Jaeger over its HTTP query API (the one Jaeger's own UI reads), through the one client
//! factory (`crate::http`), which checks every connection and redirect target.
//!
//! Read-only by construction: Kalzit sends only GET requests to the services, operations and
//! traces endpoints (`allowed`), checked for every URL and redirect; the collector and admin
//! ports are never reached, and the query API has no writes.
//!
//! A trace by id answers the `trace` shape. A search answers a `frame` with one row per trace
//! found (Jaeger sends the whole traces; Kalzit lists them and shows one by its id), and the
//! services and operations answer `frame`s too. Variables (`$name`) may stand in any text field.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::Value;

use super::traces::{self, Codes, Endpoints, TraceBuilder, TraceSummary, checked_text, form_error, with_variables};
use super::{
    Connection, DataSourcePlugin, FieldError, Health, Kind, SettingField, SettingType, SourceError, SourceQuery,
    SourceSchema,
};
use crate::shapes::{QueryResult, Shape, SpanStatus};

const SETTINGS: &[SettingField] = &[
    SettingField::new("url", "datasources.settings.url", SettingType::String).target().required(),
    SettingField::new("basicAuthUser", "datasources.settings.basicAuthUser", SettingType::String).target(),
    SettingField::new("basicAuthPassword", "datasources.settings.basicAuthPassword", SettingType::String).secret(),
    SettingField::new("bearerToken", "datasources.settings.bearerToken", SettingType::String).secret(),
    SettingField::new("caCert", "datasources.settings.caCert", SettingType::Text).target(),
];

/// Services and operations the schema reads for completion.
const MAX_SCHEMA_SERVICES: usize = 50;
const MAX_SCHEMA_OPERATIONS: usize = 200;
/// Traces a search asks for when the query does not say.
const DEFAULT_SEARCH_LIMIT: usize = 20;

static CODES: Codes = Codes {
    engine: "Jaeger",
    endpoint_not_allowed: "jaeger.endpoint_not_allowed",
    error: "jaeger.error",
    not_an_api_response: "jaeger.not_an_api_response",
    credentials_invalid: "jaeger.credentials_invalid",
};

/// The only paths Kalzit reads below the base URL, all GET.
fn allowed(segments: &[&str]) -> bool {
    match segments {
        ["api", "services"] | ["api", "operations"] | ["api", "traces"] => true,
        ["api", "services", _, "operations"] => true,
        ["api", "traces", id] => id.bytes().all(|b| b.is_ascii_hexdigit()),
        _ => false,
    }
}

static ENDPOINTS: Endpoints = Endpoints { codes: &CODES, allowed };

pub fn kind() -> Kind {
    Kind { name: "Jaeger", hint_key: "datasources.kinds.jaeger.hint", settings: SETTINGS, plugin: Arc::new(Jaeger) }
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum List {
    Services,
    Operations,
}

/// One of: `{"traceId": "..."}` (one trace), a search (`{"service": "...", "operation", "tags",
/// "minDuration", "maxDuration", "status", "limit"}`, a frame; the service is required), `{"list":
/// "services"}` or `{"list": "operations", "service": "..."}` (frames).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct JaegerQuery {
    trace_id: Option<String>,
    list: Option<List>,
    service: Option<String>,
    operation: Option<String>,
    #[serde(default)]
    tags: BTreeMap<String, String>,
    min_duration: Option<String>,
    max_duration: Option<String>,
    status: Option<SpanStatus>,
    limit: Option<u32>,
}

impl JaegerQuery {
    /// Fields that belong to a search only (the service also names a list's service).
    fn search_fields(&self) -> bool {
        self.operation.is_some()
            || !self.tags.is_empty()
            || self.min_duration.is_some()
            || self.max_duration.is_some()
            || self.status.is_some()
            || self.limit.is_some()
    }

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

pub struct Jaeger;

#[async_trait::async_trait]
impl DataSourcePlugin for Jaeger {
    fn kind(&self) -> &'static str {
        "jaeger"
    }

    fn shapes(&self) -> &'static [Shape] {
        &[Shape::Trace, Shape::Frame]
    }

    fn check_settings(&self, settings: &Value) -> Result<(), FieldError> {
        if settings.get("tenantId").is_some() {
            return Err(FieldError::new("settings", "settings.invalid", "Jaeger has no tenant setting")
                .with("detail", "unknown field tenantId"));
        }
        traces::check_settings(settings)
    }

    async fn health(&self, conn: &Connection) -> Health {
        let check = async {
            let c = traces::client(conn, &ENDPOINTS).await?;
            let answer = c.json(&["api", "services"], &[]).await?;
            if !answer.get("data").is_some_and(|d| d.is_array() || d.is_null()) {
                return Err(SourceError::failed(
                    CODES.not_an_api_response,
                    "the server answered without a Jaeger API response",
                )
                .with("status", 200));
            }
            Ok::<_, SourceError>(())
        };
        match check.await {
            Ok(()) => Health::connected("Jaeger", "", false),
            Err(e) => Health::failed(&e),
        }
    }

    /// The services as labels and their operations as values, for completion and pickers.
    async fn schema(&self, conn: &Connection) -> Result<SourceSchema, SourceError> {
        let c = traces::client(conn, &ENDPOINTS).await?;
        let mut services = traces::names(&c.json(&["api", "services"], &[]).await?["data"], MAX_SCHEMA_SERVICES * 20);
        services.sort();
        let values: BTreeMap<String, Vec<String>> =
            futures_util::stream::iter(services.iter().take(MAX_SCHEMA_SERVICES).cloned())
                .map(|service| {
                    let c = c.clone();
                    async move {
                        let ops = c.json(&["api", "services", &service, "operations"], &[]).await.ok();
                        let mut ops = ops.map(|o| traces::names(&o["data"], MAX_SCHEMA_OPERATIONS)).unwrap_or_default();
                        ops.sort();
                        (service, ops)
                    }
                })
                .buffer_unordered(4)
                .collect()
                .await;
        Ok(SourceSchema::Labels { labels: services, values })
    }

    async fn query(&self, conn: &Connection, req: SourceQuery) -> Result<QueryResult, SourceError> {
        let plan = plan(&req)?;
        let c = traces::client(conn, &ENDPOINTS).await?;
        match plan {
            Plan::Trace(id) => trace_by_id(&c, &id, &req).await,
            Plan::Services => {
                let data = c.json(&["api", "services"], &[]).await?;
                let mut names = traces::names(&data["data"], usize::MAX);
                names.sort();
                let rows = names.into_iter().map(|n| (n, None)).collect();
                Ok(QueryResult::Frame { frame: traces::names_frame("service", rows, None, &req) })
            }
            Plan::Operations(service) => {
                let data = c.json(&["api", "operations"], &[("service", service)]).await?;
                let frame = traces::names_frame("operation", operations(&data), Some("spanKind"), &req);
                Ok(QueryResult::Frame { frame })
            }
            Plan::Search { params, shown, limit } => search(&c, params, shown, limit, &req).await,
        }
    }
}

/// What a query asks of Jaeger, checked and with its variables put in.
enum Plan {
    Trace(String),
    Services,
    Operations(String),
    Search { params: Vec<(&'static str, String)>, shown: String, limit: usize },
}

fn plan(req: &SourceQuery) -> Result<Plan, SourceError> {
    let q: JaegerQuery = req.parse()?;
    if let Some(id) = &q.trace_id {
        if q.list.is_some() || q.service.is_some() || q.search_fields() {
            return Err(form_error("traceId stands alone"));
        }
        return Ok(Plan::Trace(traces::check_trace_id(&with_variables(id, req)?)?));
    }
    match q.list {
        Some(_) if q.search_fields() => Err(form_error("a list takes no search fields")),
        Some(List::Services) if q.service.is_some() => Err(form_error("the list of services takes no service")),
        Some(List::Services) => Ok(Plan::Services),
        Some(List::Operations) => match &q.service {
            Some(service) => Ok(Plan::Operations(checked_text("service", service, req)?)),
            None => Err(form_error("the list of operations needs a service")),
        },
        None if q.service.is_none() => Err(form_error("a Jaeger search needs a service")),
        None => search_plan(&q, req),
    }
}

/// The checks a query goes through before anything is sent (for the guides' queries).
#[cfg(test)]
pub(crate) fn check(req: &SourceQuery) -> Result<(), SourceError> {
    plan(req).map(|_| ())
}

/// The search as Jaeger's parameters. A status becomes a tag, as Jaeger stores it: `error` is
/// `error=true`, `ok` is `otel.status_code=OK`; Jaeger cannot search for spans without a status.
fn search_plan(q: &JaegerQuery, req: &SourceQuery) -> Result<Plan, SourceError> {
    let limit = traces::search_limit(q.limit, DEFAULT_SEARCH_LIMIT);
    let mut search = q.search().bind(req)?;
    let service = search.service.take().expect("a search names its service");
    match search.status {
        Some(SpanStatus::Error) => {
            search.tags.insert("error".into(), "true".into());
        }
        Some(SpanStatus::Ok) => {
            search.tags.insert("otel.status_code".into(), "OK".into());
        }
        Some(SpanStatus::Unset) => return Err(form_error("Jaeger cannot search for spans without a status")),
        None => {}
    }
    let mut params = vec![
        ("service", service.clone()),
        ("start", (req.range.from.saturating_mul(1000)).to_string()),
        ("end", (req.range.to.saturating_mul(1000)).to_string()),
        ("limit", limit.to_string()),
        ("lookback", "custom".to_string()),
    ];
    let mut shown = vec![format!("service={service}")];
    if let Some(op) = search.operation {
        shown.push(format!("operation={op}"));
        params.push(("operation", op));
    }
    if !search.tags.is_empty() {
        let tags = traces::tags_json(&search.tags);
        shown.push(format!("tags={tags}"));
        params.push(("tags", tags));
    }
    for (key, value) in [("minDuration", search.min_duration), ("maxDuration", search.max_duration)] {
        if let Some(value) = value {
            shown.push(format!("{key}={value}"));
            params.push((key, value));
        }
    }
    Ok(Plan::Search { params, shown: shown.join(" "), limit })
}

/// One trace in the `trace` shape. Jaeger answers 404 for an id it does not hold.
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
    let empty = Vec::new();
    for trace in doc["data"].as_array().unwrap_or(&empty) {
        if !traces::jaeger_spans(trace, &mut builder) {
            break;
        }
    }
    drop(doc);
    drop(charge);
    Ok(QueryResult::Trace { trace: builder.finish() })
}

/// The traces of a service in the time range that match the search, one row per trace.
async fn search(
    c: &traces::Client,
    params: Vec<(&'static str, String)>,
    shown: String,
    limit: usize,
    req: &SourceQuery,
) -> Result<QueryResult, SourceError> {
    let max_bytes = req.limits.budget.remaining();
    let mut charge = req.limits.budget.charge();
    let data = c.get(&["api", "traces"], &params, max_bytes, Some(&mut charge), false).await?.json(&CODES)?;
    let rows = summaries(&data);
    drop(data);
    drop(charge);
    Ok(QueryResult::Frame { frame: traces::summaries_frame(rows, req, limit, shown) })
}

/// `/api/operations` (`{"data": [{"name", "spanKind"}]}`), by name.
fn operations(data: &Value) -> Vec<(String, Option<String>)> {
    let empty = Vec::new();
    let mut out: Vec<(String, Option<String>)> = data["data"]
        .as_array()
        .unwrap_or(&empty)
        .iter()
        .filter_map(|o| {
            let name = o["name"].as_str()?.to_string();
            let kind = o["spanKind"].as_str().filter(|k| !k.is_empty()).map(str::to_string);
            Some((name, kind))
        })
        .collect();
    out.sort();
    out
}

/// Whether a Jaeger span (JSON) failed: `error` true or `otel.status_code` ERROR.
fn failed(span: &Value) -> bool {
    span["tags"].as_array().is_some_and(|tags| {
        tags.iter().any(|t| {
            (t["key"] == "error" && (t["value"] == true || t["value"] == "true"))
                || (t["key"] == "otel.status_code" && t["value"] == "ERROR")
        })
    })
}

/// The traces of a search answer, newest first: the root span (no reference, the earliest),
/// the whole trace's start and duration, its spans, errors and services.
fn summaries(data: &Value) -> Vec<TraceSummary> {
    let empty = Vec::new();
    let mut rows: Vec<TraceSummary> = data["data"]
        .as_array()
        .unwrap_or(&empty)
        .iter()
        .map(|t| {
            let spans = t["spans"].as_array().unwrap_or(&empty);
            let start_of = |s: &Value| s["startTime"].as_i64().unwrap_or(0);
            let roots = spans.iter().filter(|s| s["references"].as_array().is_none_or(|r| r.is_empty()));
            let root = roots.min_by_key(|s| start_of(s)).or_else(|| spans.iter().min_by_key(|s| start_of(s)));
            let start = spans.iter().map(start_of).min().unwrap_or(0);
            let end = spans.iter().map(|s| start_of(s) + s["duration"].as_i64().unwrap_or(0)).max().unwrap_or(start);
            let service_of = |s: &Value| {
                let process = &t["processes"][s["processID"].as_str().unwrap_or_default()];
                process["serviceName"].as_str().map(str::to_string)
            };
            let services: BTreeSet<String> = spans.iter().filter_map(service_of).collect();
            TraceSummary {
                trace_id: traces::hex_id(t["traceID"].as_str().unwrap_or_default()),
                root_service: root.and_then(service_of),
                root_operation: root.and_then(|r| r["operationName"].as_str().map(str::to_string)),
                start,
                duration_ms: (end - start) as f64 / 1000.0,
                counts: vec![
                    ("spans", spans.len() as u64),
                    ("errors", spans.iter().filter(|s| failed(s)).count() as u64),
                    ("services", services.len() as u64),
                ],
            }
        })
        .collect();
    rows.sort_by(|a, b| b.start.cmp(&a.start).then_with(|| a.trace_id.cmp(&b.trace_id)));
    rows
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::datasources::Limits;
    use crate::datasources::frame::ResponseBudget;
    use crate::shapes::TimeRange;
    use reqwest::{Method, Url};
    use serde_json::json;

    fn req(vars: Value) -> SourceQuery {
        SourceQuery {
            ref_id: "A".into(),
            query: json!({}),
            range: TimeRange { from: 1_800_000_000_000, to: 1_800_003_600_000 },
            interval_ms: 15_000,
            max_data_points: None,
            variables: serde_json::from_value(vars).unwrap(),
            identifier_variables: None,
            limits: Limits {
                timeout: std::time::Duration::from_secs(5),
                max_rows: 1000,
                budget: ResponseBudget::new(1 << 20),
            },
            cursor: None,
        }
    }

    #[test]
    fn only_read_endpoints_are_reached() {
        let base = Url::parse("https://jaeger.intern/").unwrap();
        let ok =
            |path: &str| traces::check_endpoint(&ENDPOINTS, &base, &Method::GET, &base.join(path).unwrap()).is_ok();
        assert!(ok("api/services"));
        assert!(ok("api/services/kasse/operations"));
        assert!(ok("api/operations?service=kasse"));
        assert!(ok("api/traces?service=kasse"));
        assert!(ok("api/traces/0af7651916cd43dd"));
        assert!(!ok("api/traces/0af7651916cd43dd/../../../admin"));
        assert!(!ok("api/dependencies"));
        assert!(!ok("api/traces/x"));
        assert!(!ok("api/v3/traces"));
        assert!(!ok("metrics"));
        let refused = traces::check_endpoint(&ENDPOINTS, &base, &Method::DELETE, &base.join("api/services").unwrap());
        assert_eq!(refused.unwrap_err().reason, "jaeger.endpoint_not_allowed");
    }

    #[test]
    fn query_fields_are_checked() {
        let r = req(json!({ "svc": "kasse", "dauer": "250ms", "leer": "" }));
        assert_eq!(checked_text("service", "$svc", &r).unwrap(), "kasse");
        assert!(checked_text("service", "$leer", &r).is_err());
        assert!(checked_text("service", "a\nb", &r).is_err());
        assert_eq!(traces::duration("minDuration", "$dauer", &r).unwrap(), "250ms");
        assert_eq!(traces::duration("minDuration", "1.5s", &r).unwrap(), "1.5s");
        for bad in ["", "ms", "5", "5 ms", "5d", "-5s", "1e9s"] {
            assert!(traces::duration("minDuration", bad, &r).is_err(), "{bad}");
        }
    }

    fn planned(query: Value) -> Result<Plan, SourceError> {
        let mut r = req(json!({ "svc": "kasse" }));
        r.query = query;
        plan(&r)
    }

    /// A search needs a service; a status becomes the tag Jaeger stores; the limit is 20 by
    /// default and at most 1000.
    #[test]
    fn searches_follow_jaegers_rules() {
        let Plan::Search { params, shown, limit } =
            planned(json!({ "service": "$svc", "status": "error", "minDuration": "1ms" })).unwrap()
        else {
            panic!("a search")
        };
        assert_eq!(limit, 20);
        assert!(params.contains(&("tags", r#"{"error":"true"}"#.to_string())), "{params:?}");
        assert!(params.contains(&("service", "kasse".to_string())));
        assert_eq!(shown, r#"service=kasse tags={"error":"true"} minDuration=1ms"#);
        let Ok(Plan::Search { limit, .. }) = planned(json!({ "service": "a", "limit": 5000 })) else { panic!() };
        assert_eq!(limit, 1000);
        for bad in [
            json!({ "operation": "x" }),
            json!({ "service": "a", "status": "unset" }),
            json!({ "traceId": "ab", "service": "a" }),
            json!({ "list": "services", "limit": 3 }),
            json!({ "list": "operations" }),
        ] {
            assert!(planned(bad.clone()).is_err(), "{bad}");
        }
        assert!(matches!(planned(json!({ "list": "services" })), Ok(Plan::Services)));
    }

    #[test]
    fn search_answers_become_summaries_newest_first() {
        let doc: Value = serde_json::from_str(include_str!("../../tests/fixtures/traces/jaeger_trace.json")).unwrap();
        let mut later = doc["data"][0].clone();
        later["traceID"] = json!("ffff");
        for s in later["spans"].as_array_mut().unwrap() {
            s["startTime"] = json!(s["startTime"].as_i64().unwrap() + 60_000_000);
        }
        let data = json!({ "data": [doc["data"][0], later] });
        let rows = summaries(&data);
        assert_eq!(rows[0].trace_id, "000000000000ffff");
        let first = &rows[1];
        assert_eq!(first.trace_id, "0af7651916cd43dd");
        assert_eq!(first.root_service.as_deref(), Some("frontend"));
        assert_eq!(first.root_operation.as_deref(), Some("GET /cart"));
        assert_eq!(first.start, 1_800_000_000_000_000);
        assert_eq!(first.duration_ms, 120.0);
        assert_eq!(first.counts, [("spans", 3), ("errors", 1), ("services", 2)]);
    }

    #[test]
    fn operations_come_with_their_kind() {
        let data = json!({ "data": [{ "name": "b", "spanKind": "server" }, { "name": "a", "spanKind": "" }] });
        assert_eq!(operations(&data), [("a".to_string(), None), ("b".to_string(), Some("server".to_string()))]);
    }
}
