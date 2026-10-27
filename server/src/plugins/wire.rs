//! The server's types in the data source protocol (`kalzit_plugin_api::datasource::v1`) and back.
//! A result travels as parts (`QueryChunk`): `chunks` cuts one, `Assembler` puts one together.
//! Values without a fixed type (frame values, documents, graph properties) travel as JSON text,
//! documents in their stored key order.
//!
//! The assembler is where the host enforces the query's limits on a plugin's answer, whatever
//! the plugin does: rows, documents and graph elements beyond the limits and parts beyond the
//! response budget are cut with the same notices built-in sources give; a stream with more
//! parts than `Limits::max_parts` ends with an error. It refuses parts out of order or of
//! another shape and frame values that do not fit their field's type, and stays safe with
//! additions of newer protocol minors (docs/ARCHITECTURE.md, "Plugins").

use std::collections::{BTreeMap, BTreeSet};
use std::ops::Range;

use kalzit_plugin_api::datasource::v1 as pb;
use prost::Message;
use serde_json::Value;

use crate::datasources::frame::ResponseBudget;
use crate::datasources::{Capability, Detail, FieldError, Health, MAX_TIME_MS, MIN_TIME_MS, SourceError};
use crate::shapes::{
    DocumentSet, Edge, Field, FieldSchema, FieldType, Frame, FrameMeta, GraphPath, GraphSchema, GraphSet, Node, Notice,
    NoticeSeverity, OrderedJson, QueryResult, Shape, Truncated, TypeShare,
};

/// Parts one result may have at most, so a stream that never ends is stopped.
pub const MAX_PARTS: usize = 100_000;

/// A part that breaks the protocol: out of order, of another shape, not valid JSON, a value
/// that does not fit its type, or too many parts.
#[derive(Debug, PartialEq, Eq, thiserror::Error)]
#[error("the plugin broke the protocol: {0}")]
pub struct WireError(pub String);

fn broken(message: impl Into<String>) -> WireError {
    WireError(message.into())
}

pub fn shape(s: Shape) -> pb::Shape {
    match s {
        Shape::Frame => pb::Shape::Frame,
        Shape::Documents => pb::Shape::Documents,
        Shape::Graph => pb::Shape::Graph,
    }
}

pub fn shape_from(s: pb::Shape) -> Option<Shape> {
    match s {
        pb::Shape::Frame => Some(Shape::Frame),
        pb::Shape::Documents => Some(Shape::Documents),
        pb::Shape::Graph => Some(Shape::Graph),
        pb::Shape::Unspecified => None,
    }
}

/// The protocol's name for a capability; `None` for those protocol version 1 leaves to the
/// built-in kinds.
pub fn capability(c: Capability) -> Option<pb::Capability> {
    match c {
        Capability::CheckOnSave => Some(pb::Capability::CheckOnSave),
        Capability::Watch => Some(pb::Capability::Watch),
        Capability::Distribution | Capability::Pushdown => None,
    }
}

/// The capabilities a plugin declared that this host knows; unknown ones are ignored.
pub fn capabilities_from(values: &[i32]) -> Vec<Capability> {
    values
        .iter()
        .filter_map(|v| match pb::Capability::try_from(*v) {
            Ok(pb::Capability::CheckOnSave) => Some(Capability::CheckOnSave),
            Ok(pb::Capability::Watch) => Some(Capability::Watch),
            _ => None,
        })
        .collect()
}

/// An error's kind; an unknown or missing kind counts as a failure of the source.
pub fn error_kind(e: &pb::Error) -> pb::ErrorKind {
    match pb::ErrorKind::try_from(e.kind) {
        Ok(pb::ErrorKind::Unspecified) | Err(_) => pb::ErrorKind::Failed,
        Ok(kind) => kind,
    }
}

pub fn detail(d: &Detail) -> pb::Detail {
    pb::Detail { reason: d.reason.to_string(), params: d.params.clone(), message: d.message.clone() }
}

pub fn error(e: &SourceError) -> pb::Error {
    let kind = match e {
        SourceError::Rejected(_) => pb::ErrorKind::Rejected,
        SourceError::Blocked(_) => pb::ErrorKind::Blocked,
        SourceError::Timeout(_) => pb::ErrorKind::Timeout,
        SourceError::Failed(_) => pb::ErrorKind::Failed,
    };
    pb::Error { kind: kind as i32, detail: Some(detail(&e.detail())) }
}

pub fn field_error(e: &FieldError) -> pb::FieldError {
    pb::FieldError { field: e.field.to_string(), detail: Some(detail(&e.detail)) }
}

/// "Test connection": what connected, or the error with its kind.
pub fn health(h: &Health) -> pb::HealthResponse {
    let kind = match h.code {
        Some("query_rejected") => pb::ErrorKind::Rejected,
        Some("datasource_target_blocked") => pb::ErrorKind::Blocked,
        Some("query_timeout") => pb::ErrorKind::Timeout,
        _ => pb::ErrorKind::Failed,
    };
    pb::HealthResponse {
        ok: h.ok,
        detail: h.ok.then(|| detail(&h.detail)),
        error: (!h.ok).then(|| pb::Error { kind: kind as i32, detail: Some(detail(&h.detail)) }),
        warnings: h.warnings.iter().map(detail).collect(),
    }
}

