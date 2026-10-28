//! Plugin signatures and the trust rules around them (docs/ARCHITECTURE.md, "Plugins").
//!
//! Plugins are signed with Ed25519 like releases, but in their own contexts: every signed
//! message starts with a context line no release message starts with, so a release signature
//! never verifies as a plugin signature or the other way round. Plugin keys are separate from
//! the release keys too: Kalzit's own plugin key and the publisher keys an administrator adds;
//! the release keys are never trusted for plugins.
//!
//! Rules this module decides, so every host applies them the same way:
//! - A signature that does not verify is always refused, also when unsigned plugins are allowed.
//! - Ids under `io.kalzit.` and `dev.kalzit.` need Kalzit's own plugin key (`check_signer`).
//! - A plugin id is bound to the key that signed its installed version: an update needs the
//!   same key, or a new key the old one handed the id over to (`HandOver`), and never goes back
//!   to an older version (`check_update`). Keys are compared by all their 32 bytes, never by
//!   the short `key_id`.
//! - `check_update` does not look at reserved ids: the host runs `check_signer` on every
//!   install and every update as well.
//! - Hand-overs do not expire, and a leaked old key can hand the id over again. The remedy for
//!   a leaked key is to remove it from the trusted keys (its plugins stop) and trust only the
//!   publisher's new key.

use ed25519_dalek::{Signature, VerifyingKey};
use sha2::{Digest, Sha256};

use crate::manifest::{Manifest, is_reserved_id};

/// The context line of a plugin manifest signature.
pub const MANIFEST_CONTEXT: &[u8] = b"kalzit-plugin-manifest-v1\n";

/// The context line of a catalog index signature.
pub const CATALOG_CONTEXT: &[u8] = b"kalzit-plugin-catalog-v1\n";

/// The context line of a key hand-over statement.
pub const HANDOVER_CONTEXT: &[u8] = b"kalzit-plugin-handover-v1\n";

/// The id of a public key: the first 8 bytes of its SHA-256, in hex (as for release keys).
pub fn key_id(key: &VerifyingKey) -> String {
    hex::encode(&Sha256::digest(key.as_bytes())[..8])
}

fn with_context(context: &[u8], body: &[u8]) -> Vec<u8> {
    let mut message = context.to_vec();
    message.extend_from_slice(body);
    message
}

/// What a plugin signature covers: the context line, then the manifest's exact bytes. The
/// manifest pins every file of the package by SHA-256, so the signature covers them as well.
pub fn manifest_message(manifest: &[u8]) -> Vec<u8> {
    with_context(MANIFEST_CONTEXT, manifest)
}

/// What a catalog signature covers: the context line, then the index's exact bytes.
pub fn catalog_message(index: &[u8]) -> Vec<u8> {
    with_context(CATALOG_CONTEXT, index)
}

/// The old key of a plugin hands its id over to a new key (key rotation). Signed by the old
/// key; the host keeps it with the plugin, so updates from `from_version` on may be signed by
/// the new key.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HandOver {
    pub plugin_id: String,
    /// The old public key, all 32 bytes in lowercase hex (`key_hex`).
    pub from: String,
    /// The new public key, all 32 bytes in lowercase hex.
    pub to: String,
    /// The first plugin version the new key may sign (semver).
    pub from_version: String,
}

/// A public key as hand-overs name it: all 32 bytes in lowercase hex, never the short `key_id`.
pub fn key_hex(key: &VerifyingKey) -> String {
    hex::encode(key.as_bytes())
}

/// What a hand-over signature covers: the context line, then one `key=value` line per field.
pub fn handover_message(h: &HandOver) -> Vec<u8> {
    let body = format!("plugin={}\nfrom={}\nto={}\nfrom_version={}\n", h.plugin_id, h.from, h.to, h.from_version);
    with_context(HANDOVER_CONTEXT, body.as_bytes())
}

/// Checks `signature` over `message` strictly (non-canonical signatures and weak keys refused).
fn verifies(key: &VerifyingKey, message: &[u8], signature: &Signature) -> bool {
    !key.is_weak() && key.verify_strict(message, signature).is_ok()
}

pub fn verify_manifest(key: &VerifyingKey, manifest: &[u8], signature: &Signature) -> bool {
    verifies(key, &manifest_message(manifest), signature)
}

pub fn verify_catalog(key: &VerifyingKey, index: &[u8], signature: &Signature) -> bool {
    verifies(key, &catalog_message(index), signature)
}

