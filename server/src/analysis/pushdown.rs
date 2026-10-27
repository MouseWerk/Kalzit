//! Graph steps in the database: the Cypher that runs a graph step on the result of the user's
//! query in Neo4j or Memgraph, so a count or a ranking covers the whole result instead of the
//! nodes Kalzit holds after the node limit. The user's query runs unchanged inside `CALL { }`;
//! what it returns (nodes, relationships, paths and lists of them, as the server builds a graph
//! from them) is collected, and the step's aggregation follows. The generated query is read-only
//! by construction and still goes through the same Cypher check and parameter rules as any query
//! (`datasources/cypher.rs`, `datasources/neo4j.rs`): it only adds reading clauses, names
//! (labels, types, property keys) are written as quoted text or quoted names, and numbers are
//! the step's checked bounds.
//!
//! Only the first graph step of a query runs here; the steps after it run on the server. A query
//! whose columns cannot be named (`RETURN *`, an expression without `AS`, `UNION`, `EXPLAIN`,
//! `PROFILE`, a `CYPHER` prefix) runs as written, and its graph steps run on the server.
//!
//! One difference to the server: an edge whose end node the query did not return has that node
//! here with its labels, while the server knows it only by its id.

use serde_json::Value;

use super::{Direction, StepKind};
use crate::datasources::cypher::{Tok, lex};
use crate::datasources::detail::Detail;
use crate::shapes::{Field, FieldType, Frame, GraphSchema, GraphSet, QueryResult};

/// The Cypher flavour: how node ids are read, and how a subquery starts.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Dialect {
    Neo4j,
    Memgraph,
}

impl Dialect {
    /// The node id as the server reads it from Bolt (`elementId`; Memgraph's number as text).
    fn id(self, var: &str) -> String {
        match self {
            Dialect::Neo4j => format!("elementId({var})"),
            Dialect::Memgraph => format!("toString(id({var}))"),
        }
    }

    /// A subquery that imports nothing: Neo4j's scope clause, Memgraph's plain form.
    fn call(self) -> &'static str {
        match self {
            Dialect::Neo4j => "CALL () {",
            Dialect::Memgraph => "CALL {",
        }
    }
}

fn is_word(t: &Tok, word: &str) -> bool {
    matches!(t, Tok::Ident { text, quoted: false } if text.eq_ignore_ascii_case(word))
}

/// The names of the columns the query returns, when every item of its last `RETURN` is a
/// variable or has `AS name`; `None` for anything else.
pub fn return_columns(query: &str) -> Option<Vec<String>> {
    let mut toks = lex(query).ok()?;
    while matches!(toks.last(), Some(Tok::Sym(';'))) {
        toks.pop();
    }
    if toks.first().is_some_and(|t| ["EXPLAIN", "PROFILE", "CYPHER"].iter().any(|w| is_word(t, w))) {
        return None;
    }
    // The last RETURN outside brackets, and the items after it up to ORDER, SKIP, OFFSET, LIMIT.
    let mut depth = 0i32;
    let mut last_return = None;
    for (i, t) in toks.iter().enumerate() {
        match t {
            Tok::Sym('(' | '[' | '{') => depth += 1,
            Tok::Sym(')' | ']' | '}') => depth -= 1,
            t if depth == 0 && is_word(t, "UNION") => return None,
            t if depth == 0 && is_word(t, "RETURN") && !matches!(toks.get(i + 1), Some(Tok::Sym(':'))) => {
                last_return = Some(i)
            }
            _ => {}
        }
    }
    let mut i = last_return? + 1;
    if toks.get(i).is_some_and(|t| is_word(t, "DISTINCT")) {
        i += 1;
    }
    let mut items: Vec<Vec<&Tok>> = vec![Vec::new()];
    let mut depth = 0i32;
    for t in &toks[i..] {
        match t {
            Tok::Sym('(' | '[' | '{') => depth += 1,
            Tok::Sym(')' | ']' | '}') => depth -= 1,
            _ => {}
        }
        if depth == 0 && ["ORDER", "SKIP", "OFFSET", "LIMIT"].iter().any(|w| is_word(t, w)) {
            break;
        }
        if depth == 0 && *t == Tok::Sym(',') {
            items.push(Vec::new());
        } else if let Some(last) = items.last_mut() {
            last.push(t);
        }
    }
    let mut names = Vec::with_capacity(items.len());
    for item in items {
        let name = match item.as_slice() {
            [Tok::Ident { text, .. }] => text.clone(),
            [.., as_word, Tok::Ident { text, .. }] if is_word(as_word, "AS") => text.clone(),
            _ => return None,
        };
        names.push(name);
    }
    (!names.is_empty()).then_some(names)
}

