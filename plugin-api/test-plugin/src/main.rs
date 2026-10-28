//! A data source plugin for the host's contract tests (server/tests/plugins.rs). It serves the
//! protocol like a real plugin, and misbehaves on request:
//!
//! - At start, by `mode.txt` next to the binary (a file of the package): `normal`, `crash` (exits
//!   before the handshake), `hang` (never says ready), `bad_handshake`, `wrong_kind` (`Describe`
//!   names another kind), `newer_protocol` (says ready for protocol 2).
//! - Per query, by `{"do": ...}`: `frame`, `documents`, `graph`, `rows` (`n` rows), `crash`,
//!   `hang`, `flood` (stderr), `malformed` (rows before the start), `endless` (parts that never
//!   end), `no_end`, `child` (starts a child process and answers its id), `spawn_many`, `write`
//!   and `read` (`path`), `env` (the names of its environment), `ptrace` (Linux), and the network:
//!   `net_direct` (a TCP connection of its own to `host`:`port`, which the sandbox must refuse),
//!   `net_connect` (through Kalzit's connector; `wait` then waits for an idle close) and
//!   `net_many` (`n` connections at once, against the connector's limit).
//!
//! Like a real plugin it serves only Kalzit's process (`KALZIT_PLUGIN_HOST_PID`: the peer of its
//! Unix socket on Linux, the server of the pipe it connects to on Windows) and refuses calls
//! without the start's token.
//!
//! Started with the argument `sleep`, it only sleeps: the child of `child`.

use std::collections::BTreeMap;
use std::pin::Pin;
use std::time::Duration;

use futures_util::{Stream, stream};
use kalzit_plugin_api::connector::{ConnectError, Connector, Stream as NetStream};
use kalzit_plugin_api::datasource::v1 as pb;
use kalzit_plugin_api::datasource::v1::data_source_server::{DataSource, DataSourceServer};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tonic::{Request, Response, Status};

const KIND_FILE: &str = "kind.txt";
const MODE_FILE: &str = "mode.txt";

type Parts<T> = Pin<Box<dyn Stream<Item = Result<T, Status>> + Send>>;

struct Plugin {
    kind: String,
    wrong_kind: bool,
    /// Kalzit's process id.
    host: u32,
}

fn chunk(part: pb::query_chunk::Part) -> Result<pb::QueryChunk, Status> {
    Ok(pb::QueryChunk { part: Some(part) })
}

fn start(shape: pb::Shape, fields: Vec<pb::FrameField>) -> pb::query_chunk::Part {
    pb::query_chunk::Part::Start(pb::ResultStart { shape: shape as i32, frame_fields: fields })
}

