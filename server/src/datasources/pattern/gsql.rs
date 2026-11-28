//! Patterns as GSQL (TigerGraph, pattern matching syntax v2), and the way back.
//!
//! The compiled form, an interpreted query that `gsql.rs` checks like any other:
//!
//! ```text
//! INTERPRET QUERY (STRING firma, INT kz_v0) FOR GRAPH social SYNTAX v2 {
//!   TYPEDEF TUPLE <INT kz_o, VERTEX a, VERTEX b, EDGE e> kz_match;
//!   HeapAccum<kz_match>(500, kz_o ASC) @@kz_matches;
//!   SetAccum<VERTEX> @@kz_nodes;
//!   SetAccum<EDGE> @@kz_edges;
//!   kz_m = SELECT a FROM Person:a -(KENNT>:e)- Person:b
//!     WHERE a.name == firma AND e.seit > kz_v0
//!     LIMIT 500;
//!   kz_r = SELECT a FROM kz_m:a -(KENNT>:e)- Person:b
//!     WHERE a.name == firma AND e.seit > kz_v0
//!     ACCUM @@kz_matches += kz_match(0, a, b, e);
//!   FOREACH kz_t IN @@kz_matches DO
//!     @@kz_nodes += kz_t.a;
//!     @@kz_nodes += kz_t.b;
//!     @@kz_edges += kz_t.e;
//!   END;
//!   kz_n = {@@kz_nodes};
//!   PRINT kz_n;
//!   PRINT @@kz_edges;
//!   PRINT @@kz_matches.size() AS kz_found;
//! }
//! ```
//!
//! GSQL runs `ACCUM` over every match before `LIMIT`, and a `LIMIT` counts output vertices, not
//! matches. So the first `SELECT` limits the start nodes, and the second keeps at most `limit`
//! matches in a heap of that size, one tuple per match; only the kept matches are collected. As in
//! Cypher, `limit` is the most matches the answer holds, and `kz_found` tells `tigergraph.rs` how
//! many were kept (`pattern.limit_reached` when the heap is full).
//! A count ("Treffer zählen") adds one per match to `@@kz_count` and prints it as `matches`.
//!
//! Every value is a query parameter, declared with its type in the header and sent as a typed
//! REST parameter (`tigergraph.rs`). Ids are a `SET<VERTEX<Type>>` parameter seeding the node
//! (`kz_s0 = {ids};`); a node without a type is seeded with `{ANY}`. "Any of" conditions are one
//! group joined by `OR`.
//!
//! What GSQL cannot say is refused with a reason: optional edges (`pattern.gsql_optional`), more
//! than one type per node (`pattern.gsql_one_type`), names that are not plain
//! (`pattern.gsql_name`), and the operators `contains`, `startsWith`, `endsWith`, `isNull` and
//! `isNotNull` (`pattern.gsql_operator`; attributes always have a value in TigerGraph). Paths of
//! more than one edge have no edge alias in GSQL, so their edges are not in the result, only the
//! nodes.
//!
//! Read back: the form above, with any names; the accumulator declarations, `{@@...}` sets and
//! `PRINT` statements are optional. One `SELECT` with paths separated by commas, `WHERE` with
//! conditions joined by `AND` (`==`, `!=`, `<`, `<=`, `>`, `>=`, `IN`) or one element's
//! conditions in parentheses joined by `OR`, `ACCUM` only adding the aliases to accumulators, and
//! `LIMIT` with a number; or a limited `SELECT` without `ACCUM` and a second, otherwise equal
//! `SELECT` from its result, keeping matches as tuples (`TYPEDEF TUPLE` of `INT`, `VERTEX` and
//! `EDGE` fields, a `HeapAccum` of them, a `FOREACH` that only adds tuple fields to the sets, and
//! `PRINT @@m.size()`). Seeds `X = {param};`, `X = {Type.*};` and `X = {ANY};`. Values are
//! literals or declared parameters. Everything else is `pattern.not_representable`.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::Value;

use super::text::{Cursor, Tok, lex};
use super::{
    Binder, Compiled, Condition, Detail, Direction, Match, Operand, Operator, ParameterType, Pattern, PatternEdge,
    PatternLimits, PatternNode, RESERVED_PREFIX, declare_parameters, invalid, is_alias, is_plain_name,
    not_representable, operand_from_param,
};

fn plain(what: &str, s: &str) -> Result<String, Detail> {
    if is_plain_name(s) {
        Ok(s.to_string())
    } else {
        Err(invalid(
            "pattern.gsql_name",
            format!("TigerGraph needs plain names (letters, digits and _); the {what} {s:?} is not one"),
        )
        .with("what", what)
        .with("name", s))
    }
}

fn op_text(op: Operator) -> Result<&'static str, Detail> {
    Ok(match op {
        Operator::Eq => "==",
        Operator::Ne => "!=",
        Operator::Lt => "<",
        Operator::Le => "<=",
        Operator::Gt => ">",
        Operator::Ge => ">=",
        Operator::In => "IN",
        other => {
            let name = serde_json::to_value(other).ok().and_then(|v| v.as_str().map(String::from)).unwrap_or_default();
            return Err(invalid(
                "pattern.gsql_operator",
                format!("TigerGraph has no {name} condition in a pattern; attributes always have a value there"),
            )
            .with("op", name));
        }
    })
}

fn gsql_type(ty: ParameterType, vertex: Option<&str>) -> String {
    match ty {
        ParameterType::String => "STRING".into(),
        ParameterType::Integer => "INT".into(),
        ParameterType::Float => "DOUBLE".into(),
        ParameterType::Boolean => "BOOL".into(),
        ParameterType::StringList => "SET<STRING>".into(),
        ParameterType::IntegerList => "SET<INT>".into(),
        ParameterType::FloatList => "SET<DOUBLE>".into(),
        ParameterType::IdList => match vertex {
            Some(v) => format!("SET<VERTEX<{v}>>"),
            None => "SET<VERTEX>".into(),
        },
    }
}

fn conditions(
    b: &mut Binder<'_>,
    owner: &str,
    list: &[Condition],
    matches: Match,
    out: &mut Vec<String>,
) -> Result<(), Detail> {
    let mut own = Vec::new();
    for c in list {
        let op = op_text(c.op)?;
        let property = plain("property", &c.property)?;
        let value = c.value.as_ref().expect("checked: the operator takes a value");
        let param = b.bind(value, c.op == Operator::In)?;
        own.push(format!("{owner}.{property} {op} {param}"));
    }
    match matches {
        Match::Any if own.len() > 1 => out.push(format!("({})", own.join(" OR "))),
        _ => out.extend(own),
    }
    Ok(())
}

