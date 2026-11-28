//! A Redis answer as a result: tables (`frame`) for values, pairs, scores, samples and the
//! server's info, `documents` for stream entries, JSON documents and search hits. Which one
//! follows from the command (`command::Shape`), never from guessing at the answer.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{Map, Value, json};

use super::super::Detail;
use super::super::frame::{Column, FrameBuilder, ResponseBudget};
use super::super::json_documents::DocumentsBuilder;
use super::super::{SourceError, SourceQuery};
use super::command::{Command, Shape};
use super::resp::Reply;
use crate::shapes::{FieldType, NoticeSeverity, QueryResult};

/// Largest integer a JavaScript number holds exactly.
const MAX_SAFE: i64 = (1 << 53) - 1;

fn unexpected(command: &Command) -> SourceError {
    SourceError::failed("redis.unexpected_reply", format!("{} answered in a form Kalzit does not read", command.name))
        .with("name", &command.name)
}

/// What a cell holds before its column's type is known.
#[derive(Default)]
struct Cells {
    /// Bulk strings that were not UTF-8 and are shown empty.
    binary: bool,
}

impl Cells {
    /// A reply as JSON: text, numbers (as text beyond 2^53), arrays; an error as its text.
    fn json(&mut self, reply: &Reply) -> Value {
        match reply {
            Reply::Status(s) | Reply::Error(s) => Value::String(s.clone()),
            Reply::Int(i) if i.abs() <= MAX_SAFE => json!(i),
            Reply::Int(i) => Value::String(i.to_string()),
            Reply::Bulk(b) => match std::str::from_utf8(b) {
                Ok(t) => Value::String(t.to_string()),
                Err(_) => {
                    self.binary = true;
                    Value::Null
                }
            },
            Reply::Array(items) => Value::Array(items.iter().map(|i| self.json(i)).collect()),
            Reply::Nil => Value::Null,
        }
    }

    fn text(&mut self, reply: &Reply) -> Value {
        match self.json(reply) {
            Value::Number(n) => Value::String(n.to_string()),
            other => other,
        }
    }
}

/// A number from text or an integer reply; `None` for anything else.
fn number(value: &Value) -> Option<f64> {
    match value {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse::<f64>().ok().filter(|f| f.is_finite()),
        _ => None,
    }
}

/// The column type its values agree on: numbers when every value is one (Redis keeps numbers
/// as text), JSON when any is a list, else text.
fn infer(values: &[Value]) -> FieldType {
    let present: Vec<&Value> = values.iter().filter(|v| !v.is_null()).collect();
    if present.iter().any(|v| v.is_array() || v.is_object()) {
        FieldType::Json
    } else if !present.is_empty() && present.iter().all(|v| number(v).is_some()) {
        FieldType::Number
    } else {
        FieldType::String
    }
}

fn convert(value: Value, field_type: FieldType) -> Value {
    match field_type {
        FieldType::Number => number(&value).and_then(serde_json::Number::from_f64).map_or(Value::Null, Value::Number),
        FieldType::String => match value {
            Value::Number(n) => Value::String(n.to_string()),
            other => other,
        },
        _ => value,
    }
}

/// A frame from named columns of equal length; `types` fixes a column's type, `None` infers it.
fn frame(
    columns: Vec<(String, Option<FieldType>, Vec<Value>)>,
    max_rows: usize,
    budget: &ResponseBudget,
    labels: Vec<Option<BTreeMap<String, String>>>,
) -> FrameBuilder {
    let rows = columns.first().map_or(0, |c| c.2.len());
    let mut typed = Vec::new();
    let mut data = Vec::new();
    for (i, (name, fixed, values)) in columns.into_iter().enumerate() {
        let t = fixed.unwrap_or_else(|| infer(&values));
        let mut column = Column::new(name, Some(t));
        column.labels = labels.get(i).cloned().flatten();
        typed.push(column);
        data.push(values.into_iter().map(|v| convert(v, t)).collect::<Vec<_>>());
    }
    let mut builder = FrameBuilder::new(typed, max_rows, budget.clone());
    let mut columns: Vec<std::vec::IntoIter<Value>> = data.into_iter().map(Vec::into_iter).collect();
    for _ in 0..rows {
        let row: Vec<Value> = columns.iter_mut().map(|c| c.next().unwrap_or(Value::Null)).collect();
        if !builder.push_row(row) {
            break;
        }
    }
    builder
}

