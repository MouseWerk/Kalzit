//! The server's query cache (docs/ARCHITECTURE.md, "Query cache"): answers of read-only queries,
//! kept in memory for a time each data source sets, so a dashboard opened by the same person
//! again, or refreshed within that time, does not ask the database again.
//!
//! - **Never across rights.** The key holds the caller's organization, user, role and
//!   permissions and the caller's own scope (the AI data rules of an AI call) next to the
//!   query: what one person ran is never served to another. The routes authorize every request
//!   before the cache is asked, so losing a right ends the hits at once; a change of rights also
//!   ends the organization's entries (`routes::table`, `RouteDef::changes_rights`).
//! - **Generations, not scans.** Every entry carries the generations it was read under (rights
//!   server-wide and of its organization, target rules, its data source, `Stamp`); a change bumps
//!   one, and an entry under an older one is never served and goes when next asked for.
//! - **Everything that shapes the answer** is in the key: data source and its settings version
//!   (`updated_at`), kind and its shapes, the query in canonical form, graph steps, cursor, the
//!   time range (rounded, below), interval, data points, variables and which may be
//!   identifiers, and the row limit.
//! - **Rounded ranges.** A range that ends now moves with every load; both its ends go down to a
//!   step of the panel's interval (at most the TTL, at least a second), the query runs with that
//!   range, and loads within the step share the answer. Ranges in the past stay as asked.
//! - **Only answers.** Errors, timeouts and graph steps that failed are never kept.
//! - **Bounded.** One server-wide memory limit (`datasources.cache_max_bytes`); the least recently
//!   used entries go first, one organization holds at most half and one entry a quarter of it.
//!   Entries are kept serialized and counted with a generous fixed overhead. Keeping an answer
//!   serializes it only up to that quarter and within the request's response budget.
//! - **Hits cost like answers.** A hit takes a query slot and is charged against the request's
//!   response budget and the server's in-flight pool before it is read (`run_one`); one that does
//!   not fit runs in its source as a miss would.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::frame::ResponseBudget;
use crate::locks::MutexExt;
use crate::shapes::{CacheInfo, CacheStatus, QueryResult, Shape, StepPlace, TimeRange};

/// TTL of a source that caches without its own (`cacheTtlSecs`).
pub const DEFAULT_TTL_SECS: u64 = 60;
/// The longest TTL a source may set: a day.
pub const MAX_TTL_SECS: u64 = 86_400;
/// The shortest rounding step of a moving range.
const MIN_STEP_MS: i64 = 1_000;
/// One entry takes at most this share of the limit, so one huge answer cannot empty the cache.
const MAX_ENTRY_SHARE: usize = 4;
/// Bytes an entry holds besides its answer: the key in three maps, the entry, its organization's
/// share and the allocator's rounding take less than this.
const ENTRY_OVERHEAD: usize = 512;
/// One organization's entries take at most this share of the limit, so it cannot push out all
/// others.
const MAX_ORG_SHARE: usize = 2;
/// One person's entries take at most this share of their organization's.
const MAX_USER_SHARE: usize = 4;
/// The bytes the budget counts for one value (`frame::value_size`).
const VALUE_SIZE: usize = 32;

/// Kinds whose sources cache unless their settings say otherwise: databases whose answers change
/// at the pace of their data. Metrics (Prometheus), sources that report changes as they happen
/// (MongoDB change streams), files and HTTP APIs, and plugins start without, so a dashboard of
/// live values never shows an older one.
pub fn enabled_by_default(kind: &str) -> bool {
    matches!(kind, "postgres" | "mysql" | "sqlite" | "mssql" | "elasticsearch" | "neo4j" | "memgraph" | "tigergraph")
}

/// The TTL of a stored data source in milliseconds, `None` when it does not cache: its own
/// `cacheEnabled` (or the kind's default) and `cacheTtlSecs` (or `DEFAULT_TTL_SECS`).
pub fn source_ttl_ms(kind: &str, settings: &Value) -> Option<i64> {
    let on = settings.get("cacheEnabled").and_then(Value::as_bool).unwrap_or_else(|| enabled_by_default(kind));
    let secs = settings.get("cacheTtlSecs").and_then(Value::as_u64).unwrap_or(DEFAULT_TTL_SECS).clamp(1, MAX_TTL_SECS);
    on.then_some(secs as i64 * 1000)
}

/// How a run uses the cache. Routes choose: free queries, panels, saved analyses and variable
/// options use it; live updates, exports and annotations never do.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum CacheMode {
    /// Neither read nor written.
    #[default]
    Off,
    /// Read, and written on a miss.
    Use,
    /// Not read, but the new answer replaces the kept one ("Refresh").
    Refresh,
}

/// The cache mode of a run and the caller's scope within its rights.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CacheUse {
    pub mode: CacheMode,
    /// What else decides what the caller may see, beyond organization, user and permissions,
    /// which are always in the key: the AI data rules for an AI call (`ai:` and their print).
    pub scope: String,
}

impl CacheUse {
    pub fn off() -> Self {
        Self::default()
    }

    /// Reads the cache, or refreshes it when `refresh`.
    pub fn read(refresh: bool) -> Self {
        Self { mode: if refresh { CacheMode::Refresh } else { CacheMode::Use }, scope: String::new() }
    }

