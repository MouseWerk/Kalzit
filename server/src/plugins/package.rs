//! A plugin package from a file: a zip archive with `kalzit-plugin.toml`, optionally
//! `kalzit-plugin.sig`, and the files the manifest lists, at its root.
//!
//! The package is unpacked into a fresh directory only Kalzit's service account can write
//! (`private_dir`), its entries are listed there without following links, hashed and compared
//! with the manifest (`Manifest::check_package`), and the signature is checked against the
//! trusted keys (`verify`). The plugin later runs from that same directory, so nothing can change
//! between the check and the start (docs/ARCHITECTURE.md, "Signing and trust").

use std::collections::{BTreeMap, HashSet};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use base64::Engine;
use ed25519_dalek::{Signature, VerifyingKey};
use kalzit_plugin_api::manifest::{self, EntryKind, MANIFEST_FILE, Manifest, PackageEntry, SIGNATURE_FILE};
use kalzit_plugin_api::signing::{self, Signer};
use sha2::{Digest, Sha256};

use super::HostError;

/// The largest package file accepted.
pub const MAX_PACKAGE_BYTES: u64 = 256 * 1024 * 1024;
/// The most a package may hold once unpacked; a zip bomb stops here.
pub const MAX_UNPACKED_BYTES: u64 = 1024 * 1024 * 1024;
/// Entries one package may have (the manifest lists at most 4096 files, plus directories).
const MAX_ENTRIES: usize = 8192;
/// The largest signature file accepted.
const MAX_SIGNATURE_BYTES: u64 = 4 * 1024;

/// What a package holds once unpacked and checked against its own manifest.
#[derive(Debug)]
pub struct Unpacked {
    pub manifest: Manifest,
    /// The exact bytes of `kalzit-plugin.toml`, which the signature covers.
    pub manifest_text: String,
    pub signature: Option<kalzit_release::DetachedSignature>,
}

fn invalid(issues: Vec<String>) -> HostError {
    let shown: Vec<&str> = issues.iter().take(20).map(String::as_str).collect();
    HostError::new("plugin.package_invalid", format!("the plugin package is not valid: {}", shown.join("; ")))
        .with("issues", shown.join("; "))
}

/// Creates `dir` so that only Kalzit's account (and SYSTEM and Administrators on Windows) may
/// write it, and on Windows grants plugin processes what `access` says, by a SID of their
/// restricted token (Linux: the same account, 0700; Landlock decides what the plugin reaches).
pub fn private_dir(dir: &Path, access: &PluginAccess) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        let _ = access;
        use std::os::unix::fs::DirBuilderExt;
        std::fs::DirBuilder::new().mode(0o700).create(dir)
    }
    #[cfg(windows)]
    {
        crate::data_dir::acl::create_dir(dir, &access.sddl()?)?;
        // Plugins run at low integrity: they write only where the label says they may.
        if matches!(access, PluginAccess::Modify(_)) {
            super::sandbox::label_low(dir)?;
        }
        Ok(())
    }
}

/// What sandboxed plugin processes may do in a directory Kalzit creates for them, and by which
/// SID of their token (Windows).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PluginAccess {
    /// Nothing: the host's own files (uploads, the package root).
    None,
    /// Read and run, for the plugin's SID (`plugin_sid`): its package. Other plugins cannot.
    ReadExecute(String),
    /// Read, write and delete, but not run, for the SID of one start: its run directory. Other
    /// plugins and other starts cannot.
    Modify(String),
}

/// The SID that names one plugin in its processes' tokens (Windows): from its id, so the
/// package directory made at install and every start agree. `S-1-9` is the resource manager
/// authority, which no account or group uses.
pub fn plugin_sid(id: &str) -> String {
    let digest = Sha256::digest(format!("kalzit-plugin-sid\n{id}").as_bytes());
    let part = |i: usize| u32::from_be_bytes(digest[i * 4..i * 4 + 4].try_into().expect("4 bytes"));
    format!("S-1-9-{}-{}-{}-{}", part(0), part(1), part(2), part(3))
}

/// A SID for one start of a plugin (Windows), random.
pub fn start_sid() -> String {
    format!(
        "S-1-9-{}-{}-{}-{}",
        rand::random::<u32>(),
        rand::random::<u32>(),
        rand::random::<u32>(),
        rand::random::<u32>()
    )
}

