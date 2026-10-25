//! The projection step (`toFrame`): a `documents` result as a frame, one column per field path.
//! It is the only way documents become a frame, and only where a panel or Explore stores the step
//! (docs/PLAN.md, section 1). The rules follow the documents UI (`ui/src/documents/projection.ts`)
//! and the UI's analysis engine (`ui/src/analysis/projection.ts`); both pass `conformance.json`.

use serde::Deserialize;
use serde_json::Value;

use super::ProjectionColumn;
use super::expr::{days_from_civil, days_in_month, number_text};
use crate::shapes::{DocumentSet, Field, FieldType, Frame, FrameMeta};

/// A document as the browser reads it: objects keep their keys in the stored order (the server
/// sends them so), so a container written out as text reads the same in both engines.
#[derive(Clone, Debug, PartialEq)]
enum J {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Arr(Vec<J>),
    Obj(Vec<(String, J)>),
}

impl<'de> Deserialize<'de> for J {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct Visit;
        impl<'de> serde::de::Visitor<'de> for Visit {
            type Value = J;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("JSON")
            }
            fn visit_unit<E>(self) -> Result<J, E> {
                Ok(J::Null)
            }
            fn visit_none<E>(self) -> Result<J, E> {
                Ok(J::Null)
            }
            fn visit_bool<E>(self, b: bool) -> Result<J, E> {
                Ok(J::Bool(b))
            }
            fn visit_i64<E>(self, n: i64) -> Result<J, E> {
                Ok(J::Num(n as f64))
            }
            fn visit_u64<E>(self, n: u64) -> Result<J, E> {
                Ok(J::Num(n as f64))
            }
            fn visit_f64<E>(self, n: f64) -> Result<J, E> {
                Ok(J::Num(n))
            }
            fn visit_str<E>(self, s: &str) -> Result<J, E> {
                Ok(J::Str(s.to_string()))
            }
            fn visit_string<E>(self, s: String) -> Result<J, E> {
                Ok(J::Str(s))
            }
            fn visit_seq<A: serde::de::SeqAccess<'de>>(self, mut seq: A) -> Result<J, A::Error> {
                let mut out = Vec::new();
                while let Some(v) = seq.next_element()? {
                    out.push(v);
                }
                Ok(J::Arr(out))
            }
            fn visit_map<A: serde::de::MapAccess<'de>>(self, mut map: A) -> Result<J, A::Error> {
                let mut out: Vec<(String, J)> = Vec::new();
                while let Some((k, v)) = map.next_entry::<String, J>()? {
                    // As JSON.parse: a repeated key keeps its first place and its last value.
                    match out.iter_mut().find(|(key, _)| *key == k) {
                        Some(slot) => slot.1 = v,
                        None => out.push((k, v)),
                    }
                }
                Ok(J::Obj(out))
            }
        }
        d.deserialize_any(Visit)
    }
}

impl J {
    fn get(&self, key: &str) -> Option<&J> {
        match self {
            J::Obj(m) => m.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    fn as_str(&self) -> Option<&str> {
        if let J::Str(s) = self { Some(s) } else { None }
    }

    /// As `JSON.stringify` writes it: numbers as JavaScript writes them, keys in their order.
    fn text(&self, out: &mut String) {
        match self {
            J::Null => out.push_str("null"),
            J::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
            J::Num(x) if x.is_finite() => out.push_str(&number_text(*x)),
            J::Num(_) => out.push_str("null"),
            J::Str(s) => out.push_str(&serde_json::to_string(s).unwrap_or_default()),
            J::Arr(items) => {
                out.push('[');
                for (i, v) in items.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    v.text(out);
                }
                out.push(']');
            }
            J::Obj(m) => {
                out.push('{');
                for (i, (k, v)) in m.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    out.push_str(&serde_json::to_string(k).unwrap_or_default());
                    out.push(':');
                    v.text(out);
                }
                out.push('}');
            }
        }
    }

    fn to_value(&self) -> Value {
        match self {
            J::Null => Value::Null,
            J::Bool(b) => Value::Bool(*b),
            J::Num(x) => super::expr::to_json(super::expr::V::Num(*x)),
            J::Str(s) => Value::String(s.clone()),
            J::Arr(items) => Value::Array(items.iter().map(J::to_value).collect()),
            J::Obj(m) => Value::Object(m.iter().map(|(k, v)| (k.clone(), v.to_value())).collect()),
        }
    }
}

