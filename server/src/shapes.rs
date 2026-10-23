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
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(tag = "shape", rename_all = "camelCase")]
pub enum QueryResult {
    Frame { frame: Frame },
    Documents { documents: DocumentSet },
    Graph { graph: GraphSet },
}

impl QueryResult {
    pub fn shape(&self) -> Shape {
        match self {
            QueryResult::Frame { .. } => Shape::Frame,
            QueryResult::Documents { .. } => Shape::Documents,
            QueryResult::Graph { .. } => Shape::Graph,
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

/// Export file formats (docs/api/datasources.md, "Export"). Frames export as CSV, JSON or Excel; documents
/// (NDJSON) and graphs (GraphML) follow with their milestones.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum ExportFormat {
    Csv,
    Json,
    Xlsx,
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
    /// The frame to export, by `refId`; the first frame when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub frame: Option<String>,
    /// The file name's base, such as the Explore data source's name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub title: Option<String>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub frame: Option<String>,
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
    Ok { result: QueryResult },
    Err { error: ErrorBody },
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
            QueryRequest::decl(&cfg),
            QueryItem::decl(&cfg),
            PanelQueryRequest::decl(&cfg),
            VariableOptionsRequest::decl(&cfg),
            VariableOption::decl(&cfg),
            VariableOptionsResponse::decl(&cfg),
            TimeRange::decl(&cfg),
            QueryResponse::decl(&cfg),
            QueryOutcome::decl(&cfg),
            ErrorEnvelope::decl(&cfg),
            ErrorBody::decl(&cfg),
            Page::<()>::decl(&cfg),
            DatasourceAccess::decl(&cfg),
            ExportFormat::decl(&cfg),
            ExportLanguage::decl(&cfg),
            ExportRequest::decl(&cfg),
            PanelExportRequest::decl(&cfg),
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
        out.push_str(&union("SettingKey", crate::settings::REGISTRY.iter().map(|d| d.key).collect()));
        for decl in decls {
            out.push_str("export ");
            out.push_str(&decl);
            out.push_str("\n\n");
        }
        let out = out.trim_end().to_string() + "\n";
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../ui/src/api/generated/shapes.ts");
        if std::env::var_os("KALZIT_UPDATE_GENERATED").is_some() {
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, &out).unwrap();
        }
        let current = std::fs::read_to_string(&path).unwrap_or_default().replace("\r\n", "\n");
        assert_eq!(current, out, "{} is stale; run KALZIT_UPDATE_GENERATED=1 cargo test", path.display());
    }
}
