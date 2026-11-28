//! Graph steps in TigerGraph (`DataSourcePlugin::pushdown`): counting vertices per type over the
//! whole result of an interpreted query, instead of over the vertices Kalzit holds after the
//! node limit.
//!
//! GSQL has no subqueries, so the user's query cannot be wrapped as Cypher is
//! (`analysis::pushdown`). Where every `PRINT` of an interpreted query prints only vertex set
//! variables (`PRINT A, B;`), its result is exactly the union of those sets, and each such `PRINT`
//! becomes collecting the set into a global accumulator; the counts per vertex type are printed
//! at the end. Anything else printed (edges, accumulators, projections, values) keeps the query as
//! written, and the step runs on the server. The rewritten text passes the same read-only check
//! as any query when it runs; a text TigerGraph refuses falls back to the query as written
//! (`with_pushdown`).
//!
//! Counting edge types and degrees would need the edges' ends inside GSQL, which printed edge
//! accumulators do not offer in every version; those steps run on the server.

use serde_json::{Map, Value, json};

use crate::analysis::StepKind;
use crate::datasources::gsql::{self, Form};
use crate::shapes::{Field, FieldType, Frame, QueryResult};

/// The step name the rewritten query carries (`kalzitStep`), so its answer is read as counts.
pub const COUNT_LABELS: &str = "countLabels";
/// The accumulator the rewritten query prints the counts in.
pub const TYPES: &str = "@@kalzit_types";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Tok {
    Ident,
    Sym(u8),
}

/// The tokens of a query that passed the check, with their byte ranges: strings and comments
/// are skipped (the check refused the forms that could be read differently).
fn tokens(q: &str) -> Vec<(Tok, usize, usize)> {
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
            i = q[i + 2..].find("*/").map_or(b.len(), |e| i + 2 + e + 2);
        } else if c == b'"' {
            let mut j = i + 1;
            while j < b.len() && b[j] != b'"' {
                j += if b[j] == b'\\' { 2 } else { 1 };
            }
            out.push((Tok::Sym(b'"'), i, (j + 1).min(b.len())));
            i = j + 1;
        } else if c.is_ascii_alphanumeric() || c == b'_' {
            let mut j = i;
            while j < b.len() && (b[j].is_ascii_alphanumeric() || b[j] == b'_' || b[j] == b'.') {
                j += 1;
            }
            out.push((Tok::Ident, i, j));
            i = j;
        } else {
            out.push((Tok::Sym(c), i, i + 1));
            i += 1;
        }
    }
    out
}

fn word(q: &str, t: &(Tok, usize, usize), w: &str) -> bool {
    t.0 == Tok::Ident && q[t.1..t.2].eq_ignore_ascii_case(w)
}

/// A name the query may print as a vertex set: a plain identifier, not a keyword or number.
fn plain(q: &str, t: &(Tok, usize, usize)) -> bool {
    let s = &q[t.1..t.2];
    t.0 == Tok::Ident
        && s.bytes().next().is_some_and(|c| c.is_ascii_alphabetic())
        && s.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_')
        && !["TRUE", "FALSE", "NULL"].iter().any(|k| s.eq_ignore_ascii_case(k))
        && !s.to_ascii_lowercase().starts_with("kalzit_")
}

