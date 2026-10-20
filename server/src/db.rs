//! The server's own database: SQLite by default, PostgreSQL for larger installations. Both run
//! the same portable migrations through sqlx's `Any` driver.

use anyhow::{Context, Result};
use sqlx::AnyPool;
use sqlx::any::AnyPoolOptions;

static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

pub async fn connect(url: &str, max_connections: u32) -> Result<AnyPool> {
    sqlx::any::install_default_drivers();
    let pool = AnyPoolOptions::new()
        .max_connections(max_connections)
        .connect(url)
        .await
        .with_context(|| format!("connecting to the database ({})", redact(url)))?;
    MIGRATOR.run(&pool).await.context("running database migrations")?;
    Ok(pool)
}

/// The URL without a password, for log lines.
pub fn redact(url: &str) -> String {
    match (url.find("://"), url.rfind('@')) {
        (Some(scheme_end), Some(at)) if at > scheme_end => {
            let userinfo = &url[scheme_end + 3..at];
            let user = userinfo.split(':').next().unwrap_or("");
            format!("{}://{}:***@{}", &url[..scheme_end], user, &url[at + 1..])
        }
        _ => url.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::redact;

    #[test]
    fn redact_hides_password() {
        assert_eq!(redact("postgres://granit:s3cr3t@db:5432/granit"), "postgres://granit:***@db:5432/granit");
        assert_eq!(redact("sqlite://data/granit.db?mode=rwc"), "sqlite://data/granit.db?mode=rwc");
    }
}
