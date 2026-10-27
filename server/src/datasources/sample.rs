//! The built-in sample database: a small SQLite file with a made-up shop (regions, products,
//! customers, orders), so a new installation has something to explore before a database of its
//! own is connected. Its rows are part of the binary (`sample.sql`); the file is made on demand in
//! the samples directory of the data directory, which the target rules open for SQLite sources
//! only (`targets::SAMPLES_DIR`). Sources open it read-only like any other SQLite file.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use sqlx::Connection;
use sqlx::sqlite::{SqliteConnectOptions, SqliteConnection};

use super::targets::SAMPLES_DIR;

pub const FILE_NAME: &str = "kalzit-sample.sqlite";

const SCHEMA: &str = include_str!("sample.sql");

/// One build at a time in this process; a second request waits and then finds the file.
static BUILDING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Where the sample database lives for `data_dir`.
pub fn path(data_dir: &Path) -> PathBuf {
    data_dir.join(SAMPLES_DIR).join(FILE_NAME)
}

/// Whether `path` is a file; the lookup runs off the async workers, like every file system call
/// here.
async fn is_file(path: &Path) -> bool {
    tokio::fs::metadata(path).await.is_ok_and(|m| m.is_file())
}

/// The sample database of `data_dir`, made first when it does not exist yet. It is built under
/// a temporary name in the same directory and renamed when complete, so a source never sees a
/// half-written file. An existing file is used as it is.
pub async fn ensure(data_dir: &Path) -> Result<PathBuf> {
    let file = path(data_dir);
    let _building = BUILDING.lock().await;
    if is_file(&file).await {
        return Ok(file);
    }
    let dir = data_dir.join(SAMPLES_DIR);
    tokio::fs::create_dir_all(&dir).await.with_context(|| format!("creating {}", dir.display()))?;
    let temp = dir.join(format!(".{FILE_NAME}.{}.tmp", uuid::Uuid::now_v7().simple()));
    let mut result = build(&temp).await;
    if result.is_ok() {
        let moved = match tokio::fs::rename(&temp, &file).await {
            // Another server process on the same data directory was faster.
            Err(_) if is_file(&file).await => Ok(()),
            other => other,
        };
        result = moved.with_context(|| format!("moving the sample database to {}", file.display()));
    }
    if tokio::fs::try_exists(&temp).await.unwrap_or(false) {
        let _ = tokio::fs::remove_file(&temp).await;
    }
    result.map(|()| file)
}

async fn build(temp: &Path) -> Result<()> {
    // The default rollback journal, so the finished database is this one file and nothing else.
    let options = SqliteConnectOptions::new()
        .filename(temp)
        .create_if_missing(true)
        .journal_mode(sqlx::sqlite::SqliteJournalMode::Delete);
    let mut conn = SqliteConnection::connect_with(&options).await.context("creating the sample database")?;
    let filled = sqlx::raw_sql(SCHEMA).execute(&mut conn).await.context("filling the sample database");
    conn.close().await.context("closing the sample database")?;
    filled.map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn the_sample_is_built_once_and_always_the_same() {
        let dir = tempfile::tempdir().unwrap();
        let file = ensure(dir.path()).await.unwrap();
        assert_eq!(file, path(dir.path()));
        let modified = std::fs::metadata(&file).unwrap().modified().unwrap();
        // Only the database is left behind, no temporary file or journal.
        let names: Vec<String> = std::fs::read_dir(dir.path().join(SAMPLES_DIR))
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(names, [FILE_NAME]);

        let options = SqliteConnectOptions::new().filename(&file).read_only(true);
        let mut conn = SqliteConnection::connect_with(&options).await.unwrap();
        let counts: (i64, i64, i64, i64) = sqlx::query_as(
            "SELECT (SELECT COUNT(*) FROM regions), (SELECT COUNT(*) FROM products), \
             (SELECT COUNT(*) FROM customers), (SELECT COUNT(*) FROM orders)",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap();
        assert_eq!(counts, (6, 12, 40, 600));
        let (first, last, names): (String, String, i64) = sqlx::query_as(
            "SELECT MIN(ordered_at), MAX(ordered_at), (SELECT COUNT(DISTINCT name) FROM customers) FROM orders",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap();
        assert!(first.starts_with("2025-07-01") && last.starts_with("2026-06-30"), "{first} .. {last}");
        assert_eq!(names, 40);
        // Deterministic: a fixed digest of what the orders hold.
        let (sum,): (f64,) = sqlx::query_as("SELECT SUM(total) FROM orders").fetch_one(&mut conn).await.unwrap();
        conn.close().await.unwrap();

        // The second call uses the file as it is.
        assert_eq!(ensure(dir.path()).await.unwrap(), file);
        assert_eq!(std::fs::metadata(&file).unwrap().modified().unwrap(), modified);

        // A second data directory gets the same rows.
        let other = tempfile::tempdir().unwrap();
        let again = ensure(other.path()).await.unwrap();
        let options = SqliteConnectOptions::new().filename(&again).read_only(true);
        let mut conn = SqliteConnection::connect_with(&options).await.unwrap();
        let (sum2,): (f64,) = sqlx::query_as("SELECT SUM(total) FROM orders").fetch_one(&mut conn).await.unwrap();
        conn.close().await.unwrap();
        assert_eq!(sum, sum2);
        other.close().unwrap();
        dir.close().unwrap();
    }
}
