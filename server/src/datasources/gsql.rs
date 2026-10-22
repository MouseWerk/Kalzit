//! The read-only check for TigerGraph's GSQL: a tokenizer and a parser for one query, which refuse
//! everything they do not understand. Pattern matching on the text is not used.
//!
//! Accepted is exactly one query: `INTERPRET QUERY (...) FOR GRAPH g { ... }` for interpreted
//! queries, or `CREATE [OR REPLACE] [DISTRIBUTED] QUERY name(...) FOR GRAPH g ... { ... }` (the text
//! of an installed query, as TigerGraph returns it). The body is parsed statement by statement:
//! declarations (base types, accumulators, `TYPEDEF TUPLE`), assignments to variables and
//! accumulators, vertex set seeds and `SELECT` blocks, `PRINT`, `IF`, `WHILE`, `FOREACH`, `CASE`,
//! `BREAK`, `CONTINUE`, `RETURN` and function or method calls. In `SELECT`, the `ACCUM` and
//! `POST-ACCUM` clauses are parsed as statements too; the other clauses as expressions.
//!
//! Refused, also inside `ACCUM` and `POST-ACCUM`: `INSERT INTO`, `UPDATE`, `DELETE` (also
//! `DELETE (x)`), assignments to attributes (`v.age = 1`, `e.weight += 1`), file output (`PRINT ...
//! TO_CSV`, `FILE` objects and parameters), schema, user and administration statements (`CREATE`,
//! `ALTER`, `DROP`, `RUN` (loading jobs, schema changes), `INSTALL`, `GRANT`, `REVOKE`, `CLEAR`,
//! `USE`, `LOAD`, `EXPORT`, `IMPORT`), and calls of functions and methods outside the lists below:
//! that covers calls of other queries and user-defined C++ functions, which can write, and
//! `SelectVertex` (reads files) and `evaluate` (runs text as an expression). Global accumulators
//! (`@@`) and vertex accumulators (`v.@x`) live for one run and are not writes.
//!
//! The tokenizer is strict where GSQL and Kalzit could read text differently: a character outside
//! ASCII outside strings and comments, `#`, and `\"` inside a string (whether it ends the string
//! depends on the version) are refused rather than guessed.

use std::collections::HashSet;

use super::detail::Detail;

/// Built-in functions that only compute. Compared without regard to case.
const FUNCTIONS: &[&str] = &[
    "abs",
    "acos",
    "asin",
    "atan",
    "atan2",
    "avg",
    "ceil",
    "coalesce",
    "cos",
    "cosh",
    "count",
    "datetime_add",
    "datetime_diff",
    "datetime_format",
    "datetime_sub",
    "datetime_to_epoch",
    "day",
    "epoch_to_datetime",
    "exp",
    "float_to_int",
    "floor",
    "fmod",
    "getvid",
    "hour",
    "ldexp",
    "length",
    "log",
    "log10",
    "lower",
    "ltrim",
    "max",
    "min",
    "minute",
    "month",
    "now",
    "parse_json_array",
    "parse_json_object",
    "pow",
    "rand",
    "round",
    "rtrim",
    "second",
    "sin",
    "sinh",
    "sqrt",
    "str_to_int",
    "substr",
    "sum",
    "tan",
    "tanh",
    "to_datetime",
    "to_float",
    "to_int",
    "to_string",
    "to_vertex",
    "to_vertex_set",
    "trim",
    "upper",
    "year",
];

/// Methods of accumulators, containers, vertices and edges that only read or change the query's
/// own accumulators. `setAttr` and the like are not here.
const METHODS: &[&str] = &[
    "clear",
    "contains",
    "containskey",
    "edgeattribute",
    "filter",
    "get",
    "getattr",
    "getordefault",
    "insert",
    "isdirected",
    "keys",
    "neighborattribute",
    "neighbors",
    "outdegree",
    "pop",
    "remove",
    "resize",
    "size",
    "top",
    "type",
    "update",
    "values",
];

/// Words that end a query's checks wherever they appear outside strings.
const WRITES: &[&str] = &["INSERT", "UPDATE", "DELETE"];
const STATEMENTS: &[&str] = &[
    "CREATE",
    "ALTER",
    "DROP",
    "RUN",
    "INSTALL",
    "GRANT",
    "REVOKE",
    "CLEAR",
    "USE",
    "LOAD",
    "EXPORT",
    "IMPORT",
    "INTERPRET",
    "SCHEMA_CHANGE",
    "BEGIN",
    "COMMIT",
    "ABORT",
];
/// Keywords that may stand before `(` without being a function.
const EXPR_KEYWORDS: &[&str] = &[
    "AND",
    "OR",
    "NOT",
    "IN",
    "IS",
    "WHEN",
    "THEN",
    "ELSE",
    "CASE",
    "ANY",
    "ALL",
    "DISTINCT",
    "LIKE",
    "BETWEEN",
    "AS",
    "FROM",
    "WHERE",
    "HAVING",
    "BY",
    "ON",
    "ACCUM",
    "POST_ACCUM",
    "LIMIT",
    "SAMPLE",
    "UNION",
    "INTERSECT",
    "MINUS",
    "DO",
    "EXISTS",
    "RANGE",
    "TRUE",
    "FALSE",
    "NULL",
    "PER",
];
const TYPES: &[&str] = &[
    "INT",
    "UINT",
    "FLOAT",
    "DOUBLE",
    "STRING",
    "BOOL",
    "DATETIME",
    "VERTEX",
    "EDGE",
    "JSONOBJECT",
    "JSONARRAY",
    "SET",
    "BAG",
    "LIST",
    "MAP",
];
const ASSIGN: &[&str] = &["=", "+=", "-=", "*=", "/=", "%=", "|=", "&="];
const SELECT_CLAUSES: &[&str] =
    &["FROM", "SAMPLE", "WHEN", "WHERE", "ACCUM", "POST_ACCUM", "HAVING", "GROUP", "ORDER", "LIMIT", "INTO", "PER"];

