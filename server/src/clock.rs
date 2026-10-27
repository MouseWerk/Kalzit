//! Injectable clock, so session expiry and rate limits can be tested without waiting.

use std::sync::OnceLock;
use std::sync::atomic::{AtomicI64, Ordering};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

pub trait Clock: Send + Sync {
    /// Unix time in milliseconds.
    fn now_ms(&self) -> i64;
    /// Milliseconds of a clock that never goes back and ignores changes of the system time, for
    /// measuring spans (rate-limit windows). Only differences mean anything.
    fn monotonic_ms(&self) -> i64;
}

pub struct SystemClock;

impl Clock for SystemClock {
    fn now_ms(&self) -> i64 {
        // A clock before 1970 is treated as 0 instead of panicking.
        SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
    }

    fn monotonic_ms(&self) -> i64 {
        static START: OnceLock<Instant> = OnceLock::new();
        START.get_or_init(Instant::now).elapsed().as_millis() as i64
    }
}

/// A clock that only moves when told to; its monotonic time is its Unix time.
pub struct ManualClock(AtomicI64);

impl ManualClock {
    pub fn new(start_ms: i64) -> Self {
        Self(AtomicI64::new(start_ms))
    }

    pub fn advance_ms(&self, ms: i64) {
        self.0.fetch_add(ms, Ordering::SeqCst);
    }
}

impl Clock for ManualClock {
    fn now_ms(&self) -> i64 {
        self.0.load(Ordering::SeqCst)
    }

    fn monotonic_ms(&self) -> i64 {
        self.now_ms()
    }
}