pub fn compile(
    p: &Pattern,
    graph: &str,
    variables: &BTreeMap<String, Value>,
    limits: &PatternLimits,
) -> Result<Compiled, Detail> {
    let graph = plain("graph", graph)?;
    let parts = p.parts()?;
    if let Some((e, _)) = parts.optional.first() {
        return Err(invalid(
            "pattern.gsql_optional",
            format!("TigerGraph has no optional parts in a pattern; make {} required or remove it", e.id),
        )
        .with("edge", &e.id));
    }
    let mut b = Binder::new(p, variables, *limits);
    // The type each node is written with: its type, or a seed set.
    let mut seeds = Vec::new();
    let mut node_type: BTreeMap<&str, String> = BTreeMap::new();
    let mut vertex_of: BTreeMap<String, String> = BTreeMap::new();
    for n in &p.nodes {
        if n.labels.len() > 1 {
            return Err(invalid(
                "pattern.gsql_one_type",
                format!("a TigerGraph vertex has one type; {} names {}", n.id, n.labels.len()),
            )
            .with("node", &n.id));
        }
        let label = n.labels.first().map(|l| plain("vertex type", l)).transpose()?;
        let seed = format!("{RESERVED_PREFIX}s{}", seeds.len());
        match (&n.ids, &label) {
            (Some(ids), Some(label)) => {
                let param = b.bind(ids, true)?;
                if let Some(other) = vertex_of.insert(param.clone(), label.clone()).filter(|o| o != label) {
                    return Err(invalid(
                        "pattern.gsql_ids_type",
                        format!("the ids in {param} cannot be of type {other} and {label}"),
                    )
                    .with("name", &param));
                }
                seeds.push(format!("{seed} = {{{param}}};"));
                node_type.insert(&n.id, seed);
            }
            (Some(_), None) => {
                return Err(invalid(
                    "pattern.gsql_ids_type",
                    format!("ids in TigerGraph belong to a vertex type; give {} a type", n.id),
                )
                .with("node", &n.id));
            }
            (None, Some(label)) => {
                node_type.insert(&n.id, label.clone());
            }
            (None, None) => {
                seeds.push(format!("{seed} = {{ANY}};"));
                node_type.insert(&n.id, seed);
            }
        }
    }
    let first = parts.edges.first().map_or(parts.nodes[0], |e| e.from.as_str());
    let mut edges = Vec::new();
    for e in &parts.edges {
        let types: Vec<String> = if e.types.is_empty() {
            vec!["_".to_string()]
        } else {
            e.types.iter().map(|t| plain("edge type", t)).collect::<Result<_, _>>()?
        };
        let alternatives: Vec<String> = types
            .iter()
            .map(|t| match e.direction {
                Direction::Out => format!("{t}>"),
                Direction::In => format!("<{t}"),
                Direction::Both => t.clone(),
            })
            .collect();
        let edge = if e.max_hops == 1 {
            format!("{}:{}", alternatives.join("|"), e.id)
        } else {
            let group =
                if alternatives.len() > 1 { format!("({})", alternatives.join("|")) } else { alternatives.join("") };
            format!("{group}*{}..{}", e.min_hops, e.max_hops)
        };
        edges.push((e, edge));
    }
    // The paths, the first node written with `start` as its type.
    let paths = |start: &str| -> String {
        let vertex = |id: &str| if id == first { format!("{start}:{id}") } else { format!("{}:{id}", node_type[id]) };
        if edges.is_empty() {
            return vertex(first);
        }
        edges
            .iter()
            .map(|(e, edge)| format!("{} -({edge})- {}", vertex(&e.from), vertex(&e.to)))
            .collect::<Vec<_>>()
            .join(", ")
    };
    let mut conds = Vec::new();
    for n in &p.nodes {
        conditions(&mut b, &n.id, &n.conditions, n.matches, &mut conds)?;
    }
    for e in &parts.edges {
        conditions(&mut b, &e.id, &e.conditions, e.matches, &mut conds)?;
    }
    let filter = if conds.is_empty() { String::new() } else { format!("\n    WHERE {}", conds.join(" AND ")) };
    let limit = (!p.count).then(|| p.effective_limit(limits));
    let mut body = String::new();
    if p.count {
        body.push_str(&format!("  SumAccum<INT> @@{RESERVED_PREFIX}count;\n"));
        for s in &seeds {
            body.push_str(&format!("  {s}\n"));
        }
        body.push_str(&format!(
            "  {RESERVED_PREFIX}m = SELECT {first} FROM {}{filter}\n    ACCUM @@{RESERVED_PREFIX}count += 1;\n  \
             PRINT @@{RESERVED_PREFIX}count AS matches;\n",
            paths(&node_type[first])
        ));
    } else if !limits.gsql_tuples {
        // Without the tuple (the query names cannot be read, TigerGraph 3.x): the limit bounds
        // the start nodes, and the matches that start there are collected.
        let mut adds: Vec<String> = p.nodes.iter().map(|n| format!("@@{RESERVED_PREFIX}nodes += {}", n.id)).collect();
        adds.extend(
            parts.edges.iter().filter(|e| e.max_hops == 1).map(|e| format!("@@{RESERVED_PREFIX}edges += {}", e.id)),
        );
        body.push_str(&format!(
            "  SetAccum<VERTEX> @@{RESERVED_PREFIX}nodes;\n  SetAccum<EDGE> @@{RESERVED_PREFIX}edges;\n"
        ));
        for s in &seeds {
            body.push_str(&format!("  {s}\n"));
        }
        body.push_str(&format!(
            "  {RESERVED_PREFIX}m = SELECT {first} FROM {}{filter}\n    LIMIT {};\n",
            paths(&node_type[first]),
            limit.unwrap_or(1)
        ));
        body.push_str(&format!(
            "  {RESERVED_PREFIX}r = SELECT {first} FROM {}{filter}\n    ACCUM {};\n",
            paths(&format!("{RESERVED_PREFIX}m")),
            adds.join(", ")
        ));
        body.push_str(&format!(
            "  {RESERVED_PREFIX}n = {{@@{RESERVED_PREFIX}nodes}};\n  PRINT {RESERVED_PREFIX}n;\n  PRINT @@{RESERVED_PREFIX}edges;\n"
        ));
    } else {
        // GSQL runs `ACCUM` before `LIMIT`, over every match. So the first `SELECT` limits the
        // start nodes, and the second keeps at most `limit` matches in a heap of that size (each
        // match one tuple); only those are collected. `kz_found` is how many were kept.
        let n = limit.unwrap_or(1);
        let edge_ids: Vec<&str> = parts.edges.iter().filter(|e| e.max_hops == 1).map(|e| e.id.as_str()).collect();
        let mut fields = vec![format!("INT {RESERVED_PREFIX}o")];
        fields.extend(p.nodes.iter().map(|n| format!("VERTEX {}", n.id)));
        fields.extend(edge_ids.iter().map(|e| format!("EDGE {e}")));
        let mut args = vec!["0".to_string()];
        args.extend(p.nodes.iter().map(|n| n.id.clone()));
        args.extend(edge_ids.iter().map(|e| (*e).to_string()));
        let mut keep: Vec<String> =
            p.nodes.iter().map(|n| format!("@@{RESERVED_PREFIX}nodes += {RESERVED_PREFIX}t.{}", n.id)).collect();
        keep.extend(edge_ids.iter().map(|e| format!("@@{RESERVED_PREFIX}edges += {RESERVED_PREFIX}t.{e}")));
        body.push_str(&format!(
            "  TYPEDEF TUPLE <{}> {RESERVED_PREFIX}match;\n  HeapAccum<{RESERVED_PREFIX}match>({n}, {RESERVED_PREFIX}o ASC) @@{RESERVED_PREFIX}matches;\n",
            fields.join(", ")
        ));
        body.push_str(&format!(
            "  SetAccum<VERTEX> @@{RESERVED_PREFIX}nodes;\n  SetAccum<EDGE> @@{RESERVED_PREFIX}edges;\n"
        ));
        for s in &seeds {
            body.push_str(&format!("  {s}\n"));
        }
        body.push_str(&format!(
            "  {RESERVED_PREFIX}m = SELECT {first} FROM {}{filter}\n    LIMIT {n};\n",
            paths(&node_type[first]),
        ));
        body.push_str(&format!(
            "  {RESERVED_PREFIX}r = SELECT {first} FROM {}{filter}\n    ACCUM @@{RESERVED_PREFIX}matches += {RESERVED_PREFIX}match({});\n",
            paths(&format!("{RESERVED_PREFIX}m")),
            args.join(", ")
        ));
        body.push_str(&format!(
            "  FOREACH {RESERVED_PREFIX}t IN @@{RESERVED_PREFIX}matches DO\n{}  END;\n",
            keep.iter().map(|k| format!("    {k};\n")).collect::<String>()
        ));
        body.push_str(&format!(
            "  {RESERVED_PREFIX}n = {{@@{RESERVED_PREFIX}nodes}};\n  PRINT {RESERVED_PREFIX}n;\n  PRINT @@{RESERVED_PREFIX}edges;\n  \
             PRINT @@{RESERVED_PREFIX}matches.size() AS {RESERVED_PREFIX}found;\n"
        ));
    }
    let (compiled, types) = b.finish(String::new(), limit);
    let header: Vec<String> = types
        .iter()
        .map(|(name, ty)| format!("{} {name}", gsql_type(*ty, vertex_of.get(name).map(String::as_str))))
        .collect();
    let text = format!("INTERPRET QUERY ({}) FOR GRAPH {graph} SYNTAX v2 {{\n{body}}}", header.join(", "));
    Ok(Compiled { text, ..compiled })
}

