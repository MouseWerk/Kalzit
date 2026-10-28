//! Results in their native shapes, written part by part: a writer per shape that keeps the
//! protocol's order (start, batches, end), cuts batches at about `TARGET_PART_BYTES`, and stops
//! asking for more once the query's limits are passed.

use std::collections::{BTreeMap, BTreeSet};

use kalzit_plugin_api::{MAX_MESSAGE_BYTES, TARGET_PART_BYTES};
use serde_json::Value;
use tokio::sync::mpsc;

use crate::{Error, Limits, pb};

/// The largest single row, document or graph element: half a message, so a batch of one always
/// fits.
const MAX_ITEM_BYTES: usize = MAX_MESSAGE_BYTES / 2;

/// Proof that a result was ended: only the writers' `finish` makes one.
#[derive(Debug)]
#[must_use = "return it from query"]
pub struct Finished(());

/// Whether a writer wants more.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[must_use]
pub enum Flow {
    Continue,
    /// The query's row or byte limit is passed: stop reading and finish. More rows are dropped;
    /// the host cuts the result and says so.
    Full,
}

impl Flow {
    pub fn is_full(self) -> bool {
        self == Flow::Full
    }
}

/// The types of frame fields. Values travel as JSON: `Time` and `Date` as numbers of Unix
/// milliseconds, `Number` as numbers, `Int64` and `Decimal` as decimal strings (see
/// [`int64`](FieldType::Int64)), `String` as strings, `Bool` as booleans, `Json` as anything;
/// `null` everywhere.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FieldType {
    Time,
    Number,
    /// Integers as decimal strings, so no digit is lost: `json!("9007199254740993")`.
    Int64,
    String,
    Bool,
    Json,
    /// Exact decimals as decimal strings without exponent: `json!("-1234.50")`.
    Decimal,
    /// Calendar days as Unix milliseconds of midnight UTC.
    Date,
}

impl FieldType {
    fn pb(self) -> pb::FieldType {
        match self {
            FieldType::Time => pb::FieldType::Time,
            FieldType::Number => pb::FieldType::Number,
            FieldType::Int64 => pb::FieldType::Int64,
            FieldType::String => pb::FieldType::String,
            FieldType::Bool => pb::FieldType::Bool,
            FieldType::Json => pb::FieldType::Json,
            FieldType::Decimal => pb::FieldType::Decimal,
            FieldType::Date => pb::FieldType::Date,
        }
    }
}

/// One field of a frame.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Field {
    pub name: String,
    pub field_type: FieldType,
    pub unit: Option<String>,
    pub labels: Option<BTreeMap<String, String>>,
}

impl Field {
    pub fn new(name: impl Into<String>, field_type: FieldType) -> Self {
        Self { name: name.into(), field_type, unit: None, labels: None }
    }

    pub fn unit(mut self, unit: impl Into<String>) -> Self {
        self.unit = Some(unit.into());
        self
    }

    pub fn label(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.labels.get_or_insert_with(BTreeMap::new).insert(key.into(), value.into());
        self
    }

    fn pb(&self) -> pb::FrameField {
        pb::FrameField {
            name: self.name.clone(),
            r#type: self.field_type.pb() as i32,
            unit: self.unit.clone(),
            labels: self.labels.clone().map(|entries| pb::StringMap { entries }),
        }
    }
}

/// A notice on a result: an info or a warning with a code the UI may translate.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Notice {
    pub warning: bool,
    pub code: String,
    pub params: BTreeMap<String, String>,
    pub text: String,
}

impl Notice {
    pub fn info(code: impl Into<String>, text: impl Into<String>) -> Self {
        Self { warning: false, code: code.into(), params: BTreeMap::new(), text: text.into() }
    }

    pub fn warning(code: impl Into<String>, text: impl Into<String>) -> Self {
        Self { warning: true, ..Self::info(code, text) }
    }

    pub fn with(mut self, key: impl Into<String>, value: impl ToString) -> Self {
        self.params.insert(key.into(), value.to_string());
        self
    }

    fn pb(&self) -> pb::Notice {
        let severity = if self.warning { pb::NoticeSeverity::Warning } else { pb::NoticeSeverity::Info };
        pb::Notice {
            severity: severity as i32,
            code: self.code.clone(),
            params: (!self.params.is_empty()).then(|| pb::StringMap { entries: self.params.clone() }),
            text: self.text.clone(),
        }
    }
}

