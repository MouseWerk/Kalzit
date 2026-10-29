//! What of a data source an AI function may put into a prompt. Every AI feature that sends a
//! schema or a result goes through here, never around it:
//!
//! - A data source closed to AI (`ai_datasource_access.readable`, off by default) gives nothing:
//!   no schema, no results. Explain and draft then send only the query text the user typed
//!   (`schema_for_model` answers `None`); summarize and the chat refuse the source
//!   (`result_for_model` answers `ai.datasource_not_readable`).
//! - Excluded fields keep their name and lose their value: it becomes `EXCLUDED`, so the model
//!   sees that the field exists but never its content.
//! - A result is cut to `ai.max_rows_to_model` rows, documents or nodes, and says so.
//!
//! Matching is deliberately broad, since results do not always name their table: an entry
//! excludes a field whose name or dotted path equals it, or where one is a dotted suffix of the
//! other (`kunden.email` excludes the column `email` of every result of the source, and
//! `email` excludes `kunde.email` inside a document), after NFKC and case folding. An excluded
//! object or array is replaced as a whole, also inside JSON columns. Graph properties match by
//! property name or `Label.property`.
//!
//! Excluding works by name and is best effort, not a security boundary: a query that renames a
//! column (`email AS kontakt`) or computes from it (`lower(email)`) passes its values under
//! another name. The boundary is the opt-in of the source and the rights of the person asking.
//! Values that serve as a graph node's or edge's id, or as a document's `_id`, are not replaced:
//! a node whose id is an e-mail address shows it although the property `email` is excluded.
//!
//! Stored chats are checked again with the rules as they are when read (`restrict_stored`), so
//! a field excluded or a row limit lowered later reaches the results already kept.

use std::collections::BTreeSet;

use axum::http::StatusCode;
use serde_json::{Map, Value, json};

use super::store::{self, DatasourceAccess};
use crate::app::AppState;
use crate::datasources::SourceSchema;
use crate::error::{ApiError, ApiResult};
use crate::shapes::QueryResult;

/// What replaces the value of an excluded field.
pub const EXCLUDED: &str = "[excluded]";
/// The most entries one data source may exclude.
pub const MAX_EXCLUDED: usize = 200;
const MAX_ENTRY_CHARS: usize = 256;

/// Field names too common to refuse a query for unless the entry's own table qualifies them.
pub const GENERIC: &[&str] = &[
    "id",
    "name",
    "title",
    "label",
    "type",
    "kind",
    "key",
    "value",
    "status",
    "date",
    "time",
    "count",
    "created_at",
    "updated_at",
];

/// The rules for one data source, loaded once per AI call.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DataPolicy {
    pub readable: bool,
    /// Lower case, trimmed.
    excluded: Vec<String>,
    pub max_rows: usize,
}

impl DataPolicy {
    pub fn new(access: &DatasourceAccess, max_rows: usize) -> Self {
        let excluded = access.excluded_fields.iter().map(|e| fold(e.trim())).filter(|e| !e.is_empty()).collect();
        Self { readable: access.readable, excluded, max_rows }
    }

    /// The rules as text, for the query cache's key of an AI call (`datasources::cache`): an
    /// answer kept under one set of rules is never served under another.
    pub fn fingerprint(&self) -> String {
        let mut excluded = self.excluded.clone();
        excluded.sort();
        serde_json::to_string(&(self.readable, excluded, self.max_rows)).unwrap_or_default()
    }

