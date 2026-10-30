//! Usage insights (docs/api/usage.md, docs/ARCHITECTURE.md "Usage insights"): how often
//! dashboards are opened and how often, how slowly and how reliably panels and data sources
//! answer, in hourly buckets per organization and dashboard, panel or data source.
//!
//! **Never per person.** A recorded event carries an organization, a dashboard, panel or data
//! source id and numbers; no user, session or client address reaches this module, and the tables
//! have no column for one (a test pins their columns).
//!
//! Recording costs the query path a lock on an in-memory map: events are added to the counts of
//! their bucket there (`Usage::add`), and a background task writes the counts every
//! `FLUSH_EVERY` (`flush`), adding them to the stored rows in transactions of at most
//! `FLUSH_CHUNK` buckets, so no write holds the database's write lock for long. The map holds at
//! most `MAX_KEYS` buckets; an event for a new bucket while it is full is dropped and counted
//! (`Usage::dropped`). A chunk that fails before its commit goes back to the map for the next
//! write; one whose commit failed is dropped and counted instead, since it may have been saved
//! and must not be added twice.
//! Every server instance flushes its own counts, so the flush is per instance; the retention job
//! (`spawn_retention`) is idempotent and may run on one instance only.

pub mod report;

use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use sqlx::AnyPool;

use crate::app::AppState;
use crate::shapes::{CacheStatus, QueryOutcome, QueryResponse, QueryResult};

pub const HOUR_MS: i64 = 3_600_000;
pub const DAY_MS: i64 = 24 * HOUR_MS;

/// The upper bounds (inclusive, ms) of the duration ranges `d0` to `d11`; `d12` is everything
/// above the last.
pub const DURATION_BOUNDS_MS: [i64; 12] = [5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000];
/// Duration ranges per row.
pub const RANGES: usize = DURATION_BOUNDS_MS.len() + 1;

/// Buckets the in-memory map holds between two writes. One bucket is one hour of one dashboard,
/// panel or data source; a busy server opens a few hundred per hour.
pub const MAX_KEYS: usize = 20_000;

/// How often the counts are written.
pub const FLUSH_EVERY: Duration = Duration::from_secs(15);

/// Buckets written per transaction.
pub const FLUSH_CHUNK: usize = 500;

/// The setting that turns recording on and off.
pub const ENABLED_SETTING: &str = "usage.enabled";
/// Days the buckets are kept.
pub const RETENTION_SETTING: &str = "usage.retention_days";
/// The longest retention, also the default (owner decision: usage is kept 90 days).
pub const MAX_RETENTION_DAYS: i64 = 90;

/// The start of the hour `at_ms` falls in.
pub fn bucket_of(at_ms: i64) -> i64 {
    at_ms - at_ms.rem_euclid(HOUR_MS)
}

/// The duration range of `ms`.
pub fn range_of(ms: i64) -> usize {
    DURATION_BOUNDS_MS.iter().position(|&upper| ms <= upper).unwrap_or(RANGES - 1)
}

/// Estimates the `q` quantile (0 to 1) of durations counted in `ranges`, interpolating inside the
/// range it falls in; never above `max_ms`, the longest one counted. `None` without durations.
pub fn quantile(ranges: &[i64; RANGES], max_ms: i64, q: f64) -> Option<i64> {
    let total: i64 = ranges.iter().sum();
    if total <= 0 {
        return None;
    }
    let rank = q.clamp(0.0, 1.0) * total as f64;
    let mut seen = 0i64;
    for (i, &n) in ranges.iter().enumerate() {
        if n <= 0 {
            continue;
        }
        if (seen + n) as f64 >= rank {
            let lower = if i == 0 { 0 } else { DURATION_BOUNDS_MS[i - 1] };
            let upper = DURATION_BOUNDS_MS.get(i).copied().unwrap_or(i64::MAX).min(max_ms.max(lower));
            let within = ((rank - seen as f64) / n as f64).clamp(0.0, 1.0);
            return Some(lower + ((upper - lower) as f64 * within).round() as i64);
        }
        seen += n;
    }
    Some(max_ms)
}

/// Whether a run used the query cache and how.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Cache {
    /// The cache had no part (off, not used for this source or route, or an error).
    NotUsed,
    /// Answered from the cache.
    Hit,
    /// Ran in the source while the cache was in use (also a refresh).
    Miss,
}

