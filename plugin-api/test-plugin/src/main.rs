//! A data source plugin for the host's contract tests (server/tests/plugins.rs). It serves the
//! protocol like a real plugin, and misbehaves on request:
//!
//! - At start, by `mode.txt` next to the binary (a file of the package): `normal`, `crash` (exits
//!   before the handshake), `hang` (never says ready), `bad_handshake`, `wrong_kind` (`Describe`
//!   names another kind), `newer_protocol` (says ready for protocol 2).
//! - Per query, by `{"do": ...}`: `frame`, `documents`, `graph`, `rows` (`n` rows), `crash`,
//!   `hang`, `flood` (stderr), `malformed` (rows before the start), `endless` (parts that never
//!   end), `no_end`, `child` (starts a child process and answers its id), `spawn_many`, `write`
//!   and `read` (`path`), `env` (the names of its environment), `ptrace` (Linux).
//!
//! Like a real plugin it accepts connections only from Kalzit's process
//! (`KALZIT_PLUGIN_HOST_PID`), creates its pipe instances with a DACL for Kalzit's account and
//! `RESTRICTED` (Windows), and refuses calls without the start's token.
//!
//! Started with the argument `sleep`, it only sleeps: the child of `child`.

use std::collections::BTreeMap;
use std::pin::Pin;
use std::time::Duration;

use futures_util::{Stream, stream};
use kalzit_plugin_api::datasource::v1 as pb;
use kalzit_plugin_api::datasource::v1::data_source_server::{DataSource, DataSourceServer};
use serde_json::{Value, json};
use tonic::{Request, Response, Status};

const KIND_FILE: &str = "kind.txt";
const MODE_FILE: &str = "mode.txt";

type Parts<T> = Pin<Box<dyn Stream<Item = Result<T, Status>> + Send>>;

struct Plugin {
    kind: String,
    wrong_kind: bool,
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
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
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

#[cfg(windows)]
mod listen {
    use std::pin::Pin;
    use std::task::{Context, Poll};

    use futures_util::Stream;
    use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
    use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};
    use windows::Win32::Foundation::{HANDLE, HLOCAL, LocalFree};
    use windows::Win32::Security::Authorization::{
        ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
    };
    use windows::Win32::Security::{
        GetTokenInformation, PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER, TokenUser,
    };
    use windows::Win32::System::Pipes::GetNamedPipeClientProcessId;
    use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
    use windows::core::{HSTRING, PWSTR};

    /// The SID of the account this process runs as (Kalzit's account).
    fn user_sid() -> String {
        // SAFETY: plain token queries into buffers of the size asked for; the strings are freed.
        unsafe {
            let mut token = HANDLE::default();
            OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).expect("the own token");
            let mut needed = 0u32;
            let _ = GetTokenInformation(token, TokenUser, None, 0, &mut needed);
            let mut buffer = vec![0u64; (needed as usize).div_ceil(8)];
            GetTokenInformation(token, TokenUser, Some(buffer.as_mut_ptr().cast()), needed, &mut needed)
                .expect("the token's user");
            let mut text = PWSTR::null();
            ConvertSidToStringSidW((*buffer.as_ptr().cast::<TOKEN_USER>()).User.Sid, &mut text).expect("a SID");
            let sid = text.to_string().expect("UTF-16");
            LocalFree(Some(HLOCAL(text.0.cast())));
            sid
        }
    }

    /// Creates a pipe instance that only Kalzit's account may open: the account itself, and
    /// `RESTRICTED`, which a plugin's restricted token needs to create the next instance.
    fn create(address: &str, first: bool) -> std::io::Result<NamedPipeServer> {
        let sddl = format!("D:P(A;;GA;;;{})(A;;GA;;;RC)", user_sid());
        let mut sd = PSECURITY_DESCRIPTOR::default();
        // SAFETY: the descriptor is converted from SDDL and lives until the pipe exists.
        unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(&HSTRING::from(sddl), SDDL_REVISION_1, &mut sd, None)
                .map_err(|e| std::io::Error::other(e.to_string()))?;
            let mut attributes = SECURITY_ATTRIBUTES {
                nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
                lpSecurityDescriptor: sd.0,
                bInheritHandle: false.into(),
            };
            let pipe = ServerOptions::new()
                .first_pipe_instance(first)
                .reject_remote_clients(true)
                .create_with_security_attributes_raw(address, (&raw mut attributes).cast());
            LocalFree(Some(HLOCAL(sd.0)));
            pipe
        }
    }

    /// One accepted pipe instance, as tonic serves a connection.
    pub struct Pipe(NamedPipeServer);

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

    /// The process id of the pipe's client.
    fn client_pid(server: &NamedPipeServer) -> Option<u32> {
        use std::os::windows::io::AsRawHandle;
        let mut pid = 0u32;
        // SAFETY: the handle is open for the call; pid is a valid out pointer.
        unsafe { GetNamedPipeClientProcessId(HANDLE(server.as_raw_handle()), &mut pid) }.ok()?;
        Some(pid)
    }

    /// Creates the pipe as its first instance (nobody else can own the name) and yields every
    /// client that is the host, with a fresh instance waiting for the next one.
    pub fn incoming(address: &str, host: u32) -> std::io::Result<impl Stream<Item = std::io::Result<Pipe>>> {
        let first = create(address, true)?;
        let address = address.to_string();
        Ok(futures_util::stream::unfold(Some(first), move |server| {
            let address = address.clone();
            async move {
                let mut server = server?;
                loop {
                    if let Err(e) = server.connect().await {
                        return Some((Err(e), None));
                    }
                    if client_pid(&server) == Some(host) {
                        break;
                    }
                    eprintln!("a connection from another process was refused");
                    server = create(&address, false).ok()?;
                }
                let next = match create(&address, false) {
                    Ok(next) => Some(next),
                    Err(e) => {
                        eprintln!("the next pipe instance could not be created: {e}");
                        None
                    }
                };
                Some((Ok(Pipe(server)), next))
            }
        }))
    }
}

#[cfg(unix)]
mod listen {
    use futures_util::Stream;
    use tokio::net::{UnixListener, UnixStream};

    /// Yields every connection from the host process (SO_PEERCRED); others are closed.
    pub fn incoming(address: &str, host: u32) -> std::io::Result<impl Stream<Item = std::io::Result<UnixStream>>> {
        let listener = UnixListener::bind(address)?;
        Ok(futures_util::stream::unfold(listener, move |listener| async move {
            loop {
                match listener.accept().await {
                    Ok((stream, _)) => {
                        let pid = stream.peer_cred().ok().and_then(|c| c.pid());
                        if pid == i32::try_from(host).ok() {
                            return Some((Ok(stream), listener));
                        }
                        eprintln!("a connection from another process was refused");
                    }
                    Err(e) => return Some((Err(e), listener)),
                }
            }
        }))
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
    let plugin = Plugin { kind, wrong_kind: mode == "wrong_kind" };
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
