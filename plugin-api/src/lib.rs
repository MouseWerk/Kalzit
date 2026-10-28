//! The Kalzit plugin contract (docs/ARCHITECTURE.md, "Plugins"): the data source protocol that
//! plugin processes serve over gRPC, the plugin manifest with its validator, the signing and
//! trust rules, and the catalog index. The server and plugin SDKs share this crate; the host
//! itself (processes, sandbox, catalog downloads) lives in the server.

pub mod catalog;
pub mod connector;
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

/// The minor version of protocol 1 this crate speaks: additions up to it are understood. A host
/// announces it in `DescribeRequest.protocol_minor`, and a plugin uses no addition above it.
pub const PROTOCOL_MINOR: u32 = 1;

/// Additions of protocol 1 by name, as a host announces them in `DescribeRequest.features`.
/// Minor 1: `network_connector` (`connector`).
pub const FEATURES: &[&str] = &[connector::FEATURE];

/// The protocol versions a host of this crate accepts from a plugin.
pub const SUPPORTED_PROTOCOL_VERSIONS: &[u32] = &[1];

/// The largest message either side decodes (`max_decoding_message_size`). Plugins cut result
/// batches well below it; the host refuses larger messages.
pub const MAX_MESSAGE_BYTES: usize = 16 * 1024 * 1024;

/// The size a result part aims for, so batches stay far below `MAX_MESSAGE_BYTES`.
pub const TARGET_PART_BYTES: usize = 1024 * 1024;

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

    /// What a host of this version sees of a newer plugin's additions: an unknown part decodes
    /// as no part and an unknown enum value as its number, so the host can skip or map them.
    #[test]
    fn additions_of_newer_minor_versions_decode_safely() {
        // Field 99 (a part this version does not know), length-delimited and empty.
        let future_part = [0x9a, 0x06, 0x00];
        let chunk = pb::QueryChunk::decode(future_part.as_slice()).expect("decodes");
        assert_eq!(chunk.part, None);

        let notice = pb::Notice { severity: 7, code: "x.y".into(), ..Default::default() };
        let back = pb::Notice::decode(notice.encode_to_vec().as_slice()).unwrap();
        assert_eq!(back.severity, 7);
        assert!(pb::NoticeSeverity::try_from(back.severity).is_err());

        const { assert!(super::TARGET_PART_BYTES * 8 <= super::MAX_MESSAGE_BYTES) };
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
