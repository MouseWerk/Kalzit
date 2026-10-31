//! Live updates: query results pushed to WebSocket clients (`routes::live`, docs/api/live.md).
//!
//! A subscription resolves to a `Spec`: queries the subscriber was authorized for, with their
//! time range rule, variables and refresh interval. Subscriptions with the same spec share one
//! `Feed`, a task that runs the queries and publishes the result message once for every
//! subscriber; each subscriber was authorized on its own (and is again periodically), so sharing a
//! result hands nobody more than they may see. A feed runs the queries again when its sources
//! report a change (MongoDB change streams), otherwise every `refresh`, never more often than
//! `Limits::min_refresh`; it ends when its last holder leaves.
//!
//! Feeds run with the query slots of their organization's live pool (the user `live:{orgId}` in
//! `DataSources::slots`), never with a subscriber's own: a user who left does not pay for a feed,
//! and many feeds share the slots of one user.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::panic::AssertUnwindSafe;
use std::sync::{Arc, Mutex, RwLock, Weak};
use std::task::Poll;
use std::time::Duration;

use axum::extract::ws::Utf8Bytes;
use axum::http::StatusCode;
use futures_util::{FutureExt, StreamExt};
use serde::Serialize;
use serde_json::Value;
use sha2::Digest;
use tokio::sync::{Notify, Semaphore, watch};
use tokio::time::Instant;

use crate::app::AppState;
use crate::auth::SessionUser;
use crate::authz::OrgCtx;
use crate::datasources::{Change, ChangeFeed, ResumeToken, SourceError, api_error_body, run_queries_with, watch_item};
use crate::error::ApiError;
use crate::locks::{MutexExt, RwLockExt};
use crate::shapes::{ErrorBody, LiveMode, QueryItem, TimeRange};

/// The bounds of live updates. Tests make the intervals short.
#[derive(Clone, Debug)]
pub struct Limits {
    /// Open connections of one user.
    pub connections_per_user: usize,
    /// Open connections on the server.
    pub connections: usize,
    pub subscriptions_per_connection: usize,
    /// Feeds running on the server, and distinct feeds one user follows.
    pub feeds: usize,
    pub feeds_per_user: usize,
    /// Bytes the latest results of all feeds may hold together, of the feeds one user started,
    /// and of one organization's feeds; and the largest result one feed may hold.
    pub held_bytes: usize,
    pub held_bytes_per_user: usize,
    pub held_bytes_per_org: usize,
    pub result_bytes: usize,
    /// Runs of the feeds one user started that may wait for or hold query slots at once.
    pub runs_per_user: usize,
    /// The shortest time between two runs of a feed, polled or after changes; also the shortest
    /// refresh a subscription may ask for.
    pub min_refresh: Duration,
    /// The refresh when a subscription asks for none.
    pub default_refresh: Duration,
    /// With change feeds, the queries still run this often (a pipeline may read the clock).
    pub changes_refresh: Duration,
    /// A change feed that failed is opened again after this long; meanwhile the feed polls.
    pub watch_retry: Duration,
    /// Open change feeds are reopened after this long, so changed settings and target rules of
    /// the source apply.
    pub watch_renew: Duration,
    /// How often the session and every subscription's access are checked again, and how many
    /// checks in a row may fail (database busy) before what they guard ends.
    pub recheck: Duration,
    pub check_failures: u32,
    /// How often the server pings; a client silent for `silence` is closed.
    pub ping: Duration,
    pub silence: Duration,
    /// A connection without subscriptions is closed after this long.
    pub idle: Duration,
    /// Messages waiting for a slow client; one more closes its connection.
    pub queue: usize,
    /// How long sending one message may take before the client counts as gone.
    pub send_timeout: Duration,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            connections_per_user: 8,
            connections: 1_000,
            subscriptions_per_connection: 50,
            feeds: 500,
            feeds_per_user: 100,
            held_bytes: 256 * 1024 * 1024,
            held_bytes_per_user: 32 * 1024 * 1024,
            held_bytes_per_org: 128 * 1024 * 1024,
            result_bytes: 8 * 1024 * 1024,
            runs_per_user: 2,
            min_refresh: Duration::from_secs(5),
            default_refresh: Duration::from_secs(30),
            changes_refresh: Duration::from_secs(300),
            watch_retry: Duration::from_secs(60),
            watch_renew: Duration::from_secs(600),
            recheck: Duration::from_secs(30),
            check_failures: 2,
            ping: Duration::from_secs(30),
            silence: Duration::from_secs(90),
            idle: Duration::from_secs(300),
            queue: 32,
            send_timeout: Duration::from_secs(10),
        }
    }
}