fn number_field(name: &str) -> pb::FrameField {
    pb::FrameField { name: name.into(), r#type: pb::FieldType::Number as i32, unit: None, labels: None }
}

fn frame_end() -> pb::query_chunk::Part {
    pb::query_chunk::Part::End(pb::ResultEnd { meta: Some(pb::result_end::Meta::Frame(pb::FrameEnd { meta: None })) })
}

/// A documents result with these documents, as JSON objects.
fn documents(docs: Vec<Value>) -> Vec<Result<pb::QueryChunk, Status>> {
    vec![
        chunk(start(pb::Shape::Documents, vec![])),
        chunk(pb::query_chunk::Part::Documents(pb::DocumentBatch {
            documents_json: docs.iter().map(Value::to_string).collect(),
        })),
        chunk(pb::query_chunk::Part::End(pb::ResultEnd {
            meta: Some(pb::result_end::Meta::Documents(pb::DocumentsEnd::default())),
        })),
    ]
}

fn error(kind: pb::ErrorKind, reason: &str, message: &str) -> pb::Error {
    pb::Error {
        kind: kind as i32,
        detail: Some(pb::Detail { reason: reason.into(), params: BTreeMap::new(), message: message.into() }),
    }
}

/// `n` rows of one number column, in batches of 1000.
fn rows(n: u64) -> Vec<Result<pb::QueryChunk, Status>> {
    let mut out = vec![chunk(start(pb::Shape::Frame, vec![number_field("n")]))];
    let mut at = 0;
    while at < n {
        let end = (at + 1000).min(n);
        let values: Vec<u64> = (at..end).collect();
        out.push(chunk(pb::query_chunk::Part::FrameRows(pb::FrameRows {
            columns_json: vec![serde_json::to_string(&values).unwrap()],
        })));
        at = end;
    }
    out.push(chunk(frame_end()));
    out
}

fn try_write(path: &str) -> Value {
    match std::fs::write(path, b"written by the test plugin") {
        Ok(()) => json!({ "ok": true }),
        Err(e) => json!({ "ok": false, "error": e.to_string() }),
    }
}

fn try_read(path: &str) -> Value {
    match std::fs::read(path) {
        Ok(bytes) => json!({ "ok": true, "bytes": bytes.len() }),
        Err(e) => json!({ "ok": false, "error": e.to_string() }),
    }
}

fn sleeping_child() -> std::io::Result<std::process::Child> {
    std::process::Command::new(std::env::current_exe()?)
        .arg("sleep")
        // Pipes, not the NUL device: an AppContainer process may not open NUL on every Windows
        // (Windows Server refuses it).
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
}

/// Whether this process can open Kalzit's process (or another one) to read its memory.
#[cfg(windows)]
fn open_host(host: u32) -> Value {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{OpenProcess, PROCESS_VM_READ};
    // SAFETY: an open attempt; a handle that opened is closed at once.
    match unsafe { OpenProcess(PROCESS_VM_READ, false, host) } {
        Ok(h) => {
            // SAFETY: the handle was just opened.
            let _ = unsafe { CloseHandle(h) };
            json!({ "ok": true })
        }
        Err(e) => json!({ "ok": false, "error": e.to_string() }),
    }
}

/// Whether this process can read Kalzit's environment or memory through `/proc`.
#[cfg(unix)]
fn open_host(host: u32) -> Value {
    let environ = std::fs::read(format!("/proc/{host}/environ")).is_ok();
    let mem = std::fs::File::open(format!("/proc/{host}/mem")).is_ok();
    json!({ "ok": environ || mem, "environ": environ, "mem": mem })
}

/// Whether this process may send a signal to Kalzit (signal 0 only checks).
#[cfg(unix)]
fn signal_host(host: u32) -> Value {
    // SAFETY: signal 0 delivers nothing.
    let r = unsafe { libc::kill(host as libc::pid_t, 0) };
    json!({ "ok": r == 0, "errno": if r == 0 { 0 } else { std::io::Error::last_os_error().raw_os_error().unwrap_or(0) } })
}

/// Whether this process can move into Kalzit's process group (where `kill(0)` would reach
/// Kalzit). Only signal 0 is sent, should it succeed.
#[cfg(unix)]
fn join_host_group(host: u32) -> Value {
    // SAFETY: plain process group calls; signal 0 delivers nothing.
    unsafe {
        let group = libc::getpgid(host as libc::pid_t);
        let joined = libc::setpgid(0, group) == 0;
        let errno = std::io::Error::last_os_error().raw_os_error().unwrap_or(0);
        let reached = joined && libc::kill(0, 0) == 0;
        json!({ "ok": joined, "reached": reached, "errno": if joined { 0 } else { errno } })
    }
}

#[cfg(not(unix))]
fn join_host_group(_host: u32) -> Value {
    json!({ "ok": false })
}

#[cfg(not(unix))]
fn signal_host(_host: u32) -> Value {
    json!({ "ok": false })
}

/// Whether this process can reach a Unix socket of the host by its path (Linux).
#[cfg(unix)]
fn unix_connect(path: &str) -> Value {
    match std::os::unix::net::UnixStream::connect(path) {
        Ok(_) => json!({ "ok": true }),
        Err(e) => json!({ "ok": false, "error": e.to_string() }),
    }
}

#[cfg(not(unix))]
fn unix_connect(_path: &str) -> Value {
    json!({ "ok": false, "error": "not on this system" })
}

/// Whether this process can make a datagram socket pair (which could `sendto` a datagram socket
/// of the host by its path).
#[cfg(target_os = "linux")]
fn dgram_pair() -> Value {
    let mut fds = [0 as libc::c_int; 2];
    // SAFETY: `fds` has room for both ends; they are closed at once.
    let r = unsafe { libc::socketpair(libc::AF_UNIX, libc::SOCK_DGRAM, 0, fds.as_mut_ptr()) };
    let errno = std::io::Error::last_os_error().raw_os_error().unwrap_or(0);
    if r == 0 {
        // SAFETY: both were just made.
        unsafe {
            libc::close(fds[0]);
            libc::close(fds[1]);
        }
    }
    json!({ "ok": r == 0, "errno": if r == 0 { 0 } else { errno } })
}

#[cfg(not(target_os = "linux"))]
fn dgram_pair() -> Value {
    json!({ "ok": false, "errno": -1 })
}

/// Whether a connection the connector handed over can be pointed elsewhere: `connect` with
/// `AF_UNSPEC` (disconnect) and then to `127.0.0.1:port` (Linux).
#[cfg(target_os = "linux")]
async fn net_repoint(ds: &str, q: &Value) -> Value {
    use std::os::fd::AsRawFd;
    let Some(connector) = Connector::from_env() else { return json!({ "ok": false, "reason": "no_connector" }) };
    let host = q["host"].as_str().unwrap_or_default();
    let port = q["port"].as_u64().unwrap_or(0) as u16;
    let (stream, _) = match connector.connect(ds, host, port, pb::TargetProtocol::Tcp).await {
        Ok(connected) => connected,
        Err(e) => return connect_failed(e),
    };
    let fd = stream.as_raw_fd();
    // SAFETY: plain connect calls on an open descriptor with addresses on the stack.
    let (unspec, inet) = unsafe {
        let mut unspec: libc::sockaddr = std::mem::zeroed();
        unspec.sa_family = libc::AF_UNSPEC as libc::sa_family_t;
        let a = libc::connect(fd, &raw const unspec, std::mem::size_of::<libc::sockaddr>() as libc::socklen_t);
        let a_errno = std::io::Error::last_os_error().raw_os_error().unwrap_or(0);
        let mut inet: libc::sockaddr_in = std::mem::zeroed();
        inet.sin_family = libc::AF_INET as libc::sa_family_t;
        inet.sin_port = port.to_be();
        inet.sin_addr.s_addr = u32::from(std::net::Ipv4Addr::LOCALHOST).to_be();
        let b =
            libc::connect(fd, (&raw const inet).cast(), std::mem::size_of::<libc::sockaddr_in>() as libc::socklen_t);
        let b_errno = std::io::Error::last_os_error().raw_os_error().unwrap_or(0);
        ((a, a_errno), (b, b_errno))
    };
    json!({ "ok": unspec.0 == 0 || inet.0 == 0, "unspec": unspec.1, "inet": inet.1 })
}

#[cfg(not(target_os = "linux"))]
async fn net_repoint(_ds: &str, _q: &Value) -> Value {
    json!({ "ok": false })
}

#[cfg(target_os = "linux")]
fn ptrace_traceme() -> Value {
    // SAFETY: PTRACE_TRACEME takes no pointers; it only marks this process as traceable.
    let r = unsafe { libc::ptrace(libc::PTRACE_TRACEME, 0, 0, 0) };
    let errno = std::io::Error::last_os_error().raw_os_error().unwrap_or(0);
    json!({ "ok": r == 0, "errno": if r == 0 { 0 } else { errno } })
}

#[cfg(not(target_os = "linux"))]
fn ptrace_traceme() -> Value {
    json!({ "ok": false, "errno": -1 })
}

/// Whether this process can open a TCP connection itself, past Kalzit's connector.
async fn net_direct(host: &str, port: u16) -> Value {
    match tokio::time::timeout(Duration::from_secs(5), tokio::net::TcpStream::connect((host, port))).await {
        Ok(Ok(_)) => json!({ "ok": true }),
        Ok(Err(e)) => json!({ "ok": false, "error": e.to_string() }),
        Err(_) => json!({ "ok": false, "error": "no answer within 5 seconds" }),
    }
}

/// A refused or failed connect as the probes answer it.
fn connect_failed(e: ConnectError) -> Value {
    match e {
        ConnectError::Refused(e) => {
            let detail = e.detail.unwrap_or_default();
            json!({ "ok": false, "kind": e.kind, "reason": detail.reason, "message": detail.message })
        }
        other => json!({ "ok": false, "reason": "error", "message": other.to_string() }),
    }
}

/// One line out, one line back.
async fn exchange(stream: &mut NetStream) -> std::io::Result<String> {
    stream.write_all(b"ping\n").await?;
    let mut reply = Vec::new();
    let mut byte = [0u8; 1];
    while stream.read(&mut byte).await? == 1 && byte[0] != b'\n' {
        reply.push(byte[0]);
    }
    Ok(String::from_utf8_lossy(&reply).into_owned())
}

/// Through Kalzit's connector: connects for the data source `ds` to `q.host:q.port` (`q.protocol`
/// `tcp` or `tls`), exchanges a line, and with `q.wait` (seconds) then waits for Kalzit to close
/// the idle connection.
async fn net_connect(ds: &str, q: &Value) -> Value {
    let Some(connector) = Connector::from_env() else { return json!({ "ok": false, "reason": "no_connector" }) };
    let protocol = if q["protocol"] == "tls" { pb::TargetProtocol::Tls } else { pb::TargetProtocol::Tcp };
    let host = q["host"].as_str().unwrap_or_default();
    let port = q["port"].as_u64().unwrap_or(0) as u16;
    let (mut stream, address) = match connector.connect(ds, host, port, protocol).await {
        Ok(connected) => connected,
        Err(e) => return connect_failed(e),
    };
    let reply = match tokio::time::timeout(Duration::from_secs(5), exchange(&mut stream)).await {
        Ok(Ok(reply)) => reply,
        Ok(Err(e)) => return json!({ "ok": false, "reason": "exchange", "message": e.to_string() }),
        Err(_) => return json!({ "ok": false, "reason": "exchange", "message": "no reply within 5 seconds" }),
    };
    let mut answer = json!({ "ok": true, "address": address, "reply": reply });
    if let Some(wait) = q["wait"].as_u64() {
        let mut byte = [0u8; 1];
        let closed = match tokio::time::timeout(Duration::from_secs(wait), stream.read(&mut byte)).await {
            Ok(Ok(0) | Err(_)) => true,
            Ok(Ok(_)) | Err(_) => false,
        };
        answer["closed"] = json!(closed);
    }
    answer
}

/// Opens `q.n` connections through the connector and holds them until all are tried: how many
/// opened, and why the first refused one was refused.
async fn net_many(ds: &str, q: &Value) -> Value {
    let Some(connector) = Connector::from_env() else { return json!({ "ok": false, "reason": "no_connector" }) };
    let host = q["host"].as_str().unwrap_or_default();
    let port = q["port"].as_u64().unwrap_or(0) as u16;
    let mut held = Vec::new();
    let mut refused = Value::Null;
    for _ in 0..q["n"].as_u64().unwrap_or(1) {
        match connector.connect(ds, host, port, pb::TargetProtocol::Tcp).await {
            Ok((stream, _)) => held.push(stream),
            Err(e) => {
                if refused.is_null() {
                    refused = connect_failed(e);
                }
            }
        }
    }
    json!({ "opened": held.len(), "refused": refused })
}

#[tonic::async_trait]
impl DataSource for Plugin {
    async fn describe(&self, _: Request<pb::DescribeRequest>) -> Result<Response<pb::DescribeResponse>, Status> {
        let kind = if self.wrong_kind { "dev.example.other".to_string() } else { self.kind.clone() };
        Ok(Response::new(pb::DescribeResponse {
            protocol_version: kalzit_plugin_api::PROTOCOL_VERSION,
            kind,
            shapes: vec![pb::Shape::Frame as i32, pb::Shape::Documents as i32, pb::Shape::Graph as i32],
            capabilities: vec![],
        }))
    }

    async fn check_settings(
        &self,
        request: Request<pb::CheckSettingsRequest>,
    ) -> Result<Response<pb::CheckSettingsResponse>, Status> {
        let settings: Value = serde_json::from_str(&request.get_ref().settings_json).unwrap_or(Value::Null);
        let error = (settings["host"] == "invalid").then(|| pb::FieldError {
            field: "host".into(),
            detail: Some(pb::Detail {
                reason: "settings.host_invalid".into(),
                params: BTreeMap::new(),
                message: "the host is not valid".into(),
            }),
        });
        Ok(Response::new(pb::CheckSettingsResponse { error }))
    }

    async fn health(&self, request: Request<pb::HealthRequest>) -> Result<Response<pb::HealthResponse>, Status> {
        let c = request.into_inner().connection.unwrap_or_default();
        let settings: Value = serde_json::from_str(&c.settings_json).unwrap_or(Value::Null);
        if settings["host"] == "down" {
            let e = error(pb::ErrorKind::Failed, "testplugin.down", "the test database is down");
            return Ok(Response::new(pb::HealthResponse { ok: false, detail: None, error: Some(e), warnings: vec![] }));
        }
        let detail = pb::Detail {
            reason: "health.connected".into(),
            params: [("engine".to_string(), "Test plugin".to_string()), ("version".to_string(), "1".to_string())]
                .into(),
            message: "Test plugin 1".into(),
        };
        Ok(Response::new(pb::HealthResponse { ok: true, detail: Some(detail), error: None, warnings: vec![] }))
    }

    async fn schema(&self, _: Request<pb::SchemaRequest>) -> Result<Response<pb::SchemaResponse>, Status> {
        let schema =
            json!({ "kind": "tables", "tables": [{ "name": "numbers", "columns": [{ "name": "n", "type": "int" }] }] });
        Ok(Response::new(pb::SchemaResponse {
            result: Some(pb::schema_response::Result::SchemaJson(schema.to_string())),
        }))
    }

    type QueryStream = Parts<pb::QueryChunk>;

    async fn query(&self, request: Request<pb::QueryRequest>) -> Result<Response<Self::QueryStream>, Status> {
        let q = request.into_inner();
        let query: Value = serde_json::from_str(&q.query_json).map_err(|e| Status::invalid_argument(e.to_string()))?;
        let datasource = q.connection.as_ref().map(|c| c.datasource_id.clone()).unwrap_or_default();
        let parts: Vec<Result<pb::QueryChunk, Status>> = match query["do"].as_str().unwrap_or("frame") {
            "frame" => rows(3),
            "rows" => rows(query["n"].as_u64().unwrap_or(10)),
            "documents" => documents(vec![json!({ "z": 1, "a": "zwei" })]),
            "graph" => vec![
                chunk(start(pb::Shape::Graph, vec![])),
                chunk(pb::query_chunk::Part::Graph(pb::GraphBatch {
                    nodes: vec![
                        pb::Node { id: "a".into(), labels: vec!["Person".into()], properties_json: "{}".into() },
                        pb::Node { id: "b".into(), labels: vec!["Person".into()], properties_json: "{}".into() },
                    ],
                    edges: vec![pb::Edge {
                        id: "e".into(),
                        r#type: "KNOWS".into(),
                        from: "a".into(),
                        to: "b".into(),
                        properties_json: "{}".into(),
                    }],
                    paths: vec![],
                })),
                chunk(pb::query_chunk::Part::End(pb::ResultEnd {
                    meta: Some(pb::result_end::Meta::Graph(pb::GraphEnd::default())),
                })),
            ],
            "error" => vec![chunk(pb::query_chunk::Part::Error(error(
                pb::ErrorKind::Rejected,
                "testplugin.refused",
                "the test plugin refuses this query",
            )))],
            "crash" => std::process::exit(9),
            "hang" => {
                tokio::time::sleep(Duration::from_secs(3600)).await;
                rows(1)
            }
            "flood" => {
                for i in 0..20_000 {
                    eprintln!("flood line {i} {}", "x".repeat(200));
                }
                rows(1)
            }
            "malformed" => vec![
                chunk(pb::query_chunk::Part::FrameRows(pb::FrameRows { columns_json: vec!["[1]".into()] })),
                chunk(frame_end()),
            ],
            "no_end" => {
                let mut parts = rows(2);
                parts.pop();
                parts
            }
            "endless" => {
                let head = stream::iter(vec![chunk(start(pb::Shape::Frame, vec![number_field("n")]))]);
                let tail = stream::repeat_with(|| {
                    chunk(pb::query_chunk::Part::FrameRows(pb::FrameRows { columns_json: vec!["[1]".into()] }))
                });
                return Ok(Response::new(Box::pin(futures_util::StreamExt::chain(head, tail))));
            }
            "child" => match sleeping_child() {
                Ok(child) => documents(vec![json!({ "pid": child.id() })]),
                Err(e) => documents(vec![json!({ "error": e.to_string() })]),
            },
            "spawn_many" => {
                let wanted = query["n"].as_u64().unwrap_or(40);
                let mut started = Vec::new();
                let mut failed = 0;
                for _ in 0..wanted {
                    match sleeping_child() {
                        Ok(child) => started.push(child),
                        Err(_) => failed += 1,
                    }
                }
                let n = started.len();
                for mut child in started {
                    let _ = child.kill();
                    let _ = child.wait();
                }
                documents(vec![json!({ "started": n, "failed": failed })])
            }
            "write" => documents(vec![try_write(query["path"].as_str().unwrap_or_default())]),
            "read" => documents(vec![try_read(query["path"].as_str().unwrap_or_default())]),
            "temp" => {
                let path = std::env::temp_dir().join("test-plugin-probe.txt");
                documents(vec![try_write(&path.to_string_lossy())])
            }
            "env" => {
                let names: Vec<String> = std::env::vars_os().map(|(k, _)| k.to_string_lossy().into_owned()).collect();
                documents(vec![json!({ "names": names })])
            }
            "ptrace" => documents(vec![ptrace_traceme()]),
            "open_host" => documents(vec![open_host(self.host)]),
            "signal_host" => documents(vec![signal_host(self.host)]),
            "join_host_group" => documents(vec![join_host_group(self.host)]),
            "tmpdir" => documents(vec![json!({ "path": std::env::temp_dir() })]),
            "open_pid" => documents(vec![open_host(query["pid"].as_u64().unwrap_or(0) as u32)]),
            "net_direct" => documents(vec![
                net_direct(query["host"].as_str().unwrap_or_default(), query["port"].as_u64().unwrap_or(0) as u16)
                    .await,
            ]),
            "net_connect" => documents(vec![net_connect(&datasource, &query).await]),
            "unix_connect" => documents(vec![unix_connect(query["path"].as_str().unwrap_or_default())]),
            "dgram_pair" => documents(vec![dgram_pair()]),
            "net_repoint" => documents(vec![net_repoint(&datasource, &query).await]),
            "net_many" => documents(vec![net_many(&datasource, &query).await]),
            other => return Err(Status::invalid_argument(format!("unknown behaviour {other}"))),
        };
        Ok(Response::new(Box::pin(stream::iter(parts))))
    }

    async fn check_on_save(
        &self,
        _: Request<pb::CheckOnSaveRequest>,
    ) -> Result<Response<pb::CheckOnSaveResponse>, Status> {
        Err(Status::unimplemented("no checks on save"))
    }

    type WatchStream = Parts<pb::WatchEvent>;

    async fn watch(&self, _: Request<pb::WatchRequest>) -> Result<Response<Self::WatchStream>, Status> {
        Err(Status::unimplemented("no change feeds"))
    }

    async fn release(&self, _: Request<pb::ReleaseRequest>) -> Result<Response<pb::ReleaseResponse>, Status> {
        Ok(Response::new(pb::ReleaseResponse {}))
    }
}

/// A file at the root of the package (the binary is in `bin/<platform>/`), trimmed; empty
/// when it is missing.
fn package_file(name: &str) -> String {
    let exe = match std::env::current_exe() {
        Ok(exe) => exe,
        Err(e) => {
            eprintln!("the plugin's own path is unknown: {e}");
            return String::new();
        }
    };
    for dir in exe.ancestors().skip(1).take(3) {
        match std::fs::read_to_string(dir.join(name)) {
            Ok(text) => return text.trim().to_string(),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => eprintln!("{} cannot be read: {e}", dir.join(name).display()),
        }
    }
    String::new()
}

/// Windows: Kalzit creates the pipe and keeps an instance waiting (an AppContainer cannot create
/// pipes); the plugin connects to it as a client, checks that Kalzit's process is the server, and
/// serves the protocol on every connection it makes, with one always ready for the next call.
#[cfg(windows)]
mod listen {
    use std::os::windows::io::AsRawHandle;
    use std::pin::Pin;
    use std::task::{Context, Poll};
    use std::time::Duration;

    use futures_util::Stream;
    use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
    use tokio::net::windows::named_pipe::{ClientOptions, NamedPipeClient};
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::Pipes::{GetNamedPipeServerProcessId, WaitNamedPipeW};
    use windows::core::HSTRING;

    const ERROR_FILE_NOT_FOUND: i32 = 2;
    const ERROR_PIPE_BUSY: i32 = 231;

    /// One connection to Kalzit's pipe, as tonic serves a connection.
    pub struct Pipe(NamedPipeClient);

    impl tonic::transport::server::Connected for Pipe {
        type ConnectInfo = ();
        fn connect_info(&self) {}
    }

    impl AsyncRead for Pipe {
        fn poll_read(
            mut self: Pin<&mut Self>,
            cx: &mut Context<'_>,
            buf: &mut ReadBuf<'_>,
        ) -> Poll<std::io::Result<()>> {
            Pin::new(&mut self.0).poll_read(cx, buf)
        }
    }

    impl AsyncWrite for Pipe {
        fn poll_write(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &[u8]) -> Poll<std::io::Result<usize>> {
            Pin::new(&mut self.0).poll_write(cx, buf)
        }
        fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
            Pin::new(&mut self.0).poll_flush(cx)
        }
        fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
            Pin::new(&mut self.0).poll_shutdown(cx)
        }
    }

    /// The process id of the pipe's server.
    fn server_pid(client: &NamedPipeClient) -> Option<u32> {
        let mut pid = 0u32;
        // SAFETY: the handle is open for the call; pid is a valid out pointer.
        unsafe { GetNamedPipeServerProcessId(HANDLE(client.as_raw_handle()), &mut pid) }.ok()?;
        Some(pid)
    }

    /// The next connection to Kalzit: waits (in the kernel, up to a second at a time) while every
    /// instance is taken.
    async fn dial(address: &str, host: u32) -> Pipe {
        loop {
            match ClientOptions::new().open(address) {
                Ok(client) if server_pid(&client) == Some(host) => return Pipe(client),
                Ok(_) => {
                    eprintln!("the pipe's server is not Kalzit's process");
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
                Err(e) if e.raw_os_error() == Some(ERROR_PIPE_BUSY) => {
                    let name = HSTRING::from(address);
                    // SAFETY: a plain wait on the pipe's name, which lives for the call.
                    let _ = tokio::task::spawn_blocking(move || unsafe { WaitNamedPipeW(&name, 1000) }).await;
                }
                Err(e) if e.raw_os_error() == Some(ERROR_FILE_NOT_FOUND) => {
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
                Err(e) => {
                    eprintln!("Kalzit's pipe cannot be opened: {e}");
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
            }
        }
    }

    /// Every connection to Kalzit's pipe, one after the other.
    pub fn incoming(address: &str, host: u32) -> std::io::Result<impl Stream<Item = std::io::Result<Pipe>>> {
        let address = address.to_string();
        Ok(futures_util::stream::unfold(address, move |address| async move {
            let pipe = dial(&address, host).await;
            Some((Ok(pipe), address))
        }))
    }
}

#[cfg(unix)]
mod listen {
    use futures_util::{Stream, StreamExt};
    use tokio::net::UnixStream;

    /// The one connection Kalzit handed over as `fd:<n>`, then none (the sandbox allows no
    /// socket of the plugin's own; the pair reaches only Kalzit).
    pub fn incoming(address: &str, _host: u32) -> std::io::Result<impl Stream<Item = std::io::Result<UnixStream>>> {
        let fd: std::os::fd::RawFd = address
            .strip_prefix("fd:")
            .and_then(|n| n.parse().ok())
            .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "the address is not fd:<n>"))?;
        // SAFETY: the inherited descriptor belongs to this process and is taken over once.
        let stream = unsafe { <std::os::unix::net::UnixStream as std::os::fd::FromRawFd>::from_raw_fd(fd) };
        // A copy that closes on exec, so programs the plugin starts do not get the connection.
        let stream = {
            let copy = stream.try_clone()?;
            drop(stream);
            copy
        };
        stream.set_nonblocking(true)?;
        let stream = UnixStream::from_std(stream)?;
        Ok(futures_util::stream::once(async move { Ok(stream) }).chain(futures_util::stream::pending()))
    }
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    if std::env::args().nth(1).as_deref() == Some("sleep") {
        tokio::time::sleep(Duration::from_secs(600)).await;
        return;
    }
    let mode = package_file(MODE_FILE);
    let kind = package_file(KIND_FILE);
    match mode.as_str() {
        "crash" => {
            eprintln!("the test plugin crashes at start");
            std::process::exit(3);
        }
        "hang" => {
            tokio::time::sleep(Duration::from_secs(3600)).await;
            return;
        }
        "bad_handshake" => {
            println!("hello");
            tokio::time::sleep(Duration::from_secs(3600)).await;
            return;
        }
        _ => {}
    }
    let address = std::env::var("KALZIT_PLUGIN_ADDRESS").expect("KALZIT_PLUGIN_ADDRESS is set");
    let token = std::env::var("KALZIT_PLUGIN_TOKEN").expect("KALZIT_PLUGIN_TOKEN is set");
    let host: u32 = std::env::var("KALZIT_PLUGIN_HOST_PID")
        .ok()
        .and_then(|p| p.parse().ok())
        .expect("KALZIT_PLUGIN_HOST_PID is set");
    let incoming = listen::incoming(&address, host).expect("the plugin listens");
    let plugin = Plugin { kind, wrong_kind: mode == "wrong_kind", host };
    // Every call must carry the token of this start.
    let check =
        move |request: Request<()>| match request.metadata().get("kalzit-plugin-token").and_then(|v| v.to_str().ok()) {
            Some(t) if t == token => Ok(request),
            _ => Err(Status::unauthenticated("the plugin token is missing or wrong")),
        };
    let service = DataSourceServer::with_interceptor(plugin, check);
    let version = if mode == "newer_protocol" { 2 } else { 1 };
    println!("kalzit-plugin {version} ready");
    eprintln!("the test plugin listens");
    let served = tonic::transport::Server::builder().add_service(service).serve_with_incoming(incoming).await;
    if let Err(e) = served {
        eprintln!("serving failed: {e}");
        std::process::exit(1);
    }
}
