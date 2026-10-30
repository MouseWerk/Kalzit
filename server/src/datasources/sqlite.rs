//! SQLite files: opened read-only (extension loading is never enabled), only from directories a
//! server admin allowed (`datasources.sqlite_dirs`), never Kalzit's own data directory.

use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

use futures_util::TryStreamExt;
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePool, SqlitePoolOptions, SqliteRow};
use sqlx::{Column as _, Executor, Row, SqlSafeStr, Statement, TypeInfo, ValueRef};

use super::Detail;
use super::frame::{Column, FrameBuilder};
use super::sql::{self, Bind, Engine};
use super::{
    Connection, DataSourcePlugin, FieldError, Health, Kind, SettingField, SettingType, SourceError, SourceQuery,
    SourceSchema, Table, TableColumn,
};
use crate::shapes::{FieldType, NoticeSeverity, QueryResult, Shape};

const SETTINGS: &[SettingField] =
    &[SettingField::new("path", "datasources.settings.path", SettingType::String).target().required()];
/// Connections per SQLite source; reads in parallel, the file is never written.
const POOL_SIZE: u32 = 4;
/// Tables listed in the schema.
const MAX_SCHEMA_TABLES: usize = 2_000;
/// How long a read waits for another program's write lock on the file.
const BUSY_WAIT: std::time::Duration = std::time::Duration::from_secs(5);
/// SQLite virtual machine steps between checks for timeout and cancellation.
const PROGRESS_STEPS: i32 = 10_000;

pub fn kind() -> Kind {
    Kind { name: "SQLite", hint_key: "datasources.kinds.sqlite.hint", settings: SETTINGS, plugin: Arc::new(Sqlite) }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Settings {
    path: String,
}

pub struct Sqlite;

async fn pool(conn: &Connection) -> Result<Arc<SqlitePool>, SourceError> {
    conn.shared(|| async {
        let settings: Settings = conn.settings_as()?;
        let path = conn.policy().check_sqlite_path(&settings.path)?;
        let options = SqliteConnectOptions::new()
            .filename(&path)
            .read_only(true)
            .create_if_missing(false)
            // Belt and braces next to the read-only open: refuse writes on the connection too.
            .pragma("query_only", "ON")
            // sqlx keeps the columns a cached statement was first prepared with, even after the
            // file's schema changed (SQLite re-prepares the statement, sqlx keeps the old
            // columns). The file belongs to someone else and may change at any time, so nothing
            // is cached: a query prepares three statements (the schema read in `query`, the
            // user's statement for its columns, and the same statement again to run it), about
            // 0.25 ms in all.
            .statement_cache_capacity(0)
            // Another program writing the file holds its lock for a moment; a read waits for it
            // instead of failing with "database is locked". Without a wait, 522 of 866 reads beside
            // a writer that inserted one row at a time failed; with it, none of 530 did. (This is
            // sqlx's default too; it is set here so the source does not depend on it.)
            .busy_timeout(BUSY_WAIT);
        SqlitePoolOptions::new()
            .max_connections(POOL_SIZE)
            .min_connections(0)
            .idle_timeout(std::time::Duration::from_secs(300))
            .connect_with(options)
            .await
            .map_err(|e| {
                SourceError::failed("sqlite.open_failed", format!("cannot open the SQLite file: {e}")).with("detail", e)
            })
    })
    .await
}

/// Like `failed`, but an interrupted statement inside a query is that query's time limit (or a
/// cancelled request, whose answer nobody reads).
fn failed_within(timeout: std::time::Duration) -> impl Fn(sqlx::Error) -> SourceError {
    move |e| match e {
        sqlx::Error::Database(db) if interrupted(db.as_ref()) => SourceError::Timeout(timeout.as_secs()),
        other => failed(other),
    }
}

/// SQLITE_INTERRUPT: the statement was stopped (`sqlite3_interrupt`).
fn interrupted(db: &dyn sqlx::error::DatabaseError) -> bool {
    db.code().as_deref() == Some("9")
}

fn failed(e: sqlx::Error) -> SourceError {
    match e {
        sqlx::Error::Database(db) if interrupted(db.as_ref()) => {
            SourceError::failed("query.stopped", "the query was stopped (time limit or cancelled)")
        }
        sqlx::Error::Database(db) => SourceError::from_source(db.message()),
        other => SourceError::from_source(other.to_string()),
    }
}

/// Sets `flag` when dropped: a request that goes away stops its query at the next progress check.
struct CancelOnDrop(Arc<AtomicBool>);

impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.store(true, Ordering::SeqCst);
    }
}

