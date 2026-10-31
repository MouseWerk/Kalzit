use std::net::SocketAddr;

use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::ws::WebSocketUpgrade;
use axum::middleware::from_fn_with_state;
use axum::routing::get;
use futures_util::{SinkExt, StreamExt};
use http_body_util::BodyExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tower::ServiceExt;

use super::*;

const SHORT: Timeouts = Timeouts { head: Duration::from_millis(300), idle: Duration::from_millis(1200) };

fn ip(s: &str) -> IpAddr {
    s.parse().unwrap()
}

/// A route that answers at once, one whose streamed answer takes longer than the idle timeout, and
/// an echoing WebSocket.
#[expect(clippy::disallowed_methods, reason = "a small router served on a test listener")]
fn app() -> Router {
    Router::new()
        .route("/", get(|| async { "ok" }))
        .route(
            "/stream",
            get(|| async {
                Body::from_stream(futures_util::stream::once(async {
                    tokio::time::sleep(SHORT.idle * 2).await;
                    Ok::<_, std::convert::Infallible>(Bytes::from_static(b"done"))
                }))
            }),
        )
        .route(
            "/ws",
            get(|ws: WebSocketUpgrade| async move {
                ws.on_upgrade(|mut socket| async move {
                    while let Some(Ok(message)) = socket.recv().await {
                        if socket.send(message).await.is_err() {
                            break;
                        }
                    }
                })
            }),
        )
}

/// Serves `app` behind the connection limit, with the short timeouts.
async fn serve() -> SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let limit = ConnectionLimit::new(16, 16, &[], SHORT);
    let mut server = axum_server::from_tcp(listener.into_std().unwrap()).unwrap().acceptor(limit);
    configure(server.http_builder());
    tokio::spawn(server.serve(app().into_make_service()));
    addr
}

/// Reads an HTTP/1 answer whose body is `ok`.
async fn read_ok(conn: &mut TcpStream) {
    let mut seen = Vec::new();
    let mut chunk = [0u8; 512];
    while !seen.ends_with(b"\r\n\r\nok") {
        let n = tokio::time::timeout(Duration::from_secs(5), conn.read(&mut chunk)).await.unwrap().unwrap();
        assert!(n > 0, "the connection closed before the answer: {}", String::from_utf8_lossy(&seen));
        seen.extend_from_slice(&chunk[..n]);
    }
    assert!(seen.starts_with(b"HTTP/1.1 200"));
}

/// Waits for the peer to close; only a read that keeps waiting means the connection is still open
/// (closed or reset are both gone).
async fn closes_within(conn: &mut TcpStream, within: Duration) -> bool {
    let mut rest = Vec::new();
    tokio::time::timeout(within, conn.read_to_end(&mut rest)).await.is_ok()
}

#[test]
fn the_caps_count_all_connections_and_each_address() {
    let limit = ConnectionLimit::new(3, 2, &["10.0.0.0/8".parse().unwrap()], Timeouts::default());
    let a1 = limit.admit(ip("203.0.113.5"));
    let a2 = limit.admit(ip("::ffff:203.0.113.5"));
    assert!(a1.is_some() && a2.is_some(), "two connections per address fit");
    assert!(limit.admit(ip("203.0.113.5")).is_none(), "a third one from the same address is refused");
    let b = limit.admit(ip("203.0.113.6"));
    assert!(b.is_some(), "another address still gets a place");
    assert!(limit.admit(ip("127.0.0.1")).is_none(), "the total cap holds for exempt addresses too");
    drop(a1);
    assert!(limit.admit(ip("203.0.113.5")).is_some(), "an ended connection frees its place");
}