/// Whether `old_key` signed this hand-over. The statement names `old_key` in full as `from`, a
/// valid, not weak public key in canonical hex as `to`, and a semantic `from_version`.
pub fn verify_handover(old_key: &VerifyingKey, h: &HandOver, signature: &Signature) -> bool {
    let to_is_key = hex::decode(&h.to).ok().and_then(|bytes| <[u8; 32]>::try_from(bytes).ok()).is_some_and(|bytes| {
        h.to == hex::encode(bytes) && VerifyingKey::from_bytes(&bytes).is_ok_and(|k| !k.is_weak())
    });
    h.from == key_hex(old_key)
        && to_is_key
        && semver::Version::parse(&h.from_version).is_ok()
        && verifies(old_key, &handover_message(h), signature)
}

/// Who signed a package whose signature verified (or that has none).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Signer {
    /// Kalzit's own plugin key.
    Kalzit,
    /// A publisher key an administrator trusts.
    Publisher,
    /// No signature; only with the administrator's switch for unsigned plugins.
    Unsigned,
}

/// Why a package or an update is refused.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Refusal {
    /// The id lies in Kalzit's namespace but the package is not signed with Kalzit's key.
    ReservedId,
    /// The update is for another plugin.
    OtherPlugin,
    /// The update's version is older than the installed one.
    Downgrade,
    /// The update is not signed by the installed version's key, and no hand-over allows its key.
    KeyChanged,
}

impl Refusal {
    pub fn code(&self) -> &'static str {
        match self {
            Refusal::ReservedId => "plugin.id_reserved",
            Refusal::OtherPlugin => "plugin.update_other_id",
            Refusal::Downgrade => "plugin.downgrade",
            Refusal::KeyChanged => "plugin.key_changed",
        }
    }
}

/// Whether `signer` may sign a plugin with this manifest's id.
pub fn check_signer(manifest: &Manifest, signer: Signer) -> Result<(), Refusal> {
    if is_reserved_id(&manifest.id) && signer != Signer::Kalzit {
        return Err(Refusal::ReservedId);
    }
    Ok(())
}

/// An installed plugin as the host keeps it.
pub struct Installed<'a> {
    pub manifest: &'a Manifest,
    /// The key that signed it; `None` for an unsigned install.
    pub key: Option<&'a VerifyingKey>,
    /// Verified hand-overs of this plugin's id (`verify_handover`), in any order.
    pub handovers: &'a [HandOver],
}

/// Whether `update`, signed by `key` (already verified), may replace `installed`. Both
/// manifests are valid. An unsigned install may become signed; a signed one stays bound to its
/// key or the keys it was handed over to.
pub fn check_update(installed: &Installed, update: &Manifest, key: Option<&VerifyingKey>) -> Result<(), Refusal> {
    if update.id != installed.manifest.id {
        return Err(Refusal::OtherPlugin);
    }
    let parse = |v: &str| semver::Version::parse(v).ok();
    match (parse(&installed.manifest.version), parse(&update.version)) {
        (Some(old), Some(new)) if new >= old => {}
        _ => return Err(Refusal::Downgrade),
    }
    let Some(old) = installed.key else { return Ok(()) };
    let Some(new) = key else { return Err(Refusal::KeyChanged) };
    // The keys reachable from the installed key through this plugin's hand-overs that apply to
    // the update's version, followed until nothing changes, so their order does not matter.
    let version = parse(&update.version).expect("checked above");
    let mut reachable = std::collections::BTreeSet::from([key_hex(old)]);
    loop {
        let before = reachable.len();
        for h in installed.handovers.iter().filter(|h| h.plugin_id == update.id) {
            let applies = parse(&h.from_version).is_some_and(|from| version >= from);
            if applies && reachable.contains(&h.from) {
                reachable.insert(h.to.clone());
            }
        }
        if reachable.len() == before {
            break;
        }
    }
    if reachable.contains(&key_hex(new)) { Ok(()) } else { Err(Refusal::KeyChanged) }
}

#[cfg(test)]
mod tests {
    use ed25519_dalek::{Signer as _, SigningKey};

    use super::*;

    /// `kalzit-sign sign-plugin-manifest` signs in this crate's context, so its signatures verify
    /// here and nowhere else.
    #[test]
    fn kalzit_sign_signs_plugin_manifests_as_the_host_checks_them() {
        assert_eq!(kalzit_release::PLUGIN_MANIFEST_CONTEXT, MANIFEST_CONTEXT);
        let k = key(11);
        let manifest = b"manifest = 1\n";
        let sig = kalzit_release::sign_plugin_manifest(&k, manifest);
        assert_eq!(sig.key_id, key_id(&k.verifying_key()));
        use base64::Engine as _;
        let raw = base64::engine::general_purpose::STANDARD.decode(&sig.signature).unwrap();
        let signature = Signature::from_bytes(&raw.try_into().unwrap());
        assert!(verify_manifest(&k.verifying_key(), manifest, &signature));
        assert!(!kalzit_release::signature_matches(
            &k.verifying_key(),
            &kalzit_release::manifest_message(manifest),
            &sig
        ));
    }

