//! Building, signing and checking plugin packages (docs/api/plugins.md, "Packages"), for the
//! `kalzit-plugin` tool and for tests that package a plugin.
//!
//! A package is a zip file with `kalzit-plugin.toml`, optionally `kalzit-plugin.sig`, and exactly
//! the files the manifest lists in `[files]` with their SHA-256. The author writes the manifest
//! without `[files]`; [`manifest`] adds it from the files that go into the package.

use std::collections::BTreeMap;
use std::io::{Cursor, Read, Write};

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use ed25519_dalek::{Signature, Signer as _, SigningKey, VerifyingKey};
use kalzit_plugin_api::manifest::{self, MANIFEST_FILE, Manifest, SIGNATURE_FILE};
use kalzit_plugin_api::signing;
use kalzit_release::DetachedSignature;
use sha2::{Digest, Sha256};

/// The environment variable that holds a signing key (32 bytes, base64), as an alternative to a
/// key file.
pub const KEY_ENV: &str = "KALZIT_PLUGIN_SIGNING_KEY";

/// The largest package Kalzit accepts.
pub const MAX_PACKAGE_BYTES: usize = 256 * 1024 * 1024;
/// The most a package may hold once unpacked, as Kalzit counts it; a zip bomb stops here.
pub const MAX_UNPACKED_BYTES: u64 = 1024 * 1024 * 1024;
/// The largest single file a package may hold once unpacked.
pub const MAX_ENTRY_BYTES: u64 = MAX_PACKAGE_BYTES as u64;
/// Entries one package may have (the manifest lists at most 4096 files, plus directories).
pub const MAX_ENTRIES: usize = 8192;

pub fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

/// Keeps only the lines of `[binaries]` for `platforms` (all when empty), so a package built on
/// one system carries the binary it has.
fn only_platforms(template: &str, platforms: &[String]) -> Result<String, String> {
    if platforms.is_empty() {
        return Ok(template.to_string());
    }
    if let Some(p) = platforms.iter().find(|p| !manifest::PLATFORMS.contains(&p.as_str())) {
        return Err(format!("{p} is not a platform; use one of {}", manifest::PLATFORMS.join(", ")));
    }
    let mut out = String::new();
    let mut in_binaries = false;
    for line in template.split_inclusive('\n') {
        let trimmed = line.trim();
        if trimmed.starts_with('[') {
            in_binaries = trimmed == "[binaries]";
        } else if in_binaries && let Some((key, _)) = trimmed.split_once('=') {
            let key = key.trim().trim_matches('"');
            if !platforms.iter().any(|p| p == key) {
                continue;
            }
        }
        out.push_str(line);
    }
    Ok(out)
}

/// The manifest of a package: `template` (without `[files]`) with `[files]` added for `files`
/// (package path to content), checked as Kalzit checks it. `platforms` keeps only those entries
/// of `[binaries]` (all when empty).
pub fn manifest(template: &str, files: &BTreeMap<String, Vec<u8>>, platforms: &[String]) -> Result<String, String> {
    let table: toml::Table = toml::from_str(template).map_err(|e| format!("the manifest is not TOML: {e}"))?;
    if table.contains_key("files") {
        return Err("the manifest template has [files]; leave it out, the tool writes it".into());
    }
    if files.is_empty() {
        return Err("a package needs at least one file".into());
    }
    let mut text = only_platforms(template, platforms)?;
    if !text.ends_with('\n') {
        text.push('\n');
    }
    text.push_str("\n[files]\n");
    for (path, bytes) in files {
        if path == MANIFEST_FILE || path == SIGNATURE_FILE || !manifest::is_package_path(path) {
            return Err(format!("{path} is not a valid package path"));
        }
        text.push_str(&format!("\"{path}\" = \"{}\"\n", sha256_hex(bytes)));
    }
    manifest::parse(&text).map_err(|e| e.to_string())?;
    Ok(text)
}

/// The signature file for `manifest` (`kalzit-plugin.sig`).
pub fn signature(key: &SigningKey, manifest: &[u8]) -> Vec<u8> {
    let sig = DetachedSignature {
        key_id: signing::key_id(&key.verifying_key()),
        signature: BASE64.encode(key.sign(&signing::manifest_message(manifest)).to_bytes()),
    };
    serde_json::to_vec(&sig).expect("a signature serializes")
}

