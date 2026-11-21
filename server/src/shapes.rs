//! The result envelope: every query answers with exactly one native shape. Documents stay
//! documents and graphs stay graphs; turning them into a frame is an explicit projection step in
//! the query, never something the backend does on its own (docs/ARCHITECTURE.md).
//!
//! The UI's TypeScript types in `ui/src/api/generated/shapes.ts` are generated from these types
//! by the tests; a test fails when the file is stale (run `KALZIT_UPDATE_GENERATED=1 cargo test`).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum Shape {
    Frame,
    Documents,
    Graph,
    /// Spans of distributed traces (Tempo, Jaeger).
    Trace,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(tag = "shape", rename_all = "camelCase")]
pub enum QueryResult {
    Frame { frame: Frame },
    Documents { documents: DocumentSet },
    Graph { graph: GraphSet },
    Trace { trace: TraceSet },
}

impl QueryResult {
    pub fn shape(&self) -> Shape {
        match self {
            QueryResult::Frame { .. } => Shape::Frame,
            QueryResult::Documents { .. } => Shape::Documents,
            QueryResult::Graph { .. } => Shape::Graph,
            QueryResult::Trace { .. } => Shape::Trace,
        }
    }

    /// Removes what shows how a result was made rather than what it is, for people without an
    /// account (`sharing`): the executed statement, a document set's paging cursor and the
    /// notices, whose texts may come from the source. Truncation flags stay.
    pub fn strip_for_sharing(&mut self) {
        match self {
            QueryResult::Frame { frame } => {
                if let Some(meta) = &mut frame.meta {
                    meta.executed_query = None;
                    meta.notices.clear();
                }
            }
            QueryResult::Documents { documents } => {
                documents.executed_query = None;
                documents.next_cursor = None;
                documents.notices.clear();
            }
            QueryResult::Graph { graph } => graph.notices = None,
            QueryResult::Trace { trace } => {
                trace.executed_query = None;
                trace.notices.clear();
            }
        }
    }
}

/// Columnar table: every field holds one value per row.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct Frame {
    // Private, so every frame goes through `Frame::new` and its length check.
    fields: Vec<Field>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    meta: Option<FrameMeta>,
}

/// What arrives from outside (plugins, fixtures) before the length check.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UncheckedFrame {
    fields: Vec<Field>,
    #[serde(default)]
    meta: Option<FrameMeta>,
}

impl<'de> Deserialize<'de> for Frame {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = UncheckedFrame::deserialize(deserializer)?;
        let frame = Frame::new(raw.fields).map_err(serde::de::Error::custom)?;
        Ok(match raw.meta {
            Some(meta) => frame.with_meta(meta),
            None => frame,
        })
    }
}

impl Frame {
    /// A frame whose fields all have the same length; anything else is a bug in the source.
    pub fn new(fields: Vec<Field>) -> Result<Self, String> {
        if let Some(first) = fields.first() {
            let rows = first.values.len();
            if let Some(bad) = fields.iter().find(|f| f.values.len() != rows) {
                return Err(format!("field {} has {} values, expected {rows}", bad.name, bad.values.len()));
            }
        }
        Ok(Self { fields, meta: None })
    }

    pub fn with_meta(mut self, meta: FrameMeta) -> Self {
        self.meta = Some(meta);
        self
    }

    pub fn fields(&self) -> &[Field] {
        &self.fields
    }

    pub fn meta(&self) -> Option<&FrameMeta> {
        self.meta.as_ref()
    }