fn chunk(part: pb::query_chunk::Part) -> pb::QueryChunk {
    pb::QueryChunk { part: Some(part) }
}

fn too_large(what: &str) -> Error {
    Error::failed("plugin.result_too_large", format!("{what} is larger than {MAX_ITEM_BYTES} bytes"))
}

/// Sends parts and counts against the query's limits.
struct Out {
    tx: mpsc::Sender<pb::QueryChunk>,
    limits: Limits,
    /// Rows, documents or graph elements written (sent or buffered).
    items: u64,
    /// Bytes of the parts sent so far (their JSON).
    bytes: u64,
    full: bool,
}

impl Out {
    async fn send(&mut self, part: pb::query_chunk::Part) -> Result<(), Error> {
        self.tx.send(chunk(part)).await.map_err(|_| Error::failed("plugin.cancelled", "the host ended the call"))
    }

    /// Counts one more item of `size` bytes and says whether the limits are passed. One item
    /// beyond the row limit and one part beyond the byte budget still go out, so the host sees
    /// that the result was cut and says so.
    fn count(&mut self, size: usize, buffered: usize) -> Flow {
        self.items += 1;
        let rows = self.limits.max_rows > 0 && self.items > self.limits.max_rows;
        let bytes = self.limits.max_response_bytes > 0
            && self.bytes + buffered as u64 + size as u64 > self.limits.max_response_bytes;
        if rows || bytes {
            self.full = true;
            Flow::Full
        } else {
            Flow::Continue
        }
    }
}

/// The start of a query's result: pick its shape.
pub struct Results {
    out: Out,
}

impl Results {
    pub(crate) fn new(tx: mpsc::Sender<pb::QueryChunk>, limits: Limits) -> Self {
        Self { out: Out { tx, limits, items: 0, bytes: 0, full: false } }
    }

    /// The query's limits.
    pub fn limits(&self) -> Limits {
        self.out.limits
    }

    /// Starts a frame with these fields.
    pub async fn frame(mut self, fields: Vec<Field>) -> Result<FrameWriter, Error> {
        let start =
            pb::ResultStart { shape: pb::Shape::Frame as i32, frame_fields: fields.iter().map(Field::pb).collect() };
        self.out.send(pb::query_chunk::Part::Start(start)).await?;
        let columns = vec![String::from("["); fields.len()];
        Ok(FrameWriter { out: self.out, columns, rows: 0, buffered: 0, executed_query: None, notices: Vec::new() })
    }

    /// Starts a set of documents.
    pub async fn documents(mut self) -> Result<DocumentWriter, Error> {
        self.out
            .send(pb::query_chunk::Part::Start(pb::ResultStart {
                shape: pb::Shape::Documents as i32,
                frame_fields: vec![],
            }))
            .await?;
        Ok(DocumentWriter {
            out: self.out,
            batch: Vec::new(),
            buffered: 0,
            next_cursor: None,
            executed_query: None,
            notices: Vec::new(),
        })
    }

    /// Starts a graph.
    pub async fn graph(mut self) -> Result<GraphWriter, Error> {
        self.out
            .send(pb::query_chunk::Part::Start(pb::ResultStart {
                shape: pb::Shape::Graph as i32,
                frame_fields: vec![],
            }))
            .await?;
        Ok(GraphWriter {
            out: self.out,
            batch: pb::GraphBatch::default(),
            buffered: 0,
            has_paths: false,
            labels: BTreeSet::new(),
            edge_types: BTreeSet::new(),
            keys: BTreeMap::new(),
            notices: Vec::new(),
        })
    }
}

/// The rows of a frame.
pub struct FrameWriter {
    out: Out,
    /// One JSON array per field, open at the end.
    columns: Vec<String>,
    rows: usize,
    buffered: usize,
    executed_query: Option<String>,
    notices: Vec<Notice>,
}

