//! Results of every shape with the details the wire must keep: key order, exact numbers,
//! present but empty maps, typed document values, notices, paths.

use std::collections::BTreeMap;

use serde_json::json;

use crate::datasources::Detail;
use crate::shapes::{
    DocumentSet, Edge, Field, FieldSchema, FieldType, Frame, FrameMeta, GraphPath, GraphSchema, GraphSet, Node, Notice,
    NoticeSeverity, OrderedJson, QueryResult, Truncated, TypeShare,
};

fn notices() -> Vec<Notice> {
    vec![
        Detail::new("frame.rows_truncated", "cut at 2 rows").with("limit", 2).notice(NoticeSeverity::Warning),
        Notice { severity: NoticeSeverity::Info, code: "graph.columns_ignored".into(), params: None, text: "x".into() },
    ]
}

pub fn frame() -> QueryResult {
    let fields = vec![
        Field {
            name: "time".into(),
            field_type: FieldType::Time,
            unit: None,
            values: vec![json!(1_700_000_000_000_i64), json!(1_700_000_060_000_i64), json!(null)],
            labels: None,
        },
        Field {
            name: "value".into(),
            field_type: FieldType::Number,
            unit: Some("ms".into()),
            // A value only exact with float_roundtrip, and an integer beyond 2^53 as a string.
            values: vec![json!(0.1 + 0.2), json!(-1.5e300), json!(2)],
            labels: Some(BTreeMap::from([("job".into(), "api".into())])),
        },
        Field {
            name: "big".into(),
            field_type: FieldType::Int64,
            unit: None,
            values: vec![json!("9007199254740993"), json!(null), json!("-1")],
            labels: Some(BTreeMap::new()),
        },
    ];
    let meta = FrameMeta { executed_query: Some("SELECT 1".into()), rows_truncated: true, notices: notices() };
    QueryResult::Frame { frame: Frame::new(fields).unwrap().with_meta(meta) }
}

pub fn documents() -> QueryResult {
    let docs = [
        r#"{"z":1,"a":{"$type":"objectId","value":"65f0c0ffee0000000000beef"},"ü":"Grüße 🌍"}"#,
        r#"{"b":[1,{"$type":"date","value":"2026-10-27T00:00:00Z"}],"a":null}"#,
        r#"{}"#,
    ];
    QueryResult::Documents {
        documents: DocumentSet {
            documents: docs.iter().map(|d| OrderedJson::from_text(d.to_string()).unwrap()).collect(),
            schema: vec![FieldSchema {
                path: "items[].price".into(),
                coverage: 2.0 / 3.0,
                types: vec![TypeShare { name: "double".into(), share: 1.0 }],
            }],
            next_cursor: Some("cursor-2".into()),
            truncated: Some(Truncated { limit: 3, reason: Some("documents.limit".into()) }),
            notices: notices(),
            executed_query: Some("[{\"$match\":{}}]".into()),
            distributable: true,
        },
    }
}

pub fn graph() -> QueryResult {
    let node = |id: &str, label: &str| Node {
        id: id.into(),
        labels: vec![label.into()],
        properties: BTreeMap::from([("name".into(), json!(id)), ("score".into(), json!(0.5))]),
    };
    QueryResult::Graph {
        graph: GraphSet {
            nodes: vec![node("a", "Person"), node("b", "Person"), node("c", "Company")],
            edges: vec![Edge {
                id: "a-KNOWS-b".into(),
                edge_type: "KNOWS".into(),
                from: "a".into(),
                to: "b".into(),
                properties: BTreeMap::from([("since".into(), json!({"$type": "date", "value": "2020-01-01"}))]),
            }],
            paths: Some(vec![GraphPath { nodes: vec!["a".into(), "b".into()], edges: vec!["a-KNOWS-b".into()] }]),
            schema: GraphSchema {
                labels: vec!["Company".into(), "Person".into()],
                edge_types: vec!["KNOWS".into()],
                property_keys: BTreeMap::from([("Person".into(), vec!["name".into(), "score".into()])]),
            },
            truncated: Some(Truncated { limit: 3, reason: None }),
            notices: Some(notices()),
        },
    }
}
