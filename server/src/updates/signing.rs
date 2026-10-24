//! Release manifests and their Ed25519 signatures (docs/ARCHITECTURE.md, "Updates").
//!
//! A release carries one manifest (JSON) with a detached signature over its exact bytes, and
//! every package in it carries its own signature over its version, platform, size and SHA-256.
//! Only keys compiled into Kalzit are trusted: `COMPILED_KEYS`, plus the keys in the build-time
//! variable `KALZIT_UPDATE_PUBLIC_KEYS` (comma-separated, base64). A signature names its key by
//! id; an id that is not trusted is refused, never looked up elsewhere. Several trusted keys make
//! a key rotation possible: a release signed with the new key is accepted by servers that ship
//! both, and the old key is dropped a release later.
//!
//! Every signed message starts with its own context line, so a package signature can never pass
//! as a manifest signature or the other way round.

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::UpdateError;

/// Signed manifests start with this line.
pub const MANIFEST_CONTEXT: &[u8] = b"kalzit-update-manifest-v1\n";
/// Signed package descriptions start with this line.
pub const PACKAGE_CONTEXT: &[u8] = b"kalzit-update-package-v1\n";

/// PLACEHOLDER for the project's release public key: replace this value with the base64 public
/// key printed by `kalzit-sign keygen` (docs/operations/updates.md, "Release key"). The text
/// below is not a key; it is skipped, so a build that still carries it trusts no compiled key
/// and refuses every update until a key is set here or through `KALZIT_UPDATE_PUBLIC_KEYS` at
/// build time.
pub const RELEASE_KEY_PLACEHOLDER: &str = "PLACEHOLDER-SET-THE-KALZIT-RELEASE-PUBLIC-KEY";

/// The trusted release keys, newest first. During a rotation both the new and the old key are
/// listed; see the operator guide.
pub const COMPILED_KEYS: &[&str] = &[RELEASE_KEY_PLACEHOLDER];

/// Extra trusted keys given when Kalzit was built (`KALZIT_UPDATE_PUBLIC_KEYS`, comma-separated
/// base64). Cargo rebuilds when the variable changes.
const BUILD_KEYS: Option<&str> = option_env!("KALZIT_UPDATE_PUBLIC_KEYS");

/// The largest manifest and signature files accepted.
pub const MAX_MANIFEST_BYTES: usize = 256 * 1024;
pub const MAX_SIGNATURE_BYTES: usize = 4 * 1024;
/// The largest package accepted (a Kalzit binary is far smaller).
pub const MAX_PACKAGE_BYTES: u64 = 512 * 1024 * 1024;
/// The longest release notes summary.
const MAX_NOTES_CHARS: usize = 8000;

/// A key Kalzit trusts, with its id (the first 8 bytes of the SHA-256 of the key, in hex).
#[derive(Clone, Debug)]
pub struct TrustedKey {
    pub id: String,
    key: VerifyingKey,
}

#[derive(Clone, Debug, Default)]
pub struct TrustedKeys(Vec<TrustedKey>);

impl TrustedKeys {
    /// The keys compiled into this build. Entries that are not keys are skipped with a warning;
    /// a test makes sure the compiled list holds only keys and the placeholder.
    pub fn compiled() -> Self {
        let build = BUILD_KEYS.unwrap_or_default().split(',').map(str::trim).filter(|k| !k.is_empty());
        let mut keys = Vec::new();
        for text in COMPILED_KEYS.iter().copied().chain(build) {
            if text == RELEASE_KEY_PLACEHOLDER {
                continue;
            }
            match parse_public_key(text) {
                Ok(key) => keys.push(key),
                Err(e) => tracing::warn!("ignoring a trusted update key that is not valid: {e}"),
            }
        }
        keys.dedup_by(|a, b| a.id == b.id);
        Self(keys)
    }

