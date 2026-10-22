//! The schema sample of every document source (MongoDB, Elasticsearch hits, JSON files, HTTP
//! JSON): every field path with its types and the share of documents that have it
//! (docs/api/datasources.md, "The documents shape"). Each source names its own types (MongoDB
//! its BSON aliases, the JSON sources the JSON types); the walk and the limits are shared.

use std::collections::{BTreeSet, HashMap};

use crate::shapes::{FieldSchema, TypeShare};

/// Documents of a result the schema is sampled from (the first ones).
pub const SAMPLE_DOCUMENTS: usize = 1_000;
/// Paths listed at most; documents with more fields list the first ones seen.
const MAX_PATHS: usize = 2_000;
/// Nesting levels followed at most.
const MAX_DEPTH: usize = 32;
/// Elements looked at per array.
const MAX_ELEMENTS: usize = 100;

/// What the sampler sees of a value: its type name and, for containers, what is inside.
pub enum Inner<'a, V> {
    Object(Box<dyn Iterator<Item = (&'a str, &'a V)> + 'a>),
    Array(&'a [V]),
    Leaf,
}

/// A value the schema sample can walk.
pub trait Sampled: Sized {
    /// The type name the schema lists.
    fn type_name(&self) -> &'static str;
    fn inner(&self) -> Inner<'_, Self>;
}

/// Counts field paths and their types over a sample of documents.
#[derive(Default)]
pub struct SchemaSampler {
    documents: usize,
    /// In order of first appearance.
    paths: Vec<PathStats>,
    index: HashMap<String, usize>,
}

struct PathStats {
    path: String,
    /// Documents that contain the path.
    documents: usize,
    /// Per type: documents in which the path has a value of that type.
    types: Vec<(&'static str, usize)>,
}

type Seen = HashMap<usize, BTreeSet<&'static str>>;

impl SchemaSampler {
    /// Adds one document. A document that is not an object is listed as the path `$`.
    pub fn add<V: Sampled>(&mut self, doc: &V) {
        match doc.inner() {
            Inner::Object(fields) => self.add_fields(fields),
            _ => {
                self.documents += 1;
                let mut seen = Seen::new();
                if let Some(i) = self.slot("$") {
                    seen.entry(i).or_default().insert(doc.type_name());
                }
                self.count(seen);
            }
        }
    }

    /// Adds one document given as its fields.
    pub fn add_fields<'a, V: Sampled + 'a>(&mut self, fields: impl Iterator<Item = (&'a str, &'a V)>) {
        self.documents += 1;
        let mut seen = Seen::new();
        for (key, value) in fields {
            self.walk(value, key, 0, &mut seen);
        }
        self.count(seen);
    }

    /// The number of documents added.
    pub fn len(&self) -> usize {
        self.documents
    }

    pub fn is_empty(&self) -> bool {
        self.documents == 0
    }

    fn count(&mut self, seen: Seen) {
        for (i, types) in seen {
            let stats = &mut self.paths[i];
            stats.documents += 1;
            for t in types {
                match stats.types.iter_mut().find(|(name, _)| *name == t) {
                    Some((_, n)) => *n += 1,
                    None => stats.types.push((t, 1)),
                }
            }
        }
    }

    fn slot(&mut self, path: &str) -> Option<usize> {
        if let Some(i) = self.index.get(path) {
            return Some(*i);
        }
        if self.paths.len() >= MAX_PATHS {
            return None;
        }
        self.paths.push(PathStats { path: path.to_string(), documents: 0, types: Vec::new() });
        self.index.insert(path.to_string(), self.paths.len() - 1);
        Some(self.paths.len() - 1)
    }

    fn walk<V: Sampled>(&mut self, value: &V, path: &str, depth: usize, seen: &mut Seen) {
        if depth > MAX_DEPTH {
            return;
        }
        let Some(i) = self.slot(path) else { return };
        seen.entry(i).or_default().insert(value.type_name());
        match value.inner() {
            Inner::Object(fields) => {
                for (key, v) in fields {
                    self.walk(v, &format!("{path}.{key}"), depth + 1, seen);
                }
            }
            Inner::Array(items) => {
                let child = format!("{path}[]");
                for item in items.iter().take(MAX_ELEMENTS) {
                    self.walk(item, &child, depth + 1, seen);
                }
            }
            Inner::Leaf => {}
        }
    }

    pub fn finish(self) -> Vec<FieldSchema> {
        let total = self.documents.max(1) as f64;
        self.paths
            .into_iter()
            .filter(|p| p.documents > 0)
            .map(|p| {
                let with = p.documents as f64;
                let mut types: Vec<TypeShare> = p
                    .types
                    .into_iter()
                    .map(|(name, n)| TypeShare { name: name.to_string(), share: n as f64 / with })
                    .collect();
                types.sort_by(|a, b| b.share.total_cmp(&a.share).then_with(|| a.name.cmp(&b.name)));
                FieldSchema { path: p.path, coverage: with / total, types }
            })
            .collect()
    }
}

/// JSON values, with the JSON type names.
impl Sampled for serde_json::Value {
    fn type_name(&self) -> &'static str {
        use serde_json::Value;
        match self {
            Value::Null => "null",
            Value::Bool(_) => "bool",
            Value::Number(_) => "number",
            Value::String(_) => "string",
            Value::Array(_) => "array",
            Value::Object(_) => "object",
        }
    }

    fn inner(&self) -> Inner<'_, Self> {
        use serde_json::Value;
        match self {
            Value::Object(map) => Inner::Object(Box::new(map.iter().map(|(k, v)| (k.as_str(), v)))),
            Value::Array(items) => Inner::Array(items),
            _ => Inner::Leaf,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn sample(docs: &[Value]) -> Vec<FieldSchema> {
        let mut s = SchemaSampler::default();
        for d in docs {
            s.add(d);
        }
        s.finish()
    }

    #[test]
    fn the_schema_lists_paths_with_coverage_and_types() {
        let docs = vec![
            json!({ "name": "Jörg", "alter": 41, "tags": ["a", "b"], "adresse": { "ort": "Wien" } }),
            json!({ "name": "Anna", "alter": "unbekannt", "items": [{ "preis": 2.5 }, { "preis": null }] }),
            json!(7),
        ];
        let schema = sample(&docs);
        let get = |p: &str| schema.iter().find(|f| f.path == p).unwrap_or_else(|| panic!("{p} in {schema:?}"));
        assert!((get("name").coverage - 2.0 / 3.0).abs() < 1e-9);
        let alter = get("alter");
        assert_eq!(alter.types.len(), 2);
        assert!((alter.types[0].share - 0.5).abs() < 1e-9);
        assert_eq!(get("tags").types[0].name, "array");
        assert_eq!(get("tags[]").types[0].name, "string");
        assert_eq!(get("adresse").types[0].name, "object");
        assert_eq!(get("adresse.ort").types[0].name, "string");
        // Both elements of `items` count once for the document, with both types: each share
        // counts documents, so they add up to more than 1.
        let preis = get("items[].preis");
        assert!((preis.coverage - 1.0 / 3.0).abs() < 1e-9);
        assert_eq!(preis.types.iter().map(|t| t.name.as_str()).collect::<Vec<_>>(), ["null", "number"]);
        assert!(preis.types.iter().all(|t| t.share == 1.0));
        assert_eq!(get("$").types[0].name, "number");
        assert!((get("$").coverage - 1.0 / 3.0).abs() < 1e-9);
        assert!(sample(&[]).is_empty());
    }

    #[test]
    fn paths_keep_the_order_they_first_appear_in() {
        let schema = sample(&[json!({ "b": { "c": 1 } }), json!({ "a": 1 })]);
        let paths: Vec<&str> = schema.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, ["b", "b.c", "a"]);
    }

    #[test]
    fn the_walk_keeps_to_its_limits() {
        // Only the first elements of an array are looked at.
        let mut items: Vec<Value> = (0..MAX_ELEMENTS).map(|_| json!(1)).collect();
        items.push(json!("late"));
        let schema = sample(&[json!({ "items": items })]);
        let elems = schema.iter().find(|f| f.path == "items[]").unwrap();
        assert_eq!(elems.types.iter().map(|t| t.name.as_str()).collect::<Vec<_>>(), ["number"]);

        // Paths beyond the cap are left out.
        let wide: serde_json::Map<String, Value> =
            (0..MAX_PATHS + 10).map(|i| (format!("f{i:05}"), json!(i))).collect();
        assert_eq!(sample(&[Value::Object(wide)]).len(), MAX_PATHS);

        // Nesting beyond the cap is not followed.
        let mut deep = json!(1);
        for _ in 0..MAX_DEPTH + 10 {
            deep = json!({ "x": deep });
        }
        let schema = sample(&[deep]);
        assert_eq!(schema.len(), MAX_DEPTH + 1);
    }
}
