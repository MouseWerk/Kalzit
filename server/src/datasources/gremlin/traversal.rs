//! Gremlin traversals as Kalzit reads them: the text a person writes (`g.V().hasLabel('person')
//! .out('knows').limit(10)`) parsed into steps, every step checked against a list of reading
//! steps, and the result sent as bytecode, never as a script. Gremlin Server then runs no Groovy
//! at all, only the steps Kalzit sent.
//!
//! Accepted is one traversal from `g` that starts with `V`, `E` or `inject`, with the steps in
//! `READ_STEPS`; anonymous traversals (`__.out()`, or `out()` inside a step) are checked the same
//! way. Arguments are strings, numbers, booleans, `null`, lists, predicates (`P.gt(5)`, `gt(5)`,
//! `TextP.containing('a')`, combined with `.and()` and `.or()`), the tokens of `T`, `Order`,
//! `Scope`, `Column`, `Direction`, `Pop` and `Operator`, and names of dashboard variables and
//! macros, whose values go into the bytecode as values. A trailing `.toList()` is dropped and
//! `.next()` becomes `limit(1)`.
//!
//! Refused, with their own reason: the steps that change the graph (`addV`, `addE`, `property`,
//! `drop`, `mergeV`, `mergeE`), steps that read or write files or call services (`io`, `call`,
//! `program`), `sideEffect`, `iterate`, source steps such as `withStrategies`, lambdas and every
//! other step outside the list. The server applies `ReadOnlyStrategy` to every traversal Kalzit
//! sends, which refuses a mutating step whatever the check missed.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{Value, json};

use super::super::Detail;

/// Steps that only read.
const READ_STEPS: &[&str] = &[
    "V",
    "E",
    "inject",
    "out",
    "in",
    "both",
    "outE",
    "inE",
    "bothE",
    "outV",
    "inV",
    "bothV",
    "otherV",
    "has",
    "hasLabel",
    "hasId",
    "hasKey",
    "hasValue",
    "hasNot",
    "is",
    "not",
    "and",
    "or",
    "where",
    "filter",
    "values",
    "valueMap",
    "elementMap",
    "propertyMap",
    "properties",
    "id",
    "label",
    "key",
    "value",
    "select",
    "project",
    "by",
    "as",
    "path",
    "simplePath",
    "cyclicPath",
    "count",
    "sum",
    "min",
    "max",
    "mean",
    "group",
    "groupCount",
    "fold",
    "unfold",
    "dedup",
    "limit",
    "range",
    "skip",
    "tail",
    "order",
    "coalesce",
    "choose",
    "option",
    "optional",
    "union",
    "repeat",
    "times",
    "until",
    "emit",
    "local",
    "constant",
    "math",
    "coin",
    "sample",
    "aggregate",
    "store",
    "cap",
    "tree",
    "barrier",
    "identity",
    "map",
    "flatMap",
    "match",
    "loops",
    "index",
    "concat",
    "asString",
    "length",
    "toLower",
    "toUpper",
    "trim",
    "lTrim",
    "rTrim",
    "split",
    "substring",
    "replace",
    "format",
    "dateAdd",
    "dateDiff",
    "asDate",
    "all",
    "any",
    "none",
    "combine",
    "difference",
    "disjunct",
    "intersect",
    "conjoin",
    "merge",
    "product",
    "reverse",
    "element",
    "from",
    "to",
    "timeLimit",
];

/// Steps that change the graph or reach outside it; named in their refusal.
const WRITE_STEPS: &[&str] = &[
    "addV",
    "addE",
    "property",
    "drop",
    "mergeV",
    "mergeE",
    "io",
    "call",
    "program",
    "sideEffect",
    "iterate",
    "write",
    "read",
];

/// Steps that may start a traversal from `g`.
const START_STEPS: &[&str] = &["V", "E", "inject"];

const PREDICATES: &[&str] =
    &["eq", "neq", "lt", "lte", "gt", "gte", "inside", "outside", "between", "within", "without"];
