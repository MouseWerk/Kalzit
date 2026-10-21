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

use super::frame::{Column, FrameBuilder};
use super::sql::{self, Bind, Engine};
use super::{
    Connection, DataSourcePlugin, FieldError, Health, Kind, SettingField, SettingType, SourceError, SourceQuery,
    SourceSchema, Table, TableColumn,
};
use crate::shapes::{FieldType, NoticeSeverity, QueryResult, Shape};

const SETTINGS: &[SettingField] =
    &[SettingField::new("path", "datasources.settings.path", SettingType::String).required()];
/// Connections per SQLite source; reads in parallel, the file is never written.
const POOL_SIZE: u32 = 4;
/// Tables listed in the schema.
const MAX_SCHEMA_TABLES: usize = 2_000;
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
            .pragma("query_only", "ON");
        SqlitePoolOptions::new()
            .max_connections(POOL_SIZE)
            .min_connections(0)
            .idle_timeout(std::time::Duration::from_secs(300))
            .connect_with(options)
            .await
            .map_err(|e| SourceError::Failed(format!("cannot open the SQLite file: {e}")))
    })
    .await
}

/// Like `failed`, but an interrupted statement inside a query is that query's time limit (or a
/// cancelled request, whose answer nobody reads).
fn failed_within(timeout: std::time::Duration) -> impl Fn(sqlx::Error) -> SourceError {
    move |e| match e {
        sqlx::Error::Database(db) if db.message().contains("interrupted") => SourceError::Timeout(timeout.as_secs()),
        other => failed(other),
    }
}

fn failed(e: sqlx::Error) -> SourceError {
    match e {
        sqlx::Error::Database(db) if db.message().contains("interrupted") => {
            SourceError::Failed("the query was stopped (time limit or cancelled)".into())
        }
        sqlx::Error::Database(db) => SourceError::Failed(db.message().to_string()),
        other => SourceError::Failed(other.to_string()),
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
        let s = Settings::deserialize(settings).map_err(|e| FieldError::new("path", e.to_string()))?;
        if !Path::new(&s.path).is_absolute() {
            return Err(FieldError::new(
                "path",
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
            Ok(version) => Health { ok: true, message: format!("SQLite {version}, opened read-only") },
            Err(e) => Health { ok: false, message: e.to_string() },
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
        let statement =
            (&mut *c).prepare(sqlx::AssertSqlSafe(prepared.sql.clone()).into_sql_str()).await.map_err(&stopped)?;
        let mut columns: Vec<Column> = Vec::new();
        let mut declared = Vec::new();
        for col in statement.columns() {
            let decl = col.type_info().name().to_ascii_uppercase();
            columns.push(Column::new(col.name(), declared_type(&decl)));
            declared.push(decl);
        }
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
                Bind::Time(ms) => query.bind(sqlite_time_text(ms)),
                Bind::Interval(ms) => query.bind(sql::format_interval(ms)),
            };
        }
        let mut rows = query.fetch(&mut *c);
        while let Some(row) = rows.try_next().await.map_err(&stopped)? {
            let values = row_values(&row, &mut frame);
            if !frame.push_row(values) {
                break;
            }
        }
        Ok(QueryResult::Frame { frame: frame.finish() })
    }
}

/// The field type a declared column type implies; `None` decides by the first value.
fn declared_type(decl: &str) -> Option<FieldType> {
    if decl.contains("BOOL") {
        Some(FieldType::Bool)
    } else if decl.contains("DATE") || decl.contains("TIME") {
        Some(FieldType::Time)
    } else {
        None
    }
}

/// `YYYY-MM-DD HH:MM:SS.SSS` in UTC, the text form SQLite's date functions use.
fn sqlite_time_text(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|t| t.format("%Y-%m-%d %H:%M:%S%.3f").to_string())
        .unwrap_or_default()
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

/// SQLite types each value, not each column: the column takes the type of its first value, and
/// later values are converted to it where that is lossless enough.
fn row_values(row: &SqliteRow, frame: &mut FrameBuilder) -> Vec<Value> {
    let mut out = Vec::with_capacity(row.len());
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
            notices.push(format!("{} holds binary values, which are not shown", column.name));
            out.push(Value::Null);
            continue;
        };
        let field_type = *column.field_type.get_or_insert(match natural {
            Natural::Int(_) => FieldType::Int64,
            Natural::Real(_) => FieldType::Number,
            Natural::Text(_) => FieldType::String,
        });
        let value = convert(natural, field_type);
        if value.is_null() {
            notices.push(format!("{} holds values that do not fit its type; they are shown empty", column.name));
        }
        out.push(value);
    }
    for n in notices {
        frame.notice(NoticeSeverity::Warning, n);
    }
    out
}

enum Natural {
    Int(i64),
    Real(f64),
    Text(String),
}

fn convert(natural: Natural, field_type: FieldType) -> Value {
    match (field_type, natural) {
        (FieldType::Int64, Natural::Int(i)) => json!(i.to_string()),
        (FieldType::Int64, Natural::Real(f)) => json!(f.to_string()),
        (FieldType::Number, Natural::Int(i)) => json!(i as f64),
        (FieldType::Number, Natural::Real(f)) => serde_json::Number::from_f64(f).map_or(Value::Null, Value::Number),
        (FieldType::Bool, Natural::Int(i)) => json!(i != 0),
        // A number in a date column is Unix seconds, what SQLite's unixepoch() returns.
        (FieldType::Time, Natural::Int(i)) => json!(i.saturating_mul(1000)),
        (FieldType::Time, Natural::Real(f)) => json!((f * 1000.0).round() as i64),
        (FieldType::Time, Natural::Text(t)) => parse_time_text(&t).map_or(Value::Null, |ms| json!(ms)),
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
    fn date_texts() {
        assert_eq!(parse_time_text("2026-10-20 12:30:00"), Some(1_792_499_400_000));
        assert_eq!(parse_time_text("2026-10-20T12:30:00.250Z"), Some(1_792_499_400_250));
        assert_eq!(parse_time_text("2026-10-20T14:30:00+02:00"), Some(1_792_499_400_000));
        assert_eq!(parse_time_text("2026-10-20"), Some(1_792_454_400_000));
        assert_eq!(parse_time_text("gestern"), None);
        assert_eq!(sqlite_time_text(1_792_499_400_250), "2026-10-20 12:30:00.250");
    }
}
