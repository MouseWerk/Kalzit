//! Trace steps on the server (docs/guide/traces.md): trace to trace (`filterSpans`,
//! `criticalPath`), trace to table (`spanTable`, `traceTable`) and trace to graph (`serviceMap`,
//! `spanTree`). A trace never turns into a table or a graph by itself; these steps run with the
//! query (`QueryItem::steps`), like the graph steps, and the steps after them read the trace, the
//! frame or the graph they made.
//!
//! Orders are fixed so every run answers the same rows: spans as the source ordered them,
//! services and calls by name (UTF-16 code units, as the graph steps compare text).

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use serde_json::{Value, json};

use super::graph::text_order;
use super::steps::Control;
use super::{PropertyFilter, StepKind};
use crate::datasources::detail::Detail;
use crate::shapes::{
    Edge, Field, FieldType, Frame, FrameMeta, GraphSchema, GraphSet, Node, Span, SpanKind, SpanStatus, TraceSet,
};

/// What a trace step makes.
#[derive(Clone, Debug, PartialEq)]
pub enum TraceOut {
    Trace(TraceSet),
    Frame(Frame),
    Graph(GraphSet),
}

/// The node label of a service and the edge type of a call in a service map.
pub const SERVICE_LABEL: &str = "Service";
pub const CALLS_TYPE: &str = "CALLS";
/// The node label of a span and the edge type from a parent to its child in a span tree.
pub const SPAN_LABEL: &str = "Span";
pub const CHILD_TYPE: &str = "CHILD";
/// Spans a service map reads before the step must say `confirmLarge`.
pub const MAX_GRAPH_SPANS: usize = 100_000;

/// The fixed columns of a span table, in order; asked attributes follow them.
pub const SPAN_COLUMNS: [&str; 14] = [
    "traceId",
    "spanId",
    "parentSpanId",
    "service",
    "operation",
    "start",
    "duration",
    "status",
    "statusMessage",
    "kind",
    "attributes",
    "resource",
    "events",
    "links",
];

/// Runs one trace step on `trace`. Steps that are no trace steps are not passed here.
pub fn apply(kind: &StepKind, trace: &TraceSet, control: &Control) -> Result<TraceOut, Detail> {
    control.check()?;
    Ok(match kind {
        StepKind::SpanTable { attributes, .. } => TraceOut::Frame(span_table(trace, attributes)),
        StepKind::TraceTable { .. } => TraceOut::Frame(trace_table(trace)),
        StepKind::ServiceMap { confirm_large, .. } => {
            check_large("serviceMap", trace, *confirm_large)?;
            TraceOut::Graph(service_map(trace))
        }
        StepKind::SpanTree { confirm_large, .. } => {
            check_large("spanTree", trace, *confirm_large)?;
            TraceOut::Graph(span_tree(trace))
        }
        StepKind::FilterSpans {
            services,
            operations,
            status,
            kinds,
            min_duration_ms,
            max_duration_ms,
            attribute,
            ..
        } => {
            let filter = SpanFilter {
                services,
                operations,
                status: *status,
                kinds,
                min_us: min_duration_ms.map(|d| d * 1000.0),
                max_us: max_duration_ms.map(|d| d * 1000.0),
                attribute: attribute.as_ref(),
            };
            TraceOut::Trace(keep(trace, |s| filter.passes(s)))
        }
        StepKind::CriticalPath { .. } => {
            let (on_path, rootless) = critical_path(trace);
            let mut out = keep(trace, |s| on_path.contains(&(s.trace_id.as_str(), s.span_id.as_str())));
            if rootless > 0 {
                let detail = Detail::new(
                    "trace.no_root",
                    format!("{rootless} traces have no root span; their critical path starts at their earliest span"),
                )
                .with("count", rootless);
                let notice = detail.notice(crate::shapes::NoticeSeverity::Warning);
                if !out.notices.contains(&notice) {
                    out.notices.push(notice);
                }
            }
            TraceOut::Trace(out)
        }
        _ => unreachable!("only trace steps run on traces"),
    })
}

/// A JSON value as an OTLP `AnyValue`.
fn any_value(v: &Value) -> Value {
    match v {
        Value::String(s) => json!({ "stringValue": s }),
        Value::Bool(b) => json!({ "boolValue": b }),
        Value::Number(n) if n.is_i64() || n.is_u64() => json!({ "intValue": n.to_string() }),
        Value::Number(n) => json!({ "doubleValue": n.as_f64() }),
        Value::Array(items) => json!({ "arrayValue": { "values": items.iter().map(any_value).collect::<Vec<_>>() } }),
        Value::Object(map) => json!({ "kvlistValue": { "values": key_values(map.iter()) } }),
        Value::Null => json!({}),
    }
}

fn key_values<'a>(map: impl Iterator<Item = (&'a String, &'a Value)>) -> Vec<Value> {
    map.map(|(k, v)| json!({ "key": k, "value": any_value(v) })).collect()
}

fn otlp_kind(kind: SpanKind) -> u8 {
    match kind {
        SpanKind::Unspecified => 0,
        SpanKind::Internal => 1,
        SpanKind::Server => 2,
        SpanKind::Client => 3,
        SpanKind::Producer => 4,
        SpanKind::Consumer => 5,
    }
}

/// Unix nanoseconds as OTLP JSON writes them, from microseconds.
fn nanos(us: i64, extra_us: f64) -> String {
    (i128::from(us) * 1000 + (extra_us * 1000.0).round() as i128).to_string()
}

/// A resource of an OTLP export: its key, its JSON and its spans per scope.
type OtlpResource<'a> = (String, Value, Vec<(Option<&'a crate::shapes::SpanScope>, Vec<Value>)>);

