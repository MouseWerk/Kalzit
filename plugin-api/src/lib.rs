//! The Kalzit plugin contract (docs/ARCHITECTURE.md, "Plugins"): the data source protocol that
//! plugin processes serve over gRPC, the plugin manifest with its validator, and the context
//! plugin signatures are made in. The server and plugin SDKs share this crate; the host itself
//! (processes, sandbox, catalog) lives in the server.

pub mod manifest;
pub mod signing;

/// The data source protocol, version 1, generated from
/// `proto/kalzit/plugin/datasource/v1/datasource.proto`.
pub mod datasource {
    pub mod v1 {
        #![allow(clippy::all, clippy::pedantic)]
        include!(concat!(env!("OUT_DIR"), "/kalzit.plugin.datasource.v1.rs"));
    }
}

/// The protocol version this crate speaks; `Describe` exchanges it.
pub const PROTOCOL_VERSION: u32 = 1;

/// The protocol versions a host of this crate accepts from a plugin.
pub const SUPPORTED_PROTOCOL_VERSIONS: &[u32] = &[1];

#[cfg(test)]
mod tests {
    use prost::Message;

    use super::datasource::v1 as pb;

    fn round_trip(chunk: &pb::QueryChunk) -> pb::QueryChunk {
        pb::QueryChunk::decode(chunk.encode_to_vec().as_slice()).expect("a chunk decodes")
    }

    #[test]
    fn chunks_of_every_shape_survive_the_wire() {
        let chunks = [
            pb::QueryChunk {
                part: Some(pb::query_chunk::Part::Start(pb::ResultStart {
                    shape: pb::Shape::Frame as i32,
                    frame_fields: vec![pb::FrameField {
                        name: "time".into(),
                        r#type: pb::FieldType::Time as i32,
                        unit: Some("ms".into()),
                        labels: Some(pb::StringMap { entries: [("job".into(), "api".into())].into() }),
                    }],
                })),
            },
            pb::QueryChunk {
                part: Some(pb::query_chunk::Part::FrameRows(pb::FrameRows { columns_json: vec!["[1,null,3]".into()] })),
            },
            pb::QueryChunk {
                part: Some(pb::query_chunk::Part::Documents(pb::DocumentBatch {
                    documents_json: vec![r#"{"z":1,"a":{"$type":"objectId","value":"65f0"}}"#.into()],
                })),
            },
            pb::QueryChunk {
                part: Some(pb::query_chunk::Part::Graph(pb::GraphBatch {
                    nodes: vec![pb::Node {
                        id: "n1".into(),
                        labels: vec!["Person".into()],
                        properties_json: "{}".into(),
                    }],
                    edges: vec![pb::Edge {
                        id: "e1".into(),
                        r#type: "KNOWS".into(),
                        from: "n1".into(),
                        to: "n1".into(),
                        properties_json: r#"{"since":2020}"#.into(),
                    }],
                    paths: vec![pb::GraphPath { nodes: vec!["n1".into()], edges: vec![] }],
                })),
            },
            pb::QueryChunk {
                part: Some(pb::query_chunk::Part::Error(pb::Error {
                    kind: pb::ErrorKind::Rejected as i32,
                    detail: Some(pb::Detail {
                        reason: "query.write_refused".into(),
                        params: [("clause".into(), "CREATE".into())].into(),
                        message: "writing is not allowed".into(),
                    }),
                })),
            },
        ];
        for chunk in &chunks {
            assert_eq!(&round_trip(chunk), chunk);
        }
    }

    #[test]
    fn an_empty_map_and_no_map_stay_apart() {
        let with_empty = pb::FrameField { labels: Some(pb::StringMap::default()), ..Default::default() };
        let without = pb::FrameField::default();
        let decode = |f: &pb::FrameField| pb::FrameField::decode(f.encode_to_vec().as_slice()).unwrap();
        assert_eq!(decode(&with_empty).labels, Some(pb::StringMap::default()));
        assert_eq!(decode(&without).labels, None);
    }

    #[test]
    fn the_service_has_the_capability_rpcs() {
        // The generated server trait names every RPC; a renamed one breaks plugins.
        let names = ["Describe", "CheckSettings", "Health", "Schema", "Query", "CheckOnSave", "Watch", "Release"];
        let source = include_str!("../proto/kalzit/plugin/datasource/v1/datasource.proto");
        for name in names {
            assert!(source.contains(&format!("rpc {name}(")), "{name} is missing");
        }
        assert_eq!(pb::Capability::try_from(1), Ok(pb::Capability::CheckOnSave));
        assert_eq!(pb::Capability::try_from(2), Ok(pb::Capability::Watch));
    }
}
