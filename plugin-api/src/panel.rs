//! The panel message API, version 1 (docs/api/plugins.md, "Panel message API"): what Kalzit and
//! a panel plugin's bundle say to each other through `postMessage` across the sandboxed iframe.
//! The TypeScript types are `panel/v1/kalzit-panel.d.ts` next to this crate.
//!
//! Into the frame go data (options, size, theme, results in their native shapes); out of the
//! frame come only events. The panel host runs in the browser (`ui/src/features/plugins/panel`):
//! it checks every event as [`parse_event`] does, keeps the rate limits, and drops what does not
//! fit, so unknown fields never pass. Both sides check the cases of
//! `panel/v1/events.fixture.json` and `panel/v1/options.fixture.json`, so they agree.

use serde_json::{Map, Value, json};

use crate::manifest::PanelOption;

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
pub const EVENTS: &[&str] =
    &["ready", "click", "select", "range", "setVariable", "resize", "setOptions", "link", "log"];

/// The characters of a link a panel asks Kalzit to open, and of its title.
pub const MAX_URL_CHARS: usize = 2048;
pub const MAX_LINK_TITLE_CHARS: usize = 200;

/// The characters of one log line, and the lines per second and panel Kalzit keeps (within the
/// events per second); more are dropped.
pub const MAX_LOG_CHARS: usize = 1024;
pub const MAX_LOGS_PER_SECOND: u32 = 5;

/// The levels of a log line.
pub const LOG_LEVELS: &[&str] = &["debug", "info", "warn", "error"];

/// The characters of a `string` option and of a `text` option.
pub const MAX_OPTION_STRING_CHARS: usize = 1024;
pub const MAX_OPTION_TEXT_CHARS: usize = 4096;

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
    /// In edit mode: the panel's options as the panel wants them. Kalzit checks them against the
    /// manifest's `[[panel.options]]` (`check_options`) and keeps them in the panel editor.
    SetOptions { options: Map<String, Value> },
    /// The panel asks Kalzit to open a link (`http`, `https` or a path in Kalzit); Kalzit asks
    /// the viewer first.
    Link { url: String, title: Option<String> },
    /// A line for the panel's log (the browser console and the panel inspector).
    Log { level: &'static str, text: String },
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
        "setOptions" => match m.get("options") {
            Some(Value::Object(options)) => Ok(Event::SetOptions { options: options.clone() }),
            _ => Err(refuse("panel.field_invalid", "options is a JSON object")),
        },
        "link" => {
            let url = text(m, "url", MAX_URL_CHARS)?;
            if !link_allowed(url) {
                return Err(refuse(
                    "panel.field_invalid",
                    "url is an http or https address without user name, or a path in Kalzit starting with /",
                ));
            }
            let title = match m.get("title") {
                None | Some(Value::Null) => None,
                Some(_) => Some(text(m, "title", MAX_LINK_TITLE_CHARS)?.to_string()),
            };
            Ok(Event::Link { url: url.to_string(), title })
        }
        "log" => {
            let level = m
                .get("level")
                .and_then(Value::as_str)
                .and_then(|l| LOG_LEVELS.iter().find(|k| **k == l).copied())
                .ok_or_else(|| refuse("panel.field_invalid", "level is debug, info, warn or error"))?;
            let text = text(m, "text", MAX_LOG_CHARS)?.to_string();
            Ok(Event::Log { level, text })
        }
        _ => Err(refuse("panel.type_unknown", format!("{kind:?} is not an event of panel API {API_VERSION}"))),
    }
}

