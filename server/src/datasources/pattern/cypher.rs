//! Patterns as Cypher (Neo4j and Memgraph), and the way back.
//!
//! The compiled form, which is also the subset the way back reads:
//!
//! ```text
//! MATCH kz_p0 = (a:Person)-[e:KENNT]->(b), (c)
//! WHERE (b:Person OR b:Firma) AND a.name = $firma AND (e.seit > $kz_v0 OR e.seit IS NULL)
//! OPTIONAL MATCH kz_p1 = (b)-[f:WOHNT_IN]->(d:Ort)
//! WHERE d.land = $kz_v1
//! RETURN kz_p0, c, kz_p1
//! LIMIT 500
//! ```
//!
//! A node with one label carries it in the pattern; with several, one of them must hold, written
//! as `(x:A OR x:B)`. "Any of" conditions are one group joined by `OR`. A count ("Treffer
//! zählen") ends with `RETURN count(*) AS matches` and no limit.
//!
//! Read back: one or more `MATCH` clauses with comma-separated paths, each optionally followed by
//! `WHERE` with conditions joined by `AND`; then `OPTIONAL MATCH` clauses with one relationship
//! each (a pattern makes each optional edge optional on its own) and their `WHERE`, whose
//! conditions name only what that clause brings in; then `RETURN` with names only (or `*`, or
//! `count(*)`) and an optional `LIMIT` with a number. Nodes `(a:L {key: value})` or
//! `(a:L1|L2)`, relationships with types `[:A|B]`, a length `*1..3` (a maximum is needed) and
//! `{key: value}`, all three directions. Conditions: `x.key` with `=`, `<>`, `<`, `<=`, `>`,
//! `>=`, `CONTAINS`, `STARTS WITH`, `ENDS WITH`, `IN`, `IS NULL`, `IS NOT NULL`,
//! `elementId(x) IN ...` (Neo4j) or `id(x) IN ...` (Memgraph); in parentheses, the conditions
//! of one element joined by `OR`, or label tests `(x:A OR x:B)`. Values are literals (text,
//! numbers, `true`, `false`, lists) or `$parameters`. Everything else (`OR` across elements,
//! `NOT`, `WITH`, functions, other aggregations, `ORDER BY`, paths without a maximum length,
//! `(a:L1:L2)` with all of several labels) is `pattern.not_representable`. Without `LIMIT` the
//! pattern takes its default limit.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::Value;

use super::text::{Cursor, Tok, lex};
use super::{
    Binder, Compiled, Condition, Detail, Dialect, Direction, KEYWORDS, Match, Operand, Operator, ParameterType,
    Pattern, PatternEdge, PatternLimits, PatternNode, RESERVED_PREFIX, declare_parameters, invalid, is_alias,
    is_plain_name, not_representable, operand_from_param,
};

/// A label, type or property as Cypher writes it: plain, or in backticks.
fn name(s: &str) -> String {
    if is_plain_name(s) && !KEYWORDS.contains(&s.to_ascii_lowercase().as_str()) {
        s.to_string()
    } else {
        format!("`{}`", s.replace('`', "``"))
    }
}

fn op_text(op: Operator) -> &'static str {
    match op {
        Operator::Eq => "=",
        Operator::Ne => "<>",
        Operator::Lt => "<",
        Operator::Le => "<=",
        Operator::Gt => ">",
        Operator::Ge => ">=",
        Operator::Contains => "CONTAINS",
        Operator::StartsWith => "STARTS WITH",
        Operator::EndsWith => "ENDS WITH",
        Operator::In => "IN",
        Operator::IsNull => "IS NULL",
        Operator::IsNotNull => "IS NOT NULL",
    }
}

struct Writer<'a> {
    pattern: &'a Pattern,
    dialect: Dialect,
    binder: Binder<'a>,
    /// Nodes already written with their labels.
    written: BTreeSet<String>,
}

