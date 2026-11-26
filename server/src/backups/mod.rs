//! Backups on a schedule and to a target (docs/api/backups.md, docs/guide/backup.md): a
//! consistent copy of the SQLite database (`VACUUM INTO`) with the `acme/` and `plugins/` folders
//! of the data directory and `kalzit.toml`, as one zip file (encrypted with the secrets key unless
//! `backups.encrypt` is off; the key itself is never part of it), stored in a local directory an
//! administrator allowed
//! (`backups.allowed_dirs`) or in an S3-compatible bucket (credentials in the secret store; the
//! target rules and the outbound proxy apply).
//!
//! The target is one versioned server setting (`backups.target`), saved in one explicit step
//! after a connection test, like the mail server. Schedule and retention are registry settings
//! (`backups.schedule_enabled`, `backups.interval_hours`, `backups.keep_count`,
//! `backups.encrypt`). The schedule is a leader-only job (`cluster::spawn_job`); a run at a time
//! per server (`Backups::running`). Every run, scheduled or asked for, is in `backup_runs` and in
//! the audit log. With PostgreSQL a backup holds the files only and a note that points to
//! `pg_dump`. Restoring is `kalzit backup restore` on the stopped server (`restore`).

pub mod archive;
pub mod restore;
pub mod s3;

use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use zeroize::Zeroizing;

use crate::app::AppState;
use crate::error::{ApiError, ApiResult};
use crate::http::HttpOptions;
use crate::secrets::Blob;

/// The target's key in `server_settings`, versioned like the other settings.
pub const TARGET_KEY: &str = "backups.target";
/// The secret access key's row in `server_secrets`.
pub const SECRET_OWNER: &str = "backups";
pub const SECRET_FIELD: &str = "s3_secret_access_key";
/// Backup files at the target are named `kalzit-backup-<UTC time>.zip` (`.zip.enc` when
/// encrypted); retention only ever touches files of these forms.
pub const FILE_PREFIX: &str = "kalzit-backup-";
pub const FILE_SUFFIX: &str = ".zip";
pub const ENCRYPTED_SUFFIX: &str = ".zip.enc";
/// A run marked `running` this long ago was cut short by a stop or a crash.
const STALE_RUN_MS: i64 = 6 * 3_600_000;
/// Run history kept.
const HISTORY_MS: i64 = 365 * 24 * 3_600_000;
const MAX_TEXT: usize = 1024;

/// One run at a time on this server.
#[derive(Default)]
pub struct Backups {
    running: tokio::sync::Mutex<()>,
}

/// Where backups go.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Target {
    /// A directory below one of `backups.allowed_dirs`.
    #[serde(rename_all = "camelCase")]
    Local { path: String },
    /// A bucket of an S3-compatible store.
    #[serde(rename_all = "camelCase")]
    S3 {
        endpoint: String,
        #[serde(default)]
        region: String,
        bucket: String,
        /// Put before every file name, such as `kalzit/`.
        #[serde(default)]
        prefix: String,
        #[serde(default)]
        path_style: bool,
        access_key_id: String,
    },
}

impl Target {
    pub fn kind(&self) -> &'static str {
        match self {
            Target::Local { .. } => "local",
            Target::S3 { .. } => "s3",
        }
    }

    /// Trimmed, the region filled in, the endpoint without a trailing slash.
    pub fn normalized(self) -> Self {
        match self {
            Target::Local { path } => Target::Local { path: path.trim().to_string() },
            Target::S3 { endpoint, region, bucket, prefix, path_style, access_key_id } => Target::S3 {
                endpoint: endpoint.trim().trim_end_matches('/').to_string(),
                region: Some(region.trim().to_string()).filter(|r| !r.is_empty()).unwrap_or_else(|| "us-east-1".into()),
                bucket: bucket.trim().to_string(),
                prefix: prefix.trim().trim_start_matches('/').to_string(),
                path_style,
                access_key_id: access_key_id.trim().to_string(),
            },
        }
    }

    /// Whether a stored secret may be used with `other`: same store, bucket and key id, so a
    /// changed endpoint never receives the stored secret.
    fn same_account(&self, other: &Target) -> bool {
        match (self, other) {
            (
                Target::S3 { endpoint: a, bucket: b, access_key_id: k, .. },
                Target::S3 { endpoint: a2, bucket: b2, access_key_id: k2, .. },
            ) => a == a2 && b == b2 && k == k2,
            _ => false,
        }
    }
}

fn field_error(field: &'static str, reason: &'static str, message: impl Into<String>) -> ApiError {
    ApiError::validation(message).with_field(field).because(reason)
}

fn plain(text: &str) -> bool {
    !text.is_empty() && text.chars().count() <= MAX_TEXT && !text.chars().any(char::is_control)
}

