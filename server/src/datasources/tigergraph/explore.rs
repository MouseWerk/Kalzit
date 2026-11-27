//! The graph explorer on TigerGraph: neighbours of a vertex by edge type and direction, how many
//! there are, and vertices by their ids, as interpreted GSQL that Kalzit writes from the graph's
//! schema (`{"explore": {...}}`, docs/api/datasources.md, "TigerGraph explorer").
//!
//! GSQL has no generic expand: the vertex type, the edge types and their directions must be
//! spelled out, so the query is made from the schema. Names come from the schema only (and are
//! plain GSQL names), the vertex ids go in as typed parameters, and the numbers are bounded here;
//! the generated text then passes the same read-only check and runs on the same interpret
//! endpoint as any interpreted query, with the user's rights.
//!
//! Directions: an undirected edge type is followed in every direction; a directed one along its
//! direction (`E>`) for `out`, and against it for `in` only through its reverse edge type (`R>`),
//! which TigerGraph keeps for edges created `WITH REVERSE_EDGE`. Edges reached through a reverse
//! type come back as the edge itself (its type and ends), so they merge with the same edge seen
//! from the other side. A directed type without a reverse type cannot be followed against its
//! direction; the answer says so in a notice (`tigergraph.explore_no_reverse_edge`).
//!
//! The neighbours are the best connected first (by out-degree, then TigerGraph's internal id), so
//! "load more" with `skip` continues where the last page ended.

use std::collections::{BTreeMap, HashMap};

use serde::Deserialize;
use serde_json::{Map, Value, json};

use super::schema::TgSchema;
use crate::datasources::Detail;

/// The most neighbours one step loads, as the graph panel's explorer.
pub const MAX_LIMIT: u32 = 200;
/// How far "load more" may page.
pub const MAX_SKIP: u32 = 10_000;
/// The most vertices one `nodes` request names.
pub const MAX_IDS: usize = 1_000;
/// The prefix of everything the generated queries name themselves.
const OWN: &str = "kalzit_";

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Direction {
    Out,
    In,
    #[default]
    Both,
}

fn default_limit() -> u32 {
    25
}

/// The explorer forms of a TigerGraph query.
#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(tag = "op", rename_all = "camelCase", deny_unknown_fields)]
pub enum Explore {
    /// The vertex, up to `limit` of its neighbours after the `skip` best connected, and the
    /// edges between it and them.
    Neighbours {
        node: String,
        #[serde(default, rename = "edgeTypes")]
        edge_types: Vec<String>,
        #[serde(default)]
        direction: Direction,
        #[serde(default = "default_limit")]
        limit: u32,
        #[serde(default)]
        skip: u32,
    },
    /// How many distinct neighbours the same step reaches in all (`total`).
    Count {
        node: String,
        #[serde(default, rename = "edgeTypes")]
        edge_types: Vec<String>,
        #[serde(default)]
        direction: Direction,
    },
    /// Vertices by their ids (`Type:id`), and with `edges` the edges between them.
    Nodes {
        ids: Vec<String>,
        #[serde(default)]
        edges: bool,
    },
}

/// A generated query, its parameters and what to do with the answer.
#[derive(Debug, Default)]
pub struct Generated {
    pub text: String,
    pub params: Map<String, Value>,
    /// Reverse edge types and the edge type each belongs to.
    pub reverse: HashMap<String, String>,
    /// What the answer should say (edge types that cannot be followed this way).
    pub notices: Vec<Detail>,
}

fn refuse(reason: &'static str, message: impl Into<String>) -> Detail {
    Detail::new(reason, message)
}

/// `Type:id` split at the first colon, the type known to the schema.
fn vertex<'a>(id: &'a str, schema: &TgSchema) -> Result<(&'a str, &'a str), Detail> {
    let Some((ty, key)) = id.split_once(':').filter(|(t, k)| !t.is_empty() && !k.is_empty()) else {
        return Err(
            refuse("tigergraph.explore_node", format!("{id} is no vertex id of the form Type:id")).with("node", id)
        );
    };
    if !schema.vertices.iter().any(|v| v.name == ty) {
        return Err(
            refuse("tigergraph.explore_type_unknown", format!("the graph has no vertex type {ty}")).with("type", ty)
        );
    }
    Ok((ty, key))
}