/// The trace as OTLP JSON (`{"resourceSpans": [...]}`, ids as hex, times as nanosecond text):
/// one resource per service and resource attributes, one scope list per instrumentation scope,
/// spans in the trace's order. What OpenTelemetry tools read back.
pub fn to_otlp(trace: &TraceSet) -> Value {
    // Resources and scopes in the order their first span appears.
    let mut resources: Vec<OtlpResource<'_>> = Vec::new();
    for s in &trace.spans {
        let mut attributes = vec![json!({ "key": "service.name", "value": { "stringValue": s.service } })];
        attributes.extend(key_values(s.resource.iter()));
        let resource = json!({ "attributes": attributes });
        let key = resource.to_string();
        let at = match resources.iter().position(|r| r.0 == key) {
            Some(at) => at,
            None => {
                resources.push((key, resource, Vec::new()));
                resources.len() - 1
            }
        };
        let scopes = &mut resources[at].2;
        let at = match scopes.iter().position(|sc| sc.0 == s.scope.as_ref()) {
            Some(at) => at,
            None => {
                scopes.push((s.scope.as_ref(), Vec::new()));
                scopes.len() - 1
            }
        };
        let mut status =
            json!({ "code": match s.status { SpanStatus::Unset => 0, SpanStatus::Ok => 1, SpanStatus::Error => 2 } });
        if let Some(m) = &s.status_message {
            status["message"] = json!(m);
        }
        scopes[at].1.push(json!({
            "traceId": s.trace_id,
            "spanId": s.span_id,
            "parentSpanId": s.parent_span_id.clone().unwrap_or_default(),
            "name": s.operation,
            "kind": otlp_kind(s.kind),
            "startTimeUnixNano": nanos(s.start, 0.0),
            "endTimeUnixNano": nanos(s.start, s.duration),
            "attributes": key_values(s.attributes.iter()),
            "events": s.events.iter().map(|e| json!({
                "timeUnixNano": nanos(e.time, 0.0), "name": e.name, "attributes": key_values(e.attributes.iter())
            })).collect::<Vec<_>>(),
            "links": s.links.iter().map(|l| json!({
                "traceId": l.trace_id, "spanId": l.span_id, "attributes": key_values(l.attributes.iter())
            })).collect::<Vec<_>>(),
            "status": status,
        }));
    }
    let resource_spans: Vec<Value> = resources
        .into_iter()
        .map(|(_, resource, scopes)| {
            let scope_spans: Vec<Value> = scopes
                .into_iter()
                .map(|(scope, spans)| {
                    let scope = scope.map_or(json!({}), |sc| match &sc.version {
                        Some(v) => json!({ "name": sc.name, "version": v }),
                        None => json!({ "name": sc.name }),
                    });
                    json!({ "scope": scope, "spans": spans })
                })
                .collect();
            json!({ "resource": resource, "scopeSpans": scope_spans })
        })
        .collect();
    json!({ "resourceSpans": resource_spans })
}

/// A graph step of more than `MAX_GRAPH_SPANS` spans asks first: it runs only with
/// `confirmLarge`.
fn check_large(step: &str, trace: &TraceSet, confirmed: bool) -> Result<(), Detail> {
    let n = trace.spans.len();
    if n > MAX_GRAPH_SPANS && !confirmed {
        return Err(Detail::new(
            "steps.trace_graph_large",
            format!("{step} would read {n} spans; confirm to compute it"),
        )
        .with("step", step)
        .with("spans", n)
        .with("limit", MAX_GRAPH_SPANS));
    }
    Ok(())
}

/// The trace with only the spans `pass` keeps; notices and the cut stay.
fn keep(trace: &TraceSet, pass: impl Fn(&Span) -> bool) -> TraceSet {
    TraceSet { spans: trace.spans.iter().filter(|s| pass(s)).cloned().collect(), ..trace.clone() }
}

struct SpanFilter<'a> {
    services: &'a [String],
    operations: &'a [String],
    status: Option<SpanStatus>,
    kinds: &'a [SpanKind],
    min_us: Option<f64>,
    max_us: Option<f64>,
    attribute: Option<&'a PropertyFilter>,
}

impl SpanFilter<'_> {
    /// Every given condition: one of the services, operations and kinds, the status, the
    /// duration range, and the attribute condition on span attributes, else resource attributes.
    fn passes(&self, s: &Span) -> bool {
        (self.services.is_empty() || self.services.contains(&s.service))
            && (self.operations.is_empty() || self.operations.contains(&s.operation))
            && self.status.is_none_or(|st| st == s.status)
            && (self.kinds.is_empty() || self.kinds.contains(&s.kind))
            && self.min_us.is_none_or(|m| s.duration >= m)
            && self.max_us.is_none_or(|m| s.duration <= m)
            && self.attribute.is_none_or(|f| {
                let owner = if s.attributes.contains_key(&f.key) { &s.attributes } else { &s.resource };
                super::graph::passes(owner, f)
            })
    }
}