/// How long a stopping server waits for live connections to say goodbye.
pub const SHUTDOWN_WAIT: Duration = Duration::from_secs(2);

/// The longest refresh a subscription may ask for: a day.
pub const MAX_REFRESH: Duration = Duration::from_secs(24 * 3600);

#[derive(Default)]
struct Conns {
    per_user: HashMap<String, usize>,
    total: usize,
}

#[derive(Default)]
struct Feeds {
    by_key: HashMap<String, Weak<Feed>>,
    /// Per user, the feeds they hold and how many holds each.
    holds: HashMap<String, HashMap<String, usize>>,
}

/// The live connections and feeds of one server, in `AppState`.
pub struct Live {
    pub limits: RwLock<Limits>,
    conns: Mutex<Conns>,
    /// Notified when a connection ends, for `shutdown`.
    left: Notify,
    feeds: Mutex<Feeds>,
    /// Bytes the feeds' latest results hold (`Limits::held_bytes` and friends).
    held: Arc<Mutex<Budget>>,
    /// Per user, the runs of the feeds they started (`Limits::runs_per_user`).
    runs: Mutex<HashMap<String, Arc<Semaphore>>>,
    stop: watch::Sender<bool>,
}

impl Default for Live {
    fn default() -> Self {
        Self {
            limits: RwLock::default(),
            conns: Mutex::default(),
            left: Notify::new(),
            feeds: Mutex::default(),
            held: Arc::default(),
            runs: Mutex::default(),
            stop: watch::Sender::new(false),
        }
    }
}

/// Bytes held by the feeds' latest results: in all, per user who started a feed, per
/// organization.
#[derive(Debug, Default)]
struct Budget {
    total: usize,
    users: HashMap<String, usize>,
    orgs: HashMap<String, usize>,
}

/// An admitted connection; dropping it frees its place.
pub struct Slot {
    live: Arc<Live>,
    user_id: String,
}

impl Drop for Slot {
    fn drop(&mut self) {
        let mut conns = self.live.conns.lock_or_recover();
        if let Some(n) = conns.per_user.get_mut(&self.user_id) {
            *n -= 1;
            if *n == 0 {
                conns.per_user.remove(&self.user_id);
            }
        }
        conns.total -= 1;
        drop(conns);
        self.live.left.notify_waiters();
    }
}

/// A user's hold on a feed; the feed runs while anyone holds it.
pub struct Hold {
    live: Arc<Live>,
    user_id: String,
    pub feed: Arc<Feed>,
}

impl Drop for Hold {
    fn drop(&mut self) {
        let mut feeds = self.live.feeds.lock_or_recover();
        if let Some(mine) = feeds.holds.get_mut(&self.user_id) {
            if let Some(n) = mine.get_mut(&self.feed.id) {
                *n -= 1;
                if *n == 0 {
                    mine.remove(&self.feed.id);
                }
            }
            if mine.is_empty() {
                feeds.holds.remove(&self.user_id);
            }
        }
    }
}

impl Live {
    pub fn limits(&self) -> Limits {
        self.limits.read_or_recover().clone()
    }

    /// A place for one more connection of `user_id`, within the limits; refused while the server
    /// stops.
    pub fn admit(self: &Arc<Self>, user_id: &str) -> Result<Slot, ApiError> {
        if *self.stop.borrow() {
            return Err(shutting_down());
        }
        let limits = self.limits();
        let mut conns = self.conns.lock_or_recover();
        let mine = conns.per_user.get(user_id).copied().unwrap_or(0);
        if mine >= limits.connections_per_user {
            let max = limits.connections_per_user;
            return Err(ApiError::new(
                StatusCode::TOO_MANY_REQUESTS,
                "rate_limited",
                format!("at most {max} live connections per user"),
            )
            .because("live.too_many")
            .param("max", max));
        }
        if conns.total >= limits.connections {
            return Err(ApiError::busy().because("live.server_busy").param("max", limits.connections));
        }
        *conns.per_user.entry(user_id.to_string()).or_default() += 1;
        conns.total += 1;
        Ok(Slot { live: self.clone(), user_id: user_id.to_string() })
    }

