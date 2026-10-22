//! BSON documents as the `documents` shape: values JSON has no type for keep their BSON type as
//! `{"$type", "value"}` (docs/api/datasources.md, "The documents shape"), and the shared schema
//! sample sees them with their BSON type aliases.

use std::collections::BTreeSet;

use bson::spec::BinarySubtype;
use bson::{Bson, Document};
use serde_json::{Value, json};

use crate::datasources::document_schema::{Inner, Sampled, SchemaSampler};
use crate::shapes::typed;

/// A converted value that keeps the field order of the stored document (`serde_json::Map` sorts
/// its keys). Serializes as plain JSON.
#[derive(Clone, Debug, PartialEq)]
pub enum Ordered {
    Leaf(Value),
    Array(Vec<Ordered>),
    Object(Vec<(String, Ordered)>),
}

impl serde::Serialize for Ordered {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::{SerializeMap, SerializeSeq};
        match self {
            Ordered::Leaf(v) => v.serialize(serializer),
            Ordered::Array(items) => {
                let mut seq = serializer.serialize_seq(Some(items.len()))?;
                for item in items {
                    seq.serialize_element(item)?;
                }
                seq.end()
            }
            Ordered::Object(fields) => {
                let mut map = serializer.serialize_map(Some(fields.len()))?;
                for (k, v) in fields {
                    map.serialize_entry(k, v)?;
                }
                map.end()
            }
        }
    }
}

impl Ordered {
    /// As a `serde_json::Value` (which sorts object keys).
    pub fn to_value(&self) -> Value {
        match self {
            Ordered::Leaf(v) => v.clone(),
            Ordered::Array(items) => Value::Array(items.iter().map(Ordered::to_value).collect()),
            Ordered::Object(fields) => Value::Object(fields.iter().map(|(k, v)| (k.clone(), v.to_value())).collect()),
        }
    }

    /// As JSON text in the stored order, for the documents shape.
    pub fn to_json(&self) -> crate::shapes::OrderedJson {
        crate::shapes::OrderedJson::new(self).expect("converted values always serialize")
    }
}

/// Converts documents, noting the paths whose binary values are hidden.
#[derive(Default)]
pub struct Converter {
    /// Paths (as in the schema) with binary values that are not shown.
    pub binary_paths: BTreeSet<String>,
}

impl Converter {
    pub fn document(&mut self, doc: &Document) -> Ordered {
        self.doc_at(doc, "")
    }

    fn doc_at(&mut self, doc: &Document, path: &str) -> Ordered {
        let fields: Vec<(String, Ordered)> =
            doc.iter().map(|(key, value)| (key.clone(), self.value_at(value, &join(path, key)))).collect();
        // A stored document that itself has a `$type` key would read as a typed value; it is
        // wrapped so the two cannot be confused.
        if fields.iter().any(|(k, _)| k == "$type") {
            return Ordered::Object(vec![
                ("$type".into(), Ordered::Leaf(json!("document"))),
                ("value".into(), Ordered::Object(fields)),
            ]);
        }
        Ordered::Object(fields)
    }

    pub fn value_at(&mut self, value: &Bson, path: &str) -> Ordered {
        match value {
            Bson::Array(items) => {
                let child = format!("{path}[]");
                Ordered::Array(items.iter().map(|v| self.value_at(v, &child)).collect())
            }
            Bson::Document(doc) => self.doc_at(doc, path),
            other => Ordered::Leaf(self.scalar(other, path)),
        }
    }