    /// The rules for a result made from several sources (a panel's steps join or combine their
    /// queries): readable only when every source is, with the excluded fields of all of them and
    /// the smallest row limit.
    pub fn merged<'a>(policies: impl IntoIterator<Item = &'a DataPolicy>) -> Self {
        let mut out = Self { readable: true, excluded: Vec::new(), max_rows: usize::MAX };
        for p in policies {
            out.readable &= p.readable;
            out.max_rows = out.max_rows.min(p.max_rows);
            for e in &p.excluded {
                if !out.excluded.contains(e) {
                    out.excluded.push(e.clone());
                }
            }
        }
        if out.max_rows == usize::MAX {
            out.max_rows = 0;
            out.readable = false;
        }
        out
    }

    /// The first excluded entry a query text names as a word: the entry itself or its last
    /// segment (`kunden.email` is named by `email`), compared after the same folding. A query the
    /// model writes could otherwise read an excluded field under another name (`email AS x`).
    ///
    /// Best effort, like excluding itself: a query can still reach a value without naming its
    /// field (a whole-row cast, `FOR JSON`, `$$ROOT`, `keys(n)`, escapes in identifiers). To keep
    /// false refusals rare without a way around: for an entry with a table (`kunden.email`), a
    /// query that never names that table lets the field through under another qualifier
    /// (`users.email`), and a very generic field name (`GENERIC`) unqualified; a query that names
    /// the table anywhere is refused for any mention of the field. A bare generic entry (`id`)
    /// never refuses a query.
    pub fn excluded_named_in(&self, text: &str) -> Option<String> {
        let text = fold(text);
        let is_word = |c: char| c.is_alphanumeric() || c == '_';
        // Each whole-word mention of `word`, with the word before a dot in front of it, if any.
        let mentions = |word: &str| -> Vec<Option<String>> {
            if word.is_empty() {
                return Vec::new();
            }
            text.match_indices(word)
                .filter(|(at, _)| {
                    let before = text[..*at].chars().next_back();
                    let after = text[at + word.len()..].chars().next();
                    !before.is_some_and(is_word) && !after.is_some_and(is_word)
                })
                .map(|(at, _)| {
                    let head = text[..at].strip_suffix('.')?;
                    let start =
                        head.char_indices().rev().find(|(_, c)| !is_word(*c)).map_or(0, |(i, c)| i + c.len_utf8());
                    Some(head[start..].to_string())
                })
                .collect()
        };
        for entry in &self.excluded {
            let (table, field) = match entry.rsplit_once('.') {
                Some((table, field)) => (Some(table.rsplit('.').next().unwrap_or(table)), field),
                None => (None, entry.as_str()),
            };
            let generic = GENERIC.contains(&field);
            if generic && table.is_none() {
                continue;
            }
            // Where the entry's table is named anywhere in the query, every mention of the field
            // refuses it: an alias, a CTE or a subquery could stand for the table under any name.
            let table_named = table.is_some_and(|t| !mentions(t).is_empty());
            for qualifier in mentions(field) {
                let refused = match table {
                    Some(_) if table_named => true,
                    // The table is not read: another table's field passes, a bare one does not
                    // (unless its name is generic).
                    Some(_) => qualifier.is_none() && !generic,
                    None => true,
                };
                if refused {
                    return Some(entry.clone());
                }
            }
        }
        None
    }

    /// An error text of a source as the model may get it: with excluded fields, every quoted
    /// part (`'...'`, `"..."`) is replaced, since a database error may quote a value.
    pub fn error_text(&self, message: &str) -> String {
        if self.excluded.is_empty() {
            return message.to_string();
        }
        let mut out = String::with_capacity(message.len());
        let mut open: Option<char> = None;
        for c in message.chars() {
            match open {
                Some(q) if c == q => {
                    out.push_str(EXCLUDED);
                    out.push(c);
                    open = None;
                }
                Some(_) => {}
                None => {
                    out.push(c);
                    if c == '\'' || c == '"' {
                        open = Some(c);
                    }
                }
            }
        }
        if open.is_some() {
            out.push_str(EXCLUDED);
        }
        out
    }

    /// Whether the value at `path` (a field name or dotted path) is excluded. Besides the path
    /// itself and dotted suffixes, the last segments are compared: a step that joins frames names
    /// their fields `A.email` and `B.email`, which `kunden.email` must cover too.
    pub fn excludes(&self, path: &str) -> bool {
        let path = fold(path);
        let last = |s: &str| s.rsplit('.').next().unwrap_or(s).to_string();
        let path_last = last(&path);
        self.excluded
            .iter()
            .any(|e| *e == path || ends_with_segment(e, &path) || ends_with_segment(&path, e) || last(e) == path_last)
    }
}