    pub fn scoped(mut self, scope: impl Into<String>) -> Self {
        self.scope = scope.into();
        self
    }
}

/// The range a cached query runs with (see the module notes): a range whose end is at most one
/// TTL ago, or later, goes down to a multiple of the step, keeping its length. The step is the
/// query's interval within one second and the TTL.
pub fn round_range(range: TimeRange, interval_ms: u64, ttl_ms: i64, now_ms: i64) -> TimeRange {
    if range.to < now_ms.saturating_sub(ttl_ms) {
        return range;
    }
    let step = i64::try_from(interval_ms).unwrap_or(i64::MAX).clamp(MIN_STEP_MS, ttl_ms.max(MIN_STEP_MS));
    let to = range.to.div_euclid(step) * step;
    let shift = range.to - to;
    TimeRange { from: range.from.saturating_sub(shift).max(super::MIN_TIME_MS), to }
}

/// The JSON value with every object's keys in order, so equal queries make equal keys however
/// their keys were written.
pub fn canonical(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let sorted: BTreeMap<&String, Value> = map.iter().map(|(k, v)| (k, canonical(v))).collect();
            Value::Object(sorted.into_iter().map(|(k, v)| (k.clone(), v)).collect())
        }
        Value::Array(items) => Value::Array(items.iter().map(canonical).collect()),
        other => other.clone(),
    }
}

/// Who asks, as far as it decides what they may see. Every part goes into the key.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Caller<'a> {
    pub org_id: &'a str,
    pub user_id: &'a str,
    pub role: &'a str,
    /// The caller's permissions in the organization, in order.
    pub permissions: Vec<&'static str>,
    pub scope: &'a str,
}

/// Everything that shapes one answer.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Query<'a> {
    pub datasource_id: &'a str,
    /// The source's settings version: any change of the source is another key.
    pub version: i64,
    pub kind: &'a str,
    pub shapes: &'a [Shape],
    pub query: Value,
    pub steps: Vec<Value>,
    pub cursor: Option<&'a str>,
    pub range: TimeRange,
    pub interval_ms: u64,
    pub max_data_points: Option<u32>,
    pub variables: &'a BTreeMap<String, Value>,
    pub identifiers: Option<&'a BTreeSet<String>>,
    pub max_rows: usize,
}

pub type Key = [u8; 32];

/// The key of one answer for one caller.
pub fn key(caller: &Caller<'_>, query: &Query<'_>) -> Key {
    let text = serde_json::to_vec(&(caller, query)).expect("cache keys are plain JSON");
    Sha256::digest(&text).into()
}

/// What an entry keeps: the answer and the graph steps it ran.
#[derive(Deserialize)]
pub struct Stored {
    pub result: QueryResult,
    #[serde(default)]
    pub steps: Option<Vec<StepPlace>>,
}

/// `Stored`, borrowed for writing.
#[derive(Serialize)]
struct StoredRef<'a> {
    result: &'a QueryResult,
    #[serde(skip_serializing_if = "Option::is_none")]
    steps: Option<&'a Vec<StepPlace>>,
}

/// The generations an entry was kept under: rights server-wide, the target rules, the rights of
/// its organization and its data source. An entry whose stamp is no longer the current one is
/// never served and goes when it is next asked for (invalidation in O(1), without a scan).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Stamp {
    global: u64,
    policy: u64,
    org: u64,
    source: u64,
}

#[derive(Default)]
struct Generations {
    global: u64,
    policy: u64,
    /// Bounded by the organizations and data sources that ever changed.
    orgs: HashMap<String, u64>,
    sources: HashMap<String, u64>,
}

/// One kept answer.
struct Entry {
    body: Arc<Vec<u8>>,
    /// What the answer held in memory when it was read, counted as the response budget counts
    /// it (`held_size`); a hit is charged at least this.
    held: usize,
    org_id: Arc<str>,
    /// `org/user`: whose answer it is, for the share of one person.
    user_key: Arc<str>,
    stamp: Stamp,
    stored_ms: i64,
    expires_ms: i64,
    /// Its place in the use order (`Inner::order` and its organization's and person's).
    tick: u64,
}

impl Entry {
    /// The memory it holds, counted generously: the answer's buffer and a fixed share for the
    /// key, the maps and the allocator, which is more than they take.
    fn size(&self) -> usize {
        entry_size(self.body.capacity(), self.org_id.len() + self.user_key.len())
    }
}

fn entry_size(body: usize, ids: usize) -> usize {
    body.div_ceil(16) * 16 + ids + ENTRY_OVERHEAD
}

/// What an answer holds in memory once parsed, counted as the response budget counts an answer
/// read from its source (`frame::value_size`): 32 bytes for every value, the text of strings,
/// keys and entries of objects.
pub fn held_size(result: &QueryResult) -> usize {
    use super::frame::{map_size, string_size, value_size};
    match result {
        QueryResult::Frame { frame } => {
            frame.fields().iter().map(|f| string_size(&f.name) + f.values.iter().map(value_size).sum::<usize>()).sum()
        }
        QueryResult::Documents { documents } => documents.documents.iter().map(|d| VALUE_SIZE + d.get().len()).sum(),
        QueryResult::Graph { graph } => {
            let nodes = graph.nodes.iter().map(|n| {
                string_size(&n.id) + n.labels.iter().map(string_size).sum::<usize>() + map_size(&n.properties)
            });
            let edges = graph.edges.iter().map(|e| {
                string_size(&e.id)
                    + string_size(&e.edge_type)
                    + string_size(&e.from)
                    + string_size(&e.to)
                    + map_size(&e.properties)
            });
            nodes.chain(edges).sum()
        }
    }
}

