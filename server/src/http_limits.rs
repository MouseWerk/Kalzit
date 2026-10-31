//! Limits of the HTTP listeners: how long a client may take to send its request head, how
//! connections that went quiet are closed, how many connections are served at once, and how long a
//! normal route may take to answer.

use std::io;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};
use std::task::{Context, Poll};
use std::time::Duration;

use axum::extract::{Request, State};
use axum::http::StatusCode;
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum_server::accept::Accept;
use hyper_util::rt::{TokioExecutor, TokioTimer};
use hyper_util::server::conn::auto::Builder;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

use crate::clock::Clock;
use crate::error::ApiError;

/// A client must send the complete head of a request within this time. The timer also runs while
/// an HTTP/1 keep-alive connection waits for its next request, so it is the idle timeout of
/// HTTP/1 connections too.
pub const HEADER_READ_TIMEOUT: Duration = Duration::from_secs(30);
/// HTTP/2 connections are pinged after this long without traffic ...
pub const HTTP2_PING_INTERVAL: Duration = Duration::from_secs(60);
/// ... and closed when the ping is not answered within this time.
pub const HTTP2_PING_TIMEOUT: Duration = Duration::from_secs(20);
/// Connections served at once by all listeners together; one more is closed right away. Above the
/// live updates' own limit of 1,000 connections, with room for normal requests next to them.
pub const MAX_CONNECTIONS: usize = 4_096;
/// The time a normal route has to answer (its response head; a streamed body may take longer).
/// Routes that bound themselves (data source queries, AI requests, exports, updates) or stream
/// (live updates, chat answers) are marked `long_running` in their route table and do not get it.
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);

/// Applies the timeouts above to a listener's HTTP/1 and HTTP/2 connections. hyper only enforces
/// them with a timer, which axum-server does not set.
pub fn configure(builder: &mut Builder<TokioExecutor>) {
    configure_with(builder, HEADER_READ_TIMEOUT);
}

fn configure_with(builder: &mut Builder<TokioExecutor>, header_read_timeout: Duration) {
    builder.http1().timer(TokioTimer::new()).header_read_timeout(header_read_timeout);
    builder
        .http2()
        .timer(TokioTimer::new())
        .keep_alive_interval(HTTP2_PING_INTERVAL)
        .keep_alive_timeout(HTTP2_PING_TIMEOUT);
}

/// Caps the connections of the listeners it is shared by. A connection over the cap is closed
/// before TLS or HTTP start; queueing it instead would keep its socket open all the same.
#[derive(Clone)]
pub struct ConnectionLimit {
    permits: Arc<Semaphore>,
    last_warning_ms: Arc<AtomicI64>,
}

impl ConnectionLimit {
    pub fn new(max: usize) -> Self {
        Self { permits: Arc::new(Semaphore::new(max)), last_warning_ms: Arc::default() }
    }

    fn refused(&self) {
        // At most one warning a minute, so a flood of connections does not flood the log.
        let now = crate::clock::SystemClock.monotonic_ms();
        let last = self.last_warning_ms.load(Ordering::Relaxed);
        if (last == 0 || now - last >= 60_000)
            && self.last_warning_ms.compare_exchange(last, now.max(1), Ordering::Relaxed, Ordering::Relaxed).is_ok()
        {
            tracing::warn!("{MAX_CONNECTIONS} connections are open; new connections are closed until some end");
        }
    }
}

impl<I, S> Accept<I, S> for ConnectionLimit {
    type Stream = Limited<I>;
    type Service = S;
    type Future = std::future::Ready<io::Result<(Limited<I>, S)>>;

    fn accept(&self, stream: I, service: S) -> Self::Future {
        std::future::ready(match self.permits.clone().try_acquire_owned() {
            Ok(permit) => Ok((Limited { inner: stream, _permit: permit }, service)),
            Err(_) => {
                self.refused();
                Err(io::Error::other("connection limit reached"))
            }
        })
    }
}

/// A connection that holds its place under the cap until it is dropped.
pub struct Limited<I> {
    inner: I,
    _permit: OwnedSemaphorePermit,
}

impl<I: AsyncRead + Unpin> AsyncRead for Limited<I> {
    fn poll_read(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_read(cx, buf)
    }
}

