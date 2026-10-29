use std::collections::BTreeMap;
use std::time::Duration;

use super::*;
use crate::shapes::{CacheInfo, ErrorBody};

const T0: i64 = 1_800_000_000_000;

fn frame(rows: usize) -> QueryResult {
    let values: Vec<i64> = (0..rows as i64).collect();
    serde_json::from_value(serde_json::json!({
        "shape": "frame",
        "frame": { "fields": [{ "name": "n", "type": "number", "values": values }] }
    }))
    .unwrap()
}

fn ok(rows: usize, cache: Option<CacheStatus>) -> QueryOutcome {
    QueryOutcome::Ok {
        result: frame(rows),
        steps: None,
        cache: cache.map(|status| CacheInfo { status, age_ms: 0, ttl_ms: 60_000 }),
    }
}

fn err(code: &str) -> QueryOutcome {
    let error: ErrorBody = serde_json::from_value(serde_json::json!({ "code": code, "message": "x" })).unwrap();
    QueryOutcome::Err { error }
}

#[test]
fn buckets_start_at_the_full_hour() {
    let hour = bucket_of(T0);
    assert_eq!(hour % HOUR_MS, 0);
    assert!(hour <= T0 && T0 < hour + HOUR_MS);
    assert_eq!(bucket_of(hour), hour);
    assert_eq!(bucket_of(hour + HOUR_MS - 1), hour);
    assert_eq!(bucket_of(hour + HOUR_MS), hour + HOUR_MS);
}

#[test]
fn durations_fall_into_their_range() {
    assert_eq!(range_of(0), 0);
    assert_eq!(range_of(5), 0);
    assert_eq!(range_of(6), 1);
    assert_eq!(range_of(1_000), 7);
    assert_eq!(range_of(30_000), 11);
    assert_eq!(range_of(30_001), 12);
    assert_eq!(range_of(i64::MAX), RANGES - 1);
}

#[test]
fn quantiles_are_estimated_within_their_range() {
    let mut ranges = [0i64; RANGES];
    assert_eq!(quantile(&ranges, 0, 0.5), None);
    // 100 runs between 100 and 250 ms (range 5): the median lies in the middle of it.
    ranges[5] = 100;
    assert_eq!(quantile(&ranges, 240, 0.5), Some(170));
    // Never above the longest one.
    assert_eq!(quantile(&ranges, 240, 1.0), Some(240));
    // 90 fast runs and 10 slow ones: the median is fast, the 95th percentile slow.
    let mut ranges = [0i64; RANGES];
    ranges[1] = 90;
    ranges[9] = 10;
    let p50 = quantile(&ranges, 4_000, 0.5).unwrap();
    let p95 = quantile(&ranges, 4_000, 0.95).unwrap();
    assert!((5..=10).contains(&p50), "{p50}");
    assert!((2_500..=4_000).contains(&p95), "{p95}");
    // Above the last bound the longest one is the upper end.
    let mut ranges = [0i64; RANGES];
    ranges[12] = 1;
    assert_eq!(quantile(&ranges, 45_000, 1.0), Some(45_000));
}

#[test]
fn error_classes_follow_the_codes() {
    assert_eq!(ErrorClass::of("query_timeout"), ErrorClass::Timeout);
    assert_eq!(ErrorClass::of("query_rejected"), ErrorClass::Rejected);
    assert_eq!(ErrorClass::of("datasource_error"), ErrorClass::Source);
    assert_eq!(ErrorClass::of("datasource_target_blocked"), ErrorClass::Source);
    assert_eq!(ErrorClass::of("validation"), ErrorClass::Other);
}

#[test]
fn a_panel_run_sums_its_queries() {
    let mut results = BTreeMap::new();
    results.insert("A".to_string(), ok(3, Some(CacheStatus::Hit)));
    results.insert("B".to_string(), ok(2, Some(CacheStatus::Hit)));
    let run = PanelRun::of(&QueryResponse { results: results.clone() }, 12);
    assert_eq!((run.rows, run.error, run.cache), (5, false, Cache::Hit));

    results.insert("C".to_string(), ok(1, Some(CacheStatus::Miss)));
    assert_eq!(PanelRun::of(&QueryResponse { results: results.clone() }, 12).cache, Cache::Miss);

    results.insert("D".to_string(), err("datasource_error"));
    let run = PanelRun::of(&QueryResponse { results: results.clone() }, 12);
    assert!(run.error);
    // Some answers from the cache and one without it is no hit.
    let mut mixed = BTreeMap::new();
    mixed.insert("A".to_string(), ok(1, Some(CacheStatus::Hit)));
    mixed.insert("B".to_string(), ok(1, None));
    assert_eq!(PanelRun::of(&QueryResponse { results: mixed }, 1).cache, Cache::NotUsed);
}

