//! The format of signed Kalzit releases (docs/ARCHITECTURE.md, "Updates"), shared by the server,
//! which verifies releases, and `kalzit-sign`, which makes them.
//!
//! A release carries one manifest (JSON) with a detached Ed25519 signature over its exact bytes,
//! and every package in it carries its own signature over version, platform, arch, file name,
//! size and SHA-256. Every signed message starts with its own context line, so a package
//! signature can never pass as a manifest signature or the other way round.

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Signed manifests start with this line.
pub const MANIFEST_CONTEXT: &[u8] = b"kalzit-update-manifest-v1\n";
/// Signed package descriptions start with this line.
pub const PACKAGE_CONTEXT: &[u8] = b"kalzit-update-package-v1\n";

/// The first bytes of an offline package (`.kalzit-update`): this line, then the manifest, its
/// signature and the package, each as a little-endian u64 length followed by its bytes.
pub const BUNDLE_MAGIC: &[u8; 16] = b"KALZIT-UPDATE-1\n";
/// The file name ending of offline packages.
pub const BUNDLE_EXTENSION: &str = "kalzit-update";

/// The most highlight lines a manifest may carry.
pub const MAX_HIGHLIGHTS: usize = 200;

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
    /// An `https` link to the full release notes.
    #[serde(default)]
    pub notes_url: Option<String>,
    /// The release notes' lines by section, for the Updates page.
    #[serde(default)]
    pub highlights: Vec<Highlight>,
    pub packages: Vec<Package>,
    /// Installer packages for a new installation (the Windows MSI), signed like `packages` but
    /// never installed by the updater, which takes only `packages`. Older servers ignore the
    /// field.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub installers: Vec<Package>,
}

/// One line of the release notes.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Highlight {
    /// `new`, `improved`, `fixed` or `security`.
    pub kind: String,
    pub text: String,
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

/// What a manifest signature covers: the context line, then the manifest's exact bytes.
pub fn manifest_message(manifest: &[u8]) -> Vec<u8> {
    let mut message = MANIFEST_CONTEXT.to_vec();
    message.extend_from_slice(manifest);
    message
}

/// The id of a public key: the first 8 bytes of its SHA-256, in hex.
pub fn key_id(key: &VerifyingKey) -> String {
    hex::encode(&Sha256::digest(key.as_bytes())[..8])
}

/// SHA-256 of `data`, lowercase hex.
pub fn sha256_hex(data: &[u8]) -> String {
    hex::encode(Sha256::digest(data))
}

/// A public key from base64; weak (small order) keys are refused.
pub fn parse_public_key(text: &str) -> Result<VerifyingKey, String> {
    let bytes = BASE64.decode(text.trim()).map_err(|e| format!("not base64: {e}"))?;
    let bytes: [u8; 32] = bytes.try_into().map_err(|_| "an Ed25519 public key has 32 bytes".to_string())?;
    let key = VerifyingKey::from_bytes(&bytes).map_err(|e| format!("not an Ed25519 public key: {e}"))?;
    if key.is_weak() {
        return Err("a weak (small order) key cannot be trusted".into());
    }
    Ok(key)
}

/// Checks `signature` over `message` with `key`, strictly (non-canonical signatures refused).
/// Says only whether it matches; the caller has already chosen the key by the signature's id.
pub fn signature_matches(key: &VerifyingKey, message: &[u8], signature: &DetachedSignature) -> bool {
    let Ok(bytes) = BASE64.decode(signature.signature.trim()) else { return false };
    let Ok(bytes) = <[u8; 64]>::try_from(bytes) else { return false };
    key.verify_strict(message, &Signature::from_bytes(&bytes)).is_ok()
}

/// Reads a signing key: the 32-byte Ed25519 seed in base64, as `kalzit-sign keygen` writes it.
pub fn signing_key_from_base64(text: &str) -> Result<SigningKey, String> {
    let bytes =
        zeroize::Zeroizing::new(BASE64.decode(text.trim()).map_err(|_| "the signing key is not base64".to_string())?);
    let seed: [u8; 32] = bytes.as_slice().try_into().map_err(|_| "the signing key must be 32 bytes".to_string())?;
    Ok(SigningKey::from_bytes(&seed))
}

pub fn public_key_base64(key: &SigningKey) -> String {
    BASE64.encode(key.verifying_key().as_bytes())
}

fn sign(key: &SigningKey, message: &[u8]) -> DetachedSignature {
    DetachedSignature { key_id: key_id(&key.verifying_key()), signature: BASE64.encode(key.sign(message).to_bytes()) }
}

/// What a plugin signature covers starts with this line (`kalzit_plugin_api::signing::MANIFEST_CONTEXT`,
/// tested there to be the same). The release keys never sign plugins; `kalzit-sign
/// sign-plugin-manifest` signs with the plugin key, so the release job need not build the plugin
/// crates next to it.
pub const PLUGIN_MANIFEST_CONTEXT: &[u8] = b"kalzit-plugin-manifest-v1\n";

