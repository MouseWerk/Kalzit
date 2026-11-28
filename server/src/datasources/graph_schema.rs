//! The schema of a graph source as a graph (docs/api/datasources.md, "Graph schema"): labels and
//! edge types with their counts and properties (with data types), and which label connects to
//! which through which type. The schema panel draws it; the query editor completes properties
//! per label from it.
//!
//! Each kind reads it its own way and says how (`GraphSchemaSource`): Neo4j through its
//! read-only `db.schema.*` procedures and the count store, Memgraph through `SHOW SCHEMA INFO`
//! when the server runs with `--schema-info-enabled`, else from a sample of the graph, and
//! TigerGraph from its catalog (no counts; "Zählen" counts one label on request). Labels, types
//! and links come largest first; past `MAX_ENTRIES` the smallest are left out. The answer is kept
//! with the source's connection for `TTL` (`Connection::graph_schema`), so it is rebuilt when the
//! source's settings change.

use std::collections::{BTreeMap, BTreeSet};
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

/// How long a read schema is answered from memory.
pub const TTL: Duration = Duration::from_secs(300);
/// The most labels, edge types and links an answer holds; more set `truncated`.
pub const MAX_ENTRIES: usize = 2_000;
/// How many nodes and edges a sample reads.
pub const SAMPLE: u64 = 10_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum GraphSchemaSource {
    /// Memgraph's schema information: exact counts.
    SchemaInfo,
    /// Neo4j's schema procedures and count store: exact counts of labels and types.
    Procedures,
    /// The first `sampleSize` nodes and edges: counts within the sample.
    Sample,
    /// TigerGraph's catalog: types and attributes, no counts.
    Catalog,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct GraphSourceSchema {
    pub source: GraphSchemaSource,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub sample_size: Option<u64>,
    pub labels: Vec<ElementSchema>,
    pub edge_types: Vec<ElementSchema>,
    /// Which label connects to which through which edge type, in the edge's direction.
    pub links: Vec<SchemaLink>,
    /// More labels, types or links than `MAX_ENTRIES`; the rest is left out.
    pub truncated: bool,
    /// When the source was read, Unix milliseconds.
    pub read_at: i64,
}

/// A label or an edge type.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ElementSchema {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub count: Option<u64>,
    pub properties: Vec<PropertySchema>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct PropertySchema {
    pub name: String,
    /// The value types seen or declared (`string`, `integer`, `float`, `boolean`, `date`,
    /// `dateTime`, `localDateTime`, `time`, `localTime`, `duration`, `point`, `list`, `map`,
    /// `bytes`, `enum`; another type in lower case as the source names it).
    pub types: Vec<String>,
    /// Whether every element of the label or type has it, where the source says.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub mandatory: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct SchemaLink {
    pub from: String,
    #[serde(rename = "type")]
    pub edge_type: String,
    pub to: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub count: Option<u64>,
}

/// A type name of Neo4j, Memgraph or TigerGraph in Kalzit's words.
pub fn normalize_type(raw: &str) -> String {
    // Neo4j 5.26 and later write Cypher types: `INTEGER NOT NULL`, `LOCAL DATETIME NOT NULL`.
    let t = raw.trim();
    let t = t
        .len()
        .checked_sub(9)
        .filter(|&at| t.is_char_boundary(at) && t[at..].eq_ignore_ascii_case(" not null"))
        .map_or(t, |at| &t[..at]);
    let lower = t.to_ascii_lowercase().replace(['_', ' '], "");
    if lower.ends_with("array") || lower.starts_with("list") || lower.starts_with("set<") || lower.starts_with("bag<") {
        return "list".into();
    }
    match lower.as_str() {
        "string" | "str" => "string",
        "int" | "integer" | "long" | "int64" | "uint" | "short" | "byte" | "int32" => "integer",
        "float" | "double" | "real" => "float",
        "bool" | "boolean" => "boolean",
        "date" => "date",
        "datetime" | "zoneddatetime" => "dateTime",
        "localdatetime" => "localDateTime",
        "time" | "zonedtime" => "time",
        "localtime" => "localTime",
        "duration" => "duration",
        "point" | "point2d" | "point3d" => "point",
        "map" => "map",
        "bytes" | "bytearray" => "bytes",
        "enum" => "enum",
        "null" | "" => "null",
        _ => return t.to_ascii_lowercase(),
    }
    .into()
}

#[derive(Default)]
struct Element {
    count: Option<u64>,
    /// Property to (types, mandatory).
    properties: BTreeMap<String, (BTreeSet<String>, Option<bool>)>,
}

/// Collects a schema from whatever a reader finds, in any order.
#[derive(Default)]
pub struct Builder {
    labels: BTreeMap<String, Element>,
    types: BTreeMap<String, Element>,
    links: BTreeMap<(String, String, String), Option<u64>>,
}

fn add_count(slot: &mut Option<u64>, n: Option<u64>) {
    if let Some(n) = n {
        *slot = Some(slot.unwrap_or(0).saturating_add(n));
    }
}

impl Builder {
    pub fn label(&mut self, name: &str, count: Option<u64>) {
        add_count(&mut self.labels.entry(name.to_string()).or_default().count, count);
    }

    pub fn edge_type(&mut self, name: &str, count: Option<u64>) {
        add_count(&mut self.types.entry(name.to_string()).or_default().count, count);
    }

    fn property(
        map: &mut BTreeMap<String, Element>,
        owner: &str,
        name: &str,
        ty: Option<&str>,
        mandatory: Option<bool>,
    ) {
        let entry = map.entry(owner.to_string()).or_default().properties.entry(name.to_string()).or_default();
        if let Some(t) = ty.map(normalize_type).filter(|t| t != "null") {
            entry.0.insert(t);
        }
        // Mandatory only while every reader says so.
        entry.1 = match (entry.1, mandatory) {
            (Some(a), Some(b)) => Some(a && b),
            (None, m) => m,
            (a, None) => a,
        };
    }

    pub fn label_property(&mut self, label: &str, name: &str, ty: Option<&str>, mandatory: Option<bool>) {
        Self::property(&mut self.labels, label, name, ty, mandatory);
    }

    pub fn type_property(&mut self, edge_type: &str, name: &str, ty: Option<&str>, mandatory: Option<bool>) {
        Self::property(&mut self.types, edge_type, name, ty, mandatory);
    }

    pub fn link(&mut self, from: &str, edge_type: &str, to: &str, count: Option<u64>) {
        let slot = self.links.entry((from.to_string(), edge_type.to_string(), to.to_string())).or_default();
        add_count(slot, count);
    }

    pub fn finish(self, source: GraphSchemaSource, sample_size: Option<u64>, read_at: i64) -> GraphSourceSchema {
        let mut truncated = false;
        let mut elements = |map: BTreeMap<String, Element>| -> Vec<ElementSchema> {
            truncated |= map.len() > MAX_ENTRIES;
            // The largest first, so a cut leaves out the smallest; without counts by name.
            let mut all: Vec<(String, Element)> = map.into_iter().collect();
            all.sort_by(|(an, a), (bn, b)| b.count.cmp(&a.count).then_with(|| an.cmp(bn)));
            all.into_iter()
                .take(MAX_ENTRIES)
                .map(|(name, e)| ElementSchema {
                    name,
                    count: e.count,
                    properties: e
                        .properties
                        .into_iter()
                        .map(|(name, (types, mandatory))| PropertySchema {
                            name,
                            types: types.into_iter().collect(),
                            mandatory,
                        })
                        .collect(),
                })
                .collect()
        };
        let labels = elements(self.labels);
        let edge_types = elements(self.types);
        truncated |= self.links.len() > MAX_ENTRIES;
        let mut links: Vec<SchemaLink> = self
            .links
            .into_iter()
            .map(|((from, edge_type, to), count)| SchemaLink { from, edge_type, to, count })
            .collect();
        links.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.cmp(b)));
        links.truncate(MAX_ENTRIES);
        GraphSourceSchema { source, sample_size, labels, edge_types, links, truncated, read_at }
    }
}

