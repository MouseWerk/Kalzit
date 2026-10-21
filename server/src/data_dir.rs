//! The data directory: `kalzit.db` with its `-wal` and `-shm` files, `setup-token.txt` on the
//! first start and the fallback secrets key file. Checked at start, before the database opens.
//!
//! A missing directory is created private: on Unix with mode 0700, on Windows atomically with a
//! protected ACL for SYSTEM, the Administrators group and the account Kalzit runs as (the owner).
//! An existing directory is refused when someone else owns it or may read or write in it: it
//! holds password hashes and sessions.

use std::path::Path;

use anyhow::{Context, Result, bail};

/// Creates `dir` if it is missing and checks that it is private and writable.
pub fn prepare(dir: &Path) -> Result<()> {
    #[cfg(windows)]
    let config_folder = crate::config::program_data_folder();
    #[cfg(not(windows))]
    let config_folder: Option<std::path::PathBuf> = None;
    prepare_with(dir, config_folder.as_deref())
}

/// `config_folder` is `%ProgramData%\Kalzit` on Windows: created with its own ACL when it is a
/// missing parent of `dir`.
fn prepare_with(dir: &Path, config_folder: Option<&Path>) -> Result<()> {
    create(dir, config_folder).map_err(|e| {
        let hint = creation_hint(dir, &e);
        anyhow::Error::new(e).context(format!("creating the data directory {}{hint}", dir.display()))
    })?;
    let meta = std::fs::metadata(dir).with_context(|| format!("reading the data directory {}", dir.display()))?;
    if !meta.is_dir() {
        bail!("the data directory {} is not a directory", dir.display());
    }
    #[cfg(windows)]
    acl::check(dir, acl::Others::NoAccess)?;
    let probe = write_probe(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        check_unix(dir, meta.mode(), meta.uid(), probe.uid())?;
    }
    #[cfg(not(unix))]
    let _ = probe;
    Ok(())
}

#[cfg(windows)]
pub use acl::check_admin_only;

fn creation_hint(dir: &Path, e: &std::io::Error) -> String {
    if e.kind() != std::io::ErrorKind::PermissionDenied {
        return " (set paths.data_dir to use another place)".into();
    }
    #[cfg(unix)]
    {
        let user = std::env::var("USER").or_else(|_| std::env::var("LOGNAME")).unwrap_or_else(|_| "kalzit".into());
        format!(
            ": the account may not create it. Create it as root with `sudo install -d -o {user} -m 0700 {}`, or let \
             systemd create it with `StateDirectory=kalzit` and `StateDirectoryMode=0700` in the unit",
            dir.display()
        )
    }
    #[cfg(not(unix))]
    {
        let _ = dir;
        ": the account may not create it; create it from an elevated prompt or set paths.data_dir".into()
    }
}

/// Creates the directory and missing parents. Only the directory itself (and on Windows
/// `config_folder`) gets a private mode or ACL, set atomically at creation; an existing
/// directory is never changed, only checked.
fn create(dir: &Path, config_folder: Option<&Path>) -> std::io::Result<()> {
    let mut missing = Vec::new();
    let mut current = Some(dir);
    while let Some(path) = current.filter(|p| !p.as_os_str().is_empty() && !p.exists()) {
        missing.push(path);
        current = path.parent();
    }
    for path in missing.into_iter().rev() {
        let created = if path == dir {
            create_private(path)
        } else if Some(path) == config_folder {
            create_config_folder(path)
        } else {
            std::fs::create_dir(path)
        };
        match created {
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            other => other?,
        }
    }
    Ok(())
}

#[cfg(unix)]
fn create_private(dir: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    std::fs::DirBuilder::new().mode(0o700).create(dir)
}

#[cfg(windows)]
fn create_private(dir: &Path) -> std::io::Result<()> {
    acl::create_dir(dir, acl::DIR_SDDL)
}

