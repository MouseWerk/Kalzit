//! The panel message API, version 1 (docs/api/plugins.md, "Panel message API"): what Kalzit and
//! a panel plugin's bundle say to each other through `postMessage` across the sandboxed iframe.
//! The TypeScript types are `panel/v1/kalzit-panel.d.ts` next to this crate.
//!
//! Into the frame go data (options, size, theme, results in their native shapes); out of the
//! frame come only events. The panel host (not built yet) checks every event with
//! [`parse_event`], keeps the rate limit, and drops what does not fit; the parsed [`Event`] is all
//! that goes further, so unknown fields never pass.

use serde_json::{Map, Value, json};

/// The version this crate speaks; a bundle names its version in the manifest (`[panel] api`).
pub const API_VERSION: u32 = 1;

/// The value of `kalzit` in every message, so a frame can tell Kalzit's messages from others.
pub const ENVELOPE: &str = "panel";

/// The largest event, as JSON text; larger ones are dropped unread.
pub const MAX_EVENT_BYTES: usize = 16 * 1024;

/// Events per second and panel Kalzit takes; more are dropped.
pub const MAX_EVENTS_PER_SECOND: u32 = 20;

/// Rows one `select` may name.
pub const MAX_SELECTED_ROWS: usize = 1000;

/// Values one `setVariable` may set, and the characters of each.
pub const MAX_VARIABLE_VALUES: usize = 100;
pub const MAX_VALUE_CHARS: usize = 1024;

/// The heights a panel may ask for in `resize`, in CSS pixels.
pub const MIN_HEIGHT: u64 = 16;
pub const MAX_HEIGHT: u64 = 4000;

/// The message types into the frame (Kalzit to the panel).
pub const MESSAGES_IN: &[&str] = &["init", "data", "options", "size", "theme", "state"];

/// The event types out of the frame (the panel to Kalzit).
pub const EVENTS: &[&str] = &["ready", "click", "select", "range", "setVariable", "resize"];

/// What a click hit.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Target {
    Row,
    Document,
    Node,
    Edge,
}

impl Target {
    fn name(self) -> &'static str {
        match self {
            Target::Row => "row",
            Target::Document => "document",
            Target::Node => "node",
            Target::Edge => "edge",
        }
    }
}

/// One event of a panel, checked.
#[derive(Clone, Debug, PartialEq)]
pub enum Event {
    /// The panel listens; Kalzit answers with `init` and the current data.
    Ready,
    /// A row or document (by index in the result) or a node or edge (by id) was clicked.
    Click { ref_id: String, target: Target, index: Option<u64>, id: Option<String> },
    /// Rows of a frame were selected (indices in the result).
    Select { ref_id: String, rows: Vec<u64> },
    /// A time range was picked (Unix milliseconds); Kalzit may zoom the dashboard to it.
    Range { from: i64, to: i64 },
    /// A dashboard variable is to be set; Kalzit sets it only when the dashboard has it.
    SetVariable { name: String, value: Vec<String>, multi: bool },
    /// The panel asks for a height; Kalzit may give less.
    Resize { height: u64 },
}

/// Why an event was dropped: a stable code and an English text (for the browser console).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Refused {
    pub code: &'static str,
    pub message: String,
}

fn refuse(code: &'static str, message: impl Into<String>) -> Refused {
    Refused { code, message: message.into() }
}

fn text<'a>(m: &'a Map<String, Value>, key: &str, max: usize) -> Result<&'a str, Refused> {
    match m.get(key).and_then(Value::as_str) {
        Some(s) if !s.is_empty() && s.chars().count() <= max && !s.chars().any(char::is_control) => Ok(s),
        _ => Err(refuse("panel.field_invalid", format!("{key} is a text of 1 to {max} characters"))),
    }
}

fn unsigned(m: &Map<String, Value>, key: &str) -> Result<Option<u64>, Refused> {
    match m.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => {
            v.as_u64().map(Some).ok_or_else(|| refuse("panel.field_invalid", format!("{key} is a whole number")))
        }
    }
}