fn values_column(name: &str, values: Vec<Value>) -> (String, Option<FieldType>, Vec<Value>) {
    (name.to_string(), None, values)
}

/// The elements of an array reply, or the reply itself as one element.
fn elements(reply: &Reply) -> Vec<&Reply> {
    match reply {
        Reply::Array(items) => items.iter().collect(),
        Reply::Nil => Vec::new(),
        other => vec![other],
    }
}

/// `[a, 1, b, 2]` as `[(a, 1), (b, 2)]`.
fn pairs(items: &[&Reply]) -> Vec<(Reply, Reply)> {
    items.chunks(2).map(|c| (c[0].clone(), c.get(1).copied().cloned().unwrap_or(Reply::Nil))).collect()
}

/// Stream ids are `<ms>-<seq>`: the time of the entry.
fn id_time(id: &str) -> Option<i64> {
    id.split_once('-').map_or(id, |(ms, _)| ms).parse().ok()
}

/// A RESP reply that is a field list (`[k, v, k, v]`) as a JSON object.
fn object(cells: &mut Cells, items: &[&Reply]) -> Map<String, Value> {
    let mut map = Map::new();
    for (k, v) in pairs(items) {
        let key = k.text().unwrap_or_default();
        let value = match &v {
            Reply::Array(inner) => {
                let inner: Vec<&Reply> = inner.iter().collect();
                // Nested field lists (FT.INFO's attributes) stay lists: their keys repeat.
                Value::Array(inner.iter().map(|r| cells.json(r)).collect())
            }
            other => cells.json(other),
        };
        map.insert(key, value);
    }
    map
}

fn documents_result(mut docs: DocumentsBuilder, command: &Command, cells: &Cells) -> QueryResult {
    docs.executed_query(command.text.clone());
    if cells.binary {
        docs.notice(
            NoticeSeverity::Warning,
            Detail::new("frame.binary_hidden", "binary values that are not text are shown empty"),
        );
    }
    QueryResult::Documents { documents: docs.finish() }
}

/// A JSON text from RedisJSON as values: a JSONPath answer (`$...`) is a list of matches, each
/// its own document; an older path answers the value itself.
fn json_values(text: &str, jsonpath: bool) -> Vec<Value> {
    match serde_json::from_str::<Value>(text) {
        Ok(Value::Array(items)) if jsonpath => items,
        Ok(value) => vec![value],
        Err(_) => vec![Value::String(text.to_string())],
    }
}

fn as_document(value: Value) -> Value {
    match value {
        Value::Object(_) => value,
        other => json!({ "value": other }),
    }
}