fn strings(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|s| s.as_str().map(String::from)).collect())
        .unwrap_or_default()
}

/// Properties of one `SHOW SCHEMA INFO` entry: `[{key, count, types: [{type, count}]}]`; one is
/// mandatory when it is on every element of the entry.
fn memgraph_properties(entry: &Value, mut add: impl FnMut(&str, Option<&str>, Option<bool>)) {
    let total = entry.get("count").and_then(Value::as_u64);
    for p in entry.get("properties").and_then(Value::as_array).into_iter().flatten() {
        let Some(key) = p.get("key").and_then(Value::as_str) else { continue };
        let mandatory = match (p.get("count").and_then(Value::as_u64), total) {
            (Some(c), Some(t)) => Some(c >= t),
            _ => None,
        };
        let types: Vec<&str> = p
            .get("types")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|t| t.get("type").and_then(Value::as_str))
            .collect();
        if types.is_empty() {
            add(key, None, mandatory);
        }
        for t in types {
            add(key, Some(t), mandatory);
        }
    }
}

/// Memgraph's `SHOW SCHEMA INFO` (one JSON text): nodes grouped by their set of labels, edges by
/// type and the label sets of their ends. A node with several labels counts for each; an end
/// without labels is the empty label `""`.
pub fn from_memgraph_schema_info(info: &Value, read_at: i64) -> GraphSourceSchema {
    let mut b = Builder::default();
    for n in info.get("nodes").and_then(Value::as_array).into_iter().flatten() {
        let count = n.get("count").and_then(Value::as_u64);
        for label in strings(n.get("labels")) {
            b.label(&label, count);
            memgraph_properties(n, |k, t, m| b.label_property(&label, k, t, m));
        }
    }
    for e in info.get("edges").and_then(Value::as_array).into_iter().flatten() {
        let Some(ty) = e.get("type").and_then(Value::as_str) else { continue };
        let count = e.get("count").and_then(Value::as_u64);
        b.edge_type(ty, count);
        memgraph_properties(e, |k, t, m| b.type_property(ty, k, t, m));
        let ends = |key: &str| {
            let l = strings(e.get(key));
            if l.is_empty() { vec![String::new()] } else { l }
        };
        for from in ends("start_node_labels") {
            for to in ends("end_node_labels") {
                b.link(&from, ty, &to, count);
            }
        }
    }
    b.finish(GraphSchemaSource::SchemaInfo, None, read_at)
}

