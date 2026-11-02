//! The read-only check for Cypher (Neo4j, Memgraph), on the token stream of a real lexer rather
//! than on patterns over the text: strings, backtick names, comments and parameters are tokens of
//! their own, so a keyword inside them is never seen, and a keyword outside them always is.
//!
//! What is accepted: exactly one statement that starts with a reading clause (`MATCH`,
//! `OPTIONAL MATCH`, `WITH`, `UNWIND`, `RETURN`, `CALL`, `FINISH`, `LET`, `FILTER`), optionally
//! after `EXPLAIN`, `PROFILE` or `CYPHER` options. Anywhere in it, also inside `CALL {}`,
//! `EXISTS {}`, `COUNT {}` and `COLLECT {}` subqueries, these are refused: the writing clauses
//! `CREATE`, `MERGE`, `DELETE`, `DETACH`, `NODETACH`, `SET`, `REMOVE` and `INSERT`, `FOREACH`
//! (whose body can only write), `LOAD` (`LOAD CSV` and Memgraph's other loaders), `USE` (another
//! database), `IN TRANSACTIONS` and `PERIODIC COMMIT`, and `CALL` of any procedure outside
//! `READ_PROCEDURES`. Administration commands (`SHOW`, `CREATE INDEX`, `DROP`, `GRANT`, `START
//! DATABASE`, Memgraph's `STORAGE MODE`, `FREE MEMORY`, `DUMP DATABASE`, ...) never start with a
//! reading clause, so they are refused by the first rule.
//!
//! A word is a keyword unless it is written in backticks, follows `.` (a property or a namespace)
//! or `:` (a label, relationship type or map value), or is followed by `:` (a map key). So a label
//! or property called `Set` or `create` works as `n:Set`, `n.create` and `{create: 1}`; elsewhere,
//! such as in label expressions after `|` or `&`, write it in backticks. When the lexer splits text
//! more finely than the database would (an unusual Unicode character inside a word), it sees more
//! keywords, never fewer, so a doubt refuses the query.
//!
//! This check is the second line. Neo4j runs every query in a read transaction, which the server
//! enforces; for Memgraph, which does not, the user's privileges are checked (see `neo4j.rs`).

use std::collections::BTreeSet;

use super::detail::Detail;

/// Read procedures that may be called; everything else is refused. Compared without regard to
/// case.
pub const READ_PROCEDURES: &[&str] = &[
    "db.labels",
    "db.relationshipTypes",
    "db.propertyKeys",
    "db.schema.visualization",
    "db.schema.nodeTypeProperties",
    "db.schema.relTypeProperties",
    "dbms.components",
    "schema.node_type_properties",
    "schema.rel_type_properties",
];

/// Clauses a query may start with.
const FIRST_CLAUSES: &[&str] = &["MATCH", "OPTIONAL", "WITH", "UNWIND", "RETURN", "CALL", "FINISH", "LET", "FILTER"];
const WRITE_CLAUSES: &[&str] = &["CREATE", "MERGE", "DELETE", "DETACH", "NODETACH", "SET", "REMOVE", "INSERT"];

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Tok {
    /// A name; `quoted` when written in backticks.
    Ident {
        text: String,
        quoted: bool,
    },
    /// `$name` or `` $`name` ``.
    Param(String),
    Str,
    Num,
    Sym(char),
}

fn reject(reason: &'static str, message: impl Into<String>) -> Detail {
    Detail::new(reason, message)
}

fn is_ident_start(c: char) -> bool {
    c.is_alphabetic() || c == '_'
}

fn is_ident_part(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// The tokens of a query. Unclosed strings, names and comments are refused.
pub fn lex(q: &str) -> Result<Vec<Tok>, Detail> {
    let chars: Vec<char> = q.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c.is_whitespace() {
            i += 1;
        } else if c == '/' && chars.get(i + 1) == Some(&'/') {
            while i < chars.len() && !matches!(chars[i], '\n' | '\r' | '\u{85}' | '\u{2028}' | '\u{2029}') {
                i += 1;
            }
        } else if c == '/' && chars.get(i + 1) == Some(&'*') {
            let mut j = i + 2;
            loop {
                if j + 1 >= chars.len() {
                    return Err(reject("cypher.unclosed_comment", "a /* comment is not closed"));
                }
                if chars[j] == '*' && chars[j + 1] == '/' {
                    break;
                }
                j += 1;
            }
            i = j + 2;
        } else if c == '\'' || c == '"' {
            let mut j = i + 1;
            loop {
                match chars.get(j) {
                    None => return Err(reject("cypher.unclosed_quote", "a string is not closed")),
                    Some('\\') => j += 2,
                    Some(&d) if d == c => break,
                    Some(_) => j += 1,
                }
            }
            out.push(Tok::Str);
            i = j + 1;
        } else if c == '`' {
            let (text, end) = backtick(&chars, i)?;
            out.push(Tok::Ident { text, quoted: true });
            i = end;
        } else if c == '$' {
            match chars.get(i + 1) {
                Some('`') => {
                    let (text, end) = backtick(&chars, i + 1)?;
                    out.push(Tok::Param(text));
                    i = end;
                }
                // `$0`: a numbered parameter is digits only, as the database reads it.
                Some(d) if d.is_ascii_digit() => {
                    let mut j = i + 1;
                    while j < chars.len() && chars[j].is_ascii_digit() {
                        j += 1;
                    }
                    glued(&chars, j)?;
                    out.push(Tok::Param(chars[i + 1..j].iter().collect()));
                    i = j;
                }
                Some(&d) if is_ident_start(d) => {
                    let mut j = i + 1;
                    while j < chars.len() && is_ident_part(chars[j]) {
                        j += 1;
                    }
                    out.push(Tok::Param(chars[i + 1..j].iter().collect()));
                    i = j;
                }
                _ => {
                    out.push(Tok::Sym('$'));
                    i += 1;
                }
            }
        } else if is_ident_start(c) {
            let mut j = i;
            while j < chars.len() && is_ident_part(chars[j]) {
                j += 1;
            }
            out.push(Tok::Ident { text: chars[i..j].iter().collect(), quoted: false });
            i = j;
        } else if c.is_ascii_digit() {
            let j = number_end(&chars, i);
            glued(&chars, j)?;
            out.push(Tok::Num);
            i = j;
        } else {
            out.push(Tok::Sym(c));
            i += 1;
        }
    }
    Ok(out)
}