    fn scalar(&mut self, value: &Bson, path: &str) -> Value {
        match value {
            Bson::Double(f) => match serde_json::Number::from_f64(*f) {
                Some(n) => Value::Number(n),
                None if f.is_nan() => typed("double", "NaN"),
                None if *f > 0.0 => typed("double", "Infinity"),
                None => typed("double", "-Infinity"),
            },
            Bson::String(s) => Value::String(s.clone()),
            Bson::Array(_) | Bson::Document(_) => unreachable!("value_at handles containers"),
            Bson::Boolean(b) => Value::Bool(*b),
            Bson::Null => Value::Null,
            Bson::RegularExpression(r) => typed("regex", format!("/{}/{}", r.pattern.as_str(), r.options.as_str())),
            Bson::JavaScriptCode(code) => typed("javascript", code.clone()),
            Bson::JavaScriptCodeWithScope(c) => typed("javascript", c.code.clone()),
            Bson::Int32(i) => json!(i),
            Bson::Int64(i) => typed("int64", i.to_string()),
            Bson::Timestamp(t) => typed("timestamp", format!("{}:{}", t.time, t.increment)),
            Bson::Binary(b) => {
                if b.subtype == BinarySubtype::Uuid
                    && let Ok(u) = uuid::Uuid::from_slice(&b.bytes)
                {
                    return typed("uuid", u.hyphenated().to_string());
                }
                self.binary_paths.insert(path.to_string());
                json!({ "$type": "binary", "value": null })
            }
            Bson::ObjectId(oid) => typed("objectId", oid.to_hex()),
            Bson::DateTime(d) => typed("date", d.timestamp_millis().to_string()),
            Bson::Symbol(s) => typed("symbol", s.clone()),
            Bson::Decimal128(d) => typed("decimal", d.to_string()),
            Bson::Undefined => typed("undefined", ""),
            Bson::MaxKey => typed("maxKey", ""),
            Bson::MinKey => typed("minKey", ""),
            Bson::DbPointer(_) => json!({ "$type": "dbPointer", "value": null }),
        }
    }
}

fn join(path: &str, key: &str) -> String {
    if path.is_empty() { key.to_string() } else { format!("{path}.{key}") }
}

/// MongoDB's own alias for a value's type, as `$type` queries use it.
pub fn type_name(value: &Bson) -> &'static str {
    match value {
        Bson::Double(_) => "double",
        Bson::String(_) => "string",
        Bson::Array(_) => "array",
        Bson::Document(_) => "object",
        Bson::Boolean(_) => "bool",
        Bson::Null => "null",
        Bson::RegularExpression(_) => "regex",
        Bson::JavaScriptCode(_) => "javascript",
        Bson::JavaScriptCodeWithScope(_) => "javascriptWithScope",
        Bson::Int32(_) => "int",
        Bson::Int64(_) => "long",
        Bson::Timestamp(_) => "timestamp",
        Bson::Binary(_) => "binData",
        Bson::ObjectId(_) => "objectId",
        Bson::DateTime(_) => "date",
        Bson::Symbol(_) => "symbol",
        Bson::Decimal128(_) => "decimal",
        Bson::Undefined => "undefined",
        Bson::MaxKey => "maxKey",
        Bson::MinKey => "minKey",
        Bson::DbPointer(_) => "dbPointer",
    }
}

/// BSON values for the shared schema sample, with MongoDB's type aliases.
impl Sampled for Bson {
    fn type_name(&self) -> &'static str {
        type_name(self)
    }

    fn inner(&self) -> Inner<'_, Self> {
        match self {
            Bson::Document(d) => Inner::Object(Box::new(d.iter().map(|(k, v)| (k.as_str(), v)))),
            Bson::Array(items) => Inner::Array(items),
            _ => Inner::Leaf,
        }
    }
}

/// Adds a stored document to the schema sample.
pub fn sample(sampler: &mut SchemaSampler, doc: &Document) {
    sampler.add_fields(doc.iter().map(|(k, v)| (k.as_str(), v)));
}

#[cfg(test)]
mod tests {
    use super::*;
    use bson::{Binary, Decimal128, doc, oid::ObjectId};