    /// Keys from base64 text (tests and the signing tool's own checks).
    pub fn from_base64(keys: &[&str]) -> Result<Self, String> {
        keys.iter().map(|k| parse_public_key(k)).collect::<Result<Vec<_>, _>>().map(Self)
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    pub fn ids(&self) -> Vec<String> {
        self.0.iter().map(|k| k.id.clone()).collect()
    }

    fn find(&self, id: &str) -> Option<&VerifyingKey> {
        self.0.iter().find(|k| k.id == id).map(|k| &k.key)
    }
}

fn parse_public_key(text: &str) -> Result<TrustedKey, String> {
    let bytes = BASE64.decode(text.trim()).map_err(|e| format!("not base64: {e}"))?;
    let bytes: [u8; 32] = bytes.try_into().map_err(|_| "an Ed25519 public key has 32 bytes".to_string())?;
    let key = VerifyingKey::from_bytes(&bytes).map_err(|e| format!("not an Ed25519 public key: {e}"))?;
    if key.is_weak() {
        return Err("a weak (small order) key cannot be trusted".into());
    }
    Ok(TrustedKey { id: key_id(&key), key })
}

/// The id of a public key: the first 8 bytes of its SHA-256, in hex.
pub fn key_id(key: &VerifyingKey) -> String {
    hex::encode(&Sha256::digest(key.as_bytes())[..8])
}

/// A detached signature: which key made it, and the signature in base64.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DetachedSignature {
    pub key_id: String,
    pub signature: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Channel {
    Stable,
    Preview,
}

/// What a release offers. Unknown fields are ignored, so a later manifest format can add some;
/// the signature covers the exact bytes either way.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    /// 1.
    pub format: u32,
    /// "kalzit".
    pub product: String,
    pub version: String,
    pub channel: Channel,
    /// RFC 3339 date of the release.
    #[serde(default)]
    pub released_at: Option<String>,
    /// The oldest installed version that may update to this one directly.
    #[serde(default)]
    pub minimum_version: Option<String>,
    /// A short summary of the release notes (plain text).
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub notes_url: Option<String>,
    /// The release notes' lines by section, for the Updates page.
    #[serde(default)]
    pub highlights: Vec<Highlight>,
    pub packages: Vec<Package>,
}

/// One line of the release notes.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Highlight {
    /// `new`, `improved`, `fixed` or `security`.
    pub kind: String,
    pub text: String,
}

/// The most highlight lines a manifest may carry.
const MAX_HIGHLIGHTS: usize = 200;

/// The highlights of release notes in the format of `docs/releases/v<version>.md`: the lines of
/// the sections "## New", "## Improved", "## Fixed" and "## Security"; other sections (the
/// manual checklist) are left out.
pub fn highlights_from_notes(markdown: &str) -> Vec<Highlight> {
    let mut kind: Option<&str> = None;
    let mut out = Vec::new();
    for line in markdown.lines() {
        let trimmed = line.trim();
        if let Some(heading) = trimmed.strip_prefix("## ") {
            kind = match heading.trim().to_ascii_lowercase().as_str() {
                "new" => Some("new"),
                "improved" => Some("improved"),
                "fixed" => Some("fixed"),
                "security" => Some("security"),
                _ => None,
            };
            continue;
        }
        if let (Some(k), Some(text)) = (kind, trimmed.strip_prefix("- ").or_else(|| trimmed.strip_prefix("* "))) {
            let text: String = text.trim().chars().take(300).collect();
            if !text.is_empty() && out.len() < MAX_HIGHLIGHTS {
                out.push(Highlight { kind: k.to_string(), text });
            }
        }
    }
    out
}

/// One binary of a release.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Package {
    /// `linux` or `windows`.
    pub platform: String,
    /// `x64` or `arm64`.
    pub arch: String,
    /// The asset's file name in the release.
    pub file: String,
    pub size: u64,
    /// Lowercase hex.
    pub sha256: String,
    /// Over `package_message`.
    pub signature: DetachedSignature,
}

/// What a package signature covers: the context line, then one `key=value` line per field.
pub fn package_message(version: &str, platform: &str, arch: &str, file: &str, size: u64, sha256: &str) -> Vec<u8> {
    let mut message = PACKAGE_CONTEXT.to_vec();
    message.extend_from_slice(
        format!("version={version}\nplatform={platform}\narch={arch}\nfile={file}\nsize={size}\nsha256={sha256}\n")
            .as_bytes(),
    );
    message
}

fn manifest_message(manifest: &[u8]) -> Vec<u8> {
    let mut message = MANIFEST_CONTEXT.to_vec();
    message.extend_from_slice(manifest);
    message
}

/// Checks `signature` over `message` with the trusted key it names. Verification is strict:
/// non-canonical signatures and weak keys are refused.
fn verify(keys: &TrustedKeys, message: &[u8], signature: &DetachedSignature) -> Result<(), UpdateError> {
    if keys.is_empty() {
        return Err(UpdateError::NoTrustedKey);
    }
    let Some(key) = keys.find(&signature.key_id) else {
        return Err(UpdateError::UnknownKey(signature.key_id.chars().take(64).collect()));
    };
    let bytes = BASE64.decode(signature.signature.trim()).map_err(|_| UpdateError::SignatureInvalid)?;
    let bytes: [u8; 64] = bytes.try_into().map_err(|_| UpdateError::SignatureInvalid)?;
    key.verify_strict(message, &Signature::from_bytes(&bytes)).map_err(|_| UpdateError::SignatureInvalid)
}