    pub fn rows(&self) -> usize {
        self.fields.first().map_or(0, |f| f.values.len())
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct FrameMeta {
    /// The statement as sent to the database after macros were expanded (shown in the inspector).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub executed_query: Option<String>,
    #[serde(default)]
    pub rows_truncated: bool,
    #[serde(default)]
    pub notices: Vec<Notice>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct Notice {
    pub severity: NoticeSeverity,
    /// A stable code the UI translates (see docs/api/datasources.md).
    pub code: String,
    /// Values the code's text needs (`{column}`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub params: Option<BTreeMap<String, String>>,
    /// English fallback.
    pub text: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum NoticeSeverity {
    Info,
    Warning,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum FieldType {
    /// Unix milliseconds.
    Time,
    Number,
    /// Integers beyond 2^53 as decimal strings, so JavaScript does not round them.
    Int64,
    String,
    Bool,
    Json,
    /// Exact decimal numbers (NUMERIC, DECIMAL, MONEY) as decimal strings such as "-1234.50",
    /// so no digit is rounded; charts draw the nearest double.
    Decimal,
    /// Calendar days without a time of day or zone (DATE), as Unix milliseconds of midnight UTC;
    /// shown as that day in every time zone.
    Date,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct Field {
    pub name: String,
    #[serde(rename = "type")]
    pub field_type: FieldType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub unit: Option<String>,
    /// One value per row; `null` where the row has no value.
    #[cfg_attr(test, ts(type = "unknown[]"))]
    pub values: Vec<Value>,
    /// Series labels, e.g. from Prometheus.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub labels: Option<BTreeMap<String, String>>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct DocumentSet {
    /// Documents with typed values (see `typed`) where JSON has no type for them, each in the
    /// field order the database stored.
    #[cfg_attr(test, ts(type = "unknown[]"))]
    pub documents: Vec<OrderedJson>,
    /// Sampled from the result: every field path with its types and how many documents have it.
    pub schema: Vec<FieldSchema>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub next_cursor: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub truncated: Option<Truncated>,
    /// Why the set was cut, values that are not shown, ... (codes as for frames).
    #[serde(default)]
    pub notices: Vec<Notice>,
    /// The query as sent, after macros and variables were bound (shown in the inspector).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub executed_query: Option<String>,
    /// The source computes field distributions over the whole result in the database
    /// (`POST /query/distribution`); without it, they count the loaded documents.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    #[cfg_attr(test, ts(as = "Option<bool>", optional))]
    pub distributable: bool,
}

/// One JSON value kept as its text, so the key order survives (`serde_json::Map` sorts keys).
/// Serializes as the JSON itself.
#[derive(Clone, Debug, Serialize)]
#[serde(transparent)]
pub struct OrderedJson(Box<serde_json::value::RawValue>);

impl OrderedJson {
    pub fn new(value: &impl Serialize) -> Result<Self, serde_json::Error> {
        serde_json::value::to_raw_value(value).map(Self)
    }

    /// JSON text as it is, in its own key order (a document from a plugin); fails when it is not
    /// valid JSON.
    pub fn from_text(text: String) -> Result<Self, serde_json::Error> {
        serde_json::value::RawValue::from_string(text).map(Self)
    }

    /// The JSON text.
    pub fn get(&self) -> &str {
        self.0.get()
    }
}

impl From<Value> for OrderedJson {
    fn from(value: Value) -> Self {
        Self::new(&value).expect("a JSON value always serializes")
    }
}

impl PartialEq for OrderedJson {
    fn eq(&self, other: &Self) -> bool {
        self.get() == other.get()
    }
}

#[cfg(test)]
impl OrderedJson {
    /// As a `Value`, for assertions (key order is not kept).
    pub fn value(&self) -> Value {
        serde_json::from_str(self.get()).expect("an OrderedJson holds valid JSON")
    }
}

#[cfg(test)]
impl PartialEq<Value> for OrderedJson {
    fn eq(&self, other: &Value) -> bool {
        self.value() == *other
    }
}

/// Deserializing goes through `Value`, so it works with any deserializer (a raw value needs
/// serde_json's own), but the key order is **not** kept there. No response path deserializes it:
/// the server only builds and serializes document sets; deserializing is for tests and clients.
impl<'de> Deserialize<'de> for OrderedJson {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Ok(Value::deserialize(deserializer)?.into())
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct FieldSchema {
    /// Dotted path; array elements as `[]` (`items[].price`).
    pub path: String,
    /// Share of documents that contain the path, 0 to 1.
    pub coverage: f64,
    pub types: Vec<TypeShare>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct TypeShare {
    pub name: String,
    /// Share of the documents with this path where the value has this type, 0 to 1.
    pub share: f64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct Truncated {
    pub limit: u32,
    /// Which limit cut the result (a notice code such as `graph.node_limit`), when known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub reason: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct GraphSet {
    pub nodes: Vec<Node>,
    pub edges: Vec<Edge>,
    /// Paths stay paths when the query returned them, instead of a loose set of edges.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub paths: Option<Vec<GraphPath>>,
    pub schema: GraphSchema,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub truncated: Option<Truncated>,
    /// What the source said about the result, such as columns that are not part of the graph.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub notices: Option<Vec<Notice>>,
    /// Edges a link prediction step suggests (`suggested: true`, with their `score`): no data of
    /// the source, so apart from `edges`. They are not counted, no later step reads them, and
    /// exports leave them out unless asked to take them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub suggested: Option<Vec<Edge>>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct Node {
    pub id: String,
    pub labels: Vec<String>,
    #[cfg_attr(test, ts(type = "Record<string, unknown>"))]
    pub properties: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct Edge {
    pub id: String,
    #[serde(rename = "type")]
    pub edge_type: String,
    pub from: String,
    pub to: String,
    #[cfg_attr(test, ts(type = "Record<string, unknown>"))]
    pub properties: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct GraphPath {
    pub nodes: Vec<String>,
    pub edges: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct GraphSchema {
    pub labels: Vec<String>,
    pub edge_types: Vec<String>,
    /// Property keys seen per label.
    pub property_keys: BTreeMap<String, Vec<String>>,
}

/// The spans of one or more distributed traces, in their native shape: a tree per trace through
/// `parentSpanId`, not a table. A table of spans (`spanTable`) and a service map (`serviceMap`)
/// are explicit steps (docs/guide/traces.md).
///
/// Times are Unix microseconds and durations microseconds: exact in a JavaScript number (a
/// nanosecond clock is not), and fine enough for spans.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct TraceSet {
    /// By trace, then by start time; parents may be missing when the source did not send them.
    pub spans: Vec<Span>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub truncated: Option<Truncated>,
    /// What the source said about the result, such as a trace that was cut (codes as for frames).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[cfg_attr(test, ts(as = "Option<Vec<Notice>>", optional))]
    pub notices: Vec<Notice>,
    /// The query as sent, after macros and variables were bound (shown in the inspector).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub executed_query: Option<String>,
}

/// One span. Ids are lowercase hex as the source sends them (trace ids 32, span ids 16 digits).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct Span {
    pub trace_id: String,
    pub span_id: String,
    /// None for a root span.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub parent_span_id: Option<String>,
    /// The service that recorded the span (`service.name`).
    pub service: String,
    /// The operation (the span's name).
    pub operation: String,
    /// Unix microseconds.
    pub start: i64,
    /// Microseconds; fractions keep the nanoseconds of very short spans.
    pub duration: f64,
    pub status: SpanStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub status_message: Option<String>,
    pub kind: SpanKind,
    /// Span attributes (Jaeger: tags), typed as the source sent them.
    #[cfg_attr(test, ts(type = "Record<string, unknown>"))]
    pub attributes: BTreeMap<String, Value>,
    /// Attributes of the process or resource that recorded the span (`service.name` excluded).
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    #[cfg_attr(test, ts(type = "Record<string, unknown>", optional))]
    pub resource: BTreeMap<String, Value>,
    /// The instrumentation scope (library) that recorded the span, when the source names one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub scope: Option<SpanScope>,
    #[serde(default)]
    pub events: Vec<SpanEvent>,
    #[serde(default)]
    pub links: Vec<SpanLink>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum SpanStatus {
    #[default]
    Unset,
    Ok,
    Error,
}

impl SpanStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            SpanStatus::Unset => "unset",
            SpanStatus::Ok => "ok",
            SpanStatus::Error => "error",
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum SpanKind {
    #[default]
    Unspecified,
    Internal,
    Server,
    Client,
    Producer,
    Consumer,
}

impl SpanKind {
    pub fn as_str(self) -> &'static str {
        match self {
            SpanKind::Unspecified => "unspecified",
            SpanKind::Internal => "internal",
            SpanKind::Server => "server",
            SpanKind::Client => "client",
            SpanKind::Producer => "producer",
            SpanKind::Consumer => "consumer",
        }
    }
}

/// The instrumentation scope of a span (OpenTelemetry: `InstrumentationScope`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct SpanScope {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub version: Option<String>,
}

/// Something that happened during a span (Jaeger: a log).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct SpanEvent {
    /// Unix microseconds.
    pub time: i64,
    pub name: String,
    #[serde(default)]
    #[cfg_attr(test, ts(type = "Record<string, unknown>"))]
    pub attributes: BTreeMap<String, Value>,
}

/// A reference to another span, in this trace or another (Jaeger: a reference other than the
/// parent).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct SpanLink {
    pub trace_id: String,
    pub span_id: String,
    #[serde(default)]
    #[cfg_attr(test, ts(type = "Record<string, unknown>"))]
    pub attributes: BTreeMap<String, Value>,
}

/// `POST /api/orgs/{orgId}/query`: free queries, for members with `datasources:query`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QueryRequest {
    pub queries: Vec<QueryItem>,
    pub time_range: TimeRange,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub interval_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub max_data_points: Option<u32>,
    /// Variable values: bound as parameters in SQL, escaped into strings in PromQL, and checked
    /// against the schema when used as identifiers (docs/api/datasources.md).
    #[serde(default)]
    #[cfg_attr(test, ts(type = "Record<string, unknown>"))]
    pub variables: BTreeMap<String, Value>,
    /// Set by Explore: the successful queries of this run go to the caller's Explore history
    /// (docs/api/explore-history.md). Dashboard panels never set it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub explore: Option<bool>,
    /// Runs every query in its source even when the server's query cache holds its answer, and
    /// keeps the new answer ("Refresh"). `Cache-Control: no-cache` does the same.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub refresh: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QueryItem {
    pub ref_id: String,
    pub datasource_id: String,
    /// The source's own query (SQL text, PromQL, a pipeline); each plugin defines its form.
    #[cfg_attr(test, ts(type = "unknown"))]
    pub query: Value,
    /// Continues a `DocumentSet` from its `nextCursor`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub cursor: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub limit: Option<u32>,
    /// Graph steps on this query's result (`countLabels`, `topDegree`, ...; docs/api/datasources.md),
    /// all of this query, in order. The first runs in the database when the source can, the others
    /// on the server; the answer is the result after them, with `steps` saying where each ran.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[cfg_attr(test, ts(type = "unknown[]", optional))]
    pub steps: Vec<Value>,
}

/// Where a graph step of a query ran, and why it failed when it did (the result is then the one
/// before it).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct StepPlace {
    pub id: String,
    pub ran_in: RanIn,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub error: Option<ErrorBody>,
    /// What a graph algorithm step found, in plain language the UI translates.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub summary: Option<StepSummary>,
    /// Why a graph algorithm step ran on the server (`algorithm.no_library`, ...; see
    /// docs/api/settings-dashboards.md, "Graph algorithm steps").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub reason: Option<String>,
}

impl StepPlace {
    pub fn new(id: impl Into<String>, ran_in: RanIn) -> Self {
        Self { id: id.into(), ran_in, error: None, summary: None, reason: None }
    }
}

/// The plain-language summary of a step's result: a translation key (`analysis.summary.*`) and
/// the values its text needs ("3 Communities, Modularität 0,41").
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct StepSummary {
    pub key: String,
    #[cfg_attr(test, ts(type = "Record<string, unknown>"))]
    pub values: BTreeMap<String, Value>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum RanIn {
    /// In the data source, as generated read-only Cypher around the query.
    Database,
    Server,
}

/// `POST /api/orgs/{orgId}/dashboards/{dashboardId}/panels/{panelId}/query`: runs the panel's
/// stored queries; all a viewer can run (`dashboards:read` on that dashboard).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PanelQueryRequest {
    pub time_range: TimeRange,
    /// Continues the `DocumentSet` of a target, by `refId`.
    #[serde(default)]
    pub cursors: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub limit: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub interval_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub max_data_points: Option<u32>,
    #[serde(default)]
    #[cfg_attr(test, ts(type = "Record<string, unknown>"))]
    pub variables: BTreeMap<String, Value>,
    /// As `QueryRequest::refresh`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub refresh: Option<bool>,
}

/// Live updates (`GET /api/orgs/{orgId}/live`, a WebSocket; docs/api/live.md): subscribes to a
/// panel's stored queries (`panel`) or to free queries (`queries`), exactly one of them, over a
/// fixed `timeRange` or the last `lastMs` before each run.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LiveSubscribe {
    #[serde(rename = "type")]
    pub kind: LiveSubscribeType,
    /// The client's name for the subscription, 1 to 64 characters; messages about it carry it.
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub panel: Option<LivePanel>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub queries: Option<Vec<QueryItem>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub time_range: Option<TimeRange>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub last_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub interval_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub max_data_points: Option<u32>,
    /// The panel's row limit (free queries carry their own `limit`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub limit: Option<u32>,
    #[serde(default)]
    #[cfg_attr(test, ts(type = "Record<string, unknown>"))]
    pub variables: BTreeMap<String, Value>,
    /// How often to run the queries when the source cannot report changes; the server's
    /// minimum applies.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub refresh_ms: Option<u64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum LiveSubscribeType {
    Subscribe,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LivePanel {
    pub dashboard_id: String,
    pub panel_id: String,
}

/// Ends a subscription; an unknown `id` is ignored.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LiveUnsubscribe {
    #[serde(rename = "type")]
    pub kind: LiveUnsubscribeType,
    pub id: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum LiveUnsubscribeType {
    Unsubscribe,
}

/// How a subscription learns of new data: the source reports changes, or the server runs the
/// queries every `refreshMs`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum LiveMode {
    Changes,
    Poll,
}

/// What the server sends on a live connection.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum LiveMessage {
    /// The subscription `id` follows the feed `feed`: its `status` and `result` messages are the
    /// subscription's. Sent after subscribing and when the subscription moves to another feed (its
    /// panel was edited); subscriptions with the same queries share a feed.
    Subscribed { id: String, feed: String },
    /// The feed's mode, when it starts or changes. `reason` says why a feed polls although it
    /// wanted changes (`live.source_unsupported`, ...).
    Status {
        feed: String,
        mode: LiveMode,
        refresh_ms: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(test, ts(optional))]
        reason: Option<String>,
    },
    /// New results, as `POST /query` answers them; sent first after subscribing and then
    /// whenever they differ. `at` is when the queries ran (Unix milliseconds).
    Result { feed: String, at: i64, results: BTreeMap<String, QueryOutcome> },
    /// A refused subscription, or one that ended (access revoked). Without `id`, a message that
    /// was not understood.
    Error {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(test, ts(optional))]
        id: Option<String>,
        error: ErrorBody,
    },
    /// The server closes the connection right after this; `error.reason` says why.
    Closing { error: ErrorBody },
}

/// `POST /api/orgs/{orgId}/dashboards/{dashboardId}/variables/{name}/options`: runs the stored
/// query of a query-type variable (same access as the panel route).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VariableOptionsRequest {
    pub time_range: TimeRange,
    /// The other variables' current values; the variable's own name is refused.
    #[serde(default)]
    #[cfg_attr(test, ts(type = "Record<string, unknown>"))]
    pub variables: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct VariableOption {
    pub value: String,
    pub label: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct VariableOptionsResponse {
    /// Distinct by `value`, in the order the query returned them.
    pub options: Vec<VariableOption>,
    /// True when the list was cut at the option limit or the query's row limit.
    pub truncated: bool,
}

/// `POST /api/orgs/{orgId}/query/distribution`: how the values of one field path are spread
/// over the whole result of a free query, computed in the database. Needs `datasources:query` on
/// the data source, as running the query does.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DistributionRequest {
    pub datasource_id: String,
    #[cfg_attr(test, ts(type = "unknown"))]
    pub query: Value,
    pub time_range: TimeRange,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub interval_ms: Option<u64>,
    #[serde(default)]
    #[cfg_attr(test, ts(type = "Record<string, unknown>"))]
    pub variables: BTreeMap<String, Value>,
    /// The field path as its keys, unescaped (a key may hold dots, `$` or any character); `null`
    /// stands for "every element of the array here", as `[]` in a schema path: `items[].price` is
    /// `["items", null, "price"]`.
    pub path: Vec<Option<String>>,
    /// Most common values to answer, 1 to 100 (10).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub top: Option<u32>,
    /// Histogram bins for numbers and dates, 1 to 100 (20).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub bins: Option<u32>,
}

/// `POST /api/orgs/{orgId}/dashboards/{dashboardId}/panels/{panelId}/distribution`: the same for
/// a stored target of a panel, for whoever may read the dashboard.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PanelDistributionRequest {
    pub ref_id: String,
    pub time_range: TimeRange,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub interval_ms: Option<u64>,
    #[serde(default)]
    #[cfg_attr(test, ts(type = "Record<string, unknown>"))]
    pub variables: BTreeMap<String, Value>,
    /// As in `DistributionRequest`.
    pub path: Vec<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub top: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub bins: Option<u32>,
}

