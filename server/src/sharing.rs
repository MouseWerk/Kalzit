//! Sharing with people without an account (docs/api/sharing.md): public live links to a
//! dashboard and snapshots of its panel results. The routes live in `routes/sharing.rs`.
//!
//! A public link runs only the dashboard's stored panel queries, with the rights its creator
//! holds at that moment: every request checks the server's and the organization's switch, the
//! expiry, that the creator is still a member who holds `dashboards:public`, may read the
//! dashboard and may query every source its panels use. Whatever fails, the visitor gets the same
//! answer (`unavailable`), so a token reveals nothing about why it does not work, or whether it
//! ever did. Public snapshots go through the same checks, but never run a query.
//!
//! What a visitor sees of a dashboard is `PublicDashboard`: layout, panel types, options and
//! steps, the fixed variable values; no query, no data source, no annotation, no link to another
//! dashboard or page, no library panel or saved analysis id. Answers lose the executed statement,
//! paging cursors and error details.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use crate::locks::MutexExt;

use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::app::AppState;
use crate::auth::SessionUser;
use crate::auth::ratelimit::{Capacity, RateLimiter};
use crate::authz::{DatasourceAccess, OrgCtx, Permission};
use crate::dashboards::model::{self, DashboardModel, VariableType};
use crate::error::{ApiError, ApiResult};
use crate::net::RequestInfo;
use crate::shapes::{ErrorBody, QueryOutcome, QueryResponse, TimeRange};

const DAY_MS: i64 = 24 * 3_600_000;
/// How long a link or snapshot stays valid when the request names no expiry (capped by
/// `sharing.max_expiry_days`).
pub const DEFAULT_EXPIRY_DAYS: i64 = 30;
/// How far back a visitor may look when the link names no window; a window is at most
/// `sharing.max_expiry_days`.
pub const DEFAULT_WINDOW_MS: i64 = 7 * DAY_MS;
pub const MIN_WINDOW_MS: i64 = 60_000;
/// Tokens that do not exist (or cannot be tokens) one client address (IPv6 per /64) may send in
/// `RATE_WINDOW_SECS`; then that address is refused for every token until the window ends.
/// Guessing costs the guesser only, never the visitors of a real link. Many people behind one
/// address (a company's NAT) share this budget: an old link in a browser's history counts as
/// known for 90 days after its row was deleted (`share_tombstones`), so only made-up tokens use
/// it up.
pub const MAX_UNKNOWN_PER_ADDRESS: u32 = 120;
/// Requests one client address may make to one existing token in `RATE_WINDOW_SECS`: a
/// dashboard asks once per panel and refresh. Counted per address and token, so one visitor
/// cannot use up a link for the others.
pub const MAX_PER_VISITOR: u32 = 600;
/// Requests to one existing token from all addresses together in `RATE_WINDOW_SECS` before each
/// further one waits `TOKEN_THROTTLE` first: never refused, so a flood cannot take a link
/// offline, but slowed.
pub const SOFT_MAX_PER_TOKEN: u32 = 6_000;
pub const TOKEN_THROTTLE: std::time::Duration = std::time::Duration::from_millis(500);
pub const RATE_WINDOW_SECS: u64 = 60;
/// How long the answer a visitor got for a panel is reused for the same range.
pub const SHOWN_TTL_MS: i64 = 30_000;
/// The share of `datasources.cache_max_bytes` the answers visitors got may take together, as
/// their JSON text; beyond, the oldest go.
pub const SHOWN_SHARE: usize = 8;
/// One answer is kept only up to this share of that budget; a larger one is sent, not kept.
pub const SHOWN_ENTRY_SHARE: usize = 16;
/// How long a run of panel steps waits for a slot before it answers the neutral error.
pub const STEP_SLOT_WAIT: std::time::Duration = std::time::Duration::from_secs(10);
/// What one kept answer costs besides its text (key, rights, stamps, map and queue entries),
/// counted into the byte budget.
pub const SHOWN_ENTRY_OVERHEAD: usize = 512;
/// Answers kept at most, however small.
pub const MAX_SHOWN: usize = 4096;
/// How long an internal snapshot stays valid when the request names no expiry: a snapshot keeps
/// its frozen results on the server, so it does not stay around longer than people need it.
pub const DEFAULT_INTERNAL_SNAPSHOT_DAYS: i64 = 7;
/// Snapshots one person may make in `RATE_WINDOW_SECS`; each one runs every panel query of its
/// dashboard. Beyond, creating one answers 429.
pub const MAX_SNAPSHOTS_PER_USER: u32 = 10;
/// Panel answers that may run for visitors of one organization's public links at the same time
/// on this server, in slots of their own (never the slots their links' creators work with).
pub const PUBLIC_RUNS_PER_ORG: usize = 4;
/// Requests that may wait for one of those slots at once; one more is refused with 429 at once.
pub const MAX_PUBLIC_WAITERS_PER_ORG: usize = 4 * PUBLIC_RUNS_PER_ORG;
/// How long a visitor's panel waits for one of those slots before it is refused with 429.
pub const PUBLIC_SLOT_WAIT: std::time::Duration = std::time::Duration::from_secs(10);
/// Distinct time ranges the visitors of one link may have run (not answered from an answer kept
/// for the link) in `RATE_WINDOW_SECS`; a further range answers 429 until the window ends. Ranges
/// already run in the window run again freely.
pub const MAX_RANGES_PER_LINK: usize = 30;
/// Links whose ranges are counted at once; beyond, the oldest windows go first.
const MAX_COUNTED_LINKS: usize = 10_000;
/// How often the page loads counted in memory are written to the database.
pub const VIEWS_FLUSH_EVERY: std::time::Duration = std::time::Duration::from_secs(10);
/// Graph answers with more nodes and edges than this are trimmed off the request threads.
const BLOCKING_GRAPH_ITEMS: usize = 10_000;
/// What every refused public request answers with.
const UNAVAILABLE: &str = "this shared dashboard is not available";

/// The rate limits of the public routes, the answers visitors were given lately and the slots
/// for running panel steps for them.
pub struct Sharing {
    unknown: RateLimiter,
    visitors: RateLimiter,
    tokens: RateLimiter,
    shown: std::sync::Mutex<ShownCache>,
    /// Panel steps run for visitors at the same time; further runs wait for a slot.
    steps: std::sync::Arc<tokio::sync::Semaphore>,
    /// How long a run waits for a slot (`STEP_SLOT_WAIT`; tests shorten it).
    step_wait: std::sync::Mutex<std::time::Duration>,
    /// Snapshots made per person (`MAX_SNAPSHOTS_PER_USER`).
    snapshots: RateLimiter,
    /// The slots panel answers run in for visitors, per organization (`PUBLIC_RUNS_PER_ORG`).
    public_runs: std::sync::Mutex<HashMap<String, PublicPool>>,
    /// How long a request waits for one of them (`PUBLIC_SLOT_WAIT`; tests shorten it).
    public_wait: std::sync::Mutex<std::time::Duration>,
    /// The ranges run per link in the current window (`MAX_RANGES_PER_LINK`).
    ranges: std::sync::Mutex<HashMap<String, RangeWindow>>,
    /// Page loads not yet written, by link or snapshot (`flush_views`).
    views: std::sync::Mutex<HashMap<(Viewed, String), PendingViews>>,
}

/// The ranges run for one link's visitors since `start` (monotonic milliseconds).
struct RangeWindow {
    start: i64,
    seen: std::collections::HashSet<(i64, i64)>,
}

/// What a page load counts for.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Viewed {
    Link,
    Snapshot,
}

/// Page loads counted in memory and the latest of them.
#[derive(Clone, Copy, Debug, Default)]
struct PendingViews {
    count: i64,
    last: i64,
}

/// The answers visitors got lately, with the bytes they take together (`SHOWN_ENTRY_OVERHEAD`
/// included) and their keys in the order they were kept: the TTL is the same for all, so the
/// front is always the one that expires first.
#[derive(Default)]
struct ShownCache {
    entries: HashMap<ShownKey, Shown>,
    order: std::collections::VecDeque<(i64, ShownKey)>,
    bytes: usize,
}

impl Default for Sharing {
    fn default() -> Self {
        let slots = std::thread::available_parallelism().map_or(2, |n| n.get()).clamp(2, 8) / 2;
        Self {
            unknown: RateLimiter::new(MAX_UNKNOWN_PER_ADDRESS, RATE_WINDOW_SECS, Capacity::LARGE),
            visitors: RateLimiter::new(MAX_PER_VISITOR, RATE_WINDOW_SECS, Capacity::LARGE),
            tokens: RateLimiter::new(SOFT_MAX_PER_TOKEN, RATE_WINDOW_SECS, Capacity::LARGE),
            shown: std::sync::Mutex::default(),
            steps: std::sync::Arc::new(tokio::sync::Semaphore::new(slots.max(1))),
            step_wait: std::sync::Mutex::new(STEP_SLOT_WAIT),
            // One key per account, so bounded by the accounts that exist.
            snapshots: RateLimiter::new(MAX_SNAPSHOTS_PER_USER, RATE_WINDOW_SECS, Capacity::UNBOUNDED),
            public_runs: std::sync::Mutex::default(),
            public_wait: std::sync::Mutex::new(PUBLIC_SLOT_WAIT),
            ranges: std::sync::Mutex::default(),
            views: std::sync::Mutex::default(),
        }
    }
}