/// The detached signature of a plugin manifest's exact bytes (`kalzit-plugin.sig`).
pub fn sign_plugin_manifest(key: &SigningKey, manifest: &[u8]) -> DetachedSignature {
    let mut message = PLUGIN_MANIFEST_CONTEXT.to_vec();
    message.extend_from_slice(manifest);
    sign(key, &message)
}

/// The detached signature of a manifest's exact bytes.
pub fn sign_manifest(key: &SigningKey, manifest: &[u8]) -> DetachedSignature {
    sign(key, &manifest_message(manifest))
}

/// A package entry with its signature.
pub fn sign_package(key: &SigningKey, version: &str, platform: &str, arch: &str, file: &str, data: &[u8]) -> Package {
    let sha256 = sha256_hex(data);
    let size = data.len() as u64;
    let signature = sign(key, &package_message(version, platform, arch, file, size, &sha256));
    Package { platform: platform.into(), arch: arch.into(), file: file.into(), size, sha256, signature }
}

/// The highlights of release notes in the format of `docs/releases/v<version>.md`: the lines of
/// the sections "## New", "## Improved", "## Fixed" and "## Security"; other sections (the
/// manual checklist) are left out. A point wrapped over several lines becomes one highlight.
pub fn highlights_from_notes(markdown: &str) -> Vec<Highlight> {
    let mut kind: Option<&str> = None;
    let mut points: Vec<(&str, String)> = Vec::new();
    // Whether the last point may still take continuation lines (no blank line since).
    let mut open = false;
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
            open = false;
            continue;
        }
        let Some(k) = kind else { continue };
        if let Some(text) = trimmed.strip_prefix("- ").or_else(|| trimmed.strip_prefix("* ")) {
            points.push((k, text.trim().to_string()));
            open = true;
        } else if trimmed.is_empty() {
            open = false;
        } else if open && let Some((_, text)) = points.last_mut() {
            text.push(' ');
            text.push_str(trimmed);
        }
    }
    points
        .into_iter()
        .filter(|(_, text)| !text.is_empty())
        .take(MAX_HIGHLIGHTS)
        .map(|(k, text)| Highlight { kind: k.to_string(), text: text.chars().take(300).collect() })
        .collect()
}

/// Writes an offline package of one release package.
pub fn write_bundle(
    out: &mut impl std::io::Write,
    manifest: &[u8],
    signature: &[u8],
    package: &[u8],
) -> std::io::Result<()> {
    out.write_all(BUNDLE_MAGIC)?;
    for part in [manifest, signature, package] {
        out.write_all(&(part.len() as u64).to_le_bytes())?;
        out.write_all(part)?;
    }
    out.flush()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn release_notes_become_highlights_without_the_checklist() {
        let notes = "# Kalzit 0.2.0\n\n## Improved\n\n- Faster typing\n- Axes\n\n## Fixed\n\n* Phone tables\n\n\
                     ## Checklist for Windows (manual)\n\n- Install the service\n";
        let h = highlights_from_notes(notes);
        let lines: Vec<(&str, &str)> = h.iter().map(|h| (h.kind.as_str(), h.text.as_str())).collect();
        assert_eq!(lines, [("improved", "Faster typing"), ("improved", "Axes"), ("fixed", "Phone tables")]);
    }

    #[test]
    fn a_wrapped_point_becomes_one_highlight() {
        let notes = "# Kalzit 0.3.2\n\n## Improved\n\n- Signing in on a browser that is not yours: tick\n  \
                     \"This is not my browser\".\n- Short\n\nNot a point.\n\n## Fixed\n\n- One\n";
        let h = highlights_from_notes(notes);
        let lines: Vec<(&str, &str)> = h.iter().map(|h| (h.kind.as_str(), h.text.as_str())).collect();
        assert_eq!(
            lines,
            [
                ("improved", "Signing in on a browser that is not yours: tick \"This is not my browser\"."),
                ("improved", "Short"),
                ("fixed", "One"),
            ]
        );
    }

    #[test]
    fn signatures_match_only_their_message_and_key() {
        let key = SigningKey::from_bytes(&[4; 32]);
        let other = SigningKey::from_bytes(&[5; 32]);
        let sig = sign_manifest(&key, b"{}");
        assert!(signature_matches(&key.verifying_key(), &manifest_message(b"{}"), &sig));
        assert!(!signature_matches(&key.verifying_key(), &manifest_message(b"{ }"), &sig));
        assert!(!signature_matches(&other.verifying_key(), &manifest_message(b"{}"), &sig));
        let garbage = DetachedSignature { key_id: sig.key_id.clone(), signature: "no".into() };
        assert!(!signature_matches(&key.verifying_key(), &manifest_message(b"{}"), &garbage));
    }

    #[test]
    fn signing_keys_round_trip_through_base64() {
        let key = SigningKey::from_bytes(&[9; 32]);
        let back = signing_key_from_base64(&BASE64.encode(key.to_bytes())).unwrap();
        assert_eq!(public_key_base64(&back), public_key_base64(&key));
        assert!(signing_key_from_base64("kurz").is_err());
    }

    #[test]
    fn weak_keys_are_refused() {
        let mut identity = [0u8; 32];
        identity[0] = 1;
        assert!(parse_public_key(&BASE64.encode(identity)).is_err());
    }
}
