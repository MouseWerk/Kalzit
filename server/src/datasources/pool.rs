//! A connection pool for drivers that bring none (SQL Server over tiberius, Bolt): a bounded
//! number of open connections, idle ones closed after `idle_timeout` by a sweep that runs while
//! any wait, a check of every idle connection before it is handed out, and no reuse of one that
//! broke. The sqlx sources (PostgreSQL, MySQL, SQLite) keep sqlx's own pool, which does the same.
//!
//! A connection goes back only through `Lease::release`, after a clean finish. A lease dropped
//! mid-use (a timeout, a cancelled request, a limit reached) hands its connection to
//! `Pooled::abandon` on a task of its own, which stops the server's work and closes it.

use std::future::Future;
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};

use tokio::sync::{OwnedSemaphorePermit, Semaphore};

use super::SourceError;
use crate::locks::MutexExt;

/// A connection the pool can hold.
pub trait Pooled: Send + 'static {
    /// Whether the connection may be handed out (again): open, in a known state, and the server
    /// has neither closed it nor sent anything unasked. Looks without waiting and without a
    /// round trip, so it runs under the pool's lock.
    fn reusable(&mut self) -> bool;

    /// Stops what the connection was doing on the server and closes it, for a lease dropped
    /// mid-use. Runs on a task of its own, since the request that dropped the lease may be gone.
    fn abandon(self) -> impl Future<Output = ()> + Send;
}

/// Whether an idle connection's socket is still open: nothing to read means it waits as it
/// should; the end of the stream (the server closed it), unasked data or an error mean it is not
/// to be used again. `socket` is a second handle on the connection's socket, non-blocking, so
/// the look neither waits nor consumes anything.
pub fn socket_open(socket: &std::net::TcpStream) -> bool {
    if socket.set_nonblocking(true).is_err() {
        return false;
    }
    matches!(socket.peek(&mut [0u8; 1]), Err(e) if e.kind() == std::io::ErrorKind::WouldBlock)
}

/// The longest time between two sweeps: an idle connection is closed at most this long after its
/// idle timeout ran out. A sweep only looks at the idle connections, without a round trip.
const MAX_SWEEP_GAP: Duration = Duration::from_secs(5);

pub struct ConnPool<C> {
    state: Mutex<State<C>>,
    slots: Arc<Semaphore>,
    idle_timeout: Duration,
}

struct State<C> {
    /// Idle connections with the time they came back, the most recent last.
    idle: Vec<(C, Instant)>,
    /// A sweep task runs (it ends once nothing is idle, and a release starts the next).
    sweeping: bool,
}

impl<C: Pooled> ConnPool<C> {
    /// At most `size` open connections; idle ones are closed after `idle_timeout`.
    pub fn new(size: usize, idle_timeout: Duration) -> Self {
        Self {
            state: Mutex::new(State { idle: Vec::new(), sweeping: false }),
            slots: Arc::new(Semaphore::new(size)),
            idle_timeout,
        }
    }