/// A name as it is compared: NFKC, lower case, and the case foldings `to_lowercase` leaves out
/// (`ß` as `ss`, final `ς` as `σ`), NFKC again; so `Straße`, `STRASSE` and `ｓｔｒａｓｓｅ` are one.
fn fold(s: &str) -> String {
    use unicode_normalization::UnicodeNormalization;
    let lower: String = s.nfkc().collect::<String>().to_lowercase().replace('ß', "ss").replace('ς', "σ");
    lower.nfkc().collect()
}

/// `long` ends with `.short`.
fn ends_with_segment(long: &str, short: &str) -> bool {
    long.len() > short.len() && long.ends_with(short) && long.as_bytes()[long.len() - short.len() - 1] == b'.'
}

/// The policy of a data source as stored now.
pub async fn policy(state: &AppState, datasource_id: &str) -> ApiResult<DataPolicy> {
    let access = store::datasource_access(&state.db, datasource_id).await?;
    Ok(DataPolicy::new(&access, super::service::max_rows_to_model(state).await?))
}

/// Checks a list of excluded fields as an admin enters it; returns it trimmed, without
/// duplicates, in the order given.
pub fn clean_excluded(entries: &[String]) -> ApiResult<Vec<String>> {
    if entries.len() > MAX_EXCLUDED {
        return Err(ApiError::validation(format!("excludedFields takes at most {MAX_EXCLUDED} entries"))
            .with_field("excludedFields")
            .because("ai.excluded_fields_invalid")
            .param("max", MAX_EXCLUDED));
    }
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for entry in entries {
        let entry = entry.trim();
        let ok = !entry.is_empty()
            && entry.chars().count() <= MAX_ENTRY_CHARS
            && !entry.chars().any(char::is_control)
            && entry.split('.').all(|s| !s.trim().is_empty());
        if !ok {
            return Err(ApiError::validation(format!(
                "excludedFields entries are names or dotted paths of 1 to {MAX_ENTRY_CHARS} characters"
            ))
            .with_field("excludedFields")
            .because("ai.excluded_fields_invalid")
            .param("max", MAX_EXCLUDED));
        }
        if seen.insert(fold(entry)) {
            out.push(entry.to_string());
        }
    }
    Ok(out)
}

/// The schema of a source for a prompt, or `None` when the source is closed to AI: then explain
/// and draft send only the query text. Field names stay, as excluded fields keep their names.
pub fn schema_for_model(policy: &DataPolicy, schema: &SourceSchema) -> Option<Value> {
    policy.readable.then(|| serde_json::to_value(schema).unwrap_or(Value::Null))
}

/// A result for a prompt: excluded values replaced, cut to the row limit.
#[derive(Clone, Debug, PartialEq)]
pub struct ForModel {
    pub value: Value,
    /// Rows, documents or nodes that went in.
    pub rows: usize,
    /// More were there and were left out.
    pub truncated: bool,
    /// Values that were replaced.
    pub excluded_values: usize,
}

fn not_readable() -> ApiError {
    ApiError::new(StatusCode::CONFLICT, "ai_unavailable", "this data source is not open to AI")
        .because("ai.datasource_not_readable")
}