fn variable_name(name: &str) -> bool {
    let mut bytes = name.bytes();
    name.len() <= 64
        && bytes.next().is_some_and(|b| b.is_ascii_alphabetic() || b == b'_')
        && bytes.all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

/// Checks an event as the frame sent it (JSON text). Unknown fields are ignored and do not
/// reach the parsed event; an unknown type, another API version or a value out of its range
/// is refused.
pub fn parse_event(message: &str) -> Result<Event, Refused> {
    if message.len() > MAX_EVENT_BYTES {
        return Err(refuse("panel.too_large", format!("an event is at most {MAX_EVENT_BYTES} bytes")));
    }
    let value: Value = serde_json::from_str(message).map_err(|_| refuse("panel.not_json", "an event is JSON"))?;
    let m = value.as_object().ok_or_else(|| refuse("panel.not_envelope", "an event is a JSON object"))?;
    if m.get("kalzit").and_then(Value::as_str) != Some(ENVELOPE) {
        return Err(refuse("panel.not_envelope", "an event carries \"kalzit\": \"panel\""));
    }
    if m.get("api").and_then(Value::as_u64) != Some(u64::from(API_VERSION)) {
        return Err(refuse("panel.api_unsupported", format!("this Kalzit speaks panel API {API_VERSION}")));
    }
    let kind = m.get("type").and_then(Value::as_str).unwrap_or_default();
    match kind {
        "ready" => Ok(Event::Ready),
        "click" => {
            let ref_id = text(m, "refId", 64)?.to_string();
            let target = match m.get("target").and_then(Value::as_str) {
                Some("row") => Target::Row,
                Some("document") => Target::Document,
                Some("node") => Target::Node,
                Some("edge") => Target::Edge,
                _ => return Err(refuse("panel.field_invalid", "target is row, document, node or edge")),
            };
            let (index, id) = match target {
                Target::Row | Target::Document => (
                    Some(unsigned(m, "index")?.ok_or_else(|| refuse("panel.field_invalid", "index is required"))?),
                    None,
                ),
                Target::Node | Target::Edge => (None, Some(text(m, "id", MAX_VALUE_CHARS)?.to_string())),
            };
            Ok(Event::Click { ref_id, target, index, id })
        }
        "select" => {
            let ref_id = text(m, "refId", 64)?.to_string();
            let rows = m
                .get("rows")
                .and_then(Value::as_array)
                .ok_or_else(|| refuse("panel.field_invalid", "rows is a list"))?;
            if rows.len() > MAX_SELECTED_ROWS {
                return Err(refuse("panel.field_invalid", format!("at most {MAX_SELECTED_ROWS} rows")));
            }
            let rows = rows
                .iter()
                .map(|r| r.as_u64().ok_or_else(|| refuse("panel.field_invalid", "rows are whole numbers")))
                .collect::<Result<_, _>>()?;
            Ok(Event::Select { ref_id, rows })
        }
        "range" => {
            let (Some(from), Some(to)) = (m.get("from").and_then(Value::as_i64), m.get("to").and_then(Value::as_i64))
            else {
                return Err(refuse("panel.field_invalid", "from and to are Unix milliseconds"));
            };
            if from >= to {
                return Err(refuse("panel.field_invalid", "from is before to"));
            }
            Ok(Event::Range { from, to })
        }
        "setVariable" => {
            let name = text(m, "name", 64)?;
            if !variable_name(name) {
                return Err(refuse("panel.field_invalid", "name is a variable name"));
            }
            let check = |v: &Value| match v.as_str() {
                Some(s) if s.chars().count() <= MAX_VALUE_CHARS && !s.chars().any(char::is_control) => {
                    Ok(s.to_string())
                }
                _ => Err(refuse(
                    "panel.field_invalid",
                    format!("a value is a text of at most {MAX_VALUE_CHARS} characters"),
                )),
            };
            let (value, multi) = match m.get("value") {
                Some(Value::Array(values)) if values.len() <= MAX_VARIABLE_VALUES => {
                    (values.iter().map(check).collect::<Result<_, _>>()?, true)
                }
                Some(Value::Array(_)) => {
                    return Err(refuse("panel.field_invalid", format!("at most {MAX_VARIABLE_VALUES} values")));
                }
                Some(v) => (vec![check(v)?], false),
                None => return Err(refuse("panel.field_invalid", "value is required")),
            };
            Ok(Event::SetVariable { name: name.to_string(), value, multi })
        }
        "resize" => match unsigned(m, "height")? {
            Some(h) if (MIN_HEIGHT..=MAX_HEIGHT).contains(&h) => Ok(Event::Resize { height: h }),
            _ => Err(refuse("panel.field_invalid", format!("height is {MIN_HEIGHT} to {MAX_HEIGHT}"))),
        },
        _ => Err(refuse("panel.type_unknown", format!("{kind:?} is not an event of panel API {API_VERSION}"))),
    }
}

impl Event {
    /// The event as Kalzit passes it on: only the fields of version 1.
    pub fn to_json(&self) -> Value {
        let mut v = match self {
            Event::Ready => json!({ "type": "ready" }),
            Event::Click { ref_id, target, index, id } => {
                let mut v = json!({ "type": "click", "refId": ref_id, "target": target.name() });
                if let Some(i) = index {
                    v["index"] = json!(i);
                }
                if let Some(id) = id {
                    v["id"] = json!(id);
                }
                v
            }
            Event::Select { ref_id, rows } => json!({ "type": "select", "refId": ref_id, "rows": rows }),
            Event::Range { from, to } => json!({ "type": "range", "from": from, "to": to }),
            Event::SetVariable { name, value, multi } => {
                let value = if *multi { json!(value) } else { json!(value.first().cloned().unwrap_or_default()) };
                json!({ "type": "setVariable", "name": name, "value": value })
            }
            Event::Resize { height } => json!({ "type": "resize", "height": height }),
        };
        v["kalzit"] = json!(ENVELOPE);
        v["api"] = json!(API_VERSION);
        v
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(body: Value) -> Result<Event, Refused> {
        let mut m = json!({ "kalzit": "panel", "api": 1 });
        for (k, v) in body.as_object().unwrap() {
            m[k] = v.clone();
        }
        parse_event(&m.to_string())
    }

    #[test]
    fn events_of_version_one_parse_and_lose_unknown_fields() {
        let e = event(json!({ "type": "click", "refId": "A", "target": "row", "index": 3, "secret": "x" })).unwrap();
        assert_eq!(e, Event::Click { ref_id: "A".into(), target: Target::Row, index: Some(3), id: None });
        assert_eq!(
            e.to_json(),
            json!({ "kalzit": "panel", "api": 1, "type": "click", "refId": "A", "target": "row", "index": 3 })
        );
        let e = event(json!({ "type": "click", "refId": "A", "target": "node", "id": "n1" })).unwrap();
        assert_eq!(e.to_json()["id"], "n1");
        assert_eq!(event(json!({ "type": "ready" })).unwrap(), Event::Ready);
        let e = event(json!({ "type": "setVariable", "name": "host", "value": ["a", "b"] })).unwrap();
        assert_eq!(e.to_json()["value"], json!(["a", "b"]));
        let e = event(json!({ "type": "setVariable", "name": "host", "value": "a" })).unwrap();
        assert_eq!(e.to_json()["value"], json!("a"));
        assert_eq!(event(json!({ "type": "range", "from": 1, "to": 2 })).unwrap(), Event::Range { from: 1, to: 2 });
        assert_eq!(event(json!({ "type": "resize", "height": 300 })).unwrap(), Event::Resize { height: 300 });
        assert_eq!(
            event(json!({ "type": "select", "refId": "A", "rows": [0, 2] })).unwrap().to_json()["rows"],
            json!([0, 2])
        );
    }

    #[test]
    fn what_does_not_fit_is_refused() {
        let code = |r: Result<Event, Refused>| r.unwrap_err().code;
        assert_eq!(code(parse_event("x")), "panel.not_json");
        assert_eq!(code(parse_event(r#"{"type":"ready","api":1}"#)), "panel.not_envelope");
        assert_eq!(code(parse_event(r#"{"kalzit":"panel","api":2,"type":"ready"}"#)), "panel.api_unsupported");
        assert_eq!(code(event(json!({ "type": "runQuery" }))), "panel.type_unknown");
        assert_eq!(code(parse_event(&"x".repeat(MAX_EVENT_BYTES + 1))), "panel.too_large");
        for bad in [
            json!({ "type": "click", "refId": "A", "target": "cell", "index": 1 }),
            json!({ "type": "click", "refId": "A", "target": "row" }),
            json!({ "type": "click", "refId": "", "target": "row", "index": 1 }),
            json!({ "type": "select", "refId": "A", "rows": [-1] }),
            json!({ "type": "select", "refId": "A", "rows": vec![0; MAX_SELECTED_ROWS + 1] }),
            json!({ "type": "range", "from": 5, "to": 5 }),
            json!({ "type": "setVariable", "name": "1x", "value": "a" }),
            json!({ "type": "setVariable", "name": "x", "value": { "a": 1 } }),
            json!({ "type": "setVariable", "name": "x", "value": vec!["a"; MAX_VARIABLE_VALUES + 1] }),
            json!({ "type": "setVariable", "name": "x", "value": "a\u{0}" }),
            json!({ "type": "resize", "height": 5000 }),
        ] {
            assert_eq!(code(event(bad.clone())), "panel.field_invalid", "{bad}");
        }
    }

    #[test]
    fn the_typescript_types_name_every_message() {
        let types = include_str!("../panel/v1/kalzit-panel.d.ts");
        for name in MESSAGES_IN.iter().chain(EVENTS) {
            assert!(types.contains(&format!("type: \"{name}\"")), "{name} is missing from kalzit-panel.d.ts");
        }
        assert!(types.contains(&format!("api: {API_VERSION}")));
    }
}