    /// Open connections.
    pub fn connections(&self) -> usize {
        self.conns.lock_or_recover().total
    }

    /// Changes to `true` when the server stops.
    pub fn stopping(&self) -> watch::Receiver<bool> {
        self.stop.subscribe()
    }

    /// Tells every connection to close (`live.shutting_down`); new ones are refused.
    pub fn begin_shutdown(&self) {
        self.stop.send_replace(true);
    }

    /// `begin_shutdown`, then waits up to `wait` for the connections to close.
    pub async fn shutdown(&self, wait: Duration) {
        self.begin_shutdown();
        let _ = tokio::time::timeout(wait, async {
            loop {
                let left = self.left.notified();
                if self.connections() == 0 {
                    return;
                }
                left.await;
            }
        })
        .await;
    }

    /// A hold of `user_id` on the feed of `spec`: the running one, or a new one. Refused when the
    /// user follows `feeds_per_user` other feeds, or a new feed would pass `feeds`.
    pub fn hold(self: &Arc<Self>, state: &AppState, user_id: &str, spec: Spec) -> Result<Hold, ApiError> {
        let limits = self.limits();
        let key = spec.key();
        let mut feeds = self.feeds.lock_or_recover();
        feeds.by_key.retain(|_, f| f.strong_count() > 0);
        let existing = feeds.by_key.get(&key).and_then(Weak::upgrade);
        let held = feeds.holds.get(user_id);
        let already = existing.as_ref().is_some_and(|f| held.is_some_and(|h| h.contains_key(&f.id)));
        if !already && held.map_or(0, HashMap::len) >= limits.feeds_per_user {
            let max = limits.feeds_per_user;
            return Err(ApiError::new(
                StatusCode::TOO_MANY_REQUESTS,
                "rate_limited",
                format!("at most {max} live feeds per user"),
            )
            .because("live.too_many_feeds")
            .param("max", max));
        }
        let feed = match existing {
            Some(feed) => feed,
            None => {
                if feeds.by_key.len() >= limits.feeds {
                    return Err(ApiError::busy().because("live.feeds_busy").param("max", limits.feeds));
                }
                // A user (or organization) whose feeds hold their share of the memory budget
                // starts no new ones; running feeds, theirs and others', go on.
                self.budget_left(user_id, &spec.org_id, &limits)?;
                let feed = self.start(state, spec, key.clone(), user_id);
                feeds.by_key.insert(key, Arc::downgrade(&feed));
                feed
            }
        };
        *feeds.holds.entry(user_id.to_string()).or_default().entry(feed.id.clone()).or_default() += 1;
        Ok(Hold { live: self.clone(), user_id: user_id.to_string(), feed })
    }

    /// Refuses a new feed of `user_id` in `org_id` when their feeds, the organization's or all
    /// together hold their share of the memory budget.
    fn budget_left(&self, user_id: &str, org_id: &str, limits: &Limits) -> Result<(), ApiError> {
        let budget = self.held.lock_or_recover();
        let full = [
            (budget.users.get(user_id).copied().unwrap_or(0), limits.held_bytes_per_user),
            (budget.orgs.get(org_id).copied().unwrap_or(0), limits.held_bytes_per_org),
            (budget.total, limits.held_bytes),
        ]
        .into_iter()
        .find(|(held, max)| held >= max);
        match full {
            Some((_, max)) => Err(ApiError::busy().because("live.memory_limit").param("max", max)),
            None => Ok(()),
        }
    }