#[cfg(windows)]
impl PluginAccess {
    /// SYSTEM, Administrators and Kalzit's account full, inherited, plus the plugin's or the
    /// start's SID. Kalzit's account is named by its SID, not as the owner: when Kalzit runs
    /// elevated, Administrators own what it creates, and the plugin's token holds Administrators
    /// for deny only.
    fn sddl(&self) -> std::io::Result<String> {
        let user = crate::data_dir::acl::current_user()?;
        let base = format!("D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;OW)(A;OICI;FA;;;{user})");
        Ok(match self {
            PluginAccess::None => crate::data_dir::acl::DIR_SDDL.to_string(),
            // `AC` (all AppContainers) passes the AppContainer check of the plugin's token; the
            // plugin's or the start's SID still decides which plugin gets in.
            PluginAccess::ReadExecute(sid) => format!("{base}(A;OICI;0x1200a9;;;{sid})(A;OICI;0x1200a9;;;AC)"),
            PluginAccess::Modify(sid) => format!("{base}(A;OICI;0x13019f;;;{sid})(A;OICI;0x13019f;;;AC)"),
        })
    }
}

/// Unpacks the zip file `archive` into `into` (a fresh, private directory) and checks it: every
/// entry path is a valid package path, nothing is a link or device, nothing appears twice (also
/// not in other case), the sizes stay within `MAX_UNPACKED_BYTES`, the manifest is valid and
/// the unpacked files are exactly the ones it lists, with their hashes.
pub fn unpack(archive: &Path, into: &Path) -> Result<Unpacked, HostError> {
    let file = std::fs::File::open(archive)?;
    if file.metadata()?.len() > MAX_PACKAGE_BYTES {
        return Err(HostError::new("plugin.package_too_large", "the plugin package is too large")
            .with("maxBytes", MAX_PACKAGE_BYTES));
    }
    let mut zip = zip::ZipArchive::new(file)
        .map_err(|e| HostError::new("plugin.package_unreadable", format!("the file is not a zip archive: {e}")))?;
    if zip.len() > MAX_ENTRIES {
        return Err(invalid(vec![format!("more than {MAX_ENTRIES} entries")]));
    }
    // Every entry is checked before anything is written.
    let mut issues = Vec::new();
    let mut seen = HashSet::new();
    let mut plan: Vec<(usize, String, bool)> = Vec::new();
    for index in 0..zip.len() {
        let entry = zip
            .by_index_raw(index)
            .map_err(|e| HostError::new("plugin.package_unreadable", format!("the zip archive is broken: {e}")))?;
        let Ok(name) = entry.name().map(|n| n.into_owned()) else {
            issues.push(format!("entry {index}: the name is not readable"));
            continue;
        };
        let is_dir = entry.is_dir();
        let path = if is_dir { name.trim_end_matches('/').to_string() } else { name.clone() };
        let special = entry.is_symlink() || is_special_mode(entry.unix_mode());
        if !manifest::is_package_path(&path) {
            issues.push(format!("{name}: not a valid package path"));
        } else if special {
            issues.push(format!("{path}: links and special files are refused"));
        } else if entry.encrypted() {
            issues.push(format!("{path}: encrypted entries are refused"));
        } else if !seen.insert(path.to_lowercase()) {
            issues.push(format!("{path}: appears twice (paths may not differ only in case)"));
        } else {
            plan.push((index, path, is_dir));
        }
    }
    if !issues.is_empty() {
        return Err(invalid(issues));
    }
    let mut written: u64 = 0;
    for (index, path, is_dir) in plan {
        let target = path.split('/').fold(into.to_path_buf(), |p, part| p.join(part));
        if is_dir {
            std::fs::create_dir_all(&target)?;
            continue;
        }
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut entry = zip
            .by_index(index)
            .map_err(|e| HostError::new("plugin.package_unreadable", format!("{path} cannot be read: {e}")))?;
        let mut out = std::fs::OpenOptions::new().write(true).create_new(true).open(&target)?;
        // The size in the archive is not trusted: the copy stops at the limit.
        let left = MAX_UNPACKED_BYTES - written;
        let copied = std::io::copy(&mut (&mut entry).take(left + 1), &mut out)
            .map_err(|e| HostError::new("plugin.package_unreadable", format!("{path} cannot be unpacked: {e}")))?;
        if copied > left {
            return Err(HostError::new("plugin.package_too_large", "the unpacked plugin package is too large")
                .with("maxBytes", MAX_UNPACKED_BYTES));
        }
        written += copied;
        out.flush()?;
    }
    read_unpacked(into)
}