impl Writer<'_> {
    fn node(&mut self, id: &str) -> String {
        let n = self.pattern.node(id).expect("checked");
        if !self.written.insert(id.to_string()) {
            return format!("({id})");
        }
        // Several labels are a choice, written as a condition (`node_conditions`).
        match n.labels.as_slice() {
            [one] => format!("({id}:{})", name(one)),
            _ => format!("({id})"),
        }
    }

    fn edge(&mut self, e: &PatternEdge) -> String {
        let from = self.node(&e.from);
        let to = self.node(&e.to);
        let types = if e.types.is_empty() {
            String::new()
        } else {
            format!(":{}", e.types.iter().map(|t| name(t)).collect::<Vec<_>>().join("|"))
        };
        let hops =
            if e.min_hops == 1 && e.max_hops == 1 { String::new() } else { format!("*{}..{}", e.min_hops, e.max_hops) };
        let rel = format!("[{}{types}{hops}]", e.id);
        match e.direction {
            Direction::Out => format!("{from}-{rel}->{to}"),
            Direction::In => format!("{from}<-{rel}-{to}"),
            Direction::Both => format!("{from}-{rel}-{to}"),
        }
    }

    /// The element's conditions: each one, or with "any" one group joined by `OR`.
    fn conditions(
        &mut self,
        owner: &str,
        conditions: &[Condition],
        matches: Match,
        out: &mut Vec<String>,
    ) -> Result<(), Detail> {
        let mut own = Vec::new();
        for c in conditions {
            let left = format!("{owner}.{}", name(&c.property));
            match &c.value {
                Some(v) => {
                    let param = self.binder.bind(v, c.op == Operator::In)?;
                    own.push(format!("{left} {} ${param}", op_text(c.op)));
                }
                None => own.push(format!("{left} {}", op_text(c.op))),
            }
        }
        match matches {
            Match::Any if own.len() > 1 => out.push(format!("({})", own.join(" OR "))),
            _ => out.extend(own),
        }
        Ok(())
    }

    /// The conditions of node `id`: its choice of labels, its database ids, then its properties.
    fn node_conditions(&mut self, id: &str, out: &mut Vec<String>) -> Result<(), Detail> {
        let n = self.pattern.node(id).expect("checked");
        if n.labels.len() > 1 {
            let tests: Vec<String> = n.labels.iter().map(|l| format!("{id}:{}", name(l))).collect();
            out.push(format!("({})", tests.join(" OR ")));
        }
        if let Some(ids) = &n.ids {
            let param = self.binder.bind(ids, true)?;
            match self.dialect {
                Dialect::Memgraph => {
                    // Memgraph's ids are whole numbers.
                    let (value, _) = self.binder.bound.get_mut(&param).expect("bound");
                    let numbers = value
                        .as_array()
                        .into_iter()
                        .flatten()
                        .map(|v| match v {
                            Value::Number(n) if n.is_i64() => Some(v.clone()),
                            Value::String(s) => s.trim().parse::<i64>().ok().map(Value::from),
                            _ => None,
                        })
                        .collect::<Option<Vec<_>>>()
                        .ok_or_else(|| {
                            invalid("pattern.parameter_type", "Memgraph node ids are whole numbers")
                                .with("name", &param)
                                .with("type", "a list of whole numbers")
                        })?;
                    *value = Value::Array(numbers);
                    out.push(format!("id({id}) IN ${param}"));
                }
                _ => out.push(format!("elementId({id}) IN ${param}")),
            }
        }
        self.conditions(id, &n.conditions, n.matches, out)
    }
}

fn where_clause(text: &mut String, conditions: &[String]) {
    if !conditions.is_empty() {
        text.push_str("\nWHERE ");
        text.push_str(&conditions.join(" AND "));
    }
}

pub fn compile(
    p: &Pattern,
    dialect: Dialect,
    variables: &BTreeMap<String, Value>,
    limits: &PatternLimits,
) -> Result<Compiled, Detail> {
    let parts = p.parts()?;
    let binder = Binder::new(p, variables, *limits);
    let mut w = Writer { pattern: p, dialect, binder, written: BTreeSet::new() };
    let mut segments = Vec::new();
    let mut returned = Vec::new();
    let mut path = 0;
    for e in &parts.edges {
        let name = format!("{RESERVED_PREFIX}p{path}");
        path += 1;
        segments.push(format!("{name} = {}", w.edge(e)));
        returned.push(name);
    }
    for n in &parts.nodes {
        if !w.written.contains(*n) {
            segments.push(w.node(n));
            returned.push((*n).to_string());
        }
    }
    let mut text = format!("MATCH {}", segments.join(", "));
    let mut conditions = Vec::new();
    for n in &p.nodes {
        if parts.nodes.contains(&n.id.as_str()) {
            w.node_conditions(&n.id, &mut conditions)?;
        }
    }
    for e in &parts.edges {
        w.conditions(&e.id, &e.conditions, e.matches, &mut conditions)?;
    }
    where_clause(&mut text, &conditions);
    for (e, new) in &parts.optional {
        let name = format!("{RESERVED_PREFIX}p{path}");
        path += 1;
        text.push_str(&format!("\nOPTIONAL MATCH {name} = {}", w.edge(e)));
        returned.push(name);
        let mut conditions = Vec::new();
        for n in new {
            w.node_conditions(n, &mut conditions)?;
        }
        w.conditions(&e.id, &e.conditions, e.matches, &mut conditions)?;
        where_clause(&mut text, &conditions);
    }
    if p.count {
        text.push_str("\nRETURN count(*) AS matches");
        return Ok(w.binder.finish(text, None).0);
    }
    let limit = p.effective_limit(limits);
    text.push_str(&format!("\nRETURN {}\nLIMIT {limit}", returned.join(", ")));
    Ok(w.binder.finish(text, Some(limit)).0)
}

// ---- the way back ----

/// Where an alias came in: the required part or the optional clause with this number.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Clause {
    Required,
    Optional(usize),
}

struct Reader<'v> {
    c: Cursor,
    values: &'v BTreeMap<String, Value>,
    nodes: Vec<PatternNode>,
    edges: Vec<PatternEdge>,
    /// Alias to the clause that brought it in; paths too.
    introduced: BTreeMap<String, Clause>,
    paths: BTreeSet<String>,
    types: BTreeMap<String, ParameterType>,
    /// Every name in the text, so generated aliases do not clash.
    taken: BTreeSet<String>,
    generated: usize,
    clause: Clause,
}

