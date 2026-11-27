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
/// The longest path any server setting may allow (`datasources.pattern_max_hops`, default 6).
pub const MAX_HOPS_CEILING: u32 = 20;
pub const DEFAULT_MAX_HOPS: u32 = 6;
/// The limit of a pattern without one; the data source's row limit caps every limit.
pub const DEFAULT_LIMIT: u32 = 500;
pub const MAX_LIMIT: u32 = 10_000_000;
/// The most values in one list (`datasources.pattern_max_values`, default 10,000).
pub const DEFAULT_MAX_VALUES: usize = 10_000;
pub const MAX_VALUES_CEILING: usize = 100_000;
pub const MAX_PARAMETERS: usize = 20;
/// The most values a "choice from values" offers.
pub const MAX_CHOICES: usize = 200;
/// The longest name (label, type, property) and text value.
const MAX_NAME: usize = 256;
const MAX_TEXT: usize = 10_000;
/// Names Kalzit gives what it adds to the query text (`kz_p0`, `$kz_v0`); aliases and parameters
/// may not start with it.
pub const RESERVED_PREFIX: &str = "kz_";

/// Words Cypher or GSQL do not take as a variable name.
const KEYWORDS: &[&str] = &[
    "accum",
    "all",
    "and",
    "any",
    "as",
    "asc",
    "avg",
    "bag",
    "between",
    "bool",
    "both",
    "break",
    "by",
    "call",
    "case",
    "catch",
    "commit",
    "compress",
    "contains",
    "continue",
    "count",
    "create",
    "datetime",
    "delete",
    "desc",
    "distinct",
    "do",
    "double",
    "edge",
    "else",
    "end",
    "ends",
    "escape",
    "exception",
    "exists",
    "false",
    "file",
    "filter",
    "float",
    "for",
    "foreach",
    "from",
    "global",
    "graph",
    "group",
    "having",
    "if",
    "in",
    "insert",
    "int",
    "interpret",
    "intersect",
    "into",
    "is",
    "isempty",
    "jsonarray",
    "jsonobject",
    "like",
    "limit",
    "list",
    "load",
    "map",
    "match",
    "max",
    "merge",
    "min",
    "minus",
    "not",
    "now",
    "null",
    "offset",
    "optional",
    "or",
    "order",
    "out",
    "per",
    "post",
    "post_accum",
    "print",
    "query",
    "raise",
    "range",
    "remove",
    "return",
    "returns",
    "sample",
    "select",
    "set",
    "skip",
    "starts",
    "string",
    "sum",
    "syntax",
    "then",
    "to",
    "to_csv",
    "true",
    "try",
    "tuple",
    "typedef",
    "uint",
    "union",
    "unwind",
    "update",
    "using",
    "values",
    "vertex",
    "when",
    "where",
    "while",
    "with",
    "xor",
];

/// The server settings of pattern limits (Einstellungen › Datenquellen).
pub const SETTING_MAX_VALUES: &str = "datasources.pattern_max_values";
pub const SETTING_MAX_HOPS: &str = "datasources.pattern_max_hops";

/// What the server's settings and the data source allow a pattern (`Limits::pattern`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PatternLimits {
    /// Values in one list, pasted ones included.
    pub max_values: usize,
    /// The longest path one edge may stand for.
    pub max_hops: u32,
    /// The most matches: the data source's row limit.
    pub max_limit: u32,
    /// GSQL may declare its tuple type (`kz_match`) to keep at most `limit` matches: only where
    /// the graph's installed query names are known and none is called so (`gsql.rs` refuses a
    /// `TYPEDEF` otherwise, since a call of the tuple could call such a query).
    pub gsql_tuples: bool,
}

impl Default for PatternLimits {
    fn default() -> Self {
        Self { max_values: DEFAULT_MAX_VALUES, max_hops: DEFAULT_MAX_HOPS, max_limit: MAX_LIMIT, gsql_tuples: true }
    }
}

/// Whether one or all of an element's conditions must hold.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum Match {
    #[default]
    All,
    Any,
}

