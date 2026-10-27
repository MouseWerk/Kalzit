//! What plugin signatures cover. Plugins are signed with Ed25519 like releases, but in their own
//! context: every signed message starts with a context line no release message starts with, so
//! a release signature never verifies as a plugin signature or the other way round. Plugin keys
//! are separate from the release keys too: Kalzit's own plugin key and the publisher keys an
//! administrator adds; the release keys are never trusted for plugins.

/// The context line of a plugin manifest signature.
pub const MANIFEST_CONTEXT: &[u8] = b"kalzit-plugin-manifest-v1\n";

/// The context line of a catalog index signature.
pub const CATALOG_CONTEXT: &[u8] = b"kalzit-plugin-catalog-v1\n";

/// What a plugin signature covers: the context line, then the manifest's exact bytes. The
/// manifest pins every binary and file by SHA-256, so the signature covers them as well.
pub fn manifest_message(manifest: &[u8]) -> Vec<u8> {
    let mut message = MANIFEST_CONTEXT.to_vec();
    message.extend_from_slice(manifest);
    message
}

/// What a catalog signature covers: the context line, then the index's exact bytes.
pub fn catalog_message(index: &[u8]) -> Vec<u8> {
    let mut message = CATALOG_CONTEXT.to_vec();
    message.extend_from_slice(index);
    message
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plugin_contexts_differ_from_the_release_contexts() {
        let plugin = [MANIFEST_CONTEXT, CATALOG_CONTEXT];
        let release = [kalzit_release::MANIFEST_CONTEXT, kalzit_release::PACKAGE_CONTEXT];
        for p in plugin {
            for r in release {
                // Neither is a prefix of the other, so no message of one kind starts like the other.
                assert!(!p.starts_with(r) && !r.starts_with(p), "{p:?} and {r:?} overlap");
            }
        }
        assert!(!MANIFEST_CONTEXT.starts_with(CATALOG_CONTEXT) && !CATALOG_CONTEXT.starts_with(MANIFEST_CONTEXT));
    }

    #[test]
    fn the_message_is_the_context_and_the_exact_bytes() {
        let manifest = b"manifest = 1\n";
        let message = manifest_message(manifest);
        assert!(message.starts_with(MANIFEST_CONTEXT));
        assert_eq!(&message[MANIFEST_CONTEXT.len()..], manifest);
        assert_ne!(catalog_message(manifest), message);
    }
}
