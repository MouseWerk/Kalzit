//! Password hashing with Argon2id. Hashing is CPU-heavy, so it runs on the blocking pool.

use std::sync::LazyLock;

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

/// Hashes and verifications running at once, one per CPU: more would only queue on the blocking
/// pool and take its threads from everything else. Further ones wait their turn.
static HASHING: LazyLock<tokio::sync::Semaphore> =
    LazyLock::new(|| tokio::sync::Semaphore::new(std::thread::available_parallelism().map_or(2, |n| n.get())));

pub async fn hash(password: String) -> Result<String, String> {
    let _turn = HASHING.acquire().await.map_err(|e| e.to_string())?;
    tokio::task::spawn_blocking(move || hash_blocking(&password)).await.map_err(|e| e.to_string())?
}

/// True when `password` matches `stored`. A missing hash (unknown user) still costs one
/// verification and returns false.
pub async fn verify(password: String, stored: Option<String>) -> bool {
    let Ok(_turn) = HASHING.acquire().await else { return false };
    tokio::task::spawn_blocking(move || {
        let known = stored.is_some();
        let phc = stored.unwrap_or_else(|| DUMMY_HASH.clone());
        let Ok(parsed) = PasswordHash::new(&phc) else { return false };
        Argon2::default().verify_password(password.as_bytes(), &parsed).is_ok() && known
    })
    .await
    .unwrap_or(false)
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
        assert!(verify("korrekt Pferd Batterie".into(), Some(h.clone())).await);
        assert!(!verify("falsch".into(), Some(h)).await);
    }

    #[tokio::test]
    async fn unknown_user_never_verifies() {
        assert!(!verify("anything".into(), None).await);
    }

    #[test]
    fn policy_counts_characters_not_bytes() {
        // 12 umlauts are 24 bytes but 12 characters.
        assert!(check_policy("ääääääääääää").is_ok());
        assert!(check_policy("äääääääääää").is_err());
    }
}