/// Installs a progress handler that interrupts the statement once the deadline passed or the
/// returned guard was dropped. Without it a dropped future would leave SQLite running in its
/// worker thread.
async fn guard_statement(
    conn: &mut sqlx::SqliteConnection,
    timeout: std::time::Duration,
) -> Result<CancelOnDrop, SourceError> {
    let cancelled = Arc::new(AtomicBool::new(false));
    let flag = cancelled.clone();
    let deadline = Instant::now() + timeout;
    let mut handle = conn.lock_handle().await.map_err(failed)?;
    handle.set_progress_handler(PROGRESS_STEPS, move || !flag.load(Ordering::SeqCst) && Instant::now() < deadline);
    Ok(CancelOnDrop(cancelled))
}

#[async_trait::async_trait]
impl DataSourcePlugin for Sqlite {
    fn kind(&self) -> &'static str {
        "sqlite"
    }

    fn shapes(&self) -> &'static [Shape] {
        &[Shape::Frame]
    }

    fn check_settings(&self, settings: &Value) -> Result<(), FieldError> {
        let s = Settings::deserialize(settings)
            .map_err(|e| FieldError::new("path", "settings.invalid", e.to_string()).with("detail", e))?;
        if !Path::new(&s.path).is_absolute() {
            return Err(FieldError::new(
                "path",
                "settings.path_relative",
                "the path must be absolute, like /srv/daten/umsatz.db or C:\\Daten\\umsatz.db",
            ));
        }
        Ok(())
    }

    async fn health(&self, conn: &Connection) -> Health {
        let check = async {
            let pool = pool(conn).await?;
            let (version,): (String,) =
                sqlx::query_as("SELECT sqlite_version()").fetch_one(&*pool).await.map_err(failed)?;
            Ok::<_, SourceError>(version)
        };
        match check.await {
            Ok(version) => {
                let mut health = Health::connected("SQLite", &version, false);
                health.detail =
                    Detail::new("health.connected_read_only", format!("SQLite {version}, opened read-only"))
                        .with("engine", "SQLite")
                        .with("version", version);
                health
            }
            Err(e) => Health::failed(&e),
        }
    }

    async fn schema(&self, conn: &Connection) -> Result<SourceSchema, SourceError> {
        let pool = pool(conn).await?;
        let mut c = pool.acquire().await.map_err(failed)?;
        let _guard = guard_statement(&mut c, super::MAX_HEALTH_TIMEOUT).await?;
        let names: Vec<(String,)> = sqlx::query_as(
            "SELECT name FROM sqlite_schema WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .fetch_all(&mut *c)
        .await
        .map_err(failed)?;
        let mut tables = Vec::new();
        for (name,) in names.into_iter().take(MAX_SCHEMA_TABLES) {
            let columns: Vec<(String, String)> = sqlx::query_as("SELECT name, type FROM pragma_table_info(?1)")
                .bind(&name)
                .fetch_all(&mut *c)
                .await
                .map_err(failed)?;
            let columns = columns.into_iter().map(|(name, data_type)| TableColumn { name, data_type }).collect();
            tables.push(Table { schema: None, name, columns });
        }
        Ok(SourceSchema::Tables { tables })
    }

    async fn query(&self, conn: &Connection, req: SourceQuery) -> Result<QueryResult, SourceError> {
        let prepared = sql::prepare_query(self, conn, &req, Engine::Sqlite).await?;
        let pool = pool(conn).await?;
        let mut c = pool.acquire().await.map_err(failed)?;
        let _guard = guard_statement(&mut c, req.limits.timeout).await?;
        let stopped = failed_within(req.limits.timeout);
        // A connection prepares against the schema it parsed last and notices a change only when
        // a statement reads a table, so a table recreated since would show its old declared
        // types. Reading the schema table first makes it reload the schema if it changed.
        sqlx::query("SELECT 1 FROM sqlite_schema LIMIT 1").fetch_optional(&mut *c).await.map_err(&stopped)?;
        let statement =
            (&mut *c).prepare(sqlx::AssertSqlSafe(prepared.sql.clone()).into_sql_str()).await.map_err(&stopped)?;
        let columns: Vec<Column> = statement
            .columns()
            .iter()
            .map(|col| Column::new(col.name(), declared_type(col.type_info().name())))
            .collect();
        // Columns typed by their values (expressions, NUMERIC, DECIMAL) may widen later.
        let inferred: Vec<bool> = columns.iter().map(|c| c.field_type.is_none()).collect();
        let mut frame = FrameBuilder::new(columns, req.limits.max_rows, req.limits.budget.clone());
        frame.executed_query(prepared.sql.clone());
        let mut query = statement.query();
        for bind in prepared.binds {
            query = match bind {
                Bind::Null => query.bind(None::<i64>),
                Bind::Bool(b) => query.bind(b),
                Bind::Int(i) => query.bind(i),
                Bind::Float(f) => query.bind(f),
                Bind::Text(t) => query.bind(t),
                Bind::Time(ms) => query.bind(sqlite_time_text(ms)?),
                Bind::Interval(ms) => query.bind(sql::format_interval(ms)),
            };
        }
        let mut mismatches = vec![0_u64; frame.columns_mut().len()];
        // Whole numbers beyond 2^53 a widened column holds only as the nearest double.
        let mut rounded = vec![0_u64; frame.columns_mut().len()];
        let mut rows = query.fetch(&mut *c);
        while let Some(row) = rows.try_next().await.map_err(&stopped)? {
            let (values, cells) = row_values(&row, &mut frame, &inferred, &mut rounded);
            if !frame.push_row(values) {
                break;
            }
            // Only rows that are shown count; a row the limit cut is not in the answer.
            for i in cells.mismatched {
                mismatches[i] += 1;
            }
            for i in cells.rounded {
                rounded[i] += 1;
            }
        }
        drop(rows);
        let names: Vec<String> = frame.columns_mut().iter().map(|c| c.name.clone()).collect();
        for (name, count) in names.iter().zip(mismatches).filter(|(_, n)| *n > 0) {
            let message = format!("{name} holds {count} values that do not fit its type; they are shown empty");
            let detail = Detail::new("frame.value_mismatch", message).with("column", name).with("count", count);
            frame.notice(NoticeSeverity::Warning, detail);
        }
        for (name, count) in names.iter().zip(rounded).filter(|(_, n)| *n > 0) {
            let message = format!(
                "{name} holds decimals, so {count} whole numbers beyond 2^53 in it are shown rounded to the nearest number"
            );
            let detail = Detail::new("frame.value_rounded", message).with("column", name).with("count", count);
            frame.notice(NoticeSeverity::Warning, detail);
        }
        Ok(QueryResult::Frame { frame: frame.finish() })
    }
}

