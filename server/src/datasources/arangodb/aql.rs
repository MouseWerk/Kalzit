//! The first read-only check of AQL, in Kalzit, before anything is sent: a tokenizer that
//! refuses what it does not understand, and the refusal of every writing operation (`INSERT`,
//! `UPDATE`, `REPLACE`, `REMOVE`, `UPSERT`), of user-defined functions (`ns::name()`, JavaScript
//! that runs in the server) and of `CALL` and `APPLY`, which call a function by a name given as a
//! value. Words after a `.` or before a `:` are attribute names, not keywords (`doc.update`,
//! `{ remove: 1 }`).
//!
//! The second check is the server's own parser: `arangodb.rs` asks ArangoDB to parse the query
//! (`POST /_api/query`, which runs nothing) and refuses it when the syntax tree has a writing
//! operation or a user function call.

use std::collections::BTreeSet;

use super::super::Detail;

/// Operations that change data.
pub const WRITES: &[&str] = &["insert", "update", "replace", "remove", "upsert"];
/// Functions that call another function by a name given as a value.
const DYNAMIC_CALLS: &[&str] = &["call", "apply"];

#[derive(Clone, Debug, PartialEq, Eq)]
enum Tok {
    Word(String),
    /// `@name`: a value.
    Bind(String),
    /// `@@name`: a collection.
    CollectionBind(String),
    /// A string, a number or a quoted name.
    Literal,
    Sym(&'static str),
}

/// The query's bind parameters, as the check found them.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Checked {
    /// `@name`: values.
    pub params: BTreeSet<String>,
    /// `@@name`: collection names.
    pub collections: BTreeSet<String>,
}

fn reject(reason: &'static str, message: impl Into<String>) -> Detail {
    Detail::new(reason, message)
}

const SYMBOLS: &[&str] = &[
    "::", "..", "==", "!=", "<=", ">=", "=~", "!~", "&&", "||", "?.", "(", ")", "[", "]", "{", "}", ",", ".", ":", "?",
    "<", ">", "=", "+", "-", "*", "/", "%", "!",
];

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
            let end = q[i + 2..].find("*/").ok_or_else(|| reject("arangodb.unclosed", "a comment is not closed"))?;
            i += 2 + end + 2;
            continue;
        }
        if c == b'\'' || c == b'"' || c == b'`' {
            let mut j = i + 1;
            loop {
                match b.get(j) {
                    None => return Err(reject("arangodb.unclosed", "a string or quoted name is not closed")),
                    Some(b'\\') => j += 2,
                    Some(&d) if d == c => break,
                    Some(_) => j += 1,
                }
            }
            out.push(Tok::Literal);
            i = j + 1;
            continue;
        }
        // The forward tick ´ (U+00B4) quotes names too.
        if q[i..].starts_with('\u{B4}') {
            let end =
                q[i + 2..].find('\u{B4}').ok_or_else(|| reject("arangodb.unclosed", "a quoted name is not closed"))?;
            out.push(Tok::Literal);
            i += 2 + end + 2;
            continue;
        }
        if c == b'@' {
            let collection = b.get(i + 1) == Some(&b'@');
            let start = i + if collection { 2 } else { 1 };
            let len = b[start..].iter().take_while(|d| d.is_ascii_alphanumeric() || **d == b'_').count();
            if len == 0 {
                return Err(reject("arangodb.syntax", "@ must be followed by a parameter name"));
            }
            let name = q[start..start + len].to_string();
            out.push(if collection { Tok::CollectionBind(name) } else { Tok::Bind(name) });
            i = start + len;
            continue;
        }
        if c.is_ascii_digit() {
            let len = b[i..].iter().take_while(|d| d.is_ascii_alphanumeric() || **d == b'_').count();
            i += len;
            // A fraction, but not the range operator `1..5`.
            if b.get(i) == Some(&b'.') && b.get(i + 1).is_some_and(u8::is_ascii_digit) {
                i += 1;
                i += b[i..].iter().take_while(|d| d.is_ascii_alphanumeric() || **d == b'_').count();
            }
            // An exponent sign.
            if matches!(b.get(i), Some(b'+' | b'-')) && matches!(b.get(i - 1), Some(b'e' | b'E')) {
                i += 1;
                i += b[i..].iter().take_while(|d| d.is_ascii_digit()).count();
            }
            out.push(Tok::Literal);
            continue;
        }
        if c.is_ascii_alphabetic() || c == b'_' || c == b'$' {
            let len = b[i..].iter().take_while(|d| d.is_ascii_alphanumeric() || **d == b'_' || **d == b'$').count();
            out.push(Tok::Word(q[i..i + len].to_string()));
            i += len;
            continue;
        }
        match SYMBOLS.iter().find(|s| q[i..].starts_with(**s)) {
            Some(s) => {
                out.push(Tok::Sym(s));
                i += s.len();
            }
            None => {
                let ch = q[i..].chars().next().unwrap_or('?');
                return Err(reject(
                    "arangodb.syntax",
                    format!("the character {ch} is not understood outside strings and comments"),
                )
                .with("char", ch));
            }
        }
    }
    Ok(out)
}

