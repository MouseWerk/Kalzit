//! The projection step (`toFrame`): a `documents` result as a frame, one column per field path.
//! It is the only way documents become a frame, and only where a panel or Explore stores the step
//! (docs/PLAN.md, section 1). The rules follow the documents UI (`ui/src/documents/projection.ts`)
//! and the UI's analysis engine (`ui/src/analysis/projection.ts`); both pass `conformance.json`.

use serde_json::{Map, Value};

use super::ProjectionColumn;
use super::expr::number_text;
use crate::shapes::{DocumentSet, Field, FieldType, Frame, FrameMeta};

/// The typed wrapper `{"$type", "value"}` exactly: two keys, so a field named `$type` is not one.
fn typed(value: &Value) -> Option<(&str, Option<&str>)> {
    let Value::Object(m) = value else { return None };
    let kind = m.get("$type")?.as_str()?;
    if kind == "document" || m.len() != 2 {
        return None;
    }
    match m.get("value")? {
        Value::String(s) => Some((kind, Some(s))),
        Value::Null => Some((kind, None)),
        _ => None,
    }
}

/// The document inside the wrapper of a document with its own `$type` key; anything else as is.
fn unwrap(value: &Value) -> &Value {
    if let Value::Object(m) = value
        && m.len() == 2
        && m.get("$type").and_then(Value::as_str) == Some("document")
        && let Some(inner @ Value::Object(_)) = m.get("value")
    {
        return inner;
    }
    value
}

fn object(value: &Value) -> Option<&Map<String, Value>> {
    match value {
        Value::Object(m) if typed(value).is_none() => Some(m),
        _ => None,
    }
}

/// The one value at a dotted path (`customer.city`, `items.0.price`); `None` when it is missing.
pub fn value_at<'a>(document: &'a Value, path: &str) -> Option<&'a Value> {
    let mut current = document;
    for part in path.split('.') {
        let value = unwrap(current);
        current = match value {
            Value::Array(items) if !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()) => {
                items.get(part.parse::<usize>().ok()?)?
            }
            _ => object(value)?.get(part)?,
        };
    }
    Some(current)
}

/// The column type a value reads as when the column does not name one.
fn type_for(value: &Value) -> FieldType {
    match typed(value).map(|t| t.0) {
        Some("date") => FieldType::Time,
        Some("decimal" | "double" | "int32" | "number") => FieldType::Number,
        Some("int64") => FieldType::Int64,
        Some("bool") => FieldType::Bool,
        Some("binary" | "object" | "array") => FieldType::Json,
        Some(_) => FieldType::String,
        None => match value {
            Value::Number(_) => FieldType::Number,
            Value::Bool(_) => FieldType::Bool,
            Value::Object(_) | Value::Array(_) => FieldType::Json,
            _ => FieldType::String,
        },
    }
}

/// Text as JavaScript's `Number(text)` reads it, for typed decimals and int64.
fn js_number(text: &str) -> Option<f64> {
    let t = text.trim();
    if t.is_empty() {
        return Some(0.0);
    }
    if let Some(hex) = t.strip_prefix("0x").or_else(|| t.strip_prefix("0X")) {
        return u64::from_str_radix(hex, 16).ok().map(|n| n as f64);
    }
    super::expr::parse_number(t)
}

/// Unix ms as a cell: whole numbers as integers, as times are everywhere else.
fn ms_cell(ms: f64) -> Value {
    if ms.fract() == 0.0 && ms.abs() < 9.2e18 { Value::from(ms as i64) } else { super::expr::to_json(super::expr::V::Num(ms)) }
}

/// A typed date's ms: its value is a decimal count of ms or an ISO 8601 time.
fn date_ms(text: Option<&str>) -> Option<f64> {
    let text = text.unwrap_or_default().trim();
    let digits = text.strip_prefix('-').unwrap_or(text);
    if !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()) {
        return text.parse::<f64>().ok().filter(|x| x.is_finite());
    }
    chrono::DateTime::parse_from_rfc3339(text).ok().map(|t| t.timestamp_millis() as f64)
}

/// One value in a column type; empty where it does not fit, nothing is guessed.
fn convert(value: Option<&Value>, field_type: FieldType) -> Value {
    let Some(value) = value.filter(|v| !v.is_null()) else { return Value::Null };
    let t = typed(value);
    match field_type {
        FieldType::Time => match (t, value) {
            (Some(("date", text)), _) => date_ms(text).map_or(Value::Null, ms_cell),
            (None, Value::Number(n)) => n.as_f64().filter(|x| x.is_finite()).map_or(Value::Null, ms_cell),
            _ => Value::Null,
        },
        FieldType::Number => match (t, value) {
            (None, Value::Number(_)) => value.clone(),
            (Some(("decimal" | "int64", text)), _) => js_number(text.unwrap_or_default())
                .filter(|x| x.is_finite())
                .map_or(Value::Null, |x| super::expr::to_json(super::expr::V::Num(x))),
            _ => Value::Null,
        },
        FieldType::Int64 => match (t, value) {
            (Some(("int64", text)), _) => text.map_or(Value::Null, Value::from),
            (None, Value::Number(n)) => match n.as_f64() {
                Some(x) if x.is_finite() && x.fract() == 0.0 => Value::from(number_text(x)),
                _ => Value::Null,
            },
            _ => Value::Null,
        },
        FieldType::Bool => if value.is_boolean() { value.clone() } else { Value::Null },
        FieldType::Json => value.clone(),
        FieldType::String => match (t, value) {
            (Some((_, text)), _) => text.map_or(Value::Null, Value::from),
            (None, Value::Array(_) | Value::Object(_)) => Value::from(value.to_string()),
            (None, Value::String(s)) => Value::from(s.as_str()),
            (None, Value::Number(n)) => Value::from(n.as_f64().map(number_text).unwrap_or_default()),
            (None, Value::Bool(b)) => Value::from(b.to_string()),
            _ => Value::Null,
        },
    }
}

