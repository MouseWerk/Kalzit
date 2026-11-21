//! Export files from a result after its steps, in the result's own shape (docs/api/datasources.md,
//! "Export"): a frame as CSV, JSON or Excel, documents as JSON or NDJSON, a graph as GraphML,
//! JSON or its two lists as CSV (nodes, edges). A format never turns one shape into another; that
//! is a step (a projection, a graph step that makes a table) the export runs before it, as the
//! browser does. The two graph CSV files are the graph's own lists, written as they are: one row
//! per node or edge, one column per property.
//!
//! Excel files are written with `rust_xlsxwriter`: maintained by the author of the Python
//! XlsxWriter and libxlsxwriter, pure Rust, no default features, and it writes real cells (numbers,
//! dates, booleans), never formulas. Writing them on the server keeps the export behind the
//! server's permission check; a browser library would need the data in the browser first.
//!
//! Files are written in chunks of 1 MiB into a callback (`encode_to`), CSV, JSON, NDJSON and
//! GraphML row by row (document by document, node by node) and Excel from a spool file in
//! constant memory mode, so the route can send each chunk as it is made and memory does not grow
//! with the file. `encode` and `encode_within` collect the chunks
//! (for tests and small callers).

use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::Path;

use rust_xlsxwriter::{Format, Workbook};
use serde_json::Value;

use super::expr::{self, iso_time, number_text};
use super::steps::{Control, int_of};
use crate::datasources::detail::Detail;
use crate::shapes::{
    DocumentSet, ExportFormat, ExportLanguage, FieldSchema, FieldType, Frame, FrameMeta, GraphSet, Notice, OrderedJson,
    Shape, TraceSet, Truncated,
};

/// A whole encoded file in chunks (see `encode`).
#[derive(Debug)]
pub struct File {
    pub chunks: Vec<Vec<u8>>,
    pub content_type: &'static str,
    pub extension: &'static str,
}

impl File {
    /// The whole file in one piece (for tests and small callers).
    pub fn bytes(&self) -> Vec<u8> {
        self.chunks.concat()
    }
}

/// Headers of a format's files.
#[derive(Clone, Copy, Debug)]
pub struct Kind {
    pub content_type: &'static str,
    pub extension: &'static str,
    /// What the file name says after its base: which of a graph's two CSV files this is.
    pub suffix: &'static str,
}

pub fn kind(format: ExportFormat) -> Kind {
    let (content_type, extension, suffix) = match format {
        ExportFormat::Csv => ("text/csv; charset=utf-8", "csv", ""),
        ExportFormat::CsvNodes => ("text/csv; charset=utf-8", "csv", "-nodes"),
        ExportFormat::CsvEdges => ("text/csv; charset=utf-8", "csv", "-edges"),
        ExportFormat::Json => ("application/json", "json", ""),
        ExportFormat::Xlsx => ("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "xlsx", ""),
        ExportFormat::Ndjson => ("application/x-ndjson", "ndjson", ""),
        ExportFormat::Graphml => ("application/graphml+xml; charset=utf-8", "graphml", ""),
    };
    Kind { content_type, extension, suffix }
}

/// Whether `format` writes results of `shape`: frames as CSV, JSON or Excel, documents as JSON or
/// NDJSON, graphs as GraphML, JSON or their node and edge lists as CSV, traces as OTLP JSON.
pub fn fits(shape: Shape, format: ExportFormat) -> bool {
    use ExportFormat::{Csv, CsvEdges, CsvNodes, Graphml, Json, Ndjson, Xlsx};
    matches!(
        (shape, format),
        (Shape::Frame, Csv | Json | Xlsx)
            | (Shape::Documents, Json | Ndjson)
            | (Shape::Graph, Json | Graphml | CsvNodes | CsvEdges)
            | (Shape::Trace, Json)
    )
}

pub fn shape_name(shape: Shape) -> &'static str {
    match shape {
        Shape::Frame => "frame",
        Shape::Documents => "documents",
        Shape::Graph => "graph",
        Shape::Trace => "trace",
    }
}

fn format_name(format: ExportFormat) -> &'static str {
    match format {
        ExportFormat::Csv => "csv",
        ExportFormat::Json => "json",
        ExportFormat::Xlsx => "xlsx",
        ExportFormat::Ndjson => "ndjson",
        ExportFormat::Graphml => "graphml",
        ExportFormat::CsvNodes => "csvNodes",
        ExportFormat::CsvEdges => "csvEdges",
    }
}

/// The refusal of a format that does not write this shape.
pub fn format_unsupported(shape: Shape, format: ExportFormat) -> Detail {
    let (shape, format) = (shape_name(shape), format_name(format));
    Detail::new("export.format_unsupported", format!("{shape} results cannot be exported as {format}"))
        .with("shape", shape)
        .with("format", format)
}