/// Checks one AQL query: refuses writes, user functions and dynamic calls, and collects its bind
/// parameters.
pub fn check(q: &str) -> Result<Checked, Detail> {
    let t = lex(q)?;
    if t.is_empty() {
        return Err(reject("arangodb.empty", "the query is empty"));
    }
    let mut checked = Checked::default();
    for (i, tok) in t.iter().enumerate() {
        match tok {
            Tok::Bind(name) => {
                checked.params.insert(name.clone());
            }
            Tok::CollectionBind(name) => {
                checked.collections.insert(name.clone());
            }
            Tok::Word(word) => {
                let before = i.checked_sub(1).and_then(|p| t.get(p));
                let after = t.get(i + 1);
                let attribute = matches!(before, Some(Tok::Sym("." | "?."))) || after == Some(&Tok::Sym(":"));
                if attribute {
                    continue;
                }
                let lower = word.to_ascii_lowercase();
                if after == Some(&Tok::Sym("::")) {
                    return Err(reject(
                        "arangodb.user_function",
                        format!("{word}:: names a user-defined function, which Kalzit does not call"),
                    )
                    .with("name", word));
                }
                if WRITES.contains(&lower.as_str()) {
                    return Err(reject(
                        "arangodb.write_refused",
                        format!("{} changes data; Kalzit runs only reading queries", lower.to_ascii_uppercase()),
                    )
                    .with("keyword", lower.to_ascii_uppercase()));
                }
                if DYNAMIC_CALLS.contains(&lower.as_str()) && after == Some(&Tok::Sym("(")) {
                    return Err(reject(
                        "arangodb.function_refused",
                        format!("{} calls a function by name, which Kalzit does not allow", lower.to_ascii_uppercase()),
                    )
                    .with("name", lower.to_ascii_uppercase()));
                }
            }
            Tok::Literal | Tok::Sym(_) => {}
        }
    }
    Ok(checked)
}

