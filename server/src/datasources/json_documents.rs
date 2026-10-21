//! `documents` results from JSON (Elasticsearch hits, JSON and NDJSON files, HTTP JSON): a
//! builder that keeps the document and response size limits, and the schema sampled from the
//! documents (docs/api/datasources.md, "Documents").

use std::collections::{BTreeSet, HashMap};

use serde_json::Value;

use super::frame::{ResponseBudget, json_size};
use crate::shapes::{DocumentSet, FieldSchema, Truncated, TypeShare};

/// Documents the schema is sampled from (the first ones of the result).
const MAX_SAMPLE_DOCUMENTS: usize = 1_000;
/// Array elements looked at per array.
const MAX_SAMPLE_ELEMENTS: usize = 100;
/// Paths listed at most; documents with more fields list the first ones seen.
const MAX_PATHS: usize = 1_000;
/// Nesting followed at most.
const MAX_DEPTH: usize = 32;

/// Collects documents up to `max` and the response budget. The first document that does not fit
/// ends the result, which is then marked truncated.
pub struct DocumentsBuilder {
    docs: Vec<Value>,
    max: usize,
    budget: ResponseBudget,
    truncated: bool,
}

impl DocumentsBuilder {
    pub fn new(max: usize, budget: ResponseBudget) -> Self {
        Self { docs: Vec::new(), max: max.max(1), budget, truncated: false }
    }

    /// Adds a document; false (and nothing added) when a limit was reached.
    pub fn push(&mut self, doc: Value) -> bool {
        if self.truncated {
            return false;
        }
        if self.docs.len() >= self.max || !self.budget.take(json_size(&doc) + 1) {
            self.truncated = true;
            return false;
        }
        self.docs.push(doc);
        true
    }

    /// Marks the result cut off by a limit the source hit itself (a line too long for the
    /// budget, say).
    pub fn mark_truncated(&mut self) {
        self.truncated = true;
    }

    pub fn is_full(&self) -> bool {
        self.truncated
    }

    pub fn len(&self) -> usize {
        self.docs.len()
    }

    pub fn is_empty(&self) -> bool {
        self.docs.is_empty()
    }

    /// The documents with their schema. `truncated.limit` is the number of documents kept.
    pub fn finish(self) -> DocumentSet {
        let schema = sample_schema(&self.docs);
        let truncated = self.truncated.then(|| Truncated { limit: u32::try_from(self.docs.len()).unwrap_or(u32::MAX) });
        DocumentSet { documents: self.docs, schema, next_cursor: None, truncated }
    }
}