/// One result after the steps, in its own shape, as a file holds it.
#[derive(Clone, Copy, Debug)]
pub enum Content<'a> {
    Frame(&'a Frame),
    Documents(&'a DocumentSet),
    Graph(&'a GraphSet),
    Trace(&'a TraceSet),
}

impl Content<'_> {
    pub fn shape(&self) -> Shape {
        match self {
            Content::Frame(_) => Shape::Frame,
            Content::Documents(_) => Shape::Documents,
            Content::Graph(_) => Shape::Graph,
            Content::Trace(_) => Shape::Trace,
        }
    }

    /// What the audit entry counts: `rows`, `documents`, `nodes` and `edges`, or `spans`.
    pub fn counts(&self) -> Vec<(&'static str, usize)> {
        match self {
            Content::Frame(f) => vec![("rows", f.rows())],
            Content::Documents(d) => vec![("documents", d.documents.len())],
            Content::Graph(g) => vec![("nodes", g.nodes.len()), ("edges", g.edges.len())],
            Content::Trace(t) => vec![("spans", t.spans.len())],
        }
    }

    /// About as large as the file may get, for the disk space check.
    pub fn estimate(&self) -> u64 {
        let size = match self {
            Content::Frame(f) => f.rows().saturating_mul(f.fields().len()).saturating_mul(24),
            Content::Documents(d) => d.documents.iter().map(|doc| doc.get().len() + 2).sum(),
            Content::Graph(g) => {
                let each = |n: usize| n.saturating_add(2).saturating_mul(64);
                let nodes: usize = g.nodes.iter().map(|n| each(n.properties.len() + n.labels.len())).sum();
                let edges: usize = g.edges.iter().map(|e| each(e.properties.len())).sum();
                nodes.saturating_add(edges)
            }
            Content::Trace(t) => {
                let each = |n: usize| n.saturating_add(12).saturating_mul(64);
                t.spans.iter().map(|s| each(s.attributes.len() + s.resource.len() + s.events.len())).sum()
            }
        };
        size as u64
    }
}

/// Excel's sheet limits: rows including the header, and columns.
pub const XLSX_MAX_ROWS: usize = 1_048_576;
pub const XLSX_MAX_COLUMNS: usize = 16_384;
const XLSX_MAX_TEXT: usize = 32_767;
/// The largest file an export writes; CSV and JSON stop as soon as they would pass it, an Excel
/// file is checked when it is finished, before it is sent.
pub const MAX_FILE_BYTES: usize = 256 * 1024 * 1024;
/// The size of one chunk of a file being written.
const CHUNK: usize = 1024 * 1024;

/// The limits a file is written within; tests make them small.
#[derive(Clone, Copy, Debug)]
pub struct Caps {
    pub file_bytes: usize,
}

impl Default for Caps {
    fn default() -> Self {
        Self { file_bytes: MAX_FILE_BYTES }
    }
}

fn too_large(max: usize) -> Detail {
    Detail::new("export.too_large", format!("the file would be larger than {max} bytes")).with("max", max)
}

/// Where the chunks of a file go; an error stops the writing and is the file's failure.
pub type Emit<'a> = dyn FnMut(Vec<u8>) -> Result<(), Detail> + 'a;

/// Cuts a file into chunks for `out`, failing as soon as it would pass the size limit and
/// looking at the control (cancel flag, deadline) now and then, so a long encode stops in time.
/// A file sent to a client (`deadline` false) is not held to the deadline: the client's pace
/// decides how long sending takes; the cancel flag and a failing `out` still stop it.
struct Sink<'a, 'b> {
    out: &'a mut Emit<'b>,
    current: Vec<u8>,
    total: usize,
    max: usize,
    writes: usize,
    control: &'a Control,
    deadline: bool,
    failure: Option<Detail>,
}

impl<'a, 'b> Sink<'a, 'b> {
    fn new(max: usize, control: &'a Control, deadline: bool, out: &'a mut Emit<'b>) -> Self {
        Self { out, current: Vec::with_capacity(CHUNK), total: 0, max, writes: 0, control, deadline, failure: None }
    }

    fn fail(&mut self, d: Detail) -> std::io::Error {
        self.failure = Some(d);
        std::io::Error::other("export stopped")
    }

    /// The reason the writing stopped, from an error of `write`.
    fn reason(&mut self, e: std::io::Error) -> Detail {
        self.failure.take().unwrap_or_else(|| {
            Detail::new("export.failed", format!("the file could not be written: {e}")).with("detail", &e)
        })
    }

    /// Sends the last chunk; the result of the whole writing.
    fn done(mut self, written: std::io::Result<()>) -> Result<(), Detail> {
        if let Err(e) = written {
            return Err(self.reason(e));
        }
        if !self.current.is_empty() {
            let last = std::mem::take(&mut self.current);
            (self.out)(last)?;
        }
        Ok(())
    }
}

impl Write for Sink<'_, '_> {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        if self.total + buf.len() > self.max {
            return Err(self.fail(too_large(self.max)));
        }
        let checked = if self.deadline { self.control.every(self.writes) } else { self.control.check_cancelled() };
        if let Err(d) = checked {
            return Err(self.fail(d));
        }
        self.writes += 1;
        self.total += buf.len();
        // Split at the chunk boundary, so no chunk ever grows past its 1 MiB (a growing buffer
        // would double its capacity and hold twice the file).
        let mut rest = buf;
        while !rest.is_empty() {
            let room = CHUNK - self.current.len();
            let (now, later) = rest.split_at(room.min(rest.len()));
            self.current.extend_from_slice(now);
            rest = later;
            if self.current.len() == CHUNK {
                let full = std::mem::replace(&mut self.current, Vec::with_capacity(CHUNK));
                if let Err(d) = (self.out)(full) {
                    return Err(self.fail(d));
                }
            }
        }
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

pub fn encode(
    frame: &Frame,
    name: &str,
    format: ExportFormat,
    language: ExportLanguage,
    control: &Control,
) -> Result<File, Detail> {
    encode_within(frame, name, format, language, control, Caps::default())
}

/// The whole file in memory.
pub fn encode_within(
    frame: &Frame,
    name: &str,
    format: ExportFormat,
    language: ExportLanguage,
    control: &Control,
    caps: Caps,
) -> Result<File, Detail> {
    // Only an Excel file needs a spool folder.
    let spool = if format == ExportFormat::Xlsx { Some(tempfile::tempdir().map_err(|e| io_error(&e))?) } else { None };
    let mut chunks = Vec::new();
    let mut out = |c: Vec<u8>| {
        chunks.push(c);
        Ok(())
    };
    let spool_path = spool.as_ref().map_or(Path::new(""), |d| d.path());
    encode_to(frame, name, format, language, control, caps, spool_path, true, &mut out)?;
    let Kind { content_type, extension } = kind(format);
    Ok(File { chunks, content_type, extension })
}

/// Writes the file chunk by chunk into `out`. `spool` is a private folder for the temporary
/// files of an Excel export; `deadline` says whether the control's deadline applies to the
/// writing itself (not when `out` sends to a client).
#[allow(clippy::too_many_arguments)]
pub fn encode_to(
    frame: &Frame,
    name: &str,
    format: ExportFormat,
    language: ExportLanguage,
    control: &Control,
    caps: Caps,
    spool: &Path,
    deadline: bool,
    out: &mut Emit<'_>,
) -> Result<(), Detail> {
    encode_content_to(Content::Frame(frame), name, format, language, control, caps, spool, deadline, out)
}

/// `encode_to` for a result of any shape; a format that does not write the shape is refused
/// (`export.format_unsupported`) before anything is written.
#[allow(clippy::too_many_arguments)]
pub fn encode_content_to(
    content: Content<'_>,
    name: &str,
    format: ExportFormat,
    language: ExportLanguage,
    control: &Control,
    caps: Caps,
    spool: &Path,
    deadline: bool,
    out: &mut Emit<'_>,
) -> Result<(), Detail> {
    let max = caps.file_bytes;
    match (content, format) {
        (Content::Frame(frame), ExportFormat::Csv) => csv_to(frame, language, control, max, deadline, out),
        (Content::Frame(frame), ExportFormat::Json) => json_to(frame, control, max, deadline, out),
        (Content::Frame(frame), ExportFormat::Xlsx) => xlsx_to(frame, name, control, caps, spool, deadline, out),
        (Content::Documents(set), ExportFormat::Json) => documents_json_to(set, control, max, deadline, out),
        (Content::Documents(set), ExportFormat::Ndjson) => ndjson_to(set, control, max, deadline, out),
        (Content::Graph(graph), _) if fits(Shape::Graph, format) => {
            encode_graph_to(graph, None, format, language, control, caps, deadline, out)
        }
        (Content::Trace(trace), ExportFormat::Json) => trace_otlp_to(trace, control, max, deadline, out),
        (content, format) => Err(format_unsupported(content.shape(), format)),
    }
}

/// Where nodes are drawn, by node id, as `[x, y]` (`GraphExportScope::positions`).
pub type Positions = BTreeMap<String, [f64; 2]>;

/// At most this many node ids and positions come with a request (`GraphExportScope`).
pub const SCOPE_MAX_NODES: usize = 50_000;

/// A graph's file: JSON, GraphML (with `positions` as `x` and `y` where given) or one of its two
/// CSV lists. Any other format is refused (`export.format_unsupported`).
#[allow(clippy::too_many_arguments)]
pub fn encode_graph_to(
    graph: &GraphSet,
    positions: Option<&Positions>,
    format: ExportFormat,
    language: ExportLanguage,
    control: &Control,
    caps: Caps,
    deadline: bool,
    out: &mut Emit<'_>,
) -> Result<(), Detail> {
    let max = caps.file_bytes;
    match format {
        ExportFormat::Json => graph_json_to(graph, control, max, deadline, out),
        ExportFormat::Graphml => graphml_to(graph, positions, control, max, deadline, out),
        ExportFormat::CsvNodes => graph_csv_to(graph, GraphList::Nodes, language, control, max, deadline, out),
        ExportFormat::CsvEdges => graph_csv_to(graph, GraphList::Edges, language, control, max, deadline, out),
        other => Err(format_unsupported(Shape::Graph, other)),
    }
}

/// The part of a graph a scope names: the nodes with these ids in the result's order, the edges
/// whose two ends are both among them, and the paths that keep all their nodes and edges. Ids the
/// result does not have name nothing. Schema, notices and the note that the result was cut stay.
pub fn graph_part(graph: &GraphSet, ids: &[String]) -> GraphSet {
    let keep: std::collections::HashSet<&str> = ids.iter().map(String::as_str).collect();
    let nodes: Vec<_> = graph.nodes.iter().filter(|n| keep.contains(n.id.as_str())).cloned().collect();
    let edges: Vec<_> = graph
        .edges
        .iter()
        .filter(|e| keep.contains(e.from.as_str()) && keep.contains(e.to.as_str()))
        .cloned()
        .collect();
    let kept_edges: std::collections::HashSet<&str> = edges.iter().map(|e| e.id.as_str()).collect();
    let paths = graph.paths.as_ref().map(|paths| {
        paths
            .iter()
            .filter(|p| {
                p.nodes.iter().all(|n| keep.contains(n.as_str()))
                    && p.edges.iter().all(|e| kept_edges.contains(e.as_str()))
            })
            .cloned()
            .collect()
    });
    GraphSet {
        nodes,
        edges,
        paths,
        schema: graph.schema.clone(),
        truncated: graph.truncated.clone(),
        notices: graph.notices.clone(),
    }
}

/// The whole file of a result of any shape in memory (tests and small callers).
pub fn encode_content(
    content: Content<'_>,
    format: ExportFormat,
    control: &Control,
    caps: Caps,
) -> Result<File, Detail> {
    if let Content::Frame(frame) = content {
        return encode_within(frame, "Kalzit", format, ExportLanguage::En, control, caps);
    }
    let mut chunks = Vec::new();
    let mut out = |c: Vec<u8>| {
        chunks.push(c);
        Ok(())
    };
    encode_content_to(content, "", format, ExportLanguage::En, control, caps, Path::new(""), true, &mut out)?;
    let Kind { content_type, extension, .. } = kind(format);
    Ok(File { chunks, content_type, extension })
}

/// The documents as their result envelope, `{"shape": "documents", "documents": {...}}`: every
/// document in its own key order, the schema, and why the set was cut. The statement as sent to
/// the database and the cursor of the next page stay in Kalzit.
#[derive(serde::Serialize)]
struct DocumentsFile<'a> {
    shape: &'static str,
    documents: DocumentsBody<'a>,
}

#[derive(serde::Serialize)]
struct DocumentsBody<'a> {
    documents: &'a [OrderedJson],
    schema: &'a [FieldSchema],
    #[serde(skip_serializing_if = "Option::is_none")]
    truncated: Option<&'a Truncated>,
    notices: &'a [Notice],
}

fn documents_json_to(
    set: &DocumentSet,
    control: &Control,
    max: usize,
    deadline: bool,
    out: &mut Emit<'_>,
) -> Result<(), Detail> {
    let mut sink = Sink::new(max, control, deadline, out);
    let file = DocumentsFile {
        shape: "documents",
        documents: DocumentsBody {
            documents: &set.documents,
            schema: &set.schema,
            truncated: set.truncated.as_ref(),
            notices: &set.notices,
        },
    };
    let written = serde_json::to_writer(&mut sink, &file).map_err(std::io::Error::other);
    sink.done(written)
}

/// One document per line (NDJSON, LF line ends), each in its own key order. A document from a
/// plugin may hold line breaks between its tokens; they become spaces (a line break never stands
/// inside a JSON string), so every line is one document.
fn ndjson_to(
    set: &DocumentSet,
    control: &Control,
    max: usize,
    deadline: bool,
    out: &mut Emit<'_>,
) -> Result<(), Detail> {
    let mut sink = Sink::new(max, control, deadline, out);
    let written = (|| -> std::io::Result<()> {
        for doc in &set.documents {
            let text = doc.get();
            if text.contains(['\n', '\r']) {
                sink.write_all(text.replace(['\n', '\r'], " ").as_bytes())?;
            } else {
                sink.write_all(text.as_bytes())?;
            }
            sink.write_all(b"\n")?;
        }
        Ok(())
    })();
    sink.done(written)
}

/// The graph as its result envelope, `{"shape": "graph", "graph": {...}}`: nodes, edges, paths,
/// schema and notices as the query and the steps left them.
#[derive(serde::Serialize)]
struct GraphFile<'a> {
    shape: &'static str,
    graph: &'a GraphSet,
}