/// A name in backticks, backticks inside doubled.
fn quoted(name: &str) -> String {
    format!("`{}`", name.replace('`', "``"))
}

/// Text as a Cypher string literal.
fn text(value: &str) -> String {
    format!("'{}'", value.replace('\\', "\\\\").replace('\'', "\\'"))
}

/// Whether the value is of a type (Neo4j answers `NODE NOT NULL`, Memgraph `NODE`).
fn is_type(var: &str, ty: &str) -> String {
    format!("toUpper(valueType({var})) STARTS WITH '{ty}'")
}

/// The user's query, and every distinct node and relationship it returned, as `__kz_nodes` and
/// `__kz_rels`: nodes, relationships with both their ends, paths, and lists of these.
fn prelude(query: &str, columns: &[String], dialect: Dialect) -> String {
    let row = columns.iter().map(|c| quoted(c)).collect::<Vec<_>>().join(", ");
    format!(
        "{call}\n{query}\n}}\n\
         WITH [{row}] AS __kz_row\n\
         UNWIND __kz_row AS __kz_v\n\
         UNWIND CASE WHEN {list} THEN __kz_v ELSE [__kz_v] END AS __kz_e\n\
         UNWIND CASE\n  \
         WHEN {node} THEN [__kz_e]\n  \
         WHEN {rel} THEN [__kz_e, startNode(__kz_e), endNode(__kz_e)]\n  \
         WHEN {path} THEN nodes(__kz_e) + relationships(__kz_e)\n  \
         ELSE [] END AS __kz_x\n\
         WITH DISTINCT __kz_x\n\
         WITH collect(CASE WHEN {xnode} THEN __kz_x END) AS __kz_nodes,\n     \
         collect(CASE WHEN {xrel} THEN __kz_x END) AS __kz_rels\n",
        call = dialect.call(),
        list = is_type("__kz_v", "LIST"),
        node = is_type("__kz_e", "NODE"),
        rel = is_type("__kz_e", "RELATIONSHIP"),
        path = is_type("__kz_e", "PATH"),
        xnode = is_type("__kz_x", "NODE"),
        xrel = is_type("__kz_x", "RELATIONSHIP"),
    )
}

/// Per node, its degree in `direction` and its relationships (each at both its ends), as
/// `__kz_n`, `__kz_d`, `__kz_rs`; nodes without relationships too.
fn degree_rows(direction: Direction) -> String {
    let (out, inn) = match direction {
        Direction::Both => (1, 1),
        Direction::Out => (1, 0),
        Direction::In => (0, 1),
    };
    format!(
        "UNWIND [__kz_n IN __kz_nodes | [__kz_n, 0, null]]\n  \
         + [__kz_r IN __kz_rels | [startNode(__kz_r), {out}, __kz_r]]\n  \
         + [__kz_r IN __kz_rels | [endNode(__kz_r), {inn}, __kz_r]] AS __kz_p\n\
         WITH __kz_p[0] AS __kz_n, sum(__kz_p[1]) AS __kz_d, collect(__kz_p[2]) AS __kz_rs\n"
    )
}