#[derive(Clone, Debug, PartialEq, Eq)]
enum T {
    Ident(String),
    Num,
    Str,
    Sym(&'static str),
}

fn reject(reason: &'static str, message: impl Into<String>) -> Detail {
    Detail::new(reason, message)
}

fn parse_error(message: impl Into<String>) -> Detail {
    let m = message.into();
    reject("gsql.parse_error", format!("the query cannot be read for the check: {m}")).with("detail", m)
}

const SYMS: &[&str] = &[
    "==", "!=", "<>", "<=", ">=", "+=", "-=", "*=", "/=", "%=", "|=", "&=", "->", "@@", "..", "(", ")", "[", "]", "{",
    "}", "<", ">", "=", "+", "-", "*", "/", "%", ",", ";", ".", ":", "@", "|", "&", "^", "~", "!", "?", "'",
];

fn lex(q: &str) -> Result<Vec<T>, Detail> {
    let b = q.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        let c = b[i];
        if c.is_ascii_whitespace() {
            i += 1;
        } else if c == b'/' && b.get(i + 1) == Some(&b'/') {
            while i < b.len() && b[i] != b'\n' && b[i] != b'\r' {
                i += 1;
            }
        } else if c == b'/' && b.get(i + 1) == Some(&b'*') {
            let end =
                q[i + 2..].find("*/").ok_or_else(|| reject("gsql.unclosed_comment", "a /* comment is not closed"))?;
            i += 2 + end + 2;
        } else if c == b'"' {
            let mut j = i + 1;
            loop {
                match b.get(j) {
                    None => return Err(reject("gsql.unclosed_quote", "a string is not closed")),
                    Some(b'\\') if b.get(j + 1) == Some(&b'"') => {
                        return Err(reject(
                            "gsql.string_escape",
                            "write \\\" inside a string differently; whether it ends the string depends on the version",
                        ));
                    }
                    Some(b'\\') => j += 2,
                    Some(b'"') => break,
                    Some(_) => j += 1,
                }
            }
            out.push(T::Str);
            i = j + 1;
        } else if c.is_ascii_alphabetic() || c == b'_' {
            let mut j = i;
            while j < b.len() && (b[j].is_ascii_alphanumeric() || b[j] == b'_') {
                j += 1;
            }
            out.push(T::Ident(q[i..j].to_string()));
            i = j;
        } else if c.is_ascii_digit() {
            let mut j = i;
            while j < b.len() && (b[j].is_ascii_alphanumeric() || b[j] == b'_') {
                j += 1;
            }
            if b.get(j) == Some(&b'.') && b.get(j + 1).is_some_and(u8::is_ascii_digit) {
                j += 1;
                while j < b.len() && (b[j].is_ascii_alphanumeric() || b[j] == b'_') {
                    j += 1;
                }
            }
            out.push(T::Num);
            i = j;
        } else if c == b'\'' && !matches!(out.as_slice(), [.., T::Sym("@" | "@@"), T::Ident(_)]) {
            // `@@acc'` (the value before this iteration) is the only use; anywhere else a quote
            // could start text that Kalzit and TigerGraph read differently.
            return Err(reject(
                "gsql.unexpected_character",
                "a quote ' is allowed only after an accumulator, as in @@total'",
            )
            .with("character", '\''));
        } else if let Some(sym) = SYMS.iter().find(|s| q[i..].starts_with(**s)) {
            out.push(T::Sym(sym));
            i += sym.len();
        } else {
            let ch = q[i..].chars().next().expect("i is on a char boundary");
            return Err(reject("gsql.unexpected_character", format!("the character {ch:?} is not allowed here"))
                .with("character", ch));
        }
    }
    // `POST-ACCUM` is one clause keyword.
    let mut merged: Vec<T> = Vec::with_capacity(out.len());
    for t in out {
        if matches!(&t, T::Ident(s) if s.eq_ignore_ascii_case("accum")) {
            let n = merged.len();
            if n >= 2
                && merged[n - 1] == T::Sym("-")
                && matches!(&merged[n - 2], T::Ident(s) if s.eq_ignore_ascii_case("post"))
            {
                merged.truncate(n - 2);
                merged.push(T::Ident("POST_ACCUM".into()));
                continue;
            }
        }
        merged.push(t);
    }
    Ok(merged)
}

/// A query parameter's type, for typed REST++ parameters.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ParamType {
    Int,
    Uint,
    Float,
    Bool,
    String,
    Datetime,
    /// `VERTEX<Type>` (the type known) or `VERTEX` (the type sent with the id).
    Vertex(Option<String>),
    /// `SET<...>`, `BAG<...>`, `LIST<...>`: repeated values.
    Many(Box<ParamType>),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Param {
    pub name: String,
    pub ty: ParamType,
}

