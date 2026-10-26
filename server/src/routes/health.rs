//! Liveness and readiness for service managers, load balancers and container orchestrators.

use std::io::{Read, Write};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, TcpStream};
use std::time::Duration;

use axum::extract::State;
use axum::http::StatusCode;

use crate::app::AppState;

/// The process is up and answering.
pub async fn healthz() -> &'static str {
    "ok"
}

/// The server can do its job: the database answers.
pub async fn readyz(State(state): State<AppState>) -> (StatusCode, &'static str) {
    match sqlx::query("SELECT 1").execute(&state.db).await {
        Ok(_) => (StatusCode::OK, "ready"),
        Err(e) => {
            tracing::warn!("readiness check: database not reachable: {e}");
            (StatusCode::SERVICE_UNAVAILABLE, "database not reachable")
        }
    }
}

/// What `kalzit healthcheck` asks: `/readyz` on the plain HTTP listener of this machine, for
/// container health checks in an image without curl or a shell. A wildcard listen address
/// (`0.0.0.0`, `::`) is asked on loopback.
pub fn probe(listen: SocketAddr, timeout: Duration) -> Result<(), String> {
    let ip = match listen.ip() {
        IpAddr::V4(ip) if ip.is_unspecified() => IpAddr::V4(Ipv4Addr::LOCALHOST),
        IpAddr::V6(ip) if ip.is_unspecified() => IpAddr::V6(Ipv6Addr::LOCALHOST),
        ip => ip,
    };
    let addr = SocketAddr::new(ip, listen.port());
    let mut stream = TcpStream::connect_timeout(&addr, timeout).map_err(|e| format!("connecting to {addr}: {e}"))?;
    stream.set_read_timeout(Some(timeout)).map_err(|e| e.to_string())?;
    stream.set_write_timeout(Some(timeout)).map_err(|e| e.to_string())?;
    stream
        .write_all(b"GET /readyz HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
        .map_err(|e| format!("asking {addr}: {e}"))?;
    // The status line is enough; the whole answer is a few bytes.
    let mut head = Vec::new();
    let mut buf = [0u8; 256];
    while !head.contains(&b'\n') && head.len() < 4096 {
        match stream.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => head.extend_from_slice(&buf[..n]),
            Err(e) => return Err(format!("reading the answer of {addr}: {e}")),
        }
    }
    let text = String::from_utf8_lossy(&head);
    let status = text.lines().next().unwrap_or_default().trim();
    match status.split_whitespace().nth(1) {
        Some("200") => Ok(()),
        _ if status.is_empty() => Err(format!("{addr} closed the connection without an answer")),
        _ => Err(format!("/readyz answered \"{status}\"")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    fn answer_once(reply: &'static [u8]) -> SocketAddr {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buf = [0u8; 512];
            let _ = stream.read(&mut buf);
            let _ = stream.write_all(reply);
        });
        addr
    }

    #[test]
    fn a_ready_server_passes_also_behind_a_wildcard_address() {
        let addr = answer_once(b"HTTP/1.1 200 OK\r\ncontent-length: 5\r\n\r\nready");
        let wildcard = SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), addr.port());
        assert_eq!(probe(wildcard, Duration::from_secs(5)), Ok(()));
    }

    #[test]
    fn a_server_that_is_not_ready_fails() {
        let addr = answer_once(b"HTTP/1.1 503 Service Unavailable\r\n\r\ndatabase not reachable");
        let err = probe(addr, Duration::from_secs(5)).unwrap_err();
        assert!(err.contains("503"), "{err}");
    }

    #[test]
    fn no_server_fails() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        drop(listener);
        assert!(probe(addr, Duration::from_secs(5)).is_err());
    }
}
