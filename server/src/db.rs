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
    let (base, query) = match url.split_once('?') {
        Some((b, q)) => (b, Some(q)),
        None => (url, None),
    };
    let base = match (base.find("://"), base.rfind('@')) {
        (Some(scheme_end), Some(at)) if at > scheme_end => {
            let user = base[scheme_end + 3..at].split(':').next().unwrap_or("");
            format!("{}://{}:***@{}", &base[..scheme_end], user, &base[at + 1..])
        }
        _ => base.to_string(),
    };
    let Some(query) = query else { return base };
    // PostgreSQL also takes credentials as parameters: ?user=u&password=secret.
    let query: Vec<String> = query
        .split('&')
        .map(|pair| match pair.split_once('=') {
            Some((key, _)) if SECRET_PARAMS.contains(&key.to_ascii_lowercase().as_str()) => format!("{key}=***"),
            _ => pair.to_string(),
        })
        .collect();
    format!("{base}?{}", query.join("&"))
}

const SECRET_PARAMS: &[&str] = &["password", "pass", "pwd", "sslpassword", "sslkey"];

/// Deletes sessions that have ended, every hour. Sessions are otherwise only deleted when their
/// cookie is presented again, and most expired cookies never come back.
pub fn spawn_session_cleanup(state: crate::app::AppState) {
    const INTERVAL: std::time::Duration = std::time::Duration::from_secs(3600);
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(INTERVAL);
        loop {
            tick.tick().await;
            let now = state.clock.now_ms();
            match crate::auth::session::delete_ended(&state.db, &state.config.sessions, now).await {
                Ok(0) => {}
                Ok(n) => tracing::debug!("removed {n} ended sessions"),
                Err(e) => tracing::warn!("removing ended sessions: {}", e.message),
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::redact;

    #[test]
    fn redact_hides_password() {
        assert_eq!(redact("postgres://granit:s3cr3t@db:5432/granit"), "postgres://granit:***@db:5432/granit");
        assert_eq!(redact("sqlite:data/granit.db?mode=rwc"), "sqlite:data/granit.db?mode=rwc");
        assert_eq!(
            redact("postgres://db/granit?user=u&Password=secret&sslmode=require"),
            "postgres://db/granit?user=u&Password=***&sslmode=require"
        );
    }
}