/// The end of a number literal at `i`: `0x1F`, `0o17`, `1_000`, `1.5`, `1e-3`, `1.5E+3`.
fn number_end(chars: &[char], i: usize) -> usize {
    let run = |mut j: usize, ok: &dyn Fn(char) -> bool| {
        while j < chars.len() && (ok(chars[j]) || chars[j] == '_') {
            j += 1;
        }
        j
    };
    if chars[i] == '0' && matches!(chars.get(i + 1), Some('x' | 'X')) {
        return run(i + 2, &|c| c.is_ascii_hexdigit());
    }
    if chars[i] == '0' && matches!(chars.get(i + 1), Some('o' | 'O')) {
        return run(i + 2, &|c| ('0'..='7').contains(&c));
    }
    let mut j = run(i, &|c| c.is_ascii_digit());
    // A fraction, but not the `..` of a range such as `*1..3`.
    if chars.get(j) == Some(&'.') && chars.get(j + 1).is_some_and(char::is_ascii_digit) {
        j = run(j + 1, &|c| c.is_ascii_digit());
    }
    if matches!(chars.get(j), Some('e' | 'E')) {
        let sign = usize::from(matches!(chars.get(j + 1), Some('+' | '-')));
        if chars.get(j + 1 + sign).is_some_and(char::is_ascii_digit) {
            j = run(j + 1 + sign, &|c| c.is_ascii_digit());
        }
    }
    j
}

/// A number with letters glued to it (`1DELETE`, `LIMIT 1SET`) is refused: the database reads
/// the letters as the next word, so they could hide a keyword.
fn glued(chars: &[char], end: usize) -> Result<(), Detail> {
    match chars.get(end) {
        Some(&c) if is_ident_part(c) => Err(reject(
            "cypher.number_followed_by_letters",
            "a number is directly followed by letters; put a space between them",
        )),
        _ => Ok(()),
    }
}

/// A backtick name starting at `start`; ``` `` ``` is one backtick. Answers the name and the
/// index after it.
fn backtick(chars: &[char], start: usize) -> Result<(String, usize), Detail> {
    let mut text = String::new();
    let mut j = start + 1;
    loop {
        match chars.get(j) {
            None => return Err(reject("cypher.unclosed_backtick", "a `name` is not closed")),
            Some('`') if chars.get(j + 1) == Some(&'`') => {
                text.push('`');
                j += 2;
            }
            Some('`') => return Ok((text, j + 1)),
            Some(&c) => {
                text.push(c);
                j += 1;
            }
        }
    }
}

/// What the check learned: the parameters the query uses.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Checked {
    pub params: BTreeSet<String>,
    /// Parameters used as names rather than values: inside a dynamic label or relationship type
    /// (`n:$($label)`, `$any($types)`, `$all(...)`, Neo4j 5.26 and later) or a dynamic property
    /// key (`n[$key]`, also a list index or slice, which reads the same). They decide what the
    /// query reads, like `${x:identifier}` in SQL, so the same rule applies to them (see
    /// `neo4j::parameters`).
    pub identifier_params: BTreeSet<String>,
}

/// Words after which `[` starts a list literal (`IN [$a]`, `RETURN [$a]`), not a subscript.
const BEFORE_LIST: &[&str] = &[
    "AND", "AS", "BY", "CASE", "CONTAINS", "DISTINCT", "ELSE", "ENDS", "FILTER", "IN", "IS", "LET", "LIMIT", "NOT",
    "OFFSET", "OR", "ORDER", "RETURN", "SET", "SKIP", "STARTS", "THEN", "UNWIND", "WHEN", "WHERE", "WITH", "XOR",
    "YIELD",
];

/// Whether a token can end an expression, so that a `[` right after it is a subscript
/// (`n[$key]`, `list[$i]`, `f(x)[$k]`) rather than a list or a relationship pattern (`-[r]-`).
fn ends_expression(t: &Tok) -> bool {
    match t {
        Tok::Ident { text, quoted } => *quoted || !BEFORE_LIST.iter().any(|w| text.eq_ignore_ascii_case(w)),
        Tok::Param(_) | Tok::Str | Tok::Sym(')' | ']' | '}') => true,
        _ => false,
    }
}