/// The spans on the critical path of each trace, as (trace id, span id): from the root (the
/// earliest span without a parent in the trace), going back from its end, the child that ended
/// last before the time reached so far, then that child's own critical path, and so on; the time
/// moves to the start of each child taken. Spans that run in parallel with a slower one are left
/// out. A trace without a root (its parents form a cycle, or its spans name themselves as their
/// parent) starts from its earliest span; the second value counts such traces.
pub fn critical_path(trace: &TraceSet) -> (HashSet<(&str, &str)>, usize) {
    let mut on_path = HashSet::new();
    let mut rootless = 0;
    let mut by_trace: BTreeMap<&str, Vec<&Span>> = BTreeMap::new();
    for s in &trace.spans {
        by_trace.entry(s.trace_id.as_str()).or_default().push(s);
    }
    let end = |s: &Span| s.start as f64 + s.duration;
    for spans in by_trace.values() {
        let ids: HashSet<&str> = spans.iter().map(|s| s.span_id.as_str()).collect();
        let mut children: HashMap<&str, Vec<&Span>> = HashMap::new();
        let mut roots: Vec<&Span> = Vec::new();
        for s in spans {
            match s.parent_span_id.as_deref().filter(|p| ids.contains(p)) {
                // A span that names itself as its parent is no child of itself, nor a root.
                Some(p) if p == s.span_id => {}
                Some(p) => children.entry(p).or_default().push(s),
                None => roots.push(s),
            }
        }
        // Latest end first; ties by start, then id, so the path is fixed.
        for list in children.values_mut() {
            list.sort_by(|a, b| {
                end(b).total_cmp(&end(a)).then(a.start.cmp(&b.start)).then_with(|| a.span_id.cmp(&b.span_id))
            });
        }
        let earliest = |a: &&Span, b: &&Span| a.start.cmp(&b.start).then_with(|| a.span_id.cmp(&b.span_id));
        let root = match roots.into_iter().min_by(earliest) {
            Some(root) => root,
            None => {
                rootless += 1;
                match spans.iter().copied().min_by(earliest) {
                    Some(first) => first,
                    None => continue,
                }
            }
        };
        // An explicit stack: a deep trace does not grow the call stack.
        let mut work = vec![(root, end(root))];
        while let Some((span, until)) = work.pop() {
            if !on_path.insert((span.trace_id.as_str(), span.span_id.as_str())) {
                continue;
            }
            let mut cursor = until.min(end(span));
            for child in children.get(span.span_id.as_str()).into_iter().flatten() {
                if (child.start as f64) < cursor && end(child) > span.start as f64 {
                    work.push((child, cursor));
                    cursor = child.start as f64;
                }
            }
        }
    }
    (on_path, rootless)
}

/// One row per trace: `traceId`, `rootService`, `rootOperation` (its earliest span without a
/// parent in the trace), `start` (time), `duration` (milliseconds, first start to last end),
/// `spans`, `errors` and `services`.
pub fn trace_table(trace: &TraceSet) -> Frame {
    let mut by_trace: BTreeMap<&str, Vec<&Span>> = BTreeMap::new();
    for s in &trace.spans {
        by_trace.entry(s.trace_id.as_str()).or_default().push(s);
    }
    let mut cols: [Vec<Value>; 8] = Default::default();
    for (id, spans) in &by_trace {
        let ids: HashSet<&str> = spans.iter().map(|s| s.span_id.as_str()).collect();
        let root = spans
            .iter()
            .filter(|s| s.parent_span_id.as_deref().is_none_or(|p| !ids.contains(p)))
            .min_by(|a, b| a.start.cmp(&b.start).then_with(|| a.span_id.cmp(&b.span_id)));
        let start = spans.iter().map(|s| s.start).min().unwrap_or(0);
        let last = spans.iter().map(|s| s.start as f64 + s.duration).fold(start as f64, f64::max);
        let services: BTreeSet<&str> = spans.iter().map(|s| s.service.as_str()).collect();
        cols[0].push(json!(id));
        cols[1].push(root.map_or(Value::Null, |r| json!(r.service)));
        cols[2].push(root.map_or(Value::Null, |r| json!(r.operation)));
        cols[3].push(json!(start.div_euclid(1000)));
        cols[4].push(ms(last - start as f64));
        cols[5].push(json!(spans.len()));
        cols[6].push(json!(spans.iter().filter(|s| s.status == SpanStatus::Error).count()));
        cols[7].push(json!(services.len()));
    }
    let [ids, root_services, root_ops, starts, durations, counts, errors, services] = cols;
    let fields = vec![
        field("traceId", FieldType::String, None, ids),
        field("rootService", FieldType::String, None, root_services),
        field("rootOperation", FieldType::String, None, root_ops),
        field("start", FieldType::Time, None, starts),
        field("duration", FieldType::Number, Some("ms"), durations),
        field("spans", FieldType::Number, None, counts),
        field("errors", FieldType::Number, None, errors),
        field("services", FieldType::Number, None, services),
    ];
    let meta = FrameMeta {
        executed_query: trace.executed_query.clone(),
        rows_truncated: trace.truncated.is_some(),
        notices: trace.notices.clone(),
    };
    Frame::new(fields).expect("one value per trace in every field").with_meta(meta)
}

