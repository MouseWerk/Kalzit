//! The SDK as Kalzit sees it: a plugin served on a real pipe (Windows, created by the host as
//! Kalzit does) or Unix socket (Linux), called through the generated client with the token, as
//! the host calls it.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures_util::StreamExt;
use kalzit_plugin_sdk::pb::data_source_client::DataSourceClient;
use kalzit_plugin_sdk::{
    Capability, Config, Connection, Context, DataSource, Description, Error, Field, FieldType, Finished, Health, Query,
    Results, Shape, Value, pb,
};
use serde_json::json;
use tonic::transport::Channel;

struct Probe;

impl DataSource for Probe {
    fn describe(&self) -> Description {
        Description::new("dev.example.sdk-probe")
            .shape(Shape::Frame)
            .shape(Shape::Documents)
            .capability(Capability::Watch)
    }

    async fn health(&self, ctx: &Context, conn: &Connection) -> Result<Health, Error> {
        if conn.secret("password") != Some("geheim") {
            return Err(Error::failed("source.error", "wrong password"));
        }
        Ok(Health::connected("Probe", ctx.host().version.clone()))
    }

    async fn query(&self, _ctx: Context, query: Query, out: Results) -> Result<Finished, Error> {
        match query.query["do"].as_str().unwrap_or_default() {
            "rows" => {
                let mut frame = out.frame(vec![Field::new("n", FieldType::Number)]).await?;
                for i in 0..query.query["n"].as_u64().unwrap_or(3) {
                    if frame.row(vec![json!(i)]).await?.is_full() {
                        break;
                    }
                }
                frame.finish().await
            }
            "documents" => {
                let mut docs = out.documents().await?;
                let _ = docs.document(json!({ "z": 1, "a": "zwei" })).await?;
                docs.finish().await
            }
            "sleep" => {
                tokio::time::sleep(Duration::from_secs(30)).await;
                Err(Error::source("woke up"))
            }
            _ => Err(Error::invalid_query("unknown")),
        }
    }
}

#[cfg(windows)]
fn address() -> String {
    format!(
        r"\\.\pipe\kalzit-sdk-test-{}-{}",
        std::process::id(),
        SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
    )
}