/// The zip file: the manifest, the signature when there is one, then the files.
pub fn zip(manifest: &str, signature: Option<&[u8]>, files: &BTreeMap<String, Vec<u8>>) -> Result<Vec<u8>, String> {
    let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let mut add = |name: &str, bytes: &[u8]| -> Result<(), String> {
        zip.start_file(name, options).map_err(|e| e.to_string())?;
        zip.write_all(bytes).map_err(|e| e.to_string())
    };
    add(MANIFEST_FILE, manifest.as_bytes())?;
    if let Some(sig) = signature {
        add(SIGNATURE_FILE, sig)?;
    }
    for (path, bytes) in files {
        add(path, bytes)?;
    }
    let bytes = zip.finish().map_err(|e| e.to_string())?.into_inner();
    if bytes.len() > MAX_PACKAGE_BYTES {
        return Err(format!("the package is larger than {MAX_PACKAGE_BYTES} bytes"));
    }
    Ok(bytes)
}

/// Builds a package from a manifest template and its files, signed with `key` when given.
pub fn package(
    template: &str,
    files: &BTreeMap<String, Vec<u8>>,
    platforms: &[String],
    key: Option<&SigningKey>,
) -> Result<Vec<u8>, String> {
    let text = manifest(template, files, platforms)?;
    let sig = key.map(|k| signature(k, text.as_bytes()));
    zip(&text, sig.as_deref(), files)
}

/// What a package holds, read from its zip file.
#[derive(Debug)]
pub struct Contents {
    pub manifest_text: String,
    pub manifest: Manifest,
    pub signature: Option<Vec<u8>>,
    pub files: BTreeMap<String, Vec<u8>>,
}

/// Reads a package and checks it the way Kalzit does before it trusts the signature: valid
/// entry paths, no links or other special entries, a valid manifest, and exactly the listed
/// files with their hashes. The sizes in the archive are not trusted: reading stops at
/// [`MAX_ENTRY_BYTES`] per file, [`MAX_UNPACKED_BYTES`] in all and [`MAX_ENTRIES`] entries.
pub fn read(bytes: &[u8]) -> Result<Contents, String> {
    read_within(bytes, &Limits::PACKAGE)
}

/// The caps [`read`] applies; tests use smaller ones.
struct Limits {
    entries: usize,
    entry_bytes: u64,
    unpacked_bytes: u64,
}

impl Limits {
    const PACKAGE: Limits =
        Limits { entries: MAX_ENTRIES, entry_bytes: MAX_ENTRY_BYTES, unpacked_bytes: MAX_UNPACKED_BYTES };
}

fn read_within(bytes: &[u8], limits: &Limits) -> Result<Contents, String> {
    if bytes.len() > MAX_PACKAGE_BYTES {
        return Err(format!("plugin.package_too_large: the package is larger than {MAX_PACKAGE_BYTES} bytes"));
    }
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|e| format!("not a zip file: {e}"))?;
    if archive.len() > limits.entries {
        return Err(format!("plugin.package_too_large: the package has more than {} entries", limits.entries));
    }
    let mut unpacked: u64 = 0;
    let mut manifest_text = None;
    let mut signature = None;
    let mut files = BTreeMap::new();
    let mut entries = Vec::new();
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let name = entry.name().map_err(|e| e.to_string())?.trim_end_matches('/').to_string();
        if !manifest::is_package_path(&name) {
            return Err(format!("{name} is not a valid package path"));
        }
        if entry.is_dir() {
            entries.push(manifest::PackageEntry { path: name, kind: manifest::EntryKind::Directory });
            continue;
        }
        if !entry.is_file() || entry.is_symlink() {
            return Err(format!("{name} is a link or special entry"));
        }
        let limit = limits.entry_bytes.min(limits.unpacked_bytes - unpacked);
        let mut content = Vec::new();
        (&mut entry).take(limit + 1).read_to_end(&mut content).map_err(|e| format!("{name}: {e}"))?;
        if content.len() as u64 > limit {
            return Err(format!("plugin.package_too_large: {name} makes the unpacked package too large"));
        }
        unpacked += content.len() as u64;
        entries.push(manifest::PackageEntry {
            path: name.clone(),
            kind: manifest::EntryKind::File { sha256: sha256_hex(&content) },
        });
        match name.as_str() {
            MANIFEST_FILE => {
                manifest_text = Some(String::from_utf8(content).map_err(|_| "the manifest is not UTF-8".to_string())?)
            }
            SIGNATURE_FILE => signature = Some(content),
            _ => {
                files.insert(name, content);
            }
        }
    }
    let manifest_text = manifest_text.ok_or("the package has no kalzit-plugin.toml")?;
    let manifest = manifest::parse(&manifest_text).map_err(|e| e.to_string())?;
    manifest.check_package(&entries).map_err(|e| e.to_string())?;
    Ok(Contents { manifest_text, manifest, signature, files })
}

