//! GraphSON 3.0 answers of Gremlin Server: typed values (`{"@type": "g:Int64", "@value": 1}`)
//! read into plain values, and the graph elements among them (`g:Vertex`, `g:Edge`, `g:Path`).

use std::collections::BTreeMap;

use serde_json::{Map, Value, json};

use super::super::graph::{float_value, int_value};

/// How deep a value may nest before the rest is cut.
const MAX_DEPTH: usize = 64;

#[derive(Clone, Debug, PartialEq)]
pub enum Gv {
    /// A plain value (numbers already made safe for JavaScript).
    Plain(Value),
    List(Vec<Gv>),
    /// Key and value pairs; keys may be tokens (`T.id` reads as `id`) or other values.
    Map(Vec<(Gv, Gv)>),
    Vertex {
        id: String,
        label: String,
        properties: BTreeMap<String, Value>,
    },
    Edge {
        id: String,
        label: String,
        out_v: String,
        out_label: String,
        in_v: String,
        in_label: String,
        properties: BTreeMap<String, Value>,
    },
    Path(Vec<Gv>),
}

fn inner(v: &Value) -> Option<(&str, &Value)> {
    let m = v.as_object()?;
    if m.len() != 2 {
        return None;
    }
    Some((m.get("@type")?.as_str()?, m.get("@value")?))
}

/// An element id as text: numbers and strings as they are, anything else as its JSON.
pub fn id_text(v: &Value) -> String {
    match plain(v, 0) {
        Value::String(s) => s,
        Value::Number(n) => n.to_string(),
        Value::Object(m) if m.get("$type").is_some() => {
            m.get("value").and_then(Value::as_str).unwrap_or("").to_string()
        }
        other => other.to_string(),
    }
}

/// A typed value as a plain one: numbers made safe, dates and ids as typed text, lists and maps
/// as arrays and objects (map keys as text).
pub fn plain(v: &Value, depth: usize) -> Value {
    if depth > MAX_DEPTH {
        return Value::Null;
    }
    to_plain(&decode(v, depth))
}

pub fn to_plain(g: &Gv) -> Value {
    match g {
        Gv::Plain(v) => v.clone(),
        Gv::List(items) => Value::Array(items.iter().map(to_plain).collect()),
        Gv::Map(pairs) => {
            let mut m = Map::new();
            for (k, v) in pairs {
                m.insert(key_text(k), to_plain(v));
            }
            Value::Object(m)
        }
        Gv::Vertex { id, label, properties } => {
            let mut m = Map::new();
            m.insert("id".into(), json!(id));
            m.insert("label".into(), json!(label));
            m.extend(properties.iter().map(|(k, v)| (k.clone(), v.clone())));
            Value::Object(m)
        }
        Gv::Edge { id, label, out_v, in_v, properties, .. } => {
            let mut m = Map::new();
            m.insert("id".into(), json!(id));
            m.insert("label".into(), json!(label));
            m.insert("outV".into(), json!(out_v));
            m.insert("inV".into(), json!(in_v));
            m.extend(properties.iter().map(|(k, v)| (k.clone(), v.clone())));
            Value::Object(m)
        }
        Gv::Path(objects) => Value::Array(objects.iter().map(to_plain).collect()),
    }
}

pub fn key_text(k: &Gv) -> String {
    match k {
        Gv::Plain(Value::String(s)) => s.clone(),
        Gv::Plain(Value::Object(m)) if m.get("$type").is_some() => {
            m.get("value").and_then(Value::as_str).unwrap_or("").to_string()
        }
        other => to_plain(other).to_string(),
    }
}

fn number(t: &str, v: &Value) -> Value {
    match (t, v) {
        (_, Value::Number(n)) => match n.as_i64() {
            Some(i) => int_value(i),
            None => n.as_f64().map_or(Value::Null, float_value),
        },
        // NaN and the infinities arrive as text.
        (_, Value::String(s)) => match s.as_str() {
            "NaN" => crate::shapes::typed("float", "NaN"),
            "Infinity" => crate::shapes::typed("float", "Infinity"),
            "-Infinity" => crate::shapes::typed("float", "-Infinity"),
            _ => crate::shapes::typed(t.trim_start_matches("g:").trim_start_matches("gx:"), s.clone()),
        },
        _ => Value::Null,
    }
}

