//! Limits of the HTTP listeners: how long a client may take to send its request head, when
//! connections without requests are closed, how many connections are served at once (in total and
//! per address), and how long a normal route may take to answer.
//!
//! The connection timeouts are kept here, on the connection itself, instead of in hyper: hyper's
//! header timer also runs while an HTTP/1 connection waits for its next request (so idle and head
//! could not differ), and HTTP/2 has no idle timeout at all.

use std::collections::HashMap;
use std::future::Future;
use std::io;
use std::net::{IpAddr, Ipv6Addr};
use std::pin::Pin;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll, Waker};
use std::time::Duration;

use axum::extract::{Request, State};
use axum::http::{self, StatusCode, Version};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum_server::accept::Accept;
use hyper_util::rt::{TokioExecutor, TokioTimer};
use hyper_util::server::conn::auto::Builder;
use ipnet::IpNet;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::TcpStream;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio::time::{Instant, Sleep};

use crate::clock::Clock;
use crate::error::ApiError;
use crate::locks::MutexExt;

/// Once the first byte of a request arrived, its complete head must follow within this time.
pub const HEADER_READ_TIMEOUT: Duration = Duration::from_secs(30);
/// A connection without a request in progress is closed after this long: an HTTP/1 keep-alive
/// connection waiting for its next request, an HTTP/2 connection without an open stream, and a new
/// connection that has sent nothing yet. Longer than the keep-alive of nginx (60 s) and Caddy
/// upstream connections, so a reverse proxy closes an idle connection before Kalzit does and never
/// sends a request into one that is just closing (a 502 at the proxy). An upgraded connection
/// (live updates over WebSocket) and an open stream (a streamed answer) are never cut.
pub const IDLE_TIMEOUT: Duration = Duration::from_secs(75);
/// HTTP/2 connections are pinged after this long without traffic ...
pub const HTTP2_PING_INTERVAL: Duration = Duration::from_secs(60);
/// ... and closed when the ping is not answered within this time.
pub const HTTP2_PING_TIMEOUT: Duration = Duration::from_secs(20);
/// Connections served at once by all listeners together; one more is closed right away. Above the
/// live updates' own limit of 1,000 connections, with room for normal requests next to them.
pub const MAX_CONNECTIONS: usize = 4_096;
/// Connections one client address may hold (an IPv6 client: its /64), so a single client cannot
/// take every place. Loopback and the reverse proxies in `security.trusted_proxies` are exempt:
/// behind a proxy every connection comes from the proxy's address.
pub const MAX_CONNECTIONS_PER_ADDRESS: usize = 256;
/// The time a normal route has to answer (its response head; a streamed body may take longer).
/// Routes that bound themselves (data source queries, AI requests, exports) or take uploads and
/// stream (live updates, chat answers) are marked `long_running` in their route table instead.
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);

/// Turns on HTTP/2 keep-alive pings, which notice connections whose peer is gone. hyper only
/// sends them with a timer, which axum-server does not set. hyper's own HTTP/1 header timeout
/// stays off (no timer); `Limited` enforces head and idle times for both versions.
pub fn configure(builder: &mut Builder<TokioExecutor>) {
    builder
        .http2()
        .timer(TokioTimer::new())
        .keep_alive_interval(HTTP2_PING_INTERVAL)
        .keep_alive_timeout(HTTP2_PING_TIMEOUT);
}

/// The two connection timeouts; tests make them short.
#[derive(Clone, Copy, Debug)]
pub struct Timeouts {
    pub head: Duration,
    pub idle: Duration,
}

impl Default for Timeouts {
    fn default() -> Self {
        Self { head: HEADER_READ_TIMEOUT, idle: IDLE_TIMEOUT }
    }
}

/// Connections held per client address (`ConnectionLimit::address_key`).
type ByAddress = Arc<Mutex<HashMap<IpAddr, usize>>>;

/// Caps the connections of the listeners it is shared by, in total and per client address, and
/// gives every connection its head and idle timeouts. A connection over a cap is closed before
/// TLS or HTTP start; queueing it instead would keep its socket open all the same.
#[derive(Clone)]
pub struct ConnectionLimit {
    permits: Arc<Semaphore>,
    max: usize,
    per_address: usize,
    by_address: ByAddress,
    trusted: Arc<[IpNet]>,
    timeouts: Timeouts,
    last_warning_ms: Arc<AtomicI64>,
}

impl ConnectionLimit {
    /// `trusted` are the reverse proxies (`security.trusted_proxies`), exempt from the per-address
    /// cap like loopback.
    pub fn new(max: usize, per_address: usize, trusted: &[IpNet], timeouts: Timeouts) -> Self {
        Self {
            permits: Arc::new(Semaphore::new(max)),
            max,
            per_address,
            by_address: Arc::default(),
            trusted: trusted.into(),
            timeouts,
            last_warning_ms: Arc::default(),
        }
    }