/// How the values of one field path are spread over all documents of a result.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct FieldDistribution {
    /// Documents in the result.
    pub total: u64,
    /// Documents that contain the path.
    pub documents: u64,
    /// Documents without it.
    pub missing: u64,
    /// Values at the path, array elements one by one; objects and arrays are not counted.
    pub values: u64,
    /// Values that are `null`.
    pub nulls: u64,
    /// Distinct values, counted up to 100,000; `distinctCapped` says there are more.
    pub distinct: u64,
    pub distinct_capped: bool,
    /// Every value found at the path by its type (objects and arrays included), most common first.
    pub types: Vec<TypeCount>,
    /// The most common values, typed as in documents.
    pub top: Vec<ValueCount>,
    /// Whether the histogram is of numbers or of dates (Unix milliseconds); none for other values.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub scale: Option<DistributionScale>,
    /// Smallest and largest value (numbers, dates or else texts), typed as in documents.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional, type = "unknown"))]
    pub min: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional, type = "unknown"))]
    pub max: Option<Value>,
    /// Equal-width bins from the smallest to the largest value of the scale.
    pub bins: Vec<DistributionBin>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum DistributionScale {
    Number,
    Date,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct TypeCount {
    /// The type's name, as in the schema (`int`, `string`, `date`, ...).
    pub name: String,
    pub count: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct ValueCount {
    #[cfg_attr(test, ts(type = "unknown"))]
    pub value: Value,
    pub count: u64,
    /// A text longer than `TEXT_CUT` characters, counted by its beginning: `value` is that
    /// beginning, so it cannot be filtered by.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    #[cfg_attr(test, ts(as = "Option<bool>", optional))]
    pub truncated: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct DistributionBin {
    pub from: f64,
    pub to: f64,
    pub count: u64,
}

/// Export file formats (docs/api/datasources.md, "Export"), per result shape: frames as CSV, JSON
/// or Excel, documents as JSON or NDJSON, graphs as GraphML or JSON.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum ExportFormat {
    Csv,
    Json,
    Xlsx,
    Ndjson,
    Graphml,
}

/// Decides the CSV separator and decimal mark: German `;` and `,`, English `,` and `.`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum ExportLanguage {
    De,
    En,
}

/// `POST /api/orgs/{orgId}/export`: a free query's result, after its steps, as a file. Needs
/// `data:export` and `datasources:query` on every data source, as running it does.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExportRequest {
    pub queries: Vec<QueryItem>,
    pub time_range: TimeRange,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub interval_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub max_data_points: Option<u32>,
    #[serde(default)]
    #[cfg_attr(test, ts(type = "Record<string, unknown>"))]
    pub variables: BTreeMap<String, Value>,
    /// Analysis steps, as a panel stores them in `transformations`.
    #[serde(default)]
    #[cfg_attr(test, ts(type = "unknown[]"))]
    pub steps: Vec<Value>,
    pub format: ExportFormat,
    pub language: ExportLanguage,
    /// The result to export, by `refId`: a frame, documents or a graph after the steps. Absent:
    /// the first result the format fits, frames before documents before graphs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub frame: Option<String>,
    /// The file name's base, such as the Explore data source's name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub title: Option<String>,
    /// The time zone calculated fields read times in (an IANA name such as Europe/Berlin): the
    /// dashboard's, else the viewer's, as the UI shows them. Absent: UTC.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub time_zone: Option<String>,
    /// The first day of a week for `startOf(t, 'week')`. Absent: Monday.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional, type = "\"monday\" | \"sunday\" | \"saturday\""))]
    pub week_start: Option<String>,
}

