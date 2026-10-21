//! Server-side sessions. The cookie holds a random token; the database holds only its SHA-256.

use std::time::Duration;

use axum::http::{HeaderMap, HeaderValue, header};
use sha2::{Digest, Sha256};
use sqlx::AnyPool;

use crate::config::SessionConfig;
use crate::error::ApiResult;

pub const COOKIE_NAME: &str = "kalzit_session";
/// `last_seen_at` is written at most this often, so reads do not turn into writes.
const TOUCH_INTERVAL_MS: i64 = 5 * 60 * 1000;
const HOUR_MS: i64 = 3_600_000;

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct SessionUser {
    pub id: String,
    pub email: String,
    pub name: String,
    pub is_server_admin: i64,
}

pub fn hash_token(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

/// Works on the pool or inside a transaction (`&mut *tx`), so a sign-in can write its session
/// and its audit entry together.
pub async fn create<'c, E>(db: E, cfg: &SessionConfig, now_ms: i64, user_id: &str) -> ApiResult<String>
where
    E: sqlx::Executor<'c, Database = sqlx::Any>,
{
    let token = hex::encode(rand::random::<[u8; 32]>());
    let expires = now_ms + cfg.lifetime_hours as i64 * HOUR_MS;
    sqlx::query(
        "INSERT INTO sessions (token_hash, id, user_id, created_at, last_seen_at, expires_at) \
         VALUES ($1, $2, $3, $4, $5, $6)",
    )
    .bind(hash_token(&token))
    // The id users see when they list and end their sessions; the hash never leaves the server.
    .bind(uuid::Uuid::now_v7().to_string())
    .bind(user_id)
    .bind(now_ms)
    .bind(now_ms)
    .bind(expires)
    .execute(db)
    .await?;
    Ok(token)
}

/// The signed-in user for `token`, or `None` when the session is unknown, expired, idle too long
/// or its user is disabled.
pub async fn lookup(db: &AnyPool, cfg: &SessionConfig, now_ms: i64, token: &str) -> ApiResult<Option<SessionUser>> {
    let hash = hash_token(token);
    let row: Option<(i64, i64)> = sqlx::query_as("SELECT last_seen_at, expires_at FROM sessions WHERE token_hash = $1")
        .bind(&hash)
        .fetch_optional(db)
        .await?;
    let Some((last_seen, expires)) = row else { return Ok(None) };
    let idle_limit = cfg.idle_timeout_hours as i64 * HOUR_MS;
    if now_ms >= expires || (idle_limit > 0 && now_ms - last_seen >= idle_limit) {
        delete(db, token).await?;
        return Ok(None);
    }
    let user: Option<SessionUser> = sqlx::query_as(
        "SELECT u.id, u.email, u.name, u.is_server_admin FROM sessions s JOIN users u ON u.id = s.user_id \
         WHERE s.token_hash = $1 AND u.disabled = 0",
    )
    .bind(&hash)
    .fetch_optional(db)
    .await?;
    if user.is_some() && now_ms - last_seen >= TOUCH_INTERVAL_MS {
        touch(db, &hash, now_ms).await;
    }
    Ok(user)
}

/// How long the last-seen update may wait for the database. A read must not wait on writers;
/// a missed update only moves the idle limit by one touch interval.
const TOUCH_WAIT: Duration = Duration::from_millis(100);

/// Best-effort update of the session's last-seen time: skipped when no connection is free at
/// once, given up after `TOUCH_WAIT`, and any failure is only logged.
async fn touch(db: &AnyPool, hash: &str, now_ms: i64) {
    let Some(mut conn) = db.try_acquire() else {
        tracing::debug!("session touch skipped: no free database connection");
        return;
    };
    let update = sqlx::query("UPDATE sessions SET last_seen_at = $1 WHERE token_hash = $2").bind(now_ms).bind(hash);
    let result = if conn.backend_name() == "SQLite" {
        // SQLite waits for the write lock with the connection's busy timeout; for this one
        // statement it is cut to the touch wait, then set back.
        async {
            let (previous,): (i64,) = sqlx::query_as("PRAGMA busy_timeout").fetch_one(&mut *conn).await?;
            let short = format!("PRAGMA busy_timeout = {}", TOUCH_WAIT.as_millis());
            sqlx::query(sqlx::AssertSqlSafe(short)).execute(&mut *conn).await?;
            let outcome = update.execute(&mut *conn).await;
            let restore = format!("PRAGMA busy_timeout = {previous}");
            if let Err(e) = sqlx::query(sqlx::AssertSqlSafe(restore)).execute(&mut *conn).await {
                // Never hand a connection with the short wait back to the pool.
                conn.close_on_drop();
                return Err(e);
            }
            outcome.map(|_| ())
        }
        .await
    } else {
        match tokio::time::timeout(TOUCH_WAIT, update.execute(&mut *conn)).await {
            Ok(outcome) => outcome.map(|_| ()),
            Err(_) => {
                // An abandoned statement leaves the connection in an unknown state.
                conn.close_on_drop();
                tracing::debug!("session touch gave up after {TOUCH_WAIT:?}");
                return;
            }
        }
    };
    if let Err(e) = result {
        tracing::debug!("session touch skipped: {e}");
    }
}

/// A session last seen at or before this time has ended through the idle limit. With the idle
/// timeout off, no session is that old.
pub fn idle_cutoff(cfg: &SessionConfig, now_ms: i64) -> i64 {
    let idle_ms = cfg.idle_timeout_hours as i64 * HOUR_MS;
    if idle_ms > 0 { now_ms - idle_ms } else { i64::MIN }
}

/// Removes every session past its lifetime or idle limit; returns how many.
pub async fn delete_ended(db: &AnyPool, cfg: &SessionConfig, now_ms: i64) -> Result<u64, sqlx::Error> {
    let done = sqlx::query("DELETE FROM sessions WHERE expires_at <= $1 OR last_seen_at <= $2")
        .bind(now_ms)
        .bind(idle_cutoff(cfg, now_ms))
        .execute(db)
        .await?;
    Ok(done.rows_affected())
}

pub async fn delete<'c, E>(db: E, token: &str) -> ApiResult<()>
where
    E: sqlx::Executor<'c, Database = sqlx::Any>,
{
    sqlx::query("DELETE FROM sessions WHERE token_hash = $1").bind(hash_token(token)).execute(db).await?;
    Ok(())
}

/// Ends every session of `user_id` except the one whose token is `keep` (the caller's own, when
/// they change their password); returns how many ended.
pub async fn delete_for_user<'c, E>(db: E, user_id: &str, keep: Option<&str>) -> ApiResult<u64>
where
    E: sqlx::Executor<'c, Database = sqlx::Any>,
{
    // No hash is empty, so without `keep` every session matches.
    let keep_hash = keep.map(hash_token).unwrap_or_default();
    let done = sqlx::query("DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2")
        .bind(user_id)
        .bind(keep_hash)
        .execute(db)
        .await?;
    Ok(done.rows_affected())
}

pub fn read_cookie(headers: &HeaderMap) -> Option<String> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .filter_map(|pair| pair.trim().split_once('='))
        .find(|(name, _)| *name == COOKIE_NAME)
        .map(|(_, value)| value.to_string())
        .filter(|v| !v.is_empty())
}

