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
    let (prefix, rest) = match url.find("://") {
        Some(scheme_end) => {
            let scheme = &url[..scheme_end];
            let after = &url[scheme_end + 3..];
            match userinfo_end(after) {
                Some(at) => {
                    let userinfo = &after[..at];
                    let prefix = match userinfo.split_once(':') {
                        Some((user, _)) => format!("{scheme}://{user}:***@"),
                        None => format!("{scheme}://{userinfo}@"),
                    };
                    (prefix, &after[at + 1..])
                }
                None => (format!("{scheme}://"), after),
            }
        }
        None => (String::new(), url),
    };
    // PostgreSQL also takes credentials as parameters (`?user=u&password=secret`). Every `?` or
    // `&` segment is checked, so an odd split above cannot let one through.
    let masked: String = rest
        .split_inclusive(['?', '&'])
        .map(|piece| {
            let (segment, delimiter) = match piece.strip_suffix(['?', '&']) {
                Some(segment) => (segment, &piece[segment.len()..]),
                None => (piece, ""),
            };
            match segment.split_once('=') {
                Some((key, _)) if SECRET_PARAMS.contains(&key.to_ascii_lowercase().as_str()) => {
                    format!("{key}=***{delimiter}")
                }
                _ => piece.to_string(),
            }
        })
        .collect();
    format!("{prefix}{masked}")
}

/// The `@` that ends the userinfo in `after` (the URL after `://`). A password may hold a raw
/// `?`, `#`, `/` or `@`, so it is the last `@` that is not inside the query; an `@` is in the
/// query when a `?` before it is followed by a `key=` (`?application_name=a@b`). Then the host
/// stays visible and the query parameters are masked one by one.
fn userinfo_end(after: &str) -> Option<usize> {
    let in_query = |before: &str| before.match_indices('?').any(|(q, _)| before[q + 1..].contains('='));
    if let Some(at) = after.match_indices('@').map(|(at, _)| at).rfind(|&at| !in_query(&after[..at])) {
        return Some(at);
    }
    // `user:pa?ss=1@host`: the password itself looks like a query. A `host:port?...@` (digits
    // after the colon) is not userinfo, so the host is never hidden.
    let first = after.find('@')?;
    let before_query = after[..first].split('?').next().unwrap_or_default();
    let (user, password) = before_query.split_once(':')?;
    let plain = !user.is_empty() && !user.contains('/') && !password.chars().all(|c| c.is_ascii_digit());
    plain.then_some(first)
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
        // An `@` in the query neither hides the host nor lets a secret parameter through.
        assert_eq!(
            redact("postgres://db/kalzit?application_name=a@b&password=secret"),
            "postgres://db/kalzit?application_name=a@b&password=***"
        );
        assert_eq!(
            redact("postgres://u:pw@db/k?options=x@y&password=z"),
            "postgres://u:***@db/k?options=x@y&password=***"
        );
        assert_eq!(
            redact("postgres://db:5432?application_name=a@b&pwd=s"),
            "postgres://db:5432?application_name=a@b&pwd=***"
        );
        assert_eq!(redact("postgres://u:pa?ss=1@db/k"), "postgres://u:***@db/k");
        // No password, nothing to hide.
        assert_eq!(redact("postgres://kalzit@db/kalzit"), "postgres://kalzit@db/kalzit");
        assert_eq!(redact("postgres://db/kalzit"), "postgres://db/kalzit");
    }
}
