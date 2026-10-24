//! The release waiting to be installed, in `<data dir>/updates/staging`: its manifest, the
//! manifest's signature, the package for this platform and `staged.json`. A release only lands
//! there after its signatures, size and SHA-256 passed; installing checks all of it again from
//! the files, so a file changed in between is refused.

use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::UpdateError;
use super::install::{Layout, write_json};
use super::platform::Platform;
use super::signing::{self, Manifest, Package, TrustedKeys};
use super::source::{Fetcher, Offer};

pub const MANIFEST_FILE: &str = "manifest.json";
pub const SIGNATURE_FILE: &str = "manifest.json.sig";
/// Windows starts programs by their extension, so the smoke test needs one there.
pub const PACKAGE_FILE: &str = if cfg!(windows) { "package.exe" } else { "package" };
const INFO_FILE: &str = "staged.json";

/// What the status shows of the staged release.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StagedInfo {
    pub version: String,
    /// `online` (downloaded) or `offline` (uploaded).
    pub source: String,
    pub size: u64,
    pub sha256: String,
    pub key_id: String,
    #[serde(default)]
    pub highlights: Vec<signing::Highlight>,
    pub notes: String,
    pub notes_url: Option<String>,
}

/// The staged release, its signatures verified again. The package file itself is not trusted:
/// installing copies it once and checks the copy against `package` (`install::place_binary`).
#[derive(Debug)]
pub struct Staged {
    pub version: String,
    pub manifest: Manifest,
    /// This platform's signed entry.
    pub package: Package,
    pub package_path: PathBuf,
    /// The verified manifest and signature, kept with the version for a later return.
    pub manifest_bytes: Vec<u8>,
    pub signature_bytes: Vec<u8>,
}

/// The package of `manifest` for `platform`.
pub fn select_package<'m>(manifest: &'m Manifest, platform: &Platform) -> Result<&'m Package, UpdateError> {
    manifest
        .packages
        .iter()
        .find(|p| p.platform == platform.os && p.arch == platform.arch)
        .ok_or_else(|| UpdateError::NoPackage { platform: platform.os.to_string(), arch: platform.arch.to_string() })
}

/// SHA-256 (hex) and size of a file.
pub fn hash_file(path: &Path) -> io::Result<(String, u64)> {
    let mut file = fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 64 * 1024];
    let mut size = 0u64;
    loop {
        let n = file.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        hasher.update(&buffer[..n]);
        size += n as u64;
    }
    Ok((hex::encode(hasher.finalize()), size))
}

fn io_failed(e: io::Error) -> UpdateError {
    UpdateError::InstallFailed(e.to_string())
}

