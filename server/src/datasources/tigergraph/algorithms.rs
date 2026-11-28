//! Algorithm steps in TigerGraph (`analysis::algo::library`, `Library::TigerGraph`): the contract
//! of Kalzit's read-only variants of TigerGraph's library queries (`algorithms.gsql`), which an
//! administrator installs on the graph.
//!
//! Before a run, the variant must be installed with exactly the parameters below and pass the
//! rules of every installed query (its text readable and accepted by the GSQL check, or approved
//! by name with TigerGraph's info saying it does not change data). It runs on REST++ with the
//! parameters as JSON in the body (`POST /query/{graph}/{name}`), so a large result's vertices do
//! not make the URL too long. Its answer must say it computed on as many edges as the result
//! holds; otherwise the database has other edges between those vertices and the server computes
//! the step, so both ways answer the same.

use std::collections::{BTreeMap, HashMap};

use serde_json::{Map, Value, json};

use crate::analysis::algo::library::{Job, Param, reason, tigergraph_queries as q};
use crate::datasources::SourceError;
use crate::datasources::gsql::{self, ParamType};

/// The version of the shipped texts; it is part of every text (a comment in its body), so an
/// older installed text differs from the current one byte for byte.
pub const VERSION: u32 = 1;

/// The graph name the shipped file is written for.
const PLACEHOLDER: &str = "FOR GRAPH MyGraph ";

/// Kalzit's own texts of the variants for the graph `graph`, by name, exactly as Kalzit installs
/// them and as an installed text must read to be used.
pub fn shipped(graph: &str) -> Vec<(&'static str, String)> {
    let file = include_str!("algorithms.gsql").replace("\r\n", "\n");
    file.split("CREATE QUERY ")
        .skip(1)
        .filter_map(|part| {
            let end = part.rfind('}')?;
            let text = format!("CREATE QUERY {}", &part[..=end]).replace(PLACEHOLDER, &format!("FOR GRAPH {graph} "));
            let name = q::ALL.iter().copied().find(|n| text.starts_with(&format!("CREATE QUERY {n}(")))?;
            Some((name, text))
        })
        .collect()
}

/// The SHA-256 of a text as written for the placeholder graph, so the same version has the same
/// checksum on every graph. Line ends and surrounding whitespace do not count.
pub fn checksum(text: &str, graph: &str) -> String {
    use sha2::Digest;
    let normal = text.replace("\r\n", "\n").trim().replace(&format!("FOR GRAPH {graph} "), PLACEHOLDER);
    hex::encode(sha2::Sha256::digest(normal.as_bytes()))
}

/// The printed set and accumulator of every vertex's edge ends.
const ENDS: &str = "kalzit_ends";

/// The SHA-256 (hex) of an install or removal script, the confirmation its request carries.
pub fn script_checksum(script: &str) -> String {
    use sha2::Digest;
    hex::encode(sha2::Sha256::digest(script.as_bytes()))
}

/// The checksums of earlier versions of the texts, by name, so an installed older version is
/// recognised as such (and not run until an administrator confirms the update). Empty while
/// version 1 is the only one; a change of `algorithms.gsql` adds the old text's checksum here.
pub const OLDER: &[(&str, u32, &str)] = &[];

/// What the graph holds under a variant's name, as far as Kalzit can tell.
pub fn state_of(
    name: &str,
    graph: &str,
    installed: Option<&str>,
    recorded: bool,
) -> crate::shapes::TigerGraphAlgorithmState {
    state_with(name, graph, installed, recorded, OLDER)
}