const TEXT_PREDICATES: &[&str] = &[
    "containing",
    "notContaining",
    "startingWith",
    "notStartingWith",
    "endingWith",
    "notEndingWith",
    "regex",
    "notRegex",
];

/// The token classes and their values, with their GraphSON type.
const TOKENS: &[(&str, &str, &[&str])] = &[
    ("T", "g:T", &["id", "label", "key", "value"]),
    ("Order", "g:Order", &["asc", "desc", "shuffle"]),
    ("Scope", "g:Scope", &["local", "global"]),
    ("Column", "g:Column", &["keys", "values"]),
    ("Direction", "g:Direction", &["OUT", "IN", "BOTH"]),
    ("Pop", "g:Pop", &["first", "last", "all", "mixed"]),
    (
        "Operator",
        "g:Operator",
        &["sum", "minus", "mult", "div", "min", "max", "assign", "and", "or", "addAll", "sumLong"],
    ),
];

/// Bare tokens (static imports in the Gremlin console): `desc`, `local`, `keys`, `id`, ...
const BARE_TOKENS: &[(&str, &str)] = &[
    ("id", "T"),
    ("label", "T"),
    ("key", "T"),
    ("value", "T"),
    ("asc", "Order"),
    ("desc", "Order"),
    ("shuffle", "Order"),
    ("local", "Scope"),
    ("global", "Scope"),
    ("keys", "Column"),
    ("values", "Column"),
    ("OUT", "Direction"),
    ("IN", "Direction"),
    ("BOTH", "Direction"),
    ("first", "Pop"),
    ("last", "Pop"),
    ("all", "Pop"),
    ("mixed", "Pop"),
];

/// How deep traversals and lists may nest.
const MAX_DEPTH: usize = 32;