/// Where a part that names what the query reads opens, if at `i`: the index of its bracket and
/// the closing character. A dynamic label or type: `$(` lexes as the symbol `$`, `$any(` and
/// `$all(` as a parameter followed by `(` (never valid otherwise). A dynamic property key: `[`
/// right after an expression.
fn dynamic_open(toks: &[Tok], i: usize) -> Option<(usize, char)> {
    match (&toks[i], toks.get(i + 1)) {
        (Tok::Sym('$'), Some(Tok::Sym('('))) => Some((i + 1, ')')),
        (Tok::Param(p), Some(Tok::Sym('('))) if p.eq_ignore_ascii_case("any") || p.eq_ignore_ascii_case("all") => {
            Some((i + 1, ')'))
        }
        (Tok::Sym('['), _) if i > 0 && ends_expression(&toks[i - 1]) => Some((i, ']')),
        _ => None,
    }
}

/// For each token: whether it is the parameter-like marker of a dynamic label (`$any`), and
/// whether it is inside a dynamic label, type or property key.
fn dynamic_spans(toks: &[Tok]) -> (Vec<bool>, Vec<bool>) {
    let marker: Vec<bool> = (0..toks.len())
        .map(|i| dynamic_open(toks, i).is_some_and(|(open, _)| open == i + 1) && matches!(toks[i], Tok::Param(_)))
        .collect();
    let mut inside = vec![false; toks.len()];
    for (open, close) in (0..toks.len()).filter_map(|i| dynamic_open(toks, i)) {
        let start = if close == ')' { '(' } else { '[' };
        let mut depth = 0usize;
        for (j, t) in toks.iter().enumerate().skip(open) {
            inside[j] = true;
            match t {
                Tok::Sym(c) if *c == start => depth += 1,
                Tok::Sym(c) if *c == close => {
                    depth -= 1;
                    if depth == 0 {
                        break;
                    }
                }
                _ => {}
            }
        }
    }
    (marker, inside)
}

/// The keyword at `i`, upper case, or `None` when the token is a name there.
fn keyword(toks: &[Tok], i: usize) -> Option<String> {
    let Tok::Ident { text, quoted: false } = &toks[i] else { return None };
    if i > 0 && matches!(toks[i - 1], Tok::Sym('.') | Tok::Sym(':')) {
        return None;
    }
    if matches!(toks.get(i + 1), Some(Tok::Sym(':'))) {
        return None;
    }
    Some(text.to_uppercase())
}

fn is_word(t: &Tok, word: &str) -> bool {
    matches!(t, Tok::Ident { text, quoted: false } if text.eq_ignore_ascii_case(word))
}

/// Checks that `q` is one read-only statement (see the module documentation).
pub fn check(q: &str) -> Result<Checked, Detail> {
    let mut toks = lex(q)?;
    while matches!(toks.last(), Some(Tok::Sym(';'))) {
        toks.pop();
    }
    if toks.is_empty() {
        return Err(reject("cypher.empty", "the query is empty"));
    }
    if toks.contains(&Tok::Sym(';')) {
        return Err(reject("cypher.multiple_statements", "send one statement at a time"));
    }
    let first = first_clause(&toks);
    let starts_reading = first.is_some_and(|i| keyword(&toks, i).is_some_and(|k| FIRST_CLAUSES.contains(&k.as_str())));
    if !starts_reading {
        let word = first.and_then(|i| match &toks[i] {
            Tok::Ident { text, .. } => Some(text.clone()),
            _ => None,
        });
        let detail = reject(
            "cypher.not_read_query",
            format!(
                "a query must start with MATCH, OPTIONAL MATCH, WITH, UNWIND, RETURN or CALL{}",
                word.as_ref().map(|w| format!(", not {w}")).unwrap_or_default()
            ),
        );
        return Err(detail.with("keyword", word.unwrap_or_default()));
    }
    let mut checked = Checked::default();
    let (marker, dynamic) = dynamic_spans(&toks);
    for i in 0..toks.len() {
        if let Tok::Param(name) = &toks[i]
            && !marker[i]
        {
            checked.params.insert(name.clone());
            if dynamic[i] {
                checked.identifier_params.insert(name.clone());
            }
        }
        let Some(k) = keyword(&toks, i) else { continue };
        match k.as_str() {
            w if WRITE_CLAUSES.contains(&w) => {
                return Err(
                    reject("cypher.write_clause", format!("{w} writes data; Kalzit only reads")).with("clause", w)
                );
            }
            "FOREACH" => return Err(reject("cypher.foreach", "FOREACH can only write; Kalzit only reads")),
            "LOAD" => return Err(reject("cypher.load", "LOAD reads files or URLs on the server and is not allowed")),
            "USE" => {
                return Err(reject(
                    "cypher.use",
                    "USE selects another database; the data source's settings choose the database",
                ));
            }
            "PERIODIC" => return Err(reject("cypher.in_transactions", "PERIODIC COMMIT writes in batches")),
            "TRANSACTIONS" if in_transactions_clause(&toks, i) => {
                return Err(reject("cypher.in_transactions", "CALL { } IN TRANSACTIONS writes in batches"));
            }
            "CALL" => check_call(&toks, i)?,
            _ => {}
        }
    }
    for i in 0..toks.len() {
        check_function(&toks, i)?;
    }
    Ok(checked)
}