/// What the check learned about a query that passed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Checked {
    /// The query's name (installed queries; interpreted ones may have none).
    pub name: Option<String>,
    pub graph: Option<String>,
    pub params: Vec<Param>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Form {
    /// `INTERPRET QUERY`, what Kalzit sends to the interpret endpoint.
    Interpret,
    /// `CREATE QUERY`, the text of an installed query.
    Installed,
}

struct P {
    t: Vec<T>,
    i: usize,
    typedefs: HashSet<String>,
    /// Names a `TYPEDEF` may not take (upper case): built-ins, this query and other queries.
    reserved: HashSet<String>,
}

fn upper(t: &T) -> Option<String> {
    match t {
        T::Ident(s) => Some(s.to_ascii_uppercase()),
        _ => None,
    }
}

fn upper_eq(t: &T, upper: &str) -> bool {
    matches!(t, T::Ident(s) if s.eq_ignore_ascii_case(upper))
}

fn is_kw(t: Option<&T>, kw: &str) -> bool {
    matches!(t, Some(T::Ident(s)) if s.eq_ignore_ascii_case(kw))
}

/// Checks a GSQL query (see the module documentation).
pub fn check(q: &str, form: Form) -> Result<Checked, Detail> {
    check_with(q, form, &[])
}

/// `check`, where `queries` are the names of the graph's other queries, which a `TYPEDEF` may not
/// take (a tuple called like a query would otherwise make the call look like a constructor).
pub fn check_with(q: &str, form: Form, queries: &[String]) -> Result<Checked, Detail> {
    let t = lex(q)?;
    if t.is_empty() {
        return Err(reject("gsql.empty", "the query is empty"));
    }
    let mut reserved: HashSet<String> = FUNCTIONS.iter().chain(METHODS).map(|f| f.to_ascii_uppercase()).collect();
    reserved.extend(TYPES.iter().chain(EXPR_KEYWORDS).chain(STATEMENTS).chain(WRITES).map(|s| s.to_string()));
    reserved.extend(queries.iter().map(|q| q.to_ascii_uppercase()));
    let mut p = P { t, i: 0, typedefs: HashSet::new(), reserved };
    let checked = p.header(form)?;
    if let Some(name) = &checked.name {
        p.reserved.insert(name.to_ascii_uppercase());
    }
    p.expect_sym("{")?;
    p.block(false, &[])?;
    p.expect_sym("}")?;
    while p.peek() == Some(&T::Sym(";")) {
        p.i += 1;
    }
    if p.i != p.t.len() {
        return Err(reject("gsql.not_one_query", "exactly one query is allowed; there is more after its body"));
    }
    Ok(checked)
}

impl P {
    fn peek(&self) -> Option<&T> {
        self.t.get(self.i)
    }

    fn next(&mut self) -> Option<T> {
        let t = self.t.get(self.i).cloned();
        self.i += 1;
        t
    }

    fn expect_sym(&mut self, s: &'static str) -> Result<(), Detail> {
        match self.next() {
            Some(T::Sym(x)) if x == s => Ok(()),
            _ => Err(parse_error(format!("expected {s}"))),
        }
    }

    fn expect_kw(&mut self, kw: &str) -> Result<(), Detail> {
        if is_kw(self.peek(), kw) {
            self.i += 1;
            Ok(())
        } else {
            Err(parse_error(format!("expected {kw}")))
        }
    }

    fn ident(&mut self) -> Result<String, Detail> {
        match self.next() {
            Some(T::Ident(s)) => Ok(s),
            _ => Err(parse_error("expected a name")),
        }
    }

    fn header(&mut self, form: Form) -> Result<Checked, Detail> {
        let mut name = None;
        match form {
            Form::Interpret => {
                if !is_kw(self.peek(), "INTERPRET") {
                    return Err(reject(
                        "gsql.not_one_query",
                        "an interpreted query starts with INTERPRET QUERY (...) FOR GRAPH ...",
                    ));
                }
                self.i += 1;
                self.expect_kw("QUERY")?;
                if let Some(T::Ident(n)) = self.peek().cloned() {
                    name = Some(n);
                    self.i += 1;
                }
            }
            Form::Installed => {
                self.expect_kw("CREATE")?;
                if is_kw(self.peek(), "OR") {
                    self.i += 1;
                    self.expect_kw("REPLACE")?;
                }
                if is_kw(self.peek(), "DISTRIBUTED") {
                    self.i += 1;
                }
                self.expect_kw("QUERY")?;
                name = Some(self.ident()?);
            }
        }
        self.expect_sym("(")?;
        let params = self.params()?;
        let mut graph = None;
        if is_kw(self.peek(), "FOR") {
            self.i += 1;
            self.expect_kw("GRAPH")?;
            graph = Some(self.ident()?);
        }
        if graph.is_none() && form == Form::Interpret {
            return Err(reject(
                "gsql.graph_missing",
                "an interpreted query names its graph: INTERPRET QUERY (...) FOR GRAPH name { ... }",
            ));
        }
        if is_kw(self.peek(), "RETURNS") {
            self.i += 1;
            self.expect_sym("(")?;
            self.skip_balanced_until(")")?;
        }
        if is_kw(self.peek(), "API") {
            self.i += 1;
            self.expect_sym("(")?;
            if self.next() != Some(T::Str) {
                return Err(parse_error("API takes a string"));
            }
            self.expect_sym(")")?;
        }
        if is_kw(self.peek(), "SYNTAX") {
            self.i += 1;
            self.ident()?;
        }
        Ok(Checked { name, graph, params })
    }

