//! The gRPC service around a plugin's [`DataSource`]: the token check, one deadline per call,
//! results streamed from the plugin's future (dropped when the host cancels), and errors mapped
//! to the protocol.

use std::future::Future;
use std::io::Write;
use std::pin::Pin;
use std::sync::{Arc, RwLock};
use std::task::{Context as TaskContext, Poll};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures_util::Stream;
use kalzit_plugin_api::MAX_MESSAGE_BYTES;
use kalzit_plugin_api::datasource::v1::data_source_server::{DataSource as Grpc, DataSourceServer};
use tokio::sync::mpsc;
use tonic::service::interceptor::InterceptedService;
use tonic::{Request, Response, Status};

use crate::results::{Results, WatchFeed};
use crate::{Config, Connection, Context, DataSource, Error, ErrorKind, HostInfo, Query, log, pb, transport};

/// Parts that may wait in the channel between the plugin and the connection; the plugin waits
/// when the host reads slower than it writes.
const QUEUE: usize = 4;

/// The handshake line, printed on stdout once the plugin listens.
pub(crate) fn handshake() -> String {
    format!("kalzit-plugin {} ready", kalzit_plugin_api::PROTOCOL_VERSION)
}

/// Compares in time independent of where the texts differ.
pub(crate) fn same_token(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Refuses calls without the start's token.
#[derive(Clone)]
pub(crate) struct TokenCheck(Arc<Vec<u8>>);

impl tonic::service::Interceptor for TokenCheck {
    fn call(&mut self, request: Request<()>) -> Result<Request<()>, Status> {
        match request.metadata().get("kalzit-plugin-token") {
            Some(t) if same_token(t.as_bytes(), &self.0) => Ok(request),
            _ => Err(Status::unauthenticated("the plugin token is missing or wrong")),
        }
    }
}

/// The `grpc-timeout` header: digits and a unit (`H`, `M`, `S`, `m`, `u`, `n`).
pub(crate) fn grpc_timeout(text: &str) -> Option<Duration> {
    let (digits, unit) = text.split_at(text.len().checked_sub(1)?);
    if digits.is_empty() || digits.len() > 8 || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let n: u64 = digits.parse().ok()?;
    Some(match unit {
        "H" => Duration::from_secs(n * 3600),
        "M" => Duration::from_secs(n * 60),
        "S" => Duration::from_secs(n),
        "m" => Duration::from_millis(n),
        "u" => Duration::from_micros(n),
        "n" => Duration::from_nanos(n),
        _ => return None,
    })
}

/// The earlier of the gRPC deadline and `deadline_unix_ms` (0: none).
pub(crate) fn deadline(metadata: &tonic::metadata::MetadataMap, deadline_unix_ms: i64) -> Option<SystemTime> {
    let from_header = metadata
        .get("grpc-timeout")
        .and_then(|v| v.to_str().ok())
        .and_then(grpc_timeout)
        .map(|d| SystemTime::now() + d);
    let from_field = (deadline_unix_ms > 0).then(|| UNIX_EPOCH + Duration::from_millis(deadline_unix_ms as u64));
    match (from_header, from_field) {
        (Some(a), Some(b)) => Some(a.min(b)),
        (a, b) => a.or(b),
    }
}

/// Runs `work` until `deadline`; after it, a timeout.
async fn within<T>(deadline: Option<SystemTime>, work: impl Future<Output = Result<T, Error>>) -> Result<T, Error> {
    let Some(deadline) = deadline else { return work.await };
    let left = deadline.duration_since(SystemTime::now()).unwrap_or_default();
    match tokio::time::timeout(left, work).await {
        Ok(result) => result,
        Err(_) => {
            Err(Error::timeout(format!("the call ran longer than the {} seconds allowed", left.as_secs().max(1))))
        }
    }
}

/// A broken call (not an answer): a missing implementation or a request that does not parse.
fn status(e: &Error) -> Status {
    match e.kind {
        ErrorKind::Unsupported => Status::unimplemented(e.detail.message.clone()),
        _ => Status::invalid_argument(e.detail.message.clone()),
    }
}

/// A stream of parts that drives the plugin's future itself: whatever the plugin sent goes out
/// first, then its future runs on. Dropping the stream (the host cancelled) drops the future.
struct Driven<T, F> {
    rx: mpsc::Receiver<T>,
    work: Option<Pin<Box<F>>>,
    /// The part that ends the stream after the plugin's future finished: an error.
    last: Option<T>,
}

impl<T, F> Stream for Driven<T, F>
where
    F: Future<Output = Option<T>> + Send,
    T: Unpin,
{
    type Item = Result<T, Status>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<Option<Self::Item>> {
        loop {
            if let Poll::Ready(Some(item)) = self.rx.poll_recv(cx) {
                return Poll::Ready(Some(Ok(item)));
            }
            match self.work.as_mut() {
                Some(work) => match work.as_mut().poll(cx) {
                    Poll::Ready(last) => {
                        self.work = None;
                        self.last = last;
                        // The plugin's sender is gone with its future; what it sent is drained
                        // in the next round.
                    }
                    Poll::Pending => return Poll::Pending,
                },
                None => {
                    return match self.rx.poll_recv(cx) {
                        Poll::Ready(Some(item)) => Poll::Ready(Some(Ok(item))),
                        Poll::Ready(None) => Poll::Ready(self.last.take().map(Ok)),
                        Poll::Pending => Poll::Pending,
                    };
                }
            }
        }
    }
}

fn driven<T, F>(rx: mpsc::Receiver<T>, work: F) -> Pin<Box<dyn Stream<Item = Result<T, Status>> + Send>>
where
    F: Future<Output = Option<T>> + Send + 'static,
    T: Unpin + Send + 'static,
{
    Box::pin(Driven { rx, work: Some(Box::pin(work)), last: None })
}

pub(crate) struct Service<P> {
    plugin: Arc<P>,
    host: Arc<RwLock<Arc<HostInfo>>>,
}

impl<P: DataSource> Service<P> {
    pub(crate) fn new(plugin: P) -> Self {
        Self { plugin: Arc::new(plugin), host: Arc::default() }
    }

    fn context(&self, deadline: Option<SystemTime>) -> Context {
        Context::new(deadline, self.host.read().unwrap_or_else(|e| e.into_inner()).clone())
    }
}

type Parts<T> = Pin<Box<dyn Stream<Item = Result<T, Status>> + Send>>;

#[tonic::async_trait]
impl<P: DataSource> Grpc for Service<P> {
    async fn describe(&self, request: Request<pb::DescribeRequest>) -> Result<Response<pb::DescribeResponse>, Status> {
        let r = request.into_inner();
        let info = HostInfo { version: r.host_version, protocol_minor: r.protocol_minor, features: r.features };
        *self.host.write().unwrap_or_else(|e| e.into_inner()) = Arc::new(info);
        let d = self.plugin.describe();
        Ok(Response::new(pb::DescribeResponse {
            protocol_version: kalzit_plugin_api::PROTOCOL_VERSION,
            kind: d.kind,
            shapes: d.shapes.iter().map(|s| s.pb() as i32).collect(),
            capabilities: d
                .capabilities
                .iter()
                .map(|c| match c {
                    crate::Capability::CheckOnSave => pb::Capability::CheckOnSave as i32,
                    crate::Capability::Watch => pb::Capability::Watch as i32,
                })
                .collect(),
        }))
    }

    async fn check_settings(
        &self,
        request: Request<pb::CheckSettingsRequest>,
    ) -> Result<Response<pb::CheckSettingsResponse>, Status> {
        let text = request.into_inner().settings_json;
        let settings: serde_json::Value = if text.is_empty() {
            serde_json::Value::Object(Default::default())
        } else {
            serde_json::from_str(&text)
                .map_err(|e| Status::invalid_argument(format!("the settings are not JSON: {e}")))?
        };
        let error = self
            .plugin
            .check_settings(&settings)
            .err()
            .map(|f| pb::FieldError { field: f.field, detail: Some(f.error.detail.pb()) });
        Ok(Response::new(pb::CheckSettingsResponse { error }))
    }

    async fn health(&self, request: Request<pb::HealthRequest>) -> Result<Response<pb::HealthResponse>, Status> {
        let deadline = deadline(request.metadata(), request.get_ref().deadline_unix_ms);
        let conn = Connection::from_pb(request.into_inner().connection).map_err(|e| status(&e))?;
        let ctx = self.context(deadline);
        let answer = match within(deadline, self.plugin.health(&ctx, &conn)).await {
            Ok(h) => pb::HealthResponse {
                ok: true,
                detail: Some(h.detail.pb()),
                error: None,
                warnings: h.warnings.iter().map(|w| w.pb()).collect(),
            },
            Err(e) if e.kind == ErrorKind::Unsupported => return Err(status(&e)),
            Err(e) => pb::HealthResponse { ok: false, detail: None, error: Some(e.pb()), warnings: vec![] },
        };
        Ok(Response::new(answer))
    }

    async fn schema(&self, request: Request<pb::SchemaRequest>) -> Result<Response<pb::SchemaResponse>, Status> {
        let deadline = deadline(request.metadata(), request.get_ref().deadline_unix_ms);
        let conn = Connection::from_pb(request.into_inner().connection).map_err(|e| status(&e))?;
        let ctx = self.context(deadline);
        let result = match within(deadline, self.plugin.schema(&ctx, &conn)).await {
            Ok(schema) => pb::schema_response::Result::SchemaJson(schema.to_string()),
            Err(e) if e.kind == ErrorKind::Unsupported => return Err(status(&e)),
            Err(e) => pb::schema_response::Result::Error(e.pb()),
        };
        Ok(Response::new(pb::SchemaResponse { result: Some(result) }))
    }

    type QueryStream = Parts<pb::QueryChunk>;

    async fn query(&self, request: Request<pb::QueryRequest>) -> Result<Response<Self::QueryStream>, Status> {
        let deadline = deadline(request.metadata(), request.get_ref().deadline_unix_ms);
        let query = Query::from_pb(request.into_inner()).map_err(|e| status(&e))?;
        let ctx = self.context(deadline);
        let (tx, rx) = mpsc::channel(QUEUE);
        let results = Results::new(tx, query.limits);
        let plugin = self.plugin.clone();
        let work = async move {
            match within(deadline, plugin.query(ctx, query, results)).await {
                Ok(_finished) => None,
                Err(e) => {
                    if e.kind != ErrorKind::Timeout && e.detail.reason != "plugin.cancelled" {
                        log::debug(&format!("a query failed: {e}"));
                    }
                    Some(pb::QueryChunk { part: Some(pb::query_chunk::Part::Error(e.pb())) })
                }
            }
        };
        Ok(Response::new(driven(rx, work)))
    }

    async fn check_on_save(
        &self,
        request: Request<pb::CheckOnSaveRequest>,
    ) -> Result<Response<pb::CheckOnSaveResponse>, Status> {
        let deadline = deadline(request.metadata(), request.get_ref().deadline_unix_ms);
        let conn = Connection::from_pb(request.into_inner().connection).map_err(|e| status(&e))?;
        let ctx = self.context(deadline);
        let check = async { Ok(self.plugin.check_on_save(&ctx, &conn).await) };
        let refusal = match within(deadline, check).await {
            Ok(Ok(())) => None,
            Ok(Err(f)) => Some(pb::FieldRefusal { field: f.field, error: Some(f.error.pb()) }),
            // A source that does not answer in time is not refused.
            Err(_) => None,
        };
        Ok(Response::new(pb::CheckOnSaveResponse { refusal }))
    }

    type WatchStream = Parts<pb::WatchEvent>;

    async fn watch(&self, request: Request<pb::WatchRequest>) -> Result<Response<Self::WatchStream>, Status> {
        let r = request.into_inner();
        let query = Query::from_pb(r.query.unwrap_or_default()).map_err(|e| status(&e))?;
        let ctx = self.context(None);
        let (tx, rx) = mpsc::channel(QUEUE);
        let feed = WatchFeed::new(tx);
        let plugin = self.plugin.clone();
        let resume = r.resume_token;
        let work = async move {
            match plugin.watch(ctx, query, resume, feed).await {
                Ok(()) => None,
                Err(e) => Some(pb::WatchEvent { event: Some(pb::watch_event::Event::Error(e.pb())) }),
            }
        };
        Ok(Response::new(driven(rx, work)))
    }

    async fn release(&self, request: Request<pb::ReleaseRequest>) -> Result<Response<pb::ReleaseResponse>, Status> {
        self.plugin.release(&request.into_inner().datasource_id);
        Ok(Response::new(pb::ReleaseResponse {}))
    }
}

/// The service as the transport serves it: the plugin, its limits and the token check.
pub(crate) fn grpc<P: DataSource>(
    plugin: P,
    token: &str,
) -> InterceptedService<DataSourceServer<Service<P>>, TokenCheck> {
    let server = DataSourceServer::new(Service::new(plugin))
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES);
    InterceptedService::new(server, TokenCheck(Arc::new(token.as_bytes().to_vec())))
}

