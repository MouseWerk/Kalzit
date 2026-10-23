//! Helpers shared by the integration tests.

// Each test binary compiles this module and uses only part of it.
#![allow(dead_code)]

use std::sync::Arc;

use kalzit::app::AppState;

/// A temporary directory that passes the data directory check: closed to group and others on
/// Unix (`tempfile` creates it with the umask's mode, often 0755). On Windows it keeps the ACL of
/// the user's temporary folder, which the ACL check accepts.
pub fn private_tempdir() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    dir
}

/// Ends a test app: stops its background work and closes its databases, then deletes its data
/// directory. Windows cannot delete a file that is still open, and a `TempDir` that is simply
/// dropped ignores that error, so every test app's `kalzit.db` stayed behind in the temporary
/// folder. Deleting here fails the test instead.
pub struct Finish {
    state: AppState,
    dir: Arc<tempfile::TempDir>,
}

impl Finish {
    /// For the app on `state` whose data directory is `dir`. The app keeps its own handle on
    /// `dir`; it must be gone before `finish` runs.
    pub fn new(state: AppState, dir: Arc<tempfile::TempDir>) -> Self {
        Self { state, dir }
    }

    pub async fn finish(self) {
        self.state.close().await;
        drop(self.state);
        remove_dir(Arc::try_unwrap(self.dir).expect("the test app still holds its data directory"));
    }
}

/// Deletes a test's temporary directory and fails the test when that does not work, where a
/// dropped `TempDir` would give up silently (see `Finish`).
pub fn remove_dir(dir: tempfile::TempDir) {
    let path = dir.path().to_path_buf();
    if let Err(e) = dir.close() {
        panic!("the data directory {} was not deleted: {e}", path.display());
    }
}