#[cfg(windows)]
fn create_config_folder(dir: &Path) -> std::io::Result<()> {
    acl::create_dir(dir, acl::CONFIG_DIR_SDDL)
}

#[cfg(not(windows))]
fn create_config_folder(dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir(dir)
}

/// Writes and removes a probe file; its metadata tells which account the process writes as.
fn write_probe(dir: &Path) -> Result<std::fs::Metadata> {
    let probe = dir.join(format!(".kalzit-write-check-{:016x}", rand::random::<u64>()));
    let file = std::fs::OpenOptions::new().write(true).create_new(true).open(&probe).with_context(|| {
        format!(
            "the data directory {} is not writable by the account Kalzit runs as; grant it write access \
             or set paths.data_dir",
            dir.display()
        )
    })?;
    let meta = file.metadata();
    drop(file);
    if let Err(e) = std::fs::remove_file(&probe) {
        tracing::warn!("removing the write check file {}: {e}", probe.display());
    }
    meta.with_context(|| format!("reading the write check file {}", probe.display()))
}

/// The data directory must belong to the account Kalzit runs as (the owner of the probe file)
/// and be closed to group and others.
#[cfg(unix)]
fn check_unix(dir: &Path, mode: u32, dir_uid: u32, process_uid: u32) -> Result<()> {
    if dir_uid != process_uid {
        bail!(
            "the data directory {} belongs to uid {dir_uid}, but Kalzit runs as uid {process_uid}; \
             hand it over with `chown -R <kalzit user> {}` or run Kalzit as its owner",
            dir.display(),
            dir.display()
        );
    }
    let mode = mode & 0o777;
    if mode & 0o077 != 0 {
        bail!(
            "the data directory {} is open to group or others (mode {mode:o}), but it holds password hashes \
             and sessions; restrict it with `chmod 700 {}` (in a systemd unit: StateDirectoryMode=0700)",
            dir.display(),
            dir.display()
        );
    }
    Ok(())
}

#[cfg(windows)]
pub mod acl {
    //! Explicit, protected DACLs (not inherited from the parent), set when an object is created,
    //! and the check of an existing object's owner and DACL.

    use std::path::Path;

    use anyhow::{Result, bail};
    use windows::Win32::Foundation::{CloseHandle, GENERIC_WRITE, HANDLE, HLOCAL, LocalFree};
    use windows::Win32::Security::Authorization::{
        ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, GetNamedSecurityInfoW,
        SDDL_REVISION_1, SE_FILE_OBJECT, SetNamedSecurityInfoW,
    };
    use windows::Win32::Security::{
        ACCESS_ALLOWED_ACE, ACE_HEADER, ACL, ACL_SIZE_INFORMATION, AclSizeInformation, DACL_SECURITY_INFORMATION,
        GetAce, GetAclInformation, GetSecurityDescriptorDacl, GetTokenInformation, OBJECT_SECURITY_INFORMATION,
        OWNER_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID,
        SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER, TokenUser,
    };
    use windows::Win32::Storage::FileSystem::{
        CREATE_NEW, CreateDirectoryW, CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_MODE,
    };
    use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
    use windows::core::{HSTRING, PWSTR};

    /// A single file: full access for SYSTEM, Administrators and the owner.
    pub const FILE_SDDL: &str = "D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;OW)";
    /// The data directory: the same entries, inherited by the files and folders created in it.
    pub const DIR_SDDL: &str = "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;OW)";
    /// `%ProgramData%\Kalzit`: SYSTEM and Administrators full, Users read and execute (the service
    /// account reads `kalzit.toml`), no create rights for users. The creating account may manage
    /// the folder itself (not inherited), so a service account can create `data` in it.
    pub const CONFIG_DIR_SDDL: &str = "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;BU)(A;;FA;;;OW)";

    const SYSTEM: &str = "S-1-5-18";
    const ADMINISTRATORS: &str = "S-1-5-32-544";
    const USERS: &str = "S-1-5-32-545";
    const OWNER_RIGHTS: &str = "S-1-3-4";
    /// Only creators get it, and only those who may create files here, which the check limits
    /// to the trusted accounts.
    const CREATOR_OWNER: &str = "S-1-3-0";