/// A shown answer by link, panel and rounded range. `content` is a digest of what decides the
/// answer besides the range: the dashboard model as stored now (variables, constants and their
/// options included), the panel with its linked content resolved, and the link's values. Any
/// edit makes a new key.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct ShownKey {
    pub link_id: String,
    pub panel_id: String,
    pub content: String,
    pub from: i64,
    pub to: i64,
}

/// A shown answer as the JSON text sent, with what it was made under: the creator's permissions
/// and the query cache's rights generations of the panel's sources. Anything else and it is made
/// anew.
struct Shown {
    until: i64,
    rights: String,
    stamps: Vec<crate::datasources::cache::Stamp>,
    body: axum::body::Bytes,
}

/// What a shown answer must have been made under to be reused.
pub struct ShownRights {
    rights: String,
    stamps: Vec<crate::datasources::cache::Stamp>,
}

impl ShownRights {
    pub fn of(state: &AppState, ctx: &OrgCtx, model: &model::DashboardModel, panel: &model::Panel) -> Self {
        let rights = ctx.permissions.iter().map(|p| p.as_str()).collect::<Vec<_>>().join(" ");
        let cache = state.datasources.query_cache();
        let sources: BTreeSet<&str> = panel.targets.iter().map(|t| model.default_source(&t.datasource_id)).collect();
        let stamps = sources.into_iter().map(|id| cache.stamp(&ctx.org_id, id)).collect();
        Self { rights: format!("{}:{rights}", ctx.user.id), stamps }
    }
}

fn rate_limited(wait: std::time::Duration) -> ApiError {
    ApiError::rate_limited("too many requests for shared dashboards; wait a minute", wait)
        .because("sharing.rate_limited")
}

/// The keys of a client address: its own and its network's.
fn address_keys(info: &RequestInfo) -> (String, String) {
    let ip = info.client_ip;
    (crate::auth::ratelimit::address_key("sharing", ip), crate::auth::ratelimit::network_key(ip))
}

impl Sharing {
    /// Before a token is looked up: an address that sent too many unknown tokens is refused,
    /// whatever it sends now, so the refusal says nothing about the token.
    pub fn check_address(&self, state: &AppState, info: &RequestInfo) -> ApiResult<()> {
        let (address, _) = address_keys(info);
        match self.unknown.wait(&address, state.clock.monotonic_ms()) {
            Some(wait) => Err(rate_limited(wait)),
            None => Ok(()),
        }
    }

    /// A token that does not exist, or a path that cannot be one: counted for the address only.
    pub fn unknown(&self, state: &AppState, info: &RequestInfo) {
        let (address, network) = address_keys(info);
        self.unknown.record(&address, &network, state.clock.monotonic_ms());
    }

    /// A token whose hash exists (in any state): counted per address and token. A full table
    /// never refuses, so a flood of addresses cannot take a link offline. Beyond
    /// `SOFT_MAX_PER_TOKEN` from all addresses the request waits `TOKEN_THROTTLE` first.
    pub async fn admit_known(&self, state: &AppState, info: &RequestInfo, hash: &str) -> ApiResult<()> {
        let (address, network) = address_keys(info);
        let now = state.clock.monotonic_ms();
        let key = format!("{address}|{hash}");
        self.visitors.try_count(&key, &network, now).map_err(rate_limited)?;
        let all = self.tokens.record(&format!("token|{hash}"), "sharing-tokens", now);
        if all.is_some_and(|c| c.earlier >= SOFT_MAX_PER_TOKEN) {
            tokio::time::sleep(TOKEN_THROTTLE).await;
        }
        Ok(())
    }

    /// The answer a visitor got for `key` lately, as the JSON text sent, when it was made under
    /// `rights`. A hit shares the kept bytes; nothing is copied.
    pub fn shown(&self, state: &AppState, key: &ShownKey, rights: &ShownRights) -> Option<axum::body::Bytes> {
        let now = state.clock.monotonic_ms();
        let mut cache = self.shown.lock_or_recover();
        match cache.entries.get(key) {
            Some(s) if s.until > now && s.rights == rights.rights && s.stamps == rights.stamps => Some(s.body.clone()),
            Some(_) => {
                cache.remove(key);
                None
            }
            None => None,
        }
    }

    /// Keeps the answer `body` for `key` for `SHOWN_TTL_MS`, within `budget` bytes for all kept
    /// answers together (`shown_budget`, `SHOWN_ENTRY_OVERHEAD` per answer included) and at most
    /// `MAX_SHOWN` answers: the expired go first, then the oldest, each in O(1) from the front of
    /// the queue. An answer above `budget / SHOWN_ENTRY_SHARE` is not kept.
    pub fn keep_shown(
        &self,
        state: &AppState,
        key: ShownKey,
        rights: ShownRights,
        body: axum::body::Bytes,
        budget: usize,
    ) {
        let cost = body.len() + SHOWN_ENTRY_OVERHEAD;
        if cost > budget / SHOWN_ENTRY_SHARE {
            return;
        }
        let now = state.clock.monotonic_ms();
        let mut cache = self.shown.lock_or_recover();
        cache.remove(&key);
        while let Some(&(until, _)) = cache.order.front() {
            let full = cache.bytes + cost > budget || cache.entries.len() >= MAX_SHOWN;
            if until > now && !full {
                break;
            }
            cache.pop_front();
        }
        let until = now + SHOWN_TTL_MS;
        cache.bytes += cost;
        cache.order.push_back((until, key.clone()));
        cache.entries.insert(key, Shown { until, rights: rights.rights, stamps: rights.stamps, body });
    }

    /// The bytes all kept answers take now, `SHOWN_ENTRY_OVERHEAD` each included.
    pub fn shown_bytes(&self) -> usize {
        self.shown.lock_or_recover().bytes
    }

    /// The answers kept now.
    pub fn shown_count(&self) -> usize {
        self.shown.lock_or_recover().entries.len()
    }

    /// Takes every step slot, so runs for visitors wait (`step_wait`) and then answer the neutral
    /// error: for tests of what happens when the server is busy.
    #[doc(hidden)]
    pub fn take_all_step_slots(&self, step_wait: std::time::Duration) -> tokio::sync::OwnedSemaphorePermit {
        *self.step_wait.lock_or_recover() = step_wait;
        let all = u32::try_from(self.steps.available_permits()).unwrap_or(u32::MAX);
        self.steps.clone().try_acquire_many_owned(all).expect("the step slots are open")
    }

    /// Counts a snapshot `user_id` is about to make: refused with 429 once they made
    /// `MAX_SNAPSHOTS_PER_USER` within the window.
    pub fn admit_snapshot(&self, state: &AppState, user_id: &str) -> ApiResult<()> {
        let key = format!("snapshot|{user_id}");
        match self.snapshots.try_acquire(&key, &key, state.clock.monotonic_ms()) {
            Ok(_) => Ok(()),
            Err(wait) => Err(ApiError::rate_limited(
                format!(
                    "you made {MAX_SNAPSHOTS_PER_USER} snapshots within a minute; wait a moment before the next one"
                ),
                wait,
            )
            .because("sharing.snapshot_rate_limited")
            .param("max", MAX_SNAPSHOTS_PER_USER)),
        }
    }

    /// The public slots of `org_id`.
    fn public_pool(&self, org_id: &str) -> PublicPool {
        let mut pools = self.public_runs.lock_or_recover();
        // Forget idle organizations, so the map does not grow with every one ever seen.
        pools.retain(|_, p| {
            std::sync::Arc::strong_count(&p.slots) > 1
                || p.slots.available_permits() < PUBLIC_RUNS_PER_ORG
                || p.waiting.load(std::sync::atomic::Ordering::SeqCst) > 0
        });
        pools
            .entry(org_id.to_string())
            .or_insert_with(|| PublicPool {
                slots: std::sync::Arc::new(tokio::sync::Semaphore::new(PUBLIC_RUNS_PER_ORG)),
                waiting: std::sync::Arc::default(),
            })
            .clone()
    }

    /// A slot to run a panel answer for a visitor of a link of `org_id`. A page asks for all its
    /// panels at once, so a request waits for a slot up to `PUBLIC_SLOT_WAIT`, behind at most
    /// `MAX_PUBLIC_WAITERS_PER_ORG` others; beyond that, or after the wait, it is refused with 429
    /// (`sharing.busy`). So one client cannot fill the queue and keep the organization's other
    /// visitors waiting.
    pub async fn public_run(&self, org_id: &str) -> ApiResult<tokio::sync::OwnedSemaphorePermit> {
        let pool = self.public_pool(org_id);
        if let Ok(slot) = pool.slots.clone().try_acquire_owned() {
            return Ok(slot);
        }
        let waiting = pool.waiting.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let _waiter = Waiter(pool.waiting.clone());
        if waiting >= MAX_PUBLIC_WAITERS_PER_ORG {
            return Err(busy());
        }
        let wait = *self.public_wait.lock_or_recover();
        match tokio::time::timeout(wait, pool.slots.acquire_owned()).await {
            Ok(slot) => slot.map_err(|e| ApiError::internal("sharing", e)),
            Err(_) => Err(busy()),
        }
    }
    /// Takes every public slot of `org_id`, and makes a request wait `public_wait` for one: for
    /// tests of a busy organization.
    #[doc(hidden)]
    pub fn take_all_public_runs(
        &self,
        org_id: &str,
        public_wait: std::time::Duration,
    ) -> tokio::sync::OwnedSemaphorePermit {
        *self.public_wait.lock_or_recover() = public_wait;
        let all = u32::try_from(PUBLIC_RUNS_PER_ORG).unwrap_or(u32::MAX);
        self.public_pool(org_id).slots.try_acquire_many_owned(all).expect("the public slots are open")
    }

