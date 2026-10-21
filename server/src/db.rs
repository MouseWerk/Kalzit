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
    // The userinfo first: a password may hold a raw `?`, `#` or `/`, so the last `@` ends it.
    // An `@` further right (in the query) only hides more than needed.
    let (prefix, rest) = match url.find("://") {
        Some(scheme_end) => {
            let after = &url[scheme_end + 3..];
            match after.rfind('@') {
                Some(at) => {
                    let userinfo = &after[..at];
                    let prefix = match userinfo.split_once(':') {
                        Some((user, _)) => format!("{}://{user}:***@", &url[..scheme_end]),
                        None => format!("{}://{userinfo}@", &url[..scheme_end]),
                    };
                    (prefix, &after[at + 1..])
                }
                None => (url[..scheme_end + 3].to_string(), after),
            }
        }
        None => (String::new(), url),
    };
    let (base, query) = match rest.split_once('?') {
        Some((b, q)) => (format!("{prefix}{b}"), Some(q)),
        None => (format!("{prefix}{rest}"), None),
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
                Err(e) => tracing::warn!("removing ended sessions failed, will retry in an hour: {e}"),
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::redact;

    #[test]
    fn redact_hides_password() {
        assert_eq!(redact("postgres://kalzit:s3cr3t@db:5432/kalzit"), "postgres://kalzit:***@db:5432/kalzit");
        assert_eq!(redact("sqlite:data/kalzit.db?mode=rwc"), "sqlite:data/kalzit.db?mode=rwc");
        assert_eq!(
            redact("postgres://db/kalzit?user=u&Password=secret&sslmode=require"),
            "postgres://db/kalzit?user=u&Password=***&sslmode=require"
        );
        // Raw `?`, `#`, `/` and `@` in the password stay hidden.
        assert_eq!(redact("postgres://kalzit:a?b@db/kalzit"), "postgres://kalzit:***@db/kalzit");
        assert_eq!(redact("postgres://kalzit:a#b@db/kalzit"), "postgres://kalzit:***@db/kalzit");
        assert_eq!(redact("postgres://kalzit:a/b@db/kalzit"), "postgres://kalzit:***@db/kalzit");
        assert_eq!(
            redact("postgres://kalzit:a@b?c@db/kalzit?sslmode=require"),
            "postgres://kalzit:***@db/kalzit?sslmode=require"
        );
        // No password, nothing to hide.
        assert_eq!(redact("postgres://kalzit@db/kalzit"), "postgres://kalzit@db/kalzit");
        assert_eq!(redact("postgres://db/kalzit"), "postgres://db/kalzit");
    }
}
