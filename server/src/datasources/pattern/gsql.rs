//! Patterns as GSQL (TigerGraph, pattern matching syntax v2), and the way back.
//!
//! The compiled form, an interpreted query that `gsql.rs` checks like any other:
//!
//! ```text
//! INTERPRET QUERY (STRING firma, INT kz_v0) FOR GRAPH social SYNTAX v2 {
//!   SetAccum<VERTEX> @@kz_nodes;
//!   SetAccum<EDGE> @@kz_edges;
//!   kz_m = SELECT a FROM Person:a -(KENNT>:e)- Person:b
//!     WHERE a.name == firma AND e.seit > kz_v0
//!     ACCUM @@kz_nodes += a, @@kz_nodes += b, @@kz_edges += e
//!     LIMIT 100;
//!   kz_n = {@@kz_nodes};
//!   PRINT kz_n;
//!   PRINT @@kz_edges;
//! }
//! ```
//!
//! Every value is a query parameter, declared with its type in the header and sent as a typed
//! REST parameter (`tigergraph.rs`). Ids are a `SET<VERTEX<Type>>` parameter seeding the node
//! (`kz_s0 = {ids};`); a node without a type is seeded with `{ANY}`.
//!
//! What GSQL cannot say is refused with a reason: optional edges (`pattern.gsql_optional`), more
//! than one type per node (`pattern.gsql_one_type`), names that are not plain
//! (`pattern.gsql_name`), and the operators `contains`, `startsWith`, `endsWith`, `isNull` and
//! `isNotNull` (`pattern.gsql_operator`; attributes always have a value in TigerGraph). Paths of
//! more than one edge have no edge alias in GSQL, so their edges are not in the result, only the
//! nodes. The limit caps the matches of the first node; the nodes and edges collected along them
//! are cut by the source's node and edge limits.
//!
//! Read back: the form above, with any names; the accumulator declarations, `{@@...}` sets and
//! `PRINT` statements are optional. One `SELECT` with paths separated by commas, `WHERE` with
//! conditions joined by `AND` (`==`, `!=`, `<`, `<=`, `>`, `>=`, `IN`), `ACCUM` only adding the
//! aliases to accumulators, and `LIMIT` with a number. Seeds `X = {param};`, `X = {Type.*};` and
//! `X = {ANY};`. Values are literals or declared parameters. Everything else is
//! `pattern.not_representable`.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::Value;

use super::text::{Cursor, Tok, lex};
use super::{
    Binder, Compiled, Condition, Detail, Direction, Operand, Operator, ParameterType, Pattern, PatternEdge,
    PatternNode, RESERVED_PREFIX, declare_parameters, invalid, is_alias, is_plain_name, not_representable,
    operand_from_param,
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

fn conditions(b: &mut Binder<'_>, owner: &str, list: &[Condition], out: &mut Vec<String>) -> Result<(), Detail> {
    for c in list {
        let op = op_text(c.op)?;
        let property = plain("property", &c.property)?;
        let value = c.value.as_ref().expect("checked: the operator takes a value");
        let param = b.bind(value, c.op == Operator::In)?;
        out.push(format!("{owner}.{property} {op} {param}"));
    }
    Ok(())
}

pub fn compile(p: &Pattern, graph: &str, variables: &BTreeMap<String, Value>) -> Result<Compiled, Detail> {
    let graph = plain("graph", graph)?;
    let parts = p.parts()?;
    if let Some((e, _)) = parts.optional.first() {
        return Err(invalid(
            "pattern.gsql_optional",
            format!("TigerGraph has no optional parts in a pattern; make {} required or remove it", e.id),
        )
        .with("edge", &e.id));
    }
    let mut b = Binder::new(p, variables);
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
    let vertex = |id: &str| format!("{}:{id}", node_type[id]);
    let mut paths = Vec::new();
    let mut accum: Vec<String> = Vec::new();
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
            accum.push(format!("@@{RESERVED_PREFIX}edges += {}", e.id));
            format!("{}:{}", alternatives.join("|"), e.id)
        } else {
            let group =
                if alternatives.len() > 1 { format!("({})", alternatives.join("|")) } else { alternatives.join("") };
            format!("{group}*{}..{}", e.min_hops, e.max_hops)
        };
        paths.push(format!("{} -({edge})- {}", vertex(&e.from), vertex(&e.to)));
    }
    if parts.edges.is_empty() {
        paths.push(vertex(parts.nodes[0]));
    }
    let mut conds = Vec::new();
    for n in &p.nodes {
        conditions(&mut b, &n.id, &n.conditions, &mut conds)?;
    }
    for e in &parts.edges {
        conditions(&mut b, &e.id, &e.conditions, &mut conds)?;
    }
    let mut adds: Vec<String> = p.nodes.iter().map(|n| format!("@@{RESERVED_PREFIX}nodes += {}", n.id)).collect();
    adds.extend(accum);
    let first = parts.edges.first().map_or(parts.nodes[0], |e| e.from.as_str());
    let mut select = format!("  {RESERVED_PREFIX}m = SELECT {first} FROM {}", paths.join(", "));
    if !conds.is_empty() {
        select.push_str(&format!("\n    WHERE {}", conds.join(" AND ")));
    }
    select.push_str(&format!("\n    ACCUM {}\n    LIMIT {};", adds.join(", "), p.limit()));
    let (compiled, types) = b.finish(String::new());
    let header: Vec<String> = types
        .iter()
        .map(|(name, ty)| format!("{} {name}", gsql_type(*ty, vertex_of.get(name).map(String::as_str))))
        .collect();
    let mut text = format!("INTERPRET QUERY ({}) FOR GRAPH {graph} SYNTAX v2 {{\n", header.join(", "));
    text.push_str(&format!(
        "  SetAccum<VERTEX> @@{RESERVED_PREFIX}nodes;\n  SetAccum<EDGE> @@{RESERVED_PREFIX}edges;\n"
    ));
    for s in seeds {
        text.push_str(&format!("  {s}\n"));
    }
    text.push_str(&select);
    text.push_str(&format!(
        "\n  {RESERVED_PREFIX}n = {{@@{RESERVED_PREFIX}nodes}};\n  PRINT {RESERVED_PREFIX}n;\n  PRINT @@{RESERVED_PREFIX}edges;\n}}"
    ));
    Ok(Compiled { text, parameters: compiled.parameters })
}

