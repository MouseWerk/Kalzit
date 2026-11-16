//! Encrypted backup files: the zip, cut into chunks of 1 MiB, each sealed with AES-256-GCM under
//! a random data key; the data key is sealed with the secrets key (`Keyring`), so restoring needs
//! the secrets key the backup was taken with (or a later one that still knows it).
//!
//! Layout: `KALZITBK1\n`, a 4-byte big-endian length and a JSON header (`keyId`, `nonce` and
//! `ciphertext` of the sealed data key, `prefix` of the chunk nonces in hex, `chunk`), then per
//! chunk a 4-byte length and its ciphertext. A chunk's nonce is the 4-byte prefix and its 8-byte
//! number; its associated data says whether it is the last one, so a cut file never decrypts.

use std::io::{self, Read, Write};

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::secrets::{Blob, Keyring};

pub const MAGIC: &[u8] = b"KALZITBK1\n";
const CHUNK: usize = 1024 * 1024;
const MAX_HEADER: u32 = 64 * 1024;
/// The data key's owner and field for the secrets key's associated data.
const OWNER: &str = "backup";
const FIELD: &str = "archive";

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Header {
    key_id: String,
    nonce: String,
    ciphertext: String,
    prefix: String,
    chunk: usize,
}

fn aad(number: u64, last: bool) -> Vec<u8> {
    let mut aad = b"kalzit-backup".to_vec();
    aad.extend_from_slice(&number.to_be_bytes());
    aad.push(u8::from(last));
    aad
}

fn nonce(prefix: &[u8; 4], number: u64) -> [u8; 12] {
    let mut bytes = [0u8; 12];
    bytes[..4].copy_from_slice(prefix);
    bytes[4..].copy_from_slice(&number.to_be_bytes());
    bytes
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.to_string())
}

/// Reads up to `buf.len()` bytes, fewer only at the end.
fn fill(input: &mut impl Read, buf: &mut [u8]) -> io::Result<usize> {
    let mut filled = 0;
    while filled < buf.len() {
        let n = input.read(&mut buf[filled..])?;
        if n == 0 {
            break;
        }
        filled += n;
    }
    Ok(filled)
}

/// Encrypts `input` into `output`.
pub fn encrypt(keyring: &Keyring, input: &mut impl Read, output: &mut impl Write) -> io::Result<()> {
    let key = Zeroizing::new(rand::random::<[u8; 32]>());
    let prefix: [u8; 4] = rand::random();
    let sealed = keyring.encrypt(OWNER, FIELD, &hex::encode(*key));
    let header = Header {
        key_id: sealed.key_id,
        nonce: sealed.nonce,
        ciphertext: sealed.ciphertext,
        prefix: hex::encode(prefix),
        chunk: CHUNK,
    };
    let header = serde_json::to_vec(&header).map_err(io::Error::other)?;
    output.write_all(MAGIC)?;
    output.write_all(&(header.len() as u32).to_be_bytes())?;
    output.write_all(&header)?;
    let cipher = Aes256Gcm::new_from_slice(&*key).map_err(|_| invalid("the data key has the wrong length"))?;
    let mut current = vec![0u8; CHUNK];
    let mut next = vec![0u8; CHUNK];
    let mut len = fill(input, &mut current)?;
    let mut number = 0u64;
    loop {
        // The chunk is the last one when nothing follows it.
        let next_len = if len == CHUNK { fill(input, &mut next)? } else { 0 };
        let last = next_len == 0;
        let sealed = cipher
            .encrypt(&Nonce::from(nonce(&prefix, number)), Payload { msg: &current[..len], aad: &aad(number, last) })
            .map_err(|_| invalid("encrypting a chunk failed"))?;
        output.write_all(&(sealed.len() as u32).to_be_bytes())?;
        output.write_all(&sealed)?;
        if last {
            return Ok(());
        }
        std::mem::swap(&mut current, &mut next);
        len = next_len;
        number += 1;
    }
}

/// Whether `head` (the first bytes of a file) starts an encrypted backup.
pub fn is_encrypted(head: &[u8]) -> bool {
    head.starts_with(MAGIC)
}