/// The manifest and the signature as the archive holds them, read without unpacking anything:
/// the signature and the trust are checked before a file is written.
pub fn read_from_zip(archive: &Path) -> Result<Unpacked, HostError> {
    let file = std::fs::File::open(archive)?;
    if file.metadata()?.len() > MAX_PACKAGE_BYTES {
        return Err(HostError::new("plugin.package_too_large", "the plugin package is too large")
            .with("maxBytes", MAX_PACKAGE_BYTES));
    }
    let mut zip = zip::ZipArchive::new(file)
        .map_err(|e| HostError::new("plugin.package_unreadable", format!("the file is not a zip archive: {e}")))?;
    let mut read = |name: &str, limit: u64| -> Result<Option<Vec<u8>>, HostError> {
        let entry = match zip.by_name(name) {
            Ok(entry) => entry,
            Err(zip::result::ZipError::FileNotFound) => return Ok(None),
            Err(e) => return Err(HostError::new("plugin.package_unreadable", format!("{name} cannot be read: {e}"))),
        };
        let mut bytes = Vec::new();
        entry
            .take(limit + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| HostError::new("plugin.package_unreadable", format!("{name} cannot be read: {e}")))?;
        if bytes.len() as u64 > limit {
            return Err(HostError::new("plugin.manifest_invalid", format!("{name} is too large")));
        }
        Ok(Some(bytes))
    };
    let manifest_bytes = read(MANIFEST_FILE, manifest::MAX_MANIFEST_BYTES as u64)?.ok_or_else(|| {
        HostError::new("plugin.manifest_missing", format!("the package has no readable {MANIFEST_FILE}"))
    })?;
    let signature = read(SIGNATURE_FILE, MAX_SIGNATURE_BYTES)?;
    let manifest_text = String::from_utf8(manifest_bytes)
        .map_err(|_| HostError::new("plugin.manifest_invalid", format!("{MANIFEST_FILE} is not UTF-8")))?;
    let manifest = manifest::parse(&manifest_text).map_err(|e| {
        let issues: Vec<String> = e.0.iter().map(|i| format!("{} ({})", i, i.code)).collect();
        HostError::new("plugin.manifest_invalid", e.to_string()).with("issues", issues.join("; "))
    })?;
    let signature = signature
        .map(|bytes| {
            serde_json::from_slice::<kalzit_release::DetachedSignature>(&bytes).map_err(|e| {
                HostError::new("plugin.signature_invalid", format!("{SIGNATURE_FILE} is not a signature: {e}"))
            })
        })
        .transpose()?;
    Ok(Unpacked { manifest, manifest_text, signature })
}

/// Whether an archive entry's Unix mode names anything but a plain file or a directory (a link,
/// a device, a FIFO, a socket). Entries without a mode (Windows tools) count as plain.
fn is_special_mode(mode: Option<u32>) -> bool {
    let file_type = mode.map_or(0, |m| m & 0o170_000);
    !matches!(file_type, 0 | 0o100_000 | 0o040_000)
}

/// Reads and checks an unpacked package in `dir`: the manifest, the signature file and every
/// entry against the manifest.
pub fn read_unpacked(dir: &Path) -> Result<Unpacked, HostError> {
    let manifest_path = dir.join(MANIFEST_FILE);
    let bytes = read_limited(&manifest_path, manifest::MAX_MANIFEST_BYTES as u64 + 1).map_err(|_| {
        HostError::new("plugin.manifest_missing", format!("the package has no readable {MANIFEST_FILE}"))
    })?;
    let manifest_text = String::from_utf8(bytes)
        .map_err(|_| HostError::new("plugin.manifest_invalid", format!("{MANIFEST_FILE} is not UTF-8")))?;
    let manifest = manifest::parse(&manifest_text).map_err(|e| {
        let issues: Vec<String> = e.0.iter().map(|i| format!("{} ({})", i, i.code)).collect();
        HostError::new("plugin.manifest_invalid", e.to_string()).with("issues", issues.join("; "))
    })?;
    let signature = match read_limited(&dir.join(SIGNATURE_FILE), MAX_SIGNATURE_BYTES + 1) {
        Ok(bytes) => Some(serde_json::from_slice::<kalzit_release::DetachedSignature>(&bytes).map_err(|e| {
            HostError::new("plugin.signature_invalid", format!("{SIGNATURE_FILE} is not a signature: {e}"))
        })?),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(e.into()),
    };
    let entries = list(dir)?;
    manifest.check_package(&entries).map_err(|e| {
        let issues: Vec<String> = e.0.iter().map(|i| format!("{} ({})", i, i.code)).collect();
        invalid(issues)
    })?;
    Ok(Unpacked { manifest, manifest_text, signature })
}

fn read_limited(path: &Path, limit: u64) -> std::io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    std::fs::File::open(path)?.take(limit).read_to_end(&mut bytes)?;
    if bytes.len() as u64 >= limit {
        return Err(std::io::Error::other("the file is too large"));
    }
    Ok(bytes)
}

/// Every entry below `dir`, listed without following links. Symbolic links, junctions and
/// other reparse points, files with more than one hard link and anything that is neither a
/// plain file nor a directory are `EntryKind::Other`; files carry their SHA-256.
pub fn list(dir: &Path) -> std::io::Result<Vec<PackageEntry>> {
    let mut out = Vec::new();
    walk(dir, "", &mut out)?;
    Ok(out)
}