    /// A connection: an idle one that is still reusable, or a new one from `open`. Waits while
    /// every connection is on loan.
    pub async fn checkout<F, Fut>(self: &Arc<Self>, open: F) -> Result<Lease<C>, SourceError>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<C, SourceError>>,
    {
        let permit = self
            .slots
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| SourceError::failed("server.shutting_down", "the pool is closed"))?;
        let (conn, reused) = match self.take_idle() {
            Some(c) => (c, true),
            None => (open().await?, false),
        };
        Ok(Lease { pool: self.clone(), conn: Some(conn), reused, permit: Some(permit) })
    }

    /// The most recent idle connection that is not too old and still reusable; the others it
    /// passes are closed.
    fn take_idle(&self) -> Option<C> {
        let mut closed = Vec::new();
        let found = {
            let mut state = self.state.lock_or_recover();
            let mut found = None;
            while let Some((mut c, since)) = state.idle.pop() {
                if since.elapsed() < self.idle_timeout && c.reusable() {
                    found = Some(c);
                    break;
                }
                closed.push(c);
            }
            found
        };
        // Closed outside the lock.
        drop(closed);
        found
    }

    /// Closes the idle connections that waited too long or broke while they waited. Answers
    /// whether any are left.
    fn sweep(&self) -> bool {
        let mut state = self.state.lock_or_recover();
        let (keep, closed): (Vec<_>, Vec<_>) = std::mem::take(&mut state.idle)
            .into_iter()
            .map(|(mut c, since)| {
                let ok = since.elapsed() < self.idle_timeout && c.reusable();
                (ok, (c, since))
            })
            .partition(|(ok, _)| *ok);
        state.idle = keep.into_iter().map(|(_, e)| e).collect();
        let left = !state.idle.is_empty();
        if !left {
            state.sweeping = false;
        }
        drop(state);
        drop(closed);
        left
    }

    /// Closes every idle connection: one broke, and the others most likely went down with the
    /// same server.
    pub fn clear_idle(&self) {
        let idle = std::mem::take(&mut self.state.lock_or_recover().idle);
        drop(idle);
    }

    /// How many connections wait idle.
    pub fn idle_count(&self) -> usize {
        self.state.lock_or_recover().idle.len()
    }

    fn put_back(self: &Arc<Self>, mut conn: C) {
        if !conn.reusable() {
            return;
        }
        let start = {
            let mut state = self.state.lock_or_recover();
            state.idle.push((conn, Instant::now()));
            !std::mem::replace(&mut state.sweeping, true)
        };
        if start {
            self.start_sweep();
        }
    }

    /// Sweeps while connections wait, often enough that none outlives the idle timeout by more
    /// than `MAX_SWEEP_GAP`; ends with the pool or once nothing is idle.
    fn start_sweep(self: &Arc<Self>) {
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            self.state.lock_or_recover().sweeping = false;
            return;
        };
        let every = (self.idle_timeout / 4).clamp(Duration::from_millis(10), MAX_SWEEP_GAP);
        let pool: Weak<Self> = Arc::downgrade(self);
        runtime.spawn(async move {
            loop {
                tokio::time::sleep(every).await;
                let Some(pool) = pool.upgrade() else { return };
                if !pool.sweep() {
                    return;
                }
            }
        });
    }
}

/// A connection on loan, with its pool slot.
pub struct Lease<C: Pooled> {
    pool: Arc<ConnPool<C>>,
    conn: Option<C>,
    reused: bool,
    /// The pool slot; a dropped lease keeps it until its connection is closed, so the pool never
    /// has more open connections than slots.
    permit: Option<OwnedSemaphorePermit>,
}

impl<C: Pooled> Lease<C> {
    /// The connection waited in the pool before (it was not opened for this lease). Such a one
    /// may have broken unnoticed (a server gone without closing it), so a read-only query that
    /// fails on it before any result may run once more on a fresh connection.
    pub fn reused(&self) -> bool {
        self.reused
    }

    /// Back to the pool after a clean finish, unless the connection is no longer reusable.
    pub fn release(mut self) {
        if let Some(c) = self.conn.take() {
            self.pool.put_back(c);
        }
    }

    /// Closes a connection that broke, and the idle ones with it.
    pub fn discard(mut self) {
        self.conn = None;
        self.pool.clear_idle();
    }
}

impl<C: Pooled> std::ops::Deref for Lease<C> {
    type Target = C;
    fn deref(&self) -> &C {
        self.conn.as_ref().expect("a lease holds its connection until released")
    }
}

impl<C: Pooled> std::ops::DerefMut for Lease<C> {
    fn deref_mut(&mut self) -> &mut C {
        self.conn.as_mut().expect("a lease holds its connection until released")
    }
}

