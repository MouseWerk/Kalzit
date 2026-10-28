//! Known devices: after a successful sign-in the browser gets a device cookie for that account.
//! A sign-in that brings a valid one is not held to the account's shared budget of failures
//! (`routes::auth`), so an attacker who uses it up cannot lock the owner out of a browser they
//! signed in with before. The limits per address stay.
//!
//! The cookie is signed, not stored: `v2.<expiry>.<random>.<mac>`, the MAC an HMAC with the
//! signing key derived from the secrets key (`Keyring::sign`) over the user id, the expiry, the
//! random part and a fingerprint of the account's password hash. It does not name the account:
//! a sign-in names it by email, and only that account's MAC matches. A new password (changed by
//! the user or set by an admin) changes the hash and so revokes every device cookie of the
//! account; a new secrets key revokes all of them. A device cookie alone signs nobody in.

use axum::http::{HeaderMap, HeaderValue};
use sha2::{Digest, Sha256};

use crate::secrets::Keyring;

pub const COOKIE_NAME: &str = "kalzit_device";
/// The name over HTTPS (`session::SECURE_COOKIE_NAME` explains `__Host-`).
pub const SECURE_COOKIE_NAME: &str = "__Host-kalzit_device";
/// How long a device stays known after its last sign-in.
pub const LIFETIME_MS: i64 = 90 * 24 * 3_600_000;
const VERSION: &str = "v2";

fn signed_part(user_id: &str, expires_ms: i64, nonce: &str, password_hash: Option<&str>) -> Vec<u8> {
    let fingerprint = Sha256::digest(password_hash.unwrap_or_default().as_bytes());
    [
        b"kalzit-device\0".as_slice(),
        user_id.as_bytes(),
        b"\0",
        expires_ms.to_string().as_bytes(),
        b"\0",
        nonce.as_bytes(),
        b"\0",
        fingerprint.as_slice(),
    ]
    .concat()
}

/// A new device cookie value for the account, valid for `LIFETIME_MS`.
pub fn issue(keys: &Keyring, user_id: &str, password_hash: Option<&str>, now_ms: i64) -> String {
    let expires = now_ms + LIFETIME_MS;
    let nonce = hex::encode(rand::random::<[u8; 16]>());
    let mac = hex::encode(keys.sign(&signed_part(user_id, expires, &nonce, password_hash)));
    format!("{VERSION}.{expires}.{nonce}.{mac}")
}

/// Whether `value` is an unexpired device cookie of this account with its current password. The
/// account comes from the sign-in (its email), so the cookie need not name it.
pub fn is_known(keys: &Keyring, value: &str, user_id: &str, password_hash: Option<&str>, now_ms: i64) -> bool {
    let parts: Vec<&str> = value.split('.').collect();
    let [version, expires, nonce, mac] = parts[..] else { return false };
    let Ok(expires) = expires.parse::<i64>() else { return false };
    let Ok(mac) = hex::decode(mac) else { return false };
    version == VERSION && expires > now_ms && keys.verify(&signed_part(user_id, expires, nonce, password_hash), &mac)
}

fn cookie_name(secure: bool) -> &'static str {
    if secure { SECURE_COOKIE_NAME } else { COOKIE_NAME }
}

/// The device cookie of the request; with `secure` only the `__Host-` one counts.
pub fn read_cookie(headers: &HeaderMap, secure: bool) -> Option<String> {
    super::session::cookie_value(headers, cookie_name(secure))
}

pub fn set_cookie(value: &str, secure: bool) -> HeaderValue {
    let max_age = LIFETIME_MS / 1000;
    super::session::cookie_header(&format!("{}={value}; Max-Age={max_age}", cookie_name(secure)), secure)
}

/// Removes the device cookie: the browser is no longer a known device of any account.
pub fn clear_cookie(secure: bool) -> HeaderValue {
    super::session::cookie_header(&format!("{}=; Max-Age=0", cookie_name(secure)), secure)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secrets::SecretKey;

    #[test]
    fn a_device_cookie_holds_for_its_account_password_and_lifetime_only() {
        let keys = Keyring::from_key(SecretKey::generate().0);
        let cookie = issue(&keys, "u-1", Some("hash-1"), 0);
        assert!(is_known(&keys, &cookie, "u-1", Some("hash-1"), LIFETIME_MS - 1));
        assert!(!is_known(&keys, &cookie, "u-1", Some("hash-1"), LIFETIME_MS), "expired");
        assert!(!is_known(&keys, &cookie, "u-2", Some("hash-1"), 0), "another account");
        assert!(!is_known(&keys, &cookie, "u-1", Some("hash-2"), 0), "the password changed");
        assert!(!is_known(&Keyring::from_key(SecretKey::generate().0), &cookie, "u-1", Some("hash-1"), 0));
        let stretched = cookie.replacen(&LIFETIME_MS.to_string(), &(2 * LIFETIME_MS).to_string(), 1);
        assert!(!is_known(&keys, &stretched, "u-1", Some("hash-1"), 0), "a changed expiry");
        assert!(!cookie.contains("u-1"), "the cookie does not name the account");
        for broken in ["", "v2", "v2.x.y.z", "v2.1.ab.cd", "v1.u-1.1.ab.cd"] {
            assert!(!is_known(&keys, broken, "u-1", Some("hash-1"), 0), "{broken}");
        }
    }
}
