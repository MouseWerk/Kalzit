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
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use super::{Detail, SourceError};
use crate::locks::MutexExt;

/// How long a pool may take to open a connection before the driver connects once on its own. A
/// healthy server on the same network answers well within it, so the check rarely runs.
pub const GRACE: Duration = Duration::from_millis(300);

/// The TLS mode new PostgreSQL and MySQL sources get (`sslMode`): TLS required towards a public
/// address, preferred towards a private or loopback one (`tls_required`).
pub const AUTO_TLS: &str = "auto";

/// Whether the `auto` TLS mode requires TLS towards `ip`: for every address that is not private,
/// loopback or otherwise local (`http::LocalGuard::is_private`). The address is the one the
/// connection goes to, after the name was resolved and checked, so a name pointing to the
/// internet requires TLS whatever it is called.
pub fn tls_required(ip: std::net::IpAddr) -> bool {
    !crate::http::LocalGuard::is_private(ip)
}

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

/// The last error of a pool's connection setup (`after_connect`), with when it happened. sqlx
/// closes such a connection and tries again until the acquire timeout, then reports only
/// `PoolTimedOut`; the setup's own refusal (Kalzit's own database, a name that now resolves to a
/// refused address, a session setting the server keeps) is the better answer. A setup that
/// succeeds clears it, so an old refusal never explains a later timeout.
#[derive(Clone, Default)]
pub struct SetupErrors(Arc<Mutex<Option<(Instant, SourceError)>>>);

impl SetupErrors {
    /// Keeps the outcome of a setup step (an error mapped with `failed`) and hands sqlx the
    /// error's text.
    pub fn keep(
        &self,
        step: Result<(), sqlx::Error>,
        failed: fn(sqlx::Error) -> SourceError,
    ) -> Result<(), sqlx::Error> {
        let mut slot = self.0.lock_or_recover();
        match step {
            Ok(()) => {
                *slot = None;
                Ok(())
            }
            Err(e) => {
                let text = e.to_string();
                *slot = Some((Instant::now(), failed(e)));
                Err(sqlx::Error::Configuration(text.into()))
            }
        }
    }

    /// The error of a setup that failed since `since`, for every waiter that asks.
    fn since(&self, since: Instant) -> Option<SourceError> {
        let slot = self.0.lock_or_recover();
        slot.as_ref().filter(|(at, _)| *at >= since).map(|(_, e)| e.clone())
    }
}

/// The name a verify-full (PostgreSQL) or verify_identity (MySQL) connection resolves itself:
/// checked against the target rules again before every connect, as `after_connect` does.
pub type Recheck = (Arc<super::targets::TargetPolicy>, String, u16);

/// The direct connect of a pool: at most one runs at a time, and every waiter reads its result.
#[derive(Clone)]
enum Probe {
    Idle,
    Running,
    Done { at: Instant, outcome: Outcome },
}

#[derive(Clone)]
enum Outcome {
    Connected,
    /// Refused, cut, or a target the rules refuse: the answer at once.
    Decisive(SourceError),
    /// The driver reached the server but failed later (TLS, login): the answer when the pool
    /// runs out of time too.
    Failed(SourceError),
    /// No login within the timeout.
    Slow,
}

/// The plain TCP connect that tells a silent server from a slow login, once a pool ran out of
/// time: at most one at a time per pool, and every waiter reads its result.
#[derive(Clone)]
enum Reach {
    Idle,
    Running,
    /// `None`: the server accepted the connection.
    Done {
        at: Instant,
        refused: Option<Detail>,
    },
}

/// A sqlx pool with the address its connections go to, so a failure can name it.
pub struct SqlPool<DB: sqlx::Database> {
    pub pool: sqlx::Pool<DB>,
    /// The checked address; the last check of a pool that ran out of time goes there.
    addr: SocketAddr,
    address: String,
    timeout: Duration,
    setup: SetupErrors,
    recheck: Option<Recheck>,
    probe: Arc<tokio::sync::watch::Sender<Probe>>,
    reach: Arc<tokio::sync::watch::Sender<Reach>>,
    /// Direct connects and TCP checks started, for the tests.
    probes: std::sync::atomic::AtomicUsize,
    reaches: std::sync::atomic::AtomicUsize,
}

