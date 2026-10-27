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
use crate::shapes::{Field, FieldType, Frame, GraphSchema, GraphSet, Notice, NoticeSeverity, QueryResult};

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

/// The column that says the query's rows were cut at the row limit (`CUT`), in every answer.
pub const CUT: &str = "__kz_cut";
/// The column of the shared-neighbours answer that counts the pairs the step would make.
const PAIRS: &str = "__kz_pairs";

/// The user's query, cut at `cap` rows as the server cuts it, and every distinct node and
/// relationship it returned. `__kz_nodes` holds `[node, returned]` (1 for a node the query
/// returned, 0 for one known only as the end of a relationship, which counts as a node without
/// labels, as on the server); `__kz_rels` the relationships; `__kz_cut` whether rows were cut.
fn prelude(query: &str, columns: &[String], dialect: Dialect, cap: usize) -> String {
    // Neo4j types the columns while planning and refuses `nodes()` on a column that cannot be a
    // path; read through a map with a key known only when running, a value has no known type.
    let (row, values) = match dialect {
        Dialect::Neo4j => {
            let map = columns.iter().map(|c| format!("{}: {}", quoted(c), quoted(c))).collect::<Vec<_>>().join(", ");
            let keys = columns.iter().map(|c| text(c)).collect::<Vec<_>>().join(", ");
            (format!("{{{map}}}"), format!("UNWIND [{keys}] AS __kz_k\nWITH __kz_cut, __kz_row[__kz_k] AS __kz_v\n"))
        }
        Dialect::Memgraph => {
            let list = columns.iter().map(|c| quoted(c)).collect::<Vec<_>>().join(", ");
            (format!("[{list}]"), "UNWIND __kz_row AS __kz_v\n".to_string())
        }
    };
    format!(
        "{call}\n{query}\n}}\n\
         WITH {row} AS __kz_row\n\
         LIMIT {more}\n\
         WITH collect(__kz_row) AS __kz_all\n\
         WITH size(__kz_all) > {cap} AS __kz_cut, __kz_all[0..{cap}] AS __kz_all\n\
         UNWIND __kz_all AS __kz_row\n\
         {values}\
         UNWIND CASE WHEN {list} THEN __kz_v ELSE [__kz_v] END AS __kz_e\n\
         UNWIND CASE\n  \
         WHEN {node} THEN [[__kz_e, 1]]\n  \
         WHEN {rel} THEN [[__kz_e, 1], [startNode(__kz_e), 0], [endNode(__kz_e), 0]]\n  \
         WHEN {path} THEN [__kz_y IN nodes(__kz_e) | [__kz_y, 1]] + [__kz_y IN relationships(__kz_e) | [__kz_y, 1]]\n  \
         ELSE [] END AS __kz_p\n\
         WITH __kz_cut, __kz_p[0] AS __kz_x, max(__kz_p[1]) AS __kz_f\n\
         WITH __kz_cut, collect(CASE WHEN {xnode} THEN [__kz_x, __kz_f] END) AS __kz_nodes,\n     \
         collect(CASE WHEN {xrel} THEN __kz_x END) AS __kz_rels\n",
        call = dialect.call(),
        more = cap + 1,
        list = is_type("__kz_v", "LIST"),
        node = is_type("__kz_e", "NODE"),
        rel = is_type("__kz_e", "RELATIONSHIP"),
        path = is_type("__kz_e", "PATH"),
        xnode = is_type("__kz_x", "NODE"),
        xrel = is_type("__kz_x", "RELATIONSHIP"),
    )
}

/// Per node, its degree in `direction`, its relationships (each listed at both its ends) and
/// whether the query returned it, as `__kz_n`, `__kz_d`, `__kz_rs`, `__kz_f`; nodes without
/// relationships too.
fn degree_rows(direction: Direction) -> String {
    let (out, inn) = match direction {
        Direction::Both => (1, 1),
        Direction::Out => (1, 0),
        Direction::In => (0, 1),
    };
    format!(
        "UNWIND [__kz_q IN __kz_nodes | [__kz_q[0], 0, null, __kz_q[1]]]\n  \
         + [__kz_r IN __kz_rels | [startNode(__kz_r), {out}, __kz_r, 0]]\n  \
         + [__kz_r IN __kz_rels | [endNode(__kz_r), {inn}, __kz_r, 0]] AS __kz_p\n\
         WITH __kz_cut, __kz_p[0] AS __kz_n, sum(__kz_p[1]) AS __kz_d, collect(__kz_p[2]) AS __kz_rs,\n     \
         max(__kz_p[3]) AS __kz_f\n"
    )
}