impl FrameWriter {
    /// Adds a row: one value per field, in the order of the fields. Says `Full` once the
    /// query's limits are passed; rows after that are dropped.
    pub async fn row(&mut self, values: Vec<Value>) -> Result<Flow, Error> {
        if self.out.full {
            return Ok(Flow::Full);
        }
        if values.len() != self.columns.len() {
            return Err(Error::failed(
                "plugin.row_invalid",
                format!("a row has {} values for {} fields", values.len(), self.columns.len()),
            ));
        }
        let texts: Vec<String> = values.iter().map(Value::to_string).collect();
        let size: usize = texts.iter().map(|t| t.len() + 1).sum();
        if size > MAX_ITEM_BYTES {
            return Err(too_large("a row"));
        }
        let flow = self.out.count(size, self.buffered);
        for (column, text) in self.columns.iter_mut().zip(texts) {
            if self.rows > 0 {
                column.push(',');
            }
            column.push_str(&text);
        }
        self.rows += 1;
        self.buffered += size;
        if self.buffered >= TARGET_PART_BYTES || flow.is_full() {
            self.flush().await?;
        }
        Ok(flow)
    }

    /// The query as the source ran it, shown next to the result.
    pub fn executed_query(&mut self, query: impl Into<String>) {
        self.executed_query = Some(query.into());
    }

    pub fn notice(&mut self, notice: Notice) {
        self.notices.push(notice);
    }

    async fn flush(&mut self) -> Result<(), Error> {
        if self.rows == 0 {
            return Ok(());
        }
        let columns_json: Vec<String> = self
            .columns
            .iter_mut()
            .map(|c| {
                let mut done = std::mem::replace(c, String::from("["));
                done.push(']');
                done
            })
            .collect();
        self.out.bytes += self.buffered as u64;
        self.rows = 0;
        self.buffered = 0;
        self.out.send(pb::query_chunk::Part::FrameRows(pb::FrameRows { columns_json })).await
    }

    /// Sends what is left and ends the frame.
    pub async fn finish(mut self) -> Result<Finished, Error> {
        self.flush().await?;
        let meta = pb::FrameMeta {
            executed_query: self.executed_query.take(),
            rows_truncated: false,
            notices: self.notices.iter().map(Notice::pb).collect(),
        };
        let end = pb::ResultEnd { meta: Some(pb::result_end::Meta::Frame(pb::FrameEnd { meta: Some(meta) })) };
        self.out.send(pb::query_chunk::Part::End(end)).await?;
        Ok(Finished(()))
    }
}

/// The documents of a set, each a JSON object in the source's key order.
pub struct DocumentWriter {
    out: Out,
    batch: Vec<String>,
    buffered: usize,
    next_cursor: Option<String>,
    executed_query: Option<String>,
    notices: Vec<Notice>,
}

impl DocumentWriter {
    /// Adds a document (a JSON object). Says `Full` once the query's limits are passed.
    pub async fn document(&mut self, document: Value) -> Result<Flow, Error> {
        if !document.is_object() {
            return Err(Error::failed("plugin.document_invalid", "a document is a JSON object"));
        }
        if self.out.full {
            return Ok(Flow::Full);
        }
        let text = document.to_string();
        if text.len() > MAX_ITEM_BYTES {
            return Err(too_large("a document"));
        }
        let flow = self.out.count(text.len(), self.buffered);
        self.buffered += text.len();
        self.batch.push(text);
        if self.buffered >= TARGET_PART_BYTES || flow.is_full() {
            self.flush().await?;
        }
        Ok(flow)
    }

    /// Where the next page starts; the host hands it back as `Query::cursor`.
    pub fn next_cursor(&mut self, cursor: impl Into<String>) {
        self.next_cursor = Some(cursor.into());
    }

    pub fn executed_query(&mut self, query: impl Into<String>) {
        self.executed_query = Some(query.into());
    }

    pub fn notice(&mut self, notice: Notice) {
        self.notices.push(notice);
    }

    async fn flush(&mut self) -> Result<(), Error> {
        if self.batch.is_empty() {
            return Ok(());
        }
        self.out.bytes += self.buffered as u64;
        self.buffered = 0;
        let documents_json = std::mem::take(&mut self.batch);
        self.out.send(pb::query_chunk::Part::Documents(pb::DocumentBatch { documents_json })).await
    }

    pub async fn finish(mut self) -> Result<Finished, Error> {
        self.flush().await?;
        let end = pb::DocumentsEnd {
            schema: vec![],
            next_cursor: self.next_cursor.take(),
            truncated: None,
            notices: self.notices.iter().map(Notice::pb).collect(),
            executed_query: self.executed_query.take(),
            distributable: false,
        };
        self.out
            .send(pb::query_chunk::Part::End(pb::ResultEnd { meta: Some(pb::result_end::Meta::Documents(end)) }))
            .await?;
        Ok(Finished(()))
    }
}