/// The field type a column's declared type implies, so a table without rows still answers its
/// types. sqlx names the declared type by SQLite's affinity rules (`VARCHAR(20)` is `TEXT`,
/// `DOUBLE` is `REAL`); without a declared type (an expression), or with one it cannot name
/// (`NUMERIC`, `DECIMAL`), it reports the storage class of the first row, which before any row
/// is `NULL`. `None` then decides by the first value, and a column without values is `string`.
fn declared_type(name: &str) -> Option<FieldType> {
    match name {
        "INTEGER" => Some(FieldType::Int64),
        "REAL" => Some(FieldType::Number),
        "TEXT" => Some(FieldType::String),
        "BOOLEAN" => Some(FieldType::Bool),
        "DATE" | "TIME" | "DATETIME" => Some(FieldType::Time),
        // Binary values are hidden with a notice; NUMERIC holds integers and reals alike.
        _ => None,
    }
}

/// `YYYY-MM-DD HH:MM:SS.SSS` in UTC, the text form SQLite's date functions use.
fn sqlite_time_text(ms: i64) -> Result<String, SourceError> {
    Ok(super::bind_time(ms)?.format("%Y-%m-%d %H:%M:%S%.3f").to_string())
}

/// Unix milliseconds from the text forms SQLite stores dates in.
pub fn parse_time_text(s: &str) -> Option<i64> {
    let s = s.trim();
    if let Ok(t) = chrono::DateTime::parse_from_rfc3339(s) {
        return Some(t.timestamp_millis());
    }
    for format in ["%Y-%m-%d %H:%M:%S%.f", "%Y-%m-%dT%H:%M:%S%.f", "%Y-%m-%d %H:%M", "%Y-%m-%dT%H:%M"] {
        if let Ok(t) = chrono::NaiveDateTime::parse_from_str(s, format) {
            return Some(super::naive_to_ms(t));
        }
    }
    chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").ok().and_then(|d| d.and_hms_opt(0, 0, 0)).map(super::naive_to_ms)
}