    #[test]
    fn bson_types_keep_their_type() {
        let oid = ObjectId::parse_str("65f0c1a2b3c4d5e6f7a8b9c0").unwrap();
        let uuid = uuid::Uuid::parse_str("0199f0a0-0000-7000-8000-000000000001").unwrap();
        let doc = doc! {
            "_id": oid,
            "n32": 7_i32,
            "n64": 9_007_199_254_740_993_i64,
            "f": 1.5,
            "nan": f64::NAN,
            "d": "12.50".parse::<Decimal128>().unwrap(),
            "t": bson::DateTime::from_millis(1_800_000_000_000),
            "bin": Binary { subtype: BinarySubtype::Generic, bytes: vec![1, 2, 3] },
            "id": Binary { subtype: BinarySubtype::Uuid, bytes: uuid.as_bytes().to_vec() },
            "nested": { "items": [{ "preis": 1 }, { "preis": Binary { subtype: BinarySubtype::Md5, bytes: vec![0; 16] } }] },
            "tricky": { "$type": "objectId", "value": "x" },
        };
        let mut c = Converter::default();
        let v = c.document(&doc).to_value();
        assert_eq!(v["_id"], json!({ "$type": "objectId", "value": "65f0c1a2b3c4d5e6f7a8b9c0" }));
        assert_eq!(v["n32"], 7);
        assert_eq!(v["n64"], json!({ "$type": "int64", "value": "9007199254740993" }));
        assert_eq!(v["f"], 1.5);
        assert_eq!(v["nan"], json!({ "$type": "double", "value": "NaN" }));
        assert_eq!(v["d"], json!({ "$type": "decimal", "value": "12.50" }));
        assert_eq!(v["t"], json!({ "$type": "date", "value": "1800000000000" }));
        assert_eq!(v["bin"], json!({ "$type": "binary", "value": null }));
        assert_eq!(v["id"], json!({ "$type": "uuid", "value": uuid.to_string() }));
        assert_eq!(v["nested"]["items"][0]["preis"], 1);
        assert_eq!(v["nested"]["items"][1]["preis"]["$type"], "binary");
        assert_eq!(v["tricky"]["$type"], "document", "a stored $type key is wrapped: {v}");
        assert_eq!(v["tricky"]["value"]["$type"], "objectId");
        assert_eq!(c.binary_paths.into_iter().collect::<Vec<_>>(), ["bin", "nested.items[].preis"]);
    }

    #[test]
    fn the_schema_counts_paths_types_and_coverage() {
        let mut s = SchemaSampler::default();
        sample(&mut s, &doc! { "a": 1_i32, "tags": ["x", "y"], "items": [{ "p": 1.5 }, { "p": 2_i32 }] });
        sample(&mut s, &doc! { "a": "eins", "items": [] });
        sample(&mut s, &doc! { "a": 2_i32, "b": { "c": true } });
        sample(&mut s, &doc! { "b": { "c": false } });
        let schema = s.finish();
        let get = |p: &str| schema.iter().find(|f| f.path == p).unwrap_or_else(|| panic!("{p}: {schema:?}"));
        let a = get("a");
        assert_eq!(a.coverage, 0.75);
        assert_eq!(a.types[0].name, "int");
        assert!((a.types[0].share - 2.0 / 3.0).abs() < 1e-9);
        assert_eq!(a.types[1].name, "string");
        assert_eq!(get("tags").coverage, 0.25);
        assert_eq!(get("tags[]").types[0].name, "string");
        assert_eq!(get("items").coverage, 0.5);
        let p = get("items[].p");
        assert_eq!(p.coverage, 0.25);
        // One document holds both types: each share counts documents, so they add up to more than 1.
        assert_eq!(p.types.len(), 2);
        assert!(p.types.iter().all(|t| t.share == 1.0));
        assert_eq!(get("b.c").coverage, 0.5);
        assert_eq!(get("b").types[0].name, "object");
        assert_eq!(schema[0].path, "a", "paths keep the order they first appear in");
        assert!(SchemaSampler::default().finish().is_empty());
    }

    #[test]
    fn documents_keep_their_field_order() {
        let mut c = Converter::default();
        let v = c.document(&doc! { "_id": 1_i32, "zeit": 2_i32, "betrag": { "z": 1_i32, "a": 2_i32 } });
        let text = serde_json::to_string(&v).unwrap();
        assert_eq!(text, r#"{"_id":1,"zeit":2,"betrag":{"z":1,"a":2}}"#, "the documents shape keeps the stored order");
        assert_eq!(v.to_json().get(), text);
    }

    #[test]
    fn nested_documents_keep_their_order_also_in_the_response_types() {
        let mut c = Converter::default();
        let v = c.document(&doc! { "_id": 1_i32, "zeit": 2_i32, "betrag": 3_i32, "tricky": { "z": 1_i32, "$type": "x", "a": 2_i32 }, "arr": [{ "y": 1_i32, "b": 2_i32 }] });
        assert_eq!(
            v.to_json().get(),
            r#"{"_id":1,"zeit":2,"betrag":3,"tricky":{"$type":"document","value":{"z":1,"$type":"x","a":2}},"arr":[{"y":1,"b":2}]}"#
        );
        let set = crate::shapes::DocumentSet { documents: vec![v.to_json()], ..Default::default() };
        let text = serde_json::to_string(&crate::shapes::QueryResult::Documents { documents: set }).unwrap();
        assert!(text.contains(r#"{"_id":1,"zeit":2,"betrag":3"#), "{text}");
    }
}