    fn start(&self, state: &AppState, spec: Spec, key: String, owner: &str) -> Arc<Feed> {
        let id = uuid::Uuid::now_v7().to_string();
        let (tx, rx) = watch::channel(FeedState::default());
        let tx = Arc::new(tx);
        let refresh_ms = spec.refresh_ms;
        let feed = FeedRef { id: id.clone(), key: key.clone(), owner: owner.to_string() };
        let run = run_feed(state.clone(), feed.clone(), spec, self.held.clone(), tx.clone());
        let live = state.live.clone();
        let task = tokio::spawn(async move {
            if AssertUnwindSafe(run).catch_unwind().await.is_err() {
                tracing::error!("live: a feed stopped unexpectedly");
                let error = api_error_body(ApiError::internal("live", "the feed stopped unexpectedly"));
                live.forget(&feed);
                tx.send_modify(|s| s.failed = Some(error));
            }
        });
        Arc::new(Feed { id, key, refresh_ms, state: rx, task: task.abort_handle() })
    }

    /// A feed that ended is no longer offered to new subscribers.
    fn forget(&self, feed: &FeedRef) {
        let mut feeds = self.feeds.lock_or_recover();
        let current = feeds.by_key.get(&feed.key).and_then(Weak::upgrade);
        if current.is_some_and(|f| f.id == feed.id) {
            feeds.by_key.remove(&feed.key);
        }
    }

    /// The run permits of the feeds `owner` started. Waiting runs queue there, so many feeds of
    /// one user cannot fill the organization's query slots ahead of everyone else's.
    fn run_permits(&self, owner: &str, limits: &Limits) -> Arc<Semaphore> {
        let mut runs = self.runs.lock_or_recover();
        // Forget users without running feeds, so the map does not grow with every user seen.
        runs.retain(|_, s| Arc::strong_count(s) > 1);
        runs.entry(owner.to_string()).or_insert_with(|| Arc::new(Semaphore::new(limits.runs_per_user.max(1)))).clone()
    }

    /// Feeds running now.
    pub fn feeds(&self) -> usize {
        self.feeds.lock_or_recover().by_key.values().filter(|f| f.strong_count() > 0).count()
    }

    /// Bytes the feeds' latest results hold.
    pub fn held_bytes(&self) -> usize {
        self.held.lock_or_recover().total
    }
}

/// Who a feed is: its id and key, and the user who started it (charged with its memory and
/// runs).
#[derive(Clone, Debug)]
struct FeedRef {
    id: String,
    key: String,
    owner: String,
}

pub fn shutting_down() -> ApiError {
    ApiError::busy().because("live.shutting_down")
}

/// Which time range a run uses: a fixed one, or the last `ms` before the run.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub enum RangeRule {
    Fixed(TimeRange),
    Last(u64),
}

impl RangeRule {
    pub fn at(self, now_ms: i64) -> TimeRange {
        match self {
            Self::Fixed(r) => r,
            Self::Last(ms) => TimeRange { from: now_ms.saturating_sub(ms.min(i64::MAX as u64) as i64), to: now_ms },
        }
    }
}

/// What a feed runs; equal specs share a feed.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Spec {
    pub org_id: String,
    pub items: Vec<QueryItem>,
    pub range: RangeRule,
    pub interval_ms: Option<u64>,
    pub max_data_points: Option<u32>,
    pub variables: BTreeMap<String, Value>,
    /// Variables that may be identifiers (a dashboard's stored queries); `None` for free queries.
    pub identifiers: Option<BTreeSet<String>>,
    pub refresh_ms: u64,
    /// The dashboard and panel whose stored queries these are, for the usage counts
    /// (`usage::record_panel`); `None` for free queries.
    pub panel: Option<(String, String)>,
}

impl Spec {
    pub fn key(&self) -> String {
        let text = serde_json::to_string(self).unwrap_or_default();
        hex::encode(sha2::Sha256::digest(text.as_bytes()))
    }
}

/// Bytes counted in `Live::held` while a result is kept, charged to the user who started the
/// feed and to its organization.
#[derive(Debug)]
struct HeldBytes {
    budget: Arc<Mutex<Budget>>,
    user: String,
    org: String,
    bytes: usize,
}