/// The result of a query on a source, as AI may receive it; refused for a source closed to AI.
pub fn result_for_model(policy: &DataPolicy, result: &QueryResult) -> ApiResult<ForModel> {
    if !policy.readable {
        return Err(not_readable());
    }
    let mut hits = 0;
    let (value, rows, truncated) = match result {
        QueryResult::Frame { frame } => {
            let total = frame.rows();
            let rows = total.min(policy.max_rows);
            let fields: Vec<Value> = frame
                .fields()
                .iter()
                .map(|f| {
                    let excluded = policy.excludes(&f.name);
                    let values: Vec<Value> = f
                        .values
                        .iter()
                        .take(rows)
                        .map(|v| {
                            if excluded && !v.is_null() {
                                count_replaced(v, &mut hits);
                                json!(EXCLUDED)
                            } else {
                                // A JSON column holds objects whose paths can be excluded too.
                                let mut v = v.clone();
                                redact_value(policy, &f.name, &mut v, &mut hits);
                                v
                            }
                        })
                        .collect();
                    json!({ "name": f.name, "type": f.field_type, "values": values })
                })
                .collect();
            (json!({ "shape": "frame", "fields": fields }), rows, total > rows)
        }
        QueryResult::Documents { documents } => {
            let total = documents.documents.len();
            let docs: Vec<Value> = documents
                .documents
                .iter()
                .take(policy.max_rows)
                .map(|d| {
                    let mut value: Value = serde_json::from_str(d.get()).unwrap_or(Value::Null);
                    redact_value(policy, "", &mut value, &mut hits);
                    value
                })
                .collect();
            let rows = docs.len();
            (json!({ "shape": "documents", "documents": docs }), rows, total > rows)
        }
        QueryResult::Graph { graph } => {
            let total = graph.nodes.len();
            let kept: BTreeSet<&str> = graph.nodes.iter().take(policy.max_rows).map(|n| n.id.as_str()).collect();
            let nodes: Vec<Value> = graph
                .nodes
                .iter()
                .take(policy.max_rows)
                .map(|n| {
                    let props = redact_properties(policy, &n.labels, &n.properties, &mut hits);
                    json!({ "id": n.id, "labels": n.labels, "properties": props })
                })
                .collect();
            let edges: Vec<Value> = graph
                .edges
                .iter()
                .filter(|e| kept.contains(e.from.as_str()) && kept.contains(e.to.as_str()))
                .map(|e| {
                    let props = redact_properties(policy, std::slice::from_ref(&e.edge_type), &e.properties, &mut hits);
                    json!({ "id": e.id, "type": e.edge_type, "from": e.from, "to": e.to, "properties": props })
                })
                .collect();
            let rows = nodes.len();
            (json!({ "shape": "graph", "nodes": nodes, "edges": edges }), rows, total > rows)
        }
    };
    Ok(ForModel { value, rows, truncated, excluded_values: hits })
}

fn redact_properties(
    policy: &DataPolicy,
    labels: &[String],
    properties: &std::collections::BTreeMap<String, Value>,
    hits: &mut usize,
) -> Map<String, Value> {
    properties
        .iter()
        .map(|(k, v)| {
            let excluded = policy.excludes(k) || labels.iter().any(|l| policy.excludes(&format!("{l}.{k}")));
            if excluded {
                count_replaced(v, hits);
                (k.clone(), json!(EXCLUDED))
            } else {
                let mut v = v.clone();
                redact_value(policy, k, &mut v, hits);
                (k.clone(), v)
            }
        })
        .collect()
}

/// Counts a value about to be replaced, unless it holds nothing (null) or was replaced before.
fn count_replaced(value: &Value, hits: &mut usize) {
    if !value.is_null() && value.as_str() != Some(EXCLUDED) {
        *hits += 1;
    }
}

/// A result as a chat stored it (`{shape, ...}` as `result_for_model` made it), checked again
/// with the rules as they are now.
#[derive(Clone, Debug, PartialEq)]
pub struct Restricted {
    /// `None` when the stored value has no shape this knows: nothing of it is shown.
    pub value: Option<Value>,
    /// Values replaced now that were not before.
    pub replaced: usize,
    /// Rows, documents or nodes left out now for a lower row limit.
    pub cut: bool,
}

impl Restricted {
    /// Whether the result shows less than when it was stored.
    pub fn changed(&self) -> bool {
        self.value.is_none() || self.replaced > 0 || self.cut
    }
}