#[derive(Clone, Debug, PartialEq)]
pub enum Arg {
    Str(String),
    Int(i64),
    Float(f64),
    Bool(bool),
    Null,
    List(Vec<Arg>),
    /// An anonymous traversal.
    Traversal(Vec<Step>),
    /// A predicate: `g:P` or `g:TextP`, its name and its value (a list for several).
    Pred {
        text: bool,
        name: String,
        value: Box<Arg>,
    },
    /// A token: its GraphSON type and value.
    Token(&'static str, String),
    /// A dashboard variable or macro, bound before the traversal is sent.
    Var(String),
    /// A value as the server sent it (typed GraphSON), such as an element id Kalzit asks for
    /// again; never from a person's text.
    Raw(Value),
}

#[derive(Clone, Debug, PartialEq)]
pub struct Step {
    pub name: String,
    pub args: Vec<Arg>,
}

/// A checked traversal and the variables it names.
#[derive(Clone, Debug, PartialEq)]
pub struct Traversal {
    pub steps: Vec<Step>,
    pub variables: BTreeSet<String>,
}

#[derive(Clone, Debug, PartialEq)]
enum Tok {
    Ident(String),
    Str(String),
    Int(i64),
    Float(f64),
    Sym(char),
}

fn reject(reason: &'static str, message: impl Into<String>) -> Detail {
    Detail::new(reason, message)
}

fn syntax(message: impl Into<String>) -> Detail {
    reject("gremlin.syntax", message)
}

fn lex(q: &str) -> Result<Vec<Tok>, Detail> {
    let b = q.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        let c = b[i];
        if c.is_ascii_whitespace() {
            i += 1;
            continue;
        }
        if q[i..].starts_with("//") {
            i = q[i..].find('\n').map_or(b.len(), |n| i + n);
            continue;
        }
        if q[i..].starts_with("/*") {
            let end = q[i + 2..].find("*/").ok_or_else(|| syntax("a comment is not closed"))?;
            i += 2 + end + 2;
            continue;
        }
        if c == b'\'' || c == b'"' {
            if q[i..].starts_with("'''") || q[i..].starts_with("\"\"\"") {
                return Err(syntax("triple-quoted strings are not supported; use '...'"));
            }
            let mut s = String::new();
            let mut chars = q[i + 1..].char_indices();
            let end = loop {
                let Some((at, ch)) = chars.next() else { return Err(syntax("a string is not closed")) };
                match ch {
                    '\\' => {
                        let (_, e) = chars.next().ok_or_else(|| syntax("a string is not closed"))?;
                        match e {
                            'n' => s.push('\n'),
                            't' => s.push('\t'),
                            'r' => s.push('\r'),
                            'b' => s.push('\u{8}'),
                            'f' => s.push('\u{c}'),
                            '\\' | '\'' | '"' | '$' => s.push(e),
                            'u' => {
                                let hex: String = (0..4).filter_map(|_| chars.next().map(|(_, h)| h)).collect();
                                let ch = u32::from_str_radix(&hex, 16)
                                    .ok()
                                    .and_then(char::from_u32)
                                    .ok_or_else(|| syntax("a \\u escape needs four hex digits"))?;
                                s.push(ch);
                            }
                            other => return Err(syntax(format!("the escape \\{other} is not supported"))),
                        }
                    }
                    ch if ch as u32 == c as u32 => break i + 1 + at,
                    ch => s.push(ch),
                }
            };
            out.push(Tok::Str(s));
            i = end + 1;
            continue;
        }
        if c.is_ascii_digit() {
            let start = i;
            i += b[i..].iter().take_while(|d| d.is_ascii_digit()).count();
            let mut float = false;
            if b.get(i) == Some(&b'.') && b.get(i + 1).is_some_and(u8::is_ascii_digit) {
                float = true;
                i += 1;
                i += b[i..].iter().take_while(|d| d.is_ascii_digit()).count();
            }
            if matches!(b.get(i), Some(b'e' | b'E')) {
                float = true;
                i += 1;
                if matches!(b.get(i), Some(b'+' | b'-')) {
                    i += 1;
                }
                i += b[i..].iter().take_while(|d| d.is_ascii_digit()).count();
            }
            let text = &q[start..i];
            match b.get(i) {
                Some(b'l' | b'L' | b'i' | b'I') if !float => i += 1,
                Some(b'd' | b'D' | b'f' | b'F') => {
                    float = true;
                    i += 1;
                }
                _ => {}
            }
            if b.get(i).is_some_and(|d| d.is_ascii_alphanumeric() || *d == b'_') {
                return Err(syntax(format!("{} is not a number Kalzit reads", &q[start..=i])));
            }
            out.push(if float {
                Tok::Float(text.parse().map_err(|_| syntax(format!("{text} is not a number")))?)
            } else {
                Tok::Int(text.parse().map_err(|_| syntax(format!("{text} is too large")))?)
            });
            continue;
        }
        if c.is_ascii_alphabetic() || c == b'_' {
            let len = b[i..].iter().take_while(|d| d.is_ascii_alphanumeric() || **d == b'_').count();
            out.push(Tok::Ident(q[i..i + len].to_string()));
            i += len;
            continue;
        }
        if b".(),[]-;:".contains(&c) {
            out.push(Tok::Sym(c as char));
            i += 1;
            continue;
        }
        if c == b'{' {
            return Err(reject("gremlin.lambda", "lambdas ({ ... }) are not allowed; use steps instead"));
        }
        let ch = q[i..].chars().next().unwrap_or('?');
        return Err(
            syntax(format!("the character {ch} is not understood outside strings and comments")).with("char", ch)
        );
    }
    Ok(out)
}

struct P {
    t: Vec<Tok>,
    i: usize,
    variables: BTreeSet<String>,
}

impl P {
    fn peek(&self) -> Option<&Tok> {
        self.t.get(self.i)
    }

    fn peek_at(&self, n: usize) -> Option<&Tok> {
        self.t.get(self.i + n)
    }

    fn sym(&mut self, c: char) -> bool {
        if self.peek() == Some(&Tok::Sym(c)) {
            self.i += 1;
            true
        } else {
            false
        }
    }

    fn expect(&mut self, c: char) -> Result<(), Detail> {
        if self.sym(c) { Ok(()) } else { Err(syntax(format!("expected {c} here"))) }
    }