/// The interpreted query `q` rewritten to print the number of vertices per type of its result,
/// or `None` when it prints anything but vertex set variables.
pub fn count_labels(q: &str) -> Option<String> {
    // Only the form matters here; the text that runs is checked with the graph's query names.
    gsql::check_with(q, Form::Interpret, Some(&[])).ok()?;
    let toks = tokens(q);
    let open = toks.iter().position(|t| t.0 == Tok::Sym(b'{'))?;
    let close = toks.iter().rposition(|t| t.0 == Tok::Sym(b'}'))?;
    // After the body's leading TYPEDEFs, which must come first.
    let mut at = open + 1;
    while toks.get(at).is_some_and(|t| word(q, t, "TYPEDEF")) {
        at += toks[at..close].iter().position(|t| t.0 == Tok::Sym(b';'))? + 1;
    }
    let declare_at = toks[at - 1].2;
    let mut out = String::with_capacity(q.len() + 512);
    out.push_str(&q[..declare_at]);
    out.push_str(" SetAccum<VERTEX> @@kalzit_all; MapAccum<STRING, SumAccum<INT>> @@kalzit_types; ");
    let mut copied = declare_at;
    let mut prints = 0;
    let mut i = at;
    while i < close {
        if !word(q, &toks[i], "PRINT") {
            i += 1;
            continue;
        }
        let end = i + toks[i..close].iter().position(|t| t.0 == Tok::Sym(b';'))?;
        let items = &toks[i + 1..end];
        if items.is_empty() {
            return None;
        }
        let mut sets = Vec::new();
        for (k, t) in items.iter().enumerate() {
            let expected_name = k % 2 == 0;
            match expected_name {
                true if plain(q, t) => sets.push(&q[t.1..t.2]),
                false if t.0 == Tok::Sym(b',') => {}
                _ => return None,
            }
        }
        if items.len().is_multiple_of(2) {
            return None;
        }
        out.push_str(&q[copied..toks[i].1]);
        for set in sets {
            prints += 1;
            out.push_str(&format!(
                "kalzit_p{prints} = SELECT kalzit_x FROM {set}:kalzit_x POST-ACCUM @@kalzit_all += kalzit_x; "
            ));
        }
        copied = toks[end].2;
        i = end + 1;
    }
    if prints == 0 {
        return None;
    }
    out.push_str(&q[copied..toks[close].1]);
    out.push_str(
        " kalzit_seen = {@@kalzit_all}; \
         kalzit_seen = SELECT kalzit_y FROM kalzit_seen:kalzit_y POST-ACCUM @@kalzit_types += (kalzit_y.type -> 1); \
         PRINT @@kalzit_types; ",
    );
    out.push_str(&q[toks[close].1..]);
    Some(out)
}

/// The query that runs `step` on the result of the TigerGraph query `query` in the database.
pub fn query(query: &Value, step: &StepKind) -> Option<Value> {
    let StepKind::CountLabels { .. } = step else { return None };
    let o = query.as_object()?;
    if o.keys().any(|k| k != "gsql" && k != "params") {
        return None;
    }
    let text = count_labels(o.get("gsql")?.as_str()?)?;
    let mut out = Map::new();
    out.insert("gsql".into(), json!(text));
    if let Some(p) = o.get("params") {
        out.insert("params".into(), p.clone());
    }
    out.insert("kalzitStep".into(), json!(COUNT_LABELS));
    Some(Value::Object(out))
}