/// The form rules of a target, without the file system or network; the first problem with its
/// field.
pub fn check(target: &Target) -> ApiResult<()> {
    match target {
        Target::Local { path } => {
            if !plain(path) || !Path::new(path).is_absolute() {
                return Err(field_error("path", "backup.path_invalid", "enter an absolute directory path"));
            }
        }
        Target::S3 { endpoint, region, bucket, prefix, access_key_id, .. } => {
            let url = url::Url::parse(endpoint).ok().filter(|u| {
                matches!(u.scheme(), "http" | "https")
                    && u.host_str().is_some_and(|h| !h.is_empty())
                    && u.username().is_empty()
                    && u.password().is_none()
                    && (u.path() == "/" || u.path().is_empty())
                    && u.query().is_none()
                    && u.fragment().is_none()
            });
            if url.is_none() || endpoint.len() > 2048 {
                return Err(field_error(
                    "endpoint",
                    "backup.endpoint_invalid",
                    "enter the store's address such as https://s3.eu-central-1.amazonaws.com, without a path",
                ));
            }
            if !plain(region) || !region.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') {
                return Err(field_error("region", "backup.region_invalid", "enter a region such as eu-central-1"));
            }
            let bucket_ok = (3..=63).contains(&bucket.len())
                && bucket.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'.')
                && !bucket.starts_with(['-', '.'])
                && !bucket.ends_with(['-', '.']);
            if !bucket_ok {
                return Err(field_error(
                    "bucket",
                    "backup.bucket_invalid",
                    "a bucket name has 3 to 63 lowercase letters, digits, dots or hyphens",
                ));
            }
            if prefix.chars().count() > 512 || prefix.chars().any(char::is_control) || prefix.contains("..") {
                return Err(field_error(
                    "prefix",
                    "backup.prefix_invalid",
                    "a prefix has at most 512 characters, no control characters and no ..",
                ));
            }
            if !plain(access_key_id) || access_key_id.len() > 256 {
                return Err(field_error("accessKeyId", "backup.access_key_invalid", "enter the access key id"));
            }
        }
    }
    Ok(())
}

/// The stored target and its version (`None` before the first save and after a removal).
pub async fn load_target<'e, E>(db: E) -> ApiResult<(Option<Target>, i64)>
where
    E: sqlx::Executor<'e, Database = sqlx::Any>,
{
    let row: Option<(String, i64)> = sqlx::query_as("SELECT value, version FROM server_settings WHERE key = $1")
        .bind(TARGET_KEY)
        .fetch_optional(db)
        .await?;
    let Some((value, version)) = row else { return Ok((None, 0)) };
    let parsed: Option<Target> =
        serde_json::from_str(&value).map_err(|e| ApiError::internal("reading the backup target", e))?;
    Ok((parsed, version))
}

pub async fn load_secret(state: &AppState) -> ApiResult<Option<Zeroizing<String>>> {
    let row: Option<(String, String, String)> =
        sqlx::query_as("SELECT key_id, nonce, ciphertext FROM server_secrets WHERE owner = $1 AND field = $2")
            .bind(SECRET_OWNER)
            .bind(SECRET_FIELD)
            .fetch_optional(&state.db)
            .await?;
    let Some((key_id, nonce, ciphertext)) = row else { return Ok(None) };
    let plain = state
        .secrets
        .decrypt(SECRET_OWNER, SECRET_FIELD, &Blob { key_id, nonce, ciphertext })
        .map_err(|e| ApiError::internal("decrypting the backup target's secret", e))?;
    Ok(Some(plain))
}

/// Stores (`Some`) or removes (`None`) the secret access key inside the caller's transaction.
pub async fn store_secret(conn: &mut sqlx::AnyConnection, state: &AppState, secret: Option<&str>) -> ApiResult<()> {
    sqlx::query("DELETE FROM server_secrets WHERE owner = $1 AND field = $2")
        .bind(SECRET_OWNER)
        .bind(SECRET_FIELD)
        .execute(&mut *conn)
        .await?;
    if let Some(plain) = secret.filter(|s| !s.is_empty()) {
        let blob = state.secrets.encrypt(SECRET_OWNER, SECRET_FIELD, plain);
        sqlx::query("INSERT INTO server_secrets (owner, field, key_id, nonce, ciphertext) VALUES ($1, $2, $3, $4, $5)")
            .bind(SECRET_OWNER)
            .bind(SECRET_FIELD)
            .bind(&blob.key_id)
            .bind(&blob.nonce)
            .bind(&blob.ciphertext)
            .execute(&mut *conn)
            .await?;
    }
    Ok(())
}

