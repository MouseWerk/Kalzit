//! The ACME account and the issued certificate, as files in the data directory's `acme` folder,
//! encrypted with the secrets key (`secrets`) like data source passwords: AES-256-GCM, with the
//! file's purpose as associated data, so a file copied in place of another fails to decrypt.
//! `kalzit secrets rotate` re-encrypts them with the database (`reencrypt`).
//!
//! - `account-<hash>.enc`: the account key and URL for one directory (hash of its URL), so
//!   staging and production keep their own accounts;
//! - `certificate.enc`: the certificate chain, its private key and what it was issued for.

use std::fmt;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::secrets::{Blob, Keyring, SecretKey, encrypt_with};

pub const DIR: &str = "acme";
const OWNER: &str = "acme";
const CERTIFICATE_FILE: &str = "certificate.enc";
const CERTIFICATE_FIELD: &str = "certificate";
const EXTENSION: &str = "enc";
/// Larger files are not read: an account is under 1 KiB, a certificate chain a few KiB.
const MAX_FILE_BYTES: u64 = 256 * 1024;

/// One encrypted file. `field` is the associated data besides the owner, kept in clear so a
/// rotation can re-encrypt a file without knowing what it holds.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Envelope {
    field: String,
    key_id: String,
    nonce: String,
    ciphertext: String,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredCertificate {
    pub directory_url: String,
    pub domains: Vec<String>,
    /// The leaf first, then the intermediates, in PEM.
    pub chain_pem: String,
    pub key_pem: String,
    pub not_before_ms: i64,
    pub not_after_ms: i64,
    /// The issuer's common name (or its whole name when it has none).
    pub issuer: String,
    pub issued_at_ms: i64,
}

impl fmt::Debug for StoredCertificate {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("StoredCertificate")
            .field("directory_url", &self.directory_url)
            .field("domains", &self.domains)
            .field("not_after_ms", &self.not_after_ms)
            .field("issuer", &self.issuer)
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredAccount {
    pub directory_url: String,
    /// The contact the account was registered or last updated with (empty for none).
    pub contact: String,
    /// `instant_acme::AccountCredentials`: the account URL and its private key.
    pub credentials: serde_json::Value,
}

impl fmt::Debug for StoredAccount {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("StoredAccount").field("directory_url", &self.directory_url).finish_non_exhaustive()
    }
}

fn folder(data_dir: &Path) -> PathBuf {
    data_dir.join(DIR)
}

fn account_file(directory_url: &str) -> String {
    let hash = Sha256::digest(directory_url.as_bytes());
    format!("account-{}.{EXTENSION}", &hex::encode(hash)[..16])
}

fn account_field(directory_url: &str) -> String {
    format!("account:{directory_url}")
}

pub fn load_certificate(data_dir: &Path, keyring: &Keyring) -> Result<Option<StoredCertificate>> {
    read(&folder(data_dir).join(CERTIFICATE_FILE), CERTIFICATE_FIELD, keyring)
}

pub fn save_certificate(data_dir: &Path, keyring: &Keyring, certificate: &StoredCertificate) -> Result<()> {
    write(data_dir, CERTIFICATE_FILE, CERTIFICATE_FIELD, certificate, keyring.current_key())
}

pub fn load_account(data_dir: &Path, keyring: &Keyring, directory_url: &str) -> Result<Option<StoredAccount>> {
    let account: Option<StoredAccount> =
        read(&folder(data_dir).join(account_file(directory_url)), &account_field(directory_url), keyring)?;
    Ok(account.filter(|a| a.directory_url == directory_url))
}

pub fn save_account(data_dir: &Path, keyring: &Keyring, account: &StoredAccount) -> Result<()> {
    let url = &account.directory_url;
    write(data_dir, &account_file(url), &account_field(url), account, keyring.current_key())
}

/// Forgets the account of a directory (the CA no longer knows it); the next order makes a new one.
pub fn remove_account(data_dir: &Path, directory_url: &str) {
    let _ = std::fs::remove_file(folder(data_dir).join(account_file(directory_url)));
}