/// The counts the rewritten query printed (`@@kalzit_types`), as the server's step answers them:
/// `label`, `nodes`, `share`, the most first.
pub fn counts(results: &Value) -> Option<QueryResult> {
    let map = results
        .as_array()?
        .iter()
        .find_map(|item| item.get(TYPES).or_else(|| item.get("kalzit_types")))?
        .as_object()?;
    let mut rows: Vec<(String, f64)> = map.iter().filter_map(|(k, v)| Some((k.clone(), v.as_f64()?))).collect();
    rows.sort_by(|a, b| b.1.total_cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    let total: f64 = rows.iter().map(|r| r.1).sum();
    let field = |name: &str, field_type, values: Vec<Value>| Field {
        name: name.to_string(),
        field_type,
        unit: None,
        values,
        labels: None,
    };
    let fields = vec![
        field("label", FieldType::String, rows.iter().map(|r| json!(r.0)).collect()),
        field("nodes", FieldType::Number, rows.iter().map(|r| json!(r.1)).collect()),
        field(
            "share",
            FieldType::Number,
            rows.iter().map(|r| json!(if total > 0.0 { r.1 / total } else { 0.0 })).collect(),
        ),
    ];
    Some(QueryResult::Frame { frame: Frame::new(fields).ok()? })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::analysis::parse_step;

    fn step(v: Value) -> StepKind {
        let mut v = v;
        v["id"] = json!("s");
        v["frame"] = json!("A");
        parse_step(&v).unwrap().kind
    }

    #[test]
    fn vertex_set_prints_become_counts() {
        let q = "INTERPRET QUERY (STRING name) FOR GRAPH social { TYPEDEF TUPLE <INT a> Paar; \
                 OrAccum @seen; S = {Person.*}; // PRINT nothing here\n \
                 R = SELECT s FROM S:s WHERE s.name == name; \
                 IF R.size() > 0 THEN PRINT R, S; END; PRINT S; }";
        let out = count_labels(q).unwrap();
        // Still read-only, and still one interpreted query for the same graph (TYPEDEF needs the
        // graph's query names).
        gsql::check_with(&out, Form::Interpret, Some(&[])).unwrap_or_else(|e| panic!("{out}\n{e:?}"));
        assert!(out.contains("TYPEDEF TUPLE <INT a> Paar; SetAccum<VERTEX> @@kalzit_all;"), "{out}");
        assert!(out.contains("THEN kalzit_p1 = SELECT kalzit_x FROM R:kalzit_x"), "{out}");
        assert!(out.contains("kalzit_p2 = SELECT kalzit_x FROM S:kalzit_x"), "{out}");
        assert!(out.contains("kalzit_p3 = SELECT kalzit_x FROM S:kalzit_x"), "{out}");
        assert!(out.contains("// PRINT nothing here"), "comments are kept as they are: {out}");
        assert!(out.trim_end().ends_with("PRINT @@kalzit_types; }"), "{out}");
        assert_eq!(out.matches("PRINT").count(), 2, "{out}");
    }

    #[test]
    fn anything_else_printed_keeps_the_query() {
        for q in [
            "INTERPRET QUERY () FOR GRAPH g { SetAccum<EDGE> @@e; S = {Person.*}; PRINT S, @@e; }",
            "INTERPRET QUERY () FOR GRAPH g { S = {Person.*}; PRINT S[S.name]; }",
            "INTERPRET QUERY () FOR GRAPH g { S = {Person.*}; PRINT S AS leute; }",
            "INTERPRET QUERY () FOR GRAPH g { PRINT 1; }",
            "INTERPRET QUERY () FOR GRAPH g { S = {Person.*}; PRINT S.size(); }",
            "INTERPRET QUERY () FOR GRAPH g { S = {Person.*}; R = S; }",
            "INTERPRET QUERY () FOR GRAPH g { S = {Person.*}; DELETE s FROM S:s; PRINT S; }",
            "CREATE QUERY q() FOR GRAPH g { S = {Person.*}; PRINT S; }",
        ] {
            assert_eq!(count_labels(q), None, "{q}");
        }
        let pr = step(json!({ "type": "countLabels" }));
        assert!(query(&json!({ "installed": "q" }), &pr).is_none());
        let q =
            json!({ "gsql": "INTERPRET QUERY (INT k) FOR GRAPH g { S = {Person.*}; PRINT S; }", "params": { "k": 1 } });
        let pushed = query(&q, &pr).unwrap();
        assert_eq!(pushed["kalzitStep"], COUNT_LABELS);
        assert_eq!(pushed["params"], json!({ "k": 1 }));
        assert!(query(&q, &step(json!({ "type": "countEdgeTypes" }))).is_none());
    }

    #[test]
    fn printed_counts_become_the_steps_table() {
        let results = json!([{ "@@kalzit_types": { "Ort": 1, "Person": 3, "Firma": 1 } }]);
        let Some(QueryResult::Frame { frame }) = counts(&results) else { panic!() };
        let f = frame.fields();
        assert_eq!(f[0].values, [json!("Person"), json!("Firma"), json!("Ort")]);
        assert_eq!(f[1].values, [json!(3.0), json!(1.0), json!(1.0)]);
        assert_eq!(f[2].values[0], json!(0.6));
    }
}
