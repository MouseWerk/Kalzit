//! Encrypted secrets: passwords, tokens and keys of data sources and AI providers (whose owner in
//! the associated data is `ai-provider:<id>`, so it never matches a data source). Each value is encrypted with
//! AES-256-GCM under a random 96-bit nonce, with the data source id and field name as associated
//! data, so a blob copied to another source or field fails to decrypt. Each blob records the id
//! of the key that encrypted it. The ACME account and certificates are encrypted the same way, as
//! files in the data directory's `acme` folder (`acme::store`), with `acme` as their owner.
//!
//! The key (32 random bytes) comes from, in this order: `KALZIT_SECRETS_KEY` (base64), the systemd
//! credential `kalzit-secrets-key` (Linux), a key file protected with DPAPI in machine scope
//! (Windows), and as a last resort `secrets.key` with mode 0600 in the data directory, with a
//! warning in the log. Database backups need the key; without it the secrets are lost and must be
//! entered again. `kalzit secrets rotate` re-encrypts every blob with a new key.

use std::collections::BTreeMap;
use std::fmt;
use std::path::{Path, PathBuf};

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use anyhow::{Context, Result, bail};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::config::Config;
#[cfg(windows)]
use crate::data_dir::acl;

pub const KEY_ENV: &str = "KALZIT_SECRETS_KEY";
/// The new key for `kalzit secrets rotate` when the current one comes from the environment or a
/// systemd credential, which Kalzit cannot replace itself.
pub const NEW_KEY_ENV: &str = "KALZIT_SECRETS_NEW_KEY";
/// The previous key, readable next to an external key: the server decrypts with both, and
/// `kalzit secrets rotate` moves every blob from it to the current key.
pub const OLD_KEY_ENV: &str = "KALZIT_SECRETS_OLD_KEY";
/// Held shared by every running server and exclusively by `kalzit secrets rotate`, so a rotation
/// never runs while a server could still encrypt with the old key.
pub const LOCK_FILE: &str = "secrets.lock";
const SYSTEMD_CREDENTIAL: &str = "kalzit-secrets-key";
pub const KEY_FILE: &str = "secrets.key";
#[cfg(windows)]
pub const DPAPI_KEY_FILE: &str = "secrets.key.dpapi";
/// A key written by an interrupted rotation. While it exists, both keys are loaded, so blobs
/// already re-encrypted stay readable and the next `rotate` run resumes with the same key.
const PENDING_SUFFIX: &str = ".next";
const KEY_BYTES: usize = 32;
/// Versioned prefix of the associated data, so a future format cannot be confused with this one.
const AAD_PREFIX: &[u8] = b"kalzit:datasource-secret:v1\0";

/// One AES-256 key and its id (a SHA-256 fingerprint, never the key itself).
pub struct SecretKey {
    id: String,
    cipher: Aes256Gcm,
    /// A key derived for signing (`Keyring::sign`), never used for encryption.
    signing: Zeroizing<[u8; 32]>,
}

impl fmt::Debug for SecretKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SecretKey").field("id", &self.id).finish_non_exhaustive()
    }
}

impl SecretKey {
    pub fn from_bytes(bytes: &[u8]) -> Result<Self> {
        if bytes.len() != KEY_BYTES {
            bail!("the secrets key must be {KEY_BYTES} bytes, not {}", bytes.len());
        }
        let digest = Sha256::new().chain_update(b"kalzit secrets key id\0").chain_update(bytes).finalize();
        let cipher = Aes256Gcm::new_from_slice(bytes).map_err(|_| anyhow::anyhow!("invalid key length"))?;
        let signing =
            Zeroizing::new(Sha256::new().chain_update(b"kalzit signing key\0").chain_update(bytes).finalize().into());
        Ok(Self { id: hex::encode(&digest[..8]), cipher, signing })
    }

    /// A new random key; the raw bytes are returned for storing and wiped when dropped.
    pub fn generate() -> (Self, Zeroizing<Vec<u8>>) {
        let raw = Zeroizing::new(rand::random::<[u8; KEY_BYTES]>().to_vec());
        let key = Self::from_bytes(&raw).expect("generated keys have the right length");
        (key, raw)
    }

    fn from_base64(text: &str) -> Result<(Self, Zeroizing<Vec<u8>>)> {
        let raw = Zeroizing::new(BASE64.decode(text.trim()).context("the secrets key is not valid base64")?);
        Ok((Self::from_bytes(&raw)?, raw))
    }

    pub fn id(&self) -> &str {
        &self.id
    }
}

/// Where the current key came from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeySource {
    Environment,
    SystemdCredential,
    Dpapi,
    File,
}

impl fmt::Display for KeySource {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            KeySource::Environment => KEY_ENV,
            KeySource::SystemdCredential => "the systemd credential kalzit-secrets-key",
            KeySource::Dpapi => "the DPAPI-protected key file",
            KeySource::File => "the key file",
        })
    }
}

/// An encrypted value as stored in `datasource_secrets`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Blob {
    pub key_id: String,
    pub nonce: String,
    pub ciphertext: String,
}

#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum SecretError {
    #[error("encrypted with key {0}, which is not loaded")]
    UnknownKey(String),
    #[error("cannot be decrypted (damaged, or stored for another data source or field)")]
    Undecryptable,
}

/// The current key, plus a pending one while a rotation is unfinished (or the old external key).
pub struct Keyring {
    current: SecretKey,
    others: Vec<SecretKey>,
    source: KeySource,
    /// The server's shared hold on `LOCK_FILE`, kept for the keyring's lifetime.
    _lock: Option<std::fs::File>,
}

impl fmt::Debug for Keyring {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Keyring").field("current", &self.current.id).field("source", &self.source).finish()
    }
}

impl Keyring {
    /// The server's keyring: holds the rotation lock shared, and creates the key file on first
    /// start, but only while no secret is stored (a missing key with stored secrets is an error,
    /// not a reason to start over with a new key).
    pub async fn load_for_server(data_dir: &Path, db: &sqlx::AnyPool) -> Result<Self> {
        let lock = open_lock(data_dir)?;
        match lock.try_lock_shared() {
            Ok(()) => {}
            Err(std::fs::TryLockError::WouldBlock) => {
                bail!("`kalzit secrets rotate` is running; start the server when it is done")
            }
            Err(std::fs::TryLockError::Error(e)) => return Err(e).context("locking the secrets key"),
        }
        let (stored,): (i64,) = sqlx::query_as(
            "SELECT (SELECT COUNT(*) FROM datasource_secrets) + (SELECT COUNT(*) FROM ai_provider_secrets)",
        )
        .fetch_one(db)
        .await?;
        let mut ring = Self::load_env(data_dir, stored == 0)?;
        ring._lock = Some(lock);
        let known: Vec<String> = std::iter::once(&ring.current).chain(&ring.others).map(|k| k.id.clone()).collect();
        let ids: Vec<(String,)> =
            sqlx::query_as("SELECT key_id FROM datasource_secrets UNION SELECT key_id FROM ai_provider_secrets")
                .fetch_all(db)
                .await?;
        let foreign: Vec<&str> =
            ids.iter().map(|(id,)| id.as_str()).filter(|id| !known.iter().any(|k| k == id)).collect();
        if !foreign.is_empty() {
            tracing::warn!(
                "stored secrets use keys {foreign:?}, which are not loaded (current key {}); those data sources \
                 fail until their secrets are entered again or the old key is set as {OLD_KEY_ENV}",
                ring.current.id
            );
        }
        Ok(ring)
    }

