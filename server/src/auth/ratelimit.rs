//! Counts attempts per key (a client address, an account at an address, an account) in a fixed
//! window. One `RateLimiter` holds one class of keys, so a flood of one class never crowds out
//! another.
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
//! Times are milliseconds of a monotonic clock (`Clock::monotonic_ms`), so a change of the
//! system time neither ends nor stretches a window.
//!
//! The table is bounded, and only entries whose window has ended are dropped, oldest first
//! through an index ordered by window start (no scan). Every key belongs to a network
//! (`network_key`: IPv6 per /48, IPv4 per /24). Up to `SOFT_MAX` entries any new key is taken;
//! beyond, a new key is taken only while its network holds fewer than `NETWORK_SHARE` entries,
//! so the networks that filled the table are refused while a client from any other network is
//! still counted. At `HARD_MAX` every new key is refused until the oldest window ends. A running
//! budget is never pushed out, so a flood can never reset one.

use std::collections::{BTreeSet, HashMap};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use sha2::{Digest, Sha256};

/// Entries any key may take.
const SOFT_MAX: usize = 100_000;
/// Entries beyond `SOFT_MAX` only for networks holding fewer than `NETWORK_SHARE`.
const HARD_MAX: usize = 300_000;
const NETWORK_SHARE: u32 = 16;

/// Keys are stored as a fixed-size digest, so a huge email in a request costs no memory here.
type KeyDigest = [u8; 16];

/// Earlier failures an account may have at one address and that address still count as clean.
/// A clean address is let through a budget that others used up (the setup codes of all
/// addresses, the sign-ins of one IPv6 /48), so someone who mistyped once or twice is not locked
/// out by an attacker elsewhere.
pub const CLEAN_ADDRESS_FAILURES: u32 = 2;

/// The key of a client address for `scope` (`login`, `setup`): IPv4 (also IPv4-mapped IPv6) per
/// address, IPv6 per /64 network.
pub fn address_key(scope: &str, ip: IpAddr) -> String {
    match ip.to_canonical() {
        IpAddr::V4(v4) => format!("ip:{scope}:{v4}"),
        IpAddr::V6(v6) => format!("ip:{scope}:{}/64", masked(v6, 64)),
    }
}

/// The network a client address belongs to: IPv6 per /48 (one site), IPv4 per /24.
pub fn network_key(ip: IpAddr) -> String {
    match ip.to_canonical() {
        IpAddr::V4(v4) => format!("net:{}/24", Ipv4Addr::from(u32::from(v4) & 0xFFFF_FF00)),
        IpAddr::V6(v6) => format!("net:{}/48", masked(v6, 48)),
    }
}

fn masked(ip: Ipv6Addr, prefix: u32) -> Ipv6Addr {
    Ipv6Addr::from(u128::from(ip) & !((1u128 << (128 - prefix)) - 1))
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
    /// Entries per network.
    networks: HashMap<KeyDigest, u32>,
}

#[derive(Clone, Copy)]
struct Entry {
    count: u32,
    window_start: i64,
    network: KeyDigest,
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
            if let Some(e) = self.entries.remove(&key) {
                self.leave(&e.network);
            }
        }
    }

    fn leave(&mut self, network: &KeyDigest) {
        if let Some(n) = self.networks.get_mut(network) {
            *n -= 1;
            if *n == 0 {
                self.networks.remove(network);
            }
        }
    }

    /// Whether a key of `network` the table does not hold yet may be added.
    fn admits(&self, network: &KeyDigest) -> bool {
        let len = self.entries.len();
        len < SOFT_MAX || (len < HARD_MAX && self.networks.get(network).copied().unwrap_or(0) < NETWORK_SHARE)
    }

    /// Counts one attempt for `key`, starting its window when it has none; answers the attempts
    /// before this one. The caller has checked `admits` for a new key.
    fn count(&mut self, key: KeyDigest, network: KeyDigest, now_ms: i64) -> u32 {
        if !self.entries.contains_key(&key) {
            *self.networks.entry(network).or_default() += 1;
            self.by_start.insert((now_ms, key));
            self.entries.insert(key, Entry { count: 0, window_start: now_ms, network });
        }
        let entry = self.entries.get_mut(&key).expect("inserted above");
        let earlier = entry.count;
        entry.count = entry.count.saturating_add(1);
        earlier
    }

    fn remove(&mut self, key: &KeyDigest) {
        if let Some(e) = self.entries.remove(key) {
            self.by_start.remove(&(e.window_start, *key));
            self.leave(&e.network);
        }
    }
}