    /// The address a connection counts against, `None` for an exempt one.
    fn address_key(&self, peer: IpAddr) -> Option<IpAddr> {
        let peer = peer.to_canonical();
        if peer.is_loopback() || self.trusted.iter().any(|net| net.contains(&peer)) {
            return None;
        }
        Some(match peer {
            IpAddr::V6(v6) => {
                let s = v6.segments();
                IpAddr::V6(Ipv6Addr::new(s[0], s[1], s[2], s[3], 0, 0, 0, 0))
            }
            v4 => v4,
        })
    }

    /// A place for a connection from `peer`, or `None` when a cap is reached.
    fn admit(&self, peer: IpAddr) -> Option<Slot> {
        let Ok(permit) = self.permits.clone().try_acquire_owned() else {
            self.warn(format_args!("{} connections are open; new connections are closed until some end", self.max));
            return None;
        };
        let key = self.address_key(peer);
        if let Some(key) = key {
            let mut by_address = self.by_address.lock_or_recover();
            let held = by_address.entry(key).or_default();
            if *held >= self.per_address {
                drop(by_address);
                self.warn(format_args!(
                    "{key} holds {} connections; its new connections are closed until some end",
                    self.per_address
                ));
                return None;
            }
            *held += 1;
        }
        Some(Slot { _permit: permit, address: key.map(|k| (k, self.by_address.clone())) })
    }

    fn warn(&self, message: std::fmt::Arguments<'_>) {
        // At most one warning a minute, so a flood of connections does not flood the log.
        let now = crate::clock::SystemClock.monotonic_ms();
        let last = self.last_warning_ms.load(Ordering::Relaxed);
        if (last == 0 || now - last >= 60_000)
            && self.last_warning_ms.compare_exchange(last, now.max(1), Ordering::Relaxed, Ordering::Relaxed).is_ok()
        {
            tracing::warn!("{message}");
        }
    }

    fn wrap<I, S>(&self, stream: I, service: S, slot: Slot) -> (Limited<I>, Tracked<S>) {
        let conn = Arc::new(Conn::new(self.timeouts));
        (Limited { inner: stream, conn: conn.clone(), sleep: None, _slot: slot }, Tracked { inner: service, conn })
    }
}

impl<S> Accept<TcpStream, S> for ConnectionLimit {
    type Stream = Limited<TcpStream>;
    type Service = Tracked<S>;
    type Future = std::future::Ready<io::Result<(Limited<TcpStream>, Tracked<S>)>>;

    fn accept(&self, stream: TcpStream, service: S) -> Self::Future {
        let slot = stream.peer_addr().ok().and_then(|peer| self.admit(peer.ip()));
        std::future::ready(match slot {
            Some(slot) => Ok(self.wrap(stream, service, slot)),
            None => Err(io::Error::other("connection limit reached")),
        })
    }
}

/// A connection's place under the caps, given back when the connection is dropped.
struct Slot {
    _permit: OwnedSemaphorePermit,
    address: Option<(IpAddr, ByAddress)>,
}

impl Drop for Slot {
    fn drop(&mut self) {
        if let Some((key, by_address)) = &self.address {
            let mut by_address = by_address.lock_or_recover();
            if let Some(held) = by_address.get_mut(key) {
                *held -= 1;
                if *held == 0 {
                    by_address.remove(key);
                }
            }
        }
    }
}

/// What one connection is doing, shared by its stream (which enforces the timeouts) and its
/// service (which sees requests start and end).
struct Conn {
    timeouts: Timeouts,
    state: Mutex<ConnState>,
}

struct ConnState {
    /// Requests whose answer is not finished yet (an open HTTP/2 stream, a streamed body).
    in_flight: usize,
    /// Answered with `101 Switching Protocols`: the connection belongs to the upgrade now.
    upgraded: bool,
    /// Requests came as HTTP/2: bytes without a stream (pings, settings) are not activity.
    http2: bool,
    /// Since when nothing is in progress.
    idle_since: Instant,
    /// When the first byte of the next HTTP/1 request head arrived.
    head_since: Option<Instant>,
    /// The stream's reader, woken when the last request ends and the idle timer must start.
    reader: Option<Waker>,
}

impl Conn {
    fn new(timeouts: Timeouts) -> Self {
        Self {
            timeouts,
            state: Mutex::new(ConnState {
                in_flight: 0,
                upgraded: false,
                http2: false,
                idle_since: Instant::now(),
                head_since: None,
                reader: None,
            }),
        }
    }

    /// When the connection is closed unless something happens first; `None` while a request is in
    /// progress or after an upgrade.
    fn deadline(&self, s: &ConnState) -> Option<Instant> {
        if s.upgraded || s.in_flight > 0 {
            return None;
        }
        match s.head_since {
            Some(head) if !s.http2 => Some(head + self.timeouts.head),
            _ => Some(s.idle_since + self.timeouts.idle),
        }
    }

    fn request_started(&self, version: Version) {
        let mut s = self.state.lock_or_recover();
        s.in_flight += 1;
        s.head_since = None;
        if version == Version::HTTP_2 {
            s.http2 = true;
        }
    }