    /// Loads the key from the first source that has one. A key file is created only when
    /// `may_create`; `kalzit secrets rotate` never creates one.
    pub fn load(data_dir: &Path) -> Result<Self> {
        Self::load_env(data_dir, false)
    }

    fn load_env(data_dir: &Path, may_create: bool) -> Result<Self> {
        let var = |name: &str| std::env::var(name).ok().filter(|v| !v.trim().is_empty());
        let credentials = std::env::var_os("CREDENTIALS_DIRECTORY").map(PathBuf::from);
        let env_key = var(KEY_ENV).map(Zeroizing::new);
        let old_key = var(OLD_KEY_ENV).map(Zeroizing::new);
        Self::load_from(
            env_key.as_deref().map(String::as_str),
            old_key.as_deref().map(String::as_str),
            credentials.as_deref(),
            data_dir,
            may_create,
        )
    }

    fn load_from(
        env_key: Option<&str>,
        old_key: Option<&str>,
        credentials_dir: Option<&Path>,
        data_dir: &Path,
        may_create: bool,
    ) -> Result<Self> {
        let mut ring = Self::load_current(env_key, credentials_dir, data_dir, may_create)?;
        if let Some(text) = old_key {
            if !matches!(ring.source, KeySource::Environment | KeySource::SystemdCredential) {
                bail!("{OLD_KEY_ENV} is only used next to {KEY_ENV} or a systemd credential");
            }
            let (old, _) = SecretKey::from_base64(text).with_context(|| format!("reading {OLD_KEY_ENV}"))?;
            if old.id != ring.current.id {
                ring.others.push(old);
            }
        }
        Ok(ring)
    }

    fn load_current(
        env_key: Option<&str>,
        credentials_dir: Option<&Path>,
        data_dir: &Path,
        may_create: bool,
    ) -> Result<Self> {
        if let Some(text) = env_key {
            let (key, _) = SecretKey::from_base64(text).with_context(|| format!("reading {KEY_ENV}"))?;
            return Ok(Self { current: key, others: Vec::new(), source: KeySource::Environment, _lock: None });
        }
        if let Some(path) = credentials_dir.map(|d| d.join(SYSTEMD_CREDENTIAL)).filter(|p| p.is_file()) {
            let raw = Zeroizing::new(std::fs::read(&path).with_context(|| format!("reading {}", path.display()))?);
            // `systemd-creds encrypt` keeps the bytes as given: accept raw key bytes or base64.
            let key = if raw.len() == KEY_BYTES {
                SecretKey::from_bytes(&raw)?
            } else {
                let text =
                    std::str::from_utf8(&raw).context("the systemd credential is neither 32 bytes nor base64")?;
                SecretKey::from_base64(text)?.0
            };
            return Ok(Self { current: key, others: Vec::new(), source: KeySource::SystemdCredential, _lock: None });
        }
        let store = KeyFile::for_data_dir(data_dir)?;
        let current = match store.read(&store.path)? {
            Some(key) => key,
            None if !may_create => bail!(
                "no secrets key at {} although data source secrets are stored; restore the key file \
                 (database backups need it) or set {KEY_ENV}",
                store.path.display()
            ),
            None => {
                let (key, raw) = SecretKey::generate();
                store.write(&store.path, &raw)?;
                tracing::info!("created a new secrets key in {}", store.path.display());
                key
            }
        };
        if store.source == KeySource::File {
            tracing::warn!(
                "the secrets key is stored without OS protection in {}; set {KEY_ENV} or use a systemd \
                 credential (kalzit-secrets-key) instead",
                store.path.display()
            );
        }
        let mut others = Vec::new();
        if let Some(pending) = store.read(&store.pending_path())? {
            tracing::warn!("an earlier `kalzit secrets rotate` did not finish; run it again to complete it");
            others.push(pending);
        }
        Ok(Self { current, others, source: store.source, _lock: None })
    }

    /// A keyring with just this key, for tests and tools.
    pub fn from_key(key: SecretKey) -> Self {
        Self { current: key, others: Vec::new(), source: KeySource::Environment, _lock: None }
    }

    pub fn current_id(&self) -> &str {
        &self.current.id
    }

    /// The key new values are encrypted with.
    pub(crate) fn current_key(&self) -> &SecretKey {
        &self.current
    }

    pub fn source(&self) -> KeySource {
        self.source
    }

    fn key(&self, id: &str) -> Option<&SecretKey> {
        std::iter::once(&self.current).chain(&self.others).find(|k| k.id == id)
    }

    pub fn encrypt(&self, datasource_id: &str, field: &str, plaintext: &str) -> Blob {
        encrypt_with(&self.current, datasource_id, field, plaintext)
    }

    pub fn decrypt(&self, datasource_id: &str, field: &str, blob: &Blob) -> Result<Zeroizing<String>, SecretError> {
        let key = self.key(&blob.key_id).ok_or_else(|| SecretError::UnknownKey(blob.key_id.clone()))?;
        decrypt_with(key, datasource_id, field, blob)
    }

    /// HMAC-SHA256 of `data` with the signing key derived from the current key.
    pub fn sign(&self, data: &[u8]) -> [u8; 32] {
        hmac_sha256(&self.current.signing, data)
    }

    /// Whether `mac` signs `data` with any loaded key (also one pending in a rotation), compared
    /// in time that does not depend on where they differ.
    pub fn verify(&self, data: &[u8], mac: &[u8]) -> bool {
        use subtle::ConstantTimeEq;
        std::iter::once(&self.current).chain(&self.others).any(|k| hmac_sha256(&k.signing, data)[..].ct_eq(mac).into())
    }
}

/// HMAC (RFC 2104) with SHA-256 and a 32-byte key.
fn hmac_sha256(key: &[u8; 32], data: &[u8]) -> [u8; 32] {
    let mut inner_pad = [0x36u8; 64];
    let mut outer_pad = [0x5cu8; 64];
    for (i, b) in key.iter().enumerate() {
        inner_pad[i] ^= b;
        outer_pad[i] ^= b;
    }
    let inner = Sha256::new().chain_update(inner_pad).chain_update(data).finalize();
    Sha256::new().chain_update(outer_pad).chain_update(inner).finalize().into()
}

fn aad(datasource_id: &str, field: &str) -> Vec<u8> {
    [AAD_PREFIX, datasource_id.as_bytes(), b"\0", field.as_bytes()].concat()
}

pub(crate) fn encrypt_with(key: &SecretKey, datasource_id: &str, field: &str, plaintext: &str) -> Blob {
    let nonce_bytes: [u8; 12] = rand::random();
    let nonce = Nonce::from(nonce_bytes);
    let aad = aad(datasource_id, field);
    let ciphertext = key
        .cipher
        .encrypt(&nonce, Payload { msg: plaintext.as_bytes(), aad: &aad })
        .expect("AES-GCM encryption of a short value cannot fail");
    Blob { key_id: key.id.clone(), nonce: BASE64.encode(nonce_bytes), ciphertext: BASE64.encode(ciphertext) }
}