impl Reader<'_> {
    fn fresh(&mut self, prefix: &str) -> String {
        loop {
            self.generated += 1;
            let name = format!("{prefix}{}", self.generated);
            if !self.taken.contains(&name.to_ascii_lowercase()) {
                self.taken.insert(name.to_ascii_lowercase());
                return name;
            }
        }
    }

    fn alias(&mut self) -> Result<Option<String>, Detail> {
        match self.c.peek() {
            Some(Tok::Ident { text, quoted }) => {
                let text = text.clone();
                if *quoted || !is_alias(&text) {
                    return Err(not_representable(format!("the name {text}")));
                }
                self.c.i += 1;
                Ok(Some(text))
            }
            _ => Ok(None),
        }
    }

    /// `{key: value, ...}` as equality conditions.
    fn properties(&mut self) -> Result<Vec<Condition>, Detail> {
        let mut out = Vec::new();
        if !self.c.eat_sym("{") {
            return Ok(out);
        }
        if self.c.eat_sym("}") {
            return Ok(out);
        }
        loop {
            let property = self.c.name()?;
            self.c.expect_sym(":")?;
            let value = self.operand(ParameterType::String, false)?;
            out.push(Condition { property, op: Operator::Eq, value: Some(value) });
            if self.c.eat_sym("}") {
                return Ok(out);
            }
            self.c.expect_sym(",")?;
        }
    }

    /// A node; answers its alias.
    fn node(&mut self) -> Result<String, Detail> {
        self.c.expect_sym("(")?;
        let alias = self.alias()?;
        let mut labels = Vec::new();
        let mut all_of = false;
        if self.c.eat_sym(":") {
            labels.push(self.c.name()?);
            loop {
                if self.c.eat_sym("|") {
                    self.c.eat_sym(":");
                } else if self.c.eat_sym(":") {
                    all_of = true;
                } else {
                    break;
                }
                labels.push(self.c.name()?);
            }
        }
        if all_of {
            return Err(not_representable("a node with all of several labels (a pattern takes one of them)"));
        }
        let conditions = self.properties()?;
        self.c.expect_sym(")")?;
        let id = match alias {
            Some(a) => a,
            None => self.fresh("n"),
        };
        if self.edges.iter().any(|e| e.id == id) || self.paths.contains(&id) {
            return Err(not_representable(format!("{id} names a node and something else")));
        }
        match self.nodes.iter_mut().find(|n| n.id == id) {
            Some(n) => {
                let here = self.introduced[&id];
                if here != self.clause && (!labels.is_empty() || !conditions.is_empty()) {
                    return Err(not_representable(format!(
                        "labels or properties of {id} in a clause other than the one it comes in"
                    )));
                }
                if !labels.is_empty() && !n.labels.is_empty() && labels != n.labels {
                    return Err(not_representable(format!("two sets of labels for {id}")));
                }
                if !labels.is_empty() {
                    n.labels = labels;
                }
                n.conditions.extend(conditions);
            }
            None => {
                self.introduced.insert(id.clone(), self.clause);
                self.nodes.push(PatternNode { id: id.clone(), labels, conditions, matches: Match::All, ids: None });
            }
        }
        Ok(id)
    }

    /// A relationship between `from` and the next node: `-[...]->`, `<-[...]-`, `-[...]-` or
    /// the forms without brackets.
    fn relationship(&mut self, from: &str) -> Result<String, Detail> {
        let left = self.c.eat_sym("<");
        self.c.expect_sym("-")?;
        let (mut id, mut types, mut min, mut max, mut conditions) = (None, Vec::new(), 1u32, 1u32, Vec::new());
        if self.c.eat_sym("[") {
            id = self.alias()?;
            if self.c.eat_sym(":") {
                types.push(self.c.name()?);
                while self.c.eat_sym("|") {
                    self.c.eat_sym(":");
                    types.push(self.c.name()?);
                }
            }
            if self.c.eat_sym("*") {
                let number = |c: &mut Cursor| match c.peek() {
                    Some(Tok::Num(Value::Number(n))) if n.as_u64().is_some() => {
                        let v = n.as_u64().unwrap_or(0);
                        c.i += 1;
                        Some(u32::try_from(v).unwrap_or(u32::MAX))
                    }
                    _ => None,
                };
                let first = number(&mut self.c);
                if self.c.eat_sym("..") {
                    min = first.unwrap_or(1);
                    max = number(&mut self.c).ok_or_else(|| not_representable("a path without a maximum length"))?;
                } else {
                    let exact = first.ok_or_else(|| not_representable("a path without a maximum length"))?;
                    (min, max) = (exact, exact);
                }
            }
            conditions = self.properties()?;
            self.c.expect_sym("]")?;
        }
        self.c.expect_sym("-")?;
        let right = self.c.eat_sym(">");
        let direction = match (left, right) {
            (false, true) => Direction::Out,
            (true, false) => Direction::In,
            (false, false) => Direction::Both,
            (true, true) => return Err(not_representable("a relationship pointing both ways")),
        };
        let to = self.node()?;
        let id = match id {
            Some(id) => id,
            None => self.fresh("e"),
        };
        if self.introduced.contains_key(&id) || self.paths.contains(&id) {
            return Err(not_representable(format!("{id} used twice")));
        }
        self.introduced.insert(id.clone(), self.clause);
        self.edges.push(PatternEdge {
            id: id.clone(),
            from: from.to_string(),
            to,
            types,
            direction,
            min_hops: min,
            max_hops: max,
            optional: matches!(self.clause, Clause::Optional(_)),
            conditions,
            matches: Match::All,
        });
        Ok(id)
    }

    /// One path, `name = (a)-[...]->(b)...`; answers how many relationships it has.
    fn path(&mut self) -> Result<usize, Detail> {
        if matches!(self.c.peek(), Some(Tok::Ident { .. })) && self.c.peek_at(1).is_some_and(|t| t.is_sym("=")) {
            // Any plain name, also Kalzit's own `kz_p0`: a path name is not kept in the pattern.
            let name = match self.c.next() {
                Some(Tok::Ident { text, quoted: false }) => text,
                _ => return Err(not_representable("a path name")),
            };
            self.c.expect_sym("=")?;
            if self.introduced.contains_key(&name) || !self.paths.insert(name.clone()) {
                return Err(not_representable(format!("{name} used twice")));
            }
        }
        let mut at = self.node()?;
        let mut count = 0;
        while self.c.sym("-") || self.c.sym("<") {
            self.relationship(&at)?;
            at = self.edges.last().expect("pushed").to.clone();
            count += 1;
        }
        Ok(count)
    }

    fn operand(&mut self, hint: ParameterType, list: bool) -> Result<Operand, Detail> {
        let scalar = |c: &mut Cursor| -> Result<Value, Detail> {
            let negative = c.eat_sym("-");
            let v = match c.next() {
                Some(Tok::Str(s)) if !negative => Value::String(s),
                Some(Tok::Num(Value::Number(n))) => {
                    if !negative {
                        Value::Number(n)
                    } else if let Some(i) = n.as_i64() {
                        Value::from(-i)
                    } else {
                        serde_json::Number::from_f64(-n.as_f64().unwrap_or(0.0))
                            .map(Value::Number)
                            .unwrap_or(Value::Null)
                    }
                }
                Some(t) if t.is_word("true") && !negative => Value::Bool(true),
                Some(t) if t.is_word("false") && !negative => Value::Bool(false),
                Some(t) => return Err(not_representable(format!("{} as a value", t.show()))),
                None => return Err(not_representable("a value missing at the end")),
            };
            Ok(v)
        };
        if let Some(Tok::Param(p)) = self.c.peek() {
            let p = p.clone();
            self.c.i += 1;
            let op = operand_from_param(&p, self.values);
            if matches!(op, Operand::Param(_)) {
                self.types.entry(p).or_insert(hint);
            }
            return Ok(op);
        }
        if list {
            self.c.expect_sym("[")?;
            let mut items = Vec::new();
            if !self.c.eat_sym("]") {
                loop {
                    items.push(scalar(&mut self.c)?);
                    if self.c.eat_sym("]") {
                        break;
                    }
                    self.c.expect_sym(",")?;
                }
            }
            return Ok(Operand::literal(Value::Array(items)));
        }
        Ok(Operand::literal(scalar(&mut self.c)?))
    }

    fn check_place(&self, alias: &str) -> Result<(), Detail> {
        match self.introduced.get(alias) {
            None => Err(not_representable(format!("{alias}, which the pattern does not name"))),
            Some(c) if *c != self.clause => {
                Err(not_representable(format!("a condition on {alias} in a clause other than the one it comes in")))
            }
            Some(_) => Ok(()),
        }
    }

    /// One condition: a property comparison, ids, or a label test `x:L`; with its alias.
    fn item(&mut self) -> Result<(String, Item), Detail> {
        if self.c.word("NOT") || self.c.sym("(") {
            return Err(not_representable(self.c.here()));
        }
        // elementId(x) IN ... / id(x) IN ...
        if (self.c.word("elementId") || self.c.word("id")) && self.c.peek_at(1).is_some_and(|t| t.is_sym("(")) {
            self.c.i += 2;
            let alias = self.c.name()?;
            self.c.expect_sym(")")?;
            self.c.expect_word("IN")?;
            self.check_place(&alias)?;
            let ids = self.operand(ParameterType::IdList, true)?;
            return Ok((alias, Item::Ids(ids)));
        }
        let alias = self.c.name()?;
        self.check_place(&alias)?;
        if self.c.eat_sym(":") {
            return Ok((alias, Item::Label(self.c.name()?)));
        }
        self.c.expect_sym(".")?;
        let property = self.c.name()?;
        let (op, value) = if self.c.eat_word("IS") {
            let not = self.c.eat_word("NOT");
            self.c.expect_word("NULL")?;
            (if not { Operator::IsNotNull } else { Operator::IsNull }, None)
        } else {
            let op = match self.c.next() {
                Some(Tok::Sym("=")) => Operator::Eq,
                Some(Tok::Sym("<>")) => Operator::Ne,
                Some(Tok::Sym("<")) => Operator::Lt,
                Some(Tok::Sym("<=")) => Operator::Le,
                Some(Tok::Sym(">")) => Operator::Gt,
                Some(Tok::Sym(">=")) => Operator::Ge,
                Some(t) if t.is_word("CONTAINS") => Operator::Contains,
                Some(t) if t.is_word("IN") => Operator::In,
                Some(t) if t.is_word("STARTS") => {
                    self.c.expect_word("WITH")?;
                    Operator::StartsWith
                }
                Some(t) if t.is_word("ENDS") => {
                    self.c.expect_word("WITH")?;
                    Operator::EndsWith
                }
                Some(t) => return Err(not_representable(format!("the operator {}", t.show()))),
                None => return Err(not_representable("a condition without an operator")),
            };
            let hint = if op == Operator::In { ParameterType::StringList } else { ParameterType::String };
            (op, Some(self.operand(hint, op == Operator::In)?))
        };
        Ok((alias, Item::Condition(Condition { property, op, value })))
    }

    /// The conditions of `alias`, and whether they are an "any" group.
    fn element(&mut self, alias: &str) -> Result<(&mut Vec<Condition>, &mut Match), Detail> {
        if let Some(n) = self.nodes.iter_mut().find(|n| n.id == alias) {
            return Ok((&mut n.conditions, &mut n.matches));
        }
        if let Some(e) = self.edges.iter_mut().find(|e| e.id == alias) {
            return Ok((&mut e.conditions, &mut e.matches));
        }
        Err(not_representable(format!("a condition on the path {alias}")))
    }

    /// A condition, or in parentheses a group joined by `OR` on one element: its conditions
    /// ("any of") or its labels ("one of").
    fn condition(&mut self) -> Result<(), Detail> {
        if !self.c.eat_sym("(") {
            let (alias, item) = self.item()?;
            match item {
                Item::Condition(c) => {
                    let (conditions, matches) = self.element(&alias)?;
                    if *matches == Match::Any {
                        return Err(not_representable(format!("conditions of {alias} joined by both AND and OR")));
                    }
                    conditions.push(c);
                }
                Item::Ids(ids) => {
                    let node = self
                        .nodes
                        .iter_mut()
                        .find(|n| n.id == alias)
                        .ok_or_else(|| not_representable(format!("ids of {alias}, which is no node")))?;
                    if node.ids.replace(ids).is_some() {
                        return Err(not_representable(format!("two id lists for {alias}")));
                    }
                }
                Item::Label(_) => return Err(not_representable(format!("a single label test on {alias}"))),
            }
            return Ok(());
        }
        let mut items = vec![self.item()?];
        while self.c.eat_word("OR") {
            items.push(self.item()?);
        }
        self.c.expect_sym(")")?;
        let alias = items[0].0.clone();
        if items.len() < 2 || items.iter().any(|(a, _)| *a != alias) {
            return Err(not_representable("OR across elements, or parentheses around one condition"));
        }
        if items.iter().all(|(_, i)| matches!(i, Item::Label(_))) {
            let node = self
                .nodes
                .iter_mut()
                .find(|n| n.id == alias)
                .ok_or_else(|| not_representable(format!("labels of {alias}, which is no node")))?;
            if !node.labels.is_empty() {
                return Err(not_representable(format!("two sets of labels for {alias}")));
            }
            node.labels =
                items.into_iter().filter_map(|(_, i)| if let Item::Label(l) = i { Some(l) } else { None }).collect();
            return Ok(());
        }
        let mut group = Vec::new();
        for (_, i) in items {
            match i {
                Item::Condition(c) => group.push(c),
                _ => return Err(not_representable(format!("ids or labels joined by OR with conditions of {alias}"))),
            }
        }
        let (conditions, matches) = self.element(&alias)?;
        if !conditions.is_empty() {
            return Err(not_representable(format!("conditions of {alias} joined by both AND and OR")));
        }
        *conditions = group;
        *matches = Match::Any;
        Ok(())
    }

    fn where_part(&mut self) -> Result<(), Detail> {
        if !self.c.eat_word("WHERE") {
            return Ok(());
        }
        loop {
            self.condition()?;
            if !self.c.eat_word("AND") {
                return Ok(());
            }
        }
    }

    fn read(mut self) -> Result<Pattern, Detail> {
        let mut optional = 0;
        let mut any_match = false;
        loop {
            if self.c.eat_word("MATCH") {
                if optional > 0 {
                    return Err(not_representable("MATCH after OPTIONAL MATCH"));
                }
                any_match = true;
                self.clause = Clause::Required;
                loop {
                    self.path()?;
                    if !self.c.eat_sym(",") {
                        break;
                    }
                }
                self.where_part()?;
            } else if self.c.word("OPTIONAL") && self.c.peek_at(1).is_some_and(|t| t.is_word("MATCH")) {
                if !any_match {
                    return Err(not_representable("OPTIONAL MATCH at the start"));
                }
                self.c.i += 2;
                self.clause = Clause::Optional(optional);
                optional += 1;
                if self.path()? != 1 || self.c.sym(",") {
                    return Err(not_representable("OPTIONAL MATCH with other than one relationship"));
                }
                self.where_part()?;
            } else if self.c.eat_word("RETURN") {
                break;
            } else {
                return Err(not_representable(self.c.here()));
            }
        }
        if !any_match {
            return Err(not_representable("a query without MATCH"));
        }
        let mut count = false;
        if self.c.word("count") && self.c.peek_at(1).is_some_and(|t| t.is_sym("(")) {
            self.c.i += 2;
            self.c.expect_sym("*")?;
            self.c.expect_sym(")")?;
            if self.c.eat_word("AS") {
                self.c.name()?;
            }
            count = true;
        } else if !self.c.eat_sym("*") {
            loop {
                let item = self.c.name()?;
                if !self.introduced.contains_key(&item) && !self.paths.contains(&item) {
                    return Err(not_representable(format!("RETURN {item}")));
                }
                if self.c.word("AS") || self.c.sym(".") || self.c.sym("(") {
                    return Err(not_representable(format!("RETURN {item} {}", self.c.here())));
                }
                if !self.c.eat_sym(",") {
                    break;
                }
            }
        }
        let mut limit = None;
        if !count && self.c.eat_word("LIMIT") {
            match self.c.next() {
                Some(Tok::Num(Value::Number(n))) if n.as_u64().is_some() => {
                    limit = Some(u32::try_from(n.as_u64().unwrap_or(0)).unwrap_or(u32::MAX));
                }
                Some(t) => return Err(not_representable(format!("LIMIT {}", t.show()))),
                None => return Err(not_representable("LIMIT without a number")),
            }
        }
        self.c.eat_sym(";");
        if !self.c.at_end() {
            return Err(not_representable(self.c.here()));
        }
        let mut p = Pattern { nodes: self.nodes, edges: self.edges, limit, parameters: Vec::new(), count };
        declare_parameters(&mut p, &self.types)?;
        Ok(p)
    }
}