    fn request_ended(&self, upgraded: bool) {
        let mut s = self.state.lock_or_recover();
        s.in_flight -= 1;
        s.upgraded |= upgraded;
        if s.in_flight == 0 {
            s.idle_since = Instant::now();
            if let Some(reader) = s.reader.take() {
                reader.wake();
            }
        }
    }
}

/// A connection: holds its place under the caps until it is dropped, and reads as closed once its
/// head or idle deadline passed, which makes hyper close it.
pub struct Limited<I> {
    inner: I,
    conn: Arc<Conn>,
    sleep: Option<Pin<Box<Sleep>>>,
    _slot: Slot,
}

impl<I: AsyncRead + Unpin> AsyncRead for Limited<I> {
    fn poll_read(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<io::Result<()>> {
        let this = &mut *self;
        loop {
            let deadline = {
                let mut s = this.conn.state.lock_or_recover();
                s.reader = Some(cx.waker().clone());
                this.conn.deadline(&s)
            };
            if deadline.is_some_and(|d| Instant::now() >= d) {
                tracing::debug!("closing a connection that sent no request in time");
                return Poll::Ready(Ok(()));
            }
            let filled = buf.filled().len();
            if let Poll::Ready(result) = Pin::new(&mut this.inner).poll_read(cx, buf) {
                if result.is_ok() && buf.filled().len() > filled {
                    let mut s = this.conn.state.lock_or_recover();
                    if !s.http2 && s.in_flight == 0 && s.head_since.is_none() && !s.upgraded {
                        s.head_since = Some(Instant::now());
                    }
                }
                return Poll::Ready(result);
            }
            let Some(deadline) = deadline else { return Poll::Pending };
            match &mut this.sleep {
                Some(sleep) => sleep.as_mut().reset(deadline),
                None => this.sleep = Some(Box::pin(tokio::time::sleep_until(deadline))),
            }
            if let Some(sleep) = &mut this.sleep
                && sleep.as_mut().poll(cx).is_pending()
            {
                return Poll::Pending;
            }
        }
    }
}

impl<I: AsyncWrite + Unpin> Limited<I> {
    /// An HTTP/1 answer still being written keeps the connection busy.
    fn wrote(&self, n: usize) {
        if n > 0 {
            let mut s = self.conn.state.lock_or_recover();
            if !s.http2 && s.in_flight == 0 {
                s.idle_since = Instant::now();
            }
        }
    }
}

impl<I: AsyncWrite + Unpin> AsyncWrite for Limited<I> {
    fn poll_write(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
        let polled = Pin::new(&mut self.inner).poll_write(cx, buf);
        if let Poll::Ready(Ok(n)) = &polled {
            self.wrote(*n);
        }
        polled
    }

    fn poll_write_vectored(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bufs: &[io::IoSlice<'_>],
    ) -> Poll<io::Result<usize>> {
        let polled = Pin::new(&mut self.inner).poll_write_vectored(cx, bufs);
        if let Poll::Ready(Ok(n)) = &polled {
            self.wrote(*n);
        }
        polled
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

/// The connection's service: counts a request as in progress from its head until its answer's
/// body is finished or dropped.
#[derive(Clone)]
pub struct Tracked<S> {
    inner: S,
    conn: Arc<Conn>,
}

impl<S, B, ReqB> tower::Service<http::Request<ReqB>> for Tracked<S>
where
    S: tower::Service<http::Request<ReqB>, Response = http::Response<B>>,
    S::Future: Send + 'static,
{
    type Response = http::Response<Guarded<B>>;
    type Error = S::Error;
    type Future = Pin<Box<dyn Future<Output = Result<Self::Response, S::Error>> + Send>>;

    fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), S::Error>> {
        self.inner.poll_ready(cx)
    }

    fn call(&mut self, req: http::Request<ReqB>) -> Self::Future {
        self.conn.request_started(req.version());
        let mut guard = InFlight { conn: self.conn.clone(), upgraded: false };
        let future = self.inner.call(req);
        Box::pin(async move {
            let res = future.await?;
            guard.upgraded = res.status() == StatusCode::SWITCHING_PROTOCOLS;
            Ok(res.map(|body| Guarded { inner: Box::pin(body), _in_flight: guard }))
        })
    }
}

/// One request in progress; ends when dropped.
struct InFlight {
    conn: Arc<Conn>,
    upgraded: bool,
}

impl Drop for InFlight {
    fn drop(&mut self) {
        self.conn.request_ended(self.upgraded);
    }
}

/// An answer's body that keeps its request in progress until it is finished or dropped.
pub struct Guarded<B> {
    inner: Pin<Box<B>>,
    _in_flight: InFlight,
}

impl<B: http_body::Body> http_body::Body for Guarded<B> {
    type Data = B::Data;
    type Error = B::Error;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<http_body::Frame<B::Data>, B::Error>>> {
        self.inner.as_mut().poll_frame(cx)
    }

    fn is_end_stream(&self) -> bool {
        self.inner.is_end_stream()
    }

    fn size_hint(&self) -> http_body::SizeHint {
        self.inner.size_hint()
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
mod tests;