/// `POST /api/orgs/{orgId}/dashboards/{dashboardId}/panels/{panelId}/export`: the stored
/// panel's result, after its stored steps, as a file. Needs `data:export` and `dashboards:read`
/// on the dashboard, as viewing it does.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PanelExportRequest {
    pub time_range: TimeRange,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub interval_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub max_data_points: Option<u32>,
    #[serde(default)]
    #[cfg_attr(test, ts(type = "Record<string, unknown>"))]
    pub variables: BTreeMap<String, Value>,
    pub format: ExportFormat,
    pub language: ExportLanguage,
    /// The result to export, by `refId`, as for the free export.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub frame: Option<String>,
    /// The time zone calculated fields read times in (an IANA name such as Europe/Berlin): the
    /// dashboard's, else the viewer's, as the UI shows them. Absent: UTC.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub time_zone: Option<String>,
    /// The first day of a week for `startOf(t, 'week')`. Absent: Monday.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional, type = "\"monday\" | \"sunday\" | \"saturday\""))]
    pub week_start: Option<String>,
}

/// Absolute Unix milliseconds; the UI resolves relative ranges such as "now-6h".
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct TimeRange {
    pub from: i64,
    pub to: i64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct QueryResponse {
    /// One entry per `refId`; one failing query does not fail the others.
    pub results: BTreeMap<String, QueryOutcome>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(untagged)]
pub enum QueryOutcome {
    Ok {
        result: QueryResult,
        /// The graph steps the query ran, when it had any (`QueryItem::steps`).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(test, ts(optional))]
        steps: Option<Vec<StepPlace>>,
        /// Whether the answer came from the server's query cache, for runs that use it
        /// (docs/api/datasources.md, "Query cache").
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(test, ts(optional))]
        cache: Option<CacheInfo>,
        /// How long the query took on the server, in milliseconds, from its start to its answer
        /// (a cache hit included), for the editors' "rows and time" line.
        #[serde(default, rename = "elapsedMs", skip_serializing_if = "Option::is_none")]
        #[cfg_attr(test, ts(optional, rename = "elapsedMs"))]
        elapsed_ms: Option<u64>,
    },
    Err {
        error: ErrorBody,
    },
}