/// The typed wrapper `{"$type", "value"}` exactly: two keys, so a field named `$type` is not one.
fn typed(value: &J) -> Option<(&str, Option<&str>)> {
    let J::Obj(m) = value else { return None };
    let kind = value.get("$type")?.as_str()?;
    if kind == "document" || m.len() != 2 {
        return None;
    }
    match value.get("value")? {
        J::Str(s) => Some((kind, Some(s))),
        J::Null => Some((kind, None)),
        _ => None,
    }
}

/// The document inside the wrapper of a document with its own `$type` key; anything else as is.
fn unwrap(value: &J) -> &J {
    if let J::Obj(m) = value
        && m.len() == 2
        && value.get("$type").and_then(J::as_str) == Some("document")
        && let Some(inner @ J::Obj(_)) = value.get("value")
    {
        return inner;
    }
    value
}

/// The one value at a dotted path (`customer.city`, `items.0.price`); `None` when it is missing.
fn value_at<'a>(document: &'a J, path: &str) -> Option<&'a J> {
    let mut current = document;
    for part in path.split('.') {
        let value = unwrap(current);
        current = match value {
            J::Arr(items) if !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()) => {
                items.get(part.parse::<usize>().ok()?)?
            }
            J::Obj(_) if typed(value).is_none() => value.get(part)?,
            _ => return None,
        };
    }
    Some(current)
}

/// The column type a value reads as when the column does not name one.
fn type_for(value: &J) -> FieldType {
    match typed(value).map(|t| t.0) {
        Some("date") => FieldType::Time,
        Some("decimal" | "double" | "int32" | "number") => FieldType::Number,
        Some("int64") => FieldType::Int64,
        Some("bool") => FieldType::Bool,
        Some("binary" | "object" | "array") => FieldType::Json,
        Some(_) => FieldType::String,
        None => match value {
            J::Num(_) => FieldType::Number,
            J::Bool(_) => FieldType::Bool,
            J::Obj(_) | J::Arr(_) => FieldType::Json,
            _ => FieldType::String,
        },
    }
}

/// Text as JavaScript's `Number(text)` reads it, for typed decimals and int64.
fn js_number(text: &str) -> Option<f64> {
    let t = text.trim_matches(|c: char| c.is_ascii_whitespace());
    if t.is_empty() {
        return Some(0.0);
    }
    if let Some(hex) = t.strip_prefix("0x").or_else(|| t.strip_prefix("0X"))
        && (1..=16).contains(&hex.len())
        && hex.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return u64::from_str_radix(hex, 16).ok().map(|n| n as f64);
    }
    super::expr::parse_number(t)
}

/// Unix ms as a cell: whole numbers as integers, as times are everywhere else.
fn ms_cell(ms: f64) -> Value {
    if ms.fract() == 0.0 && ms.abs() < 9.2e18 {
        Value::from(ms as i64)
    } else {
        super::expr::to_json(super::expr::V::Num(ms))
    }
}

/// RFC 3339 (`2026-01-02T03:04:05.678Z`, `t` or a space between, `Z` or `±hh:mm`) as Unix ms;
/// fractions past the millisecond are cut. The UI reads exactly the same forms.
pub fn rfc3339_ms(text: &str) -> Option<f64> {
    let b = text.as_bytes();
    let num = |r: std::ops::Range<usize>| -> Option<i64> {
        let part = text.get(r)?;
        if part.bytes().all(|c| c.is_ascii_digit()) { part.parse().ok() } else { None }
    };
    if b.len() < 20
        || b[4] != b'-'
        || b[7] != b'-'
        || !matches!(b[10], b'T' | b't' | b' ')
        || b[13] != b':'
        || b[16] != b':'
    {
        return None;
    }
    let (year, month, day) = (num(0..4)?, num(5..7)?, num(8..10)?);
    let (hour, minute, second) = (num(11..13)?, num(14..16)?, num(17..19)?);
    if !(1..=12).contains(&month)
        || day < 1
        || day > days_in_month(year, month)
        || hour > 23
        || minute > 59
        || second > 59
    {
        return None;
    }
    let mut i = 19;
    let mut millis = 0;
    if b[i] == b'.' {
        let digits = b[i + 1..].iter().take_while(|c| c.is_ascii_digit()).count();
        if digits == 0 {
            return None;
        }
        let first: String = text[i + 1..i + 1 + digits.min(3)].to_string();
        millis = format!("{first:0<3}").parse::<i64>().ok()?;
        i += 1 + digits;
    }
    let offset_minutes = match &text[i..] {
        "Z" | "z" => 0,
        o if o.len() == 6 && matches!(o.as_bytes()[0], b'+' | b'-') && o.as_bytes()[3] == b':' => {
            let (h, m) = (num(i + 1..i + 3)?, num(i + 4..i + 6)?);
            if h > 23 || m > 59 {
                return None;
            }
            let sign = if o.starts_with('-') { -1 } else { 1 };
            sign * (h * 60 + m)
        }
        _ => return None,
    };
    let days = days_from_civil(year, month, day);
    let ms = ((days * 24 + hour) * 60 + minute - offset_minutes) * 60_000 + second * 1000 + millis;
    Some(ms as f64)
}

