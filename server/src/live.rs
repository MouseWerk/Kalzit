//! Live updates: query results pushed to WebSocket clients (`routes::live`, docs/api/live.md).
//!
//! A subscription resolves to a `Spec`: queries the subscriber was authorized for, with their
//! time range rule, variables and refresh interval. Subscriptions with the same spec share one
//! `Feed`, a task that runs the queries and publishes the result; every subscriber was authorized
//! on its own (and is again periodically), so sharing a result hands nobody more than they may
//! see. A feed runs the queries again when its sources report a change (MongoDB change streams),
//! otherwise every `refresh`; it ends when its last subscriber leaves.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::{Arc, Mutex, RwLock, Weak};
use std::task::Poll;
use std::time::Duration;

use axum::http::StatusCode;
use futures_util::{FutureExt, StreamExt};
use serde::Serialize;
use serde_json::Value;
use sha2::Digest;
use tokio::sync::{Notify, watch};
use tokio::time::Instant;

use crate::app::AppState;
use crate::authz::OrgCtx;
use crate::datasources::{ChangeFeed, ResumeToken, SourceError, run_queries_with, watch_item};
use crate::error::ApiError;
use crate::shapes::{LiveMode, QueryItem, TimeRange};

/// The bounds of live updates. Tests make the intervals short.
#[derive(Clone, Debug)]
pub struct Limits {
    /// Open connections of one user.
    pub connections_per_user: usize,
    /// Open connections on the server.
    pub connections: usize,
    pub subscriptions_per_connection: usize,
    /// The shortest refresh a subscription may ask for, and the refresh when it asks for none.
    pub min_refresh: Duration,
    pub default_refresh: Duration,
    /// After a reported change, the queries run again at most this often.
    pub change_spacing: Duration,
    /// With change feeds, the queries still run this often (a pipeline may read the clock).
    pub changes_refresh: Duration,
    /// A change feed that failed is opened again after this long; meanwhile the feed polls.
    pub watch_retry: Duration,
    /// Open change feeds are reopened after this long, so changed settings and target rules of
    /// the source apply.
    pub watch_renew: Duration,
    /// How often the session and every subscription's access are checked again.
    pub recheck: Duration,
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
            min_refresh: Duration::from_secs(5),
            default_refresh: Duration::from_secs(30),
            change_spacing: Duration::from_secs(1),
            changes_refresh: Duration::from_secs(300),
            watch_retry: Duration::from_secs(60),
            watch_renew: Duration::from_secs(600),
            recheck: Duration::from_secs(30),
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

/// The live connections and feeds of one server, in `AppState`.
pub struct Live {
    pub limits: RwLock<Limits>,
    conns: Mutex<Conns>,
    /// Notified when a connection ends, for `shutdown`.
    left: Notify,
    feeds: Mutex<HashMap<String, Weak<Feed>>>,
    stop: watch::Sender<bool>,
}

impl Default for Live {
    fn default() -> Self {
        Self {
            limits: RwLock::default(),
            conns: Mutex::default(),
            left: Notify::new(),
            feeds: Mutex::default(),
            stop: watch::Sender::new(false),
        }
    }
}

/// An admitted connection; dropping it frees its place.
pub struct Slot {
    live: Arc<Live>,
    user_id: String,
}

impl Drop for Slot {
    fn drop(&mut self) {
        let mut conns = self.live.conns.lock().expect("live connections lock");
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

impl Live {
    pub fn limits(&self) -> Limits {
        self.limits.read().expect("live limits lock").clone()
    }

    /// A place for one more connection of `user_id`, within the limits; refused while the server
    /// stops.
    pub fn admit(self: &Arc<Self>, user_id: &str) -> Result<Slot, ApiError> {
        if *self.stop.borrow() {
            return Err(shutting_down());
        }
        let limits = self.limits();
        let mut conns = self.conns.lock().expect("live connections lock");
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
        self.conns.lock().expect("live connections lock").total
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

    /// The feed of `spec`: the running one, or a new one that runs with `ctx` (its user's query
    /// slots).
    pub fn feed(&self, state: &AppState, ctx: &OrgCtx, spec: Spec) -> Arc<Feed> {
        let key = spec.key();
        let mut feeds = self.feeds.lock().expect("live feeds lock");
        feeds.retain(|_, f| f.strong_count() > 0);
        if let Some(feed) = feeds.get(&key).and_then(Weak::upgrade) {
            return feed;
        }
        let (tx, rx) = watch::channel(FeedState::default());
        let task = tokio::spawn(run_feed(state.clone(), ctx.clone(), spec.clone(), tx));
        let feed =
            Arc::new(Feed { key: key.clone(), refresh_ms: spec.refresh_ms, state: rx, task: task.abort_handle() });
        feeds.insert(key, Arc::downgrade(&feed));
        feed
    }

    /// Feeds running now.
    pub fn feeds(&self) -> usize {
        self.feeds.lock().expect("live feeds lock").values().filter(|f| f.strong_count() > 0).count()
    }
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
}

impl Spec {
    pub fn key(&self) -> String {
        let text = serde_json::to_string(self).unwrap_or_default();
        hex::encode(sha2::Sha256::digest(text.as_bytes()))
    }
}

/// The latest results of a feed: serialized once, sent to every subscriber.
#[derive(Clone, Debug)]
pub struct Published {
    /// Counts up with every new result.
    pub seq: u64,
    pub at: i64,
    /// The `results` object of `POST /query`.
    pub json: Arc<str>,
}

#[derive(Clone, Debug, Default)]
pub struct FeedState {
    /// `None` until the feed has decided.
    pub mode: Option<LiveMode>,
    pub reason: Option<&'static str>,
    pub results: Option<Published>,
}

/// One running set of queries; the task stops when the last holder drops it.
pub struct Feed {
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
    /// Not open; tried again from `retry_at`.
    Closed {
        retry_at: Instant,
        token: Option<ResumeToken>,
    },
    /// The source cannot report changes.
    Unsupported,
}

/// Opens the change feeds that are due, and reopens those open longer than `watch_renew`.
async fn open_due(state: &AppState, ctx: &OrgCtx, spec: &Spec, watches: &mut [Watch], limits: &Limits) {
    let now = Instant::now();
    for (i, w) in watches.iter_mut().enumerate() {
        if let Watch::Open { token, since, .. } = w
            && now.duration_since(*since) >= limits.watch_renew
        {
            *w = Watch::Closed { retry_at: now, token: token.take() };
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
                // A token that does not open the feed again (its history is gone) is dropped; the
                // queries run after every open anyway, so nothing is missed.
                Watch::Closed { retry_at: Instant::now() + limits.watch_retry, token: None }
            }
        };
    }
}

/// The next change of any open feed: its index and what it reported.
fn next_change(
    watches: &mut [Watch],
) -> impl std::future::Future<Output = (usize, Option<Result<Option<ResumeToken>, SourceError>>)> + '_ {
    futures_util::future::poll_fn(move |cx| {
        for (i, w) in watches.iter_mut().enumerate() {
            if let Watch::Open { feed, .. } = w
                && let Poll::Ready(event) = feed.poll_next_unpin(cx)
            {
                return Poll::Ready((i, event));
            }
        }
        Poll::Pending
    })
}

/// Takes one report of feed `i` into account: a new token, or a closed feed.
fn absorb(watches: &mut [Watch], i: usize, event: Option<Result<Option<ResumeToken>, SourceError>>, limits: &Limits) {
    let retry_at = Instant::now() + limits.watch_retry;
    match event {
        Some(Ok(new)) => {
            if let (Watch::Open { token, .. }, Some(new)) = (&mut watches[i], new) {
                *token = Some(new);
            }
        }
        Some(Err(e)) => {
            tracing::debug!(code = e.code(), "live: change feed failed: {}", e.detail().message);
            let token = match &mut watches[i] {
                Watch::Open { token, .. } => token.take(),
                _ => None,
            };
            watches[i] = Watch::Closed { retry_at, token };
        }
        // The feed ended (the collection was dropped or renamed): start over later.
        None => watches[i] = Watch::Closed { retry_at, token: None },
    }
}

/// Reports that are ready now, without waiting.
fn absorb_ready(watches: &mut [Watch], limits: &Limits) {
    while let Some((i, event)) = next_change(watches).now_or_never() {
        absorb(watches, i, event, limits);
    }
}

async fn run_feed(state: AppState, ctx: OrgCtx, spec: Spec, tx: watch::Sender<FeedState>) {
    let limits = state.live.limits();
    let refresh = Duration::from_millis(spec.refresh_ms);
    // Change feeds only help with a fixed range; a moving one needs runs anyway.
    let wants_changes = matches!(spec.range, RangeRule::Fixed(_)) && !spec.items.is_empty();
    let start = Instant::now();
    let mut watches: Vec<Watch> = spec
        .items
        .iter()
        .map(|_| if wants_changes { Watch::Closed { retry_at: start, token: None } } else { Watch::Unsupported })
        .collect();
    let mut last: Option<Arc<str>> = None;
    let mut seq = 0;
    loop {
        if wants_changes {
            open_due(&state, &ctx, &spec, &mut watches, &limits).await;
        }
        let changes = wants_changes && watches.iter().all(|w| matches!(w, Watch::Open { .. }));
        let reason = if changes || !wants_changes {
            None
        } else if watches.iter().any(|w| matches!(w, Watch::Unsupported)) {
            Some("live.source_unsupported")
        } else {
            Some("live.changes_unavailable")
        };
        let mode = if changes { LiveMode::Changes } else { LiveMode::Poll };
        tx.send_if_modified(|s| {
            let modified = s.mode != Some(mode) || s.reason != reason;
            s.mode = Some(mode);
            s.reason = reason;
            modified
        });
        let at = state.clock.now_ms();
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
        let json: Arc<str> = match serde_json::to_string(&response.results) {
            Ok(json) => json.into(),
            Err(e) => {
                tracing::error!("live: a result cannot be serialized: {e}");
                "{}".into()
            }
        };
        drop(response);
        if last.as_deref() != Some(&*json) {
            seq += 1;
            last = Some(json.clone());
            tx.send_modify(|s| s.results = Some(Published { seq, at, json }));
        }
        let ran = Instant::now();
        let next_run = ran + if changes { limits.changes_refresh } else { refresh };
        tokio::select! {
            () = tokio::time::sleep_until(next_run) => {}
            (i, event) = next_change(&mut watches) => {
                let changed = matches!(event, Some(Ok(_)));
                absorb(&mut watches, i, event, &limits);
                if changed {
                    // Changes in quick succession make one run.
                    tokio::time::sleep_until(ran + limits.change_spacing).await;
                }
                absorb_ready(&mut watches, &limits);
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
        };
        let mut other = spec.clone();
        assert_eq!(spec.key(), other.key());
        other.refresh_ms = 6_000;
        assert_ne!(spec.key(), other.key());
        other.refresh_ms = 5_000;
        other.identifiers = Some(BTreeSet::new());
        assert_ne!(spec.key(), other.key());
    }
}