/// The edge types a step may follow: those named (each known to the schema), or all.
fn chosen<'a>(schema: &'a TgSchema, names: &[String]) -> Result<Vec<&'a super::schema::EdgeType>, Detail> {
    if let Some(unknown) = names.iter().find(|n| !schema.edges.iter().any(|e| &e.name == *n)) {
        return Err(refuse("tigergraph.explore_type_unknown", format!("the graph has no edge type {unknown}"))
            .with("type", unknown));
    }
    Ok(schema.edges.iter().filter(|e| names.is_empty() || names.contains(&e.name)).collect())
}

/// The edge pattern from a vertex of `ty` in `direction`, as GSQL alternatives (`Friend|Lebt>`),
/// the reverse types it uses, and the directed types it cannot follow against their direction.
fn pattern(
    edges: &[&super::schema::EdgeType],
    ty: &str,
    direction: Direction,
) -> (Vec<String>, HashMap<String, String>, Vec<String>) {
    let mut parts = Vec::new();
    let mut reverse = HashMap::new();
    let mut missing = Vec::new();
    for e in edges {
        if !e.directed {
            if e.leaves(ty) {
                parts.push(e.name.clone());
            }
            continue;
        }
        if direction != Direction::In && e.leaves(ty) {
            parts.push(format!("{}>", e.name));
        }
        if direction != Direction::Out && e.arrives(ty) {
            match &e.reverse {
                Some(r) => {
                    parts.push(format!("{r}>"));
                    reverse.insert(r.clone(), e.name.clone());
                }
                None => missing.push(e.name.clone()),
            }
        }
    }
    (parts, reverse, missing)
}

fn no_reverse(missing: &[String]) -> Detail {
    let list = missing.join(", ");
    refuse(
        "tigergraph.explore_no_reverse_edge",
        format!(
            "{list} cannot be followed against their direction: the schema has no reverse edge type for them \
             (create the edge type WITH REVERSE_EDGE)"
        ),
    )
    .with("types", list)
}