/// The secret to use with `target`: the one sent, else the stored one when it belongs to the same
/// store, bucket and key id. Local targets have none.
pub async fn secret_for(
    state: &AppState,
    target: &Target,
    sent: Option<Zeroizing<String>>,
) -> ApiResult<Option<Zeroizing<String>>> {
    if !matches!(target, Target::S3 { .. }) {
        return Ok(None);
    }
    if let Some(sent) = sent.filter(|s| !s.is_empty()) {
        if sent.chars().count() > MAX_TEXT || sent.chars().any(char::is_control) {
            return Err(field_error(
                "secretAccessKey",
                "backup.secret_invalid",
                "the secret is too long or has control characters",
            ));
        }
        return Ok(Some(sent));
    }
    let (stored, _) = load_target(&state.db).await?;
    let same = stored.as_ref().is_some_and(|s| s.same_account(target));
    let secret = if same { load_secret(state).await? } else { None };
    secret.map(Some).ok_or_else(|| {
        field_error(
            "secretAccessKey",
            "backup.secret_required",
            "enter the secret access key for this store and key id",
        )
    })
}

/// The canonical directory of a local target, or why not: absolute, an existing directory below
/// one of `backups.allowed_dirs` (compared after links are resolved), never in the data directory
/// or Kalzit's own database folder.
pub async fn check_dir(state: &AppState, raw: &str) -> ApiResult<PathBuf> {
    let refused = || {
        field_error(
            "path",
            "backup.path_refused",
            "the directory is not below a directory allowed in backups.allowed_dirs, does not exist, or is in Kalzit's data directory",
        )
    };
    let path = Path::new(raw);
    if !path.is_absolute() {
        return Err(field_error("path", "backup.path_invalid", "enter an absolute directory path"));
    }
    let allowed = crate::settings::get(state, "backups.allowed_dirs").await?;
    let allowed: Vec<PathBuf> = allowed
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter_map(|d| std::fs::canonicalize(d).ok())
        .filter(|d| d.is_dir())
        .collect();
    let canonical = std::fs::canonicalize(path).map_err(|_| refused())?;
    let data_dir =
        std::fs::canonicalize(&state.config.paths.data_dir).unwrap_or_else(|_| state.config.paths.data_dir.clone());
    let own_db = crate::db::sqlite_file(&state.config.database_url())
        .and_then(|f| f.parent().map(Path::to_path_buf))
        .and_then(|d| std::fs::canonicalize(d).ok());
    let plugins = std::fs::canonicalize(state.config.plugins_dir()).ok();
    let inside_own = canonical.starts_with(&data_dir)
        || own_db.as_ref().is_some_and(|d| canonical.starts_with(d))
        || plugins.as_ref().is_some_and(|d| canonical.starts_with(d));
    if inside_own || !canonical.is_dir() || !allowed.iter().any(|d| canonical.starts_with(d)) {
        return Err(refused());
    }
    Ok(canonical)
}

/// What a test or a run needs to reach the target.
pub enum Reach {
    Local(PathBuf),
    S3(Box<S3Reach>),
}

/// An S3 target ready to use.
pub struct S3Reach {
    pub bucket: s3::Bucket,
    pub prefix: String,
    pub client: crate::http::HttpClient,
}

fn s3_error(f: s3::Failure) -> ApiError {
    let field = match f.reason {
        "backup.credentials_refused" => Some("secretAccessKey"),
        "backup.bucket_not_found" => Some("bucket"),
        "backup.target_blocked" | "backup.endpoint_invalid" | "backup.target_unreachable" => Some("endpoint"),
        _ => None,
    };
    let mut e = ApiError::new(axum::http::StatusCode::BAD_GATEWAY, "datasource_error", f.message.clone())
        .because(f.reason)
        .param("detail", &f.message);
    if let Some(field) = field {
        e = e.with_field(field);
    }
    e
}

/// Resolves `target` into what reaches it: the checked directory, or the bucket with an HTTP
/// client under the target rules and the outbound proxy (failing closed when the proxy setting
/// cannot be read).
pub async fn reach(state: &AppState, target: &Target, secret: Option<Zeroizing<String>>) -> ApiResult<Reach> {
    match target {
        Target::Local { path } => Ok(Reach::Local(check_dir(state, path).await?)),
        Target::S3 { endpoint, region, bucket, prefix, path_style, access_key_id } => {
            let endpoint_url = url::Url::parse(endpoint)
                .map_err(|_| field_error("endpoint", "backup.endpoint_invalid", "the store's address is not a URL"))?;
            if crate::routes::ai::is_kalzit_itself(state, &endpoint_url) {
                return Err(field_error(
                    "endpoint",
                    "backup.target_blocked",
                    "the store's address points at this Kalzit server",
                ));
            }
            let policy = state.datasources.policy(state).await?;
            let proxy = crate::outbound::current(state).await?;
            let guard = local_guard(state, &endpoint_url);
            let client = crate::http::client_proxied(
                HttpOptions { timeout: s3::TIMEOUT, extra_root_pem: None, policy },
                guard,
                proxy,
            )
            .map_err(|e| ApiError::internal("the backup target's HTTP client", e))?;
            let secret = secret.ok_or_else(|| {
                field_error(
                    "secretAccessKey",
                    "backup.secret_required",
                    "enter the secret access key for this store and key id",
                )
            })?;
            Ok(Reach::S3(Box::new(S3Reach {
                bucket: s3::Bucket {
                    endpoint: endpoint_url,
                    region: region.clone(),
                    bucket: bucket.clone(),
                    path_style: *path_style,
                    access_key_id: access_key_id.clone(),
                    secret_access_key: secret,
                },
                prefix: prefix.clone(),
                client,
            })))
        }
    }
}