impl<C: Pooled> Drop for Lease<C> {
    fn drop(&mut self) {
        // Not released: given up mid-use. The slot is freed once the connection is closed.
        if let Some(c) = self.conn.take()
            && let Ok(runtime) = tokio::runtime::Handle::try_current()
        {
            let permit = self.permit.take();
            runtime.spawn(async move {
                c.abandon().await;
                drop(permit);
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    #[derive(Default)]
    struct Counts {
        opened: AtomicUsize,
        closed: AtomicUsize,
        abandoned: AtomicUsize,
    }

    struct Fake {
        alive: Arc<AtomicBool>,
        counts: Arc<Counts>,
    }

    impl Drop for Fake {
        fn drop(&mut self) {
            self.counts.closed.fetch_add(1, Ordering::SeqCst);
        }
    }

    impl Pooled for Fake {
        fn reusable(&mut self) -> bool {
            self.alive.load(Ordering::SeqCst)
        }

        async fn abandon(self) {
            self.counts.abandoned.fetch_add(1, Ordering::SeqCst);
        }
    }

    fn opener(counts: &Arc<Counts>) -> impl Fn() -> std::future::Ready<Result<Fake, SourceError>> + '_ {
        move || {
            counts.opened.fetch_add(1, Ordering::SeqCst);
            std::future::ready(Ok(Fake { alive: Arc::new(AtomicBool::new(true)), counts: counts.clone() }))
        }
    }

    fn n(a: &AtomicUsize) -> usize {
        a.load(Ordering::SeqCst)
    }

    #[tokio::test]
    async fn released_connections_are_reused() {
        let counts = Arc::new(Counts::default());
        let pool = Arc::new(ConnPool::new(2, Duration::from_secs(60)));
        let a = pool.checkout(opener(&counts)).await.unwrap();
        assert!(!a.reused());
        a.release();
        let b = pool.checkout(opener(&counts)).await.unwrap();
        assert!(b.reused());
        assert_eq!(n(&counts.opened), 1);
        b.release();
        assert_eq!(pool.idle_count(), 1);
    }

    #[tokio::test]
    async fn the_pool_is_bounded() {
        let counts = Arc::new(Counts::default());
        let pool = Arc::new(ConnPool::new(1, Duration::from_secs(60)));
        let a = pool.checkout(opener(&counts)).await.unwrap();
        let waiting = tokio::time::timeout(Duration::from_millis(50), pool.checkout(opener(&counts))).await;
        assert!(waiting.is_err(), "a second connection was opened past the bound");
        a.release();
        let b = tokio::time::timeout(Duration::from_secs(5), pool.checkout(opener(&counts))).await.unwrap().unwrap();
        assert!(b.reused());
        assert_eq!(n(&counts.opened), 1);
    }

    #[tokio::test]
    async fn broken_connections_are_never_reused() {
        let counts = Arc::new(Counts::default());
        let pool = Arc::new(ConnPool::new(2, Duration::from_secs(60)));
        // Broken while on loan: not put back.
        let a = pool.checkout(opener(&counts)).await.unwrap();
        a.alive.store(false, Ordering::SeqCst);
        a.release();
        assert_eq!(pool.idle_count(), 0);
        assert_eq!(n(&counts.closed), 1);
        // Broken while idle: closed at checkout, a fresh one is opened.
        let b = pool.checkout(opener(&counts)).await.unwrap();
        let alive = b.alive.clone();
        b.release();
        alive.store(false, Ordering::SeqCst);
        let c = pool.checkout(opener(&counts)).await.unwrap();
        assert!(!c.reused(), "the broken idle connection was handed out");
        assert_eq!((n(&counts.opened), n(&counts.closed)), (3, 2));
    }

    #[tokio::test]
    async fn idle_connections_past_the_timeout_are_swept_without_a_checkout() {
        let counts = Arc::new(Counts::default());
        let pool = Arc::new(ConnPool::new(2, Duration::from_millis(80)));
        let a = pool.checkout(opener(&counts)).await.unwrap();
        let b = pool.checkout(opener(&counts)).await.unwrap();
        a.release();
        b.release();
        assert_eq!(pool.idle_count(), 2);
        let deadline = Instant::now() + Duration::from_secs(5);
        while pool.idle_count() > 0 && Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert_eq!(pool.idle_count(), 0, "the sweep closed nothing");
        assert_eq!(n(&counts.closed), 2);
        assert!(!pool.state.lock_or_recover().sweeping, "the sweep ends once nothing is idle");
        // The next release starts it again.
        pool.checkout(opener(&counts)).await.unwrap().release();
        assert!(pool.state.lock_or_recover().sweeping);
    }

    #[tokio::test]
    async fn an_old_idle_connection_is_not_handed_out() {
        let counts = Arc::new(Counts::default());
        let pool = Arc::new(ConnPool::new(1, Duration::from_millis(30)));
        pool.checkout(opener(&counts)).await.unwrap().release();
        // Older than the timeout, whether or not the sweep got to it yet.
        std::thread::sleep(Duration::from_millis(40));
        let c = pool.checkout(opener(&counts)).await.unwrap();
        assert!(!c.reused());
        assert_eq!(n(&counts.opened), 2);
    }

    #[tokio::test]
    async fn a_socket_the_server_closed_or_wrote_to_is_not_open() {
        use tokio::io::AsyncWriteExt;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let probe_of = |s: &tokio::net::TcpStream| {
            let raw = s.peer_addr().unwrap();
            assert_eq!(raw, addr);
            // A second handle on the socket, as the SQL Server pool keeps one.
            #[cfg(unix)]
            let dup = {
                use std::os::fd::AsFd;
                std::net::TcpStream::from(s.as_fd().try_clone_to_owned().unwrap())
            };
            #[cfg(windows)]
            let dup = {
                use std::os::windows::io::AsSocket;
                std::net::TcpStream::from(s.as_socket().try_clone_to_owned().unwrap())
            };
            dup
        };
        // Idle: open.
        let client = tokio::net::TcpStream::connect(addr).await.unwrap();
        let (mut server, _) = listener.accept().await.unwrap();
        let probe = probe_of(&client);
        assert!(socket_open(&probe));
        // Unasked data: not open (and nothing consumed).
        server.write_all(b"x").await.unwrap();
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(!socket_open(&probe));
        assert!(!socket_open(&probe), "the look consumed the data");
        // Closed by the server: not open.
        let client = tokio::net::TcpStream::connect(addr).await.unwrap();
        let (server, _) = listener.accept().await.unwrap();
        let probe = probe_of(&client);
        drop(server);
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(!socket_open(&probe));
    }

    /// A connection that takes long to stop (a slow server) keeps its slot until it is closed.
    #[tokio::test]
    async fn an_abandoned_connection_keeps_its_slot_until_closed() {
        struct Slow(Arc<tokio::sync::Notify>);
        impl Pooled for Slow {
            fn reusable(&mut self) -> bool {
                true
            }
            async fn abandon(self) {
                self.0.notified().await;
            }
        }
        let stop = Arc::new(tokio::sync::Notify::new());
        let pool = Arc::new(ConnPool::new(1, Duration::from_secs(60)));
        let open = || std::future::ready(Ok(Slow(stop.clone())));
        drop(pool.checkout(open).await.unwrap());
        let waiting = tokio::time::timeout(Duration::from_millis(50), pool.checkout(open)).await;
        assert!(waiting.is_err(), "a second connection opened while the first was still closing");
        stop.notify_one();
        let next = tokio::time::timeout(Duration::from_secs(5), pool.checkout(open)).await;
        assert!(next.is_ok_and(|l| l.is_ok()));
    }

    #[test]
    fn idle_connections_are_closed_within_seconds_of_the_timeout() {
        let pool: ConnPool<Fake> = ConnPool::new(1, Duration::from_secs(300));
        assert!((pool.idle_timeout / 4).clamp(Duration::from_millis(10), MAX_SWEEP_GAP) <= Duration::from_secs(5));
    }

    #[tokio::test]
    async fn a_dropped_lease_is_abandoned_and_discard_clears_the_idle_ones() {
        let counts = Arc::new(Counts::default());
        let pool = Arc::new(ConnPool::new(3, Duration::from_secs(60)));
        let a = pool.checkout(opener(&counts)).await.unwrap();
        let b = pool.checkout(opener(&counts)).await.unwrap();
        let c = pool.checkout(opener(&counts)).await.unwrap();
        a.release();
        drop(b);
        let deadline = Instant::now() + Duration::from_secs(5);
        while n(&counts.abandoned) == 0 && Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert_eq!(n(&counts.abandoned), 1);
        assert_eq!(pool.idle_count(), 1);
        c.discard();
        assert_eq!(pool.idle_count(), 0, "the idle ones went with the broken one");
        // Every slot is free again.
        let all: Vec<_> = futures_util::future::join_all((0..3).map(|_| pool.checkout(opener(&counts)))).await;
        assert!(all.iter().all(Result::is_ok));
    }
}