/// The class of a failed query, from its error code.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ErrorClass {
    /// `query_timeout`.
    Timeout,
    /// `query_rejected`: the query was refused before it ran (read-only checks).
    Rejected,
    /// `datasource_error`, `datasource_target_blocked`: the source failed or may not be reached.
    Source,
    /// Anything else that failed while running (internal, limits).
    Other,
}

/// Whether an error code means a query was asked of its source and failed there. `validation`
/// and `not_found` mean the request was refused before anything ran (a wrong variable, an unknown
/// or trashed source), `busy` and `internal` that Kalzit itself could not run it (its database
/// was busy, a fault of its own): such answers are not counted as queries of the source.
pub fn ran(code: &str) -> bool {
    !matches!(code, "validation" | "not_found" | "busy" | "internal")
}

/// Whether an error code makes a panel run a failed one: anything but `validation` (a wrong
/// variable or range of the request). A stored query whose data source was trashed or deleted
/// answers `not_found`, and the panel failed for whoever looked at it.
pub fn fails_panel(code: &str) -> bool {
    code != "validation"
}

impl ErrorClass {
    pub fn of(code: &str) -> Self {
        match code {
            "query_timeout" => Self::Timeout,
            "query_rejected" => Self::Rejected,
            "datasource_error" | "datasource_target_blocked" => Self::Source,
            _ => Self::Other,
        }
    }
}

/// A panel's stored queries, run once from its dashboard.
#[derive(Clone, Copy, Debug)]
pub struct PanelRun {
    pub duration_ms: i64,
    pub rows: i64,
    pub error: bool,
    pub cache: Cache,
}

impl PanelRun {
    /// The run of a whole panel request: an error when one of its queries failed
    /// (`fails_panel`; an item refused as invalid is no error of the panel), a hit when
    /// every answer came from the cache, a miss when one of them ran in its source with the cache
    /// in use.
    pub fn of(response: &QueryResponse, duration_ms: i64) -> Self {
        let mut run = Self { duration_ms, rows: 0, error: false, cache: Cache::NotUsed };
        let mut hits = 0usize;
        let mut misses = 0usize;
        for outcome in response.results.values() {
            match outcome {
                QueryOutcome::Ok { result, cache, .. } => {
                    run.rows += rows_of(result);
                    match cache.as_ref().map(|c| c.status) {
                        Some(CacheStatus::Hit) => hits += 1,
                        Some(CacheStatus::Miss | CacheStatus::Refresh) => misses += 1,
                        None => {}
                    }
                }
                QueryOutcome::Err { error } => run.error |= fails_panel(&error.code),
            }
        }
        run.cache = if misses > 0 {
            Cache::Miss
        } else if hits > 0 && hits == response.results.len() {
            Cache::Hit
        } else {
            Cache::NotUsed
        };
        run
    }
}

/// One query asked of a data source.
#[derive(Clone, Copy, Debug)]
pub struct SourceQuery {
    pub duration_ms: i64,
    pub rows: i64,
    pub error: Option<ErrorClass>,
    pub cache: Cache,
}

impl SourceQuery {
    pub fn of(outcome: &QueryOutcome, duration_ms: i64) -> Self {
        match outcome {
            QueryOutcome::Ok { result, cache, .. } => Self {
                duration_ms,
                rows: rows_of(result),
                error: None,
                cache: match cache.as_ref().map(|c| c.status) {
                    Some(CacheStatus::Hit) => Cache::Hit,
                    Some(CacheStatus::Miss | CacheStatus::Refresh) => Cache::Miss,
                    None => Cache::NotUsed,
                },
            },
            QueryOutcome::Err { error } => {
                Self { duration_ms, rows: 0, error: Some(ErrorClass::of(&error.code)), cache: Cache::NotUsed }
            }
        }
    }
}

/// Rows of a result: frame rows, documents, or nodes and edges.
pub fn rows_of(result: &QueryResult) -> i64 {
    let n = match result {
        QueryResult::Frame { frame } => frame.rows(),
        QueryResult::Documents { documents } => documents.documents.len(),
        QueryResult::Graph { graph } => graph.nodes.len() + graph.edges.len(),
    };
    i64::try_from(n).unwrap_or(i64::MAX)
}