    /// Counts the range `range` of link `link_id` before it runs: a range already run in the
    /// window passes, a new one only while fewer than `MAX_RANGES_PER_LINK` ran; else 429.
    pub fn admit_range(&self, state: &AppState, link_id: &str, range: TimeRange) -> ApiResult<()> {
        let now = state.clock.monotonic_ms();
        let window = i64::try_from(RATE_WINDOW_SECS * 1000).unwrap_or(i64::MAX);
        let mut ranges = self.ranges.lock_or_recover();
        if ranges.len() >= MAX_COUNTED_LINKS && !ranges.contains_key(link_id) {
            ranges.retain(|_, w| w.start + window > now);
            if ranges.len() >= MAX_COUNTED_LINKS {
                // Still full of windows that run: the one that ends first goes.
                if let Some(oldest) = ranges.iter().min_by_key(|(_, w)| w.start).map(|(k, _)| k.clone()) {
                    ranges.remove(&oldest);
                }
            }
        }
        let entry = ranges
            .entry(link_id.to_string())
            .or_insert_with(|| RangeWindow { start: now, seen: std::collections::HashSet::new() });
        if entry.start + window <= now {
            *entry = RangeWindow { start: now, seen: std::collections::HashSet::new() };
        }
        let key = (range.from, range.to);
        if entry.seen.contains(&key) {
            return Ok(());
        }
        if entry.seen.len() >= MAX_RANGES_PER_LINK {
            let left = (entry.start + window - now).max(1);
            let wait = std::time::Duration::from_millis(u64::try_from(left).unwrap_or(1)).max(RETRY_BUSY);
            return Err(rate_limited(wait));
        }
        entry.seen.insert(key);
        Ok(())
    }

    /// Counts a page load of a link or snapshot; written by `flush_views`.
    pub fn count_view(&self, state: &AppState, of: Viewed, id: &str) {
        let now = state.clock.now_ms();
        let mut views = self.views.lock_or_recover();
        let pending = views.entry((of, id.to_string())).or_default();
        pending.count += 1;
        pending.last = pending.last.max(now);
    }

    /// The page loads counted and not yet written.
    pub fn pending_views(&self) -> i64 {
        self.views.lock_or_recover().values().map(|p| p.count).sum()
    }
}

/// One organization's slots for visitors and the requests waiting for one.
#[derive(Clone)]
struct PublicPool {
    slots: std::sync::Arc<tokio::sync::Semaphore>,
    waiting: std::sync::Arc<std::sync::atomic::AtomicUsize>,
}

/// Counts a request among the waiting until it is done waiting, however that ends.
struct Waiter(std::sync::Arc<std::sync::atomic::AtomicUsize>);

impl Drop for Waiter {
    fn drop(&mut self) {
        self.0.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
    }
}

fn busy() -> ApiError {
    ApiError::rate_limited("shared dashboards of this organization are busy; try again in a moment", RETRY_BUSY)
        .because("sharing.busy")
}
/// How long a visitor refused because the public slots are busy waits before trying again.
const RETRY_BUSY: std::time::Duration = std::time::Duration::from_secs(1);

/// Page loads taken out of memory for a write: put back when the write did not commit, whatever
/// ended it (an error, or the task dropped while the server stops), so none is lost to a cancel.
struct TakenViews {
    state: AppState,
    pending: Vec<((Viewed, String), PendingViews)>,
    written: bool,
}

impl Drop for TakenViews {
    fn drop(&mut self) {
        if self.written {
            return;
        }
        let mut views = self.state.sharing.views.lock_or_recover();
        for (key, back) in self.pending.drain(..) {
            let kept = views.entry(key).or_default();
            kept.count += back.count;
            kept.last = kept.last.max(back.last);
        }
    }
}

/// Writes the page loads counted in memory, all in one transaction; on failure they are kept for
/// the next try. The write runs in a task of its own, so a caller that goes away (a list request
/// whose client disconnected) neither loses the counts nor leaves them half written. Answers the
/// links and snapshots written.
pub async fn flush_views(state: &AppState) -> ApiResult<usize> {
    let pending: Vec<((Viewed, String), PendingViews)> = state.sharing.views.lock_or_recover().drain().collect();
    if pending.is_empty() {
        return Ok(0);
    }
    let mut taken = TakenViews { state: state.clone(), pending, written: false };
    let write = tokio::spawn(async move {
        write_views(&taken.state.db, &taken.pending).await?;
        taken.written = true;
        Ok::<usize, ApiError>(taken.pending.len())
    });
    write.await.map_err(|e| ApiError::internal("sharing", e))?
}

async fn write_views(db: &sqlx::AnyPool, pending: &[((Viewed, String), PendingViews)]) -> ApiResult<()> {
    let mut tx = crate::db::begin(db).await?;
    for ((of, id), views) in pending {
        let sql = match of {
            Viewed::Link => {
                "UPDATE public_links SET views = views + $1, last_viewed_at = CASE WHEN last_viewed_at IS NULL \
                 OR last_viewed_at < $2 THEN $2 ELSE last_viewed_at END WHERE id = $3"
            }
            Viewed::Snapshot => {
                "UPDATE snapshots SET views = views + $1, last_viewed_at = CASE WHEN last_viewed_at IS NULL \
                 OR last_viewed_at < $2 THEN $2 ELSE last_viewed_at END WHERE id = $3"
            }
        };
        sqlx::query(sql).bind(views.count).bind(views.last).bind(id).execute(&mut *tx).await?;
    }
    crate::db::commit(tx).await?;
    Ok(())
}

/// Writes the counted page loads every `VIEWS_FLUSH_EVERY`, and once more when the server stops.
/// Every server of a cluster writes its own.
pub fn spawn_views_flusher(state: AppState) {
    let stopping = state.background.stopping();
    let background = state.background.clone();
    background.spawn(async move {
        let mut tick = tokio::time::interval(VIEWS_FLUSH_EVERY);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            let last = tokio::select! {
                () = stopping.cancelled() => true,
                _ = tick.tick() => false,
            };
            match flush_views(&state).await {
                Ok(_) => {}
                // The last write before the server stops: what it did not write is lost.
                Err(e) if last => {
                    tracing::warn!("writing the views of shared dashboards before stopping: {}", e.message)
                }
                Err(e) => tracing::debug!(
                    "writing the views of shared dashboards, next try in {VIEWS_FLUSH_EVERY:?}: {}",
                    e.message
                ),
            }
            if last {
                return;
            }
        }
    });
}

impl ShownCache {
    fn remove(&mut self, key: &ShownKey) {
        // Its place in the queue stays until it reaches the front (`pop_front` skips it).
        if let Some(s) = self.entries.remove(key) {
            self.bytes -= s.body.len() + SHOWN_ENTRY_OVERHEAD;
        }
    }

    /// Drops the front of the queue, and its answer unless that key was kept again since.
    fn pop_front(&mut self) {
        let Some((until, key)) = self.order.pop_front() else { return };
        if self.entries.get(&key).is_some_and(|s| s.until == until) {
            self.remove(&key);
        }
    }
}

/// The bytes the answers visitors got may take together: `1 / SHOWN_SHARE` of
/// `datasources.cache_max_bytes`.
pub async fn shown_budget(state: &AppState) -> ApiResult<usize> {
    let max = crate::settings::get(state, "datasources.cache_max_bytes").await?.as_u64().unwrap_or(256 << 20);
    Ok(usize::try_from(max).unwrap_or(usize::MAX) / SHOWN_SHARE)
}

/// The time range of a visitor's request rounded up to whole minutes, so visitors of the same
/// link share the creator's cached answers (the query cache keys on the range).
pub fn round_range(range: TimeRange) -> TimeRange {
    let up = |t: i64| t.saturating_add(59_999).div_euclid(60_000).saturating_mul(60_000);
    let to = up(range.to);
    TimeRange { from: up(range.from).min(to), to }
}

/// The one answer of a public route for a token that does not work, whatever the cause.
pub fn unavailable() -> ApiError {
    ApiError::new(StatusCode::NOT_FOUND, "not_found", UNAVAILABLE).because("sharing.unavailable")
}

/// A new token and its hash: 256 random bits, as for mail links.
pub fn new_token() -> (String, String) {
    let token = crate::mail::links::new_token();
    let hash = crate::mail::links::hash(&token);
    (token, hash)
}

/// The hash a public route looks a token up by, or `None` for anything that cannot be a token.
pub fn token_hash(raw: &str) -> Option<String> {
    crate::mail::links::is_token(raw).then(|| crate::mail::links::hash(raw))
}

/// Whether public links and snapshots may be served in `org_id` now: the server's switch, then the
/// organization's, which can only turn them off.
pub async fn public_enabled(state: &AppState, org_id: &str) -> ApiResult<bool> {
    let server = crate::settings::get(state, "sharing.public_enabled").await?.as_bool().unwrap_or(false);
    if !server {
        return Ok(false);
    }
    Ok(crate::settings::get_org(state, org_id, "sharing.org_public_enabled").await?.as_bool().unwrap_or(true))
}