/// The entries of one organization or one person, so neither can push out all others.
#[derive(Default)]
struct Share {
    bytes: usize,
    order: BTreeMap<u64, Key>,
}

/// Shares by organization or by person.
#[derive(Default)]
struct Shares(HashMap<Arc<str>, Share>);

impl Shares {
    fn add(&mut self, owner: &Arc<str>, tick: u64, key: Key, size: usize) {
        let share = self.0.entry(owner.clone()).or_default();
        share.order.insert(tick, key);
        share.bytes += size;
    }

    fn remove(&mut self, owner: &str, tick: u64, size: usize) {
        if let Some(share) = self.0.get_mut(owner) {
            share.order.remove(&tick);
            share.bytes -= size;
            if share.order.is_empty() {
                self.0.remove(owner);
            }
        }
    }

    fn touch(&mut self, owner: &str, old: u64, tick: u64, key: Key) {
        if let Some(share) = self.0.get_mut(owner) {
            share.order.remove(&old);
            share.order.insert(tick, key);
        }
    }

    /// The oldest entry of `owner` while its share is above `limit`.
    fn over(&self, owner: &str, limit: usize) -> Option<Key> {
        let share = self.0.get(owner)?;
        if share.bytes <= limit {
            return None;
        }
        share.order.first_key_value().map(|(_, k)| *k)
    }
}

#[derive(Default)]
struct Inner {
    entries: HashMap<Key, Entry>,
    /// Entries by their last use, oldest first.
    order: BTreeMap<u64, Key>,
    orgs: Shares,
    users: Shares,
    tick: u64,
    bytes: usize,
    /// The limit the shares were last applied for (`QueryCache::limit`).
    limit: Option<usize>,
}

impl Inner {
    fn remove(&mut self, key: &Key) {
        let Some(e) = self.entries.remove(key) else { return };
        let size = e.size();
        self.order.remove(&e.tick);
        self.bytes -= size;
        self.orgs.remove(&e.org_id, e.tick, size);
        self.users.remove(&e.user_key, e.tick, size);
    }

    /// Drops the least recently used entries until all of them fit in `limit`.
    fn fit(&mut self, limit: usize) {
        while self.bytes > limit {
            let Some(key) = self.order.first_key_value().map(|(_, k)| *k) else { break };
            self.remove(&key);
        }
    }

    /// Drops the organization's least recently used entries until its share fits in `limit`.
    fn fit_org(&mut self, org_id: &str, limit: usize) {
        while let Some(key) = self.orgs.over(org_id, limit) {
            self.remove(&key);
        }
    }

    /// The same for one person's share.
    fn fit_user(&mut self, user_key: &str, limit: usize) {
        while let Some(key) = self.users.over(user_key, limit) {
            self.remove(&key);
        }
    }

    /// Marks `key` as just used.
    fn touch(&mut self, key: &Key) {
        self.tick += 1;
        let tick = self.tick;
        let Some(e) = self.entries.get_mut(key) else { return };
        let old = std::mem::replace(&mut e.tick, tick);
        let (org, user) = (e.org_id.clone(), e.user_key.clone());
        self.order.remove(&old);
        self.order.insert(tick, *key);
        self.orgs.touch(&org, old, tick, *key);
        self.users.touch(&user, old, tick, *key);
    }
}

/// A kept answer as found, not yet read: the caller charges it against its request before it
/// parses it (`Found::parse`).
pub struct Found {
    body: Arc<Vec<u8>>,
    held: usize,
    pub info: CacheInfo,
}

impl Found {
    /// Bytes the answer takes in the cache, as kept.
    pub fn stored_bytes(&self) -> usize {
        self.body.len()
    }

    /// What a hit is charged against the request's response budget: what the answer held when
    /// it was read from its source, and at least twice its stored size for the parsed copy.
    pub fn charge(&self) -> usize {
        self.held.max(self.body.len().saturating_mul(2))
    }

    /// The answer; `None` when it no longer reads (then it is a miss).
    pub fn parse(&self) -> Option<Stored> {
        serde_json::from_slice(&self.body).ok()
    }
}

/// Counts and size, for `GET /admin/query-cache`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub entries: usize,
    pub bytes: usize,
    pub hits: u64,
    pub misses: u64,
}

/// Serializes an answer into memory, at most `cap` bytes and only while the request's budget
/// (and with it the server's in-flight pool) has room for the copy; what it drew goes back when
/// it is dropped, since the copy then belongs to the cache.
struct CappedWriter<'a> {
    buf: Vec<u8>,
    cap: usize,
    budget: &'a ResponseBudget,
    drawn: usize,
}

