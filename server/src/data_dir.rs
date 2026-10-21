//! The data directory: `kalzit.db` with its `-wal` and `-shm` files, `setup-token.txt` on the
//! first start and the fallback secrets key file. Checked at start, before the database opens.
//!
//! A missing directory is created: on Unix with mode 0700, on Windows with a protected ACL for
//! SYSTEM, the Administrators group and the account Kalzit runs as (the owner). An existing
//! directory keeps its ACL on Windows; on Unix it must not be writable by group or others.

use std::path::Path;

use anyhow::{Context, Result, bail};

/// Creates `dir` if it is missing and checks that it is private and writable.
pub fn prepare(dir: &Path) -> Result<()> {
    create(dir).with_context(|| {
        format!("creating the data directory {} (set paths.data_dir to use another place)", dir.display())
    })?;
    let meta = std::fs::metadata(dir).with_context(|| format!("reading the data directory {}", dir.display()))?;
    if !meta.is_dir() {
        bail!("the data directory {} is not a directory", dir.display());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = meta.permissions().mode() & 0o777;
        if mode & 0o022 != 0 {
            bail!(
                "the data directory {} is writable by group or others (mode {mode:o}); \
                 restrict it with `chmod 700 {}`",
                dir.display(),
                dir.display()
            );
        }
    }
    check_writable(dir)
}

/// Creates the directory (and missing parents). Only a directory created here gets the private
/// mode or ACL; an existing one is left as the administrator set it up.
fn create(dir: &Path) -> std::io::Result<()> {
    if let Some(parent) = dir.parent().filter(|p| !p.as_os_str().is_empty()) {
        std::fs::create_dir_all(parent)?;
    }
    #[cfg(unix)]
    let created = {
        use std::os::unix::fs::DirBuilderExt;
        std::fs::DirBuilder::new().mode(0o700).create(dir)
    };
    #[cfg(not(unix))]
    let created = std::fs::create_dir(dir);
    match created {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => return Ok(()),
        Err(e) => return Err(e),
    }
    #[cfg(windows)]
    if let Err(e) = acl::restrict(dir, acl::DIR_SDDL) {
        // Never leave a directory behind that is open to every user; it is still empty.
        let _ = std::fs::remove_dir(dir);
        return Err(e);
    }
    Ok(())
}

fn check_writable(dir: &Path) -> Result<()> {
    let probe = dir.join(format!(".kalzit-write-check-{}", std::process::id()));
    let written = std::fs::write(&probe, b"").and_then(|()| std::fs::remove_file(&probe));
    written.with_context(|| {
        format!(
            "the data directory {} is not writable by the account Kalzit runs as; grant it write access \
             or set paths.data_dir",
            dir.display()
        )
    })
}

#[cfg(windows)]
pub mod acl {
    //! Explicit, protected DACLs (not inherited from the parent): full access for SYSTEM, the
    //! Administrators group and the object's owner (the account Kalzit runs as), nobody else.

    use windows::Win32::Foundation::{HLOCAL, LocalFree};
    use windows::Win32::Security::Authorization::{
        ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
    };
    use windows::Win32::Security::{
        DACL_SECURITY_INFORMATION, OBJECT_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION,
        PSECURITY_DESCRIPTOR, SetFileSecurityW,
    };
    use windows::core::HSTRING;

    /// For a single file.
    pub const FILE_SDDL: &str = "D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;OW)";
    /// For a directory: the same entries, inherited by the files and folders created in it.
    pub const DIR_SDDL: &str = "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;OW)";