fn graph_json_to(
    graph: &GraphSet,
    control: &Control,
    max: usize,
    deadline: bool,
    out: &mut Emit<'_>,
) -> Result<(), Detail> {
    let mut sink = Sink::new(max, control, deadline, out);
    let file = GraphFile { shape: "graph", graph };
    let written = serde_json::to_writer(&mut sink, &file).map_err(std::io::Error::other);
    sink.done(written)
}

/// The trace as OTLP JSON (`super::trace::to_otlp`), the form OpenTelemetry tools read. The
/// statement as sent to the source and the notices stay in Kalzit.
fn trace_otlp_to(
    trace: &TraceSet,
    control: &Control,
    max: usize,
    deadline: bool,
    out: &mut Emit<'_>,
) -> Result<(), Detail> {
    let mut sink = Sink::new(max, control, deadline, out);
    let written = serde_json::to_writer(&mut sink, &super::trace::to_otlp(trace)).map_err(std::io::Error::other);
    sink.done(written)
}

/// The GraphML type of a property key: the narrowest that holds every value it has.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum KeyType {
    Boolean,
    Long,
    Double,
    String,
}

impl KeyType {
    fn of(value: &Value) -> Option<KeyType> {
        match value {
            Value::Null => None,
            Value::Bool(_) => Some(KeyType::Boolean),
            Value::Number(n) if n.is_i64() => Some(KeyType::Long),
            Value::Number(_) => Some(KeyType::Double),
            _ => Some(KeyType::String),
        }
    }

    fn join(self, other: KeyType) -> KeyType {
        match (self, other) {
            (a, b) if a == b => a,
            (KeyType::Long, KeyType::Double) | (KeyType::Double, KeyType::Long) => KeyType::Double,
            _ => KeyType::String,
        }
    }

    fn name(self) -> &'static str {
        match self {
            KeyType::Boolean => "boolean",
            KeyType::Long => "long",
            KeyType::Double => "double",
            KeyType::String => "string",
        }
    }
}

/// The property keys of nodes or edges with their types, in name order. A key that only ever
/// holds `null` is declared as text.
fn graph_keys<'a>(maps: impl Iterator<Item = &'a BTreeMap<String, Value>>) -> Vec<(String, KeyType)> {
    let mut keys: BTreeMap<&str, Option<KeyType>> = BTreeMap::new();
    for map in maps {
        for (key, value) in map {
            let seen = keys.entry(key.as_str()).or_insert(None);
            if let Some(t) = KeyType::of(value) {
                *seen = Some(seen.map_or(t, |s| s.join(t)));
            }
        }
    }
    keys.into_iter().map(|(k, t)| (k.to_string(), t.unwrap_or(KeyType::String))).collect()
}

/// Text for XML: the special characters as entities, line breaks and tabs kept (as character
/// references in attributes, where a parser would turn them into spaces), and the characters XML
/// 1.0 cannot hold replaced by U+FFFD.
fn xml_text(text: &str, attribute: bool) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\r' => out.push_str("&#13;"),
            '\n' if attribute => out.push_str("&#10;"),
            '\t' if attribute => out.push_str("&#9;"),
            '\n' | '\t' => out.push(c),
            c if (c as u32) < 0x20 || c == '\u{FFFE}' || c == '\u{FFFF}' => out.push('\u{FFFD}'),
            c => out.push(c),
        }
    }
    out
}

/// A property's value as GraphML data: text as it is, numbers and booleans in JSON's notation,
/// lists and objects as compact JSON.
fn data_text(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

const GRAPHML_HEAD: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<graphml xmlns="http://graphml.graphdrawing.org/xmlns" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://graphml.graphdrawing.org/xmlns http://graphml.graphdrawing.org/xmlns/1.0/graphml.xsd">
  <key id="labels" for="node" attr.name="kalzit:labels" attr.type="string"/>
  <key id="type" for="edge" attr.name="kalzit:type" attr.type="string"/>
"#;

const GRAPHML_PLACES: &str = r#"  <key id="x" for="node" attr.name="kalzit:x" attr.type="double"/>
  <key id="y" for="node" attr.name="kalzit:y" attr.type="double"/>
"#;

/// What a file says when its result was cut at a limit, or `None` for a whole result.
fn truncated_note(graph: &GraphSet) -> Option<String> {
    let cut = graph.truncated.as_ref()?;
    let reason = cut.reason.as_deref().map(|r| format!(" ({r})")).unwrap_or_default();
    Some(format!(
        "Truncated: the result was cut at its limit of {}{reason}. In this file: nodes {}, edges {}.",
        cut.limit,
        graph.nodes.len(),
        graph.edges.len()
    ))
}

/// Which of a graph's two lists a CSV file holds.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum GraphList {
    Nodes,
    Edges,
}

/// A property's value as a CSV cell: nothing for `null`, `true` or `false`, whole numbers digit
/// by digit, other numbers with the language's decimal mark, text as it is (defused, so a
/// spreadsheet never runs it as a formula), lists and objects as compact JSON text.
fn graph_cell(value: &Value, language: ExportLanguage) -> String {
    match value {
        Value::Null => String::new(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) if n.is_i64() || n.is_u64() => n.to_string(),
        Value::Number(n) => {
            let text = n.as_f64().map(number_text).unwrap_or_default();
            if language == ExportLanguage::De { text.replace('.', ",") } else { text }
        }
        Value::String(s) => defuse(s),
        // JSON text starts with `[` or `{`, never with a formula's sign.
        other => other.to_string(),
    }
}

/// The header of a property's column: its name, or `property:<name>` when the name is one of the
/// file's own columns (`id`, `labels`, `type`, `source`, `target`), so no two columns share a name.
fn property_column(name: &str, own: &[&str]) -> String {
    if own.contains(&name) { format!("property:{name}") } else { name.to_string() }
}

/// A graph's nodes or edges as CSV, in the result's order: `id`, `labels` (as `:Person:Customer`)
/// and one column per node property, or `id`, `type`, `source`, `target` and one column per edge
/// property. Property columns are in name order and the same for every row; a row without the
/// property leaves the cell empty. Separator, decimal mark, byte order mark and line ends are
/// those of the table CSV (`csv_to`). A result that was cut at a limit says so in a first line
/// that starts with `#`.
fn graph_csv_to(
    graph: &GraphSet,
    list: GraphList,
    language: ExportLanguage,
    control: &Control,
    max: usize,
    deadline: bool,
    out: &mut Emit<'_>,
) -> Result<(), Detail> {
    let separator = if language == ExportLanguage::De { ';' } else { ',' };
    let sep = separator.to_string();
    let own: &[&str] = match list {
        GraphList::Nodes => &["id", "labels"],
        GraphList::Edges => &["id", "type", "source", "target"],
    };
    let keys = match list {
        GraphList::Nodes => graph_keys(graph.nodes.iter().map(|n| &n.properties)),
        GraphList::Edges => graph_keys(graph.edges.iter().map(|e| &e.properties)),
    };
    let mut sink = Sink::new(max, control, deadline, out);
    let written = (|| -> std::io::Result<()> {
        sink.write_all("\u{FEFF}".as_bytes())?;
        if let Some(note) = truncated_note(graph) {
            sink.write_all(format!("# {note}\r\n").as_bytes())?;
        }
        let header: Vec<String> = own
            .iter()
            .map(|name| (*name).to_string())
            .chain(keys.iter().map(|(k, _)| quote(&defuse(&property_column(k, own)), separator)))
            .collect();
        sink.write_all(header.join(&sep).as_bytes())?;
        sink.write_all(b"\r\n")?;
        let row = |fixed: &[&str], properties: &BTreeMap<String, Value>| -> String {
            let mut line = String::new();
            for (i, cell) in fixed.iter().enumerate() {
                if i > 0 {
                    line.push_str(&sep);
                }
                line.push_str(&quote(&defuse(cell), separator));
            }
            for (key, _) in &keys {
                line.push_str(&sep);
                if let Some(value) = properties.get(key) {
                    line.push_str(&quote(&graph_cell(value, language), separator));
                }
            }
            line.push_str("\r\n");
            line
        };
        match list {
            GraphList::Nodes => {
                for node in &graph.nodes {
                    let labels: String = node.labels.iter().map(|l| format!(":{l}")).collect();
                    sink.write_all(row(&[node.id.as_str(), labels.as_str()], &node.properties).as_bytes())?;
                }
            }
            GraphList::Edges => {
                for edge in &graph.edges {
                    let fixed = [edge.id.as_str(), edge.edge_type.as_str(), edge.from.as_str(), edge.to.as_str()];
                    sink.write_all(row(&fixed, &edge.properties).as_bytes())?;
                }
            }
        }
        Ok(())
    })();
    sink.done(written)
}