fn field_type(t: FieldType) -> pb::FieldType {
    match t {
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

fn field_type_from(t: i32) -> Option<FieldType> {
    Some(match pb::FieldType::try_from(t).ok()? {
        pb::FieldType::Time => FieldType::Time,
        pb::FieldType::Number => FieldType::Number,
        pb::FieldType::Int64 => FieldType::Int64,
        pb::FieldType::String => FieldType::String,
        pb::FieldType::Bool => FieldType::Bool,
        pb::FieldType::Json => FieldType::Json,
        pb::FieldType::Decimal => FieldType::Decimal,
        pb::FieldType::Date => FieldType::Date,
        pb::FieldType::Unspecified => return None,
    })
}

/// Whether `v` is a value of a field of type `t` as the result envelope defines them.
fn value_fits(t: FieldType, v: &Value) -> bool {
    let integer_text = |s: &str| {
        let digits = s.strip_prefix('-').unwrap_or(s);
        !digits.is_empty() && digits.len() <= 20 && digits.bytes().all(|b| b.is_ascii_digit())
    };
    let decimal_text = |s: &str| match s.split_once('.') {
        Some((whole, fraction)) => {
            integer_text(whole) && !fraction.is_empty() && fraction.bytes().all(|b| b.is_ascii_digit())
        }
        None => integer_text(s),
    };
    match (t, v) {
        (_, Value::Null) | (FieldType::Json, _) => true,
        (FieldType::Time | FieldType::Date, Value::Number(n)) => {
            n.as_f64().is_some_and(|ms| ms.is_finite() && (MIN_TIME_MS as f64..=MAX_TIME_MS as f64).contains(&ms))
        }
        (FieldType::Number, Value::Number(_)) | (FieldType::String, Value::String(_)) => true,
        (FieldType::Bool, Value::Bool(_)) => true,
        (FieldType::Int64, Value::String(s)) => integer_text(s) && s.parse::<i64>().is_ok(),
        (FieldType::Decimal, Value::String(s)) => s.len() <= 1000 && decimal_text(s),
        _ => false,
    }
}

fn type_name(t: FieldType) -> &'static str {
    match t {
        FieldType::Time => "time",
        FieldType::Number => "number",
        FieldType::Int64 => "int64",
        FieldType::String => "string",
        FieldType::Bool => "bool",
        FieldType::Json => "json",
        FieldType::Decimal => "decimal",
        FieldType::Date => "date",
    }
}

fn string_map(map: &Option<BTreeMap<String, String>>) -> Option<pb::StringMap> {
    map.as_ref().map(|entries| pb::StringMap { entries: entries.clone() })
}

fn notice(n: &Notice) -> pb::Notice {
    let severity = match n.severity {
        NoticeSeverity::Info => pb::NoticeSeverity::Info,
        NoticeSeverity::Warning => pb::NoticeSeverity::Warning,
    };
    pb::Notice { severity: severity as i32, code: n.code.clone(), params: string_map(&n.params), text: n.text.clone() }
}

/// A notice from a plugin; a severity this host does not know counts as info.
fn notice_from(n: pb::Notice) -> Notice {
    let severity = match pb::NoticeSeverity::try_from(n.severity) {
        Ok(pb::NoticeSeverity::Warning) => NoticeSeverity::Warning,
        _ => NoticeSeverity::Info,
    };
    Notice { severity, code: n.code, params: n.params.map(|p| p.entries), text: n.text }
}

fn notices_from(notices: Vec<pb::Notice>) -> Vec<Notice> {
    notices.into_iter().map(notice_from).collect()
}

fn truncated(t: &Truncated) -> pb::Truncated {
    pb::Truncated { limit: u64::from(t.limit), reason: t.reason.clone() }
}

fn truncated_from(t: pb::Truncated) -> Truncated {
    Truncated { limit: u32::try_from(t.limit).unwrap_or(u32::MAX), reason: t.reason }
}

fn json<T: serde::Serialize + ?Sized>(value: &T) -> String {
    serde_json::to_string(value).expect("values of a result always serialize")
}

fn parse<T: serde::de::DeserializeOwned>(what: &str, text: &str) -> Result<T, WireError> {
    serde_json::from_str(text).map_err(|e| broken(format!("{what} is not valid JSON: {e}")))
}

fn part(part: pb::query_chunk::Part) -> pb::QueryChunk {
    pb::QueryChunk { part: Some(part) }
}

/// Consecutive ranges of items with these sizes, each with at most `max_items` items and, past
/// its first item, at most `TARGET_PART_BYTES` bytes.
fn batches(sizes: impl Iterator<Item = usize>, max_items: usize) -> Vec<Range<usize>> {
    let (mut out, mut start, mut bytes, mut end) = (Vec::new(), 0, 0, 0);
    for (i, size) in sizes.enumerate() {
        if i > start && (i - start >= max_items || bytes + size > kalzit_plugin_api::TARGET_PART_BYTES) {
            out.push(start..i);
            start = i;
            bytes = 0;
        }
        bytes += size;
        end = i + 1;
    }
    if end > start {
        out.push(start..end);
    }
    out
}

/// The parts of a result: the start, batches of at most `max_items` rows, documents or graph
/// elements and about `TARGET_PART_BYTES` each, and the end.
pub fn chunks(result: &QueryResult, max_items: usize) -> Vec<pb::QueryChunk> {
    use pb::query_chunk::Part;
    let max_items = max_items.max(1);
    let mut out = Vec::new();
    match result {
        QueryResult::Frame { frame } => {
            let frame_fields = frame
                .fields()
                .iter()
                .map(|f| pb::FrameField {
                    name: f.name.clone(),
                    r#type: field_type(f.field_type) as i32,
                    unit: f.unit.clone(),
                    labels: string_map(&f.labels),
                })
                .collect();
            out.push(part(Part::Start(pb::ResultStart { shape: pb::Shape::Frame as i32, frame_fields })));
            let row_bytes =
                (0..frame.rows()).map(|r| frame.fields().iter().map(|f| json(&f.values[r]).len() + 1).sum());
            for rows in batches(row_bytes, max_items) {
                let columns_json = frame.fields().iter().map(|f| json(&f.values[rows.clone()])).collect();
                out.push(part(Part::FrameRows(pb::FrameRows { columns_json })));
            }
            let meta = frame.meta().map(|m| pb::FrameMeta {
                executed_query: m.executed_query.clone(),
                rows_truncated: m.rows_truncated,
                notices: m.notices.iter().map(notice).collect(),
            });
            out.push(part(Part::End(pb::ResultEnd { meta: Some(pb::result_end::Meta::Frame(pb::FrameEnd { meta })) })));
        }
        QueryResult::Documents { documents: set } => {
            out.push(part(Part::Start(pb::ResultStart { shape: pb::Shape::Documents as i32, frame_fields: vec![] })));
            for docs in batches(set.documents.iter().map(|d| d.get().len()), max_items) {
                let documents_json = set.documents[docs].iter().map(|d| d.get().to_string()).collect();
                out.push(part(Part::Documents(pb::DocumentBatch { documents_json })));
            }
            let end = pb::DocumentsEnd {
                schema: set
                    .schema
                    .iter()
                    .map(|f| pb::FieldSchema {
                        path: f.path.clone(),
                        coverage: f.coverage,
                        types: f.types.iter().map(|t| pb::TypeShare { name: t.name.clone(), share: t.share }).collect(),
                    })
                    .collect(),
                next_cursor: set.next_cursor.clone(),
                truncated: set.truncated.as_ref().map(truncated),
                notices: set.notices.iter().map(notice).collect(),
                executed_query: set.executed_query.clone(),
                distributable: set.distributable,
            };
            out.push(part(Part::End(pb::ResultEnd { meta: Some(pb::result_end::Meta::Documents(end)) })));
        }
        QueryResult::Graph { graph } => {
            out.push(part(Part::Start(pb::ResultStart { shape: pb::Shape::Graph as i32, frame_fields: vec![] })));
            let nodes: Vec<pb::Node> = graph
                .nodes
                .iter()
                .map(|n| pb::Node { id: n.id.clone(), labels: n.labels.clone(), properties_json: json(&n.properties) })
                .collect();
            for range in batches(nodes.iter().map(|n| n.encoded_len()), max_items) {
                out.push(part(Part::Graph(pb::GraphBatch { nodes: nodes[range].to_vec(), ..Default::default() })));
            }
            let edges: Vec<pb::Edge> = graph
                .edges
                .iter()
                .map(|e| pb::Edge {
                    id: e.id.clone(),
                    r#type: e.edge_type.clone(),
                    from: e.from.clone(),
                    to: e.to.clone(),
                    properties_json: json(&e.properties),
                })
                .collect();
            for range in batches(edges.iter().map(|e| e.encoded_len()), max_items) {
                out.push(part(Part::Graph(pb::GraphBatch { edges: edges[range].to_vec(), ..Default::default() })));
            }
            let paths: Vec<pb::GraphPath> = graph
                .paths
                .iter()
                .flatten()
                .map(|p| pb::GraphPath { nodes: p.nodes.clone(), edges: p.edges.clone() })
                .collect();
            for range in batches(paths.iter().map(|p| p.encoded_len()), max_items) {
                out.push(part(Part::Graph(pb::GraphBatch { paths: paths[range].to_vec(), ..Default::default() })));
            }
            let end = pb::GraphEnd {
                schema: Some(pb::GraphSchema {
                    labels: graph.schema.labels.clone(),
                    edge_types: graph.schema.edge_types.clone(),
                    property_keys: graph
                        .schema
                        .property_keys
                        .iter()
                        .map(|(k, v)| (k.clone(), pb::StringList { values: v.clone() }))
                        .collect(),
                }),
                truncated: graph.truncated.as_ref().map(truncated),
                notices: graph.notices.as_ref().map(|n| pb::Notices { items: n.iter().map(notice).collect() }),
                has_paths: graph.paths.is_some(),
            };
            out.push(part(Part::End(pb::ResultEnd { meta: Some(pb::result_end::Meta::Graph(end)) })));
        }
    }
    out
}

/// What the host allows one result to hold.
#[derive(Clone, Debug)]
pub struct Limits {
    /// Frame rows.
    pub max_rows: usize,
    /// Documents, and graph nodes, edges and paths each.
    pub max_elements: usize,
    /// Parts of the stream, start and end included.
    pub max_parts: usize,
    /// The response bytes of the request; every batch draws its encoded size.
    pub budget: ResponseBudget,
}

impl Limits {
    /// The limits of a query (`datasources::Limits`): its row limit for rows and elements.
    pub fn for_query(limits: &crate::datasources::Limits) -> Self {
        Self {
            max_rows: limits.max_rows,
            max_elements: limits.max_rows,
            max_parts: MAX_PARTS,
            budget: limits.budget.clone(),
        }
    }
}

enum Building {
    /// The fields kept (`None` for one of an unknown type, left out).
    Frame {
        fields: Vec<Option<Field>>,
        rows: usize,
    },
    Documents(Vec<OrderedJson>),
    Graph {
        nodes: Vec<Node>,
        edges: Vec<Edge>,
        paths: Vec<GraphPath>,
    },
}

/// Puts a result together from its parts, in the order the protocol prescribes, within the
/// host's limits.
pub struct Assembler {
    limits: Limits,
    building: Option<Building>,
    parts: usize,
    /// The first limit that cut the result: a notice and the count it stopped at.
    cut: Option<(Detail, usize)>,
    /// Notices of the host about the stream (skipped parts, fields left out).
    notices: Vec<Notice>,
    skipped: usize,
}

/// What a finished stream answered: a result, or the plugin's error.
pub type Outcome = Result<QueryResult, pb::Error>;

impl Assembler {
    pub fn new(limits: Limits) -> Self {
        Self { limits, building: None, parts: 0, cut: None, notices: Vec::new(), skipped: 0 }
    }

    fn cut(&mut self, detail: Detail, at: usize) {
        if self.cut.is_none() {
            self.cut = Some((detail, at));
        }
    }

    /// Draws a data part's size from the budget; false once the result is cut.
    fn draw(&mut self, bytes: usize, size_reason: &'static str, kept: usize) -> bool {
        if self.cut.is_some() {
            return false;
        }
        if !self.limits.budget.take(bytes) {
            self.cut(Detail::new(size_reason, "the result was cut off at the response size limit"), kept);
            return false;
        }
        true
    }

    /// Takes the next part; `Some` once the result or the error is complete.
    pub fn push(&mut self, chunk: pb::QueryChunk) -> Result<Option<Outcome>, WireError> {
        use pb::query_chunk::Part;
        self.parts += 1;
        if self.parts > self.limits.max_parts {
            return Err(broken(format!("the result has more than {} parts", self.limits.max_parts)));
        }
        let bytes = chunk.encoded_len();
        // A part of a newer protocol minor decodes as no part: skipped, and said once at the end.
        let Some(part) = chunk.part else {
            self.skipped += 1;
            return Ok(None);
        };
        match (part, self.building.is_some()) {
            (Part::Error(e), _) => Ok(Some(Err(e))),
            (Part::Start(start), false) => self.start(start).map(|()| None),
            (Part::Start(_), true) => Err(broken("a second start")),
            (_, false) => Err(broken("a part before the start")),
            (Part::FrameRows(rows), true) => self.frame_rows(rows, bytes).map(|()| None),
            (Part::Documents(batch), true) => self.documents(batch, bytes).map(|()| None),
            (Part::Graph(batch), true) => self.graph(batch, bytes).map(|()| None),
            (Part::End(end), true) => {
                let building = self.building.take().expect("checked above");
                Ok(Some(Ok(self.finish(building, end)?)))
            }
        }
    }

    fn start(&mut self, start: pb::ResultStart) -> Result<(), WireError> {
        let shape = pb::Shape::try_from(start.shape).ok().and_then(shape_from);
        self.building = Some(match shape {
            Some(Shape::Frame) => {
                let mut fields = Vec::new();
                for f in start.frame_fields {
                    match field_type_from(f.r#type) {
                        Some(field_type) => fields.push(Some(Field {
                            name: f.name,
                            field_type,
                            unit: f.unit,
                            values: Vec::new(),
                            labels: f.labels.map(|l| l.entries),
                        })),
                        None => {
                            let message = format!("the column {} has a type this server cannot show", f.name);
                            let detail = Detail::new("frame.type_unsupported", message)
                                .with("column", &f.name)
                                .with("type", f.r#type);
                            self.notices.push(detail.notice(NoticeSeverity::Warning));
                            fields.push(None);
                        }
                    }
                }
                Building::Frame { fields, rows: 0 }
            }
            Some(Shape::Documents) => Building::Documents(Vec::new()),
            Some(Shape::Graph) => Building::Graph { nodes: Vec::new(), edges: Vec::new(), paths: Vec::new() },
            None => return Err(broken(format!("a result of unknown shape {}", start.shape))),
        });
        Ok(())
    }

    fn frame_rows(&mut self, rows: pb::FrameRows, bytes: usize) -> Result<(), WireError> {
        let Some(Building::Frame { fields, rows: kept }) = &self.building else {
            return Err(broken("a part of another shape"));
        };
        if rows.columns_json.len() != fields.len() {
            return Err(broken(format!("{} columns for {} fields", rows.columns_json.len(), fields.len())));
        }
        let mut columns = Vec::with_capacity(fields.len());
        let mut length = None;
        for (field, column) in fields.iter().zip(&rows.columns_json) {
            let values: Vec<Value> = parse("a frame column", column)?;
            if *length.get_or_insert(values.len()) != values.len() {
                return Err(broken("frame columns of different lengths"));
            }
            if let Some(field) = field
                && let Some((row, bad)) = values.iter().enumerate().find(|(_, v)| !value_fits(field.field_type, v))
            {
                return Err(broken(format!(
                    "the value {bad} in row {} of column {} is no {}",
                    kept + row,
                    field.name,
                    type_name(field.field_type)
                )));
            }
            columns.push(values);
        }
        let (kept, count) = (*kept, length.unwrap_or(0));
        if !self.draw(bytes, "frame.size_limit", kept) {
            return Ok(());
        }
        let room = self.limits.max_rows.saturating_sub(kept);
        let take = count.min(room);
        if take < count {
            let max = self.limits.max_rows;
            self.cut(
                Detail::new("frame.row_limit", format!("only the first {max} rows are shown")).with("rows", max),
                max,
            );
        }
        let Some(Building::Frame { fields, rows }) = &mut self.building else { unreachable!() };
        for (field, mut values) in fields.iter_mut().zip(columns) {
            if let Some(field) = field {
                values.truncate(take);
                field.values.extend(values);
            }
        }
        *rows += take;
        Ok(())
    }

    fn documents(&mut self, batch: pb::DocumentBatch, bytes: usize) -> Result<(), WireError> {
        let Some(Building::Documents(docs)) = &self.building else { return Err(broken("a part of another shape")) };
        let kept = docs.len();
        let mut parsed = Vec::with_capacity(batch.documents_json.len());
        for text in batch.documents_json {
            let doc = OrderedJson::from_text(text).map_err(|e| broken(format!("a document is not JSON: {e}")))?;
            if !doc.get().trim_start().starts_with('{') {
                return Err(broken("a document is not a JSON object"));
            }
            parsed.push(doc);
        }
        if !self.draw(bytes, "documents.size_limit", kept) {
            return Ok(());
        }
        let max = self.limits.max_elements;
        if kept + parsed.len() > max {
            parsed.truncate(max - kept);
            self.cut(
                Detail::new("documents.limit", format!("only the first {max} documents are shown")).with("limit", max),
                max,
            );
        }
        let Some(Building::Documents(docs)) = &mut self.building else { unreachable!() };
        docs.extend(parsed);
        Ok(())
    }

    fn graph(&mut self, batch: pb::GraphBatch, bytes: usize) -> Result<(), WireError> {
        let Some(Building::Graph { nodes, edges, .. }) = &self.building else {
            return Err(broken("a part of another shape"));
        };
        let (kept_nodes, kept_edges) = (nodes.len(), edges.len());
        let mut new_nodes = Vec::with_capacity(batch.nodes.len());
        for n in batch.nodes {
            let properties = parse("node properties", &n.properties_json)?;
            new_nodes.push(Node { id: n.id, labels: n.labels, properties });
        }
        let mut new_edges = Vec::with_capacity(batch.edges.len());
        for e in batch.edges {
            let properties = parse("edge properties", &e.properties_json)?;
            new_edges.push(Edge { id: e.id, edge_type: e.r#type, from: e.from, to: e.to, properties });
        }
        if !self.draw(bytes, "graph.size_limit", kept_nodes) {
            return Ok(());
        }
        let max = self.limits.max_elements;
        if kept_nodes + new_nodes.len() > max {
            new_nodes.truncate(max - kept_nodes);
            self.cut(
                Detail::new("graph.node_limit", format!("only the first {max} nodes are shown")).with("limit", max),
                max,
            );
        }
        if kept_edges + new_edges.len() > max {
            new_edges.truncate(max - kept_edges);
            self.cut(
                Detail::new("graph.edge_limit", format!("only the first {max} edges are shown")).with("limit", max),
                max,
            );
        }
        let Some(Building::Graph { nodes, edges, paths }) = &mut self.building else { unreachable!() };
        nodes.extend(new_nodes);
        edges.extend(new_edges);
        let room = max.saturating_sub(paths.len());
        paths.extend(batch.paths.into_iter().take(room).map(|p| GraphPath { nodes: p.nodes, edges: p.edges }));
        Ok(())
    }

    /// The host's notices for the end: the cut, skipped parts and fields left out.
    fn host_notices(&mut self) -> Vec<Notice> {
        let mut out = std::mem::take(&mut self.notices);
        if self.skipped > 0 {
            let detail = Detail::new(
                "plugin.part_skipped",
                format!("{} parts of a newer plugin protocol were skipped", self.skipped),
            )
            .with("count", self.skipped);
            out.push(detail.notice(NoticeSeverity::Info));
        }
        if let Some((detail, _)) = &self.cut {
            out.push(detail.clone().notice(NoticeSeverity::Warning));
        }
        out
    }

    fn finish(&mut self, building: Building, end: pb::ResultEnd) -> Result<QueryResult, WireError> {
        use pb::result_end::Meta;
        let cut = self.cut.as_ref().map(|(d, at)| Truncated {
            limit: u32::try_from(*at).unwrap_or(u32::MAX),
            reason: Some(d.reason.to_string()),
        });
        let host = self.host_notices();
        match (building, end.meta) {
            (Building::Frame { fields, .. }, Some(Meta::Frame(end))) => {
                let frame = Frame::new(fields.into_iter().flatten().collect()).map_err(broken)?;
                let mut meta = end.meta.map(|m| FrameMeta {
                    executed_query: m.executed_query,
                    rows_truncated: m.rows_truncated,
                    notices: notices_from(m.notices),
                });
                if cut.is_some() || !host.is_empty() {
                    let meta = meta.get_or_insert_with(FrameMeta::default);
                    meta.rows_truncated |= cut.is_some();
                    meta.notices.extend(host);
                }
                Ok(QueryResult::Frame {
                    frame: match meta {
                        Some(m) => frame.with_meta(m),
                        None => frame,
                    },
                })
            }
            (Building::Documents(documents), Some(Meta::Documents(end))) => {
                let mut notices = notices_from(end.notices);
                notices.extend(host);
                Ok(QueryResult::Documents {
                    documents: DocumentSet {
                        documents,
                        schema: end
                            .schema
                            .into_iter()
                            .map(|f| FieldSchema {
                                path: f.path,
                                coverage: f.coverage,
                                types: f
                                    .types
                                    .into_iter()
                                    .map(|t| TypeShare { name: t.name, share: t.share })
                                    .collect(),
                            })
                            .collect(),
                        // The plugin's cursor would skip what the host cut.
                        next_cursor: if cut.is_some() { None } else { end.next_cursor },
                        truncated: cut.or(end.truncated.map(truncated_from)),
                        notices,
                        executed_query: end.executed_query,
                        distributable: end.distributable,
                    },
                })
            }
            (Building::Graph { nodes, mut edges, mut paths }, Some(Meta::Graph(end))) => {
                if !end.has_paths && !paths.is_empty() {
                    return Err(broken("paths in a graph without paths"));
                }
                if cut.is_some() {
                    // Keep only edges and paths whose ends are still there.
                    let node_ids: BTreeSet<&str> = nodes.iter().map(|n| n.id.as_str()).collect();
                    edges.retain(|e| node_ids.contains(e.from.as_str()) && node_ids.contains(e.to.as_str()));
                    let edge_ids: BTreeSet<&str> = edges.iter().map(|e| e.id.as_str()).collect();
                    paths.retain(|p| {
                        p.nodes.iter().all(|n| node_ids.contains(n.as_str()))
                            && p.edges.iter().all(|e| edge_ids.contains(e.as_str()))
                    });
                }
                let schema = end.schema.unwrap_or_default();
                let mut notices = end.notices.map(|n| notices_from(n.items));
                if !host.is_empty() {
                    notices.get_or_insert_with(Vec::new).extend(host);
                }
                Ok(QueryResult::Graph {
                    graph: GraphSet {
                        nodes,
                        edges,
                        paths: end.has_paths.then_some(paths),
                        schema: GraphSchema {
                            labels: schema.labels,
                            edge_types: schema.edge_types,
                            property_keys: schema.property_keys.into_iter().map(|(k, v)| (k, v.values)).collect(),
                        },
                        truncated: cut.or(end.truncated.map(truncated_from)),
                        notices,
                    },
                })
            }
            _ => Err(broken("an end of another shape")),
        }
    }
}

/// A whole stream of parts; a stream that stops before its end is broken.
pub fn assemble(limits: Limits, chunks: impl IntoIterator<Item = pb::QueryChunk>) -> Result<Outcome, WireError> {
    let mut assembler = Assembler::new(limits);
    for chunk in chunks {
        if let Some(outcome) = assembler.push(chunk)? {
            return Ok(outcome);
        }
    }
    Err(broken("the result ended without its end"))
}

#[cfg(test)]
pub(crate) fn unlimited() -> Limits {
    Limits {
        max_rows: usize::MAX,
        max_elements: usize::MAX,
        max_parts: MAX_PARTS,
        budget: ResponseBudget::new(usize::MAX),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::plugins::test_results::{documents, frame, graph};

    /// Through the wire: every part encoded and decoded, then put together again.
    fn round_trip(result: &QueryResult, batch: usize) -> QueryResult {
        let parts = chunks(result, batch)
            .into_iter()
            .map(|c| pb::QueryChunk::decode(c.encode_to_vec().as_slice()).expect("decodes"));
        assemble(unlimited(), parts).expect("follows the protocol").expect("a result")
    }

    fn limits(max_rows: usize, max_elements: usize, max_parts: usize, bytes: usize) -> Limits {
        Limits { max_rows, max_elements, max_parts, budget: ResponseBudget::new(bytes) }
    }

    fn codes(notices: &[Notice]) -> Vec<&str> {
        notices.iter().map(|n| n.code.as_str()).collect()
    }

    #[test]
    fn every_shape_survives_the_wire_in_any_batch_size() {
        for result in [frame(), documents(), graph()] {
            for batch in [1, 2, 1000] {
                let back = round_trip(&result, batch);
                assert_eq!(back, result, "batch {batch}");
                // Identical on the API too, documents in their stored key order.
                assert_eq!(serde_json::to_string(&back).unwrap(), serde_json::to_string(&result).unwrap());
            }
        }
    }

    #[test]
    fn parts_stay_far_below_the_message_limit() {
        let big = "x".repeat(300_000);
        let docs: Vec<OrderedJson> = (0..20).map(|i| json!({"i": i, "text": big}).into()).collect();
        let result = QueryResult::Documents { documents: DocumentSet { documents: docs, ..Default::default() } };
        let parts = chunks(&result, 1000);
        assert!(parts.len() > 3, "{} parts", parts.len());
        assert!(parts.iter().all(|p| p.encoded_len() < kalzit_plugin_api::MAX_MESSAGE_BYTES / 4));
        assert_eq!(round_trip(&result, 1000), result);
        assert_eq!(batches([10, 10, 10].into_iter(), 2), [0..2, 2..3]);
        assert_eq!(batches(std::iter::empty(), 2), Vec::<Range<usize>>::new());
    }

    #[test]
    fn empty_results_and_absent_parts_stay_as_they_were() {
        let empty_frame = QueryResult::Frame { frame: Frame::new(vec![]).unwrap() };
        let no_rows = QueryResult::Frame {
            frame: Frame::new(vec![Field {
                name: "x".into(),
                field_type: FieldType::String,
                unit: None,
                values: vec![],
                labels: None,
            }])
            .unwrap(),
        };
        let empty_docs = QueryResult::Documents { documents: DocumentSet::default() };
        let empty_graph = QueryResult::Graph { graph: GraphSet::default() };
        let no_paths_yet =
            QueryResult::Graph { graph: GraphSet { paths: Some(vec![]), notices: Some(vec![]), ..Default::default() } };
        for result in [empty_frame, no_rows, empty_docs, empty_graph, no_paths_yet] {
            assert_eq!(round_trip(&result, 2), result);
        }
    }

    #[test]
    fn an_error_ends_the_stream() {
        let e = SourceError::rejected("cypher.write_clause", "writing is not allowed").with("clause", "CREATE");
        let mut parts = chunks(&frame(), 1);
        parts.truncate(2);
        parts.push(pb::QueryChunk { part: Some(pb::query_chunk::Part::Error(error(&e))) });
        let got = assemble(unlimited(), parts).unwrap().unwrap_err();
        assert_eq!(error_kind(&got), pb::ErrorKind::Rejected);
        let d = got.detail.unwrap();
        assert_eq!((d.reason.as_str(), d.params["clause"].as_str()), ("cypher.write_clause", "CREATE"));
        assert_eq!(error(&SourceError::Timeout(30)).detail.unwrap().params["seconds"], "30");
        assert_eq!(error_kind(&pb::Error { kind: 99, detail: None }), pb::ErrorKind::Failed);
        assert_eq!(error_kind(&pb::Error { kind: 0, detail: None }), pb::ErrorKind::Failed);
    }

    #[test]
    fn health_carries_an_error_when_it_failed() {
        let ok = health(&Health::connected("Fixture", "1", false));
        assert!(ok.ok && ok.error.is_none() && ok.detail.is_some());
        let failed = health(&Health::failed(&SourceError::Blocked(Detail::new("target.metadata", "no"))));
        assert!(!failed.ok && failed.detail.is_none());
        assert_eq!(error_kind(failed.error.as_ref().unwrap()), pb::ErrorKind::Blocked);
    }

    #[test]
    fn parts_out_of_order_or_shape_are_refused() {
        use pb::query_chunk::Part;
        let frame_parts = chunks(&frame(), 1);
        let doc_parts = chunks(&documents(), 1);
        let rows = |cols: &[&str]| pb::QueryChunk {
            part: Some(Part::FrameRows(pb::FrameRows { columns_json: cols.iter().map(|c| c.to_string()).collect() })),
        };
        let cases: Vec<(Vec<pb::QueryChunk>, &str)> = vec![
            (frame_parts[1..].to_vec(), "before the start"),
            (vec![frame_parts[0].clone(), frame_parts[0].clone()], "second start"),
            (vec![frame_parts[0].clone(), doc_parts[1].clone()], "another shape"),
            (vec![frame_parts[0].clone(), doc_parts.last().unwrap().clone()], "end of another shape"),
            (frame_parts[..2].to_vec(), "without its end"),
            (vec![frame_parts[0].clone(), rows(&["[1]"])], "columns for"),
            (vec![frame_parts[0].clone(), rows(&["[1]", "[1,2]", "[\"1\"]"])], "different lengths"),
            (
                vec![
                    doc_parts[0].clone(),
                    pb::QueryChunk {
                        part: Some(Part::Documents(pb::DocumentBatch { documents_json: vec!["[1]".into()] })),
                    },
                ],
                "not a JSON object",
            ),
            (
                vec![pb::QueryChunk {
                    part: Some(Part::Start(pb::ResultStart {
                        shape: pb::Shape::Unspecified as i32,
                        frame_fields: vec![],
                    })),
                }],
                "unknown shape",
            ),
        ];
        for (parts, expected) in cases {
            let e = assemble(unlimited(), parts).unwrap_err();
            assert!(e.0.contains(expected), "{e} should mention {expected}");
        }
    }

    /// Values that do not fit the declared type are refused, naming the column and row.
    #[test]
    fn frame_values_must_fit_their_types() {
        let start = |t: pb::FieldType| pb::QueryChunk {
            part: Some(pb::query_chunk::Part::Start(pb::ResultStart {
                shape: pb::Shape::Frame as i32,
                frame_fields: vec![pb::FrameField { name: "c".into(), r#type: t as i32, ..Default::default() }],
            })),
        };
        let rows = |column: &str| pb::QueryChunk {
            part: Some(pb::query_chunk::Part::FrameRows(pb::FrameRows { columns_json: vec![column.into()] })),
        };
        let end = chunks(&QueryResult::Frame { frame: Frame::new(vec![]).unwrap() }, 1).pop().unwrap();
        use pb::FieldType as T;
        let fits = [
            (T::Time, "[1700000000000, 1.5, null]"),
            (T::Date, "[0, -86400000]"),
            (T::Number, "[1, -2.5, 1e300]"),
            (T::Int64, "[\"9223372036854775807\", \"-1\", null]"),
            (T::Decimal, "[\"-1234.50\", \"7\", \"0.000001\"]"),
            (T::String, "[\"a\", \"\"]"),
            (T::Bool, "[true, false]"),
            (T::Json, "[{\"a\": [1]}, 2, \"x\", true]"),
        ];
        for (t, column) in fits {
            let parts = vec![start(t), rows(column), end.clone()];
            assert!(assemble(unlimited(), parts).unwrap().is_ok(), "{t:?} {column}");
        }
        let mistyped = [
            (T::Time, "[\"2026-10-27\"]"),
            (T::Time, "[1e300]"),
            (T::Number, "[\"1\"]"),
            (T::Int64, "[42]"),
            (T::Int64, "[\"9223372036854775808\"]"),
            (T::Int64, "[\"1.5\"]"),
            (T::Decimal, "[1.5]"),
            (T::Decimal, "[\"1e5\"]"),
            (T::Decimal, "[\"NaN\"]"),
            (T::Decimal, "[\"1.\"]"),
            (T::String, "[1]"),
            (T::Bool, "[\"true\"]"),
            (T::Date, "[true]"),
        ];
        for (t, column) in mistyped {
            let e = assemble(unlimited(), vec![start(t), rows(&format!("[null, {}", &column[1..])), end.clone()])
                .unwrap_err();
            assert!(e.0.contains("row 1 of column c"), "{t:?} {column}: {e}");
        }
    }

    #[test]
    fn rows_documents_and_graph_elements_are_cut_at_the_limits() {
        let QueryResult::Frame { frame: cut } =
            assemble(limits(2, 100, 100, usize::MAX), chunks(&frame(), 1)).unwrap().unwrap()
        else {
            panic!("a frame")
        };
        assert_eq!(cut.rows(), 2);
        let meta = cut.meta().unwrap();
        assert!(meta.rows_truncated);
        assert_eq!(codes(&meta.notices).last(), Some(&"frame.row_limit"));

        let QueryResult::Documents { documents: set } =
            assemble(limits(100, 2, 100, usize::MAX), chunks(&documents(), 1000)).unwrap().unwrap()
        else {
            panic!("documents")
        };
        assert_eq!(set.documents.len(), 2);
        assert_eq!(set.truncated, Some(Truncated { limit: 2, reason: Some("documents.limit".into()) }));
        assert_eq!(set.next_cursor, None);
        assert_eq!(codes(&set.notices).last(), Some(&"documents.limit"));

        let QueryResult::Graph { graph: g } =
            assemble(limits(100, 1, 100, usize::MAX), chunks(&graph(), 1000)).unwrap().unwrap()
        else {
            panic!("a graph")
        };
        assert_eq!(g.nodes.len(), 1);
        // The edge a-b and the path through it lost their end b.
        assert!(g.edges.is_empty() && g.paths == Some(vec![]));
        assert_eq!(g.truncated.unwrap().reason.as_deref(), Some("graph.node_limit"));
    }

    #[test]
    fn the_response_budget_cuts_by_size() {
        let QueryResult::Documents { documents: set } =
            assemble(limits(100, 100, 100, 150), chunks(&documents(), 1)).unwrap().unwrap()
        else {
            panic!("documents")
        };
        assert!(set.documents.len() < 3);
        assert_eq!(set.truncated.as_ref().unwrap().reason.as_deref(), Some("documents.size_limit"));
        assert!(codes(&set.notices).contains(&"documents.size_limit"));
    }

    /// A plugin that never ends its result is stopped at the parts cap, also after a cut.
    #[test]
    fn endless_streams_end_with_an_error() {
        let parts = chunks(&documents(), 1);
        let endless = std::iter::once(parts[0].clone()).chain(std::iter::repeat(parts[1].clone()));
        let e = assemble(limits(100, 2, 50, usize::MAX), endless).unwrap_err();
        assert!(e.0.contains("more than 50 parts"), "{e}");
        let empty_parts = std::iter::repeat(pb::QueryChunk { part: None });
        assert!(assemble(limits(100, 100, 10, usize::MAX), empty_parts).is_err());
    }

    /// Additions of a newer protocol minor: unknown parts are skipped, unknown severities count
    /// as info, a field of an unknown type is left out with a notice.
    #[test]
    fn additions_of_newer_minors_are_handled_safely() {
        let mut parts = chunks(&documents(), 1);
        parts.insert(2, pb::QueryChunk { part: None });
        let QueryResult::Documents { documents: set } = assemble(unlimited(), parts).unwrap().unwrap() else {
            panic!("documents")
        };
        assert_eq!(set.documents.len(), 3);
        assert_eq!(codes(&set.notices).last(), Some(&"plugin.part_skipped"));

        let n = notice_from(pb::Notice { severity: 9, code: "x.y".into(), params: None, text: "t".into() });
        assert_eq!(n.severity, NoticeSeverity::Info);
        assert_eq!(capabilities_from(&[1, 2, 77]), [Capability::CheckOnSave, Capability::Watch]);

        let start = pb::QueryChunk {
            part: Some(pb::query_chunk::Part::Start(pb::ResultStart {
                shape: pb::Shape::Frame as i32,
                frame_fields: vec![
                    pb::FrameField { name: "a".into(), r#type: pb::FieldType::Number as i32, ..Default::default() },
                    pb::FrameField { name: "geo".into(), r#type: 42, ..Default::default() },
                ],
            })),
        };
        let rows = pb::QueryChunk {
            part: Some(pb::query_chunk::Part::FrameRows(pb::FrameRows {
                columns_json: vec!["[1,2]".into(), "[{\"lat\":1},null]".into()],
            })),
        };
        let end = chunks(&QueryResult::Frame { frame: Frame::new(vec![]).unwrap() }, 1).pop().unwrap();
        let QueryResult::Frame { frame: f } = assemble(unlimited(), [start, rows, end]).unwrap().unwrap() else {
            panic!("a frame")
        };
        assert_eq!(f.fields().len(), 1);
        assert_eq!(f.fields()[0].name, "a");
        let notice = &f.meta().unwrap().notices[0];
        assert_eq!(notice.code, "frame.type_unsupported");
        assert_eq!(notice.params.as_ref().unwrap()["column"], "geo");
    }
}