/// The key id and signature of a signature file.
fn parse_signature(bytes: &[u8]) -> Result<(String, Signature), String> {
    let sig: DetachedSignature = serde_json::from_slice(bytes).map_err(|e| format!("the signature file: {e}"))?;
    let raw = BASE64.decode(sig.signature.trim()).map_err(|_| "the signature is not base64".to_string())?;
    let raw: [u8; 64] = raw.try_into().map_err(|_| "the signature is not 64 bytes".to_string())?;
    Ok((sig.key_id, Signature::from_bytes(&raw)))
}

/// Checks a package and its signature against `key` (any valid signature when `None`, which
/// then only says which key signed). Answers what was checked.
pub fn verify(bytes: &[u8], key: Option<&VerifyingKey>) -> Result<String, String> {
    let c = read(bytes)?;
    let what = format!("{} {} ({} files)", c.manifest.id, c.manifest.version, c.files.len());
    let Some(sig) = c.signature else {
        return match key {
            Some(_) => Err(format!("{what} is not signed")),
            None => Ok(format!("{what}: valid, not signed")),
        };
    };
    let (key_id, signature) = parse_signature(&sig)?;
    match key {
        Some(key) => {
            if key_id != signing::key_id(key) {
                return Err(format!("{what} is signed with key {key_id}, not with key {}", signing::key_id(key)));
            }
            if !signing::verify_manifest(key, c.manifest_text.as_bytes(), &signature) {
                return Err(format!("the signature of {what} does not verify"));
            }
            Ok(format!("{what}: valid, signed with key {key_id}"))
        }
        None => Ok(format!("{what}: valid, signed with key {key_id} (pass --public-key to check the signature)")),
    }
}

/// Signs an existing package again with `key`, replacing any signature.
pub fn sign(bytes: &[u8], key: &SigningKey) -> Result<Vec<u8>, String> {
    let c = read(bytes)?;
    let sig = signature(key, c.manifest_text.as_bytes());
    zip(&c.manifest_text, Some(&sig), &c.files)
}

/// Adds a signature made elsewhere (`kalzit-sign sign-plugin-manifest`) to a package, replacing
/// any signature. Checked against `key` when given.
pub fn attach_signature(bytes: &[u8], signature: &[u8], key: Option<&VerifyingKey>) -> Result<Vec<u8>, String> {
    let c = read(bytes)?;
    parse_signature(signature)?;
    let out = zip(&c.manifest_text, Some(signature), &c.files)?;
    if key.is_some() {
        verify(&out, key)?;
    }
    Ok(out)
}

/// A signing key from its text: 32 bytes in base64, as `kalzit-plugin keygen` writes it.
pub fn signing_key(text: &str) -> Result<SigningKey, String> {
    kalzit_release::signing_key_from_base64(text.trim())
}

/// A public key in base64 or hex.
pub fn public_key(text: &str) -> Result<VerifyingKey, String> {
    let text = text.trim();
    let bytes = if text.len() == 64 && text.bytes().all(|b| b.is_ascii_hexdigit()) {
        hex::decode(text).map_err(|e| e.to_string())?
    } else {
        BASE64.decode(text).map_err(|e| format!("the public key is not base64: {e}"))?
    };
    let bytes: [u8; 32] = bytes.try_into().map_err(|_| "a public key is 32 bytes".to_string())?;
    let key = VerifyingKey::from_bytes(&bytes).map_err(|e| format!("not an Ed25519 public key: {e}"))?;
    if key.is_weak() {
        return Err("a weak (small order) key cannot be trusted".into());
    }
    Ok(key)
}

#[cfg(test)]
mod tests {
    use super::*;