    fn key(seed: u8) -> SigningKey {
        SigningKey::from_bytes(&[seed; 32])
    }

    const MANIFEST: &str = r#"
manifest = 1
id = "dev.example.redis"
name = "Redis"
version = "1.2.0"
kind = "datasource"
min_kalzit = "0.4.0"
shapes = ["frame"]
protocol = 1

[binaries]
linux-x64 = "bin/redis-plugin"

[files]
"bin/redis-plugin" = "3f1a2b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708"
"#;

    fn manifest(version: &str, id: &str) -> Manifest {
        crate::manifest::parse(&MANIFEST.replacen("1.2.0", version, 1).replacen("dev.example.redis", id, 1)).unwrap()
    }

    #[test]
    fn plugin_contexts_differ_from_the_release_contexts() {
        let plugin = [MANIFEST_CONTEXT, CATALOG_CONTEXT, HANDOVER_CONTEXT];
        let release = [kalzit_release::MANIFEST_CONTEXT, kalzit_release::PACKAGE_CONTEXT];
        for p in plugin {
            for r in release {
                // Neither is a prefix of the other, so no message of one kind starts like the other.
                assert!(!p.starts_with(r) && !r.starts_with(p), "{p:?} and {r:?} overlap");
            }
            for q in plugin.iter().filter(|q| **q != p) {
                assert!(!p.starts_with(q), "{p:?} and {q:?} overlap");
            }
        }
    }

    /// A real signature made in one context verifies there and nowhere else.
    #[test]
    fn a_signature_verifies_only_in_its_own_context() {
        let k = key(7);
        let body = MANIFEST.as_bytes();
        let signature = k.sign(&manifest_message(body));
        assert!(verify_manifest(&k.verifying_key(), body, &signature));
        assert!(!verify_catalog(&k.verifying_key(), body, &signature));
        assert!(!verify_manifest(&key(8).verifying_key(), body, &signature));
        assert!(!verify_manifest(&k.verifying_key(), &[body, b" "].concat(), &signature));

        // A release manifest signature over the same bytes is no plugin signature, and back.
        let release = k.sign(&kalzit_release::manifest_message(body));
        assert!(!verify_manifest(&k.verifying_key(), body, &release));
        assert!(k.verifying_key().verify_strict(&kalzit_release::manifest_message(body), &signature).is_err());

        let h = HandOver {
            plugin_id: "dev.example.redis".into(),
            from: key_hex(&k.verifying_key()),
            to: key_hex(&key(9).verifying_key()),
            from_version: "2.0.0".into(),
        };
        let catalog = k.sign(&catalog_message(&handover_message(&h)[HANDOVER_CONTEXT.len()..]));
        assert!(!verify_handover(&k.verifying_key(), &h, &catalog));
        assert!(verify_handover(&k.verifying_key(), &h, &k.sign(&handover_message(&h))));
    }

    #[test]
    fn reserved_ids_need_kalzits_key() {
        let own = manifest("1.0.0", "io.kalzit.csv");
        assert_eq!(check_signer(&own, Signer::Kalzit), Ok(()));
        assert_eq!(check_signer(&own, Signer::Publisher), Err(Refusal::ReservedId));
        assert_eq!(check_signer(&own, Signer::Unsigned), Err(Refusal::ReservedId));
        assert_eq!(check_signer(&manifest("1.0.0", "dev.example.redis"), Signer::Unsigned), Ok(()));
    }