/// `state_of` with the checksums of earlier versions given.
fn state_with(
    name: &str,
    graph: &str,
    installed: Option<&str>,
    recorded: bool,
    older: &[(&str, u32, &str)],
) -> crate::shapes::TigerGraphAlgorithmState {
    use crate::shapes::TigerGraphAlgorithmState as St;
    let Some(text) = installed else { return St::Missing };
    let sum = checksum(text, graph);
    let current = shipped(graph).into_iter().find(|(n, _)| *n == name).map(|(_, t)| checksum(&t, graph));
    if current.as_deref() == Some(sum.as_str()) {
        St::Current
    } else if !recorded {
        // Not installed by Kalzit, whatever its text: never replaced, removed or run by Kalzit.
        St::Foreign
    } else if older.iter().any(|(n, _, c)| *n == name && *c == sum) {
        St::Older
    } else {
        St::Changed
    }
}

/// The GSQL commands that bring the variants named in `replace` (Kalzit's own, older or changed:
/// dropped first) and `create` (missing) to the shipped texts on `graph`. The UI shows exactly
/// this text before the install, and the install request must send it back unchanged.
/// `changed` (part of `replace`) are queries changed in the database after Kalzit installed them;
/// the script says so in its first line, so the confirmation shows it.
pub fn install_script(graph: &str, replace: &[&str], create: &[&str], changed: &[&str]) -> Option<String> {
    let texts = shipped(graph);
    let all: Vec<&str> = q::ALL.iter().copied().filter(|n| replace.contains(n) || create.contains(n)).collect();
    if all.is_empty() {
        return None;
    }
    let mut out = String::new();
    if !changed.is_empty() {
        out.push_str(&format!(
            "// Replaces queries changed in the database since Kalzit installed them: {}\n",
            changed.join(", ")
        ));
    }
    out.push_str(&format!("USE GRAPH {graph}\n"));
    let dropped: Vec<&str> = q::ALL.iter().copied().filter(|n| replace.contains(n)).collect();
    if !dropped.is_empty() {
        out.push_str(&format!("DROP QUERY {}\n", dropped.join(", ")));
    }
    for (name, text) in &texts {
        if all.contains(name) {
            out.push_str(text);
            out.push('\n');
        }
    }
    out.push_str(&format!("INSTALL QUERY {}\n", all.join(", ")));
    Some(out)
}

/// The GSQL commands that remove the variants named in `ours` (installed by Kalzit) from `graph`;
/// `None` when there are none. Never another query.
pub fn remove_script(graph: &str, ours: &[&str]) -> Option<String> {
    let ours: Vec<&str> = q::ALL.iter().copied().filter(|n| ours.contains(n)).collect();
    (!ours.is_empty()).then(|| format!("USE GRAPH {graph}\nDROP QUERY {}\n", ours.join(", ")))
}

/// The parameters each variant takes, by name.
pub fn signature(name: &str) -> Option<Vec<(&'static str, ParamType)>> {
    let vertices = || ParamType::Many(Box::new(ParamType::Vertex(None)));
    let texts = || ParamType::Many(Box::new(ParamType::String));
    let mut out = vec![("nodes", vertices()), ("edge_types", texts())];
    match name {
        q::PAGE_RANK => out.extend([
            ("direction", ParamType::String),
            ("damping", ParamType::Float),
            ("max_iterations", ParamType::Int),
            ("tolerance", ParamType::Float),
        ]),
        q::WCC | q::K_CORE | q::TRIANGLES => {}
        q::REACHABLE => {
            out.extend([("direction", ParamType::String), ("starts", vertices()), ("max_hops", ParamType::Int)])
        }
        _ => return None,
    }
    Some(out)
}

pub fn not_installed(name: &str, detail: impl Into<String>) -> SourceError {
    let detail = detail.into();
    SourceError::rejected(reason::NOT_INSTALLED, format!("{name} is not installed as Kalzit expects it: {detail}"))
        .with("name", name)
        .with("detail", detail)
}

pub fn not_verified(name: &str, detail: impl Into<String>) -> SourceError {
    let detail = detail.into();
    SourceError::rejected(reason::NOT_VERIFIED, format!("{name} cannot be shown to only read: {detail}"))
        .with("name", name)
        .with("detail", detail)
}

pub fn changed(name: &str) -> SourceError {
    SourceError::rejected(
        reason::CHANGED_IN_DATABASE,
        format!("{name} was changed in the database after Kalzit installed it; an administrator installs it again"),
    )
    .with("name", name)
}