/// One part of a `WHERE`, before it is given to its element.
enum Item {
    Condition(Condition),
    Ids(Operand),
    Label(String),
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
    let reader = Reader {
        c: Cursor::new(toks),
        values,
        nodes: Vec::new(),
        edges: Vec::new(),
        introduced: BTreeMap::new(),
        paths: BTreeSet::new(),
        types: BTreeMap::new(),
        taken,
        generated: 0,
        clause: Clause::Required,
    };
    reader.read()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::super::tests::knows;
    use super::super::{Compiled, PatternLimits, compile, parse as parse_any};
    use super::*;
    use crate::datasources::cypher::check;

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

    fn pattern(v: Value) -> Pattern {
        serde_json::from_value(v).unwrap()
    }

    #[test]
    fn a_pattern_compiles_to_cypher_with_bound_values() {
        let c = compile_any(&knows(), Dialect::Neo4j, None, &vars(json!({ "firma": "Acme" }))).unwrap();
        assert_eq!(
            c.text,
            "MATCH kz_p0 = (a:Person)-[e:KENNT]->(b:Person)\nWHERE a.name = $firma\nRETURN kz_p0\nLIMIT 500"
        );
        assert_eq!(c.parameters, vars(json!({ "firma": "Acme" })));
        check(&c.text).unwrap();
    }