impl std::io::Write for CappedWriter<'_> {
    fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
        if self.buf.len() + data.len() > self.cap || !self.budget.take(data.len()) {
            return Err(std::io::Error::other("the answer is too large for the cache"));
        }
        self.drawn += data.len();
        self.buf.extend_from_slice(data);
        Ok(data.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl Drop for CappedWriter<'_> {
    fn drop(&mut self) {
        if self.drawn > 0 {
            self.budget.give_back(self.drawn);
        }
    }
}

/// See `QueryCache::bump_on_drop`.
pub struct RightsBump<'a> {
    cache: &'a QueryCache,
    org_id: Option<String>,
    armed: bool,
}

impl RightsBump<'_> {
    /// No bump: the change was refused, so no right changed (and nobody can empty an
    /// organization's cache by sending refused changes).
    pub fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for RightsBump<'_> {
    fn drop(&mut self) {
        if self.armed {
            self.cache.rights_changed(self.org_id.as_deref());
        }
    }
}

/// The cache of one server, in `DataSources`.
#[derive(Default)]
pub struct QueryCache {
    inner: Mutex<Inner>,
    generations: Mutex<Generations>,
    hits: AtomicU64,
    misses: AtomicU64,
    /// Tells the other servers on the same database about a rights change (`cluster`); unset
    /// for a single server.
    publisher: std::sync::OnceLock<crate::cluster::Publisher>,
}