fn decrypt_with(
    key: &SecretKey,
    datasource_id: &str,
    field: &str,
    blob: &Blob,
) -> Result<Zeroizing<String>, SecretError> {
    let nonce: [u8; 12] =
        BASE64.decode(&blob.nonce).ok().and_then(|n| n.try_into().ok()).ok_or(SecretError::Undecryptable)?;
    let ciphertext = BASE64.decode(&blob.ciphertext).map_err(|_| SecretError::Undecryptable)?;
    let aad = aad(datasource_id, field);
    let plain = key
        .cipher
        .decrypt(&Nonce::from(nonce), Payload { msg: &ciphertext, aad: &aad })
        .map_err(|_| SecretError::Undecryptable)?;
    String::from_utf8(plain).map(Zeroizing::new).map_err(|_| SecretError::Undecryptable)
}

/// The key file in the data directory: DPAPI-protected on Windows when DPAPI works, otherwise
/// plain base64 with mode 0600.
struct KeyFile {
    path: PathBuf,
    source: KeySource,
}

impl KeyFile {
    fn for_data_dir(data_dir: &Path) -> Result<Self> {
        std::fs::create_dir_all(data_dir).with_context(|| format!("creating {}", data_dir.display()))?;
        let plain = data_dir.join(KEY_FILE);
        #[cfg(windows)]
        {
            let protected = data_dir.join(DPAPI_KEY_FILE);
            // An existing plain file keeps being used: switching would orphan every stored blob.
            if protected.exists() || !plain.exists() {
                match dpapi::protect(b"probe") {
                    Ok(_) => return Ok(Self { path: protected, source: KeySource::Dpapi }),
                    Err(e) if protected.exists() => {
                        return Err(e).with_context(|| format!("DPAPI is not usable for {}", protected.display()));
                    }
                    Err(e) => tracing::warn!("DPAPI is not usable ({e}); falling back to a plain key file"),
                }
            }
        }
        Ok(Self { path: plain, source: KeySource::File })
    }

    fn pending_path(&self) -> PathBuf {
        let mut name = self.path.file_name().unwrap_or_default().to_os_string();
        name.push(PENDING_SUFFIX);
        self.path.with_file_name(name)
    }

    fn read(&self, path: &Path) -> Result<Option<SecretKey>> {
        let bytes = match std::fs::read(path) {
            Ok(b) => Zeroizing::new(b),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e).with_context(|| format!("reading {}", path.display())),
        };
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(path)?.permissions().mode();
            if mode & 0o077 != 0 {
                bail!(
                    "{} can be read by other users (mode {:o}); run `chmod 600 {}` and start again",
                    path.display(),
                    mode & 0o777,
                    path.display()
                );
            }
        }
        let raw = match self.source {
            #[cfg(windows)]
            KeySource::Dpapi => dpapi::unprotect(&bytes).with_context(|| format!("unprotecting {}", path.display()))?,
            _ => {
                let text = std::str::from_utf8(&bytes).with_context(|| format!("{} is not text", path.display()))?;
                Zeroizing::new(BASE64.decode(text.trim()).with_context(|| format!("{} is not base64", path.display()))?)
            }
        };
        SecretKey::from_bytes(&raw).with_context(|| format!("reading {}", path.display())).map(Some)
    }

    fn write(&self, path: &Path, raw: &[u8]) -> Result<()> {
        let content: Zeroizing<Vec<u8>> = match self.source {
            #[cfg(windows)]
            KeySource::Dpapi => Zeroizing::new(dpapi::protect(raw).context("protecting the key with DPAPI")?),
            _ => Zeroizing::new(format!("{}\n", BASE64.encode(raw)).into_bytes()),
        };
        write_private_atomic(path, &content).with_context(|| format!("writing {}", path.display()))
    }

    /// Makes the pending key the current one. The rename replaces the old file atomically, and
    /// the directory is synced so the rename survives a crash.
    fn promote_pending(&self) -> Result<()> {
        std::fs::rename(self.pending_path(), &self.path)
            .with_context(|| format!("replacing {}", self.path.display()))?;
        sync_dir(&self.path).with_context(|| format!("syncing the directory of {}", self.path.display()))
    }
}

fn open_lock(data_dir: &Path) -> Result<std::fs::File> {
    std::fs::create_dir_all(data_dir).with_context(|| format!("creating {}", data_dir.display()))?;
    let path = data_dir.join(LOCK_FILE);
    std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&path)
        .with_context(|| format!("opening {}", path.display()))
}

/// Makes a created or renamed directory entry durable (Unix; Windows has no directory fsync and
/// commits renames with the metadata journal).
fn sync_dir(file: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    if let Some(dir) = file.parent() {
        std::fs::File::open(dir)?.sync_all()?;
    }
    #[cfg(not(unix))]
    let _ = file;
    Ok(())
}

/// Writes through a temporary file and a rename, so a crash never leaves a half-written key. On
/// Unix the file is created with mode 0600; on Windows it gets an ACL for SYSTEM, Administrators
/// and its owner only (not inherited from the data directory), set when the file is created.
fn write_private_atomic(path: &Path, content: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let tmp = path.with_extension("tmp");
    match std::fs::remove_file(&tmp) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e),
    }
    #[cfg(windows)]
    let mut file = acl::create_file(&tmp, acl::FILE_SDDL)?;
    #[cfg(not(windows))]
    let mut file = {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        options.open(&tmp)?
    };
    file.write_all(content)?;
    file.sync_all()?;
    drop(file);
    std::fs::rename(&tmp, path)?;
    sync_dir(path)
}

#[cfg(windows)]
mod dpapi {
    //! DPAPI in machine scope: the blob is bound to this computer, so a copied data directory
    //! (or backup) does not carry a usable key.

    use windows::Win32::Foundation::{HLOCAL, LocalFree};
    use windows::Win32::Security::Cryptography::{
        CRYPT_INTEGER_BLOB, CRYPTPROTECT_LOCAL_MACHINE, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData, CryptUnprotectData,
    };
    use windows::core::PCWSTR;
    use zeroize::{Zeroize, Zeroizing};

    const ENTROPY: &[u8] = b"kalzit secrets key";

