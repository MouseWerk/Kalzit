//! The privilege switch of `kalzit update apply|rollback` (`updates::cli::Rights`) against the real
//! system: run as root on a data directory another account owns. It needs root and that account,
//! so it is ignored in the normal run; the CI job `update-rights` creates a `kalzit` user and a
//! 0700 data directory for it and runs this test with sudo:
//!
//! ```text
//! sudo -E env KALZIT_TEST_RIGHTS_DIR=/var/lib/kalzit-rights-test target/debug/deps/update_rights-... --ignored
//! ```
#![cfg(unix)]

use std::fs;
use std::os::unix::fs::{MetadataExt, PermissionsExt, symlink};
use std::path::PathBuf;

use ed25519_dalek::SigningKey;
use kalzit::updates::UpdateError;
use kalzit::updates::cli::Rights;
use kalzit::updates::install::{self, Layout};
use kalzit::updates::platform::Platform;
use kalzit::updates::signing::{self, Channel, Manifest, TrustedKeys};
use kalzit::updates::staging;

/// Effective user id, effective group id and supplementary groups of this thread.
fn ids() -> (u32, u32, Vec<u32>) {
    let status = fs::read_to_string("/proc/thread-self/status").unwrap();
    let field = |name: &str| -> Vec<u32> {
        let line = status.lines().find(|l| l.starts_with(name)).unwrap_or_default();
        line[name.len()..].split_whitespace().filter_map(|v| v.parse().ok()).collect()
    };
    let (uid, gid) = (field("Uid:"), field("Gid:"));
    (uid[1], gid[1], field("Groups:"))
}

#[test]
#[ignore = "needs root and a data directory owned by another account (CI job update-rights)"]
fn the_command_line_works_in_the_data_directory_with_its_owners_rights() {
    let dir = PathBuf::from(std::env::var("KALZIT_TEST_RIGHTS_DIR").expect("KALZIT_TEST_RIGHTS_DIR"));
    let (start_uid, _, start_groups) = ids();
    assert_eq!(start_uid, 0, "run this test as root");
    let meta = fs::metadata(&dir).unwrap();
    let (owner, group) = (meta.uid(), meta.gid());
    assert_ne!(owner, 0, "the data directory must belong to another account");

    // Made as root: a file only root may read, and the binary's folder.
    let root_dir = tempfile::tempdir().unwrap();
    let secret = root_dir.path().join("secret");
    fs::write(&secret, "root only").unwrap();
    fs::set_permissions(&secret, fs::Permissions::from_mode(0o600)).unwrap();
    let exe = root_dir.path().join("kalzit");
    fs::write(&exe, "old binary").unwrap();
    fs::set_permissions(&exe, fs::Permissions::from_mode(0o755)).unwrap();

    let rights = Rights::detect(&dir).unwrap();
    assert!(rights.switches());
    rights.as_owner().unwrap();
    assert_eq!(ids(), (owner, group, vec![group]), "the owner's ids during as_owner");

    // A staged release, written with the owner's rights.
    let layout = Layout::new(&dir);
    let key = SigningKey::from_bytes(&[7; 32]);
    let keys = TrustedKeys::from_base64(&[&signing::public_key_base64(&key)]).unwrap();
    let platform = Platform::current();
    let file = format!("kalzit-99.0.0-{}-{}", platform.os, platform.arch);
    let package = signing::sign_package(&key, "99.0.0", platform.os, platform.arch, &file, b"signed binary");
    let manifest = Manifest {
        format: 1,
        product: "kalzit".into(),
        version: "99.0.0".into(),
        channel: Channel::Stable,
        released_at: None,
        minimum_version: None,
        notes: String::new(),
        notes_url: None,
        highlights: vec![],
        packages: vec![package],
        installers: vec![],
    };
    let manifest = serde_json::to_vec(&manifest).unwrap();
    let signature = serde_json::to_vec(&signing::sign_manifest(&key, &manifest)).unwrap();
    let upload = staging::incoming_dir(&layout, "upload-rights-test").unwrap();
    fs::write(upload.join(staging::MANIFEST_FILE), &manifest).unwrap();
    fs::write(upload.join(staging::SIGNATURE_FILE), &signature).unwrap();
    fs::write(upload.join(staging::PACKAGE_FILE), b"signed binary").unwrap();
    let current = semver::Version::parse("0.1.0").unwrap();
    staging::stage_upload(&layout, &upload, &keys, &platform, &current, Channel::Stable).unwrap();
    for path in [layout.root().to_path_buf(), layout.staging(), layout.staging().join(staging::PACKAGE_FILE)] {
        assert_eq!(fs::metadata(&path).unwrap().uid(), owner, "{} belongs to the owner", path.display());
    }

    // The package is swapped after it was loaded: the copy's check catches it.
    let staged = staging::load(&layout, &keys, &platform).unwrap();
    fs::write(&staged.package_path, b"swapped binary").unwrap();
    let opened = install::open_regular(&staged.package_path).unwrap();
    rights.as_self().unwrap();
    assert_eq!(ids(), (0, 0, start_groups.clone()), "root's ids after as_self");
    let e = install::place_from(opened, &exe, &staged.package.sha256, staged.package.size).unwrap_err();
    assert!(matches!(e, UpdateError::HashMismatch | UpdateError::SizeMismatch), "{e}");
    assert_eq!(fs::read_to_string(&exe).unwrap(), "old binary");

    // A link in place of the package, to a file only root may read, is refused.
    rights.as_owner().unwrap();
    fs::remove_file(&staged.package_path).unwrap();
    symlink(&secret, &staged.package_path).unwrap();
    assert!(install::open_regular(&staged.package_path).is_err(), "a link is not followed");
    assert!(fs::read(&secret).is_err(), "the owner cannot read the root-only file anyway");
    fs::remove_dir_all(layout.root()).unwrap();
    rights.as_self().unwrap();
    assert_eq!(ids().0, 0);
}