/// Every span a node (`Span`; id `<traceId>:<spanId>`; `traceId`, `spanId`, `service`,
/// `operation`, `kind`, `status`, `start` in milliseconds, `durationMs`), every span whose parent
/// is in the result an edge `CHILD` from the parent to it.
pub fn span_tree(trace: &TraceSet) -> GraphSet {
    let id = |t: &str, s: &str| format!("{t}:{s}");
    let present: HashSet<(&str, &str)> =
        trace.spans.iter().map(|s| (s.trace_id.as_str(), s.span_id.as_str())).collect();
    let nodes: Vec<Node> = trace
        .spans
        .iter()
        .map(|s| Node {
            id: id(&s.trace_id, &s.span_id),
            labels: vec![SPAN_LABEL.to_string()],
            properties: BTreeMap::from([
                ("traceId".to_string(), json!(s.trace_id)),
                ("spanId".to_string(), json!(s.span_id)),
                ("service".to_string(), json!(s.service)),
                ("operation".to_string(), json!(s.operation)),
                ("kind".to_string(), json!(s.kind.as_str())),
                ("status".to_string(), json!(s.status.as_str())),
                ("start".to_string(), json!(s.start.div_euclid(1000))),
                ("durationMs".to_string(), ms(s.duration)),
            ]),
        })
        .collect();
    let edges: Vec<Edge> = trace
        .spans
        .iter()
        .filter_map(|s| {
            let parent = s.parent_span_id.as_deref()?;
            present.contains(&(s.trace_id.as_str(), parent)).then(|| Edge {
                id: format!("{} -> {}", id(&s.trace_id, parent), id(&s.trace_id, &s.span_id)),
                edge_type: CHILD_TYPE.to_string(),
                from: id(&s.trace_id, parent),
                to: id(&s.trace_id, &s.span_id),
                properties: BTreeMap::new(),
            })
        })
        .collect();
    let keys = ["durationMs", "kind", "operation", "service", "spanId", "start", "status", "traceId"];
    let schema = GraphSchema {
        labels: if nodes.is_empty() { vec![] } else { vec![SPAN_LABEL.to_string()] },
        edge_types: if edges.is_empty() { vec![] } else { vec![CHILD_TYPE.to_string()] },
        property_keys: if nodes.is_empty() {
            BTreeMap::new()
        } else {
            BTreeMap::from([(SPAN_LABEL.to_string(), keys.iter().map(|k| k.to_string()).collect())])
        },
    };
    GraphSet {
        nodes,
        edges,
        paths: None,
        schema,
        truncated: trace.truncated.clone(),
        notices: Some(trace.notices.clone()).filter(|n| !n.is_empty()),
        suggested: None,
    }
}

fn field(name: &str, field_type: FieldType, unit: Option<&str>, values: Vec<Value>) -> Field {
    Field { name: name.to_string(), field_type, unit: unit.map(str::to_string), values, labels: None }
}

fn ms(us: f64) -> Value {
    super::expr::to_json(super::expr::V::Num(us / 1000.0))
}