pub(crate) async fn serve<P: DataSource>(
    plugin: P,
    config: Config,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let incoming = transport::incoming(&config.address, config.host_pid)?;
    let service = grpc(plugin, &config.token);
    {
        let mut stdout = std::io::stdout().lock();
        writeln!(stdout, "{}", handshake())?;
        stdout.flush()?;
    }
    log::info("listening");
    tonic::transport::Server::builder().add_service(service).serve_with_incoming(incoming).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use futures_util::StreamExt;

    use super::*;

    #[test]
    fn the_handshake_names_protocol_one() {
        assert_eq!(handshake(), "kalzit-plugin 1 ready");
    }

    #[test]
    fn tokens_compare_whole() {
        assert!(same_token(b"abc", b"abc"));
        assert!(!same_token(b"abc", b"abd"));
        assert!(!same_token(b"abc", b"ab"));
        assert!(!same_token(b"", b"a"));
    }

    #[test]
    fn grpc_timeouts_parse() {
        assert_eq!(grpc_timeout("5S"), Some(Duration::from_secs(5)));
        assert_eq!(grpc_timeout("250m"), Some(Duration::from_millis(250)));
        assert_eq!(grpc_timeout("2M"), Some(Duration::from_secs(120)));
        for bad in ["", "S", "5", "5x", "123456789S", "-1S"] {
            assert_eq!(grpc_timeout(bad), None, "{bad}");
        }
    }

    #[test]
    fn the_earlier_deadline_wins() {
        let mut metadata = tonic::metadata::MetadataMap::new();
        metadata.insert("grpc-timeout", "1S".parse().unwrap());
        let now = SystemTime::now();
        let far = now + Duration::from_secs(3600);
        let ms = far.duration_since(UNIX_EPOCH).unwrap().as_millis() as i64;
        let d = deadline(&metadata, ms).unwrap();
        assert!(d < now + Duration::from_secs(2));
        assert!(deadline(&tonic::metadata::MetadataMap::new(), 0).is_none());
    }

    #[tokio::test]
    async fn a_timeout_is_an_error_of_its_kind() {
        let soon = Some(SystemTime::now() + Duration::from_millis(20));
        let e = within(soon, async {
            tokio::time::sleep(Duration::from_secs(5)).await;
            Ok::<(), Error>(())
        })
        .await
        .unwrap_err();
        assert_eq!((e.kind, e.detail.reason.as_str()), (ErrorKind::Timeout, "query.timeout"));
    }

    #[tokio::test]
    async fn the_driven_stream_sends_the_parts_then_the_last_one() {
        let (tx, rx) = mpsc::channel(1);
        let work = async move {
            for i in 0..5 {
                tx.send(i).await.unwrap();
            }
            Some(99)
        };
        let items: Vec<i32> = driven(rx, work).map(|r| r.unwrap()).collect().await;
        assert_eq!(items, [0, 1, 2, 3, 4, 99]);
    }

    #[tokio::test]
    async fn dropping_the_stream_drops_the_work() {
        struct Flag(Arc<std::sync::atomic::AtomicBool>);
        impl Drop for Flag {
            fn drop(&mut self) {
                self.0.store(true, std::sync::atomic::Ordering::SeqCst);
            }
        }
        let dropped = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = Flag(dropped.clone());
        let (tx, rx) = mpsc::channel(1);
        let work = async move {
            let _flag = flag;
            tx.send(1).await.unwrap();
            std::future::pending::<()>().await;
            None
        };
        let mut stream = driven(rx, work);
        assert_eq!(stream.next().await.unwrap().unwrap(), 1);
        drop(stream);
        assert!(dropped.load(std::sync::atomic::Ordering::SeqCst));
    }

    #[test]
    fn errors_keep_their_kind_on_the_wire() {
        let e = Error::rejected("query.write_refused", "writing is not allowed").with("clause", "DELETE");
        let p = e.pb();
        assert_eq!(p.kind, pb::ErrorKind::Rejected as i32);
        assert_eq!(p.detail.as_ref().unwrap().params["clause"], "DELETE");
        assert_eq!(Error::unsupported("x").pb().kind, pb::ErrorKind::Failed as i32);
        assert_eq!(status(&Error::unsupported("x")).code(), tonic::Code::Unimplemented);
    }
}