impl QueryCache {
    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock_or_recover()
    }

    fn generations(&self) -> std::sync::MutexGuard<'_, Generations> {
        self.generations.lock_or_recover()
    }

    /// The current generations for an answer of `datasource_id` in `org_id`. Taken before a
    /// query runs: an answer is kept and served only under the stamp it was read under.
    pub fn stamp(&self, org_id: &str, datasource_id: &str) -> Stamp {
        let g = self.generations();
        Stamp {
            global: g.global,
            policy: g.policy,
            org: g.orgs.get(org_id).copied().unwrap_or(0),
            source: g.sources.get(datasource_id).copied().unwrap_or(0),
        }
    }

    /// Sends rights changes to the other servers on the same database (`cluster`).
    pub fn set_publisher(&self, publisher: crate::cluster::Publisher) {
        let _ = self.publisher.set(publisher);
    }

    /// Rights changed in an organization (`None`: on the whole server): its kept answers are no
    /// longer served, here and on the other servers on the same database.
    pub fn rights_changed(&self, org_id: Option<&str>) {
        self.rights_changed_here(org_id);
        if let Some(publish) = self.publisher.get() {
            publish(crate::cluster::Change::Rights(org_id.map(str::to_string)));
        }
    }

    /// `rights_changed` on this server only: another server reported the change.
    pub fn rights_changed_here(&self, org_id: Option<&str>) {
        let mut g = self.generations();
        match org_id {
            Some(org_id) => *g.orgs.entry(org_id.to_string()).or_default() += 1,
            None => g.global += 1,
        }
    }

    /// Bumps the rights generation of `org_id` (`None`: server-wide) when dropped: a route that
    /// changes rights holds it while it runs, so a client that goes away mid-change cannot skip
    /// it. A route that answers with an error disarms it (`RightsBump::disarm`).
    pub fn bump_on_drop(&self, org_id: Option<String>) -> RightsBump<'_> {
        RightsBump { cache: self, org_id, armed: true }
    }

    /// The target rules changed: no answer read under the old ones is served.
    pub fn policy_changed(&self) {
        self.generations().policy += 1;
    }

    /// A data source changed, went to the trash or was purged: its answers are no longer served.
    pub fn forget_datasource(&self, datasource_id: &str) {
        *self.generations().sources.entry(datasource_id.to_string()).or_default() += 1;
    }

    /// Counts a load the cache answered (`true`) or could not answer.
    pub fn count(&self, hit: bool) {
        let counter = if hit { &self.hits } else { &self.misses };
        counter.fetch_add(1, Ordering::Relaxed);
    }

    /// The kept answer of `key`, if it is younger than its TTL and was kept under `stamp` (the
    /// current one). A stale or expired entry goes.
    pub fn get(&self, key: &Key, stamp: Stamp, now_ms: i64) -> Option<Found> {
        let mut inner = self.lock();
        let entry = inner.entries.get(key)?;
        if entry.expires_ms <= now_ms || entry.stamp != stamp {
            inner.remove(key);
            return None;
        }
        let found = Found {
            body: entry.body.clone(),
            held: entry.held,
            info: CacheInfo {
                status: CacheStatus::Hit,
                age_ms: (now_ms - entry.stored_ms).max(0) as u64,
                ttl_ms: (entry.expires_ms - entry.stored_ms).max(0) as u64,
            },
        };
        inner.touch(key);
        Some(found)
    }

    /// Forgets the entry of `key` (an answer that no longer reads).
    pub fn remove(&self, key: &Key) {
        self.lock().remove(key);
    }

    /// Keeps an answer for `ttl_ms` within `limit` bytes for all entries, half of it for one
    /// organization and an eighth for one person (`owner`: organization and user). Not kept: an answer larger than a quarter of the limit (serializing stops
    /// there), one whose copy does not fit in the request's `budget`, and one read under a stamp
    /// that is no longer current. `false` when it was not kept.
    #[expect(clippy::too_many_arguments, reason = "the parts of one entry")]
    pub fn put(
        &self,
        key: Key,
        owner: (&str, &str),
        datasource_id: &str,
        stored: (&QueryResult, Option<&Vec<StepPlace>>),
        stamp: Stamp,
        now_ms: i64,
        ttl_ms: i64,
        limit: usize,
        budget: &ResponseBudget,
    ) -> bool {
        let (org_id, user_id) = owner;
        let user_key = format!("{org_id}/{user_id}");
        let entry_cap = limit / MAX_ENTRY_SHARE;
        let fixed = entry_size(0, org_id.len() + user_key.len());
        if entry_cap <= fixed || self.stamp(org_id, datasource_id) != stamp {
            return false;
        }
        let mut writer = CappedWriter { buf: Vec::new(), cap: entry_cap - fixed, budget, drawn: 0 };
        let (result, steps) = stored;
        if serde_json::to_writer(&mut writer, &StoredRef { result, steps }).is_err() {
            return false;
        }
        let mut body = std::mem::take(&mut writer.buf);
        drop(writer);
        body.shrink_to_fit();
        let entry = Entry {
            body: Arc::new(body),
            held: held_size(result),
            org_id: Arc::from(org_id),
            user_key: Arc::from(user_key.as_str()),
            stamp,
            stored_ms: now_ms,
            expires_ms: now_ms.saturating_add(ttl_ms),
            tick: 0,
        };
        let size = entry.size();
        let mut inner = self.lock();
        inner.remove(&key);
        if size > entry_cap {
            return false;
        }
        inner.fit_user(&user_key, (limit / MAX_ORG_SHARE / MAX_USER_SHARE).saturating_sub(size));
        inner.fit_org(org_id, (limit / MAX_ORG_SHARE).saturating_sub(size));
        inner.fit(limit.saturating_sub(size));
        inner.tick += 1;
        let tick = inner.tick;
        inner.order.insert(tick, key);
        inner.bytes += size;
        inner.orgs.add(&entry.org_id, tick, key, size);
        inner.users.add(&entry.user_key, tick, key, size);
        inner.entries.insert(key, Entry { tick, ..entry });
        true
    }

    /// Keeps at most `limit` bytes, half of it per organization and an eighth per person (a
    /// lowered limit takes effect at once).
    pub fn limit(&self, limit: usize) {
        let mut inner = self.lock();
        // The same limit as before: `put` kept every share within it already.
        if inner.limit == Some(limit) {
            return;
        }
        inner.limit = Some(limit);
        if inner.bytes > limit {
            inner.fit(limit);
        }
        let over = |shares: &Shares, cap: usize| -> Vec<Arc<str>> {
            shares.0.iter().filter(|(_, s)| s.bytes > cap).map(|(o, _)| o.clone()).collect()
        };
        for org in over(&inner.orgs, limit / MAX_ORG_SHARE) {
            inner.fit_org(&org, limit / MAX_ORG_SHARE);
        }
        for user in over(&inner.users, limit / MAX_ORG_SHARE / MAX_USER_SHARE) {
            inner.fit_user(&user, limit / MAX_ORG_SHARE / MAX_USER_SHARE);
        }
    }

    /// Lets go of everything (the cache was turned off or emptied).
    pub fn clear(&self) {
        let mut inner = self.lock();
        inner.entries.clear();
        inner.order.clear();
        inner.orgs.0.clear();
        inner.users.0.clear();
        inner.bytes = 0;
    }

    pub fn is_empty(&self) -> bool {
        self.lock().entries.is_empty()
    }

    pub fn stats(&self) -> Stats {
        let inner = self.lock();
        Stats {
            entries: inner.entries.len(),
            bytes: inner.bytes,
            hits: self.hits.load(Ordering::Relaxed),
            misses: self.misses.load(Ordering::Relaxed),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shapes::{Field, FieldType, Frame};
    use serde_json::json;

    fn caller<'a>(org: &'a str, user: &'a str, scope: &'a str) -> Caller<'a> {
        Caller { org_id: org, user_id: user, role: "editor", permissions: vec!["datasources:query"], scope }
    }

    fn query<'a>(vars: &'a BTreeMap<String, Value>, q: Value) -> Query<'a> {
        Query {
            datasource_id: "ds",
            version: 1,
            kind: "sqlite",
            shapes: &[Shape::Frame],
            query: canonical(&q),
            steps: Vec::new(),
            cursor: None,
            range: TimeRange { from: 0, to: 60_000 },
            interval_ms: 1_000,
            max_data_points: None,
            variables: vars,
            identifiers: None,
            max_rows: 100,
        }
    }

    fn stored(n: i64) -> QueryResult {
        let field =
            Field { name: "n".into(), field_type: FieldType::Number, unit: None, values: vec![json!(n)], labels: None };
        QueryResult::Frame { frame: Frame::new(vec![field]).unwrap() }
    }

    fn number(found: &Found) -> Value {
        let QueryResult::Frame { frame } = found.parse().unwrap().result else { panic!("a frame") };
        frame.fields()[0].values[0].clone()
    }

    /// Keeps the answer `n` under the current stamp of `org` with a roomy budget.
    fn put(cache: &QueryCache, key: Key, org: &str, n: i64, now: i64, ttl: i64, limit: usize) -> bool {
        let stamp = cache.stamp(org, "ds");
        let r = stored(n);
        // One person per key, so the share of one person does not decide these tests.
        let user = format!("u{:03}", key[0]);
        cache.put(key, (org, &user), "ds", (&r, None), stamp, now, ttl, limit, &ResponseBudget::new(1 << 30))
    }

    /// The key changes with every part of the caller's rights, so no answer crosses them.
    #[test]
    fn the_key_holds_the_permission_context() {
        let vars = BTreeMap::new();
        let q = query(&vars, json!({ "sql": "SELECT 1" }));
        let base = key(&caller("o", "u", ""), &q);
        assert_eq!(base, key(&caller("o", "u", ""), &q));
        assert_ne!(base, key(&caller("o2", "u", ""), &q), "organization");
        assert_ne!(base, key(&caller("o", "u2", ""), &q), "user");
        assert_ne!(base, key(&caller("o", "u", "ai:abc"), &q), "AI data rules");
        let mut viewer = caller("o", "u", "");
        viewer.role = "viewer";
        assert_ne!(base, key(&viewer, &q), "role");
        let mut fewer = caller("o", "u", "");
        fewer.permissions = vec![];
        assert_ne!(base, key(&fewer, &q), "permissions");
    }

    #[test]
    fn the_key_holds_everything_that_shapes_the_answer() {
        let vars = BTreeMap::from([("land".to_string(), json!("AT"))]);
        let other_vars = BTreeMap::from([("land".to_string(), json!("CH"))]);
        let c = caller("o", "u", "");
        let base = key(&c, &query(&vars, json!({ "sql": "SELECT 1", "format": "table" })));
        // Key order of the query does not matter.
        assert_eq!(base, key(&c, &query(&vars, json!({ "format": "table", "sql": "SELECT 1" }))));
        assert_ne!(base, key(&c, &query(&vars, json!({ "sql": "SELECT 2", "format": "table" }))));
        assert_ne!(base, key(&c, &query(&other_vars, json!({ "sql": "SELECT 1", "format": "table" }))));
        let variants: [fn(&mut Query<'_>); 9] = [
            |q| q.version = 2,
            |q| q.datasource_id = "other",
            |q| q.range.to += 1,
            |q| q.interval_ms = 2_000,
            |q| q.max_rows = 5,
            |q| q.max_data_points = Some(10),
            |q| q.cursor = Some("weiter"),
            |q| q.steps = vec![json!({ "type": "neighbors" })],
            |q| q.shapes = &[Shape::Graph],
        ];
        for change in variants {
            let mut q = query(&vars, json!({ "sql": "SELECT 1", "format": "table" }));
            change(&mut q);
            assert_ne!(base, key(&c, &q));
        }
    }

    #[test]
    fn moving_ranges_round_to_a_step_and_fixed_ones_stay() {
        let now = 1_800_000_123_456;
        let six_hours = 6 * 3_600_000;
        let r = TimeRange { from: now - six_hours, to: now };
        // Interval 20 s, TTL 60 s: down to 20 s, the length kept.
        let rounded = round_range(r, 20_000, 60_000, now);
        assert_eq!(rounded.to % 20_000, 0);
        assert_eq!(rounded.to - rounded.from, six_hours);
        assert!(now - rounded.to < 20_000);
        // Two loads within the step share the range.
        assert_eq!(
            rounded,
            round_range(TimeRange { from: r.from + 3_000, to: r.to + 3_000 }, 20_000, 60_000, now + 3_000)
        );
        // The step is at most the TTL and at least a second.
        assert_eq!(round_range(r, 600_000, 60_000, now).to % 60_000, 0);
        assert_eq!(round_range(r, 10, 60_000, now).to, now / 1000 * 1000);
        // A range in the past is a fixed one.
        let past = TimeRange { from: 1_000, to: now - 3_600_000 };
        assert_eq!(round_range(past, 20_000, 60_000, now), past);
    }

    #[test]
    fn answers_live_for_their_ttl() {
        let cache = QueryCache::default();
        let k = [1; 32];
        let s = cache.stamp("o", "ds");
        assert!(cache.get(&k, s, 0).is_none());
        assert!(put(&cache, k, "o", 7, 1_000, 60_000, 1 << 20));
        let found = cache.get(&k, s, 31_000).expect("a hit within the TTL");
        assert_eq!(number(&found), json!(7));
        assert_eq!((found.info.status, found.info.age_ms, found.info.ttl_ms), (CacheStatus::Hit, 30_000, 60_000));
        assert!(cache.get(&k, s, 61_000).is_none(), "expired");
        assert!(cache.is_empty(), "an expired entry goes");
        cache.count(true);
        cache.count(false);
        assert_eq!((cache.stats().hits, cache.stats().misses), (1, 1));
    }

    #[test]
    fn the_least_recently_used_answer_goes_first() {
        let cache = QueryCache::default();
        assert!(put(&cache, [1; 32], "o", 1, 0, 60_000, 1 << 20));
        let size = cache.stats().bytes;
        // Room for four entries of this size, each within a quarter of the limit; one
        // organization may use half of it, so these spread over two.
        let limit = size * 4;
        put(&cache, [2; 32], "p", 2, 0, 60_000, limit);
        put(&cache, [3; 32], "o", 3, 0, 60_000, limit);
        put(&cache, [4; 32], "p", 4, 0, 60_000, limit);
        assert_eq!(cache.stats().entries, 4);
        let s = |org| cache.stamp(org, "ds");
        // 1 was used last; 2 is now the oldest.
        assert!(cache.get(&[1; 32], s("o"), 1).is_some());
        put(&cache, [5; 32], "q", 5, 0, 60_000, limit);
        assert!(cache.get(&[2; 32], s("p"), 1).is_none(), "the least recently used went");
        assert!(cache.get(&[1; 32], s("o"), 1).is_some());
        assert!(cache.stats().bytes <= limit);
        // A lower limit takes effect at once.
        cache.limit(size);
        assert!(cache.stats().bytes <= size && cache.stats().entries <= 1);
        // An answer larger than a quarter of the limit is not kept.
        assert!(!put(&cache, [6; 32], "o", 6, 0, 60_000, size));
    }

    /// One organization fills at most half of the cache, so it cannot push all others out.
    #[test]
    fn one_organization_takes_at_most_half() {
        let cache = QueryCache::default();
        put(&cache, [0; 32], "o", 0, 0, 60_000, 1 << 20);
        let size = cache.stats().bytes;
        cache.clear();
        let limit = size * 8;
        for i in 0..4 {
            assert!(put(&cache, [i; 32], "a", i.into(), 0, 60_000, limit));
        }
        for i in 10..20 {
            assert!(put(&cache, [i; 32], "l", (i - 10).into(), 0, 60_000, limit));
        }
        for i in 0..4 {
            assert!(cache.get(&[i; 32], cache.stamp("a", "ds"), 1).is_some(), "{i} stays");
        }
        let loud = (10..20).filter(|i| cache.get(&[*i; 32], cache.stamp("l", "ds"), 1).is_some()).count();
        assert_eq!(loud, 4, "half of the limit");
    }

    /// Changes are generations: no scan, and an entry kept under another one is never served.
    #[test]
    fn rights_rules_and_sources_end_entries_without_a_scan() {
        let cache = QueryCache::default();
        put(&cache, [1; 32], "o", 1, 0, 60_000, 1 << 20);
        put(&cache, [3; 32], "p", 3, 0, 60_000, 1 << 20);
        let before = cache.stamp("o", "ds");
        cache.rights_changed(Some("o"));
        assert_ne!(cache.stamp("o", "ds"), before);
        assert!(cache.get(&[1; 32], cache.stamp("o", "ds"), 1).is_none(), "the organization's rights changed");
        assert!(cache.get(&[3; 32], cache.stamp("p", "ds"), 1).is_some(), "another organization keeps its");
        cache.forget_datasource("ds");
        assert!(cache.get(&[3; 32], cache.stamp("p", "ds"), 1).is_none(), "the source changed");
        put(&cache, [3; 32], "p", 3, 0, 60_000, 1 << 20);
        cache.policy_changed();
        assert!(cache.get(&[3; 32], cache.stamp("p", "ds"), 1).is_none(), "the target rules changed");
        put(&cache, [3; 32], "p", 3, 0, 60_000, 1 << 20);
        cache.rights_changed(None);
        assert!(cache.get(&[3; 32], cache.stamp("p", "ds"), 1).is_none(), "rights changed server-wide");
        // An answer read before a change is not kept after it.
        let stale = cache.stamp("o", "ds");
        cache.rights_changed(Some("o"));
        let budget = ResponseBudget::new(1 << 20);
        let r = stored(1);
        assert!(!cache.put([9; 32], ("o", "u"), "ds", (&r, None), stale, 0, 60_000, 1 << 20, &budget));
        cache.clear();
        assert_eq!((cache.stats().entries, cache.stats().bytes), (0, 0));
    }

    /// Small numbers take a few bytes as text but 32 each in memory: a hit is charged at least
    /// what the answer was charged when it was read from its source.
    #[test]
    fn hits_are_charged_at_least_what_the_miss_was() {
        let values: Vec<Value> = (0..20_000).map(|i| json!(i % 10)).collect();
        let miss_charge: usize = values.iter().map(super::super::frame::value_size).sum();
        let name = "n".to_string();
        let frame = Frame::new(vec![Field {
            name: name.clone(),
            field_type: FieldType::Number,
            unit: None,
            values,
            labels: None,
        }])
        .unwrap();
        let result = QueryResult::Frame { frame };
        assert!(held_size(&result) >= miss_charge + super::super::frame::string_size(&name));
        let cache = QueryCache::default();
        let stamp = cache.stamp("o", "ds");
        let budget = ResponseBudget::new(64 << 20);
        assert!(cache.put([1; 32], ("o", "u"), "ds", (&result, None), stamp, 0, 60_000, 64 << 20, &budget));
        let found = cache.get(&[1; 32], stamp, 1).unwrap();
        assert!(found.stored_bytes() * 2 < miss_charge, "the text alone would undercount");
        assert!(found.charge() >= miss_charge, "{} < {miss_charge}", found.charge());
        // A small answer is still charged twice its text.
        let small = stored(1);
        assert!(cache.put([2; 32], ("o", "u"), "ds", (&small, None), stamp, 0, 60_000, 64 << 20, &budget));
        let found = cache.get(&[2; 32], stamp, 1).unwrap();
        assert!(found.charge() >= found.stored_bytes() * 2);
    }

    /// The guard bumps when dropped, unless the change was refused.
    #[test]
    fn a_disarmed_bump_changes_nothing() {
        let cache = QueryCache::default();
        let before = cache.stamp("o", "ds");
        let mut bump = cache.bump_on_drop(Some("o".into()));
        bump.disarm();
        drop(bump);
        assert_eq!(cache.stamp("o", "ds"), before);
        drop(cache.bump_on_drop(Some("o".into())));
        assert_ne!(cache.stamp("o", "ds"), before);
        let all = cache.stamp("p", "ds");
        drop(cache.bump_on_drop(None));
        assert_ne!(cache.stamp("p", "ds"), all);
    }

    /// The same limit again is the fast path; only a changed one applies the shares.
    #[test]
    fn an_unchanged_limit_applies_nothing() {
        let cache = QueryCache::default();
        put(&cache, [0; 32], "o", 0, 0, 60_000, 1 << 20);
        cache.limit(1 << 20);
        assert_eq!(cache.lock().limit, Some(1 << 20));
        cache.limit(1 << 20);
        assert_eq!(cache.stats().entries, 1);
        cache.limit(1);
        assert_eq!((cache.stats().entries, cache.lock().limit), (0, Some(1)));
    }

    /// One person holds at most an eighth of the limit (a quarter of the organization's half),
    /// and a lowered limit applies the shares at once.
    #[test]
    fn one_person_takes_at_most_an_eighth_and_lower_limits_apply_shares() {
        let cache = QueryCache::default();
        put(&cache, [0; 32], "o", 0, 0, 60_000, 1 << 20);
        let size = cache.stats().bytes;
        cache.clear();
        let budget = ResponseBudget::new(1 << 30);
        let limit = size * 32;
        let stamp = cache.stamp("o", "ds");
        let r = stored(1);
        for i in 0..10 {
            // The same length of owner as the measured entry ("o", "u000").
            assert!(cache.put([i; 32], ("o", "u001"), "ds", (&r, None), stamp, 0, 60_000, limit, &budget));
        }
        let kept = (0..10).filter(|i| cache.get(&[*i; 32], stamp, 1).is_some()).count();
        assert_eq!(kept, 4, "an eighth of the limit");
        for i in 10..30 {
            let user = format!("u{:03}", i % 4 + 2);
            assert!(cache.put([i; 32], ("o", user.as_str()), "ds", (&r, None), stamp, 0, 60_000, limit, &budget));
        }
        // Lowered: the organization keeps at most half of the new limit.
        cache.limit(size * 4);
        assert!(cache.stats().bytes <= size * 2, "{} > {}", cache.stats().bytes, size * 2);
    }

    /// Keeping an answer copies it within the request's budget and the entry cap, and gives the
    /// copy's bytes back to the budget afterwards; a huge answer stops at the cap.
    #[test]
    fn keeping_an_answer_is_bounded() {
        let cache = QueryCache::default();
        let big = QueryResult::Frame {
            frame: Frame::new(vec![Field {
                name: "s".into(),
                field_type: FieldType::String,
                unit: None,
                values: (0..10_000).map(|i| json!(format!("Zeile {i}"))).collect(),
                labels: None,
            }])
            .unwrap(),
        };
        let stamp = cache.stamp("o", "ds");
        let budget = ResponseBudget::new(1 << 20);
        // Above a quarter of the limit: serializing stops there; the budget is whole again.
        assert!(!cache.put([1; 32], ("o", "u"), "ds", (&big, None), stamp, 0, 60_000, 64 * 1024, &budget));
        assert_eq!(budget.remaining(), 1 << 20);
        // Within the cap, but the request's budget has no room for the copy.
        let small = ResponseBudget::new(4096);
        assert!(!cache.put([1; 32], ("o", "u"), "ds", (&big, None), stamp, 0, 60_000, 64 << 20, &small));
        assert_eq!(small.remaining(), 4096);
        // With room for both it is kept, and the copy's bytes go back to the request.
        assert!(cache.put([1; 32], ("o", "u"), "ds", (&big, None), stamp, 0, 60_000, 64 << 20, &budget));
        assert_eq!(budget.remaining(), 1 << 20);
        let found = cache.get(&[1; 32], stamp, 1).unwrap();
        assert!(cache.stats().bytes > found.stored_bytes() + ENTRY_OVERHEAD - 1);
        assert!(matches!(found.parse().unwrap().result, QueryResult::Frame { .. }));
    }

    #[test]
    fn source_settings_decide_ttl() {
        assert_eq!(source_ttl_ms("postgres", &json!({})), Some(60_000));
        assert_eq!(source_ttl_ms("prometheus", &json!({})), None);
        assert_eq!(source_ttl_ms("mongodb", &json!({})), None);
        assert_eq!(source_ttl_ms("prometheus", &json!({ "cacheEnabled": true, "cacheTtlSecs": 5 })), Some(5_000));
        assert_eq!(source_ttl_ms("postgres", &json!({ "cacheEnabled": false })), None);
        assert_eq!(source_ttl_ms("postgres", &json!({ "cacheTtlSecs": 10_000_000 })), Some(86_400_000));
    }
}