impl RateLimiter {
    pub fn new(max_attempts: u32, window_secs: u64) -> Self {
        Self { max_attempts, window_ms: window_secs as i64 * 1000, table: Mutex::new(Table::default()) }
    }

    fn lock(&self, now_ms: i64) -> MutexGuard<'_, Table> {
        let mut table = self.table.lock().unwrap_or_else(|e| e.into_inner());
        table.drop_expired(now_ms, self.window_ms);
        table
    }

    /// The wait of an entry that has used up its attempts in a window still running.
    fn blocked(&self, e: &Entry, now_ms: i64) -> Option<Duration> {
        let left = e.window_start + self.window_ms - now_ms;
        (left > 0 && e.count >= self.max_attempts).then(|| whole_secs(left))
    }

    /// The wait for a key the table cannot take: until the oldest window ends at `HARD_MAX`, the
    /// whole window when its network has its share (its own entries may be the newest).
    fn full(&self, table: &Table, now_ms: i64) -> Duration {
        if table.entries.len() >= HARD_MAX {
            let oldest = table.by_start.first().map_or(now_ms, |(start, _)| *start);
            whole_secs(oldest + self.window_ms - now_ms)
        } else {
            whole_secs(self.window_ms)
        }
    }

    /// Whether `key` (of `network`) may try now, without counting: the error is the wait when it
    /// has used up its attempts, or when the table cannot take it (refused rather than not
    /// counted). Answers its attempts in the running window.
    pub fn check(&self, key: &str, network: &str, now_ms: i64) -> Result<u32, Duration> {
        let table = self.lock(now_ms);
        match table.entries.get(&digest(key)) {
            Some(e) => self.blocked(e, now_ms).map_or(Ok(e.count), Err),
            None if table.admits(&digest(network)) => Ok(0),
            None => Err(self.full(&table, now_ms)),
        }
    }

    /// Counts one attempt for `key` (of `network`), unless it has used up its attempts or the
    /// table cannot take it; then the error is the wait (whole seconds, rounded up, at least
    /// one). Answers the attempts in its window before this one.
    pub fn try_acquire(&self, key: &str, network: &str, now_ms: i64) -> Result<u32, Duration> {
        let mut table = self.lock(now_ms);
        let d = digest(key);
        match table.entries.get(&d) {
            Some(e) => {
                if let Some(wait) = self.blocked(e, now_ms) {
                    return Err(wait);
                }
            }
            None if table.admits(&digest(network)) => {}
            None => return Err(self.full(&table, now_ms)),
        }
        Ok(table.count(d, digest(network), now_ms))
    }

    /// Counts one failure for `key` without refusing anything: a budget that decides about other
    /// keys (`wait`, `check`). Answers false when the table cannot take a new key.
    pub fn record(&self, key: &str, network: &str, now_ms: i64) -> bool {
        let mut table = self.lock(now_ms);
        let d = digest(key);
        let network = digest(network);
        if !table.entries.contains_key(&d) && !table.admits(&network) {
            return false;
        }
        table.count(d, network, now_ms);
        true
    }

    /// The wait until `key` may try again, when it has used up its attempts.
    pub fn wait(&self, key: &str, now_ms: i64) -> Option<Duration> {
        self.lock(now_ms).entries.get(&digest(key)).and_then(|e| self.blocked(e, now_ms))
    }

    /// The length of the counting window.
    pub fn window(&self) -> Duration {
        Duration::from_millis(self.window_ms as u64)
    }

    /// Gives back the attempt counted for `key` (the sign-in succeeded).
    pub fn refund(&self, key: &str) {
        let mut table = self.table.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(e) = table.entries.get_mut(&digest(key)) {
            e.count = e.count.saturating_sub(1);
        }
    }

    /// Forgets `key` entirely (the account proved its password).
    pub fn reset(&self, key: &str) {
        self.table.lock().unwrap_or_else(|e| e.into_inner()).remove(&digest(key));
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        let table = self.table.lock().unwrap();
        assert_eq!(table.entries.len(), table.by_start.len(), "the index lists every entry once");
        assert_eq!(table.networks.values().map(|n| *n as usize).sum::<usize>(), table.entries.len());
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
            assert!(rl.try_acquire("a", "n", 0).is_ok());
        }
        assert!(rl.try_acquire("a", "n", 59_999).is_err());
        assert!(rl.try_acquire("a", "n", 60_000).is_ok());
        assert!(rl.try_acquire("b", "n", 0).is_ok());
    }

    #[test]
    fn a_blocked_attempt_names_the_wait_in_whole_seconds() {
        let rl = RateLimiter::new(1, 60);
        assert!(rl.try_acquire("a", "n", 0).is_ok());
        assert_eq!(rl.try_acquire("a", "n", 0), Err(Duration::from_secs(60)));
        // Rounded up: 30.5 seconds left are 31.
        assert_eq!(rl.try_acquire("a", "n", 29_500), Err(Duration::from_secs(31)));
        // At least one second, even in the last millisecond of the window.
        assert_eq!(rl.try_acquire("a", "n", 59_999), Err(Duration::from_secs(1)));
        assert!(rl.try_acquire("a", "n", 60_000).is_ok());
    }

    #[test]
    fn refund_and_reset() {
        let rl = RateLimiter::new(1, 60);
        assert!(rl.try_acquire("a", "n", 0).is_ok());
        rl.refund("a");
        assert!(rl.try_acquire("a", "n", 0).is_ok());
        rl.reset("a");
        assert!(rl.try_acquire("a", "n", 0).is_ok());
        assert_eq!(rl.len(), 1);
    }

    #[test]
    fn parallel_attempts_cannot_exceed_the_limit() {
        let rl = std::sync::Arc::new(RateLimiter::new(3, 60));
        let granted: usize = (0..40)
            .map(|_| {
                let rl = rl.clone();
                std::thread::spawn(move || rl.try_acquire("a", "n", 0).is_ok() as usize)
            })
            .collect::<Vec<_>>()
            .into_iter()
            .map(|h| h.join().unwrap())
            .sum();
        assert_eq!(granted, 3);
    }

    #[test]
    fn addresses_count_per_64_and_networks_per_48_or_24() {
        let ip = |s: &str| s.parse::<IpAddr>().unwrap();
        assert_eq!(address_key("login", ip("2001:db8:1:2::1")), address_key("login", ip("2001:db8:1:2:ffff::9")));
        assert_ne!(address_key("login", ip("2001:db8:1:2::1")), address_key("login", ip("2001:db8:1:3::1")));
        assert_eq!(address_key("login", ip("2001:db8:1:2::1")), "ip:login:2001:db8:1:2::/64");
        assert_eq!(address_key("login", ip("::ffff:203.0.113.7")), "ip:login:203.0.113.7");
        assert_ne!(address_key("login", ip("203.0.113.7")), address_key("login", ip("203.0.113.8")));
        assert_ne!(address_key("login", ip("203.0.113.7")), address_key("setup", ip("203.0.113.7")));
        assert_eq!(network_key(ip("2001:db8:1:2::1")), "net:2001:db8:1::/48");
        assert_eq!(network_key(ip("2001:db8:1:ffff::1")), network_key(ip("2001:db8:1:2::1")));
        assert_ne!(network_key(ip("2001:db8:2::1")), network_key(ip("2001:db8:1::1")));
        assert_eq!(network_key(ip("::ffff:203.0.113.7")), "net:203.0.113.0/24");
    }

    /// Fills the table to `SOFT_MAX` from 1000 networks of 100 keys each.
    fn filled() -> RateLimiter {
        let rl = RateLimiter::new(2, 60);
        for i in 0..SOFT_MAX {
            let net = format!("attacker-{}", i / 100);
            assert!(rl.try_acquire(&format!("k{i}"), &net, 0).is_ok());
        }
        rl
    }

    /// Beyond `SOFT_MAX`, the networks that filled the table get no new keys, while a client
    /// from another network is still counted, and running budgets stay.
    #[test]
    fn a_full_table_refuses_the_networks_that_filled_it_and_takes_others() {
        let rl = filled();
        assert_eq!(rl.try_acquire("new", "attacker-7", 1_000), Err(Duration::from_secs(60)));
        assert!(!rl.record("new", "attacker-7", 1_000));
        assert!(rl.check("new", "attacker-7", 1_000).is_err());
        // A known key of a full network goes on counting, and is refused once used up.
        assert_eq!(rl.try_acquire("k700", "attacker-7", 1_000), Ok(1));
        assert!(rl.try_acquire("k700", "attacker-7", 1_000).is_err());
        // Another network gets its share, then is refused too.
        for i in 0..NETWORK_SHARE {
            assert_eq!(rl.check(&format!("clean{i}"), "clean", 1_000), Ok(0));
            assert!(rl.try_acquire(&format!("clean{i}"), "clean", 1_000).is_ok());
        }
        assert!(rl.try_acquire("clean-more", "clean", 1_000).is_err());
        assert!(rl.try_acquire("other", "elsewhere", 1_000).is_ok());
        assert_eq!(rl.len(), SOFT_MAX + NETWORK_SHARE as usize + 1);
        // Once the flood's windows end, everything is taken again.
        assert!(rl.try_acquire("new", "attacker-7", 60_000).is_ok());
        assert_eq!(rl.len(), NETWORK_SHARE as usize + 2);
    }

    #[test]
    fn at_the_hard_cap_every_new_key_waits_for_the_oldest_window() {
        let rl = RateLimiter::new(2, 60);
        for i in 0..HARD_MAX {
            // Networks of one key each, so the share never stops them.
            assert!(rl.try_acquire(&format!("k{i}"), &format!("n{i}"), (i / SOFT_MAX) as i64 * 10_000).is_ok());
        }
        assert_eq!(rl.try_acquire("new", "fresh", 30_000), Err(Duration::from_secs(30)));
        assert!(rl.try_acquire("k5", "n5", 30_000).is_ok(), "a known key still counts");
        assert!(rl.try_acquire("new", "fresh", 60_000).is_ok(), "the oldest windows ended");
    }

    #[test]
    fn expired_entries_are_dropped_oldest_first() {
        let rl = RateLimiter::new(1, 60);
        assert!(rl.try_acquire("a", "n", 0).is_ok());
        assert!(rl.try_acquire("b", "n", 30_000).is_ok());
        assert_eq!(rl.len(), 2);
        assert!(rl.try_acquire("c", "n", 60_000).is_ok());
        assert_eq!(rl.len(), 2, "the window of a has ended");
        assert!(rl.try_acquire("b", "n", 60_000).is_err(), "the window of b is still running");
        rl.reset("b");
        assert_eq!(rl.len(), 1);
    }

    #[test]
    fn counting_answers_the_earlier_attempts_and_record_never_refuses() {
        let rl = RateLimiter::new(3, 60);
        assert_eq!(rl.try_acquire("a", "n", 0), Ok(0));
        assert_eq!(rl.try_acquire("a", "n", 0), Ok(1));
        assert_eq!(rl.check("a", "n", 0), Ok(2));
        for _ in 0..5 {
            assert!(rl.record("c", "n", 0));
        }
        assert_eq!(rl.wait("c", 0), Some(Duration::from_secs(60)));
        assert_eq!(rl.check("c", "n", 0), Err(Duration::from_secs(60)));
        assert_eq!(rl.wait("c", 60_000), None);
    }
}