impl HeldBytes {
    /// Charges `bytes`, or answers the limit it would pass: the result's own, the user's, the
    /// organization's or the server's.
    fn take(budget: &Arc<Mutex<Budget>>, user: &str, org: &str, bytes: usize, limits: &Limits) -> Result<Self, usize> {
        if bytes > limits.result_bytes {
            return Err(limits.result_bytes);
        }
        let mut b = budget.lock_or_recover();
        let mine = b.users.get(user).copied().unwrap_or(0);
        let ours = b.orgs.get(org).copied().unwrap_or(0);
        for (held, max) in
            [(mine, limits.held_bytes_per_user), (ours, limits.held_bytes_per_org), (b.total, limits.held_bytes)]
        {
            if held + bytes > max {
                return Err(max);
            }
        }
        b.total += bytes;
        *b.users.entry(user.to_string()).or_default() += bytes;
        *b.orgs.entry(org.to_string()).or_default() += bytes;
        Ok(Self { budget: budget.clone(), user: user.to_string(), org: org.to_string(), bytes })
    }
}

impl Drop for HeldBytes {
    fn drop(&mut self) {
        let mut guard = self.budget.lock_or_recover();
        let b = &mut *guard;
        b.total -= self.bytes;
        for (map, key) in [(&mut b.users, &self.user), (&mut b.orgs, &self.org)] {
            if let Some(n) = map.get_mut(key) {
                *n -= self.bytes;
                if *n == 0 {
                    map.remove(key);
                }
            }
        }
    }
}

/// The latest results of a feed: the whole `result` message, made once and shared by every
/// subscriber's queue.
#[derive(Clone, Debug)]
pub struct Published {
    /// Counts up with every new result.
    pub seq: u64,
    pub message: Utf8Bytes,
    _held: Arc<HeldBytes>,
}

#[derive(Clone, Debug, Default)]
pub struct FeedState {
    /// `None` until the feed has decided.
    pub mode: Option<LiveMode>,
    pub reason: Option<&'static str>,
    pub results: Option<Published>,
    /// The feed ended; its subscriptions end with this error.
    pub failed: Option<ErrorBody>,
}

/// One running set of queries; the task stops when the last holder drops it.
pub struct Feed {
    /// Named in the messages about it.
    pub id: String,
    pub key: String,
    pub refresh_ms: u64,
    state: watch::Receiver<FeedState>,
    task: tokio::task::AbortHandle,
}

impl Feed {
    pub fn subscribe(&self) -> watch::Receiver<FeedState> {
        self.state.clone()
    }
}

impl Drop for Feed {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// A query's change feed.
enum Watch {
    Open {
        feed: ChangeFeed,
        token: Option<ResumeToken>,
        since: Instant,
    },
    /// Not open; tried again from `retry_at`. `reason`: why the last try failed.
    Closed {
        retry_at: Instant,
        token: Option<ResumeToken>,
        reason: &'static str,
    },
    /// The source cannot report changes.
    Unsupported,
}

/// The context feeds run their queries with: the organization's live slot pool.
fn feed_ctx(state: &AppState, org_id: &str) -> OrgCtx {
    let user =
        SessionUser { id: format!("live:{org_id}"), email: String::new(), name: String::new(), is_server_admin: 0 };
    OrgCtx {
        user,
        org_id: org_id.to_string(),
        role: String::new(),
        permissions: BTreeSet::new(),
        at_ms: state.clock.now_ms(),
    }
}

/// Opens the change feeds that are due, and reopens those open longer than `watch_renew`.
async fn open_due(state: &AppState, ctx: &OrgCtx, spec: &Spec, watches: &mut [Watch], limits: &Limits) {
    let now = Instant::now();
    for (i, w) in watches.iter_mut().enumerate() {
        if let Watch::Open { token, since, .. } = w
            && now.duration_since(*since) >= limits.watch_renew
        {
            *w = Watch::Closed { retry_at: now, token: token.take(), reason: "live.changes_unavailable" };
        }
        let Watch::Closed { retry_at, token, .. } = w else { continue };
        if now < *retry_at {
            continue;
        }
        let token = token.take();
        let item = &spec.items[i];
        let range = spec.range.at(state.clock.now_ms());
        let opened = watch_item(
            state,
            ctx,
            item,
            range,
            spec.interval_ms,
            spec.max_data_points,
            &spec.variables,
            spec.identifiers.as_ref(),
            token.clone(),
        )
        .await;
        *w = match opened {
            Ok(Some(feed)) => Watch::Open { feed, token, since: Instant::now() },
            Ok(None) => Watch::Unsupported,
            Err(e) => {
                tracing::debug!(datasource = %item.datasource_id, code = e.code, "live: no change feed: {}", e.message);
                let reason = if e.reason.as_deref() == Some("mongodb.streams_limit") {
                    "live.streams_limit"
                } else {
                    "live.changes_unavailable"
                };
                // The source restarts a feed whose token's history is gone; the token is kept for
                // the next try.
                Watch::Closed { retry_at: Instant::now() + limits.watch_retry, token, reason }
            }
        };
    }
}

/// The next report of any open feed: its index and what it reported. The feeds are polled from
/// `start` on, so a busy one cannot starve the others.
fn next_change(
    watches: &mut [Watch],
    start: usize,
) -> impl std::future::Future<Output = (usize, Option<Result<Change, SourceError>>)> + '_ {
    futures_util::future::poll_fn(move |cx| {
        let n = watches.len();
        for k in 0..n {
            let i = (start + k) % n;
            if let Watch::Open { feed, .. } = &mut watches[i]
                && let Poll::Ready(event) = feed.poll_next_unpin(cx)
            {
                return Poll::Ready((i, event));
            }
        }
        Poll::Pending
    })
}