    fn blob(data: &[u8]) -> CRYPT_INTEGER_BLOB {
        CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 }
    }

    /// Copies the output out of the LocalAlloc'ed buffer, wipes it and frees it.
    fn take(out: CRYPT_INTEGER_BLOB) -> Zeroizing<Vec<u8>> {
        // SAFETY: DPAPI returned a buffer of `cbData` bytes at `pbData`, owned by us until freed.
        let data = unsafe { std::slice::from_raw_parts_mut(out.pbData, out.cbData as usize) };
        let copy = Zeroizing::new(data.to_vec());
        data.zeroize();
        // SAFETY: the buffer was allocated by DPAPI with LocalAlloc and is not used afterwards.
        unsafe { LocalFree(Some(HLOCAL(out.pbData.cast()))) };
        copy
    }

    pub fn protect(data: &[u8]) -> std::io::Result<Vec<u8>> {
        let input = blob(data);
        let entropy = blob(ENTROPY);
        let mut out = CRYPT_INTEGER_BLOB::default();
        let flags = CRYPTPROTECT_LOCAL_MACHINE | CRYPTPROTECT_UI_FORBIDDEN;
        // SAFETY: input and entropy point at live slices for the duration of the call.
        unsafe { CryptProtectData(&input, PCWSTR::null(), Some(&entropy), None, None, flags, &mut out) }
            .map_err(std::io::Error::other)?;
        Ok(take(out).to_vec())
    }

    pub fn unprotect(data: &[u8]) -> std::io::Result<Zeroizing<Vec<u8>>> {
        let input = blob(data);
        let entropy = blob(ENTROPY);
        let mut out = CRYPT_INTEGER_BLOB::default();
        // SAFETY: as above.
        unsafe { CryptUnprotectData(&input, None, Some(&entropy), None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut out) }
            .map_err(std::io::Error::other)?;
        Ok(take(out))
    }
}

/// A secret field change: absent = keep, `None` (JSON `null`) = remove, `Some` = set.
pub type SecretPatch = BTreeMap<String, Option<Zeroizing<String>>>;

pub async fn apply_patch(
    conn: &mut sqlx::AnyConnection,
    keyring: &Keyring,
    datasource_id: &str,
    patch: &SecretPatch,
) -> Result<(), sqlx::Error> {
    for (field, value) in patch {
        match value {
            None => {
                sqlx::query("DELETE FROM datasource_secrets WHERE datasource_id = $1 AND field = $2")
                    .bind(datasource_id)
                    .bind(field)
                    .execute(&mut *conn)
                    .await?;
            }
            Some(plain) => {
                let blob = keyring.encrypt(datasource_id, field, plain);
                sqlx::query(
                    "INSERT INTO datasource_secrets (datasource_id, field, key_id, nonce, ciphertext) \
                     VALUES ($1, $2, $3, $4, $5) ON CONFLICT (datasource_id, field) DO UPDATE SET \
                     key_id = excluded.key_id, nonce = excluded.nonce, ciphertext = excluded.ciphertext",
                )
                .bind(datasource_id)
                .bind(field)
                .bind(&blob.key_id)
                .bind(&blob.nonce)
                .bind(&blob.ciphertext)
                .execute(&mut *conn)
                .await?;
            }
        }
    }
    Ok(())
}

/// The names of the secret fields that have a value, for `{"set": true}` in the API.
pub async fn set_fields<'e, E: sqlx::Executor<'e, Database = sqlx::Any>>(
    db: E,
    datasource_id: &str,
) -> Result<Vec<String>, sqlx::Error> {
    let rows: Vec<(String,)> =
        sqlx::query_as("SELECT field FROM datasource_secrets WHERE datasource_id = $1 ORDER BY field")
            .bind(datasource_id)
            .fetch_all(db)
            .await?;
    Ok(rows.into_iter().map(|(f,)| f).collect())
}

#[derive(Debug, thiserror::Error)]
pub enum LoadError {
    #[error(transparent)]
    Database(#[from] sqlx::Error),
    #[error("the stored secret {field} {error}; enter it again")]
    Secret { field: String, error: SecretError },
}

/// Every secret of a data source, decrypted. The values are wiped when dropped.
pub async fn load_all(
    db: &sqlx::AnyPool,
    keyring: &Keyring,
    datasource_id: &str,
) -> Result<BTreeMap<String, Zeroizing<String>>, LoadError> {
    let rows: Vec<(String, String, String, String)> =
        sqlx::query_as("SELECT field, key_id, nonce, ciphertext FROM datasource_secrets WHERE datasource_id = $1")
            .bind(datasource_id)
            .fetch_all(db)
            .await?;
    let mut out = BTreeMap::new();
    for (field, key_id, nonce, ciphertext) in rows {
        let blob = Blob { key_id, nonce, ciphertext };
        let value = keyring
            .decrypt(datasource_id, &field, &blob)
            .map_err(|error| LoadError::Secret { field: field.clone(), error })?;
        out.insert(field, value);
    }
    Ok(out)
}

/// What `kalzit secrets rotate` did.
#[derive(Debug)]
pub struct Rotation {
    pub reencrypted: usize,
    pub key_id: String,
    pub source: KeySource,
    /// What the administrator still has to do.
    pub next_step: String,
}

impl fmt::Display for Rotation {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "re-encrypted {} secrets with key {}; {}", self.reencrypted, self.key_id, self.next_step)
    }
}

/// Re-encrypts every stored secret with a new key. Run it while the server is stopped: a server
/// still holding the old key would encrypt new secrets with it.
///
/// A key from the environment or a systemd credential cannot be replaced by Kalzit, so the new
/// key is read from `KALZIT_SECRETS_NEW_KEY` and the administrator swaps it in afterwards. A key
/// file is replaced here: the new key is first written next to it (`.next`), then the blobs are
/// re-encrypted in one transaction, then the new file replaces the old one. An interrupted run
/// leaves both keys loadable and resumes with the same new key.
pub async fn rotate(config: &Config) -> Result<Rotation> {
    let data_dir = &config.paths.data_dir;
    let _lock = hold_exclusive(data_dir)?;
    let keyring = Keyring::load(data_dir)?;
    let db = crate::db::connect(&config.database_url(), 1).await?;
    let new_key = std::env::var(NEW_KEY_ENV).ok().filter(|v| !v.trim().is_empty());
    let rotation = rotate_with(&db, keyring, data_dir, new_key.as_deref()).await;
    db.close().await;
    rotation
}

/// Holds the data directory for a command that needs the server stopped (`secrets rotate`,
/// `update apply`): a running server holds the lock shared, so this fails while one runs, and no
/// server starts while the returned file is open.
pub fn hold_exclusive(data_dir: &Path) -> Result<std::fs::File> {
    let lock = open_lock(data_dir)?;
    match lock.try_lock() {
        Ok(()) => Ok(lock),
        Err(std::fs::TryLockError::WouldBlock) => {
            bail!("a Kalzit server is running on this data directory; stop it first")
        }
        Err(std::fs::TryLockError::Error(e)) => Err(e).context("locking the secrets key"),
    }
}

