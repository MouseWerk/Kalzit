//! The read-only check of Couchbase SQL++ (N1QL), in Kalzit, before anything is sent: a tokenizer
//! that refuses what it does not understand, exactly one statement, which must be a `SELECT` (also
//! after `WITH`, in parentheses or after `EXPLAIN`), and none of the words that start a writing,
//! schema, rights or transaction statement anywhere outside strings and quoted names, and no
//! `CURL()`, which sends requests from the query service to other addresses. Parameters
//! are named (`$name`); positional ones are refused, since a dashboard has no order of values.
//!
//! The second check is Couchbase's own: every statement is sent with `readonly: true`, so the
//! query service refuses any statement that would change data.

use std::collections::BTreeSet;

use super::super::Detail;

/// Words that start a statement that is not a read.
const WRITES: &[&str] = &[
    "insert",
    "upsert",
    "update",
    "delete",
    "merge",
    "create",
    "drop",
    "alter",
    "build",
    "grant",
    "revoke",
    "prepare",
    "execute",
    "infer",
    "advise",
    "begin",
    "commit",
    "rollback",
    "savepoint",
];

/// Functions that reach outside the database.
const FUNCTIONS_REFUSED: &[&str] = &["curl"];

#[derive(Clone, Debug, PartialEq, Eq)]
enum Tok {
    Word(String),
    /// A string, a number or a quoted name.
    Literal,
    Param(String),
    Sym(char),
}

/// The named parameters the statement uses.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Checked {
    pub params: BTreeSet<String>,
}

fn reject(reason: &'static str, message: impl Into<String>) -> Detail {
    Detail::new(reason, message)
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
        if q[i..].starts_with("--") {
            i = q[i..].find('\n').map_or(b.len(), |n| i + n);
            continue;
        }
        if q[i..].starts_with("/*") {
            let end = q[i + 2..].find("*/").ok_or_else(|| reject("couchbase.unclosed", "a comment is not closed"))?;
            i += 2 + end + 2;
            continue;
        }
        if c == b'\'' || c == b'"' || c == b'`' {
            let mut j = i + 1;
            loop {
                match b.get(j) {
                    None => return Err(reject("couchbase.unclosed", "a string or quoted name is not closed")),
                    Some(b'\\') => j += 2,
                    // A doubled quote stays inside.
                    Some(&d) if d == c && b.get(j + 1) == Some(&c) => j += 2,
                    Some(&d) if d == c => break,
                    Some(_) => j += 1,
                }
            }
            out.push(Tok::Literal);
            i = j + 1;
            continue;
        }
        if c == b'$' {
            let len = b[i + 1..].iter().take_while(|d| d.is_ascii_alphanumeric() || **d == b'_').count();
            let name = &q[i + 1..i + 1 + len];
            if name.is_empty() || name.bytes().all(|d| d.is_ascii_digit()) {
                return Err(reject(
                    "couchbase.positional_parameter",
                    "use named parameters ($name); positional ones ($1, ?) have no values on a dashboard",
                ));
            }
            out.push(Tok::Param(name.to_string()));
            i += 1 + len;
            continue;
        }
        if c == b'?' {
            return Err(reject(
                "couchbase.positional_parameter",
                "use named parameters ($name); positional ones ($1, ?) have no values on a dashboard",
            ));
        }
        if c.is_ascii_digit() {
            let len = b[i..].iter().take_while(|d| d.is_ascii_alphanumeric() || **d == b'.').count();
            i += len;
            if matches!(b.get(i), Some(b'+' | b'-')) && matches!(b.get(i - 1), Some(b'e' | b'E')) {
                i += 1;
                i += b[i..].iter().take_while(|d| d.is_ascii_digit()).count();
            }
            out.push(Tok::Literal);
            continue;
        }
        if c.is_ascii_alphabetic() || c == b'_' {
            let len = b[i..].iter().take_while(|d| d.is_ascii_alphanumeric() || **d == b'_' || **d == b'$').count();
            out.push(Tok::Word(q[i..i + len].to_string()));
            i += len;
            continue;
        }
        if b"()[]{},.:;=<>!+-*/%|".contains(&c) {
            out.push(Tok::Sym(c as char));
            i += 1;
            continue;
        }
        let ch = q[i..].chars().next().unwrap_or('?');
        return Err(reject(
            "couchbase.syntax",
            format!("the character {ch} is not understood outside strings and comments"),
        )
        .with("char", ch));
    }
    Ok(out)
}