/// The documents as a frame: one column per path, typed as named or by its first value.
pub fn project(set: &DocumentSet, columns: &[ProjectionColumn]) -> Frame {
    let fields: Vec<Field> = columns
        .iter()
        .filter(|c| !c.path.trim().is_empty())
        .map(|c| {
            let raw: Vec<Option<&Value>> = set.documents.iter().map(|d| value_at(d, &c.path)).collect();
            let first = raw.iter().flatten().find(|v| !v.is_null());
            let field_type = c.field_type.unwrap_or_else(|| first.map_or(FieldType::String, |v| type_for(v)));
            Field {
                name: c.name.clone().filter(|n| !n.is_empty()).unwrap_or_else(|| c.path.clone()),
                field_type,
                unit: None,
                values: raw.into_iter().map(|v| convert(v, field_type)).collect(),
                labels: None,
            }
        })
        .collect();
    let meta = FrameMeta { executed_query: None, rows_truncated: set.truncated.is_some(), notices: Vec::new() };
    Frame::new(fields).expect("one value per document in every column").with_meta(meta)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn column(path: &str) -> ProjectionColumn {
        ProjectionColumn { path: path.into(), name: None, field_type: None }
    }

    #[test]
    fn paths_reach_into_objects_arrays_and_wrapped_documents() {
        let doc = json!({ "a": { "b": [ { "c": 1 }, { "c": 2 } ] },
                          "w": { "$type": "document", "value": { "$type": "x", "k": 5 } },
                          "t": { "$type": "date", "value": "5" } });
        assert_eq!(value_at(&doc, "a.b.1.c"), Some(&json!(2)));
        assert_eq!(value_at(&doc, "a.b.9.c"), None);
        assert_eq!(value_at(&doc, "a.b.x"), None);
        assert_eq!(value_at(&doc, "w.k"), Some(&json!(5)));
        assert_eq!(value_at(&doc, "t.value"), None, "typed values are leaves");
        assert_eq!(value_at(&doc, "a.b.99999999999999999999999"), None);
    }

    #[test]
    fn columns_take_their_type_from_the_first_value_or_as_named() {
        let set = DocumentSet {
            documents: vec![
                json!({ "at": { "$type": "date", "value": "1767225600000" }, "n": { "$type": "int64", "value": "9007199254740993" },
                        "p": { "$type": "decimal", "value": "129.90" }, "tags": ["x"], "ok": true, "id": { "$type": "objectId", "value": "65f0" } }),
                json!({ "at": { "$type": "date", "value": "2026-01-02T00:00:00Z" }, "n": 7, "p": "teuer", "ok": "ja" }),
            ],
            schema: vec![],
            next_cursor: None,
            truncated: Some(crate::shapes::Truncated { limit: 2 }),
        };
        let mut named = column("p");
        named.name = Some("Preis".into());
        let mut as_text = column("n");
        as_text.field_type = Some(FieldType::String);
        as_text.name = Some(String::new());
        let frame = project(
            &set,
            &[column("at"), column("n"), named, column("tags"), column("ok"), column("id"), as_text, column(" ")],
        );
        let types: Vec<(&str, FieldType)> = frame.fields().iter().map(|f| (f.name.as_str(), f.field_type)).collect();
        assert_eq!(
            types,
            [
                ("at", FieldType::Time),
                ("n", FieldType::Int64),
                ("Preis", FieldType::Number),
                ("tags", FieldType::Json),
                ("ok", FieldType::Bool),
                ("id", FieldType::String),
                ("n", FieldType::String),
            ]
        );
        let values = |i: usize| frame.fields()[i].values.clone();
        assert_eq!(values(0), [json!(1_767_225_600_000_i64), json!(1_767_312_000_000_i64)]);
        assert_eq!(values(1), [json!("9007199254740993"), json!("7")]);
        assert_eq!(values(2), [json!(129.9), Value::Null]);
        assert_eq!(values(4), [json!(true), Value::Null]);
        assert_eq!(values(5), [json!("65f0"), Value::Null]);
        assert_eq!(values(6), [json!("9007199254740993"), json!("7")]);
        assert!(frame.meta().unwrap().rows_truncated);
    }
}