/// A node's labels joined with `:`, null without labels.
fn labels_text(node: &str) -> String {
    format!(
        "reduce(__kz_s = null, __kz_l IN labels({node}) | CASE WHEN __kz_s IS NULL THEN __kz_l ELSE __kz_s + ':' + __kz_l END)"
    )
}

/// The Cypher that runs `step` on the result of `query` in the database; `None` when the step or
/// the query cannot run there.
pub fn cypher(query: &str, step: &StepKind, dialect: Dialect) -> Option<String> {
    let columns = return_columns(query)?;
    let query = query.trim_end().trim_end_matches(';');
    let tail = match step {
        StepKind::CountLabels { .. } => "WITH __kz_nodes, size(__kz_nodes) AS __kz_total\n\
             UNWIND __kz_nodes AS __kz_n\n\
             UNWIND labels(__kz_n) AS __kz_l\n\
             WITH __kz_l, __kz_total, count(*) AS __kz_c\n\
             RETURN __kz_l AS `label`, __kz_c AS `nodes`, toFloat(__kz_c) / __kz_total AS `share`\n\
             ORDER BY `nodes` DESC, `label` ASC"
            .to_string(),
        StepKind::CountEdgeTypes { .. } => format!(
            "UNWIND __kz_rels AS __kz_r\n\
             WITH type(__kz_r) AS __kz_t, {from} AS __kz_f, {to} AS __kz_o\n\
             WITH __kz_t, __kz_f, __kz_o, count(*) AS __kz_c\n\
             RETURN __kz_t AS `type`, __kz_f AS `from`, __kz_o AS `to`, __kz_c AS `edges`\n\
             ORDER BY `edges` DESC, `type` ASC, `from` ASC, `to` ASC",
            from = labels_text("startNode(__kz_r)"),
            to = labels_text("endNode(__kz_r)"),
        ),
        StepKind::DegreeDistribution { direction, .. } => format!(
            "{rows}WITH __kz_d, count(*) AS __kz_c\n\
             RETURN __kz_d AS `degree`, __kz_c AS `nodes`\n\
             ORDER BY `degree` ASC",
            rows = degree_rows(*direction),
        ),
        StepKind::TopDegree { n, label, direction, .. } => {
            let only = label.as_ref().map(|l| format!("WHERE {} IN labels(__kz_n)\n", text(l))).unwrap_or_default();
            // Each relationship is listed at both its ends: one listed twice among the kept nodes
            // has both ends there. A row without one carries the kept nodes.
            format!(
                "{rows}{only}WITH __kz_n, __kz_d, __kz_rs\n\
                 ORDER BY __kz_d DESC, {id} ASC\n\
                 LIMIT {n}\n\
                 UNWIND [null] + __kz_rs AS __kz_r\n\
                 WITH __kz_r, count(*) AS __kz_k, collect(__kz_n) AS __kz_ns\n\
                 WITH __kz_r, __kz_k, __kz_ns WHERE __kz_r IS NULL OR __kz_k >= 2\n\
                 RETURN CASE WHEN __kz_r IS NULL THEN __kz_ns ELSE __kz_r END AS `element`",
                rows = degree_rows(*direction),
                id = dialect.id("__kz_n"),
            )
        }
        StepKind::SharedNeighbours { label, via, edge_type, min, limit, name, .. } => {
            let (l, v) = (text(label), text(via));
            let pick = format!("{l} IN labels(__kz_s) AND {v} IN labels(__kz_t)");
            let typed = edge_type.as_ref().map(|t| format!("type(__kz_r) = {} AND ", text(t))).unwrap_or_default();
            let named = |var: &str| match name {
                Some(key) => format!(
                    "CASE WHEN {} THEN {var}.{} ELSE {} END",
                    is_type(&format!("{var}.{}", quoted(key)), "STRING"),
                    quoted(key),
                    dialect.id(var)
                ),
                None => dialect.id(var),
            };
            format!(
                "UNWIND __kz_rels AS __kz_r\n\
                 WITH __kz_r, startNode(__kz_r) AS __kz_s, endNode(__kz_r) AS __kz_t\n\
                 WHERE {typed}(({pick}) OR ({v} IN labels(__kz_s) AND {l} IN labels(__kz_t)))\n\
                 WITH DISTINCT CASE WHEN {pick} THEN __kz_s ELSE __kz_t END AS __kz_a,\n     \
                 CASE WHEN {pick} THEN __kz_t ELSE __kz_s END AS __kz_v\n\
                 WITH __kz_v, collect(__kz_a) AS __kz_as\n\
                 UNWIND __kz_as AS __kz_x\n\
                 UNWIND __kz_as AS __kz_y\n\
                 WITH __kz_x, __kz_y, __kz_v WHERE {xi} < {yi}\n\
                 WITH __kz_x, __kz_y, __kz_v ORDER BY {vi} ASC\n\
                 WITH __kz_x, __kz_y, collect(__kz_v) AS __kz_vs\n\
                 WHERE size(__kz_vs) >= {min}\n\
                 RETURN {xn} AS `a`, {yn} AS `b`, size(__kz_vs) AS `shared`,\n       \
                 [__kz_w IN __kz_vs | {wn}] AS `neighbours`, {xi} AS `__kz_ai`, {yi} AS `__kz_bi`\n\
                 ORDER BY `shared` DESC, `__kz_ai` ASC, `__kz_bi` ASC\n\
                 LIMIT {limit}",
                xi = dialect.id("__kz_x"),
                yi = dialect.id("__kz_y"),
                vi = dialect.id("__kz_v"),
                xn = named("__kz_x"),
                yn = named("__kz_y"),
                wn = named("__kz_w"),
            )
        }
        _ => return None,
    };
    Some(format!("{}{tail}", prelude(query, &columns, dialect)))
}