/// TigerGraph's catalog (`GET /gsql/v1/schema/graphs/{graph}` 4.x, `/gsqlserver/gsql/schema`
/// 3.x): `VertexTypes` and `EdgeTypes` with `Attributes`; an edge type's ends from `EdgePairs`
/// (4.x, several pairs) or `FromVertexTypeName`/`ToVertexTypeName` (`*` for any).
pub fn from_tigergraph(results: &Value, read_at: i64) -> GraphSourceSchema {
    let mut b = Builder::default();
    let attributes = |t: &Value| -> Vec<(String, Option<String>)> {
        t.get("Attributes")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|a| {
                let name = a.get("AttributeName").and_then(Value::as_str)?;
                let ty = a.get("AttributeType").and_then(|t| t.get("Name")).and_then(Value::as_str);
                Some((name.to_string(), ty.map(String::from)))
            })
            .collect()
    };
    for v in results.get("VertexTypes").and_then(Value::as_array).into_iter().flatten() {
        let Some(name) = v.get("Name").and_then(Value::as_str) else { continue };
        b.label(name, None);
        for (k, t) in attributes(v) {
            b.label_property(name, &k, t.as_deref(), Some(true));
        }
    }
    for e in results.get("EdgeTypes").and_then(Value::as_array).into_iter().flatten() {
        let Some(name) = e.get("Name").and_then(Value::as_str) else { continue };
        b.edge_type(name, None);
        for (k, t) in attributes(e) {
            b.type_property(name, &k, t.as_deref(), Some(true));
        }
        let pairs: Vec<(String, String)> = e
            .get("EdgePairs")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|p| Some((p.get("From")?.as_str()?.to_string(), p.get("To")?.as_str()?.to_string())))
            .collect();
        let pairs = if pairs.is_empty() {
            let end = |k: &str| e.get(k).and_then(Value::as_str).unwrap_or("*").to_string();
            vec![(end("FromVertexTypeName"), end("ToVertexTypeName"))]
        } else {
            pairs
        };
        for (from, to) in pairs {
            let any = |s: &str| if s == "*" { String::new() } else { s.to_string() };
            b.link(&any(&from), name, &any(&to), None);
        }
    }
    b.finish(GraphSchemaSource::Catalog, None, read_at)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn types_have_one_name_across_sources() {
        for (raw, want) in [
            ("String", "string"),
            ("Long", "integer"),
            ("INTEGER", "integer"),
            ("Double", "float"),
            ("BOOL", "boolean"),
            ("LocalDateTime", "localDateTime"),
            ("LOCAL_DATE_TIME", "localDateTime"),
            ("ZonedDateTime", "dateTime"),
            ("DATETIME", "dateTime"),
            ("StringArray", "list"),
            ("LIST<STRING>", "list"),
            ("SET<INT>", "list"),
            ("Point", "point"),
            ("INTEGER NOT NULL", "integer"),
            ("LOCAL DATETIME NOT NULL", "localDateTime"),
            ("ZONED DATETIME NOT NULL", "dateTime"),
            ("LIST<STRING NOT NULL> NOT NULL", "list"),
            ("UDT", "udt"),
        ] {
            assert_eq!(normalize_type(raw), want, "{raw}");
        }
    }

    /// Recorded from Memgraph 3.x started with `--schema-info-enabled`.
    const MEMGRAPH_INFO: &str = r#"{"edges":[{"count":2,"end_node_labels":["Person"],"properties":[{"count":2,"filling_factor":100.0,"key":"seit","types":[{"count":2,"type":"Integer"}]}],"start_node_labels":["Person","Kunde"],"type":"KENNT"},{"count":1,"end_node_labels":[],"properties":[],"start_node_labels":["Person"],"type":"MAG"}],"enums":[],"node_constraints":[],"node_indexes":[],"nodes":[{"count":2,"labels":["Person","Kunde"],"properties":[{"count":2,"filling_factor":100.0,"key":"name","types":[{"count":2,"type":"String"}]},{"count":1,"filling_factor":50.0,"key":"alter","types":[{"count":1,"type":"Integer"},{"count":1,"type":"Float"}]}]},{"count":1,"labels":["Person"],"properties":[{"count":1,"filling_factor":100.0,"key":"name","types":[{"count":1,"type":"String"}]}]},{"count":1,"labels":[],"properties":[]}]}"#;

    #[test]
    fn memgraph_schema_info_reads_into_a_graph() {
        let info: Value = serde_json::from_str(MEMGRAPH_INFO).unwrap();
        let s = from_memgraph_schema_info(&info, 7);
        assert_eq!(s.source, GraphSchemaSource::SchemaInfo);
        let person = s.labels.iter().find(|l| l.name == "Person").unwrap();
        assert_eq!(person.count, Some(3));
        let name = person.properties.iter().find(|p| p.name == "name").unwrap();
        assert_eq!((name.types.clone(), name.mandatory), (vec!["string".to_string()], Some(true)));
        let alter = person.properties.iter().find(|p| p.name == "alter").unwrap();
        assert_eq!(
            (alter.types.clone(), alter.mandatory),
            (vec!["float".to_string(), "integer".to_string()], Some(false))
        );
        assert_eq!(s.labels.iter().find(|l| l.name == "Kunde").unwrap().count, Some(2));
        let kennt = s.edge_types.iter().find(|t| t.name == "KENNT").unwrap();
        assert_eq!(kennt.count, Some(2));
        assert_eq!(kennt.properties[0].types, ["integer"]);
        assert_eq!(
            s.links,
            [
                SchemaLink { from: "Kunde".into(), edge_type: "KENNT".into(), to: "Person".into(), count: Some(2) },
                SchemaLink { from: "Person".into(), edge_type: "KENNT".into(), to: "Person".into(), count: Some(2) },
                SchemaLink { from: "Person".into(), edge_type: "MAG".into(), to: String::new(), count: Some(1) },
            ]
        );
        assert!(!s.truncated);
        assert_eq!(s.read_at, 7);
    }

    #[test]
    fn tigergraph_catalogs_read_into_a_graph() {
        let catalog = json!({
            "VertexTypes": [
                { "Name": "Person", "Attributes": [{ "AttributeName": "name", "AttributeType": { "Name": "STRING" } }] },
                { "Name": "Firma", "Attributes": [] }
            ],
            "EdgeTypes": [
                { "Name": "ARBEITET_BEI", "FromVertexTypeName": "Person", "ToVertexTypeName": "Firma", "IsDirected": true,
                  "Attributes": [{ "AttributeName": "seit", "AttributeType": { "Name": "DATETIME" } }] },
                { "Name": "KENNT", "FromVertexTypeName": "*", "ToVertexTypeName": "*",
                  "EdgePairs": [{ "From": "Person", "To": "Person" }, { "From": "Person", "To": "Firma" }], "Attributes": [] }
            ]
        });
        let s = from_tigergraph(&catalog, 1);
        assert_eq!(s.source, GraphSchemaSource::Catalog);
        assert_eq!(s.labels.iter().map(|l| l.name.as_str()).collect::<Vec<_>>(), ["Firma", "Person"]);
        assert!(s.labels.iter().all(|l| l.count.is_none()));
        assert_eq!(s.edge_types[0].properties[0].types, ["dateTime"]);
        assert_eq!(s.links.len(), 3);
        assert!(s.links.contains(&SchemaLink {
            from: "Person".into(),
            edge_type: "KENNT".into(),
            to: "Firma".into(),
            count: None
        }));
    }

    #[test]
    fn answers_are_bounded() {
        let mut b = Builder::default();
        for i in 0..=MAX_ENTRIES {
            b.label(&format!("L{i}"), Some(1));
        }
        b.label("Groß", Some(5));
        b.label("Klein", Some(0));
        let s = b.finish(GraphSchemaSource::Sample, Some(SAMPLE), 0);
        assert!(s.truncated);
        assert_eq!(s.labels.len(), MAX_ENTRIES);
        // The largest first: the cut leaves out the smallest.
        assert_eq!(s.labels[0].name, "Groß");
        assert!(!s.labels.iter().any(|l| l.name == "Klein"));
    }
}