    fn ident(&mut self) -> Result<String, Detail> {
        match self.peek() {
            Some(Tok::Ident(s)) => {
                let s = s.clone();
                self.i += 1;
                Ok(s)
            }
            _ => Err(syntax("expected a step name here")),
        }
    }

    /// `.step(...)` repeated, after the first step.
    fn chain(&mut self, steps: &mut Vec<Step>, depth: usize) -> Result<(), Detail> {
        while self.peek() == Some(&Tok::Sym('.')) {
            self.i += 1;
            steps.push(self.step(depth)?);
        }
        Ok(())
    }

    fn step(&mut self, depth: usize) -> Result<Step, Detail> {
        let name = self.ident()?;
        check_step(&name)?;
        self.expect('(')?;
        let args = self.args(')', depth)?;
        Ok(Step { name, args })
    }

    fn args(&mut self, close: char, depth: usize) -> Result<Vec<Arg>, Detail> {
        if depth > MAX_DEPTH {
            return Err(syntax("the traversal is nested too deeply"));
        }
        let mut out = Vec::new();
        if self.sym(close) {
            return Ok(out);
        }
        loop {
            out.push(self.arg(depth + 1)?);
            if self.sym(close) {
                return Ok(out);
            }
            self.expect(',')?;
        }
    }

    fn number(&mut self, negative: bool) -> Result<Arg, Detail> {
        let sign = if negative { -1 } else { 1 };
        match self.peek().cloned() {
            Some(Tok::Int(n)) => {
                self.i += 1;
                Ok(Arg::Int(sign * n))
            }
            Some(Tok::Float(f)) => {
                self.i += 1;
                Ok(Arg::Float(sign as f64 * f))
            }
            _ => Err(syntax("expected a number after -")),
        }
    }

    fn arg(&mut self, depth: usize) -> Result<Arg, Detail> {
        let tok = self.peek().cloned().ok_or_else(|| syntax("the traversal ends too early"))?;
        match tok {
            Tok::Str(s) => {
                self.i += 1;
                Ok(Arg::Str(s))
            }
            Tok::Int(_) | Tok::Float(_) => self.number(false),
            Tok::Sym('-') => {
                self.i += 1;
                self.number(true)
            }
            Tok::Sym('[') => {
                self.i += 1;
                let items = self.args(']', depth)?;
                Ok(Arg::List(items))
            }
            Tok::Ident(name) => self.named(&name, depth),
            Tok::Sym(c) => Err(syntax(format!("{c} cannot start a value"))),
        }
    }

