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
//! sqlx keeps the cause of a refused connection to itself: its pool retries refused connects (and
//! connections its setup refused) until the acquire timeout and then reports only `PoolTimedOut`.
//! `SqlPool::acquire` therefore connects once on its own when the pool takes longer than `GRACE`,
//! fails at once when the server refuses, and otherwise reports what the setup or that connect
//! found.

use std::io;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use super::{Detail, SourceError};

/// How long a pool may take to open a connection before the driver connects once on its own. A
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
        other => failed(other),
    }
}

/// No free connection within `timeout`, although the server takes connections: every connection
/// is busy, or logging in takes that long.
pub fn pool_timed_out(timeout: Duration) -> Detail {
    let seconds = timeout.as_secs().max(1);
    Detail::new("source.pool_timeout", format!("no connection to the data source was free within {seconds} seconds"))
        .with("seconds", seconds)
}

/// The last error of a pool's connection setup (`after_connect`). sqlx closes such a connection
/// and tries again until the acquire timeout, then reports only `PoolTimedOut`; the setup's own
/// refusal (Kalzit's own database, a name that now resolves to a refused address, a session
/// setting the server keeps) is the better answer.
#[derive(Clone, Default)]
pub struct SetupErrors(Arc<Mutex<Option<SourceError>>>);

impl SetupErrors {
    /// Keeps the error of a setup step, mapped with `failed`, and hands sqlx its text.
    pub fn keep(
        &self,
        step: Result<(), sqlx::Error>,
        failed: fn(sqlx::Error) -> SourceError,
    ) -> Result<(), sqlx::Error> {
        step.map_err(|e| {
            let text = e.to_string();
            *self.0.lock().expect("setup error lock") = Some(failed(e));
            sqlx::Error::Configuration(text.into())
        })
    }

    fn take(&self) -> Option<SourceError> {
        self.0.lock().expect("setup error lock").take()
    }
}

/// How the direct connect of `SqlPool::acquire` went.
enum Probe {
    NotStarted,
    Running,
    Connected,
    /// The driver connected to the server but failed later (TLS, login): the answer when the
    /// pool runs out of time too.
    Failed(SourceError),
}

/// A sqlx pool with the address its connections go to, so a failure can name it.
pub struct SqlPool<DB: sqlx::Database> {
    pub pool: sqlx::Pool<DB>,
    address: String,
    timeout: Duration,
    setup: SetupErrors,
}

impl<DB: sqlx::Database> SqlPool<DB> {
    /// `pool` should be lazy and test connections before handing them out (sqlx's default): a
    /// connection that died while idle is then replaced instead of failing the query. `setup`
    /// is the slot the pool's `after_connect` keeps its errors in.
    pub fn new(pool: sqlx::Pool<DB>, address: String, timeout: Duration, setup: SetupErrors) -> Self {
        Self { pool, address, timeout, setup }
    }

    /// A connection from the pool. When the pool needs longer than `GRACE` to open one, the
    /// driver connects once on its own, outside the pool, to learn the cause: a refused or cut
    /// connection is answered at once, instead of after the pool's silent retries. The check is
    /// a regular login that is closed again, not a bare TCP connect, so MySQL does not count an
    /// aborted handshake against the host and PostgreSQL logs no incomplete startup; the price
    /// is one more login while a server is slow to accept one. While every connection is busy
    /// the pool only waits, and nothing is checked.
    pub async fn acquire(
        &self,
        failed: fn(sqlx::Error) -> SourceError,
    ) -> Result<sqlx::pool::PoolConnection<DB>, SourceError> {
        use sqlx::{ConnectOptions as _, Connection as _};
        let waits_for_busy = self.pool.num_idle() == 0 && self.pool.size() >= self.pool.options().get_max_connections();
        let probe = Mutex::new(Probe::NotStarted);
        let set = |state: Probe| *probe.lock().expect("probe lock") = state;
        let check = async {
            if waits_for_busy {
                return std::future::pending().await;
            }
            tokio::time::sleep(GRACE).await;
            set(Probe::Running);
            let options = self.pool.connect_options();
            match tokio::time::timeout(self.timeout, options.connect()).await {
                Ok(Ok(c)) => {
                    let _ = c.close().await;
                    set(Probe::Connected);
                }
                Ok(Err(sqlx::Error::Io(e))) => return connect_failed(&self.address, &e, self.timeout),
                Ok(Err(e)) => set(Probe::Failed(failed(e))),
                Err(_) => return timed_out(&self.address, self.timeout),
            }
            // The server takes connections: the pool's own outcome tells the rest.
            std::future::pending().await
        };
        let acquired = tokio::select! {
            acquired = self.pool.acquire() => acquired,
            cause = check => return Err(SourceError::Failed(cause)),
        };
        match acquired {
            Ok(c) => Ok(c),
            Err(sqlx::Error::PoolTimedOut) => Err(self.timed_out(probe.into_inner().expect("probe lock"))),
            Err(e) => Err(sqlx_connect_failed(e, &self.address, self.timeout, failed)),
        }
    }