async fn rotate_with(db: &sqlx::AnyPool, keyring: Keyring, data_dir: &Path, new_key: Option<&str>) -> Result<Rotation> {
    let source = keyring.source;
    let store = match source {
        KeySource::Environment | KeySource::SystemdCredential => None,
        KeySource::Dpapi | KeySource::File => Some(KeyFile::for_data_dir(data_dir)?),
    };
    if store.is_none() && new_key.is_none() {
        // The external key is already the new one and OLD_KEY_ENV names the previous key: move
        // every blob to the current key.
        if keyring.others.is_empty() {
            bail!(
                "the secrets key comes from {source}; set {NEW_KEY_ENV} to the new key (base64 of 32 random \
                 bytes), or set {KEY_ENV} to the new key and {OLD_KEY_ENV} to the old one"
            );
        }
        let reencrypted = reencrypt_all(db, &keyring, &keyring.current).await?
            + crate::acme::store::reencrypt(data_dir, &keyring, &keyring.current)?
            + crate::acme::store::reencrypt_shared(db, &keyring, &keyring.current).await?;
        let next_step = format!("{OLD_KEY_ENV} is no longer needed; remove it");
        return Ok(Rotation { reencrypted, key_id: keyring.current.id.clone(), source, next_step });
    }
    let new = match (&store, new_key) {
        (None, None) => unreachable!("handled above"),
        (None, Some(text)) => SecretKey::from_base64(text).with_context(|| format!("reading {NEW_KEY_ENV}"))?.0,
        (Some(_), Some(_)) => bail!("{NEW_KEY_ENV} is only used when the key comes from {KEY_ENV} or systemd"),
        (Some(store), None) => {
            let pending = store.pending_path();
            match store.read(&pending)? {
                Some(key) => key,
                None => {
                    let (key, raw) = SecretKey::generate();
                    store.write(&pending, &raw)?;
                    key
                }
            }
        }
    };
    if new.id == keyring.current.id {
        bail!("the new key is the current key");
    }
    // The ACME account and certificate files follow the database; an interrupted run leaves
    // both keys loadable, so files already moved stay readable.
    let reencrypted = reencrypt_all(db, &keyring, &new).await?
        + crate::acme::store::reencrypt(data_dir, &keyring, &new)?
        + crate::acme::store::reencrypt_shared(db, &keyring, &new).await?;
    let next_step = match &store {
        Some(store) => {
            store.promote_pending()?;
            "the key file was replaced".to_string()
        }
        None => format!("now replace {source} with the value of {NEW_KEY_ENV} before starting the server"),
    };
    Ok(Rotation { reencrypted, key_id: new.id, source, next_step })
}