fn properties_of(v: &Value, depth: usize) -> BTreeMap<String, Value> {
    let mut out = BTreeMap::new();
    let Some(m) = v.get("properties").and_then(Value::as_object) else { return out };
    for (k, p) in m {
        // Vertex properties come as lists (multi-properties), edge properties as one.
        let values: Vec<Value> = match p {
            Value::Array(items) => items.iter().map(|i| property_value(i, depth)).collect(),
            one => vec![property_value(one, depth)],
        };
        let value = match <[Value; 1]>::try_from(values) {
            Ok([one]) => one,
            Err(many) => Value::Array(many),
        };
        out.insert(k.clone(), value);
    }
    out
}

fn property_value(p: &Value, depth: usize) -> Value {
    match inner(p) {
        Some(("g:VertexProperty" | "g:Property", body)) => {
            body.get("value").map_or(Value::Null, |v| plain(v, depth + 1))
        }
        _ => plain(p, depth + 1),
    }
}

/// Reads one GraphSON value.
pub fn decode(v: &Value, depth: usize) -> Gv {
    if depth > MAX_DEPTH {
        return Gv::Plain(Value::Null);
    }
    let Some((t, body)) = inner(v) else {
        return Gv::Plain(match v {
            Value::Number(n) => match n.as_i64() {
                Some(i) => int_value(i),
                None => n.as_f64().map_or(Value::Null, float_value),
            },
            Value::Array(a) => Value::Array(a.iter().map(|x| plain(x, depth + 1)).collect()),
            Value::Object(m) => Value::Object(m.iter().map(|(k, x)| (k.clone(), plain(x, depth + 1))).collect()),
            other => other.clone(),
        });
    };
    match t {
        "g:Int32" | "g:Int64" | "g:Float" | "g:Double" | "gx:Int16" | "gx:Byte" | "gx:BigInteger" | "gx:BigDecimal" => {
            Gv::Plain(number(t, body))
        }
        "g:List" | "g:Set" => {
            Gv::List(body.as_array().map(|a| a.iter().map(|x| decode(x, depth + 1)).collect()).unwrap_or_default())
        }
        "g:BulkSet" => {
            let mut out = Vec::new();
            for pair in body.as_array().map(Vec::as_slice).unwrap_or_default().chunks(2) {
                let n = pair.get(1).map(|b| id_text(b).parse::<usize>().unwrap_or(1)).unwrap_or(1);
                let item = decode(&pair[0], depth + 1);
                out.extend(std::iter::repeat_n(item, n.min(10_000)));
            }
            Gv::List(out)
        }
        "g:Map" => {
            let items = body.as_array().map(Vec::as_slice).unwrap_or_default();
            Gv::Map(
                items
                    .chunks(2)
                    .filter(|p| p.len() == 2)
                    .map(|p| (decode(&p[0], depth + 1), decode(&p[1], depth + 1)))
                    .collect(),
            )
        }
        "g:Traverser" => body.get("value").map_or(Gv::Plain(Value::Null), |x| decode(x, depth + 1)),
        "g:Vertex" => Gv::Vertex {
            id: body.get("id").map(id_text).unwrap_or_default(),
            label: body.get("label").and_then(Value::as_str).unwrap_or("").to_string(),
            properties: properties_of(body, depth),
        },
        "g:Edge" => Gv::Edge {
            id: body.get("id").map(id_text).unwrap_or_default(),
            label: body.get("label").and_then(Value::as_str).unwrap_or("").to_string(),
            out_v: body.get("outV").map(id_text).unwrap_or_default(),
            out_label: body.get("outVLabel").and_then(Value::as_str).unwrap_or("").to_string(),
            in_v: body.get("inV").map(id_text).unwrap_or_default(),
            in_label: body.get("inVLabel").and_then(Value::as_str).unwrap_or("").to_string(),
            properties: properties_of(body, depth),
        },
        "g:Path" => match decode(body.get("objects").unwrap_or(&Value::Null), depth + 1) {
            Gv::List(objects) => Gv::Path(objects),
            other => Gv::Path(vec![other]),
        },
        "g:VertexProperty" | "g:Property" => Gv::Plain(body.get("value").map_or(Value::Null, |x| plain(x, depth + 1))),
        "g:T" | "g:Direction" | "g:Order" | "g:Column" | "g:Pop" | "g:Scope" => Gv::Plain(body.clone()),
        "g:Date" | "g:Timestamp" => Gv::Plain(match body.as_i64() {
            Some(ms) => crate::shapes::typed("date", chrono_text(ms)),
            None => body.clone(),
        }),
        "g:UUID" => Gv::Plain(crate::shapes::typed("uuid", body.as_str().unwrap_or("").to_string())),
        "g:Class" => Gv::Plain(body.clone()),
        other => Gv::Plain(crate::shapes::typed(
            other.trim_start_matches("g:").trim_start_matches("gx:"),
            plain(body, depth + 1).to_string(),
        )),
    }
}

