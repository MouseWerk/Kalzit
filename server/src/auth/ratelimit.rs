//! Counts sign-in attempts per key (email, client address) in a fixed window.
//!
//! A refused attempt learns how long to wait; the API sends it as `Retry-After` and
//! `retryAfterSecs` (`ApiError::rate_limited`).
//!
//! An attempt is counted before the password is checked and refunded when it succeeds. Checking
//! and counting happen under one lock, so parallel requests cannot all pass the check before the
//! first failure is recorded.
//!
//! Client addresses are keys made by `address_key`: an IPv6 client is counted per /64, the
//! smallest network one subscriber usually gets, so changing the low bits buys no new attempts.
//!
//! The table is bounded. Only entries whose window has ended are dropped to make room, oldest
//! first through an index ordered by window start, so making room needs no scan. When the table
//! is still full, attempts with keys it does not know yet are refused until the oldest window
//! ends: a flood of new keys can never push out (and so reset) a budget that is still counting.

use std::collections::{BTreeSet, HashMap};
use std::net::{IpAddr, Ipv6Addr};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use sha2::{Digest, Sha256};

/// Hard cap on tracked keys, so memory stays bounded no matter how many different keys an
/// attacker sends.
const MAX_ENTRIES: usize = 100_000;

/// Keys are stored as a fixed-size digest, so a huge email in a request costs no memory here.
type KeyDigest = [u8; 16];

/// Earlier failures a client address may have and still count as clean. A clean address is let
/// through a budget that others used up (the setup codes of all addresses, the sign-ins of one
/// account), so someone who mistyped once or twice is not locked out by an attacker elsewhere.
pub const CLEAN_ADDRESS_FAILURES: u32 = 2;

/// The key of a client address for `scope` (`login`, `setup`): IPv4 (also IPv4-mapped IPv6) per
/// address, IPv6 per /64 network.
pub fn address_key(scope: &str, ip: IpAddr) -> String {
    match ip.to_canonical() {
        IpAddr::V4(v4) => format!("ip:{scope}:{v4}"),
        IpAddr::V6(v6) => {
            let net = Ipv6Addr::from(u128::from(v6) & !((1u128 << 64) - 1));
            format!("ip:{scope}:{net}/64")
        }
    }
}

/// The key of an account's failed sign-ins and password checks (`AppState::account_limiter`).
pub fn account_key(email: &str) -> String {
    format!("email:{email}")
}

pub struct RateLimiter {
    max_attempts: u32,
    window_ms: i64,
    table: Mutex<Table>,
}

#[derive(Default)]
struct Table {
    entries: HashMap<KeyDigest, Entry>,
    /// The same entries ordered by window start, so the expired ones are found without a scan.
    by_start: BTreeSet<(i64, KeyDigest)>,
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

/// A wait in whole seconds: rounded up, at least one.
fn whole_secs(ms: i64) -> Duration {
    Duration::from_secs((ms.max(1) as u64).div_ceil(1000))
}

impl Table {
    /// Drops every entry whose window has ended, oldest first; stops at the first live one.
    fn drop_expired(&mut self, now_ms: i64, window_ms: i64) {
        while let Some(&(start, key)) = self.by_start.first() {
            if now_ms - start < window_ms {
                break;
            }
            self.by_start.pop_first();
            self.entries.remove(&key);
        }
    }

    /// Counts one attempt for `key`, starting its window when it has none; answers the attempts
    /// before this one.
    fn count(&mut self, key: KeyDigest, now_ms: i64) -> u32 {
        let entry = self.entries.entry(key).or_insert(Entry { count: 0, window_start: now_ms });
        let earlier = entry.count;
        entry.count = entry.count.saturating_add(1);
        let start = entry.window_start;
        self.by_start.insert((start, key));
        earlier
    }

    fn remove(&mut self, key: &KeyDigest) {
        if let Some(e) = self.entries.remove(key) {
            self.by_start.remove(&(e.window_start, *key));
        }
    }
}

impl RateLimiter {
    pub fn new(max_attempts: u32, window_secs: u64) -> Self {
        Self { max_attempts, window_ms: window_secs as i64 * 1000, table: Mutex::new(Table::default()) }
    }

    fn lock(&self) -> MutexGuard<'_, Table> {
        self.table.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The wait of an entry that has used up its attempts in a window still running.
    fn blocked(&self, e: &Entry, now_ms: i64) -> Option<Duration> {
        let left = e.window_start + self.window_ms - now_ms;
        (left > 0 && e.count >= self.max_attempts).then(|| whole_secs(left))
    }

    /// Counts one attempt for every key, or none when any key has used up its attempts. Then the
    /// error is the wait until all blocked keys have a new window: the longest remaining window,
    /// in whole seconds (rounded up, at least one).
    pub fn try_acquire(&self, keys: &[&str], now_ms: i64) -> Result<(), Duration> {
        self.try_acquire_counting(keys, now_ms).map(|_| ())
    }