fn object(map: &BTreeMap<String, Value>) -> Value {
    Value::Object(map.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
}

/// One row per span: ids, service, operation, start (time), duration in milliseconds, status,
/// kind, the attributes, resource, events and links as JSON, and one column per asked attribute
/// key (span attributes first, then the resource), typed by its values. An attribute whose key is
/// one of the fixed columns is named `attributes.<key>`.
pub fn span_table(trace: &TraceSet, attributes: &[String]) -> Frame {
    let spans = &trace.spans;
    let text = |f: &dyn Fn(&crate::shapes::Span) -> Option<String>| -> Vec<Value> {
        spans.iter().map(|s| f(s).map_or(Value::Null, Value::String)).collect()
    };
    let mut fields = vec![
        field("traceId", FieldType::String, None, text(&|s| Some(s.trace_id.clone()))),
        field("spanId", FieldType::String, None, text(&|s| Some(s.span_id.clone()))),
        field("parentSpanId", FieldType::String, None, text(&|s| s.parent_span_id.clone())),
        field("service", FieldType::String, None, text(&|s| Some(s.service.clone()))),
        field("operation", FieldType::String, None, text(&|s| Some(s.operation.clone()))),
        // Frames count time in milliseconds; the microseconds stay in the trace.
        field("start", FieldType::Time, None, spans.iter().map(|s| json!(s.start.div_euclid(1000))).collect()),
        field("duration", FieldType::Number, Some("ms"), spans.iter().map(|s| ms(s.duration)).collect()),
        field("status", FieldType::String, None, text(&|s| Some(s.status.as_str().to_string()))),
        field("statusMessage", FieldType::String, None, text(&|s| s.status_message.clone())),
        field("kind", FieldType::String, None, text(&|s| Some(s.kind.as_str().to_string()))),
        field("attributes", FieldType::Json, None, spans.iter().map(|s| object(&s.attributes)).collect()),
        field("resource", FieldType::Json, None, spans.iter().map(|s| object(&s.resource)).collect()),
        field(
            "events",
            FieldType::Json,
            None,
            spans.iter().map(|s| serde_json::to_value(&s.events).unwrap_or(Value::Null)).collect(),
        ),
        field(
            "links",
            FieldType::Json,
            None,
            spans.iter().map(|s| serde_json::to_value(&s.links).unwrap_or(Value::Null)).collect(),
        ),
    ];
    for key in attributes {
        let values: Vec<Value> = spans
            .iter()
            .map(|s| s.attributes.get(key).or_else(|| s.resource.get(key)).cloned().unwrap_or(Value::Null))
            .collect();
        let name = if SPAN_COLUMNS.contains(&key.as_str()) { format!("attributes.{key}") } else { key.clone() };
        fields.push(field(&name, column_type(&values), None, values));
    }
    let meta = FrameMeta {
        executed_query: trace.executed_query.clone(),
        rows_truncated: trace.truncated.is_some(),
        notices: trace.notices.clone(),
    };
    Frame::new(fields).expect("a span table has one value per span in every field").with_meta(meta)
}

/// The narrowest type that holds every value of an attribute column; JSON when they differ.
fn column_type(values: &[Value]) -> FieldType {
    let mut seen: Option<FieldType> = None;
    for v in values {
        let t = match v {
            Value::Null => continue,
            Value::Bool(_) => FieldType::Bool,
            Value::Number(_) => FieldType::Number,
            Value::String(_) => FieldType::String,
            _ => FieldType::Json,
        };
        match seen {
            None => seen = Some(t),
            Some(s) if s == t => {}
            Some(_) => return FieldType::Json,
        }
    }
    seen.unwrap_or(FieldType::String)
}

#[derive(Default)]
struct ServiceStats {
    spans: u64,
    errors: u64,
}

#[derive(Default)]
struct CallStats {
    calls: u64,
    errors: u64,
    total_us: f64,
    max_us: f64,
}

/// The services as nodes (`Service`, id and `name` the service, `spans` and `errors` it
/// recorded) and the calls between them as edges (`CALLS`, from the service of the parent span to
/// the service of the child span): `calls`, `errors` (child spans with status error), and the
/// child spans' `durationTotalMs`, `durationMeanMs` and `durationMaxMs`. A span whose parent is
/// in the same service or not in the result is no call.
pub fn service_map(trace: &TraceSet) -> GraphSet {
    let mut services: BTreeMap<&str, ServiceStats> = BTreeMap::new();
    let by_id: HashMap<(&str, &str), &str> =
        trace.spans.iter().map(|s| ((s.trace_id.as_str(), s.span_id.as_str()), s.service.as_str())).collect();
    let mut calls: BTreeMap<(&str, &str), CallStats> = BTreeMap::new();
    for span in &trace.spans {
        let error = span.status == SpanStatus::Error;
        let stats = services.entry(span.service.as_str()).or_default();
        stats.spans += 1;
        stats.errors += u64::from(error);
        let Some(parent) = span.parent_span_id.as_deref() else { continue };
        let Some(&caller) = by_id.get(&(span.trace_id.as_str(), parent)) else { continue };
        if caller == span.service {
            continue;
        }
        let call = calls.entry((caller, span.service.as_str())).or_default();
        call.calls += 1;
        call.errors += u64::from(error);
        call.total_us += span.duration;
        call.max_us = call.max_us.max(span.duration);
    }
    let mut names: Vec<&str> = services.keys().copied().collect();
    names.sort_by(|a, b| text_order(a, b));
    let nodes: Vec<Node> = names
        .iter()
        .map(|name| {
            let stats = &services[name];
            Node {
                id: (*name).to_string(),
                labels: vec![SERVICE_LABEL.to_string()],
                properties: BTreeMap::from([
                    ("name".to_string(), json!(name)),
                    ("spans".to_string(), json!(stats.spans)),
                    ("errors".to_string(), json!(stats.errors)),
                ]),
            }
        })
        .collect();
    let mut pairs: Vec<(&(&str, &str), &CallStats)> = calls.iter().collect();
    pairs.sort_by(|a, b| text_order(a.0.0, b.0.0).then_with(|| text_order(a.0.1, b.0.1)));
    let edges: Vec<Edge> = pairs
        .into_iter()
        .map(|((from, to), c)| Edge {
            id: format!("{from} -> {to}"),
            edge_type: CALLS_TYPE.to_string(),
            from: (*from).to_string(),
            to: (*to).to_string(),
            properties: BTreeMap::from([
                ("calls".to_string(), json!(c.calls)),
                ("errors".to_string(), json!(c.errors)),
                ("durationTotalMs".to_string(), ms(c.total_us)),
                ("durationMeanMs".to_string(), ms(c.total_us / c.calls as f64)),
                ("durationMaxMs".to_string(), ms(c.max_us)),
            ]),
        })
        .collect();
    let schema = GraphSchema {
        labels: if nodes.is_empty() { vec![] } else { vec![SERVICE_LABEL.to_string()] },
        edge_types: if edges.is_empty() { vec![] } else { vec![CALLS_TYPE.to_string()] },
        property_keys: if nodes.is_empty() {
            BTreeMap::new()
        } else {
            let keys: BTreeSet<String> = ["errors", "name", "spans"].into_iter().map(String::from).collect();
            BTreeMap::from([(SERVICE_LABEL.to_string(), keys.into_iter().collect())])
        },
    };
    GraphSet {
        nodes,
        edges,
        paths: None,
        schema,
        truncated: trace.truncated.clone(),
        notices: Some(trace.notices.clone()).filter(|n| !n.is_empty()),
        suggested: None,
    }
}

#[cfg(test)]
pub(crate) use tests::fixture;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shapes::{SpanEvent, SpanLink, Truncated};

    /// The fixture of docs/guide/traces.md: a checkout through a frontend, the cart and the
    /// payment service, which fails once.
    pub(crate) fn fixture() -> TraceSet {
        let span = |trace: &str, id: &str, parent: Option<&str>, service: &str, op: &str, start: i64, dur: f64| Span {
            trace_id: trace.into(),
            span_id: id.into(),
            parent_span_id: parent.map(str::to_string),
            service: service.into(),
            operation: op.into(),
            start,
            duration: dur,
            status: SpanStatus::Unset,
            status_message: None,
            kind: SpanKind::Server,
            attributes: BTreeMap::new(),
            resource: BTreeMap::new(),
            scope: None,
            events: vec![],
            links: vec![],
        };
        let t1 = "0af7651916cd43dd8448eb211c80319c";
        let t2 = "4bf92f3577b34da6a3ce929d0e0e4736";
        let mut root =
            span(t1, "a000000000000001", None, "frontend", "POST /checkout", 1_800_000_000_000_000, 120_000.0);
        root.attributes.insert("http.status_code".into(), json!(500));
        root.resource.insert("host.name".into(), json!("web-1"));
        let mut cart =
            span(t1, "a000000000000002", Some("a000000000000001"), "cart", "GetCart", 1_800_000_000_010_000, 20_000.0);
        cart.kind = SpanKind::Client;
        let inner =
            span(t1, "a000000000000003", Some("a000000000000002"), "cart", "redis GET", 1_800_000_000_012_000, 1_500.5);
        let mut pay = span(
            t1,
            "a000000000000004",
            Some("a000000000000001"),
            "payment",
            "Charge",
            1_800_000_000_040_000,
            60_000.0,
        );
        pay.status = SpanStatus::Error;
        pay.status_message = Some("card declined".into());
        pay.events.push(SpanEvent {
            time: 1_800_000_000_090_000,
            name: "exception".into(),
            attributes: BTreeMap::new(),
        });
        let mut root2 =
            span(t2, "b000000000000001", None, "frontend", "POST /checkout", 1_800_000_001_000_000, 50_000.0);
        root2.attributes.insert("http.status_code".into(), json!(200));
        root2.links.push(SpanLink {
            trace_id: t1.into(),
            span_id: "a000000000000001".into(),
            attributes: BTreeMap::new(),
        });
        let mut pay2 = span(
            t2,
            "b000000000000002",
            Some("b000000000000001"),
            "payment",
            "Charge",
            1_800_000_001_005_000,
            40_000.0,
        );
        pay2.status = SpanStatus::Ok;
        // Its parent is not in the result: no call.
        let orphan =
            span(t2, "b000000000000003", Some("ffffffffffffffff"), "audit", "Write", 1_800_000_001_006_000, 1_000.0);
        TraceSet {
            spans: vec![root, cart, inner, pay, root2, pay2, orphan],
            truncated: None,
            notices: vec![],
            executed_query: Some("{ resource.service.name = \"frontend\" }".into()),
        }
    }

    fn values<'a>(frame: &'a Frame, name: &str) -> &'a [Value] {
        &frame.fields().iter().find(|f| f.name == name).unwrap_or_else(|| panic!("no field {name}")).values
    }

    #[test]
    fn a_span_table_has_one_row_per_span() {
        let trace = fixture();
        let frame = span_table(&trace, &["http.status_code".into(), "host.name".into(), "service".into()]);
        assert_eq!(frame.rows(), 7);
        let names: Vec<&str> = frame.fields().iter().map(|f| f.name.as_str()).collect();
        let mut expected: Vec<&str> = SPAN_COLUMNS.to_vec();
        expected.extend(["http.status_code", "host.name", "attributes.service"]);
        assert_eq!(names, expected);
        assert_eq!(values(&frame, "start")[0], json!(1_800_000_000_000_i64));
        assert_eq!(values(&frame, "duration")[2], json!(1.5005));
        assert_eq!(frame.fields()[6].unit.as_deref(), Some("ms"));
        assert_eq!(values(&frame, "parentSpanId")[0], Value::Null);
        assert_eq!(values(&frame, "parentSpanId")[1], json!("a000000000000001"));
        assert_eq!(values(&frame, "status")[3], json!("error"));
        assert_eq!(values(&frame, "statusMessage")[3], json!("card declined"));
        assert_eq!(values(&frame, "kind")[1], json!("client"));
        assert_eq!(values(&frame, "events")[3][0]["name"], json!("exception"));
        assert_eq!(values(&frame, "links")[4][0]["spanId"], json!("a000000000000001"));
        assert_eq!(values(&frame, "resource")[0], json!({ "host.name": "web-1" }));
        // Asked attributes: typed by their values, from the resource when the span has none.
        let status = frame.fields().iter().find(|f| f.name == "http.status_code").unwrap();
        assert_eq!(status.field_type, FieldType::Number);
        assert_eq!(status.values[..2], [json!(500), Value::Null]);
        assert_eq!(values(&frame, "host.name")[0], json!("web-1"));
        let meta = frame.meta().unwrap();
        assert_eq!(meta.executed_query.as_deref(), Some("{ resource.service.name = \"frontend\" }"));
        assert!(!meta.rows_truncated);
    }

    #[test]
    fn a_cut_trace_makes_a_cut_table_and_map() {
        let mut trace = fixture();
        trace.truncated = Some(Truncated { limit: 7, reason: Some("trace.span_limit".into()) });
        assert!(span_table(&trace, &[]).meta().unwrap().rows_truncated);
        assert_eq!(service_map(&trace).truncated, trace.truncated);
        let empty = span_table(&TraceSet::default(), &["x".into()]);
        assert_eq!(empty.rows(), 0);
        assert_eq!(empty.fields().last().unwrap().field_type, FieldType::String);
    }

    #[test]
    fn a_service_map_counts_calls_between_services() {
        let graph = service_map(&fixture());
        let ids: Vec<&str> = graph.nodes.iter().map(|n| n.id.as_str()).collect();
        assert_eq!(ids, ["audit", "cart", "frontend", "payment"]);
        let frontend = &graph.nodes[2];
        assert_eq!(frontend.labels, [SERVICE_LABEL]);
        assert_eq!(frontend.properties["spans"], json!(2));
        assert_eq!(graph.nodes[3].properties["errors"], json!(1));
        let edges: Vec<(&str, &str)> = graph.edges.iter().map(|e| (e.from.as_str(), e.to.as_str())).collect();
        // cart -> cart (redis GET) stays inside the service; audit's parent is not there.
        assert_eq!(edges, [("frontend", "cart"), ("frontend", "payment")]);
        let pay = &graph.edges[1];
        assert_eq!(pay.edge_type, CALLS_TYPE);
        assert_eq!(pay.id, "frontend -> payment");
        assert_eq!(pay.properties["calls"], json!(2));
        assert_eq!(pay.properties["errors"], json!(1));
        assert_eq!(pay.properties["durationTotalMs"], json!(100.0));
        assert_eq!(pay.properties["durationMeanMs"], json!(50.0));
        assert_eq!(pay.properties["durationMaxMs"], json!(60.0));
        assert_eq!(graph.schema.labels, [SERVICE_LABEL]);
        assert_eq!(graph.schema.edge_types, [CALLS_TYPE]);
        assert_eq!(graph.schema.property_keys[SERVICE_LABEL], ["errors", "name", "spans"]);
        let empty = service_map(&TraceSet::default());
        assert!(empty.nodes.is_empty() && empty.schema.labels.is_empty());
    }

    #[test]
    fn a_trace_table_has_one_row_per_trace() {
        let frame = trace_table(&fixture());
        assert_eq!(frame.rows(), 2);
        assert_eq!(values(&frame, "traceId")[0], json!("0af7651916cd43dd8448eb211c80319c"));
        assert_eq!(values(&frame, "rootService")[0], json!("frontend"));
        assert_eq!(values(&frame, "rootOperation")[1], json!("POST /checkout"));
        assert_eq!(values(&frame, "duration")[0], json!(120.0));
        assert_eq!(values(&frame, "spans"), [json!(4), json!(3)]);
        assert_eq!(values(&frame, "errors"), [json!(1), json!(0)]);
        assert_eq!(values(&frame, "services"), [json!(3), json!(3)]);
        // The second trace's orphan has no parent in it, but the earliest such span is the root.
        assert_eq!(values(&frame, "start")[1], json!(1_800_000_001_000_i64));
    }

    #[test]
    fn a_span_tree_links_parents_to_children() {
        let graph = span_tree(&fixture());
        assert_eq!(graph.nodes.len(), 7);
        assert_eq!(graph.nodes[0].id, "0af7651916cd43dd8448eb211c80319c:a000000000000001");
        assert_eq!(graph.nodes[0].properties["durationMs"], json!(120.0));
        assert_eq!(graph.edges.len(), 4, "the orphan's parent is missing");
        assert!(graph.edges.iter().all(|e| e.edge_type == CHILD_TYPE));
        assert_eq!(graph.edges[0].to, "0af7651916cd43dd8448eb211c80319c:a000000000000002");
        assert_eq!(graph.schema.labels, [SPAN_LABEL]);
    }

    #[test]
    fn filters_keep_spans_that_pass_every_condition() {
        let trace = fixture();
        let control = Control::unbounded();
        let run = |raw: Value| {
            let step = crate::analysis::parse_step(&raw).unwrap();
            let TraceOut::Trace(out) = apply(&step.kind, &trace, &control).unwrap() else { panic!("a trace") };
            out.spans.iter().map(|s| s.span_id.clone()).collect::<Vec<_>>()
        };
        let base = |extra: Value| {
            let mut v = json!({ "id": "f", "type": "filterSpans", "frame": "A" });
            v.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
            v
        };
        assert_eq!(run(base(json!({ "status": "error" }))), ["a000000000000004"]);
        assert_eq!(run(base(json!({ "services": ["cart"] }))), ["a000000000000002", "a000000000000003"]);
        assert_eq!(run(base(json!({ "minDurationMs": 50, "services": ["payment"] }))), ["a000000000000004"]);
        assert_eq!(run(base(json!({ "kinds": ["client"] }))), ["a000000000000002"]);
        assert_eq!(
            run(base(json!({ "attribute": { "key": "http.status_code", "op": "gte", "value": 500 } }))),
            ["a000000000000001"]
        );
        assert_eq!(
            run(base(json!({ "attribute": { "key": "host.name", "op": "eq", "value": "web-1" } }))),
            ["a000000000000001"],
            "resource attributes count too"
        );
        assert_eq!(run(base(json!({}))).len(), 7);
    }

    /// The checkout: the frontend waits for the payment (40 to 100 ms) after the cart (10 to 30
    /// ms); the Redis call inside the cart is on the path too. The second trace's root waits for
    /// its payment; the orphan has no parent in the trace and is a root of its own, not the first.
    #[test]
    fn the_critical_path_follows_the_last_finished_child() {
        let trace = fixture();
        let path = critical_path(&trace).0;
        let mut ids: Vec<&str> = path.iter().map(|(_, s)| *s).collect();
        ids.sort();
        assert_eq!(
            ids,
            [
                "a000000000000001",
                "a000000000000002",
                "a000000000000003",
                "a000000000000004",
                "b000000000000001",
                "b000000000000002"
            ]
        );
        // A child running in parallel with a slower sibling is not on the path.
        let mut parallel = fixture();
        parallel.spans.truncate(4);
        parallel.spans[1].start = parallel.spans[3].start + 1000;
        parallel.spans[1].duration = 1000.0;
        parallel.spans[2].start = parallel.spans[1].start;
        parallel.spans[2].duration = 500.0;
        let path = critical_path(&parallel).0;
        assert!(!path.iter().any(|(_, s)| *s == "a000000000000002"), "{path:?}");
        assert!(path.iter().any(|(_, s)| *s == "a000000000000004"));
    }

    #[test]
    fn large_graphs_of_a_trace_need_a_confirmation() {
        let mut trace = fixture();
        let one = trace.spans[0].clone();
        trace.spans = vec![one; MAX_GRAPH_SPANS + 1];
        let control = Control::unbounded();
        let map = |confirm: bool| StepKind::ServiceMap { frame: "A".into(), confirm_large: confirm };
        let tree = |confirm: bool| StepKind::SpanTree { frame: "A".into(), confirm_large: confirm };
        for (step, name) in [(map as fn(bool) -> StepKind, "serviceMap"), (tree, "spanTree")] {
            let refused = apply(&step(false), &trace, &control).unwrap_err();
            assert_eq!(refused.reason, "steps.trace_graph_large");
            assert_eq!(refused.params["spans"], (MAX_GRAPH_SPANS + 1).to_string());
            assert_eq!(refused.params["step"], name);
            assert!(matches!(apply(&step(true), &trace, &control), Ok(TraceOut::Graph(_))));
        }
    }

    /// A trace whose parents form a cycle, or whose spans name themselves as their parent, has no
    /// root: its critical path starts at its earliest span, and a notice says so.
    #[test]
    fn a_trace_without_a_root_starts_at_its_earliest_span() {
        let mut trace = fixture();
        trace.spans.truncate(4);
        // A cycle: the root now has the payment as its parent.
        trace.spans[0].parent_span_id = Some("a000000000000004".into());
        let control = Control::unbounded();
        let TraceOut::Trace(out) = apply(&StepKind::CriticalPath { frame: "A".into() }, &trace, &control).unwrap()
        else {
            panic!("a trace")
        };
        assert_eq!(out.spans[0].span_id, "a000000000000001", "the earliest span starts the path");
        assert_eq!(out.spans.len(), 4);
        let notice = out.notices.iter().find(|n| n.code == "trace.no_root").expect("a notice");
        assert_eq!(notice.params.as_ref().unwrap()["count"], "1");

        // Self-parents only: every span names itself.
        let mut selfish = fixture();
        selfish.spans.truncate(2);
        for s in &mut selfish.spans {
            s.parent_span_id = Some(s.span_id.clone());
        }
        let (path, rootless) = critical_path(&selfish);
        assert_eq!(rootless, 1);
        assert_eq!(path.len(), 1, "no span is a child of itself: only the earliest one");
        assert!(path.contains(&(selfish.spans[0].trace_id.as_str(), "a000000000000001")));
        let (_, rootless) = critical_path(&fixture());
        assert_eq!(rootless, 0);
    }

    /// OTLP JSON out, OTLP JSON in: the same spans.
    #[test]
    fn otlp_json_round_trips() {
        let mut trace = fixture();
        trace.spans[0].scope = Some(crate::shapes::SpanScope { name: "shop-sdk".into(), version: Some("2.1".into()) });
        trace.spans[0].attributes.insert("ratio".into(), json!(0.25));
        trace.spans[0].attributes.insert("tags".into(), json!(["a", true]));
        let otlp = to_otlp(&trace);
        assert_eq!(otlp["resourceSpans"][0]["resource"]["attributes"][0]["key"], "service.name");
        let mut builder =
            crate::datasources::traces::TraceBuilder::new(crate::datasources::frame::ResponseBudget::new(1 << 24));
        assert!(crate::datasources::traces::otlp_spans(&otlp, &mut builder));
        assert_eq!(builder.finish().spans, trace.spans);
    }

    fn steps(raw: Value) -> Vec<crate::analysis::Step> {
        crate::analysis::check_steps(raw.as_array().unwrap(), &BTreeSet::from(["A", "B"]), "steps").unwrap()
    }

    fn run(raw: Value, input: Input) -> Result<crate::analysis::steps::Outputs, crate::analysis::steps::StepFailure> {
        crate::analysis::steps::run_outputs(
            &steps(raw),
            vec![("A".into(), input)],
            &Control::unbounded(),
            &BTreeSet::new(),
        )
    }

    use crate::analysis::steps::Input;

    #[test]
    fn trace_steps_are_checked_where_they_are_stored() {
        let ok = json!([
            { "id": "s1", "type": "spanTable", "frame": "A", "attributes": ["http.status_code"] },
            { "id": "s2", "type": "serviceMap", "frame": "B" }
        ]);
        let parsed = steps(ok);
        assert!(parsed.iter().all(|s| s.kind.is_trace_step() && s.kind.runs_with_query() && !s.kind.is_graph_step()));
        let check = |raw: Value| crate::analysis::check_steps(raw.as_array().unwrap(), &BTreeSet::from(["A"]), "steps");
        assert!(check(json!([{ "id": "s", "type": "spanTable", "frame": "A" }])).is_ok(), "attributes are optional");
        for bad in [
            json!([{ "id": "s", "type": "spanTable", "frame": "A", "attributes": ["a", "a"] }]),
            json!([{ "id": "s", "type": "spanTable", "frame": "A", "attributes": [""] }]),
            json!([{ "id": "s", "type": "serviceMap", "frame": "A", "extra": 1 }]),
            json!([{ "id": "s", "type": "serviceMap", "frame": "Z" }]),
        ] {
            assert!(check(bad.clone()).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_trace_is_read_only_through_its_projections() {
        // The span table, then a frame step on it.
        let out = run(
            json!([
                { "id": "s1", "type": "spanTable", "frame": "A" },
                { "id": "s2", "type": "calculate", "frame": "A", "name": "slow", "expression": "duration > 50" }
            ]),
            Input::Trace(fixture()),
        )
        .unwrap();
        assert!(out.traces.is_empty());
        assert_eq!(out.frames[0].frame.rows(), 7);
        assert_eq!(out.frames[0].frame.fields().last().unwrap().name, "slow");
        // The service map, then a graph step on it.
        let out = run(
            json!([
                { "id": "s1", "type": "serviceMap", "frame": "A" },
                { "id": "s2", "type": "topDegree", "frame": "A", "n": 2 }
            ]),
            Input::Trace(fixture()),
        )
        .unwrap();
        assert_eq!(out.graphs[0].1.nodes.len(), 2);
        // No projection: the trace stays as it is, for an export in its own shape.
        let out = run(json!([]), Input::Trace(fixture())).unwrap();
        assert_eq!(out.traces[0].1.spans.len(), 7);
        // Any other step on a trace says what is missing.
        let failure = run(
            json!([{ "id": "s1", "type": "calculate", "frame": "A", "name": "x", "expression": "1" }]),
            Input::Trace(fixture()),
        )
        .err()
        .unwrap();
        assert_eq!(failure.detail.reason, "steps.trace_needs_projection");
        let failure =
            run(json!([{ "id": "s1", "type": "countLabels", "frame": "A" }]), Input::Trace(fixture())).err().unwrap();
        assert_eq!(failure.detail.reason, "steps.trace_needs_projection");
        // A trace step on what is no trace.
        let frame = span_table(&fixture(), &[]);
        let failure =
            run(json!([{ "id": "s1", "type": "serviceMap", "frame": "A" }]), Input::Frame(frame)).err().unwrap();
        assert_eq!(failure.detail.reason, "steps.not_trace");
    }
}