/// The expiry of a link or snapshot, new or changed: `requested`, or `DEFAULT_EXPIRY_DAYS` from
/// now; never beyond `sharing.max_expiry_days` counted from now.
pub async fn expiry(state: &AppState, requested: Option<i64>, now: i64) -> ApiResult<i64> {
    expiry_or(state, requested, now, DEFAULT_EXPIRY_DAYS).await
}

/// `expiry` with `default_days` when the request names none.
pub async fn expiry_or(state: &AppState, requested: Option<i64>, now: i64, default_days: i64) -> ApiResult<i64> {
    let max_days = max_expiry_days(state).await?;
    let latest = now.saturating_add(max_days.saturating_mul(DAY_MS));
    match requested {
        None => Ok(now.saturating_add(default_days.saturating_mul(DAY_MS)).min(latest)),
        Some(at) if at > now && at <= latest => Ok(at),
        Some(_) => Err(ApiError::validation(format!("expiresAt must lie within the next {max_days} days"))
            .with_field("expiresAt")
            .because("sharing.expiry_invalid")
            .param("maxDays", max_days)),
    }
}

/// The largest snapshot, `sharing.snapshot_max_bytes`.
pub async fn snapshot_max_bytes(state: &AppState) -> ApiResult<usize> {
    let max = crate::settings::get(state, "sharing.snapshot_max_bytes").await?.as_i64().unwrap_or(10 * 1024 * 1024);
    Ok(usize::try_from(max).unwrap_or(usize::MAX))
}

/// What one organization may keep in snapshots: `sharing.snapshots_per_org` and
/// `sharing.snapshot_bytes_per_org`.
#[derive(Clone, Copy, Debug)]
pub struct SnapshotCaps {
    pub count: i64,
    pub bytes: i64,
}

pub async fn snapshot_caps(state: &AppState) -> ApiResult<SnapshotCaps> {
    let count = crate::settings::get(state, "sharing.snapshots_per_org").await?.as_i64().unwrap_or(500);
    let bytes = crate::settings::get(state, "sharing.snapshot_bytes_per_org").await?.as_i64().unwrap_or(1 << 30);
    Ok(SnapshotCaps { count, bytes })
}

/// The snapshots of `org_id` whose frozen results are still kept, and their bytes: every one
/// not revoked, expired ones too until the cleanup deletes them (revoking drops the results at
/// once).
pub async fn stored_snapshots(conn: &mut sqlx::AnyConnection, org_id: &str) -> ApiResult<(i64, i64)> {
    let (count, bytes): (i64, i64) = sqlx::query_as(
        "SELECT COUNT(*), CAST(COALESCE(SUM(size_bytes), 0) AS BIGINT) FROM snapshots \
         WHERE org_id = $1 AND revoked_at IS NULL",
    )
    .bind(org_id)
    .fetch_one(conn)
    .await?;
    Ok((count, bytes))
}

/// Refuses a new snapshot of `size` bytes when `org_id` would keep more than `caps` allow, with
/// what to do about it.
pub async fn check_snapshot_caps(
    conn: &mut sqlx::AnyConnection,
    org_id: &str,
    caps: SnapshotCaps,
    size: i64,
) -> ApiResult<()> {
    let (count, bytes) = stored_snapshots(conn, org_id).await?;
    if count >= caps.count {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "conflict",
            format!(
                "this organization keeps {} snapshots, as many as it may; revoke ones nobody needs any more",
                caps.count
            ),
        )
        .because("sharing.too_many_snapshots")
        .param("max", caps.count));
    }
    if bytes.saturating_add(size) > caps.bytes {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "conflict",
            format!(
                "the snapshots of this organization would take more than {} bytes together; revoke ones nobody \
                 needs any more",
                caps.bytes
            ),
        )
        .because("sharing.snapshot_storage_full")
        .param("max", caps.bytes));
    }
    Ok(())
}

/// The creator of a link or snapshot as a member of `org_id` now, with their current rights;
/// `None` when the account is gone or disabled or no longer in the organization.
pub async fn creator_ctx(state: &AppState, org_id: &str, created_by: Option<&str>) -> ApiResult<Option<OrgCtx>> {
    let Some(user_id) = created_by else { return Ok(None) };
    let row: Option<(String, String, String, i64, i64)> =
        sqlx::query_as("SELECT id, email, name, is_server_admin, disabled FROM users WHERE id = $1")
            .bind(user_id)
            .fetch_optional(&state.read_db)
            .await?;
    let Some((id, email, name, is_server_admin, disabled)) = row else { return Ok(None) };
    if disabled != 0 {
        return Ok(None);
    }
    let user = SessionUser { id, email, name, is_server_admin };
    match crate::routes::table::org_ctx(state, user, org_id.to_string()).await {
        Ok(ctx) => Ok(Some(ctx)),
        Err(e) if e.status == StatusCode::NOT_FOUND => Ok(None),
        Err(e) => Err(e),
    }
}

/// `readable_model` as the creator: `None` when they may no longer read the dashboard or it is in
/// the trash.
pub async fn creator_model(state: &AppState, ctx: &OrgCtx, dashboard_id: &str) -> ApiResult<Option<DashboardModel>> {
    match crate::routes::query::readable_model(state, ctx, dashboard_id).await {
        Ok(model) => Ok(Some(model)),
        Err(e) if matches!(e.status, StatusCode::NOT_FOUND | StatusCode::FORBIDDEN) => Ok(None),
        Err(e) => Err(e),
    }
}

/// A panel as shared: the slot with what it links (a library panel's or a saved analysis's
/// queries and steps) in place, so it runs and renders without the linked item.
pub struct SharedPanel {
    pub panel: model::Panel,
}

/// The panels of `model` with their linked content resolved. A panel whose library panel or
/// saved analysis is gone is left out.
pub async fn shared_panels(state: &AppState, org_id: &str, model: &DashboardModel) -> ApiResult<Vec<SharedPanel>> {
    let mut out = Vec::with_capacity(model.panels.len());
    for slot in &model.panels {
        let linked = match crate::dashboards::linked_content(&state.db, org_id, slot).await {
            Ok(linked) => linked,
            Err(e) if e.status == StatusCode::NOT_FOUND => continue,
            Err(e) => return Err(e),
        };
        let panel = match linked {
            None => slot.clone(),
            Some(content) if slot.library_panel_id.is_some() => model::Panel {
                id: slot.id.clone(),
                grid: slot.grid,
                row_id: slot.row_id.clone(),
                title: if content.title.is_empty() { slot.title.clone() } else { content.title.clone() },
                repeat: None,
                links: Vec::new(),
                library_panel_id: None,
                analysis_id: None,
                ..content
            },
            Some(content) => model::Panel {
                targets: content.targets,
                transformations: content.transformations,
                analysis_id: None,
                ..slot.clone()
            },
        };
        out.push(SharedPanel { panel });
    }
    Ok(out)
}

/// Saving a dashboard with active public links needs `dashboards:public` (owner decision D1):
/// the change goes live to people without an account at once. The same holds for a library panel
/// or saved analysis such a dashboard shows (`dashboards`: every dashboard the change reaches).
/// Refused with the number of links, on `field`.
pub async fn check_live_links(
    state: &AppState,
    ctx: &OrgCtx,
    dashboards: &[String],
    field: &'static str,
) -> ApiResult<()> {
    if dashboards.is_empty() || ctx.permissions.contains(&Permission::DashboardsPublic) {
        return Ok(());
    }
    let now = state.clock.now_ms();
    let mut links = 0;
    for id in dashboards {
        let (n,): (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM public_links WHERE org_id = $1 AND dashboard_id = $2 AND revoked_at IS NULL \
             AND expires_at > $3",
        )
        .bind(&ctx.org_id)
        .bind(id)
        .bind(now)
        .fetch_one(&state.db)
        .await?;
        links += n;
    }
    if links == 0 {
        return Ok(());
    }
    Err(ApiError::forbidden(format!(
        "this change would reach {links} active public link(s) at once; saving it needs dashboards:public"
    ))
    .with_field(field)
    .because("sharing.public_links_active")
    .param("links", links))
}

/// The dashboards that show the library panel or saved analysis `id` (`library_panel_uses`,
/// `analysis_uses`), for `check_live_links`.
pub async fn dashboards_showing(state: &AppState, org_id: &str, linked: Linked, id: &str) -> ApiResult<Vec<String>> {
    let sql = match linked {
        Linked::LibraryPanel => {
            "SELECT dashboard_id FROM library_panel_uses WHERE org_id = $1 AND library_panel_id = $2"
        }
        Linked::Analysis => "SELECT dashboard_id FROM analysis_uses WHERE org_id = $1 AND analysis_id = $2",
    };
    let rows: Vec<(String,)> = sqlx::query_as(sql).bind(org_id).bind(id).fetch_all(&state.db).await?;
    Ok(rows.into_iter().map(|(id,)| id).collect())
}

/// What a dashboard panel can link.
#[derive(Clone, Copy, Debug)]
pub enum Linked {
    LibraryPanel,
    Analysis,
}

