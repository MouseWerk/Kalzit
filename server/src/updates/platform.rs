//! What this server runs on, whether it can install updates on its own, and how it starts the
//! next binary.
//!
//! Kalzit installs on its own only where a restart is safe without an operator:
//!
//! - Linux under systemd, with the binary's folder writable by the service account. The server
//!   stops gracefully and replaces itself with the new binary (`exec`), so the process id stays
//!   and systemd keeps supervising it; no privileges are needed for a restart.
//! - Windows only once Kalzit has its own service integration (with the service installer, see
//!   docs/PLAN.md, M5). Until then, Windows downloads and verifies, and an administrator runs
//!   `kalzit update apply` with the server stopped.
//!
//! Everywhere else (a console, a container, a binary owned by root) Kalzit prepares the update
//! and the status names the command to run.

use std::path::Path;
use std::process::ExitCode;
use std::time::Duration;

use super::UpdateError;

/// Operating system and processor as release packages name them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Platform {
    /// `linux` or `windows`.
    pub os: &'static str,
    /// `x64` or `arm64`.
    pub arch: &'static str,
}

impl Platform {
    pub fn current() -> Self {
        // Package names use the operating system's own name (`linux`, `windows`).
        let os = std::env::consts::OS;
        let arch = match std::env::consts::ARCH {
            "x86_64" => "x64",
            "aarch64" => "arm64",
            other => other,
        };
        Self { os, arch }
    }

    pub fn name(&self) -> String {
        format!("{}-{}", self.os, self.arch)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    /// Installs, restarts and checks itself.
    Automatic,
    /// Prepares only; the reason is an `updates.mode_*` code.
    Manual(&'static str),
}

/// Whether the server running `exe` may install on its own.
pub fn detect_mode(exe: &Path) -> Mode {
    if cfg!(windows) {
        return Mode::Manual("updates.mode_windows_service");
    }
    if !cfg!(target_os = "linux") {
        return Mode::Manual("updates.mode_unsupported_platform");
    }
    if Path::new("/.dockerenv").exists() || Path::new("/run/.containerenv").exists() {
        return Mode::Manual("updates.mode_container");
    }
    // systemd sets INVOCATION_ID for every service it starts.
    if std::env::var_os("INVOCATION_ID").is_none() {
        return Mode::Manual("updates.mode_not_systemd");
    }
    if !binary_writable(exe) {
        return Mode::Manual("updates.mode_binary_not_writable");
    }
    Mode::Automatic
}

/// Whether a file can be created next to `exe` and `exe` itself is not read-only.
fn binary_writable(exe: &Path) -> bool {
    let Some(dir) = exe.parent() else { return false };
    if std::fs::metadata(exe).map(|m| m.permissions().readonly()).unwrap_or(true) {
        return false;
    }
    let probe = dir.join(format!(".kalzit-write-probe-{}", std::process::id()));
    match std::fs::OpenOptions::new().write(true).create_new(true).open(&probe) {
        Ok(file) => {
            drop(file);
            let _ = std::fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

/// Free space for this process on the disk that holds `path`, if the system says.
pub fn free_space(path: &Path) -> Option<u64> {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        let c = std::ffi::CString::new(path.as_os_str().as_bytes()).ok()?;
        let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
        // SAFETY: `c` is a valid NUL-terminated path and `stat` a writable statvfs.
        let rc = unsafe { libc::statvfs(c.as_ptr(), &mut stat) };
        (rc == 0).then(|| (stat.f_bavail as u64).saturating_mul(stat.f_frsize as u64))
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        let wide: Vec<u16> = path.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
        let mut free = 0u64;
        // SAFETY: `wide` is NUL-terminated and `free` outlives the call.
        let ok = unsafe {
            windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW(
                windows::core::PCWSTR(wide.as_ptr()),
                Some(&mut free),
                None,
                None,
            )
        };
        ok.is_ok().then_some(free)
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = path;
        None
    }
}

/// Runs `binary --version` and expects it to name `version`: the package is a program for this
/// machine, not just signed bytes.
pub async fn smoke_test(binary: &Path, version: &str) -> Result<(), UpdateError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(binary, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| UpdateError::SmokeTestFailed(e.to_string()))?;
    }
    let run = tokio::process::Command::new(binary).arg("--version").kill_on_drop(true).output();
    let output = match tokio::time::timeout(Duration::from_secs(20), run).await {
        Ok(Ok(output)) => output,
        Ok(Err(e)) => return Err(UpdateError::SmokeTestFailed(e.to_string())),
        Err(_) => return Err(UpdateError::SmokeTestFailed("it did not answer within 20 seconds".into())),
    };
    let stdout = String::from_utf8_lossy(&output.stdout);
    if output.status.success() && stdout.split_whitespace().any(|w| w == version) {
        Ok(())
    } else {
        Err(UpdateError::SmokeTestFailed(format!(
            "it answered {:?} with status {}",
            stdout.trim().chars().take(200).collect::<String>(),
            output.status
        )))
    }
}

/// Starts `exe` with this process's arguments in its place. On Unix the process image is
/// replaced, so the process id (and a supervisor's view of it) stays; on Windows the new binary
/// runs as a child whose exit code this process returns.
pub fn relaunch(exe: &Path) -> ExitCode {
    let args: Vec<std::ffi::OsString> = std::env::args_os().skip(1).collect();
    tracing::info!("starting {}", exe.display());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        let e = std::process::Command::new(exe).args(&args).exec();
        eprintln!("kalzit: starting {} failed: {e}", exe.display());
        ExitCode::FAILURE
    }
    #[cfg(not(unix))]
    {
        match std::process::Command::new(exe).args(&args).status() {
            Ok(status) => ExitCode::from(status.code().map_or(1, |c| u8::try_from(c).unwrap_or(1))),
            Err(e) => {
                eprintln!("kalzit: starting {} failed: {e}", exe.display());
                ExitCode::FAILURE
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_platform_has_package_names() {
        let p = Platform::current();
        if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
            assert_eq!(p.name(), "linux-x64");
        }
        if cfg!(all(windows, target_arch = "x86_64")) {
            assert_eq!(p.name(), "windows-x64");
        }
    }

    #[test]
    fn windows_and_consoles_prepare_only() {
        let dir = tempfile::tempdir().unwrap();
        let exe = dir.path().join("kalzit");
        std::fs::write(&exe, "x").unwrap();
        let mode = detect_mode(&exe);
        if cfg!(windows) {
            assert_eq!(mode, Mode::Manual("updates.mode_windows_service"));
        } else if std::env::var_os("INVOCATION_ID").is_none() && !Path::new("/.dockerenv").exists() {
            assert_eq!(mode, Mode::Manual("updates.mode_not_systemd"));
        }
        assert!(binary_writable(&exe));
        assert!(!binary_writable(&dir.path().join("missing").join("kalzit")));
    }

    #[test]
    fn free_space_is_known_for_a_local_folder() {
        let dir = tempfile::tempdir().unwrap();
        assert!(free_space(dir.path()).is_some_and(|f| f > 0));
    }

    #[tokio::test]
    async fn the_smoke_test_refuses_what_does_not_run() {
        let dir = tempfile::tempdir().unwrap();
        let fake = dir.path().join("not-a-program");
        std::fs::write(&fake, b"signed bytes, but no program").unwrap();
        assert!(matches!(smoke_test(&fake, "1.0.0").await, Err(UpdateError::SmokeTestFailed(_))));
    }
}