fn read<T: serde::de::DeserializeOwned>(path: &Path, field: &str, keyring: &Keyring) -> Result<Option<T>> {
    let meta = match std::fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e).with_context(|| format!("reading {}", path.display())),
    };
    if !meta.is_file() || meta.len() > MAX_FILE_BYTES {
        bail!("{} is not a regular file of at most {MAX_FILE_BYTES} bytes", path.display());
    }
    let text = std::fs::read(path).with_context(|| format!("reading {}", path.display()))?;
    let envelope: Envelope = serde_json::from_slice(&text).with_context(|| format!("{} is damaged", path.display()))?;
    if envelope.field != field {
        bail!("{} holds {}, not {field}", path.display(), envelope.field);
    }
    let blob = Blob { key_id: envelope.key_id, nonce: envelope.nonce, ciphertext: envelope.ciphertext };
    let plain = keyring
        .decrypt(OWNER, field, &blob)
        .map_err(|e| anyhow::anyhow!("{} cannot be decrypted: {e}", path.display()))?;
    let value = serde_json::from_str(&plain).with_context(|| format!("{} is damaged", path.display()))?;
    Ok(Some(value))
}

fn write<T: Serialize>(data_dir: &Path, name: &str, field: &str, value: &T, key: &SecretKey) -> Result<()> {
    let plain = zeroize::Zeroizing::new(serde_json::to_string(value)?);
    let blob = encrypt_with(key, OWNER, field, &plain);
    let envelope =
        Envelope { field: field.to_string(), key_id: blob.key_id, nonce: blob.nonce, ciphertext: blob.ciphertext };
    write_file(data_dir, name, &serde_json::to_vec(&envelope)?)
}

/// Writes next to the target and renames, so a crash leaves the old file or the new one.
fn write_file(data_dir: &Path, name: &str, bytes: &[u8]) -> Result<()> {
    use std::io::Write;
    let dir = folder(data_dir);
    create_folder(&dir)?;
    let target = dir.join(name);
    let temp = dir.join(format!("{name}.tmp"));
    let _ = std::fs::remove_file(&temp);
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temp).with_context(|| format!("writing {}", temp.display()))?;
    file.write_all(bytes)?;
    file.sync_all()?;
    drop(file);
    std::fs::rename(&temp, &target).with_context(|| format!("replacing {}", target.display()))?;
    Ok(())
}

/// The folder inside the private data directory; on Unix closed to everyone but the owner, on
/// Windows with the data directory's protected entries, which it inherits.
fn create_folder(dir: &Path) -> Result<()> {
    #[cfg(unix)]
    let builder = {
        use std::os::unix::fs::DirBuilderExt;
        let mut builder = std::fs::DirBuilder::new();
        builder.mode(0o700);
        builder
    };
    #[cfg(not(unix))]
    let builder = std::fs::DirBuilder::new();
    match builder.create(dir) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            let meta = std::fs::symlink_metadata(dir)?;
            if !meta.is_dir() {
                bail!("{} is not a folder", dir.display());
            }
            Ok(())
        }
        Err(e) => Err(e).with_context(|| format!("creating {}", dir.display())),
    }
}

/// Whether `name` is one of this folder's files: the certificate or an account. Names read from
/// the database are checked with it before they become paths.
fn is_store_file(name: &str) -> bool {
    if name == CERTIFICATE_FILE {
        return true;
    }
    name.strip_prefix("account-")
        .and_then(|rest| rest.strip_suffix(&format!(".{EXTENSION}")))
        .is_some_and(|hash| hash.len() == 16 && hash.bytes().all(|b| b.is_ascii_hexdigit()))
}

/// The folder's files as they are on disk (still encrypted), by name.
fn local_files(data_dir: &Path) -> Result<Vec<(String, Vec<u8>)>> {
    let dir = folder(data_dir);
    let entries = match std::fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e).with_context(|| format!("reading {}", dir.display())),
    };
    let mut files = Vec::new();
    for entry in entries {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if !is_store_file(&name) || !entry.file_type()?.is_file() || entry.metadata()?.len() > MAX_FILE_BYTES {
            continue;
        }
        files.push((name, std::fs::read(entry.path())?));
    }
    Ok(files)
}