/// Panel types that draw a graph; without property details (`clickDetails: false`) they show
/// only the properties their options name.
const GRAPH_PANELS: &[&str] = &["network", "hierarchy", "path"];
/// Options of a graph panel that name a node or edge property (the caption is picked per node,
/// `caption_of`).
const PROPERTY_OPTIONS: &[&str] = &["colorProperty", "sizeBy", "edgeWidthBy", "timeProperty", "variableProperty"];
/// The properties a node is shown with when its caption property has no text, the first one with
/// (`CAPTION_KEYS` in `ui/src/panels/graph/adapter.ts`).
const CAPTION_KEYS: &[&str] = &["name", "title", "label", "displayName", "caption", "id", "key"];

/// Sets the flag when the request that runs steps goes away, so the blocking run stops.
struct CancelOnDrop(std::sync::Arc<std::sync::atomic::AtomicBool>);

impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.store(true, std::sync::atomic::Ordering::Relaxed);
    }
}

/// What a panel shows of an answer (owner decision D2), worked out on the server: the panel's
/// enabled steps run here (graph steps that already ran with their query are not run again),
/// answers of hidden queries are left out, and a graph panel without property details keeps only
/// the properties its options name and each node's caption. Errors keep their place; a step that
/// fails, or does not even parse, answers a neutral error for every shown query. The visitor's
/// page then draws the answers without steps. Runs hold one of `Sharing`'s step slots and stop
/// when the request goes away.
///
/// The flag says whether the answer may be kept for other visitors: only when every shown query
/// answered. An error (a busy server, a failed or timed-out step, a source that failed) is sent
/// to this visitor alone, so the next one gets a fresh try.
pub async fn shown_response(
    state: &AppState,
    panel: &model::Panel,
    response: QueryResponse,
) -> ApiResult<(QueryResponse, bool)> {
    let timeout = crate::settings::get(state, "datasources.query_timeout_secs").await?.as_u64().unwrap_or(30);
    let cancelled = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let keepable = |r: QueryResponse| {
        let keep = r.results.values().all(|o| matches!(o, QueryOutcome::Ok { .. }));
        (r, keep)
    };
    // Without an enabled step there is nothing to run: no slot. A step that does not parse
    // counts: `shown` answers the neutral error for it.
    let has_steps =
        panel.transformations.iter().any(|v| !matches!(crate::analysis::parse_step(v), Ok(s) if s.disabled));
    if !has_steps {
        // Trimming a large graph still takes its time, off the request threads.
        if graph_items(&response) <= BLOCKING_GRAPH_ITEMS {
            return Ok(keepable(shown(panel, response, timeout, cancelled)));
        }
        let panel = panel.clone();
        let _cancel = CancelOnDrop(cancelled.clone());
        return tokio::task::spawn_blocking(move || keepable(shown(&panel, response, timeout, cancelled)))
            .await
            .map_err(|e| ApiError::internal("sharing", e));
    }
    let wait = *state.sharing.step_wait.lock_or_recover();
    let slot = match tokio::time::timeout(wait, state.sharing.steps.clone().acquire_owned()).await {
        Ok(slot) => slot.map_err(|e| ApiError::internal("sharing", e))?,
        // Every slot busy for too long: the visitor gets the neutral error, not a queue.
        Err(_) => return Ok((failed(panel), false)),
    };
    let panel = panel.clone();
    let _cancel = CancelOnDrop(cancelled.clone());
    tokio::task::spawn_blocking(move || {
        let _slot = slot;
        keepable(shown(&panel, response, timeout, cancelled))
    })
    .await
    .map_err(|e| ApiError::internal("sharing", e))
}

/// The nodes and edges of the graph answers in `response`.
fn graph_items(response: &QueryResponse) -> usize {
    response
        .results
        .values()
        .map(|o| match o {
            QueryOutcome::Ok { result: crate::shapes::QueryResult::Graph { graph }, .. } => {
                graph.nodes.len() + graph.edges.len()
            }
            _ => 0,
        })
        .sum()
}

/// The neutral error for every shown query of `panel`.
fn failed(panel: &model::Panel) -> QueryResponse {
    let results = panel.targets.iter().filter(|t| !t.hide).map(|t| (t.ref_id.clone(), neutral_failure())).collect();
    QueryResponse { results }
}

fn neutral_failure() -> QueryOutcome {
    QueryOutcome::Err {
        error: ErrorBody {
            code: "validation".into(),
            message: String::new(),
            field: None,
            reason: None,
            params: None,
            request_id: None,
            retry_after_secs: None,
        },
    }
}

fn shown(
    panel: &model::Panel,
    mut response: QueryResponse,
    timeout_secs: u64,
    cancelled: std::sync::Arc<std::sync::atomic::AtomicBool>,
) -> QueryResponse {
    use crate::analysis::steps::{self, Control, Input};
    let hidden: BTreeSet<&str> = panel.targets.iter().filter(|t| t.hide).map(|t| t.ref_id.as_str()).collect();
    let parsed: Result<Vec<crate::analysis::Step>, String> =
        panel.transformations.iter().map(crate::analysis::parse_step).collect();
    let Ok(parsed) = parsed else {
        // A step that does not parse is never skipped: what is left would show more than the panel.
        return failed(panel);
    };
    let steps: Vec<crate::analysis::Step> = parsed.into_iter().filter(|s| !s.disabled).collect();
    let mut inputs = Vec::new();
    let mut errors = BTreeMap::new();
    let mut done = BTreeSet::new();
    for target in &panel.targets {
        match response.results.remove(&target.ref_id) {
            Some(QueryOutcome::Ok { result, steps: ran, .. }) => {
                done.extend(ran.into_iter().flatten().filter(|p| p.error.is_none()).map(|p| p.id));
                inputs.push((target.ref_id.clone(), Input::from(result)));
            }
            Some(QueryOutcome::Err { error }) => {
                errors.insert(target.ref_id.clone(), QueryOutcome::Err { error });
            }
            None => {}
        }
    }
    let ok = |result| QueryOutcome::Ok { result, steps: None, cache: None, elapsed_ms: None };
    let mut results: BTreeMap<String, QueryOutcome> = BTreeMap::new();
    let control = Control::new(cancelled, timeout_secs);
    match steps::run_outputs(&steps, inputs, &control, &done) {
        Ok(out) => {
            for f in out.frames {
                results.insert(f.name, ok(crate::shapes::QueryResult::Frame { frame: f.frame }));
            }
            for (name, documents) in out.documents {
                results.insert(name, ok(crate::shapes::QueryResult::Documents { documents }));
            }
            for (name, graph) in out.graphs {
                results.insert(name, ok(crate::shapes::QueryResult::Graph { graph }));
            }
            for (name, trace) in out.traces {
                results.insert(name, ok(crate::shapes::QueryResult::Trace { trace }));
            }
        }
        Err(_) => {
            for t in &panel.targets {
                results.insert(t.ref_id.clone(), neutral_failure());
            }
        }
    }
    results.extend(errors);
    results.retain(|name, _| !hidden.contains(name.as_str()));
    if GRAPH_PANELS.contains(&panel.kind.as_str()) && panel.options.get("clickDetails") == Some(&Value::Bool(false)) {
        let named: BTreeSet<&str> =
            PROPERTY_OPTIONS.iter().filter_map(|k| panel.options.get(*k)?.as_str()).filter(|v| !v.is_empty()).collect();
        let caption = panel.options.get("caption").and_then(Value::as_str).unwrap_or_default();
        for outcome in results.values_mut() {
            if let QueryOutcome::Ok { result: crate::shapes::QueryResult::Graph { graph }, .. } = outcome {
                prune_graph(graph, &named, caption);
            }
        }
    }
    QueryResponse { results }
}

/// Whether a property shows as text in a caption (`propertyText` in the UI gives no text for
/// these).
fn has_text(value: &Value) -> bool {
    !matches!(value, Value::Null) && value.as_str() != Some("")
}

/// The property a node is shown with, as `nodeCaption` in `ui/src/panels/graph/adapter.ts`
/// picks it: the panel's caption property when it has text, else the first `CAPTION_KEYS`
/// property with text; `None` when the node shows its label and id.
fn caption_of<'a>(properties: &'a BTreeMap<String, Value>, caption: &str) -> Option<&'a str> {
    let with_text = |key: &str| properties.get_key_value(key).filter(|(_, v)| has_text(v)).map(|(k, _)| k.as_str());
    (!caption.is_empty())
        .then(|| with_text(caption))
        .flatten()
        .or_else(|| CAPTION_KEYS.iter().find_map(|k| with_text(k)))
}

/// Keeps the properties `named` and the one each node is shown with (`caption_of`); the schema
/// lists only what is left.
fn prune_graph(graph: &mut crate::shapes::GraphSet, named: &BTreeSet<&str>, caption: &str) {
    for node in &mut graph.nodes {
        let shown = caption_of(&node.properties, caption).map(str::to_string);
        node.properties.retain(|k, _| named.contains(k.as_str()) || shown.as_deref() == Some(k.as_str()));
    }
    for edge in &mut graph.edges {
        edge.properties.retain(|k, _| named.contains(k.as_str()));
    }
    let kept: BTreeSet<String> = graph
        .nodes
        .iter()
        .flat_map(|n| n.properties.keys())
        .chain(graph.edges.iter().flat_map(|e| e.properties.keys()))
        .cloned()
        .collect();
    for keys in graph.schema.property_keys.values_mut() {
        keys.retain(|k| kept.contains(k));
    }
}