/// Every address of this computer is refused when the store's port is one of Kalzit's own
/// listening ports, so a target never reaches Kalzit itself.
fn local_guard(state: &AppState, url: &url::Url) -> Option<crate::http::LocalGuard> {
    let port = url.port_or_known_default()?;
    let own = [state.config.http_addr(), state.config.https_addr()];
    own.iter().flatten().any(|l| l.port() == port).then(|| crate::http::LocalGuard {
        refused: crate::datasources::Detail::new(
            "backup.target_blocked",
            "the store's address points at this Kalzit server",
        ),
        private: None,
    })
}

/// Writes a small file to the target and deletes it again: proves that backups can be stored
/// and retention can delete them.
pub async fn test(state: &AppState, reach: &Reach) -> ApiResult<()> {
    let name = format!(".kalzit-test-{}", crate::routes::new_id());
    match reach {
        Reach::Local(dir) => {
            let file = dir.join(&name);
            let written =
                std::fs::write(&file, b"kalzit backup target test").and_then(|()| std::fs::remove_file(&file));
            written.map_err(|e| {
                field_error("path", "backup.path_not_writable", format!("Kalzit cannot write to the directory: {e}"))
                    .param("detail", e)
            })
        }
        Reach::S3(s3_reach) => {
            let S3Reach { bucket, prefix, client } = &**s3_reach;
            let store = s3::Store { bucket, client, clock: state.clock.as_ref() };
            let key = format!("{prefix}{name}");
            store.put(&key, b"kalzit backup target test".to_vec()).await.map_err(s3_error)?;
            store.delete(&key).await.map_err(s3_error)?;
            Ok(())
        }
    }
}

/// One run as the history lists it.
#[derive(Clone, Debug, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    pub id: String,
    /// `scheduled` or `manual`.
    pub kind: String,
    /// `local` or `s3`.
    pub target_kind: String,
    /// `running`, `succeeded` or `failed`.
    pub status: String,
    pub file_name: Option<String>,
    pub size_bytes: Option<i64>,
    /// Older backups retention deleted after this one.
    pub deleted_count: i64,
    /// The `backup.*` reason of a failure.
    pub reason: Option<String>,
    pub detail: Option<String>,
    pub started_by: Option<String>,
    pub started_at: i64,
    pub finished_at: Option<i64>,
}

pub const RUN_COLUMNS: &str = "SELECT id, kind, target_kind, status, file_name, size_bytes, deleted_count, reason, detail, \
                               started_by, started_at, finished_at FROM backup_runs";

/// Whether the backup holds Kalzit's own database (SQLite). With PostgreSQL it holds the files
/// only; the database is backed up with `pg_dump`.
pub fn supported(state: &AppState) -> bool {
    crate::db::sqlite_file(&state.config.database_url()).is_some()
}

/// The UTC file name of a backup taken at `now_ms`.
pub fn file_name(now_ms: i64, encrypted: bool) -> String {
    let at = chrono::DateTime::from_timestamp_millis(now_ms).unwrap_or_default();
    let suffix = if encrypted { ENCRYPTED_SUFFIX } else { FILE_SUFFIX };
    format!("{FILE_PREFIX}{}{suffix}", at.format("%Y%m%dT%H%M%S%.3fZ"))
}

/// The time a backup file name carries, for retention; `None` for any other file.
pub fn time_of(name: &str) -> Option<i64> {
    let rest = name.strip_prefix(FILE_PREFIX)?;
    let stamp = rest.strip_suffix(ENCRYPTED_SUFFIX).or_else(|| rest.strip_suffix(FILE_SUFFIX))?;
    let parsed = chrono::NaiveDateTime::parse_from_str(stamp, "%Y%m%dT%H%M%S%.3fZ").ok()?;
    Some(parsed.and_utc().timestamp_millis())
}