impl Match {
    fn is_all(&self) -> bool {
        *self == Match::All
    }
}

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
    /// Counts the matches instead of returning them ("Treffer zählen"): a frame with `matches`.
    #[serde(default, skip_serializing_if = "is_false")]
    #[cfg_attr(test, ts(as = "Option<bool>", optional))]
    pub count: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PatternNode {
    /// The node's name in the query (`a`): letters, digits and `_`.
    pub id: String,
    /// One of these labels; TigerGraph takes at most one vertex type.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[cfg_attr(test, ts(as = "Option<Vec<String>>", optional))]
    pub labels: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[cfg_attr(test, ts(as = "Option<Vec<Condition>>", optional))]
    pub conditions: Vec<Condition>,
    /// All conditions (the default) or any one of them.
    #[serde(default, skip_serializing_if = "Match::is_all")]
    #[cfg_attr(test, ts(as = "Option<Match>", optional))]
    pub matches: Match,
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
    /// The path length, 1 to the server's longest path (`PatternLimits::max_hops`); both 1 (the
    /// default) is one edge.
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
    #[serde(default, skip_serializing_if = "Match::is_all")]
    #[cfg_attr(test, ts(as = "Option<Match>", optional))]
    pub matches: Match,
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
    #[cfg_attr(test, ts(type = "unknown"))]
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
    /// Database ids; pasted text is split at line breaks, commas, semicolons, tabs and spaces.
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
    /// "Auswahl aus Werten": the template offers the values of this property, read with a fixed
    /// query of the template (at most `MAX_CHOICES`, with a search), instead of a free field.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub choices: Option<Choices>,
}

/// Where a template parameter's choices come from: the values of `property` on nodes of `label`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Choices {
    pub label: String,
    pub property: String,
    /// The template's target whose data source the values come from. A pattern target that
    /// declares the parameter names its own; a parameter of the analysis names one here.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub ref_id: Option<String>,
}

/// Matching nodes a TigerGraph choices query reads its values from, at most.
pub const CHOICES_SCAN: usize = 10_000;

impl Choices {
    pub fn check(&self) -> Result<(), Detail> {
        if !is_name(&self.label) {
            return Err(bad_name("label", &self.label));
        }
        if !is_name(&self.property) {
            return Err(bad_name("property", &self.property));
        }
        Ok(())
    }
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
    #[cfg_attr(test, ts(type = "Record<string, unknown>"))]
    pub parameters: BTreeMap<String, Value>,
    /// The limit the text has: the pattern's, capped at the data source's row limit; none for a
    /// count.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub limit: Option<u32>,
    /// Lists given as pasted text: how many values they hold after empty parts and repeats were
    /// left out.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    #[cfg_attr(test, ts(as = "Option<Vec<ListReport>>", optional))]
    pub lists: Vec<ListReport>,
}