/// Copies the account and certificate files into the database (`acme_shared`) for the other
/// servers on it (`cluster`). They stay encrypted with the secrets key, which all servers share.
pub async fn share(conn: &mut sqlx::AnyConnection, data_dir: &Path, now_ms: i64) -> Result<()> {
    let dir = data_dir.to_path_buf();
    let files = tokio::task::spawn_blocking(move || local_files(&dir)).await??;
    for (name, bytes) in files {
        let text = String::from_utf8(bytes).with_context(|| format!("{name} is damaged"))?;
        sqlx::query(
            "INSERT INTO acme_shared (name, envelope, updated_at) VALUES ($1, $2, $3) \
             ON CONFLICT (name) DO UPDATE SET envelope = excluded.envelope, updated_at = excluded.updated_at",
        )
        .bind(&name)
        .bind(&text)
        .bind(now_ms)
        .execute(&mut *conn)
        .await?;
    }
    Ok(())
}

/// Writes the files another server shared (`share`) where they differ from this server's; the
/// database's copy wins. Answers whether a file changed.
pub async fn pull(db: &sqlx::AnyPool, data_dir: &Path) -> Result<bool> {
    let rows: Vec<(String, String)> = sqlx::query_as("SELECT name, envelope FROM acme_shared").fetch_all(db).await?;
    if rows.is_empty() {
        return Ok(false);
    }
    let dir = data_dir.to_path_buf();
    tokio::task::spawn_blocking(move || {
        let mut changed = false;
        for (name, envelope) in rows {
            // Never a path from the database: only the folder's own names, and only what parses.
            if !is_store_file(&name) || serde_json::from_str::<Envelope>(&envelope).is_err() {
                tracing::warn!("ignoring the shared ACME file {name:?}: not a certificate or account file");
                continue;
            }
            let local = std::fs::read(folder(&dir).join(&name)).ok();
            if local.as_deref() != Some(envelope.as_bytes()) {
                write_file(&dir, &name, envelope.as_bytes())?;
                changed = true;
            }
        }
        Ok(changed)
    })
    .await?
}

/// Re-encrypts the shared copies (`share`) not yet under `new`, like the files
/// (`kalzit secrets rotate`).
pub async fn reencrypt_shared(db: &sqlx::AnyPool, keyring: &Keyring, new: &SecretKey) -> Result<usize> {
    let rows: Vec<(String, String)> = sqlx::query_as("SELECT name, envelope FROM acme_shared").fetch_all(db).await?;
    let mut count = 0;
    for (name, text) in rows {
        let envelope: Envelope = serde_json::from_str(&text)
            .with_context(|| format!("the shared ACME file {name} is damaged; nothing was changed there"))?;
        if envelope.key_id == new.id() {
            continue;
        }
        let field = envelope.field.clone();
        let blob = Blob { key_id: envelope.key_id, nonce: envelope.nonce, ciphertext: envelope.ciphertext };
        let plain = keyring
            .decrypt(OWNER, &field, &blob)
            .map_err(|e| anyhow::anyhow!("the shared ACME file {name} cannot be decrypted: {e}"))?;
        let fresh = encrypt_with(new, OWNER, &field, &plain);
        let envelope = Envelope { field, key_id: fresh.key_id, nonce: fresh.nonce, ciphertext: fresh.ciphertext };
        sqlx::query("UPDATE acme_shared SET envelope = $1 WHERE name = $2")
            .bind(serde_json::to_string(&envelope)?)
            .bind(&name)
            .execute(db)
            .await?;
        count += 1;
    }
    Ok(count)
}