#[test]
fn source_queries_count_by_bucket_and_class() {
    let usage = Usage::default();
    let q = |outcome: &QueryOutcome, ms| SourceQuery::of(outcome, ms);
    usage.source(T0, "o1", "s1", q(&ok(10, Some(CacheStatus::Miss)), 120));
    usage.source(T0 + 1, "o1", "s1", q(&ok(10, Some(CacheStatus::Hit)), 1));
    usage.source(T0 + 2, "o1", "s1", q(&err("query_timeout"), 30_000));
    usage.source(T0 + 3, "o1", "s1", q(&err("query_rejected"), 0));
    usage.source(T0 + HOUR_MS, "o1", "s1", q(&ok(1, None), 5));
    let pending = usage.take();
    assert_eq!(pending.len(), 2);
    let c = &pending[&Key::Source { bucket: bucket_of(T0), org_id: "o1".into(), datasource_id: "s1".into() }];
    assert_eq!(c.count, 4);
    assert_eq!((c.errors, c.errors_timeout, c.errors_rejected, c.errors_source, c.errors_other), (2, 1, 1, 0, 0));
    assert_eq!((c.cache_hits, c.cache_misses), (1, 1));
    // The hit did not reach the source: its rows and time are not counted.
    assert_eq!(c.rows, 10);
    assert_eq!(c.ranges.iter().sum::<i64>(), 3);
    assert_eq!(c.duration_max_ms, 30_000);
    assert_eq!(c.duration_sum_ms, 30_120);
    assert_eq!(usage.pending(), 0);
}

#[test]
fn a_full_buffer_drops_new_buckets_and_counts_them() {
    let usage = Usage::with_capacity(2);
    usage.view(T0, "o1", "d1");
    usage.view(T0, "o1", "d2");
    usage.view(T0, "o1", "d3");
    usage.view(T0, "o1", "d3");
    // A bucket already there still counts.
    usage.view(T0, "o1", "d1");
    assert_eq!(usage.dropped(), 2);
    let pending = usage.take();
    assert_eq!(pending.len(), 2);
    assert_eq!(pending[&Key::View { bucket: bucket_of(T0), org_id: "o1".into(), dashboard_id: "d1".into() }].count, 2);
}

#[test]
fn put_back_merges_with_new_counts() {
    let usage = Usage::with_capacity(2);
    usage.view(T0, "o1", "d1");
    let batch = usage.take();
    usage.view(T0, "o1", "d1");
    usage.view(T0, "o1", "d2");
    let mut more = batch.clone();
    more.insert(
        Key::View { bucket: bucket_of(T0), org_id: "o1".into(), dashboard_id: "d9".into() },
        Counts { count: 4, ..Default::default() },
    );
    usage.put_back(more);
    let pending = usage.take();
    assert_eq!(pending[&Key::View { bucket: bucket_of(T0), org_id: "o1".into(), dashboard_id: "d1".into() }].count, 2);
    // No room for d9: its four views are dropped and counted.
    assert_eq!(pending.len(), 2);
    assert_eq!(usage.dropped(), 4);
}

async fn database() -> (tempfile::TempDir, AnyPool) {
    let dir = tempfile::tempdir().unwrap();
    let url = crate::config::sqlite_url(&dir.path().join("k.db"));
    let pool = crate::db::connect_with(&url, 2, Duration::from_secs(5)).await.unwrap();
    for org in ["o1", "o2"] {
        sqlx::query("INSERT INTO orgs (id, name, created_at) VALUES ($1, $2, 0)")
            .bind(org)
            .bind(org)
            .execute(&pool)
            .await
            .unwrap();
    }
    (dir, pool)
}

async fn count(pool: &AnyPool, sql: &str) -> i64 {
    let (n,): (i64,) = sqlx::query_as(sqlx::AssertSqlSafe(sql)).fetch_one(pool).await.unwrap();
    n
}