#[test]
fn loopback_and_trusted_proxies_are_exempt_and_ipv6_counts_per_64() {
    let limit = ConnectionLimit::new(100, 2, &["10.0.0.0/8".parse().unwrap()], Timeouts::default());
    let mut held = Vec::new();
    for peer in ["127.0.0.1", "::1", "10.1.2.3"] {
        for _ in 0..5 {
            held.push(limit.admit(ip(peer)).unwrap_or_else(|| panic!("{peer} is exempt")));
        }
    }
    held.push(limit.admit(ip("2001:db8:1:2::1")).unwrap());
    held.push(limit.admit(ip("2001:db8:1:2::ffff")).unwrap());
    assert!(limit.admit(ip("2001:db8:1:2:abcd::1")).is_none(), "the same /64 is one client");
    assert!(limit.admit(ip("2001:db8:1:3::1")).is_some(), "another /64 is another client");
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

/// An unfinished request head is cut after the head timeout; a keep-alive connection waiting for
/// its next request lives longer than that and is closed after the idle timeout.
#[tokio::test]
async fn http1_heads_and_idle_connections_have_their_own_timeouts() {
    let addr = serve().await;
    let mut slow = TcpStream::connect(addr).await.unwrap();
    slow.write_all(b"GET / HTTP/1.1\r\nHost: x\r\n").await.unwrap();
    let mut idle = TcpStream::connect(addr).await.unwrap();
    idle.write_all(b"GET / HTTP/1.1\r\nHost: x\r\n\r\n").await.unwrap();
    read_ok(&mut idle).await;

    assert!(closes_within(&mut slow, SHORT.head * 3).await, "the unfinished head is cut");
    // Past the head timeout, still within the idle timeout: the connection serves another request.
    idle.write_all(b"GET / HTTP/1.1\r\nHost: x\r\n\r\n").await.unwrap();
    read_ok(&mut idle).await;
    assert!(closes_within(&mut idle, SHORT.idle * 3).await, "the idle connection is closed");
}

/// A connection that sends nothing at all is closed after the idle timeout.
#[tokio::test]
async fn a_silent_connection_is_closed() {
    let addr = serve().await;
    let mut silent = TcpStream::connect(addr).await.unwrap();
    assert!(closes_within(&mut silent, SHORT.idle * 3).await);
}

/// An HTTP/2 connection is closed once no stream was open for the idle timeout; a stream that
/// stays open longer is not cut.
#[tokio::test]
async fn http2_connections_without_streams_are_closed() {
    let addr = serve().await;
    // A bare prior-knowledge HTTP/2 client: the preface, empty SETTINGS, and one HEADERS frame on
    // stream 1 (END_STREAM | END_HEADERS) for GET /stream, its header block in HPACK with the
    // static table (:method GET, :scheme http, :path and :authority as literals).
    let mut headers = vec![0x82, 0x86, 0x44, 7];
    headers.extend_from_slice(b"/stream");
    headers.extend_from_slice(&[0x41, 1, b'x']);
    let mut hello = b"PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n".to_vec();
    hello.extend_from_slice(&[0, 0, 0, 0x04, 0, 0, 0, 0, 0]);
    hello.extend_from_slice(&[0, 0, headers.len() as u8, 0x01, 0x05, 0, 0, 0, 1]);
    hello.extend_from_slice(&headers);
    let mut conn = TcpStream::connect(addr).await.unwrap();
    conn.write_all(&hello).await.unwrap();

    let started = Instant::now();
    let mut received = Vec::new();
    let read = tokio::time::timeout(SHORT.idle * 6, conn.read_to_end(&mut received)).await;
    assert!(read.is_ok(), "the connection without streams is closed");
    let at = started.elapsed();
    assert!(received.windows(4).any(|w| w == b"done"), "the open stream finished its answer");
    // The answer took two idle periods and the close came one later, not while the stream was open.
    assert!(at >= SHORT.idle * 3, "closed after {at:?}");
}

/// A WebSocket (an upgraded HTTP/1 connection) stays open while it is quiet.
#[tokio::test]
async fn upgraded_connections_are_not_cut() {
    let addr = serve().await;
    let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://{addr}/ws")).await.unwrap();
    tokio::time::sleep(SHORT.idle * 2).await;
    ws.send(tokio_tungstenite::tungstenite::Message::Text("still here".into())).await.unwrap();
    let echo = tokio::time::timeout(Duration::from_secs(5), ws.next()).await.unwrap().unwrap().unwrap();
    assert_eq!(echo.into_text().unwrap().as_str(), "still here");
}