/// The backups retention deletes: all but the newest `keep_count` (at least one stays).
pub fn to_delete(names: &[String], keep_count: usize) -> Vec<String> {
    let mut dated: Vec<(i64, &String)> = names.iter().filter_map(|n| Some((time_of(n)?, n))).collect();
    dated.sort_by(|a, b| b.cmp(a));
    dated.iter().skip(keep_count.max(1)).map(|(_, n)| (*n).clone()).collect()
}

/// Copies `src` into the zip under `name`, streamed.
fn add_file(zip: &mut zip::ZipWriter<std::fs::File>, src: &Path, name: &str) -> io::Result<()> {
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .large_file(true)
        .unix_permissions(0o600);
    zip.start_file(name, options).map_err(io::Error::other)?;
    let mut input = std::fs::File::open(src)?;
    io::copy(&mut input, zip)?;
    Ok(())
}

/// Adds every regular file below `dir` (links are left out) as `<prefix>/<relative path>`,
/// skipping the subfolders named in `skip`.
fn add_dir(zip: &mut zip::ZipWriter<std::fs::File>, dir: &Path, prefix: &str, skip: &[&str]) -> io::Result<()> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Ok(()) };
    for entry in entries {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let kind = entry.file_type()?;
        let path = format!("{prefix}/{name}");
        if kind.is_dir() {
            if !skip.contains(&name.as_str()) {
                add_dir(zip, &entry.path(), &path, &[])?;
            }
        } else if kind.is_file() {
            add_file(zip, &entry.path(), &path)?;
        }
    }
    Ok(())
}

/// The run detail of an unencrypted backup of a server with a configuration file.
pub const TOML_LEFT_OUT: &str = "kalzit.toml was left out: it may hold secrets, and the backup is not encrypted";

/// What a backup of a server on PostgreSQL holds instead of the database.
pub const POSTGRES_NOTE: &str = "This backup holds Kalzit's files (acme/, plugins/, kalzit.toml) but not its database,\n\
which is PostgreSQL. Back the database up with pg_dump (docs/guide/backup.md, \"PostgreSQL\").\n\
The secrets key is never part of a backup; keep it apart.\n";

/// Takes the snapshot into a private work folder: the database through `VACUUM INTO` (SQLite
/// only), then the zip with it, `acme/`, `plugins/` (without the run and upload folders) and
/// `kalzit.toml`, encrypted with the secrets key when `encrypt`. Answers the file's path; the
/// caller removes the work folder.
async fn snapshot(state: &AppState, work: &Path, name: &str, encrypt: bool) -> Result<PathBuf, (&'static str, String)> {
    let failed = |e: io::Error| ("backup.snapshot_failed", e.to_string());
    std::fs::create_dir_all(work).map_err(failed)?;
    let db_copy = work.join("kalzit.db");
    let with_db = supported(state);
    if with_db {
        let db_path =
            db_copy.to_str().ok_or(("backup.snapshot_failed", "the data directory path is not UTF-8".to_string()))?;
        sqlx::query("VACUUM INTO $1")
            .bind(db_path)
            .execute(&state.db)
            .await
            .map_err(|e| ("backup.snapshot_failed", e.to_string()))?;
    }
    let data_dir = state.config.paths.data_dir.clone();
    let plugins_dir = state.config.plugins_dir();
    let plugins_moved = state.config.plugins_dir_moved();
    let config_file = state.config.config_file.clone();
    let zip_path = work.join("backup.zip");
    let out_path = work.join(name);
    let keyring = state.secrets.clone();
    let (zip2, out2) = (zip_path.clone(), out_path.clone());
    tokio::task::spawn_blocking(move || -> io::Result<()> {
        let target = if encrypt { &zip2 } else { &out2 };
        let mut zip = zip::ZipWriter::new(std::fs::File::create(target)?);
        if with_db {
            add_file(&mut zip, &db_copy, "kalzit.db")?;
        } else {
            let options = zip::write::SimpleFileOptions::default();
            zip.start_file("README.txt", options).map_err(io::Error::other)?;
            io::Write::write_all(&mut zip, POSTGRES_NOTE.as_bytes())?;
        }
        add_dir(&mut zip, &data_dir.join("acme"), "acme", &[])?;
        // A moved plugin folder is packed only when it is Kalzit's own, never a general one
        // `paths.plugins_dir` points at; `plugins` in the data directory is packed as it is.
        if plugins_moved {
            crate::data_dir::check_plugins_dir_own(&plugins_dir).map_err(|e| io::Error::other(format!("{e:#}")))?;
        }
        add_dir(&mut zip, &plugins_dir, "plugins", &["run", "uploads"])?;
        // The configuration may hold secrets: only in an encrypted backup.
        if let Some(file) = config_file.filter(|f| encrypt && f.is_file()) {
            add_file(&mut zip, &file, "kalzit.toml")?;
        }
        zip.finish().map_err(io::Error::other)?.sync_all()?;
        if with_db {
            std::fs::remove_file(&db_copy)?;
        }
        if encrypt {
            let mut input = io::BufReader::new(std::fs::File::open(&zip2)?);
            let mut output = io::BufWriter::new(std::fs::File::create(&out2)?);
            archive::encrypt(&keyring, &mut input, &mut output)?;
            io::Write::flush(&mut output)?;
            output.into_inner().map_err(|e| e.into_error())?.sync_all()?;
            std::fs::remove_file(&zip2)?;
        }
        Ok(())
    })
    .await
    .map_err(|e| ("backup.snapshot_failed", e.to_string()))?
    .map_err(failed)?;
    Ok(out_path)
}

