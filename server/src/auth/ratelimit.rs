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
//! The table is bounded. Entries whose window has ended are dropped, oldest first through an
//! index ordered by window start (no scan). Every key belongs to a network (`network_key`: IPv6
//! per /48, IPv4 per /24):
//!
//! - a network holding fewer than `NETWORK_SHARE` entries always gets its new key. When the table
//!   is at `HARD_MAX`, room is made by dropping the oldest entry that has not used up its
//!   attempts from the network with the most such entries: a flood pushes out its own entries.
//!   An entry that has used up its attempts is never dropped before its window ends;
//! - a network holding more gets new keys only up to `SOFT_MAX` entries.
//!
//! So a client from a network that is not flooding is always counted, and a used-up budget is
//! never reset by a flood.

use std::collections::{BTreeSet, HashMap};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use sha2::{Digest, Sha256};

/// Entries any network may add to.
const SOFT_MAX: usize = 100_000;
/// The size of the table; beyond `SOFT_MAX` only networks holding fewer than `NETWORK_SHARE`.
const HARD_MAX: usize = 300_000;
const NETWORK_SHARE: u32 = 16;

/// Keys are stored as a fixed-size digest, so a huge email in a request costs no memory here.
type KeyDigest = [u8; 16];

/// Earlier failures that still count as clean. A clean client is let through a budget that
/// others used up (the setup codes of all addresses, the sign-ins of one IPv6 /48), so someone
/// who mistyped once or twice is not locked out by an attacker elsewhere.
pub const CLEAN_ADDRESS_FAILURES: u32 = 2;

/// Password checks of one account at the same moment (`InFlight`).
pub const MAX_IN_FLIGHT_PER_ACCOUNT: u32 = 2;

/// The key of a client address for `scope` (`login`, `setup`): IPv4 (also IPv4-mapped IPv6) per
/// address, IPv6 per /64 network.
pub fn address_key(scope: &str, ip: IpAddr) -> String {
    match ip.to_canonical() {
        IpAddr::V4(v4) => format!("ip:{scope}:{v4}"),
        IpAddr::V6(v6) => format!("ip:{scope}:{}/64", masked(v6, 64)),
    }
}