/// The tables hold an hour, ids of organizations, dashboards, panels and data sources, and
/// numbers: nothing that names or traces a person.
#[tokio::test]
async fn the_tables_have_no_column_for_a_person() {
    let (dir, pool) = database().await;
    let numbers = [
        "views",
        "runs",
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
    let ranges: Vec<String> = (0..RANGES).map(|i| format!("d{i}")).collect();
    for (table, ids) in [
        ("usage_dashboard_views", &["bucket", "org_id", "dashboard_id"][..]),
        ("usage_panel_runs", &["bucket", "org_id", "dashboard_id", "panel_id"][..]),
        ("usage_source_queries", &["bucket", "org_id", "datasource_id"][..]),
    ] {
        let columns: Vec<(String,)> =
            sqlx::query_as("SELECT name FROM pragma_table_info($1)").bind(table).fetch_all(&pool).await.unwrap();
        assert!(!columns.is_empty(), "{table} exists");
        for (column,) in columns {
            assert!(
                ids.contains(&column.as_str()) || numbers.contains(&column.as_str()) || ranges.contains(&column),
                "{table}.{column} is not one of the allowed columns"
            );
            for person in ["user", "actor", "session", "address", "ip", "email", "name", "agent"] {
                assert!(!column.contains(person), "{table}.{column} looks like person data");
            }
        }
    }
    pool.close().await;
    drop(dir);
}

#[tokio::test]
async fn flushes_add_to_the_stored_rows() {
    let (dir, pool) = database().await;
    let usage = Usage::default();
    usage.view(T0, "o1", "d1");
    usage.panel(T0, "o1", "d1", "p1", PanelRun { duration_ms: 40, rows: 3, error: false, cache: Cache::Miss });
    usage.source(T0, "o1", "s1", SourceQuery { duration_ms: 35, rows: 3, error: None, cache: Cache::Miss });
    assert_eq!(flush(&usage, &pool).await.unwrap(), 3);
    assert_eq!(flush(&usage, &pool).await.unwrap(), 0);
    usage.view(T0, "o1", "d1");
    usage.panel(T0, "o1", "d1", "p1", PanelRun { duration_ms: 900, rows: 1, error: true, cache: Cache::NotUsed });
    // An organization deleted meanwhile leaves nothing behind.
    usage.view(T0, "gone", "d1");
    assert_eq!(flush(&usage, &pool).await.unwrap(), 3);
    assert_eq!(count(&pool, "SELECT views FROM usage_dashboard_views").await, 2);
    assert_eq!(count(&pool, "SELECT COUNT(*) FROM usage_dashboard_views").await, 1);
    let (runs, errors, misses, rows, max, d3, d7): (i64, i64, i64, i64, i64, i64, i64) =
        sqlx::query_as("SELECT runs, errors, cache_misses, result_rows, duration_max_ms, d3, d7 FROM usage_panel_runs")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!((runs, errors, misses, rows, max, d3, d7), (2, 1, 1, 4, 900, 1, 1));
    pool.close().await;
    drop(dir);
}

#[tokio::test]
async fn a_failed_flush_keeps_the_counts() {
    let (dir, pool) = database().await;
    let usage = Usage::default();
    usage.view(T0, "o1", "d1");
    pool.close().await;
    assert!(flush(&usage, &pool).await.is_err());
    assert_eq!(usage.pending(), 1);
    drop(dir);
}

#[tokio::test]
async fn retention_deletes_old_buckets_only() {
    let (dir, pool) = database().await;
    let usage = Usage::default();
    let now = T0;
    for days_ago in [0, 10, 89, 91, 200] {
        let at = now - days_ago * DAY_MS;
        usage.view(at, "o1", "d1");
        usage.panel(at, "o2", "d2", "p", PanelRun { duration_ms: 1, rows: 0, error: false, cache: Cache::NotUsed });
        usage.source(at, "o1", "s", SourceQuery { duration_ms: 1, rows: 0, error: None, cache: Cache::NotUsed });
    }
    flush(&usage, &pool).await.unwrap();
    assert_eq!(purge(&pool, now, 90).await.unwrap(), 6);
    for table in ["usage_dashboard_views", "usage_panel_runs", "usage_source_queries"] {
        assert_eq!(count(&pool, &format!("SELECT COUNT(*) FROM {table}")).await, 3, "{table}");
        let oldest = count(&pool, &format!("SELECT MIN(bucket) FROM {table}")).await;
        assert!(oldest >= bucket_of(now) - 90 * DAY_MS);
    }
    // Running it again changes nothing.
    assert_eq!(purge(&pool, now, 90).await.unwrap(), 0);
    assert_eq!(purge(&pool, now, 5).await.unwrap(), 6);
    pool.close().await;
    drop(dir);
}