/// Stores the file at the target, then applies retention. Answers the size and how many older
/// backups were deleted.
async fn store(
    state: &AppState,
    reach: &Reach,
    file: &Path,
    name: &str,
) -> Result<(u64, usize), (&'static str, String)> {
    let keep_count =
        crate::settings::get(state, "backups.keep_count").await.ok().and_then(|v| v.as_i64()).unwrap_or(14);
    let keep = keep_count.max(1) as usize;
    match reach {
        Reach::Local(dir) => {
            let failed = |e: io::Error| ("backup.path_not_writable", e.to_string());
            let partial = dir.join(format!("{name}.partial"));
            let size = std::fs::copy(file, &partial).map_err(failed)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&partial, std::fs::Permissions::from_mode(0o600)).map_err(failed)?;
            }
            std::fs::rename(&partial, dir.join(name)).map_err(failed)?;
            let names: Vec<String> = std::fs::read_dir(dir)
                .map_err(failed)?
                .flatten()
                .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect();
            let mut deleted = 0;
            for old in to_delete(&names, keep) {
                match std::fs::remove_file(dir.join(&old)) {
                    Ok(()) => deleted += 1,
                    Err(e) => tracing::warn!("retention could not delete the backup {old}: {e}"),
                }
            }
            Ok((size, deleted))
        }
        Reach::S3(s3_reach) => {
            let S3Reach { bucket, prefix, client } = &**s3_reach;
            let store = s3::Store { bucket, client, clock: state.clock.as_ref() };
            let size = store.upload(&format!("{prefix}{name}"), file).await.map_err(|f| (f.reason, f.message))?;
            let listed = store.list(&format!("{prefix}{FILE_PREFIX}")).await.map_err(|f| (f.reason, f.message))?;
            // Only files directly under the prefix: a backup of another folder is not ours.
            let names: Vec<String> = listed
                .iter()
                .filter_map(|o| o.key.strip_prefix(prefix.as_str()))
                .filter(|n| !n.contains('/'))
                .map(str::to_string)
                .collect();
            let mut deleted = 0;
            for old in to_delete(&names, keep) {
                match store.delete(&format!("{prefix}{old}")).await {
                    Ok(()) => deleted += 1,
                    Err(f) => tracing::warn!("retention could not delete the backup {old}: {}", f.message),
                }
            }
            Ok((size, deleted))
        }
    }
}

/// The reasons a backup answers with (docs/api/backups.md, "Reasons").
pub const REASONS: &[&str] = &[
    "backup.access_key_invalid",
    "backup.bucket_invalid",
    "backup.bucket_not_found",
    "backup.credentials_refused",
    "backup.endpoint_invalid",
    "backup.interrupted",
    "backup.no_target",
    "backup.path_invalid",
    "backup.path_not_writable",
    "backup.path_refused",
    "backup.prefix_invalid",
    "backup.region_invalid",
    "backup.running",
    "backup.secret_invalid",
    "backup.secret_required",
    "backup.snapshot_failed",
    "backup.target_blocked",
    "backup.target_failed",
    "backup.target_timeout",
    "backup.target_unreachable",
];

/// The backup reason of an error, `backup.target_failed` for any other.
pub fn reason_of(e: &ApiError) -> &'static str {
    let code = e.reason.as_ref().map(|r| r.code.as_str()).unwrap_or_default();
    REASONS.iter().find(|r| **r == code).copied().unwrap_or("backup.target_failed")
}

/// Why a run did not start.
pub fn busy() -> ApiError {
    ApiError::new(axum::http::StatusCode::CONFLICT, "conflict", "a backup is running already").because("backup.running")
}