/// Per end of each relationship: the relationship `__kz_r`, its side `__kz_side` (0 start, 1
/// end), the node `__kz_n` and whether the query returned that node `__kz_f`.
const ENDS: &str = "UNWIND [__kz_q IN __kz_nodes | [__kz_q[0], __kz_q[1], null, null]]\n  \
     + [__kz_r IN __kz_rels | [startNode(__kz_r), 0, __kz_r, 0]]\n  \
     + [__kz_r IN __kz_rels | [endNode(__kz_r), 0, __kz_r, 1]] AS __kz_q\n\
     WITH __kz_cut, __kz_q[0] AS __kz_n, max(__kz_q[1]) AS __kz_f,\n     \
     collect(CASE WHEN __kz_q[2] IS NOT NULL THEN [__kz_q[2], __kz_q[3]] END) AS __kz_inc\n\
     UNWIND __kz_inc AS __kz_i\n\
     WITH __kz_cut, __kz_i[0] AS __kz_r, __kz_i[1] AS __kz_side, __kz_n, __kz_f\n";

/// A node's labels joined with `:`, null without labels.
fn labels_text(node: &str) -> String {
    format!(
        "reduce(__kz_s = null, __kz_l IN labels({node}) | CASE WHEN __kz_s IS NULL THEN __kz_l ELSE __kz_s + ':' + __kz_l END)"
    )
}