/// The data sources the panels' stored queries use (hidden ones included: a step may read them).
/// A target of a data source variable (`$name`) counts with the variable's saved default; a pick
/// of another source is checked against the creator's rights when it runs
/// (`query::picked_sources`).
pub fn panel_sources(model: &model::DashboardModel, panels: &[SharedPanel]) -> BTreeSet<String> {
    panels
        .iter()
        .flat_map(|p| p.panel.targets.iter().map(|t| model.default_source(&t.datasource_id).to_string()))
        .collect()
}

/// Whether the creator may still query every one of `sources`.
pub async fn may_query_all(state: &AppState, ctx: &OrgCtx, sources: &BTreeSet<String>) -> ApiResult<bool> {
    if sources.is_empty() {
        return Ok(true);
    }
    let access = DatasourceAccess::load(&state.db, ctx).await?;
    Ok(sources.iter().all(|id| access.allows(Permission::DatasourcesQuery, id)))
}

/// Why a public link or snapshot is suspended. Suspension is not stored: it is what the checks
/// find at each request, so the link works again once the cause is gone (until it expires).
/// Shown to the creator and the organization's admins only, never to visitors.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum SuspendedReason {
    /// Public sharing is off for the server or the organization.
    SharingOff,
    /// The creator's account is gone or disabled, or they left the organization.
    CreatorRemoved,
    /// The creator no longer holds `dashboards:public`, read on the dashboard or query rights on
    /// one of its sources.
    CreatorRights,
    /// The dashboard is in the trash.
    DashboardTrashed,
}

/// The outcome of `creator_gate`.
pub enum Gate {
    Open(Box<OrgCtx>, Box<DashboardModel>),
    Suspended(SuspendedReason),
}

/// What a public link or snapshot needs on every request: public sharing on for the server and
/// the organization, and a creator who is still a member, still holds `dashboards:public` and may
/// still read the dashboard (not in the trash). The creator's context and the dashboard come back.
/// The caller checks expiry, revocation and the creator's query rights.
pub async fn creator_gate(
    state: &AppState,
    org_id: &str,
    created_by: Option<&str>,
    dashboard_id: &str,
) -> ApiResult<Gate> {
    if !public_enabled(state, org_id).await? {
        return Ok(Gate::Suspended(SuspendedReason::SharingOff));
    }
    let Some(ctx) = creator_ctx(state, org_id, created_by).await? else {
        return Ok(Gate::Suspended(SuspendedReason::CreatorRemoved));
    };
    if !ctx.permissions.contains(&Permission::DashboardsPublic) {
        return Ok(Gate::Suspended(SuspendedReason::CreatorRights));
    }
    let trashed: Option<(Option<i64>,)> =
        sqlx::query_as("SELECT deleted_at FROM dashboards WHERE org_id = $1 AND id = $2")
            .bind(org_id)
            .bind(dashboard_id)
            .fetch_optional(&state.db)
            .await?;
    if matches!(trashed, Some((Some(_),))) {
        return Ok(Gate::Suspended(SuspendedReason::DashboardTrashed));
    }
    match creator_model(state, &ctx, dashboard_id).await? {
        Some(model) => Ok(Gate::Open(Box::new(ctx), Box::new(model))),
        None => Ok(Gate::Suspended(SuspendedReason::CreatorRights)),
    }
}

/// The variable values a dashboard opens with: each variable's current value, constants left out
/// (they are the dashboard's own and never sent).
pub fn default_variables(model: &DashboardModel) -> BTreeMap<String, Value> {
    model
        .variables
        .iter()
        .filter(|v| v.kind != VariableType::Constant)
        .filter_map(|v| crate::dashboards::variables::saved_value(v).map(|value| (v.name.clone(), value)))
        .collect()
}

/// The stored values of a link that the dashboard still has, so a variable removed since does
/// not break the link; a value that no longer fits is refused when the queries run.
pub fn current_variables(model: &DashboardModel, stored: &BTreeMap<String, Value>) -> BTreeMap<String, Value> {
    let known: BTreeSet<&str> =
        model.variables.iter().filter(|v| v.kind != VariableType::Constant).map(|v| v.name.as_str()).collect();
    stored.iter().filter(|(k, _)| known.contains(k.as_str())).map(|(k, v)| (k.clone(), v.clone())).collect()
}

/// A dashboard's relative time range, as links store it (`now-6h` to `now`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(deny_unknown_fields)]
pub struct SharedTimeRange {
    pub from: String,
    pub to: String,
}

/// A dashboard as people without an account see it: what draws it, nothing that reaches past it.
#[derive(Clone, Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct PublicDashboard {
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub refresh_seconds: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub time_zone: Option<String>,
    /// `monday`, `sunday` or `saturday`.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub week_start: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub fiscal_year_start_month: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub now_delay: Option<String>,
    /// `off`, `crosshair` or `tooltip`.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub shared_cursor: Option<String>,
    /// The variables with their fixed values, for the header; constants are left out.
    pub variables: Vec<PublicVariable>,
    pub rows: Vec<PublicRow>,
    pub panels: Vec<PublicPanel>,
}

#[derive(Clone, Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct PublicVariable {
    pub name: String,
    /// `query`, `custom`, `textbox` or `interval`.
    #[serde(rename = "type")]
    #[cfg_attr(test, ts(rename = "type"))]
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub label: Option<String>,
    /// The fixed value (a list for several values); absent when there is none.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional, type = "unknown"))]
    pub value: Option<Value>,
}

#[derive(Clone, Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct PublicRow {
    pub id: String,
    pub title: String,
    pub collapsed: bool,
}

#[derive(Clone, Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct PublicPanel {
    pub id: String,
    #[serde(rename = "type")]
    #[cfg_attr(test, ts(rename = "type"))]
    pub kind: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub description: Option<String>,
    pub grid: PublicGrid,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub row_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub time_from: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub time_shift: Option<String>,
    pub transparent: bool,
    /// The panel's shown queries by reference id only. Its steps ran on the server
    /// (`shown_response`): the answers are what the panel draws, without steps of their own.
    pub targets: Vec<PublicTarget>,
    /// The panel's options and field settings without links (`dataLinks`, cell `link`).
    #[cfg_attr(test, ts(type = "unknown"))]
    pub options: Value,
    #[cfg_attr(test, ts(type = "unknown"))]
    pub field_config: Value,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct PublicGrid {
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
}

#[derive(Clone, Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct PublicTarget {
    pub ref_id: String,
    pub hide: bool,
}

/// Keys of panel options and field settings that hold addresses (data links of document and
/// graph panels, a table cell's link): removed at any depth.
const LINK_KEYS: &[&str] = &["dataLinks", "link", "links"];

fn without_links(value: &Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(
            map.iter()
                .filter(|(k, _)| !LINK_KEYS.contains(&k.as_str()))
                .map(|(k, v)| (k.clone(), without_links(v)))
                .collect(),
        ),
        Value::Array(items) => Value::Array(items.iter().map(without_links).collect()),
        other => other.clone(),
    }
}

fn enum_text<T: Serialize>(value: &T) -> Option<String> {
    serde_json::to_value(value).ok().and_then(|v| v.as_str().map(str::to_string))
}

/// What a visitor sees of `model`, with `panels` resolved (`shared_panels`) and the fixed
/// `variables`.
pub fn public_dashboard(
    model: &DashboardModel,
    panels: &[SharedPanel],
    variables: &BTreeMap<String, Value>,
) -> PublicDashboard {
    PublicDashboard {
        title: model.title.clone(),
        refresh_seconds: model.refresh_seconds,
        time_zone: model.time_zone.clone(),
        week_start: model.week_start.as_ref().and_then(enum_text),
        fiscal_year_start_month: model.fiscal_year_start_month,
        now_delay: model.now_delay.clone(),
        shared_cursor: model.shared_cursor.as_ref().and_then(enum_text),
        variables: model
            .variables
            .iter()
            .filter(|v| v.kind != VariableType::Constant)
            .map(|v| PublicVariable {
                name: v.name.clone(),
                kind: enum_text(&v.kind).unwrap_or_default(),
                label: v.label.clone(),
                value: variables.get(&v.name).cloned(),
            })
            .collect(),
        rows: model
            .rows
            .iter()
            .map(|r| PublicRow { id: r.id.clone(), title: r.title.clone(), collapsed: r.collapsed })
            .collect(),
        panels: panels
            .iter()
            .map(|SharedPanel { panel: p }| PublicPanel {
                id: p.id.clone(),
                kind: p.kind.clone(),
                title: p.title.clone(),
                description: p.description.clone(),
                grid: PublicGrid { x: p.grid.x, y: p.grid.y, w: p.grid.w, h: p.grid.h },
                row_id: p.row_id.clone(),
                time_from: p.time_from.clone(),
                time_shift: p.time_shift.clone(),
                transparent: p.transparent,
                targets: p
                    .targets
                    .iter()
                    .filter(|t| !t.hide)
                    .map(|t| PublicTarget { ref_id: t.ref_id.clone(), hide: false })
                    .collect(),
                options: without_links(&p.options),
                field_config: without_links(&p.field_config),
            })
            .collect(),
    }
}