/// Takes one report of feed `i` into account: a new token, or a closed feed. True when the
/// result may have changed (a change, or a feed that closed and is polled now).
fn absorb(watches: &mut [Watch], i: usize, event: Option<Result<Change, SourceError>>, limits: &Limits) -> bool {
    let retry_at = Instant::now() + limits.watch_retry;
    match event {
        Some(Ok(change)) => {
            if let (Watch::Open { token, .. }, Some(new)) = (&mut watches[i], change.token) {
                *token = Some(new);
            }
            change.changed
        }
        Some(Err(e)) => {
            tracing::debug!(code = e.code(), "live: change feed failed: {}", e.detail().message);
            let token = match &mut watches[i] {
                Watch::Open { token, .. } => token.take(),
                _ => None,
            };
            watches[i] = Watch::Closed { retry_at, token, reason: "live.changes_unavailable" };
            true
        }
        // The feed ended (the collection was dropped or renamed): start over later.
        None => {
            watches[i] = Watch::Closed { retry_at, token: None, reason: "live.changes_unavailable" };
            true
        }
    }
}

/// Reports that are ready now, without waiting.
fn absorb_ready(watches: &mut [Watch], start: usize, limits: &Limits) {
    while let Some((i, event)) = next_change(watches, start).now_or_never() {
        absorb(watches, i, event, limits);
    }
}