impl<DB: sqlx::Database> SqlPool<DB> {
    /// `pool` should be lazy and test connections before handing them out (sqlx's default): a
    /// connection that died while idle is then replaced instead of failing the query. `setup`
    /// is the slot the pool's `after_connect` keeps its errors in; `recheck` the name a
    /// connection resolves itself, if it does.
    pub fn new(
        pool: sqlx::Pool<DB>,
        addr: SocketAddr,
        address: String,
        timeout: Duration,
        setup: SetupErrors,
        recheck: Option<Recheck>,
    ) -> Self {
        let probe = Arc::new(tokio::sync::watch::Sender::new(Probe::Idle));
        let reach = Arc::new(tokio::sync::watch::Sender::new(Reach::Idle));
        Self {
            pool,
            addr,
            address,
            timeout,
            setup,
            recheck,
            probe,
            reach,
            probes: Default::default(),
            reaches: Default::default(),
        }
    }

    /// A connection from the pool. When the pool needs longer than `GRACE` to open one, the
    /// driver connects once on its own, outside the pool, to learn the cause: a refused or cut
    /// connection is answered at once, instead of after the pool's silent retries. The check is
    /// a regular login that is closed again, not a bare TCP connect, so MySQL does not count an
    /// aborted handshake against the host and PostgreSQL logs no incomplete startup; it runs in
    /// a task of its own, so it finishes cleanly also when the pool answers first, and only one
    /// runs per pool at a time, whose result every waiting query reads. The price is one more
    /// login while a server is slow to accept one. While every connection is busy the pool only
    /// waits, and nothing is checked.
    pub async fn acquire(
        &self,
        failed: fn(sqlx::Error) -> SourceError,
    ) -> Result<sqlx::pool::PoolConnection<DB>, SourceError> {
        let started = Instant::now();
        let waits_for_busy = self.pool.num_idle() == 0 && self.pool.size() >= self.pool.options().get_max_connections();
        let check = async {
            if waits_for_busy {
                return std::future::pending().await;
            }
            tokio::time::sleep(GRACE).await;
            let mut results = self.probe.subscribe();
            self.start_probe(started, failed);
            loop {
                if let Probe::Done { at, outcome: Outcome::Decisive(e) } = &*results.borrow_and_update()
                    && *at >= started
                {
                    return e.clone();
                }
                if results.changed().await.is_err() {
                    return std::future::pending().await;
                }
            }
        };
        let acquired = tokio::select! {
            acquired = self.pool.acquire() => acquired,
            cause = check => return Err(cause),
        };
        match acquired {
            Ok(c) => Ok(c),
            Err(sqlx::Error::PoolTimedOut) => Err(self.timed_out(started).await),
            Err(e) => Err(sqlx_connect_failed(e, &self.address, self.timeout, failed)),
        }
    }

    /// Starts the direct connect, unless one runs or one finished since `since`.
    fn start_probe(&self, since: Instant, failed: fn(sqlx::Error) -> SourceError) {
        let start = self.probe.send_if_modified(|state| match state {
            Probe::Running => false,
            Probe::Done { at, .. } if *at >= since => false,
            _ => {
                *state = Probe::Running;
                true
            }
        });
        if !start {
            return;
        }
        self.probes.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let (pool, probe, recheck) = (self.pool.clone(), self.probe.clone(), self.recheck.clone());
        let (address, timeout) = (self.address.clone(), self.timeout);
        tokio::spawn(async move {
            use sqlx::{ConnectOptions as _, Connection as _};
            let check = async {
                // The driver resolves the name itself here, as for the pool's own connections. A
                // target the rules refuse is the answer; a name that does not resolve just now may
                // again before the pool gives up, as in `after_connect`.
                if let Some((policy, host, port)) = &recheck
                    && let Err(e) = super::recheck_name(policy, host, *port).await
                {
                    let blocked =
                        matches!(&e, sqlx::Error::Configuration(inner) if inner.is::<super::targets::Blocked>());
                    return if blocked { Outcome::Decisive(failed(e)) } else { Outcome::Failed(failed(e)) };
                }
                // The login runs in a task of its own: past the timeout the answer is "slow", and
                // the login still finishes and closes (up to `LOGIN_LIMIT` timeouts) instead of
                // being cut off in the middle of its handshake.
                let login = tokio::spawn(async move {
                    let login = async {
                        let c = pool.connect_options().connect().await?;
                        let _ = c.close().await;
                        Ok::<_, sqlx::Error>(())
                    };
                    tokio::time::timeout(timeout.saturating_mul(LOGIN_LIMIT), login).await
                });
                match tokio::time::timeout(timeout, login).await {
                    Ok(Ok(Ok(Ok(())))) => Outcome::Connected,
                    Ok(Ok(Ok(Err(sqlx::Error::Io(e))))) => {
                        Outcome::Decisive(SourceError::Failed(connect_failed(&address, &e, timeout)))
                    }
                    Ok(Ok(Ok(Err(e)))) => Outcome::Failed(failed(e)),
                    Ok(Ok(Err(_))) | Ok(Err(_)) | Err(_) => Outcome::Slow,
                }
            };
            // Bounded as a whole (name lookup included), so the state never stays `Running`.
            let outcome = tokio::time::timeout(timeout + PROBE_MARGIN, check).await.unwrap_or(Outcome::Slow);
            probe.send_replace(Probe::Done { at: Instant::now(), outcome });
        });
    }