    /// Skips to the matching closing symbol (the opening one was consumed).
    fn skip_balanced_until(&mut self, close: &'static str) -> Result<(), Detail> {
        let mut depth = 0usize;
        loop {
            match self.next() {
                None => return Err(parse_error(format!("expected {close}"))),
                Some(T::Sym("(" | "[" | "{" | "<")) => depth += 1,
                Some(T::Sym(s)) if s == close && depth == 0 => return Ok(()),
                Some(T::Sym(")" | "]" | "}" | ">")) => depth = depth.saturating_sub(1),
                Some(T::Ident(s)) if s.eq_ignore_ascii_case("FILE") => {
                    return Err(reject("gsql.file_output", "FILE objects write files and are not allowed"));
                }
                Some(_) => {}
            }
        }
    }

    fn param_type(&mut self) -> Result<ParamType, Detail> {
        let name = self.ident()?.to_ascii_uppercase();
        Ok(match name.as_str() {
            "INT" => ParamType::Int,
            "UINT" => ParamType::Uint,
            "FLOAT" | "DOUBLE" => ParamType::Float,
            "BOOL" => ParamType::Bool,
            "STRING" => ParamType::String,
            "DATETIME" => ParamType::Datetime,
            "VERTEX" => {
                if self.peek() == Some(&T::Sym("<")) {
                    self.i += 1;
                    let ty = self.ident()?;
                    self.expect_sym(">")?;
                    ParamType::Vertex(Some(ty))
                } else {
                    ParamType::Vertex(None)
                }
            }
            "SET" | "BAG" | "LIST" => {
                self.expect_sym("<")?;
                let inner = self.param_type()?;
                self.expect_sym(">")?;
                ParamType::Many(Box::new(inner))
            }
            "FILE" => return Err(reject("gsql.file_output", "FILE parameters write files and are not allowed")),
            other => return Err(parse_error(format!("{other} is not a parameter type Kalzit knows"))),
        })
    }

    fn params(&mut self) -> Result<Vec<Param>, Detail> {
        let mut out = Vec::new();
        if self.peek() == Some(&T::Sym(")")) {
            self.i += 1;
            return Ok(out);
        }
        loop {
            let ty = self.param_type()?;
            let name = self.ident()?;
            if self.peek() == Some(&T::Sym("=")) {
                self.i += 1;
                match self.next() {
                    Some(T::Num | T::Str) => {}
                    Some(T::Sym("-")) if self.next() == Some(T::Num) => {}
                    Some(T::Ident(s)) if ["TRUE", "FALSE", "NULL"].contains(&s.to_ascii_uppercase().as_str()) => {}
                    _ => return Err(parse_error("a parameter default must be a literal")),
                }
            }
            out.push(Param { name, ty });
            match self.next() {
                Some(T::Sym(",")) => continue,
                Some(T::Sym(")")) => return Ok(out),
                _ => return Err(parse_error("expected , or ) in the parameters")),
            }
        }
    }

    /// The tokens from here to the end of a statement: a separator (`;`, and `,` in `ACCUM`) or a
    /// stop keyword, outside brackets and outside `IF`/`CASE`/`WHILE`/`FOREACH` ... `END`.
    fn region(&mut self, accum: bool, stops: &[&str]) -> Vec<T> {
        let start = self.i;
        let (mut depth, mut blocks) = (0usize, 0usize);
        while let Some(t) = self.t.get(self.i) {
            let top = depth == 0 && blocks == 0;
            match t {
                T::Sym(";") if top => break,
                T::Sym(",") if top && accum => break,
                T::Sym("(" | "[" | "{") => depth += 1,
                T::Sym(")" | "]" | "}") => {
                    if depth == 0 {
                        break;
                    }
                    depth -= 1;
                }
                T::Ident(s) => {
                    let u = s.to_ascii_uppercase();
                    if top && stops.contains(&u.as_str()) {
                        break;
                    }
                    let after_else = self.i > 0 && is_kw(self.t.get(self.i - 1), "ELSE");
                    match u.as_str() {
                        "CASE" | "WHILE" | "FOREACH" => blocks += 1,
                        "IF" if !after_else => blocks += 1,
                        "END" => blocks = blocks.saturating_sub(1),
                        _ => {}
                    }
                }
                _ => {}
            }
            self.i += 1;
        }
        self.t[start..self.i].to_vec()
    }

    /// Statements up to a stop keyword or `}`.
    fn block(&mut self, accum: bool, stops: &[&str]) -> Result<(), Detail> {
        loop {
            match self.peek() {
                None => return Ok(()),
                Some(T::Sym(";")) => self.i += 1,
                Some(T::Sym(",")) if accum => self.i += 1,
                Some(T::Sym("}")) => return Ok(()),
                Some(t) if upper(t).is_some_and(|u| stops.contains(&u.as_str())) => return Ok(()),
                Some(_) => self.statement(accum, stops)?,
            }
        }
    }

