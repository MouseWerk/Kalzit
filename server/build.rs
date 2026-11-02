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

/// Appends one entry of a compiled resource file (.res): a header with a numeric type and name,
/// then the data, both padded to four bytes.
fn push_resource(res: &mut Vec<u8>, kind: u16, name: u16, data: &[u8]) {
    const LANG_NEUTRAL: u16 = 0;
    // MOVEABLE | PURE | DISCARDABLE, as rc.exe writes them for icons.
    const FLAGS: u16 = 0x1030;
    let mut header = Vec::with_capacity(32);
    header.extend_from_slice(&u32::try_from(data.len()).unwrap_or(u32::MAX).to_le_bytes());
    header.extend_from_slice(&32u32.to_le_bytes());
    header.extend_from_slice(&[0xFF, 0xFF]);
    header.extend_from_slice(&kind.to_le_bytes());
    header.extend_from_slice(&[0xFF, 0xFF]);
    header.extend_from_slice(&name.to_le_bytes());
    header.extend_from_slice(&0u32.to_le_bytes());
    header.extend_from_slice(&FLAGS.to_le_bytes());
    header.extend_from_slice(&LANG_NEUTRAL.to_le_bytes());
    header.extend_from_slice(&0u32.to_le_bytes());
    header.extend_from_slice(&0u32.to_le_bytes());
    res.extend_from_slice(&header);
    res.extend_from_slice(data);
    while !res.len().is_multiple_of(4) {
        res.push(0);
    }
}

/// The program icon of `kalzit.exe` as a resource file the MSVC linker takes directly, built from
/// packaging/windows/kalzit.ico (made by tools/brand/build-icons.mjs) without a resource compiler:
/// each image becomes an RT_ICON, the directory an RT_GROUP_ICON with the id Explorer shows.
fn icon_resource(ico: &[u8]) -> Option<Vec<u8>> {
    const RT_ICON: u16 = 3;
    const RT_GROUP_ICON: u16 = 14;
    let word = |at: usize| Some(u16::from_le_bytes(ico.get(at..at + 2)?.try_into().ok()?));
    let dword = |at: usize| Some(u32::from_le_bytes(ico.get(at..at + 4)?.try_into().ok()?));
    if word(0)? != 0 || word(2)? != 1 {
        return None;
    }
    let count = word(4)?;
    // An empty first entry (type 0, name 0) marks a 32-bit resource file.
    let mut res = vec![0, 0, 0, 0, 0x20, 0, 0, 0, 0xFF, 0xFF, 0, 0, 0xFF, 0xFF, 0, 0];
    res.extend_from_slice(&[0; 16]);
    let mut group = Vec::new();
    group.extend_from_slice(&0u16.to_le_bytes());
    group.extend_from_slice(&1u16.to_le_bytes());
    group.extend_from_slice(&count.to_le_bytes());
    for index in 0..count {
        let entry = 6 + 16 * usize::from(index);
        let size = usize::try_from(dword(entry + 8)?).ok()?;
        let offset = usize::try_from(dword(entry + 12)?).ok()?;
        let image = ico.get(offset..offset.checked_add(size)?)?;
        let id = index + 1;
        push_resource(&mut res, RT_ICON, id, image);
        // GRPICONDIRENTRY: the ICONDIRENTRY's first 12 bytes, then the resource id.
        group.extend_from_slice(ico.get(entry..entry + 12)?);
        group.extend_from_slice(&id.to_le_bytes());
    }
    push_resource(&mut res, RT_GROUP_ICON, 1, &group);
    Some(res)
}

/// Links the icon into `kalzit.exe` on Windows with the MSVC toolchain.
fn windows_icon() {
    let Ok(manifest) = std::env::var("CARGO_MANIFEST_DIR") else { return };
    let ico_path = Path::new(&manifest).join("../packaging/windows/kalzit.ico");
    println!("cargo:rerun-if-changed={}", ico_path.display());
    let Some(res) = std::fs::read(&ico_path).ok().and_then(|ico| icon_resource(&ico)) else {
        println!("cargo:warning=packaging/windows/kalzit.ico is missing or not an icon; kalzit.exe has no icon");
        return;
    };
    let Ok(out) = std::env::var("OUT_DIR") else { return };
    let res_path = Path::new(&out).join("kalzit-icon.res");
    if std::fs::write(&res_path, res).is_ok() {
        println!("cargo:rustc-link-arg-bin=kalzit={}", res_path.display());
    }
}

fn main() {
    // Windows: the loader looks for the DLLs `kalzit.exe` imports in System32 only, never in the
    // program folder (LOAD_LIBRARY_SEARCH_SYSTEM32), so a DLL placed next to the program is not
    // loaded, also not while an administrator or the installer runs it.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc")
    {
        println!("cargo:rustc-link-arg-bin=kalzit=/DEPENDENTLOADFLAG:0x800");
        windows_icon();
    }
    for name in ["KALZIT_BUILD_COMMIT", "KALZIT_BUILD_DATE", "SOURCE_DATE_EPOCH"] {
        println!("cargo:rerun-if-env-changed={name}");
    }
    watch_checkout();
    println!("cargo:rustc-env=KALZIT_BUILD_COMMIT={}", commit());
    println!("cargo:rustc-env=KALZIT_BUILD_DATE={}", date());
}
