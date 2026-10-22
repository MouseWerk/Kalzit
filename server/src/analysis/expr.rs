//! The expression language of calculated fields: a small, safe language over the fields of one
//! frame. It is parsed into a tree and type-checked against the frame's fields before a single
//! row is computed; nothing is ever evaluated as code. The UI has the same language in
//! `ui/src/analysis/expr.ts`; both run the cases of `conformance.json` (docs/api/settings-dashboards.md, "Analysis steps").
//!
//! - Values: numbers, text, booleans, times (Unix ms) and the empty value `null`.
//! - Fields: a bare name (`betrag`, `A.umsatz`) or any name in brackets (`[Umsatz (€)]`, `]]` for
//!   a `]` inside).
//! - Operators by precedence: `or`/`||`, `and`/`&&`, `not`/`!`, comparisons (`= == != <> < <= >
//!   >=`, not chained), `+ -`, `* / %`, unary `-`, `^` (right-associative).
//! - Empty values propagate (`null + 1` is `null`); `and`/`or` follow three-valued logic;
//!   division by zero and results that are not finite are empty, never an error.
//! - All calendar functions work in UTC.

use serde_json::Value;

use crate::datasources::detail::Detail;
use crate::shapes::{Field, FieldType};

/// Longest expression, in characters.
pub const MAX_CHARS: usize = 2000;
/// Deepest nesting of parentheses, operators and calls while parsing.
pub const MAX_DEPTH: usize = 64;
/// Highest tree an expression may build (chains inside parentheses grow it past `MAX_DEPTH`).
pub const MAX_HEIGHT: usize = 128;
/// Most arguments of one call.
const MAX_ARGS: usize = 100;

/// Times outside the years 1 to 9999 have no ISO form; a calculation that leaves them is empty.
pub const MIN_TIME_MS: f64 = -62_135_596_800_000.0;
pub const MAX_TIME_MS: f64 = 253_402_300_799_999.0;
pub const DAY_MS: f64 = 86_400_000.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Type {
    Number,
    Text,
    Bool,
    Time,
    /// The literal `null`, before it meets a typed value.
    Null,
}

impl Type {
    pub fn name(self) -> &'static str {
        match self {
            Type::Number => "number",
            Type::Text => "text",
            Type::Bool => "bool",
            Type::Time => "time",
            Type::Null => "null",
        }
    }

    pub fn field_type(self) -> FieldType {
        match self {
            Type::Number | Type::Null => FieldType::Number,
            Type::Text => FieldType::String,
            Type::Bool => FieldType::Bool,
            Type::Time => FieldType::Time,
        }
    }
}

fn error(reason: &'static str, message: String) -> Detail {
    Detail::new(reason, message)
}

// ---- tokens ----

#[derive(Clone, Debug, PartialEq)]
enum Tok {
    Num(f64),
    Str(String),
    Field(String),
    Ident(String),
    Op(&'static str),
    End,
}

#[derive(Clone, Debug)]
struct Token {
    tok: Tok,
    /// 1-based character position, as people count.
    at: usize,
}

const OPERATORS: &[&str] =
    &["==", "!=", "<>", "<=", ">=", "&&", "||", "+", "-", "*", "/", "%", "^", "(", ")", ",", "=", "<", ">", "!"];

fn is_ident_start(c: char) -> bool {
    c.is_alphabetic() || c == '_'
}

fn is_ident_char(c: char) -> bool {
    c.is_alphabetic() || c.is_ascii_digit() || c == '_' || c == '.'
}

fn lex(chars: &[char]) -> Result<Vec<Token>, Detail> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        let at = i + 1;
        if c.is_whitespace() {
            i += 1;
            continue;
        }
        if c.is_ascii_digit() {
            let start = i;
            while i < chars.len() && chars[i].is_ascii_digit() {
                i += 1;
            }
            if i < chars.len() && chars[i] == '.' {
                i += 1;
                let digits = i;
                while i < chars.len() && chars[i].is_ascii_digit() {
                    i += 1;
                }
                if i == digits {
                    return Err(syntax(i + 1));
                }
            }
            if i < chars.len() && (chars[i] == 'e' || chars[i] == 'E') {
                let mut j = i + 1;
                if j < chars.len() && (chars[j] == '+' || chars[j] == '-') {
                    j += 1;
                }
                let digits = j;
                while j < chars.len() && chars[j].is_ascii_digit() {
                    j += 1;
                }
                if j == digits {
                    return Err(syntax(j + 1));
                }
                i = j;
            }
            if i < chars.len() && is_ident_char(chars[i]) {
                return Err(syntax(i + 1));
            }
            let text: String = chars[start..i].iter().collect();
            let value: f64 = text.parse().map_err(|_| syntax(at))?;
            if !value.is_finite() {
                return Err(error("expression.number", format!("the number at {at} is too large")).with("at", at));
            }
            out.push(Token { tok: Tok::Num(value), at });
            continue;
        }
        if c == '"' || c == '\'' {
            let mut text = String::new();
            i += 1;
            loop {
                let Some(&d) = chars.get(i) else {
                    return Err(unclosed(at));
                };
                i += 1;
                if d == c {
                    break;
                }
                if d == '\\' {
                    let Some(&e) = chars.get(i) else {
                        return Err(unclosed(at));
                    };
                    i += 1;
                    text.push(match e {
                        'n' => '\n',
                        't' => '\t',
                        '\\' | '\'' | '"' => e,
                        _ => return Err(syntax(i)),
                    });
                } else {
                    text.push(d);
                }
            }
            out.push(Token { tok: Tok::Str(text), at });
            continue;
        }
        if c == '[' {
            let mut name = String::new();
            i += 1;
            loop {
                let Some(&d) = chars.get(i) else {
                    return Err(unclosed(at));
                };
                i += 1;
                if d == ']' {
                    if chars.get(i) == Some(&']') {
                        name.push(']');
                        i += 1;
                        continue;
                    }
                    break;
                }
                name.push(d);
            }
            if name.is_empty() {
                return Err(syntax(at));
            }
            out.push(Token { tok: Tok::Field(name), at });
            continue;
        }
        if is_ident_start(c) {
            let start = i;
            while i < chars.len() && is_ident_char(chars[i]) {
                i += 1;
            }
            out.push(Token { tok: Tok::Ident(chars[start..i].iter().collect()), at });
            continue;
        }
        let op = OPERATORS.iter().find(|op| {
            let len = op.chars().count();
            i + len <= chars.len() && op.chars().zip(&chars[i..i + len]).all(|(a, b)| a == *b)
        });
        match op {
            Some(op) => {
                out.push(Token { tok: Tok::Op(op), at });
                i += op.chars().count();
            }
            None => return Err(syntax(at)),
        }
    }
    out.push(Token { tok: Tok::End, at: chars.len() + 1 });
    Ok(out)
}

fn syntax(at: usize) -> Detail {
    error("expression.syntax", format!("unexpected input at {at}")).with("at", at)
}

fn unclosed(at: usize) -> Detail {
    error("expression.unclosed", format!("what starts at {at} is not closed")).with("at", at)
}

// ---- syntax tree ----

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BinOp {
    Or,
    And,
    Eq,
    Ne,
    Lt,
    Le,
    Gt,
    Ge,
    Add,
    Sub,
    Mul,
    Div,
    Rem,
    Pow,
}

