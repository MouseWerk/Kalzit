//! The server's types in the data source protocol (`kalzit_plugin_api::datasource::v1`) and back.
//! A result travels as parts (`QueryChunk`): `chunks` cuts one, `Assembler` puts one together and
//! refuses parts out of order or of another shape. Values without a fixed type (frame values,
//! documents, graph properties) travel as JSON text, documents in their stored key order.

use std::collections::BTreeMap;

use kalzit_plugin_api::datasource::v1 as pb;
use serde_json::Value;

use crate::datasources::{Capability, Detail, FieldError, Health, SourceError};
use crate::shapes::{
    DocumentSet, Edge, Field, FieldSchema, FieldType, Frame, FrameMeta, GraphPath, GraphSchema, GraphSet, Node, Notice,
    NoticeSeverity, OrderedJson, QueryResult, Shape, Truncated, TypeShare,
};

/// A part that breaks the protocol: out of order, of another shape, or not valid JSON.
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

pub fn health(h: &Health) -> pb::HealthResponse {
    pb::HealthResponse {
        ok: h.ok,
        code: h.code.unwrap_or_default().to_string(),
        detail: Some(detail(&h.detail)),
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

fn field_type_from(t: i32) -> Result<FieldType, WireError> {
    Ok(match pb::FieldType::try_from(t).map_err(|_| broken(format!("unknown field type {t}")))? {
        pb::FieldType::Time => FieldType::Time,
        pb::FieldType::Number => FieldType::Number,
        pb::FieldType::Int64 => FieldType::Int64,
        pb::FieldType::String => FieldType::String,
        pb::FieldType::Bool => FieldType::Bool,
        pb::FieldType::Json => FieldType::Json,
        pb::FieldType::Decimal => FieldType::Decimal,
        pb::FieldType::Date => FieldType::Date,
        pb::FieldType::Unspecified => return Err(broken("a field without a type")),
    })
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

fn notice_from(n: pb::Notice) -> Result<Notice, WireError> {
    let severity = match pb::NoticeSeverity::try_from(n.severity) {
        Ok(pb::NoticeSeverity::Info) => NoticeSeverity::Info,
        Ok(pb::NoticeSeverity::Warning) => NoticeSeverity::Warning,
        _ => return Err(broken(format!("notice {} has no severity", n.code))),
    };
    Ok(Notice { severity, code: n.code, params: n.params.map(|p| p.entries), text: n.text })
}

fn notices_from(notices: Vec<pb::Notice>) -> Result<Vec<Notice>, WireError> {
    notices.into_iter().map(notice_from).collect()
}

fn truncated(t: &Truncated) -> pb::Truncated {
    pb::Truncated { limit: t.limit, reason: t.reason.clone() }
}

fn truncated_from(t: pb::Truncated) -> Truncated {
    Truncated { limit: t.limit, reason: t.reason }
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

/// The parts of a result: the start, batches of at most `batch` rows, documents or graph
/// elements, and the end.
pub fn chunks(result: &QueryResult, batch: usize) -> Vec<pb::QueryChunk> {
    use pb::query_chunk::Part;
    let batch = batch.max(1);
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
            let rows = frame.rows();
            for from in (0..rows).step_by(batch) {
                let to = (from + batch).min(rows);
                let columns_json = frame.fields().iter().map(|f| json(&f.values[from..to])).collect();
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
            for docs in set.documents.chunks(batch) {
                let documents_json = docs.iter().map(|d| d.get().to_string()).collect();
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
            let paths = graph.paths.as_deref().unwrap_or_default();
            let longest = graph.nodes.len().max(graph.edges.len()).max(paths.len());
            for from in (0..longest).step_by(batch) {
                let slice = |len: usize| from.min(len)..(from + batch).min(len);
                out.push(part(Part::Graph(pb::GraphBatch {
                    nodes: graph.nodes[slice(graph.nodes.len())]
                        .iter()
                        .map(|n| pb::Node {
                            id: n.id.clone(),
                            labels: n.labels.clone(),
                            properties_json: json(&n.properties),
                        })
                        .collect(),
                    edges: graph.edges[slice(graph.edges.len())]
                        .iter()
                        .map(|e| pb::Edge {
                            id: e.id.clone(),
                            r#type: e.edge_type.clone(),
                            from: e.from.clone(),
                            to: e.to.clone(),
                            properties_json: json(&e.properties),
                        })
                        .collect(),
                    paths: paths[slice(paths.len())]
                        .iter()
                        .map(|p| pb::GraphPath { nodes: p.nodes.clone(), edges: p.edges.clone() })
                        .collect(),
                })));
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

enum Building {
    Frame(Vec<Field>),
    Documents(Vec<OrderedJson>),
    Graph { nodes: Vec<Node>, edges: Vec<Edge>, paths: Vec<GraphPath> },
}

/// Puts a result together from its parts, in the order the protocol prescribes.
#[derive(Default)]
pub struct Assembler {
    building: Option<Building>,
}

/// What a finished stream answered: a result, or the plugin's error.
pub type Outcome = Result<QueryResult, pb::Error>;

impl Assembler {
    /// Takes the next part; `Some` once the result or the error is complete.
    pub fn push(&mut self, chunk: pb::QueryChunk) -> Result<Option<Outcome>, WireError> {
        use pb::query_chunk::Part;
        let part = chunk.part.ok_or_else(|| broken("an empty part"))?;
        match (part, &mut self.building) {
            (Part::Error(e), _) => Ok(Some(Err(e))),
            (Part::Start(start), None) => {
                let shape = pb::Shape::try_from(start.shape).ok().and_then(shape_from);
                self.building = Some(match shape {
                    Some(Shape::Frame) => Building::Frame(
                        start
                            .frame_fields
                            .into_iter()
                            .map(|f| {
                                Ok(Field {
                                    name: f.name,
                                    field_type: field_type_from(f.r#type)?,
                                    unit: f.unit,
                                    values: Vec::new(),
                                    labels: f.labels.map(|l| l.entries),
                                })
                            })
                            .collect::<Result<_, WireError>>()?,
                    ),
                    Some(Shape::Documents) => Building::Documents(Vec::new()),
                    Some(Shape::Graph) => Building::Graph { nodes: Vec::new(), edges: Vec::new(), paths: Vec::new() },
                    None => return Err(broken("a result without a shape")),
                });
                Ok(None)
            }
            (Part::Start(_), Some(_)) => Err(broken("a second start")),
            (_, None) => Err(broken("a part before the start")),
            (Part::FrameRows(rows), Some(Building::Frame(fields))) => {
                if rows.columns_json.len() != fields.len() {
                    return Err(broken(format!("{} columns for {} fields", rows.columns_json.len(), fields.len())));
                }
                let mut length = None;
                for (field, column) in fields.iter_mut().zip(rows.columns_json) {
                    let values: Vec<Value> = parse("a frame column", &column)?;
                    if *length.get_or_insert(values.len()) != values.len() {
                        return Err(broken("frame columns of different lengths"));
                    }
                    field.values.extend(values);
                }
                Ok(None)
            }
            (Part::Documents(batch), Some(Building::Documents(docs))) => {
                for text in batch.documents_json {
                    let doc =
                        OrderedJson::from_text(text).map_err(|e| broken(format!("a document is not JSON: {e}")))?;
                    if !doc.get().trim_start().starts_with('{') {
                        return Err(broken("a document is not a JSON object"));
                    }
                    docs.push(doc);
                }
                Ok(None)
            }
            (Part::Graph(batch), Some(Building::Graph { nodes, edges, paths })) => {
                for n in batch.nodes {
                    let properties = parse("node properties", &n.properties_json)?;
                    nodes.push(Node { id: n.id, labels: n.labels, properties });
                }
                for e in batch.edges {
                    let properties = parse("edge properties", &e.properties_json)?;
                    edges.push(Edge { id: e.id, edge_type: e.r#type, from: e.from, to: e.to, properties });
                }
                paths.extend(batch.paths.into_iter().map(|p| GraphPath { nodes: p.nodes, edges: p.edges }));
                Ok(None)
            }
            (Part::End(end), Some(_)) => {
                let building = self.building.take().expect("matched above");
                Ok(Some(Ok(finish(building, end)?)))
            }
            (_, Some(_)) => Err(broken("a part of another shape")),
        }
    }
}

fn finish(building: Building, end: pb::ResultEnd) -> Result<QueryResult, WireError> {
    use pb::result_end::Meta;
    match (building, end.meta) {
        (Building::Frame(fields), Some(Meta::Frame(end))) => {
            let frame = Frame::new(fields).map_err(broken)?;
            let frame = match end.meta {
                Some(m) => frame.with_meta(FrameMeta {
                    executed_query: m.executed_query,
                    rows_truncated: m.rows_truncated,
                    notices: notices_from(m.notices)?,
                }),
                None => frame,
            };
            Ok(QueryResult::Frame { frame })
        }
        (Building::Documents(documents), Some(Meta::Documents(end))) => Ok(QueryResult::Documents {
            documents: DocumentSet {
                documents,
                schema: end
                    .schema
                    .into_iter()
                    .map(|f| FieldSchema {
                        path: f.path,
                        coverage: f.coverage,
                        types: f.types.into_iter().map(|t| TypeShare { name: t.name, share: t.share }).collect(),
                    })
                    .collect(),
                next_cursor: end.next_cursor,
                truncated: end.truncated.map(truncated_from),
                notices: notices_from(end.notices)?,
                executed_query: end.executed_query,
                distributable: end.distributable,
            },
        }),
        (Building::Graph { nodes, edges, paths }, Some(Meta::Graph(end))) => {
            if !end.has_paths && !paths.is_empty() {
                return Err(broken("paths in a graph without paths"));
            }
            let schema = end.schema.unwrap_or_default();
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
                    truncated: end.truncated.map(truncated_from),
                    notices: end.notices.map(|n| notices_from(n.items)).transpose()?,
                },
            })
        }
        _ => Err(broken("an end of another shape")),
    }
}

/// A whole stream of parts; a stream that stops before its end is broken.
pub fn assemble(chunks: impl IntoIterator<Item = pb::QueryChunk>) -> Result<Outcome, WireError> {
    let mut assembler = Assembler::default();
    for chunk in chunks {
        if let Some(outcome) = assembler.push(chunk)? {
            return Ok(outcome);
        }
    }
    Err(broken("the result ended without its end"))
}

#[cfg(test)]
mod tests {
    use prost::Message;

    use super::*;
    use crate::plugins::test_results::{documents, frame, graph};

    /// Through the wire: every part encoded and decoded, then put together again.
    fn round_trip(result: &QueryResult, batch: usize) -> QueryResult {
        let parts = chunks(result, batch)
            .into_iter()
            .map(|c| pb::QueryChunk::decode(c.encode_to_vec().as_slice()).expect("decodes"));
        assemble(parts).expect("follows the protocol").expect("a result")
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
        let got = assemble(parts).unwrap().unwrap_err();
        assert_eq!(got.kind, pb::ErrorKind::Rejected as i32);
        let d = got.detail.unwrap();
        assert_eq!((d.reason.as_str(), d.params["clause"].as_str()), ("cypher.write_clause", "CREATE"));
        assert_eq!(error(&SourceError::Timeout(30)).detail.unwrap().params["seconds"], "30");
    }

    #[test]
    fn parts_out_of_order_or_shape_are_refused() {
        use pb::query_chunk::Part;
        let frame_parts = chunks(&frame(), 1);
        let doc_parts = chunks(&documents(), 1);
        let cases: Vec<(Vec<pb::QueryChunk>, &str)> = vec![
            (frame_parts[1..].to_vec(), "before the start"),
            (vec![frame_parts[0].clone(), frame_parts[0].clone()], "second start"),
            (vec![frame_parts[0].clone(), doc_parts[1].clone()], "another shape"),
            (vec![frame_parts[0].clone(), doc_parts.last().unwrap().clone()], "end of another shape"),
            (frame_parts[..2].to_vec(), "without its end"),
            (
                vec![
                    frame_parts[0].clone(),
                    pb::QueryChunk { part: Some(Part::FrameRows(pb::FrameRows { columns_json: vec!["[1]".into()] })) },
                ],
                "columns for",
            ),
            (
                vec![
                    frame_parts[0].clone(),
                    pb::QueryChunk {
                        part: Some(Part::FrameRows(pb::FrameRows {
                            columns_json: vec!["[1]".into(), "[1,2]".into(), "[1]".into()],
                        })),
                    },
                ],
                "different lengths",
            ),
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
                "without a shape",
            ),
            (vec![pb::QueryChunk { part: None }], "empty part"),
        ];
        for (parts, expected) in cases {
            let e = assemble(parts).unwrap_err();
            assert!(e.0.contains(expected), "{e} should mention {expected}");
        }
    }
}