/// The JSON type name of a value as the schema lists it.
pub fn type_name(v: &Value) -> &'static str {
    match v {
        Value::Null => "null",
        Value::Bool(_) => "bool",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

#[derive(Default)]
struct PathStats {
    docs: usize,
    types: HashMap<&'static str, usize>,
}

/// Every field path of the first documents with how many have it and its types: object keys
/// joined with `.`, array elements as `[]` (`items[].price`). A path counts once per document,
/// however often it occurs in its arrays. A document that is not an object is listed as `$`.
pub fn sample_schema(docs: &[Value]) -> Vec<FieldSchema> {
    let sample = &docs[..docs.len().min(MAX_SAMPLE_DOCUMENTS)];
    let mut order: Vec<String> = Vec::new();
    let mut stats: HashMap<String, PathStats> = HashMap::new();
    for doc in sample {
        let mut seen: BTreeSet<(String, &'static str)> = BTreeSet::new();
        match doc {
            Value::Object(map) => {
                for (key, value) in map {
                    walk(key.clone(), value, 0, &mut seen);
                }
            }
            other => {
                seen.insert(("$".to_string(), type_name(other)));
            }
        }
        let mut paths_in_doc: BTreeSet<&str> = BTreeSet::new();
        for (path, ty) in &seen {
            if !stats.contains_key(path) {
                if order.len() >= MAX_PATHS {
                    continue;
                }
                order.push(path.clone());
            }
            let entry = stats.entry(path.clone()).or_default();
            if paths_in_doc.insert(path) {
                entry.docs += 1;
            }
            *entry.types.entry(ty).or_default() += 1;
        }
    }
    let total = sample.len().max(1) as f64;
    order
        .into_iter()
        .map(|path| {
            let s = &stats[&path];
            let mut types: Vec<TypeShare> = s
                .types
                .iter()
                .map(|(name, n)| TypeShare { name: (*name).to_string(), share: *n as f64 / s.docs.max(1) as f64 })
                .collect();
            types.sort_by(|a, b| b.share.total_cmp(&a.share).then_with(|| a.name.cmp(&b.name)));
            FieldSchema { coverage: s.docs as f64 / total, path, types }
        })
        .collect()
}

fn walk(path: String, value: &Value, depth: usize, seen: &mut BTreeSet<(String, &'static str)>) {
    if depth > MAX_DEPTH {
        return;
    }
    match value {
        Value::Object(map) => {
            for (key, v) in map {
                walk(format!("{path}.{key}"), v, depth + 1, seen);
            }
        }
        Value::Array(items) => {
            for item in items.iter().take(MAX_SAMPLE_ELEMENTS) {
                walk(format!("{path}[]"), item, depth + 1, seen);
            }
        }
        _ => {}
    }
    seen.insert((path, type_name(value)));
}

/// A connection for the unit tests of the JSON-based kinds.
#[cfg(test)]
pub(crate) async fn test_connection(
    settings: Value,
    secrets: &[(&str, &str)],
    policy: super::targets::TargetPolicy,
) -> super::Connection {
    let db = crate::db::connect("sqlite::memory:", 1).await.unwrap();
    let secrets = secrets.iter().map(|(k, v)| (k.to_string(), zeroize::Zeroizing::new(v.to_string()))).collect();
    super::Connection::new(
        "ds",
        settings,
        secrets,
        std::sync::Arc::new(policy),
        std::sync::Arc::new(super::OwnDatabase::new(db, "sqlite::memory:")),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_schema_lists_paths_with_coverage_and_types() {
        let docs = vec![
            json!({ "name": "Jörg", "alter": 41, "tags": ["a", "b"], "adresse": { "ort": "Wien" } }),
            json!({ "name": "Anna", "alter": "unbekannt", "items": [{ "preis": 2.5 }, { "preis": null }] }),
            json!(7),
        ];
        let schema = sample_schema(&docs);
        let get = |p: &str| schema.iter().find(|f| f.path == p).unwrap_or_else(|| panic!("{p} in {schema:?}"));
        assert!((get("name").coverage - 2.0 / 3.0).abs() < 1e-9);
        let alter = get("alter");
        assert_eq!(alter.types.len(), 2);
        assert!((alter.types[0].share - 0.5).abs() < 1e-9);
        assert_eq!(get("tags").types[0].name, "array");
        assert_eq!(get("tags[]").types[0].name, "string");
        assert_eq!(get("adresse.ort").types[0].name, "string");
        // Both elements of `items` count once for the document, with both types.
        let preis = get("items[].preis");
        assert!((preis.coverage - 1.0 / 3.0).abs() < 1e-9);
        assert_eq!(preis.types.iter().map(|t| t.name.as_str()).collect::<Vec<_>>(), ["null", "number"]);
        assert_eq!(get("$").types[0].name, "number");
    }

    #[test]
    fn documents_keep_to_the_count_and_the_budget() {
        let mut b = DocumentsBuilder::new(2, ResponseBudget::new(1 << 20));
        assert!(b.push(json!({ "a": 1 })));
        assert!(b.push(json!({ "a": 2 })));
        assert!(!b.push(json!({ "a": 3 })));
        let set = b.finish();
        assert_eq!(set.documents.len(), 2);
        assert_eq!(set.truncated, Some(Truncated { limit: 2 }));

        let mut b = DocumentsBuilder::new(100, ResponseBudget::new(30));
        assert!(b.push(json!({ "a": "x" })));
        assert!(!b.push(json!({ "a": "y".repeat(40) })));
        assert!(b.is_full());
        assert_eq!(b.finish().truncated, Some(Truncated { limit: 1 }));

        let untouched = DocumentsBuilder::new(10, ResponseBudget::new(1 << 20)).finish();
        assert_eq!(untouched.truncated, None);
    }
}