    /// An argument that starts with a name: a literal word, an anonymous traversal, a predicate,
    /// a token or a variable.
    fn named(&mut self, name: &str, depth: usize) -> Result<Arg, Detail> {
        let next = self.peek_at(1).cloned();
        match name {
            "true" | "false" if next != Some(Tok::Sym('(')) => {
                self.i += 1;
                return Ok(Arg::Bool(name == "true"));
            }
            "null" if next != Some(Tok::Sym('(')) => {
                self.i += 1;
                return Ok(Arg::Null);
            }
            "__" => {
                self.i += 1;
                self.expect('.')?;
                let mut steps = vec![self.step(depth)?];
                self.chain(&mut steps, depth)?;
                return Ok(Arg::Traversal(steps));
            }
            "P" | "TextP" if next == Some(Tok::Sym('.')) => {
                self.i += 2;
                let pred = self.ident()?;
                return self.predicate(&pred, name == "TextP", depth);
            }
            _ => {}
        }
        if let Some((_, ty, values)) = TOKENS.iter().find(|(class, _, _)| *class == name)
            && next == Some(Tok::Sym('.'))
        {
            self.i += 2;
            let value = self.ident()?;
            if !values.contains(&value.as_str()) {
                return Err(syntax(format!("{name}.{value} is not a token Kalzit knows")));
            }
            return Ok(Arg::Token(ty, value));
        }
        if matches!(name, "Cardinality" | "Merge" | "WithOptions" | "Pick" | "VertexProperty") {
            return Err(reject("gremlin.token_refused", format!("{name} is not allowed here")).with("name", name));
        }
        if next == Some(Tok::Sym('(')) {
            if PREDICATES.contains(&name) || TEXT_PREDICATES.contains(&name) {
                self.i += 1;
                return self.predicate(name, TEXT_PREDICATES.contains(&name), depth);
            }
            // An anonymous traversal written without `__.`.
            let mut steps = vec![self.step(depth)?];
            self.chain(&mut steps, depth)?;
            return Ok(Arg::Traversal(steps));
        }
        self.i += 1;
        if let Some((_, class)) = BARE_TOKENS.iter().find(|(t, _)| *t == name) {
            let ty = TOKENS.iter().find(|(c, _, _)| c == class).map(|(_, ty, _)| *ty).unwrap_or("g:T");
            return Ok(Arg::Token(ty, name.to_string()));
        }
        if !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
            return Err(syntax(format!("{name} is not a variable name")));
        }
        self.variables.insert(name.to_string());
        Ok(Arg::Var(name.to_string()))
    }

    /// `name(args)` of `P` or `TextP`, then `.and(p)` / `.or(p)`.
    fn predicate(&mut self, name: &str, text: bool, depth: usize) -> Result<Arg, Detail> {
        let known = if text { TEXT_PREDICATES } else { PREDICATES };
        if !known.contains(&name) && !(text && PREDICATES.contains(&name)) && name != "not" {
            return Err(syntax(format!("{name} is not a predicate Kalzit knows")));
        }
        self.expect('(')?;
        let mut args = self.args(')', depth)?;
        let value = match (name, args.len()) {
            (_, 0) => return Err(syntax(format!("{name}() needs a value"))),
            ("within" | "without", _) if args.len() > 1 => Arg::List(args),
            ("inside" | "outside" | "between", 2) => Arg::List(args),
            ("inside" | "outside" | "between", _) => return Err(syntax(format!("{name}() takes two values"))),
            (_, 1) => args.pop().unwrap_or(Arg::Null),
            _ => return Err(syntax(format!("{name}() takes one value"))),
        };
        let mut pred = Arg::Pred { text, name: name.to_string(), value: Box::new(value) };
        while self.peek() == Some(&Tok::Sym('.'))
            && matches!(self.peek_at(1), Some(Tok::Ident(n)) if n == "and" || n == "or")
        {
            self.i += 1;
            let join = self.ident()?;
            self.expect('(')?;
            let other = self.args(')', depth)?;
            let [other @ Arg::Pred { .. }] = <[Arg; 1]>::try_from(other)
                .map_err(|_| syntax(format!("{join}() of a predicate takes one predicate")))?
            else {
                return Err(syntax(format!("{join}() of a predicate takes one predicate")));
            };
            pred = Arg::Pred { text: false, name: join, value: Box::new(Arg::List(vec![pred, other])) };
        }
        Ok(pred)
    }
}

fn check_step(name: &str) -> Result<(), Detail> {
    if READ_STEPS.contains(&name) {
        return Ok(());
    }
    if WRITE_STEPS.contains(&name) {
        return Err(reject(
            "gremlin.write_refused",
            format!("{name}() changes the graph or reaches outside it; Kalzit runs only reading traversals"),
        )
        .with("step", name));
    }
    Err(reject("gremlin.step_refused", format!("{name}() is not a step Kalzit runs")).with("step", name))
}