    const TEMPLATE: &str = r#"manifest = 1
id = "dev.example.tool"
name = "Tool test"
version = "1.0.0"
kind = "datasource"
min_kalzit = "0.4.0"
shapes = ["frame"]
protocol = 1

[binaries]
windows-x64 = "bin/windows-x64/tool.exe"
linux-x64 = "bin/linux-x64/tool"
"#;

    fn files() -> BTreeMap<String, Vec<u8>> {
        [("bin/windows-x64/tool.exe", "w"), ("bin/linux-x64/tool", "l"), ("README.md", "r")]
            .into_iter()
            .map(|(p, c)| (p.to_string(), c.as_bytes().to_vec()))
            .collect()
    }

    fn key(seed: u8) -> SigningKey {
        SigningKey::from_bytes(&[seed; 32])
    }

    #[test]
    fn a_package_is_built_signed_and_checked() {
        let k = key(7);
        let zip = package(TEMPLATE, &files(), &[], Some(&k)).unwrap();
        let ok = verify(&zip, Some(&k.verifying_key())).unwrap();
        assert!(ok.contains("dev.example.tool 1.0.0"), "{ok}");
        assert!(verify(&zip, Some(&key(8).verifying_key())).unwrap_err().contains("not with key"));
        let c = read(&zip).unwrap();
        assert_eq!(c.manifest.files["README.md"], sha256_hex(b"r"));
        // The signature is the one Kalzit checks.
        let (_, sig) = parse_signature(c.signature.as_ref().unwrap()).unwrap();
        assert!(signing::verify_manifest(&k.verifying_key(), c.manifest_text.as_bytes(), &sig));
    }

    #[test]
    fn signing_again_replaces_the_signature() {
        let unsigned = package(TEMPLATE, &files(), &[], None).unwrap();
        assert!(verify(&unsigned, None).unwrap().contains("not signed"));
        assert!(verify(&unsigned, Some(&key(1).verifying_key())).is_err());
        let signed = sign(&unsigned, &key(1)).unwrap();
        assert!(verify(&signed, Some(&key(1).verifying_key())).is_ok());
    }

    #[test]
    fn a_signature_made_by_kalzit_sign_is_attached_and_checked() {
        let unsigned = package(TEMPLATE, &files(), &[], None).unwrap();
        let text = read(&unsigned).unwrap().manifest_text;
        let k = key(3);
        let sig = serde_json::to_vec(&kalzit_release::sign_plugin_manifest(&k, text.as_bytes())).unwrap();
        let signed = attach_signature(&unsigned, &sig, Some(&k.verifying_key())).unwrap();
        assert!(verify(&signed, Some(&k.verifying_key())).is_ok());
        // Another key, or a signature over other bytes, does not pass.
        assert!(attach_signature(&unsigned, &sig, Some(&key(4).verifying_key())).is_err());
        let other = serde_json::to_vec(&kalzit_release::sign_plugin_manifest(&k, b"other")).unwrap();
        assert!(attach_signature(&unsigned, &other, Some(&k.verifying_key())).is_err());
        assert!(attach_signature(&unsigned, b"not json", None).is_err());
    }

    #[test]
    fn weak_public_keys_are_refused() {
        // The identity point: a small-order key that "verifies" forged signatures.
        let mut identity = [0u8; 32];
        identity[0] = 1;
        assert!(public_key(&hex::encode(identity)).unwrap_err().contains("weak"));
    }

    #[test]
    fn one_platform_keeps_its_binary_only() {
        let mut f = files();
        f.remove("bin/windows-x64/tool.exe");
        // Without the filter the Windows binary is missing from [files].
        assert!(manifest(TEMPLATE, &f, &[]).unwrap_err().contains("binaries.windows-x64"));
        let text = manifest(TEMPLATE, &f, &["linux-x64".into()]).unwrap();
        assert!(!text.contains("windows-x64"), "{text}");
        assert!(manifest(TEMPLATE, &f, &["mac".into()]).is_err());
    }

    /// A zip with `entries` files of `size` zero bytes each: a few KiB on disk, much more unpacked.
    fn bomb(entries: usize, size: usize) -> Vec<u8> {
        let mut out = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        let chunk = vec![0u8; 64 * 1024];
        for i in 0..entries {
            out.start_file(format!("data/{i}.bin"), options).unwrap();
            let mut left = size;
            while left > 0 {
                let n = left.min(chunk.len());
                out.write_all(&chunk[..n]).unwrap();
                left -= n;
            }
        }
        out.finish().unwrap().into_inner()
    }