/// A fresh, empty folder under `updates/` for incoming files.
pub fn incoming_dir(layout: &Layout, name: &str) -> io::Result<PathBuf> {
    let dir = layout.root().join(name);
    if dir.exists() {
        fs::remove_dir_all(&dir)?;
    }
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// Downloads the offered package, checks it and stages the release.
pub async fn download(
    fetcher: &Fetcher,
    layout: &Layout,
    offer: &Offer,
    keys: &TrustedKeys,
    platform: &Platform,
    progress: &(dyn Fn(u64, u64) + Send + Sync),
) -> Result<StagedInfo, UpdateError> {
    let manifest_bytes =
        BASE64.decode(&offer.manifest).map_err(|_| UpdateError::ManifestInvalid("stored offer".into()))?;
    let signature_bytes =
        BASE64.decode(&offer.signature).map_err(|_| UpdateError::ManifestInvalid("stored offer".into()))?;
    let manifest = signing::verify_manifest(keys, &manifest_bytes, &signature_bytes)?;
    let package = select_package(&manifest, platform)?.clone();
    let dir = incoming_dir(layout, "incoming").map_err(io_failed)?;
    let target = dir.join(PACKAGE_FILE);
    let url = url::Url::parse(&offer.package_url).map_err(|_| UpdateError::ReleaseIncomplete(offer.version.clone()))?;
    let (sha256, size) = fetcher.download(&url, package.size, &target, progress).await?;
    if size != package.size {
        return Err(UpdateError::SizeMismatch);
    }
    if sha256 != package.sha256 {
        return Err(UpdateError::HashMismatch);
    }
    finish(layout, &dir, &manifest_bytes, &signature_bytes, &manifest, &package, "online")
}

/// Verifies an uploaded release in `dir` (manifest, signature, package) and stages it. The
/// package is matched to its manifest entry by its hash; it must be this platform's.
pub fn stage_upload(
    layout: &Layout,
    dir: &Path,
    keys: &TrustedKeys,
    platform: &Platform,
    current: &semver::Version,
    channel: signing::Channel,
) -> Result<StagedInfo, UpdateError> {
    let manifest_bytes = fs::read(dir.join(MANIFEST_FILE)).map_err(|_| UpdateError::UploadIncomplete("manifest"))?;
    let signature_bytes = fs::read(dir.join(SIGNATURE_FILE)).map_err(|_| UpdateError::UploadIncomplete("signature"))?;
    let package_path = dir.join(PACKAGE_FILE);
    if !package_path.is_file() {
        return Err(UpdateError::UploadIncomplete("package"));
    }
    let manifest = signing::verify_manifest(keys, &manifest_bytes, &signature_bytes)?;
    let (sha256, size) = hash_file(&package_path).map_err(io_failed)?;
    let package = match manifest.packages.iter().find(|p| p.sha256 == sha256) {
        Some(p) => p.clone(),
        // A package of this platform with another hash was changed; anything else does not
        // belong to the release at all.
        None if select_package(&manifest, platform).is_ok() => return Err(UpdateError::HashMismatch),
        None => return Err(select_package(&manifest, platform).err().unwrap_or(UpdateError::HashMismatch)),
    };
    if package.platform != platform.os || package.arch != platform.arch {
        return Err(UpdateError::WrongPlatform {
            platform: package.platform,
            arch: package.arch,
            ours: platform.name(),
        });
    }
    if size != package.size {
        return Err(UpdateError::SizeMismatch);
    }
    super::version_rules(current, &manifest)?;
    super::channel_rule(channel, &manifest)?;
    finish(layout, dir, &manifest_bytes, &signature_bytes, &manifest, &package, "offline")
}

pub use super::signing::{BUNDLE_EXTENSION, BUNDLE_MAGIC, write_bundle};

/// Splits the offline package `bundle` into `dir` (manifest, signature, package), each within its
/// limit. Nothing in it is trusted yet; `stage_upload` verifies it.
pub fn split_bundle(bundle: &Path, dir: &Path) -> Result<(), UpdateError> {
    let invalid = |what: &str| UpdateError::ManifestInvalid(format!("the offline package {what}"));
    let mut file = io::BufReader::new(fs::File::open(bundle).map_err(io_failed)?);
    let mut magic = [0u8; 16];
    file.read_exact(&mut magic).map_err(|_| invalid("is too short"))?;
    if &magic != BUNDLE_MAGIC {
        return Err(invalid("is not a Kalzit update package"));
    }
    let parts = [
        (MANIFEST_FILE, signing::MAX_MANIFEST_BYTES as u64),
        (SIGNATURE_FILE, signing::MAX_SIGNATURE_BYTES as u64),
        (PACKAGE_FILE, signing::MAX_PACKAGE_BYTES),
    ];
    for (name, max) in parts {
        let mut len = [0u8; 8];
        file.read_exact(&mut len).map_err(|_| invalid("is cut short"))?;
        let len = u64::from_le_bytes(len);
        if len > max {
            return Err(UpdateError::TooLarge(max));
        }
        let mut out = fs::File::create(dir.join(name)).map_err(io_failed)?;
        let copied = io::copy(&mut (&mut file).take(len), &mut out).map_err(io_failed)?;
        if copied != len {
            return Err(invalid("is cut short"));
        }
    }
    let mut rest = [0u8; 1];
    if file.read(&mut rest).map_err(io_failed)? != 0 {
        return Err(invalid("has data after its package"));
    }
    Ok(())
}

/// Where the upload route writes an offline package before it is split.
pub const UPLOAD_BUNDLE_FILE: &str = "upload.kalzit-update";

/// Splits an uploaded offline package in `dir` into its parts, if the upload was one.
pub fn split_upload(dir: &Path) -> Result<(), UpdateError> {
    let bundle = dir.join(UPLOAD_BUNDLE_FILE);
    if !bundle.is_file() {
        return Ok(());
    }
    let result = split_bundle(&bundle, dir);
    let _ = fs::remove_file(&bundle);
    result
}

/// The version an upload claims, for the history of a refused one (read without trusting it).
pub fn uploaded_version(dir: &Path) -> Option<String> {
    let bytes = fs::read(dir.join(MANIFEST_FILE)).ok()?;
    let value: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    let version = value.get("version")?.as_str()?;
    semver::Version::parse(version).ok().map(|v| v.to_string())
}

/// Writes the release files into `dir` and makes it the staging folder.
fn finish(
    layout: &Layout,
    dir: &Path,
    manifest_bytes: &[u8],
    signature_bytes: &[u8],
    manifest: &Manifest,
    package: &Package,
    source: &str,
) -> Result<StagedInfo, UpdateError> {
    fs::write(dir.join(MANIFEST_FILE), manifest_bytes).map_err(io_failed)?;
    fs::write(dir.join(SIGNATURE_FILE), signature_bytes).map_err(io_failed)?;
    let info = StagedInfo {
        version: manifest.version.clone(),
        source: source.to_string(),
        size: package.size,
        sha256: package.sha256.clone(),
        key_id: package.signature.key_id.clone(),
        highlights: manifest.highlights.clone(),
        notes: manifest.notes.clone(),
        notes_url: manifest.notes_url.clone(),
    };
    write_json(&dir.join(INFO_FILE), &info).map_err(io_failed)?;
    discard(layout).map_err(io_failed)?;
    fs::rename(dir, layout.staging()).map_err(io_failed)?;
    Ok(info)
}

/// The staged release as recorded; `load` verifies it.
pub fn staged_info(layout: &Layout) -> Option<StagedInfo> {
    let bytes = fs::read(layout.staging().join(INFO_FILE)).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// Verifies the staged release's signatures again and finds this platform's entry. The manifest
/// is read once into memory and verified there; the package is checked when it is copied.
pub fn load(layout: &Layout, keys: &TrustedKeys, platform: &Platform) -> Result<Staged, UpdateError> {
    let dir = layout.staging();
    let info = staged_info(layout).ok_or_else(|| UpdateError::NotStaged(String::new()))?;
    let read = |name: &str, max: usize| -> Result<Vec<u8>, UpdateError> {
        let mut bytes = Vec::new();
        fs::File::open(dir.join(name))
            .and_then(|f| f.take(max as u64 + 1).read_to_end(&mut bytes))
            .map_err(|_| UpdateError::NotStaged(info.version.clone()))?;
        Ok(bytes)
    };
    let manifest_bytes = read(MANIFEST_FILE, signing::MAX_MANIFEST_BYTES)?;
    let signature_bytes = read(SIGNATURE_FILE, signing::MAX_SIGNATURE_BYTES)?;
    let manifest = signing::verify_manifest(keys, &manifest_bytes, &signature_bytes)?;
    let package = select_package(&manifest, platform)?.clone();
    Ok(Staged {
        version: manifest.version.clone(),
        manifest,
        package,
        package_path: dir.join(PACKAGE_FILE),
        manifest_bytes,
        signature_bytes,
    })
}

/// Removes the staged release.
pub fn discard(layout: &Layout) -> io::Result<()> {
    match fs::remove_dir_all(layout.staging()) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

#[cfg(test)]
mod tests {
    use super::super::signing::Channel;
    use super::super::signing::tests::{keys_for, signed_manifest, signed_manifest_on, test_key};
    use super::*;

    fn linux() -> Platform {
        Platform { os: "linux", arch: "x64" }
    }

    fn upload(dir: &Path, manifest: &[u8], sig: &[u8], package: &[u8]) {
        fs::create_dir_all(dir).unwrap();
        fs::write(dir.join(MANIFEST_FILE), manifest).unwrap();
        fs::write(dir.join(SIGNATURE_FILE), sig).unwrap();
        fs::write(dir.join(PACKAGE_FILE), package).unwrap();
    }

    fn v(text: &str) -> semver::Version {
        semver::Version::parse(text).unwrap()
    }

    #[test]
    fn an_uploaded_release_is_verified_staged_and_loads_again() {
        let tmp = tempfile::tempdir().unwrap();
        let layout = Layout::new(tmp.path());
        let key = test_key(3);
        let (manifest, sig) =
            signed_manifest(&key, "2.0.0", &[("linux", "x64", b"linux binary"), ("windows", "x64", b"windows binary")]);
        let dir = layout.root().join("upload-1");
        upload(&dir, &manifest, &sig, b"linux binary");
        let info = stage_upload(&layout, &dir, &keys_for(&key), &linux(), &v("1.0.0"), Channel::Stable).unwrap();
        assert_eq!((info.version.as_str(), info.source.as_str(), info.size), ("2.0.0", "offline", 12));
        assert!(!dir.exists(), "the upload folder became the staging folder");
        let staged = load(&layout, &keys_for(&key), &linux()).unwrap();
        assert_eq!((staged.version.as_str(), staged.package.size), ("2.0.0", 12));
        // A changed manifest is refused when the release is loaded for installing.
        let mut changed = manifest.clone();
        changed.push(b' ');
        fs::write(layout.staging().join(MANIFEST_FILE), changed).unwrap();
        assert!(matches!(load(&layout, &keys_for(&key), &linux()), Err(UpdateError::SignatureInvalid)));
    }

    #[test]
    fn a_preview_release_is_refused_on_the_stable_channel() {
        let tmp = tempfile::tempdir().unwrap();
        let layout = Layout::new(tmp.path());
        let key = test_key(3);
        let (manifest, sig) = signed_manifest_on(&key, "2.0.0-rc.1", Channel::Preview, &[("linux", "x64", b"rc")]);
        let dir = layout.root().join("upload-1");
        upload(&dir, &manifest, &sig, b"rc");
        let e = stage_upload(&layout, &dir, &keys_for(&key), &linux(), &v("1.0.0"), Channel::Stable).unwrap_err();
        assert!(matches!(e, UpdateError::ChannelMismatch), "{e}");
        let info = stage_upload(&layout, &dir, &keys_for(&key), &linux(), &v("1.0.0"), Channel::Preview).unwrap();
        assert_eq!(info.version, "2.0.0-rc.1");
    }

    #[test]
    fn a_changed_package_is_refused() {
        let tmp = tempfile::tempdir().unwrap();
        let layout = Layout::new(tmp.path());
        let key = test_key(3);
        let (manifest, sig) = signed_manifest(&key, "2.0.0", &[("linux", "x64", b"linux binary")]);
        let dir = layout.root().join("upload-1");
        upload(&dir, &manifest, &sig, b"linux binary with a backdoor");
        let e = stage_upload(&layout, &dir, &keys_for(&key), &linux(), &v("1.0.0"), Channel::Stable).unwrap_err();
        assert!(matches!(e, UpdateError::HashMismatch), "{e}");
        assert!(staged_info(&layout).is_none());
    }

    #[test]
    fn another_platforms_package_is_refused() {
        let tmp = tempfile::tempdir().unwrap();
        let layout = Layout::new(tmp.path());
        let key = test_key(3);
        let (manifest, sig) =
            signed_manifest(&key, "2.0.0", &[("linux", "x64", b"linux binary"), ("windows", "x64", b"windows binary")]);
        let dir = layout.root().join("upload-1");
        upload(&dir, &manifest, &sig, b"windows binary");
        let e = stage_upload(&layout, &dir, &keys_for(&key), &linux(), &v("1.0.0"), Channel::Stable).unwrap_err();
        assert!(matches!(e, UpdateError::WrongPlatform { .. }), "{e}");
        let arm = Platform { os: "linux", arch: "arm64" };
        upload(&dir, &manifest, &sig, b"linux binary");
        let e = stage_upload(&layout, &dir, &keys_for(&key), &arm, &v("1.0.0"), Channel::Stable).unwrap_err();
        assert!(matches!(e, UpdateError::WrongPlatform { .. }), "{e}");
    }

    #[test]
    fn an_older_upload_is_refused_and_keeps_what_was_staged() {
        let tmp = tempfile::tempdir().unwrap();
        let layout = Layout::new(tmp.path());
        let key = test_key(3);
        let (manifest, sig) = signed_manifest(&key, "2.0.0", &[("linux", "x64", b"two")]);
        let dir = layout.root().join("upload-1");
        upload(&dir, &manifest, &sig, b"two");
        stage_upload(&layout, &dir, &keys_for(&key), &linux(), &v("1.0.0"), Channel::Stable).unwrap();
        let (manifest, sig) = signed_manifest(&key, "0.9.0", &[("linux", "x64", b"old")]);
        let dir = layout.root().join("upload-2");
        upload(&dir, &manifest, &sig, b"old");
        let e = stage_upload(&layout, &dir, &keys_for(&key), &linux(), &v("1.0.0"), Channel::Stable).unwrap_err();
        assert!(matches!(e, UpdateError::Downgrade { .. }), "{e}");
        assert_eq!(staged_info(&layout).unwrap().version, "2.0.0");
    }

    #[test]
    fn an_offline_package_splits_into_its_parts() {
        let tmp = tempfile::tempdir().unwrap();
        let layout = Layout::new(tmp.path());
        let key = test_key(3);
        let (manifest, sig) = signed_manifest(&key, "2.0.0", &[("linux", "x64", b"linux binary")]);
        let bundle = tmp.path().join("kalzit-2.0.0-linux-x64.kalzit-update");
        let mut out = fs::File::create(&bundle).unwrap();
        write_bundle(&mut out, &manifest, &sig, b"linux binary").unwrap();
        drop(out);
        let dir = layout.root().join("upload-1");
        fs::create_dir_all(&dir).unwrap();
        split_bundle(&bundle, &dir).unwrap();
        let info = stage_upload(&layout, &dir, &keys_for(&key), &linux(), &v("1.0.0"), Channel::Stable).unwrap();
        assert_eq!(info.version, "2.0.0");

        // Cut short, extra bytes, a foreign file.
        let bytes = fs::read(&bundle).unwrap();
        let dir = layout.root().join("upload-2");
        fs::create_dir_all(&dir).unwrap();
        for bad in [&bytes[..bytes.len() - 1], &[bytes.as_slice(), b"x"].concat()[..], b"PK\x03\x04 zip file here"] {
            fs::write(&bundle, bad).unwrap();
            assert!(matches!(split_bundle(&bundle, &dir), Err(UpdateError::ManifestInvalid(_))));
        }
        // A length beyond the limit is refused before anything is read.
        let mut huge = BUNDLE_MAGIC.to_vec();
        huge.extend_from_slice(&u64::MAX.to_le_bytes());
        fs::write(&bundle, &huge).unwrap();
        assert!(matches!(split_bundle(&bundle, &dir), Err(UpdateError::TooLarge(_))));
    }

    #[test]
    fn a_missing_part_names_it() {
        let tmp = tempfile::tempdir().unwrap();
        let layout = Layout::new(tmp.path());
        let dir = layout.root().join("upload-1");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(MANIFEST_FILE), b"{}").unwrap();
        let e =
            stage_upload(&layout, &dir, &keys_for(&test_key(3)), &linux(), &v("1.0.0"), Channel::Stable).unwrap_err();
        assert!(matches!(e, UpdateError::UploadIncomplete("signature")), "{e}");
    }
}
