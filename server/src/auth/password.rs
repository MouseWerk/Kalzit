//! Password hashing with Argon2id. Hashing is CPU-heavy, so it runs on the blocking pool.

use std::sync::LazyLock;
use std::sync::atomic::{AtomicUsize, Ordering};

use argon2::Argon2;
use argon2::password_hash::phc::PasswordHash;
use argon2::password_hash::{PasswordHasher, PasswordVerifier};

/// NIST SP 800-63B allows 8; 12 is the floor for accounts that can administer a server.
pub const MIN_PASSWORD_CHARS: usize = 12;
/// Bounds the hashing cost a hostile client can cause with one request.
pub const MAX_PASSWORD_CHARS: usize = 1024;

/// Verified against when the user does not exist, so a login takes as long either way and does
/// not reveal which emails have accounts.
static DUMMY_HASH: LazyLock<String> = LazyLock::new(|| {
    let random: [u8; 32] = rand::random();
    hash_blocking(&hex::encode(random)).unwrap_or_default()
});

/// Builds the dummy hash at start, so the first sign-in with an unknown email is not slower than
/// the others (which would reveal that the email has no account).
pub async fn prewarm() {
    let _ = tokio::task::spawn_blocking(|| LazyLock::force(&DUMMY_HASH).len()).await;
}

fn hash_blocking(password: &str) -> Result<String, String> {
    Argon2::default().hash_password(password.as_bytes()).map(|h| h.to_string()).map_err(|e| e.to_string())
}

fn cpus() -> usize {
    std::thread::available_parallelism().map_or(2, |n| n.get())
}

/// Checks waiting for a thread, per CPU, before further ones are refused at once.
const WAITING_PER_CPU: usize = 32;

/// Threads for hashing and checking: at most so many at once, since more would only queue on the
/// blocking pool and take its threads from everything else; further ones wait their turn, up to
/// `WAITING_PER_CPU` per CPU.
pub struct Lane {
    turns: tokio::sync::Semaphore,
    waiting: AtomicUsize,
    max_waiting: usize,
}

/// For the checks of sign-ins from browsers the account does not know.
pub static SHARED: LazyLock<Lane> = LazyLock::new(|| Lane::new(cpus()));
/// For the checks of known devices (`auth::device`) and of signed-in users, and for hashing new
/// passwords (setup, an admin's reset, a user's change), so a flood of guesses that fills the
/// shared lane cannot keep the owner out or delay them.
pub static TRUSTED: LazyLock<Lane> = LazyLock::new(|| Lane::new((cpus() / 4).max(1)));

/// Counts a waiter until dropped (also when the request is cancelled while waiting).
struct Waiting<'a>(&'a AtomicUsize);

impl Drop for Waiting<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

impl Lane {
    fn new(threads: usize) -> Self {
        Self {
            turns: tokio::sync::Semaphore::new(threads),
            waiting: AtomicUsize::new(0),
            max_waiting: threads * WAITING_PER_CPU,
        }
    }

    /// A turn, or `None` at once when too many wait already.
    async fn turn(&self) -> Option<tokio::sync::SemaphorePermit<'_>> {
        if self.waiting.fetch_add(1, Ordering::SeqCst) >= self.max_waiting {
            self.waiting.fetch_sub(1, Ordering::SeqCst);
            return None;
        }
        let _waiting = Waiting(&self.waiting);
        self.turns.acquire().await.ok()
    }
}

/// Hashes a new password on the trusted lane; it waits for its turn however many wait. Only
/// privileged requests hash (setup with its code, admins, signed-in users), so sign-in guesses on
/// the shared lane never delay them.
pub async fn hash(password: String) -> Result<String, String> {
    let _turn = TRUSTED.turns.acquire().await.map_err(|e| e.to_string())?;
    tokio::task::spawn_blocking(move || hash_blocking(&password)).await.map_err(|e| e.to_string())?
}

/// Whether `password` matches `stored`, checked on `lane`; `None` when the lane is too busy to
/// take the check. A missing hash (unknown user) still costs one verification and is `false`.
pub async fn verify(password: String, stored: Option<String>, lane: &Lane) -> Option<bool> {
    let _turn = lane.turn().await?;
    let matched = tokio::task::spawn_blocking(move || {
        let known = stored.is_some();
        let phc = stored.unwrap_or_else(|| DUMMY_HASH.clone());
        let Ok(parsed) = PasswordHash::new(&phc) else { return false };
        Argon2::default().verify_password(password.as_bytes(), &parsed).is_ok() && known
    })
    .await
    .unwrap_or(false);
    Some(matched)
}

pub fn check_policy(password: &str) -> Result<(), String> {
    let chars = password.chars().count();
    if chars < MIN_PASSWORD_CHARS {
        return Err(format!("password needs at least {MIN_PASSWORD_CHARS} characters"));
    }
    if chars > MAX_PASSWORD_CHARS {
        return Err(format!("password may have at most {MAX_PASSWORD_CHARS} characters"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn hash_then_verify() {
        let h = hash("korrekt Pferd Batterie".into()).await.unwrap();
        assert!(h.starts_with("$argon2id$"));
        assert_eq!(verify("korrekt Pferd Batterie".into(), Some(h.clone()), &SHARED).await, Some(true));
        assert_eq!(verify("falsch".into(), Some(h), &TRUSTED).await, Some(false));
    }

    #[tokio::test]
    async fn unknown_user_never_verifies() {
        assert_eq!(verify("anything".into(), None, &SHARED).await, Some(false));
    }

    /// A shared lane full of sign-in checks does not hold up a new password's hash.
    #[tokio::test]
    async fn hashing_does_not_wait_for_the_shared_lane() {
        let threads = u32::try_from(cpus()).unwrap();
        let busy = SHARED.turns.acquire_many(threads).await.unwrap();
        let hashed = tokio::time::timeout(std::time::Duration::from_secs(60), hash("neues Passwort 2026".into())).await;
        drop(busy);
        assert!(hashed.expect("hashing waited for the shared lane").unwrap().starts_with("$argon2id$"));
    }

    /// Beyond its waiters a lane refuses at once instead of queueing without end.
    #[tokio::test]
    async fn a_full_lane_refuses_at_once() {
        let lane = Lane::new(1);
        let busy = lane.turns.acquire().await.unwrap();
        let mut waiting = Vec::new();
        for _ in 0..WAITING_PER_CPU {
            let lane = &lane;
            waiting.push(Box::pin(async move { lane.turn().await.is_some() }));
        }
        // Start every waiter once, so each takes its place in the queue.
        for w in &mut waiting {
            assert!(futures_util::poll!(w.as_mut()).is_pending());
        }
        assert!(lane.turn().await.is_none(), "the queue is full");
        drop(waiting);
        assert_eq!(lane.waiting.load(Ordering::SeqCst), 0, "cancelled waiters leave the queue");
        drop(busy);
        assert!(lane.turn().await.is_some());
    }

    #[test]
    fn policy_counts_characters_not_bytes() {
        // 12 umlauts are 24 bytes but 12 characters.
        assert!(check_policy("ääääääääääää").is_ok());
        assert!(check_policy("äääääääääää").is_err());
    }
}