    /// Why the pool ran out of time: a refused setup, a failed direct connect, a server that
    /// does not answer, or else a pool that had no free connection (busy, or logins that slow).
    async fn timed_out(&self, started: Instant) -> SourceError {
        if let Some(e) = self.setup.since(started) {
            return e;
        }
        let probe = self.probe.borrow().clone();
        match probe {
            Probe::Done { at, outcome: Outcome::Decisive(e) | Outcome::Failed(e) } if at >= started => e,
            Probe::Done { at, outcome: Outcome::Connected } if at >= started => {
                SourceError::Failed(pool_timed_out(self.timeout))
            }
            // The login has not finished: whether the server does not answer at all, or accepts
            // the connection and is slow to log in, a plain TCP connect tells. Only now, when the
            // pool has failed anyway, and once for all waiters, so a healthy MySQL never sees an
            // aborted handshake from it and a failing one one per timeout.
            Probe::Running | Probe::Done { outcome: Outcome::Slow, .. } => match self.reach(started).await {
                None => SourceError::Failed(pool_timed_out(self.timeout)),
                Some(cause) => SourceError::Failed(cause),
            },
            _ => SourceError::Failed(pool_timed_out(self.timeout)),
        }
    }

    /// The result of a plain TCP connect to the checked address finished since `since`: `None`
    /// when the server accepted it. Starts one unless one runs or finished since then.
    async fn reach(&self, since: Instant) -> Option<Detail> {
        let mut results = self.reach.subscribe();
        let start = self.reach.send_if_modified(|state| match state {
            Reach::Running => false,
            Reach::Done { at, .. } if *at >= since => false,
            _ => {
                *state = Reach::Running;
                true
            }
        });
        if start {
            self.reaches.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let (reach, addr, address, timeout) = (self.reach.clone(), self.addr, self.address.clone(), self.timeout);
            tokio::spawn(async move {
                let refused = match tokio::time::timeout(TCP_CHECK, tokio::net::TcpStream::connect(addr)).await {
                    Ok(Ok(_)) => None,
                    Ok(Err(e)) => Some(connect_failed(&address, &e, timeout)),
                    Err(_) => Some(timed_out(&address, timeout)),
                };
                reach.send_replace(Reach::Done { at: Instant::now(), refused });
            });
        }
        loop {
            if let Reach::Done { at, refused } = &*results.borrow_and_update()
                && *at >= since
            {
                return refused.clone();
            }
            if results.changed().await.is_err() {
                return None;
            }
        }
    }
}

