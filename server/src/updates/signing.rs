//! Verifying releases (docs/ARCHITECTURE.md, "Updates"). The format and the signed messages are
//! in the `kalzit-release` crate, which `kalzit-sign` shares, so both sides cannot drift apart.
//!
//! Only keys compiled into Kalzit are trusted: `COMPILED_KEYS`, plus the keys in the build-time
//! variable `KALZIT_UPDATE_PUBLIC_KEYS` (comma-separated, base64). A signature names its key by
//! id; an id that is not trusted is refused, never looked up elsewhere. Several trusted keys make
//! a key rotation possible: a release signed with the new key is accepted by servers that ship
//! both, and the old key is dropped a release later. Listing a second key whose private half is
//! kept offline lets the project revoke a leaked key with a release signed by the other one.

use ed25519_dalek::VerifyingKey;

pub use kalzit_release::{
    BUNDLE_EXTENSION, BUNDLE_MAGIC, Channel, DetachedSignature, Highlight, MANIFEST_CONTEXT, MAX_HIGHLIGHTS, Manifest,
    PACKAGE_CONTEXT, Package, highlights_from_notes, key_id, manifest_message, package_message, public_key_base64,
    sha256_hex, sign_manifest, sign_package, signing_key_from_base64, write_bundle,
};

use super::UpdateError;

/// PLACEHOLDER for the project's release public key: replace this value with the base64 public
/// key printed by `kalzit-sign keygen` (docs/operations/updates.md, "Release key"). The text
/// below is not a key; it is skipped, so a build that still carries it trusts no compiled key
/// and refuses every update until a key is set here or through `KALZIT_UPDATE_PUBLIC_KEYS` at
/// build time.
pub const RELEASE_KEY_PLACEHOLDER: &str = "PLACEHOLDER-SET-THE-KALZIT-RELEASE-PUBLIC-KEY";

/// The 2026 release key (key id ad39cc7bdcca1649); its private half signs releases in the
/// `release` environment.
pub const RELEASE_KEY_2026: &str = "/9zXPgaQYKE0f6Gui9i+Lhneg9a8nJMcm40Ud5KZm+g=";

/// The 2026 backup key (key id eb97403429a2907a), kept offline only; it signs the release that
/// revokes the first key if that one leaks.
pub const RELEASE_KEY_2026_OFFLINE: &str = "rYhsRUAkyhIhwVAEkEtCKKExi8bc9ypf8Zcoz3xKBOw=";

/// The trusted release keys, newest first. During a rotation both the new and the old key are
/// listed; a second key kept offline makes revoking a leaked one possible (operator guide).
pub const COMPILED_KEYS: &[&str] = &[RELEASE_KEY_2026, RELEASE_KEY_2026_OFFLINE];

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

    /// Keys from base64 text (tests).
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
    let key = kalzit_release::parse_public_key(text)?;
    Ok(TrustedKey { id: key_id(&key), key })
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
    if kalzit_release::signature_matches(key, message, signature) { Ok(()) } else { Err(UpdateError::SignatureInvalid) }
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
    // The page links to it; only an https link to somewhere is shown.
    if m.notes_url.as_deref().is_some_and(|u| !u.starts_with("https://") || u.len() > 2000) {
        return bad("the release notes link is not an https URL");
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

#[cfg(test)]
pub(crate) mod tests {
    use ed25519_dalek::SigningKey;

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
        signed_manifest_on(key, version, Channel::Stable, packages)
    }

    pub(crate) fn signed_manifest_on(
        key: &SigningKey,
        version: &str,
        channel: Channel,
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
            channel,
            released_at: Some("2026-10-24T00:00:00Z".into()),
            minimum_version: None,
            notes: "Faster dashboards.".into(),
            notes_url: None,
            highlights: vec![Highlight { kind: "improved".into(), text: "Faster dashboards".into() }],
            packages,
            installers: vec![],
        };
        let bytes = serde_json::to_vec_pretty(&manifest).unwrap();
        let sig = serde_json::to_vec(&sign_manifest(key, &bytes)).unwrap();
        (bytes, sig)
    }

    /// What the Updates page shows: a shortened highlight with umlauts ends in a real "…",
    /// from a manifest written by `kalzit-sign` (`manifest_json`, non-ASCII as `\u` escapes).
    #[test]
    fn a_shortened_highlight_with_umlauts_reads_back_with_its_ellipsis() {
        let key = test_key(7);
        let point = "Übersicht für große Dashboards, schneller geöffnet ".repeat(10);
        let highlights = highlights_from_notes(&format!("## Improved\n\n- {}\n", point.trim_end()));
        let (manifest, _) = signed_manifest(&key, "1.2.3", &[("linux", "x64", b"binary")]);
        let mut m: Manifest = serde_json::from_slice(&manifest).unwrap();
        m.highlights = highlights;
        let bytes = kalzit_release::manifest_json(&m).unwrap();
        let sig = serde_json::to_vec(&sign_manifest(&key, &bytes)).unwrap();
        let read = verify_manifest(&keys_for(&key), &bytes, &sig).unwrap();
        let text = &read.highlights[0].text;
        assert!(text.starts_with("Übersicht für große") && text.ends_with('…'), "{text}");
        assert!(!text.contains('â') && text.chars().count() <= 300, "{text}");
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
        m.packages[0].sha256 = sha256_hex(b"evil");
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
        let entry = sign_package(&key, "1.2.3", "linux", "x64", "f", b"x");
        let message = package_message("1.2.3", "linux", "x64", "f", 1, &entry.sha256);
        // The same bytes signed in the package context do not verify as a manifest.
        let body = &message[PACKAGE_CONTEXT.len()..];
        assert!(verify(&keys_for(&key), &manifest_message(body), &entry.signature).is_err());
        assert!(verify(&keys_for(&key), &message, &entry.signature).is_ok());
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
            ("\"notesUrl\": null", "\"notesUrl\": \"javascript:alert(1)\""),
            ("\"notesUrl\": null", "\"notesUrl\": \"http://example.com/notes\""),
        ] {
            assert!(text.contains(from), "{from}");
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
}