    fn rich() -> Pattern {
        pattern(json!({
            "nodes": [
                { "id": "a", "labels": ["Person", "Kunde Gold"], "conditions": [
                    { "property": "alter", "op": "ge", "value": { "value": 18 } },
                    { "property": "name", "op": "startsWith", "value": { "value": "A" } },
                    { "property": "gesperrt", "op": "isNull" }
                ], "ids": { "param": "ids" } },
                { "id": "b", "labels": ["Firma"], "conditions": [
                    { "property": "land", "op": "in", "value": { "value": ["DE", "AT"] } }
                ] },
                { "id": "c" },
                { "id": "d", "labels": ["Ort"], "matches": "any", "conditions": [
                    { "property": "plz", "op": "contains", "value": { "value": "10" } },
                    { "property": "stadt", "op": "isNotNull" }
                ] }
            ],
            "edges": [
                { "id": "e", "from": "a", "to": "b", "types": ["ARBEITET_BEI", "LEITET"], "conditions": [
                    { "property": "seit", "op": "lt", "value": { "value": 2.5 } }
                ] },
                { "id": "f", "from": "b", "to": "c", "direction": "both", "minHops": 1, "maxHops": 3 },
                { "id": "g", "from": "d", "to": "b", "direction": "in", "optional": true }
            ],
            "limit": 25,
            "parameters": [{ "name": "ids", "type": "idList" }]
        }))
    }