    #[test]
    fn updates_stay_with_the_key_and_never_go_back() {
        let (old, new, stranger) = (key(1), key(2), key(3));
        let installed_manifest = manifest("1.2.0", "dev.example.redis");
        let installed = Installed { manifest: &installed_manifest, key: Some(&old.verifying_key()), handovers: &[] };
        let next = manifest("1.3.0", "dev.example.redis");

        assert_eq!(check_update(&installed, &next, Some(&old.verifying_key())), Ok(()));
        assert_eq!(check_update(&installed, &next, Some(&new.verifying_key())), Err(Refusal::KeyChanged));
        assert_eq!(check_update(&installed, &next, None), Err(Refusal::KeyChanged));
        assert_eq!(
            check_update(&installed, &manifest("1.1.9", "dev.example.redis"), Some(&old.verifying_key())),
            Err(Refusal::Downgrade)
        );
        assert_eq!(
            check_update(&installed, &manifest("1.3.0", "dev.example.other"), Some(&old.verifying_key())),
            Err(Refusal::OtherPlugin)
        );

        // The old key hands the id over to the new one from 1.3.0 on; a stranger stays refused.
        let handovers = [handover("dev.example.redis", &old, &new, "1.3.0")];
        let rotated = Installed { handovers: &handovers, ..installed };
        assert_eq!(check_update(&rotated, &next, Some(&new.verifying_key())), Ok(()));
        assert_eq!(check_update(&rotated, &next, Some(&stranger.verifying_key())), Err(Refusal::KeyChanged));
        // Not for versions before the hand-over's minimum.
        let early = manifest("1.2.5", "dev.example.redis");
        assert_eq!(check_update(&rotated, &early, Some(&new.verifying_key())), Err(Refusal::KeyChanged));
        // A hand-over for another plugin does not count.
        let elsewhere = [handover("dev.example.other", &old, &new, "1.0.0")];
        let other = Installed { handovers: &elsewhere, ..rotated };
        assert_eq!(check_update(&other, &next, Some(&new.verifying_key())), Err(Refusal::KeyChanged));

        // An unsigned install may become signed.
        let unsigned = Installed { manifest: &installed_manifest, key: None, handovers: &[] };
        assert_eq!(check_update(&unsigned, &next, Some(&stranger.verifying_key())), Ok(()));
    }

    /// A verified hand-over from `from` to `to`.
    fn handover(plugin: &str, from: &SigningKey, to: &SigningKey, from_version: &str) -> HandOver {
        let h = HandOver {
            plugin_id: plugin.into(),
            from: key_hex(&from.verifying_key()),
            to: key_hex(&to.verifying_key()),
            from_version: from_version.into(),
        };
        assert!(verify_handover(&from.verifying_key(), &h, &from.sign(&handover_message(&h))));
        h
    }

    #[test]
    fn handover_chains_are_followed_in_any_order() {
        let (a, b, c) = (key(1), key(2), key(3));
        let installed_manifest = manifest("1.0.0", "dev.example.redis");
        let next = manifest("2.0.0", "dev.example.redis");
        // b to c is listed before a to b.
        let handovers =
            [handover("dev.example.redis", &b, &c, "1.0.0"), handover("dev.example.redis", &a, &b, "1.0.0")];
        let installed =
            Installed { manifest: &installed_manifest, key: Some(&a.verifying_key()), handovers: &handovers };
        assert_eq!(check_update(&installed, &next, Some(&c.verifying_key())), Ok(()));
    }

    /// Keys are compared in full: a hand-over naming the new key by its short id, or a key that
    /// shares its id but differs in its bytes, does not let it sign.
    #[test]
    fn keys_are_compared_by_all_their_bytes() {
        let (old, new) = (key(1), key(2));
        let installed_manifest = manifest("1.0.0", "dev.example.redis");
        let next = manifest("1.1.0", "dev.example.redis");
        let mut by_id = handover("dev.example.redis", &old, &new, "1.0.0");
        by_id.to = key_id(&new.verifying_key());
        assert!(!verify_handover(&old.verifying_key(), &by_id, &old.sign(&handover_message(&by_id))));
        let mut near = handover("dev.example.redis", &old, &new, "1.0.0");
        let mut bytes = new.verifying_key().to_bytes();
        bytes[31] ^= 1;
        near.to = hex::encode(bytes);
        for h in [by_id, near] {
            let handovers = [h];
            let installed =
                Installed { manifest: &installed_manifest, key: Some(&old.verifying_key()), handovers: &handovers };
            assert_eq!(check_update(&installed, &next, Some(&new.verifying_key())), Err(Refusal::KeyChanged));
        }
        // The signature covers the plugin, both keys and the version: changing any breaks it.
        let h = handover("dev.example.redis", &old, &new, "1.0.0");
        let signature = old.sign(&handover_message(&h));
        for changed in [
            HandOver { plugin_id: "dev.example.other".into(), ..h.clone() },
            HandOver { from_version: "0.1.0".into(), ..h.clone() },
            HandOver { to: key_hex(&key(5).verifying_key()), ..h.clone() },
        ] {
            assert!(!verify_handover(&old.verifying_key(), &changed, &signature));
        }
    }
}
