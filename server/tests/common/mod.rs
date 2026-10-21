//! Helpers shared by the integration tests.

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