    fn statement(&mut self, accum: bool, stops: &[&str]) -> Result<(), Detail> {
        let first = upper(self.peek().expect("block checked for a token")).unwrap_or_default();
        match first.as_str() {
            w if WRITES.contains(&w) => {
                Err(reject("gsql.write", format!("{w} changes data; Kalzit only reads")).with("statement", w))
            }
            s if STATEMENTS.contains(&s) => Err(reject(
                "gsql.statement_not_allowed",
                format!("{s} statements are not allowed in a query Kalzit runs"),
            )
            .with("statement", s)),
            "IF" => {
                self.i += 1;
                loop {
                    let cond = self.region(accum, &["THEN"]);
                    self.expr(&cond, false)?;
                    self.expect_kw("THEN")?;
                    self.block(accum, &["ELSE", "END"])?;
                    if is_kw(self.peek(), "ELSE") {
                        self.i += 1;
                        if is_kw(self.peek(), "IF") {
                            self.i += 1;
                            continue;
                        }
                        self.block(accum, &["END"])?;
                    }
                    return self.expect_kw("END");
                }
            }
            "WHILE" => {
                self.i += 1;
                let cond = self.region(accum, &["DO", "LIMIT"]);
                self.expr(&cond, false)?;
                if is_kw(self.peek(), "LIMIT") {
                    self.i += 1;
                    let limit = self.region(accum, &["DO"]);
                    self.expr(&limit, false)?;
                }
                self.expect_kw("DO")?;
                self.block(accum, &["END"])?;
                self.expect_kw("END")
            }
            "FOREACH" => {
                self.i += 1;
                let head = self.region(accum, &["DO"]);
                self.expr(&head, false)?;
                self.expect_kw("DO")?;
                self.block(accum, &["END"])?;
                self.expect_kw("END")
            }
            "CASE" => {
                self.i += 1;
                if !is_kw(self.peek(), "WHEN") {
                    let subject = self.region(accum, &["WHEN"]);
                    self.expr(&subject, false)?;
                }
                while is_kw(self.peek(), "WHEN") {
                    self.i += 1;
                    let cond = self.region(accum, &["THEN"]);
                    self.expr(&cond, false)?;
                    self.expect_kw("THEN")?;
                    self.block(accum, &["WHEN", "ELSE", "END"])?;
                }
                if is_kw(self.peek(), "ELSE") {
                    self.i += 1;
                    self.block(accum, &["END"])?;
                }
                self.expect_kw("END")
            }
            "BREAK" | "CONTINUE" => {
                self.i += 1;
                Ok(())
            }
            "PRINT" | "RETURN" | "LOG" if !accum || first == "LOG" => {
                self.i += 1;
                let rest = self.region(accum, stops);
                self.expr(&rest, false)
            }
            "TYPEDEF" => {
                let start = self.i;
                let rest = self.region(accum, stops);
                if let Some(T::Ident(name)) = rest.last() {
                    let upper = name.to_ascii_uppercase();
                    // A tuple named like a function or query, or like a name already used, would
                    // make a call of it look like a constructor.
                    let used_before = self.t[..start].iter().any(|t| upper_eq(t, &upper));
                    if self.reserved.contains(&upper) || used_before {
                        return Err(reject(
                            "gsql.typedef_name",
                            format!(
                                "{name} cannot be a tuple name: it names a function, a query or something used before"
                            ),
                        )
                        .with("name", name));
                    }
                    self.typedefs.insert(upper);
                }
                self.expr(&rest[1..], false)
            }
            "SELECT" if !accum => {
                let rest = self.region(accum, stops);
                self.select(&rest)
            }
            t if TYPES.contains(&t) || t.ends_with("ACCUM") || self.typedefs.contains(t) => {
                let rest = self.region(accum, stops);
                self.expr(&rest[1..], true)
            }
            _ => {
                let rest = self.region(accum, stops);
                self.assignment_or_call(&rest)
            }
        }
    }

    fn assignment_or_call(&mut self, toks: &[T]) -> Result<(), Detail> {
        let mut depth = 0usize;
        let mut at = None;
        for (j, t) in toks.iter().enumerate() {
            match t {
                T::Sym("(" | "[" | "{") => depth += 1,
                T::Sym(")" | "]" | "}") => depth = depth.saturating_sub(1),
                T::Sym(s) if depth == 0 && ASSIGN.contains(s) => {
                    at = Some(j);
                    break;
                }
                _ => {}
            }
        }
        let Some(at) = at else {
            // Without an assignment, a statement must be a call: `@@list.clear()`, `log(...)`.
            let is_call = toks.last() == Some(&T::Sym(")")) && toks.contains(&T::Sym("("));
            if !is_call {
                return Err(parse_error("expected an assignment, a declaration or a call"));
            }
            return self.expr(toks, false);
        };
        let (lhs, rhs) = (&toks[..at], &toks[at + 1..]);
        if lhs.is_empty() || rhs.is_empty() {
            return Err(parse_error("an assignment needs a target and a value"));
        }
        // `x.attr = ...` writes an attribute; `x.@acc` and `@@acc` are the query's own.
        if lhs.windows(2).any(|w| w[0] == T::Sym(".") && matches!(w[1], T::Ident(_))) {
            let target = lhs
                .iter()
                .map(|t| match t {
                    T::Ident(s) => s.clone(),
                    T::Sym(s) => s.to_string(),
                    _ => String::new(),
                })
                .collect::<String>();
            return Err(reject(
                "gsql.attribute_assignment",
                format!("{target} assigns an attribute, which changes data; Kalzit only reads"),
            )
            .with("target", target));
        }
        self.expr(lhs, false)?;
        if is_kw(rhs.first(), "SELECT") { self.select(rhs) } else { self.expr(rhs, false) }
    }