// ---- the way back ----

enum Seed {
    Ids(String),
    Type(String),
    Any,
}

struct Reader<'v> {
    c: Cursor,
    values: &'v BTreeMap<String, Value>,
    /// Declared parameters: name to type, and the vertex type of a `SET<VERTEX<T>>`.
    declared: BTreeMap<String, (ParameterType, Option<String>)>,
    accumulators: BTreeSet<String>,
    seeds: BTreeMap<String, Seed>,
    nodes: Vec<PatternNode>,
    edges: Vec<PatternEdge>,
    taken: BTreeSet<String>,
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

    fn condition(&mut self) -> Result<(), Detail> {
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
        let condition = Condition { property, op, value };
        if let Some(n) = self.nodes.iter_mut().find(|n| n.id == alias) {
            n.conditions.push(condition);
        } else if let Some(e) = self.edges.iter_mut().find(|e| e.id == alias) {
            e.conditions.push(condition);
        } else {
            return Err(not_representable(format!("{alias}, which the pattern does not name")));
        }
        Ok(())
    }

    fn select(&mut self) -> Result<Option<u32>, Detail> {
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
        if self.c.eat_word("ACCUM") {
            loop {
                self.c.expect_sym("@@")?;
                let acc = self.c.name()?;
                self.c.expect_sym("+=")?;
                let alias = self.c.name()?;
                let known = self.nodes.iter().any(|n| n.id == alias) || self.edges.iter().any(|e| e.id == alias);
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
        Ok(limit)
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
            } else if self.c.eat_word("PRINT") {
                loop {
                    self.c.eat_sym("@@");
                    self.c.name()?;
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
                    if selected {
                        return Err(not_representable("a second SELECT"));
                    }
                    selected = true;
                    limit = self.select()?;
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
        let mut p = Pattern { nodes: self.nodes, edges: self.edges, limit, parameters: Vec::new() };
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
        seeds: BTreeMap::new(),
        nodes: Vec::new(),
        edges: Vec::new(),
        taken,
        generated: 0,
    }
    .read()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::super::tests::knows;
    use super::super::{Dialect, compile as compile_any, parse as parse_any};
    use super::*;
    use crate::datasources::gsql::{Form, check_with};

    fn vars(v: Value) -> BTreeMap<String, Value> {
        serde_json::from_value(v).unwrap()
    }

    #[test]
    fn a_pattern_compiles_to_checked_gsql() {
        let c = compile_any(&knows(), Dialect::TigerGraph, Some("social"), &vars(json!({ "firma": "Acme" }))).unwrap();
        assert_eq!(
            c.text,
            "INTERPRET QUERY (STRING firma) FOR GRAPH social SYNTAX v2 {\n  SetAccum<VERTEX> @@kz_nodes;\n  \
             SetAccum<EDGE> @@kz_edges;\n  kz_m = SELECT a FROM Person:a -(KENNT>:e)- Person:b\n    \
             WHERE a.name == firma\n    ACCUM @@kz_nodes += a, @@kz_nodes += b, @@kz_edges += e\n    LIMIT 100;\n  \
             kz_n = {@@kz_nodes};\n  PRINT kz_n;\n  PRINT @@kz_edges;\n}"
        );
        assert_eq!(c.parameters, vars(json!({ "firma": "Acme" })));
        let checked = check_with(&c.text, Form::Interpret, None).unwrap();
        assert_eq!(checked.graph.as_deref(), Some("social"));
    }

    fn rich() -> Pattern {
        serde_json::from_value(json!({
            "nodes": [
                { "id": "a", "labels": ["Person"], "ids": { "param": "ids" }, "conditions": [
                    { "property": "alter", "op": "ge", "value": { "value": 18 } }
                ] },
                { "id": "b", "labels": ["Firma"], "conditions": [
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
                "SELECT a FROM kz_s0:a -(ARBEITET_BEI>|LEITET>:e)- Firma:b, kz_s1:c -((<A|<B)*2..4)- Firma:b\n    \
                 WHERE a.alter >= kz_v0 AND b.land IN laender AND b.aktiv == kz_v1 AND e.seit < kz_v2\n    \
                 ACCUM @@kz_nodes += a, @@kz_nodes += b, @@kz_nodes += c, @@kz_edges += e\n    LIMIT 7;"
            ),
            "{}",
            c.text
        );
        assert_eq!(c.parameters["ids"], json!(["p1", "p2"]));
        assert_eq!(c.parameters["kz_v2"], json!(-2.5));
        check_with(&c.text, Form::Interpret, None).unwrap();
        let parsed = parse_any(&c.text, Dialect::TigerGraph, &c.parameters);
        let back = parsed.pattern.clone().unwrap_or_else(|| panic!("{parsed:?}"));
        assert_eq!(compile_any(&back, Dialect::TigerGraph, Some("g"), &c.parameters).unwrap(), c);
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
            check_with(&c.text, Form::Interpret, None).unwrap();
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