/// A typed date's ms: its value is a decimal count of ms or an RFC 3339 time, nothing else.
fn date_ms(text: Option<&str>) -> Option<f64> {
    let text = text.unwrap_or_default().trim_matches(|c: char| c.is_ascii_whitespace());
    let digits = text.strip_prefix('-').unwrap_or(text);
    if !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()) {
        return text.parse::<f64>().ok().filter(|x| x.is_finite());
    }
    rfc3339_ms(text)
}

/// One value in a column type; empty where it does not fit, nothing is guessed.
fn convert(value: Option<&J>, field_type: FieldType) -> Value {
    let Some(value) = value.filter(|v| **v != J::Null) else { return Value::Null };
    let t = typed(value);
    let number = |x: f64| super::expr::to_json(super::expr::V::Num(x));
    match field_type {
        FieldType::Time | FieldType::Date => match (t, value) {
            (Some(("date", text)), _) => date_ms(text).map_or(Value::Null, ms_cell),
            (None, J::Num(x)) if x.is_finite() => ms_cell(*x),
            _ => Value::Null,
        },
        FieldType::Number => match (t, value) {
            (None, J::Num(x)) => number(*x),
            (Some(("decimal" | "int64", text)), _) => {
                js_number(text.unwrap_or_default()).filter(|x| x.is_finite()).map_or(Value::Null, number)
            }
            _ => Value::Null,
        },
        // Projections offer no decimal type; a decimal column keeps the digits it is given.
        FieldType::Decimal => match (t, value) {
            (Some(("decimal" | "int64", text)), _) => text.map_or(Value::Null, Value::from),
            (None, J::Num(x)) if x.is_finite() => Value::from(number_text(*x)),
            _ => Value::Null,
        },
        FieldType::Int64 => match (t, value) {
            (Some(("int64", text)), _) => text.map_or(Value::Null, Value::from),
            (None, J::Num(x)) if x.is_finite() && x.fract() == 0.0 => Value::from(number_text(*x)),
            _ => Value::Null,
        },
        FieldType::Bool => match value {
            J::Bool(b) => Value::Bool(*b),
            _ => Value::Null,
        },
        FieldType::Json => value.to_value(),
        FieldType::String => match (t, value) {
            (Some((_, text)), _) => text.map_or(Value::Null, Value::from),
            (None, J::Arr(_) | J::Obj(_)) => {
                let mut out = String::new();
                value.text(&mut out);
                Value::from(out)
            }
            (None, J::Str(s)) => Value::from(s.as_str()),
            (None, J::Num(x)) => Value::from(number_text(*x)),
            (None, J::Bool(b)) => Value::from(b.to_string()),
            _ => Value::Null,
        },
    }
}