/// Whether a panel may ask to open `url`: an `http` or `https` address with a host and without
/// a user name (`https://kalzit.dev@elsewhere` would read as Kalzit), or a path in Kalzit
/// (`/dashboards/...`, not `//host` or `/\host`, which browsers read as another host, and not
/// Kalzit's API under `/api`). Never `javascript:`, `data:` or any other scheme. Without white
/// space, control characters or format characters (Unicode `Cf`: bidirectional overrides,
/// zero-width characters), which could make the address shown read as another one.
pub fn link_allowed(url: &str) -> bool {
    if url.is_empty() || url.chars().any(|c| c.is_whitespace() || c.is_control() || is_format(c) || c == '\\') {
        return false;
    }
    if let Some(path) = url.strip_prefix('/') {
        // No dot segments and no encoded dots or slashes, so the path is the one the browser
        // resolves and `/./api` or `/%2e/api` cannot reach the API.
        let lower = path.to_ascii_lowercase();
        let route = lower.split(['?', '#']).next().unwrap_or_default();
        if path.starts_with('/')
            || ["%2e", "%2f", "%5c"].iter().any(|e| route.contains(e))
            || route.split('/').any(|s| s == "." || s == "..")
        {
            return false;
        }
        return route.split('/').next() != Some("api");
    }
    let lower = url.to_ascii_lowercase();
    let Some(rest) = lower.strip_prefix("https://").or_else(|| lower.strip_prefix("http://")) else {
        return false;
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    !authority.is_empty() && !authority.contains('@') && !authority.starts_with(':')
}

/// Whether `c` is a format character (Unicode general category `Cf`, Unicode 16), as
/// `/\p{Cf}/u` matches it in the browser.
pub fn is_format(c: char) -> bool {
    matches!(
        c,
        '\u{00AD}'
            | '\u{0600}'..='\u{0605}'
            | '\u{061C}'
            | '\u{06DD}'
            | '\u{070F}'
            | '\u{0890}'..='\u{0891}'
            | '\u{08E2}'
            | '\u{180E}'
            | '\u{200B}'..='\u{200F}'
            | '\u{202A}'..='\u{202E}'
            | '\u{2060}'..='\u{2064}'
            | '\u{2066}'..='\u{206F}'
            | '\u{FEFF}'
            | '\u{FFF9}'..='\u{FFFB}'
            | '\u{110BD}'
            | '\u{110CD}'
            | '\u{13430}'..='\u{1343F}'
            | '\u{1BCA0}'..='\u{1BCA3}'
            | '\u{1D173}'..='\u{1D17A}'
            | '\u{E0001}'
            | '\u{E0020}'..='\u{E007F}'
    )
}

fn option_refused(name: &str, message: impl std::fmt::Display) -> Refused {
    refuse("panel.option_invalid", format!("options.{name}: {message}"))
}

/// Checks one value against its option: the type, the range of numbers, the choices of a
/// select, the length of texts (no control characters but line breaks and tabs in `text`).
pub fn check_option(option: &PanelOption, value: &Value) -> Result<(), Refused> {
    let name = &option.name;
    let in_range = |n: f64| option.min.is_none_or(|min| n >= min) && option.max.is_none_or(|max| n <= max);
    let range = || match (option.min, option.max) {
        (Some(min), Some(max)) => format!(" from {min} to {max}"),
        (Some(min), None) => format!(" of at least {min}"),
        (None, Some(max)) => format!(" of at most {max}"),
        (None, None) => String::new(),
    };
    match (option.option_type.as_str(), value) {
        ("string", Value::String(s)) => {
            if s.chars().count() > MAX_OPTION_STRING_CHARS || s.chars().any(char::is_control) {
                return Err(option_refused(name, format!("a text of at most {MAX_OPTION_STRING_CHARS} characters")));
            }
            Ok(())
        }
        ("text", Value::String(s)) => {
            if s.chars().count() > MAX_OPTION_TEXT_CHARS || s.chars().any(|c| c.is_control() && c != '\n' && c != '\t')
            {
                return Err(option_refused(name, format!("a text of at most {MAX_OPTION_TEXT_CHARS} characters")));
            }
            Ok(())
        }
        ("number", Value::Number(n)) => match n.as_f64() {
            Some(f) if f.is_finite() && in_range(f) => Ok(()),
            _ => Err(option_refused(name, format!("a number{}", range()))),
        },
        ("integer", Value::Number(n)) => match n.as_i64() {
            #[allow(clippy::cast_precision_loss)]
            Some(i) if in_range(i as f64) => Ok(()),
            _ => Err(option_refused(name, format!("a whole number{}", range()))),
        },
        ("bool", Value::Bool(_)) => Ok(()),
        ("select", Value::String(s)) if option.choices.contains(s) => Ok(()),
        ("select", _) => Err(option_refused(name, format!("one of {}", option.choices.join(", ")))),
        (ty, _) => Err(option_refused(name, format!("a value of type {ty}"))),
    }
}

/// Checks a panel's options against the options its manifest declares: only declared keys,
/// each value fitting its option. Absent keys take the option's default.
pub fn check_options(declared: &[PanelOption], options: &Map<String, Value>) -> Result<(), Refused> {
    for (key, value) in options {
        let option = declared
            .iter()
            .find(|o| &o.name == key)
            .ok_or_else(|| refuse("panel.option_unknown", format!("options.{key} is not an option of this panel")))?;
        check_option(option, value)?;
    }
    Ok(())
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
            Event::SetOptions { options } => json!({ "type": "setOptions", "options": options }),
            Event::Link { url, title } => {
                let mut v = json!({ "type": "link", "url": url });
                if let Some(t) = title {
                    v["title"] = json!(t);
                }
                v
            }
            Event::Log { level, text } => json!({ "type": "log", "level": level, "text": text }),
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

    /// The cases both sides check (`panel/v1/events.fixture.json`; the UI's protocol test reads
    /// the same file).
    #[test]
    fn the_shared_event_cases_hold() {
        let fixture: Value = serde_json::from_str(include_str!("../panel/v1/events.fixture.json")).unwrap();
        for case in fixture["cases"].as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            let text = match case["raw"].as_str() {
                Some("TOO_LARGE") => "x".repeat(MAX_EVENT_BYTES + 1),
                Some(raw) => raw.to_string(),
                None => case["event"].to_string(),
            };
            let got = parse_event(&text);
            match case["code"].as_str() {
                None => {
                    let e = got.unwrap_or_else(|r| panic!("{name}: refused with {}", r.code));
                    if let Some(passed) = case.get("passed") {
                        assert_eq!(&e.to_json(), passed, "{name}");
                    }
                }
                Some(code) => assert_eq!(got.map_err(|r| r.code), Err(code), "{name}"),
            }
        }
    }

    #[test]
    fn the_shared_option_cases_hold() {
        let fixture: Value = serde_json::from_str(include_str!("../panel/v1/options.fixture.json")).unwrap();
        let declared: Vec<PanelOption> = serde_json::from_value(fixture["options"].clone()).unwrap();
        for case in fixture["cases"].as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            let got = check_options(&declared, case["options"].as_object().unwrap()).map_err(|r| r.code);
            assert_eq!(got, case["code"].as_str().map_or(Ok(()), Err), "{name}");
        }
    }

    #[test]
    fn links_open_only_the_web_or_kalzit() {
        for good in ["https://example.com", "http://10.0.0.1:8080/x", "/d/abc", "/", "HTTPS://Example.com/a"] {
            assert!(link_allowed(good), "{good}");
        }
        for bad in [
            "javascript:alert(1)",
            "JavaScript:alert(1)",
            "vbscript:x",
            "file:///etc/passwd",
            "//evil.example",
            "/\\evil.example",
            "https://a@b.example",
            "https://:443/x",
            "https://",
            "ftp://example.com",
            "https://example.com/\u{0}",
            "",
            // Format characters anywhere: a right-to-left override, zero-width space and joiner,
            // an isolate, a byte order mark, a soft hyphen, a tag character.
            "https://example.com\u{202E}moc.lapyap",
            "https://exa\u{200B}mple.com/",
            "https://example.com/a\u{200D}b",
            "/d/abc\u{2066}x",
            "https://\u{FEFF}example.com",
            "https://exam\u{AD}ple.com",
            "https://example.com/\u{E0041}",
        ] {
            assert!(!link_allowed(bad), "{bad:?}");
        }
        assert!(is_format('\u{200B}') && is_format('\u{061C}') && !is_format('a') && !is_format('\u{00E4}'));
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