    const ACCESS_ALLOWED: u8 = 0;
    const ACCESS_DENIED: u8 = 1;
    const ACCESS_ALLOWED_CALLBACK: u8 = 9;
    const ACCESS_DENIED_OBJECT: u8 = 6;
    const ACCESS_DENIED_CALLBACK: u8 = 10;
    const ACCESS_DENIED_CALLBACK_OBJECT: u8 = 12;
    /// Read data or list, read extended attributes, generic read.
    const READ_MASK: u32 = 0x1 | 0x8 | 0x8000_0000;
    /// Write or append data (create files or folders), write extended attributes, delete
    /// children, write attributes, delete, change the DACL or owner, generic write or all.
    const WRITE_MASK: u32 =
        0x2 | 0x4 | 0x10 | 0x40 | 0x100 | 0x1_0000 | 0x4_0000 | 0x8_0000 | 0x4000_0000 | 0x1000_0000;

    /// What accounts other than SYSTEM, Administrators and Kalzit's own may do.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum Others {
        NoAccess,
        ReadOnly,
    }

    /// A self-relative security descriptor from SDDL, freed on drop.
    struct Descriptor(PSECURITY_DESCRIPTOR);

    impl Descriptor {
        fn from_sddl(sddl: &str) -> std::io::Result<Self> {
            let mut sd = PSECURITY_DESCRIPTOR::default();
            // SAFETY: `sddl` lives in the HSTRING for the call; the conversion validates it and
            // on success stores a LocalAlloc'ed descriptor in `sd`, owned by the returned value.
            unsafe {
                ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    &HSTRING::from(sddl),
                    SDDL_REVISION_1,
                    &mut sd,
                    None,
                )
            }
            .map_err(io_error)?;
            Ok(Self(sd))
        }

        /// Sets the descriptor's DACL on `path` as a protected DACL, with auto-inheritance to the
        /// objects inside it.
        fn apply(&self, path: &Path) -> std::io::Result<()> {
            let mut present = windows::core::BOOL::default();
            let mut defaulted = windows::core::BOOL::default();
            let mut dacl: *mut ACL = std::ptr::null_mut();
            // SAFETY: `self.0` is a valid descriptor; `dacl` receives a pointer into it.
            unsafe { GetSecurityDescriptorDacl(self.0, &mut present, &mut dacl, &mut defaulted) }.map_err(io_error)?;
            let info = OBJECT_SECURITY_INFORMATION(DACL_SECURITY_INFORMATION.0 | PROTECTED_DACL_SECURITY_INFORMATION.0);
            // SAFETY: `dacl` points into `self`, which outlives the call.
            let status = unsafe {
                SetNamedSecurityInfoW(
                    &HSTRING::from(path.as_os_str()),
                    SE_FILE_OBJECT,
                    info,
                    None,
                    None,
                    Some(dacl.cast_const()),
                    None,
                )
            };
            if status.0 == 0 { Ok(()) } else { Err(std::io::Error::from_raw_os_error(status.0 as i32)) }
        }

        fn attributes(&self) -> SECURITY_ATTRIBUTES {
            SECURITY_ATTRIBUTES {
                nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
                lpSecurityDescriptor: self.0.0,
                bInheritHandle: false.into(),
            }
        }
    }

    impl Drop for Descriptor {
        fn drop(&mut self) {
            // SAFETY: the descriptor was allocated with LocalAlloc and is freed once.
            unsafe { LocalFree(Some(HLOCAL(self.0.0))) };
        }
    }

    fn io_error(e: windows::core::Error) -> std::io::Error {
        let code = e.code().0 as u32;
        // HRESULT_FROM_WIN32: facility 7 carries the Win32 error code in the low word.
        if code & 0xFFFF_0000 == 0x8007_0000 {
            std::io::Error::from_raw_os_error((code & 0xFFFF) as i32)
        } else {
            std::io::Error::other(e)
        }
    }

    /// Creates a directory that has the DACL from `sddl` from its first moment. The DACL is then
    /// set once more through the auto-inheritance API: a descriptor passed at creation does not
    /// mark its entries as inheritable the modern way, so files created inside would get copies
    /// instead of inherited entries.
    pub fn create_dir(path: &Path, sddl: &str) -> std::io::Result<()> {
        let sd = Descriptor::from_sddl(sddl)?;
        let attributes = sd.attributes();
        // SAFETY: `attributes` points at `sd`, which outlives the call.
        unsafe { CreateDirectoryW(&HSTRING::from(path.as_os_str()), Some(&attributes)) }.map_err(io_error)?;
        if let Err(e) = sd.apply(path) {
            // Private already, but not as intended; leave nothing half-done behind.
            if let Err(removal) = std::fs::remove_dir(path) {
                tracing::warn!("removing the new directory {} after a failed ACL update: {removal}", path.display());
            }
            return Err(e);
        }
        Ok(())
    }

    /// Creates a new file (it must not exist) that has the DACL from `sddl` from its first moment.
    pub fn create_file(path: &Path, sddl: &str) -> std::io::Result<std::fs::File> {
        use std::os::windows::io::FromRawHandle;
        let sd = Descriptor::from_sddl(sddl)?;
        let attributes = sd.attributes();
        // SAFETY: `attributes` points at `sd`, which outlives the call.
        let handle = unsafe {
            CreateFileW(
                &HSTRING::from(path.as_os_str()),
                GENERIC_WRITE.0,
                FILE_SHARE_MODE(0),
                Some(&attributes),
                CREATE_NEW,
                FILE_ATTRIBUTE_NORMAL,
                None,
            )
        }
        .map_err(io_error)?;
        // SAFETY: `handle` is a new, valid file handle that the File now owns and closes.
        Ok(unsafe { std::fs::File::from_raw_handle(handle.0) })
    }

    /// Replaces the DACL of an existing object with the protected DACL from `sddl` (the secrets
    /// key file before it is written; tests build exposed folders with it).
    pub fn restrict(path: &Path, sddl: &str) -> std::io::Result<()> {
        Descriptor::from_sddl(sddl)?.apply(path)
    }

    /// The string form (`S-1-5-...`) of a SID.
    ///
    /// SAFETY: `sid` must point at a valid SID.
    unsafe fn sid_string(sid: PSID) -> std::io::Result<String> {
        let mut text = PWSTR::null();
        // SAFETY: `sid` is valid (caller); `text` receives a LocalAlloc'ed string.
        unsafe { ConvertSidToStringSidW(sid, &mut text) }.map_err(io_error)?;
        // SAFETY: the conversion returned a NUL-terminated wide string, freed right after.
        let s = unsafe { text.to_string() }.map_err(std::io::Error::other);
        unsafe { LocalFree(Some(HLOCAL(text.0.cast()))) };
        s
    }

    /// The SID of the account this process runs as.
    pub fn current_user() -> std::io::Result<String> {
        let mut token = HANDLE::default();
        // SAFETY: the pseudo handle of the own process; `token` receives a handle closed below.
        unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) }.map_err(io_error)?;
        let mut needed = 0u32;
        // SAFETY: a size query with no buffer; it fails with "insufficient buffer" by design.
        let _ = unsafe { GetTokenInformation(token, TokenUser, None, 0, &mut needed) };
        // u64 elements keep the TOKEN_USER at the start suitably aligned.
        let mut buffer = vec![0u64; (needed as usize).div_ceil(8)];
        // SAFETY: `buffer` holds at least `needed` bytes.
        let read =
            unsafe { GetTokenInformation(token, TokenUser, Some(buffer.as_mut_ptr().cast()), needed, &mut needed) };
        // SAFETY: `token` was opened above and is closed once.
        let _ = unsafe { CloseHandle(token) };
        read.map_err(io_error)?;
        // SAFETY: on success the buffer starts with a TOKEN_USER whose SID points into it.
        unsafe { sid_string((*buffer.as_ptr().cast::<TOKEN_USER>()).User.Sid) }
    }

    /// An access entry of a DACL.
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct Entry {
        pub sid: String,
        pub mask: u32,
    }

    /// The owner and the allow entries of the DACL (`None`: no DACL, which allows everyone
    /// everything). Deny entries only take rights away and are left out.
    pub fn read(path: &Path) -> std::io::Result<(String, Option<Vec<Entry>>)> {
        let mut owner = PSID::default();
        let mut dacl: *mut ACL = std::ptr::null_mut();
        let mut sd = PSECURITY_DESCRIPTOR::default();
        let info = OBJECT_SECURITY_INFORMATION(OWNER_SECURITY_INFORMATION.0 | DACL_SECURITY_INFORMATION.0);
        // SAFETY: the out pointers are valid; on success `sd` is a LocalAlloc'ed descriptor that
        // `owner` and `dacl` point into, freed by the guard below.
        let status = unsafe {
            GetNamedSecurityInfoW(
                &HSTRING::from(path.as_os_str()),
                SE_FILE_OBJECT,
                info,
                Some(&mut owner),
                None,
                Some(&mut dacl),
                None,
                &mut sd,
            )
        };
        if status.0 != 0 {
            return Err(std::io::Error::from_raw_os_error(status.0 as i32));
        }
        let _guard = Descriptor(sd);
        // SAFETY: `owner` points into the descriptor, alive until the guard drops.
        let owner = unsafe { sid_string(owner) }?;
        if dacl.is_null() {
            return Ok((owner, None));
        }
        let mut size = ACL_SIZE_INFORMATION::default();
        // SAFETY: `dacl` is a valid ACL; `size` has the size passed.
        unsafe {
            GetAclInformation(
                dacl,
                (&raw mut size).cast(),
                std::mem::size_of::<ACL_SIZE_INFORMATION>() as u32,
                AclSizeInformation,
            )
        }
        .map_err(io_error)?;
        let mut entries = Vec::new();
        for index in 0..size.AceCount {
            let mut ace = std::ptr::null_mut();
            // SAFETY: `index` is below the ACE count; `ace` receives a pointer into the ACL.
            unsafe { GetAce(dacl, index, &mut ace) }.map_err(io_error)?;
            // SAFETY: every ACE starts with an ACE_HEADER.
            let header = unsafe { *ace.cast::<ACE_HEADER>() };
            match header.AceType {
                ACCESS_ALLOWED | ACCESS_ALLOWED_CALLBACK => {
                    // SAFETY: both types share the ACCESS_ALLOWED_ACE layout, the SID starts at
                    // `SidStart` and lies within the ACE.
                    let allowed = ace.cast::<ACCESS_ALLOWED_ACE>();
                    let mask = unsafe { (*allowed).Mask };
                    let sid = unsafe { sid_string(PSID((&raw mut (*allowed).SidStart).cast())) }?;
                    entries.push(Entry { sid, mask });
                }
                ACCESS_DENIED | ACCESS_DENIED_OBJECT | ACCESS_DENIED_CALLBACK | ACCESS_DENIED_CALLBACK_OBJECT => {}
                // Object and other allow types are not used on files; treat them as open.
                other => entries.push(Entry { sid: format!("(ACE type {other})"), mask: u32::MAX }),
            }
        }
        Ok((owner, Some(entries)))
    }

    /// What is wrong with `owner` and `dacl`, or `None` when only SYSTEM, Administrators and
    /// `me` own and may change the object, and others may at most do what `others` allows.
    pub fn problem(owner: &str, dacl: Option<&[Entry]>, me: &str, others: Others) -> Option<String> {
        let trusted = |sid: &str| [SYSTEM, ADMINISTRATORS, OWNER_RIGHTS, CREATOR_OWNER, me].contains(&sid);
        if ![SYSTEM, ADMINISTRATORS, me].contains(&owner) {
            return Some(format!(
                "it is owned by {owner}, not by SYSTEM, Administrators or the account Kalzit runs as ({me})"
            ));
        }
        let Some(dacl) = dacl else {
            return Some("it has no access list, so everyone has full access".into());
        };
        let refused = match others {
            Others::NoAccess => READ_MASK | WRITE_MASK,
            Others::ReadOnly => WRITE_MASK,
        };
        let exposed: Vec<&str> =
            dacl.iter().filter(|e| !trusted(&e.sid) && e.mask & refused != 0).map(|e| e.sid.as_str()).collect();
        if exposed.is_empty() {
            return None;
        }
        let what = if others == Others::NoAccess { "read or write" } else { "write" };
        Some(format!("{} may {what} it", exposed.join(", ")))
    }

    /// Refuses an object that others own or may read or write (`Others::NoAccess`), or write
    /// (`Others::ReadOnly`), with an `icacls` command that fixes it.
    pub fn check(path: &Path, others: Others) -> Result<()> {
        let (owner, dacl) =
            read(path).map_err(|e| anyhow::anyhow!("reading the access list of {}: {e}", path.display()))?;
        let me = current_user().map_err(|e| anyhow::anyhow!("reading the account Kalzit runs as: {e}"))?;
        let Some(problem) = problem(&owner, dacl.as_deref(), &me, others) else { return Ok(()) };
        let inherit = if path.is_dir() { "(OI)(CI)" } else { "" };
        let users = match others {
            Others::NoAccess => format!("*{me}:{inherit}F"),
            Others::ReadOnly => format!("*{USERS}:{inherit}RX"),
        };
        bail!(
            "{} is not private enough: {problem}. From an elevated prompt, run \
             `icacls \"{p}\" /setowner *{ADMINISTRATORS}` and \
             `icacls \"{p}\" /inheritance:r /grant:r *{SYSTEM}:{inherit}F *{ADMINISTRATORS}:{inherit}F {users}`, \
             then remove the other entries with `icacls \"{p}\" /remove <account>`",
            path.display(),
            p = path.display(),
        )
    }

    /// `%ProgramData%\Kalzit` and its `kalzit.toml`: others may read, only admins may write.
    pub fn check_admin_only(path: &Path) -> Result<()> {
        check(path, Others::ReadOnly)
    }

    /// The DACL of a file or directory as SDDL (tests check what was set).
    #[cfg(test)]
    pub fn dacl_sddl(path: &Path) -> std::io::Result<String> {
        use windows::Win32::Security::Authorization::ConvertSecurityDescriptorToStringSecurityDescriptorW;
        use windows::Win32::Security::GetFileSecurityW;
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

    /// The ACEs of an SDDL DACL as (flags, rights, trustee).
    #[cfg(test)]
    pub fn aces(sddl: &str) -> Vec<(String, String, String)> {
        let dacl = sddl.split("D:").nth(1).unwrap_or_default();
        dacl.split(['(', ')'])
            .filter(|a| a.starts_with("A;"))
            .map(|a| {
                let parts: Vec<&str> = a.split(';').collect();
                (parts[1].to_string(), parts[2].to_string(), parts[5].to_string())
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_directory_is_created() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("nested").join("data");
        prepare_with(&dir, None).unwrap();
        assert!(dir.is_dir());
        // Nothing is left behind by the write check.
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0);
        // A second start finds it and accepts it.
        prepare_with(&dir, None).unwrap();
    }

    #[test]
    fn a_file_in_place_of_the_directory_is_refused() {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("data");
        std::fs::write(&file, b"x").unwrap();
        let err = prepare_with(&file, None).unwrap_err();
        assert!(format!("{err:#}").contains("not a directory"), "{err:#}");
    }

    #[cfg(unix)]
    #[test]
    fn a_new_directory_is_private() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("data");
        prepare_with(&dir, None).unwrap();
        assert_eq!(std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777, 0o700);
    }

    #[cfg(unix)]
    #[test]
    fn a_directory_open_to_group_or_others_is_refused() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        for mode in [0o770, 0o707, 0o777, 0o755, 0o750, 0o701] {
            let dir = root.path().join(format!("data-{mode:o}"));
            std::fs::create_dir(&dir).unwrap();
            std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(mode)).unwrap();
            let err = prepare_with(&dir, None).unwrap_err();
            let text = format!("{err:#}");
            assert!(text.contains("open to group or others") && text.contains("chmod 700"), "{mode:o}: {text}");
            assert!(text.contains("StateDirectoryMode=0700"), "{text}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_directory_of_another_account_is_refused() {
        let dir = Path::new("/srv/kalzit");
        let err = check_unix(dir, 0o700, 1001, 1002).unwrap_err();
        assert!(format!("{err:#}").contains("belongs to uid 1001, but Kalzit runs as uid 1002"), "{err:#}");
        check_unix(dir, 0o40700, 1001, 1001).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn a_parent_without_create_rights_names_the_install_command() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let locked = root.path().join("locked");
        std::fs::create_dir(&locked).unwrap();
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o500)).unwrap();
        let dir = locked.join("kalzit");
        let result = prepare_with(&dir, None);
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o700)).unwrap();
        // Root may create it anyway; there is nothing to hint then.
        if dir.exists() {
            return;
        }
        let text = format!("{:#}", result.unwrap_err());
        assert!(text.contains("sudo install -d -o") && text.contains("-m 0700"), "{text}");
        assert!(text.contains("StateDirectory=kalzit") && text.contains("StateDirectoryMode=0700"), "{text}");
    }

    #[cfg(windows)]
    #[test]
    fn a_new_directory_gets_a_private_inherited_acl() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("data");
        prepare_with(&dir, None).unwrap();
        let sddl = acl::dacl_sddl(&dir).unwrap();
        assert!(sddl.split("D:").nth(1).unwrap_or_default().starts_with('P'), "not protected: {sddl}");
        let aces = acl::aces(&sddl);
        let mut trustees: Vec<&str> = aces.iter().map(|(_, _, t)| t.as_str()).collect();
        trustees.sort_unstable();
        assert_eq!(trustees, ["BA", "OW", "SY"], "{sddl}");
        assert!(aces.iter().all(|(flags, _, _)| flags.contains("OICI")), "not inherited by children: {sddl}");

        // A file created inside has exactly the inherited entries, and the owner can write it.
        let file = dir.join("kalzit.db");
        std::fs::write(&file, b"x").unwrap();
        let file_sddl = acl::dacl_sddl(&file).unwrap();
        let file_aces = acl::aces(&file_sddl);
        let mut trustees: Vec<&str> = file_aces.iter().map(|(_, _, t)| t.as_str()).collect();
        trustees.sort_unstable();
        assert_eq!(trustees, ["BA", "OW", "SY"], "{file_sddl}");
        assert!(file_aces.iter().all(|(flags, _, _)| flags == "ID"), "only inherited entries: {file_sddl}");
    }

    #[cfg(windows)]
    #[test]
    fn an_existing_private_directory_is_accepted_unchanged() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("data");
        std::fs::create_dir(&dir).unwrap();
        acl::restrict(&dir, acl::DIR_SDDL).unwrap();
        let before = acl::dacl_sddl(&dir).unwrap();
        prepare_with(&dir, None).unwrap();
        assert_eq!(acl::dacl_sddl(&dir).unwrap(), before);
    }

    #[cfg(windows)]
    #[test]
    fn an_existing_directory_open_to_users_is_refused() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("data");
        std::fs::create_dir(&dir).unwrap();
        // Users:(W), as `icacls data /grant Users:(W)` adds it.
        acl::restrict(&dir, "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;OW)(A;;0x100116;;;BU)").unwrap();
        let text = format!("{:#}", prepare_with(&dir, None).unwrap_err());
        assert!(text.contains("S-1-5-32-545 may read or write"), "{text}");
        assert!(text.contains("icacls"), "{text}");

        // Read access for Everyone is refused as well.
        acl::restrict(&dir, "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;OW)(A;OICI;FR;;;WD)").unwrap();
        let text = format!("{:#}", prepare_with(&dir, None).unwrap_err());
        assert!(text.contains("S-1-1-0 may read or write"), "{text}");
    }

    #[cfg(windows)]
    #[test]
    fn owners_and_entries_are_judged() {
        use acl::{Entry, Others, problem};
        let me = "S-1-5-80-1";
        let entry = |sid: &str, mask: u32| Entry { sid: sid.into(), mask };
        let private = [entry("S-1-5-18", 0x1f01ff), entry("S-1-5-32-544", 0x1f01ff), entry(me, 0x1f01ff)];
        assert_eq!(problem(me, Some(&private), me, Others::NoAccess), None);
        assert_eq!(problem("S-1-5-32-544", Some(&private), me, Others::NoAccess), None);
        let other_owner = problem("S-1-5-21-9-9-9-1001", Some(&private), me, Others::NoAccess).unwrap();
        assert!(other_owner.contains("owned by S-1-5-21-9-9-9-1001"), "{other_owner}");
        assert!(problem(me, None, me, Others::NoAccess).unwrap().contains("no access list"));
        // Another user, Authenticated Users, an unknown ACE type: all refused.
        for sid in ["S-1-5-21-9-9-9-1001", "S-1-5-11", "(ACE type 5)"] {
            let open = [&private[..], &[entry(sid, 0x1)]].concat();
            assert!(problem(me, Some(&open), me, Others::NoAccess).is_some(), "{sid}");
        }
        // Users reading the configuration folder is fine; writing is not.
        let readable = [&private[..], &[entry("S-1-5-32-545", 0x1200a9)]].concat();
        assert_eq!(problem(me, Some(&readable), me, Others::ReadOnly), None);
        assert!(problem(me, Some(&readable), me, Others::NoAccess).is_some());
        let writable = [&private[..], &[entry("S-1-5-32-545", 0x2)]].concat();
        assert!(problem(me, Some(&writable), me, Others::ReadOnly).unwrap().contains("may write"));
        // Synchronize and read-attributes alone do not count.
        let harmless = [&private[..], &[entry("S-1-1-0", 0x10_0080)]].concat();
        assert_eq!(problem(me, Some(&harmless), me, Others::NoAccess), None);
    }

    #[cfg(windows)]
    #[test]
    fn a_missing_config_folder_is_created_admin_only() {
        let root = tempfile::tempdir().unwrap();
        let folder = root.path().join("Kalzit");
        let dir = folder.join("data");
        prepare_with(&dir, Some(&folder)).unwrap();
        let sddl = acl::dacl_sddl(&folder).unwrap();
        let aces = acl::aces(&sddl);
        let users: Vec<_> = aces.iter().filter(|(_, _, t)| t == "BU").collect();
        assert_eq!(users.len(), 1, "{sddl}");
        assert!(users[0].1 == "0x1200a9", "Users read and execute only: {sddl}");
        acl::check_admin_only(&folder).unwrap();
        let text = format!("{:#}", acl::check(&folder, acl::Others::NoAccess).unwrap_err());
        assert!(text.contains("S-1-5-32-545"), "{text}");
        // A writable configuration file is refused.
        let file = folder.join("kalzit.toml");
        std::fs::write(&file, "").unwrap();
        acl::restrict(&file, "D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FW;;;BU)").unwrap();
        let text = format!("{:#}", check_admin_only(&file).unwrap_err());
        assert!(text.contains("S-1-5-32-545 may write") && text.contains("icacls"), "{text}");
    }
}