/// Node types of ArangoDB's syntax tree (`POST /_api/query`) that change data or run user
/// code; `name` is the function's for call nodes.
pub fn refused_node(node_type: &str, name: Option<&str>) -> Option<Detail> {
    let lower = node_type.to_ascii_lowercase();
    if WRITES.contains(&lower.as_str()) {
        return Some(
            reject(
                "arangodb.write_refused",
                format!("{} changes data; Kalzit runs only reading queries", lower.to_ascii_uppercase()),
            )
            .with("keyword", lower.to_ascii_uppercase()),
        );
    }
    if lower == "user function call" {
        let name = name.unwrap_or("?");
        return Some(
            reject("arangodb.user_function", format!("{name} is a user-defined function, which Kalzit does not call"))
                .with("name", name),
        );
    }
    if lower == "function call"
        && let Some(n) = name.filter(|n| DYNAMIC_CALLS.contains(&n.to_ascii_lowercase().as_str()))
    {
        return Some(
            reject("arangodb.function_refused", format!("{n} calls a function by name, which Kalzit does not allow"))
                .with("name", n.to_ascii_uppercase()),
        );
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reason(q: &str) -> &'static str {
        check(q).map(|_| "ok").unwrap_or_else(|d| d.reason)
    }

    #[test]
    fn reading_queries_pass_with_their_parameters() {
        let c = check(
            "FOR p IN @@coll FILTER p.age > @min AND p.name == 'x' // INSERT in a comment\n\
             /* UPDATE */ LET s = \"REMOVE\" RETURN { name: p.name, `update`: p.update, remove: 1 }",
        )
        .unwrap();
        assert_eq!(c.params, ["min".to_string()].into());
        assert_eq!(c.collections, ["coll".to_string()].into());
        for q in [
            "FOR v, e, p IN 1..3 OUTBOUND 'persons/alice' GRAPH 'social' RETURN p",
            "FOR d IN docs SORT d.t DESC LIMIT 10 RETURN d",
            "RETURN LENGTH(docs)",
            "FOR d IN docs COLLECT k = d.kind WITH COUNT INTO n RETURN {k, n}",
            "FOR x IN 1..5 RETURN x * 2.5e-3",
            "RETURN d?.replace",
        ] {
            assert_eq!(reason(q), "ok", "{q}");
        }
    }

    #[test]
    fn writes_are_refused_in_any_case_and_place() {
        for q in [
            "INSERT { a: 1 } INTO docs",
            "FOR d IN docs UPDATE d WITH { a: 1 } IN docs",
            "FOR d IN docs replace d WITH {} IN docs",
            "FOR d IN docs Remove d IN docs",
            "UPSERT { a: 1 } INSERT { a: 1 } UPDATE {} IN docs",
            "LET x = (FOR d IN docs REMOVE d IN docs) RETURN x",
        ] {
            assert_eq!(reason(q), "arangodb.write_refused", "{q}");
        }
    }

    #[test]
    fn user_functions_and_dynamic_calls_are_refused() {
        assert_eq!(reason("RETURN MYFUNCS::write(1)"), "arangodb.user_function");
        assert_eq!(reason("RETURN CALL('MYFUNCS::X', 1)"), "arangodb.function_refused");
        assert_eq!(reason("RETURN apply('MYFUNCS::X', [1])"), "arangodb.function_refused");
        // As attribute names they are only names.
        assert_eq!(reason("FOR d IN docs RETURN d.call"), "ok");
    }

    #[test]
    fn what_the_tokenizer_does_not_understand_is_refused() {
        assert_eq!(reason(""), "arangodb.empty");
        assert_eq!(reason("  // only a comment"), "arangodb.empty");
        assert_eq!(reason("RETURN 'open"), "arangodb.unclosed");
        assert_eq!(reason("RETURN 1 /* open"), "arangodb.unclosed");
        assert_eq!(reason("RETURN 1 ; RETURN 2"), "arangodb.syntax");
        assert_eq!(reason("RETURN @"), "arangodb.syntax");
        assert_eq!(reason("RETURN ü"), "arangodb.syntax");
        // Escaped quotes stay inside the string.
        assert_eq!(reason(r#"RETURN "a \" INSERT""#), "ok");
        assert_eq!(reason("RETURN ´quoted INSERT´"), "ok");
    }

    #[test]
    fn syntax_tree_nodes_that_write_or_run_code_are_refused() {
        for t in ["insert", "update", "replace", "remove", "upsert"] {
            assert_eq!(refused_node(t, None).unwrap().reason, "arangodb.write_refused");
        }
        assert_eq!(refused_node("user function call", Some("A::B")).unwrap().reason, "arangodb.user_function");
        assert_eq!(refused_node("function call", Some("CALL")).unwrap().reason, "arangodb.function_refused");
        assert!(refused_node("function call", Some("LENGTH")).is_none());
        assert!(refused_node("for", None).is_none());
    }
}