    #[test]
    fn every_part_of_a_pattern_has_its_cypher() {
        let p = rich();
        let c = compile_any(&p, Dialect::Neo4j, None, &vars(json!({ "ids": "4:x:1\n4:x:2" }))).unwrap();
        assert_eq!(
            c.text,
            "MATCH kz_p0 = (a)-[e:ARBEITET_BEI|LEITET]->(b:Firma), kz_p1 = (b)-[f*1..3]-(c)\n\
             WHERE (a:Person OR a:`Kunde Gold`) AND elementId(a) IN $ids AND a.alter >= $kz_v0 \
             AND a.name STARTS WITH $kz_v1 AND a.gesperrt IS NULL AND b.land IN $kz_v2 AND e.seit < $kz_v3\n\
             OPTIONAL MATCH kz_p2 = (d:Ort)<-[g]-(b)\n\
             WHERE (d.plz CONTAINS $kz_v4 OR d.stadt IS NOT NULL)\n\
             RETURN kz_p0, kz_p1, kz_p2\nLIMIT 25"
        );
        assert_eq!(c.parameters["ids"], json!(["4:x:1", "4:x:2"]));
        assert_eq!(c.parameters["kz_v0"], json!(18));
        assert_eq!(c.parameters["kz_v2"], json!(["DE", "AT"]));
        assert_eq!(c.parameters["kz_v3"], json!(2.5));
        assert_eq!(c.limit, Some(25));
        assert_eq!((c.lists[0].name.as_str(), c.lists[0].values), ("ids", 2));
        check(&c.text).unwrap();
        // The data source's row limit caps the pattern's.
        let limits = PatternLimits { max_limit: 10, ..PatternLimits::default() };
        let capped = compile(&p, Dialect::Neo4j, None, &vars(json!({ "ids": "x" })), &limits).unwrap();
        assert!(capped.text.ends_with("LIMIT 10") && capped.limit == Some(10), "{}", capped.text);
        // Counting the matches: the same pattern without a limit.
        let mut counted = p.clone();
        counted.count = true;
        let n = compile_any(&counted, Dialect::Neo4j, None, &vars(json!({ "ids": "x" }))).unwrap();
        assert!(n.text.ends_with("OPTIONAL MATCH kz_p2 = (d:Ort)<-[g]-(b)\nWHERE (d.plz CONTAINS $kz_v4 OR d.stadt IS NOT NULL)\nRETURN count(*) AS matches"), "{}", n.text);
        assert_eq!(n.limit, None);
        check(&n.text).unwrap();
        assert!(parse(&n.text, &n.parameters).unwrap().count);
        // Memgraph names nodes by number.
        let m = compile_any(&p, Dialect::Memgraph, None, &vars(json!({ "ids": "1 2" }))).unwrap();
        assert!(m.text.contains(" AND id(a) IN $ids AND "), "{}", m.text);
        assert_eq!(m.parameters["ids"], json!([1, 2]));
        let e = compile_any(&p, Dialect::Memgraph, None, &vars(json!({ "ids": "4:x:1" }))).unwrap_err();
        assert_eq!(e.reason, "pattern.parameter_type");
    }