// ---- the way back ----

enum Seed {
    Ids(String),
    Type(String),
    Any,
    /// The result of the first `SELECT`: the node it selected, with its type and ids.
    Like(Option<String>, Option<Operand>),
}

/// What a `SELECT` was: the alias it selects, its limit and whether it accumulates.
struct Select {
    out: String,
    limit: Option<u32>,
    accum: bool,
}

struct Reader<'v> {
    c: Cursor,
    values: &'v BTreeMap<String, Value>,
    /// Declared parameters: name to type, and the vertex type of a `SET<VERTEX<T>>`.
    declared: BTreeMap<String, (ParameterType, Option<String>)>,
    accumulators: BTreeSet<String>,
    /// Tuple types declared with `TYPEDEF TUPLE`.
    tuples: BTreeSet<String>,
    seeds: BTreeMap<String, Seed>,
    nodes: Vec<PatternNode>,
    edges: Vec<PatternEdge>,
    taken: BTreeSet<String>,
    /// `taken` before the first `SELECT`, to read the second one alike.
    first_taken: Option<BTreeSet<String>>,
    generated: usize,
}

impl Reader<'_> {
    fn declaration(&mut self) -> Result<(), Detail> {
        let ty = self.c.name()?.to_ascii_uppercase();
        let (ty, vertex) = match ty.as_str() {
            "STRING" => (ParameterType::String, None),
            "INT" | "UINT" => (ParameterType::Integer, None),
            "DOUBLE" | "FLOAT" => (ParameterType::Float, None),
            "BOOL" => (ParameterType::Boolean, None),
            "SET" | "LIST" => {
                self.c.expect_sym("<")?;
                let inner = self.c.name()?.to_ascii_uppercase();
                let out = match inner.as_str() {
                    "STRING" => (ParameterType::StringList, None),
                    "INT" | "UINT" => (ParameterType::IntegerList, None),
                    "DOUBLE" | "FLOAT" => (ParameterType::FloatList, None),
                    "VERTEX" => {
                        let vertex = if self.c.eat_sym("<") {
                            let t = self.c.name()?;
                            self.c.expect_sym(">")?;
                            Some(t)
                        } else {
                            None
                        };
                        (ParameterType::IdList, vertex)
                    }
                    other => return Err(not_representable(format!("a parameter of type {ty}<{other}>"))),
                };
                self.c.expect_sym(">")?;
                out
            }
            other => return Err(not_representable(format!("a parameter of type {other}"))),
        };
        let name = self.c.name()?;
        if self.c.sym("=") {
            return Err(not_representable(format!("a default value for {name}")));
        }
        self.declared.insert(name, (ty, vertex));
        Ok(())
    }

    fn fresh(&mut self) -> String {
        loop {
            self.generated += 1;
            let name = format!("e{}", self.generated);
            if self.taken.insert(name.to_ascii_lowercase()) {
                return name;
            }
        }
    }

    /// `Type:alias`, `Seed:alias` or `:alias`; answers the alias.
    fn vertex(&mut self) -> Result<String, Detail> {
        let ty = if self.c.sym(":") { None } else { Some(self.c.name()?) };
        self.c.expect_sym(":")?;
        let alias = self.c.name()?;
        if !is_alias(&alias) {
            return Err(not_representable(format!("the name {alias}")));
        }
        let (label, ids) = match ty {
            None => (None, None),
            Some(t) => match self.seeds.get(&t) {
                Some(Seed::Ids(param)) => {
                    let label = self.declared.get(param).and_then(|(_, v)| v.clone());
                    (label, Some(operand_from_param(param, self.values)))
                }
                Some(Seed::Type(label)) => (Some(label.clone()), None),
                Some(Seed::Any) => (None, None),
                Some(Seed::Like(label, ids)) => (label.clone(), ids.clone()),
                None => (Some(t), None),
            },
        };
        match self.nodes.iter().find(|n| n.id == alias) {
            Some(n) => {
                if label.is_some() && n.labels.first() != label.as_ref() || ids.is_some() && n.ids != ids {
                    return Err(not_representable(format!("{alias} with two different types")));
                }
            }
            None => {
                if self.edges.iter().any(|e| e.id == alias) {
                    return Err(not_representable(format!("{alias} used twice")));
                }
                self.nodes.push(PatternNode {
                    id: alias.clone(),
                    labels: label.into_iter().collect(),
                    conditions: vec![],
                    matches: Match::All,
                    ids,
                });
            }
        }
        Ok(alias)
    }

    fn edge(&mut self, from: &str) -> Result<(), Detail> {
        self.c.expect_sym("-")?;
        self.c.expect_sym("(")?;
        let grouped = self.c.eat_sym("(");
        let mut types = Vec::new();
        let mut directions = BTreeSet::new();
        loop {
            let left = self.c.eat_sym("<");
            let t = self.c.name()?;
            let right = self.c.eat_sym(">");
            directions.insert(match (left, right) {
                (false, true) => Direction::Out,
                (true, false) => Direction::In,
                (false, false) => Direction::Both,
                (true, true) => return Err(not_representable("an edge pointing both ways")),
            } as u8);
            if t != "_" {
                types.push(t);
            }
            if !self.c.eat_sym("|") {
                break;
            }
        }
        if grouped {
            self.c.expect_sym(")")?;
        }
        if directions.len() != 1 {
            return Err(not_representable("edge types with different directions"));
        }
        let direction = match directions.first() {
            Some(0) => Direction::Out,
            Some(1) => Direction::In,
            _ => Direction::Both,
        };
        let (mut min, mut max) = (1, 1);
        if self.c.eat_sym("*") {
            let number = |c: &mut Cursor| match c.next() {
                Some(Tok::Num(Value::Number(n))) if n.as_u64().is_some() => {
                    Ok(u32::try_from(n.as_u64().unwrap_or(0)).unwrap_or(u32::MAX))
                }
                _ => Err(not_representable("a path without a minimum and maximum length")),
            };
            min = number(&mut self.c)?;
            self.c.expect_sym("..")?;
            max = number(&mut self.c)?;
        } else if grouped {
            return Err(not_representable("a group of edge types without a length"));
        }
        let id = if self.c.eat_sym(":") {
            let a = self.c.name()?;
            if !is_alias(&a) {
                return Err(not_representable(format!("the name {a}")));
            }
            a
        } else {
            self.fresh()
        };
        self.c.expect_sym(")")?;
        self.c.expect_sym("-")?;
        let to = self.vertex()?;
        if self.nodes.iter().any(|n| n.id == id) || self.edges.iter().any(|e| e.id == id) {
            return Err(not_representable(format!("{id} used twice")));
        }
        self.edges.push(PatternEdge {
            id,
            from: from.to_string(),
            to,
            types,
            direction,
            min_hops: min,
            max_hops: max,
            optional: false,
            conditions: vec![],
            matches: Match::All,
        });
        Ok(())
    }

    fn operand(&mut self, list: bool) -> Result<Operand, Detail> {
        let negative = self.c.eat_sym("-");
        let tok = self.c.next().ok_or_else(|| not_representable("a value missing at the end"))?;
        let v = match tok {
            Tok::Ident { text, quoted: false } if !negative && self.declared.contains_key(&text) => {
                let (ty, _) = self.declared[&text];
                if ty.is_list() != list {
                    return Err(not_representable(format!("{text} where its type does not fit")));
                }
                return Ok(operand_from_param(&text, self.values));
            }
            _ if list => return Err(not_representable("a list that is not a parameter")),
            Tok::Str(s) if !negative => Value::String(s),
            Tok::Num(Value::Number(n)) => match (negative, n.as_i64()) {
                (false, _) => Value::Number(n),
                (true, Some(i)) => Value::from(-i),
                (true, None) => {
                    serde_json::Number::from_f64(-n.as_f64().unwrap_or(0.0)).map_or(Value::Null, Value::Number)
                }
            },
            t if t.is_word("TRUE") && !negative => Value::Bool(true),
            t if t.is_word("FALSE") && !negative => Value::Bool(false),
            t => return Err(not_representable(format!("{} as a value", t.show()))),
        };
        Ok(Operand::literal(v))
    }

    fn item(&mut self) -> Result<(String, Condition), Detail> {
        if self.c.word("NOT") || self.c.sym("(") {
            return Err(not_representable(self.c.here()));
        }
        let alias = self.c.name()?;
        self.c.expect_sym(".")?;
        let property = self.c.name()?;
        let op = match self.c.next() {
            Some(Tok::Sym("==")) => Operator::Eq,
            Some(Tok::Sym("!=" | "<>")) => Operator::Ne,
            Some(Tok::Sym("<")) => Operator::Lt,
            Some(Tok::Sym("<=")) => Operator::Le,
            Some(Tok::Sym(">")) => Operator::Gt,
            Some(Tok::Sym(">=")) => Operator::Ge,
            Some(t) if t.is_word("IN") => Operator::In,
            Some(t) => return Err(not_representable(format!("the operator {}", t.show()))),
            None => return Err(not_representable("a condition without an operator")),
        };
        let value = Some(self.operand(op == Operator::In)?);
        Ok((alias, Condition { property, op, value }))
    }

    /// A condition, or in parentheses the conditions of one element joined by `OR` ("any of").
    fn condition(&mut self) -> Result<(), Detail> {
        let group = self.c.eat_sym("(");
        let mut items = vec![self.item()?];
        if group {
            while self.c.eat_word("OR") {
                items.push(self.item()?);
            }
            self.c.expect_sym(")")?;
        }
        let alias = items[0].0.clone();
        if group && (items.len() < 2 || items.iter().any(|(a, _)| *a != alias)) {
            return Err(not_representable("OR across elements, or parentheses around one condition"));
        }
        let element = match self.nodes.iter_mut().find(|n| n.id == alias) {
            Some(n) => (&mut n.conditions, &mut n.matches),
            None => match self.edges.iter_mut().find(|e| e.id == alias) {
                Some(e) => (&mut e.conditions, &mut e.matches),
                None => return Err(not_representable(format!("{alias}, which the pattern does not name"))),
            },
        };
        let (conditions, matches) = element;
        if *matches == Match::Any || group && !conditions.is_empty() {
            return Err(not_representable(format!("conditions of {alias} joined by both AND and OR")));
        }
        conditions.extend(items.into_iter().map(|(_, c)| c));
        if group {
            *matches = Match::Any;
        }
        Ok(())
    }

    fn select(&mut self) -> Result<Select, Detail> {
        self.c.expect_word("SELECT")?;
        let out = self.c.name()?;
        self.c.expect_word("FROM")?;
        loop {
            let mut at = self.vertex()?;
            while self.c.sym("-") {
                self.edge(&at)?;
                at = self.edges.last().expect("pushed").to.clone();
            }
            if !self.c.eat_sym(",") {
                break;
            }
        }
        if !self.nodes.iter().any(|n| n.id == out) {
            return Err(not_representable(format!("SELECT {out}")));
        }
        if self.c.eat_word("WHERE") {
            loop {
                self.condition()?;
                if !self.c.eat_word("AND") {
                    break;
                }
            }
        }
        let accum = self.c.eat_word("ACCUM");
        if accum {
            loop {
                self.c.expect_sym("@@")?;
                let acc = self.c.name()?;
                self.c.expect_sym("+=")?;
                let alias = self.c.name()?;
                // `@@m += kz_match(0, a, b, e)`: a match kept as a tuple of the aliases.
                let mut known = self.nodes.iter().any(|n| n.id == alias) || self.edges.iter().any(|e| e.id == alias);
                if self.tuples.contains(&alias) && self.c.eat_sym("(") {
                    known = true;
                    loop {
                        match self.c.next() {
                            Some(Tok::Num(_)) => {}
                            Some(Tok::Ident { text, .. })
                                if self.nodes.iter().any(|n| n.id == text)
                                    || self.edges.iter().any(|e| e.id == text) => {}
                            _ => known = false,
                        }
                        if self.c.eat_sym(")") {
                            break;
                        }
                        self.c.expect_sym(",")?;
                    }
                }
                if !self.accumulators.contains(&acc) || !known {
                    return Err(not_representable(format!("ACCUM @@{acc} += {alias}")));
                }
                if !self.c.eat_sym(",") {
                    break;
                }
            }
        }
        let mut limit = None;
        if self.c.eat_word("LIMIT") {
            match self.c.next() {
                Some(Tok::Num(Value::Number(n))) if n.as_u64().is_some() => {
                    limit = Some(u32::try_from(n.as_u64().unwrap_or(0)).unwrap_or(u32::MAX));
                }
                Some(t) => return Err(not_representable(format!("LIMIT {}", t.show()))),
                None => return Err(not_representable("LIMIT without a number")),
            }
        }
        self.c.expect_sym(";")?;
        Ok(Select { out, limit, accum })
    }

    fn read(mut self) -> Result<Pattern, Detail> {
        self.c.expect_word("INTERPRET")?;
        self.c.expect_word("QUERY")?;
        self.c.expect_sym("(")?;
        if !self.c.eat_sym(")") {
            loop {
                self.declaration()?;
                if self.c.eat_sym(")") {
                    break;
                }
                self.c.expect_sym(",")?;
            }
        }
        self.c.expect_word("FOR")?;
        self.c.expect_word("GRAPH")?;
        self.c.name()?;
        if self.c.eat_word("SYNTAX") {
            let v = self.c.name()?;
            if !v.eq_ignore_ascii_case("v2") {
                return Err(not_representable(format!("SYNTAX {v}")));
            }
        }
        self.c.expect_sym("{")?;
        let mut limit = None;
        let mut selected = false;
        let mut second = false;
        loop {
            if self.c.eat_sym("}") {
                break;
            }
            if self.c.word("SetAccum") {
                self.c.i += 1;
                self.c.expect_sym("<")?;
                let what = self.c.name()?;
                if !(what.eq_ignore_ascii_case("VERTEX") || what.eq_ignore_ascii_case("EDGE")) {
                    return Err(not_representable(format!("SetAccum<{what}>")));
                }
                self.c.expect_sym(">")?;
                self.c.expect_sym("@@")?;
                let name = self.c.name()?;
                self.accumulators.insert(name);
                self.c.expect_sym(";")?;
            } else if self.c.eat_word("TYPEDEF") {
                // `TYPEDEF TUPLE <INT kz_o, VERTEX a, EDGE e> kz_match;`: the shape of a kept match.
                self.c.expect_word("TUPLE")?;
                self.c.expect_sym("<")?;
                loop {
                    let ty = self.c.name()?;
                    if !["INT", "VERTEX", "EDGE"].iter().any(|t| ty.eq_ignore_ascii_case(t)) {
                        return Err(not_representable(format!("a tuple with a {ty} field")));
                    }
                    self.c.name()?;
                    if self.c.eat_sym(">") {
                        break;
                    }
                    self.c.expect_sym(",")?;
                }
                let name = self.c.name()?;
                self.tuples.insert(name);
                self.c.expect_sym(";")?;
            } else if self.c.word("HeapAccum") {
                // `HeapAccum<kz_match>(n, kz_o ASC) @@m;`: where kept matches go.
                self.c.i += 1;
                self.c.expect_sym("<")?;
                let tuple = self.c.name()?;
                self.c.expect_sym(">")?;
                self.c.expect_sym("(")?;
                let size_ok = matches!(self.c.next(), Some(Tok::Num(_)));
                self.c.expect_sym(",")?;
                self.c.name()?;
                let order_ok = self.c.eat_word("ASC") || self.c.eat_word("DESC");
                self.c.expect_sym(")")?;
                self.c.expect_sym("@@")?;
                let name = self.c.name()?;
                if !self.tuples.contains(&tuple) || !size_ok || !order_ok {
                    return Err(not_representable(format!("HeapAccum<{tuple}>")));
                }
                self.accumulators.insert(name);
                self.c.expect_sym(";")?;
            } else if self.c.eat_word("FOREACH") {
                // Kept matches into the sets: `@@set += t.field;` only.
                let var = self.c.name()?;
                self.c.expect_word("IN")?;
                self.c.expect_sym("@@")?;
                let from = self.c.name()?;
                self.c.expect_word("DO")?;
                if !self.accumulators.contains(&from) {
                    return Err(not_representable(format!("FOREACH over @@{from}")));
                }
                while !self.c.eat_word("END") {
                    self.c.expect_sym("@@")?;
                    let acc = self.c.name()?;
                    self.c.expect_sym("+=")?;
                    let of = self.c.name()?;
                    self.c.expect_sym(".")?;
                    self.c.name()?;
                    self.c.expect_sym(";")?;
                    if of != var || !self.accumulators.contains(&acc) {
                        return Err(not_representable(format!("FOREACH adding {of} to @@{acc}")));
                    }
                }
                self.c.expect_sym(";")?;
            } else if self.c.eat_word("PRINT") {
                loop {
                    self.c.eat_sym("@@");
                    self.c.name()?;
                    // `@@m.size() AS kz_found`: how many matches were kept.
                    if self.c.eat_sym(".") {
                        let method = self.c.name()?;
                        if !method.eq_ignore_ascii_case("size") {
                            return Err(not_representable(format!("PRINT .{method}()")));
                        }
                        self.c.expect_sym("(")?;
                        self.c.expect_sym(")")?;
                    }
                    if self.c.eat_word("AS") {
                        self.c.name()?;
                    }
                    if !self.c.eat_sym(",") {
                        break;
                    }
                }
                self.c.expect_sym(";")?;
            } else if matches!(self.c.peek(), Some(Tok::Ident { .. }))
                && self.c.peek_at(1).is_some_and(|t| t.is_sym("="))
            {
                let name = self.c.name()?;
                self.c.i += 1;
                if self.c.word("SELECT") {
                    if !selected {
                        selected = true;
                        self.first_taken = Some(self.taken.clone());
                        let first = self.select()?;
                        limit = first.limit;
                        if !first.accum && first.limit.is_some() {
                            // The limited matches, collected by a second SELECT from them.
                            let node = self.nodes.iter().find(|n| n.id == first.out).expect("selected");
                            self.seeds.insert(name, Seed::Like(node.labels.first().cloned(), node.ids.clone()));
                        }
                        continue;
                    }
                    if second || !self.seeds.values().any(|s| matches!(s, Seed::Like(..))) {
                        return Err(not_representable("a second SELECT"));
                    }
                    second = true;
                    let (nodes, edges) = (std::mem::take(&mut self.nodes), std::mem::take(&mut self.edges));
                    // Names given to edges without an alias come out the same the second time.
                    let (taken, generated) = (self.taken.clone(), self.generated);
                    if let Some(first_taken) = self.first_taken.take() {
                        self.taken = first_taken;
                        self.generated = 0;
                    }
                    let again = self.select()?;
                    (self.taken, self.generated) = (taken, generated);
                    let same = again.limit.is_none() && self.nodes == nodes && self.edges == edges;
                    (self.nodes, self.edges) = (nodes, edges);
                    if !same {
                        return Err(not_representable("a second SELECT that is not the same pattern"));
                    }
                    continue;
                }
                self.c.expect_sym("{")?;
                let seed = if self.c.eat_sym("@@") {
                    let acc = self.c.name()?;
                    if !selected || !self.accumulators.contains(&acc) {
                        return Err(not_representable(format!("{{@@{acc}}}")));
                    }
                    None
                } else if self.c.eat_word("ANY") {
                    Some(Seed::Any)
                } else {
                    let first = self.c.name()?;
                    if self.c.eat_sym(".") {
                        self.c.expect_sym("*")?;
                        Some(Seed::Type(first))
                    } else if self.declared.get(&first).is_some_and(|(t, _)| *t == ParameterType::IdList) {
                        Some(Seed::Ids(first))
                    } else {
                        return Err(not_representable(format!("{{{first}}}")));
                    }
                };
                self.c.expect_sym("}")?;
                self.c.expect_sym(";")?;
                if let Some(seed) = seed {
                    if selected {
                        return Err(not_representable("a seed after the SELECT"));
                    }
                    self.seeds.insert(name, seed);
                }
            } else {
                return Err(not_representable(self.c.here()));
            }
        }
        self.c.eat_sym(";");
        if !self.c.at_end() || !selected {
            return Err(not_representable(if selected { self.c.here() } else { "a query without SELECT".into() }));
        }
        let used: BTreeMap<String, ParameterType> = self
            .declared
            .iter()
            .filter(|(name, _)| !(name.starts_with(RESERVED_PREFIX) && self.values.contains_key(*name)))
            .map(|(name, (ty, _))| (name.clone(), *ty))
            .collect();
        let mut p = Pattern { nodes: self.nodes, edges: self.edges, limit, parameters: Vec::new(), count: false };
        declare_parameters(&mut p, &used)?;
        Ok(p)
    }
}