/// Parses a detached signature file.
pub fn parse_signature(bytes: &[u8]) -> Result<DetachedSignature, UpdateError> {
    if bytes.len() > MAX_SIGNATURE_BYTES {
        return Err(UpdateError::ManifestInvalid("the signature file is too large".into()));
    }
    serde_json::from_slice(bytes).map_err(|e| UpdateError::ManifestInvalid(format!("the signature file: {e}")))
}

/// Verifies a manifest and every package signature in it, then checks its form. Nothing in the
/// manifest is read before its signature passed.
pub fn verify_manifest(keys: &TrustedKeys, manifest: &[u8], signature: &[u8]) -> Result<Manifest, UpdateError> {
    if manifest.len() > MAX_MANIFEST_BYTES {
        return Err(UpdateError::ManifestInvalid("the manifest is too large".into()));
    }
    let signature = parse_signature(signature)?;
    verify(keys, &manifest_message(manifest), &signature)?;
    let parsed: Manifest =
        serde_json::from_slice(manifest).map_err(|e| UpdateError::ManifestInvalid(format!("the manifest: {e}")))?;
    check_form(&parsed)?;
    for p in &parsed.packages {
        let message = package_message(&parsed.version, &p.platform, &p.arch, &p.file, p.size, &p.sha256);
        verify(keys, &message, &p.signature)?;
    }
    Ok(parsed)
}

fn check_form(m: &Manifest) -> Result<(), UpdateError> {
    let bad = |what: &str| Err(UpdateError::ManifestInvalid(what.to_string()));
    if m.format != 1 {
        return bad("the manifest format is not 1");
    }
    if m.product != "kalzit" {
        return bad("the manifest is not for Kalzit");
    }
    if semver::Version::parse(&m.version).is_err() {
        return bad("the version is not a semantic version");
    }
    if m.minimum_version.as_deref().is_some_and(|v| semver::Version::parse(v).is_err()) {
        return bad("the minimum version is not a semantic version");
    }
    if m.notes.chars().count() > MAX_NOTES_CHARS {
        return bad("the release notes summary is too long");
    }
    if m.packages.is_empty() {
        return bad("the manifest lists no package");
    }
    let kinds_ok = m
        .highlights
        .iter()
        .all(|h| matches!(h.kind.as_str(), "new" | "improved" | "fixed" | "security") && h.text.chars().count() <= 300);
    if m.highlights.len() > MAX_HIGHLIGHTS || !kinds_ok {
        return bad("the release notes highlights are not valid");
    }
    for p in &m.packages {
        let name_ok = !p.file.is_empty()
            && p.file.len() <= 200
            && p.file.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
            && !p.file.starts_with('.');
        if !name_ok {
            return bad("a package file name is not a plain file name");
        }
        if !matches!(p.platform.as_str(), "linux" | "windows") || !matches!(p.arch.as_str(), "x64" | "arm64") {
            return bad("a package names an unknown platform");
        }
        if p.size == 0 || p.size > MAX_PACKAGE_BYTES {
            return bad("a package size is out of range");
        }
        if p.sha256.len() != 64 || !p.sha256.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f')) {
            return bad("a package hash is not a lowercase SHA-256");
        }
    }
    Ok(())
}

/// Reads a signing key: the 32-byte Ed25519 seed in base64, as `kalzit-sign keygen` writes it.
pub fn signing_key_from_base64(text: &str) -> Result<SigningKey, String> {
    let bytes = BASE64.decode(text.trim()).map_err(|_| "the signing key is not base64".to_string())?;
    let seed: [u8; 32] = bytes.try_into().map_err(|_| "the signing key must be 32 bytes".to_string())?;
    Ok(SigningKey::from_bytes(&seed))
}

pub fn public_key_base64(key: &SigningKey) -> String {
    BASE64.encode(key.verifying_key().as_bytes())
}

fn sign(key: &SigningKey, message: &[u8]) -> DetachedSignature {
    DetachedSignature { key_id: key_id(&key.verifying_key()), signature: BASE64.encode(key.sign(message).to_bytes()) }
}

/// The detached signature of a manifest's exact bytes.
pub fn sign_manifest(key: &SigningKey, manifest: &[u8]) -> DetachedSignature {
    sign(key, &manifest_message(manifest))
}