fn walk(dir: &Path, prefix: &str, out: &mut Vec<PackageEntry>) -> std::io::Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let path = if prefix.is_empty() { name } else { format!("{prefix}/{name}") };
        let full = entry.path();
        // Never follows a link: the entry's own metadata.
        let meta = std::fs::symlink_metadata(&full)?;
        let kind = if is_special(&full, &meta)? {
            EntryKind::Other
        } else if meta.is_dir() {
            walk(&full, &path, out)?;
            EntryKind::Directory
        } else if meta.is_file() {
            EntryKind::File { sha256: sha256_file(&full)? }
        } else {
            EntryKind::Other
        };
        out.push(PackageEntry { path, kind });
    }
    Ok(())
}

#[cfg(unix)]
fn is_special(_path: &Path, meta: &std::fs::Metadata) -> std::io::Result<bool> {
    use std::os::unix::fs::MetadataExt;
    let ft = meta.file_type();
    Ok(ft.is_symlink() || !(ft.is_dir() || ft.is_file()) || (ft.is_file() && meta.nlink() > 1))
}

#[cfg(windows)]
fn is_special(path: &Path, meta: &std::fs::Metadata) -> std::io::Result<bool> {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    let ft = meta.file_type();
    if ft.is_symlink() || meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 || !(ft.is_dir() || ft.is_file()) {
        return Ok(true);
    }
    Ok(ft.is_file() && hard_links(path)? > 1)
}

/// The number of hard links of a file (`GetFileInformationByHandle`).
#[cfg(windows)]
fn hard_links(path: &Path) -> std::io::Result<u32> {
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::Storage::FileSystem::{BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle};
    let file = std::fs::File::open(path)?;
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    // SAFETY: the handle is open for the call and `info` is a valid out pointer.
    unsafe { GetFileInformationByHandle(HANDLE(file.as_raw_handle()), &mut info) }
        .map_err(|e| std::io::Error::other(e.to_string()))?;
    Ok(info.nNumberOfLinks)
}

pub fn sha256_file(path: &Path) -> std::io::Result<String> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        hasher.update(&buffer[..n]);
    }
    Ok(hex::encode(hasher.finalize()))
}

/// A trusted key: Kalzit's own plugin key or a publisher key an administrator added.
#[derive(Clone, Debug)]
pub struct TrustedKey {
    pub key: VerifyingKey,
    pub signer: Signer,
}

/// Who signed a package, after its signature verified.
#[derive(Clone, Debug)]
pub struct Verified {
    pub signer: Signer,
    pub key: Option<VerifyingKey>,
}

/// Checks the signature of `unpacked` against `trusted`. A signature that names a trusted key
/// but does not verify is always refused, also when unsigned plugins are allowed; one that
/// names no trusted key is refused as untrusted; no signature is accepted only with
/// `allow_unsigned`. Reserved ids need Kalzit's key (`signing::check_signer`).
pub fn verify(unpacked: &Unpacked, trusted: &[TrustedKey], allow_unsigned: bool) -> Result<Verified, HostError> {
    let verified = match &unpacked.signature {
        None if allow_unsigned => Verified { signer: Signer::Unsigned, key: None },
        None => {
            return Err(HostError::new(
                "plugin.unsigned_refused",
                "the plugin is not signed, and unsigned plugins are not allowed on this server",
            ));
        }
        Some(sig) => {
            let invalid = || HostError::new("plugin.signature_invalid", "the plugin's signature does not verify");
            let bytes =
                base64::engine::general_purpose::STANDARD.decode(sig.signature.trim()).map_err(|_| invalid())?;
            let signature = Signature::from_slice(&bytes).map_err(|_| invalid())?;
            let candidates: Vec<&TrustedKey> =
                trusted.iter().filter(|t| signing::key_id(&t.key) == sig.key_id).collect();
            if candidates.is_empty() {
                return Err(HostError::new(
                    "plugin.signer_untrusted",
                    format!("the plugin is signed with key {}, which this server does not trust", sig.key_id),
                )
                .with("keyId", &sig.key_id));
            }
            let Some(t) = candidates
                .into_iter()
                .find(|t| signing::verify_manifest(&t.key, unpacked.manifest_text.as_bytes(), &signature))
            else {
                return Err(invalid());
            };
            Verified { signer: t.signer, key: Some(t.key) }
        }
    };
    signing::check_signer(&unpacked.manifest, verified.signer).map_err(|r| refusal(&r))?;
    Ok(verified)
}