/// What the query cache did for one answer.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct CacheInfo {
    pub status: CacheStatus,
    /// How old the answer is: 0 for one that just ran.
    pub age_ms: u64,
    /// How long the answer is kept from when it ran.
    pub ttl_ms: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum CacheStatus {
    /// Kept from an earlier run.
    Hit,
    /// Ran in the source and is kept now.
    Miss,
    /// Ran in the source because the caller asked to refresh; kept now in place of the older one.
    Refresh,
}

/// What the caller may do on one data source, from their role and grants together; the routes
/// decide by the same rules.
///
/// - `read`: open it (name, kind, settings without secrets).
/// - `query`: run free queries in Explore, test the connection, read the schema.
/// - `write`: change its name, limits and secrets, and trash and restore it.
/// - `permissions`: the admin level: manage its grants.
/// - `changeTarget`: change where it connects (host, port, database, user, TLS, path, URL), with
///   the secrets that go with it: `write`, plus the org-wide datasources:write or `permissions`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct DatasourceAccess {
    pub read: bool,
    pub query: bool,
    pub write: bool,
    pub permissions: bool,
    pub change_target: bool,
}

/// The body of every error answer: `{"error": ErrorBody}`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct ErrorEnvelope {
    pub error: ErrorBody,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct ErrorBody {
    #[cfg_attr(test, ts(type = "ErrorCode"))]
    pub code: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub field: Option<String>,
    /// A finer, stable reason the UI translates (see docs/api/datasources.md); `message` is the
    /// English fallback.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub reason: Option<String>,
    /// Values the reason's text needs (`{name}`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub params: Option<BTreeMap<String, String>>,
    /// For `internal`: the request id that the server log names next to the cause.
    #[serde(default, rename = "requestId", skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub request_id: Option<String>,
    /// For `rate_limited`: seconds until another attempt can succeed (also `Retry-After`).
    #[serde(default, rename = "retryAfterSecs", skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional, type = "number"))]
    pub retry_after_secs: Option<u64>,
}