impl<I: AsyncWrite + Unpin> AsyncWrite for Limited<I> {
    fn poll_write(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.inner).poll_write(cx, buf)
    }

    fn poll_write_vectored(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bufs: &[io::IoSlice<'_>],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.inner).poll_write_vectored(cx, bufs)
    }

    fn is_write_vectored(&self) -> bool {
        self.inner.is_write_vectored()
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

/// Answers a request that ran past `limit` with `503 busy`, so the client may try again; the
/// handler is dropped, which rolls back an open transaction. After a commit that answer would be
/// untrue, so it is an internal error then.
pub async fn request_timeout(State(limit): State<Duration>, req: Request, next: Next) -> Response {
    let (method, path) = (req.method().clone(), req.uri().path().to_string());
    match tokio::time::timeout(limit, next.run(req)).await {
        Ok(res) => res,
        Err(_) if crate::db::committed() => {
            ApiError::internal("request timeout, after a commit", format!("{method} {path} took over {limit:?}"))
                .into_response()
        }
        Err(_) => {
            let id = crate::error::request_id().unwrap_or_default();
            tracing::warn!(request_id = %id, "{method} {path} took over {limit:?}; answering 503");
            ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "busy",
                format!("the request took longer than {} seconds; try again in a moment", limit.as_secs()),
            )
            .into_response()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::Router;
    use axum::body::Body;
    use axum::middleware::from_fn_with_state;
    use axum::routing::get;
    use http_body_util::BodyExt;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};
    use tower::ServiceExt;

    #[tokio::test]
    async fn the_connection_limit_refuses_connections_over_the_cap_until_one_ends() {
        let limit = ConnectionLimit::new(2);
        let first = limit.accept((), ()).await;
        let second = limit.accept((), ()).await;
        assert!(first.is_ok() && second.is_ok(), "two connections fit");
        assert!(limit.accept((), ()).await.is_err(), "a third connection is refused");
        drop(first);
        assert!(limit.accept((), ()).await.is_ok(), "an ended connection frees its place");
    }

    #[expect(clippy::disallowed_methods, reason = "a one-route router that only carries the middleware under test")]
    #[tokio::test]
    async fn a_slow_route_answers_busy_with_the_request_id() {
        let app = Router::new()
            .route("/slow", get(|| async { tokio::time::sleep(Duration::from_secs(60)).await }))
            .route("/fast", get(|| async { "ok" }))
            .layer(from_fn_with_state(Duration::from_millis(200), request_timeout))
            .layer(axum::middleware::from_fn(crate::error::assign_request_id));
        let res = app.clone().oneshot(Request::get("/fast").body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let res = app.oneshot(Request::get("/slow").body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(res.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(res.headers()["x-request-id"].len(), 12);
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["error"]["code"], "busy");
    }

    /// A client that opens a connection and never finishes its request head is cut off by the
    /// header timeout, also while a keep-alive connection waits for its next request.
    #[expect(clippy::disallowed_methods, reason = "a one-route router served on a test listener")]
    #[tokio::test]
    async fn the_listener_closes_slow_and_idle_connections() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let app = Router::new().route("/", get(|| async { "ok" }));
        let mut server = axum_server::from_tcp(listener.into_std().unwrap()).unwrap();
        let header_timeout = Duration::from_millis(300);
        configure_with(server.http_builder(), header_timeout);
        tokio::spawn(server.serve(app.into_make_service()));

        // An unfinished head.
        let mut slow = TcpStream::connect(addr).await.unwrap();
        slow.write_all(b"GET / HTTP/1.1\r\nHost: x\r\n").await.unwrap();
        // A finished request on a connection that then stays idle.
        let mut idle = TcpStream::connect(addr).await.unwrap();
        idle.write_all(b"GET / HTTP/1.1\r\nHost: x\r\n\r\n").await.unwrap();
        let mut answer = [0u8; 12];
        idle.read_exact(&mut answer).await.unwrap();
        assert_eq!(&answer, b"HTTP/1.1 200");

        tokio::time::sleep(header_timeout * 2).await;
        for (name, mut conn) in [("slow", slow), ("idle", idle)] {
            let mut rest = Vec::new();
            let read = tokio::time::timeout(Duration::from_secs(5), conn.read_to_end(&mut rest)).await;
            // Closed or reset, either way gone; only a read that waits means it is still open.
            assert!(read.is_ok(), "the {name} connection is closed");
        }
    }
}