impl BinOp {
    fn symbol(self) -> &'static str {
        match self {
            BinOp::Or => "or",
            BinOp::And => "and",
            BinOp::Eq => "=",
            BinOp::Ne => "!=",
            BinOp::Lt => "<",
            BinOp::Le => "<=",
            BinOp::Gt => ">",
            BinOp::Ge => ">=",
            BinOp::Add => "+",
            BinOp::Sub => "-",
            BinOp::Mul => "*",
            BinOp::Div => "/",
            BinOp::Rem => "%",
            BinOp::Pow => "^",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Func {
    If,
    Coalesce,
    IsNull,
    Round,
    Floor,
    Ceil,
    Abs,
    Sqrt,
    Exp,
    Ln,
    Log10,
    Pow,
    Min,
    Max,
    Year,
    Month,
    Day,
    Hour,
    Minute,
    Second,
    Weekday,
    StartOf,
    Concat,
    Text,
    Number,
    Lower,
    Upper,
    Length,
    Contains,
}

/// Name, function, fewest and most arguments (`None`: no upper bound).
const FUNCTIONS: &[(&str, Func, usize, Option<usize>)] = &[
    ("if", Func::If, 3, Some(3)),
    ("coalesce", Func::Coalesce, 1, None),
    ("isnull", Func::IsNull, 1, Some(1)),
    ("round", Func::Round, 1, Some(2)),
    ("floor", Func::Floor, 1, Some(1)),
    ("ceil", Func::Ceil, 1, Some(1)),
    ("abs", Func::Abs, 1, Some(1)),
    ("sqrt", Func::Sqrt, 1, Some(1)),
    ("exp", Func::Exp, 1, Some(1)),
    ("ln", Func::Ln, 1, Some(1)),
    ("log10", Func::Log10, 1, Some(1)),
    ("pow", Func::Pow, 2, Some(2)),
    ("min", Func::Min, 2, None),
    ("max", Func::Max, 2, None),
    ("year", Func::Year, 1, Some(1)),
    ("month", Func::Month, 1, Some(1)),
    ("day", Func::Day, 1, Some(1)),
    ("hour", Func::Hour, 1, Some(1)),
    ("minute", Func::Minute, 1, Some(1)),
    ("second", Func::Second, 1, Some(1)),
    ("weekday", Func::Weekday, 1, Some(1)),
    ("startof", Func::StartOf, 2, Some(2)),
    ("concat", Func::Concat, 1, None),
    ("text", Func::Text, 1, Some(1)),
    ("number", Func::Number, 1, Some(1)),
    ("lower", Func::Lower, 1, Some(1)),
    ("upper", Func::Upper, 1, Some(1)),
    ("length", Func::Length, 1, Some(1)),
    ("contains", Func::Contains, 2, Some(2)),
];

/// The function names, for the editor's help and completion.
pub fn function_names() -> impl Iterator<Item = &'static str> {
    FUNCTIONS.iter().map(|f| f.0)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Unit {
    Minute,
    Hour,
    Day,
    Week,
    Month,
    Quarter,
    Year,
}

const UNITS: &[(&str, Unit)] = &[
    ("minute", Unit::Minute),
    ("hour", Unit::Hour),
    ("day", Unit::Day),
    ("week", Unit::Week),
    ("month", Unit::Month),
    ("quarter", Unit::Quarter),
    ("year", Unit::Year),
];

#[derive(Clone, Debug, PartialEq)]
pub enum Expr {
    Num(f64),
    Str(String),
    Bool(bool),
    Null,
    Field { name: String, at: usize },
    Neg { inner: Box<Expr>, height: usize },
    Not { inner: Box<Expr>, height: usize },
    Bin { op: BinOp, left: Box<Expr>, right: Box<Expr>, height: usize },
    Call { func: Func, name: &'static str, args: Vec<Expr>, unit: Option<Unit>, height: usize },
}

impl Expr {
    /// The height of the tree: 1 for a leaf. Known from building it, without walking it.
    pub fn height(&self) -> usize {
        match self {
            Expr::Neg { height, .. }
            | Expr::Not { height, .. }
            | Expr::Bin { height, .. }
            | Expr::Call { height, .. } => *height,
            _ => 1,
        }
    }
}

/// A node's height from its children's, refused above `MAX_HEIGHT`: nested parentheses around
/// operator chains can build a tree far deeper than the parser's own nesting, and every later
/// pass (type check, evaluation, dropping the tree) walks it recursively.
fn grown(children: impl Iterator<Item = usize>) -> Result<usize, Detail> {
    let height = 1 + children.max().unwrap_or(0);
    if height > MAX_HEIGHT {
        return Err(error("expression.too_deep", format!("the expression nests deeper than {MAX_HEIGHT} levels"))
            .with("max", MAX_HEIGHT));
    }
    Ok(height)
}

fn binary_node(op: BinOp, left: Expr, right: Expr) -> Result<Expr, Detail> {
    let height = grown([left.height(), right.height()].into_iter())?;
    Ok(Expr::Bin { op, left: Box::new(left), right: Box::new(right), height })
}

struct Parser {
    tokens: Vec<Token>,
    pos: usize,
    depth: usize,
}

impl Parser {
    fn peek(&self) -> &Token {
        // `lex` always ends with `End`, and `next` never moves past it.
        &self.tokens[self.pos.min(self.tokens.len() - 1)]
    }

    fn next(&mut self) -> Token {
        let t = self.peek().clone();
        if self.pos < self.tokens.len() - 1 {
            self.pos += 1;
        }
        t
    }

    fn is_op(&self, op: &str) -> bool {
        matches!(&self.peek().tok, Tok::Op(o) if *o == op)
    }

    fn is_word(&self, word: &str) -> bool {
        matches!(&self.peek().tok, Tok::Ident(w) if w.eq_ignore_ascii_case(word))
    }

    fn enter(&mut self) -> Result<(), Detail> {
        self.depth += 1;
        if self.depth > MAX_DEPTH {
            return Err(error("expression.too_deep", format!("the expression nests deeper than {MAX_DEPTH} levels"))
                .with("max", MAX_DEPTH));
        }
        Ok(())
    }

    fn leave(&mut self) {
        self.depth -= 1;
    }

    fn expr(&mut self) -> Result<Expr, Detail> {
        self.enter()?;
        let e = self.or();
        self.leave();
        e
    }

    fn or(&mut self) -> Result<Expr, Detail> {
        let mut left = self.and()?;
        let mark = self.depth;
        while self.is_word("or") || self.is_op("||") {
            self.next();
            // Each operand of a chain is one level deeper in the tree it builds.
            self.enter()?;
            let right = self.and()?;
            left = binary_node(BinOp::Or, left, right)?;
        }
        self.depth = mark;
        Ok(left)
    }

    fn and(&mut self) -> Result<Expr, Detail> {
        let mut left = self.not()?;
        let mark = self.depth;
        while self.is_word("and") || self.is_op("&&") {
            self.next();
            self.enter()?;
            let right = self.not()?;
            left = binary_node(BinOp::And, left, right)?;
        }
        self.depth = mark;
        Ok(left)
    }

    /// Parses an operand one level deeper.
    fn nested(&mut self, f: fn(&mut Self) -> Result<Expr, Detail>) -> Result<Expr, Detail> {
        self.enter()?;
        let e = f(self);
        self.leave();
        e
    }

    fn not(&mut self) -> Result<Expr, Detail> {
        if self.is_word("not") || self.is_op("!") {
            self.next();
            let inner = self.nested(Self::not)?;
            let height = grown(std::iter::once(inner.height()))?;
            return Ok(Expr::Not { inner: Box::new(inner), height });
        }
        self.comparison()
    }

    fn comparison(&mut self) -> Result<Expr, Detail> {
        let left = self.additive()?;
        let op = match &self.peek().tok {
            Tok::Op("=") | Tok::Op("==") => BinOp::Eq,
            Tok::Op("!=") | Tok::Op("<>") => BinOp::Ne,
            Tok::Op("<") => BinOp::Lt,
            Tok::Op("<=") => BinOp::Le,
            Tok::Op(">") => BinOp::Gt,
            Tok::Op(">=") => BinOp::Ge,
            _ => return Ok(left),
        };
        self.next();
        let right = self.nested(Self::additive)?;
        // `a < b < c` reads like a range but would compare a boolean with c.
        if matches!(&self.peek().tok, Tok::Op("=" | "==" | "!=" | "<>" | "<" | "<=" | ">" | ">=")) {
            return Err(syntax(self.peek().at));
        }
        binary_node(op, left, right)
    }

    fn additive(&mut self) -> Result<Expr, Detail> {
        let mut left = self.multiplicative()?;
        let mark = self.depth;
        loop {
            let op = match &self.peek().tok {
                Tok::Op("+") => BinOp::Add,
                Tok::Op("-") => BinOp::Sub,
                _ => break,
            };
            self.next();
            self.enter()?;
            let right = self.multiplicative()?;
            left = binary_node(op, left, right)?;
        }
        self.depth = mark;
        Ok(left)
    }

    fn multiplicative(&mut self) -> Result<Expr, Detail> {
        let mut left = self.unary()?;
        let mark = self.depth;
        loop {
            let op = match &self.peek().tok {
                Tok::Op("*") => BinOp::Mul,
                Tok::Op("/") => BinOp::Div,
                Tok::Op("%") => BinOp::Rem,
                _ => break,
            };
            self.next();
            self.enter()?;
            let right = self.unary()?;
            left = binary_node(op, left, right)?;
        }
        self.depth = mark;
        Ok(left)
    }

    fn unary(&mut self) -> Result<Expr, Detail> {
        if self.is_op("-") {
            self.next();
            let inner = self.nested(Self::unary)?;
            let height = grown(std::iter::once(inner.height()))?;
            return Ok(Expr::Neg { inner: Box::new(inner), height });
        }
        self.power()
    }

    fn power(&mut self) -> Result<Expr, Detail> {
        let base = self.primary()?;
        if self.is_op("^") {
            self.next();
            let exponent = self.nested(Self::unary)?;
            return binary_node(BinOp::Pow, base, exponent);
        }
        Ok(base)
    }

    fn primary(&mut self) -> Result<Expr, Detail> {
        let token = self.next();
        match token.tok {
            Tok::Num(n) => Ok(Expr::Num(n)),
            Tok::Str(s) => Ok(Expr::Str(s)),
            Tok::Field(name) => Ok(Expr::Field { name, at: token.at }),
            Tok::Op("(") => {
                let inner = self.expr()?;
                if !self.is_op(")") {
                    return Err(if matches!(self.peek().tok, Tok::End) {
                        unclosed(token.at)
                    } else {
                        syntax(self.peek().at)
                    });
                }
                self.next();
                Ok(inner)
            }
            Tok::Ident(word) => {
                if self.is_op("(") {
                    return self.call(word);
                }
                match word.to_ascii_lowercase().as_str() {
                    "true" => Ok(Expr::Bool(true)),
                    "false" => Ok(Expr::Bool(false)),
                    "null" => Ok(Expr::Null),
                    "and" | "or" | "not" => Err(syntax(token.at)),
                    _ => Ok(Expr::Field { name: word, at: token.at }),
                }
            }
            Tok::End => Err(if self.tokens.len() == 1 {
                error("expression.empty", "the expression is empty".into())
            } else {
                syntax(token.at)
            }),
            Tok::Op(_) => Err(syntax(token.at)),
        }
    }

    fn call(&mut self, word: String) -> Result<Expr, Detail> {
        let lower = word.to_lowercase();
        let Some(&(name, func, min, max)) = FUNCTIONS.iter().find(|f| f.0 == lower) else {
            return Err(
                error("expression.unknown_function", format!("there is no function {word}")).with("name", &word)
            );
        };
        let open = self.next().at;
        let mut args = Vec::new();
        if !self.is_op(")") {
            loop {
                args.push(self.expr()?);
                if args.len() > MAX_ARGS {
                    return Err(arguments(name, min, Some(MAX_ARGS)));
                }
                if self.is_op(",") {
                    self.next();
                    continue;
                }
                break;
            }
        }
        if !self.is_op(")") {
            return Err(if matches!(self.peek().tok, Tok::End) { unclosed(open) } else { syntax(self.peek().at) });
        }
        self.next();
        if args.len() < min || max.is_some_and(|m| args.len() > m) {
            return Err(arguments(name, min, max));
        }
        let unit = if func == Func::StartOf {
            let unit = match &args[1] {
                Expr::Str(s) => UNITS.iter().find(|u| u.0 == s.to_lowercase()).map(|u| u.1),
                _ => None,
            };
            let Some(unit) = unit else {
                return Err(error(
                    "expression.unit",
                    "startOf takes a unit in quotes: minute, hour, day, week, month, quarter or year".into(),
                ));
            };
            Some(unit)
        } else {
            None
        };
        let height = grown(args.iter().map(Expr::height))?;
        Ok(Expr::Call { func, name, args, unit, height })
    }
}

fn arguments(name: &str, min: usize, max: Option<usize>) -> Detail {
    match max {
        Some(max) if max == min => error("expression.arguments_exact", format!("{name} takes {min} values"))
            .with("name", name)
            .with("count", min),
        Some(max) => error("expression.arguments_range", format!("{name} takes {min} to {max} values"))
            .with("name", name)
            .with("min", min)
            .with("max", max),
        None => error("expression.arguments_min", format!("{name} takes at least {min} values"))
            .with("name", name)
            .with("min", min),
    }
}

/// Parses an expression; the syntax only, field names are checked against a frame later.
pub fn parse(text: &str) -> Result<Expr, Detail> {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() > MAX_CHARS {
        return Err(error("expression.too_long", format!("the expression has more than {MAX_CHARS} characters"))
            .with("max", MAX_CHARS));
    }
    let tokens = lex(&chars)?;
    let mut parser = Parser { tokens, pos: 0, depth: 0 };
    let expr = parser.expr()?;
    if !matches!(parser.peek().tok, Tok::End) {
        return Err(syntax(parser.peek().at));
    }
    Ok(expr)
}

// ---- types ----

/// How a field's JSON values are read.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Read {
    Number,
    Int64,
    Time,
    Text,
    Bool,
}

/// A checked expression, with fields resolved to their column.
#[derive(Clone, Debug)]
enum Node {
    Const(V),
    Field(usize, Read),
    Neg(Box<Node>),
    Not(Box<Node>),
    Bin(BinOp, Kind, Box<Node>, Box<Node>),
    Call(Func, Option<Unit>, Vec<Node>),
}

/// What an operator works on, decided by the type check.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    Number,
    Text,
    Bool,
    Time,
    /// time - time: a number of milliseconds.
    TimeDiff,
    /// time + number, number + time, time - number.
    TimeShift,
}

/// A type-checked expression, ready to compute rows of one frame.
#[derive(Clone, Debug)]
pub struct Compiled {
    node: Node,
    pub result: Type,
}

/// Finds a field by name: exactly one field of the frame must have it.
pub fn find_field(fields: &[Field], name: &str) -> Result<usize, Detail> {
    let mut found = fields.iter().enumerate().filter(|(_, f)| f.name == name).map(|(i, _)| i);
    match (found.next(), found.next()) {
        (Some(i), None) => Ok(i),
        (None, _) => Err(error("expression.unknown_field", format!("there is no field {name}")).with("field", name)),
        (Some(_), Some(_)) => {
            Err(error("expression.ambiguous_field", format!("several fields are named {name}")).with("field", name))
        }
    }
}

fn unify(a: Type, b: Type) -> Option<Type> {
    match (a, b) {
        (Type::Null, t) | (t, Type::Null) => Some(t),
        (a, b) if a == b => Some(a),
        _ => None,
    }
}

fn operands(op: BinOp, l: Type, r: Type) -> Detail {
    error("expression.operand_types", format!("{} cannot combine {} and {}", op.symbol(), l.name(), r.name()))
        .with("operator", op.symbol())
        .with("left", l.name())
        .with("right", r.name())
}

fn argument_type(name: &str, position: usize, expected: &str, found: Type) -> Detail {
    error("expression.argument_type", format!("value {position} of {name} must be {expected}, not {}", found.name()))
        .with("name", name)
        .with("position", position)
        .with("expected", expected)
        .with("found", found.name())
}

/// Type-checks `expr` against the fields of a frame.
pub fn compile(expr: &Expr, fields: &[Field]) -> Result<Compiled, Detail> {
    let (node, result) = check(expr, fields)?;
    if result == Type::Null {
        return Err(error("expression.no_type", "the expression is always empty".into()));
    }
    Ok(Compiled { node, result })
}

fn check(expr: &Expr, fields: &[Field]) -> Result<(Node, Type), Detail> {
    Ok(match expr {
        Expr::Num(n) => (Node::Const(V::Num(*n)), Type::Number),
        Expr::Str(s) => (Node::Const(V::Text(s.clone())), Type::Text),
        Expr::Bool(b) => (Node::Const(V::Bool(*b)), Type::Bool),
        Expr::Null => (Node::Const(V::Null), Type::Null),
        Expr::Field { name, .. } => {
            let index = find_field(fields, name)?;
            let (read, t) = match fields[index].field_type {
                FieldType::Number => (Read::Number, Type::Number),
                FieldType::Int64 => (Read::Int64, Type::Number),
                FieldType::Time => (Read::Time, Type::Time),
                FieldType::String => (Read::Text, Type::Text),
                FieldType::Bool => (Read::Bool, Type::Bool),
                FieldType::Json => {
                    return Err(error(
                        "expression.field_type",
                        format!("field {name} holds JSON, which has no type here"),
                    )
                    .with("field", name)
                    .with("type", "json"));
                }
            };
            (Node::Field(index, read), t)
        }
        Expr::Neg { inner, .. } => {
            let (node, t) = check(inner, fields)?;
            if !matches!(t, Type::Number | Type::Null) {
                return Err(error("expression.operand_types", format!("- cannot negate {}", t.name()))
                    .with("operator", "-")
                    .with("left", t.name())
                    .with("right", t.name()));
            }
            (Node::Neg(Box::new(node)), Type::Number)
        }
        Expr::Not { inner, .. } => {
            let (node, t) = check(inner, fields)?;
            if !matches!(t, Type::Bool | Type::Null) {
                return Err(error("expression.operand_types", format!("not cannot negate {}", t.name()))
                    .with("operator", "not")
                    .with("left", t.name())
                    .with("right", t.name()));
            }
            (Node::Not(Box::new(node)), Type::Bool)
        }
        Expr::Bin { op, left, right, .. } => {
            let (ln, lt) = check(left, fields)?;
            let (rn, rt) = check(right, fields)?;
            let (kind, result) = bin_types(*op, lt, rt, left, right)?;
            (Node::Bin(*op, kind, Box::new(ln), Box::new(rn)), result)
        }
        Expr::Call { func, name, args, unit, .. } => {
            let mut nodes = Vec::with_capacity(args.len());
            let mut types = Vec::with_capacity(args.len());
            for a in args {
                let (n, t) = check(a, fields)?;
                nodes.push(n);
                types.push(t);
            }
            let result = call_type(*func, name, &types)?;
            (Node::Call(*func, *unit, nodes), result)
        }
    })
}

fn bin_types(op: BinOp, l: Type, r: Type, left: &Expr, right: &Expr) -> Result<(Kind, Type), Detail> {
    use Type::*;
    let both = unify(l, r);
    match op {
        BinOp::Or | BinOp::And => match both {
            Some(Bool | Null) => Ok((Kind::Bool, Bool)),
            _ => Err(operands(op, l, r)),
        },
        BinOp::Eq | BinOp::Ne | BinOp::Lt | BinOp::Le | BinOp::Gt | BinOp::Ge => {
            if matches!(left, Expr::Null) || matches!(right, Expr::Null) {
                return Err(error(
                    "expression.null_compare",
                    "a comparison with null is always empty; use isnull(...)".into(),
                ));
            }
            let ordered = !matches!(op, BinOp::Eq | BinOp::Ne);
            match both {
                Some(Number) => Ok((Kind::Number, Bool)),
                Some(Text) => Ok((Kind::Text, Bool)),
                Some(Time) => Ok((Kind::Time, Bool)),
                Some(Bool) if !ordered => Ok((Kind::Bool, Bool)),
                Some(Null) => Ok((Kind::Number, Bool)),
                _ => Err(operands(op, l, r)),
            }
        }
        BinOp::Add => match (l, r) {
            (Time, Number | Null) | (Number | Null, Time) => Ok((Kind::TimeShift, Time)),
            _ => match both {
                Some(Number | Null) => Ok((Kind::Number, Number)),
                Some(Text) => Ok((Kind::Text, Text)),
                _ => Err(operands(op, l, r)),
            },
        },
        BinOp::Sub => match (l, r) {
            (Time, Time) => Ok((Kind::TimeDiff, Number)),
            (Time, Number) => Ok((Kind::TimeShift, Time)),
            // Which one is meant cannot be told from an empty value; both answer empty anyway.
            (Time, Null) => Ok((Kind::TimeShift, Time)),
            (Null, Time) => Ok((Kind::TimeDiff, Number)),
            _ => match both {
                Some(Number | Null) => Ok((Kind::Number, Number)),
                _ => Err(operands(op, l, r)),
            },
        },
        BinOp::Mul | BinOp::Div | BinOp::Rem | BinOp::Pow => match both {
            Some(Number | Null) => Ok((Kind::Number, Number)),
            _ => Err(operands(op, l, r)),
        },
    }
}

fn mixed(name: &str, a: Type, b: Type) -> Detail {
    error("expression.mixed_types", format!("{name} mixes {} and {}", a.name(), b.name()))
        .with("name", name)
        .with("first", a.name())
        .with("second", b.name())
}

fn call_type(func: Func, name: &str, types: &[Type]) -> Result<Type, Detail> {
    use Type::*;
    let want = |i: usize, allowed: &[Type], expected: &str| -> Result<(), Detail> {
        let t = types[i];
        if t == Null || allowed.contains(&t) { Ok(()) } else { Err(argument_type(name, i + 1, expected, t)) }
    };
    Ok(match func {
        Func::If => {
            want(0, &[Bool], "bool")?;
            unify(types[1], types[2]).ok_or_else(|| mixed(name, types[1], types[2]))?
        }
        Func::Coalesce => {
            let mut t = Null;
            for &a in types {
                t = unify(t, a).ok_or_else(|| mixed(name, t, a))?;
            }
            t
        }
        Func::IsNull => Bool,
        Func::Round => {
            want(0, &[Number], "number")?;
            if types.len() == 2 {
                want(1, &[Number], "number")?;
            }
            Number
        }
        Func::Floor | Func::Ceil | Func::Abs | Func::Sqrt | Func::Exp | Func::Ln | Func::Log10 => {
            want(0, &[Number], "number")?;
            Number
        }
        Func::Pow => {
            want(0, &[Number], "number")?;
            want(1, &[Number], "number")?;
            Number
        }
        Func::Min | Func::Max => {
            let mut t = Null;
            for (i, &a) in types.iter().enumerate() {
                want(i, &[Number, Text, Time], "a number, text or time")?;
                t = unify(t, a).ok_or_else(|| mixed(name, t, a))?;
            }
            t
        }
        Func::Year | Func::Month | Func::Day | Func::Hour | Func::Minute | Func::Second | Func::Weekday => {
            want(0, &[Time], "time")?;
            Number
        }
        Func::StartOf => {
            want(0, &[Time], "time")?;
            Time
        }
        Func::Concat | Func::Text => Text,
        Func::Number => {
            want(0, &[Number, Text, Bool, Time], "a value")?;
            Number
        }
        Func::Lower | Func::Upper => {
            want(0, &[Text], "text")?;
            Text
        }
        Func::Length => {
            want(0, &[Text], "text")?;
            Number
        }
        Func::Contains => {
            want(0, &[Text], "text")?;
            want(1, &[Text], "text")?;
            Bool
        }
    })
}

// ---- values ----

#[derive(Clone, Debug, PartialEq)]
pub enum V {
    Null,
    Num(f64),
    Text(String),
    Bool(bool),
    /// Unix ms; may carry a fraction until it is written out.
    Time(f64),
}

/// A number, or empty when it is not finite (division by zero, overflow).
fn num(x: f64) -> V {
    if x.is_finite() { V::Num(x) } else { V::Null }
}

/// A time, or empty outside the years 1 to 9999.
fn time(ms: f64) -> V {
    if ms.is_finite() && (MIN_TIME_MS..=MAX_TIME_MS).contains(&ms.floor()) { V::Time(ms) } else { V::Null }
}

/// Exact powers of ten for `round`, so both engines round by the same factor.
const POW10: [f64; 16] = [1e0, 1e1, 1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9, 1e10, 1e11, 1e12, 1e13, 1e14, 1e15];

/// Half away from zero, as people round.
fn round_half_away(x: f64) -> f64 {
    let r = x.abs().floor();
    let r = if x.abs() - r >= 0.5 { r + 1.0 } else { r };
    if x < 0.0 { -r } else { r }
}

fn read(value: &Value, how: Read) -> V {
    match (how, value) {
        (_, Value::Null) => V::Null,
        (Read::Number, Value::Number(n)) => n.as_f64().map_or(V::Null, num),
        (Read::Int64, Value::String(s)) => parse_number(s).map_or(V::Null, num),
        (Read::Int64, Value::Number(n)) => n.as_f64().map_or(V::Null, num),
        (Read::Time, Value::Number(n)) => n.as_f64().map_or(V::Null, time),
        (Read::Text, Value::String(s)) => V::Text(s.clone()),
        (Read::Bool, Value::Bool(b)) => V::Bool(*b),
        _ => V::Null,
    }
}

/// Longest text an expression may make, in UTF-16 units (Excel's limit for a cell): nested
/// `concat` would otherwise grow a cell about a thousandfold per step.
pub const MAX_TEXT_UNITS: usize = 32_767;

thread_local! {
    /// Set when a text result went past `MAX_TEXT_UNITS` during one evaluation.
    static TOO_LONG: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

pub fn utf16_len(s: &str) -> usize {
    s.chars().map(char::len_utf16).sum()
}

/// Text within the limit, else empty and the evaluation is marked as failed.
fn capped(s: String) -> V {
    if utf16_len(&s) > MAX_TEXT_UNITS {
        TOO_LONG.with(|f| f.set(true));
        return V::Null;
    }
    V::Text(s)
}

pub fn text_too_long() -> Detail {
    error("expression.text_too_long", format!("the expression makes text longer than {MAX_TEXT_UNITS} characters"))
        .with("max", MAX_TEXT_UNITS)
}

impl Compiled {
    /// The value of the expression for one row of `fields`; text longer than `MAX_TEXT_UNITS`
    /// fails the row.
    pub fn eval(&self, fields: &[Field], row: usize) -> Result<V, Detail> {
        TOO_LONG.with(|f| f.set(false));
        let v = eval(&self.node, fields, row);
        let too_long = TOO_LONG.with(|f| f.replace(false));
        match v {
            V::Text(s) if utf16_len(&s) > MAX_TEXT_UNITS => Err(text_too_long()),
            _ if too_long => Err(text_too_long()),
            v => Ok(v),
        }
    }

    /// The value as a JSON cell of the result field.
    pub fn cell(&self, fields: &[Field], row: usize) -> Result<Value, Detail> {
        self.eval(fields, row).map(to_json)
    }
}

pub fn to_json(v: V) -> Value {
    match v {
        V::Null => Value::Null,
        // -0 is written as 0, as JSON in the browser writes it.
        V::Num(x) => serde_json::Number::from_f64(if x == 0.0 { 0.0 } else { x }).map_or(Value::Null, Value::Number),
        V::Text(s) => Value::String(s),
        V::Bool(b) => Value::Bool(b),
        V::Time(ms) => Value::from(ms.floor() as i64),
    }
}

fn eval(node: &Node, fields: &[Field], row: usize) -> V {
    match node {
        Node::Const(v) => v.clone(),
        Node::Field(i, how) => fields[*i].values.get(row).map_or(V::Null, |v| read(v, *how)),
        Node::Neg(inner) => match eval(inner, fields, row) {
            V::Num(x) => num(-x),
            _ => V::Null,
        },
        Node::Not(inner) => match eval(inner, fields, row) {
            V::Bool(b) => V::Bool(!b),
            _ => V::Null,
        },
        Node::Bin(op, kind, l, r) => bin(*op, *kind, l, r, fields, row),
        Node::Call(func, unit, args) => call(*func, *unit, args, fields, row),
    }
}

fn bin(op: BinOp, kind: Kind, l: &Node, r: &Node, fields: &[Field], row: usize) -> V {
    if matches!(op, BinOp::And | BinOp::Or) {
        let a = eval(l, fields, row);
        // Three-valued logic: false and x is false, true or x is true, whatever x is.
        match (op, &a) {
            (BinOp::And, V::Bool(false)) => return V::Bool(false),
            (BinOp::Or, V::Bool(true)) => return V::Bool(true),
            _ => {}
        }
        let b = eval(r, fields, row);
        return match (op, a, b) {
            (BinOp::And, _, V::Bool(false)) => V::Bool(false),
            (BinOp::Or, _, V::Bool(true)) => V::Bool(true),
            (_, V::Bool(_), V::Bool(y)) => V::Bool(y),
            _ => V::Null,
        };
    }
    let a = eval(l, fields, row);
    let b = eval(r, fields, row);
    if a == V::Null || b == V::Null {
        return V::Null;
    }
    match op {
        BinOp::Eq | BinOp::Ne | BinOp::Lt | BinOp::Le | BinOp::Gt | BinOp::Ge => {
            let ord = match (&a, &b) {
                (V::Num(x), V::Num(y)) | (V::Time(x), V::Time(y)) => x.partial_cmp(y),
                (V::Text(x), V::Text(y)) => Some(x.chars().cmp(y.chars())),
                (V::Bool(x), V::Bool(y)) => Some(x.cmp(y)),
                _ => None,
            };
            let Some(ord) = ord else { return V::Null };
            V::Bool(match op {
                BinOp::Eq => ord.is_eq(),
                BinOp::Ne => ord.is_ne(),
                BinOp::Lt => ord.is_lt(),
                BinOp::Le => ord.is_le(),
                BinOp::Gt => ord.is_gt(),
                _ => ord.is_ge(),
            })
        }
        _ => match (kind, a, b) {
            (Kind::Text, V::Text(x), V::Text(y)) => {
                if utf16_len(&x) + utf16_len(&y) > MAX_TEXT_UNITS {
                    TOO_LONG.with(|f| f.set(true));
                    return V::Null;
                }
                V::Text(x + &y)
            }
            (Kind::TimeDiff, V::Time(x), V::Time(y)) => num(x - y),
            (Kind::TimeShift, V::Time(t), V::Num(n)) | (Kind::TimeShift, V::Num(n), V::Time(t)) => {
                time(if op == BinOp::Sub { t - n } else { t + n })
            }
            (_, V::Num(x), V::Num(y)) => match op {
                BinOp::Add => num(x + y),
                BinOp::Sub => num(x - y),
                BinOp::Mul => num(x * y),
                BinOp::Div if y == 0.0 => V::Null,
                BinOp::Div => num(x / y),
                BinOp::Rem if y == 0.0 => V::Null,
                BinOp::Rem => num(x % y),
                BinOp::Pow => num(x.powf(y)),
                _ => V::Null,
            },
            _ => V::Null,
        },
    }
}

fn call(func: Func, unit: Option<Unit>, args: &[Node], fields: &[Field], row: usize) -> V {
    let arg = |i: usize| eval(&args[i], fields, row);
    let number = |i: usize| match arg(i) {
        V::Num(x) => Some(x),
        _ => None,
    };
    let math = |f: fn(f64) -> f64| number(0).map_or(V::Null, |x| num(f(x)));
    let at = |i: usize| match arg(i) {
        V::Time(t) => Some(t.floor()),
        _ => None,
    };
    let calendar = |f: fn(Civil) -> f64| at(0).map_or(V::Null, |t| num(f(Civil::of(t))));
    match func {
        Func::If => match arg(0) {
            V::Bool(true) => arg(1),
            _ => arg(2),
        },
        Func::Coalesce => args.iter().map(|a| eval(a, fields, row)).find(|v| *v != V::Null).unwrap_or(V::Null),
        Func::IsNull => V::Bool(arg(0) == V::Null),
        Func::Round => {
            let Some(x) = number(0) else { return V::Null };
            let digits = if args.len() == 2 {
                match number(1) {
                    Some(d) => d.trunc().clamp(0.0, 15.0) as usize,
                    None => return V::Null,
                }
            } else {
                0
            };
            let factor = POW10[digits];
            num(round_half_away(x * factor) / factor)
        }
        Func::Floor => math(f64::floor),
        Func::Ceil => math(f64::ceil),
        Func::Abs => math(f64::abs),
        Func::Sqrt => number(0).map_or(V::Null, |x| if x < 0.0 { V::Null } else { num(x.sqrt()) }),
        Func::Exp => math(f64::exp),
        Func::Ln => number(0).map_or(V::Null, |x| if x <= 0.0 { V::Null } else { num(x.ln()) }),
        Func::Log10 => number(0).map_or(V::Null, |x| if x <= 0.0 { V::Null } else { num(x.log10()) }),
        Func::Pow => match (number(0), number(1)) {
            (Some(x), Some(y)) => num(x.powf(y)),
            _ => V::Null,
        },
        Func::Min | Func::Max => {
            let mut best: Option<V> = None;
            for a in args {
                let v = eval(a, fields, row);
                if v == V::Null {
                    continue;
                }
                best = Some(match best {
                    None => v,
                    Some(b) => {
                        let less = match (&v, &b) {
                            (V::Num(x), V::Num(y)) | (V::Time(x), V::Time(y)) => x < y,
                            (V::Text(x), V::Text(y)) => x.chars().lt(y.chars()),
                            _ => false,
                        };
                        if less == (func == Func::Min) && v != b { v } else { b }
                    }
                });
            }
            best.unwrap_or(V::Null)
        }
        Func::Year => calendar(|c| c.year as f64),
        Func::Month => calendar(|c| c.month as f64),
        Func::Day => calendar(|c| c.day as f64),
        Func::Hour => at(0).map_or(V::Null, |t| num(((t.rem_euclid(DAY_MS)) / 3_600_000.0).floor())),
        Func::Minute => at(0).map_or(V::Null, |t| num((t.rem_euclid(3_600_000.0) / 60_000.0).floor())),
        Func::Second => at(0).map_or(V::Null, |t| num((t.rem_euclid(60_000.0) / 1000.0).floor())),
        Func::Weekday => at(0).map_or(V::Null, |t| num(weekday((t / DAY_MS).floor() as i64) as f64)),
        Func::StartOf => at(0).map_or(V::Null, |t| time(start_of(t, unit.unwrap_or(Unit::Day)))),
        Func::Concat => {
            let (mut out, mut units) = (String::new(), 0);
            for a in args {
                if let Some(s) = text_of(&eval(a, fields, row)) {
                    units += utf16_len(&s);
                    if units > MAX_TEXT_UNITS {
                        // Stops before building anything longer.
                        TOO_LONG.with(|f| f.set(true));
                        return V::Null;
                    }
                    out.push_str(&s);
                }
            }
            V::Text(out)
        }
        Func::Text => text_of(&arg(0)).map_or(V::Null, V::Text),
        Func::Number => match arg(0) {
            V::Num(x) => V::Num(x),
            V::Time(t) => num(t.floor()),
            V::Bool(b) => V::Num(if b { 1.0 } else { 0.0 }),
            V::Text(s) => parse_number(&s).map_or(V::Null, num),
            V::Null => V::Null,
        },
        Func::Lower => match arg(0) {
            V::Text(s) => capped(s.to_lowercase()),
            _ => V::Null,
        },
        Func::Upper => match arg(0) {
            V::Text(s) => capped(s.to_uppercase()),
            _ => V::Null,
        },
        Func::Length => match arg(0) {
            V::Text(s) => V::Num(s.chars().count() as f64),
            _ => V::Null,
        },
        Func::Contains => match (arg(0), arg(1)) {
            (V::Text(s), V::Text(sub)) => V::Bool(s.contains(&sub)),
            _ => V::Null,
        },
    }
}

/// A number written in text: an optional sign, digits with an optional fraction, an optional
/// exponent; spaces around it are allowed. Anything else is not a number.
pub fn parse_number(text: &str) -> Option<f64> {
    let s = text.trim_matches(|c: char| c.is_ascii_whitespace());
    let body = s.strip_prefix(['+', '-']).unwrap_or(s);
    let (mantissa, exponent) = match body.find(['e', 'E']) {
        Some(i) => (&body[..i], Some(&body[i + 1..])),
        None => (body, None),
    };
    let (whole, fraction) = match mantissa.split_once('.') {
        Some((w, f)) => (w, Some(f)),
        None => (mantissa, None),
    };
    let digits = |p: &str| p.bytes().all(|b| b.is_ascii_digit());
    let mantissa_ok =
        digits(whole) && fraction.is_none_or(digits) && (!whole.is_empty() || fraction.is_some_and(|f| !f.is_empty()));
    let exponent_ok = exponent.is_none_or(|e| {
        let e = e.strip_prefix(['+', '-']).unwrap_or(e);
        !e.is_empty() && digits(e)
    });
    if !mantissa_ok || !exponent_ok {
        return None;
    }
    s.parse::<f64>().ok().filter(|x| x.is_finite())
}

/// A value as text: numbers as JavaScript writes them, times as ISO 8601 in UTC.
pub fn text_of(v: &V) -> Option<String> {
    match v {
        V::Null => None,
        V::Num(x) => Some(number_text(*x)),
        V::Text(s) => Some(s.clone()),
        V::Bool(b) => Some(b.to_string()),
        V::Time(t) => Some(iso_time(t.floor() as i64)),
    }
}

/// Unix ms as `2026-10-21T08:15:00.000Z`.
pub fn iso_time(ms: i64) -> String {
    let c = Civil::of(ms as f64);
    let in_day = ms.rem_euclid(86_400_000);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        c.year,
        c.month,
        c.day,
        in_day / 3_600_000,
        in_day % 3_600_000 / 60_000,
        in_day % 60_000 / 1000,
        in_day % 1000
    )
}

/// A number the way JavaScript's `String(x)` writes it (ECMAScript `Number::toString`, through
/// `ryu-js`), so both engines produce the same text.
pub fn number_text(x: f64) -> String {
    if !x.is_finite() {
        return String::new();
    }
    if x == 0.0 {
        return "0".into();
    }
    ryu_js::Buffer::new().format_finite(x).to_string()
}

// ---- calendar (UTC, proleptic Gregorian) ----

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Civil {
    pub year: i64,
    pub month: i64,
    pub day: i64,
}

impl Civil {
    /// The date of a Unix ms time.
    pub fn of(ms: f64) -> Civil {
        civil_from_days((ms / DAY_MS).floor() as i64)
    }
}

/// Days since 1970-01-01 to a date (Howard Hinnant's algorithm).
pub fn civil_from_days(z: i64) -> Civil {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    Civil { year: if month <= 2 { y + 1 } else { y }, month, day }
}

/// A date to days since 1970-01-01.
pub fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let mp = if month > 2 { month - 3 } else { month + 9 };
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

pub fn days_in_month(year: i64, month: i64) -> i64 {
    match month {
        2 if (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

/// ISO weekday of a day number: 1 Monday to 7 Sunday (1970-01-01 was a Thursday).
pub fn weekday(days: i64) -> i64 {
    (days + 3).rem_euclid(7) + 1
}

fn start_of(t: f64, unit: Unit) -> f64 {
    let floor_to = |step: f64| (t / step).floor() * step;
    match unit {
        Unit::Minute => floor_to(60_000.0),
        Unit::Hour => floor_to(3_600_000.0),
        Unit::Day => floor_to(DAY_MS),
        Unit::Week => {
            let days = (t / DAY_MS).floor() as i64;
            (days - (weekday(days) - 1)) as f64 * DAY_MS
        }
        Unit::Month | Unit::Quarter | Unit::Year => {
            let c = Civil::of(t);
            let month = match unit {
                Unit::Month => c.month,
                Unit::Quarter => (c.month - 1) / 3 * 3 + 1,
                _ => 1,
            };
            days_from_civil(c.year, month, 1) as f64 * DAY_MS
        }
    }
}

/// Moves a time by whole calendar months in UTC, keeping the time of day; a day the target month
/// lacks becomes its last day (31 March minus a month is 28 or 29 February).
pub fn add_months(t: f64, months: i64) -> f64 {
    let days = (t / DAY_MS).floor();
    let in_day = t - days * DAY_MS;
    let c = civil_from_days(days as i64);
    let index = c.year * 12 + (c.month - 1) + months;
    let (year, month) = (index.div_euclid(12), index.rem_euclid(12) + 1);
    let day = c.day.min(days_in_month(year, month));
    days_from_civil(year, month, day) as f64 * DAY_MS + in_day
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn field(name: &str, field_type: FieldType, values: Vec<Value>) -> Field {
        Field { name: name.into(), field_type, unit: None, values, labels: None }
    }

    fn sample() -> Vec<Field> {
        vec![
            field(
                "zeit",
                FieldType::Time,
                vec![json!(1_767_225_600_000_i64), json!(1_767_312_000_000_i64), Value::Null],
            ),
            field("betrag", FieldType::Number, vec![json!(12.5), json!(-3), Value::Null]),
            field("anzahl", FieldType::Int64, vec![json!("4"), json!("9007199254740993"), Value::Null]),
            field("land", FieldType::String, vec![json!("Österreich"), json!("Schweiz"), Value::Null]),
            field("bezahlt", FieldType::Bool, vec![json!(true), json!(false), Value::Null]),
            field("roh", FieldType::Json, vec![json!({}), json!([]), Value::Null]),
            field("Umsatz (€)", FieldType::Number, vec![json!(100), json!(0), json!(1)]),
        ]
    }

    fn run(text: &str) -> Vec<Value> {
        let fields = sample();
        let c = compile(&parse(text).unwrap_or_else(|e| panic!("{text}: {e}")), &fields)
            .unwrap_or_else(|e| panic!("{text}: {e}"));
        (0..3).map(|row| c.cell(&fields, row).unwrap()).collect()
    }

    fn fails(text: &str) -> Detail {
        let fields = sample();
        match parse(text) {
            Err(e) => e,
            Ok(expr) => compile(&expr, &fields).err().unwrap_or_else(|| panic!("{text} should fail")),
        }
    }

    #[test]
    fn arithmetic_follows_precedence() {
        assert_eq!(run("1 + 2 * 3"), vec![json!(7.0); 3]);
        assert_eq!(run("(1 + 2) * 3"), vec![json!(9.0); 3]);
        assert_eq!(run("2 ^ 3 ^ 2"), vec![json!(512.0); 3]);
        assert_eq!(run("-2 ^ 2"), vec![json!(-4.0); 3]);
        assert_eq!(run("2 ^ -1"), vec![json!(0.5); 3]);
        assert_eq!(run("7 % 3 - 10 / 4"), vec![json!(-1.5); 3]);
        assert_eq!(run("1e3 + 0.5"), vec![json!(1000.5); 3]);
    }

    #[test]
    fn fields_by_name_and_in_brackets() {
        assert_eq!(run("betrag * 2"), [json!(25.0), json!(-6.0), Value::Null]);
        assert_eq!(run("[Umsatz (€)] / betrag"), [json!(8.0), json!(0.0), Value::Null]);
        assert_eq!(run("anzahl + 1"), [json!(5.0), json!(9007199254740992.0), Value::Null]);
        assert_eq!(run("bezahlt and betrag > 0"), [json!(true), json!(false), Value::Null]);
    }

    #[test]
    fn empty_values_and_division_by_zero() {
        assert_eq!(run("betrag / 0"), vec![Value::Null; 3]);
        assert_eq!(run("betrag % 0"), vec![Value::Null; 3]);
        assert_eq!(run("coalesce(betrag, 0)"), [json!(12.5), json!(-3.0), json!(0.0)]);
        assert_eq!(run("isnull(land)"), [json!(false), json!(false), json!(true)]);
        assert_eq!(run("sqrt(betrag)")[1], Value::Null);
        assert_eq!(run("ln(0)"), vec![Value::Null; 3]);
        assert_eq!(run("10 ^ 400"), vec![Value::Null; 3], "overflow is empty, never infinite");
        assert_eq!(run("null + 1"), vec![Value::Null; 3]);
    }

    #[test]
    fn three_valued_logic() {
        assert_eq!(run("isnull(land) or bezahlt"), [json!(true), json!(false), json!(true)]);
        assert_eq!(run("false and bezahlt"), vec![json!(false); 3]);
        assert_eq!(run("true or bezahlt"), vec![json!(true); 3]);
        assert_eq!(run("true and bezahlt"), [json!(true), json!(false), Value::Null]);
        assert_eq!(run("not bezahlt"), [json!(false), json!(true), Value::Null]);
    }

    #[test]
    fn functions() {
        assert_eq!(run("if(betrag > 0, 'plus', 'minus')"), [json!("plus"), json!("minus"), json!("minus")]);
        assert_eq!(run("round(2.5) + round(-2.5)"), vec![json!(0.0); 3]);
        assert_eq!(run("round(1.23456, 2)"), vec![json!(1.23); 3]);
        assert_eq!(run("round(1.5, 99)"), vec![json!(1.5); 3]);
        assert_eq!(run("min(3, betrag, 20)"), [json!(3.0), json!(-3.0), json!(3.0)]);
        assert_eq!(run("max(land, 'Zypern')"), [json!("Österreich"), json!("Zypern"), json!("Zypern")]);
        assert_eq!(run("concat(land, ': ', betrag)"), [json!("Österreich: 12.5"), json!("Schweiz: -3"), json!(": ")]);
        assert_eq!(run("length(land)"), [json!(10.0), json!(7.0), Value::Null]);
        assert_eq!(run("upper(land)")[0], json!("ÖSTERREICH"));
        assert_eq!(run("contains(land, 'reich')"), [json!(true), json!(false), Value::Null]);
        assert_eq!(run("number(' 1.5e2 ') + number('x')"), vec![Value::Null; 3]);
        assert_eq!(run("number(' 1.5e2 ')"), vec![json!(150.0); 3]);
        assert_eq!(run("number('')"), vec![Value::Null; 3], "empty text is no number");
        assert_eq!(run("text(1e21)"), vec![json!("1e+21"); 3]);
        assert_eq!(run("text(zeit)")[0], json!("2026-01-01T00:00:00.000Z"));
    }

    #[test]
    fn time_functions_work_in_utc() {
        // 2026-01-01 is a Thursday.
        assert_eq!(run("year(zeit)")[0], json!(2026.0));
        assert_eq!(run("month(zeit) * 100 + day(zeit)")[1], json!(102.0));
        assert_eq!(run("weekday(zeit)"), [json!(4.0), json!(5.0), Value::Null]);
        assert_eq!(run("hour(zeit + 3600000 * 25)")[0], json!(1.0));
        assert_eq!(run("startOf(zeit, 'week')")[0], json!(1_766_966_400_000_i64));
        assert_eq!(run("startOf(zeit + 86400000 * 40, 'month')")[0], json!(1_769_904_000_000_i64));
        assert_eq!(run("startOf(zeit, 'quarter') = startOf(zeit, 'year')")[0], json!(true));
        assert_eq!(run("(zeit - startOf(zeit, 'day')) / 1000")[1], json!(0.0));
        assert_eq!(run("zeit - 86400000")[0], json!(1_767_139_200_000_i64));
        assert_eq!(run("zeit + 1e20"), vec![Value::Null; 3], "past the year 9999");
    }

    #[test]
    fn calendar_helpers() {
        assert_eq!(civil_from_days(0), Civil { year: 1970, month: 1, day: 1 });
        assert_eq!(civil_from_days(-1), Civil { year: 1969, month: 12, day: 31 });
        assert_eq!(days_from_civil(2000, 3, 1), 11_017);
        for d in [-800_000, -1, 0, 59, 10_957, 2_932_896] {
            let c = civil_from_days(d);
            assert_eq!(days_from_civil(c.year, c.month, c.day), d);
        }
        let march_31 = days_from_civil(2024, 3, 31) as f64 * DAY_MS + 5.0;
        assert_eq!(add_months(march_31, -1), days_from_civil(2024, 2, 29) as f64 * DAY_MS + 5.0);
        let leap = days_from_civil(2024, 2, 29) as f64 * DAY_MS;
        assert_eq!(add_months(leap, -12), days_from_civil(2023, 2, 28) as f64 * DAY_MS);
        assert_eq!(iso_time(MIN_TIME_MS as i64), "0001-01-01T00:00:00.000Z");
        assert_eq!(iso_time(MAX_TIME_MS as i64), "9999-12-31T23:59:59.999Z");
    }

    #[test]
    fn numbers_are_written_as_javascript_writes_them() {
        for (x, text) in [
            // Two shortest forms read back the same; ECMAScript takes the one closer to the value.
            (1_658_206_780_088_562.2, "1658206780088562.2"),
            (-1_052_730_259_603_333.2, "-1052730259603333.2"),
            (0.0, "0"),
            (-0.0, "0"),
            (1.0, "1"),
            (-12.5, "-12.5"),
            (0.1 + 0.2, "0.30000000000000004"),
            (1e21, "1e+21"),
            (1.5e21, "1.5e+21"),
            (123_456_789_012_345_680_000.0, "123456789012345680000"),
            (1e-6, "0.000001"),
            (1e-7, "1e-7"),
            (-2.5e-8, "-2.5e-8"),
            (f64::MAX, "1.7976931348623157e+308"),
            (5e-324, "5e-324"),
        ] {
            assert_eq!(number_text(x), text, "{x}");
        }
    }

    #[test]
    fn type_errors_name_the_problem() {
        let cases: &[(&str, &str)] = &[
            ("land + 1", "expression.operand_types"),
            ("betrag and true", "expression.operand_types"),
            ("zeit * 2", "expression.operand_types"),
            ("bezahlt < true", "expression.operand_types"),
            ("-land", "expression.operand_types"),
            ("not betrag", "expression.operand_types"),
            ("if(betrag, 1, 2)", "expression.argument_type"),
            ("if(bezahlt, 1, 'x')", "expression.mixed_types"),
            ("coalesce(land, betrag)", "expression.mixed_types"),
            ("year(betrag)", "expression.argument_type"),
            ("min(bezahlt, true)", "expression.argument_type"),
            ("unbekannt + 1", "expression.unknown_field"),
            ("roh", "expression.field_type"),
            ("null", "expression.no_type"),
            ("coalesce(null, null)", "expression.no_type"),
            ("betrag = null", "expression.null_compare"),
        ];
        for (text, reason) in cases {
            assert_eq!(fails(text).reason, *reason, "{text}");
        }
        let e = fails("land + 1");
        assert_eq!(e.params.get("left").map(String::as_str), Some("text"));
        assert_eq!(e.params.get("right").map(String::as_str), Some("number"));
        let mut twice = sample();
        twice.push(field("land", FieldType::String, vec![Value::Null; 3]));
        let e = compile(&parse("land").unwrap(), &twice).unwrap_err();
        assert_eq!(e.reason, "expression.ambiguous_field");
    }

    #[test]
    fn syntax_errors_name_the_place() {
        let cases: &[(&str, &str, Option<&str>)] = &[
            ("", "expression.empty", None),
            ("   ", "expression.empty", None),
            ("1 +", "expression.syntax", Some("4")),
            ("1 2", "expression.syntax", Some("3")),
            ("2x", "expression.syntax", Some("2")),
            ("1.", "expression.syntax", Some("3")),
            ("1e", "expression.syntax", Some("3")),
            ("(1 + 2", "expression.unclosed", Some("1")),
            ("'offen", "expression.unclosed", Some("1")),
            ("[offen", "expression.unclosed", Some("1")),
            ("round(1, 2", "expression.unclosed", Some("6")),
            ("[]", "expression.syntax", Some("1")),
            ("'\\q'", "expression.syntax", Some("3")),
            ("1 < 2 < 3", "expression.syntax", Some("7")),
            ("a # b", "expression.syntax", Some("3")),
            ("1e999", "expression.number", Some("1")),
            ("and", "expression.syntax", Some("1")),
            ("ungueltig(1)", "expression.unknown_function", None),
            ("if(true, 1)", "expression.arguments_exact", None),
            ("round()", "expression.arguments_range", None),
            ("min(1)", "expression.arguments_min", None),
            ("startOf(zeit, 'tag')", "expression.unit", None),
            ("startOf(zeit, land)", "expression.unit", None),
        ];
        for (text, reason, at) in cases {
            let e = fails(text);
            assert_eq!(e.reason, *reason, "{text}: {e}");
            if let Some(at) = at {
                assert_eq!(e.params.get("at").map(String::as_str), Some(*at), "{text}");
            }
        }
    }

    #[test]
    fn names_keywords_and_escapes() {
        assert_eq!(run("TRUE AND NOT False"), vec![json!(true); 3]);
        assert_eq!(run("IF(true, 1, 2)"), vec![json!(1.0); 3]);
        assert_eq!(run("'it\\'s' + \"\\\"\""), vec![json!("it's\""); 3]);
        let fields =
            vec![field("a]b", FieldType::Number, vec![json!(1)]), field("A.wert", FieldType::Number, vec![json!(2)])];
        let c = compile(&parse("[a]]b] + A.wert").unwrap(), &fields).unwrap();
        assert_eq!(c.cell(&fields, 0).unwrap(), json!(3.0));
        let fields = vec![field("größe_2", FieldType::Number, vec![json!(4)])];
        assert_eq!(compile(&parse("größe_2 * 2").unwrap(), &fields).unwrap().cell(&fields, 0).unwrap(), json!(8.0));
    }

    #[test]
    fn deep_trees_from_chains_inside_parentheses_are_refused() {
        // At each level of parentheses a chain adds height without nesting the parser deeper.
        let mut text = String::from("x");
        let mut k = 63usize;
        loop {
            let mut next = format!("({text}");
            for _ in 0..(64 - k).saturating_sub(1) {
                next.push_str("*x");
            }
            next.push(')');
            if next.chars().count() > 1990 || k == 1 {
                break;
            }
            text = next;
            k -= 1;
        }
        let e = parse(&text).unwrap_err();
        assert_eq!((e.reason, e.params.get("max").map(String::as_str)), ("expression.too_deep", Some("128")));
        // A tree of exactly the limit is fine and runs on a small stack.
        let chain = vec!["1"; MAX_HEIGHT].join("+");
        let expr = parse(&format!("({chain})")).err().map(|e| e.reason);
        assert_eq!(expr, Some("expression.too_deep"), "the flat chain is within the parser's own limit first");
        let ok = (0..MAX_HEIGHT - 1).fold("1".to_string(), |acc, _| format!("abs({acc})"));
        assert!(parse(&ok).is_err(), "nesting calls this deep is refused by the parser already");
        let fields = vec![field("x", FieldType::Number, vec![json!(1.0)])];
        let tall = (0..6).fold("x".to_string(), |acc, _| format!("({acc}{})", "*x".repeat(20)));
        let tall = parse(&tall).unwrap_or_else(|e| panic!("{e}"));
        assert!(tall.height() <= MAX_HEIGHT && tall.height() > MAX_DEPTH, "{}", tall.height());
        std::thread::Builder::new()
            .stack_size(1024 * 1024)
            .spawn(move || compile(&tall, &fields).unwrap().cell(&fields, 0).unwrap())
            .unwrap()
            .join()
            .expect("evaluates on a small stack");
    }

    #[test]
    fn text_results_are_capped() {
        let fields = vec![field("a", FieldType::String, vec![json!("x".repeat(20_000))])];
        let c = compile(&parse("concat(a, a)").unwrap(), &fields).unwrap();
        assert_eq!(c.cell(&fields, 0).unwrap_err().reason, "expression.text_too_long");
        let c = compile(&parse("length(a + a) + 1").unwrap(), &fields).unwrap();
        assert_eq!(c.cell(&fields, 0).unwrap_err().reason, "expression.text_too_long", "also inside");
        let c = compile(&parse("concat(a, 'y')").unwrap(), &fields).unwrap();
        assert!(c.cell(&fields, 0).is_ok());
        // UTF-16 units, as Excel counts: an emoji takes two.
        let emoji = vec![field("a", FieldType::String, vec![json!("😀".repeat(16_384))])];
        let c = compile(&parse("concat(a)").unwrap(), &emoji).unwrap();
        assert_eq!(c.cell(&emoji, 0).unwrap_err().reason, "expression.text_too_long");
    }

    #[test]
    fn huge_and_hostile_inputs_never_panic() {
        assert_eq!(fails(&"1+".repeat(1500)).reason, "expression.too_long");
        assert_eq!(fails(&format!("{}1{}", "(".repeat(100), ")".repeat(100))).reason, "expression.too_deep");
        assert_eq!(fails(&"-".repeat(200)).reason, "expression.too_deep");
        assert_eq!(fails(&"not ".repeat(100)).reason, "expression.too_deep");
        // A long flat chain is fine up to the depth limit, then refused instead of overflowing.
        assert!(parse(&vec!["1"; 60].join("+")).is_ok());
        assert_eq!(fails(&vec!["1"; 200].join("+")).reason, "expression.too_deep");
        assert_eq!(fails(&format!("concat({})", vec!["'a'"; 150].join(","))).reason, "expression.arguments_range");
        // Every prefix of these inputs either parses or answers a reason; none panics.
        let inputs = [
            "if(bezahlt and not isnull(land), round(betrag * 1.19, 2), coalesce(anzahl, -1)) ",
            "[Umsatz (€)] / startOf(zeit + 'x', \"month\") ^ -2 <> 'ä\\n' || !true",
            "concat(text(zeit), [a]]b], 1e308 * 10, 0.5e-3, ((((())))))",
            "\u{0}\u{1F600}\u{FEFF} [\u{202E}] 'unterminated \\",
        ];
        let fields = sample();
        for input in inputs {
            let chars: Vec<char> = input.chars().collect();
            for end in 0..=chars.len() {
                let text: String = chars[..end].iter().collect();
                if let Ok(expr) = parse(&text)
                    && let Ok(c) = compile(&expr, &fields)
                {
                    for row in 0..4 {
                        let _ = c.cell(&fields, row);
                    }
                }
            }
        }
        // Pseudo-random byte soup over the language's own characters.
        let alphabet: Vec<char> = "01.5e+-*/%^()[]'\",<>=!&|abz _ägn".chars().collect();
        let mut seed: u64 = 0x2545_F491_4F6C_DD1D;
        for _ in 0..3000 {
            let len = (seed % 40) as usize;
            let mut text = String::new();
            for _ in 0..len {
                seed ^= seed << 13;
                seed ^= seed >> 7;
                seed ^= seed << 17;
                text.push(alphabet[(seed % alphabet.len() as u64) as usize]);
            }
            if let Ok(expr) = parse(&text)
                && let Ok(c) = compile(&expr, &fields)
            {
                let _ = c.cell(&fields, 0);
            }
        }
    }

    #[test]
    fn parse_number_accepts_only_plain_numbers() {
        for (text, value) in [("1", 1.0), ("-1.5", -1.5), ("+.5", 0.5), ("2.", 2.0), (" 1e3 ", 1000.0), ("1E-2", 0.01)]
        {
            assert_eq!(parse_number(text), Some(value), "{text}");
        }
        for text in ["", " ", ".", "e5", "1e", "0x10", "inf", "NaN", "1_000", "1,5", "--1", "1e999", "١"] {
            assert_eq!(parse_number(text), None, "{text}");
        }
    }
}