/// A stored result under the rules as they are now: fields excluded since lose their values and
/// a row limit lowered since cuts it again, so tightening the rules reaches stored chats too.
/// Values replaced before stay replaced; nothing comes back that was not stored.
pub fn restrict_stored(policy: &DataPolicy, stored: &Value) -> Restricted {
    let mut value = stored.clone();
    let mut hits = 0;
    let mut cut = false;
    let max = policy.max_rows;
    let mut truncate = |items: &mut Vec<Value>| {
        if items.len() > max {
            items.truncate(max);
            cut = true;
        }
    };
    match stored.get("shape").and_then(Value::as_str) {
        Some("frame") => {
            for field in value.get_mut("fields").and_then(Value::as_array_mut).into_iter().flatten() {
                let name = field.get("name").and_then(Value::as_str).unwrap_or_default().to_string();
                let excluded = policy.excludes(&name);
                let Some(values) = field.get_mut("values").and_then(Value::as_array_mut) else { continue };
                truncate(values);
                for v in values.iter_mut() {
                    if excluded {
                        if !v.is_null() {
                            count_replaced(v, &mut hits);
                            *v = json!(EXCLUDED);
                        }
                    } else {
                        redact_value(policy, &name, v, &mut hits);
                    }
                }
            }
        }
        Some("documents") => {
            if let Some(documents) = value.get_mut("documents").and_then(Value::as_array_mut) {
                truncate(documents);
                for d in documents.iter_mut() {
                    redact_value(policy, "", d, &mut hits);
                }
            }
        }
        Some("graph") => {
            let mut kept = BTreeSet::new();
            if let Some(nodes) = value.get_mut("nodes").and_then(Value::as_array_mut) {
                truncate(nodes);
                for node in nodes.iter_mut() {
                    kept.insert(node.get("id").map(Value::to_string).unwrap_or_default());
                    let labels = string_list(node.get("labels"));
                    restrict_properties(policy, &labels, node.get_mut("properties"), &mut hits);
                }
            }
            if let Some(edges) = value.get_mut("edges").and_then(Value::as_array_mut) {
                edges.retain(|e| {
                    let end = |key: &str| e.get(key).map(Value::to_string).unwrap_or_default();
                    kept.contains(&end("from")) && kept.contains(&end("to"))
                });
                for edge in edges.iter_mut() {
                    let labels = string_list(edge.get("type").map(|t| json!([t])).as_ref());
                    restrict_properties(policy, &labels, edge.get_mut("properties"), &mut hits);
                }
            }
        }
        _ => return Restricted { value: None, replaced: 0, cut: false },
    }
    Restricted { value: Some(value), replaced: hits, cut }
}

fn string_list(value: Option<&Value>) -> Vec<String> {
    value.and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::to_string).collect()
}

/// `redact_properties` on stored properties, in place.
fn restrict_properties(policy: &DataPolicy, labels: &[String], properties: Option<&mut Value>, hits: &mut usize) {
    let Some(Value::Object(map)) = properties else { return };
    let current: std::collections::BTreeMap<String, Value> = std::mem::take(map).into_iter().collect();
    *map = redact_properties(policy, labels, &current, hits);
}