    /// `try_acquire`, answering for each key the attempts in its window before this one. A key the
    /// table does not know yet is refused while the table is full of running windows, with the
    /// wait until the oldest of them ends.
    pub fn try_acquire_counting(&self, keys: &[&str], now_ms: i64) -> Result<Vec<u32>, Duration> {
        let mut table = self.lock();
        table.drop_expired(now_ms, self.window_ms);
        let digests: Vec<KeyDigest> = keys.iter().map(|k| digest(k)).collect();
        let wait = digests.iter().filter_map(|d| table.entries.get(d)).filter_map(|e| self.blocked(e, now_ms)).max();
        if let Some(wait) = wait {
            return Err(wait);
        }
        let new = digests.iter().filter(|d| !table.entries.contains_key(*d)).count();
        if new > 0 && table.entries.len() + new > MAX_ENTRIES {
            let oldest = table.by_start.first().map_or(now_ms, |(start, _)| *start);
            return Err(whole_secs(oldest + self.window_ms - now_ms));
        }
        Ok(digests.into_iter().map(|d| table.count(d, now_ms)).collect())
    }

    /// Counts one failure for `key` without refusing anything: a budget that decides about other
    /// keys (`wait`). A key the full table does not know is not counted.
    pub fn record(&self, key: &str, now_ms: i64) {
        let mut table = self.lock();
        table.drop_expired(now_ms, self.window_ms);
        let d = digest(key);
        if table.entries.len() >= MAX_ENTRIES && !table.entries.contains_key(&d) {
            return;
        }
        table.count(d, now_ms);
    }

    /// The wait until `key` may try again, when it has used up its attempts.
    pub fn wait(&self, key: &str, now_ms: i64) -> Option<Duration> {
        self.lock().entries.get(&digest(key)).and_then(|e| self.blocked(e, now_ms))
    }

    /// The length of the counting window.
    pub fn window(&self) -> Duration {
        Duration::from_millis(self.window_ms as u64)
    }

    /// Gives back the attempt counted for `key` (the sign-in succeeded).
    pub fn refund(&self, key: &str) {
        if let Some(e) = self.lock().entries.get_mut(&digest(key)) {
            e.count = e.count.saturating_sub(1);
        }
    }