/// How long the last check of a pool that ran out of time waits for a TCP connection. Windows
/// takes about two seconds to report a refused connection on its own.
const TCP_CHECK: Duration = Duration::from_secs(4);
/// The direct login may go on (unobserved) for this many timeouts, so it ends cleanly.
const LOGIN_LIMIT: u32 = 3;
/// What the direct check may take beyond the timeout as a whole (name lookup, closing).
const PROBE_MARGIN: Duration = Duration::from_secs(5);

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
        // A server that takes TCP connections and never logs anyone in.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let open = listener.local_addr().unwrap();
        let options = sqlx::postgres::PgConnectOptions::new_without_pgpass().host("127.0.0.1").port(open.port());
        let lazy = sqlx::postgres::PgPoolOptions::new().connect_lazy_with(options);
        let setup = SetupErrors::default();
        let pool = SqlPool::new(lazy, open, open.to_string(), Duration::from_secs(10), setup.clone(), None);
        let started = Instant::now();
        let done = |outcome| Probe::Done { at: Instant::now(), outcome };
        // Busy (nothing checked), or the direct connect logged in: no free connection.
        assert_eq!(pool.timed_out(started).await.detail().reason, "source.pool_timeout");
        pool.probe.send_replace(done(Outcome::Connected));
        assert_eq!(pool.timed_out(started).await.detail().params["seconds"], "10");
        // The login has not finished, but TCP is accepted: slow, not "no answer".
        pool.probe.send_replace(Probe::Running);
        assert_eq!(pool.timed_out(started).await.detail().reason, "source.pool_timeout");
        // A result from before this acquire is not its answer.
        let old = done(Outcome::Failed(SourceError::from_source("old")));
        pool.probe.send_replace(old);
        assert_eq!(pool.timed_out(Instant::now()).await.detail().reason, "source.pool_timeout");
        // A setup the server refused is the answer for every waiter, whatever the probe found,
        // until a setup succeeds again.
        let refuse = |e: sqlx::Error| SourceError::failed("mysql.no_time_limit", e.to_string());
        let kept = setup.keep(Err(sqlx::Error::Protocol("the server keeps sql_mode ANSI".into())), refuse);
        assert!(kept.is_err());
        assert_eq!(pool.timed_out(started).await.detail().reason, "mysql.no_time_limit");
        assert_eq!(pool.timed_out(started).await.detail().reason, "mysql.no_time_limit");
        assert!(setup.keep(Ok(()), refuse).is_ok());
        pool.probe.send_replace(Probe::Idle);
        assert_eq!(pool.timed_out(started).await.detail().reason, "source.pool_timeout");
        // An old refusal does not explain a later timeout either.
        let _ = setup.keep(Err(sqlx::Error::Protocol("old".into())), refuse);
        assert_eq!(pool.timed_out(Instant::now()).await.detail().reason, "source.pool_timeout");
        // Nothing listens any more: the last TCP check names the cause, one check for all
        // waiters of the same moment.
        drop(listener);
        pool.probe.send_replace(Probe::Running);
        let now = Instant::now();
        let before = pool.reaches.load(std::sync::atomic::Ordering::SeqCst);
        let waiters = futures_util::future::join_all((0..5).map(|_| pool.timed_out(now))).await;
        assert!(waiters.iter().all(|e| e.detail().reason == "source.connect_refused"));
        assert_eq!(pool.reaches.load(std::sync::atomic::Ordering::SeqCst), before + 1, "one TCP check");
    }

    #[tokio::test]
    async fn one_probe_per_pool_answers_every_waiter() {
        let addr = closed_port().await;
        let options = sqlx::postgres::PgConnectOptions::new_without_pgpass().host("127.0.0.1").port(addr.port());
        let lazy = sqlx::postgres::PgPoolOptions::new()
            .max_connections(8)
            .acquire_timeout(Duration::from_secs(10))
            .connect_lazy_with(options);
        let pool = SqlPool::new(lazy, addr, addr.to_string(), Duration::from_secs(10), SetupErrors::default(), None);
        let started = Instant::now();
        let waiters = (0..6).map(|_| pool.acquire(|e| SourceError::from_source(e.to_string())));
        for e in futures_util::future::join_all(waiters).await {
            assert_eq!(e.unwrap_err().detail().reason, "source.connect_refused");
        }
        assert!(started.elapsed() < Duration::from_secs(6), "took {:?}", started.elapsed());
        assert_eq!(pool.probes.load(std::sync::atomic::Ordering::SeqCst), 1);
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
        let pool = SqlPool::new(pool, addr, addr.to_string(), Duration::from_secs(10), SetupErrors::default(), None);
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
        let pool = SqlPool::new(pool, addr, addr.to_string(), Duration::from_secs(10), SetupErrors::default(), None);
        let started = std::time::Instant::now();
        let e = pool.acquire(|e| SourceError::from_source(e.to_string())).await.unwrap_err();
        assert!(started.elapsed() < Duration::from_secs(6), "took {:?}", started.elapsed());
        let d = e.detail();
        assert_eq!(d.reason, "source.connect_failed", "{d:?}");
        assert_eq!(d.params["address"], addr.to_string());
        assert!(d.params.contains_key("detail"));
    }
}