    #[test]
    fn zip_bombs_stop_at_the_caps() {
        const MIB: usize = 1024 * 1024;
        let limits = Limits { entries: 8, entry_bytes: 2 * MIB as u64, unpacked_bytes: 3 * MIB as u64 };
        // One entry that unpacks beyond the per-file cap.
        let one = bomb(1, 4 * MIB);
        assert!(one.len() < 64 * 1024, "{}", one.len());
        let err = read_within(&one, &limits).unwrap_err();
        assert!(err.starts_with("plugin.package_too_large"), "{err}");
        // Entries that each fit but together pass the total cap.
        let err = read_within(&bomb(3, 3 * MIB / 2), &limits).unwrap_err();
        assert!(err.starts_with("plugin.package_too_large"), "{err}");
        // Too many entries.
        let err = read_within(&bomb(9, 1), &limits).unwrap_err();
        assert!(err.contains("more than 8 entries"), "{err}");
        // Within the caps the package is read on (and refused for its missing manifest).
        let err = read_within(&bomb(2, MIB), &limits).unwrap_err();
        assert!(err.contains("no kalzit-plugin.toml"), "{err}");
    }

    #[test]
    fn templates_and_packages_that_do_not_fit_are_refused() {
        let with_files = format!("{TEMPLATE}\n[files]\n");
        assert!(manifest(&with_files, &files(), &[]).unwrap_err().contains("[files]"));
        let mut bad = files();
        bad.insert("../evil".into(), vec![]);
        assert!(manifest(TEMPLATE, &bad, &[]).is_err());
        // A file the manifest does not list.
        let text = manifest(TEMPLATE, &files(), &[]).unwrap();
        let mut more = files();
        more.insert("extra.dll".into(), b"x".to_vec());
        let zip = zip(&text, None, &more).unwrap();
        assert!(read(&zip).unwrap_err().contains("extra.dll"));
    }

    #[test]
    fn the_example_manifests_package() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../examples/plugins");
        let read = |p: &str| std::fs::read(root.join(p)).unwrap();
        let k = key(5);

        let template = String::from_utf8(read("panel-kpi/kalzit-plugin.toml")).unwrap();
        let files: BTreeMap<String, Vec<u8>> =
            [("panel.js", read("panel-kpi/panel.js")), ("README.md", read("panel-kpi/README.md"))]
                .into_iter()
                .map(|(p, c)| (p.to_string(), c))
                .collect();
        let zip = package(&template, &files, &[], Some(&k)).unwrap();
        let c = read_package(&zip);
        assert_eq!(c.manifest.plugin_kind(), manifest::PluginKind::Panel);
        assert_eq!(c.manifest.panel.as_ref().unwrap().api, kalzit_plugin_api::panel::API_VERSION);

        let template = String::from_utf8(read("csv-http/kalzit-plugin.toml")).unwrap();
        let files: BTreeMap<String, Vec<u8>> = [
            ("bin/windows-x64/kalzit-csv-http.exe", b"w".to_vec()),
            ("bin/linux-x64/kalzit-csv-http", b"l".to_vec()),
            ("README.md", read("csv-http/README.md")),
        ]
        .into_iter()
        .map(|(p, c)| (p.to_string(), c))
        .collect();
        let zip = package(&template, &files, &[], Some(&k)).unwrap();
        let c = read_package(&zip);
        assert!(manifest::is_reserved_id(&c.manifest.id), "examples use ids under dev.kalzit.");
        assert_eq!(c.manifest.permissions.network[0].setting.as_deref(), Some("url"));
    }

    fn read_package(zip: &[u8]) -> Contents {
        read(zip).unwrap()
    }

    #[test]
    fn keys_read_as_kalzit_prints_them() {
        let k = key(9);
        let b64 = BASE64.encode(k.verifying_key().as_bytes());
        assert_eq!(public_key(&b64).unwrap(), k.verifying_key());
        assert_eq!(public_key(&hex::encode(k.verifying_key().as_bytes())).unwrap(), k.verifying_key());
        assert_eq!(signing_key(&BASE64.encode([9u8; 32])).unwrap().verifying_key(), k.verifying_key());
    }
}
