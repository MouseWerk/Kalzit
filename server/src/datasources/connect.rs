//! Connection failures in words a person can act on, and the checks that keep a broken pooled
//! connection from failing a query.
//!
//! A server that refuses the connection or does not answer is named with its address and the
//! cause (`source.connect_refused`, `source.connect_timeout`, `source.connect_failed`). A
//! connection that broke while it waited in a pool, typically because the database restarted, is
//! `source.connection_lost`, with the driver's words as the secondary `detail`. The plugins check
//! pooled connections before use and run a read-only query once more on a fresh connection when
//! the old one turns out dead before any result arrived; a query error is never retried.
//!
//! sqlx keeps the cause of a refused connection to itself: its pool retries refused connects until
//! the acquire timeout and then reports only `PoolTimedOut`. `SqlPool::acquire` therefore checks
//! the address on its own when the pool takes longer than `GRACE` to open a connection, and fails
//! at once when the server refuses.

use std::io;
use std::net::SocketAddr;
use std::time::Duration;

use super::{Detail, SourceError};

/// How long a pool may take to open a connection before the address is checked directly. A
/// healthy server on the same network answers well within it, so the check rarely runs.
pub const GRACE: Duration = Duration::from_millis(300);

/// `host:port`, with an IPv6 address in brackets.
pub fn address(host: &str, port: u16) -> String {
    let host = host.trim_matches(['[', ']']);
    if host.contains(':') { format!("[{host}]:{port}") } else { format!("{host}:{port}") }
}

/// Whether an I/O error means the connection itself is gone (closed, reset or cut by the peer),
/// as opposed to a slow server or an answer Kalzit could not read.
pub fn is_dead(kind: io::ErrorKind) -> bool {
    matches!(
        kind,
        io::ErrorKind::UnexpectedEof
            | io::ErrorKind::ConnectionReset
            | io::ErrorKind::ConnectionAborted
            | io::ErrorKind::BrokenPipe
            | io::ErrorKind::NotConnected
    )
}

/// A connection that broke during use; `detail` is the driver's own text.
pub fn lost(detail: impl ToString) -> SourceError {
    SourceError::Failed(lost_detail(detail))
}

/// `lost` as a detail.
pub fn lost_detail(detail: impl ToString) -> Detail {
    let detail = detail.to_string();
    Detail::new("source.connection_lost", format!("the connection to the data source broke: {detail}"))
        .with("detail", detail)
}

/// Whether the error is a broken connection (`lost`), which a read-only query may retry once on a
/// fresh connection.
pub fn is_lost(e: &SourceError) -> bool {
    matches!(e, SourceError::Failed(d) if d.reason == "source.connection_lost")
}

/// The server at `address` refused the connection: nothing listens there (it is down or
/// restarting) or a firewall rejects it.
pub fn refused(address: &str) -> Detail {
    Detail::new("source.connect_refused", format!("cannot connect to {address}: the connection was refused"))
        .with("address", address)
}

/// No connection to `address` within `timeout`.
pub fn timed_out(address: &str, timeout: Duration) -> Detail {
    let seconds = timeout.as_secs().max(1);
    Detail::new("source.connect_timeout", format!("cannot connect to {address}: no answer within {seconds} seconds"))
        .with("address", address)
        .with("seconds", seconds)
}

/// A failed connect to `address`, by its cause.
pub fn connect_failed(address: &str, e: &io::Error, timeout: Duration) -> Detail {
    match e.kind() {
        io::ErrorKind::ConnectionRefused => refused(address),
        io::ErrorKind::TimedOut => timed_out(address, timeout),
        _ => Detail::new("source.connect_failed", format!("cannot connect to {address}: {e}"))
            .with("address", address)
            .with("detail", e),
    }
}

/// Opens and closes a TCP connection to `addr`, to learn why a driver cannot connect.
pub async fn probe(addr: SocketAddr, address: &str, timeout: Duration) -> Result<(), Detail> {
    match tokio::time::timeout(timeout, tokio::net::TcpStream::connect(addr)).await {
        Ok(Ok(_)) => Ok(()),
        Ok(Err(e)) => Err(connect_failed(address, &e, timeout)),
        Err(_) => Err(timed_out(address, timeout)),
    }
}

/// Whether a sqlx error is a broken connection.
pub fn sqlx_dead(e: &sqlx::Error) -> bool {
    matches!(e, sqlx::Error::Io(io) if is_dead(io.kind()))
}

/// A sqlx error while connecting to `address`: refused, silent or cut connections by their cause.
pub fn sqlx_connect_failed(
    e: sqlx::Error,
    address: &str,
    timeout: Duration,
    failed: fn(sqlx::Error) -> SourceError,
) -> SourceError {
    match e {
        sqlx::Error::Io(io) => SourceError::Failed(connect_failed(address, &io, timeout)),
        sqlx::Error::PoolTimedOut => SourceError::Failed(timed_out(address, timeout)),
        other => failed(other),
    }
}

/// A sqlx pool with the address its connections go to, so a failure can name it.
pub struct SqlPool<DB: sqlx::Database> {
    pub pool: sqlx::Pool<DB>,
    addr: SocketAddr,
    address: String,
    timeout: Duration,
}