pub fn parse(text: &str, values: &BTreeMap<String, Value>) -> Result<Pattern, Detail> {
    let toks = lex(text)?;
    let taken = toks
        .iter()
        .filter_map(|t| match t {
            Tok::Ident { text, .. } => Some(text.to_ascii_lowercase()),
            _ => None,
        })
        .collect();
    Reader {
        c: Cursor::new(toks),
        values,
        declared: BTreeMap::new(),
        accumulators: BTreeSet::new(),
        tuples: BTreeSet::new(),
        seeds: BTreeMap::new(),
        nodes: Vec::new(),
        edges: Vec::new(),
        taken,
        first_taken: None,
        generated: 0,
    }
    .read()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::super::tests::knows;
    use super::super::{Dialect, compile, parse as parse_any};
    use super::*;
    use crate::datasources::gsql::{Form, check_with};

    fn compile_any(
        p: &Pattern,
        dialect: Dialect,
        graph: Option<&str>,
        variables: &BTreeMap<String, Value>,
    ) -> Result<Compiled, Detail> {
        compile(p, dialect, graph, variables, &PatternLimits::default())
    }

    fn vars(v: Value) -> BTreeMap<String, Value> {
        serde_json::from_value(v).unwrap()
    }

    #[test]
    fn a_pattern_compiles_to_checked_gsql() {
        let c = compile_any(&knows(), Dialect::TigerGraph, Some("social"), &vars(json!({ "firma": "Acme" }))).unwrap();
        assert_eq!(
            c.text,
            "INTERPRET QUERY (STRING firma) FOR GRAPH social SYNTAX v2 {\n  \
             TYPEDEF TUPLE <INT kz_o, VERTEX a, VERTEX b, EDGE e> kz_match;\n  \
             HeapAccum<kz_match>(500, kz_o ASC) @@kz_matches;\n  SetAccum<VERTEX> @@kz_nodes;\n  \
             SetAccum<EDGE> @@kz_edges;\n  kz_m = SELECT a FROM Person:a -(KENNT>:e)- Person:b\n    \
             WHERE a.name == firma\n    LIMIT 500;\n  kz_r = SELECT a FROM kz_m:a -(KENNT>:e)- Person:b\n    \
             WHERE a.name == firma\n    ACCUM @@kz_matches += kz_match(0, a, b, e);\n  \
             FOREACH kz_t IN @@kz_matches DO\n    @@kz_nodes += kz_t.a;\n    @@kz_nodes += kz_t.b;\n    \
             @@kz_edges += kz_t.e;\n  END;\n  kz_n = {@@kz_nodes};\n  PRINT kz_n;\n  PRINT @@kz_edges;\n  \
             PRINT @@kz_matches.size() AS kz_found;\n}"
        );
        assert_eq!(c.parameters, vars(json!({ "firma": "Acme" })));
        let checked = check_with(&c.text, Form::Interpret, Some(&[])).unwrap();
        assert_eq!(checked.graph.as_deref(), Some("social"));
        // The heap holds at most the limit of matches, also when it is capped by the source.
        let limits = PatternLimits { max_limit: 20, ..PatternLimits::default() };
        let capped =
            compile(&knows(), Dialect::TigerGraph, Some("social"), &vars(json!({ "firma": "A" })), &limits).unwrap();
        assert!(
            capped.text.contains("HeapAccum<kz_match>(20, kz_o ASC)") && capped.text.contains("LIMIT 20;"),
            "{}",
            capped.text
        );
        // Without the installed query names (3.x) there is no tuple: the start nodes are limited.
        let no_tuples = PatternLimits { gsql_tuples: false, ..PatternLimits::default() };
        let plain =
            compile(&knows(), Dialect::TigerGraph, Some("social"), &vars(json!({ "firma": "A" })), &no_tuples).unwrap();
        assert!(!plain.text.contains("TYPEDEF") && plain.text.contains("ACCUM @@kz_nodes += a"), "{}", plain.text);
        check_with(&plain.text, Form::Interpret, None).unwrap();
        // The tuple is refused where a query of that name exists.
        let names = ["kz_match".to_string()];
        assert_eq!(check_with(&c.text, Form::Interpret, Some(&names)).unwrap_err().reason, "gsql.typedef_name");
        // Read back, the kept-matches form is the same pattern.
        let back = parse(&c.text, &c.parameters).unwrap();
        assert_eq!(compile_any(&back, Dialect::TigerGraph, Some("social"), &c.parameters).unwrap(), c);
        // Counting: every match adds one, nothing is collected.
        let mut counted = knows();
        counted.count = true;
        let n = compile_any(&counted, Dialect::TigerGraph, Some("social"), &vars(json!({ "firma": "Acme" }))).unwrap();
        assert!(n.text.contains("ACCUM @@kz_count += 1;\n  PRINT @@kz_count AS matches;"), "{}", n.text);
        assert!(!n.text.contains("LIMIT") && n.limit.is_none(), "{}", n.text);
        check_with(&n.text, Form::Interpret, Some(&[])).unwrap();
    }

    fn rich() -> Pattern {
        serde_json::from_value(json!({
            "nodes": [
                { "id": "a", "labels": ["Person"], "ids": { "param": "ids" }, "conditions": [
                    { "property": "alter", "op": "ge", "value": { "value": 18 } }
                ] },
                { "id": "b", "labels": ["Firma"], "matches": "any", "conditions": [
                    { "property": "land", "op": "in", "value": { "param": "laender" } },
                    { "property": "aktiv", "op": "eq", "value": { "value": true } }
                ] },
                { "id": "c" }
            ],
            "edges": [
                { "id": "e", "from": "a", "to": "b", "types": ["ARBEITET_BEI", "LEITET"], "conditions": [
                    { "property": "seit", "op": "lt", "value": { "value": -2.5 } }
                ] },
                { "id": "f", "from": "c", "to": "b", "direction": "in", "types": ["A", "B"], "minHops": 2, "maxHops": 4 }
            ],
            "limit": 7,
            "parameters": [{ "name": "ids", "type": "idList" }, { "name": "laender", "type": "stringList" }]
        }))
        .unwrap()
    }

    #[test]
    fn every_part_has_its_gsql_and_reads_back() {
        let p = rich();
        let values = vars(json!({ "ids": "p1\np2", "laender": ["DE", "AT"] }));
        let c = compile_any(&p, Dialect::TigerGraph, Some("g"), &values).unwrap();
        assert!(
            c.text.starts_with(
                "INTERPRET QUERY (SET<VERTEX<Person>> ids, INT kz_v0, BOOL kz_v1, DOUBLE kz_v2, SET<STRING> laender) \
                 FOR GRAPH g SYNTAX v2 {"
            ),
            "{}",
            c.text
        );
        assert!(c.text.contains("  kz_s0 = {ids};\n  kz_s1 = {ANY};\n"), "{}", c.text);
        assert!(
            c.text.contains(
                "kz_m = SELECT a FROM kz_s0:a -(ARBEITET_BEI>|LEITET>:e)- Firma:b, kz_s1:c -((<A|<B)*2..4)- Firma:b\n    \
                 WHERE a.alter >= kz_v0 AND (b.land IN laender OR b.aktiv == kz_v1) AND e.seit < kz_v2\n    \
                 LIMIT 7;\n  \
                 kz_r = SELECT a FROM kz_m:a -(ARBEITET_BEI>|LEITET>:e)- Firma:b, kz_s1:c -((<A|<B)*2..4)- Firma:b\n    \
                 WHERE a.alter >= kz_v0 AND (b.land IN laender OR b.aktiv == kz_v1) AND e.seit < kz_v2\n    \
                 ACCUM @@kz_matches += kz_match(0, a, b, c, e);"
            ),
            "{}",
            c.text
        );
        assert_eq!(c.parameters["ids"], json!(["p1", "p2"]));
        assert_eq!(c.parameters["kz_v2"], json!(-2.5));
        check_with(&c.text, Form::Interpret, Some(&[])).unwrap();
        let parsed = parse_any(&c.text, Dialect::TigerGraph, &c.parameters);
        let back = parsed.pattern.clone().unwrap_or_else(|| panic!("{parsed:?}"));
        // The pasted list was reported the first time; read back it is a list.
        let again = compile_any(&back, Dialect::TigerGraph, Some("g"), &c.parameters).unwrap();
        assert_eq!(again, Compiled { lists: Vec::new(), ..c.clone() });
        let mut expected = p;
        // A path in GSQL has no alias; reading it back names it.
        expected.edges[1].id = back.edges[1].id.clone();
        assert_eq!(back, expected);
    }

    #[test]
    fn what_gsql_cannot_say_is_refused_with_a_reason() {
        let reason = |p: &Pattern| {
            compile_any(p, Dialect::TigerGraph, Some("g"), &vars(json!({ "firma": "x" }))).unwrap_err().reason
        };
        let mut p = knows();
        p.edges[0].optional = true;
        assert_eq!(reason(&p), "pattern.gsql_optional");
        let mut p = knows();
        p.nodes[0].labels.push("Kunde".into());
        assert_eq!(reason(&p), "pattern.gsql_one_type");
        let mut p = knows();
        p.nodes[0].labels = vec!["Kunde Gold".into()];
        assert_eq!(reason(&p), "pattern.gsql_name");
        let mut p = knows();
        p.nodes[0].conditions[0].op = Operator::Contains;
        assert_eq!(reason(&p), "pattern.gsql_operator");
        let mut p = knows();
        p.nodes[1].labels.clear();
        p.nodes[1].ids = Some(Operand::literal(json!(["x"])));
        assert_eq!(reason(&p), "pattern.gsql_ids_type");
        assert_eq!(
            compile_any(&knows(), Dialect::TigerGraph, Some("g x"), &vars(json!({ "firma": "x" }))).unwrap_err().reason,
            "pattern.gsql_name"
        );
    }

    #[test]
    fn values_stay_parameters() {
        for attack in ["x\" OR TRUE; DELETE s FROM Person:s; //", "x'; DROP ALL", "\\\" ) PRINT 1"] {
            let c = compile_any(&knows(), Dialect::TigerGraph, Some("g"), &vars(json!({ "firma": attack }))).unwrap();
            assert!(!c.text.contains(attack), "{}", c.text);
            assert_eq!(c.parameters["firma"], json!(attack));
            check_with(&c.text, Form::Interpret, Some(&[])).unwrap();
        }
    }

    #[test]
    fn the_documented_subset_reads_and_the_rest_does_not() {
        let p = parse(
            "INTERPRET QUERY (STRING firma) FOR GRAPH g { S = {Person.*}; \
             R = SELECT t FROM S:s -(KENNT>)- Person:t WHERE s.name == firma AND t.alter > 3 LIMIT 10; PRINT R; }",
            &BTreeMap::new(),
        )
        .unwrap();
        assert_eq!(p.nodes[0].labels, ["Person"]);
        assert_eq!(p.edges[0].id, "e1");
        assert_eq!(p.parameters[0].name, "firma");
        assert_eq!(p.limit, Some(10));
        for q in [
            "INTERPRET QUERY () FOR GRAPH g { R = SELECT s FROM Person:s WHERE s.a == 1 OR s.b == 2; PRINT R; }",
            "INTERPRET QUERY () FOR GRAPH g { R = SELECT s FROM Person:s; R2 = SELECT s FROM Person:s; }",
            "INTERPRET QUERY () FOR GRAPH g { R = SELECT s FROM Person:s LIMIT 5; R2 = SELECT s FROM R:s -(K>)- Person:t; }",
            "INTERPRET QUERY () FOR GRAPH g { R = SELECT s FROM Person:s -(K>)- Person:t WHERE (s.a == 1 OR t.b == 2); }",
            "INTERPRET QUERY () FOR GRAPH g { TYPEDEF TUPLE <STRING x> T; R = SELECT s FROM Person:s; }",
            "INTERPRET QUERY () FOR GRAPH g { SetAccum<VERTEX> @@n; R = SELECT s FROM Person:s ACCUM @@n += s; \
             FOREACH x IN @@n DO PRINT x; END; }",
            "INTERPRET QUERY () FOR GRAPH g { SumAccum<INT> @@n; R = SELECT s FROM Person:s ACCUM @@n += 1; }",
            "INTERPRET QUERY () FOR GRAPH g { R = SELECT s FROM Person:s POST-ACCUM s.x = 1; }",
            "INTERPRET QUERY (INT k = 3) FOR GRAPH g { R = SELECT s FROM Person:s; }",
            "INTERPRET QUERY () FOR GRAPH g { R = SELECT s FROM Person:s -(KENNT>|<KENNT)- Person:t; }",
            "INTERPRET QUERY () FOR GRAPH g { R = SELECT s FROM Person:s ORDER BY s.x; }",
            "INTERPRET QUERY () FOR GRAPH g { R = SELECT s FROM Person:s WHERE s.name LIKE \"a%\"; }",
            "INTERPRET QUERY () FOR GRAPH g { WHILE TRUE DO PRINT 1; END; }",
            "INTERPRET QUERY () FOR GRAPH g SYNTAX v1 { R = SELECT s FROM Person:s; }",
            "CREATE QUERY x() FOR GRAPH g { R = SELECT s FROM Person:s; }",
        ] {
            let parsed = parse_any(q, Dialect::TigerGraph, &BTreeMap::new());
            assert!(!parsed.representable, "{q}: {parsed:?}");
        }
    }
}