/// What became of a pasted list ("13 Werte erkannt, 1 doppelt entfernt, 1 leere Zeile übergangen").
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ListReport {
    pub name: String,
    pub values: usize,
    pub duplicates: usize,
    pub empty: usize,
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

/// A label, type or property name: any text without control characters and backslashes.
fn is_name(s: &str) -> bool {
    !s.trim().is_empty() && s.len() <= MAX_NAME && !s.chars().any(|c| c.is_control() || c == '\\')
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
        if !(1..=MAX_LIMIT).contains(&limit) && !self.count {
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
            if !(1..=MAX_HOPS_CEILING).contains(&e.min_hops) || !(e.min_hops..=MAX_HOPS_CEILING).contains(&e.max_hops) {
                return Err(hops_invalid(&e.id, MAX_HOPS_CEILING));
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
        // A parameter named like a node or edge would read as both in GSQL.
        if let Some(p) = self.parameters.iter().find(|p| names.contains(&p.name.to_ascii_lowercase())) {
            return Err(invalid(
                "pattern.duplicate_name",
                format!("the parameter {} has the name of a node or edge", p.name),
            )
            .with("name", &p.name));
        }
        for p in &self.parameters {
            if let Some(c) = &p.choices {
                c.check()?;
            }
        }
        self.parts().map(|_| ())
    }

    /// The checks that depend on the server and the source: the longest path.
    pub fn check_limits(&self, limits: &PatternLimits) -> Result<(), Detail> {
        if let Some(e) = self.edges.iter().find(|e| e.max_hops > limits.max_hops) {
            return Err(hops_invalid(&e.id, limits.max_hops));
        }
        Ok(())
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
                literal_kind(&v.value, list, MAX_VALUES_CEILING).map_err(|d| d.with("element", owner))?;
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

fn hops_invalid(edge: &str, max: u32) -> Detail {
    invalid(
        "pattern.hops_invalid",
        format!("the path of {edge} may be 1 to {max} steps long here, the least first; search with a shorter path"),
    )
    .with("edge", edge)
    .with("max", max)
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
        _ => "not empty, without control characters or backslashes, at most 256 characters",
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

fn too_many(name: Option<&str>, max: usize) -> Detail {
    let d = invalid(
        "pattern.too_many_values",
        format!(
            "a list holds at most {max} values on this server; split the list or search by a property the group shares"
        ),
    )
    .with("max", max);
    match name {
        Some(n) => d.with("name", n),
        None => d,
    }
}

/// The kind of a literal: a scalar (text, number, true or false) or, where `list`, a list of texts
/// or numbers of one kind (whole numbers and numbers mix as numbers). Lists of true and false
/// are refused: `in` over two values is a condition of its own.
fn literal_kind(v: &Value, list: bool, max_values: usize) -> Result<Kind, Detail> {
    let wrong = |want: &str| invalid("pattern.value_invalid", format!("the value must be {want}")).with("want", want);
    if !list {
        return scalar_kind(v).map(Kind::Scalar).ok_or_else(|| wrong("text, a number, true or false"));
    }
    let Value::Array(items) = v else { return Err(wrong("a list")) };
    if items.len() > max_values {
        return Err(too_many(None, max_values));
    }
    let mut kind: Option<ParameterType> = None;
    for item in items {
        let k = scalar_kind(item)
            .filter(|k| *k != ParameterType::Boolean)
            .ok_or_else(|| wrong("a list of texts or numbers"))?;
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

/// Pasted values: split at line breaks, commas, semicolons and tabs, and for ids also at spaces;
/// empty parts and repeats left out, in their order. Answers the values and the report.
pub fn split_values(name: &str, text: &str, ids: bool) -> (Vec<String>, ListReport) {
    let mut seen = BTreeSet::new();
    let (mut duplicates, mut empty, mut values) = (0, 0, Vec::new());
    let lines: Vec<&str> = text.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)).collect();
    let last = lines.len().saturating_sub(1);
    for (i, line) in lines.iter().enumerate() {
        // A line break at the very end makes no empty entry.
        if i == last && line.trim().is_empty() {
            continue;
        }
        for part in line.split([',', ';', '\t']) {
            let words: Vec<&str> = if ids { part.split_whitespace().collect() } else { vec![part.trim()] };
            if words.iter().all(|w| w.is_empty()) {
                empty += 1;
                continue;
            }
            for w in words {
                if seen.insert(w.to_string()) {
                    values.push(w.to_string());
                } else {
                    duplicates += 1;
                }
            }
        }
    }
    let report = ListReport { name: name.to_string(), values: values.len(), duplicates, empty };
    (values, report)
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
/// number, text given for a list is split (`split_values`, reported). Anything that does not fit
/// is refused, never guessed; a list longer than `max_values` too.
pub fn coerce_reported(
    name: &str,
    ty: ParameterType,
    v: &Value,
    max_values: usize,
) -> Result<(Value, Option<ListReport>), Detail> {
    if !ty.is_list() {
        return coerce_scalar(name, ty, v).map(|v| (v, None));
    }
    let (items, report): (Vec<Value>, Option<ListReport>) = match v {
        Value::Array(items) => (items.clone(), None),
        Value::String(s) => {
            let (values, report) = split_values(name, s, ty == ParameterType::IdList);
            (values.into_iter().map(Value::String).collect(), Some(report))
        }
        Value::Number(_) => (vec![v.clone()], None),
        _ => return Err(parameter_error(name, ty)),
    };
    if items.len() > max_values {
        return Err(too_many(Some(name), max_values));
    }
    let item = ty.item();
    let list = items
        .iter()
        .map(|i| coerce_scalar(name, item, i).map_err(|_| parameter_error(name, ty)))
        .collect::<Result<Vec<_>, _>>()?;
    Ok((Value::Array(list), report))
}

/// `coerce_reported` without the report.
pub fn coerce(name: &str, ty: ParameterType, v: &Value, max_values: usize) -> Result<Value, Detail> {
    coerce_reported(name, ty, v, max_values).map(|(v, _)| v)
}

/// Gives every value of a compiled pattern its parameter name, its value and type.
struct Binder<'a> {
    pattern: &'a Pattern,
    variables: &'a BTreeMap<String, Value>,
    limits: PatternLimits,
    /// Name to (value, type).
    bound: BTreeMap<String, (Value, ParameterType)>,
    lists: Vec<ListReport>,
    next: usize,
}

impl<'a> Binder<'a> {
    fn new(pattern: &'a Pattern, variables: &'a BTreeMap<String, Value>, limits: PatternLimits) -> Self {
        Self { pattern, variables, limits, bound: BTreeMap::new(), lists: Vec::new(), next: 0 }
    }

    /// The parameter name for `operand`: a new `kz_vN` for a literal, the template parameter's
    /// own name (bound once) for a parameter.
    fn bind(&mut self, operand: &Operand, list: bool) -> Result<String, Detail> {
        let max = self.limits.max_values;
        match operand {
            Operand::Value(v) => {
                let ty = literal_kind(&v.value, list, max)?.ty();
                let name = format!("{RESERVED_PREFIX}v{}", self.next);
                self.next += 1;
                let value = coerce(&name, ty, &v.value, max)?;
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
                    let (value, report) = coerce_reported(&p.param, declared.ty, given, max)?;
                    self.lists.extend(report);
                    self.bound.insert(p.param.clone(), (value, declared.ty));
                }
                Ok(p.param.clone())
            }
        }
    }

    fn finish(self, text: String, limit: Option<u32>) -> (Compiled, BTreeMap<String, ParameterType>) {
        let types = self.bound.iter().map(|(k, (_, t))| (k.clone(), *t)).collect();
        let parameters = self.bound.into_iter().map(|(k, (v, _))| (k, v)).collect();
        (Compiled { text, parameters, limit, lists: self.lists }, types)
    }
}

impl Pattern {
    /// The limit the text gets: the pattern's, capped at the data source's row limit.
    pub fn effective_limit(&self, limits: &PatternLimits) -> u32 {
        self.limit().min(limits.max_limit.max(1))
    }
}

/// Compiles `pattern` for `dialect` with the template parameters' values from `variables`, within
/// `limits`; `graph` names TigerGraph's graph.
pub fn compile(
    pattern: &Pattern,
    dialect: Dialect,
    graph: Option<&str>,
    variables: &BTreeMap<String, Value>,
    limits: &PatternLimits,
) -> Result<Compiled, Detail> {
    pattern.check()?;
    pattern.check_limits(limits)?;
    match dialect {
        Dialect::Neo4j | Dialect::Memgraph => cypher::compile(pattern, dialect, variables, limits),
        Dialect::TigerGraph => gsql::compile(pattern, graph.unwrap_or_default(), variables, limits),
    }
}

/// Text of a value for comparing list values with what a result holds (`"7"` and `7` alike).
fn value_text(v: &Value) -> Option<String> {
    match v {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        // A typed value of a graph result: `{"$type": "int64", "value": "..."}`.
        Value::Object(o) => o.get("value").and_then(value_text),
        _ => None,
    }
}

/// Notices on a pattern's result: the limit reached without counting ("nicht gezählt") when
/// `records` reached it, and for each list how many of its values the result holds ("9 von 12
/// gefunden"), with what was left out of a pasted list.
pub fn annotate(
    result: &mut crate::shapes::QueryResult,
    pattern: &Pattern,
    compiled: &Compiled,
    records: Option<usize>,
) {
    use crate::shapes::{NoticeSeverity, QueryResult};
    if let (Some(limit), Some(records)) = (compiled.limit, records)
        && records >= limit as usize
    {
        result.add_notice(
            invalid(
                "pattern.limit_reached",
                format!("{limit} matches shown, the limit of the pattern; whether there are more was not counted"),
            )
            .with("limit", limit)
            .notice(NoticeSeverity::Info),
        );
    }
    let QueryResult::Graph { graph } = &*result else { return };
    // Per list parameter: which values occur on the nodes it narrows.
    let mut found: BTreeMap<String, (BTreeSet<String>, BTreeSet<String>)> = BTreeMap::new();
    let mut seek = |param: &str, node: &PatternNode, property: Option<&str>| {
        let Some(Value::Array(values)) = compiled.parameters.get(param) else { return };
        let wanted: BTreeSet<String> = values.iter().filter_map(value_text).collect();
        let hits = graph
            .nodes
            .iter()
            .filter(|n| node.labels.is_empty() || n.labels.iter().any(|l| node.labels.contains(l)))
            .filter_map(|n| match property {
                None => Some(n.id.clone()),
                Some(p) => n.properties.get(p).and_then(value_text),
            })
            .filter(|t| wanted.contains(t));
        let entry = found.entry(param.to_string()).or_insert_with(|| (wanted.clone(), BTreeSet::new()));
        entry.1.extend(hits);
    };
    for n in &pattern.nodes {
        if let Some(op) = &n.ids {
            seek(&operand_name(op, compiled), n, None);
        }
        for c in n.conditions.iter().filter(|c| c.op == Operator::In) {
            if let Some(op) = &c.value {
                seek(&operand_name(op, compiled), n, Some(&c.property));
            }
        }
    }
    let mut notices = Vec::new();
    for (name, (wanted, hits)) in found {
        // Literal lists keep their `kz_v` name, which no one typed: they are named as such.
        let shown = if name.starts_with(RESERVED_PREFIX) { "list".to_string() } else { name.clone() };
        let report = compiled.lists.iter().find(|r| r.name == name);
        let mut d =
            invalid("pattern.values_found", format!("{} of {} values of {shown} found", hits.len(), wanted.len()))
                .with("name", &shown)
                .with("found", hits.len())
                .with("total", wanted.len());
        if let Some(r) = report {
            d = d.with("duplicates", r.duplicates).with("empty", r.empty);
        }
        notices.push(d.notice(NoticeSeverity::Info));
    }
    for n in notices {
        result.add_notice(n);
    }
}

/// Takes `kz_found`, the number of matches a GSQL pattern kept, out of TigerGraph's printed
/// `results`.
pub fn take_found(results: &mut Value) -> Option<usize> {
    let key = format!("{RESERVED_PREFIX}found");
    let mut found = None;
    if let Value::Array(items) = results {
        for item in items.iter_mut() {
            if let Some(v) = item.as_object_mut().and_then(|o| o.remove(&key)) {
                found = v.as_u64().and_then(|n| usize::try_from(n).ok());
            }
        }
        items.retain(|i| i.as_object().is_none_or(|o| !o.is_empty()));
    }
    found
}

/// The parameter name an operand was bound under: its own for a template parameter; for a literal
/// the `kz_v` parameter holding the same value.
fn operand_name(op: &Operand, compiled: &Compiled) -> String {
    match op {
        Operand::Param(p) => p.param.clone(),
        Operand::Value(v) => compiled
            .parameters
            .iter()
            .find(|(k, val)| k.starts_with(RESERVED_PREFIX) && val.as_array().is_some() && values_equal(val, &v.value))
            .map(|(k, _)| k.clone())
            .unwrap_or_default(),
    }
}

fn values_equal(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Array(x), Value::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(a, b)| value_text(a) == value_text(b))
        }
        _ => value_text(a) == value_text(b),
    }
}

/// The names of the list parameters of a query that is a pattern (`{"pattern": {...}}`): their
/// values may be as long as `PatternLimits::max_values` allows, longer than other variables.
pub fn list_parameters(query: &Value) -> BTreeSet<String> {
    let Some(Ok(p)) = query.get("pattern").map(|p| serde_json::from_value::<Pattern>(p.clone())) else {
        return BTreeSet::new();
    };
    p.parameters.into_iter().filter(|p| p.ty.is_list()).map(|p| p.name).collect()
}

/// The pattern that counts the nodes of `label` or the edges of `edge_type` ("Zählen" in the
/// schema, for sources without statistics).
pub fn count_pattern(label: Option<&str>, edge_type: Option<&str>) -> Pattern {
    let node = |id: &str, labels: Vec<String>| PatternNode {
        id: id.into(),
        labels,
        conditions: Vec::new(),
        matches: Match::All,
        ids: None,
    };
    let (nodes, edges) = match edge_type {
        Some(t) => (
            vec![node("a", Vec::new()), node("b", Vec::new())],
            vec![PatternEdge {
                id: "e".into(),
                from: "a".into(),
                to: "b".into(),
                types: vec![t.to_string()],
                direction: Direction::Out,
                min_hops: 1,
                max_hops: 1,
                optional: false,
                conditions: Vec::new(),
                matches: Match::All,
            }],
        ),
        None => (vec![node("n", label.map(|l| vec![l.to_string()]).unwrap_or_default())], Vec::new()),
    };
    Pattern { nodes, edges, limit: None, parameters: Vec::new(), count: true }
}

/// The fixed query of a template parameter's choices (`Choices`): the distinct values of the
/// property, as the source's own query form. Cypher filters by `$kz_search` (bound) and stops after
/// `MAX_CHOICES + 1`; GSQL has no text search in a pattern, so its values are filtered by Kalzit.
pub fn choices_query(dialect: Dialect, graph: Option<&str>, choices: &Choices) -> Result<Value, Detail> {
    choices.check()?;
    match dialect {
        Dialect::Neo4j | Dialect::Memgraph => {
            let quote = |s: &str| format!("`{}`", s.replace('`', "``"));
            let (label, property) = (quote(&choices.label), quote(&choices.property));
            // Lists and maps have no text to search or pick; they are left out first, in a `WITH`
            // of their own, since `toString` refuses them and `AND` need not stop early.
            // `valueType` names them `LIST...` and `MAP...` in Neo4j and Memgraph.
            Ok(serde_json::json!({ "cypher": format!(
                "MATCH (n:{label}) WITH n.{property} AS value \
                 WHERE value IS NOT NULL AND NOT valueType(value) STARTS WITH 'LIST' \
                 AND NOT valueType(value) STARTS WITH 'MAP' \
                 WITH value WHERE toLower(toString(value)) CONTAINS toLower($kz_search) \
                 RETURN DISTINCT value ORDER BY value LIMIT {}",
                MAX_CHOICES + 1
            ) }))
        }
        Dialect::TigerGraph => {
            let plain = |what: &str, s: &str| {
                if is_plain_name(s) {
                    Ok(s.to_string())
                } else {
                    Err(invalid(
                        "pattern.gsql_name",
                        format!("TigerGraph needs plain names; the {what} {s:?} is not one"),
                    )
                    .with("what", what)
                    .with("name", s))
                }
            };
            let graph = plain("graph", graph.unwrap_or_default())?;
            let (label, property) = (plain("vertex type", &choices.label)?, plain("property", &choices.property)?);
            // The search narrows the nodes in TigerGraph (`LIKE`, the text bound as a parameter);
            // at most `CHOICES_SCAN` of them are read, so the work stays bounded, and Kalzit
            // searches, sorts and cuts the values again.
            Ok(serde_json::json!({ "gsql": format!(
                "INTERPRET QUERY (STRING kz_search) FOR GRAPH {graph} SYNTAX v2 {{\n  SetAccum<STRING> @@kz_values;\n  \
                 kz_s = {{{label}.*}};\n  \
                 kz_m = SELECT s FROM kz_s:s WHERE lower(to_string(s.{property})) LIKE \"%\" + lower(kz_search) + \"%\"\n    \
                 LIMIT {CHOICES_SCAN};\n  \
                 kz_r = SELECT s FROM kz_m:s ACCUM @@kz_values += to_string(s.{property});\n  \
                 PRINT @@kz_values AS kz_values;\n}}"
            ) }))
        }
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
        p.parameters.push(PatternParameter { name: name.clone(), ty: *ty, label: None, choices: None });
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
        p.edges[0].max_hops = 21;
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
        p.nodes.push(PatternNode {
            id: "c".into(),
            labels: vec![],
            conditions: vec![],
            matches: Match::All,
            ids: None,
        });
        assert_eq!(reason(&p), "pattern.not_connected");
        let mut p = knows();
        p.nodes.push(PatternNode {
            id: "c".into(),
            labels: vec![],
            conditions: vec![],
            matches: Match::All,
            ids: None,
        });
        p.nodes.push(PatternNode {
            id: "d".into(),
            labels: vec![],
            conditions: vec![],
            matches: Match::All,
            ids: None,
        });
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
            matches: Match::All,
        });
        assert_eq!(reason(&p), "pattern.optional_unattached");
        let mut p = knows();
        p.nodes[0].labels = vec![String::new()];
        assert_eq!(reason(&p), "pattern.name_invalid");
    }

    #[test]
    fn parameters_take_their_declared_type() {
        let c = |name: &str, ty: ParameterType, v: Value| coerce(name, ty, &v, 10);
        assert_eq!(c("n", ParameterType::Integer, json!("42")).unwrap(), json!(42));
        assert_eq!(c("n", ParameterType::Integer, json!(7)).unwrap(), json!(7));
        assert_eq!(c("n", ParameterType::Integer, json!("4.2")).unwrap_err().reason, "pattern.parameter_type");
        assert_eq!(c("n", ParameterType::Float, json!("2.5")).unwrap(), json!(2.5));
        assert_eq!(c("n", ParameterType::Float, json!("NaN")).unwrap_err().reason, "pattern.parameter_type");
        assert_eq!(c("n", ParameterType::Boolean, json!("true")).unwrap(), json!(true));
        assert_eq!(c("n", ParameterType::String, json!(12)).unwrap(), json!("12"));
        assert_eq!(c("n", ParameterType::String, json!(["a"])).unwrap_err().reason, "pattern.parameter_type");
        // Ids split at spaces too; other lists keep a space inside a value.
        assert_eq!(
            c(
                "ids",
                ParameterType::IdList,
                json!(
                    "4:ab:1
4:ab:2, 4:ab:3;4:ab:1	4:ab:4  "
                )
            )
            .unwrap(),
            json!(["4:ab:1", "4:ab:2", "4:ab:3", "4:ab:4"])
        );
        assert_eq!(
            c(
                "n",
                ParameterType::StringList,
                json!(
                    "Nord GmbH
Süd AG"
                )
            )
            .unwrap(),
            json!(["Nord GmbH", "Süd AG"])
        );
        assert_eq!(
            c(
                "n",
                ParameterType::IntegerList,
                json!(
                    "1
2;3"
                )
            )
            .unwrap(),
            json!([1, 2, 3])
        );
        assert_eq!(c("n", ParameterType::IntegerList, json!("1 2")).unwrap_err().reason, "pattern.parameter_type");
        assert_eq!(c("n", ParameterType::IntegerList, json!(["1", 2])).unwrap(), json!([1, 2]));
        assert_eq!(c("n", ParameterType::IntegerList, json!(true)).unwrap_err().reason, "pattern.parameter_type");
        let many = (0..=10).map(|i| i.to_string()).collect::<Vec<_>>().join(
            "
",
        );
        let e = c("ids", ParameterType::IdList, json!(many)).unwrap_err();
        assert_eq!((e.reason, e.params["max"].as_str()), ("pattern.too_many_values", "10"));
    }

    #[test]
    fn pasted_values_are_split_and_reported() {
        let (values, r) = split_values(
            "n",
            "4711
4712
4712

4720, 4731; 4733
",
            false,
        );
        assert_eq!(values, ["4711", "4712", "4720", "4731", "4733"]);
        assert_eq!((r.values, r.duplicates, r.empty), (5, 1, 1));
        let (values, r) = split_values("n", " a  b	c,,a", true);
        assert_eq!(values, ["a", "b", "c"]);
        assert_eq!((r.duplicates, r.empty), (1, 1));
        let (values, r) = split_values("n", "", true);
        assert!(values.is_empty() && r.empty == 0);
    }

    #[test]
    fn boolean_lists_and_parameters_named_like_aliases_are_refused() {
        let mut p = knows();
        p.nodes[1].conditions.push(Condition {
            property: "x".into(),
            op: Operator::In,
            value: Some(Operand::literal(json!([true, false]))),
        });
        assert_eq!(reason(&p), "pattern.value_invalid");
        let mut p = knows();
        p.parameters[0].name = "B".into();
        p.nodes[0].conditions[0].value = Some(Operand::param("B"));
        assert_eq!(reason(&p), "pattern.duplicate_name");
        let mut p = knows();
        p.nodes[0].id = "vertex".into();
        p.edges[0].from = "vertex".into();
        assert_eq!(reason(&p), "pattern.name_invalid");
        let mut p = knows();
        p.nodes[0].labels = vec!["Per\\son".into()];
        assert_eq!(reason(&p), "pattern.name_invalid");
    }

    #[test]
    fn choices_queries_bind_the_search_and_stay_bounded() {
        let c = Choices { label: "Firma".into(), property: "name".into(), ref_id: None };
        let q = choices_query(Dialect::Neo4j, None, &c).unwrap();
        let cypher = q["cypher"].as_str().unwrap();
        assert!(cypher.contains("CONTAINS toLower($kz_search)") && cypher.ends_with("LIMIT 201"), "{cypher}");
        assert!(cypher.contains("NOT valueType(value) STARTS WITH 'LIST'"), "{cypher}");
        crate::datasources::cypher::check(cypher).unwrap();
        let q = choices_query(Dialect::TigerGraph, Some("social"), &c).unwrap();
        let gsql = q["gsql"].as_str().unwrap();
        assert!(gsql.contains("LIKE \"%\" + lower(kz_search) + \"%\"") && gsql.contains("LIMIT 10000;"), "{gsql}");
        let checked =
            crate::datasources::gsql::check_with(gsql, crate::datasources::gsql::Form::Interpret, None).unwrap();
        assert_eq!(checked.params.len(), 1);
        let bad = Choices { label: "Firma GmbH".into(), ..c };
        assert_eq!(choices_query(Dialect::TigerGraph, Some("social"), &bad).unwrap_err().reason, "pattern.gsql_name");
    }

    #[test]
    fn the_kept_matches_of_gsql_come_out_of_the_answer() {
        let mut results = json!([{ "kz_n": [] }, { "@@kz_edges": [] }, { "kz_found": 500 }]);
        assert_eq!(take_found(&mut results), Some(500));
        assert_eq!(results, json!([{ "kz_n": [] }, { "@@kz_edges": [] }]));
        let mut nothing = json!([{ "kz_n": [] }]);
        assert_eq!(take_found(&mut nothing), None);
    }

    #[test]
    fn the_server_limits_paths_and_the_source_limits_matches() {
        let mut p = knows();
        p.edges[0].max_hops = 7;
        let limits = PatternLimits::default();
        let e =
            compile(&p, Dialect::Neo4j, None, &BTreeMap::from([("firma".into(), json!("x"))]), &limits).unwrap_err();
        assert_eq!((e.reason, e.params["max"].as_str()), ("pattern.hops_invalid", "6"));
        let p = knows();
        assert_eq!(p.limit(), 500);
        assert_eq!(p.effective_limit(&PatternLimits { max_limit: 50, ..limits }), 50);
    }
}