/// SQLite types each value, not each column: a column without a declared type takes the type of
/// its first value, and later values are converted to the column's type where that is lossless.
/// Values that do not fit are `null`; the second part names their columns. A column typed by its
/// values (`inferred`) that started with whole numbers becomes `number` at its first fraction, as
/// NUMERIC and DECIMAL columns need, instead of losing every later decimal.
/// Whole numbers in a widened column beyond 2^53 lose digits; `rounded` counts those of the rows
/// already read when a column widens, and the row's own are named in its `Cells`.
fn row_values(
    row: &SqliteRow,
    frame: &mut FrameBuilder,
    inferred: &[bool],
    rounded: &mut [u64],
) -> (Vec<Value>, Cells) {
    let mut out = Vec::with_capacity(row.len());
    let mut mismatched = Vec::new();
    let mut rounded_here = Vec::new();
    let mut notices = Vec::new();
    for (i, column) in frame.columns_mut().iter_mut().enumerate() {
        let Ok(raw) = row.try_get_raw(i) else {
            out.push(Value::Null);
            continue;
        };
        if raw.is_null() {
            out.push(Value::Null);
            continue;
        }
        let storage = raw.type_info().name().to_string();
        let natural = match storage.as_str() {
            "INTEGER" => row.try_get_unchecked::<i64, _>(i).map(Natural::Int).ok(),
            "REAL" => row.try_get_unchecked::<f64, _>(i).map(Natural::Real).ok(),
            "TEXT" => row.try_get_unchecked::<String, _>(i).map(Natural::Text).ok(),
            _ => None,
        };
        let Some(natural) = natural else {
            notices.push(
                Detail::new("frame.binary_hidden", format!("{} holds binary values, which are not shown", column.name))
                    .with("column", &column.name),
            );
            out.push(Value::Null);
            continue;
        };
        if let Natural::Real(f) = natural
            && column.field_type == Some(FieldType::Int64)
            && inferred.get(i).copied().unwrap_or(false)
            && f.fract() != 0.0
        {
            let lost = std::cell::Cell::new(0_u64);
            column.retype(FieldType::Number, |v| {
                if v.as_str().is_some_and(|s| !exact_as_double(s)) {
                    lost.set(lost.get() + 1);
                }
                widen_to_number(v)
            });
            if let Some(count) = rounded.get_mut(i) {
                *count += lost.get();
            }
        }
        if let Natural::Int(n) = natural
            && column.field_type == Some(FieldType::Number)
            && inferred.get(i).copied().unwrap_or(false)
            && n.unsigned_abs() > 1 << 53
        {
            rounded_here.push(i);
        }
        let field_type = *column.field_type.get_or_insert(match natural {
            Natural::Int(_) => FieldType::Int64,
            Natural::Real(_) => FieldType::Number,
            Natural::Text(_) => FieldType::String,
        });
        let value = convert(natural, field_type);
        if value.is_null() {
            mismatched.push(i);
        }
        out.push(value);
    }
    for n in notices {
        frame.notice(NoticeSeverity::Warning, n);
    }
    (out, Cells { mismatched, rounded: rounded_here })
}

/// What one row's values did not keep: columns whose value did not fit (empty) and columns whose
/// whole number was rounded to a double.
struct Cells {
    mismatched: Vec<usize>,
    rounded: Vec<usize>,
}

/// Whether an int64 text survives the trip through a double: up to 2^53 every integer does.
fn exact_as_double(s: &str) -> bool {
    s.parse::<i64>().is_ok_and(|n| n.unsigned_abs() <= 1 << 53)
}

/// An int64 value (a decimal string) as a number, for a column that turned out to hold decimals.
fn widen_to_number(value: &Value) -> Value {
    value.as_str().and_then(|s| s.parse::<f64>().ok()).map_or(Value::Null, |f| json!(f))
}

