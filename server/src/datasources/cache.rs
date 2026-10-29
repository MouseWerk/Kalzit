//! The server's query cache (docs/ARCHITECTURE.md, "Query cache"): answers of read-only queries,
//! kept in memory for a time each data source sets, so a dashboard opened by the same person
//! again, or refreshed within that time, does not ask the database again.
//!
//! - **Never across rights.** The key holds the caller's organization, user, role and
//!   permissions and the caller's own scope (the AI data rules of an AI call) next to the
//!   query: what one person ran is never served to another. The routes authorize every request
//!   before the cache is asked, so losing a right ends the hits at once; a change of rights also
//!   empties the organization's entries (`routes::table`, `RouteDef::changes_rights`).
//! - **Everything that shapes the answer** is in the key: data source and its settings version
//!   (`updated_at`), kind and its shapes, the query in canonical form, graph steps, cursor, the
//!   time range (rounded, below), interval, data points, variables and which may be
//!   identifiers, and the row limit.
//! - **Rounded ranges.** A range that ends now moves with every load; both its ends go down to a
//!   step of the panel's interval (at most the TTL, at least a second), the query runs with that
//!   range, and loads within the step share the answer. Ranges in the past stay as asked.
//! - **Only answers.** Errors, timeouts and graph steps that failed are never kept.
//! - **Bounded.** One server-wide memory limit (`datasources.cache_max_bytes`); the least recently
//!   used entries go first. Entries are kept serialized, so the limit counts real bytes.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::shapes::{CacheInfo, CacheStatus, QueryResult, Shape, StepPlace, TimeRange};

/// TTL of a source that caches without its own (`cacheTtlSecs`).
pub const DEFAULT_TTL_SECS: u64 = 60;
/// The longest TTL a source may set: a day.
pub const MAX_TTL_SECS: u64 = 86_400;
/// The shortest rounding step of a moving range.
const MIN_STEP_MS: i64 = 1_000;
/// One entry takes at most this share of the limit, so one huge answer cannot empty the cache.
const MAX_ENTRY_SHARE: usize = 4;
/// Bytes an entry holds besides its answer (key, ids, bookkeeping), estimated.
const ENTRY_OVERHEAD: usize = 160;

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

/// One kept answer.
struct Entry {
    body: std::sync::Arc<[u8]>,
    org_id: String,
    datasource_id: String,
    stored_ms: i64,
    expires_ms: i64,
    /// Its place in the use order (`Inner::order`).
    tick: u64,
}

impl Entry {
    fn size(&self) -> usize {
        self.body.len() + self.org_id.len() + self.datasource_id.len() + ENTRY_OVERHEAD
    }
}

#[derive(Default)]
struct Inner {
    entries: HashMap<Key, Entry>,
    /// Entries by their last use, oldest first.
    order: BTreeMap<u64, Key>,
    tick: u64,
    bytes: usize,
}

impl Inner {
    fn remove(&mut self, key: &Key) {
        if let Some(e) = self.entries.remove(key) {
            self.order.remove(&e.tick);
            self.bytes -= e.size();
        }
    }

    fn retain(&mut self, keep: impl Fn(&Entry) -> bool) {
        let gone: Vec<Key> = self.entries.iter().filter(|(_, e)| !keep(e)).map(|(k, _)| *k).collect();
        for key in gone {
            self.remove(&key);
        }
    }

    /// Drops the least recently used entries until `bytes` fits.
    fn fit(&mut self, limit: usize) {
        while self.bytes > limit {
            let Some((_, key)) = self.order.pop_first() else { break };
            if let Some(e) = self.entries.remove(&key) {
                self.bytes -= e.size();
            }
        }
    }
}

/// A hit: the kept answer and how old it is.
pub struct Hit {
    pub stored: Stored,
    pub info: CacheInfo,
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

/// The cache of one server, in `DataSources`.
#[derive(Default)]
pub struct QueryCache {
    inner: Mutex<Inner>,
    hits: AtomicU64,
    misses: AtomicU64,
}

impl QueryCache {
    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The kept answer of `key`, if it is younger than its TTL. Counts a hit or a miss.
    pub fn get(&self, key: &Key, now_ms: i64) -> Option<Hit> {
        let found = {
            let mut inner = self.lock();
            let fresh = inner.entries.get(key).map(|e| e.expires_ms > now_ms);
            match fresh {
                Some(true) => {
                    inner.tick += 1;
                    let tick = inner.tick;
                    let e = inner.entries.get_mut(key).expect("the entry was just found");
                    let old = std::mem::replace(&mut e.tick, tick);
                    let found = (e.body.clone(), e.stored_ms, e.expires_ms);
                    inner.order.remove(&old);
                    inner.order.insert(tick, *key);
                    Some(found)
                }
                Some(false) => {
                    inner.remove(key);
                    None
                }
                None => None,
            }
        };
        // Parsed outside the lock; an entry that no longer parses is a miss and goes.
        let hit = found.and_then(|(body, stored_ms, expires_ms)| {
            let stored = serde_json::from_slice::<Stored>(&body).ok();
            if stored.is_none() {
                self.lock().remove(key);
            }
            stored.map(|stored| Hit {
                stored,
                info: CacheInfo {
                    status: CacheStatus::Hit,
                    age_ms: (now_ms - stored_ms).max(0) as u64,
                    ttl_ms: (expires_ms - stored_ms).max(0) as u64,
                },
            })
        });
        let counter = if hit.is_some() { &self.hits } else { &self.misses };
        counter.fetch_add(1, Ordering::Relaxed);
        hit
    }