/// GraphML (graphml.graphdrawing.org), as Gephi, yEd, Cytoscape and NetworkX read it: a directed
/// graph whose nodes carry their labels (`:Person:Actor`, as Neo4j writes them) and properties,
/// and whose edges carry their type and properties. The labels and the type are named
/// `kalzit:labels` and `kalzit:type`, so they never share a name with a property called `labels`
/// or `type`. Each property key is declared once for nodes
/// and once for edges, with the narrowest type that holds all its values (`boolean`, `long`,
/// `double`, else `string`; lists and objects are JSON text). GraphML has no paths: their nodes
/// and edges are in the file, the JSON file keeps the paths themselves. With `positions`, nodes
/// carry where they are drawn as `kalzit:x` and `kalzit:y` (double). A result that was cut at a
/// limit says so in a comment before the graph.
fn graphml_to(
    graph: &GraphSet,
    positions: Option<&Positions>,
    control: &Control,
    max: usize,
    deadline: bool,
    out: &mut Emit<'_>,
) -> Result<(), Detail> {
    let node_keys = graph_keys(graph.nodes.iter().map(|n| &n.properties));
    let edge_keys = graph_keys(graph.edges.iter().map(|e| &e.properties));
    let index = |keys: &[(String, KeyType)], name: &str| keys.binary_search_by(|(k, _)| k.as_str().cmp(name)).ok();
    let mut sink = Sink::new(max, control, deadline, out);
    let written = (|| -> std::io::Result<()> {
        sink.write_all(GRAPHML_HEAD.as_bytes())?;
        if positions.is_some_and(|p| graph.nodes.iter().any(|n| p.contains_key(&n.id))) {
            sink.write_all(GRAPHML_PLACES.as_bytes())?;
        }
        if let Some(note) = truncated_note(graph) {
            // A comment may not hold "--".
            sink.write_all(format!("  <!-- {} -->\n", xml_text(&note, false).replace("--", "- -")).as_bytes())?;
        }
        for (prefix, domain, keys) in [("n", "node", &node_keys), ("e", "edge", &edge_keys)] {
            for (i, (name, t)) in keys.iter().enumerate() {
                let line = format!(
                    "  <key id=\"{prefix}{i}\" for=\"{domain}\" attr.name=\"{}\" attr.type=\"{}\"/>\n",
                    xml_text(name, true),
                    t.name()
                );
                sink.write_all(line.as_bytes())?;
            }
        }
        sink.write_all(b"  <graph id=\"G\" edgedefault=\"directed\">\n")?;
        let mut line = String::new();
        for node in &graph.nodes {
            line.clear();
            line.push_str(&format!("    <node id=\"{}\">", xml_text(&node.id, true)));
            if !node.labels.is_empty() {
                let labels: String = node.labels.iter().map(|l| format!(":{l}")).collect();
                line.push_str(&format!("<data key=\"labels\">{}</data>", xml_text(&labels, false)));
            }
            if let Some([x, y]) = positions.and_then(|p| p.get(&node.id)).filter(|p| p.iter().all(|v| v.is_finite())) {
                line.push_str(&format!(
                    "<data key=\"x\">{}</data><data key=\"y\">{}</data>",
                    number_text(*x),
                    number_text(*y)
                ));
            }
            for (key, value) in &node.properties {
                if let (Some(i), false) = (index(&node_keys, key), value.is_null()) {
                    line.push_str(&format!("<data key=\"n{i}\">{}</data>", xml_text(&data_text(value), false)));
                }
            }
            line.push_str("</node>\n");
            sink.write_all(line.as_bytes())?;
        }
        for edge in &graph.edges {
            line.clear();
            line.push_str(&format!(
                "    <edge id=\"{}\" source=\"{}\" target=\"{}\"><data key=\"type\">{}</data>",
                xml_text(&edge.id, true),
                xml_text(&edge.from, true),
                xml_text(&edge.to, true),
                xml_text(&edge.edge_type, false)
            ));
            for (key, value) in &edge.properties {
                if let (Some(i), false) = (index(&edge_keys, key), value.is_null()) {
                    line.push_str(&format!("<data key=\"e{i}\">{}</data>", xml_text(&data_text(value), false)));
                }
            }
            line.push_str("</edge>\n");
            sink.write_all(line.as_bytes())?;
        }
        sink.write_all(b"  </graph>\n</graphml>\n")
    })();
    sink.done(written)
}

