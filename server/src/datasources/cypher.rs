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
            while i < chars.len() && chars[i] != '\n' && chars[i] != '\r' {
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
                Some(&d) if is_ident_part(d) => {
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
            let mut j = i;
            while j < chars.len() && (chars[j].is_ascii_alphanumeric() || chars[j] == '_') {
                j += 1;
            }
            // A fraction, but not the `..` of a range such as `*1..3`.
            if chars.get(j) == Some(&'.') && chars.get(j + 1).is_some_and(char::is_ascii_digit) {
                j += 1;
                while j < chars.len() && (chars[j].is_ascii_alphanumeric() || chars[j] == '_') {
                    j += 1;
                }
            }
            out.push(Tok::Num);
            i = j;
        } else {
            out.push(Tok::Sym(c));
            i += 1;
        }
    }
    Ok(out)
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
    for i in 0..toks.len() {
        if let Tok::Param(name) = &toks[i] {
            checked.params.insert(name.clone());
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
            "TRANSACTIONS" if i > 0 && is_word(&toks[i - 1], "IN") => {
                return Err(reject("cypher.in_transactions", "CALL { } IN TRANSACTIONS writes in batches"));
            }
            "CALL" => check_call(&toks, i)?,
            _ => {}
        }
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
        ] {
            assert!(check(q).is_ok(), "{q}: {:?}", check(q));
        }
    }

    #[test]
    fn parameters_are_collected() {
        let c = check("MATCH (n) WHERE n.id IN $ids AND n.t > $__timeFrom AND n.x = $`odd name` RETURN n").unwrap();
        assert_eq!(c.params, ["__timeFrom", "ids", "odd name"].map(String::from).into());
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