/// Decrypts `input` (after its magic) into `output`. Fails for another key, a changed or a cut
/// file.
pub fn decrypt(keyring: &Keyring, input: &mut impl Read, output: &mut impl Write) -> io::Result<()> {
    let mut magic = [0u8; 10];
    input.read_exact(&mut magic)?;
    if magic != MAGIC {
        return Err(invalid("not an encrypted Kalzit backup"));
    }
    let mut len = [0u8; 4];
    input.read_exact(&mut len)?;
    let header_len = u32::from_be_bytes(len);
    if header_len > MAX_HEADER {
        return Err(invalid("the backup's header is too large"));
    }
    let mut header = vec![0u8; header_len as usize];
    input.read_exact(&mut header)?;
    let header: Header = serde_json::from_slice(&header).map_err(|_| invalid("the backup's header cannot be read"))?;
    let blob = Blob { key_id: header.key_id, nonce: header.nonce, ciphertext: header.ciphertext };
    let key_hex = keyring.decrypt(OWNER, FIELD, &blob).map_err(|e| {
        invalid(&format!(
            "the backup's key cannot be opened with this secrets key ({e}); use the key the backup was taken with"
        ))
    })?;
    let key = Zeroizing::new(hex::decode(key_hex.as_bytes()).map_err(|_| invalid("the backup's key is damaged"))?);
    let prefix: [u8; 4] = hex::decode(&header.prefix)
        .ok()
        .and_then(|p| p.try_into().ok())
        .ok_or_else(|| invalid("the backup's header is damaged"))?;
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| invalid("the backup's key is damaged"))?;
    let max = header.chunk.min(CHUNK) + 16;
    let mut number = 0u64;
    loop {
        let mut len = [0u8; 4];
        if fill(input, &mut len)? < 4 {
            return Err(invalid("the backup file is cut short"));
        }
        let len = u32::from_be_bytes(len) as usize;
        if len > max {
            return Err(invalid("a chunk of the backup is too large"));
        }
        let mut sealed = vec![0u8; len];
        input.read_exact(&mut sealed)?;
        let open = |last: bool| {
            cipher.decrypt(&Nonce::from(nonce(&prefix, number)), Payload { msg: &sealed, aad: &aad(number, last) })
        };
        let (plain, last) = match open(false) {
            Ok(plain) => (plain, false),
            Err(_) => (open(true).map_err(|_| invalid("the backup file was changed or is damaged"))?, true),
        };
        output.write_all(&plain)?;
        if last {
            let mut rest = [0u8; 1];
            if input.read(&mut rest)? != 0 {
                return Err(invalid("the backup file has data after its end"));
            }
            return Ok(());
        }
        number += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ring() -> Keyring {
        Keyring::from_key(crate::secrets::SecretKey::generate().0)
    }

    #[test]
    fn a_backup_round_trips_and_needs_its_key() {
        let ring = ring();
        for size in [0, 10, CHUNK, CHUNK + 1, 2 * CHUNK + 5] {
            let data: Vec<u8> = (0..size).map(|i| (i % 251) as u8).collect();
            let mut sealed = Vec::new();
            encrypt(&ring, &mut data.as_slice(), &mut sealed).unwrap();
            assert!(is_encrypted(&sealed));
            let mut opened = Vec::new();
            decrypt(&ring, &mut sealed.as_slice(), &mut opened).unwrap();
            assert_eq!(opened, data, "{size}");
            let mut other = Vec::new();
            assert!(decrypt(&self::ring(), &mut sealed.as_slice(), &mut other).is_err());
        }
    }

    #[test]
    fn a_cut_or_changed_backup_is_refused() {
        let ring = ring();
        let data = vec![7u8; CHUNK + 100];
        let mut sealed = Vec::new();
        encrypt(&ring, &mut data.as_slice(), &mut sealed).unwrap();
        // Without its last chunk: the first one is not marked last.
        let first_end = sealed.len() - (100 + 16 + 4);
        assert!(decrypt(&ring, &mut &sealed[..first_end], &mut Vec::new()).is_err());
        let mut changed = sealed.clone();
        let at = changed.len() - 1;
        changed[at] ^= 1;
        assert!(decrypt(&ring, &mut changed.as_slice(), &mut Vec::new()).is_err());
        let mut longer = sealed.clone();
        longer.push(0);
        assert!(decrypt(&ring, &mut longer.as_slice(), &mut Vec::new()).is_err());
    }
}