    /// Keeps an answer for `ttl_ms` within `limit` bytes for all entries; an answer larger than a
    /// quarter of the limit is not kept. `false` when it was not kept.
    #[expect(clippy::too_many_arguments, reason = "the parts of one entry")]
    pub fn put(
        &self,
        key: Key,
        org_id: &str,
        datasource_id: &str,
        result: &QueryResult,
        steps: Option<&Vec<StepPlace>>,
        now_ms: i64,
        ttl_ms: i64,
        limit: usize,
    ) -> bool {
        let Ok(body) = serde_json::to_vec(&StoredRef { result, steps }) else { return false };
        let entry = Entry {
            body: body.into(),
            org_id: org_id.to_string(),
            datasource_id: datasource_id.to_string(),
            stored_ms: now_ms,
            expires_ms: now_ms.saturating_add(ttl_ms),
            tick: 0,
        };
        let size = entry.size();
        let mut inner = self.lock();
        inner.remove(&key);
        if size > limit / MAX_ENTRY_SHARE {
            return false;
        }
        inner.fit(limit.saturating_sub(size));
        inner.tick += 1;
        let tick = inner.tick;
        inner.order.insert(tick, key);
        inner.bytes += size;
        inner.entries.insert(key, Entry { tick, ..entry });
        true
    }

    /// Keeps at most `limit` bytes (a lowered limit takes effect at once).
    pub fn limit(&self, limit: usize) {
        let mut inner = self.lock();
        if inner.bytes > limit {
            inner.fit(limit);
        }
    }

    /// Forgets every answer of a data source (changed, trashed or purged).
    pub fn forget_datasource(&self, datasource_id: &str) {
        self.lock().retain(|e| e.datasource_id != datasource_id);
    }

    /// Forgets every answer of an organization (its rights changed).
    pub fn forget_org(&self, org_id: &str) {
        self.lock().retain(|e| e.org_id != org_id);
    }

    /// Forgets everything (the cache was turned off or emptied, or rights changed server-wide).
    pub fn clear(&self) {
        let mut inner = self.lock();
        inner.entries.clear();
        inner.order.clear();
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

    fn number(hit: &Hit) -> Value {
        let QueryResult::Frame { frame } = &hit.stored.result else { panic!("a frame") };
        frame.fields()[0].values[0].clone()
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
        assert!(cache.get(&k, 0).is_none());
        assert!(cache.put(k, "o", "ds", &stored(7), None, 1_000, 60_000, 1 << 20));
        let hit = cache.get(&k, 31_000).expect("a hit within the TTL");
        assert_eq!(number(&hit), json!(7));
        assert_eq!((hit.info.status, hit.info.age_ms, hit.info.ttl_ms), (CacheStatus::Hit, 30_000, 60_000));
        assert!(cache.get(&k, 61_000).is_none(), "expired");
        assert!(cache.is_empty(), "an expired entry goes");
        assert_eq!(cache.stats().hits, 1);
        assert_eq!(cache.stats().misses, 2);
    }

    #[test]
    fn the_least_recently_used_answer_goes_first() {
        let cache = QueryCache::default();
        let one = cache.put([1; 32], "o", "ds", &stored(1), None, 0, 60_000, 1 << 20);
        assert!(one);
        let size = cache.stats().bytes;
        // Room for exactly three entries of this size (and each within a quarter of the limit
        // only when the limit is at least four of them).
        let limit = size * 4;
        cache.put([2; 32], "o", "ds", &stored(2), None, 0, 60_000, limit);
        cache.put([3; 32], "o", "ds", &stored(3), None, 0, 60_000, limit);
        cache.put([4; 32], "o", "ds", &stored(4), None, 0, 60_000, limit);
        assert_eq!(cache.stats().entries, 4);
        // 1 was used last; 2 is now the oldest.
        assert!(cache.get(&[1; 32], 1).is_some());
        cache.put([5; 32], "o", "ds", &stored(5), None, 0, 60_000, limit);
        assert!(cache.get(&[2; 32], 1).is_none(), "the least recently used went");
        assert!(cache.get(&[1; 32], 1).is_some());
        assert!(cache.stats().bytes <= limit);
        // A lower limit takes effect at once.
        cache.limit(size);
        assert_eq!(cache.stats().entries, 1);
        // An answer larger than a quarter of the limit is not kept.
        assert!(!cache.put([6; 32], "o", "ds", &stored(6), None, 0, 60_000, size));
    }

    #[test]
    fn sources_and_organizations_are_forgotten() {
        let cache = QueryCache::default();
        cache.put([1; 32], "o", "a", &stored(1), None, 0, 60_000, 1 << 20);
        cache.put([2; 32], "o", "b", &stored(2), None, 0, 60_000, 1 << 20);
        cache.put([3; 32], "p", "c", &stored(3), None, 0, 60_000, 1 << 20);
        cache.forget_datasource("a");
        assert!(cache.get(&[1; 32], 1).is_none());
        assert!(cache.get(&[2; 32], 1).is_some());
        cache.forget_org("o");
        assert!(cache.get(&[2; 32], 1).is_none());
        assert!(cache.get(&[3; 32], 1).is_some());
        cache.clear();
        assert_eq!(cache.stats().entries, 0);
        assert_eq!(cache.stats().bytes, 0);
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