/// Re-encrypts every blob not yet under `new` in one transaction; nothing changes when any blob
/// cannot be decrypted.
async fn reencrypt_all(db: &sqlx::AnyPool, keyring: &Keyring, new: &SecretKey) -> Result<usize> {
    let mut tx = crate::db::begin(db).await?;
    let rows: Vec<(String, String, String, String, String)> =
        sqlx::query_as("SELECT datasource_id, field, key_id, nonce, ciphertext FROM datasource_secrets")
            .fetch_all(&mut *tx)
            .await?;
    let mut count = 0;
    for (datasource_id, field, key_id, nonce, ciphertext) in rows {
        if key_id == new.id {
            continue;
        }
        let blob = Blob { key_id, nonce, ciphertext };
        let plain = match keyring.key(&blob.key_id) {
            Some(key) => decrypt_with(key, &datasource_id, &field, &blob),
            None => Err(SecretError::UnknownKey(blob.key_id.clone())),
        }
        .with_context(|| format!("secret {field} of data source {datasource_id}; nothing was changed"))?;
        let fresh = encrypt_with(new, &datasource_id, &field, &plain);
        sqlx::query(
            "UPDATE datasource_secrets SET key_id = $1, nonce = $2, ciphertext = $3 \
             WHERE datasource_id = $4 AND field = $5",
        )
        .bind(&fresh.key_id)
        .bind(&fresh.nonce)
        .bind(&fresh.ciphertext)
        .bind(&datasource_id)
        .bind(&field)
        .execute(&mut *tx)
        .await?;
        count += 1;
    }
    // The keys of AI providers, bound to `ai-provider:<id>` (`ai::store`).
    let rows: Vec<(String, String, String, String, String)> =
        sqlx::query_as("SELECT provider_id, field, key_id, nonce, ciphertext FROM ai_provider_secrets")
            .fetch_all(&mut *tx)
            .await?;
    for (provider_id, field, key_id, nonce, ciphertext) in rows {
        if key_id == new.id {
            continue;
        }
        let owner = crate::ai::store::secret_owner(&provider_id);
        let blob = Blob { key_id, nonce, ciphertext };
        let plain = match keyring.key(&blob.key_id) {
            Some(key) => decrypt_with(key, &owner, &field, &blob),
            None => Err(SecretError::UnknownKey(blob.key_id.clone())),
        }
        .with_context(|| format!("secret {field} of AI provider {provider_id}; nothing was changed"))?;
        let fresh = encrypt_with(new, &owner, &field, &plain);
        sqlx::query(
            "UPDATE ai_provider_secrets SET key_id = $1, nonce = $2, ciphertext = $3 \
             WHERE provider_id = $4 AND field = $5",
        )
        .bind(&fresh.key_id)
        .bind(&fresh.nonce)
        .bind(&fresh.ciphertext)
        .bind(&provider_id)
        .bind(&field)
        .execute(&mut *tx)
        .await?;
        count += 1;
    }
    // The secrets of identity providers, bound to `sso-provider:<id>` (`sso::store`). The
    // secrets of test sign-ins live ten minutes and are not carried over.
    let rows: Vec<(String, String, String, String, String)> =
        sqlx::query_as("SELECT provider_id, field, key_id, nonce, ciphertext FROM sso_provider_secrets")
            .fetch_all(&mut *tx)
            .await?;
    for (provider_id, field, key_id, nonce, ciphertext) in rows {
        if key_id == new.id {
            continue;
        }
        let owner = crate::sso::store::secret_owner(&provider_id);
        let blob = Blob { key_id, nonce, ciphertext };
        let plain = match keyring.key(&blob.key_id) {
            Some(key) => decrypt_with(key, &owner, &field, &blob),
            None => Err(SecretError::UnknownKey(blob.key_id.clone())),
        }
        .with_context(|| format!("secret {field} of identity provider {provider_id}; nothing was changed"))?;
        let fresh = encrypt_with(new, &owner, &field, &plain);
        sqlx::query(
            "UPDATE sso_provider_secrets SET key_id = $1, nonce = $2, ciphertext = $3 \
             WHERE provider_id = $4 AND field = $5",
        )
        .bind(&fresh.key_id)
        .bind(&fresh.nonce)
        .bind(&fresh.ciphertext)
        .bind(&provider_id)
        .bind(&field)
        .execute(&mut *tx)
        .await?;
        count += 1;
    }
    sqlx::query("DELETE FROM sso_sign_ins WHERE draft_secret IS NOT NULL").execute(&mut *tx).await?;
    // The keys of authenticator apps, bound to `user:<id>` / `totp` (`auth::second_factor`).
    let rows: Vec<(String, String, String, String)> =
        sqlx::query_as("SELECT user_id, key_id, nonce, ciphertext FROM user_totp").fetch_all(&mut *tx).await?;
    for (user_id, key_id, nonce, ciphertext) in rows {
        if key_id == new.id {
            continue;
        }
        let (owner, field) = crate::auth::second_factor::totp_secret_binding(&user_id);
        let blob = Blob { key_id, nonce, ciphertext };
        let plain = match keyring.key(&blob.key_id) {
            Some(key) => decrypt_with(key, &owner, field, &blob),
            None => Err(SecretError::UnknownKey(blob.key_id.clone())),
        }
        .with_context(|| format!("the authenticator app key of user {user_id}; nothing was changed"))?;
        let fresh = encrypt_with(new, &owner, field, &plain);
        sqlx::query("UPDATE user_totp SET key_id = $1, nonce = $2, ciphertext = $3 WHERE user_id = $4")
            .bind(&fresh.key_id)
            .bind(&fresh.nonce)
            .bind(&fresh.ciphertext)
            .bind(&user_id)
            .execute(&mut *tx)
            .await?;
        count += 1;
    }
    crate::db::commit(tx).await?;
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// RFC 4231, test case 2 (a short key is padded with zeros, as here to 32 bytes).
    #[test]
    fn hmac_matches_the_rfc_vector() {
        let mut key = [0u8; 32];
        key[..4].copy_from_slice(b"Jefe");
        assert_eq!(
            hex::encode(hmac_sha256(&key, b"what do ya want for nothing?")),
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
        let ring = Keyring::from_key(SecretKey::generate().0);
        let mac = ring.sign(b"data");
        assert!(ring.verify(b"data", &mac));
        assert!(!ring.verify(b"datb", &mac));
        assert!(!Keyring::from_key(SecretKey::generate().0).verify(b"data", &mac));
    }

    fn key() -> SecretKey {
        SecretKey::generate().0
    }

    #[test]
    fn round_trip_with_umlauts() {
        let ring = Keyring::from_key(key());
        let blob = ring.encrypt("ds1", "password", "Grün & geheim");
        assert_eq!(blob.key_id, ring.current_id());
        assert!(!blob.ciphertext.contains("geheim"));
        assert_eq!(&*ring.decrypt("ds1", "password", &blob).unwrap(), "Grün & geheim");
        // A fresh nonce every time: the same value never encrypts the same way twice.
        assert_ne!(ring.encrypt("ds1", "password", "x").nonce, ring.encrypt("ds1", "password", "x").nonce);
    }

    #[test]
    fn a_moved_blob_does_not_decrypt() {
        let ring = Keyring::from_key(key());
        let blob = ring.encrypt("ds1", "password", "s3cr3t");
        assert_eq!(ring.decrypt("ds2", "password", &blob).unwrap_err(), SecretError::Undecryptable);
        assert_eq!(ring.decrypt("ds1", "bearerToken", &blob).unwrap_err(), SecretError::Undecryptable);
        // The separator keeps "ds1" + "0password" apart from "ds10" + "password".
        assert_eq!(ring.decrypt("ds10", "assword", &blob).unwrap_err(), SecretError::Undecryptable);
    }

    #[test]
    fn a_wrong_key_does_not_decrypt() {
        let a = Keyring::from_key(key());
        let b = Keyring::from_key(key());
        let blob = a.encrypt("ds1", "password", "s3cr3t");
        assert_eq!(b.decrypt("ds1", "password", &blob).unwrap_err(), SecretError::UnknownKey(blob.key_id.clone()));
        // Even with a forged key id the authentication tag rejects it.
        let forged = Blob { key_id: b.current_id().to_string(), ..blob };
        assert_eq!(b.decrypt("ds1", "password", &forged).unwrap_err(), SecretError::Undecryptable);
        let tampered = Blob { ciphertext: BASE64.encode(b"0123456789abcdefXYZ"), ..a.encrypt("d", "f", "v") };
        assert_eq!(a.decrypt("d", "f", &tampered).unwrap_err(), SecretError::Undecryptable);
    }

    #[test]
    fn key_ids_are_fingerprints() {
        let raw = [7u8; 32];
        let a = SecretKey::from_bytes(&raw).unwrap();
        assert_eq!(a.id(), SecretKey::from_bytes(&raw).unwrap().id());
        assert_eq!(a.id().len(), 16);
        assert!(!a.id().contains(&hex::encode(&raw[..4])));
        assert!(SecretKey::from_bytes(&[1u8; 16]).is_err());
        assert!(format!("{a:?}").contains(a.id()));
    }

    #[test]
    fn sources_are_tried_in_order() {
        let dir = tempfile::tempdir().unwrap();
        let env_key = BASE64.encode([1u8; 32]);
        let creds = tempfile::tempdir().unwrap();
        std::fs::write(creds.path().join(SYSTEMD_CREDENTIAL), [2u8; 32]).unwrap();

        let ring = Keyring::load_from(Some(&env_key), None, Some(creds.path()), dir.path(), true).unwrap();
        assert_eq!(ring.source(), KeySource::Environment);
        assert_eq!(ring.current_id(), SecretKey::from_bytes(&[1u8; 32]).unwrap().id());

        let ring = Keyring::load_from(None, None, Some(creds.path()), dir.path(), true).unwrap();
        assert_eq!(ring.source(), KeySource::SystemdCredential);
        assert_eq!(ring.current_id(), SecretKey::from_bytes(&[2u8; 32]).unwrap().id());
        std::fs::write(creds.path().join(SYSTEMD_CREDENTIAL), format!("{}\n", BASE64.encode([3u8; 32]))).unwrap();
        let ring = Keyring::load_from(None, None, Some(creds.path()), dir.path(), true).unwrap();
        assert_eq!(ring.current_id(), SecretKey::from_bytes(&[3u8; 32]).unwrap().id());

        // Nothing configured: a key file is created once and reused.
        let first = Keyring::load_from(None, None, None, dir.path(), true).unwrap();
        let again = Keyring::load_from(None, None, Some(Path::new("/nonexistent")), dir.path(), true).unwrap();
        assert_eq!(first.current_id(), again.current_id());
        #[cfg(windows)]
        {
            assert_eq!(first.source(), KeySource::Dpapi);
            let stored = std::fs::read(dir.path().join(DPAPI_KEY_FILE)).unwrap();
            assert!(std::str::from_utf8(&stored).is_err() || !stored.is_ascii(), "DPAPI output is binary");
            assert!(!dir.path().join(KEY_FILE).exists());
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(first.source(), KeySource::File);
            let mode = std::fs::metadata(dir.path().join(KEY_FILE)).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }

        assert!(Keyring::load_from(Some("not base64!"), None, None, dir.path(), true).is_err());
        assert!(Keyring::load_from(Some(&BASE64.encode([1u8; 16])), None, None, dir.path(), true).is_err());
    }

    async fn db_with_source(ids: &[&str]) -> sqlx::AnyPool {
        let db = crate::db::connect("sqlite::memory:", 1).await.unwrap();
        sqlx::query("INSERT INTO orgs (id, name, created_at) VALUES ('o', 'O', 0)").execute(&db).await.unwrap();
        for id in ids {
            sqlx::query(
                "INSERT INTO datasources (id, org_id, name, kind, settings, created_at, updated_at) \
                 VALUES ($1, 'o', $1, 'postgres', '{}', 0, 0)",
            )
            .bind(*id)
            .execute(&db)
            .await
            .unwrap();
        }
        db
    }

    #[tokio::test]
    async fn patch_keeps_removes_and_sets() {
        let db = db_with_source(&["ds1"]).await;
        let ring = Keyring::from_key(key());
        let mut conn = db.acquire().await.unwrap();
        let set: SecretPatch = serde_json::from_str(r#"{"password": "eins", "bearerToken": "zwei"}"#).unwrap();
        apply_patch(&mut conn, &ring, "ds1", &set).await.unwrap();
        // `password` omitted keeps it, `bearerToken: null` removes it, a string sets a new value.
        let patch: SecretPatch = serde_json::from_str(r#"{"bearerToken": null, "clientKey": "drei"}"#).unwrap();
        assert_eq!(patch.get("bearerToken"), Some(&None));
        apply_patch(&mut conn, &ring, "ds1", &patch).await.unwrap();
        drop(conn);
        assert_eq!(set_fields(&db, "ds1").await.unwrap(), ["clientKey", "password"]);
        let all = load_all(&db, &ring, "ds1").await.unwrap();
        assert_eq!(all.get("password").map(|v| v.as_str()), Some("eins"));
        assert_eq!(all.get("clientKey").map(|v| v.as_str()), Some("drei"));

        let mut conn = db.acquire().await.unwrap();
        let overwrite: SecretPatch = serde_json::from_str(r#"{"password": "neu"}"#).unwrap();
        apply_patch(&mut conn, &ring, "ds1", &overwrite).await.unwrap();
        drop(conn);
        assert_eq!(load_all(&db, &ring, "ds1").await.unwrap()["password"].as_str(), "neu");
    }

    #[tokio::test]
    async fn a_blob_copied_to_another_source_is_refused() {
        let db = db_with_source(&["ds1", "ds2"]).await;
        let ring = Keyring::from_key(key());
        let mut conn = db.acquire().await.unwrap();
        apply_patch(
            &mut conn,
            &ring,
            "ds1",
            &[("password".to_string(), Some(Zeroizing::new("s3cr3t".to_string())))].into(),
        )
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO datasource_secrets (datasource_id, field, key_id, nonce, ciphertext) \
             SELECT 'ds2', field, key_id, nonce, ciphertext FROM datasource_secrets WHERE datasource_id = 'ds1'",
        )
        .execute(&mut *conn)
        .await
        .unwrap();
        drop(conn);
        let err = load_all(&db, &ring, "ds2").await.unwrap_err();
        assert!(
            matches!(err, LoadError::Secret { ref field, error: SecretError::Undecryptable } if field == "password")
        );
        assert!(!err.to_string().contains("s3cr3t"));
    }

    #[tokio::test]
    async fn rotation_with_a_key_file_replaces_it_and_resumes() {
        let dir = tempfile::tempdir().unwrap();
        let db = db_with_source(&["ds1", "ds2"]).await;
        let old = Keyring::load_from(None, None, None, dir.path(), true).unwrap();
        let mut conn = db.acquire().await.unwrap();
        apply_patch(&mut conn, &old, "ds1", &[("password".into(), Some(Zeroizing::new("eins".to_string())))].into())
            .await
            .unwrap();
        apply_patch(&mut conn, &old, "ds2", &[("password".into(), Some(Zeroizing::new("zwei".to_string())))].into())
            .await
            .unwrap();
        drop(conn);

        let rotation =
            rotate_with(&db, Keyring::load_from(None, None, None, dir.path(), true).unwrap(), dir.path(), None)
                .await
                .unwrap();
        assert_eq!(rotation.reencrypted, 2);
        let new = Keyring::load_from(None, None, None, dir.path(), true).unwrap();
        assert_eq!(new.current_id(), rotation.key_id);
        assert_ne!(new.current_id(), old.current_id());
        assert_eq!(load_all(&db, &new, "ds2").await.unwrap()["password"].as_str(), "zwei");
        assert!(load_all(&db, &old, "ds1").await.is_err(), "the old key no longer opens anything");

        // An interrupted rotation: the pending key exists and one blob already uses it.
        let store = KeyFile::for_data_dir(dir.path()).unwrap();
        let (next, raw) = SecretKey::generate();
        store.write(&store.pending_path(), &raw).unwrap();
        let both = Keyring::load_from(None, None, None, dir.path(), true).unwrap();
        assert_eq!(both.others.len(), 1);
        let mut conn = db.acquire().await.unwrap();
        let resumed = Keyring {
            current: SecretKey::from_bytes(&raw).unwrap(),
            others: Vec::new(),
            source: both.source,
            _lock: None,
        };
        apply_patch(
            &mut conn,
            &resumed,
            "ds1",
            &[("password".into(), Some(Zeroizing::new("eins".to_string())))].into(),
        )
        .await
        .unwrap();
        drop(conn);
        let rotation = rotate_with(&db, both, dir.path(), None).await.unwrap();
        assert_eq!((rotation.reencrypted, rotation.key_id.as_str()), (1, next.id()));
        let after = Keyring::load_from(None, None, None, dir.path(), true).unwrap();
        assert_eq!(after.current_id(), next.id());
        assert!(after.others.is_empty(), "the pending file became the key file");
        assert_eq!(load_all(&db, &after, "ds1").await.unwrap()["password"].as_str(), "eins");
        assert_eq!(load_all(&db, &after, "ds2").await.unwrap()["password"].as_str(), "zwei");
    }

    #[tokio::test]
    async fn rotation_reencrypts_ai_provider_keys_too() {
        let dir = tempfile::tempdir().unwrap();
        let db = db_with_source(&["ds1"]).await;
        sqlx::query(
            "INSERT INTO ai_providers (id, org_id, name, kind, base_url, model, is_default, created_at, updated_at) \
             VALUES ('p1', NULL, 'P', 'openai', 'http://localhost:11434/v1', 'm', 1, 0, 0)",
        )
        .execute(&db)
        .await
        .unwrap();
        let old = Keyring::load_from(None, None, None, dir.path(), true).unwrap();
        let mut conn = db.acquire().await.unwrap();
        crate::ai::store::set_key(&mut conn, &old, "p1", Some("sk-alt")).await.unwrap();
        drop(conn);
        // A provider key cannot be read as a data source secret of the same id, nor the reverse.
        let copied = "INSERT INTO datasource_secrets (datasource_id, field, key_id, nonce, ciphertext) \
                      SELECT 'ds1', field, key_id, nonce, ciphertext FROM ai_provider_secrets";
        sqlx::query(copied).execute(&db).await.unwrap();
        assert!(load_all(&db, &old, "ds1").await.is_err());
        sqlx::query("DELETE FROM datasource_secrets").execute(&db).await.unwrap();

        let rotation =
            rotate_with(&db, Keyring::load_from(None, None, None, dir.path(), true).unwrap(), dir.path(), None)
                .await
                .unwrap();
        assert_eq!(rotation.reencrypted, 1);
        let new = Keyring::load_from(None, None, None, dir.path(), true).unwrap();
        let key = crate::ai::store::load_key(&db, &new, "p1").await.unwrap().unwrap();
        assert_eq!(key.as_str(), "sk-alt");
        assert!(crate::ai::store::load_key(&db, &old, "p1").await.is_err());
    }

    #[tokio::test]
    async fn rotation_with_an_external_key_needs_the_new_one() {
        let dir = tempfile::tempdir().unwrap();
        let db = db_with_source(&["ds1"]).await;
        let old_text = BASE64.encode([4u8; 32]);
        let ring = Keyring::load_from(Some(&old_text), None, None, dir.path(), true).unwrap();
        let mut conn = db.acquire().await.unwrap();
        apply_patch(&mut conn, &ring, "ds1", &[("password".into(), Some(Zeroizing::new("eins".to_string())))].into())
            .await
            .unwrap();
        drop(conn);

        let missing = rotate_with(
            &db,
            Keyring::load_from(Some(&old_text), None, None, dir.path(), true).unwrap(),
            dir.path(),
            None,
        );
        assert!(missing.await.unwrap_err().to_string().contains(NEW_KEY_ENV));
        let new_text = BASE64.encode([5u8; 32]);
        let ring = Keyring::load_from(Some(&old_text), None, None, dir.path(), true).unwrap();
        let rotation = rotate_with(&db, ring, dir.path(), Some(&new_text)).await.unwrap();
        assert_eq!(rotation.reencrypted, 1);
        assert!(rotation.to_string().contains(NEW_KEY_ENV));
        let new = Keyring::load_from(Some(&new_text), None, None, dir.path(), true).unwrap();
        assert_eq!(load_all(&db, &new, "ds1").await.unwrap()["password"].as_str(), "eins");
        assert!(!dir.path().join(KEY_FILE).exists(), "no key file for an external key");
    }

    #[tokio::test]
    async fn rotation_changes_nothing_when_a_blob_is_unreadable() {
        let dir = tempfile::tempdir().unwrap();
        let db = db_with_source(&["ds1", "ds2"]).await;
        let current_text = BASE64.encode([6u8; 32]);
        let current = Keyring::load_from(Some(&current_text), None, None, dir.path(), true).unwrap();
        let stranger = Keyring::from_key(key());
        let mut conn = db.acquire().await.unwrap();
        apply_patch(
            &mut conn,
            &current,
            "ds1",
            &[("password".into(), Some(Zeroizing::new("eins".to_string())))].into(),
        )
        .await
        .unwrap();
        apply_patch(
            &mut conn,
            &stranger,
            "ds2",
            &[("password".into(), Some(Zeroizing::new("zwei".to_string())))].into(),
        )
        .await
        .unwrap();
        drop(conn);
        let err = rotate_with(&db, current, dir.path(), Some(&BASE64.encode([8u8; 32]))).await.unwrap_err();
        assert!(format!("{err:#}").contains("nothing was changed"), "{err:#}");
        let current = Keyring::load_from(Some(&current_text), None, None, dir.path(), true).unwrap();
        assert_eq!(load_all(&db, &current, "ds1").await.unwrap()["password"].as_str(), "eins");
    }

    fn patch(value: &str) -> SecretPatch {
        [("password".to_string(), Some(Zeroizing::new(value.to_string())))].into()
    }

    #[tokio::test]
    async fn a_lost_key_file_is_an_error_when_secrets_are_stored() {
        let dir = tempfile::tempdir().unwrap();
        let db = db_with_source(&["ds1"]).await;
        let first = Keyring::load_for_server(dir.path(), &db).await.unwrap();
        let mut conn = db.acquire().await.unwrap();
        apply_patch(&mut conn, &first, "ds1", &patch("eins")).await.unwrap();
        drop(conn);
        drop(first);
        for name in [KEY_FILE, "secrets.key.dpapi"] {
            let _ = std::fs::remove_file(dir.path().join(name));
        }
        let err = Keyring::load_for_server(dir.path(), &db).await.unwrap_err();
        assert!(format!("{err:#}").contains("no secrets key"), "{err:#}");
        assert!(
            !dir.path().join(KEY_FILE).exists() && !dir.path().join("secrets.key.dpapi").exists(),
            "no new key was made"
        );
    }

    #[tokio::test]
    async fn rotation_refuses_while_a_server_holds_the_key() {
        let dir = tempfile::tempdir().unwrap();
        let mut config = Config::default();
        config.paths.data_dir = dir.path().to_path_buf();
        let db = crate::db::connect(&config.database_url(), 1).await.unwrap();
        let server = Keyring::load_for_server(dir.path(), &db).await.unwrap();
        let err = rotate(&config).await.unwrap_err();
        assert!(format!("{err:#}").contains("stop it first"), "{err:#}");
        drop(server);
        let done = rotate(&config).await.unwrap();
        assert_eq!(done.reencrypted, 0);
        // A rotation in progress keeps a server from starting.
        let lock = open_lock(dir.path()).unwrap();
        lock.lock().unwrap();
        let err = Keyring::load_for_server(dir.path(), &db).await.unwrap_err();
        assert!(format!("{err:#}").contains("rotate"), "{err:#}");
        // Closed before the folder goes: Windows cannot delete files that are still open.
        drop(lock);
        db.close().await;
        dir.close().unwrap();
    }

    #[tokio::test]
    async fn an_old_external_key_is_read_and_rotated_away() {
        let dir = tempfile::tempdir().unwrap();
        let db = db_with_source(&["ds1"]).await;
        let old_text = BASE64.encode([9u8; 32]);
        let new_text = BASE64.encode([10u8; 32]);
        let old = Keyring::load_from(Some(&old_text), None, None, dir.path(), true).unwrap();
        let mut conn = db.acquire().await.unwrap();
        apply_patch(&mut conn, &old, "ds1", &patch("eins")).await.unwrap();
        drop(conn);
        // The server reads blobs of the old key while the new one is current.
        let both = Keyring::load_from(Some(&new_text), Some(&old_text), None, dir.path(), true).unwrap();
        assert_eq!(load_all(&db, &both, "ds1").await.unwrap()["password"].as_str(), "eins");
        let rotation = rotate_with(&db, both, dir.path(), None).await.unwrap();
        assert_eq!(rotation.reencrypted, 1);
        assert!(rotation.to_string().contains(OLD_KEY_ENV));
        let only_new = Keyring::load_from(Some(&new_text), None, None, dir.path(), true).unwrap();
        assert_eq!(load_all(&db, &only_new, "ds1").await.unwrap()["password"].as_str(), "eins");
        assert!(
            Keyring::load_from(None, Some(&old_text), None, dir.path(), true).is_err(),
            "only next to an external key"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_key_file_readable_by_others_is_refused() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        Keyring::load_from(None, None, None, dir.path(), true).unwrap();
        let path = dir.path().join(KEY_FILE);
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        let err = Keyring::load_from(None, None, None, dir.path(), true).unwrap_err();
        assert!(format!("{err:#}").contains("chmod 600"), "{err:#}");
    }

    #[cfg(windows)]
    #[test]
    fn key_files_get_a_private_acl() {
        let dir = tempfile::tempdir().unwrap();
        Keyring::load_from(None, None, None, dir.path(), true).unwrap();
        let path = dir.path().join(DPAPI_KEY_FILE);
        let sddl = acl::dacl_sddl(&path).unwrap();
        let dacl = sddl.split("D:").nth(1).unwrap_or_default().trim().to_string();
        assert!(dacl.starts_with('P'), "not inherited: {sddl}");
        let trustees: Vec<&str> =
            dacl.split(')').filter_map(|ace| ace.rsplit(';').next()).filter(|t| !t.is_empty()).collect();
        assert!(trustees.contains(&"SY") && trustees.contains(&"BA"), "{sddl}");
        for broad in ["WD", "AU", "BU"] {
            assert!(!trustees.contains(&broad), "{broad} may not read the key: {sddl}");
        }
    }
}