    /// A `SELECT` block: clauses split at their keywords; `ACCUM` and `POST-ACCUM` hold statements.
    fn select(&mut self, toks: &[T]) -> Result<(), Detail> {
        let (mut depth, mut blocks) = (0usize, 0usize);
        let mut parts: Vec<(String, Vec<T>)> = vec![("SELECT".into(), Vec::new())];
        for (j, t) in toks.iter().enumerate().skip(1) {
            if let T::Sym(s) = t {
                match *s {
                    "(" | "[" | "{" => depth += 1,
                    ")" | "]" | "}" => depth = depth.saturating_sub(1),
                    _ => {}
                }
            }
            if let Some(u) = upper(t) {
                let after_else = is_kw(toks.get(j.wrapping_sub(1)), "ELSE");
                match u.as_str() {
                    "CASE" | "WHILE" | "FOREACH" => blocks += 1,
                    "IF" if !after_else => blocks += 1,
                    "END" => blocks = blocks.saturating_sub(1),
                    _ => {}
                }
                if depth == 0 && blocks == 0 && SELECT_CLAUSES.contains(&u.as_str()) {
                    parts.push((u, Vec::new()));
                    continue;
                }
            }
            parts.last_mut().expect("one part at least").1.push(t.clone());
        }
        if !parts.iter().any(|(c, _)| c == "FROM") {
            return Err(parse_error("SELECT needs FROM"));
        }
        for (clause, body) in parts {
            if clause == "ACCUM" || clause == "POST_ACCUM" {
                let mut inner = P { t: body, i: 0, typedefs: self.typedefs.clone(), reserved: self.reserved.clone() };
                inner.block(true, &[])?;
                if inner.i != inner.t.len() {
                    return Err(parse_error(format!("unexpected text in {clause}")));
                }
            } else {
                self.expr(&body, false)?;
            }
        }
        Ok(())
    }