/// A trust refusal of `kalzit-plugin-api` as the host's error.
pub fn refusal(r: &signing::Refusal) -> HostError {
    let message = match r {
        signing::Refusal::ReservedId => "ids under io.kalzit. and dev.kalzit. need Kalzit's own plugin key",
        signing::Refusal::OtherPlugin => "the package is for another plugin",
        signing::Refusal::Downgrade => "the package is older than the installed version",
        signing::Refusal::KeyChanged => {
            "the update is not signed by the installed version's key or a key it was handed over to"
        }
    };
    let reason = match r {
        signing::Refusal::ReservedId => "plugin.id_reserved",
        signing::Refusal::OtherPlugin => "plugin.update_other_id",
        signing::Refusal::Downgrade => "plugin.downgrade",
        signing::Refusal::KeyChanged => "plugin.key_changed",
    };
    debug_assert_eq!(reason, r.code());
    HostError::new(reason, message)
}

/// Lets Kalzit's account run the binary of this platform (zip files carry no mode Kalzit
/// trusts; unpacked files are not executable). Windows needs nothing.
pub fn make_executable(program: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(program, std::fs::Permissions::from_mode(0o700))?;
    }
    #[cfg(not(unix))]
    let _ = program;
    Ok(())
}

/// The binary of this platform, as a path inside the package directory.
pub fn binary(manifest: &Manifest, package_dir: &Path) -> Result<PathBuf, HostError> {
    let platform = super::platform()
        .ok_or_else(|| HostError::new("plugin.platform_unsupported", "plugins cannot run on this platform"))?;
    let path = manifest.binaries.get(platform).ok_or_else(|| {
        HostError::new("plugin.platform_missing", format!("the plugin has no binary for {platform}"))
            .with("platform", platform)
    })?;
    Ok(path.split('/').fold(package_dir.to_path_buf(), |p, part| p.join(part)))
}

/// Checks the platform's binary against the SHA-256 the signed manifest lists, before every
/// start: a file changed after the installation never runs. The binary is opened as a regular
/// file only (a link in its place is refused).
pub fn verify_binary(manifest: &Manifest, package_dir: &Path) -> Result<(), HostError> {
    let platform = super::platform()
        .ok_or_else(|| HostError::new("plugin.platform_unsupported", "plugins cannot run on this platform"))?;
    let changed = |detail: String| {
        HostError::new(
            "plugin.binary_changed",
            format!("the plugin's program no longer matches its signed package ({detail}); install the plugin again"),
        )
    };
    let rel = manifest.binaries.get(platform).ok_or_else(|| {
        HostError::new("plugin.platform_missing", format!("the plugin has no binary for {platform}"))
            .with("platform", platform)
    })?;
    let expected = manifest.files.get(rel).ok_or_else(|| changed(format!("{rel} is not listed")))?;
    let path = rel.split('/').fold(package_dir.to_path_buf(), |p, part| p.join(part));
    let mut file = crate::updates::install::open_regular(&path).map_err(|e| changed(format!("{rel}: {e}")))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buffer).map_err(|e| changed(format!("{rel}: {e}")))?;
        if n == 0 {
            break;
        }
        hasher.update(&buffer[..n]);
    }
    if hex::encode(hasher.finalize()) != expected.to_ascii_lowercase() {
        return Err(changed(format!("{rel} has another SHA-256")).with("path", rel.as_str()));
    }
    Ok(())
}

/// A public key as an administrator pastes it: 32 bytes in base64 (as `kalzit-sign` prints keys)
/// or in hex. Weak keys are refused.
pub fn parse_public_key(text: &str) -> Option<VerifyingKey> {
    let text = text.trim();
    let bytes = if text.len() == 64 && text.bytes().all(|b| b.is_ascii_hexdigit()) {
        hex::decode(text).ok()?
    } else {
        base64::engine::general_purpose::STANDARD.decode(text).ok()?
    };
    let key = VerifyingKey::from_bytes(&<[u8; 32]>::try_from(bytes).ok()?).ok()?;
    (!key.is_weak()).then_some(key)
}

/// Kalzit's own plugin public keys, compiled in (base64): the main key, which the release
/// workflow signs Kalzit's plugins with (`KALZIT_PLUGIN_SIGNING_KEY` in the release
/// environment), and the backup key, kept offline to sign with should the main key be lost.
/// Packages under `io.kalzit.` and `dev.kalzit.` need one of them.
pub const COMPILED_KALZIT_KEYS: &[&str] = &[KALZIT_PLUGIN_MAIN_KEY, KALZIT_PLUGIN_BACKUP_KEY];

/// The main plugin key, key id 581c30a0d8384cfd. The release workflow reads this line to check
/// the signed packages against it; keep the name and the form.
pub const KALZIT_PLUGIN_MAIN_KEY: &str = "6RZV2LeoOy9gDyW7Izi8OXRoDbMjsWQ3FiZabeC4D6c=";