pub fn set_cookie(token: &str, cfg: &SessionConfig, secure: bool) -> HeaderValue {
    let max_age = cfg.lifetime_hours * 3600;
    cookie_header(&format!("{COOKIE_NAME}={token}; Max-Age={max_age}"), secure)
}

pub fn clear_cookie(secure: bool) -> HeaderValue {
    cookie_header(&format!("{COOKIE_NAME}=; Max-Age=0"), secure)
}

fn cookie_header(base: &str, secure: bool) -> HeaderValue {
    let secure = if secure { "; Secure" } else { "" };
    // The token is hex and the rest is static, so this is always a valid header value.
    HeaderValue::from_str(&format!("{base}; Path=/; HttpOnly; SameSite=Lax{secure}")).expect("cookie header is ASCII")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_session_cookie_among_others() {
        let mut h = HeaderMap::new();
        h.insert(header::COOKIE, HeaderValue::from_static("theme=dark; kalzit_session=abc123; x=1"));
        assert_eq!(read_cookie(&h).as_deref(), Some("abc123"));
    }

    #[test]
    fn cookie_flags() {
        let cfg = SessionConfig { lifetime_hours: 1, idle_timeout_hours: 1 };
        let v = set_cookie("t", &cfg, true);
        let s = v.to_str().unwrap();
        assert!(s.contains("HttpOnly") && s.contains("SameSite=Lax") && s.contains("Secure"));
        assert!(s.contains("Max-Age=3600"));
        assert!(!set_cookie("t", &cfg, false).to_str().unwrap().contains("Secure"));
    }
}