/// An answer as people without an account get it: the results in their shapes without the
/// executed statement, paging cursors, notices or step reports, errors reduced to their code and
/// a generic message. No query text, source name or text from the source passes.
pub fn public_response(response: QueryResponse) -> QueryResponse {
    let results = response
        .results
        .into_iter()
        .map(|(ref_id, outcome)| {
            let outcome = match outcome {
                QueryOutcome::Ok { mut result, .. } => {
                    result.strip_for_sharing();
                    QueryOutcome::Ok { result, steps: None, cache: None, elapsed_ms: None }
                }
                QueryOutcome::Err { error } => QueryOutcome::Err { error: neutral_error(&error) },
            };
            (ref_id, outcome)
        })
        .collect();
    QueryResponse { results }
}

fn neutral_error(error: &ErrorBody) -> ErrorBody {
    // The code says what kind of failure it was; the message, reason and its parameters can name
    // hosts, tables or fields of the source and stay on the server.
    let code = match error.code.as_str() {
        "query_timeout" | "rate_limited" | "busy" => error.code.clone(),
        _ => "datasource_error".to_string(),
    };
    ErrorBody {
        code,
        message: "the query failed".into(),
        field: None,
        reason: None,
        params: None,
        request_id: None,
        retry_after_secs: None,
    }
}

/// The range a visitor asks for must lie within the link's window: from `now - max_window_ms` to
/// now, each with `CLOCK_SLACK_MS` of slack. A page that asks for the whole window names its start
/// from its own clock and the request arrives a moment later, and a browser clock may run
/// slightly ahead or behind: without the slack at the start, the widest range a link offers
/// would be refused.
pub fn check_window(range: TimeRange, max_window_ms: i64, now: i64) -> ApiResult<()> {
    crate::datasources::check_range(range)?;
    let earliest = now.saturating_sub(max_window_ms).saturating_sub(CLOCK_SLACK_MS);
    if range.from < earliest || range.to > now.saturating_add(CLOCK_SLACK_MS) {
        return Err(ApiError::validation(format!("the time range must lie within the last {max_window_ms} ms"))
            .with_field("timeRange")
            .because("sharing.window_exceeded")
            .param("maxWindowMs", max_window_ms));
    }
    Ok(())
}

/// How far a visitor's `to` may lie ahead of the server's clock, and their `from` before the
/// start of the window.
pub const CLOCK_SLACK_MS: i64 = 60_000;

/// The window of a new link: `requested` or `DEFAULT_WINDOW_MS`, at most `max_expiry_days`.
pub fn window(requested: Option<i64>, max_expiry_days: i64) -> ApiResult<i64> {
    let max = max_expiry_days.saturating_mul(DAY_MS);
    let window = requested.unwrap_or(DEFAULT_WINDOW_MS.min(max));
    if !(MIN_WINDOW_MS..=max).contains(&window) {
        return Err(ApiError::validation(format!("maxWindowMs must be {MIN_WINDOW_MS} to {max}"))
            .with_field("maxWindowMs")
            .because("sharing.window_invalid")
            .param("min", MIN_WINDOW_MS)
            .param("max", max));
    }
    Ok(window)
}

/// `sharing.max_expiry_days`.
pub async fn max_expiry_days(state: &AppState) -> ApiResult<i64> {
    Ok(crate::settings::get(state, "sharing.max_expiry_days").await?.as_i64().unwrap_or(365))
}

/// How long revoked and expired links and snapshots are kept (listed with their status) before
/// they are deleted, a snapshot's frozen results with it.
pub const KEEP_ENDED_MS: i64 = 30 * DAY_MS;

/// How long the hash of a deleted link or snapshot still counts as a known token.
pub const KEEP_TOMBSTONES_MS: i64 = 90 * DAY_MS;

/// Deletes links and snapshots that expired or were revoked `KEEP_ENDED_MS` before `now`, keeping
/// their token hashes as tombstones for `KEEP_TOMBSTONES_MS`; the number of links and snapshots
/// deleted. All in one transaction.
pub async fn purge_ended(db: &sqlx::AnyPool, now: i64) -> ApiResult<u64> {
    let before = now.saturating_sub(KEEP_ENDED_MS);
    let mut tx = crate::db::begin(db).await?;
    for sql in [
        "INSERT INTO share_tombstones (token_hash, purged_at) SELECT token_hash, $2 FROM public_links \
         WHERE expires_at <= $1 OR revoked_at <= $1 ON CONFLICT (token_hash) DO NOTHING",
        "INSERT INTO share_tombstones (token_hash, purged_at) SELECT token_hash, $2 FROM snapshots \
         WHERE token_hash IS NOT NULL AND (expires_at <= $1 OR revoked_at <= $1) ON CONFLICT (token_hash) DO NOTHING",
    ] {
        sqlx::query(sql).bind(before).bind(now).execute(&mut *tx).await?;
    }
    let mut deleted = 0;
    for sql in [
        "DELETE FROM public_links WHERE expires_at <= $1 OR revoked_at <= $1",
        "DELETE FROM snapshots WHERE expires_at <= $1 OR revoked_at <= $1",
    ] {
        deleted += sqlx::query(sql).bind(before).execute(&mut *tx).await?.rows_affected();
    }
    sqlx::query("DELETE FROM share_tombstones WHERE purged_at <= $1")
        .bind(now.saturating_sub(KEEP_TOMBSTONES_MS))
        .execute(&mut *tx)
        .await?;
    crate::db::commit(tx).await?;
    Ok(deleted)
}