    pub fn restrict(path: &std::path::Path, sddl: &str) -> std::io::Result<()> {
        let mut sd = PSECURITY_DESCRIPTOR::default();
        // SAFETY: `sddl` is one of the constants above; `sd` receives a LocalAlloc'ed descriptor.
        unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(&HSTRING::from(sddl), SDDL_REVISION_1, &mut sd, None)
        }
        .map_err(std::io::Error::other)?;
        let info = OBJECT_SECURITY_INFORMATION(DACL_SECURITY_INFORMATION.0 | PROTECTED_DACL_SECURITY_INFORMATION.0);
        // SAFETY: `sd` is the descriptor built above, alive until freed below.
        let ok = unsafe { SetFileSecurityW(&HSTRING::from(path.as_os_str()), info, sd) }.as_bool();
        let error = std::io::Error::last_os_error();
        // SAFETY: the descriptor was allocated by the conversion with LocalAlloc.
        unsafe { LocalFree(Some(HLOCAL(sd.0))) };
        if ok { Ok(()) } else { Err(error) }
    }

    /// The DACL of a file or directory as SDDL, read through the API (tests check `restrict`).
    #[cfg(test)]
    pub fn dacl_sddl(path: &std::path::Path) -> std::io::Result<String> {
        use windows::Win32::Security::Authorization::ConvertSecurityDescriptorToStringSecurityDescriptorW;
        use windows::Win32::Security::GetFileSecurityW;
        use windows::core::PWSTR;
        let name = HSTRING::from(path.as_os_str());
        let mut needed = 0u32;
        // SAFETY: a size query with no buffer.
        let _ = unsafe { GetFileSecurityW(&name, DACL_SECURITY_INFORMATION.0, None, 0, &mut needed) };
        let mut buffer = vec![0u8; needed as usize];
        let sd = PSECURITY_DESCRIPTOR(buffer.as_mut_ptr().cast());
        // SAFETY: `buffer` holds `needed` bytes for the descriptor.
        if !unsafe { GetFileSecurityW(&name, DACL_SECURITY_INFORMATION.0, Some(sd), needed, &mut needed) }.as_bool() {
            return Err(std::io::Error::last_os_error());
        }
        let mut text = PWSTR::null();
        // SAFETY: `sd` is the descriptor read above; `text` receives a LocalAlloc'ed string.
        unsafe {
            ConvertSecurityDescriptorToStringSecurityDescriptorW(
                sd,
                SDDL_REVISION_1,
                DACL_SECURITY_INFORMATION,
                &mut text,
                None,
            )
        }
        .map_err(std::io::Error::other)?;
        // SAFETY: the conversion returned a NUL-terminated wide string, freed right after.
        let sddl = unsafe { text.to_string() }.map_err(std::io::Error::other);
        unsafe { LocalFree(Some(HLOCAL(text.0.cast()))) };
        sddl
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_directory_is_created() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("nested").join("data");
        prepare(&dir).unwrap();
        assert!(dir.is_dir());
        // Nothing is left behind by the write check.
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0);
        // A second start finds it and accepts it.
        prepare(&dir).unwrap();
    }

    #[test]
    fn a_file_in_place_of_the_directory_is_refused() {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("data");
        std::fs::write(&file, b"x").unwrap();
        let err = prepare(&file).unwrap_err();
        assert!(format!("{err:#}").contains("not a directory"), "{err:#}");
    }

    #[cfg(unix)]
    #[test]
    fn a_new_directory_is_private() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("data");
        prepare(&dir).unwrap();
        assert_eq!(std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777, 0o700);
    }

    #[cfg(unix)]
    #[test]
    fn a_group_or_world_writable_directory_is_refused() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        for mode in [0o770, 0o707, 0o777] {
            let dir = root.path().join(format!("data-{mode:o}"));
            std::fs::create_dir(&dir).unwrap();
            std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(mode)).unwrap();
            let err = prepare(&dir).unwrap_err();
            assert!(format!("{err:#}").contains("writable by group or others"), "{mode:o}: {err:#}");
        }
        // Readable by others is the administrator's choice; only writing is refused.
        let dir = root.path().join("data-755");
        std::fs::create_dir(&dir).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        prepare(&dir).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn a_new_directory_gets_a_private_inherited_acl() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("data");
        prepare(&dir).unwrap();
        let sddl = acl::dacl_sddl(&dir).unwrap();
        let dacl = sddl.split("D:").nth(1).unwrap_or_default().trim().to_string();
        assert!(dacl.starts_with('P'), "not protected: {sddl}");
        let aces: Vec<&str> = dacl.split(['(', ')']).filter(|a| a.starts_with("A;")).collect();
        let mut trustees: Vec<&str> = aces.iter().filter_map(|a| a.rsplit(';').next()).collect();
        trustees.sort_unstable();
        assert_eq!(trustees, ["BA", "OW", "SY"], "{sddl}");
        assert!(aces.iter().all(|a| a.contains("OICI")), "not inherited by children: {sddl}");
        // The account running the test (the owner) can still write files there.
        std::fs::write(dir.join("kalzit.db"), b"x").unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn an_existing_directory_keeps_its_acl() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("data");
        std::fs::create_dir(&dir).unwrap();
        let before = acl::dacl_sddl(&dir).unwrap();
        prepare(&dir).unwrap();
        assert_eq!(acl::dacl_sddl(&dir).unwrap(), before);
    }
}
