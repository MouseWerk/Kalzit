//! Counts sign-in attempts per key (email, client address) in a fixed window.
//!
//! An attempt is counted before the password is checked and refunded when it succeeds. Checking
//! and counting happen under one lock, so parallel requests cannot all pass the check before the
//! first failure is recorded.

use std::collections::HashMap;
use std::sync::Mutex;

use sha2::{Digest, Sha256};

/// Hard cap on tracked keys. Beyond it the oldest entry is dropped, so memory stays bounded no
/// matter how many different keys an attacker sends.
const MAX_ENTRIES: usize = 100_000;

/// Keys are stored as a fixed-size digest, so a huge email in a request costs no memory here.
type KeyDigest = [u8; 16];

pub struct RateLimiter {
    max_attempts: u32,
    window_ms: i64,
    entries: Mutex<HashMap<KeyDigest, Entry>>,
}

#[derive(Clone, Copy)]
struct Entry {
    count: u32,
    window_start: i64,
}

fn digest(key: &str) -> KeyDigest {
    let full = Sha256::digest(key.as_bytes());
    let mut out = [0u8; 16];
    out.copy_from_slice(&full[..16]);
    out
}

impl RateLimiter {
    pub fn new(max_attempts: u32, window_secs: u64) -> Self {
        Self { max_attempts, window_ms: window_secs as i64 * 1000, entries: Mutex::new(HashMap::new()) }
    }

    /// Counts one attempt for every key, or none when any key has used up its attempts.
    pub fn try_acquire(&self, keys: &[&str], now_ms: i64) -> bool {
        let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        let digests: Vec<KeyDigest> = keys.iter().map(|k| digest(k)).collect();
        let blocked = digests.iter().any(|d| {
            entries.get(d).is_some_and(|e| now_ms - e.window_start < self.window_ms && e.count >= self.max_attempts)
        });
        if blocked {
            return false;
        }
        if entries.len() + digests.len() > MAX_ENTRIES {
            self.make_room(&mut entries, now_ms, digests.len());
        }
        for d in digests {
            let entry = entries.entry(d).or_insert(Entry { count: 0, window_start: now_ms });
            if now_ms - entry.window_start >= self.window_ms {
                *entry = Entry { count: 0, window_start: now_ms };
            }
            entry.count += 1;
        }
        true
    }

    /// Gives back the attempt counted for `key` (the sign-in succeeded).
    pub fn refund(&self, key: &str) {
        let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(e) = entries.get_mut(&digest(key)) {
            e.count = e.count.saturating_sub(1);
        }
    }

    /// Forgets `key` entirely (the account proved its password).
    pub fn reset(&self, key: &str) {
        self.entries.lock().unwrap_or_else(|e| e.into_inner()).remove(&digest(key));
    }

    fn make_room(&self, entries: &mut HashMap<KeyDigest, Entry>, now_ms: i64, needed: usize) {
        let window = self.window_ms;
        entries.retain(|_, e| now_ms - e.window_start < window);
        while entries.len() + needed > MAX_ENTRIES {
            let Some(oldest) = entries.iter().min_by_key(|(_, e)| e.window_start).map(|(k, _)| *k) else { break };
            entries.remove(&oldest);
        }
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.entries.lock().unwrap().len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_after_max_attempts_until_window_passes() {
        let rl = RateLimiter::new(3, 60);
        for _ in 0..3 {
            assert!(rl.try_acquire(&["a"], 0));
        }
        assert!(!rl.try_acquire(&["a"], 59_999));
        assert!(rl.try_acquire(&["a"], 60_000));
        assert!(rl.try_acquire(&["b"], 0));
    }

    #[test]
    fn a_blocked_key_counts_nothing_for_the_others() {
        let rl = RateLimiter::new(1, 60);
        assert!(rl.try_acquire(&["email"], 0));
        assert!(!rl.try_acquire(&["email", "ip"], 0));
        assert!(rl.try_acquire(&["ip"], 0), "the refused attempt must not have counted for ip");
    }

    #[test]
    fn refund_and_reset() {
        let rl = RateLimiter::new(1, 60);
        assert!(rl.try_acquire(&["a"], 0));
        rl.refund("a");
        assert!(rl.try_acquire(&["a"], 0));
        rl.reset("a");
        assert!(rl.try_acquire(&["a"], 0));
    }

    #[test]
    fn parallel_attempts_cannot_exceed_the_limit() {
        let rl = std::sync::Arc::new(RateLimiter::new(3, 60));
        let granted: usize = (0..40)
            .map(|_| {
                let rl = rl.clone();
                std::thread::spawn(move || rl.try_acquire(&["a"], 0) as usize)
            })
            .collect::<Vec<_>>()
            .into_iter()
            .map(|h| h.join().unwrap())
            .sum();
        assert_eq!(granted, 3);
    }

    #[test]
    fn memory_is_bounded() {
        let rl = RateLimiter::new(5, 60);
        for i in 0..(MAX_ENTRIES + 500) {
            rl.try_acquire(&[&format!("k{i}")], i as i64);
        }
        assert!(rl.len() <= MAX_ENTRIES);
    }
}