/// The documents as a frame: one column per path, typed as named or by its first value.
pub fn project(set: &DocumentSet, columns: &[ProjectionColumn]) -> Frame {
    // Read in the order stored; a document that does not parse (never, from the server) is empty.
    let docs: Vec<J> = set.documents.iter().map(|d| serde_json::from_str(d.get()).unwrap_or(J::Null)).collect();
    let fields: Vec<Field> = columns
        .iter()
        .filter(|c| !c.path.trim().is_empty())
        .map(|c| {
            let raw: Vec<Option<&J>> = docs.iter().map(|d| value_at(d, &c.path)).collect();
            let first = raw.iter().flatten().find(|v| ***v != J::Null);
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
    // The source's notices and the query as it ran stay with the frame, as in the UI.
    let meta = FrameMeta {
        executed_query: set.executed_query.clone(),
        rows_truncated: set.truncated.is_some(),
        notices: set.notices.clone(),
    };
    Frame::new(fields).expect("one value per document in every column").with_meta(meta)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn column(path: &str) -> ProjectionColumn {
        ProjectionColumn { path: path.into(), name: None, field_type: None }
    }

    fn j(text: &str) -> J {
        serde_json::from_str(text).unwrap()
    }

    #[test]
    fn paths_reach_into_objects_arrays_and_wrapped_documents() {
        let doc = j(r#"{ "a": { "b": [ { "c": 1 }, { "c": 2 } ] },
                         "w": { "$type": "document", "value": { "$type": "x", "k": 5 } },
                         "t": { "$type": "date", "value": "5" } }"#);
        assert_eq!(value_at(&doc, "a.b.1.c"), Some(&J::Num(2.0)));
        assert_eq!(value_at(&doc, "a.b.9.c"), None);
        assert_eq!(value_at(&doc, "a.b.x"), None);
        assert_eq!(value_at(&doc, "w.k"), Some(&J::Num(5.0)));
        assert_eq!(value_at(&doc, "t.value"), None, "typed values are leaves");
        assert_eq!(value_at(&doc, "a.b.99999999999999999999999"), None);
    }

    /// A container as text keeps the stored key order and JavaScript's numbers, as the UI writes it.
    #[test]
    fn containers_as_text_read_as_in_the_browser() {
        let docs = [j(r#"{"k":{"z":1.0,"a":[2.5,1e21,"ä\n"],"m":{"$type":"x"}}}"#)];
        let mut out = String::new();
        value_at(&docs[0], "k").unwrap().text(&mut out);
        assert_eq!(out, r#"{"z":1,"a":[2.5,1e+21,"ä\n"],"m":{"$type":"x"}}"#);
    }

    #[test]
    fn dates_are_digits_or_rfc_3339() {
        assert_eq!(rfc3339_ms("2026-01-02T00:00:00Z"), Some(1_767_312_000_000.0));
        assert_eq!(rfc3339_ms("2026-01-02 01:30:00.1239+01:30"), Some(1_767_312_000_123.0));
        assert_eq!(rfc3339_ms("2026-01-02t00:00:00z"), Some(1_767_312_000_000.0));
        for bad in [
            "2026-01-02",
            "2026-01-02T00:00:00",
            "2026-02-30T00:00:00Z",
            "2026-01-02T24:00:00Z",
            "Jan 2 2026",
            "2026-01-02T00:00:60Z",
            "2026-01-02T00:00:00.Z",
            "2026-01-02T00:00:00+1:00",
        ] {
            assert_eq!(rfc3339_ms(bad), None, "{bad}");
        }
        assert_eq!(date_ms(Some(" -5 ")), Some(-5.0));
        assert_eq!(date_ms(Some("Fri, 02 Jan 2026 00:00:00 GMT")), None, "no other forms");
    }

    #[test]
    fn columns_take_their_type_from_the_first_value_or_as_named() {
        let set = DocumentSet {
            documents: vec![
                json!({ "at": { "$type": "date", "value": "1767225600000" }, "n": { "$type": "int64", "value": "9007199254740993" },
                        "p": { "$type": "decimal", "value": "129.90" }, "tags": ["x"], "ok": true, "id": { "$type": "objectId", "value": "65f0" } }).into(),
                json!({ "at": { "$type": "date", "value": "2026-01-02T00:00:00Z" }, "n": 7, "p": "teuer", "ok": "ja" }).into(),
            ],
            schema: vec![],
            next_cursor: None,
            truncated: Some(crate::shapes::Truncated { limit: 2, reason: None }),
            notices: vec![crate::shapes::Notice {
                severity: crate::shapes::NoticeSeverity::Warning,
                code: "documents.limit".into(),
                params: None,
                text: "cut".into(),
            }],
            executed_query: Some("orders.find(...)".into()),
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
        let meta = frame.meta().unwrap();
        assert!(meta.rows_truncated);
        // The source's notices and the executed query go with the frame (and so into exports).
        assert_eq!(meta.notices, set.notices);
        assert_eq!(meta.executed_query.as_deref(), Some("orders.find(...)"));
    }
}