/// The query of an explorer form for the graph `graph`.
pub fn generate(explore: &Explore, schema: &TgSchema, graph: &str) -> Result<Generated, Detail> {
    let mut out = Generated::default();
    match explore {
        Explore::Neighbours { node, edge_types, direction, limit, skip } => {
            if !(1..=MAX_LIMIT).contains(limit) {
                return Err(refuse("tigergraph.explore_limit", format!("limit must be from 1 to {MAX_LIMIT}"))
                    .with("max", MAX_LIMIT));
            }
            if *skip > MAX_SKIP {
                return Err(refuse("tigergraph.explore_limit", format!("skip must be at most {MAX_SKIP}"))
                    .with("max", MAX_SKIP));
            }
            let (ty, key) = vertex(node, schema)?;
            let (parts, reverse, missing) = pattern(&chosen(schema, edge_types)?, ty, *direction);
            out.params.insert(format!("{OWN}node"), json!(key));
            out.reverse = reverse;
            if !missing.is_empty() {
                out.notices.push(no_reverse(&missing));
            }
            let mut body = vec![
                format!("OrAccum @{OWN}pick;"),
                format!("SetAccum<EDGE> @@{OWN}edges;"),
                format!("{OWN}start = {{{OWN}node}};"),
                format!("PRINT {OWN}start;"),
            ];
            if !parts.is_empty() {
                let p = parts.join("|");
                let order = "ORDER BY t.outdegree() DESC, getvid(t) ASC";
                body.push(format!(
                    "{OWN}near = SELECT t FROM {OWN}start:s -({p}:e)- :t {order} LIMIT {};",
                    u64::from(*skip) + u64::from(*limit)
                ));
                if *skip > 0 {
                    body.push(format!("{OWN}skipped = SELECT t FROM {OWN}near:t {order} LIMIT {skip};"));
                    body.push(format!("{OWN}near = {OWN}near MINUS {OWN}skipped;"));
                }
                body.push(format!("PRINT {OWN}near;"));
                body.push(format!("{OWN}near = SELECT t FROM {OWN}near:t POST-ACCUM t.@{OWN}pick = TRUE;"));
                body.push(format!(
                    "{OWN}linked = SELECT t FROM {OWN}start:s -({p}:e)- :t WHERE t.@{OWN}pick ACCUM @@{OWN}edges += e;"
                ));
                body.push(format!("PRINT @@{OWN}edges;"));
            }
            out.text =
                format!("INTERPRET QUERY (VERTEX<{ty}> {OWN}node) FOR GRAPH {graph} {{\n  {}\n}}", body.join("\n  "));
        }
        Explore::Count { node, edge_types, direction } => {
            let (ty, key) = vertex(node, schema)?;
            let (parts, _, missing) = pattern(&chosen(schema, edge_types)?, ty, *direction);
            out.params.insert(format!("{OWN}node"), json!(key));
            if !missing.is_empty() {
                out.notices.push(no_reverse(&missing));
            }
            let body = if parts.is_empty() {
                "PRINT 0 AS total;".to_string()
            } else {
                format!(
                    "{OWN}start = {{{OWN}node}};\n  {OWN}near = SELECT t FROM {OWN}start:s -({}:e)- :t;\n  \
                     PRINT {OWN}near.size() AS total;",
                    parts.join("|")
                )
            };
            out.text = format!("INTERPRET QUERY (VERTEX<{ty}> {OWN}node) FOR GRAPH {graph} {{\n  {body}\n}}");
        }
        Explore::Nodes { ids, edges } => {
            if ids.is_empty() || ids.len() > MAX_IDS {
                return Err(refuse("tigergraph.explore_limit", format!("ids must name 1 to {MAX_IDS} vertices"))
                    .with("max", MAX_IDS));
            }
            // One typed set parameter per vertex type, in the order the types first appear.
            let mut by_type: Vec<(&str, Vec<&str>)> = Vec::new();
            for id in ids {
                let (ty, key) = vertex(id, schema)?;
                match by_type.iter_mut().find(|(t, _)| *t == ty) {
                    Some((_, keys)) => keys.push(key),
                    None => by_type.push((ty, vec![key])),
                }
            }
            let mut params = Vec::new();
            let mut body = vec![format!("OrAccum @{OWN}pick;"), format!("SetAccum<EDGE> @@{OWN}edges;")];
            let mut sets = Vec::new();
            for (i, (ty, keys)) in by_type.iter().enumerate() {
                params.push(format!("SET<VERTEX<{ty}>> {OWN}v{i}"));
                out.params.insert(format!("{OWN}v{i}"), json!(keys));
                body.push(format!("{OWN}s{i} = {{{OWN}v{i}}};"));
                sets.push(format!("{OWN}s{i}"));
            }
            body.push(format!("{OWN}all = {};", sets.join(" UNION ")));
            body.push(format!("PRINT {OWN}all;"));
            // Every directed edge between two of the vertices is found from its source.
            let forward: Vec<String> = if *edges {
                schema.edges.iter().map(|e| if e.directed { format!("{}>", e.name) } else { e.name.clone() }).collect()
            } else {
                Vec::new()
            };
            if !forward.is_empty() {
                body.push(format!("{OWN}all = SELECT v FROM {OWN}all:v POST-ACCUM v.@{OWN}pick = TRUE;"));
                body.push(format!(
                    "{OWN}linked = SELECT t FROM {OWN}all:s -({}:e)- :t WHERE t.@{OWN}pick ACCUM @@{OWN}edges += e;",
                    forward.join("|")
                ));
                body.push(format!("PRINT @@{OWN}edges;"));
            }
            out.text =
                format!("INTERPRET QUERY ({}) FOR GRAPH {graph} {{\n  {}\n}}", params.join(", "), body.join("\n  "));
        }
    }
    Ok(out)
}