/// The key of a client's site for `scope`: IPv4 per address, IPv6 per /48, for budgets where a
/// site should not get more tries by using more of its /64 networks (setup codes).
pub fn site_key(scope: &str, ip: IpAddr) -> String {
    match ip.to_canonical() {
        IpAddr::V4(v4) => format!("ip:{scope}:{v4}"),
        IpAddr::V6(v6) => format!("ip:{scope}:{}/48", masked(v6, 48)),
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
    networks: HashMap<KeyDigest, Network>,
    /// Networks by how many of their entries may be dropped to make room.
    by_droppable: BTreeSet<(usize, KeyDigest)>,
}

#[derive(Default)]
struct Network {
    entries: u32,
    /// Its entries that have not used up their attempts, by window start.
    droppable: BTreeSet<(i64, KeyDigest)>,
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
    /// Moves `key` into or out of its network's droppable entries.
    fn set_droppable(&mut self, key: KeyDigest, droppable: bool) {
        let Some(e) = self.entries.get(&key).copied() else { return };
        let Some(net) = self.networks.get_mut(&e.network) else { return };
        let before = net.droppable.len();
        if droppable {
            net.droppable.insert((e.window_start, key));
        } else {
            net.droppable.remove(&(e.window_start, key));
        }
        let after = net.droppable.len();
        if before != after {
            self.by_droppable.remove(&(before, e.network));
            if after > 0 {
                self.by_droppable.insert((after, e.network));
            }
        }
    }

    fn remove(&mut self, key: &KeyDigest) {
        self.set_droppable(*key, false);
        let Some(e) = self.entries.remove(key) else { return };
        self.by_start.remove(&(e.window_start, *key));
        if let Some(net) = self.networks.get_mut(&e.network) {
            net.entries -= 1;
            if net.entries == 0 {
                self.networks.remove(&e.network);
            }
        }
    }

    /// Drops every entry whose window has ended, oldest first; stops at the first live one.
    fn drop_expired(&mut self, now_ms: i64, window_ms: i64) {
        while let Some(&(start, key)) = self.by_start.first() {
            if now_ms - start < window_ms {
                break;
            }
            self.remove(&key);
        }
    }

    fn network_entries(&self, network: &KeyDigest) -> u32 {
        self.networks.get(network).map_or(0, |n| n.entries)
    }

    /// Makes room for a new key of `network`, or answers false when it may not have one: a
    /// network with its share gets none beyond `SOFT_MAX`; at `HARD_MAX` an entry that may be
    /// dropped goes, from the network with the most of them.
    fn make_room(&mut self, network: &KeyDigest) -> bool {
        let len = self.entries.len();
        if self.network_entries(network) >= NETWORK_SHARE {
            return len < SOFT_MAX;
        }
        if len < HARD_MAX {
            return true;
        }
        let Some(&(_, largest)) = self.by_droppable.last() else { return false };
        let Some(&(_, key)) = self.networks.get(&largest).and_then(|n| n.droppable.first()) else { return false };
        self.remove(&key);
        true
    }

    /// Counts one attempt for `key`, starting its window when it has none; answers the attempts
    /// before this one. The caller has made room for a new key.
    fn count(&mut self, key: KeyDigest, network: KeyDigest, now_ms: i64, max: u32) -> u32 {
        if !self.entries.contains_key(&key) {
            self.networks.entry(network).or_default().entries += 1;
            self.by_start.insert((now_ms, key));
            self.entries.insert(key, Entry { count: 0, window_start: now_ms, network });
        }
        let entry = self.entries.get_mut(&key).expect("inserted above");
        let earlier = entry.count;
        entry.count = entry.count.saturating_add(1);
        let droppable = entry.count < max;
        self.set_droppable(key, droppable);
        earlier
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

    /// The wait for a key the table cannot take: the whole window for a network with its share
    /// (its own entries may be the newest), else until the oldest window ends (the table holds
    /// only used-up entries).
    fn full(&self, table: &Table, network: &KeyDigest, now_ms: i64) -> Duration {
        if table.network_entries(network) >= NETWORK_SHARE {
            whole_secs(self.window_ms)
        } else {
            let oldest = table.by_start.first().map_or(now_ms, |(start, _)| *start);
            whole_secs(oldest + self.window_ms - now_ms)
        }
    }

    /// Counts one attempt for `key` (of `network`), unless it has used up its attempts or the
    /// table cannot take it; then the error is the wait (whole seconds, rounded up, at least
    /// one). Answers the attempts in its window before this one.
    pub fn try_acquire(&self, key: &str, network: &str, now_ms: i64) -> Result<u32, Duration> {
        let mut table = self.lock(now_ms);
        let (d, network) = (digest(key), digest(network));
        match table.entries.get(&d) {
            Some(e) => {
                if let Some(wait) = self.blocked(e, now_ms) {
                    return Err(wait);
                }
            }
            None => {
                if !table.make_room(&network) {
                    return Err(self.full(&table, &network, now_ms));
                }
            }
        }
        Ok(table.count(d, network, now_ms, self.max_attempts))
    }

    /// Counts one attempt for `key` without refusing it, even when used up. Answers false when
    /// the table cannot take a new key.
    pub fn record(&self, key: &str, network: &str, now_ms: i64) -> bool {
        let mut table = self.lock(now_ms);
        let (d, network) = (digest(key), digest(network));
        if !table.entries.contains_key(&d) && !table.make_room(&network) {
            return false;
        }
        table.count(d, network, now_ms, self.max_attempts);
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

    /// Gives back an attempt counted for `key` (the sign-in succeeded).
    pub fn refund(&self, key: &str) {
        let mut table = self.table.lock().unwrap_or_else(|e| e.into_inner());
        let d = digest(key);
        if let Some(e) = table.entries.get_mut(&d) {
            e.count = e.count.saturating_sub(1);
            let droppable = e.count < self.max_attempts;
            table.set_droppable(d, droppable);
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
        let per_network: usize = table.networks.values().map(|n| n.entries as usize).sum();
        assert_eq!(per_network, table.entries.len());
        let droppable: usize = table.networks.values().map(|n| n.droppable.len()).sum();
        let ranked: usize = table.by_droppable.iter().map(|(n, _)| *n).sum();
        assert_eq!(droppable, ranked, "the ranking matches the networks");
        table.entries.len()
    }
}

/// Password checks in flight per account: at most `MAX_IN_FLIGHT_PER_ACCOUNT` at once, so
/// parallel guesses cannot all start before the first failure is counted, and cannot tie up the
/// hashing threads for one account.
#[derive(Default)]
pub struct InFlight(Mutex<HashMap<KeyDigest, u32>>);

/// One check in flight; ends when dropped.
pub struct InFlightGuard<'a> {
    owner: &'a InFlight,
    key: KeyDigest,
}

impl InFlight {
    /// A slot for `key`, or `None` when it has its checks in flight already.
    pub fn enter(&self, key: &str) -> Option<InFlightGuard<'_>> {
        let key = digest(key);
        let mut map = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let n = map.entry(key).or_default();
        if *n >= MAX_IN_FLIGHT_PER_ACCOUNT {
            return None;
        }
        *n += 1;
        Some(InFlightGuard { owner: self, key })
    }

    /// `enter`, waiting up to `IN_FLIGHT_WAIT` for a slot, so a few sign-ins of one account at
    /// the same moment (several tabs, a double click) are served one after the other instead of
    /// refused; `None` when no slot came free in that time.
    pub async fn enter_soon(&self, key: &str) -> Option<InFlightGuard<'_>> {
        let deadline = tokio::time::Instant::now() + IN_FLIGHT_WAIT;
        loop {
            if let Some(guard) = self.enter(key) {
                return Some(guard);
            }
            if tokio::time::Instant::now() >= deadline {
                return None;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
}

/// How long a password check waits for a slot of its account (`InFlight::enter_soon`).
const IN_FLIGHT_WAIT: Duration = Duration::from_secs(2);

impl Drop for InFlightGuard<'_> {
    fn drop(&mut self) {
        let mut map = self.owner.0.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(n) = map.get_mut(&self.key) {
            *n -= 1;
            if *n == 0 {
                map.remove(&self.key);
            }
        }
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
        assert_eq!(rl.len(), 2);
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
        assert_eq!(site_key("setup", ip("2001:db8:1:2::1")), "ip:setup:2001:db8:1::/48");
        assert_eq!(site_key("setup", ip("2001:db8:1:ffff::1")), site_key("setup", ip("2001:db8:1:2::1")));
        assert_eq!(site_key("setup", ip("203.0.113.7")), "ip:setup:203.0.113.7");
        assert_eq!(network_key(ip("2001:db8:1:2::1")), "net:2001:db8:1::/48");
        assert_eq!(network_key(ip("2001:db8:1:ffff::1")), network_key(ip("2001:db8:1:2::1")));
        assert_ne!(network_key(ip("2001:db8:2::1")), network_key(ip("2001:db8:1::1")));
        assert_eq!(network_key(ip("::ffff:203.0.113.7")), "net:203.0.113.0/24");
    }

    /// Beyond `SOFT_MAX`, the networks that filled the table get no new keys, while a client
    /// from another network is still counted, and running budgets stay.
    #[test]
    fn a_full_table_refuses_the_networks_that_filled_it_and_takes_others() {
        let rl = RateLimiter::new(2, 60);
        for i in 0..SOFT_MAX {
            assert!(rl.try_acquire(&format!("k{i}"), &format!("attacker-{}", i / 100), 0).is_ok());
        }
        assert_eq!(rl.try_acquire("new", "attacker-7", 1_000), Err(Duration::from_secs(60)));
        assert!(!rl.record("new", "attacker-7", 1_000));
        // A known key of a full network goes on counting, and is refused once used up.
        assert_eq!(rl.try_acquire("k700", "attacker-7", 1_000), Ok(1));
        assert!(rl.try_acquire("k700", "attacker-7", 1_000).is_err());
        // Another network gets its share, then is refused too.
        for i in 0..NETWORK_SHARE {
            assert!(rl.try_acquire(&format!("clean{i}"), "clean", 1_000).is_ok());
        }
        assert!(rl.try_acquire("clean-more", "clean", 1_000).is_err());
        assert!(rl.try_acquire("other", "elsewhere", 1_000).is_ok());
        assert_eq!(rl.len(), SOFT_MAX + NETWORK_SHARE as usize + 1);
        // Once the flood's windows end, everything is taken again.
        assert!(rl.try_acquire("new", "attacker-7", 60_000).is_ok());
        assert_eq!(rl.len(), NETWORK_SHARE as usize + 2);
    }

    /// At `HARD_MAX` (filled from 30 000 networks of 10 entries), a fresh network still gets its
    /// key: room is made from the network with the most entries that may be dropped, never from
    /// an entry that has used up its attempts.
    #[test]
    fn at_the_hard_cap_a_fresh_network_pushes_out_the_flood() {
        let rl = RateLimiter::new(2, 60);
        for i in 0..HARD_MAX {
            assert!(rl.try_acquire(&format!("k{i}"), &format!("n{}", i / 10), 0).is_ok());
        }
        // One network's keys use up their attempts.
        for i in 0..10 {
            assert!(rl.try_acquire(&format!("k{i}"), "n0", 0).is_ok());
        }
        assert_eq!(rl.len(), HARD_MAX);
        for i in 0..100 {
            assert!(rl.try_acquire(&format!("owner{i}"), &format!("fresh{i}"), 1_000).is_ok());
        }
        assert_eq!(rl.len(), HARD_MAX);
        for i in 0..10 {
            assert!(rl.wait(&format!("k{i}"), 1_000).is_some(), "a used-up budget stays");
        }
    }

    /// Room is made from the network with the most entries that may be dropped.
    #[test]
    fn room_is_made_from_the_biggest_network() {
        let mut table = Table::default();
        let net = |n: &str| digest(n);
        for i in 0..5 {
            table.count(digest(&format!("small{i}")), net("small"), i, 2);
        }
        for i in 0..9 {
            table.count(digest(&format!("big{i}")), net("big"), i, 2);
        }
        assert_eq!(table.by_droppable.last().map(|(n, d)| (*n, *d)), Some((9, net("big"))));
        let (_, largest) = *table.by_droppable.last().unwrap();
        let (_, oldest) = *table.networks[&largest].droppable.first().unwrap();
        assert_eq!(oldest, digest("big0"));
        // Using up its attempts takes an entry out of the droppable ones.
        table.count(digest("big0"), net("big"), 0, 2);
        assert_eq!(table.by_droppable.last().map(|(n, _)| *n), Some(8));
    }

    #[test]
    fn a_table_of_used_up_entries_refuses_new_keys_until_the_oldest_window_ends() {
        let rl = RateLimiter::new(1, 60);
        for i in 0..HARD_MAX {
            assert!(rl.try_acquire(&format!("k{i}"), &format!("n{i}"), (i / SOFT_MAX) as i64 * 10_000).is_ok());
        }
        assert_eq!(rl.try_acquire("new", "fresh", 30_000), Err(Duration::from_secs(30)));
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
        for _ in 0..5 {
            assert!(rl.record("c", "n", 0));
        }
        assert_eq!(rl.wait("c", 0), Some(Duration::from_secs(60)));
        assert_eq!(rl.wait("c", 60_000), None);
        rl.refund("c");
        rl.len();
    }

    #[test]
    fn in_flight_checks_are_capped_per_key() {
        let flight = InFlight::default();
        let a = flight.enter("a").unwrap();
        let b = flight.enter("a").unwrap();
        assert!(flight.enter("a").is_none());
        assert!(flight.enter("b").is_some());
        drop(a);
        assert!(flight.enter("a").is_some());
        drop(b);
        assert!(flight.0.lock().unwrap().is_empty());
    }
}
