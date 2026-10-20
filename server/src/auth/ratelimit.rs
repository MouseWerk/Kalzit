//! Counts failed sign-ins per key (email, client address) in a fixed window.

use std::collections::HashMap;
use std::sync::Mutex;

/// Above this many tracked keys, expired entries are dropped on the next write.
const PRUNE_THRESHOLD: usize = 10_000;

pub struct RateLimiter {
    max_failures: u32,
    window_ms: i64,
    entries: Mutex<HashMap<String, (u32, i64)>>,
}

impl RateLimiter {
    pub fn new(max_failures: u32, window_secs: u64) -> Self {
        Self { max_failures, window_ms: window_secs as i64 * 1000, entries: Mutex::new(HashMap::new()) }
    }

    pub fn is_blocked(&self, key: &str, now_ms: i64) -> bool {
        let entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        match entries.get(key) {
            Some(&(count, start)) => now_ms - start < self.window_ms && count >= self.max_failures,
            None => false,
        }
    }

    pub fn record_failure(&self, key: &str, now_ms: i64) {
        let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        if entries.len() > PRUNE_THRESHOLD {
            let window = self.window_ms;
            entries.retain(|_, entry| now_ms - entry.1 < window);
        }
        let entry = entries.entry(key.to_string()).or_insert((0, now_ms));
        if now_ms - entry.1 >= self.window_ms {
            *entry = (0, now_ms);
        }
        entry.0 += 1;
    }

    pub fn reset(&self, key: &str) {
        self.entries.lock().unwrap_or_else(|e| e.into_inner()).remove(key);
    }
}

#[cfg(test)]
mod tests {
    use super::RateLimiter;

    #[test]
    fn blocks_after_max_failures_until_window_passes() {
        let rl = RateLimiter::new(3, 60);
        for _ in 0..3 {
            assert!(!rl.is_blocked("a", 0));
            rl.record_failure("a", 0);
        }
        assert!(rl.is_blocked("a", 59_999));
        assert!(!rl.is_blocked("a", 60_000));
        assert!(!rl.is_blocked("b", 0));
    }

    #[test]
    fn reset_clears_the_key() {
        let rl = RateLimiter::new(1, 60);
        rl.record_failure("a", 0);
        rl.reset("a");
        assert!(!rl.is_blocked("a", 0));
    }
}