    #[test]
    fn compiled_patterns_read_back_the_same() {
        let values = vars(json!({ "ids": ["4:x:1"] }));
        for p in [knows(), rich()] {
            let c = compile_any(
                &p,
                Dialect::Neo4j,
                None,
                &values.clone().into_iter().chain([("firma".into(), json!("A"))]).collect(),
            )
            .unwrap();
            let parsed = parse_any(&c.text, Dialect::Neo4j, &c.parameters);
            let back = parsed.pattern.clone().unwrap_or_else(|| panic!("{parsed:?}"));
            // Template parameters stay parameters, literals come back as literals.
            let again = compile_any(&back, Dialect::Neo4j, None, &c.parameters).unwrap();
            assert_eq!(again, c, "{back:?}");
            let mut expected = p.clone();
            expected.limit = Some(p.limit());
            for param in &mut expected.parameters {
                param.label = None;
            }
            let mut back = back;
            back.nodes.sort_by(|a, b| a.id.cmp(&b.id));
            expected.nodes.sort_by(|a, b| a.id.cmp(&b.id));
            assert_eq!(back, expected);
        }
    }

    #[test]
    fn the_documented_subset_reads_into_a_pattern() {
        let p = parse(
            "match (a:Person {name: 'Ana', alter: -3})-[:KENNT]->(:Person)<--(c), (c)-[r:A|:B *2]-(d) \
             where r.x = true and c.k in [1, 2.5] and id(d) IN [7] return * limit 5;",
            &BTreeMap::new(),
        )
        .unwrap();
        assert_eq!(p.nodes.len(), 4);
        assert_eq!(p.nodes[0].conditions[1].value, Some(Operand::literal(json!(-3))));
        assert_eq!(p.nodes[1].id, "n1");
        assert_eq!(p.edges[0].id, "e2");
        assert_eq!(p.edges[1].direction, Direction::In);
        assert_eq!((p.edges[2].min_hops, p.edges[2].max_hops, p.edges[2].direction), (2, 2, Direction::Both));
        assert_eq!(p.edges[2].types, ["A", "B"]);
        assert_eq!(p.nodes[3].ids, Some(Operand::literal(json!([7]))));
        assert_eq!(p.limit, Some(5));
        let p = parse(
            "MATCH (k:Kunde)-[:VON]->(f:Firma) WHERE f.name = $firma AND k.nr IN $nummern RETURN k, f",
            &BTreeMap::new(),
        )
        .unwrap();
        assert_eq!(
            p.parameters.iter().map(|p| (p.name.as_str(), p.ty)).collect::<Vec<_>>(),
            [("firma", ParameterType::String), ("nummern", ParameterType::StringList)]
        );
        assert_eq!(p.limit, None);
        // One of several labels, and "any of" a node's conditions.
        let p = parse(
            "MATCH (k:Kunde|Interessent)-[:VON]->(f) WHERE (f:Firma OR f:Verein) AND (k.a = 1 OR k.b IS NULL) RETURN *",
            &BTreeMap::new(),
        )
        .unwrap();
        assert_eq!(p.nodes[0].labels, ["Kunde", "Interessent"]);
        assert_eq!(p.nodes[1].labels, ["Firma", "Verein"]);
        assert_eq!((p.nodes[0].matches, p.nodes[0].conditions.len()), (Match::Any, 2));
    }