/// What a bucket counts. `Hash` keys hold ids only.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Key {
    View { bucket: i64, org_id: String, dashboard_id: String },
    Panel { bucket: i64, org_id: String, dashboard_id: String, panel_id: String },
    Source { bucket: i64, org_id: String, datasource_id: String },
}

/// The counts of one bucket; a view uses `count` alone.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Counts {
    /// Views, panel runs or queries.
    pub count: i64,
    pub errors: i64,
    pub errors_timeout: i64,
    pub errors_rejected: i64,
    pub errors_source: i64,
    pub errors_other: i64,
    pub cache_hits: i64,
    pub cache_misses: i64,
    pub rows: i64,
    pub duration_sum_ms: i64,
    pub duration_max_ms: i64,
    pub ranges: [i64; RANGES],
}

impl Counts {
    fn duration(&mut self, ms: i64) {
        let ms = ms.max(0);
        self.duration_sum_ms = self.duration_sum_ms.saturating_add(ms);
        self.duration_max_ms = self.duration_max_ms.max(ms);
        self.ranges[range_of(ms)] += 1;
    }

    fn cache(&mut self, cache: Cache) {
        match cache {
            Cache::Hit => self.cache_hits += 1,
            Cache::Miss => self.cache_misses += 1,
            Cache::NotUsed => {}
        }
    }

    /// Adds `other` (the counts of the same bucket from another batch).
    pub fn merge(&mut self, other: &Counts) {
        self.count += other.count;
        self.errors += other.errors;
        self.errors_timeout += other.errors_timeout;
        self.errors_rejected += other.errors_rejected;
        self.errors_source += other.errors_source;
        self.errors_other += other.errors_other;
        self.cache_hits += other.cache_hits;
        self.cache_misses += other.cache_misses;
        self.rows = self.rows.saturating_add(other.rows);
        self.duration_sum_ms = self.duration_sum_ms.saturating_add(other.duration_sum_ms);
        self.duration_max_ms = self.duration_max_ms.max(other.duration_max_ms);
        for (mine, theirs) in self.ranges.iter_mut().zip(other.ranges) {
            *mine += theirs;
        }
    }
}

/// The counts not yet written, and what was dropped.
pub struct Usage {
    pending: Mutex<HashMap<Key, Counts>>,
    max_keys: usize,
    dropped: AtomicU64,
}

impl Default for Usage {
    fn default() -> Self {
        Self::with_capacity(MAX_KEYS)
    }
}