/// The `result` message of a feed.
fn result_message(feed: &str, at: i64, results: &str) -> String {
    let feed = serde_json::to_string(feed).unwrap_or_default();
    format!(r#"{{"type":"result","feed":{feed},"at":{at},"results":{results}}}"#)
}

async fn run_feed(
    state: AppState,
    feed: FeedRef,
    spec: Spec,
    held: Arc<Mutex<Budget>>,
    tx: Arc<watch::Sender<FeedState>>,
) {
    let limits = state.live.limits();
    let runs = state.live.run_permits(&feed.owner, &limits);
    let ctx = feed_ctx(&state, &spec.org_id);
    let refresh = Duration::from_millis(spec.refresh_ms).max(limits.min_refresh);
    // Change feeds only help with a fixed range; a moving one needs runs anyway.
    let wants_changes = matches!(spec.range, RangeRule::Fixed(_)) && !spec.items.is_empty();
    let start = Instant::now();
    let mut watches: Vec<Watch> = spec
        .items
        .iter()
        .map(|_| {
            if wants_changes {
                Watch::Closed { retry_at: start, token: None, reason: "live.changes_unavailable" }
            } else {
                Watch::Unsupported
            }
        })
        .collect();
    // The hash of the last results published, so unchanged results are not sent again.
    let mut last: Option<[u8; 32]> = None;
    // The latest results did not fit the memory budget; the last ones that did stay.
    let mut held_back = false;
    let mut seq = 0;
    let mut turn = 0usize;
    loop {
        if wants_changes {
            open_due(&state, &ctx, &spec, &mut watches, &limits).await;
        }
        let changes = wants_changes && watches.iter().all(|w| matches!(w, Watch::Open { .. }));
        let reason = if changes || !wants_changes {
            None
        } else if watches.iter().any(|w| matches!(w, Watch::Unsupported)) {
            Some("live.source_unsupported")
        } else if watches.iter().any(|w| matches!(w, Watch::Closed { reason: "live.streams_limit", .. })) {
            Some("live.streams_limit")
        } else {
            Some("live.changes_unavailable")
        };
        let mode = if changes { LiveMode::Changes } else { LiveMode::Poll };
        let set_status = |held_back: bool| {
            let reason = if held_back { Some("live.memory_limit") } else { reason };
            tx.send_if_modified(|s| {
                let modified = s.mode != Some(mode) || s.reason != reason;
                s.mode = Some(mode);
                s.reason = reason;
                modified
            });
        };
        set_status(held_back);
        // One run of this feed at a time, and at most `runs_per_user` of its owner's feeds.
        let Ok(permit) = runs.clone().acquire_owned().await else { return };
        let at = state.clock.now_ms();
        let started = Instant::now();
        let response = run_queries_with(
            &state,
            &ctx,
            spec.items.clone(),
            spec.range.at(at),
            spec.interval_ms,
            spec.max_data_points,
            &spec.variables,
            spec.identifiers.as_ref(),
        )
        .await;
        // A panel's refresh counts as a run of that panel (per feed, not per viewer).
        if let Some((dashboard_id, panel_id)) = &spec.panel {
            let ms = i64::try_from(started.elapsed().as_millis()).unwrap_or(i64::MAX);
            let run = crate::usage::PanelRun::of(&response, ms);
            crate::usage::record_panel(&state, &spec.org_id, dashboard_id, panel_id, run).await;
        }
        let json = match serde_json::to_string(&response.results) {
            Ok(json) => json,
            Err(e) => {
                tracing::error!("live: a result cannot be serialized: {e}");
                "{}".into()
            }
        };
        drop(response);
        drop(permit);
        let hash: [u8; 32] = sha2::Sha256::digest(json.as_bytes()).into();
        if last != Some(hash) {
            let message = result_message(&feed.id, at, &json);
            drop(json);
            match HeldBytes::take(&held, &feed.owner, &spec.org_id, message.len(), &limits) {
                Ok(bytes) => {
                    seq += 1;
                    let published = Published { seq, message: message.into(), _held: Arc::new(bytes) };
                    tx.send_modify(|s| s.results = Some(published));
                    last = Some(hash);
                    if held_back {
                        held_back = false;
                        set_status(false);
                    }
                }
                // A new feed whose first result does not fit ends; a running one keeps its last
                // result and says why it holds back, until a result fits again.
                Err(max) if seq == 0 => {
                    let e = ApiError::busy().because("live.memory_limit").param("max", max);
                    state.live.forget(&feed);
                    tx.send_modify(|s| s.failed = Some(api_error_body(e)));
                    return;
                }
                Err(_) => {
                    held_back = true;
                    set_status(true);
                }
            }
        }
        let ran = Instant::now();
        let mut next_run = ran + if changes { limits.changes_refresh } else { refresh };
        // Change feeds due to be reopened or tried again wake the feed (it runs after an open).
        for w in &watches {
            let due = match w {
                Watch::Open { since, .. } => Some(*since + limits.watch_renew),
                Watch::Closed { retry_at, .. } => Some(*retry_at),
                Watch::Unsupported => None,
            };
            if let Some(due) = due {
                next_run = next_run.min(due.max(ran + limits.min_refresh));
            }
        }
        // Waits for the next run: its time, or a change (reports that only move the resume token
        // keep waiting). Runs keep `min_refresh` apart, however many changes come in.
        loop {
            tokio::select! {
                () = tokio::time::sleep_until(next_run) => break,
                (i, event) = next_change(&mut watches, turn) => {
                    turn = turn.wrapping_add(1);
                    if absorb(&mut watches, i, event, &limits) {
                        tokio::time::sleep_until(ran + limits.min_refresh).await;
                        absorb_ready(&mut watches, turn, &limits);
                        break;
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connections_are_limited_per_user_and_server() {
        let live = Arc::new(Live::default());
        *live.limits.write().unwrap() = Limits { connections_per_user: 2, connections: 3, ..Limits::default() };
        let a1 = live.admit("a").unwrap();
        let _a2 = live.admit("a").unwrap();
        let e = live.admit("a").err().unwrap();
        assert_eq!((e.code, e.reason.as_ref().unwrap().code.as_str()), ("rate_limited", "live.too_many"));
        let _b1 = live.admit("b").unwrap();
        let e = live.admit("c").err().unwrap();
        assert_eq!((e.code, e.reason.as_ref().unwrap().code.as_str()), ("busy", "live.server_busy"));
        drop(a1);
        assert_eq!(live.connections(), 2);
        let _c1 = live.admit("c").unwrap();
        live.begin_shutdown();
        let e = live.admit("d").err().unwrap();
        assert_eq!(e.reason.unwrap().code, "live.shutting_down");
    }

    #[test]
    fn held_results_stay_within_their_budget() {
        let limits = Limits {
            held_bytes: 100,
            held_bytes_per_user: 50,
            held_bytes_per_org: 80,
            result_bytes: 40,
            ..Limits::default()
        };
        let budget = Arc::new(Mutex::new(Budget::default()));
        let take = |user: &str, org: &str, bytes| HeldBytes::take(&budget, user, org, bytes, &limits);
        assert_eq!(take("a", "o", 41).err(), Some(40), "larger than one result may be");
        let a1 = take("a", "o", 30).unwrap();
        assert_eq!(take("a", "o", 30).err(), Some(50), "the user's share");
        let b1 = take("b", "o", 40).unwrap();
        assert_eq!(take("c", "o", 20).err(), Some(80), "the organization's share");
        let c1 = take("c", "p", 30).unwrap();
        assert_eq!(take("d", "q", 1).err(), Some(100), "the server's budget");
        assert_eq!(budget.lock().unwrap().total, 100);
        drop((a1, b1, c1));
        let b = budget.lock().unwrap();
        assert_eq!((b.total, b.users.len(), b.orgs.len()), (0, 0, 0));
    }

    #[test]
    fn a_moving_range_ends_now() {
        let fixed = TimeRange { from: 1, to: 2 };
        assert_eq!(RangeRule::Fixed(fixed).at(99), fixed);
        assert_eq!(RangeRule::Last(10).at(100), TimeRange { from: 90, to: 100 });
        assert_eq!(RangeRule::Last(u64::MAX).at(100).from, i64::MIN + 101);
    }

    #[test]
    fn equal_specs_share_a_key() {
        let spec = Spec {
            org_id: "o".into(),
            items: Vec::new(),
            range: RangeRule::Last(1_000),
            interval_ms: None,
            max_data_points: None,
            variables: BTreeMap::new(),
            identifiers: None,
            refresh_ms: 5_000,
            panel: None,
        };
        let mut other = spec.clone();
        assert_eq!(spec.key(), other.key());
        other.refresh_ms = 6_000;
        assert_ne!(spec.key(), other.key());
        other.refresh_ms = 5_000;
        other.identifiers = Some(BTreeSet::new());
        assert_ne!(spec.key(), other.key());
    }

    #[test]
    fn result_messages_match_their_type() {
        let raw = result_message("f\"1", 42, r#"{"A":{"error":{"code":"internal","message":"x"}}}"#);
        let parsed: crate::shapes::LiveMessage = serde_json::from_str(&raw).unwrap();
        let crate::shapes::LiveMessage::Result { feed, at, results } = &parsed else { panic!("{raw}") };
        assert_eq!((feed.as_str(), *at), ("f\"1", 42));
        assert!(matches!(results.get("A"), Some(crate::shapes::QueryOutcome::Err { .. })));
        assert_eq!(serde_json::to_value(&parsed).unwrap(), serde_json::from_str::<Value>(&raw).unwrap());
    }
}
