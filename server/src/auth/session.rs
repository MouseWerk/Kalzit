//! Server-side sessions. The cookie holds a random token; the database holds only its SHA-256.

use std::sync::{Arc, Mutex};

use axum::http::{HeaderMap, HeaderValue, header};
use sha2::{Digest, Sha256};
use sqlx::AnyPool;
use tokio::sync::Semaphore;
use tokio::task::JoinSet;

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
pub async fn lookup(
    db: &AnyPool,
    touches: &Touches,
    cfg: &SessionConfig,
    now_ms: i64,
    token: &str,
) -> ApiResult<Option<SessionUser>> {
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
        touches.spawn(hash, now_ms);
    }
    Ok(user)
}

/// The last-seen updates in flight for one server. Each runs in its own task, so a read never
/// waits for one, and a cancelled request cannot cut one short.
pub struct Touches {
    /// On SQLite a pool of its own, whose connections wait at most `db::TOUCH_BUSY_TIMEOUT` for
    /// the write lock: SQLite goes on waiting after a touch is aborted, and closing the database
    /// waits for that. Otherwise the server's pool.
    db: AnyPool,
    own_pool: bool,
    permits: Arc<Semaphore>,
    limit: u32,
    tasks: Mutex<JoinSet<()>>,
}

impl Touches {
    /// At most a quarter of the server's pool size (1 to 4) at once: on PostgreSQL each touch
    /// holds one of the requests' connections while it runs.
    pub fn new(db: &AnyPool, url: &str) -> Self {
        let limit = (db.options().get_max_connections() / 4).clamp(1, 4);
        let own = crate::db::side_pool(db, url, limit, crate::db::TOUCH_BUSY_TIMEOUT);
        Self {
            own_pool: own.is_some(),
            db: own.unwrap_or_else(|| db.clone()),
            permits: Arc::new(Semaphore::new(limit as usize)),
            limit,
            tasks: Mutex::default(),
        }
    }

    /// Waits until no touch is in flight (tests, before they move the clock on).
    pub async fn settle(&self) {
        // Fails only once `abort_all` closed the semaphore, and then nothing is in flight.
        let _all = self.permits.acquire_many(self.limit).await;
    }

    /// Stops all touches for good, before the server closes the database, and waits at most
    /// `db::TOUCH_BUSY_TIMEOUT` for one that is waiting for the write lock. A dropped touch costs
    /// nothing; the session's next request repeats it.
    pub async fn abort_all(&self) {
        self.permits.close();
        let mut tasks = std::mem::take(&mut *self.lock_tasks());
        tasks.abort_all();
        while tasks.join_next().await.is_some() {}
        if self.own_pool {
            self.db.close().await;
        }
    }

    fn lock_tasks(&self) -> std::sync::MutexGuard<'_, JoinSet<()>> {
        // The set holds no invariant a panic could break.
        self.tasks.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Updates the session's last-seen time in the background. Skipped when the limit is
    /// reached; the session's next request tries again, since its touch is still due. Failures
    /// are only logged.
    fn spawn(&self, hash: String, now_ms: i64) {
        let Ok(permit) = self.permits.clone().try_acquire_owned() else {
            tracing::debug!("session touch skipped: {} already in flight", self.limit);
            return;
        };
        let db = self.db.clone();
        let mut tasks = self.lock_tasks();
        // Finished touches leave their result in the set; drop them so it does not grow.
        while tasks.try_join_next().is_some() {}
        tasks.spawn(async move {
            let _permit = permit;
            // A touch that waited for the lock never moves a newer one back.
            let update =
                sqlx::query("UPDATE sessions SET last_seen_at = $1 WHERE token_hash = $2 AND last_seen_at < $1")
                    .bind(now_ms)
                    .bind(&hash)
                    .execute(&db)
                    .await;
            if let Err(e) = update {
                tracing::debug!("session touch failed: {e}");
            }
        });
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

    /// Touches can land out of order; one that waited longer never moves the time back.
    #[tokio::test]
    async fn an_older_touch_never_overwrites_a_newer_one() {
        let db = crate::db::connect("sqlite::memory:", 1).await.unwrap();
        sqlx::query("INSERT INTO users (id, email, name, created_at) VALUES ('u-1', 'a@example.de', 'A', 0)")
            .execute(&db)
            .await
            .unwrap();
        let cfg = SessionConfig { lifetime_hours: 24, idle_timeout_hours: 24 };
        let token = create(&db, &cfg, 0, "u-1").await.unwrap();
        let touches = Touches::new(&db, "sqlite::memory:");
        for now_ms in [20 * 60_000, 10 * 60_000] {
            touches.spawn(hash_token(&token), now_ms);
            touches.settle().await;
        }
        let last_seen: i64 = sqlx::query_scalar("SELECT last_seen_at FROM sessions").fetch_one(&db).await.unwrap();
        assert_eq!(last_seen, 20 * 60_000);
    }

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