/// Every list answer. `nextCursor` is opaque; order is stable (newest first unless a route says
/// otherwise), `limit` defaults to 50 and above 200 is a `validation` error.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct Page<T> {
    pub items: Vec<T>,
    pub next_cursor: Option<String>,
}

/// A value JSON cannot express by itself (ObjectId, date, decimal, binary, int64), kept with its
/// database type instead of being flattened to a string.
pub fn typed(kind: &str, value: impl Into<String>) -> Value {
    serde_json::json!({ "$type": kind, "value": value.into() })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use ts_rs::TS;

    #[test]
    fn query_results_are_tagged_by_shape() {
        let frame = Frame::new(vec![Field {
            name: "time".into(),
            field_type: FieldType::Time,
            unit: None,
            values: vec![json!(1_800_000_000_000_i64)],
            labels: None,
        }])
        .unwrap();
        let json = serde_json::to_value(QueryResult::Frame { frame }).unwrap();
        assert_eq!(json["shape"], "frame");
        assert_eq!(json["frame"]["fields"][0]["type"], "time");
        assert!(json["frame"].get("meta").is_none());

        let graph = QueryResult::Graph { graph: GraphSet::default() };
        assert_eq!(graph.shape(), Shape::Graph);
        let back: QueryResult = serde_json::from_value(serde_json::to_value(&graph).unwrap()).unwrap();
        assert_eq!(back, graph);
    }

    #[test]
    fn traces_round_trip_in_their_own_shape() {
        let span = Span {
            trace_id: "4bf92f3577b34da6a3ce929d0e0e4736".into(),
            span_id: "00f067aa0ba902b7".into(),
            parent_span_id: Some("a000000000000001".into()),
            service: "kasse".into(),
            operation: "POST /zahlung".into(),
            start: 1_800_000_000_000_123,
            duration: 1500.25,
            status: SpanStatus::Error,
            status_message: Some("abgelehnt".into()),
            kind: SpanKind::Client,
            attributes: BTreeMap::from([
                ("http.status_code".into(), json!(402)),
                ("big".into(), json!("9007199254740993")),
            ]),
            resource: BTreeMap::from([("host.name".into(), json!("web-1"))]),
            scope: Some(SpanScope { name: "kasse-sdk".into(), version: Some("1.2".into()) }),
            events: vec![SpanEvent {
                time: 1_800_000_000_001_000,
                name: "exception".into(),
                attributes: BTreeMap::from([("exception.message".into(), json!("Karte abgelehnt"))]),
            }],
            links: vec![SpanLink {
                trace_id: "0af7651916cd43dd8448eb211c80319c".into(),
                span_id: "b7ad6b7169203331".into(),
                attributes: BTreeMap::new(),
            }],
        };
        let trace = QueryResult::Trace {
            trace: TraceSet {
                spans: vec![span],
                truncated: Some(Truncated { limit: 1, reason: Some("trace.span_limit".into()) }),
                notices: vec![],
                executed_query: Some("{ status = error }".into()),
            },
        };
        assert_eq!(trace.shape(), Shape::Trace);
        let json = serde_json::to_value(&trace).unwrap();
        assert_eq!(json["shape"], "trace");
        let s = &json["trace"]["spans"][0];
        assert_eq!(s["traceId"], "4bf92f3577b34da6a3ce929d0e0e4736");
        assert_eq!(s["parentSpanId"], "a000000000000001");
        assert_eq!(s["start"], 1_800_000_000_000_123_i64);
        assert_eq!(s["duration"], 1500.25);
        assert_eq!(s["status"], "error");
        assert_eq!(s["kind"], "client");
        assert_eq!(s["events"][0]["time"], 1_800_000_000_001_000_i64);
        assert_eq!(s["links"][0]["spanId"], "b7ad6b7169203331");
        assert!(json["trace"].get("notices").is_none(), "no notices, no key");
        let back: QueryResult = serde_json::from_value(json).unwrap();
        assert_eq!(back, trace);
        // A root span without the optional parts, as a plugin or a stored snapshot may send it.
        let minimal = json!({ "shape": "trace", "trace": { "spans": [{
            "traceId": "t", "spanId": "s", "service": "a", "operation": "b", "start": 1, "duration": 0.5,
            "status": "unset", "kind": "server", "attributes": {}
        }] } });
        let QueryResult::Trace { trace } = serde_json::from_value::<QueryResult>(minimal).unwrap() else {
            panic!("a trace")
        };
        assert_eq!(trace.spans[0].parent_span_id, None);
        assert!(trace.spans[0].events.is_empty() && trace.spans[0].resource.is_empty());
        assert_eq!(serde_json::to_value(Shape::Trace).unwrap(), "trace");
    }

    #[test]
    fn frames_reject_ragged_fields() {
        let field = |name: &str, n: usize| Field {
            name: name.into(),
            field_type: FieldType::Number,
            unit: None,
            values: vec![json!(1); n],
            labels: None,
        };
        assert!(Frame::new(vec![field("a", 2), field("b", 3)]).is_err());
        assert_eq!(Frame::new(vec![field("a", 2), field("b", 2)]).unwrap().rows(), 2);
        assert_eq!(Frame::new(vec![]).unwrap().rows(), 0);
        let ragged = json!({ "fields": [
            { "name": "a", "type": "number", "values": [1, 2] },
            { "name": "b", "type": "number", "values": [1] }
        ] });
        assert!(serde_json::from_value::<Frame>(ragged).is_err());
    }

    #[test]
    fn typed_values_keep_their_database_type() {
        assert_eq!(typed("objectId", "65f0c1"), json!({ "$type": "objectId", "value": "65f0c1" }));
    }

    /// Keeps `ui/src/api/generated/shapes.ts` in step with these types.
    #[test]
    fn generated_typescript_is_current() {
        // Times are Unix milliseconds, well inside the 2^53 range of a JavaScript number.
        let cfg = ts_rs::Config::default().with_large_int("number");
        let decls = [
            Shape::decl(&cfg),
            QueryResult::decl(&cfg),
            Frame::decl(&cfg),
            FrameMeta::decl(&cfg),
            Notice::decl(&cfg),
            NoticeSeverity::decl(&cfg),
            FieldType::decl(&cfg),
            Field::decl(&cfg),
            DocumentSet::decl(&cfg),
            FieldSchema::decl(&cfg),
            TypeShare::decl(&cfg),
            Truncated::decl(&cfg),
            GraphSet::decl(&cfg),
            Node::decl(&cfg),
            Edge::decl(&cfg),
            GraphPath::decl(&cfg),
            GraphSchema::decl(&cfg),
            TraceSet::decl(&cfg),
            Span::decl(&cfg),
            SpanStatus::decl(&cfg),
            SpanKind::decl(&cfg),
            SpanScope::decl(&cfg),
            SpanEvent::decl(&cfg),
            SpanLink::decl(&cfg),
            QueryRequest::decl(&cfg),
            QueryItem::decl(&cfg),
            PanelQueryRequest::decl(&cfg),
            LiveSubscribe::decl(&cfg),
            LiveSubscribeType::decl(&cfg),
            LivePanel::decl(&cfg),
            LiveUnsubscribe::decl(&cfg),
            LiveUnsubscribeType::decl(&cfg),
            LiveMode::decl(&cfg),
            LiveMessage::decl(&cfg),
            VariableOptionsRequest::decl(&cfg),
            VariableOption::decl(&cfg),
            VariableOptionsResponse::decl(&cfg),
            TimeRange::decl(&cfg),
            QueryResponse::decl(&cfg),
            QueryOutcome::decl(&cfg),
            CacheInfo::decl(&cfg),
            CacheStatus::decl(&cfg),
            StepPlace::decl(&cfg),
            StepSummary::decl(&cfg),
            RanIn::decl(&cfg),
            ErrorEnvelope::decl(&cfg),
            ErrorBody::decl(&cfg),
            Page::<()>::decl(&cfg),
            DatasourceAccess::decl(&cfg),
            ExportFormat::decl(&cfg),
            ExportLanguage::decl(&cfg),
            ExportRequest::decl(&cfg),
            PanelExportRequest::decl(&cfg),
            DistributionRequest::decl(&cfg),
            PanelDistributionRequest::decl(&cfg),
            FieldDistribution::decl(&cfg),
            DistributionScale::decl(&cfg),
            TypeCount::decl(&cfg),
            ValueCount::decl(&cfg),
            DistributionBin::decl(&cfg),
            crate::ai::service::AiStatus::decl(&cfg),
            crate::ai::service::AiStatusProvider::decl(&cfg),
            crate::ai::service::AiStatusFunctions::decl(&cfg),
            crate::ai::service::AiStatusUsage::decl(&cfg),
            crate::sharing::SharedTimeRange::decl(&cfg),
            crate::sharing::SuspendedReason::decl(&cfg),
            crate::sharing::PublicDashboard::decl(&cfg),
            crate::sharing::PublicVariable::decl(&cfg),
            crate::sharing::PublicRow::decl(&cfg),
            crate::sharing::PublicPanel::decl(&cfg),
            crate::sharing::PublicGrid::decl(&cfg),
            crate::sharing::PublicTarget::decl(&cfg),
            crate::routes::sharing::SharingLimits::decl(&cfg),
            crate::routes::sharing::ShareStatus::decl(&cfg),
            crate::routes::sharing::PublicLink::decl(&cfg),
            crate::routes::sharing::CreatePublicLink::decl(&cfg),
            crate::routes::sharing::CreatedPublicLink::decl(&cfg),
            crate::routes::sharing::ChangeExpiry::decl(&cfg),
            crate::routes::sharing::PublicLinkView::decl(&cfg),
            crate::routes::sharing::PublicPanelQuery::decl(&cfg),
            crate::routes::sharing::SnapshotSummary::decl(&cfg),
            crate::routes::sharing::CreateSnapshot::decl(&cfg),
            crate::routes::sharing::CreatedSnapshot::decl(&cfg),
            crate::routes::sharing::SnapshotView::decl(&cfg),
            crate::routes::sharing::PublicSnapshotView::decl(&cfg),
            crate::provisioning::ResourceKind::decl(&cfg),
            crate::provisioning::engine::RequestFile::decl(&cfg),
            crate::provisioning::engine::SetRequest::decl(&cfg),
            crate::provisioning::engine::Action::decl(&cfg),
            crate::provisioning::engine::Change::decl(&cfg),
            crate::provisioning::engine::Counts::decl(&cfg),
            crate::provisioning::engine::Plan::decl(&cfg),
            crate::provisioning::engine::ApplyWarning::decl(&cfg),
            crate::provisioning::engine::ApplyResult::decl(&cfg),
            crate::provisioning::engine::Provisioned::decl(&cfg),
            crate::provisioning::engine::ExportFile::decl(&cfg),
            crate::provisioning::engine::ExportSkip::decl(&cfg),
            crate::provisioning::engine::Export::decl(&cfg),
            crate::provisioning::grafana::ItemStatus::decl(&cfg),
            crate::provisioning::grafana::ItemKind::decl(&cfg),
            crate::provisioning::grafana::ImportItem::decl(&cfg),
            crate::provisioning::grafana::ImportNote::decl(&cfg),
            crate::provisioning::grafana::ImportCounts::decl(&cfg),
            crate::provisioning::grafana::ImportReport::decl(&cfg),
            crate::routes::dashboards::GrafanaImportRequest::decl(&cfg),
            crate::reports::schedule::Weekday::decl(&cfg),
            crate::reports::schedule::Schedule::decl(&cfg),
            crate::reports::model::ReportFormat::decl(&cfg),
            crate::reports::model::ReportLanguage::decl(&cfg),
            crate::reports::model::Recipient::decl(&cfg),
            crate::reports::model::ReportTimeRange::decl(&cfg),
            crate::reports::model::ReportInput::decl(&cfg),
            crate::reports::model::RecipientView::decl(&cfg),
            crate::reports::model::Report::decl(&cfg),
            crate::reports::model::Suspension::decl(&cfg),
            crate::reports::model::RunTrigger::decl(&cfg),
            crate::reports::model::RunStatus::decl(&cfg),
            crate::reports::model::RunError::decl(&cfg),
            crate::reports::model::ReportRun::decl(&cfg),
            crate::reports::model::ReportLimits::decl(&cfg),
            crate::reports::model::ReportsStatus::decl(&cfg),
            crate::reports::model::SendNow::decl(&cfg),
        ];
        let mut out = String::from(
            "// Generated from server/src/shapes.rs by `KALZIT_UPDATE_GENERATED=1 cargo test`. Do not edit.\n\n",
        );
        let union = |name: &str, values: Vec<&str>| {
            let parts: Vec<String> = values.iter().map(|v| format!("\"{v}\"")).collect();
            format!("export type {name} = {};\n\n", parts.join(" | "))
        };
        out.push_str(&union("ErrorCode", crate::error::ERROR_CODES.to_vec()));
        out.push_str(&union("Permission", crate::authz::Permission::ALL.iter().map(|p| p.as_str()).collect()));
        // The UI keeps a label and description per setting in its catalogs (tested there).
        // A key in both scopes (an organization's appearance override) is listed once.
        let mut keys: Vec<&str> = Vec::new();
        for d in crate::settings::REGISTRY {
            if !keys.contains(&d.key) {
                keys.push(d.key);
            }
        }
        out.push_str(&union("SettingKey", keys));
        for decl in decls {
            out.push_str("export ");
            out.push_str(&decl);
            out.push_str("\n\n");
        }
        let out = out.trim_end().to_string() + "\n";
        // The UI and the TypeScript SDK (sdk/typescript) share the same types.
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        for path in
            [root.join("../ui/src/api/generated/shapes.ts"), root.join("../sdk/typescript/src/generated/shapes.ts")]
        {
            if std::env::var_os("KALZIT_UPDATE_GENERATED").is_some() {
                std::fs::create_dir_all(path.parent().unwrap()).unwrap();
                std::fs::write(&path, &out).unwrap();
            }
            let current = std::fs::read_to_string(&path).unwrap_or_default().replace("\r\n", "\n");
            assert_eq!(current, out, "{} is stale; run KALZIT_UPDATE_GENERATED=1 cargo test", path.display());
        }
    }
}