enum Natural {
    Int(i64),
    Real(f64),
    Text(String),
}

/// Above this, a number in a time column is Unix milliseconds, below it Unix seconds (what
/// SQLite's `unixepoch()` returns). 10^11 seconds lie in the year 5138, 10^11 milliseconds in
/// 1973, so both readings cover the dates people store.
const EPOCH_MS_ABOVE: f64 = sql::SQLITE_EPOCH_MS_ABOVE as f64;

/// Unix milliseconds of a number in a time column, or `None` outside the years 1 to 9999 (the
/// range every time in an answer keeps to).
fn epoch_ms(n: f64) -> Option<i64> {
    let ms = if n.abs() > EPOCH_MS_ABOVE { n } else { n * 1000.0 };
    // Compared as a float first: the cast saturates, which would turn any huge value into a
    // valid-looking time at the edge.
    let range = super::MIN_TIME_MS as f64..=super::MAX_TIME_MS as f64;
    range.contains(&ms.round()).then(|| ms.round() as i64)
}

fn time_value(ms: Option<i64>) -> Value {
    ms.filter(|ms| (super::MIN_TIME_MS..=super::MAX_TIME_MS).contains(ms)).map_or(Value::Null, |ms| json!(ms))
}

fn convert(natural: Natural, field_type: FieldType) -> Value {
    match (field_type, natural) {
        (FieldType::Int64, Natural::Int(i)) => json!(i.to_string()),
        // A whole number stored as REAL fits; anything else would lose its fraction.
        (FieldType::Int64, Natural::Real(f)) => {
            if f.fract() == 0.0 && (-9_223_372_036_854_775_808.0..9_223_372_036_854_775_808.0).contains(&f) {
                json!((f as i64).to_string())
            } else {
                Value::Null
            }
        }
        (FieldType::Number, Natural::Int(i)) => json!(i as f64),
        (FieldType::Number, Natural::Real(f)) => serde_json::Number::from_f64(f).map_or(Value::Null, Value::Number),
        (FieldType::Bool, Natural::Int(i)) => json!(i != 0),
        (FieldType::Time, Natural::Int(i)) => {
            time_value(if i.unsigned_abs() > EPOCH_MS_ABOVE as u64 { Some(i) } else { i.checked_mul(1000) })
        }
        (FieldType::Time, Natural::Real(f)) if f.is_finite() => time_value(epoch_ms(f)),
        (FieldType::Time, Natural::Text(t)) => time_value(parse_time_text(&t)),
        (FieldType::String, Natural::Text(t)) => json!(t),
        (FieldType::String, Natural::Int(i)) => json!(i.to_string()),
        (FieldType::String, Natural::Real(f)) => json!(f.to_string()),
        _ => Value::Null,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn whole_reals_fit_int64_and_epochs_are_seconds_or_milliseconds() {
        assert_eq!(convert(Natural::Real(4.0), FieldType::Int64), json!("4"));
        assert_eq!(convert(Natural::Real(-3.0), FieldType::Int64), json!("-3"));
        assert_eq!(convert(Natural::Real(2.5), FieldType::Int64), Value::Null);
        assert_eq!(convert(Natural::Real(f64::NAN), FieldType::Int64), Value::Null);
        assert_eq!(convert(Natural::Real(1e19), FieldType::Int64), Value::Null);
        // Seconds up to 10^11, milliseconds above.
        assert_eq!(convert(Natural::Int(1_767_261_600), FieldType::Time), json!(1_767_261_600_000_i64));
        assert_eq!(convert(Natural::Int(1_767_261_600_000), FieldType::Time), json!(1_767_261_600_000_i64));
        assert_eq!(convert(Natural::Int(100_000_000_000), FieldType::Time), json!(100_000_000_000_000_i64));
        assert_eq!(convert(Natural::Int(100_000_000_001), FieldType::Time), json!(100_000_000_001_i64));
        assert_eq!(convert(Natural::Int(-1_767_261_600), FieldType::Time), json!(-1_767_261_600_000_i64));
        assert_eq!(convert(Natural::Real(1_767_261_600.25), FieldType::Time), json!(1_767_261_600_250_i64));
        assert_eq!(convert(Natural::Real(1_767_261_600_250.4), FieldType::Time), json!(1_767_261_600_250_i64));
        assert_eq!(convert(Natural::Real(f64::INFINITY), FieldType::Time), Value::Null);
        // Outside the years 1 to 9999 nothing is a time: neither huge integers (milliseconds far
        // past 9999) nor reals whose conversion would saturate.
        let max = crate::datasources::MAX_TIME_MS;
        let min = crate::datasources::MIN_TIME_MS;
        assert_eq!(convert(Natural::Int(max), FieldType::Time), json!(max));
        assert_eq!(convert(Natural::Int(max + 1), FieldType::Time), Value::Null);
        assert_eq!(convert(Natural::Int(min), FieldType::Time), json!(min));
        assert_eq!(convert(Natural::Int(min - 1), FieldType::Time), Value::Null);
        assert_eq!(convert(Natural::Int(i64::MAX), FieldType::Time), Value::Null);
        assert_eq!(convert(Natural::Int(i64::MIN), FieldType::Time), Value::Null);
        assert_eq!(convert(Natural::Real(1e30), FieldType::Time), Value::Null);
        assert_eq!(convert(Natural::Real(-1e30), FieldType::Time), Value::Null);
        assert_eq!(convert(Natural::Text("+12026-01-01".into()), FieldType::Time), Value::Null);
    }

    /// The time filter's plain ranges let SQLite search an index on the column instead of
    /// reading every row.
    #[tokio::test]
    async fn the_time_filter_can_use_an_index() {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql("CREATE TABLE e (am); CREATE INDEX e_am ON e (am);").execute(&pool).await.unwrap();
        let variables = std::collections::BTreeMap::new();
        let ctx = sql::Context {
            range: crate::shapes::TimeRange { from: 1_767_261_600_000, to: 1_767_268_800_000 },
            interval_ms: 1000,
            variables: &variables,
            identifiers: None,
            identifier_variables: None,
        };
        let prepared = sql::prepare("SELECT am FROM e WHERE $__timeFilter(am)", Engine::Sqlite, &ctx).unwrap();
        let mut query = sqlx::query(sqlx::AssertSqlSafe(format!("EXPLAIN QUERY PLAN {}", prepared.sql)));
        for bind in prepared.binds {
            query = match bind {
                Bind::Int(i) => query.bind(i),
                Bind::Float(f) => query.bind(f),
                Bind::Text(t) => query.bind(t),
                Bind::Time(ms) => query.bind(sqlite_time_text(ms).unwrap()),
                other => panic!("unexpected {other:?}"),
            };
        }
        let plan: Vec<String> =
            query.fetch_all(&pool).await.unwrap().iter().map(|r| r.get::<String, _>("detail")).collect();
        assert!(plan.iter().any(|d| d.contains("INDEX e_am")), "{plan:?}");
        assert!(!plan.iter().any(|d| d.starts_with("SCAN e")), "{plan:?}");
    }

    #[test]
    fn declared_types() {
        assert_eq!(declared_type("INTEGER"), Some(FieldType::Int64));
        assert_eq!(declared_type("REAL"), Some(FieldType::Number));
        assert_eq!(declared_type("TEXT"), Some(FieldType::String));
        assert_eq!(declared_type("BOOLEAN"), Some(FieldType::Bool));
        assert_eq!(declared_type("DATETIME"), Some(FieldType::Time));
        assert_eq!(declared_type("NULL"), None);
        assert_eq!(declared_type("BLOB"), None);
    }

    #[test]
    fn date_texts() {
        assert_eq!(parse_time_text("2026-10-20 12:30:00"), Some(1_792_499_400_000));
        assert_eq!(parse_time_text("2026-10-20T12:30:00.250Z"), Some(1_792_499_400_250));
        assert_eq!(parse_time_text("2026-10-20T14:30:00+02:00"), Some(1_792_499_400_000));
        assert_eq!(parse_time_text("2026-10-20"), Some(1_792_454_400_000));
        assert_eq!(parse_time_text("gestern"), None);
        assert_eq!(sqlite_time_text(1_792_499_400_250).unwrap(), "2026-10-20 12:30:00.250");
        assert!(sqlite_time_text(i64::MAX).is_err(), "never an empty or NULL time");
    }
}