/// Checks one SQL++ statement and collects its named parameters.
pub fn check(q: &str) -> Result<Checked, Detail> {
    let mut t = lex(q)?;
    while t.last() == Some(&Tok::Sym(';')) {
        t.pop();
    }
    if t.is_empty() {
        return Err(reject("couchbase.empty", "the statement is empty"));
    }
    if t.contains(&Tok::Sym(';')) {
        return Err(reject("couchbase.not_one_statement", "exactly one statement is allowed"));
    }
    let first = t.iter().find(|x| **x != Tok::Sym('('));
    let word = |x: Option<&Tok>| match x {
        Some(Tok::Word(w)) => w.to_ascii_lowercase(),
        _ => String::new(),
    };
    let mut lead = word(first);
    if lead == "explain" {
        lead = word(t.iter().skip_while(|x| word(Some(x)) != "explain").nth(1));
    }
    if lead != "select" && lead != "with" {
        let shown = if lead.is_empty() { "?".to_string() } else { lead.to_ascii_uppercase() };
        return Err(reject("couchbase.not_a_select", format!("only SELECT statements run here, not {shown}"))
            .with("keyword", shown));
    }
    let mut checked = Checked::default();
    for (i, tok) in t.iter().enumerate() {
        match tok {
            Tok::Param(name) => {
                checked.params.insert(name.clone());
            }
            Tok::Word(w) => {
                if i > 0 && t[i - 1] == Tok::Sym('.') {
                    continue;
                }
                let lower = w.to_ascii_lowercase();
                if WRITES.contains(&lower.as_str()) {
                    return Err(reject(
                        "couchbase.write_refused",
                        format!("{} is not a read; Kalzit runs only SELECT statements", lower.to_ascii_uppercase()),
                    )
                    .with("keyword", lower.to_ascii_uppercase()));
                }
                // CURL() sends requests from the query service to other addresses.
                if FUNCTIONS_REFUSED.contains(&lower.as_str()) && t.get(i + 1) == Some(&Tok::Sym('(')) {
                    return Err(reject(
                        "couchbase.function_refused",
                        format!(
                            "{}() reaches outside the database, which Kalzit does not allow",
                            lower.to_ascii_uppercase()
                        ),
                    )
                    .with("name", lower.to_ascii_uppercase()));
                }
            }
            Tok::Literal | Tok::Sym(_) => {}
        }
    }
    Ok(checked)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reason(q: &str) -> &'static str {
        check(q).map(|_| "ok").unwrap_or_else(|d| d.reason)
    }

    #[test]
    fn selects_pass_with_their_parameters() {
        let c = check(
            "SELECT d.name, d.`update` FROM `travel-sample`.inventory.airline AS d \
             WHERE d.country = $land AND d.t >= $__timeFrom -- DELETE in a comment\n\
             /* UPDATE */ AND d.note != 'DROP it' AND d.x = \"it''s\" LIMIT 10;",
        )
        .unwrap();
        assert_eq!(c.params, ["__timeFrom".to_string(), "land".to_string()].into());
        for q in [
            "WITH x AS (SELECT 1 AS a) SELECT x.a FROM x",
            "(SELECT RAW 1)",
            "EXPLAIN SELECT * FROM b",
            "SELECT COUNT(*) AS n FROM b WHERE b.v >= 1.5e-3",
            "select meta(d).id from b d where d.delete = true",
        ] {
            assert_eq!(reason(q), "ok", "{q}");
        }
    }

    #[test]
    fn statements_that_are_not_reads_are_refused() {
        for q in [
            "INSERT INTO b VALUES ('k', {})",
            "UPDATE b SET a = 1",
            "DELETE FROM b",
            "CREATE INDEX i ON b(a)",
            "INFER b",
        ] {
            assert_eq!(reason(q), "couchbase.not_a_select", "{q}");
        }
        for q in ["SELECT * FROM b; DELETE FROM b", "SELECT 1; SELECT 2"] {
            assert_eq!(reason(q), "couchbase.not_one_statement", "{q}");
        }
        for q in [
            "WITH x AS (SELECT 1) UPSERT INTO b VALUES ('k', {})",
            "SELECT * FROM b WHERE EXISTS (DELETE FROM b)",
            "EXPLAIN UPDATE b SET a = 1",
            "SELECT * FROM b MERGE",
        ] {
            assert_ne!(reason(q), "ok", "{q}");
        }
        assert_eq!(reason("WITH x AS (SELECT 1) UPSERT INTO b VALUES ('k', {})"), "couchbase.write_refused");
    }

    #[test]
    fn curl_is_refused_in_any_case_and_place() {
        for q in [
            "SELECT CURL('http://169.254.169.254/latest/meta-data/')",
            "SELECT curl ('http://intern/x', {'request': 'POST'}) AS r",
            "SELECT d.* FROM b AS d WHERE d.x IN (SELECT RAW Curl('http://x'))",
        ] {
            assert_eq!(reason(q), "couchbase.function_refused", "{q}");
        }
        // As a field or a text it is only a name.
        assert_eq!(reason("SELECT d.curl, 'CURL(' AS t FROM b AS d"), "ok");
    }

    #[test]
    fn what_the_tokenizer_does_not_understand_is_refused() {
        assert_eq!(reason(""), "couchbase.empty");
        assert_eq!(reason(" ; "), "couchbase.empty");
        assert_eq!(reason("SELECT 'open"), "couchbase.unclosed");
        assert_eq!(reason("SELECT 1 /* open"), "couchbase.unclosed");
        assert_eq!(reason("SELECT $1"), "couchbase.positional_parameter");
        assert_eq!(reason("SELECT ?"), "couchbase.positional_parameter");
        assert_eq!(reason("SELECT ä"), "couchbase.syntax");
        assert_eq!(reason(r#"SELECT "a \" DELETE""#), "ok");
    }
}