#[cfg(unix)]
fn address() -> String {
    let dir = std::env::temp_dir().join(format!("kalzit-sdk-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    dir.join(format!("s{}", SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos() % 1_000_000))
        .to_string_lossy()
        .into_owned()
}

/// A channel over `connector`, retried while the plugin starts.
macro_rules! connect {
    ($connector:expr) => {{
        let connector = $connector;
        let mut channel = None;
        for _ in 0..100 {
            if let Ok(c) = tonic::transport::Endpoint::from_static("http://kalzit-plugin.invalid")
                .connect_with_connector(connector.clone())
                .await
            {
                channel = Some(c);
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        channel.expect("the plugin does not listen")
    }};
}

/// Windows: Kalzit creates the pipe and waits for the plugin to connect, as the host does.
#[cfg(windows)]
async fn channel(address: String) -> Channel {
    use tokio::net::windows::named_pipe::ServerOptions;
    let first = std::sync::Arc::new(std::sync::Mutex::new(Some(
        ServerOptions::new().first_pipe_instance(true).create(&address).unwrap(),
    )));
    let connector = tower::service_fn(move |_: tonic::transport::Uri| {
        let (address, first) = (address.clone(), first.clone());
        async move {
            let waiting = first.lock().unwrap().take();
            let server = match waiting {
                Some(server) => server,
                None => ServerOptions::new().create(&address)?,
            };
            server.connect().await?;
            Ok::<_, std::io::Error>(hyper_util::rt::TokioIo::new(server))
        }
    });
    connect!(connector)
}

#[cfg(unix)]
async fn channel(address: String) -> Channel {
    let connector = tower::service_fn(move |_: tonic::transport::Uri| {
        let address = address.clone();
        async move { tokio::net::UnixStream::connect(&address).await.map(hyper_util::rt::TokioIo::new) }
    });
    connect!(connector)
}

fn with_token<T>(message: T, token: &str) -> tonic::Request<T> {
    let mut r = tonic::Request::new(message);
    r.metadata_mut().insert("kalzit-plugin-token", token.parse().unwrap());
    r
}

fn query(q: Value, deadline_ms: i64) -> pb::QueryRequest {
    pb::QueryRequest {
        connection: Some(pb::Connection {
            datasource_id: "ds".into(),
            revision: 1,
            settings_json: "{}".into(),
            ..Default::default()
        }),
        ref_id: "A".into(),
        query_json: q.to_string(),
        limits: Some(pb::Limits { timeout_ms: 5000, max_rows: 5, max_response_bytes: 1 << 20 }),
        deadline_unix_ms: deadline_ms,
        ..Default::default()
    }
}

async fn parts(
    client: &mut DataSourceClient<Channel>,
    request: tonic::Request<pb::QueryRequest>,
) -> Vec<pb::query_chunk::Part> {
    let mut stream = client.query(request).await.unwrap().into_inner();
    let mut out = Vec::new();
    while let Some(chunk) = stream.next().await {
        out.push(chunk.unwrap().part.unwrap());
    }
    out
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_plugin_answers_the_host_with_its_token_only() {
    let address = address();
    let token = "t0ken-of-this-start";
    let config = Config { address: address.clone(), token: token.into(), host_pid: std::process::id() };
    let server = tokio::spawn(kalzit_plugin_sdk::serve(Probe, config));
    let mut client = DataSourceClient::new(channel(address).await);

    // Without the token, or with another one, nothing is answered.
    let refused = client.describe(pb::DescribeRequest::default()).await.unwrap_err();
    assert_eq!(refused.code(), tonic::Code::Unauthenticated);
    let refused = client.describe(with_token(pb::DescribeRequest::default(), "t0ken-of-this-starT")).await.unwrap_err();
    assert_eq!(refused.code(), tonic::Code::Unauthenticated);

    let host =
        pb::DescribeRequest { protocol_version: 1, host_version: "0.4.0".into(), protocol_minor: 0, features: vec![] };
    let d = client.describe(with_token(host, token)).await.unwrap().into_inner();
    assert_eq!(d.kind, "dev.example.sdk-probe");
    assert_eq!(d.protocol_version, 1);
    assert_eq!(d.shapes, [pb::Shape::Frame as i32, pb::Shape::Documents as i32]);
    assert_eq!(d.capabilities, [pb::Capability::Watch as i32]);

    // Health sees the secret and what the host announced.
    let conn =
        pb::Connection { secrets: [("password".to_string(), "geheim".to_string())].into(), ..Default::default() };
    let h = client
        .health(with_token(pb::HealthRequest { connection: Some(conn), deadline_unix_ms: 0 }, token))
        .await
        .unwrap()
        .into_inner();
    assert!(h.ok, "{h:?}");
    assert_eq!(h.detail.unwrap().params["version"], "0.4.0");
    let h = client.health(with_token(pb::HealthRequest::default(), token)).await.unwrap().into_inner();
    assert_eq!((h.ok, h.error.unwrap().kind), (false, pb::ErrorKind::Failed as i32));

    // A frame within the row limit: one row more than the limit goes out, then the end.
    let got = parts(&mut client, with_token(query(json!({ "do": "rows", "n": 100 }), 0), token)).await;
    assert!(matches!(got.first(), Some(pb::query_chunk::Part::Start(_))));
    assert!(matches!(got.last(), Some(pb::query_chunk::Part::End(_))));
    let rows: Vec<String> = got
        .iter()
        .filter_map(|p| match p {
            pb::query_chunk::Part::FrameRows(r) => Some(r.columns_json[0].clone()),
            _ => None,
        })
        .collect();
    assert_eq!(rows, ["[0,1,2,3,4,5]"]);

    let got = parts(&mut client, with_token(query(json!({ "do": "documents" }), 0), token)).await;
    let pb::query_chunk::Part::Documents(docs) = &got[1] else { panic!("{got:?}") };
    assert_eq!(docs.documents_json, [r#"{"a":"zwei","z":1}"#]);

    // An error of the plugin is the result's only part.
    let got = parts(&mut client, with_token(query(json!({ "do": "nope" }), 0), token)).await;
    let [pb::query_chunk::Part::Error(e)] = got.as_slice() else { panic!("{got:?}") };
    assert_eq!(e.detail.as_ref().unwrap().reason, "query.invalid_form");

    // The deadline ends a call that runs too long, with a timeout.
    let soon = (SystemTime::now() + Duration::from_millis(300)).duration_since(UNIX_EPOCH).unwrap().as_millis() as i64;
    let started = std::time::Instant::now();
    let got = parts(&mut client, with_token(query(json!({ "do": "sleep" }), soon), token)).await;
    let [pb::query_chunk::Part::Error(e)] = got.as_slice() else { panic!("{got:?}") };
    assert_eq!(e.kind, pb::ErrorKind::Timeout as i32);
    assert!(started.elapsed() < Duration::from_secs(10));

    // A request the plugin cannot read is a broken call.
    let mut bad = query(Value::Null, 0);
    bad.query_json = "{".into();
    let status = client.query(with_token(bad, token)).await.unwrap_err();
    assert_eq!(status.code(), tonic::Code::InvalidArgument);

    // Schema is not implemented by this plugin; the watch default says "poll".
    let status = client.schema(with_token(pb::SchemaRequest::default(), token)).await.unwrap_err();
    assert_eq!(status.code(), tonic::Code::Unimplemented);
    let watch = pb::WatchRequest { query: Some(query(json!({}), 0)), resume_token: None };
    let mut feed = client.watch(with_token(watch, token)).await.unwrap().into_inner();
    let first = feed.next().await.unwrap().unwrap();
    assert!(matches!(first.event, Some(pb::watch_event::Event::Unsupported(_))));

    server.abort();
}

#[tokio::test]
async fn another_process_is_refused() {
    // The host is another process: this test's own connection is not the host's and stays
    // unanswered.
    let address = address();
    let config = Config { address: address.clone(), token: "x".into(), host_pid: std::process::id() + 1 };
    let server = tokio::spawn(kalzit_plugin_sdk::serve(Probe, config));
    let channel = channel(address).await;
    let mut client = DataSourceClient::new(channel);
    let call = client.describe(with_token(pb::DescribeRequest::default(), "x"));
    let answer = tokio::time::timeout(Duration::from_secs(3), call).await;
    assert!(!matches!(answer, Ok(Ok(_))), "a process other than the host was answered");
    server.abort();
}