/// Whether the declared parameters are exactly the variant's (a whole number may be `UINT`).
pub fn matches(name: &str, declared: &[gsql::Param]) -> Result<(), SourceError> {
    let Some(want) = signature(name) else { return Err(not_installed(name, "no such Kalzit query")) };
    let same = |a: &ParamType, b: &ParamType| a == b || matches!((a, b), (ParamType::Int, ParamType::Uint));
    let fits = declared.len() == want.len()
        && want.iter().all(|(n, t)| declared.iter().any(|p| p.name == *n && same(t, &p.ty)));
    if fits {
        Ok(())
    } else {
        let had: Vec<String> = declared.iter().map(|p| p.name.clone()).collect();
        Err(not_installed(name, format!("it takes ({}), not the parameters of algorithms.gsql", had.join(", "))))
    }
}

/// A vertex `Type:id` as REST++ reads an untyped vertex in JSON.
fn vertex(id: &str) -> Value {
    let (ty, key) = id.split_once(':').unwrap_or(("", id));
    json!({ "id": key, "type": ty })
}

/// The job's parameters as the JSON body of the REST++ call.
pub fn body(job: &Job) -> Value {
    let mut out = Map::new();
    for (name, p) in &job.params {
        let v = match p {
            Param::Int(i) => json!(i),
            Param::Float(f) => json!(f),
            Param::Bool(b) => json!(b),
            Param::Text(t) => json!(t),
            Param::Texts(ts) => json!(ts),
            Param::Id(id) => vertex(id),
            Param::Ids(ids) => Value::Array(ids.iter().map(|id| vertex(id)).collect()),
        };
        out.insert(name.clone(), v);
    }
    Value::Object(out)
}

/// The value of the accumulator `name` in a printed vertex's attributes: `@name`, or as a
/// projection prints it, `<set>.@name`.
fn accumulator<'a>(attributes: &'a Map<String, Value>, name: &str) -> Option<&'a Value> {
    let own = format!("@{name}");
    attributes.iter().find(|(k, _)| **k == own || k.ends_with(&format!(".{own}"))).map(|(_, v)| v)
}