/// The columns each step answers, with their types.
fn output(step: &StepKind) -> &'static [(&'static str, FieldType)] {
    use FieldType::{Json, Number, String};
    match step {
        StepKind::CountLabels { .. } => &[("label", String), ("nodes", Number), ("share", Number)],
        StepKind::CountEdgeTypes { .. } => &[("type", String), ("from", String), ("to", String), ("edges", Number)],
        StepKind::DegreeDistribution { .. } => &[("degree", Number), ("nodes", Number)],
        StepKind::SharedNeighbours { .. } => &[("a", String), ("b", String), ("shared", Number), ("neighbours", Json)],
        _ => &[],
    }
}

/// The database's answer in the form the server's step gives: the step's fields and types
/// (counts as numbers, not the 64-bit integers Bolt sends), the query as it ran kept; a top-N
/// step stays a graph.
pub fn normalize(step: &StepKind, result: QueryResult) -> Result<QueryResult, Detail> {
    if let StepKind::TopDegree { .. } = step {
        return Ok(match result {
            QueryResult::Graph { graph } => QueryResult::Graph { graph },
            // No row at all: the query found no node.
            _ => QueryResult::Graph {
                graph: GraphSet {
                    nodes: Vec::new(),
                    edges: Vec::new(),
                    paths: None,
                    schema: GraphSchema::default(),
                    truncated: None,
                    notices: None,
                },
            },
        });
    }
    let QueryResult::Frame { frame } = result else {
        return Err(Detail::new("steps.pushdown_shape", "the database answered the graph step with no table"));
    };
    let rows = frame.rows();
    let fields = output(step)
        .iter()
        .map(|(name, field_type)| {
            let given = frame.fields().iter().find(|f| f.name == *name);
            let values = (0..rows)
                .map(|row| {
                    let v = given.and_then(|f| f.values.get(row)).cloned().unwrap_or(Value::Null);
                    match field_type {
                        FieldType::Number => super::expr::to_json(
                            super::steps::number_at(&v).map_or(super::expr::V::Null, super::expr::V::Num),
                        ),
                        _ => v,
                    }
                })
                .collect();
            Field { name: (*name).to_string(), field_type: *field_type, unit: None, values, labels: None }
        })
        .collect();
    let mut out = Frame::new(fields).expect("one value per row in every field");
    if let Some(meta) = frame.meta() {
        out = out.with_meta(meta.clone());
    }
    Ok(QueryResult::Frame { frame: out })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::analysis::parse_step;
    use crate::datasources::cypher::check;
    use serde_json::json;

    fn step(v: Value) -> StepKind {
        let mut v = v;
        v["id"] = json!("s");
        v["frame"] = json!("A");
        parse_step(&v).unwrap().kind
    }

    fn all_steps() -> Vec<StepKind> {
        vec![
            step(json!({ "type": "countLabels" })),
            step(json!({ "type": "countEdgeTypes" })),
            step(json!({ "type": "degreeDistribution", "direction": "out" })),
            step(json!({ "type": "topDegree", "n": 5, "label": "Kunde" })),
            step(json!({ "type": "topDegree", "n": 5 })),
            step(json!({ "type": "sharedNeighbours", "label": "Kunde", "via": "Produkt", "min": 2, "limit": 10 })),
            step(json!({ "type": "sharedNeighbours", "label": "Kunde", "via": "Produkt", "edgeType": "KAUFTE",
                         "min": 1, "limit": 3, "name": "name" })),
        ]
    }

    #[test]
    fn columns_are_named_or_the_query_stays_on_the_server() {
        for (q, want) in [
            ("MATCH (k:Kunde)-[r:KAUFTE]->(p) RETURN k, r, p", Some(vec!["k", "r", "p"])),
            ("MATCH p = (a)-->(b) RETURN DISTINCT p AS weg ORDER BY length(p) LIMIT 5;", Some(vec!["weg"])),
            ("MATCH (a) WITH a RETURN a, [x IN [1] | x] AS l", Some(vec!["a", "l"])),
            ("MATCH (a) CALL { WITH a RETURN a AS b } RETURN `a`, b", Some(vec!["a", "b"])),
            ("MATCH (n) RETURN n {.name} AS m", Some(vec!["m"])),
            ("MATCH (n) RETURN *", None),
            ("MATCH (n) RETURN n.name", None),
            ("MATCH (n) RETURN n UNION MATCH (n) RETURN n", None),
            ("EXPLAIN MATCH (n) RETURN n", None),
            ("CYPHER 5 MATCH (n) RETURN n", None),
            ("MATCH (n) WITH n", None),
        ] {
            let got = return_columns(q);
            assert_eq!(got, want.map(|w| w.into_iter().map(String::from).collect()), "{q}");
        }
    }

    /// Every generated query passes the same read-only check as a query typed by hand, keeps the
    /// user's parameters, and holds no writing clause.
    #[test]
    fn generated_queries_pass_the_read_only_check() {
        let user =
            "MATCH (k:Kunde)-[r:KAUFTE]->(p:Produkt) WHERE r.am >= $__timeFrom AND k.land = $land RETURN k, r, p";
        for dialect in [Dialect::Neo4j, Dialect::Memgraph] {
            for s in all_steps() {
                let q = cypher(user, &s, dialect).unwrap();
                let checked = check(&q).unwrap_or_else(|e| panic!("{q}\n{}", e.message));
                assert_eq!(
                    checked.params.into_iter().collect::<Vec<_>>(),
                    vec!["__timeFrom".to_string(), "land".to_string()],
                    "{q}"
                );
                for word in ["CREATE", "MERGE", " SET ", "DELETE", "REMOVE", "LOAD", "FOREACH"] {
                    assert!(!q.to_uppercase().contains(word), "{word} in {q}");
                }
            }
        }
    }

    #[test]
    fn names_from_the_step_cannot_break_out() {
        let evil = "x') DETACH DELETE n //";
        let s = step(json!({ "type": "sharedNeighbours", "label": evil, "via": "a\\'b", "edgeType": "T`] DELETE n",
                             "min": 1, "limit": 1, "name": "n` DELETE x //" }));
        let q = cypher("MATCH (a)-[r]->(b) RETURN a, r, b", &s, Dialect::Neo4j).unwrap();
        // The names are text or quoted names: the check sees no keyword in them.
        check(&q).unwrap_or_else(|e| panic!("{q}\n{}", e.message));
        assert!(q.contains(r"'x\') DETACH DELETE n //'"), "{q}");
        assert!(q.contains(r"'a\\\'b'"), "{q}");
        assert!(q.contains("`n`` DELETE x //`"), "{q}");
        let s = step(json!({ "type": "topDegree", "n": 3, "label": "K'); MATCH (n) DELETE n" }));
        let q = cypher("MATCH (a) RETURN a", &s, Dialect::Memgraph).unwrap();
        check(&q).unwrap_or_else(|e| panic!("{q}\n{}", e.message));
    }

    /// A user query that writes is refused by the check also inside the generated query.
    #[test]
    fn writing_user_queries_stay_refused() {
        for user in ["MATCH (n) DETACH DELETE n RETURN n", "MATCH (n) SET n.x = 1 RETURN n", "CREATE (n) RETURN n"] {
            let q = cypher(user, &all_steps()[0], Dialect::Neo4j).unwrap();
            assert!(check(&q).is_err(), "{q}");
        }
    }

    #[test]
    fn dialects_differ_in_ids_and_subqueries() {
        let s = step(json!({ "type": "topDegree", "n": 3 }));
        let neo = cypher("MATCH (a) RETURN a", &s, Dialect::Neo4j).unwrap();
        let mem = cypher("MATCH (a) RETURN a", &s, Dialect::Memgraph).unwrap();
        assert!(neo.starts_with("CALL () {\nMATCH (a) RETURN a\n}"), "{neo}");
        assert!(mem.starts_with("CALL {\nMATCH (a) RETURN a\n}"), "{mem}");
        assert!(neo.contains("elementId(__kz_n) ASC") && mem.contains("toString(id(__kz_n)) ASC"));
        assert!(neo.contains("LIMIT 3"));
        // Other steps stay on the server.
        let p = step(json!({ "type": "toFrame", "rows": "nodes", "columns": [{ "path": "name" }] }));
        assert_eq!(cypher("MATCH (a) RETURN a", &p, Dialect::Neo4j), None);
        assert_eq!(cypher("MATCH (a) RETURN *", &s, Dialect::Neo4j), None);
    }

    #[test]
    fn answers_take_the_form_of_the_server_step() {
        let frame = Frame::new(vec![
            Field {
                name: "label".into(),
                field_type: FieldType::String,
                unit: None,
                values: vec![json!("Kunde")],
                labels: None,
            },
            Field {
                name: "nodes".into(),
                field_type: FieldType::Int64,
                unit: None,
                values: vec![json!("3")],
                labels: None,
            },
            Field {
                name: "share".into(),
                field_type: FieldType::Number,
                unit: None,
                values: vec![json!(0.75)],
                labels: None,
            },
        ])
        .unwrap();
        let out = normalize(&all_steps()[0], QueryResult::Frame { frame }).unwrap();
        let QueryResult::Frame { frame } = out else { panic!() };
        assert_eq!(frame.fields()[1].field_type, FieldType::Number);
        assert_eq!(frame.fields()[1].values, vec![json!(3.0)]);
        // No row: the columns are there all the same.
        let empty = Frame::new(vec![]).unwrap();
        let QueryResult::Frame { frame } = normalize(&all_steps()[2], QueryResult::Frame { frame: empty }).unwrap()
        else {
            panic!()
        };
        assert_eq!(frame.fields().iter().map(|f| f.name.as_str()).collect::<Vec<_>>(), ["degree", "nodes"]);
        let top = normalize(&all_steps()[3], QueryResult::Frame { frame: Frame::new(vec![]).unwrap() }).unwrap();
        assert!(matches!(top, QueryResult::Graph { graph } if graph.nodes.is_empty()));
    }
}