/// Deletes ended links and snapshots every hour, on one server of a cluster (the leader).
pub fn spawn_cleanup(state: AppState) {
    use crate::db::JobError;
    let cluster_state = state.clone();
    crate::cluster::spawn_job(
        &cluster_state,
        "sharing:cleanup",
        "deleting ended public links and snapshots",
        crate::db::Schedule::hourly(),
        move || {
            let state = state.clone();
            async move {
                match purge_ended(state.background.db(), state.clock.now_ms()).await {
                    Ok(0) => Ok(()),
                    Ok(n) => {
                        tracing::info!("deleted {n} public links and snapshots 30 days after they ended");
                        Ok(())
                    }
                    Err(e) if e.code == "busy" => Err(JobError::Busy(e.message)),
                    Err(e) => Err(JobError::Failed(e.message)),
                }
            }
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shapes::QueryResult;
    use serde_json::json;

    fn model(value: Value) -> DashboardModel {
        model::parse(value).unwrap()
    }

    fn sample() -> DashboardModel {
        model(json!({
            "schemaVersion": model::SCHEMA_VERSION, "title": "Umsatz", "timeRange": { "from": "now-6h", "to": "now" },
            "tags": ["intern"],
            "variables": [
                { "name": "region", "type": "custom", "options": ["Nord", "Süd"], "current": { "value": "Nord" } },
                { "name": "secret", "type": "constant", "current": "db-intern-01" }
            ],
            "annotations": [ { "id": "a", "name": "Releases", "datasourceId": "ds-a", "query": { "sql": "SELECT 1" } } ],
            "links": [ { "type": "url", "title": "Intern", "url": "https://intern.example/" } ],
            "panels": [ {
                "id": "p1", "type": "table", "title": "Bestellungen", "grid": { "x": 0, "y": 0, "w": 12, "h": 8 },
                "targets": [ { "refId": "A", "datasourceId": "ds-1", "query": { "sql": "SELECT * FROM orders" } } ],
                "links": [ { "title": "Details", "url": "/dashboards/other" } ],
                "fieldConfig": { "defaults": {}, "overrides": [ { "matcher": { "type": "name", "value": "url" },
                    "properties": { "cellDisplay": "link", "link": "https://example.org/q?v=${__value}" } } ] }
            } ]
        }))
    }

    #[test]
    fn the_public_view_holds_no_query_source_annotation_or_link() {
        let m = sample();
        let panels: Vec<SharedPanel> = m.panels.iter().map(|p| SharedPanel { panel: p.clone() }).collect();
        let view = public_dashboard(&m, &panels, &default_variables(&m));
        let text = serde_json::to_string(&view).unwrap();
        for leak in [
            "SELECT",
            "ds-1",
            "ds-a",
            "Releases",
            "intern.example",
            "/dashboards/other",
            "example.org",
            "db-intern-01",
            "secret",
        ] {
            assert!(!text.contains(leak), "{leak} in {text}");
        }
        assert_eq!(view.variables.len(), 1);
        assert_eq!(view.variables[0].value, Some(json!("Nord")));
        assert_eq!(view.panels[0].targets[0].ref_id, "A");
        assert_eq!(view.panels[0].field_config["overrides"][0]["properties"]["cellDisplay"], "link");
    }

    #[test]
    fn defaults_take_current_values_and_leave_constants_out() {
        let m = sample();
        assert_eq!(default_variables(&m), BTreeMap::from([("region".to_string(), json!("Nord"))]));
        let stored = BTreeMap::from([("region".to_string(), json!("Süd")), ("gone".to_string(), json!(1))]);
        assert_eq!(current_variables(&m, &stored), BTreeMap::from([("region".to_string(), json!("Süd"))]));
    }

    #[test]
    fn public_answers_keep_their_shape_and_lose_how_they_were_made() {
        let graph: QueryResult = serde_json::from_value(json!({ "shape": "graph", "graph": {
            "nodes": [ { "id": "1", "labels": ["Person"], "properties": { "name": "Ana" } } ],
            "edges": [], "schema": { "labels": ["Person"], "edgeTypes": [], "propertyKeys": {} } } }))
        .unwrap();
        let frame: QueryResult = serde_json::from_value(json!({ "shape": "frame", "frame": {
            "fields": [ { "name": "n", "type": "number", "values": [1] } ],
            "meta": { "executedQuery": "SELECT n FROM secret_table", "rowsTruncated": false, "notices": [] } } }))
        .unwrap();
        let error = ErrorBody {
            code: "datasource_error".into(),
            message: "connection to db-intern-01:5432 refused".into(),
            field: None,
            reason: Some("target.refused".into()),
            params: Some(BTreeMap::from([("host".into(), "db-intern-01".into())])),
            request_id: None,
            retry_after_secs: None,
        };
        let response = QueryResponse {
            results: BTreeMap::from([
                ("G".into(), QueryOutcome::Ok { result: graph.clone(), steps: None, cache: None, elapsed_ms: Some(5) }),
                ("F".into(), QueryOutcome::Ok { result: frame, steps: None, cache: None, elapsed_ms: None }),
                ("E".into(), QueryOutcome::Err { error }),
            ]),
        };
        let shared = public_response(response);
        let text = serde_json::to_string(&shared).unwrap();
        assert!(
            !text.contains("secret_table") && !text.contains("db-intern-01") && !text.contains("elapsedMs"),
            "{text}"
        );
        let QueryOutcome::Ok { result, .. } = &shared.results["G"] else { panic!("{text}") };
        assert_eq!(result, &graph);
        assert!(matches!(&shared.results["F"], QueryOutcome::Ok { result: QueryResult::Frame { .. }, .. }));
    }

    #[test]
    fn windows_are_bounded_by_the_longest_expiry() {
        assert_eq!(window(None, 365).unwrap(), DEFAULT_WINDOW_MS);
        assert_eq!(window(None, 2).unwrap(), 2 * DAY_MS);
        assert!(window(Some(MIN_WINDOW_MS - 1), 365).is_err());
        assert!(window(Some(30 * DAY_MS), 30).is_ok() && window(Some(30 * DAY_MS + 1), 30).is_err());
    }

    #[test]
    fn visitors_look_back_within_the_window_only() {
        let hour = 3_600_000;
        let now = 1_800_000_000_000;
        let ok = |from, to| check_window(TimeRange { from, to }, 24 * hour, now);
        assert!(ok(now - 24 * hour, now).is_ok());
        assert!(ok(now - hour, now + CLOCK_SLACK_MS).is_ok());
        // The whole window, named by a page a moment before the request arrived or by a browser
        // whose clock is a little behind: the start has the same slack as the end.
        assert!(ok(now - 24 * hour - 250, now - 250).is_ok());
        assert!(ok(now - 24 * hour - CLOCK_SLACK_MS, now).is_ok());
        for (from, to) in [
            (now - 24 * hour - CLOCK_SLACK_MS - 1, now),
            (now - hour, now + CLOCK_SLACK_MS + 1),
            (now - 48 * hour, now - 30 * hour),
        ] {
            let e = ok(from, to).unwrap_err();
            assert_eq!(e.reason.unwrap().code, "sharing.window_exceeded");
        }
    }

    #[test]
    fn tokens_are_long_random_and_looked_up_by_hash() {
        let (token, hash) = new_token();
        // 256 random bits, at least the 128 the owner asked for.
        assert!(token.len() >= 43);
        assert_eq!(token_hash(&token), Some(hash));
        assert_eq!(token_hash("short"), None);
        assert_eq!(token_hash(&format!("{}!", &token[1..])), None);
    }

    fn ok(result: Value) -> QueryOutcome {
        QueryOutcome::Ok { result: serde_json::from_value(result).unwrap(), steps: None, cache: None, elapsed_ms: None }
    }

    fn panel(value: Value) -> model::Panel {
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn answers_hold_what_the_panel_shows_after_its_steps() {
        let frame = |values: Value| json!({ "shape": "frame", "frame": { "fields": [ { "name": "amount", "type": "number", "values": values } ] } });
        let p = panel(json!({
            "id": "p", "type": "table", "grid": { "x": 0, "y": 0, "w": 1, "h": 1 },
            "targets": [ { "refId": "A", "datasourceId": "d", "query": {} },
                         { "refId": "B", "datasourceId": "d", "query": {}, "hide": true } ],
            "transformations": [ { "id": "s", "type": "calculate", "frame": "A", "name": "double", "expression": "amount * 2" } ]
        }));
        let response = QueryResponse {
            results: BTreeMap::from([("A".into(), ok(frame(json!([1, 2])))), ("B".into(), ok(frame(json!([99]))))]),
        };
        let shown = serde_json::to_value(shown(&p, response, 5, Default::default())).unwrap();
        assert!(shown["results"].get("B").is_none(), "the hidden query is left out: {shown}");
        let fields = &shown["results"]["A"]["result"]["frame"]["fields"];
        assert_eq!(fields[1]["name"], "double", "{shown}");
        assert_eq!(fields[1]["values"], json!([2.0, 4.0]), "{shown}");
    }

    #[test]
    fn graph_panels_without_details_keep_only_named_properties() {
        let graph = json!({ "shape": "graph", "graph": {
            "nodes": [ { "id": "1", "labels": ["Person"], "properties": { "name": "Ana", "salary": 9000, "team": "A" } } ],
            "edges": [ { "id": "e", "type": "KENNT", "from": "1", "to": "1", "properties": { "since": 2020, "note": "x" } } ],
            "schema": { "labels": ["Person"], "edgeTypes": ["KENNT"],
                        "propertyKeys": { "Person": ["name", "salary", "team"], "KENNT": ["since", "note"] } } } });
        let with = |details: bool, caption: &str| {
            let p = panel(json!({
                "id": "p", "type": "network", "grid": { "x": 0, "y": 0, "w": 1, "h": 1 },
                "targets": [ { "refId": "A", "datasourceId": "d", "query": {} } ],
                "options": { "clickDetails": details, "caption": caption, "colorProperty": "team", "edgeWidthBy": "since" }
            }));
            let response = QueryResponse { results: BTreeMap::from([("A".into(), ok(graph.clone()))]) };
            serde_json::to_value(shown(&p, response, 5, Default::default())).unwrap()
        };
        // Without a caption of its own the node keeps the first usual name property.
        let lean = with(false, "");
        let g = &lean["results"]["A"]["result"]["graph"];
        assert_eq!(g["nodes"][0]["properties"], json!({ "name": "Ana", "team": "A" }));
        assert_eq!(g["edges"][0]["properties"], json!({ "since": 2020 }));
        assert_eq!(g["schema"]["propertyKeys"], json!({ "Person": ["name", "team"], "KENNT": ["since"] }));
        // A named caption is kept instead.
        let named = with(false, "salary");
        let g = &named["results"]["A"]["result"]["graph"];
        assert_eq!(g["nodes"][0]["properties"], json!({ "salary": 9000, "team": "A" }));
        // A named caption the node has no text for falls back to the usual name properties.
        let missing = with(false, "spitzname");
        let g = &missing["results"]["A"]["result"]["graph"];
        assert_eq!(g["nodes"][0]["properties"], json!({ "name": "Ana", "team": "A" }));
        let full = with(true, "");
        assert_eq!(full["results"]["A"]["result"]["graph"]["nodes"][0]["properties"]["salary"], 9000);
    }

    #[test]
    fn captions_follow_the_ui() {
        let props = |v: Value| -> BTreeMap<String, Value> { serde_json::from_value(v).unwrap() };
        let p = props(json!({ "name": "", "title": "Chefin", "label": "x", "nick": null }));
        assert_eq!(caption_of(&p, ""), Some("title"), "the first one with text");
        assert_eq!(caption_of(&p, "nick"), Some("title"), "a named one without text falls back");
        assert_eq!(caption_of(&p, "label"), Some("label"));
        assert_eq!(caption_of(&props(json!({ "gehalt": 1 })), ""), None, "label and id then");
    }

    #[test]
    fn a_step_that_does_not_parse_answers_the_neutral_error() {
        let p = panel(json!({
            "id": "p", "type": "table", "grid": { "x": 0, "y": 0, "w": 1, "h": 1 },
            "targets": [ { "refId": "A", "datasourceId": "d", "query": {} } ],
            "transformations": [ { "id": "s", "type": "keineSolcheStufe" } ]
        }));
        let frame = json!({ "shape": "frame", "frame": { "fields": [ { "name": "geheim", "type": "number", "values": [1] } ] } });
        let response = QueryResponse { results: BTreeMap::from([("A".into(), ok(frame))]) };
        let shown = serde_json::to_value(shown(&p, response, 5, Default::default())).unwrap();
        assert!(shown["results"]["A"].get("error").is_some(), "{shown}");
        assert!(!shown.to_string().contains("geheim"), "{shown}");
    }

    #[test]
    fn visitor_ranges_round_up_to_whole_minutes() {
        let r = round_range(TimeRange { from: 1_800_000_000_001, to: 1_800_000_030_000 });
        assert_eq!((r.from, r.to), (1_800_000_060_000, 1_800_000_060_000));
        let r = round_range(TimeRange { from: 1_800_000_000_000, to: 1_800_000_120_001 });
        assert_eq!((r.from, r.to), (1_800_000_000_000, 1_800_000_180_000));
    }
}