/// Builds the result of `command` from its `reply`.
pub fn result(command: &Command, reply: Reply, req: &SourceQuery) -> Result<QueryResult, SourceError> {
    if let Reply::Error(e) = &reply {
        return Err(super::server_error(e));
    }
    let mut cells = Cells::default();
    let mut notices: Vec<Detail> = Vec::new();
    let max = req.limits.max_rows;
    let budget = req.limits.budget.clone();
    let mut builder = match command.shape {
        Shape::Stream => {
            let mut docs = DocumentsBuilder::new(max, budget);
            for entry in elements(&reply) {
                let Reply::Array(parts) = entry else { return Err(unexpected(command)) };
                let id = parts.first().and_then(Reply::text).unwrap_or_default();
                let fields: Vec<&Reply> = parts.get(1).map(elements).unwrap_or_default();
                let mut doc = Map::new();
                doc.insert("_id".into(), json!(id));
                doc.insert("_time".into(), id_time(&id).map_or(Value::Null, |t| json!(t)));
                for (k, v) in object(&mut cells, &fields) {
                    doc.insert(k, v);
                }
                if !docs.push(Value::Object(doc)) {
                    break;
                }
            }
            return Ok(documents_result(docs, command, &cells));
        }
        Shape::Json => {
            let jsonpath = command.args.iter().skip(2).any(|a| a.starts_with(b"$"));
            let mut docs = DocumentsBuilder::new(max, budget);
            if command.name == "JSON.MGET" {
                // JSON.MGET key... path: one answer per key, the path last.
                let keys = &command.args[1..command.args.len().saturating_sub(1)];
                for (key, item) in keys.iter().zip(elements(&reply)) {
                    let key = String::from_utf8_lossy(key).into_owned();
                    let Some(text) = item.text() else { continue };
                    for value in json_values(&text, jsonpath) {
                        let mut doc = match as_document(value) {
                            Value::Object(m) => m,
                            _ => Map::new(),
                        };
                        doc.insert("_key".into(), json!(key));
                        if !docs.push(Value::Object(doc)) {
                            return Ok(documents_result(docs, command, &cells));
                        }
                    }
                }
            } else if let Some(text) = reply.text() {
                // Several paths answer one object keyed by path.
                let several = command.args.len() > 3;
                let values = if several { json_values(&text, false) } else { json_values(&text, jsonpath) };
                for value in values {
                    let items = match value {
                        Value::Array(items) if !jsonpath && !several => items,
                        other => vec![other],
                    };
                    for item in items {
                        if !docs.push(as_document(item)) {
                            return Ok(documents_result(docs, command, &cells));
                        }
                    }
                }
            }
            return Ok(documents_result(docs, command, &cells));
        }
        Shape::Search => {
            let items = elements(&reply);
            let total = items.first().and_then(|r| r.text()).unwrap_or_default();
            let scores = command.has_flag("WITHSCORES");
            let payloads = command.has_flag("WITHPAYLOADS");
            let content = !command.has_flag("NOCONTENT");
            let mut docs = DocumentsBuilder::new(max, budget);
            let mut rest = items.iter().skip(1).peekable();
            while let Some(id) = rest.next() {
                let mut doc = Map::new();
                doc.insert("_id".into(), json!(id.text().unwrap_or_default()));
                if scores && let Some(s) = rest.next() {
                    doc.insert("_score".into(), number(&cells.json(s)).map_or(Value::Null, |f| json!(f)));
                }
                if payloads && let Some(p) = rest.next() {
                    doc.insert("_payload".into(), cells.json(p));
                }
                if content && let Some(Reply::Array(fields)) = rest.next() {
                    let fields: Vec<&Reply> = fields.iter().collect();
                    for (k, v) in object(&mut cells, &fields) {
                        // A JSON index answers the whole document under `$`.
                        match (k.as_str(), v.as_str().map(serde_json::from_str::<Value>)) {
                            ("$", Some(Ok(Value::Object(m)))) => doc.extend(m),
                            _ => {
                                doc.insert(k, v);
                            }
                        }
                    }
                }
                if !docs.push(Value::Object(doc)) {
                    break;
                }
            }
            docs.notice(
                NoticeSeverity::Info,
                Detail::new("redis.search_total", format!("{total} documents match")).with("total", &total),
            );
            return Ok(documents_result(docs, command, &cells));
        }
        Shape::Aggregate => {
            let mut docs = DocumentsBuilder::new(max, budget);
            for row in elements(&reply).into_iter().skip(1) {
                let fields = elements(row);
                if !docs.push(Value::Object(object(&mut cells, &fields))) {
                    break;
                }
            }
            return Ok(documents_result(docs, command, &cells));
        }
        Shape::Samples => {
            // TS.GET answers one sample, TS.RANGE a list of them.
            let samples: Vec<&Reply> = match &reply {
                Reply::Array(items) if command.name == "TS.GET" => {
                    if items.is_empty() {
                        Vec::new()
                    } else {
                        vec![&reply]
                    }
                }
                other => elements(other),
            };
            let (mut times, mut values) = (Vec::new(), Vec::new());
            for s in samples {
                let parts = elements(s);
                times.push(parts.first().map_or(Value::Null, |t| cells.json(t)));
                values.push(parts.get(1).map_or(Value::Null, |v| cells.json(v)));
            }
            let key = command.arg(1).unwrap_or_else(|| "value".into());
            frame(
                vec![("time".into(), Some(FieldType::Time), times), (key, Some(FieldType::Number), values)],
                max,
                &budget,
                Vec::new(),
            )
        }
        Shape::MultiSamples => {
            // [[key, labels, samples], ...]: one column per series on the union of their times.
            let mut series = Vec::new();
            let mut times = BTreeSet::new();
            for s in elements(&reply) {
                let parts = elements(s);
                let key = parts.first().and_then(|k| k.text()).unwrap_or_default();
                let labels: BTreeMap<String, String> = parts
                    .get(1)
                    .map(|l| elements(l))
                    .unwrap_or_default()
                    .into_iter()
                    .filter_map(|pair| {
                        let kv = elements(pair);
                        Some((kv.first()?.text()?, kv.get(1)?.text()?))
                    })
                    .collect();
                let mut points = BTreeMap::new();
                for sample in parts.get(2).map(|p| elements(p)).unwrap_or_default() {
                    let sp = elements(sample);
                    let Some(t) = sp.first().and_then(|t| t.text()).and_then(|t| t.parse::<i64>().ok()) else {
                        continue;
                    };
                    times.insert(t);
                    points.insert(t, sp.get(1).map_or(Value::Null, |v| cells.json(v)));
                }
                series.push((key, labels, points));
            }
            let mut columns =
                vec![("time".to_string(), Some(FieldType::Time), times.iter().map(|t| json!(t)).collect::<Vec<_>>())];
            let mut labels = vec![None];
            for (key, l, points) in series {
                let values = times.iter().map(|t| points.get(t).cloned().unwrap_or(Value::Null)).collect();
                columns.push((key, Some(FieldType::Number), values));
                labels.push((!l.is_empty()).then_some(l));
            }
            // The limit counts points: rows times series.
            let rows = (max / columns.len().saturating_sub(1).max(1)).max(1);
            frame(columns, rows, &budget, labels)
        }
        Shape::LastSamples => {
            let (mut keys, mut times, mut values) = (Vec::new(), Vec::new(), Vec::new());
            for s in elements(&reply) {
                let parts = elements(s);
                keys.push(parts.first().map_or(Value::Null, |k| cells.text(k)));
                let sample = parts.get(2).map(|p| elements(p)).unwrap_or_default();
                times.push(sample.first().map_or(Value::Null, |t| cells.json(t)));
                values.push(sample.get(1).map_or(Value::Null, |v| cells.json(v)));
            }
            frame(
                vec![
                    ("key".into(), Some(FieldType::String), keys),
                    ("time".into(), Some(FieldType::Time), times),
                    ("value".into(), Some(FieldType::Number), values),
                ],
                max,
                &budget,
                Vec::new(),
            )
        }
        Shape::Info => {
            let text = reply.text().unwrap_or_default();
            let (mut sections, mut keys, mut values) = (Vec::new(), Vec::new(), Vec::new());
            let mut section = String::new();
            for line in text.lines().map(str::trim).filter(|l| !l.is_empty()) {
                if let Some(name) = line.strip_prefix('#') {
                    section = name.trim().to_string();
                } else if let Some((k, v)) = line.split_once(':') {
                    sections.push(json!(section));
                    keys.push(json!(k));
                    values.push(json!(v));
                }
            }
            frame(
                vec![
                    ("section".into(), Some(FieldType::String), sections),
                    ("key".into(), Some(FieldType::String), keys),
                    values_column("value", values),
                ],
                max,
                &budget,
                Vec::new(),
            )
        }
        Shape::Pairs | Shape::InfoPairs => {
            let items = elements(&reply);
            let (mut names, mut values) = (Vec::new(), Vec::new());
            for (k, v) in pairs(&items) {
                names.push(cells.text(&k));
                values.push(cells.json(&v));
            }
            frame(
                vec![("field".into(), Some(FieldType::String), names), values_column("value", values)],
                max,
                &budget,
                Vec::new(),
            )
        }
        Shape::Scored | Shape::WithValues => {
            let flag = if command.shape == Shape::Scored { "WITHSCORES" } else { "WITHVALUES" };
            let items = elements(&reply);
            if command.has_flag(flag) {
                let (first, second) =
                    if command.shape == Shape::Scored { ("member", "score") } else { ("field", "value") };
                let (mut names, mut values) = (Vec::new(), Vec::new());
                // RESP2 answers a flat list; some servers nest each pair.
                let nested = items.iter().all(|i| matches!(i, Reply::Array(p) if p.len() == 2));
                let list: Vec<(Reply, Reply)> = if nested && !items.is_empty() {
                    items.iter().map(|i| (elements(i)[0].clone(), elements(i)[1].clone())).collect()
                } else {
                    pairs(&items)
                };
                for (k, v) in list {
                    names.push(cells.text(&k));
                    values.push(cells.json(&v));
                }
                let fixed = (command.shape == Shape::Scored).then_some(FieldType::Number);
                frame(
                    vec![(first.into(), Some(FieldType::String), names), (second.into(), fixed, values)],
                    max,
                    &budget,
                    Vec::new(),
                )
            } else {
                let values = items.iter().map(|r| cells.json(r)).collect();
                frame(vec![values_column("value", values)], max, &budget, Vec::new())
            }
        }
        Shape::Scan { pairs: two, scored } => {
            let parts = elements(&reply);
            let cursor = parts.first().and_then(|c| c.text()).unwrap_or_default();
            let items: Vec<&Reply> = parts.get(1).map(|p| elements(p)).unwrap_or_default();
            if cursor != "0" {
                notices.push(
                    Detail::new(
                        "redis.scan_more",
                        format!("more entries follow; run the command again with the cursor {cursor}"),
                    )
                    .with("cursor", &cursor),
                );
            }
            let first = match command.name.as_str() {
                "SCAN" => "key",
                "HSCAN" => "field",
                _ => "member",
            };
            if two {
                let (mut names, mut values) = (Vec::new(), Vec::new());
                for (k, v) in pairs(&items) {
                    names.push(cells.text(&k));
                    values.push(cells.json(&v));
                }
                let (second, fixed) = if scored { ("score", Some(FieldType::Number)) } else { ("value", None) };
                frame(
                    vec![(first.into(), Some(FieldType::String), names), (second.into(), fixed, values)],
                    max,
                    &budget,
                    Vec::new(),
                )
            } else {
                let names = items.iter().map(|r| cells.text(r)).collect();
                frame(vec![(first.into(), Some(FieldType::String), names)], max, &budget, Vec::new())
            }
        }
        Shape::PerArgument { from, name } => {
            let items = elements(&reply);
            let names: Vec<Value> = command.args.iter().skip(from).map(|a| json!(String::from_utf8_lossy(a))).collect();
            let values: Vec<Value> = items.iter().map(|r| cells.json(r)).collect();
            if names.len() != values.len() {
                return Err(unexpected(command));
            }
            frame(
                vec![(name.into(), Some(FieldType::String), names), values_column("value", values)],
                max,
                &budget,
                Vec::new(),
            )
        }
        Shape::Values => {
            let values = match &reply {
                Reply::Array(items) => items.iter().map(|r| cells.json(r)).collect(),
                other => vec![cells.json(other)],
            };
            frame(vec![values_column("value", values)], max, &budget, Vec::new())
        }
    };
    builder.executed_query(command.text.clone());
    if cells.binary {
        builder.notice(
            NoticeSeverity::Warning,
            Detail::new("frame.binary_hidden", "binary values that are not text are shown empty"),
        );
    }
    for n in notices {
        builder.notice(NoticeSeverity::Info, n);
    }
    Ok(QueryResult::Frame { frame: builder.finish() })
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;
    use crate::datasources::Limits;
    use crate::datasources::frame::ResponseBudget;
    use crate::shapes::TimeRange;

    fn req(command: &str, max_rows: usize) -> SourceQuery {
        SourceQuery {
            ref_id: "A".into(),
            query: json!({ "command": command }),
            range: TimeRange { from: 0, to: 1 },
            interval_ms: 1000,
            max_data_points: None,
            variables: BTreeMap::new(),
            identifier_variables: None,
            limits: Limits {
                timeout: Duration::from_secs(5),
                max_rows,
                budget: ResponseBudget::new(1 << 20),
                pattern: Default::default(),
            },
            cursor: None,
            filters: Vec::new(),
        }
    }

    fn bulk(s: &str) -> Reply {
        Reply::Bulk(s.as_bytes().to_vec())
    }

    fn arr(items: Vec<Reply>) -> Reply {
        Reply::Array(items)
    }

    fn run(command: &str, reply: Reply) -> Value {
        let r = req(command, 100);
        let c = super::super::command::prepare(&r).unwrap();
        serde_json::to_value(result(&c, reply, &r).unwrap()).unwrap()
    }

    fn fields(v: &Value) -> Vec<(String, String, Value)> {
        v["frame"]["fields"]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| (f["name"].as_str().unwrap().into(), f["type"].as_str().unwrap().into(), f["values"].clone()))
            .collect()
    }

    #[test]
    fn values_pairs_and_scores_become_tables() {
        let v = run("GET zaehler", bulk("42"));
        assert_eq!(fields(&v), [("value".into(), "number".into(), json!([42.0]))]);
        let v = run("HGETALL user:1", arr(vec![bulk("name"), bulk("Jörg"), bulk("alter"), bulk("41")]));
        assert_eq!(fields(&v)[0], ("field".into(), "string".into(), json!(["name", "alter"])));
        assert_eq!(fields(&v)[1].2, json!(["Jörg", "41"]));
        let v = run("ZRANGE z 0 -1 WITHSCORES", arr(vec![bulk("a"), bulk("1.5"), bulk("b"), bulk("2")]));
        assert_eq!(fields(&v)[1], ("score".into(), "number".into(), json!([1.5, 2.0])));
        let v = run("MGET a b", arr(vec![bulk("x"), Reply::Nil]));
        assert_eq!(fields(&v)[0].2, json!(["a", "b"]));
        assert_eq!(fields(&v)[1].2, json!(["x", null]));
        let v = run("LRANGE l 0 -1", arr(vec![bulk("x"), bulk("\u{0}\u{ff}")]));
        assert_eq!(fields(&v)[0].2, json!(["x", "\u{0}\u{ff}"]));
        let v = run("GET bin", Reply::Bulk(vec![0xff, 0xfe]));
        assert_eq!(v["frame"]["meta"]["notices"][0]["code"], "frame.binary_hidden", "{v}");
        let v = run("DBSIZE", Reply::Int(9_007_199_254_740_993));
        assert_eq!(fields(&v)[0].2, json!([9_007_199_254_740_993.0_f64]));
        let v = run("SCAN 0 COUNT 2", arr(vec![bulk("17"), arr(vec![bulk("k1"), bulk("k2")])]));
        assert_eq!(fields(&v)[0], ("key".into(), "string".into(), json!(["k1", "k2"])));
        assert_eq!(v["frame"]["meta"]["notices"][0]["params"]["cursor"], "17");
        let v = run("INFO server", bulk("# Server\r\nredis_version:8.2.1\r\nuptime_in_seconds:5\r\n"));
        assert_eq!(fields(&v)[1].2, json!(["redis_version", "uptime_in_seconds"]));
        assert_eq!(fields(&v)[0].2, json!(["Server", "Server"]));
    }

    #[test]
    fn the_row_limit_holds() {
        let r = req("LRANGE l 0 -1", 2);
        let c = super::super::command::prepare(&r).unwrap();
        let reply = arr((0..5).map(|i| bulk(&i.to_string())).collect());
        let v = serde_json::to_value(result(&c, reply, &r).unwrap()).unwrap();
        assert_eq!(fields(&v)[0].2, json!([0.0, 1.0]));
        assert_eq!(v["frame"]["meta"]["notices"][0]["code"], "frame.row_limit");
    }

    #[test]
    fn streams_json_and_search_become_documents() {
        let v = run(
            "XRANGE s - +",
            arr(vec![arr(vec![
                bulk("1800000000000-0"),
                arr(vec![bulk("temp"), bulk("21.5"), bulk("ort"), bulk("Graz")]),
            ])]),
        );
        let doc = &v["documents"]["documents"][0];
        assert_eq!(doc["_id"], "1800000000000-0");
        assert_eq!(doc["_time"], 1_800_000_000_000_i64);
        assert_eq!(doc["ort"], "Graz");
        let v = run("JSON.GET d $", bulk(r#"[{"name":"Linz","n":[1,2]}]"#));
        assert_eq!(v["documents"]["documents"], json!([{ "name": "Linz", "n": [1, 2] }]));
        let v = run("JSON.GET d $.n[*]", bulk("[1,2]"));
        assert_eq!(v["documents"]["documents"], json!([{ "value": 1 }, { "value": 2 }]));
        let v = run("JSON.GET d", bulk(r#"{"a":1}"#));
        assert_eq!(v["documents"]["documents"], json!([{ "a": 1 }]));
        let v = run("JSON.MGET a b $", arr(vec![bulk(r#"[{"x":1}]"#), Reply::Nil]));
        assert_eq!(v["documents"]["documents"], json!([{ "x": 1, "_key": "a" }]));
        let v = run(
            "FT.SEARCH idx * WITHSCORES",
            arr(vec![
                Reply::Int(2),
                bulk("doc:1"),
                bulk("0.5"),
                arr(vec![bulk("$"), bulk(r#"{"ort":"Wien"}"#)]),
                bulk("doc:2"),
                bulk("0.25"),
                arr(vec![bulk("ort"), bulk("Graz")]),
            ]),
        );
        let docs = &v["documents"]["documents"];
        assert_eq!(docs[0], json!({ "_id": "doc:1", "_score": 0.5, "ort": "Wien" }));
        assert_eq!(docs[1]["ort"], "Graz");
        assert_eq!(v["documents"]["notices"][0]["params"]["total"], "2");
        let v = run(
            "FT.AGGREGATE idx * GROUPBY 1 @ort",
            arr(vec![Reply::Int(1), arr(vec![bulk("ort"), bulk("Graz"), bulk("n"), bulk("3")])]),
        );
        assert_eq!(v["documents"]["documents"], json!([{ "ort": "Graz", "n": "3" }]));
    }

    #[test]
    fn time_series_become_time_columns_with_labels() {
        let v = run(
            "TS.RANGE temp - +",
            arr(vec![arr(vec![Reply::Int(1000), bulk("1.5")]), arr(vec![Reply::Int(2000), bulk("2")])]),
        );
        assert_eq!(fields(&v)[0], ("time".into(), "time".into(), json!([1000, 2000])));
        assert_eq!(fields(&v)[1], ("temp".into(), "number".into(), json!([1.5, 2.0])));
        let v = run("TS.GET temp", arr(vec![Reply::Int(3000), bulk("7")]));
        assert_eq!(fields(&v)[1].2, json!([7.0]));
        let v = run(
            "TS.MRANGE - + WITHLABELS FILTER area=nord",
            arr(vec![
                arr(vec![
                    bulk("t:1"),
                    arr(vec![arr(vec![bulk("area"), bulk("nord")])]),
                    arr(vec![arr(vec![Reply::Int(1000), bulk("1")])]),
                ]),
                arr(vec![bulk("t:2"), arr(vec![]), arr(vec![arr(vec![Reply::Int(2000), bulk("2")])])]),
            ]),
        );
        let f = &v["frame"]["fields"];
        assert_eq!(f[0]["values"], json!([1000, 2000]));
        assert_eq!(f[1]["values"], json!([1.0, null]));
        assert_eq!(f[1]["labels"], json!({ "area": "nord" }));
        assert_eq!(f[2]["values"], json!([null, 2.0]));
        let v = run(
            "TS.MGET FILTER area=nord",
            arr(vec![arr(vec![bulk("t:1"), arr(vec![]), arr(vec![Reply::Int(5), bulk("9")])])]),
        );
        assert_eq!(fields(&v)[2].2, json!([9.0]));
    }

    #[test]
    fn a_server_error_is_the_sources_error() {
        let r = req("GET a", 10);
        let c = super::super::command::prepare(&r).unwrap();
        let e = result(&c, Reply::Error("WRONGTYPE Operation against a key".into()), &r).unwrap_err();
        assert_eq!(e.detail().reason, "redis.error");
        let e = result(&c, Reply::Error("NOPERM this user has no permissions".into()), &r).unwrap_err();
        assert_eq!(e.detail().reason, "redis.no_permission");
    }
}