/// Replaces excluded paths below `path` in place; array elements share their array's path.
fn redact_value(policy: &DataPolicy, path: &str, value: &mut Value, hits: &mut usize) {
    match value {
        Value::Object(map) => {
            for (key, child) in map.iter_mut() {
                let child_path = if path.is_empty() { key.clone() } else { format!("{path}.{key}") };
                if policy.excludes(&child_path) {
                    count_replaced(child, hits);
                    *child = json!(EXCLUDED);
                } else {
                    redact_value(policy, &child_path, child, hits);
                }
            }
        }
        Value::Array(items) => {
            for item in items {
                redact_value(policy, path, item, hits);
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shapes::{DocumentSet, Edge, Field, FieldType, Frame, GraphSchema, GraphSet, Node, OrderedJson};

    fn policy(excluded: &[&str], max_rows: usize) -> DataPolicy {
        let access =
            DatasourceAccess { readable: true, excluded_fields: excluded.iter().map(|s| s.to_string()).collect() };
        DataPolicy::new(&access, max_rows)
    }

    #[test]
    fn matching_is_broad_on_purpose() {
        let p = policy(&["kunden.email", "IBAN", "adresse"], 10);
        assert!(p.excludes("email"), "a qualified entry excludes the bare column");
        assert!(p.excludes("kunden.email") && p.excludes("Kunden.Email"));
        assert!(p.excludes("iban") && p.excludes("konto.iban"), "a bare entry excludes nested paths");
        assert!(p.excludes("adresse"));
        assert!(!p.excludes("emails") && !p.excludes("xemail") && !p.excludes("name"));
        assert!(p.excludes("A.email") && p.excludes("B.Email"), "a joined frame's fields are covered");
        assert!(!p.excludes("A.emails"));
    }

    #[test]
    fn a_closed_source_gives_nothing() {
        let closed = DataPolicy::new(&DatasourceAccess::default(), 10);
        let schema = SourceSchema::Metrics { metrics: vec!["up".into()], labels: vec![] };
        assert_eq!(schema_for_model(&closed, &schema), None);
        assert!(schema_for_model(&policy(&[], 10), &schema).is_some());
        let frame = QueryResult::Frame { frame: Frame::new(vec![]).unwrap() };
        let e = result_for_model(&closed, &frame).unwrap_err();
        assert_eq!(e.reason.unwrap().code, "ai.datasource_not_readable");
    }

    #[test]
    fn frames_lose_excluded_values_and_extra_rows() {
        let field = |name: &str, values: Vec<Value>| Field {
            name: name.into(),
            field_type: FieldType::String,
            unit: None,
            values,
            labels: None,
        };
        let frame = Frame::new(vec![
            field("name", vec![json!("Ada"), json!("Bob"), json!("Cem")]),
            field("email", vec![json!("ada@example.de"), Value::Null, json!("cem@example.de")]),
        ])
        .unwrap();
        let out = result_for_model(&policy(&["kunden.email"], 2), &QueryResult::Frame { frame }).unwrap();
        assert_eq!((out.rows, out.truncated, out.excluded_values), (2, true, 1));
        assert_eq!(out.value["fields"][0]["values"], json!(["Ada", "Bob"]));
        assert_eq!(out.value["fields"][1]["values"], json!([EXCLUDED, null]));
        assert!(!out.value.to_string().contains("example.de"));
    }

    #[test]
    fn documents_lose_excluded_paths_inside_arrays_and_objects() {
        let doc = json!({ "name": "Ada", "konto": { "iban": "DE89", "bank": "X" },
                          "kontakte": [{ "email": "a@b.de" }, { "email": "c@d.de" }] });
        let documents = DocumentSet { documents: vec![OrderedJson::new(&doc).unwrap()], ..Default::default() };
        let out =
            result_for_model(&policy(&["iban", "kontakte.email"], 10), &QueryResult::Documents { documents }).unwrap();
        let d = &out.value["documents"][0];
        assert_eq!(d["konto"], json!({ "iban": EXCLUDED, "bank": "X" }));
        assert_eq!(d["kontakte"], json!([{ "email": EXCLUDED }, { "email": EXCLUDED }]));
        assert_eq!(out.excluded_values, 3);
    }

    #[test]
    fn graphs_keep_edges_between_kept_nodes_only() {
        let node = |id: &str, email: &str| Node {
            id: id.into(),
            labels: vec!["Person".into()],
            properties: [("email".to_string(), json!(email)), ("name".to_string(), json!(id))].into(),
        };
        let graph = GraphSet {
            nodes: vec![node("a", "a@x.de"), node("b", "b@x.de"), node("c", "c@x.de")],
            edges: vec![
                Edge {
                    id: "e1".into(),
                    edge_type: "KNOWS".into(),
                    from: "a".into(),
                    to: "b".into(),
                    properties: Default::default(),
                },
                Edge {
                    id: "e2".into(),
                    edge_type: "KNOWS".into(),
                    from: "b".into(),
                    to: "c".into(),
                    properties: Default::default(),
                },
            ],
            paths: None,
            schema: GraphSchema { labels: vec![], edge_types: vec![], property_keys: Default::default() },
            truncated: None,
            notices: None,
        };
        let out = result_for_model(&policy(&["Person.email"], 2), &QueryResult::Graph { graph }).unwrap();
        assert_eq!(out.value["nodes"].as_array().unwrap().len(), 2);
        assert_eq!(out.value["edges"].as_array().unwrap().len(), 1);
        assert_eq!(out.value["nodes"][0]["properties"]["email"], EXCLUDED);
        assert!(out.truncated);
    }

    #[test]
    fn queries_naming_an_excluded_field_are_found() {
        let p = policy(&["kunden.email", "IBAN"], 10);
        assert_eq!(p.excluded_named_in("SELECT name, Email AS kontakt FROM kunden").as_deref(), Some("kunden.email"));
        assert_eq!(p.excluded_named_in("select k.iban from k").as_deref(), Some("iban"));
        assert_eq!(p.excluded_named_in("SELECT emails, xemail, iban_count FROM k"), None);
        assert_eq!(policy(&[], 10).excluded_named_in("SELECT email"), None);
        // Another table's field passes while the entry's table is not named in the query.
        assert_eq!(p.excluded_named_in("SELECT users.email FROM users"), None);
        assert_eq!(p.excluded_named_in("SELECT u.email FROM users u JOIN orders o ON true"), None);
        // Once the table is named anywhere, every mention refuses: aliases, subqueries, CTEs.
        for aliased in [
            "SELECT k.email AS kontakt FROM kunden k",
            "SELECT k.email FROM kunden AS k",
            "SELECT x.email FROM (SELECT * FROM kunden) x",
            "WITH k AS (SELECT * FROM kunden) SELECT k.email AS kontakt FROM k",
            "SELECT u.email FROM kunden k JOIN users u ON true",
            "SELECT kunden.email FROM kunden",
        ] {
            assert_eq!(p.excluded_named_in(aliased).as_deref(), Some("kunden.email"), "{aliased}");
        }
        let generic = policy(&["id", "kunden.name"], 10);
        assert_eq!(generic.excluded_named_in("SELECT id, name FROM users"), None, "generic names stay usable");
        assert_eq!(generic.excluded_named_in("SELECT id, name FROM kunden").as_deref(), Some("kunden.name"));
        assert_eq!(generic.excluded_named_in("SELECT k.name FROM KUNDEN k").as_deref(), Some("kunden.name"));
    }

    #[test]
    fn quoted_parts_of_errors_are_replaced_when_fields_are_excluded() {
        let p = policy(&["email"], 10);
        assert_eq!(
            p.error_text("invalid input syntax for type integer: \"ana@x.de\" near 'x"),
            "invalid input syntax for type integer: \"[excluded]\" near '[excluded]"
        );
        assert_eq!(policy(&[], 10).error_text("bad \"v\""), "bad \"v\"");
    }

    #[test]
    fn names_match_across_case_and_unicode_forms() {
        let p = policy(&["Kunden.Straße"], 10);
        assert!(p.excludes("STRASSE") && p.excludes("strasse") && p.excludes("ｓｔｒａｓｓｅ"));
        assert!(!p.excludes("strassen"));
    }

    #[test]
    fn json_columns_lose_excluded_paths_inside() {
        let frame = Frame::new(vec![Field {
            name: "daten".into(),
            field_type: FieldType::Json,
            unit: None,
            values: vec![json!({ "iban": "DE89", "name": "Ada" }), json!([{ "iban": "DE12" }])],
            labels: None,
        }])
        .unwrap();
        let out = result_for_model(&policy(&["iban"], 10), &QueryResult::Frame { frame }).unwrap();
        assert_eq!(
            out.value["fields"][0]["values"],
            json!([{ "iban": EXCLUDED, "name": "Ada" }, [{ "iban": EXCLUDED }]])
        );
        assert_eq!(out.excluded_values, 2);
    }

    #[test]
    fn stored_results_follow_rules_tightened_since() {
        let field = |name: &str, values: Vec<Value>| Field {
            name: name.into(),
            field_type: FieldType::String,
            unit: None,
            values,
            labels: None,
        };
        let frame = Frame::new(vec![
            field("name", vec![json!("Ada"), json!("Bob"), json!("Cem")]),
            field("email", vec![json!("ada@example.de"), Value::Null, json!("cem@example.de")]),
        ])
        .unwrap();
        let stored = result_for_model(&policy(&[], 10), &QueryResult::Frame { frame }).unwrap().value;
        // The same rules: nothing changes.
        let same = restrict_stored(&policy(&[], 10), &stored);
        assert!(!same.changed() && same.value.as_ref() == Some(&stored), "{same:?}");
        // A field excluded since, and a lower row limit.
        let now = restrict_stored(&policy(&["kunden.email"], 2), &stored);
        assert!(now.changed() && now.cut);
        assert_eq!(now.replaced, 1);
        let value = now.value.unwrap();
        assert_eq!(value["fields"][1]["values"], json!([EXCLUDED, null]));
        assert_eq!(value["fields"][0]["values"], json!(["Ada", "Bob"]));
        // Stored after excluding: checking it again under the same rules changes nothing.
        assert!(!restrict_stored(&policy(&["kunden.email"], 2), &value).changed());

        let doc = json!({ "name": "Ada", "konto": { "iban": "DE89" } });
        let documents = DocumentSet { documents: vec![OrderedJson::new(&doc).unwrap()], ..Default::default() };
        let stored = result_for_model(&policy(&[], 10), &QueryResult::Documents { documents }).unwrap().value;
        let now = restrict_stored(&policy(&["iban"], 10), &stored);
        assert_eq!((now.replaced, now.cut), (1, false));
        assert_eq!(now.value.unwrap()["documents"][0]["konto"]["iban"], EXCLUDED);

        let graph = json!({ "shape": "graph",
            "nodes": [{ "id": "a", "labels": ["Person"], "properties": { "email": "a@x.de" } },
                      { "id": "b", "labels": ["Person"], "properties": { "email": "b@x.de" } }],
            "edges": [{ "id": "e", "type": "KNOWS", "from": "a", "to": "b", "properties": { "seit": 2020 } }] });
        let now = restrict_stored(&policy(&["Person.email", "KNOWS.seit"], 1), &graph);
        let value = now.value.clone().unwrap();
        assert_eq!(value["nodes"].as_array().unwrap().len(), 1);
        assert_eq!(value["nodes"][0]["properties"]["email"], EXCLUDED);
        assert_eq!(value["edges"], json!([]), "an edge to a node cut away goes too");
        assert!(now.cut && now.replaced == 1);
        assert!(restrict_stored(&policy(&[], 10), &json!({ "shape": "other" })).changed(), "unknown shapes go");
    }

    #[test]
    fn entries_are_checked() {
        let ok = clean_excluded(&[" kunden.email ".into(), "KUNDEN.EMAIL".into(), "iban".into()]).unwrap();
        assert_eq!(ok, ["kunden.email", "iban"]);
        for bad in ["", "a..b", ".a", "a\nb"] {
            assert!(clean_excluded(&[bad.to_string()]).is_err(), "{bad:?}");
        }
        assert!(clean_excluded(&vec!["x".to_string(); MAX_EXCLUDED + 1]).is_err());
    }
}