/// Re-encrypts every file not yet under `new` (`kalzit secrets rotate`). A file that cannot be
/// decrypted stops the rotation, like a blob in the database.
pub fn reencrypt(data_dir: &Path, keyring: &Keyring, new: &SecretKey) -> Result<usize> {
    let dir = folder(data_dir);
    let entries = match std::fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(e) => return Err(e).with_context(|| format!("reading {}", dir.display())),
    };
    let mut count = 0;
    for entry in entries {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.ends_with(&format!(".{EXTENSION}")) || !entry.file_type()?.is_file() {
            continue;
        }
        let path = entry.path();
        let envelope: Envelope = serde_json::from_slice(&std::fs::read(&path)?)
            .with_context(|| format!("{} is damaged; nothing was changed there", path.display()))?;
        if envelope.key_id == new.id() {
            continue;
        }
        let field = envelope.field.clone();
        let blob = Blob { key_id: envelope.key_id, nonce: envelope.nonce, ciphertext: envelope.ciphertext };
        let plain = keyring
            .decrypt(OWNER, &field, &blob)
            .map_err(|e| anyhow::anyhow!("{} cannot be decrypted: {e}", path.display()))?;
        let fresh = encrypt_with(new, OWNER, &field, &plain);
        let envelope = Envelope { field, key_id: fresh.key_id, nonce: fresh.nonce, ciphertext: fresh.ciphertext };
        write_file(data_dir, &name, &serde_json::to_vec(&envelope)?)?;
        count += 1;
    }
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keyring(byte: u8) -> Keyring {
        Keyring::from_key(SecretKey::from_bytes(&[byte; 32]).unwrap())
    }

    fn certificate() -> StoredCertificate {
        StoredCertificate {
            directory_url: "https://ca.example/dir".into(),
            domains: vec!["kalzit.example.com".into()],
            chain_pem: "chain".into(),
            key_pem: "-----BEGIN PRIVATE KEY-----secret".into(),
            not_before_ms: 1,
            not_after_ms: 2,
            issuer: "Test CA".into(),
            issued_at_ms: 1,
        }
    }

    #[test]
    fn files_are_encrypted_and_bound_to_their_purpose() {
        let dir = tempfile::tempdir().unwrap();
        let ring = keyring(1);
        assert!(load_certificate(dir.path(), &ring).unwrap().is_none());
        save_certificate(dir.path(), &ring, &certificate()).unwrap();
        let raw = std::fs::read_to_string(dir.path().join(DIR).join(CERTIFICATE_FILE)).unwrap();
        assert!(!raw.contains("secret") && !raw.contains("kalzit.example.com"), "{raw}");
        assert_eq!(load_certificate(dir.path(), &ring).unwrap(), Some(certificate()));
        assert!(!format!("{:?}", certificate()).contains("secret"));
        // Another key cannot read it.
        assert!(load_certificate(dir.path(), &keyring(2)).is_err());

        let account = StoredAccount {
            directory_url: "https://ca.example/dir".into(),
            contact: String::new(),
            credentials: serde_json::json!({ "id": "x" }),
        };
        save_account(dir.path(), &ring, &account).unwrap();
        assert!(load_account(dir.path(), &ring, "https://ca.example/dir").unwrap().is_some());
        assert!(load_account(dir.path(), &ring, "https://other.example/dir").unwrap().is_none());
        // An account file put in the certificate's place does not pass for a certificate.
        let folder = dir.path().join(DIR);
        std::fs::copy(folder.join(account_file("https://ca.example/dir")), folder.join(CERTIFICATE_FILE)).unwrap();
        assert!(load_certificate(dir.path(), &ring).is_err());
        remove_account(dir.path(), "https://ca.example/dir");
        assert!(load_account(dir.path(), &ring, "https://ca.example/dir").unwrap().is_none());
    }

    #[cfg(unix)]
    #[test]
    fn files_are_private() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        save_certificate(dir.path(), &keyring(1), &certificate()).unwrap();
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&dir.path().join(DIR)), 0o700);
        assert_eq!(mode(&dir.path().join(DIR).join(CERTIFICATE_FILE)), 0o600);
    }

    #[test]
    fn rotation_moves_every_file_to_the_new_key() {
        let dir = tempfile::tempdir().unwrap();
        let old = keyring(1);
        save_certificate(dir.path(), &old, &certificate()).unwrap();
        let new = SecretKey::from_bytes(&[2; 32]).unwrap();
        assert_eq!(reencrypt(dir.path(), &old, &new).unwrap(), 1);
        assert_eq!(reencrypt(dir.path(), &old, &new).unwrap(), 0, "nothing left to move");
        assert_eq!(load_certificate(dir.path(), &keyring(2)).unwrap(), Some(certificate()));
        assert_eq!(reencrypt(tempfile::tempdir().unwrap().path(), &old, &new).unwrap(), 0);
    }
}
