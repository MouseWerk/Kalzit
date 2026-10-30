//! One-time links: a random 256-bit token in the link, its SHA-256 in the database. Invitations
//! also keep the token encrypted while they are pending (`seal`), so an admin can copy the link
//! again; nothing else can turn a stored row back into a working link.

use base64::Engine;
use sha2::{Digest, Sha256};

use crate::secrets::{Blob, Keyring};

/// Characters of a token: 32 random bytes in unpadded base64url.
pub const TOKEN_CHARS: usize = 43;

pub fn new_token() -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(rand::random::<[u8; 32]>())
}

pub fn hash(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

/// Whether `raw` has the shape of a token; anything else is refused before a lookup.
pub fn is_token(raw: &str) -> bool {
    raw.len() == TOKEN_CHARS && raw.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn owner(invitation_id: &str) -> String {
    format!("invitation:{invitation_id}")
}

/// The field of a sealed invitation token (associated data next to the owner).
pub const TOKEN_FIELD: &str = "token";

pub fn seal(keyring: &Keyring, invitation_id: &str, token: &str) -> Blob {
    keyring.encrypt(&owner(invitation_id), TOKEN_FIELD, token)
}

pub fn unseal(keyring: &Keyring, invitation_id: &str, blob: &Blob) -> Option<zeroize::Zeroizing<String>> {
    keyring.decrypt(&owner(invitation_id), TOKEN_FIELD, blob).ok()
}

/// The owner a sealed token of `invitation_id` is bound to, for the rotation of the secrets key.
pub fn sealed_owner(invitation_id: &str) -> String {
    owner(invitation_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_are_random_and_have_their_shape() {
        let (a, b) = (new_token(), new_token());
        assert_ne!(a, b);
        assert!(is_token(&a) && is_token(&b));
        assert!(!is_token(&a[1..]) && !is_token(&format!("{}=", &a[1..])) && !is_token(""));
        assert_eq!(hash(&a).len(), 64);
        assert_ne!(hash(&a), hash(&b));
    }

    #[test]
    fn a_sealed_token_opens_only_for_its_invitation() {
        let ring = Keyring::from_key(crate::secrets::SecretKey::generate().0);
        let token = new_token();
        let blob = seal(&ring, "inv-1", &token);
        assert!(!blob.ciphertext.contains(&token));
        assert_eq!(unseal(&ring, "inv-1", &blob).as_deref().map(|s| s.as_str()), Some(token.as_str()));
        assert!(unseal(&ring, "inv-2", &blob).is_none());
    }
}
