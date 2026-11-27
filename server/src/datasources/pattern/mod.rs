//! Graph patterns (docs/api/datasources.md, "Graph patterns"): nodes with labels and property
//! conditions, edges with types, direction and path length, optional parts and a result limit.
//! A pattern is a query form of its own (`{"pattern": {...}}`) on Neo4j, Memgraph and TigerGraph:
//! the source compiles it into Cypher (`cypher.rs`) or GSQL (`gsql.rs`) and runs the text through
//! the same read-only check as any typed query, so the pattern adds no way around it.
//!
//! Values never become text in the query. A literal in a condition is bound as a parameter of its
//! own (`$kz_v0`), a template parameter (`{"param": "firma"}`) as the parameter of that name, each
//! with the type the pattern declares (`coerce`). Labels, types and property names are names in
//! the text: Cypher quotes them in backticks, GSQL takes plain names only.
//!
//! The way back (`cypher::parse`, `gsql::parse`) reads a fixed, documented subset of each language
//! into a pattern; anything outside it answers `pattern.not_representable` naming the part, never
//! a pattern that leaves something out.

pub mod cypher;
pub mod gsql;
mod text;

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::detail::Detail;

/// The most nodes and edges a pattern may have.
pub const MAX_NODES: usize = 20;
pub const MAX_EDGES: usize = 30;
/// The most conditions on one node or edge.
pub const MAX_CONDITIONS: usize = 20;
/// The longest path an edge may stand for.
pub const MAX_HOPS: u32 = 10;
pub const DEFAULT_LIMIT: u32 = 100;
pub const MAX_LIMIT: u32 = 10_000;
/// The most values in one list (pasted ids included).
pub const MAX_VALUES: usize = 1_000;
pub const MAX_PARAMETERS: usize = 20;
/// The longest name (label, type, property) and text value.
const MAX_NAME: usize = 256;
const MAX_TEXT: usize = 10_000;
/// Names Kalzit gives what it adds to the query text (`kz_p0`, `$kz_v0`); aliases and parameters
/// may not start with it.
pub const RESERVED_PREFIX: &str = "kz_";

