//! The server's one lock policy: a poisoned lock is recovered, never turned into a second panic.
//!
//! A std lock is poisoned when a thread panics while holding it. Every lock in the server guards
//! plain bookkeeping (caches, counters, connection and token maps) that is changed in single steps,
//! so the state stays valid even after such a panic; refusing it would only spread one failed
//! request into a panic in every later request that touches the same lock. Recovering through
//! `PoisonError::into_inner` keeps std's types (no extra dependency, `Condvar` keeps working) and
//! reads the same at every call site: `lock_or_recover`, `read_or_recover`, `write_or_recover`.

use std::sync::{Mutex, MutexGuard, PoisonError, RwLock, RwLockReadGuard, RwLockWriteGuard};

pub trait MutexExt<T: ?Sized> {
    /// Locks the mutex, taking over the guard if an earlier holder panicked.
    fn lock_or_recover(&self) -> MutexGuard<'_, T>;
}

impl<T: ?Sized> MutexExt<T> for Mutex<T> {
    fn lock_or_recover(&self) -> MutexGuard<'_, T> {
        self.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

pub trait RwLockExt<T: ?Sized> {
    /// Takes a read guard, also after an earlier writer panicked.
    fn read_or_recover(&self) -> RwLockReadGuard<'_, T>;
    /// Takes the write guard, also after an earlier holder panicked.
    fn write_or_recover(&self) -> RwLockWriteGuard<'_, T>;
}

impl<T: ?Sized> RwLockExt<T> for RwLock<T> {
    fn read_or_recover(&self) -> RwLockReadGuard<'_, T> {
        self.read().unwrap_or_else(PoisonError::into_inner)
    }

    fn write_or_recover(&self) -> RwLockWriteGuard<'_, T> {
        self.write().unwrap_or_else(PoisonError::into_inner)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn a_poisoned_mutex_is_recovered_with_its_state() {
        let m = Arc::new(Mutex::new(vec![1]));
        let held = m.clone();
        let _ = std::thread::spawn(move || {
            let mut v = held.lock().unwrap();
            v.push(2);
            panic!("holder panics");
        })
        .join();
        assert!(m.is_poisoned());
        m.lock_or_recover().push(3);
        assert_eq!(*m.lock_or_recover(), [1, 2, 3]);
    }

    #[test]
    fn a_poisoned_rwlock_is_recovered_for_readers_and_writers() {
        let l = Arc::new(RwLock::new(1));
        let held = l.clone();
        let _ = std::thread::spawn(move || {
            let _w = held.write().unwrap();
            panic!("writer panics");
        })
        .join();
        assert!(l.is_poisoned());
        *l.write_or_recover() += 1;
        assert_eq!(*l.read_or_recover(), 2);
    }
}