/// The answer of an explorer query as the explorer reads it: edges reached through a reverse type
/// become the edge itself, and the generated query's own vertex accumulators are left out.
pub fn tidy(results: &mut Value, reverse: &HashMap<String, String>) {
    match results {
        Value::Array(a) => a.iter_mut().for_each(|v| tidy(v, reverse)),
        Value::Object(m) => {
            if m.contains_key("v_id") && m.contains_key("v_type") {
                if let Some(Value::Object(attrs)) = m.get_mut("attributes") {
                    attrs.retain(|k, _| !k.starts_with(&format!("@{OWN}")));
                }
                return;
            }
            if let Some(forward) = m.get("e_type").and_then(Value::as_str).and_then(|t| reverse.get(t)).cloned() {
                let swap: BTreeMap<&str, &str> =
                    [("from_id", "to_id"), ("to_id", "from_id"), ("from_type", "to_type"), ("to_type", "from_type")]
                        .into();
                let old = m.clone();
                for (k, from) in swap {
                    if let Some(v) = old.get(from) {
                        m.insert(k.to_string(), v.clone());
                    }
                }
                m.insert("e_type".into(), json!(forward));
                m.insert("directed".into(), json!(true));
                return;
            }
            m.values_mut().for_each(|v| tidy(v, reverse));
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::datasources::gsql::{Form, ParamType, check_with};

    fn schema() -> TgSchema {
        super::super::schema::parse(&json!({
            "VertexTypes": [{ "Name": "Person", "Attributes": [] }, { "Name": "Ort", "Attributes": [] }],
            "EdgeTypes": [
                { "Name": "Friend", "IsDirected": false, "FromVertexTypeName": "Person", "ToVertexTypeName": "Person" },
                { "Name": "Lebt", "IsDirected": true, "FromVertexTypeName": "Person", "ToVertexTypeName": "Ort",
                  "Config": { "REVERSE_EDGE": "reverse_Lebt" } },
                { "Name": "Mag", "IsDirected": true, "FromVertexTypeName": "Person", "ToVertexTypeName": "Person" }
            ]
        }))
    }

    fn explore(v: Value) -> Explore {
        serde_json::from_value(v).unwrap()
    }

    /// Every generated query passes the read-only check with the names and types it declares.
    fn checked(g: &Generated) -> Vec<crate::datasources::gsql::Param> {
        let c = check_with(&g.text, Form::Interpret, Some(&[])).unwrap_or_else(|e| panic!("{}\n{e:?}", g.text));
        assert_eq!(c.graph.as_deref(), Some("social"));
        c.params
    }

    #[test]
    fn neighbours_follow_the_schema_types_and_directions() {
        let s = schema();
        let g = generate(&explore(json!({ "op": "neighbours", "node": "Person:1" })), &s, "social").unwrap();
        let params = checked(&g);
        assert_eq!(params[0].ty, ParamType::Vertex(Some("Person".into())));
        assert_eq!(g.params["kalzit_node"], "1");
        assert!(g.text.contains("-(Friend|Lebt>|Mag>:e)- :t"), "{}", g.text);
        assert!(g.text.contains("LIMIT 25;"), "{}", g.text);
        assert!(!g.text.contains("MINUS"), "nothing skipped");
        assert_eq!(
            g.notices[0].params["types"], "Mag",
            "both directions include in, which Mag has no reverse type for"
        );
        // Against the direction: the reverse type, and a notice for the type without one.
        let g = generate(
            &explore(json!({ "op": "neighbours", "node": "Ort:7", "direction": "in", "limit": 3, "skip": 6 })),
            &s,
            "social",
        )
        .unwrap();
        checked(&g);
        assert!(g.text.contains("-(reverse_Lebt>:e)- :t") && g.text.contains("LIMIT 9;"), "{}", g.text);
        assert!(g.text.contains("LIMIT 6;") && g.text.contains("kalzit_near MINUS kalzit_skipped"), "{}", g.text);
        assert_eq!(g.reverse["reverse_Lebt"], "Lebt");
        let g = generate(&explore(json!({ "op": "neighbours", "node": "Person:1", "direction": "in" })), &s, "social")
            .unwrap();
        assert!(g.text.contains("-(Friend:e)-"), "undirected in every direction: {}", g.text);
        assert_eq!(g.notices[0].reason, "tigergraph.explore_no_reverse_edge");
        assert_eq!(g.notices[0].params["types"], "Mag");
        // Only the edge types asked for.
        let g = generate(
            &explore(json!({ "op": "neighbours", "node": "Person:1", "edgeTypes": ["Lebt"], "direction": "out" })),
            &s,
            "social",
        )
        .unwrap();
        assert!(g.text.contains("-(Lebt>:e)-"), "{}", g.text);
        // Nothing to follow: only the vertex.
        let g = generate(&explore(json!({ "op": "neighbours", "node": "Ort:7", "direction": "out" })), &s, "social")
            .unwrap();
        checked(&g);
        assert!(!g.text.contains("SELECT"), "{}", g.text);
    }

    #[test]
    fn names_ids_and_bounds_are_refused_before_any_query() {
        let s = schema();
        let refused = |v: Value| generate(&explore(v), &s, "social").unwrap_err().reason;
        assert_eq!(refused(json!({ "op": "neighbours", "node": "Planet:1" })), "tigergraph.explore_type_unknown");
        assert_eq!(refused(json!({ "op": "neighbours", "node": "1" })), "tigergraph.explore_node");
        assert_eq!(
            refused(json!({ "op": "neighbours", "node": "Person:1", "edgeTypes": ["Friend} DELETE"] })),
            "tigergraph.explore_type_unknown"
        );
        assert_eq!(refused(json!({ "op": "neighbours", "node": "Person:1", "limit": 0 })), "tigergraph.explore_limit");
        assert_eq!(
            refused(json!({ "op": "neighbours", "node": "Person:1", "limit": 201 })),
            "tigergraph.explore_limit"
        );
        assert_eq!(
            refused(json!({ "op": "neighbours", "node": "Person:1", "skip": 10_001 })),
            "tigergraph.explore_limit"
        );
        let many: Vec<String> = (0..=MAX_IDS).map(|i| format!("Person:{i}")).collect();
        assert_eq!(refused(json!({ "op": "nodes", "ids": many })), "tigergraph.explore_limit");
        assert!(serde_json::from_value::<Explore>(json!({ "op": "neighbours", "node": "Person:1", "x": 1 })).is_err());
        // An id with quotes or braces is a parameter value, never text in the query.
        let g = generate(&explore(json!({ "op": "neighbours", "node": "Person:\" } DELETE" })), &s, "social").unwrap();
        assert!(!g.text.contains("DELETE"));
        assert_eq!(g.params["kalzit_node"], "\" } DELETE");
    }

    #[test]
    fn counts_and_nodes_by_id() {
        let s = schema();
        let g = generate(&explore(json!({ "op": "count", "node": "Person:1", "direction": "both" })), &s, "social")
            .unwrap();
        checked(&g);
        assert!(g.text.contains("PRINT kalzit_near.size() AS total;"), "{}", g.text);
        let g = generate(
            &explore(json!({ "op": "nodes", "ids": ["Person:1", "Ort:7", "Person:2:x"], "edges": true })),
            &s,
            "social",
        )
        .unwrap();
        let params = checked(&g);
        assert_eq!(params[0].ty, ParamType::Many(Box::new(ParamType::Vertex(Some("Person".into())))));
        assert_eq!(g.params["kalzit_v0"], json!(["1", "2:x"]), "split at the first colon");
        assert_eq!(g.params["kalzit_v1"], json!(["7"]));
        assert!(g.text.contains("kalzit_all = kalzit_s0 UNION kalzit_s1;"), "{}", g.text);
        assert!(g.text.contains("-(Friend|Lebt>|Mag>:e)-"), "forward types only: {}", g.text);
        let g = generate(&explore(json!({ "op": "nodes", "ids": ["Person:1"] })), &s, "social").unwrap();
        checked(&g);
        assert!(!g.text.contains("@@kalzit_edges += e"));
    }

    #[test]
    fn reverse_edges_come_back_as_the_edge_itself() {
        let mut results = json!([
            { "kalzit_near": [{ "v_id": "1", "v_type": "Person", "attributes": { "name": "Ana", "@kalzit_pick": false } }] },
            { "@@kalzit_edges": [
                { "e_type": "reverse_Lebt", "from_type": "Ort", "from_id": "7", "to_type": "Person", "to_id": "1",
                  "directed": true, "attributes": {} },
                { "e_type": "Friend", "from_type": "Person", "from_id": "1", "to_type": "Person", "to_id": "2",
                  "directed": false, "attributes": {} }
            ] }
        ]);
        tidy(&mut results, &[("reverse_Lebt".to_string(), "Lebt".to_string())].into());
        assert_eq!(results[0]["kalzit_near"][0]["attributes"], json!({ "name": "Ana" }));
        let e = &results[1]["@@kalzit_edges"][0];
        assert_eq!(
            (e["e_type"].as_str(), e["from_id"].as_str(), e["to_type"].as_str()),
            (Some("Lebt"), Some("1"), Some("Ort"))
        );
        assert_eq!(results[1]["@@kalzit_edges"][1]["e_type"], "Friend");
    }
}