/// Takes a backup now and stores it at the saved target: `manual` (asked for, `by` the admin) or
/// `scheduled`. The run is recorded and audited whatever happens; a failure answers with its
/// reason after it was recorded.
pub async fn run(state: &AppState, kind: &'static str, by: Option<&str>, address: Option<&str>) -> ApiResult<Run> {
    let _running = state.backups.running.try_lock().map_err(|_| busy())?;
    let (target, _) = load_target(&state.db).await?;
    let Some(target) = target else {
        return Err(ApiError::new(axum::http::StatusCode::CONFLICT, "conflict", "no backup target is saved")
            .because("backup.no_target"));
    };
    let now = state.clock.now_ms();
    let id = crate::routes::new_id();
    let mut tx = crate::db::begin(&state.db).await?;
    sqlx::query(
        "UPDATE backup_runs SET status = 'failed', reason = 'backup.interrupted', finished_at = $1 \
         WHERE status = 'running' AND started_at < $2",
    )
    .bind(now)
    .bind(now - STALE_RUN_MS)
    .execute(&mut *tx)
    .await?;
    sqlx::query("DELETE FROM backup_runs WHERE started_at < $1").bind(now - HISTORY_MS).execute(&mut *tx).await?;
    sqlx::query(
        "INSERT INTO backup_runs (id, kind, target_kind, status, deleted_count, started_by, started_at) \
         VALUES ($1, $2, $3, 'running', 0, $4, $5)",
    )
    .bind(&id)
    .bind(kind)
    .bind(target.kind())
    .bind(by)
    .bind(now)
    .execute(&mut *tx)
    .await?;
    crate::db::commit(tx).await?;

    let encrypt = crate::settings::get(state, "backups.encrypt").await?.as_bool() != Some(false);
    let name = file_name(now, encrypt);
    let toml_left_out = !encrypt && state.config.config_file.as_ref().is_some_and(|f| f.is_file());
    let work = state.config.paths.data_dir.join("backup-work").join(&id);
    let outcome: Result<(u64, usize), (&'static str, String)> = async {
        let secret = load_secret(state).await.map_err(|e| ("backup.target_failed", e.message.clone()))?;
        let reach = reach(state, &target, secret).await.map_err(|e| (reason_of(&e), e.message.clone()))?;
        let zip = snapshot(state, &work, &name, encrypt).await?;
        store(state, &reach, &zip, &name).await
    }
    .await;
    if let Err(e) = std::fs::remove_dir_all(&work)
        && e.kind() != io::ErrorKind::NotFound
    {
        tracing::warn!("removing the backup work folder {} failed: {e}", work.display());
    }
    let finished = state.clock.now_ms();
    let mut tx = crate::db::begin(&state.db).await?;
    let (action, summary) = match &outcome {
        Ok((size, deleted)) => {
            sqlx::query(
                "UPDATE backup_runs SET status = 'succeeded', file_name = $1, size_bytes = $2, deleted_count = $3, \
                 finished_at = $4, detail = $6 WHERE id = $5",
            )
            .bind(&name)
            .bind(*size as i64)
            .bind(*deleted as i64)
            .bind(finished)
            .bind(&id)
            .bind(toml_left_out.then_some(TOML_LEFT_OUT))
            .execute(&mut *tx)
            .await?;
            (
                "backup.completed",
                json!({ "runId": id, "kind": kind, "target": target.kind(), "file": name, "deleted": deleted }),
            )
        }
        Err((reason, detail)) => {
            tracing::warn!("the backup {id} failed: {detail}");
            let detail: String = detail.chars().take(MAX_TEXT).collect();
            sqlx::query(
                "UPDATE backup_runs SET status = 'failed', reason = $1, detail = $2, finished_at = $3 WHERE id = $4",
            )
            .bind(*reason)
            .bind(&detail)
            .bind(finished)
            .bind(&id)
            .execute(&mut *tx)
            .await?;
            ("backup.failed", json!({ "runId": id, "kind": kind, "target": target.kind(), "reason": reason }))
        }
    };
    let event = crate::audit::AuditEvent {
        org_id: None,
        actor_user_id: by,
        actor_address: address.map(str::to_string),
        action,
        resource_type: Some("backup"),
        resource_id: Some(&id),
        summary,
        at_ms: finished,
    };
    crate::audit::record(&mut tx, &event).await?;
    crate::db::commit(tx).await?;
    let run: Run = sqlx::query_as(sqlx::AssertSqlSafe(format!("{RUN_COLUMNS} WHERE id = $1")))
        .bind(&id)
        .fetch_one(&state.db)
        .await?;
    Ok(run)
}

/// The schedule as the settings say: `Some(interval)` while scheduled backups are on.
pub async fn schedule(state: &AppState) -> ApiResult<Option<i64>> {
    if crate::settings::get(state, "backups.schedule_enabled").await?.as_bool() != Some(true) {
        return Ok(None);
    }
    let hours = crate::settings::get(state, "backups.interval_hours").await?.as_i64().unwrap_or(24).max(1);
    Ok(Some(hours * 3_600_000))
}