    /// Why the pool ran out of time: a refused setup, a failed direct connect, a server that
    /// did not answer it, or else a pool that had no free connection.
    fn timed_out(&self, probe: Probe) -> SourceError {
        if let Some(e) = self.setup.take() {
            return e;
        }
        match probe {
            Probe::Failed(e) => e,
            // Still waiting for the server since `GRACE`: it does not answer.
            Probe::Running => SourceError::Failed(timed_out(&self.address, self.timeout)),
            Probe::NotStarted | Probe::Connected => SourceError::Failed(pool_timed_out(self.timeout)),
        }
    }
}

#[cfg(test)]
pub mod tests {
    use super::*;

    /// A port on the loopback interface where nothing listens: bound and released again.
    pub async fn closed_port() -> std::net::SocketAddr {
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
    async fn a_pool_timeout_is_told_by_what_was_found() {
        let options = sqlx::postgres::PgConnectOptions::new_without_pgpass().host("127.0.0.1").port(1);
        let lazy = sqlx::postgres::PgPoolOptions::new().connect_lazy_with(options);
        let setup = SetupErrors::default();
        let pool = SqlPool::new(lazy, "db:5432".into(), Duration::from_secs(10), setup.clone());
        // Busy, or the server let the direct connect in: no free connection, not "no answer".
        assert_eq!(pool.timed_out(Probe::NotStarted).detail().reason, "source.pool_timeout");
        assert_eq!(pool.timed_out(Probe::Connected).detail().params["seconds"], "10");
        // The direct connect still waits for an answer: the configured timeout, not less.
        let d = pool.timed_out(Probe::Running).detail();
        assert_eq!((d.reason, d.params["seconds"].as_str()), ("source.connect_timeout", "10"));
        // A setup the server refused is the answer, whatever the direct connect found.
        let kept = setup.keep(Err(sqlx::Error::Protocol("the server keeps sql_mode ANSI".into())), |e| {
            SourceError::failed("mysql.no_time_limit", e.to_string())
        });
        assert!(kept.is_err());
        assert_eq!(pool.timed_out(Probe::Running).detail().reason, "mysql.no_time_limit");
        assert_eq!(pool.timed_out(Probe::Running).detail().reason, "source.connect_timeout", "reported once");
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
        let pool = SqlPool::new(pool, addr.to_string(), Duration::from_secs(10), SetupErrors::default());
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
        let pool = SqlPool::new(pool, addr.to_string(), Duration::from_secs(10), SetupErrors::default());
        let started = std::time::Instant::now();
        let e = pool.acquire(|e| SourceError::from_source(e.to_string())).await.unwrap_err();
        assert!(started.elapsed() < Duration::from_secs(6), "took {:?}", started.elapsed());
        let d = e.detail();
        assert_eq!(d.reason, "source.connect_failed", "{d:?}");
        assert_eq!(d.params["address"], addr.to_string());
        assert!(d.params.contains_key("detail"));
    }
}