/// The result envelope of the frame, `{"shape": "frame", "frame": {...}}`, written straight from
/// the frame (no copy of it) and without the statement as sent to the database: a file goes
/// elsewhere, the query text stays in Kalzit.
fn json_to(frame: &Frame, control: &Control, max: usize, deadline: bool, out: &mut Emit<'_>) -> Result<(), Detail> {
    let mut sink = Sink::new(max, control, deadline, out);
    let written = (|| -> std::io::Result<()> {
        sink.write_all(br#"{"shape":"frame","frame":{"fields":"#)?;
        serde_json::to_writer(&mut sink, frame.fields()).map_err(std::io::Error::other)?;
        if let Some(meta) = frame.meta() {
            sink.write_all(br#","meta":"#)?;
            let meta = FrameMeta { executed_query: None, ..meta.clone() };
            serde_json::to_writer(&mut sink, &meta).map_err(std::io::Error::other)?;
        }
        sink.write_all(b"}}")
    })();
    sink.done(written)
}

/// Text cells a spreadsheet would read as a formula get a leading `'`, so a value from the data
/// can never run as one: `=`, `+`, `-`, `@` (also their full-width forms) after any leading
/// spaces, line breaks or invisible characters, and a leading tab or carriage return (DDE such as
/// `=cmd|...` starts with `=`).
pub(crate) fn defuse(text: &str) -> String {
    // Spaces, line breaks and the invisible characters a spreadsheet skips before a formula: the
    // no-break and typographic spaces (U+2000 to U+200A), the zero-width space and joiners
    // (U+200B to U+200D), the word joiner (U+2060), the byte order mark, the ideographic space.
    let lead = text.trim_start_matches(|c: char| {
        matches!(c, ' ' | '\n' | '\u{00A0}' | '\u{2000}'..='\u{200D}' | '\u{2060}' | '\u{FEFF}' | '\u{3000}')
    });
    let risky = text.starts_with(['\t', '\r'])
        || lead.starts_with(['=', '+', '-', '@', '\t', '\r', '\u{FF1D}', '\u{FF0B}', '\u{FF0D}', '\u{FF20}']);
    if risky { format!("'{text}") } else { text.to_string() }
}

/// `2026-01-01` for the ms of a day's midnight UTC.
fn iso_date(ms: i64) -> String {
    iso_time(ms)[..10].to_string()
}

/// Digits with an optional sign and decimal point, as databases write decimals.
fn is_plain_decimal(s: &str) -> bool {
    expr::parse_number(s).is_some() && s.bytes().all(|b| b.is_ascii_digit() || b == b'-' || b == b'.')
}

/// Significant digits of a plain decimal: without sign, point, leading zeros and the zeros that
/// end it ("0012.500" has 3, "1200" has 2).
fn significant_digits(s: &str) -> usize {
    let digits: String = s.bytes().filter(u8::is_ascii_digit).map(char::from).collect();
    digits.trim_start_matches('0').trim_end_matches('0').len()
}

/// Digits Excel keeps of a number; a decimal with more stays text so none is rounded.
const EXCEL_DIGITS: usize = 15;

/// A time cell's ms: fractions of a millisecond are cut (floor), never dropped.
fn time_ms(n: &serde_json::Number) -> Option<i64> {
    n.as_i64().or_else(|| n.as_f64().filter(|x| x.is_finite() && x.abs() < 9.2e18).map(|x| x.floor() as i64))
}

fn csv_cell(value: &Value, field_type: FieldType, language: ExportLanguage) -> String {
    let decimal = |s: String| if language == ExportLanguage::De { s.replace('.', ",") } else { s };
    match (field_type, value) {
        (_, Value::Null) => String::new(),
        (FieldType::Time, Value::Number(n)) => time_ms(n).map(iso_time).unwrap_or_default(),
        // A day as it is, without a time or zone.
        (FieldType::Date, Value::Number(n)) => time_ms(n).map(iso_date).unwrap_or_default(),
        (FieldType::Number, Value::Number(n)) => n.as_f64().map(|x| decimal(number_text(x))).unwrap_or_default(),
        // Every digit as the database sent it; anything else in a decimal field is text and defused.
        (FieldType::Decimal, Value::String(s)) if is_plain_decimal(s) => decimal(s.clone()),
        // Digits as they are; anything else in an int64 field is text and defused.
        (FieldType::Int64, Value::String(s)) => match int_of(value) {
            Some(_) if s.bytes().all(|b| b.is_ascii_digit() || b == b'-') => s.clone(),
            _ => defuse(s),
        },
        (FieldType::Json, v) => v.to_string(),
        (_, Value::String(s)) => defuse(s),
        (_, Value::Bool(b)) => b.to_string(),
        (_, v) => v.to_string(),
    }
}

pub(crate) fn quote(cell: &str, separator: char) -> String {
    let needs =
        cell.contains([separator, '"', '\n', '\r']) || cell.starts_with([' ', '\t']) || cell.ends_with([' ', '\t']);
    if needs { format!("\"{}\"", cell.replace('"', "\"\"")) } else { cell.to_string() }
}

/// RFC 4180 CSV with a byte order mark, so Excel opens it as UTF-8, and CRLF line ends. Times
/// are ISO 8601 in UTC; numbers keep every digit and use the language's decimal mark.
pub fn csv(frame: &Frame, language: ExportLanguage) -> Vec<u8> {
    let mut bytes = Vec::new();
    let mut out = |c: Vec<u8>| {
        bytes.extend_from_slice(&c);
        Ok(())
    };
    csv_to(frame, language, &Control::unbounded(), usize::MAX, true, &mut out).expect("no limit without a control");
    bytes
}

/// CSV within the file size limit, stopping when the control says so. Rows are written one by
/// one into the chunks, so the file is never held twice.
fn csv_to(
    frame: &Frame,
    language: ExportLanguage,
    control: &Control,
    max: usize,
    deadline: bool,
    out: &mut Emit<'_>,
) -> Result<(), Detail> {
    let separator = if language == ExportLanguage::De { ';' } else { ',' };
    let sep = separator.to_string();
    let mut sink = Sink::new(max, control, deadline, out);
    let written = (|| -> std::io::Result<()> {
        let header: Vec<String> = frame.fields().iter().map(|f| quote(&defuse(&f.name), separator)).collect();
        sink.write_all("\u{FEFF}".as_bytes())?;
        sink.write_all(header.join(&sep).as_bytes())?;
        sink.write_all(b"\r\n")?;
        let mut line = String::new();
        for row in 0..frame.rows() {
            line.clear();
            for (i, f) in frame.fields().iter().enumerate() {
                if i > 0 {
                    line.push_str(&sep);
                }
                line.push_str(&quote(&csv_cell(&f.values[row], f.field_type, language), separator));
            }
            line.push_str("\r\n");
            sink.write_all(line.as_bytes())?;
        }
        Ok(())
    })();
    sink.done(written)
}

/// A sheet name Excel accepts: at most 31 characters, none of `[]:*?/\`, not the reserved
/// "History".
fn sheet_name(name: &str) -> String {
    let clean: String = name.chars().filter(|c| !"[]:*?/\\".contains(*c) && !c.is_control()).take(31).collect();
    let clean = clean.trim_matches('\'').to_string();
    if clean.trim().is_empty() || clean.trim().eq_ignore_ascii_case("history") { "Kalzit".into() } else { clean }
}

/// Text cut at Excel's 32,767 UTF-16 units, never inside a character.
fn truncate(text: &str) -> &str {
    let mut units = 0;
    for (i, c) in text.char_indices() {
        units += c.len_utf16();
        if units > XLSX_MAX_TEXT {
            return &text[..i];
        }
    }
    text
}

/// Days since 1899-12-30, Excel's date numbers; Excel shows dates from 1900-03-01 on.
fn excel_date(ms: i64) -> Option<f64> {
    const FIRST: i64 = -2_203_891_200_000; // 1900-03-01T00:00:00Z
    (ms >= FIRST).then(|| ms as f64 / 86_400_000.0 + 25_569.0)
}

fn xlsx_error(e: rust_xlsxwriter::XlsxError) -> Detail {
    Detail::new("export.failed", format!("the file could not be written: {e}")).with("detail", &e)
}

fn io_error(e: &std::io::Error) -> Detail {
    Detail::new("export.failed", format!("the file could not be written: {e}")).with("detail", e)
}

/// One sheet: a bold, frozen header row and typed cells. Numbers, booleans and times are cells of
/// their type (times in UTC); int64 beyond 2^53 and times before 1900-03-01 are text, so no digit
/// is lost; text longer than Excel's 32,767 characters is cut there.
pub fn xlsx(frame: &Frame, name: &str) -> Result<Vec<u8>, Detail> {
    Ok(encode(frame, name, ExportFormat::Xlsx, ExportLanguage::En, &Control::unbounded())?.bytes())
}

/// Excel in constant memory mode: the writer keeps no cells, each finished row goes to a temporary
/// file in `spool`, and the workbook is saved to a second one that is then sent in chunks. Memory
/// stays flat however large the sheet is; the sheet's rows and columns and the file size limit
/// still apply (the saved file is checked before the first byte is sent).
fn xlsx_to(
    frame: &Frame,
    name: &str,
    control: &Control,
    caps: Caps,
    spool: &Path,
    deadline: bool,
    out: &mut Emit<'_>,
) -> Result<(), Detail> {
    if frame.rows() + 1 > XLSX_MAX_ROWS {
        return Err(Detail::new("export.too_many_rows", format!("Excel takes at most {} rows", XLSX_MAX_ROWS - 1))
            .with("max", XLSX_MAX_ROWS - 1));
    }
    if frame.fields().len() > XLSX_MAX_COLUMNS {
        return Err(Detail::new("export.too_many_columns", format!("Excel takes at most {XLSX_MAX_COLUMNS} columns"))
            .with("max", XLSX_MAX_COLUMNS));
    }
    std::fs::create_dir_all(spool).map_err(|e| io_error(&e))?;
    let target = tempfile::Builder::new()
        .prefix("export-")
        .suffix(".xlsx")
        .tempfile_in(spool)
        .map_err(|e| io_error(&e))?
        .into_temp_path();
    {
        let mut book = Workbook::new();
        book.set_tempdir(spool).map_err(xlsx_error)?;
        let sheet = book.add_worksheet_with_constant_memory().map_err(xlsx_error)?;
        fill_sheet(sheet, frame, name, control)?;
        control.check()?;
        book.save(&target).map_err(xlsx_error)?;
    }
    let mut file = std::fs::File::open(&target).map_err(|e| io_error(&e))?;
    let len = file.metadata().map_err(|e| io_error(&e))?.len();
    if len > caps.file_bytes as u64 {
        return Err(too_large(caps.file_bytes));
    }
    let mut sink = Sink::new(usize::MAX, control, deadline, out);
    let written = (|| -> std::io::Result<()> {
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            let n = file.read(&mut buf)?;
            if n == 0 {
                return Ok(());
            }
            sink.write_all(&buf[..n])?;
        }
    })();
    sink.done(written)
}

/// The cells, row by row (constant memory mode takes rows in order).
fn fill_sheet(
    sheet: &mut rust_xlsxwriter::Worksheet,
    frame: &Frame,
    name: &str,
    control: &Control,
) -> Result<(), Detail> {
    sheet.set_name(sheet_name(name)).map_err(xlsx_error)?;
    let bold = Format::new().set_bold();
    let date = Format::new().set_num_format("yyyy-mm-dd hh:mm:ss.000");
    let day = Format::new().set_num_format("yyyy-mm-dd");
    for (c, field) in frame.fields().iter().enumerate() {
        let col = c as u16;
        sheet.write_string_with_format(0, col, truncate(&field.name), &bold).map_err(xlsx_error)?;
        if field.field_type == FieldType::Time {
            sheet.set_column_width(col, 22).map_err(xlsx_error)?;
        }
        if field.field_type == FieldType::Date {
            sheet.set_column_width(col, 12).map_err(xlsx_error)?;
        }
    }
    sheet.set_freeze_panes(1, 0).map_err(xlsx_error)?;
    for r in 0..frame.rows() {
        control.every(r)?;
        let row = r as u32 + 1;
        for (c, field) in frame.fields().iter().enumerate() {
            let col = c as u16;
            let value = &field.values[r];
            let result = match (field.field_type, value) {
                (_, Value::Null) => continue,
                (FieldType::Time, Value::Number(n)) => match time_ms(n) {
                    Some(ms) => match excel_date(ms) {
                        Some(d) => sheet.write_number_with_format(row, col, d, &date),
                        None => sheet.write_string(row, col, iso_time(ms)),
                    },
                    None => continue,
                },
                (FieldType::Date, Value::Number(n)) => match time_ms(n) {
                    Some(ms) => match excel_date(ms) {
                        Some(d) => sheet.write_number_with_format(row, col, d, &day),
                        None => sheet.write_string(row, col, iso_date(ms)),
                    },
                    None => continue,
                },
                // Excel keeps 15 digits of a number; a decimal it cannot hold stays text.
                (FieldType::Decimal, Value::String(s)) => match expr::parse_number(s) {
                    Some(x) if is_plain_decimal(s) && significant_digits(s) <= EXCEL_DIGITS => {
                        sheet.write_number(row, col, x)
                    }
                    _ => sheet.write_string(row, col, truncate(s)),
                },
                (FieldType::Int64, Value::String(s)) => match int_of(value) {
                    Some(n) if n.unsigned_abs() <= 1 << 53 => sheet.write_number(row, col, n as f64),
                    _ => sheet.write_string(row, col, truncate(s)),
                },
                (_, Value::Number(n)) => match n.as_f64() {
                    Some(x) => sheet.write_number(row, col, x),
                    None => continue,
                },
                (_, Value::Bool(b)) => sheet.write_boolean(row, col, *b),
                (_, Value::String(s)) => sheet.write_string(row, col, truncate(s)),
                (_, other) => sheet.write_string(row, col, truncate(&other.to_string())),
            };
            result.map_err(xlsx_error)?;
        }
    }
    Ok(())
}

/// The name of a file of `kind`: `file_name` with the kind's suffix (`Customers-nodes.csv`).
pub fn file_name_of(base: &str, kind: Kind) -> String {
    let name = file_name(base, "");
    format!("{}{}.{}", name.trim_end_matches('.'), kind.suffix, kind.extension)
}

/// A file name of letters, digits, `-` and `_` only, for `Content-Disposition`.
pub fn file_name(base: &str, extension: &str) -> String {
    let mut clean = String::new();
    for c in base.chars() {
        if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
            clean.push(c);
        } else if !clean.ends_with('-') {
            clean.push('-');
        }
        if clean.len() >= 80 {
            break;
        }
    }
    let clean = clean.trim_matches('-');
    format!("{}.{extension}", if clean.is_empty() { "kalzit-export" } else { clean })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shapes::{Field, QueryResult};
    use serde_json::json;
    use std::io::Read;

    fn field(name: &str, field_type: FieldType, values: Vec<Value>) -> Field {
        Field { name: name.into(), field_type, unit: None, values, labels: None }
    }

    fn sample() -> Frame {
        Frame::new(vec![
            field(
                "zeit",
                FieldType::Time,
                vec![json!(1_767_225_600_000_i64), Value::Null, json!(-2_208_988_800_000_i64)],
            ),
            field("betrag", FieldType::Number, vec![json!(1234.5), json!(-0.25), json!(1e21)]),
            field("stück", FieldType::Int64, vec![json!("9007199254740993"), json!("7"), Value::Null]),
            field(
                "text",
                FieldType::String,
                vec![json!("a;b,\"c\""), json!("=HYPERLINK(\"x\")"), json!(" Zeile\nzwei ")],
            ),
            field("ok", FieldType::Bool, vec![json!(true), json!(false), Value::Null]),
            field("roh", FieldType::Json, vec![json!({ "a": [1, "x"] }), Value::Null, json!("-1")]),
        ])
        .unwrap()
    }

    #[test]
    fn german_csv_uses_semicolons_decimal_commas_and_a_bom() {
        let text = String::from_utf8(csv(&sample(), ExportLanguage::De)).unwrap();
        assert!(text.starts_with('\u{FEFF}'), "BOM for Excel");
        let lines: Vec<&str> = text.trim_start_matches('\u{FEFF}').split("\r\n").collect();
        assert_eq!(lines[0], "zeit;betrag;stück;text;ok;roh");
        assert_eq!(
            lines[1],
            "2026-01-01T00:00:00.000Z;1234,5;9007199254740993;\"a;b,\"\"c\"\"\";true;\"{\"\"a\"\":[1,\"\"x\"\"]}\""
        );
        assert_eq!(lines[2], ";-0,25;7;\"'=HYPERLINK(\"\"x\"\")\";false;");
        // A line break inside a quoted cell stays a bare LF; rows end with CRLF.
        assert_eq!(lines[3], "1900-01-01T00:00:00.000Z;1e+21;;\" Zeile\nzwei \";;\"\"\"-1\"\"\"");
        assert_eq!(lines[4], "", "every row ends with CRLF");
    }

    #[test]
    fn english_csv_uses_commas_and_decimal_points() {
        let text = String::from_utf8(csv(&sample(), ExportLanguage::En)).unwrap();
        let lines: Vec<&str> = text.trim_start_matches('\u{FEFF}').split("\r\n").collect();
        assert_eq!(lines[0], "zeit,betrag,stück,text,ok,roh");
        assert!(
            lines[1].starts_with("2026-01-01T00:00:00.000Z,1234.5,9007199254740993,\"a;b,\"\"c\"\"\",true,"),
            "{}",
            lines[1]
        );
        assert!(lines[2].starts_with(",-0.25,7,"), "{}", lines[2]);
    }

    #[test]
    fn header_names_are_defused_and_quoted_too() {
        let frame = Frame::new(vec![
            field("=SUM(A1)", FieldType::Number, vec![json!(1)]),
            field("a,b", FieldType::Number, vec![json!(2)]),
        ])
        .unwrap();
        let text = String::from_utf8(csv(&frame, ExportLanguage::En)).unwrap();
        assert!(text.starts_with("\u{FEFF}'=SUM(A1),\"a,b\"\r\n1,2\r\n"), "{text:?}");
        assert_eq!(String::from_utf8(csv(&Frame::new(vec![]).unwrap(), ExportLanguage::De)).unwrap(), "\u{FEFF}\r\n");
    }

    #[test]
    fn json_is_the_result_envelope() {
        let file = encode(&sample(), "A", ExportFormat::Json, ExportLanguage::De, &Control::unbounded()).unwrap();
        let back: QueryResult = serde_json::from_slice(&file.bytes()).unwrap();
        assert_eq!(back, QueryResult::Frame { frame: sample() });
        assert_eq!(file.content_type, "application/json");
    }

    /// The parts of an xlsx file: a zip archive whose sheet holds the cells.
    fn sheet_xml(bytes: &[u8]) -> (String, String) {
        let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
        let mut read = |name: &str| {
            let mut s = String::new();
            zip.by_name(name).unwrap().read_to_string(&mut s).unwrap();
            s
        };
        // Constant memory mode writes text inline, without a shared string table.
        let sheet = read("xl/worksheets/sheet1.xml");
        (sheet.clone(), sheet)
    }

    #[test]
    fn excel_files_hold_typed_cells() {
        let file =
            encode(&sample(), "Umsatz: A/B", ExportFormat::Xlsx, ExportLanguage::De, &Control::unbounded()).unwrap();
        let bytes = file.bytes();
        assert_eq!(&bytes[..2], b"PK", "a zip archive");
        let (sheet, strings) = sheet_xml(&bytes);
        // 2026-01-01 is Excel day 46023; numbers stay numbers, the big int64 stays text.
        assert!(sheet.contains("<v>46023</v>"), "{sheet}");
        assert!(sheet.contains("<v>1234.5</v>") && sheet.contains("<v>-0.25</v>"), "{sheet}");
        assert!(sheet.contains("<v>7</v>"), "{sheet}");
        assert!(sheet.contains(r#"t="b""#), "booleans are boolean cells: {sheet}");
        assert!(!sheet.contains("<f>"), "no formulas: {sheet}");
        assert!(strings.contains("9007199254740993"), "{strings}");
        assert!(strings.contains("=HYPERLINK"), "kept as text: {strings}");
        assert!(strings.contains("1900-01-01T00:00:00.000Z"), "before 1900-03-01 as text: {strings}");
        let mut zip = zip::ZipArchive::new(std::io::Cursor::new(&bytes[..])).unwrap();
        let mut book = String::new();
        zip.by_name("xl/workbook.xml").unwrap().read_to_string(&mut book).unwrap();
        assert!(book.contains(r#"name="Umsatz AB""#), "{book}");
    }

    #[test]
    fn excel_keeps_decimals_it_cannot_hold_as_text() {
        let frame = Frame::new(vec![
            field("betrag", FieldType::Decimal, vec![json!("12.50"), json!("1234567890123.4567"), json!("-0.000123")]),
            field("tag", FieldType::Date, vec![json!(1_767_225_600_000_i64), Value::Null, Value::Null]),
        ])
        .unwrap();
        let (sheet, strings) = sheet_xml(&xlsx(&frame, "x").unwrap());
        assert!(sheet.contains("<v>12.5</v>") && sheet.contains("<v>-0.000123</v>"), "{sheet}");
        // 17 significant digits: Excel would round it, so it stays text, every digit kept.
        assert!(strings.contains("1234567890123.4567"), "{strings}");
        assert!(!sheet.contains("<v>1234567890123.45"), "{sheet}");
        assert!(sheet.contains("<v>46023</v>"), "the day as an Excel date: {sheet}");
        assert_eq!(significant_digits("0012.500"), 3);
        assert_eq!(significant_digits("1200"), 2);
        assert_eq!(significant_digits("123456789012345"), 15);
    }

    #[test]
    fn excel_limits_and_long_text() {
        let long = Frame::new(vec![field("t", FieldType::String, vec![json!("ä".repeat(40_000))])]).unwrap();
        let (_, strings) = sheet_xml(&xlsx(&long, "x").unwrap());
        assert_eq!(strings.matches('ä').count(), XLSX_MAX_TEXT);
        let wide =
            Frame::new((0..=XLSX_MAX_COLUMNS).map(|i| field(&format!("f{i}"), FieldType::Number, vec![])).collect())
                .unwrap();
        assert_eq!(xlsx(&wide, "x").unwrap_err().reason, "export.too_many_columns");
    }

    #[test]
    fn names_for_files_and_sheets() {
        assert_eq!(file_name("Umsatz 2026 / Österreich", "csv"), "Umsatz-2026-sterreich.csv");
        assert_eq!(file_name("../../etc/passwd", "json"), "etc-passwd.json");
        assert_eq!(file_name("", "xlsx"), "kalzit-export.xlsx");
        assert_eq!(file_name("\"\r\n", "csv"), "kalzit-export.csv");
        assert_eq!(sheet_name("[]:*?/\\"), "Kalzit");
        assert_eq!(sheet_name(&"x".repeat(40)).len(), 31);
        assert_eq!(sheet_name("History"), "Kalzit", "Excel reserves it");
        assert_eq!(sheet_name(" history "), "Kalzit");
    }

    #[test]
    fn excel_text_is_cut_by_utf16_units_never_inside_a_character() {
        let text = format!("{}{}", "a".repeat(XLSX_MAX_TEXT - 1), "😀😀");
        let cut = truncate(&text);
        assert_eq!(cut.chars().map(char::len_utf16).sum::<usize>(), XLSX_MAX_TEXT - 1);
        assert!(cut.chars().all(|c| c == 'a'));
    }

    #[test]
    fn odd_int64_text_and_fractional_times_in_csv() {
        let frame = Frame::new(vec![
            field("i", FieldType::Int64, vec![json!("=1+1"), json!("-12"), json!(" 7")]),
            field("t", FieldType::Time, vec![json!(1_767_225_600_000.9), json!(-0.5), Value::Null]),
        ])
        .unwrap();
        let text = String::from_utf8(csv(&frame, ExportLanguage::En)).unwrap();
        let lines: Vec<&str> = text.trim_start_matches('\u{FEFF}').split("\r\n").collect();
        assert_eq!(lines[1], "'=1+1,2026-01-01T00:00:00.000Z");
        assert_eq!(lines[2], "-12,1969-12-31T23:59:59.999Z");
        assert_eq!(lines[3], "\" 7\",");
    }

    fn caps(file_bytes: usize) -> Caps {
        Caps { file_bytes }
    }

    fn reason_of(format: ExportFormat, frame: &Frame, c: Caps) -> &'static str {
        encode_within(frame, "A", format, ExportLanguage::En, &Control::unbounded(), c)
            .map_or_else(|d| d.reason, |_| "ok")
    }

    /// The finished workbook is held to the file limit before it is sent; there is no cell limit.
    #[test]
    fn excel_files_are_held_to_the_file_limit() {
        let frame = sample();
        assert_eq!(reason_of(ExportFormat::Xlsx, &frame, caps(MAX_FILE_BYTES)), "ok");
        assert_eq!(reason_of(ExportFormat::Xlsx, &frame, caps(100)), "export.too_large");
    }

    /// CSV and JSON stop at the first write past the limit; what they wrote is what they send.
    #[test]
    fn csv_and_json_stop_at_the_file_limit() {
        let frame = sample();
        let full = csv(&frame, ExportLanguage::En).len();
        let header = "\u{FEFF}zeit,betrag,stück,text,ok,roh\r\n".len();
        assert_eq!(reason_of(ExportFormat::Csv, &frame, caps(full)), "ok");
        assert_eq!(reason_of(ExportFormat::Csv, &frame, caps(full - 1)), "export.too_large", "the last row");
        assert_eq!(reason_of(ExportFormat::Csv, &frame, caps(header + 1)), "export.too_large", "the first row");
        assert_eq!(reason_of(ExportFormat::Csv, &frame, caps(3)), "export.too_large", "the header");
        let json = encode(&frame, "A", ExportFormat::Json, ExportLanguage::En, &Control::unbounded()).unwrap().bytes();
        assert_eq!(reason_of(ExportFormat::Json, &frame, caps(json.len())), "ok");
        assert_eq!(reason_of(ExportFormat::Json, &frame, caps(json.len() - 1)), "export.too_large");
        let big = Frame::new(vec![field("t", FieldType::String, vec![json!("x".repeat(1024)); 3 * 1024])]).unwrap();
        let file = encode(&big, "A", ExportFormat::Csv, ExportLanguage::En, &Control::unbounded()).unwrap();
        assert!(file.chunks.len() >= 3, "written in chunks, not one buffer");
        // Rows of 1025 bytes cross the boundary in every chunk; none grows past 1 MiB.
        for c in &file.chunks {
            assert!(c.capacity() <= CHUNK && c.len() <= CHUNK, "{} / {}", c.len(), c.capacity());
        }
        assert!(file.chunks[..file.chunks.len() - 1].iter().all(|c| c.len() == CHUNK));
        assert_eq!(file.bytes(), csv(&big, ExportLanguage::En), "nothing lost at the boundaries");
    }

    /// The statement as sent to the database stays in Kalzit.
    #[test]
    fn json_files_leave_out_the_executed_statement() {
        let frame = sample().with_meta(FrameMeta {
            executed_query: Some("SELECT secret FROM t".into()),
            rows_truncated: true,
            notices: vec![],
        });
        let bytes = encode(&frame, "A", ExportFormat::Json, ExportLanguage::En, &Control::unbounded()).unwrap().bytes();
        let text = String::from_utf8(bytes).unwrap();
        assert!(!text.contains("SELECT secret"), "{text}");
        let back: QueryResult = serde_json::from_str(&text).unwrap();
        let QueryResult::Frame { frame: back } = back else { panic!() };
        assert_eq!((back.meta().unwrap().rows_truncated, back.rows()), (true, 3));
    }

    /// Documents keep each one's own key order, one per line, also when a plugin sent line breaks
    /// between the tokens; their JSON file is the result envelope without what stays in Kalzit.
    #[test]
    fn documents_keep_their_key_order_one_per_line() {
        let set = DocumentSet {
            documents: vec![
                OrderedJson::from_text("{\"z\":1,\n  \"a\": \"x\\ny\"}".into()).unwrap(),
                OrderedJson::from_text("{\"b\":[1,2]}".into()).unwrap(),
            ],
            schema: vec![],
            next_cursor: Some("next-page".into()),
            truncated: None,
            notices: vec![],
            executed_query: Some("db.secret.find()".into()),
            distributable: false,
        };
        let file = |format| encode_content(Content::Documents(&set), format, &Control::unbounded(), Caps::default());
        let ndjson = String::from_utf8(file(ExportFormat::Ndjson).unwrap().bytes()).unwrap();
        assert_eq!(ndjson, "{\"z\":1,   \"a\": \"x\\ny\"}\n{\"b\":[1,2]}\n");
        for line in ndjson.lines() {
            serde_json::from_str::<Value>(line).unwrap();
        }
        let json = String::from_utf8(file(ExportFormat::Json).unwrap().bytes()).unwrap();
        assert!(json.starts_with(r#"{"shape":"documents","documents":{"documents":[{"z":1,"#), "{json}");
        assert!(!json.contains("secret") && !json.contains("next-page"), "{json}");
        let err = file(ExportFormat::Csv).unwrap_err();
        assert_eq!(err.reason, "export.format_unsupported");
        assert_eq!(err.params.get("shape").map(String::as_str), Some("documents"));
        assert!(fits(Shape::Graph, ExportFormat::Graphml) && !fits(Shape::Frame, ExportFormat::Graphml));
    }

    /// A trace is written as OTLP JSON; a table of it is a step, never a format.
    #[test]
    fn traces_export_as_otlp_json() {
        let mut trace = crate::analysis::trace::fixture();
        trace.executed_query = Some("{ secret = \"x\" }".into());
        let file = |format| encode_content(Content::Trace(&trace), format, &Control::unbounded(), Caps::default());
        let json: Value = serde_json::from_slice(&file(ExportFormat::Json).unwrap().bytes()).unwrap();
        let spans: usize = json["resourceSpans"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|r| r["scopeSpans"].as_array().unwrap())
            .map(|s| s["spans"].as_array().unwrap().len())
            .sum();
        assert_eq!(spans, trace.spans.len());
        assert!(!json.to_string().contains("secret"), "the query stays in Kalzit");
        for format in [ExportFormat::Csv, ExportFormat::Xlsx, ExportFormat::Graphml, ExportFormat::Ndjson] {
            let err = file(format).unwrap_err();
            assert_eq!(err.reason, "export.format_unsupported");
            assert_eq!(err.params.get("shape").map(String::as_str), Some("trace"));
        }
        assert_eq!(Content::Trace(&trace).counts(), [("spans", trace.spans.len())]);
        assert!(Content::Trace(&trace).estimate() > 0);
    }

    fn props(pairs: Vec<(&str, Value)>) -> BTreeMap<String, Value> {
        pairs.into_iter().map(|(k, v)| (k.to_string(), v)).collect()
    }

    /// Two nodes and two edges with every kind of value a property can hold.
    fn typed_graph() -> GraphSet {
        use crate::shapes::{Edge, GraphPath, Node};
        GraphSet {
            nodes: vec![
                Node {
                    id: "1".into(),
                    labels: vec!["Person".into(), "Kunde".into()],
                    properties: props(vec![
                        ("name", json!("Jörg, \"der\" Erste")),
                        ("alter", json!(41)),
                        ("aktiv", json!(true)),
                        ("saldo", json!(-12.5)),
                        ("id", json!("intern")),
                    ]),
                },
                Node {
                    id: "2".into(),
                    labels: vec![],
                    properties: props(vec![
                        ("name", json!("=SUM(A1)")),
                        ("tags", json!(["a", 1])),
                        ("adresse", json!({ "ort": "Köln" })),
                        ("saldo", json!(3)),
                        ("notiz", json!("Zeile 1\nZeile 2")),
                        ("leer", Value::Null),
                    ]),
                },
            ],
            edges: vec![
                Edge {
                    id: "e1".into(),
                    edge_type: "KENNT".into(),
                    from: "1".into(),
                    to: "2".into(),
                    properties: props(vec![("seit", json!(2020)), ("type", json!("privat")), ("gewicht", json!(0.5))]),
                },
                Edge {
                    id: "-7".into(),
                    edge_type: String::new(),
                    from: "2".into(),
                    to: "1".into(),
                    properties: props(vec![]),
                },
            ],
            paths: Some(vec![GraphPath { nodes: vec!["1".into(), "2".into()], edges: vec!["e1".into()] }]),
            ..GraphSet::default()
        }
    }

    fn graph_file(
        graph: &GraphSet,
        positions: Option<&Positions>,
        format: ExportFormat,
        language: ExportLanguage,
    ) -> String {
        let mut bytes = Vec::new();
        let mut out = |c: Vec<u8>| {
            bytes.extend_from_slice(&c);
            Ok(())
        };
        encode_graph_to(graph, positions, format, language, &Control::unbounded(), Caps::default(), true, &mut out)
            .unwrap();
        String::from_utf8(bytes).unwrap()
    }

    #[test]
    fn graph_nodes_as_csv_have_one_column_per_property_in_name_order() {
        let graph = typed_graph();
        let text = graph_file(&graph, None, ExportFormat::CsvNodes, ExportLanguage::En);
        assert!(text.starts_with('\u{FEFF}'), "BOM");
        let lines: Vec<&str> = text.trim_start_matches('\u{FEFF}').split("\r\n").collect();
        // A property named like one of the file's own columns is told apart from it.
        assert_eq!(lines[0], "id,labels,adresse,aktiv,alter,property:id,leer,name,notiz,saldo,tags");
        // Text with the separator or quotes is quoted; a missing property leaves its cell empty.
        assert_eq!(lines[1], "1,:Person:Kunde,,true,41,intern,,\"Jörg, \"\"der\"\" Erste\",,-12.5,");
        // Objects and lists are JSON text, a formula stays text, a line break stays in its cell.
        let second = concat!(
            "2,,\"{\"\"ort\"\":\"\"Köln\"\"}\",,,,,'=SUM(A1),",
            "\"Zeile 1\nZeile 2\",3,\"[\"\"a\"\",1]\""
        );
        assert_eq!(lines[2], second);
        assert_eq!((lines[3], lines.len()), ("", 4));

        // German: semicolons and decimal commas, as in the table CSV.
        let text = graph_file(&graph, None, ExportFormat::CsvNodes, ExportLanguage::De);
        let lines: Vec<&str> = text.trim_start_matches('\u{FEFF}').split("\r\n").collect();
        assert_eq!(lines[0], "id;labels;adresse;aktiv;alter;property:id;leer;name;notiz;saldo;tags");
        assert_eq!(lines[1], "1;:Person:Kunde;;true;41;intern;;\"Jörg, \"\"der\"\" Erste\";;-12,5;");
    }

    #[test]
    fn graph_edges_as_csv_name_their_ends_and_type() {
        let graph = typed_graph();
        let text = graph_file(&graph, None, ExportFormat::CsvEdges, ExportLanguage::En);
        let lines: Vec<&str> = text.trim_start_matches('\u{FEFF}').split("\r\n").collect();
        assert_eq!(lines[0], "id,type,source,target,gewicht,seit,property:type");
        assert_eq!(lines[1], "e1,KENNT,1,2,0.5,2020,privat");
        // An id a spreadsheet would read as a formula is defused, like any text.
        assert_eq!(lines[2], "'-7,,2,1,,,");
        assert_eq!((lines[3], lines.len()), ("", 4));

        // A graph without nodes or edges still has its header.
        let empty = GraphSet::default();
        assert_eq!(graph_file(&empty, None, ExportFormat::CsvNodes, ExportLanguage::En), "\u{FEFF}id,labels\r\n");
        assert_eq!(
            graph_file(&empty, None, ExportFormat::CsvEdges, ExportLanguage::De),
            "\u{FEFF}id;type;source;target\r\n"
        );
    }

    #[test]
    fn graph_csv_fits_graphs_only_and_keeps_to_the_limits() {
        for format in [ExportFormat::CsvNodes, ExportFormat::CsvEdges] {
            assert!(fits(Shape::Graph, format));
            assert!(!fits(Shape::Frame, format) && !fits(Shape::Documents, format) && !fits(Shape::Trace, format));
        }
        let control = Control::unbounded();
        let err = encode(&sample(), "A", ExportFormat::CsvNodes, ExportLanguage::En, &control).unwrap_err();
        assert_eq!(err.reason, "export.format_unsupported");
        assert_eq!(err.params.get("format").map(String::as_str), Some("csvNodes"));

        let graph = typed_graph();
        let content = Content::Graph(&graph);
        let small = encode_content(content, ExportFormat::CsvNodes, &Control::unbounded(), Caps { file_bytes: 40 });
        assert_eq!(small.unwrap_err().reason, "export.too_large");
        let flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));
        let stopped = encode_content(content, ExportFormat::CsvEdges, &Control::new(flag, 30), Caps::default());
        assert_eq!(stopped.unwrap_err().reason, "steps.cancelled");
    }

    #[test]
    fn a_cut_graph_says_so_in_its_files() {
        let mut graph = typed_graph();
        graph.truncated = Some(Truncated { limit: 2, reason: Some("graph.node_limit".into()) });
        let note = concat!(
            "Truncated: the result was cut at its limit of 2 (graph.node_limit). ",
            "In this file: nodes 2, edges 2."
        );
        let text = graph_file(&graph, None, ExportFormat::CsvNodes, ExportLanguage::En);
        assert!(text.starts_with(&format!("\u{{FEFF}}# {note}\r\nid,labels,")), "{text}");
        let text = graph_file(&graph, None, ExportFormat::CsvEdges, ExportLanguage::En);
        assert!(text.starts_with(&format!("\u{{FEFF}}# {note}\r\nid,type,")), "{text}");
        let xml = graph_file(&graph, None, ExportFormat::Graphml, ExportLanguage::En);
        assert!(xml.contains(&format!("  <!-- {note} -->\n")), "{xml}");
        // A whole result has no such line.
        let whole = graph_file(&typed_graph(), None, ExportFormat::Graphml, ExportLanguage::En);
        assert!(!whole.contains("<!--"), "{whole}");
    }

    fn places(pairs: &[(&str, [f64; 2])]) -> Positions {
        pairs.iter().map(|(id, at)| (id.to_string(), *at)).collect()
    }

    #[test]
    fn graphml_holds_the_drawn_positions() {
        let graph = typed_graph();
        let positions = places(&[("1", [10.5, -20.0]), ("9", [1.0, 1.0])]);
        let xml = graph_file(&graph, Some(&positions), ExportFormat::Graphml, ExportLanguage::En);
        assert!(xml.contains(r#"<key id="x" for="node" attr.name="kalzit:x" attr.type="double"/>"#), "{xml}");
        assert!(xml.contains(r#"<key id="y" for="node" attr.name="kalzit:y" attr.type="double"/>"#), "{xml}");
        let node = concat!(
            r#"<node id="1"><data key="labels">:Person:Kunde</data>"#,
            r#"<data key="x">10.5</data><data key="y">-20</data>"#
        );
        assert!(xml.contains(node), "{xml}");
        // A node without a position has none, and without positions the keys are not declared.
        assert!(xml.contains(r#"<node id="2"><data key="n0">"#), "{xml}");
        let plain = graph_file(&graph, None, ExportFormat::Graphml, ExportLanguage::En);
        assert!(!plain.contains("kalzit:x") && !plain.contains(r#"key="x""#), "{plain}");
        let elsewhere = places(&[("9", [1.0, 1.0])]);
        let none = graph_file(&graph, Some(&elsewhere), ExportFormat::Graphml, ExportLanguage::En);
        assert!(!none.contains("kalzit:x"), "{none}");
    }

    #[test]
    fn a_part_of_a_graph_keeps_the_edges_between_its_nodes() {
        let graph = typed_graph();
        let both = graph_part(&graph, &["2".to_string(), "1".to_string(), "9".to_string()]);
        // In the result's order, whatever the order of the ids; an unknown id names nothing.
        assert_eq!(both.nodes.iter().map(|n| n.id.as_str()).collect::<Vec<_>>(), ["1", "2"]);
        assert_eq!(both.edges.len(), 2);
        assert_eq!(both.paths.as_ref().map(Vec::len), Some(1));
        let one = graph_part(&graph, &["2".to_string()]);
        assert_eq!(one.nodes.iter().map(|n| n.id.as_str()).collect::<Vec<_>>(), ["2"]);
        // An edge with an end outside the part is left out, and so is a path that crossed it.
        assert!(one.edges.is_empty());
        assert_eq!(one.paths, Some(vec![]));
        assert!(graph_part(&graph, &[]).nodes.is_empty());
    }

    #[test]
    fn graph_csv_files_are_named_after_their_list() {
        assert_eq!(file_name_of("Kunden & Partner", kind(ExportFormat::CsvNodes)), "Kunden-Partner-nodes.csv");
        assert_eq!(file_name_of("", kind(ExportFormat::CsvEdges)), "kalzit-export-edges.csv");
        assert_eq!(file_name_of("Netz", kind(ExportFormat::Graphml)), "Netz.graphml");
        assert_eq!(file_name_of("Umsätze 2026", kind(ExportFormat::Csv)), file_name("Umsätze 2026", "csv"));
    }

    #[test]
    fn xml_text_keeps_what_xml_can_hold() {
        assert_eq!(xml_text("a<b>&\"c\"", false), "a&lt;b&gt;&amp;&quot;c&quot;");
        assert_eq!(xml_text("x\ny\tz\r", true), "x&#10;y&#9;z&#13;");
        assert_eq!(xml_text("x\ny\u{0}\u{FFFF}", false), "x\ny\u{FFFD}\u{FFFD}");
    }

    #[test]
    fn invisible_characters_before_a_formula_are_defused() {
        for risky in [
            "\u{200B}=1",
            "\u{FEFF}+1",
            "\u{00A0}@x",
            " \n-1",
            "\u{3000}=1",
            "\u{200C}=1",
            "\u{200D}+1",
            "\u{2060}-1",
            "\u{2000}=1",
            "\u{2007}\u{200A}@x",
        ] {
            assert!(defuse(risky).starts_with('\''), "{risky:?}");
        }
        assert_eq!(defuse("a=1"), "a=1");
    }

    #[test]
    fn a_control_stops_the_encoder() {
        let flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));
        let err = encode(&sample(), "A", ExportFormat::Csv, ExportLanguage::En, &Control::new(flag, 30)).unwrap_err();
        assert_eq!(err.reason, "steps.cancelled");
    }

    /// Chunks reach `out` while the file is still being written, and an error from `out` ends the
    /// writing with that error: this is what stops an export whose client went away.
    #[test]
    fn chunks_are_handed_over_as_they_are_made_and_a_failing_out_stops_the_writing() {
        let big = Frame::new(vec![field("t", FieldType::String, vec![json!("x".repeat(1024)); 4 * 1024])]).unwrap();
        let spool = tempfile::tempdir().unwrap();
        // The Excel file is compressed, so it is small: it stops at its first chunk.
        for (format, stop) in [(ExportFormat::Csv, 2), (ExportFormat::Json, 2), (ExportFormat::Xlsx, 1)] {
            let mut calls = 0;
            let mut out = |c: Vec<u8>| {
                calls += 1;
                assert!(c.len() <= CHUNK);
                if calls == stop { Err(Detail::new("test.stop", "stop")) } else { Ok(()) }
            };
            let control = Control::unbounded();
            let err = encode_to(
                &big,
                "A",
                format,
                ExportLanguage::En,
                &control,
                Caps::default(),
                spool.path(),
                false,
                &mut out,
            )
            .unwrap_err();
            assert_eq!(err.reason, "test.stop", "{format:?}");
            assert_eq!(calls, stop, "{format:?}: nothing is written after the failure");
        }
    }

    /// The deadline does not apply to a file being sent, the cancel flag does.
    #[test]
    fn a_sent_file_ignores_the_deadline_but_not_the_cancel_flag() {
        let flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let late = Control::new(flag.clone(), 0);
        let spool = tempfile::tempdir().unwrap();
        let mut out = |_c: Vec<u8>| Ok(());
        let run = |deadline: bool, out: &mut Emit<'_>| {
            encode_to(
                &sample(),
                "A",
                ExportFormat::Csv,
                ExportLanguage::En,
                &late,
                Caps::default(),
                spool.path(),
                deadline,
                out,
            )
        };
        assert!(run(false, &mut out).is_ok());
        assert_eq!(run(true, &mut out).unwrap_err().reason, "steps.timeout");
        flag.store(true, std::sync::atomic::Ordering::Relaxed);
        assert_eq!(run(false, &mut out).unwrap_err().reason, "steps.cancelled");
    }
}