/// Words neither language takes as a variable name.
const KEYWORDS: &[&str] = &[
    "accum", "all", "and", "any", "as", "asc", "by", "call", "case", "contains", "create", "delete", "desc",
    "distinct", "else", "end", "ends", "exists", "false", "for", "from", "graph", "having", "if", "in", "is", "limit",
    "match", "merge", "not", "null", "optional", "or", "order", "print", "query", "remove", "return", "select", "set",
    "skip", "starts", "then", "to", "true", "union", "unwind", "where", "when", "with", "xor",
];

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Pattern {
    pub nodes: Vec<PatternNode>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[cfg_attr(test, ts(as = "Option<Vec<PatternEdge>>", optional))]
    pub edges: Vec<PatternEdge>,
    /// The most matches; `DEFAULT_LIMIT` when left out.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub limit: Option<u32>,
    /// The template parameters the conditions use (`{"param": name}`), with their types.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[cfg_attr(test, ts(as = "Option<Vec<PatternParameter>>", optional))]
    pub parameters: Vec<PatternParameter>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PatternNode {
    /// The node's name in the query (`a`): letters, digits and `_`.
    pub id: String,
    /// All of these labels (Cypher); TigerGraph takes at most one vertex type.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[cfg_attr(test, ts(as = "Option<Vec<String>>", optional))]
    pub labels: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[cfg_attr(test, ts(as = "Option<Vec<Condition>>", optional))]
    pub conditions: Vec<Condition>,
    /// Only these nodes, by the database's own id (Neo4j element id, Memgraph id, TigerGraph
    /// primary id): a list, or a parameter of type `idList` (pasted ids).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub ids: Option<Operand>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum Direction {
    /// From `from` to `to`.
    #[default]
    Out,
    /// From `to` to `from`.
    In,
    /// Either way.
    Both,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PatternEdge {
    pub id: String,
    pub from: String,
    pub to: String,
    /// Any of these types; any type when empty.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[cfg_attr(test, ts(as = "Option<Vec<String>>", optional))]
    pub types: Vec<String>,
    #[serde(default)]
    pub direction: Direction,
    /// The path length, 1 to `MAX_HOPS` steps; both 1 (the default) is one edge.
    #[serde(default = "one", skip_serializing_if = "is_one")]
    #[cfg_attr(test, ts(as = "Option<u32>", optional))]
    pub min_hops: u32,
    #[serde(default = "one", skip_serializing_if = "is_one")]
    #[cfg_attr(test, ts(as = "Option<u32>", optional))]
    pub max_hops: u32,
    /// Matches also where this edge (and nodes only it reaches) is missing (Cypher only).
    #[serde(default, skip_serializing_if = "is_false")]
    #[cfg_attr(test, ts(as = "Option<bool>", optional))]
    pub optional: bool,
    /// Conditions on the edge's properties; only for one edge (no path length).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[cfg_attr(test, ts(as = "Option<Vec<Condition>>", optional))]
    pub conditions: Vec<Condition>,
}

fn one() -> u32 {
    1
}

fn is_one(v: &u32) -> bool {
    *v == 1
}

fn is_false(v: &bool) -> bool {
    !*v
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum Operator {
    Eq,
    Ne,
    Lt,
    Le,
    Gt,
    Ge,
    Contains,
    StartsWith,
    EndsWith,
    /// The value is a list.
    In,
    /// No value.
    IsNull,
    IsNotNull,
}

impl Operator {
    fn takes_value(self) -> bool {
        !matches!(self, Operator::IsNull | Operator::IsNotNull)
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Condition {
    pub property: String,
    pub op: Operator,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub value: Option<Operand>,
}

/// A literal value (`{"value": 3}`) or a template parameter (`{"param": "firma"}`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(untagged)]
pub enum Operand {
    Value(LiteralOperand),
    Param(ParamOperand),
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(deny_unknown_fields)]
pub struct LiteralOperand {
    pub value: Value,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(deny_unknown_fields)]
pub struct ParamOperand {
    pub param: String,
}

impl Operand {
    pub fn literal(value: Value) -> Self {
        Operand::Value(LiteralOperand { value })
    }

    pub fn param(name: &str) -> Self {
        Operand::Param(ParamOperand { param: name.to_string() })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum ParameterType {
    String,
    Integer,
    Float,
    Boolean,
    StringList,
    IntegerList,
    FloatList,
    /// Database ids; text with one id per line (or separated by commas, semicolons, tabs or
    /// spaces) is split into a list.
    IdList,
}

impl ParameterType {
    pub fn is_list(self) -> bool {
        matches!(self, Self::StringList | Self::IntegerList | Self::FloatList | Self::IdList)
    }

    fn item(self) -> Self {
        match self {
            Self::StringList | Self::IdList => Self::String,
            Self::IntegerList => Self::Integer,
            Self::FloatList => Self::Float,
            other => other,
        }
    }

    fn describe(self) -> &'static str {
        match self {
            Self::String => "text",
            Self::Integer => "a whole number",
            Self::Float => "a number",
            Self::Boolean => "true or false",
            Self::StringList => "a list of texts",
            Self::IntegerList => "a list of whole numbers",
            Self::FloatList => "a list of numbers",
            Self::IdList => "a list of ids",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PatternParameter {
    pub name: String,
    #[serde(rename = "type")]
    pub ty: ParameterType,
    /// What the field is called where the template asks for it ("Firma").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub label: Option<String>,
}

/// The query language a pattern compiles to, with the differences between the Cypher engines.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Dialect {
    Neo4j,
    Memgraph,
    TigerGraph,
}

/// A compiled pattern: the query text and the values of its parameters, typed.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct Compiled {
    pub text: String,
    /// By parameter name: the literals (`kz_v0`, ...) and the template parameters that had a
    /// value. GSQL declares each with its type in the query's header.
    pub parameters: BTreeMap<String, Value>,
}

fn invalid(reason: &'static str, message: impl Into<String>) -> Detail {
    Detail::new(reason, message)
}

/// A name in the query: an alias or a parameter.
pub fn is_alias(s: &str) -> bool {
    let mut chars = s.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic())
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
        && s.len() <= 32
        && !s.to_ascii_lowercase().starts_with(RESERVED_PREFIX)
        && !KEYWORDS.contains(&s.to_ascii_lowercase().as_str())
}

/// A label, type or property name: any text without control characters.
fn is_name(s: &str) -> bool {
    !s.trim().is_empty() && s.len() <= MAX_NAME && !s.chars().any(char::is_control)
}

/// A plain name, as GSQL needs it: letters, digits and `_`, not starting with a digit.
pub fn is_plain_name(s: &str) -> bool {
    let mut chars = s.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
        && s.len() <= MAX_NAME
}

impl Pattern {
    pub fn limit(&self) -> u32 {
        self.limit.unwrap_or(DEFAULT_LIMIT)
    }

    fn node(&self, id: &str) -> Option<&PatternNode> {
        self.nodes.iter().find(|n| n.id == id)
    }

    fn parameter(&self, name: &str) -> Option<&PatternParameter> {
        self.parameters.iter().find(|p| p.name == name)
    }

    /// Checks the pattern on its own: names, sizes, operators with their values, declared
    /// parameters, path lengths, and that the required part hangs together (no cross product)
    /// with every optional edge attached to it.
    pub fn check(&self) -> Result<(), Detail> {
        if self.nodes.is_empty() {
            return Err(invalid("pattern.empty", "the pattern needs at least one node"));
        }
        if self.nodes.len() > MAX_NODES || self.edges.len() > MAX_EDGES {
            return Err(invalid(
                "pattern.too_large",
                format!("a pattern has at most {MAX_NODES} nodes and {MAX_EDGES} edges"),
            )
            .with("nodes", MAX_NODES)
            .with("edges", MAX_EDGES));
        }
        let limit = self.limit();
        if !(1..=MAX_LIMIT).contains(&limit) {
            return Err(
                invalid("pattern.limit_invalid", format!("the limit must be 1 to {MAX_LIMIT}")).with("max", MAX_LIMIT)
            );
        }
        if self.parameters.len() > MAX_PARAMETERS {
            return Err(invalid("pattern.too_large", format!("a pattern has at most {MAX_PARAMETERS} parameters"))
                .with("parameters", MAX_PARAMETERS));
        }
        let mut seen = BTreeSet::new();
        for p in &self.parameters {
            if !is_alias(&p.name) {
                return Err(bad_name("parameter", &p.name));
            }
            if !seen.insert(p.name.as_str()) {
                return Err(
                    invalid("pattern.duplicate_name", format!("{} is declared twice", p.name)).with("name", &p.name)
                );
            }
        }
        let mut names = BTreeSet::new();
        for n in &self.nodes {
            if !is_alias(&n.id) {
                return Err(bad_name("node", &n.id));
            }
            if !names.insert(n.id.to_ascii_lowercase()) {
                return Err(invalid("pattern.duplicate_name", format!("{} is used twice", n.id)).with("name", &n.id));
            }
            if let Some(bad) = n.labels.iter().find(|l| !is_name(l)) {
                return Err(bad_name("label", bad));
            }
            self.check_conditions(&n.id, &n.conditions)?;
            if let Some(ids) = &n.ids {
                self.check_operand(&n.id, ids, true)?;
            }
        }
        for e in &self.edges {
            if !is_alias(&e.id) {
                return Err(bad_name("edge", &e.id));
            }
            if !names.insert(e.id.to_ascii_lowercase()) {
                return Err(invalid("pattern.duplicate_name", format!("{} is used twice", e.id)).with("name", &e.id));
            }
            for end in [&e.from, &e.to] {
                if self.node(end).is_none() {
                    return Err(invalid("pattern.unknown_node", format!("edge {} names no node {end}", e.id))
                        .with("edge", &e.id)
                        .with("node", end));
                }
            }
            if let Some(bad) = e.types.iter().find(|t| !is_name(t)) {
                return Err(bad_name("type", bad));
            }
            if !(1..=MAX_HOPS).contains(&e.min_hops) || !(e.min_hops..=MAX_HOPS).contains(&e.max_hops) {
                return Err(invalid(
                    "pattern.hops_invalid",
                    format!("the path length of {} must be 1 to {MAX_HOPS} steps, the least first", e.id),
                )
                .with("edge", &e.id)
                .with("max", MAX_HOPS));
            }
            if e.max_hops > 1 && !e.conditions.is_empty() {
                return Err(invalid(
                    "pattern.path_conditions",
                    format!("{} stands for a path; conditions apply only to a single edge", e.id),
                )
                .with("edge", &e.id));
            }
            self.check_conditions(&e.id, &e.conditions)?;
        }
        self.parts().map(|_| ())
    }

    fn check_conditions(&self, owner: &str, conditions: &[Condition]) -> Result<(), Detail> {
        if conditions.len() > MAX_CONDITIONS {
            return Err(invalid("pattern.too_large", format!("{owner} has more than {MAX_CONDITIONS} conditions"))
                .with("conditions", MAX_CONDITIONS));
        }
        for c in conditions {
            if !is_name(&c.property) {
                return Err(bad_name("property", &c.property));
            }
            match (&c.value, c.op.takes_value()) {
                (None, true) => {
                    return Err(invalid(
                        "pattern.value_missing",
                        format!("the condition on {owner}.{} needs a value", c.property),
                    )
                    .with("element", owner)
                    .with("property", &c.property));
                }
                (Some(_), false) => {
                    return Err(invalid(
                        "pattern.value_unexpected",
                        format!("the condition on {owner}.{} takes no value", c.property),
                    )
                    .with("element", owner)
                    .with("property", &c.property));
                }
                (Some(v), true) => self.check_operand(owner, v, c.op == Operator::In)?,
                (None, false) => {}
            }
        }
        Ok(())
    }

    fn check_operand(&self, owner: &str, operand: &Operand, list: bool) -> Result<(), Detail> {
        match operand {
            Operand::Param(p) => {
                let declared = self.parameter(&p.param).ok_or_else(|| {
                    invalid("pattern.parameter_undeclared", format!("the parameter {} is not declared", p.param))
                        .with("name", &p.param)
                })?;
                if declared.ty.is_list() != list {
                    let want = if list { "a list type" } else { "a single value type" };
                    return Err(invalid(
                        "pattern.parameter_type",
                        format!("the parameter {} is used on {owner} where it needs {want}", p.param),
                    )
                    .with("name", &p.param)
                    .with("element", owner));
                }
            }
            Operand::Value(v) => {
                literal_kind(&v.value, list).map_err(|d| d.with("element", owner))?;
            }
        }
        Ok(())
    }

    /// The required part (nodes and edges in their order) and the optional edges in the order they
    /// attach, each with the nodes it brings in.
    fn parts(&self) -> Result<Parts<'_>, Detail> {
        let required: Vec<&PatternEdge> = self.edges.iter().filter(|e| !e.optional).collect();
        let touched: BTreeSet<&str> = self.edges.iter().flat_map(|e| [e.from.as_str(), e.to.as_str()]).collect();
        let mut nodes: Vec<&str> = Vec::new();
        for n in &self.nodes {
            let in_required = required.iter().any(|e| e.from == n.id || e.to == n.id);
            if in_required || !touched.contains(n.id.as_str()) {
                nodes.push(&n.id);
            }
        }
        if nodes.is_empty() {
            // Only optional edges: the first node is where they start.
            nodes.push(&self.nodes[0].id);
        }
        // One connected required part.
        let mut reached: BTreeSet<&str> = BTreeSet::from([nodes[0]]);
        loop {
            let before = reached.len();
            for e in &required {
                if reached.contains(e.from.as_str()) || reached.contains(e.to.as_str()) {
                    reached.insert(&e.from);
                    reached.insert(&e.to);
                }
            }
            if reached.len() == before {
                break;
            }
        }
        if let Some(apart) = nodes.iter().find(|n| !reached.contains(**n)) {
            return Err(invalid(
                "pattern.not_connected",
                format!("{apart} is not connected to the rest of the pattern; connect it with an edge"),
            )
            .with("node", apart));
        }
        let mut bound = reached;
        let mut optional: Vec<(&PatternEdge, Vec<&str>)> = Vec::new();
        let mut waiting: Vec<&PatternEdge> = self.edges.iter().filter(|e| e.optional).collect();
        while !waiting.is_empty() {
            let Some(at) =
                waiting.iter().position(|e| bound.contains(e.from.as_str()) || bound.contains(e.to.as_str()))
            else {
                let e = waiting[0];
                return Err(invalid(
                    "pattern.optional_unattached",
                    format!("the optional edge {} does not touch the rest of the pattern", e.id),
                )
                .with("edge", &e.id));
            };
            let e = waiting.remove(at);
            let new: Vec<&str> = [e.from.as_str(), e.to.as_str()]
                .into_iter()
                .filter(|n| !bound.contains(n))
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect();
            bound.extend(new.iter().copied());
            optional.push((e, new));
        }
        Ok(Parts { nodes, edges: required, optional })
    }
}

struct Parts<'a> {
    nodes: Vec<&'a str>,
    edges: Vec<&'a PatternEdge>,
    optional: Vec<(&'a PatternEdge, Vec<&'a str>)>,
}

fn bad_name(what: &str, name: &str) -> Detail {
    let rule = match what {
        "node" | "edge" | "parameter" => {
            "letters, digits and _, starting with a letter, at most 32 characters, not a keyword and not starting with kz_"
        }
        _ => "not empty, without control characters, at most 256 characters",
    };
    invalid("pattern.name_invalid", format!("{what} name {name:?} is not valid: {rule}"))
        .with("what", what)
        .with("name", name)
}

/// What a literal is, for typing it as a parameter.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    Scalar(ParameterType),
    List(ParameterType),
}

impl Kind {
    fn ty(self) -> ParameterType {
        match self {
            Kind::Scalar(t) => t,
            Kind::List(ParameterType::Integer) => ParameterType::IntegerList,
            Kind::List(ParameterType::Float) => ParameterType::FloatList,
            Kind::List(_) => ParameterType::StringList,
        }
    }
}

fn scalar_kind(v: &Value) -> Option<ParameterType> {
    match v {
        Value::String(s) if s.len() <= MAX_TEXT => Some(ParameterType::String),
        Value::Bool(_) => Some(ParameterType::Boolean),
        Value::Number(n) if n.as_i64().is_some() => Some(ParameterType::Integer),
        Value::Number(n) if n.as_f64().is_some_and(f64::is_finite) && !n.is_u64() => Some(ParameterType::Float),
        _ => None,
    }
}

/// The kind of a literal: a scalar (text, number, true or false) or, where `list`, a list of
/// scalars of one kind (whole numbers and numbers mix as numbers).
fn literal_kind(v: &Value, list: bool) -> Result<Kind, Detail> {
    let wrong = |want: &str| invalid("pattern.value_invalid", format!("the value must be {want}")).with("want", want);
    if !list {
        return scalar_kind(v).map(Kind::Scalar).ok_or_else(|| wrong("text, a number, true or false"));
    }
    let Value::Array(items) = v else { return Err(wrong("a list")) };
    if items.len() > MAX_VALUES {
        return Err(invalid("pattern.too_many_values", format!("a list holds at most {MAX_VALUES} values"))
            .with("max", MAX_VALUES));
    }
    let mut kind: Option<ParameterType> = None;
    for item in items {
        let k = scalar_kind(item).ok_or_else(|| wrong("a list of texts, numbers or true and false"))?;
        kind = Some(match (kind, k) {
            (None, k) => k,
            (Some(a), b) if a == b => a,
            (Some(ParameterType::Integer | ParameterType::Float), ParameterType::Integer | ParameterType::Float) => {
                ParameterType::Float
            }
            _ => return Err(wrong("a list of values of one kind")),
        });
    }
    Ok(Kind::List(kind.unwrap_or(ParameterType::String)))
}

/// Pasted ids: one per line, or separated by commas, semicolons, tabs or spaces; empty parts and
/// repeats left out, in their order.
pub fn split_ids(text: &str) -> Vec<String> {
    let mut seen = BTreeSet::new();
    text.split(['\n', '\r', ',', ';', '\t', ' '])
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .filter(|s| seen.insert(s.to_string()))
        .map(String::from)
        .collect()
}

fn parameter_error(name: &str, ty: ParameterType) -> Detail {
    invalid("pattern.parameter_type", format!("the value of {name} must be {}", ty.describe()))
        .with("name", name)
        .with("type", ty.describe())
}

fn coerce_scalar(name: &str, ty: ParameterType, v: &Value) -> Result<Value, Detail> {
    let err = || parameter_error(name, ty);
    Ok(match ty {
        ParameterType::Integer => match v {
            Value::Number(n) => Value::from(n.as_i64().ok_or_else(err)?),
            Value::String(s) => Value::from(s.trim().parse::<i64>().map_err(|_| err())?),
            _ => return Err(err()),
        },
        ParameterType::Float => {
            let f = match v {
                Value::Number(n) => n.as_f64(),
                Value::String(s) => s.trim().parse::<f64>().ok(),
                _ => None,
            }
            .filter(|f| f.is_finite())
            .ok_or_else(err)?;
            serde_json::Number::from_f64(f).map(Value::Number).ok_or_else(err)?
        }
        ParameterType::Boolean => match v {
            Value::Bool(b) => Value::Bool(*b),
            Value::String(s) if s == "true" || s == "false" => Value::Bool(s == "true"),
            _ => return Err(err()),
        },
        _ => match v {
            Value::String(s) if s.len() <= MAX_TEXT => Value::String(s.clone()),
            Value::Number(n) => Value::String(n.to_string()),
            Value::Bool(b) => Value::String(b.to_string()),
            _ => return Err(err()),
        },
    })
}

/// A template parameter's value with the declared type: text that holds a number becomes the
/// number, text given for a list is split like pasted ids (`split_ids`). Anything that does not
/// fit is refused, never guessed.
pub fn coerce(name: &str, ty: ParameterType, v: &Value) -> Result<Value, Detail> {
    if !ty.is_list() {
        return coerce_scalar(name, ty, v);
    }
    let items: Vec<Value> = match v {
        Value::Array(items) => items.clone(),
        Value::String(s) => split_ids(s).into_iter().map(Value::String).collect(),
        Value::Number(_) | Value::Bool(_) => vec![v.clone()],
        _ => return Err(parameter_error(name, ty)),
    };
    if items.len() > MAX_VALUES {
        return Err(invalid("pattern.too_many_values", format!("{name} holds more than {MAX_VALUES} values"))
            .with("max", MAX_VALUES)
            .with("name", name));
    }
    let item = ty.item();
    items
        .iter()
        .map(|i| coerce_scalar(name, item, i).map_err(|_| parameter_error(name, ty)))
        .collect::<Result<Vec<_>, _>>()
        .map(Value::Array)
}

/// Gives every value of a compiled pattern its parameter name, its value and type.
struct Binder<'a> {
    pattern: &'a Pattern,
    variables: &'a BTreeMap<String, Value>,
    /// Name to (value, type).
    bound: BTreeMap<String, (Value, ParameterType)>,
    next: usize,
}

impl<'a> Binder<'a> {
    fn new(pattern: &'a Pattern, variables: &'a BTreeMap<String, Value>) -> Self {
        Self { pattern, variables, bound: BTreeMap::new(), next: 0 }
    }

    /// The parameter name for `operand`: a new `kz_vN` for a literal, the template parameter's
    /// own name (bound once) for a parameter.
    fn bind(&mut self, operand: &Operand, list: bool) -> Result<String, Detail> {
        match operand {
            Operand::Value(v) => {
                let ty = literal_kind(&v.value, list)?.ty();
                let name = format!("{RESERVED_PREFIX}v{}", self.next);
                self.next += 1;
                let value = coerce(&name, ty, &v.value)?;
                self.bound.insert(name.clone(), (value, ty));
                Ok(name)
            }
            Operand::Param(p) => {
                if !self.bound.contains_key(&p.param) {
                    let declared = self.pattern.parameter(&p.param).ok_or_else(|| {
                        invalid("pattern.parameter_undeclared", format!("the parameter {} is not declared", p.param))
                            .with("name", &p.param)
                    })?;
                    let given = self.variables.get(&p.param).filter(|v| !v.is_null()).ok_or_else(|| {
                        invalid("pattern.parameter_missing", format!("the search needs a value for {}", p.param))
                            .with("name", &p.param)
                    })?;
                    let value = coerce(&p.param, declared.ty, given)?;
                    self.bound.insert(p.param.clone(), (value, declared.ty));
                }
                Ok(p.param.clone())
            }
        }
    }

    fn finish(self, text: String) -> (Compiled, BTreeMap<String, ParameterType>) {
        let types = self.bound.iter().map(|(k, (_, t))| (k.clone(), *t)).collect();
        let parameters = self.bound.into_iter().map(|(k, (v, _))| (k, v)).collect();
        (Compiled { text, parameters }, types)
    }
}

/// Compiles `pattern` for `dialect` with the template parameters' values from `variables`;
/// `graph` names TigerGraph's graph.
pub fn compile(
    pattern: &Pattern,
    dialect: Dialect,
    graph: Option<&str>,
    variables: &BTreeMap<String, Value>,
) -> Result<Compiled, Detail> {
    pattern.check()?;
    match dialect {
        Dialect::Neo4j | Dialect::Memgraph => cypher::compile(pattern, dialect, variables),
        Dialect::TigerGraph => gsql::compile(pattern, graph.unwrap_or_default(), variables),
    }
}

/// The answer of the way back: a pattern, or why the text is not one.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct Parsed {
    pub representable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub pattern: Option<Pattern>,
    /// `pattern.not_representable` (or another `pattern.*` reason) when it is not.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    #[cfg_attr(test, ts(as = "Option<BTreeMap<String, String>>", optional))]
    pub params: BTreeMap<String, String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub message: Option<String>,
}

impl Parsed {
    fn from(result: Result<Pattern, Detail>) -> Self {
        match result {
            Ok(pattern) => Parsed {
                representable: true,
                pattern: Some(pattern),
                reason: None,
                params: BTreeMap::new(),
                message: None,
            },
            Err(d) => Parsed {
                representable: false,
                pattern: None,
                reason: Some(d.reason.to_string()),
                params: d.params,
                message: Some(d.message),
            },
        }
    }
}

/// Reads `text` back into a pattern. `values` are the parameter values a compiled pattern came
/// with: a `kz_vN` parameter with a value there becomes that literal again.
pub fn parse(text: &str, dialect: Dialect, values: &BTreeMap<String, Value>) -> Parsed {
    let parsed = match dialect {
        Dialect::Neo4j | Dialect::Memgraph => cypher::parse(text, values),
        Dialect::TigerGraph => gsql::parse(text, values),
    };
    Parsed::from(parsed.and_then(|p| p.check().map(|()| p)))
}

/// `pattern.not_representable`, naming the part of the text that a pattern cannot hold.
pub fn not_representable(part: impl AsRef<str>) -> Detail {
    let part = part.as_ref();
    invalid("pattern.not_representable", format!("not representable as a pattern: {part}")).with("part", part)
}

/// A literal or parameter operand read back: `kz_vN` with a known value is the literal again.
fn operand_from_param(name: &str, values: &BTreeMap<String, Value>) -> Operand {
    match values.get(name) {
        Some(v) if name.starts_with(RESERVED_PREFIX) => Operand::literal(v.clone()),
        _ => Operand::param(name),
    }
}

/// Template parameters a parsed pattern uses, declared with a type that fits where they stand.
fn declare_parameters(p: &mut Pattern, types: &BTreeMap<String, ParameterType>) -> Result<(), Detail> {
    for (name, ty) in types {
        if !is_alias(name) {
            return Err(bad_name("parameter", name));
        }
        p.parameters.push(PatternParameter { name: name.clone(), ty: *ty, label: None });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    pub(super) fn knows() -> Pattern {
        serde_json::from_value(json!({
            "nodes": [
                { "id": "a", "labels": ["Person"], "conditions": [{ "property": "name", "op": "eq", "value": { "param": "firma" } }] },
                { "id": "b", "labels": ["Person"] }
            ],
            "edges": [{ "id": "e", "from": "a", "to": "b", "types": ["KENNT"] }],
            "parameters": [{ "name": "firma", "type": "string", "label": "Firma" }]
        }))
        .unwrap()
    }

    #[test]
    fn the_json_form_reads_and_writes_back() {
        let p = knows();
        let back: Pattern = serde_json::from_value(serde_json::to_value(&p).unwrap()).unwrap();
        assert_eq!(back, p);
        assert!(p.check().is_ok());
        let wrong = serde_json::from_value::<Pattern>(json!({ "nodes": [{ "id": "a", "label": "X" }] }));
        assert!(wrong.is_err(), "unknown fields are refused");
    }

    fn reason(p: &Pattern) -> &'static str {
        p.check().unwrap_err().reason
    }

    #[test]
    fn checks_refuse_what_cannot_compile() {
        let mut p = knows();
        p.nodes[0].id = "kz_a".into();
        assert_eq!(reason(&p), "pattern.name_invalid");
        let mut p = knows();
        p.nodes[0].id = "match".into();
        assert_eq!(reason(&p), "pattern.name_invalid");
        let mut p = knows();
        p.nodes[1].id = "A".into();
        p.edges[0].to = "A".into();
        assert_eq!(reason(&p), "pattern.duplicate_name");
        let mut p = knows();
        p.edges[0].to = "c".into();
        assert_eq!(reason(&p), "pattern.unknown_node");
        let mut p = knows();
        p.edges[0].max_hops = 11;
        assert_eq!(reason(&p), "pattern.hops_invalid");
        let mut p = knows();
        p.edges[0].min_hops = 3;
        p.edges[0].max_hops = 2;
        assert_eq!(reason(&p), "pattern.hops_invalid");
        let mut p = knows();
        p.parameters.clear();
        assert_eq!(reason(&p), "pattern.parameter_undeclared");
        let mut p = knows();
        p.parameters[0].ty = ParameterType::StringList;
        assert_eq!(reason(&p), "pattern.parameter_type");
        let mut p = knows();
        p.nodes[0].conditions[0].value = None;
        assert_eq!(reason(&p), "pattern.value_missing");
        let mut p = knows();
        p.nodes[0].conditions[0].op = Operator::IsNull;
        assert_eq!(reason(&p), "pattern.value_unexpected");
        let mut p = knows();
        p.nodes[0].conditions[0].value = Some(Operand::literal(json!({ "x": 1 })));
        assert_eq!(reason(&p), "pattern.value_invalid");
        let mut p = knows();
        p.nodes[0].conditions[0] =
            Condition { property: "n".into(), op: Operator::In, value: Some(Operand::literal(json!([1, "a"]))) };
        assert_eq!(reason(&p), "pattern.value_invalid");
        let mut p = knows();
        p.limit = Some(0);
        assert_eq!(reason(&p), "pattern.limit_invalid");
        let mut p = knows();
        p.edges[0].max_hops = 2;
        p.edges[0].conditions.push(Condition { property: "x".into(), op: Operator::IsNull, value: None });
        assert_eq!(reason(&p), "pattern.path_conditions");
        let mut p = knows();
        p.nodes.push(PatternNode { id: "c".into(), labels: vec![], conditions: vec![], ids: None });
        assert_eq!(reason(&p), "pattern.not_connected");
        let mut p = knows();
        p.nodes.push(PatternNode { id: "c".into(), labels: vec![], conditions: vec![], ids: None });
        p.nodes.push(PatternNode { id: "d".into(), labels: vec![], conditions: vec![], ids: None });
        p.edges.push(PatternEdge {
            id: "f".into(),
            from: "c".into(),
            to: "d".into(),
            types: vec![],
            direction: Direction::Out,
            min_hops: 1,
            max_hops: 1,
            optional: true,
            conditions: vec![],
        });
        assert_eq!(reason(&p), "pattern.optional_unattached");
        let mut p = knows();
        p.nodes[0].labels = vec![String::new()];
        assert_eq!(reason(&p), "pattern.name_invalid");
    }

    #[test]
    fn parameters_take_their_declared_type() {
        assert_eq!(coerce("n", ParameterType::Integer, &json!("42")).unwrap(), json!(42));
        assert_eq!(coerce("n", ParameterType::Integer, &json!(7)).unwrap(), json!(7));
        assert_eq!(coerce("n", ParameterType::Integer, &json!("4.2")).unwrap_err().reason, "pattern.parameter_type");
        assert_eq!(coerce("n", ParameterType::Float, &json!("2.5")).unwrap(), json!(2.5));
        assert_eq!(coerce("n", ParameterType::Float, &json!("NaN")).unwrap_err().reason, "pattern.parameter_type");
        assert_eq!(coerce("n", ParameterType::Boolean, &json!("true")).unwrap(), json!(true));
        assert_eq!(coerce("n", ParameterType::String, &json!(12)).unwrap(), json!("12"));
        assert_eq!(coerce("n", ParameterType::String, &json!(["a"])).unwrap_err().reason, "pattern.parameter_type");
        assert_eq!(
            coerce("ids", ParameterType::IdList, &json!("4:ab:1\n4:ab:2, 4:ab:3;4:ab:1\t4:ab:4  ")).unwrap(),
            json!(["4:ab:1", "4:ab:2", "4:ab:3", "4:ab:4"])
        );
        assert_eq!(coerce("ids", ParameterType::IntegerList, &json!("1 2 3")).unwrap(), json!([1, 2, 3]));
        assert_eq!(coerce("ids", ParameterType::IntegerList, &json!(["1", 2])).unwrap(), json!([1, 2]));
        assert_eq!(
            coerce("ids", ParameterType::IntegerList, &json!("1 zwei")).unwrap_err().reason,
            "pattern.parameter_type"
        );
        let many = (0..=MAX_VALUES).map(|i| i.to_string()).collect::<Vec<_>>().join("\n");
        assert_eq!(coerce("ids", ParameterType::IdList, &json!(many)).unwrap_err().reason, "pattern.too_many_values");
    }

    #[test]
    fn pasted_ids_are_split_in_order_without_repeats() {
        assert_eq!(split_ids(" a\r\nb,,c;a \t d e"), ["a", "b", "c", "d", "e"]);
        assert!(split_ids(" \n ,; ").is_empty());
    }
}
