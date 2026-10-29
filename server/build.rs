//! Embeds the commit and the date of the build, shown in Settings, About.
//!
//! Commit: `KALZIT_BUILD_COMMIT` (release pipelines, source archives without a `.git` folder),
//! then the checkout, then "unknown". Date: `KALZIT_BUILD_DATE`, then `SOURCE_DATE_EPOCH`, then
//! the date of the commit, and only without a checkout the day of the build. A value that is not
//! valid is reported as a build warning and ignored.

use std::path::Path;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

#[path = "build_info.rs"]
mod build_info;

fn git(args: &[&str]) -> Option<String> {
    let out = Command::new("git").args(args).output().ok()?;
    let text = String::from_utf8(out.stdout).ok()?.trim().to_string();
    (out.status.success() && !text.is_empty()).then_some(text)
}

/// Rebuilds when the checked out commit changes: HEAD, the branch it points to (a loose ref) and
/// packed-refs (where a branch lives after a pack).
fn watch_checkout() {
    let mut paths = Vec::new();
    paths.extend(git(&["rev-parse", "--git-path", "HEAD"]));
    paths.extend(git(&["rev-parse", "--git-path", "packed-refs"]));
    if let Some(branch) = git(&["symbolic-ref", "-q", "HEAD"]) {
        paths.extend(git(&["rev-parse", "--git-path", &branch]));
    }
    for path in paths {
        // A path that does not exist would make cargo rebuild every time.
        if Path::new(&path).exists() {
            println!("cargo:rerun-if-changed={path}");
        }
    }
}

fn env_value(name: &str, valid: fn(&str) -> bool) -> Option<String> {
    let value = std::env::var(name).ok().filter(|v| !v.is_empty())?;
    if valid(&value) {
        Some(value)
    } else {
        println!("cargo:warning={name} is not valid and is ignored");
        None
    }
}

fn commit() -> String {
    env_value("KALZIT_BUILD_COMMIT", build_info::valid_commit)
        .or_else(|| git(&["rev-parse", "--short=9", "HEAD"]).filter(|c| build_info::valid_commit(c)))
        .unwrap_or_else(|| "unknown".into())
}

fn date() -> String {
    if let Some(date) = env_value("KALZIT_BUILD_DATE", build_info::valid_date) {
        return date;
    }
    let epoch = std::env::var("SOURCE_DATE_EPOCH").ok().and_then(|v| v.parse::<u64>().ok());
    let from_commit = || git(&["show", "-s", "--format=%ct", "HEAD"]).and_then(|v| v.parse::<u64>().ok());
    let now = || SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs());
    build_info::date_of(epoch.or_else(from_commit).unwrap_or_else(now))
}

fn main() {
    // Windows: the loader looks for the DLLs `kalzit.exe` imports in System32 only, never in the
    // program folder (LOAD_LIBRARY_SEARCH_SYSTEM32), so a DLL placed next to the program is not
    // loaded, also not while an administrator or the installer runs it.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc")
    {
        println!("cargo:rustc-link-arg-bin=kalzit=/DEPENDENTLOADFLAG:0x800");
    }
    for name in ["KALZIT_BUILD_COMMIT", "KALZIT_BUILD_DATE", "SOURCE_DATE_EPOCH"] {
        println!("cargo:rerun-if-env-changed={name}");
    }
    watch_checkout();
    println!("cargo:rustc-env=KALZIT_BUILD_COMMIT={}", commit());
    println!("cargo:rustc-env=KALZIT_BUILD_DATE={}", date());
}