/// The offline backup plugin key, key id df87ab1649696788.
pub const KALZIT_PLUGIN_BACKUP_KEY: &str = "t0SLQ6UM+XNRoqJJai/6aSx8t8ITdjIz3uL7tuv0gh8=";

/// Kalzit's own plugin keys: [`COMPILED_KALZIT_KEYS`] plus `KALZIT_PLUGIN_PUBLIC_KEYS` at build
/// time (comma-separated base64), for a fork or a test build with keys of its own.
pub fn kalzit_keys() -> Vec<VerifyingKey> {
    const COMPILED: &[&str] = COMPILED_KALZIT_KEYS;
    const BUILD: Option<&str> = option_env!("KALZIT_PLUGIN_PUBLIC_KEYS");
    COMPILED
        .iter()
        .copied()
        .chain(BUILD.unwrap_or_default().split(',').filter(|k| !k.trim().is_empty()))
        .filter_map(parse_public_key)
        .collect()
}

/// The manifest's permissions as the administrator approves them: one line per network target.
pub fn permission_lines(manifest: &Manifest) -> Vec<BTreeMap<&'static str, String>> {
    manifest
        .permissions
        .network
        .iter()
        .map(|t| {
            let mut line = BTreeMap::new();
            let fields = [
                ("setting", t.setting.clone()),
                ("form", t.form.clone()),
                ("portSetting", t.port_setting.clone()),
                ("defaultPort", t.default_port.map(|p| p.to_string())),
                ("host", t.host.clone()),
                ("port", t.port.map(|p| p.to_string())),
                ("protocol", Some(t.protocol.clone().unwrap_or_else(|| "tcp".into()))),
            ];
            for (key, value) in fields {
                if let Some(v) = value {
                    line.insert(key, v);
                }
            }
            line
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use ed25519_dalek::{Signer as _, SigningKey};
    use zip::write::SimpleFileOptions;

    use super::*;

    const BINARY: &[u8] = b"not really a program";

    #[test]
    fn kalzits_plugin_keys_are_compiled_in() {
        let ids: Vec<String> =
            COMPILED_KALZIT_KEYS.iter().map(|k| signing::key_id(&parse_public_key(k).expect("a valid key"))).collect();
        assert_eq!(ids, ["581c30a0d8384cfd", "df87ab1649696788"]);
        let all = kalzit_keys();
        for k in COMPILED_KALZIT_KEYS {
            assert!(all.contains(&parse_public_key(k).unwrap()));
        }
    }

    fn manifest_for(files: &[(&str, &[u8])]) -> String {
        let platform = crate::plugins::platform().unwrap_or("linux-x64");
        let mut text = format!(
            "manifest = 1\nid = \"dev.example.test\"\nname = \"Test\"\nversion = \"1.0.0\"\nkind = \"datasource\"\n\
             min_kalzit = \"0.1.0\"\nshapes = [\"frame\"]\nprotocol = 1\n\n[binaries]\n{platform} = \"bin/plugin{}\"\n\n[files]\n",
            if platform.starts_with("windows") { ".exe" } else { "" }
        );
        for (path, bytes) in files {
            text.push_str(&format!("\"{path}\" = \"{}\"\n", hex::encode(Sha256::digest(bytes))));
        }
        text
    }

    fn binary_path() -> &'static str {
        if crate::plugins::platform().is_some_and(|p| p.starts_with("windows")) {
            "bin/plugin.exe"
        } else {
            "bin/plugin"
        }
    }

    #[test]
    fn a_binary_changed_after_the_installation_does_not_start() {
        let dir = tempfile::tempdir().unwrap();
        let manifest = manifest::parse(&manifest_for(&[(binary_path(), BINARY)])).unwrap();
        let program = binary_path().split('/').fold(dir.path().to_path_buf(), |p, part| p.join(part));
        std::fs::create_dir_all(program.parent().unwrap()).unwrap();
        // Missing: refused.
        assert_eq!(verify_binary(&manifest, dir.path()).unwrap_err().reason, "plugin.binary_changed");
        std::fs::write(&program, BINARY).unwrap();
        verify_binary(&manifest, dir.path()).unwrap();
        std::fs::write(&program, b"swapped by someone else").unwrap();
        assert_eq!(verify_binary(&manifest, dir.path()).unwrap_err().reason, "plugin.binary_changed");
    }

    fn zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut out = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for (name, bytes) in entries {
            out.start_file(*name, SimpleFileOptions::default()).unwrap();
            out.write_all(bytes).unwrap();
        }
        out.finish().unwrap().into_inner()
    }

    fn unpack_bytes(bytes: &[u8]) -> (tempfile::TempDir, Result<Unpacked, HostError>) {
        let root = tempfile::tempdir().unwrap();
        let archive = root.path().join("p.zip");
        std::fs::write(&archive, bytes).unwrap();
        let into = root.path().join("unpacked");
        std::fs::create_dir(&into).unwrap();
        let result = unpack(&archive, &into);
        (root, result)
    }

    #[test]
    fn a_complete_package_unpacks_and_matches_its_manifest() {
        let manifest = manifest_for(&[(binary_path(), BINARY)]);
        let (root, result) = unpack_bytes(&zip(&[(MANIFEST_FILE, manifest.as_bytes()), (binary_path(), BINARY)]));
        let unpacked = result.unwrap();
        assert_eq!(unpacked.manifest.id, "dev.example.test");
        assert_eq!(unpacked.manifest_text, manifest);
        assert!(unpacked.signature.is_none());
        let bin = binary(&unpacked.manifest, &root.path().join("unpacked")).unwrap();
        assert_eq!(std::fs::read(bin).unwrap(), BINARY);
    }

    fn reason(result: Result<Unpacked, HostError>) -> (&'static str, String) {
        let e = result.unwrap_err();
        (e.reason, e.message)
    }

    #[test]
    fn unlisted_changed_and_missing_files_are_refused() {
        let manifest = manifest_for(&[(binary_path(), BINARY)]);
        let extra = zip(&[(MANIFEST_FILE, manifest.as_bytes()), (binary_path(), BINARY), ("evil.dll", b"x")]);
        let (_root, result) = unpack_bytes(&extra);
        let (code, text) = reason(result);
        assert_eq!(code, "plugin.package_invalid");
        assert!(text.contains("package.file_unlisted"), "{text}");

        let changed = zip(&[(MANIFEST_FILE, manifest.as_bytes()), (binary_path(), b"other bytes")]);
        let (_root, result) = unpack_bytes(&changed);
        assert!(reason(result).1.contains("package.hash_mismatch"));

        let missing = zip(&[(MANIFEST_FILE, manifest.as_bytes())]);
        let (_root, result) = unpack_bytes(&missing);
        assert!(reason(result).1.contains("package.file_missing"));

        let no_manifest = zip(&[(binary_path(), BINARY)]);
        let (_root, result) = unpack_bytes(&no_manifest);
        assert_eq!(reason(result).0, "plugin.manifest_missing");

        let (_root, result) = unpack_bytes(b"this is no zip file");
        assert_eq!(reason(result).0, "plugin.package_unreadable");
    }

    #[test]
    fn links_bad_paths_and_case_twins_are_refused_before_anything_is_written() {
        let manifest = manifest_for(&[(binary_path(), BINARY)]);
        let mut out = zip::ZipWriter::new(Cursor::new(Vec::new()));
        out.start_file(MANIFEST_FILE, SimpleFileOptions::default()).unwrap();
        out.write_all(manifest.as_bytes()).unwrap();
        out.add_symlink("bin/link", "/etc/passwd", SimpleFileOptions::default()).unwrap();
        let bytes = out.finish().unwrap().into_inner();
        let (root, result) = unpack_bytes(&bytes);
        let (code, text) = reason(result);
        assert_eq!(code, "plugin.package_invalid");
        assert!(text.contains("links and special files"), "{text}");
        assert_eq!(std::fs::read_dir(root.path().join("unpacked")).unwrap().count(), 0, "nothing was written");

        for name in ["../escape", "/abs", "a/./b", "C:/x", "bin\\plugin", "nul.txt", "dir/ends."] {
            let bytes = zip(&[(MANIFEST_FILE, manifest.as_bytes()), (name, b"x")]);
            let (_root, result) = unpack_bytes(&bytes);
            let (code, text) = reason(result);
            assert_eq!(code, "plugin.package_invalid", "{name}");
            assert!(text.contains("not a valid package path"), "{name}: {text}");
        }

        let twins = zip(&[(MANIFEST_FILE, manifest.as_bytes()), ("LICENSE", b"a"), ("license", b"b")]);
        let (_root, result) = unpack_bytes(&twins);
        assert!(reason(result).1.contains("appears twice"));
    }

    #[test]
    fn device_and_fifo_modes_are_special() {
        for mode in [0o010_644, 0o020_644, 0o060_644, 0o140_755, 0o120_777] {
            assert!(is_special_mode(Some(mode)), "{mode:o}");
        }
        for mode in [None, Some(0o100_644), Some(0o040_755), Some(0o644)] {
            assert!(!is_special_mode(mode), "{mode:?}");
        }
    }

    /// Links in an unpacked directory are reported, whatever put them there.
    #[cfg(unix)]
    #[test]
    fn listing_reports_links_and_hard_links() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a"), b"x").unwrap();
        std::os::unix::fs::symlink("/etc/passwd", dir.path().join("s")).unwrap();
        std::fs::hard_link(dir.path().join("a"), dir.path().join("h")).unwrap();
        let entries = list(dir.path()).unwrap();
        for name in ["a", "s", "h"] {
            let e = entries.iter().find(|e| e.path == name).unwrap();
            assert_eq!(e.kind, EntryKind::Other, "{name}");
        }
    }

    #[cfg(windows)]
    #[test]
    fn listing_reports_hard_links_and_junctions() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a"), b"x").unwrap();
        std::fs::hard_link(dir.path().join("a"), dir.path().join("h")).unwrap();
        std::fs::create_dir(dir.path().join("target")).unwrap();
        let status = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(dir.path().join("j"))
            .arg(dir.path().join("target"))
            .stdout(std::process::Stdio::null())
            .status()
            .unwrap();
        assert!(status.success());
        let entries = list(dir.path()).unwrap();
        for name in ["a", "h", "j"] {
            let e = entries.iter().find(|e| e.path == name).unwrap();
            assert_eq!(e.kind, EntryKind::Other, "{name}");
        }
    }

    fn signed(key: &SigningKey, manifest: &str) -> kalzit_release::DetachedSignature {
        let signature = key.sign(&signing::manifest_message(manifest.as_bytes()));
        kalzit_release::DetachedSignature {
            key_id: signing::key_id(&key.verifying_key()),
            signature: base64::engine::general_purpose::STANDARD.encode(signature.to_bytes()),
        }
    }

    fn unpacked(manifest: &str, signature: Option<kalzit_release::DetachedSignature>) -> Unpacked {
        Unpacked { manifest: manifest::parse(manifest).unwrap(), manifest_text: manifest.into(), signature }
    }

    #[test]
    fn signatures_are_checked_against_the_trusted_keys() {
        let (publisher, kalzit, stranger) =
            (SigningKey::from_bytes(&[1; 32]), SigningKey::from_bytes(&[2; 32]), SigningKey::from_bytes(&[3; 32]));
        let trusted = [
            TrustedKey { key: publisher.verifying_key(), signer: Signer::Publisher },
            TrustedKey { key: kalzit.verifying_key(), signer: Signer::Kalzit },
        ];
        let text = manifest_for(&[(binary_path(), BINARY)]);

        let ok = verify(&unpacked(&text, Some(signed(&publisher, &text))), &trusted, false).unwrap();
        assert_eq!(ok.signer, Signer::Publisher);
        assert_eq!(ok.key, Some(publisher.verifying_key()));

        // An unknown key is untrusted; a trusted key whose signature does not match is invalid,
        // also with unsigned plugins allowed.
        let e = verify(&unpacked(&text, Some(signed(&stranger, &text))), &trusted, true).unwrap_err();
        assert_eq!(e.reason, "plugin.signer_untrusted");
        let mut forged = signed(&publisher, &text);
        forged.signature = signed(&publisher, &format!("{text}\n")).signature;
        let e = verify(&unpacked(&text, Some(forged)), &trusted, true).unwrap_err();
        assert_eq!(e.reason, "plugin.signature_invalid");
        let mut garbage = signed(&publisher, &text);
        garbage.signature = "kein base64".into();
        assert_eq!(
            verify(&unpacked(&text, Some(garbage)), &trusted, true).unwrap_err().reason,
            "plugin.signature_invalid"
        );

        // Unsigned only with the switch.
        assert_eq!(verify(&unpacked(&text, None), &trusted, false).unwrap_err().reason, "plugin.unsigned_refused");
        assert_eq!(verify(&unpacked(&text, None), &trusted, true).unwrap().signer, Signer::Unsigned);

        // Reserved ids need Kalzit's key.
        let reserved = text.replace("dev.example.test", "io.kalzit.test");
        let e = verify(&unpacked(&reserved, Some(signed(&publisher, &reserved))), &trusted, false).unwrap_err();
        assert_eq!(e.reason, "plugin.id_reserved");
        assert_eq!(verify(&unpacked(&reserved, None), &trusted, true).unwrap_err().reason, "plugin.id_reserved");
        let own = verify(&unpacked(&reserved, Some(signed(&kalzit, &reserved))), &trusted, false).unwrap();
        assert_eq!(own.signer, Signer::Kalzit);
    }

    #[test]
    fn public_keys_are_read_from_base64_or_hex() {
        let key = SigningKey::from_bytes(&[4; 32]).verifying_key();
        let b64 = base64::engine::general_purpose::STANDARD.encode(key.as_bytes());
        assert_eq!(parse_public_key(&b64), Some(key));
        assert_eq!(parse_public_key(&hex::encode(key.as_bytes())), Some(key));
        assert_eq!(parse_public_key("kurz"), None);
        // The identity point is a weak key.
        let mut identity = [0u8; 32];
        identity[0] = 1;
        assert_eq!(parse_public_key(&hex::encode(identity)), None);
    }
}