/// Nodes, edges and paths of a graph. The schema (labels, edge types, property keys) is
/// gathered from what is written.
pub struct GraphWriter {
    out: Out,
    batch: pb::GraphBatch,
    buffered: usize,
    has_paths: bool,
    labels: BTreeSet<String>,
    edge_types: BTreeSet<String>,
    keys: BTreeMap<String, BTreeSet<String>>,
    notices: Vec<Notice>,
}

fn properties_json(properties: &Value) -> Result<String, Error> {
    match properties {
        Value::Null => Ok("{}".into()),
        Value::Object(_) => Ok(properties.to_string()),
        _ => Err(Error::failed("plugin.graph_invalid", "properties are a JSON object")),
    }
}

impl GraphWriter {
    fn seen_keys(&mut self, name: &str, properties: &Value) {
        if let Some(object) = properties.as_object() {
            self.keys.entry(name.to_string()).or_default().extend(object.keys().cloned());
        }
    }

    async fn added(&mut self, size: usize) -> Result<Flow, Error> {
        if size > MAX_ITEM_BYTES {
            return Err(too_large("a graph element"));
        }
        let flow = self.out.count(size, self.buffered);
        self.buffered += size;
        if self.buffered >= TARGET_PART_BYTES || flow.is_full() {
            self.flush().await?;
        }
        Ok(flow)
    }

    /// Adds a node with its labels and properties (a JSON object, or `null` for none).
    pub async fn node(&mut self, id: impl Into<String>, labels: Vec<String>, properties: Value) -> Result<Flow, Error> {
        if self.out.full {
            return Ok(Flow::Full);
        }
        let properties_json = properties_json(&properties)?;
        for label in &labels {
            self.labels.insert(label.clone());
            self.seen_keys(label, &properties);
        }
        let node = pb::Node { id: id.into(), labels, properties_json };
        let size = node.id.len() + node.properties_json.len() + node.labels.iter().map(String::len).sum::<usize>();
        self.batch.nodes.push(node);
        self.added(size).await
    }