    /// Forgets `key` entirely (the account proved its password).
    pub fn reset(&self, key: &str) {
        self.lock().remove(&digest(key));
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        let table = self.lock();
        assert_eq!(table.entries.len(), table.by_start.len(), "the index lists every entry once");
        table.entries.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_after_max_attempts_until_window_passes() {
        let rl = RateLimiter::new(3, 60);
        for _ in 0..3 {
            assert!(rl.try_acquire(&["a"], 0).is_ok());
        }
        assert!(rl.try_acquire(&["a"], 59_999).is_err());
        assert!(rl.try_acquire(&["a"], 60_000).is_ok());
        assert!(rl.try_acquire(&["b"], 0).is_ok());
    }

    #[test]
    fn a_blocked_attempt_names_the_wait_in_whole_seconds() {
        let rl = RateLimiter::new(1, 60);
        assert!(rl.try_acquire(&["a"], 0).is_ok());
        assert_eq!(rl.try_acquire(&["a"], 0), Err(Duration::from_secs(60)));
        // Rounded up: 30.5 seconds left are 31.
        assert_eq!(rl.try_acquire(&["a"], 29_500), Err(Duration::from_secs(31)));
        // At least one second, even in the last millisecond of the window.
        assert_eq!(rl.try_acquire(&["a"], 59_999), Err(Duration::from_secs(1)));
        assert!(rl.try_acquire(&["a"], 60_000).is_ok());

        // Of several blocked keys, the one whose window ends last decides.
        let rl = RateLimiter::new(1, 60);
        assert!(rl.try_acquire(&["early"], 0).is_ok());
        assert!(rl.try_acquire(&["late"], 20_000).is_ok());
        assert_eq!(rl.try_acquire(&["early", "late", "free"], 30_000), Err(Duration::from_secs(50)));
        assert_eq!(rl.try_acquire(&["early", "free"], 30_000), Err(Duration::from_secs(30)));
    }

    #[test]
    fn a_blocked_key_counts_nothing_for_the_others() {
        let rl = RateLimiter::new(1, 60);
        assert!(rl.try_acquire(&["email"], 0).is_ok());
        assert!(rl.try_acquire(&["email", "ip"], 0).is_err());
        assert!(rl.try_acquire(&["ip"], 0).is_ok(), "the refused attempt must not have counted for ip");
    }

    #[test]
    fn refund_and_reset() {
        let rl = RateLimiter::new(1, 60);
        assert!(rl.try_acquire(&["a"], 0).is_ok());
        rl.refund("a");
        assert!(rl.try_acquire(&["a"], 0).is_ok());
        rl.reset("a");
        assert!(rl.try_acquire(&["a"], 0).is_ok());
    }

    #[test]
    fn parallel_attempts_cannot_exceed_the_limit() {
        let rl = std::sync::Arc::new(RateLimiter::new(3, 60));
        let granted: usize = (0..40)
            .map(|_| {
                let rl = rl.clone();
                std::thread::spawn(move || rl.try_acquire(&["a"], 0).is_ok() as usize)
            })
            .collect::<Vec<_>>()
            .into_iter()
            .map(|h| h.join().unwrap())
            .sum();
        assert_eq!(granted, 3);
    }

    #[test]
    fn ipv6_clients_count_per_64_and_ipv4_per_address() {
        let ip = |s: &str| s.parse::<IpAddr>().unwrap();
        assert_eq!(address_key("login", ip("2001:db8:1:2::1")), address_key("login", ip("2001:db8:1:2:ffff::9")));
        assert_ne!(address_key("login", ip("2001:db8:1:2::1")), address_key("login", ip("2001:db8:1:3::1")));
        assert_eq!(address_key("login", ip("2001:db8:1:2::1")), "ip:login:2001:db8:1:2::/64");
        assert_eq!(address_key("login", ip("::ffff:203.0.113.7")), "ip:login:203.0.113.7");
        assert_ne!(address_key("login", ip("203.0.113.7")), address_key("login", ip("203.0.113.8")));
        assert_ne!(address_key("login", ip("203.0.113.7")), address_key("setup", ip("203.0.113.7")));

        let rl = RateLimiter::new(2, 60);
        let a = address_key("login", ip("2001:db8::1"));
        let b = address_key("login", ip("2001:db8::abcd:1"));
        assert!(rl.try_acquire(&[&a], 0).is_ok() && rl.try_acquire(&[&b], 0).is_ok());
        assert!(rl.try_acquire(&[&a], 0).is_err(), "the whole /64 shares one budget");
    }

    /// A flood of new keys never resets a budget that is still counting: once the table is full
    /// of running windows, new keys are refused until the oldest window ends, and known keys go
    /// on counting.
    #[test]
    fn a_flood_of_new_keys_fails_closed_and_never_resets_a_budget() {
        let rl = RateLimiter::new(2, 60);
        assert!(rl.try_acquire(&["email:opfer@example.de"], 0).is_ok());
        assert!(rl.try_acquire(&["email:opfer@example.de"], 0).is_ok());
        assert!(rl.try_acquire(&["known"], 0).is_ok());
        let mut refused = 0;
        for i in 0..(MAX_ENTRIES as u32 + 10) {
            let ip = IpAddr::V6(Ipv6Addr::from(u128::from(i) << 64));
            if rl.try_acquire(&[&address_key("login", ip)], 1_000).is_err() {
                refused += 1;
            }
        }
        assert_eq!(rl.len(), MAX_ENTRIES);
        assert_eq!(refused, 12, "only the new keys past the cap are refused");
        assert!(rl.try_acquire(&["email:opfer@example.de"], 2_000).is_err(), "the used-up budget must stay");
        assert!(rl.try_acquire(&["known"], 2_000).is_ok(), "a known key still counts");
        // A new key waits for the oldest window (started at 0) to end.
        assert_eq!(rl.try_acquire(&["new"], 2_000), Err(Duration::from_secs(58)));
        rl.record("new", 2_000);
        assert_eq!(rl.len(), MAX_ENTRIES, "a full table records no new key either");
        // Once the oldest windows end, their entries make room.
        assert!(rl.try_acquire(&["new"], 60_000).is_ok());
        assert!(rl.try_acquire(&["email:opfer@example.de"], 60_000).is_ok());
    }

    #[test]
    fn expired_entries_are_dropped_oldest_first() {
        let rl = RateLimiter::new(1, 60);
        assert!(rl.try_acquire(&["a"], 0).is_ok());
        assert!(rl.try_acquire(&["b"], 30_000).is_ok());
        assert_eq!(rl.len(), 2);
        assert!(rl.try_acquire(&["c"], 60_000).is_ok());
        assert_eq!(rl.len(), 2, "the window of a has ended");
        assert!(rl.try_acquire(&["b"], 60_000).is_err(), "the window of b is still running");
        rl.reset("b");
        assert_eq!(rl.len(), 1);
    }

    #[test]
    fn counting_answers_the_earlier_attempts_and_record_never_refuses() {
        let rl = RateLimiter::new(3, 60);
        assert_eq!(rl.try_acquire_counting(&["a", "b"], 0), Ok(vec![0, 0]));
        assert_eq!(rl.try_acquire_counting(&["a"], 0), Ok(vec![1]));
        assert_eq!(rl.try_acquire_counting(&["a", "b"], 0), Ok(vec![2, 1]));
        for _ in 0..5 {
            rl.record("c", 0);
        }
        assert_eq!(rl.wait("c", 0), Some(Duration::from_secs(60)));
        assert_eq!(rl.wait("c", 60_000), None);
    }

    #[test]
    fn memory_is_bounded() {
        let rl = RateLimiter::new(5, 60);
        for i in 0..(MAX_ENTRIES + 500) {
            let _ = rl.try_acquire(&[&format!("k{i}")], i as i64);
        }
        assert!(rl.len() <= MAX_ENTRIES);
    }
}