fn chrono_text(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .map_or_else(|| ms.to_string(), |d| d.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
}

/// Whether a value holds a vertex, an edge or a path of them.
pub fn has_elements(g: &Gv, depth: usize) -> bool {
    if depth > MAX_DEPTH {
        return false;
    }
    match g {
        Gv::Vertex { .. } | Gv::Edge { .. } => true,
        Gv::Path(objects) | Gv::List(objects) => objects.iter().any(|o| has_elements(o, depth + 1)),
        Gv::Map(pairs) => pairs.iter().any(|(_, v)| has_elements(v, depth + 1)),
        Gv::Plain(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn typed_values_read_as_plain_values() {
        let v = json!({ "@type": "g:Map", "@value": [
            { "@type": "g:T", "@value": "id" }, { "@type": "g:Int64", "@value": 9_007_199_254_740_993_i64 },
            "name", "marko",
            "ages", { "@type": "g:List", "@value": [{ "@type": "g:Int32", "@value": 29 }, { "@type": "g:Double", "@value": 1.5 }] },
            "when", { "@type": "g:Date", "@value": 1_800_000_000_000_i64 }
        ] });
        assert_eq!(
            plain(&v, 0),
            json!({ "id": { "$type": "int64", "value": "9007199254740993" }, "name": "marko", "ages": [29, 1.5],
                    "when": { "$type": "date", "value": "2027-01-15T08:00:00.000Z" } })
        );
        assert_eq!(
            plain(&json!({ "@type": "g:Double", "@value": "NaN" }), 0),
            json!({ "$type": "float", "value": "NaN" })
        );
    }

    #[test]
    fn elements_keep_their_ids_labels_and_properties() {
        let vertex = json!({ "@type": "g:Vertex", "@value": { "id": { "@type": "g:Int32", "@value": 1 }, "label": "person",
            "properties": {
                "name": [{ "@type": "g:VertexProperty", "@value": { "id": { "@type": "g:Int64", "@value": 0 }, "value": "marko", "label": "name" } }],
                "nick": [
                    { "@type": "g:VertexProperty", "@value": { "id": 1, "value": "m", "label": "nick" } },
                    { "@type": "g:VertexProperty", "@value": { "id": 2, "value": "mk", "label": "nick" } }
                ]
            } } });
        let Gv::Vertex { id, label, properties } = decode(&vertex, 0) else { panic!() };
        assert_eq!((id.as_str(), label.as_str()), ("1", "person"));
        assert_eq!(properties["name"], "marko");
        assert_eq!(properties["nick"], json!(["m", "mk"]));
        let edge = json!({ "@type": "g:Edge", "@value": { "id": { "@type": "g:Int32", "@value": 7 }, "label": "knows",
            "inVLabel": "person", "outVLabel": "person", "inV": { "@type": "g:Int32", "@value": 2 }, "outV": { "@type": "g:Int32", "@value": 1 },
            "properties": { "weight": { "@type": "g:Property", "@value": { "key": "weight", "value": { "@type": "g:Double", "@value": 0.5 } } } } } });
        let Gv::Edge { id, out_v, in_v, properties, .. } = decode(&edge, 0) else { panic!() };
        assert_eq!((id.as_str(), out_v.as_str(), in_v.as_str()), ("7", "1", "2"));
        assert_eq!(properties["weight"], 0.5);
        let path = json!({ "@type": "g:Path", "@value": { "labels": { "@type": "g:List", "@value": [] },
            "objects": { "@type": "g:List", "@value": [vertex, edge] } } });
        assert!(has_elements(&decode(&path, 0), 0));
        let names = json!({ "@type": "g:Path", "@value": { "labels": [], "objects": { "@type": "g:List", "@value": ["a", "b"] } } });
        assert!(!has_elements(&decode(&names, 0), 0));
        assert_eq!(plain(&names, 0), json!(["a", "b"]));
    }

    #[test]
    fn traversers_and_bulk_sets_unfold() {
        let t =
            json!({ "@type": "g:Traverser", "@value": { "bulk": { "@type": "g:Int64", "@value": 2 }, "value": "x" } });
        assert_eq!(decode(&t, 0), Gv::Plain(json!("x")));
        let b = json!({ "@type": "g:BulkSet", "@value": ["a", { "@type": "g:Int64", "@value": 2 }, "b", { "@type": "g:Int64", "@value": 1 }] });
        assert_eq!(plain(&b, 0), json!(["a", "a", "b"]));
    }
}