/// Parses and checks one traversal.
pub fn parse(q: &str) -> Result<Traversal, Detail> {
    let mut t = lex(q)?;
    while t.last() == Some(&Tok::Sym(';')) {
        t.pop();
    }
    if t.is_empty() {
        return Err(reject("gremlin.empty", "the traversal is empty"));
    }
    let mut p = P { t, i: 0, variables: BTreeSet::new() };
    match p.peek() {
        Some(Tok::Ident(g)) if g == "g" => p.i += 1,
        _ => return Err(reject("gremlin.not_a_traversal", "the traversal must start with g.")),
    }
    p.expect('.')?;
    let first = p.ident()?;
    if first.starts_with("with") {
        return Err(reject("gremlin.source_refused", format!("g.{first}() is not allowed; start with g.V() or g.E()"))
            .with("step", first));
    }
    p.i -= 1;
    let start = p.step(0)?;
    if !START_STEPS.contains(&start.name.as_str()) {
        return Err(reject(
            "gremlin.not_a_traversal",
            format!("a traversal starts with g.V(), g.E() or g.inject(), not g.{}()", start.name),
        ));
    }
    let mut steps = vec![start];
    loop {
        if p.peek() != Some(&Tok::Sym('.')) {
            break;
        }
        // Terminal steps of the console: toList() is the default, next() is limit(1).
        if let Some(Tok::Ident(n)) = p.peek_at(1).cloned()
            && matches!(n.as_str(), "toList" | "next" | "toSet")
        {
            p.i += 2;
            p.expect('(')?;
            let args = p.args(')', 0)?;
            match (n.as_str(), args.as_slice()) {
                ("next", []) => steps.push(Step { name: "limit".into(), args: vec![Arg::Int(1)] }),
                ("next", [Arg::Int(k)]) => steps.push(Step { name: "limit".into(), args: vec![Arg::Int(*k)] }),
                ("toList", []) => {}
                ("toSet", []) => steps.push(Step { name: "dedup".into(), args: vec![] }),
                _ => return Err(syntax(format!("{n}() takes no such arguments"))),
            }
            if p.i != p.t.len() {
                return Err(syntax(format!("{n}() ends the traversal")));
            }
            break;
        }
        p.i += 1;
        steps.push(p.step(0)?);
    }
    if p.i != p.t.len() {
        return Err(reject("gremlin.not_one_traversal", "exactly one traversal is allowed"));
    }
    Ok(Traversal { steps, variables: p.variables })
}

// ---- bytecode ----

/// A JSON value of a variable as an argument: strings, numbers, booleans, null and lists of them.
pub fn value_arg(v: &Value) -> Option<Arg> {
    Some(match v {
        Value::String(s) => Arg::Str(s.clone()),
        Value::Bool(b) => Arg::Bool(*b),
        Value::Null => Arg::Null,
        Value::Number(n) => match n.as_i64() {
            Some(i) => Arg::Int(i),
            None => Arg::Float(n.as_f64()?),
        },
        Value::Array(a) => Arg::List(a.iter().map(value_arg).collect::<Option<_>>()?),
        Value::Object(_) => return None,
    })
}

fn bind_arg(a: &Arg, vars: &BTreeMap<String, Arg>) -> Result<Arg, Detail> {
    Ok(match a {
        Arg::Var(name) => vars
            .get(name)
            .cloned()
            .ok_or_else(|| reject("gremlin.variable_missing", format!("{name} has no value")).with("name", name))?,
        Arg::List(items) => Arg::List(items.iter().map(|i| bind_arg(i, vars)).collect::<Result<_, _>>()?),
        Arg::Traversal(steps) => Arg::Traversal(bind_steps(steps, vars)?),
        Arg::Pred { text, name, value } => {
            Arg::Pred { text: *text, name: name.clone(), value: Box::new(bind_arg(value, vars)?) }
        }
        other => other.clone(),
    })
}

/// The steps with every variable replaced by its value.
pub fn bind_steps(steps: &[Step], vars: &BTreeMap<String, Arg>) -> Result<Vec<Step>, Detail> {
    steps
        .iter()
        .map(|s| {
            Ok(Step { name: s.name.clone(), args: s.args.iter().map(|a| bind_arg(a, vars)).collect::<Result<_, _>>()? })
        })
        .collect()
}

fn typed(t: &str, v: Value) -> Value {
    json!({ "@type": t, "@value": v })
}