/// A package entry with its signature.
pub fn sign_package(key: &SigningKey, version: &str, platform: &str, arch: &str, file: &str, data: &[u8]) -> Package {
    let sha256 = hex::encode(Sha256::digest(data));
    let size = data.len() as u64;
    let signature = sign(key, &package_message(version, platform, arch, file, size, &sha256));
    Package { platform: platform.into(), arch: arch.into(), file: file.into(), size, sha256, signature }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// A key made for the tests from a fixed seed; it signs nothing outside them.
    pub(crate) fn test_key(seed: u8) -> SigningKey {
        SigningKey::from_bytes(&[seed; 32])
    }

    pub(crate) fn keys_for(key: &SigningKey) -> TrustedKeys {
        TrustedKeys::from_base64(&[&public_key_base64(key)]).unwrap()
    }

    /// A signed manifest for `version` with one package per (platform, arch, bytes).
    pub(crate) fn signed_manifest(
        key: &SigningKey,
        version: &str,
        packages: &[(&str, &str, &[u8])],
    ) -> (Vec<u8>, Vec<u8>) {
        let packages = packages
            .iter()
            .map(|(platform, arch, data)| {
                let file = format!("kalzit-{version}-{platform}-{arch}");
                sign_package(key, version, platform, arch, &file, data)
            })
            .collect();
        let manifest = Manifest {
            format: 1,
            product: "kalzit".into(),
            version: version.into(),
            channel: Channel::Stable,
            released_at: Some("2026-10-24T00:00:00Z".into()),
            minimum_version: None,
            notes: "Faster dashboards.".into(),
            notes_url: None,
            highlights: vec![Highlight { kind: "improved".into(), text: "Faster dashboards".into() }],
            packages,
        };
        let bytes = serde_json::to_vec_pretty(&manifest).unwrap();
        let sig = serde_json::to_vec(&sign_manifest(key, &bytes)).unwrap();
        (bytes, sig)
    }

    #[test]
    fn a_signed_manifest_verifies() {
        let key = test_key(7);
        let (manifest, sig) = signed_manifest(&key, "1.2.3", &[("linux", "x64", b"binary")]);
        let m = verify_manifest(&keys_for(&key), &manifest, &sig).unwrap();
        assert_eq!(m.version, "1.2.3");
        assert_eq!(m.packages[0].size, 6);
    }

    #[test]
    fn a_changed_manifest_is_refused() {
        let key = test_key(7);
        let (manifest, sig) = signed_manifest(&key, "1.2.3", &[("linux", "x64", b"binary")]);
        let tampered = String::from_utf8(manifest).unwrap().replace("1.2.3", "9.9.9").into_bytes();
        assert!(matches!(verify_manifest(&keys_for(&key), &tampered, &sig), Err(UpdateError::SignatureInvalid)));
        // One byte of whitespace is a change as well.
        let (manifest, sig) = signed_manifest(&key, "1.2.3", &[("linux", "x64", b"binary")]);
        let mut spaced = manifest.clone();
        spaced.push(b' ');
        assert!(matches!(verify_manifest(&keys_for(&key), &spaced, &sig), Err(UpdateError::SignatureInvalid)));
    }

    #[test]
    fn a_package_entry_changed_inside_a_re_signed_manifest_is_refused() {
        // Someone with a manifest key but without the package signature cannot swap a hash: the
        // package signature still covers the old one.
        let key = test_key(7);
        let (manifest, _) = signed_manifest(&key, "1.2.3", &[("linux", "x64", b"binary")]);
        let mut m: Manifest = serde_json::from_slice(&manifest).unwrap();
        m.packages[0].sha256 = hex::encode(Sha256::digest(b"evil"));
        let bytes = serde_json::to_vec(&m).unwrap();
        let sig = serde_json::to_vec(&sign_manifest(&key, &bytes)).unwrap();
        assert!(matches!(verify_manifest(&keys_for(&key), &bytes, &sig), Err(UpdateError::SignatureInvalid)));
    }

    #[test]
    fn an_unknown_key_is_refused_and_no_key_trusts_nothing() {
        let key = test_key(7);
        let other = test_key(8);
        let (manifest, sig) = signed_manifest(&other, "1.2.3", &[("linux", "x64", b"binary")]);
        assert!(matches!(verify_manifest(&keys_for(&key), &manifest, &sig), Err(UpdateError::UnknownKey(_))));
        assert!(matches!(verify_manifest(&TrustedKeys::default(), &manifest, &sig), Err(UpdateError::NoTrustedKey)));
    }

    #[test]
    fn a_signature_claiming_a_trusted_key_id_but_made_by_another_key_is_refused() {
        let key = test_key(7);
        let other = test_key(8);
        let (manifest, _) = signed_manifest(&other, "1.2.3", &[("linux", "x64", b"binary")]);
        let mut sig = sign_manifest(&other, &manifest);
        sig.key_id = key_id(&key.verifying_key());
        let sig = serde_json::to_vec(&sig).unwrap();
        assert!(matches!(verify_manifest(&keys_for(&key), &manifest, &sig), Err(UpdateError::SignatureInvalid)));
    }

    #[test]
    fn a_package_signature_does_not_pass_as_a_manifest_signature() {
        let key = test_key(7);
        let message = package_message("1.2.3", "linux", "x64", "f", 1, &"0".repeat(64));
        let as_manifest = sign(&key, &message);
        // The same bytes signed in the package context do not verify as a manifest.
        let body = &message[PACKAGE_CONTEXT.len()..];
        assert!(verify(&keys_for(&key), &manifest_message(body), &as_manifest).is_err());
    }

    #[test]
    fn key_rotation_accepts_any_listed_key() {
        let old = test_key(1);
        let new = test_key(2);
        let both = TrustedKeys::from_base64(&[&public_key_base64(&new), &public_key_base64(&old)]).unwrap();
        for key in [&old, &new] {
            let (manifest, sig) = signed_manifest(key, "1.2.3", &[("windows", "x64", b"exe")]);
            assert!(verify_manifest(&both, &manifest, &sig).is_ok());
        }
    }

    #[test]
    fn malformed_manifests_are_refused_after_the_signature() {
        let key = test_key(7);
        let sign_raw = |text: &str| {
            let sig = serde_json::to_vec(&sign_manifest(&key, text.as_bytes())).unwrap();
            verify_manifest(&keys_for(&key), text.as_bytes(), &sig)
        };
        assert!(matches!(sign_raw("not json"), Err(UpdateError::ManifestInvalid(_))));
        let (manifest, _) = signed_manifest(&key, "1.2.3", &[("linux", "x64", b"binary")]);
        let text = String::from_utf8(manifest).unwrap();
        for (from, to) in [
            ("\"kalzit-1.2.3-linux-x64\"", "\"../kalzit\""),
            ("\"linux\"", "\"plan9\""),
            ("\"product\": \"kalzit\"", "\"product\": \"other\""),
            ("\"1.2.3\"", "\"one\""),
        ] {
            assert!(matches!(sign_raw(&text.replacen(from, to, 1)), Err(UpdateError::ManifestInvalid(_))), "{to}");
        }
    }

    #[test]
    fn oversized_inputs_are_refused_before_parsing() {
        let key = test_key(7);
        let big = vec![b' '; MAX_MANIFEST_BYTES + 1];
        assert!(matches!(verify_manifest(&keys_for(&key), &big, b"{}"), Err(UpdateError::ManifestInvalid(_))));
        let (manifest, _) = signed_manifest(&key, "1.2.3", &[("linux", "x64", b"binary")]);
        let big_sig = vec![b' '; MAX_SIGNATURE_BYTES + 1];
        assert!(matches!(verify_manifest(&keys_for(&key), &manifest, &big_sig), Err(UpdateError::ManifestInvalid(_))));
    }

    #[test]
    fn the_compiled_list_holds_only_keys_and_the_placeholder() {
        for text in COMPILED_KEYS {
            assert!(*text == RELEASE_KEY_PLACEHOLDER || parse_public_key(text).is_ok(), "{text} is not a key");
        }
        // The placeholder is never a key, so a build that still has it trusts no compiled key.
        assert!(parse_public_key(RELEASE_KEY_PLACEHOLDER).is_err());
    }

    #[test]
    fn weak_keys_are_not_trusted() {
        // The identity point (all zero but the first byte) has small order.
        let mut identity = [0u8; 32];
        identity[0] = 1;
        assert!(parse_public_key(&BASE64.encode(identity)).is_err());
    }

    #[test]
    fn release_notes_become_highlights_without_the_checklist() {
        let notes = "# Kalzit 0.2.0\n\n## Improved\n\n- Faster typing\n- Axes\n\n## Fixed\n\n* Phone tables\n\n\
                     ## Checklist for Windows (manual)\n\n- Install the service\n";
        let h = highlights_from_notes(notes);
        let lines: Vec<(&str, &str)> = h.iter().map(|h| (h.kind.as_str(), h.text.as_str())).collect();
        assert_eq!(lines, [("improved", "Faster typing"), ("improved", "Axes"), ("fixed", "Phone tables")]);
    }

    #[test]
    fn signing_keys_round_trip_through_base64() {
        let key = test_key(9);
        let text = BASE64.encode(key.to_bytes());
        let back = signing_key_from_base64(&text).unwrap();
        assert_eq!(public_key_base64(&back), public_key_base64(&key));
        assert!(signing_key_from_base64("kurz").is_err());
    }
}
