//! The schema of a TigerGraph graph as `GET /gsql/v1/schema/graphs/{g}` (4.x) and
//! `GET /gsqlserver/gsql/schema?graph=g` (3.x) describe it: vertex types with their primary id and
//! attributes, edge types with their vertex type pairs, direction and reverse edge type. Read for
//! GSQL completion (`completion`) and for the explorer's generated queries (`explore.rs`), which
//! need the names and directions spelled out.

use serde_json::Value;

use crate::shapes::{GsqlAccumulator, GsqlAttribute, GsqlDirection, GsqlEdgeType, GsqlSchema, GsqlVertexType};

/// The most vertex and edge types read; a graph with more keeps the first ones.
const MAX_TYPES: usize = 10_000;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct TgSchema {
    pub vertices: Vec<VertexType>,
    pub edges: Vec<EdgeType>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct VertexType {
    pub name: String,
    pub primary_id: GsqlAttribute,
    pub attributes: Vec<GsqlAttribute>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct EdgeType {
    pub name: String,
    pub directed: bool,
    /// `[from, to]` vertex type names; `*` for any where the schema says so.
    pub pairs: Vec<[String; 2]>,
    pub reverse: Option<String>,
    pub attributes: Vec<GsqlAttribute>,
}

impl EdgeType {
    fn connects(&self, side: usize, vertex_type: &str) -> bool {
        self.pairs.iter().any(|p| p[side] == vertex_type || p[side] == "*")
    }

    /// Whether the edge leaves a vertex of `vertex_type` (as its source, or either end when
    /// undirected).
    pub fn leaves(&self, vertex_type: &str) -> bool {
        self.connects(0, vertex_type) || (!self.directed && self.connects(1, vertex_type))
    }

    /// Whether a directed edge arrives at a vertex of `vertex_type`.
    pub fn arrives(&self, vertex_type: &str) -> bool {
        self.directed && self.connects(1, vertex_type)
    }
}

/// A name GSQL can take as written: letters, digits and `_`, up to 128.
pub fn is_name(s: &str) -> bool {
    super::is_name(s)
}

/// A type as GSQL writes it, from an `AttributeType` object (`{"Name": "LIST", "ValueTypeName":
/// "INT"}`).
fn type_text(t: &Value) -> String {
    let name = t.get("Name").and_then(Value::as_str).unwrap_or("").to_ascii_uppercase();
    let value = t.get("ValueTypeName").and_then(Value::as_str);
    let key = t.get("KeyTypeName").and_then(Value::as_str);
    let tuple = t.get("TupleTypeName").and_then(Value::as_str);
    match (name.as_str(), key, value, tuple) {
        ("MAP", Some(k), Some(v), _) => format!("MAP<{k}, {v}>"),
        ("LIST" | "SET", _, Some(v), _) => format!("{name}<{v}>"),
        ("UDT", _, _, Some(t)) => t.to_string(),
        ("", _, _, _) => "STRING".into(),
        _ => name,
    }
}

fn attribute(a: &Value) -> Option<GsqlAttribute> {
    let name = a.get("AttributeName").and_then(Value::as_str)?.to_string();
    let ty = a.get("AttributeType").map(type_text).unwrap_or_else(|| "STRING".into());
    Some(GsqlAttribute { name, ty })
}

fn attributes(t: &Value) -> Vec<GsqlAttribute> {
    t.get("Attributes").and_then(Value::as_array).map(|a| a.iter().filter_map(attribute).collect()).unwrap_or_default()
}

/// The schema from the `results` of the schema endpoint (or the body itself). Types whose names
/// GSQL could not take as written are left out.
pub fn parse(results: &Value) -> TgSchema {
    let list = |key: &str| results.get(key).and_then(Value::as_array).cloned().unwrap_or_default();
    let vertices = list("VertexTypes")
        .iter()
        .filter_map(|v| {
            let name = v.get("Name").and_then(Value::as_str).filter(|n| is_name(n))?.to_string();
            let primary_id = v
                .get("PrimaryId")
                .and_then(attribute)
                .unwrap_or_else(|| GsqlAttribute { name: "id".into(), ty: "STRING".into() });
            Some(VertexType { name, primary_id, attributes: attributes(v) })
        })
        .take(MAX_TYPES)
        .collect();
    let edges = list("EdgeTypes")
        .iter()
        .filter_map(|e| {
            let name = e.get("Name").and_then(Value::as_str).filter(|n| is_name(n))?.to_string();
            let directed = e.get("IsDirected").and_then(Value::as_bool).unwrap_or(false);
            let mut pairs: Vec<[String; 2]> = e
                .get("EdgePairs")
                .and_then(Value::as_array)
                .map(|ps| {
                    ps.iter()
                        .filter_map(|p| {
                            Some([p.get("From")?.as_str()?.to_string(), p.get("To")?.as_str()?.to_string()])
                        })
                        .collect()
                })
                .unwrap_or_default();
            if pairs.is_empty()
                && let (Some(f), Some(t)) = (
                    e.get("FromVertexTypeName").and_then(Value::as_str),
                    e.get("ToVertexTypeName").and_then(Value::as_str),
                )
            {
                pairs.push([f.to_string(), t.to_string()]);
            }
            let reverse = e
                .get("Config")
                .and_then(|c| c.get("REVERSE_EDGE"))
                .and_then(Value::as_str)
                .filter(|r| directed && is_name(r))
                .map(String::from);
            Some(EdgeType { name, directed, pairs, reverse, attributes: attributes(e) })
        })
        .take(MAX_TYPES)
        .collect();
    TgSchema { vertices, edges }
}

/// GSQL's accumulator types, for completion: name, type parameters and the text to insert.
const ACCUMULATORS: &[(&str, &str, &str)] = &[
    ("SumAccum", "<T>", "SumAccum<INT>"),
    ("MinAccum", "<T>", "MinAccum<INT>"),
    ("MaxAccum", "<T>", "MaxAccum<INT>"),
    ("AvgAccum", "", "AvgAccum"),
    ("AndAccum", "", "AndAccum"),
    ("OrAccum", "", "OrAccum"),
    ("BitwiseAndAccum", "", "BitwiseAndAccum"),
    ("BitwiseOrAccum", "", "BitwiseOrAccum"),
    ("ListAccum", "<T>", "ListAccum<STRING>"),
    ("SetAccum", "<T>", "SetAccum<VERTEX>"),
    ("BagAccum", "<T>", "BagAccum<STRING>"),
    ("MapAccum", "<K, V>", "MapAccum<STRING, SumAccum<INT>>"),
    ("ArrayAccum", "<A>", "ArrayAccum<SumAccum<INT>>"),
    ("HeapAccum", "<T>(size, field ASC|DESC)", "HeapAccum<T>(10, field DESC)"),
    ("GroupByAccum", "<K..., A...>", "GroupByAccum<STRING key, SumAccum<INT> total>"),
];

/// What a GSQL editor completes, from the schema.
pub fn completion(schema: &TgSchema) -> GsqlSchema {
    let vertex_types = schema
        .vertices
        .iter()
        .map(|v| GsqlVertexType {
            name: v.name.clone(),
            primary_id: v.primary_id.clone(),
            attributes: v.attributes.clone(),
        })
        .collect();
    let edge_types = schema
        .edges
        .iter()
        .map(|e| {
            let directions = match (e.directed, &e.reverse) {
                (false, _) => vec![GsqlDirection::Undirected],
                (true, None) => vec![GsqlDirection::Out],
                (true, Some(_)) => vec![GsqlDirection::Out, GsqlDirection::In],
            };
            GsqlEdgeType {
                name: e.name.clone(),
                directed: e.directed,
                pairs: e.pairs.clone(),
                reverse: e.reverse.clone(),
                directions,
                attributes: e.attributes.clone(),
            }
        })
        .collect();
    let accumulators = ACCUMULATORS
        .iter()
        .map(|(name, params, snippet)| GsqlAccumulator {
            name: (*name).to_string(),
            params: (*params).to_string(),
            snippet: (*snippet).to_string(),
        })
        .collect();
    GsqlSchema { vertex_types, edge_types, accumulators }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// As 4.2.5 describes the nightly job's graph `social` (shortened), plus an edge with several
    /// vertex type pairs.
    pub fn social() -> Value {
        json!({
            "GraphName": "social",
            "VertexTypes": [
                { "Name": "Person", "PrimaryId": { "AttributeName": "id", "AttributeType": { "Name": "STRING" } },
                  "Attributes": [{ "AttributeName": "name", "AttributeType": { "Name": "STRING" } },
                                 { "AttributeName": "age", "AttributeType": { "Name": "INT" } },
                                 { "AttributeName": "tags", "AttributeType": { "Name": "SET", "ValueTypeName": "STRING" } }] },
                { "Name": "Ort", "PrimaryId": { "AttributeName": "id", "AttributeType": { "Name": "INT" } }, "Attributes": [] },
                { "Name": "bad name", "Attributes": [] }
            ],
            "EdgeTypes": [
                { "Name": "Friend", "IsDirected": false, "FromVertexTypeName": "Person", "ToVertexTypeName": "Person",
                  "Config": {}, "Attributes": [{ "AttributeName": "since", "AttributeType": { "Name": "INT" } }] },
                { "Name": "Lebt", "IsDirected": true, "FromVertexTypeName": "Person", "ToVertexTypeName": "Ort",
                  "Config": { "REVERSE_EDGE": "reverse_Lebt" }, "Attributes": [] },
                { "Name": "Kennt", "IsDirected": true, "FromVertexTypeName": "*", "ToVertexTypeName": "*",
                  "EdgePairs": [{ "From": "Person", "To": "Ort" }, { "From": "Ort", "To": "Ort" }],
                  "Config": {}, "Attributes": [] }
            ]
        })
    }

    #[test]
    fn schema_types_directions_and_completion() {
        let s = parse(&social());
        assert_eq!(s.vertices.iter().map(|v| v.name.as_str()).collect::<Vec<_>>(), ["Person", "Ort"]);
        assert_eq!(s.vertices[1].primary_id.ty, "INT");
        assert_eq!(s.vertices[0].attributes[2].ty, "SET<STRING>");
        let lebt = &s.edges[1];
        assert_eq!(lebt.reverse.as_deref(), Some("reverse_Lebt"));
        assert!(lebt.leaves("Person") && !lebt.leaves("Ort") && lebt.arrives("Ort"));
        let friend = &s.edges[0];
        assert!(friend.leaves("Person") && !friend.arrives("Person"), "undirected edges only leave");
        let kennt = &s.edges[2];
        assert_eq!(kennt.pairs, [["Person".to_string(), "Ort".to_string()], ["Ort".into(), "Ort".into()]]);
        let c = completion(&s);
        assert_eq!(c.edge_types[0].directions, [GsqlDirection::Undirected]);
        assert_eq!(c.edge_types[1].directions, [GsqlDirection::Out, GsqlDirection::In]);
        assert_eq!(c.edge_types[2].directions, [GsqlDirection::Out]);
        assert!(c.accumulators.iter().any(|a| a.name == "HeapAccum"));
        let shown = serde_json::to_value(&c).unwrap();
        assert_eq!(shown["edgeTypes"][1]["reverse"], "reverse_Lebt");
        assert_eq!(shown["vertexTypes"][0]["primaryId"], json!({ "name": "id", "type": "STRING" }));
        assert!(shown["edgeTypes"][0].get("reverse").is_none());
    }
}