/// The index of the first clause, after `EXPLAIN`, `PROFILE` and `CYPHER` with its options
/// (`CYPHER 5`, `CYPHER runtime=slotted`).
fn first_clause(toks: &[Tok]) -> Option<usize> {
    let mut i = 0;
    loop {
        match toks.get(i) {
            Some(t) if is_word(t, "EXPLAIN") || is_word(t, "PROFILE") => i += 1,
            Some(t) if is_word(t, "CYPHER") => {
                i += 1;
                loop {
                    match (toks.get(i), toks.get(i + 1)) {
                        (Some(Tok::Num), _) => i += 1,
                        (Some(Tok::Ident { .. }), Some(Tok::Sym('='))) => i += 3,
                        _ => break,
                    }
                }
            }
            Some(_) => return Some(i),
            None => return None,
        }
    }
}

/// `} IN TRANSACTIONS`, `} IN 4 CONCURRENT TRANSACTIONS`, `} IN CONCURRENT TRANSACTIONS` (with
/// `$n` or an expression in brackets as the count): the clause after a `CALL` subquery, not a
/// variable named `transactions`.
fn in_transactions_clause(toks: &[Tok], i: usize) -> bool {
    let mut j = i;
    if j > 0 && is_word(&toks[j - 1], "CONCURRENT") {
        j -= 1;
        match toks.get(j.wrapping_sub(1)) {
            Some(Tok::Num | Tok::Param(_)) => j -= 1,
            Some(Tok::Sym(')')) => {
                // `IN (expression) CONCURRENT TRANSACTIONS`: back to the matching `(`.
                let mut depth = 0usize;
                while j > 0 {
                    j -= 1;
                    match toks[j] {
                        Tok::Sym(')') => depth += 1,
                        Tok::Sym('(') => {
                            depth -= 1;
                            if depth == 0 {
                                break;
                            }
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }
    j >= 2 && is_word(&toks[j - 1], "IN") && toks[j - 2] == Tok::Sym('}')
}

/// Words that stand before `(` without naming a function: clauses, operators, path modes.
const NOT_FUNCTIONS: &[&str] = &[
    "MATCH",
    "OPTIONAL",
    "WHERE",
    "AND",
    "OR",
    "XOR",
    "NOT",
    "IN",
    "RETURN",
    "WITH",
    "UNWIND",
    "AS",
    "CASE",
    "WHEN",
    "THEN",
    "ELSE",
    "END",
    "IS",
    "DISTINCT",
    "ON",
    "BY",
    "SKIP",
    "LIMIT",
    "OFFSET",
    "ORDER",
    "YIELD",
    "UNION",
    "CALL",
    "SHORTEST",
    "PATH",
    "PATHS",
    "WALK",
    "TRAIL",
    "ACYCLIC",
    "SIMPLE",
    "REPEATABLE",
    "DIFFERENT",
    "ELEMENTS",
    "FINISH",
    "LET",
    "NEXT",
    "EXPLAIN",
    "PROFILE",
    "STARTS",
    "ENDS",
    "CONTAINS",
    "ASC",
    "DESC",
    "ASCENDING",
    "DESCENDING",
    "GROUP",
    "GROUPS",
    "KEEP",
    "ROWS",
    "OF",
];

/// Cypher's built-in functions (Neo4j and Memgraph), compared without regard to case.
const FUNCTIONS: &[&str] = &[
    "abs",
    "acos",
    "all",
    "allshortestpaths",
    "any",
    "asin",
    "atan",
    "atan2",
    "avg",
    "btrim",
    "ceil",
    "char_length",
    "character_length",
    "coalesce",
    "collect",
    "contains",
    "cos",
    "cot",
    "count",
    "date",
    "datetime",
    "degrees",
    "duration",
    "e",
    "elementid",
    "endnode",
    "endswith",
    "exists",
    "exp",
    "extract",
    "filter",
    "floor",
    "haversin",
    "head",
    "id",
    "isempty",
    "isnan",
    "keys",
    "labels",
    "last",
    "left",
    "length",
    "localdatetime",
    "localtime",
    "log",
    "log10",
    "lower",
    "ltrim",
    "max",
    "min",
    "nodes",
    "none",
    "normalize",
    "nullif",
    "percentilecont",
    "percentiledisc",
    "pi",
    "point",
    "properties",
    "radians",
    "rand",
    "randomuuid",
    "range",
    "reduce",
    "relationships",
    "replace",
    "reverse",
    "right",
    "round",
    "rtrim",
    "shortestpath",
    "sign",
    "sin",
    "single",
    "size",
    "split",
    "sqrt",
    "startnode",
    "startswith",
    "stdev",
    "stdevp",
    "substring",
    "sum",
    "tail",
    "tan",
    "time",
    "timestamp",
    "toboolean",
    "tobooleanlist",
    "tobooleanornull",
    "tofloat",
    "tofloatlist",
    "tofloatornull",
    "tointeger",
    "tointegerlist",
    "tointegerornull",
    "tolower",
    "toset",
    "tostring",
    "tostringlist",
    "tostringornull",
    "toupper",
    "trim",
    "type",
    "upper",
    "valuetype",
];

/// Namespaced functions: an entry ending in `.` allows the namespace, any other entry exactly that
/// function. The temporal and spatial built-ins and APOC's pure helpers.
/// Not here, so refused: `apoc.cypher.*` (runs Cypher given as text), `apoc.load.*`,
/// `apoc.export.*`, `apoc.periodic.*`, `apoc.trigger.*`, `apoc.schema.*`, `dbms.*`, `db.*`.
const FUNCTION_PREFIXES: &[&str] = &[
    "date.",
    "datetime.",
    "localdatetime.",
    "localtime.",
    "time.",
    "duration.",
    "point.",
    "vector.similarity.",
    "apoc.coll.",
    "apoc.text.",
    "apoc.map.",
    "apoc.math.",
    "apoc.convert.",
    "apoc.date.",
    "apoc.temporal.",
    "apoc.number.",
    "apoc.agg.",
    "apoc.label.",
    "apoc.node.degree",
    "apoc.node.degree.in",
    "apoc.node.degree.out",
    "apoc.node.labels",
    "apoc.rel.type",
    "apoc.hashing.",
    "apoc.util.md5",
    "apoc.util.sha1",
    "apoc.util.sha256",
    "apoc.util.sha384",
    "apoc.util.sha512",
    "apoc.meta.cypher.",
];

/// A function call (a name, possibly dotted, before `(`) must be a built-in or on the list of
/// namespaced functions. A name right after `CALL` is a procedure, not a function: it is skipped
/// here because `check_call` holds it to the stricter `READ_PROCEDURES` list (tested in
/// `procedures_are_checked_by_check_call`).
fn check_function(toks: &[Tok], i: usize) -> Result<(), Detail> {
    if !matches!(toks.get(i), Some(Tok::Ident { .. })) || toks.get(i + 1) != Some(&Tok::Sym('(')) {
        return Ok(());
    }
    let mut start = i;
    while start >= 2 && toks[start - 1] == Tok::Sym('.') && matches!(toks[start - 2], Tok::Ident { .. }) {
        start -= 2;
    }
    if start > 0 && is_word(&toks[start - 1], "CALL") {
        return Ok(());
    }
    let name: String = toks[start..=i]
        .iter()
        .filter_map(|t| match t {
            Tok::Ident { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join(".");
    let single_keyword = start == i
        && matches!(&toks[i], Tok::Ident { text, quoted: false } if NOT_FUNCTIONS.contains(&text.to_uppercase().as_str()));
    let lower = name.to_lowercase();
    if single_keyword
        || FUNCTIONS.contains(&lower.as_str())
        || FUNCTION_PREFIXES.iter().any(|p| if p.ends_with('.') { lower.starts_with(p) } else { lower == *p })
    {
        return Ok(());
    }
    Err(reject("cypher.function_not_allowed", format!("the function {name} is not on the list of allowed functions"))
        .with("name", name))
}

/// `CALL {` and `CALL (...) {` are subqueries, checked with the rest of the query. Any other
/// `CALL` names a procedure, which must be a read procedure.
fn check_call(toks: &[Tok], i: usize) -> Result<(), Detail> {
    match toks.get(i + 1) {
        Some(Tok::Sym('{')) | Some(Tok::Sym('(')) => return Ok(()),
        _ => {}
    }
    let mut parts = Vec::new();
    let mut j = i + 1;
    while let Some(Tok::Ident { text, .. }) = toks.get(j) {
        parts.push(text.clone());
        if toks.get(j + 1) != Some(&Tok::Sym('.')) {
            break;
        }
        j += 2;
    }
    if parts.is_empty() {
        return Err(reject("cypher.parse_error", "CALL must be followed by a procedure name or a subquery"));
    }
    let name = parts.join(".");
    if READ_PROCEDURES.iter().any(|p| p.eq_ignore_ascii_case(&name)) {
        Ok(())
    } else {
        Err(reject(
            "cypher.procedure_not_allowed",
            format!("the procedure {name} is not on the list of read procedures"),
        )
        .with("name", name))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn refused(q: &str) -> &'static str {
        match check(q) {
            Ok(c) => panic!("accepted: {q} ({c:?})"),
            Err(d) => d.reason,
        }
    }

    #[test]
    fn reading_queries_pass() {
        for q in [
            "MATCH (n:Person) RETURN n LIMIT 10",
            "match (n) return n;",
            "MATCH p = (a)-[:KNOWS*1..3]->(b) WHERE a.name = $name RETURN p",
            "OPTIONAL MATCH (n) WITH n UNWIND [1, 2] AS x RETURN x",
            "RETURN 'CREATE (n) DELETE n' AS text, \"SET x\" AS other",
            "MATCH (n:`CREATE`)-[:`DELETE`]->(m:Set) RETURN n.create, n.`set`, m",
            "RETURN {set: 1, delete: 2, create: 3} AS m",
            "MATCH (n) // CREATE (x)\nRETURN n /* DELETE n */",
            "EXPLAIN MATCH (n) RETURN n",
            "PROFILE MATCH (n) RETURN count(n)",
            "CYPHER 5 MATCH (n) RETURN n",
            "CYPHER runtime=slotted planner=cost MATCH (n) RETURN n",
            "CALL db.labels() YIELD label RETURN label",
            "CALL db.labels",
            "CALL `db`.`labels`()",
            "CALL DB.LABELS()",
            "CALL db.schema.visualization()",
            "MATCH (n) CALL { WITH n MATCH (n)--(m) RETURN count(m) AS c } RETURN n, c",
            "MATCH (n) CALL (n) { MATCH (n)--(m) RETURN m } RETURN m",
            "MATCH (n) WHERE EXISTS { MATCH (n)-->() } AND COUNT { (n)-->() } > 1 RETURN n",
            "MATCH (start)-[r]->(end) RETURN start, end, r.since",
            "MATCH (n) RETURN n ORDER BY n.name SKIP 1 LIMIT 2 UNION MATCH (m) RETURN m AS n",
            "MATCH (n) WHERE n.name =~ 'a.*' RETURN apoc.text.join([n.name], ',')",
            "MATCH (n) RETURN n.x IN [1.5, 2..3]",
            "RETURN 'it\\'s' AS s",
            "WITH 1 AS ünïcödé RETURN ünïcödé",
            "MATCH (n:$($label)) RETURN n",
            "RETURN 0x1F, 0o17, 1e5, 1.5E-3, 2e+2, 1_000, 3.14 AS n",
            "MATCH (n) WHERE n.id = $0 OR n.id = $p1 RETURN n LIMIT 1",
            "MATCH p = shortestPath((a)-[*]-(b)) RETURN nodes(p), relationships(p), length(p)",
            "RETURN toUpper('a'), date.truncate('month', date()), duration.between(date(), date()), point.distance(point({x: 1, y: 2}), point({x: 0, y: 0}))",
            "MATCH (n) WHERE all(x IN n.tags WHERE x <> '') AND (n)-->() RETURN coalesce(n.a, 1), apoc.coll.sum([1, 2])",
            "MATCH (n) RETURN `toLower`(n.name)",
        ] {
            assert!(check(q).is_ok(), "{q}: {:?}", check(q));
        }
    }

    #[test]
    fn parameters_are_collected() {
        let c = check("MATCH (n) WHERE n.id IN $ids AND n.t > $__timeFrom AND n.x = $`odd name` RETURN n").unwrap();
        assert_eq!(c.params, ["__timeFrom", "ids", "odd name"].map(String::from).into());
        assert!(c.identifier_params.is_empty());
    }

    #[test]
    fn parameters_in_dynamic_labels_are_identifiers() {
        let c =
            check("MATCH (n:$($label))-[r:$any($types)]->(m:$all(['A', $other])) WHERE n.id = $id RETURN n").unwrap();
        assert_eq!(c.params, ["id", "label", "other", "types"].map(String::from).into());
        assert_eq!(c.identifier_params, ["label", "other", "types"].map(String::from).into());
        // Dynamic property keys and indexes; lists and patterns are not.
        let c = check(
            "MATCH (n)-[r]->(m) WHERE n[$key] = $value AND $v IN [$a, $b] AND n.tags[$i] IS NOT NULL \
             RETURN [$c], n[$k2 + 'x'], m['name'] AS name",
        )
        .unwrap();
        assert_eq!(c.identifier_params, ["i", "k2", "key"].map(String::from).into());
        // A parameter that happens to be called any is a value where no `(` follows.
        let c = check("MATCH (n) WHERE n.x = $any RETURN n").unwrap();
        assert_eq!(c.params, ["any".to_string()].into());
        assert!(c.identifier_params.is_empty());
    }

    #[test]
    fn writes_are_refused_wherever_they_hide() {
        for (q, reason) in [
            ("CREATE (n)", "cypher.not_read_query"),
            ("MATCH (n) CREATE (m)", "cypher.write_clause"),
            ("MATCH (n) cReAtE (m)", "cypher.write_clause"),
            ("MATCH (n) MERGE (m:X {a: 1})", "cypher.write_clause"),
            ("MATCH (n) DELETE n", "cypher.write_clause"),
            ("MATCH (n) DETACH DELETE n", "cypher.write_clause"),
            ("MATCH (n) NODETACH DELETE n", "cypher.write_clause"),
            ("MATCH (n) SET n.x = 1", "cypher.write_clause"),
            ("MATCH (n) SET n:Admin", "cypher.write_clause"),
            ("MATCH (n) REMOVE n.x", "cypher.write_clause"),
            ("MATCH (n) INSERT (m)", "cypher.write_clause"),
            ("MATCH (n) /* harmless */ DELETE /**/ n", "cypher.write_clause"),
            ("MATCH (n) // x\nDELETE n", "cypher.write_clause"),
            ("MATCH (n)\u{00A0}DELETE\u{00A0}n", "cypher.write_clause"),
            ("MATCH (n)\u{2028}SET n.x=1", "cypher.write_clause"),
            ("MATCH (n) RETURN n UNION MATCH (m) DELETE m", "cypher.write_clause"),
            ("MATCH (n) CALL { CREATE (m) } RETURN n", "cypher.write_clause"),
            ("MATCH (n) CALL { CALL { MATCH (x) SET x.a = 1 } } RETURN n", "cypher.write_clause"),
            ("MATCH (n) CALL (n) { DETACH DELETE n }", "cypher.write_clause"),
            ("MATCH (n) WHERE EXISTS { MATCH (n) SET n.x = 1 } RETURN n", "cypher.write_clause"),
            ("MATCH (n) WITH n CALL { WITH n DELETE n } IN TRANSACTIONS", "cypher.write_clause"),
            ("MATCH (n) CALL { MATCH (m) RETURN m } IN TRANSACTIONS OF 10 ROWS RETURN n", "cypher.in_transactions"),
            ("MATCH (n) FOREACH (x IN [1] | CREATE ())", "cypher.foreach"),
            ("MATCH (n) WITH n LOAD CSV FROM 'file:///etc/passwd' AS l RETURN l", "cypher.load"),
            ("WITH 1 AS x LOAD CSV FROM 'http://x' AS l RETURN l", "cypher.load"),
            ("USE other MATCH (n) RETURN n", "cypher.not_read_query"),
            ("MATCH (n) CALL { USE other MATCH (m) RETURN m } RETURN n", "cypher.use"),
            ("MATCH (n) RETURN n; MATCH (m) DELETE m", "cypher.multiple_statements"),
            ("MATCH (n) RETURN n; DROP INDEX x", "cypher.multiple_statements"),
            ("CALL apoc.create.node(['X'], {})", "cypher.procedure_not_allowed"),
            ("CALL dbms.killQuery('x')", "cypher.procedure_not_allowed"),
            (
                "MATCH (n) CALL apoc.periodic.iterate('MATCH (x) RETURN x', 'DELETE x', {})",
                "cypher.procedure_not_allowed",
            ),
            ("CALL `apoc`.`create`.`node`(['X'], {})", "cypher.procedure_not_allowed"),
            ("CALL mg.load_all()", "cypher.procedure_not_allowed"),
            ("MATCH (n) WITH n, 1DELETE n", "cypher.number_followed_by_letters"),
            ("MATCH (n) RETURN n LIMIT 1SET n.x = 1", "cypher.number_followed_by_letters"),
            ("MATCH (n) RETURN n LIMIT 1CALL dbms.killQueries(['x'])", "cypher.number_followed_by_letters"),
            (
                "MATCH (n) RETURN n LIMIT 1LOAD CSV FROM 'file:///etc/passwd' AS l RETURN l",
                "cypher.number_followed_by_letters",
            ),
            ("MATCH (n) WHERE n.x = $1DELETE n", "cypher.number_followed_by_letters"),
            ("RETURN 0x1G", "cypher.number_followed_by_letters"),
            ("RETURN 1.5e3x", "cypher.number_followed_by_letters"),
            ("MATCH (n) // Kommentar\u{2028}DELETE n", "cypher.write_clause"),
            ("MATCH (n) // Kommentar\u{85}DELETE n", "cypher.write_clause"),
            ("MATCH (n) // Kommentar\u{2029}DELETE n", "cypher.write_clause"),
            ("MATCH (n) CALL { MATCH (m) RETURN m } IN 4 CONCURRENT TRANSACTIONS RETURN n", "cypher.in_transactions"),
            ("MATCH (n) CALL { MATCH (m) RETURN m } IN CONCURRENT TRANSACTIONS RETURN n", "cypher.in_transactions"),
            ("RETURN apoc.cypher.runFirstColumnSingle('MATCH (n) DETACH DELETE n', {})", "cypher.function_not_allowed"),
            ("RETURN apoc.cypher.runFirstColumnMany('CREATE ()', {})", "cypher.function_not_allowed"),
            ("RETURN `apoc`.`cypher`.`runFirstColumn`('CREATE ()', {})", "cypher.function_not_allowed"),
            ("RETURN apoc.load.json('http://x')", "cypher.function_not_allowed"),
            ("RETURN apoc.export.csv.all('x', {})", "cypher.function_not_allowed"),
            ("RETURN apoc.periodic.list()", "cypher.function_not_allowed"),
            ("RETURN apoc.trigger.list()", "cypher.function_not_allowed"),
            ("RETURN apoc.schema.assert({}, {})", "cypher.function_not_allowed"),
            ("RETURN dbms.listConfig()", "cypher.function_not_allowed"),
            ("RETURN db.createLabel('X')", "cypher.function_not_allowed"),
            ("RETURN eigeneFunktion(1)", "cypher.function_not_allowed"),
            ("RETURN apoc.util.md5x(['a'])", "cypher.function_not_allowed"),
            ("RETURN apoc.node.labelsAndMore(n)", "cypher.function_not_allowed"),
            ("MATCH (n) CALL { MATCH (m) RETURN m } IN $n CONCURRENT TRANSACTIONS RETURN n", "cypher.in_transactions"),
            (
                "MATCH (n) CALL { MATCH (m) RETURN m } IN (2 + 2) CONCURRENT TRANSACTIONS RETURN n",
                "cypher.in_transactions",
            ),
            ("CALL", "cypher.parse_error"),
            ("SHOW USERS", "cypher.not_read_query"),
            ("SHOW TRANSACTIONS", "cypher.not_read_query"),
            ("CREATE INDEX FOR (n:X) ON (n.a)", "cypher.not_read_query"),
            ("DROP DATABASE neo4j", "cypher.not_read_query"),
            ("GRANT ROLE admin TO kalzit", "cypher.not_read_query"),
            ("START DATABASE x", "cypher.not_read_query"),
            ("STORAGE MODE IN_MEMORY_ANALYTICAL", "cypher.not_read_query"),
            ("FREE MEMORY", "cypher.not_read_query"),
            ("DUMP DATABASE", "cypher.not_read_query"),
            ("BEGIN", "cypher.not_read_query"),
            ("EXPLAIN CREATE (n)", "cypher.not_read_query"),
            ("PROFILE MATCH (n) DELETE n", "cypher.write_clause"),
            ("CYPHER 5 MATCH (n) SET n.a = 1", "cypher.write_clause"),
            ("USING PERIODIC COMMIT LOAD CSV FROM 'x' AS l CREATE ()", "cypher.not_read_query"),
            ("MATCH (n) USING PERIODIC COMMIT", "cypher.in_transactions"),
            ("MATCH (n:A|Set) RETURN n", "cypher.write_clause"),
            ("", "cypher.empty"),
            (" ; ", "cypher.empty"),
            ("// nur ein Kommentar", "cypher.empty"),
            ("MATCH (n) RETURN 'offen", "cypher.unclosed_quote"),
            ("MATCH (n) RETURN \"offen\\\"", "cypher.unclosed_quote"),
            ("MATCH (n) /* offen", "cypher.unclosed_comment"),
            ("MATCH (n:`offen) RETURN n", "cypher.unclosed_backtick"),
            ("(n) RETURN n", "cypher.not_read_query"),
        ] {
            assert_eq!(refused(q), reason, "{q}");
        }
    }

    #[test]
    fn variables_may_be_called_transactions() {
        for q in [
            "MATCH (t) WITH collect(t) AS transactions RETURN size(transactions)",
            "UNWIND [1, 2] AS concurrent RETURN concurrent",
            "MATCH (n) WHERE n.id IN transactions RETURN n",
            "RETURN apoc.util.md5(['a']), apoc.node.degree.in(null)",
        ] {
            assert!(check(q).is_ok(), "{q}: {:?}", check(q));
        }
    }

    #[test]
    fn procedures_are_checked_by_check_call() {
        // Names after CALL are procedures; check_function leaves them to check_call, whose list
        // is stricter: a harmless function name is still no allowed procedure.
        for q in ["CALL apoc.util.md5(['a'])", "CALL apoc.cypher.run('CREATE ()', {})", "CALL toUpper('a')"] {
            assert_eq!(refused(q), "cypher.procedure_not_allowed", "{q}");
        }
        assert!(check("CALL db.labels() YIELD label RETURN toUpper(label)").is_ok());
    }

    /// The explorer-mode expand queries of the graph panel (`ui/src/panels/graph/adapter.ts`,
    /// `expandQuery`), with the smallest, a usual and the largest limit it produces.
    #[test]
    fn graph_panel_expand_queries_pass() {
        for limit in [1, 25, 200] {
            for q in [
                format!("MATCH (n)-[r]-(m) WHERE elementId(n) = $nodeId RETURN n, r, m LIMIT {limit}"),
                format!("MATCH (n)-[r]-(m) WHERE id(n) = toInteger($nodeId) RETURN n, r, m LIMIT {limit}"),
            ] {
                let checked = check(&q).unwrap_or_else(|e| panic!("{q}: {e:?}"));
                assert_eq!(checked.params, ["nodeId".to_string()].into(), "{q}");
            }
        }
    }

    #[test]
    fn strings_hide_nothing_from_the_lexer() {
        // The backslash escapes the quote, so DELETE is still inside the string.
        assert!(check(r"RETURN 'a\' DELETE n //' AS s").is_ok());
        // Here the string ends before DELETE.
        assert_eq!(refused(r"MATCH (n) WITH 'a\\' AS s DELETE n"), "cypher.write_clause");
        // A doubled backtick stays inside the name.
        assert!(check("MATCH (n:`a`` DELETE n`) RETURN n").is_ok());
        assert_eq!(refused("MATCH (n:`a``) DELETE n"), "cypher.unclosed_backtick");
    }
}

/// The checker sees every query text a user can type: it answers with a result or a refusal,
/// never a panic.
#[cfg(test)]
mod property_tests {
    use super::*;
    use proptest::prelude::*;

    /// Text built from the pieces the lexer cares about, so cases reach past the first token.
    fn cypher_like() -> impl Strategy<Value = String> {
        let piece = prop_oneof![
            prop::sample::select(vec![
                "MATCH ",
                "RETURN ",
                "CALL ",
                "WITH ",
                "UNWIND ",
                "IN TRANSACTIONS ",
                "LOAD CSV ",
                "{",
                "}",
                "(",
                ")",
                "[",
                "]",
                "`",
                "'",
                "\"",
                "\\",
                "$",
                "//",
                "/*",
                "*/",
                ".",
                "..",
                "1e",
                "0x",
                ";",
                "-[",
                "]->",
            ])
            .prop_map(str::to_string),
            "[a-zA-Z_0-9 .:,-]{0,6}",
            "\\PC{0,3}",
        ];
        prop::collection::vec(piece, 0..24).prop_map(|p| p.concat())
    }

    proptest! {
        // 256 cases (proptest's default), bounded for CI; PROPTEST_CASES raises it locally.
        #![proptest_config(ProptestConfig::default())]

        #[test]
        fn check_never_panics_on_any_text(q in "\\PC{0,200}") {
            let _ = check(&q);
        }

        #[test]
        fn check_never_panics_on_cypher_like_text(q in cypher_like()) {
            let _ = check(&q);
        }
    }
}