    /// Adds an edge of `edge_type` from one node id to another.
    pub async fn edge(
        &mut self,
        id: impl Into<String>,
        edge_type: impl Into<String>,
        from: impl Into<String>,
        to: impl Into<String>,
        properties: Value,
    ) -> Result<Flow, Error> {
        if self.out.full {
            return Ok(Flow::Full);
        }
        let properties_json = properties_json(&properties)?;
        let edge =
            pb::Edge { id: id.into(), r#type: edge_type.into(), from: from.into(), to: to.into(), properties_json };
        self.edge_types.insert(edge.r#type.clone());
        let name = edge.r#type.clone();
        self.seen_keys(&name, &properties);
        let size = edge.id.len() + edge.r#type.len() + edge.from.len() + edge.to.len() + edge.properties_json.len();
        self.batch.edges.push(edge);
        self.added(size).await
    }

    /// Adds a path: node ids and the edge ids between them. A graph with paths says so in its
    /// end, also when the paths are cut.
    pub async fn path(&mut self, nodes: Vec<String>, edges: Vec<String>) -> Result<Flow, Error> {
        self.has_paths = true;
        if self.out.full {
            return Ok(Flow::Full);
        }
        let size: usize = nodes.iter().chain(&edges).map(|s| s.len() + 3).sum();
        self.batch.paths.push(pb::GraphPath { nodes, edges });
        // Paths are not elements of the row limit; only their bytes count.
        if size > MAX_ITEM_BYTES {
            return Err(too_large("a path"));
        }
        self.buffered += size;
        if self.buffered >= TARGET_PART_BYTES {
            self.flush().await?;
        }
        Ok(Flow::Continue)
    }

    pub fn notice(&mut self, notice: Notice) {
        self.notices.push(notice);
    }

    async fn flush(&mut self) -> Result<(), Error> {
        if self.batch.nodes.is_empty() && self.batch.edges.is_empty() && self.batch.paths.is_empty() {
            return Ok(());
        }
        self.out.bytes += self.buffered as u64;
        self.buffered = 0;
        let batch = std::mem::take(&mut self.batch);
        self.out.send(pb::query_chunk::Part::Graph(batch)).await
    }

    pub async fn finish(mut self) -> Result<Finished, Error> {
        self.flush().await?;
        let schema = pb::GraphSchema {
            labels: std::mem::take(&mut self.labels).into_iter().collect(),
            edge_types: std::mem::take(&mut self.edge_types).into_iter().collect(),
            property_keys: std::mem::take(&mut self.keys)
                .into_iter()
                .map(|(k, v)| (k, pb::StringList { values: v.into_iter().collect() }))
                .collect(),
        };
        let end = pb::GraphEnd {
            schema: Some(schema),
            truncated: None,
            notices: (!self.notices.is_empty())
                .then(|| pb::Notices { items: self.notices.iter().map(Notice::pb).collect() }),
            has_paths: self.has_paths,
        };
        self.out
            .send(pb::query_chunk::Part::End(pb::ResultEnd { meta: Some(pb::result_end::Meta::Graph(end)) }))
            .await?;
        Ok(Finished(()))
    }
}

/// The change feed of [`DataSource::watch`](crate::DataSource::watch).
pub struct WatchFeed {
    tx: mpsc::Sender<pb::WatchEvent>,
    sent: bool,
}

impl WatchFeed {
    pub(crate) fn new(tx: mpsc::Sender<pb::WatchEvent>) -> Self {
        Self { tx, sent: false }
    }

    async fn send(&mut self, event: pb::watch_event::Event) -> Result<(), Error> {
        self.sent = true;
        self.tx
            .send(pb::WatchEvent { event: Some(event) })
            .await
            .map_err(|_| Error::failed("plugin.cancelled", "the host ended the call"))
    }

    /// Something changed that may alter the result; `token` is the position to resume from.
    pub async fn changed(&mut self, token: Option<Vec<u8>>) -> Result<(), Error> {
        self.send(pb::watch_event::Event::Change(pb::Change { changed: true, token })).await
    }

    /// Nothing changed, but the feed moved on to `token`.
    pub async fn position(&mut self, token: Vec<u8>) -> Result<(), Error> {
        self.send(pb::watch_event::Event::Change(pb::Change { changed: false, token: Some(token) })).await
    }

    /// This source cannot report changes; the host polls instead. Only as the first event.
    pub async fn unsupported(mut self) -> Result<(), Error> {
        if self.sent {
            return Err(Error::failed("plugin.watch_invalid", "unsupported is only the first event of a feed"));
        }
        self.send(pb::watch_event::Event::Unsupported(pb::Unsupported {})).await
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn results(max_rows: u64, max_bytes: u64) -> (Results, mpsc::Receiver<pb::QueryChunk>) {
        let (tx, rx) = mpsc::channel(1024);
        (Results::new(tx, Limits { timeout: Default::default(), max_rows, max_response_bytes: max_bytes }), rx)
    }

    fn drain(mut rx: mpsc::Receiver<pb::QueryChunk>) -> Vec<pb::query_chunk::Part> {
        let mut out = Vec::new();
        while let Ok(c) = rx.try_recv() {
            out.push(c.part.unwrap());
        }
        out
    }

    #[tokio::test]
    async fn a_frame_goes_out_in_order_with_columns_of_equal_length() {
        let (out, rx) = results(0, 0);
        let mut frame = out
            .frame(vec![Field::new("t", FieldType::Time).unit("ms"), Field::new("v", FieldType::Number)])
            .await
            .unwrap();
        for i in 0..3 {
            assert_eq!(frame.row(vec![json!(i * 1000), json!(i as f64 / 2.0)]).await.unwrap(), Flow::Continue);
        }
        frame.executed_query("GET /x");
        let _done = frame.finish().await.unwrap();
        let parts = drain(rx);
        assert_eq!(parts.len(), 3);
        let pb::query_chunk::Part::Start(start) = &parts[0] else { panic!("{parts:?}") };
        assert_eq!(start.frame_fields[0].unit.as_deref(), Some("ms"));
        let pb::query_chunk::Part::FrameRows(rows) = &parts[1] else { panic!("{parts:?}") };
        assert_eq!(rows.columns_json, ["[0,1000,2000]", "[0.0,0.5,1.0]"]);
        let pb::query_chunk::Part::End(end) = &parts[2] else { panic!("{parts:?}") };
        let Some(pb::result_end::Meta::Frame(f)) = &end.meta else { panic!() };
        assert_eq!(f.meta.as_ref().unwrap().executed_query.as_deref(), Some("GET /x"));
    }

    #[tokio::test]
    async fn rows_are_cut_into_parts_below_the_message_limit() {
        let (out, rx) = results(0, 0);
        let mut frame = out.frame(vec![Field::new("s", FieldType::String)]).await.unwrap();
        let text = "x".repeat(10_000);
        for _ in 0..500 {
            let _ = frame.row(vec![json!(text)]).await.unwrap();
        }
        let _done = frame.finish().await.unwrap();
        let parts = drain(rx);
        let batches: Vec<_> = parts
            .iter()
            .filter_map(|p| match p {
                pb::query_chunk::Part::FrameRows(r) => Some(r),
                _ => None,
            })
            .collect();
        assert!(batches.len() >= 4, "{} batches", batches.len());
        let total: usize =
            batches.iter().map(|b| serde_json::from_str::<Vec<String>>(&b.columns_json[0]).unwrap().len()).sum();
        assert_eq!(total, 500);
        assert!(batches.iter().all(|b| b.columns_json[0].len() < TARGET_PART_BYTES + 20_000));
    }

    #[tokio::test]
    async fn the_row_limit_lets_one_more_row_through_and_then_says_full() {
        let (out, rx) = results(2, 0);
        let mut frame = out.frame(vec![Field::new("n", FieldType::Number)]).await.unwrap();
        assert_eq!(frame.row(vec![json!(1)]).await.unwrap(), Flow::Continue);
        assert_eq!(frame.row(vec![json!(2)]).await.unwrap(), Flow::Continue);
        assert_eq!(frame.row(vec![json!(3)]).await.unwrap(), Flow::Full);
        assert_eq!(frame.row(vec![json!(4)]).await.unwrap(), Flow::Full);
        let _done = frame.finish().await.unwrap();
        let rows: Vec<String> = drain(rx)
            .into_iter()
            .filter_map(|p| match p {
                pb::query_chunk::Part::FrameRows(r) => Some(r.columns_json[0].clone()),
                _ => None,
            })
            .collect();
        assert_eq!(rows, ["[1,2,3]"]);
    }

    #[tokio::test]
    async fn the_byte_budget_says_full() {
        let (out, _rx) = results(0, 100);
        let mut docs = out.documents().await.unwrap();
        assert_eq!(docs.document(json!({ "a": "x".repeat(40) })).await.unwrap(), Flow::Continue);
        assert_eq!(docs.document(json!({ "a": "x".repeat(80) })).await.unwrap(), Flow::Full);
    }

    #[tokio::test]
    async fn misuse_is_an_error() {
        let (out, _rx) = results(0, 0);
        let mut frame = out.frame(vec![Field::new("a", FieldType::Number)]).await.unwrap();
        assert_eq!(frame.row(vec![]).await.unwrap_err().detail.reason, "plugin.row_invalid");
        let (out, _rx) = results(0, 0);
        let mut docs = out.documents().await.unwrap();
        assert_eq!(docs.document(json!([1])).await.unwrap_err().detail.reason, "plugin.document_invalid");
    }

    #[tokio::test]
    async fn a_graph_gathers_its_schema() {
        let (out, rx) = results(0, 0);
        let mut g = out.graph().await.unwrap();
        let _ = g.node("a", vec!["Person".into()], json!({ "name": "Ada" })).await.unwrap();
        let _ = g.node("b", vec!["Person".into()], Value::Null).await.unwrap();
        let _ = g.edge("e", "KNOWS", "a", "b", json!({ "since": 2020 })).await.unwrap();
        let _ = g.path(vec!["a".into(), "b".into()], vec!["e".into()]).await.unwrap();
        let _done = g.finish().await.unwrap();
        let parts = drain(rx);
        let pb::query_chunk::Part::End(end) = parts.last().unwrap() else { panic!() };
        let Some(pb::result_end::Meta::Graph(g)) = &end.meta else { panic!() };
        let schema = g.schema.as_ref().unwrap();
        assert_eq!(schema.labels, ["Person"]);
        assert_eq!(schema.edge_types, ["KNOWS"]);
        assert_eq!(schema.property_keys["Person"].values, ["name"]);
        assert_eq!(schema.property_keys["KNOWS"].values, ["since"]);
        assert!(g.has_paths);
    }
}