impl<DB: sqlx::Database> SqlPool<DB> {
    /// `pool` should be lazy and test connections before handing them out (sqlx's default): a
    /// connection that died while idle is then replaced instead of failing the query.
    pub fn new(pool: sqlx::Pool<DB>, addr: SocketAddr, address: String, timeout: Duration) -> Self {
        Self { pool, addr, address, timeout }
    }

    /// A connection from the pool. When the pool needs longer than `GRACE` to open one, the
    /// address is checked directly, so a refused or silent server is reported by its cause
    /// instead of a bare pool timeout. While every connection is busy the pool only waits, and
    /// nothing is checked.
    pub async fn acquire(
        &self,
        failed: fn(sqlx::Error) -> SourceError,
    ) -> Result<sqlx::pool::PoolConnection<DB>, SourceError> {
        let waits_for_busy = self.pool.num_idle() == 0 && self.pool.size() >= self.pool.options().get_max_connections();
        let check = async {
            if waits_for_busy {
                return std::future::pending().await;
            }
            tokio::time::sleep(GRACE).await;
            match probe(self.addr, &self.address, self.timeout.saturating_sub(GRACE)).await {
                Err(d) => d,
                // The server takes connections: the pool's own outcome tells the rest.
                Ok(()) => std::future::pending().await,
            }
        };
        tokio::select! {
            acquired = self.pool.acquire() => {
                acquired.map_err(|e| sqlx_connect_failed(e, &self.address, self.timeout, failed))
            }
            cause = check => Err(SourceError::Failed(cause)),
        }
    }
}

#[cfg(test)]
pub mod tests {
    use super::*;

    /// A port on the loopback interface where nothing listens: bound and released again.
    pub async fn closed_port() -> SocketAddr {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        drop(listener);
        addr
    }

    #[test]
    fn names_the_address_and_the_cause() {
        let refused_e = io::Error::from(io::ErrorKind::ConnectionRefused);
        let d = connect_failed("127.0.0.1:15432", &refused_e, Duration::from_secs(10));
        assert_eq!(d.reason, "source.connect_refused");
        assert_eq!(d.params["address"], "127.0.0.1:15432");
        let d = connect_failed("db:1", &io::Error::from(io::ErrorKind::TimedOut), Duration::from_secs(10));
        assert_eq!((d.reason, d.params["seconds"].as_str()), ("source.connect_timeout", "10"));
        let d = connect_failed("db:1", &io::Error::other("no route"), Duration::from_secs(10));
        assert_eq!((d.reason, d.params["detail"].as_str()), ("source.connect_failed", "no route"));
        assert_eq!(address("::1", 5432), "[::1]:5432");
        assert_eq!(address("[::1]", 5432), "[::1]:5432");
    }

    #[test]
    fn only_a_broken_connection_counts_as_lost() {
        let eof = io::Error::new(io::ErrorKind::UnexpectedEof, "early eof");
        assert!(sqlx_dead(&sqlx::Error::Io(io::Error::new(io::ErrorKind::UnexpectedEof, "early eof"))));
        let e = lost(eof);
        assert!(is_lost(&e));
        let d = e.detail();
        assert_eq!(d.params["detail"], "early eof");
        assert!(!is_lost(&SourceError::from_source("syntax error")));
        assert!(!is_dead(io::ErrorKind::TimedOut));
        assert!(is_dead(io::ErrorKind::ConnectionReset) && is_dead(io::ErrorKind::BrokenPipe));
    }

    #[tokio::test]
    async fn a_refused_connect_fails_fast_with_its_cause() {
        let addr = closed_port().await;
        let options = sqlx::postgres::PgConnectOptions::new_without_pgpass()
            .host("127.0.0.1")
            .port(addr.port())
            .username("u")
            .database("d");
        let pool = sqlx::postgres::PgPoolOptions::new()
            .max_connections(2)
            .acquire_timeout(Duration::from_secs(10))
            .connect_lazy_with(options);
        let pool = SqlPool::new(pool, addr, addr.to_string(), Duration::from_secs(10));
        let started = std::time::Instant::now();
        let e = pool.acquire(|e| SourceError::from_source(e.to_string())).await.unwrap_err();
        assert!(started.elapsed() < Duration::from_secs(6), "took {:?}", started.elapsed());
        let d = e.detail();
        assert_eq!(d.reason, "source.connect_refused", "{d:?}");
        assert_eq!(d.params["address"], addr.to_string());
    }

    #[tokio::test]
    async fn a_server_that_closes_every_connection_is_named_with_the_drivers_words() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                drop(stream);
            }
        });
        let options = sqlx::postgres::PgConnectOptions::new_without_pgpass()
            .host("127.0.0.1")
            .port(addr.port())
            .username("u")
            .database("d")
            .ssl_mode(sqlx::postgres::PgSslMode::Disable);
        let pool = sqlx::postgres::PgPoolOptions::new()
            .max_connections(2)
            .acquire_timeout(Duration::from_secs(10))
            .connect_lazy_with(options);
        let pool = SqlPool::new(pool, addr, addr.to_string(), Duration::from_secs(10));
        let started = std::time::Instant::now();
        let e = pool.acquire(|e| SourceError::from_source(e.to_string())).await.unwrap_err();
        assert!(started.elapsed() < Duration::from_secs(6), "took {:?}", started.elapsed());
        let d = e.detail();
        assert_eq!(d.reason, "source.connect_failed", "{d:?}");
        assert_eq!(d.params["address"], addr.to_string());
        assert!(d.params.contains_key("detail"));
    }
}