    /// An expression (or a declaration's names and initial values when `declaration`): balanced
    /// brackets, no writing or administration words, no assignments, and calls only of known
    /// functions and methods.
    fn expr(&self, toks: &[T], declaration: bool) -> Result<(), Detail> {
        let mut depth: Vec<&str> = Vec::new();
        for (j, t) in toks.iter().enumerate() {
            let prev = j.checked_sub(1).and_then(|p| toks.get(p));
            let next = toks.get(j + 1);
            match t {
                T::Sym(s @ ("(" | "[" | "{")) => depth.push(match *s {
                    "(" => ")",
                    "[" => "]",
                    _ => "}",
                }),
                T::Sym(s @ (")" | "]" | "}")) => {
                    if depth.pop() != Some(*s) {
                        return Err(parse_error("brackets do not match"));
                    }
                }
                T::Sym(s) if ASSIGN.contains(s) && !declaration => {
                    return Err(parse_error("an assignment where a value belongs (compare with ==)"));
                }
                T::Sym(s)
                    if ASSIGN.contains(s)
                        && j >= 2
                        && toks[j - 2] == T::Sym(".")
                        && matches!(toks[j - 1], T::Ident(_)) =>
                {
                    return Err(reject(
                        "gsql.attribute_assignment",
                        "assigning an attribute changes data; Kalzit only reads",
                    )
                    .with("target", "attribute"));
                }
                T::Sym(";") => return Err(parse_error("a ; inside an expression")),
                T::Ident(name) => {
                    let u = name.to_ascii_uppercase();
                    let after_dot = prev == Some(&T::Sym("."));
                    let call = next == Some(&T::Sym("("));
                    if after_dot {
                        if call && !METHODS.iter().any(|m| m.eq_ignore_ascii_case(name)) {
                            return Err(reject("gsql.method_not_allowed", format!("the method {name} is not allowed"))
                                .with("name", name));
                        }
                        continue;
                    }
                    if WRITES.contains(&u.as_str()) {
                        return Err(
                            reject("gsql.write", format!("{u} changes data; Kalzit only reads")).with("statement", &u)
                        );
                    }
                    if u == "TO_CSV" || u == "FILE" {
                        return Err(reject("gsql.file_output", "writing files (TO_CSV, FILE) is not allowed"));
                    }
                    if STATEMENTS.contains(&u.as_str()) || u == "SELECT" || u == "PRINT" {
                        return Err(reject("gsql.statement_not_allowed", format!("{u} is not allowed here"))
                            .with("statement", &u));
                    }
                    let allowed = EXPR_KEYWORDS.contains(&u.as_str())
                        || FUNCTIONS.iter().any(|f| f.eq_ignore_ascii_case(name))
                        || self.typedefs.contains(&u)
                        || TYPES.contains(&u.as_str());
                    if call && !allowed {
                        return Err(reject(
                            "gsql.function_not_allowed",
                            format!("{name} is not a built-in function Kalzit allows (calls of other queries and user functions are refused)"),
                        )
                        .with("name", name));
                    }
                }
                _ => {}
            }
        }
        if !depth.is_empty() {
            return Err(parse_error("a bracket is not closed"));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok(body: &str) -> Checked {
        let q = format!("INTERPRET QUERY (STRING name, INT k = 3) FOR GRAPH social {{ {body} }}");
        check(&q, Form::Interpret).unwrap_or_else(|e| panic!("refused: {body}: {e:?}"))
    }

    fn refused(body: &str) -> &'static str {
        let q = format!("INTERPRET QUERY () FOR GRAPH social {{ {body} }}");
        match check(&q, Form::Interpret) {
            Ok(_) => panic!("accepted: {body}"),
            Err(d) => d.reason,
        }
    }

    #[test]
    fn reading_queries_pass_and_report_their_parameters() {
        let c = ok(r#"
            TYPEDEF TUPLE <STRING n, INT c> Row;
            SumAccum<INT> @@total = 0;
            SetAccum<EDGE> @@edges;
            MapAccum<STRING, SumAccum<INT>> @@perCity;
            HeapAccum<Row>(10, c DESC) @@top;
            OrAccum @visited;
            INT x = 1;
            // a comment with DELETE in it
            Start = {Person.*};
            /* INSERT INTO nothing */
            Friends = SELECT t FROM Start:s -(Friend>:e)- Person:t
                WHERE s.name == name AND t.age > k
                ACCUM @@total += 1, @@edges += e, t.@visited = TRUE,
                      IF e.weight > 2 THEN @@perCity += (t.city -> 1) ELSE @@total += 0 END
                POST-ACCUM @@top += Row(t.name, t.outdegree())
                ORDER BY t.age DESC
                LIMIT 10;
            WHILE x < 3 LIMIT 5 DO x = x + 1; END;
            FOREACH v IN @@edges DO @@total += 1; END;
            IF @@total > 0 THEN PRINT "many"; ELSE IF @@total == 0 THEN PRINT "none"; ELSE PRINT "x"; END;
            CASE WHEN x == 1 THEN PRINT x; ELSE PRINT 0; END;
            INT vorher = @@total';
            @@edges.clear();
            log(TRUE, @@total);
            PRINT Friends[Friends.name, Friends.@visited AS v], @@edges, @@total, to_string(now()) AS t;
        "#);
        assert_eq!(c.graph.as_deref(), Some("social"));
        assert_eq!(
            c.params,
            [Param { name: "name".into(), ty: ParamType::String }, Param { name: "k".into(), ty: ParamType::Int }]
        );
        let installed = check(
            "CREATE OR REPLACE DISTRIBUTED QUERY nachbarn(VERTEX<Person> p, SET<STRING> tags, VERTEX any, DOUBLE w = -1.5) \
             FOR GRAPH social RETURNS (INT) API(\"v2\") SYNTAX v2 { S = {p}; PRINT S; RETURN 1; }",
            Form::Installed,
        )
        .unwrap();
        assert_eq!(installed.name.as_deref(), Some("nachbarn"));
        assert_eq!(installed.params[0].ty, ParamType::Vertex(Some("Person".into())));
        assert_eq!(installed.params[1].ty, ParamType::Many(Box::new(ParamType::String)));
        assert_eq!(installed.params[2].ty, ParamType::Vertex(None));
        assert_eq!(installed.params[3].ty, ParamType::Float);
    }

    #[test]
    fn writes_and_everything_unreadable_are_refused() {
        for (body, reason) in [
            ("INSERT INTO Person VALUES (\"x\", 1);", "gsql.write"),
            ("insert into Person values (\"x\", 1);", "gsql.write"),
            ("UPDATE s FROM Person:s SET s.age = 1;", "gsql.write"),
            ("DELETE s FROM Person:s;", "gsql.write"),
            ("S = {Person.*}; R = SELECT s FROM S:s ACCUM DELETE (s);", "gsql.write"),
            ("S = {Person.*}; R = SELECT s FROM S:s ACCUM INSERT INTO Person VALUES (\"y\", 2);", "gsql.write"),
            ("S = {Person.*}; R = SELECT s FROM S:s POST-ACCUM s.age = 1;", "gsql.attribute_assignment"),
            (
                "S = {Person.*}; R = SELECT s FROM S:s -(Friend:e)- Person:t ACCUM e.weight += 1;",
                "gsql.attribute_assignment",
            ),
            ("S = {Person.*}; R = SELECT s FROM S:s ACCUM IF TRUE THEN s.age = 1 END;", "gsql.attribute_assignment"),
            (
                "S = {Person.*}; R = SELECT s FROM S:s ACCUM FOREACH x IN s.tags DO s.n = x END;",
                "gsql.attribute_assignment",
            ),
            ("S = {Person.*}; R = SELECT s FROM S:s POST_ACCUM s.setAttr(\"age\", 1);", "gsql.method_not_allowed"),
            ("S = {Person.*}; PRINT S TO_CSV \"/tmp/x\";", "gsql.file_output"),
            ("FILE f (\"/tmp/x\"); f.println(1);", "gsql.file_output"),
            ("x = otherQuery(1);", "gsql.function_not_allowed"),
            ("otherQuery(1);", "gsql.function_not_allowed"),
            ("S = SelectVertex(\"/etc/passwd\", \"a\", Person, \",\", false);", "gsql.function_not_allowed"),
            ("INT x = 1, s.age = 5;", "gsql.attribute_assignment"),
            ("PRINT evaluate(\"1+1\", \"int\");", "gsql.function_not_allowed"),
            ("RUN LOADING JOB load_people;", "gsql.statement_not_allowed"),
            ("CREATE VERTEX X (PRIMARY_ID id STRING);", "gsql.statement_not_allowed"),
            ("DROP ALL;", "gsql.statement_not_allowed"),
            ("CLEAR GRAPH STORE -HARD;", "gsql.statement_not_allowed"),
            ("GRANT ROLE superuser TO kalzit;", "gsql.statement_not_allowed"),
            ("USE GRAPH other;", "gsql.statement_not_allowed"),
            ("INSTALL QUERY ALL;", "gsql.statement_not_allowed"),
            ("PRINT 1; RUN SCHEMA_CHANGE JOB x;", "gsql.statement_not_allowed"),
            ("x = 1 y = 2;", "gsql.parse_error"),
            ("PRINT (1;", "gsql.parse_error"),
            ("hello world;", "gsql.parse_error"),
            ("IF TRUE THEN PRINT 1;", "gsql.parse_error"),
            ("S = SELECT s;", "gsql.parse_error"),
            ("PRINT x WHERE x = 1;", "gsql.parse_error"),
            ("PRINT \"a\\\" DELETE \";", "gsql.string_escape"),
            ("PRINT \"offen;", "gsql.unclosed_quote"),
            ("PRINT 1; /* offen", "gsql.unclosed_comment"),
            ("PRINT 1; # Kommentar?", "gsql.unexpected_character"),
            ("PRINT 1;\u{00A0}", "gsql.unexpected_character"),
            ("PRINT ünïcödé;", "gsql.unexpected_character"),
            ("PRINT '\"' ; DELETE s FROM Person:s; '\"';", "gsql.unexpected_character"),
            ("PRINT 1'; DELETE s FROM Person:s;", "gsql.unexpected_character"),
            ("TYPEDEF TUPLE <INT a> count; PRINT count(1);", "gsql.typedef_name"),
            ("TYPEDEF TUPLE <INT a> To_String; PRINT 1;", "gsql.typedef_name"),
            ("INT foo = 1; TYPEDEF TUPLE <INT a> foo; PRINT foo(1);", "gsql.typedef_name"),
        ] {
            assert_eq!(refused(body), reason, "{body}");
        }
    }

    fn installed_check(s: &str) -> Result<(), &'static str> {
        check(s, Form::Installed).map(|_| ()).map_err(|d| d.reason)
    }

    #[test]
    fn exactly_one_query() {
        let q = |s: &str| check(s, Form::Interpret).map(|_| ()).map_err(|d| d.reason);
        assert_eq!(q(""), Err("gsql.empty"));
        assert_eq!(q("// nur Kommentar"), Err("gsql.empty"));
        assert_eq!(q("SELECT s FROM Person:s"), Err("gsql.not_one_query"));
        assert_eq!(
            q("INTERPRET QUERY () FOR GRAPH g { PRINT 1; } INTERPRET QUERY () { PRINT 2; }"),
            Err("gsql.not_one_query")
        );
        assert_eq!(q("INTERPRET QUERY () FOR GRAPH g { PRINT 1; }; DROP ALL"), Err("gsql.not_one_query"));
        assert_eq!(q("INTERPRET QUERY () FOR GRAPH g { PRINT 1; };"), Ok(()));
        assert_eq!(q("INTERPRET QUERY () { PRINT 1; }"), Err("gsql.graph_missing"));
        let other =
            |s: &str| check_with(s, Form::Interpret, &["andereAbfrage".to_string()]).map(|_| ()).map_err(|d| d.reason);
        assert_eq!(
            other("INTERPRET QUERY () FOR GRAPH g { TYPEDEF TUPLE <INT a> ANDEREABFRAGE; PRINT andereAbfrage(1); }"),
            Err("gsql.typedef_name")
        );
        assert_eq!(other("INTERPRET QUERY () FOR GRAPH g { TYPEDEF TUPLE <INT a> Zeile; PRINT Zeile(1); }"), Ok(()));
        assert_eq!(
            installed_check("CREATE QUERY selbst() FOR GRAPH g { TYPEDEF TUPLE <INT a> selbst; PRINT 1; }"),
            Err("gsql.typedef_name")
        );
        assert_eq!(q("INTERPRET QUERY (FILE f) FOR GRAPH g { PRINT 1; }"), Err("gsql.file_output"));
        assert_eq!(q("INTERPRET OPENCYPHER QUERY () { MATCH (n) RETURN n }"), Err("gsql.parse_error"));
        assert_eq!(q("CREATE QUERY x() FOR GRAPH g { PRINT 1; }"), Err("gsql.not_one_query"));
        let installed = |s: &str| check(s, Form::Installed).map(|_| ()).map_err(|d| d.reason);
        assert_eq!(installed("INTERPRET QUERY () FOR GRAPH g { PRINT 1; }"), Err("gsql.parse_error"));
        assert_eq!(installed("CREATE QUERY x() FOR GRAPH g { DELETE s FROM Person:s; }"), Err("gsql.write"));
    }
}