fn graphson(a: &Arg) -> Value {
    match a {
        Arg::Str(s) => Value::String(s.clone()),
        Arg::Int(i) => match i32::try_from(*i) {
            Ok(small) => typed("g:Int32", json!(small)),
            Err(_) => typed("g:Int64", json!(i)),
        },
        Arg::Float(f) => typed("g:Double", json!(f)),
        Arg::Bool(b) => Value::Bool(*b),
        Arg::Null | Arg::Var(_) => Value::Null,
        Arg::List(items) => typed("g:List", Value::Array(items.iter().map(graphson).collect())),
        Arg::Traversal(steps) => typed("g:Bytecode", json!({ "step": steps_json(steps) })),
        Arg::Pred { text, name, value } => {
            let value = match (name.as_str(), value.as_ref()) {
                // `and` and `or` take their two predicates as a plain array.
                ("and" | "or", Arg::List(items)) => Value::Array(items.iter().map(graphson).collect()),
                _ => graphson(value),
            };
            typed(if *text { "g:TextP" } else { "g:P" }, json!({ "predicate": name, "value": value }))
        }
        Arg::Token(t, v) => typed(t, json!(v)),
        Arg::Raw(v) => v.clone(),
    }
}

fn steps_json(steps: &[Step]) -> Value {
    Value::Array(
        steps
            .iter()
            .map(|s| {
                let mut one = vec![Value::String(s.name.clone())];
                one.extend(s.args.iter().map(graphson));
                Value::Array(one)
            })
            .collect(),
    )
}

