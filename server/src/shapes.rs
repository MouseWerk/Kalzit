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
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct Frame {
    pub fields: Vec<Field>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub meta: Option<FrameMeta>,
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
    /// Documents with typed values (see [`typed`]) where JSON has no type for them.
    #[cfg_attr(test, ts(type = "unknown[]"))]
    pub documents: Vec<Value>,
    /// Sampled from the result: every field path with its types and how many documents have it.
    pub schema: Vec<FieldSchema>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub next_cursor: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub truncated: Option<Truncated>,
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

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct Truncated {
    pub limit: u32,
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
    }

    #[test]
    fn typed_values_keep_their_database_type() {
        assert_eq!(typed("objectId", "65f0c1"), json!({ "$type": "objectId", "value": "65f0c1" }));
    }

    /// Keeps `ui/src/api/generated/shapes.ts` in step with these types.
    #[test]
    fn generated_typescript_is_current() {
        let cfg = ts_rs::Config::default();
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
        ];
        let mut out = String::from(
            "// Generated from server/src/shapes.rs by `KALZIT_UPDATE_GENERATED=1 cargo test`. Do not edit.\n\n",
        );
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