/// The variant's answer as rows per output (`[id, value]`, ids as `Type:id`), after checking it
/// computed on the result's edges. Component labels (TigerGraph's internal ids, which may exceed
/// what a JSON number holds exactly) become small numbers.
pub fn answers(job: &Job, results: &Value) -> Result<Vec<Vec<Vec<Value>>>, SourceError> {
    let name = job.runs.first().map(String::as_str).unwrap_or("");
    let unreadable = |what: &str| {
        SourceError::failed("algorithm.answer", format!("{name} answered without {what}")).with("detail", what)
    };
    let items = results.as_array().ok_or_else(|| unreadable("results"))?;
    let edges = items
        .iter()
        .find_map(|i| i.get("edges").or_else(|| i.get("@@kalzit_edges")))
        .and_then(Value::as_u64)
        .ok_or_else(|| unreadable("its edge count"))?;
    if edges != job.edges as u64 {
        return Err(SourceError::rejected(
            reason::SUBGRAPH_DIFFERS,
            format!(
                "{name} computed on {edges} edges, the result holds {}; the database has other edges between \
                 its vertices",
                job.edges
            ),
        )
        .with("database", edges)
        .with("result", job.edges));
    }
    // The printed vertex sets: `kalzit_ends` with every vertex's edge ends, the other with the answer.
    let printed = |ends: bool| -> Vec<&Map<String, Value>> {
        items
            .iter()
            .filter_map(Value::as_object)
            .flat_map(|m| m.iter())
            .filter(|(k, _)| (k.as_str() == ENDS) == ends)
            .filter_map(|(_, v)| v.as_array())
            .flatten()
            .filter_map(Value::as_object)
            .filter(|v| v.contains_key("v_id") && v.contains_key("v_type"))
            .collect()
    };
    let id_of = |v: &Map<String, Value>| {
        format!(
            "{}:{}",
            v["v_type"].as_str().unwrap_or(""),
            match &v["v_id"] {
                Value::String(s) => s.clone(),
                other => other.to_string(),
            }
        )
    };
    let mut ends: BTreeMap<String, BTreeMap<String, u64>> = BTreeMap::new();
    for v in printed(true) {
        let Some(Value::Object(map)) =
            v.get("attributes").and_then(Value::as_object).and_then(|a| accumulator(a, ENDS))
        else {
            return Err(unreadable("its edge ends"));
        };
        let counts: BTreeMap<String, u64> =
            map.iter().filter_map(|(k, n)| n.as_u64().filter(|n| *n > 0).map(|n| (k.clone(), n))).collect();
        if !counts.is_empty() {
            ends.insert(id_of(v), counts);
        }
    }
    if ends != job.ends {
        return Err(SourceError::rejected(
            reason::SUBGRAPH_DIFFERS,
            format!("{name} computed on other edges than the result holds (their ends differ)"),
        )
        .with("database", edges)
        .with("result", job.edges));
    }
    let vertices = printed(false);
    let mut out = Vec::with_capacity(job.outputs.len());
    for output in &job.outputs {
        let mut labels: HashMap<String, usize> = HashMap::new();
        let mut rows = Vec::with_capacity(vertices.len());
        for v in &vertices {
            let id = id_of(v);
            let Some(value) = v.get("attributes").and_then(Value::as_object).and_then(|a| accumulator(a, output))
            else {
                return Err(unreadable(output));
            };
            let value = if name == q::WCC {
                let next = labels.len();
                json!(*labels.entry(value.to_string()).or_insert(next))
            } else {
                value.clone()
            };
            rows.push(vec![json!(id), value]);
        }
        out.push(rows);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::datasources::gsql::{Form, check_with};

    /// Every variant in algorithms.gsql passes the read-only check for installed queries and
    /// declares exactly the parameters Kalzit sends; none writes, prints to files or calls
    /// another query.
    #[test]
    fn the_variants_only_read_and_take_what_kalzit_sends() {
        let text = include_str!("algorithms.gsql");
        let queries: Vec<&str> = text.split("CREATE QUERY ").skip(1).collect();
        assert_eq!(queries.len(), q::ALL.len());
        for body in queries {
            let query = format!("CREATE QUERY {body}");
            let checked = check_with(&query, Form::Installed, Some(&[])).unwrap_or_else(|e| panic!("{query}\n{e:?}"));
            let name = checked.name.clone().unwrap();
            assert!(q::ALL.contains(&name.as_str()), "{name}");
            matches(&name, &checked.params).unwrap_or_else(|e| panic!("{name}: {:?}", e.detail()));
            for word in ["INSERT", "UPDATE", "DELETE", "TO_CSV", "FILE", "setAttr", "SET<FILE"] {
                assert!(!query.contains(word), "{word} in {name}");
            }
            // Every attribute it touches is one of its own accumulators.
            assert!(!query.contains(".kalzit_") && !query.contains("v.name"), "{name}");
            assert!(query.contains("PRINT @@kalzit_edges AS edges;"), "{name}");
        }
    }

    /// The shipped texts for a graph: one per variant, for that graph, with the version, and the
    /// install script holds exactly them.
    #[test]
    fn shipped_texts_and_scripts() {
        let texts = shipped("social");
        assert_eq!(texts.iter().map(|(n, _)| *n).collect::<Vec<_>>(), q::ALL);
        for (name, text) in &texts {
            assert!(text.contains(" FOR GRAPH social SYNTAX V1 {"), "{name}");
            assert!(text.contains(&format!("version {VERSION}.")), "{name}");
            assert!(text.ends_with('}') && !text.contains("MyGraph"), "{name}");
            let checked = check_with(text, Form::Installed, Some(&[])).unwrap();
            assert_eq!(checked.graph.as_deref(), Some("social"));
            let sum = checksum(text, "social");
            let crlf = format!("\r\n{}\r\n", text.replace('\n', "\r\n"));
            assert_eq!(checksum(&crlf, "social"), sum, "line ends and surrounding space do not count");
            assert_ne!(checksum(&text.replace("version 1.", "version 0."), "social"), sum);
        }
        let others: Vec<&str> = q::ALL.iter().copied().filter(|n| *n != q::WCC).collect();
        let script = install_script("social", &[q::WCC, "nachbarn"], &others, &[]).unwrap();
        assert!(
            script.starts_with("USE GRAPH social\nDROP QUERY kalzit_wcc\nCREATE QUERY kalzit_pagerank("),
            "{script}"
        );
        assert!(script.ends_with(&format!("INSTALL QUERY {}\n", q::ALL.join(", "))), "{script}");
        assert!(!script.contains("nachbarn"), "never another query");
        let only = install_script("social", &[], &[q::K_CORE], &[]).unwrap();
        assert!(
            !only.contains("DROP") && !only.contains("kalzit_wcc") && only.ends_with("INSTALL QUERY kalzit_kcore\n")
        );
        assert_eq!(install_script("social", &[], &[], &[]), None, "all current: nothing to do");
        assert_eq!(remove_script("social", &["nachbarn"]), None, "never another query");
        assert_eq!(
            remove_script("social", &[q::K_CORE, q::WCC]).unwrap(),
            "USE GRAPH social\nDROP QUERY kalzit_wcc, kalzit_kcore\n"
        );
    }

    /// The four states of an installed name: unchanged, older, changed by someone after Kalzit
    /// installed it, someone else's.
    #[test]
    fn states_of_installed_texts() {
        use crate::shapes::TigerGraphAlgorithmState as St;
        let (_, text) = shipped("social").into_iter().find(|(n, _)| *n == q::WCC).unwrap();
        assert_eq!(state_of(q::WCC, "social", None, true), St::Missing);
        assert_eq!(state_of(q::WCC, "social", Some(&format!("{text}\n")), false), St::Current);
        assert_eq!(checksum(&text, "social"), checksum(&text.replace("social", "other"), "other"));
        let edited = text.replace("WHILE TRUE DO", "WHILE TRUE LIMIT 3 DO");
        assert_eq!(state_of(q::WCC, "social", Some(&edited), true), St::Changed);
        assert_eq!(state_of(q::WCC, "social", Some(&edited), false), St::Foreign);
        // An older version only when Kalzit installed it; else someone else's query.
        let old = text.replace("version 1.", "version 0.");
        let sum = checksum(&old, "social");
        let older = [(q::WCC, 0, sum.as_str())];
        assert_eq!(state_with(q::WCC, "social", Some(&old), true, &older), St::Older);
        assert_eq!(state_with(q::WCC, "social", Some(&old), false, &older), St::Foreign);
        assert!(OLDER.iter().all(|(n, v, c)| q::ALL.contains(n) && *v < VERSION && c.len() == 64));
    }

    #[test]
    fn signatures_are_checked_exactly() {
        let p = |name: &str, ty: ParamType| gsql::Param { name: name.into(), ty };
        let vertices = || ParamType::Many(Box::new(ParamType::Vertex(None)));
        let texts = || ParamType::Many(Box::new(ParamType::String));
        assert!(matches(q::WCC, &[p("nodes", vertices()), p("edge_types", texts())]).is_ok());
        let wrong = matches(q::WCC, &[p("nodes", vertices())]).unwrap_err();
        assert_eq!(wrong.detail().reason, reason::NOT_INSTALLED);
        let extra = [p("nodes", vertices()), p("edge_types", texts()), p("v_type", ParamType::String)];
        assert!(matches(q::WCC, &extra).is_err());
        assert!(
            matches(q::WCC, &[p("nodes", ParamType::Many(Box::new(ParamType::String))), p("edge_types", texts())])
                .is_err()
        );
    }
}