/// When the next scheduled backup is due: `interval` after the last scheduled run started, at
/// once when there was none.
pub async fn next_due(state: &AppState, interval_ms: i64) -> ApiResult<i64> {
    let last: Option<(i64,)> =
        sqlx::query_as("SELECT started_at FROM backup_runs WHERE kind = 'scheduled' ORDER BY started_at DESC LIMIT 1")
            .fetch_optional(&state.db)
            .await?;
    Ok(last.map_or(0, |(at,)| at + interval_ms))
}

/// One look of the schedule: runs a backup when one is due.
async fn tick(state: &AppState) -> ApiResult<()> {
    let Some(interval) = schedule(state).await? else { return Ok(()) };
    if load_target(&state.db).await?.0.is_none() {
        return Ok(());
    }
    if state.clock.now_ms() < next_due(state, interval).await? {
        return Ok(());
    }
    match run(state, "scheduled", None, None).await {
        // A failed run is recorded in the history and the audit log; the next one is due after
        // the interval like after a success.
        Ok(_) => Ok(()),
        Err(e) if reason_of(&e) == "backup.running" => Ok(()),
        Err(e) => Err(e),
    }
}

/// Starts the schedule: every minute the leader (alone: this server) looks whether a backup is
/// due.
pub fn spawn(state: AppState) {
    let cluster_state = state.clone();
    let secs = Duration::from_secs;
    let schedule = crate::db::Schedule { interval: secs(60), retries: vec![secs(2), secs(10)] };
    crate::cluster::spawn_job(&cluster_state, "backups:schedule", "taking scheduled backups", schedule, move || {
        let state = state.clone();
        async move {
            tick(&state).await.map_err(|e| {
                if e.code == "busy" {
                    crate::db::JobError::Busy(e.message)
                } else {
                    crate::db::JobError::Failed(e.message)
                }
            })
        }
    });
}

/// For the view: the run history's newest entry.
pub async fn last_run(state: &AppState) -> ApiResult<Option<Run>> {
    Ok(sqlx::query_as(sqlx::AssertSqlSafe(format!("{RUN_COLUMNS} ORDER BY started_at DESC, id DESC LIMIT 1")))
        .fetch_optional(&state.db)
        .await?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_names_carry_their_time() {
        let name = file_name(1_800_000_000_123, false);
        assert_eq!(name, "kalzit-backup-20270115T080000.123Z.zip");
        assert_eq!(time_of(&name), Some(1_800_000_000_123));
        let sealed = file_name(1_800_000_000_123, true);
        assert_eq!(sealed, "kalzit-backup-20270115T080000.123Z.zip.enc");
        assert_eq!(time_of(&sealed), Some(1_800_000_000_123));
        assert_eq!(time_of("kalzit.db"), None);
        assert_eq!(time_of("kalzit-backup-x.zip"), None);
    }

    #[test]
    fn retention_keeps_the_newest_by_count() {
        let day = 24 * 3_600_000;
        let now = 1_800_000_000_000;
        let names: Vec<String> =
            (0..5).map(|d| file_name(now - d * day, d % 2 == 0)).chain(["notes.txt".to_string()]).collect();
        assert_eq!(to_delete(&names, 3), vec![names[3].clone(), names[4].clone()]);
        assert!(to_delete(&names, 14).is_empty());
        // At least the newest stays.
        assert_eq!(to_delete(&names, 0).len(), 4);
    }
    #[test]
    fn targets_are_checked_field_by_field() {
        let s3 = |endpoint: &str, bucket: &str| Target::S3 {
            endpoint: endpoint.into(),
            region: "eu-central-1".into(),
            bucket: bucket.into(),
            prefix: "kalzit/".into(),
            path_style: true,
            access_key_id: "AKIA".into(),
        };
        assert!(check(&s3("https://s3.example.com", "backups")).is_ok());
        let field = |t: Target| check(&t).unwrap_err().field;
        assert_eq!(field(s3("https://s3.example.com/path", "backups")), Some("endpoint"));
        assert_eq!(field(s3("ftp://s3.example.com", "backups")), Some("endpoint"));
        assert_eq!(field(s3("https://user:pw@s3.example.com", "backups")), Some("endpoint"));
        assert_eq!(field(s3("https://s3.example.com", "Bad_Bucket")), Some("bucket"));
        assert_eq!(field(Target::Local { path: "relative/dir".into() }), Some("path"));
        let normalized = s3(" https://s3.example.com/ ", "backups").normalized();
        assert!(matches!(normalized, Target::S3 { ref endpoint, .. } if endpoint == "https://s3.example.com"));
    }
}