    #[test]
    fn everything_else_is_not_representable() {
        for q in [
            "MATCH (a) WHERE a.x = 1 OR a.y = 2 RETURN a",
            "MATCH (a) WHERE NOT a.x = 1 RETURN a",
            "MATCH (a) WITH a RETURN a",
            "MATCH (a) RETURN count(a)",
            "MATCH (a) RETURN a.name",
            "MATCH (a) RETURN a ORDER BY a.x",
            "MATCH (a)-[*]->(b) RETURN a",
            "MATCH (a)-[*2..]->(b) RETURN a",
            "MATCH (a)<-[]->(b) RETURN a",
            "MATCH (a) WHERE a.x = b.y RETURN a",
            "MATCH (a) WHERE toLower(a.x) = 'a' RETURN a",
            "MATCH (a) WHERE a.x = null RETURN a",
            "MATCH (a) OPTIONAL MATCH (a)-[e]->(b)-[f]->(c) RETURN a",
            "MATCH (a) OPTIONAL MATCH (a)-[e]->(b) WHERE a.x = 1 RETURN a",
            "MATCH (a) OPTIONAL MATCH (a:Neu)-[e]->(b) RETURN a",
            "OPTIONAL MATCH (a)-[e]->(b) RETURN a",
            "MATCH (a) OPTIONAL MATCH (a)-[e]->(b) MATCH (c) RETURN a",
            "CREATE (a) RETURN a",
            "MATCH (a) DETACH DELETE a",
            "MATCH (a) RETURN a LIMIT $n",
            "MATCH (a) RETURN a; MATCH (b) RETURN b",
            "MATCH (`a b`) RETURN *",
            "CALL db.labels()",
            "UNWIND [1] AS x MATCH (a) RETURN a",
            "MATCH p = shortestPath((a)-[*..3]->(b)) RETURN p",
            "MATCH (a:A:B) RETURN a",
            "MATCH (a)-[e]->(b) WHERE (a.x = 1 OR b.y = 2) RETURN a",
            "MATCH (a) WHERE a.x = 1 AND (a.y = 1 OR a.z = 2) RETURN a",
            "MATCH (a) WHERE (a:X OR a.y = 1) RETURN a",
            "MATCH (a) WHERE a:X RETURN a",
        ] {
            let parsed = parse_any(q, Dialect::Neo4j, &BTreeMap::new());
            assert!(!parsed.representable, "{q}: {parsed:?}");
            assert!(parsed.reason.as_deref().is_some_and(|r| r.starts_with("pattern.")), "{q}: {parsed:?}");
        }
        // A pattern that reads but breaks a pattern rule says which.
        let parsed = parse_any("MATCH (a), (b) RETURN a, b", Dialect::Neo4j, &BTreeMap::new());
        assert_eq!(parsed.reason.as_deref(), Some("pattern.not_connected"));
    }

    #[test]
    fn values_never_reach_the_text() {
        let attacks = [
            "x' OR 1=1 //",
            "x\" OR true //",
            "x`) MATCH (m) DETACH DELETE m //",
            "$kz_v1",
            "}) RETURN 1 UNION MATCH (n) DETACH DELETE n //",
            "\\u0027 OR 1=1",
        ];
        for attack in attacks {
            let mut p = knows();
            p.nodes[1].conditions.push(Condition {
                property: "name".into(),
                op: Operator::Eq,
                value: Some(Operand::literal(json!(attack))),
            });
            let c = compile_any(&p, Dialect::Neo4j, None, &vars(json!({ "firma": attack }))).unwrap();
            assert!(!c.text.contains(attack), "{attack}: {}", c.text);
            assert_eq!(c.parameters["firma"], json!(attack));
            assert_eq!(c.parameters["kz_v0"], json!(attack));
            check(&c.text).unwrap();
        }
        // Names are quoted, so a label cannot end the pattern either.
        let mut p = knows();
        p.nodes[0].labels = vec!["Person`) DETACH DELETE a //".into()];
        p.nodes[0].conditions[0].property = "x` = 1 OR `y".into();
        let c = compile_any(&p, Dialect::Neo4j, None, &vars(json!({ "firma": "A" }))).unwrap();
        assert!(c.text.contains("(a:`Person``) DETACH DELETE a //`)"), "{}", c.text);
        assert!(c.text.contains("a.`x`` = 1 OR ``y` = $firma"), "{}", c.text);
        check(&c.text).unwrap();
        let back = parse(&c.text, &c.parameters).unwrap();
        assert_eq!(back.nodes[0].labels, p.nodes[0].labels);
        assert_eq!(back.nodes[0].conditions[0].property, p.nodes[0].conditions[0].property);
    }
}