/// The bytecode Kalzit sends: the steps, always under `ReadOnlyStrategy`.
pub fn bytecode(steps: &[Step]) -> Value {
    typed(
        "g:Bytecode",
        json!({
            "source": [["withStrategies", typed("g:ReadOnlyStrategy", json!({}))]],
            "step": steps_json(steps),
        }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reason(q: &str) -> &'static str {
        parse(q).map(|_| "ok").unwrap_or_else(|d| d.reason)
    }

    #[test]
    fn reading_traversals_parse_into_steps() {
        let t =
            parse("g.V().hasLabel('person').has('age', P.gt(30)).out(\"knows\").order().by('name', desc).limit(10)")
                .unwrap();
        let names: Vec<&str> = t.steps.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, ["V", "hasLabel", "has", "out", "order", "by", "limit"]);
        assert_eq!(t.steps[2].args[1], Arg::Pred { text: false, name: "gt".into(), value: Box::new(Arg::Int(30)) });
        assert_eq!(t.steps[5].args[1], Arg::Token("g:Order", "desc".into()));
        for q in [
            "g.E().limit(5)",
            "g.V().repeat(out()).times(2).path()",
            "g.V().where(__.out('knows').count().is(gt(2))).values('name')",
            "g.V().has('name', within('a', 'b')).elementMap()",
            "g.V().has('name', TextP.containing('ar')).valueMap(true)",
            "g.V().group().by(label).by(count())",
            "g.V().has('age', P.gt(1).and(P.lt(5))).toList()",
            "g.V().project('n', 'd').by('name').by(bothE().count())",
            "g.V().has(T.id, 1).next()",
            "g.inject(1, -2.5, 3L, 1e3d, [1, 2], null, true)",
            "g.V().choose(has('age'), constant('x'), constant('y'))",
        ] {
            assert_eq!(reason(q), "ok", "{q}");
        }
        let t = parse("g.V().has('land', land).has('t', gte(__timeFrom))").unwrap();
        assert_eq!(t.variables, ["__timeFrom".to_string(), "land".to_string()].into());
    }

    #[test]
    fn mutating_and_unknown_steps_are_refused_also_inside() {
        for q in [
            "g.addV('person')",
            "g.V().addE('knows').to(V(1))",
            "g.V().property('name', 'x')",
            "g.V().drop()",
            "g.V().sideEffect(drop())",
            "g.V().where(__.drop())",
            "g.mergeV([name: 'x'])",
            "g.io('file.xml').read()",
            "g.V().call('tinker.search')",
            "g.V().union(identity(), addV('x'))",
            "g.V().iterate()",
        ] {
            assert!(matches!(reason(q), "gremlin.write_refused" | "gremlin.not_a_traversal"), "{q}: {}", reason(q));
        }
        assert_eq!(reason("g.V().drop()"), "gremlin.write_refused");
        assert_eq!(reason("g.V().shortestPath()"), "gremlin.step_refused");
        assert_eq!(reason("g.withSideEffect('a', 1).V()"), "gremlin.source_refused");
        assert_eq!(reason("g.withStrategies(new X()).V()"), "gremlin.source_refused");
        assert_eq!(reason("g.V().map{ it.get() }"), "gremlin.lambda");
        assert_eq!(reason("g.V().property(Cardinality.single, 'a', 1)"), "gremlin.write_refused");
        assert_eq!(reason("g.V().has(Cardinality.single)"), "gremlin.token_refused");
    }

    #[test]
    fn what_is_not_one_traversal_is_refused() {
        assert_eq!(reason(""), "gremlin.empty");
        assert_eq!(reason("graph.V()"), "gremlin.not_a_traversal");
        assert_eq!(reason("g.V(); g.V().drop()"), "gremlin.not_one_traversal");
        assert_eq!(reason("g.V()\ng.V()"), "gremlin.not_one_traversal");
        assert_eq!(reason("g.V().has('a'"), "gremlin.syntax");
        assert_eq!(reason("g.V().has('a)"), "gremlin.syntax");
        assert_eq!(reason("g.V().has(\"\"\"a\"\"\")"), "gremlin.syntax");
        assert_eq!(reason("g.V().has('a', 1G)"), "gremlin.syntax");
        assert_eq!(reason("g.V().has('a', Order.incr)"), "gremlin.syntax");
        assert_eq!(reason("System.exit(0)"), "gremlin.not_a_traversal");
        assert_eq!(reason("g.V().next().drop()"), "gremlin.syntax");
    }

    #[test]
    fn bytecode_carries_typed_values_under_the_read_only_strategy() {
        let t = parse(
            "g.V().has('age', between(1, 5)).has('n', land).limit(3000000000).order().by(values('x'), Order.desc)",
        )
        .unwrap();
        let vars = [("land".to_string(), Arg::Str("Österreich".into()))].into();
        let steps = bind_steps(&t.steps, &vars).unwrap();
        let b = bytecode(&steps);
        assert_eq!(b["@type"], "g:Bytecode");
        assert_eq!(b["@value"]["source"], json!([["withStrategies", { "@type": "g:ReadOnlyStrategy", "@value": {} }]]));
        let s = &b["@value"]["step"];
        assert_eq!(s[0], json!(["V"]));
        assert_eq!(
            s[1],
            json!(["has", "age", { "@type": "g:P", "@value": { "predicate": "between", "value": { "@type": "g:List", "@value": [
                { "@type": "g:Int32", "@value": 1 }, { "@type": "g:Int32", "@value": 5 }] } } }])
        );
        assert_eq!(s[2], json!(["has", "n", "Österreich"]));
        assert_eq!(s[3], json!(["limit", { "@type": "g:Int64", "@value": 3_000_000_000_i64 }]));
        assert_eq!(
            s[5],
            json!(["by", { "@type": "g:Bytecode", "@value": { "step": [["values", "x"]] } }, { "@type": "g:Order", "@value": "desc" }])
        );
        let p = parse("g.V().has('a', P.gt(1).or(P.lt(-1)))").unwrap();
        assert_eq!(
            bytecode(&p.steps)["@value"]["step"][1][2],
            json!({ "@type": "g:P", "@value": { "predicate": "or", "value": [
                { "@type": "g:P", "@value": { "predicate": "gt", "value": { "@type": "g:Int32", "@value": 1 } } },
                { "@type": "g:P", "@value": { "predicate": "lt", "value": { "@type": "g:Int32", "@value": -1 } } }] } })
        );
        let missing = bind_steps(&parse("g.V().has('a', x)").unwrap().steps, &BTreeMap::new()).unwrap_err();
        assert_eq!(missing.reason, "gremlin.variable_missing");
        assert_eq!(value_arg(&json!({ "a": 1 })), None);
        assert_eq!(value_arg(&json!([1, "a"])), Some(Arg::List(vec![Arg::Int(1), Arg::Str("a".into())])));
    }
}