/// The Cypher that runs `step` on the result of `query` in the database, the query cut at
/// `max_rows` rows as the server cuts it; `None` when the step or the query cannot run there.
pub fn cypher(query: &str, step: &StepKind, dialect: Dialect, max_rows: usize) -> Option<String> {
    let columns = return_columns(query)?;
    let query = query.trim_end().trim_end_matches(';');
    let tail = match step {
        StepKind::CountLabels { .. } => format!(
            "WITH __kz_cut, __kz_nodes, size(__kz_nodes) AS __kz_total\n\
             UNWIND __kz_nodes AS __kz_q\n\
             UNWIND CASE WHEN __kz_q[1] = 1 THEN labels(__kz_q[0]) ELSE [] END AS __kz_l\n\
             WITH __kz_cut, __kz_l, __kz_total, count(*) AS __kz_c\n\
             RETURN __kz_l AS `label`, __kz_c AS `nodes`, toFloat(__kz_c) / __kz_total AS `share`, __kz_cut AS `{CUT}`\n\
             ORDER BY `nodes` DESC, `label` ASC"
        ),
        StepKind::CountEdgeTypes { .. } => format!(
            "{ENDS}\
             WITH __kz_cut, __kz_r, collect([__kz_side, CASE WHEN __kz_f = 1 THEN {labels} END]) AS __kz_ends\n\
             WITH __kz_cut, type(__kz_r) AS __kz_t,\n     \
             [__kz_e IN __kz_ends WHERE __kz_e[0] = 0][0][1] AS __kz_fr,\n     \
             [__kz_e IN __kz_ends WHERE __kz_e[0] = 1][0][1] AS __kz_o\n\
             WITH __kz_cut, __kz_t, __kz_fr, __kz_o, count(*) AS __kz_c\n\
             RETURN __kz_t AS `type`, __kz_fr AS `from`, __kz_o AS `to`, __kz_c AS `edges`, __kz_cut AS `{CUT}`\n\
             ORDER BY `edges` DESC, `type` ASC, `from` ASC, `to` ASC",
            labels = labels_text("__kz_n"),
        ),
        StepKind::DegreeDistribution { direction, .. } => format!(
            "{rows}WITH __kz_cut, __kz_d, count(*) AS __kz_c\n\
             RETURN __kz_d AS `degree`, __kz_c AS `nodes`, __kz_cut AS `{CUT}`\n\
             ORDER BY `degree` ASC",
            rows = degree_rows(*direction),
        ),
        StepKind::TopDegree { n, label, direction, .. } => {
            let only = label
                .as_ref()
                .map(|l| format!("WHERE __kz_f = 1 AND {} IN labels(__kz_n)\n", text(l)))
                .unwrap_or_default();
            // Each relationship is listed at both its ends: one listed twice among the kept nodes
            // has both ends there. A row without one carries the kept nodes.
            format!(
                "{rows}{only}WITH __kz_cut, __kz_n, __kz_d, __kz_rs\n\
                 ORDER BY __kz_d DESC, {id} ASC\n\
                 LIMIT {n}\n\
                 UNWIND [null] + __kz_rs AS __kz_r\n\
                 WITH __kz_cut, __kz_r, count(*) AS __kz_k, collect(__kz_n) AS __kz_ns\n\
                 WITH __kz_cut, __kz_r, __kz_k, __kz_ns WHERE __kz_r IS NULL OR __kz_k >= 2\n\
                 RETURN CASE WHEN __kz_r IS NULL THEN __kz_ns ELSE __kz_r END AS `element`, __kz_cut AS `{CUT}`",
                rows = degree_rows(*direction),
                id = dialect.id("__kz_n"),
            )
        }
        StepKind::SharedNeighbours { label, via, edge_type, min, limit, name, .. } => {
            let (l, v) = (text(label), text(via));
            let pick = format!("{l} IN __kz_sl AND {v} IN __kz_tl");
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
            // The pairs grow with the square of each neighbour's nodes: counted first, and made
            // only within the server's cell budget. A row without a pair always comes first and
            // carries the count, so the server learns it also when no pair is made.
            format!(
                "{ENDS}\
                 WITH __kz_cut, __kz_r, collect([__kz_side, __kz_n, CASE WHEN __kz_f = 1 THEN labels(__kz_n) ELSE [] END]) AS __kz_ends\n\
                 WITH __kz_cut, __kz_r, [__kz_e IN __kz_ends WHERE __kz_e[0] = 0][0] AS __kz_se,\n     \
                 [__kz_e IN __kz_ends WHERE __kz_e[0] = 1][0] AS __kz_te\n\
                 WITH __kz_cut, __kz_r, __kz_se[1] AS __kz_s, __kz_se[2] AS __kz_sl, __kz_te[1] AS __kz_t, __kz_te[2] AS __kz_tl\n\
                 WHERE {typed}(({pick}) OR ({v} IN __kz_sl AND {l} IN __kz_tl))\n\
                 WITH DISTINCT __kz_cut, CASE WHEN {pick} THEN __kz_s ELSE __kz_t END AS __kz_a,\n     \
                 CASE WHEN {pick} THEN __kz_t ELSE __kz_s END AS __kz_v\n\
                 WITH __kz_cut, __kz_v, collect(__kz_a) AS __kz_as\n\
                 WITH max(CASE WHEN __kz_cut THEN 1 ELSE 0 END) AS __kz_cn,\n     \
                 sum(size(__kz_as) * (size(__kz_as) - 1) / 2) AS __kz_pairs, collect([__kz_v, __kz_as]) AS __kz_groups\n\
                 UNWIND [null] + CASE WHEN __kz_pairs <= {budget} THEN __kz_groups ELSE [] END AS __kz_g\n\
                 UNWIND CASE WHEN __kz_g IS NULL THEN [null] ELSE __kz_g[1] END AS __kz_x\n\
                 UNWIND CASE WHEN __kz_g IS NULL THEN [null] ELSE __kz_g[1] END AS __kz_y\n\
                 WITH __kz_cn, __kz_pairs, __kz_x, __kz_y, __kz_g[0] AS __kz_v\n\
                 WHERE __kz_x IS NULL OR {xi} < {yi}\n\
                 WITH __kz_cn, __kz_pairs, __kz_x, __kz_y, __kz_v ORDER BY CASE WHEN __kz_v IS NULL THEN '' ELSE {vi} END ASC\n\
                 WITH __kz_cn, __kz_pairs, __kz_x, __kz_y, collect(__kz_v) AS __kz_vs\n\
                 WHERE __kz_x IS NULL OR size(__kz_vs) >= {min}\n\
                 WITH __kz_cn, __kz_pairs, __kz_x, __kz_y, __kz_vs,\n     \
                 CASE WHEN __kz_x IS NULL THEN null ELSE {xi} END AS __kz_xi, CASE WHEN __kz_x IS NULL THEN null ELSE {yi} END AS __kz_yi\n\
                 ORDER BY CASE WHEN __kz_x IS NULL THEN 0 ELSE 1 END ASC, size(__kz_vs) DESC, __kz_xi ASC, __kz_yi ASC\n\
                 LIMIT {more}\n\
                 RETURN CASE WHEN __kz_x IS NULL THEN null ELSE {xn} END AS `a`, CASE WHEN __kz_x IS NULL THEN null ELSE {yn} END AS `b`,\n       \
                 size(__kz_vs) AS `shared`, [__kz_w IN __kz_vs | {wn}] AS `neighbours`,\n       \
                 __kz_cn = 1 AS `{CUT}`, __kz_pairs AS `{PAIRS}`",
                budget = super::steps::MAX_CELLS,
                more = *limit + 1,
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
    Some(format!("{}{tail}", prelude(query, &columns, dialect, max_rows)))
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
/// (counts as numbers, not the 64-bit integers Bolt sends), the query as it ran kept, a cut at
/// the row limit marked; a top-N step stays a graph. Shared neighbours beyond the server's cell
/// budget are `steps.too_many_cells`, as on the server.
pub fn normalize(step: &StepKind, result: QueryResult, max_rows: usize) -> Result<QueryResult, Detail> {
    if let StepKind::TopDegree { .. } = step {
        return Ok(match result {
            // The graph builder marks a cut it is told of (`CUT`, datasources/neo4j.rs).
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
    let column = |name: &str| frame.fields().iter().find(|f| f.name == name);
    let cut = column(CUT).is_some_and(|f| f.values.contains(&Value::Bool(true)));
    if let Some(pairs) = column(PAIRS).and_then(|f| f.values.iter().find_map(super::steps::number_at)) {
        let max = super::steps::MAX_CELLS;
        if pairs > max as f64 {
            return Err(Detail::new("steps.too_many_cells", format!("the step would make more than {max} cells"))
                .with("max", max));
        }
    }
    // The row that only carries the counts of the shared-neighbours step is no pair.
    let rows: Vec<usize> = (0..frame.rows())
        .filter(|row| {
            !matches!(step, StepKind::SharedNeighbours { .. })
                || column("a").and_then(|f| f.values.get(*row)).is_some_and(|v| !v.is_null())
        })
        .collect();
    let fields = output(step)
        .iter()
        .map(|(name, field_type)| {
            let given = column(name);
            let values = rows
                .iter()
                .map(|row| {
                    let v = given.and_then(|f| f.values.get(*row)).cloned().unwrap_or(Value::Null);
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
    let mut meta = frame.meta().cloned().unwrap_or_default();
    if cut {
        meta.rows_truncated = true;
        meta.notices.push(Notice {
            severity: NoticeSeverity::Warning,
            code: "graph.row_limit".into(),
            params: Some([("limit".to_string(), max_rows.to_string())].into()),
            text: format!("only the first {max_rows} records are counted (row limit)"),
        });
    }
    Ok(QueryResult::Frame { frame: Frame::new(fields).expect("one value per row in every field").with_meta(meta) })
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
                let q = cypher(user, &s, dialect, 1000).unwrap();
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
        let q = cypher("MATCH (a)-[r]->(b) RETURN a, r, b", &s, Dialect::Neo4j, 1000).unwrap();
        // The names are text or quoted names: the check sees no keyword in them.
        check(&q).unwrap_or_else(|e| panic!("{q}\n{}", e.message));
        assert!(q.contains(r"'x\') DETACH DELETE n //'"), "{q}");
        assert!(q.contains(r"'a\\\'b'"), "{q}");
        assert!(q.contains("`n`` DELETE x //`"), "{q}");
        let s = step(json!({ "type": "topDegree", "n": 3, "label": "K'); MATCH (n) DELETE n" }));
        let q = cypher("MATCH (a) RETURN a", &s, Dialect::Memgraph, 1000).unwrap();
        check(&q).unwrap_or_else(|e| panic!("{q}\n{}", e.message));
    }

    /// A user query that writes is refused by the check also inside the generated query.
    #[test]
    fn writing_user_queries_stay_refused() {
        for user in ["MATCH (n) DETACH DELETE n RETURN n", "MATCH (n) SET n.x = 1 RETURN n", "CREATE (n) RETURN n"] {
            let q = cypher(user, &all_steps()[0], Dialect::Neo4j, 1000).unwrap();
            assert!(check(&q).is_err(), "{q}");
        }
    }

    #[test]
    fn dialects_differ_in_ids_and_subqueries() {
        let s = step(json!({ "type": "topDegree", "n": 3 }));
        let neo = cypher("MATCH (a) RETURN a", &s, Dialect::Neo4j, 1000).unwrap();
        let mem = cypher("MATCH (a) RETURN a", &s, Dialect::Memgraph, 1000).unwrap();
        assert!(neo.starts_with("CALL () {\nMATCH (a) RETURN a\n}"), "{neo}");
        assert!(mem.starts_with("CALL {\nMATCH (a) RETURN a\n}"), "{mem}");
        assert!(neo.contains("elementId(__kz_n) ASC") && mem.contains("toString(id(__kz_n)) ASC"));
        assert!(neo.contains("LIMIT 3"));
        // Other steps stay on the server.
        let p = step(json!({ "type": "toFrame", "rows": "nodes", "columns": [{ "path": "name" }] }));
        assert_eq!(cypher("MATCH (a) RETURN a", &p, Dialect::Neo4j, 1000), None);
        assert_eq!(cypher("MATCH (a) RETURN *", &s, Dialect::Neo4j, 1000), None);
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
        let out = normalize(&all_steps()[0], QueryResult::Frame { frame }, 1000).unwrap();
        let QueryResult::Frame { frame } = out else { panic!() };
        assert_eq!(frame.fields()[1].field_type, FieldType::Number);
        assert_eq!(frame.fields()[1].values, vec![json!(3.0)]);
        // No row: the columns are there all the same.
        let empty = Frame::new(vec![]).unwrap();
        let QueryResult::Frame { frame } =
            normalize(&all_steps()[2], QueryResult::Frame { frame: empty }, 1000).unwrap()
        else {
            panic!()
        };
        assert_eq!(frame.fields().iter().map(|f| f.name.as_str()).collect::<Vec<_>>(), ["degree", "nodes"]);
        let top = normalize(&all_steps()[3], QueryResult::Frame { frame: Frame::new(vec![]).unwrap() }, 1000).unwrap();
        assert!(matches!(top, QueryResult::Graph { graph } if graph.nodes.is_empty()));
    }

    fn field(name: &str, field_type: FieldType, values: Vec<Value>) -> Field {
        Field { name: name.into(), field_type, unit: None, values, labels: None }
    }

    /// The database reads at most the server's row limit of the query and says when it cut.
    #[test]
    fn the_row_limit_holds_and_a_cut_is_marked() {
        let q = cypher("MATCH (a) RETURN a", &all_steps()[0], Dialect::Neo4j, 500).unwrap();
        assert!(q.contains("LIMIT 501") && q.contains("size(__kz_all) > 500") && q.contains("__kz_all[0..500]"), "{q}");
        let frame = Frame::new(vec![
            field("label", FieldType::String, vec![json!("Kunde")]),
            field("nodes", FieldType::Int64, vec![json!("500")]),
            field("share", FieldType::Number, vec![json!(1.0)]),
            field(CUT, FieldType::Bool, vec![json!(true)]),
        ])
        .unwrap();
        let QueryResult::Frame { frame } = normalize(&all_steps()[0], QueryResult::Frame { frame }, 500).unwrap()
        else {
            panic!()
        };
        let meta = frame.meta().unwrap();
        assert!(meta.rows_truncated);
        assert_eq!(meta.notices[0].code, "graph.row_limit");
        assert_eq!(frame.fields().len(), 3, "the cut column is no field of the step");
    }

    /// Shared neighbours: the counting row is no pair, and more pairs than the server's cell
    /// budget are refused before they are made.
    #[test]
    fn shared_neighbours_are_bounded() {
        let q = cypher("MATCH (a)-[r]->(b) RETURN a, r, b", &all_steps()[5], Dialect::Neo4j, 1000).unwrap();
        assert!(q.contains(&format!("__kz_pairs <= {}", crate::analysis::steps::MAX_CELLS)), "{q}");
        let answer = |pairs: Value| {
            Frame::new(vec![
                field("a", FieldType::String, vec![Value::Null, json!("Anna")]),
                field("b", FieldType::String, vec![Value::Null, json!("Ben")]),
                field("shared", FieldType::Int64, vec![json!("0"), json!("2")]),
                field("neighbours", FieldType::Json, vec![json!([]), json!(["Abo", "Dock"])]),
                field(CUT, FieldType::Bool, vec![json!(false), json!(false)]),
                field(PAIRS, FieldType::Int64, vec![pairs.clone(), pairs]),
            ])
            .unwrap()
        };
        let QueryResult::Frame { frame } =
            normalize(&all_steps()[5], QueryResult::Frame { frame: answer(json!("3")) }, 1000).unwrap()
        else {
            panic!()
        };
        assert_eq!(frame.fields()[0].values, vec![json!("Anna")]);
        assert_eq!(frame.fields()[2].values, vec![json!(2.0)]);
        let too_many = json!((crate::analysis::steps::MAX_CELLS + 1).to_string());
        let e = normalize(&all_steps()[5], QueryResult::Frame { frame: answer(too_many) }, 1000).unwrap_err();
        assert_eq!(e.reason, "steps.too_many_cells");
    }
}