impl Usage {
    /// A map of at most `max_keys` buckets (tests make it small).
    pub fn with_capacity(max_keys: usize) -> Self {
        Self { pending: Mutex::new(HashMap::new()), max_keys, dropped: AtomicU64::new(0) }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<Key, Counts>> {
        // The map holds counts only; one a panic left half-updated is still usable.
        self.pending.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Adds an event to its bucket; drops it, counted, when the map is full and the bucket new.
    pub fn add(&self, key: Key, event: impl FnOnce(&mut Counts)) {
        let mut pending = self.lock();
        let full = pending.len() >= self.max_keys;
        match pending.get_mut(&key) {
            Some(counts) => event(counts),
            None if full => {
                self.dropped.fetch_add(1, Ordering::Relaxed);
            }
            None => event(pending.entry(key).or_default()),
        }
    }

    pub fn view(&self, at_ms: i64, org_id: &str, dashboard_id: &str) {
        let key = Key::View { bucket: bucket_of(at_ms), org_id: org_id.into(), dashboard_id: dashboard_id.into() };
        self.add(key, |c| c.count += 1);
    }

    pub fn panel(&self, at_ms: i64, org_id: &str, dashboard_id: &str, panel_id: &str, run: PanelRun) {
        let key = Key::Panel {
            bucket: bucket_of(at_ms),
            org_id: org_id.into(),
            dashboard_id: dashboard_id.into(),
            panel_id: panel_id.into(),
        };
        self.add(key, |c| {
            c.count += 1;
            c.errors += i64::from(run.error);
            c.cache(run.cache);
            c.rows = c.rows.saturating_add(run.rows);
            c.duration(run.duration_ms);
        });
    }

    pub fn source(&self, at_ms: i64, org_id: &str, datasource_id: &str, query: SourceQuery) {
        let key = Key::Source { bucket: bucket_of(at_ms), org_id: org_id.into(), datasource_id: datasource_id.into() };
        self.add(key, |c| {
            c.count += 1;
            c.cache(query.cache);
            if let Some(class) = query.error {
                c.errors += 1;
                match class {
                    ErrorClass::Timeout => c.errors_timeout += 1,
                    ErrorClass::Rejected => c.errors_rejected += 1,
                    ErrorClass::Source => c.errors_source += 1,
                    ErrorClass::Other => c.errors_other += 1,
                }
            }
            // A cache hit did not reach the source: its time and rows are not the source's.
            if query.cache != Cache::Hit {
                c.rows = c.rows.saturating_add(query.rows);
                c.duration(query.duration_ms);
            }
        });
    }

    /// Takes every pending bucket, for a write.
    pub fn take(&self) -> HashMap<Key, Counts> {
        std::mem::take(&mut *self.lock())
    }

    /// Puts back the buckets of a write that failed, merged with what arrived meanwhile. Buckets
    /// beyond the map's size are dropped, and their events counted once (`lose`).
    pub fn put_back(&self, batch: impl IntoIterator<Item = (Key, Counts)>) {
        let mut pending = self.lock();
        for (key, counts) in batch {
            if let Some(mine) = pending.get_mut(&key) {
                mine.merge(&counts);
            } else if pending.len() < self.max_keys {
                pending.insert(key, counts);
            } else {
                self.lose(&counts);
            }
        }
    }

    /// Counts the events of a bucket that will not be written.
    fn lose(&self, counts: &Counts) {
        self.dropped.fetch_add(u64::try_from(counts.count).unwrap_or(0), Ordering::Relaxed);
    }

    /// Buckets waiting for the next write.
    pub fn pending(&self) -> usize {
        self.lock().len()
    }

    /// Events dropped since the server started, because the map was full.
    pub fn dropped(&self) -> u64 {
        self.dropped.load(Ordering::Relaxed)
    }
}

/// Whether recording is on (`usage.enabled`); on when the setting cannot be read.
pub async fn enabled(state: &AppState) -> bool {
    match crate::settings::get(state, ENABLED_SETTING).await {
        Ok(v) => v.as_bool().unwrap_or(true),
        Err(e) => {
            tracing::debug!("usage recording setting: {}", e.message);
            true
        }
    }
}

/// Records that a dashboard was opened, when recording is on.
pub async fn record_view(state: &AppState, org_id: &str, dashboard_id: &str) {
    if enabled(state).await {
        state.usage.view(state.clock.now_ms(), org_id, dashboard_id);
    }
}

/// Records a run of a panel's stored queries from its dashboard, when recording is on.
pub async fn record_panel(state: &AppState, org_id: &str, dashboard_id: &str, panel_id: &str, run: PanelRun) {
    if enabled(state).await {
        state.usage.panel(state.clock.now_ms(), org_id, dashboard_id, panel_id, run);
    }
}

/// Records a query asked of a data source, when recording is on.
pub async fn record_query(state: &AppState, org_id: &str, datasource_id: &str, query: SourceQuery) {
    if enabled(state).await {
        state.usage.source(state.clock.now_ms(), org_id, datasource_id, query);
    }
}

/// The columns of `usage_panel_runs` and `usage_source_queries` after their key, in the order
/// `values` binds them.
const PANEL_COLUMNS: &[&str] =
    &["runs", "errors", "cache_hits", "cache_misses", "result_rows", "duration_sum_ms", "duration_max_ms"];
const SOURCE_COLUMNS: &[&str] = &[
    "queries",
    "errors",
    "errors_timeout",
    "errors_rejected",
    "errors_source",
    "errors_other",
    "cache_hits",
    "cache_misses",
    "result_rows",
    "duration_sum_ms",
    "duration_max_ms",
];

fn range_columns() -> impl Iterator<Item = String> {
    (0..RANGES).map(|i| format!("d{i}"))
}

/// An upsert that adds the batch's counts to the stored row (the longest duration is the larger
/// one), for an organization that still exists. `$2` is the organization.
fn upsert_sql(table: &str, keys: &[&str], columns: &[&str]) -> String {
    let all: Vec<String> = keys.iter().chain(columns).map(|c| c.to_string()).chain(range_columns()).collect();
    let params: Vec<String> = (1..=all.len()).map(|i| format!("${i}")).collect();
    let sets: Vec<String> = columns
        .iter()
        .map(|c| c.to_string())
        .chain(range_columns())
        .map(|c| {
            if c == "duration_max_ms" {
                format!("{c} = CASE WHEN excluded.{c} > {table}.{c} THEN excluded.{c} ELSE {table}.{c} END")
            } else {
                format!("{c} = {table}.{c} + excluded.{c}")
            }
        })
        .collect();
    format!(
        "INSERT INTO {table} ({}) SELECT {} WHERE EXISTS (SELECT 1 FROM orgs WHERE id = $2) \
         ON CONFLICT ({}) DO UPDATE SET {}",
        all.join(", "),
        params.join(", "),
        keys.join(", "),
        sets.join(", ")
    )
}

/// How a chunk's write failed.
enum WriteError {
    /// Before the commit: nothing of the chunk was saved.
    Before(sqlx::Error),
    /// The commit itself: the chunk may or may not be saved.
    Commit(sqlx::Error),
}

/// Writes every pending bucket through `db`, adding to the stored rows, `FLUSH_CHUNK` buckets per
/// transaction. Answers the number of buckets written. On an error the chunks not yet written go
/// back to the map for the next write (a chunk whose commit failed is dropped and counted, never
/// written twice), and the error is returned.
pub async fn flush(usage: &Usage, db: &AnyPool) -> Result<usize, sqlx::Error> {
    flush_in(usage, db, FLUSH_CHUNK).await
}

async fn flush_in(usage: &Usage, db: &AnyPool, chunk: usize) -> Result<usize, sqlx::Error> {
    let mut batch: Vec<(Key, Counts)> = usage.take().into_iter().collect();
    let mut written = 0;
    while !batch.is_empty() {
        let rest = batch.split_off(chunk.max(1).min(batch.len()));
        match write(db, &batch).await {
            Ok(()) => written += batch.len(),
            Err(WriteError::Before(e)) => {
                usage.put_back(batch.into_iter().chain(rest));
                return Err(e);
            }
            Err(WriteError::Commit(e)) => {
                for (_, counts) in &batch {
                    usage.lose(counts);
                }
                usage.put_back(rest);
                return Err(e);
            }
        }
        batch = rest;
    }
    Ok(written)
}

async fn write(db: &AnyPool, batch: &[(Key, Counts)]) -> Result<(), WriteError> {
    write_rows(db, batch).await.map_err(WriteError::Before)?.commit().await
}

/// A transaction holding the chunk's upserts, ready to commit.
struct Written(sqlx::Transaction<'static, sqlx::Any>);

impl Written {
    async fn commit(self) -> Result<(), WriteError> {
        crate::db::commit(self.0).await.map_err(WriteError::Commit)
    }
}

async fn write_rows(db: &AnyPool, batch: &[(Key, Counts)]) -> Result<Written, sqlx::Error> {
    let views = "INSERT INTO usage_dashboard_views (bucket, org_id, dashboard_id, views) \
                 SELECT $1, $2, $3, $4 WHERE EXISTS (SELECT 1 FROM orgs WHERE id = $2) \
                 ON CONFLICT (bucket, org_id, dashboard_id) DO UPDATE SET views = usage_dashboard_views.views + excluded.views";
    let panels = upsert_sql("usage_panel_runs", &["bucket", "org_id", "dashboard_id", "panel_id"], PANEL_COLUMNS);
    let sources = upsert_sql("usage_source_queries", &["bucket", "org_id", "datasource_id"], SOURCE_COLUMNS);
    let mut tx = crate::db::begin(db).await?;
    for (key, c) in batch {
        match key {
            Key::View { bucket, org_id, dashboard_id } => {
                sqlx::query(views).bind(bucket).bind(org_id).bind(dashboard_id).bind(c.count).execute(&mut *tx).await?;
            }
            Key::Panel { bucket, org_id, dashboard_id, panel_id } => {
                let mut q = sqlx::query(sqlx::AssertSqlSafe(panels.as_str()))
                    .bind(bucket)
                    .bind(org_id)
                    .bind(dashboard_id)
                    .bind(panel_id)
                    .bind(c.count)
                    .bind(c.errors)
                    .bind(c.cache_hits)
                    .bind(c.cache_misses)
                    .bind(c.rows)
                    .bind(c.duration_sum_ms)
                    .bind(c.duration_max_ms);
                for n in c.ranges {
                    q = q.bind(n);
                }
                q.execute(&mut *tx).await?;
            }
            Key::Source { bucket, org_id, datasource_id } => {
                let mut q = sqlx::query(sqlx::AssertSqlSafe(sources.as_str()))
                    .bind(bucket)
                    .bind(org_id)
                    .bind(datasource_id)
                    .bind(c.count)
                    .bind(c.errors)
                    .bind(c.errors_timeout)
                    .bind(c.errors_rejected)
                    .bind(c.errors_source)
                    .bind(c.errors_other)
                    .bind(c.cache_hits)
                    .bind(c.cache_misses)
                    .bind(c.rows)
                    .bind(c.duration_sum_ms)
                    .bind(c.duration_max_ms);
                for n in c.ranges {
                    q = q.bind(n);
                }
                q.execute(&mut *tx).await?;
            }
        }
    }
    Ok(Written(tx))
}

/// Writes the counts every `FLUSH_EVERY` through the background pool, and once more when the
/// server stops. Runs on every instance: each writes its own counts.
pub fn spawn_flusher(state: AppState) {
    spawn_flusher_every(state, FLUSH_EVERY);
}

/// `spawn_flusher` with another interval (tests).
pub fn spawn_flusher_every(state: AppState, every: Duration) {
    let stopping = state.background.stopping();
    let background = state.background.clone();
    background.spawn(async move {
        let mut tick = tokio::time::interval(every);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            let last = tokio::select! {
                () = stopping.cancelled() => true,
                _ = tick.tick() => false,
            };
            match flush(&state.usage, state.background.db()).await {
                Ok(_) => {}
                Err(e) if crate::error::is_contention(&e) => {
                    tracing::debug!("writing usage counts: the database is busy, next try in {every:?}: {e}");
                }
                Err(e) => tracing::warn!("writing usage counts failed, next try in {every:?}: {e}"),
            }
            if last {
                return;
            }
        }
    });
}

/// The retention in days (`usage.retention_days`).
pub async fn retention_days(state: &AppState) -> i64 {
    match crate::settings::get(state, RETENTION_SETTING).await {
        Ok(v) => v.as_i64().unwrap_or(MAX_RETENTION_DAYS).clamp(1, MAX_RETENTION_DAYS),
        Err(_) => 90,
    }
}

/// Deletes buckets older than `days` before `now_ms` through `db`, one hour of one table per
/// statement, so a large backlog never holds the write lock for long. Idempotent. Answers the
/// rows deleted.
pub async fn purge(db: &AnyPool, now_ms: i64, days: i64) -> Result<u64, sqlx::Error> {
    let cutoff = bucket_of(now_ms) - days * DAY_MS;
    let mut total = 0;
    for table in ["usage_dashboard_views", "usage_panel_runs", "usage_source_queries"] {
        let sql = format!("DELETE FROM {table} WHERE bucket = (SELECT MIN(bucket) FROM {table}) AND bucket < $1");
        loop {
            let mut tx = crate::db::begin(db).await?;
            let n =
                sqlx::query(sqlx::AssertSqlSafe(sql.as_str())).bind(cutoff).execute(&mut *tx).await?.rows_affected();
            crate::db::commit(tx).await?;
            total += n;
            if n == 0 {
                break;
            }
        }
    }
    Ok(total)
}

/// Deletes expired buckets every hour (`purge`). Idempotent, so it may run on one instance only.
pub fn spawn_retention(state: AppState) {
    spawn_retention_on(state, crate::db::Schedule::hourly());
}

/// `spawn_retention` on another schedule (tests).
pub fn spawn_retention_on(state: AppState, schedule: crate::db::Schedule) {
    use crate::db::JobError;
    let background = state.background.clone();
    crate::db::spawn_job(&background, "deleting old usage counts", schedule, move || {
        let state = state.clone();
        async move {
            let days = retention_days(&state).await;
            match purge(state.background.db(), state.clock.now_ms(), days).await {
                Ok(0) => Ok(()),
                Ok(n) => {
                    tracing::debug!("deleted {n} usage buckets past their retention");
                    Ok(())
                }
                Err(e) if crate::error::is_contention(&e) => Err(JobError::Busy(e.to_string())),
                Err(e) => Err(JobError::Failed(e.to_string())),
            }
        }
    });
}

#[cfg(test)]
mod tests;
