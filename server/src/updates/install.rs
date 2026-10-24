//! Putting a release in place and returning from it: the files under `<data dir>/updates`, the
//! database backup, the binary swap, the plan the next start reads, kept versions and the
//! history. Everything here works on paths, so tests run it on a temporary directory with fake
//! binaries.
//!
//! Layout of `<data dir>/updates`:
//!
//! | Path | What |
//! |---|---|
//! | `staging/` | the downloaded or uploaded release, signatures verified (`staging.rs`) |
//! | `versions/<version>/` | the signed manifest of an installed release, and once it was left its binary with `info.json` (schema, backup, SHA-256), for a return |
//! | `backups/` | database backups (mode 0600 on Unix) with a `.json` record each |
//! | `plan.json` | the switch in progress, read by the next start (`boot.rs`) |
//! | `history.json` | installed and returned versions, newest first |
//! | `state.json` | the last check and a planned installation |
//!
//! Nothing read from these folders is trusted for what it does: a binary is copied once from an
//! open file into the binary's own folder and checked there against a signed or recorded SHA-256
//! before it runs or replaces anything (`place_binary`), paths are derived from versions and file
//! names rather than taken from JSON, and backups are only taken from `backups/`.

use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::UpdateError;
use super::platform::Platform;
use super::signing::{self, TrustedKeys};
use crate::error::ApiResult;

/// The most history entries kept.
const MAX_HISTORY: usize = 50;
/// The plan format this build writes and reads.
pub const PLAN_FORMAT: u32 = 2;
const MANIFEST_RECORD: &str = "manifest.json";
const SIGNATURE_RECORD: &str = "manifest.json.sig";

#[derive(Clone, Debug)]
pub struct Layout {
    root: PathBuf,
}

impl Layout {
    pub fn new(data_dir: &Path) -> Self {
        Self { root: data_dir.join("updates") }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn staging(&self) -> PathBuf {
        self.root.join("staging")
    }

    pub fn versions(&self) -> PathBuf {
        self.root.join("versions")
    }

    pub fn backups(&self) -> PathBuf {
        self.root.join("backups")
    }

    pub fn plan_file(&self) -> PathBuf {
        self.root.join("plan.json")
    }

    pub fn history_file(&self) -> PathBuf {
        self.root.join("history.json")
    }

    pub fn state_file(&self) -> PathBuf {
        self.root.join("state.json")
    }
}

/// Creates `path` as a new file: a stale one is removed first, and `create_new` never follows a
/// link someone left in its place.
fn create_fresh(path: &Path) -> io::Result<fs::File> {
    match fs::remove_file(path) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Err(e),
    }
    fs::OpenOptions::new().write(true).create_new(true).open(path)
}

/// Opens a file the service account may control (in the data directory) for reading: a link in
/// its place is refused rather than followed (Unix `O_NOFOLLOW`, Windows a reparse point opened
/// as itself), opening does not block on a FIFO (`O_NONBLOCK`), and what was opened must be a
/// regular file.
pub fn open_regular(path: &Path) -> io::Result<fs::File> {
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // FILE_FLAG_OPEN_REPARSE_POINT
        options.custom_flags(0x0020_0000);
    }
    let file = options.open(path)?;
    let meta = file.metadata()?;
    if !meta.file_type().is_file() || meta.file_type().is_symlink() {
        return Err(io::Error::other(format!("{} is not a regular file", path.display())));
    }
    Ok(file)
}

fn read_regular(path: &Path) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    open_regular(path)?.read_to_end(&mut bytes)?;
    Ok(bytes)
}

/// Unix: readable and writable by the owner only.
fn private(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    }
    let _ = path;
    Ok(())
}

/// Writes `value` as JSON through a new temporary file and a rename, so a reader never sees half
/// a file.
pub fn write_json<T: Serialize + ?Sized>(path: &Path, value: &T) -> io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(value).map_err(io::Error::other)?;
    {
        let mut file = create_fresh(&tmp)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
    }
    fs::rename(&tmp, path)
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Option<T> {
    let bytes = fs::read(path).ok()?;
    match serde_json::from_slice(&bytes) {
        Ok(value) => Some(value),
        Err(e) => {
            tracing::warn!("ignoring {}: {e}", path.display());
            None
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PlanKind {
    /// To a newer release.
    Update,
    /// Back to a kept version.
    Rollback,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PlanState {
    /// The new binary is in place; its first start begins the trial.
    Swapped,
    /// The new binary started and has not confirmed its health yet. A start that finds this
    /// state returns: the trial ended without a confirmation (a crash, a kill).
    Trial,
    /// The trial failed; the next start returns.
    RollbackRequested,
    /// The previous binary and database are back; the previous version records it at its start.
    RolledBack,
}

/// A switch between two versions, from the moment the new binary is in place until it confirmed
/// its health or Kalzit returned.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    /// `PLAN_FORMAT`.
    pub format: u32,
    pub kind: PlanKind,
    pub from: String,
    pub to: String,
    /// The binary that runs Kalzit.
    pub exe: PathBuf,
    /// SHA-256 and size of the kept binary of `from` (`versions/<from>/<binary name>`), checked
    /// before it is put back.
    pub previous_sha256: String,
    pub previous_size: u64,
    /// The file name in `backups/` of the database backup taken before the switch (SQLite).
    pub backup: Option<String>,
    /// The SQLite database file; `None` for PostgreSQL.
    pub database: Option<PathBuf>,
    /// The schema version of `from`.
    pub schema: i64,
    /// PostgreSQL: the new version changed the schema, so the previous binary could not start
    /// on it; Kalzit then keeps the new version instead of returning.
    #[serde(default)]
    pub migrated: bool,
    pub state: PlanState,
    pub created_at: i64,
    /// How long the new version has to report healthy.
    pub health_timeout_secs: u64,
    /// Who started it, for the audit log.
    pub actor: Option<String>,
    /// Why Kalzit returned.
    pub error: Option<String>,
    /// `online` (downloaded), `offline` (uploaded) or `kept` (a return to a kept version).
    pub source: String,
    /// Started by a planned installation.
    pub scheduled: bool,
    /// The return was written to the history (the audit entry may still be missing).
    #[serde(default)]
    pub recorded: bool,
}

/// The plan, if there is one. A plan that cannot be read, or one of another format, is an error:
/// a switch is in progress that this build does not understand.
pub fn read_plan_checked(layout: &Layout) -> Result<Option<Plan>, String> {
    let bytes = match fs::read(layout.plan_file()) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("reading {}: {e}", layout.plan_file().display())),
    };
    let plan: Plan = serde_json::from_slice(&bytes)
        .map_err(|e| format!("{} is not a plan this version understands: {e}", layout.plan_file().display()))?;
    if plan.format != PLAN_FORMAT {
        return Err(format!(
            "{} has format {}, this version writes {PLAN_FORMAT}",
            layout.plan_file().display(),
            plan.format
        ));
    }
    Ok(Some(plan))
}

/// The plan for callers that only look at it; an unreadable one is logged and treated as none.
pub fn read_plan(layout: &Layout) -> Option<Plan> {
    read_plan_checked(layout).unwrap_or_else(|e| {
        tracing::error!("{e}");
        None
    })
}

pub fn write_plan(layout: &Layout, plan: &Plan) -> io::Result<()> {
    write_json(&layout.plan_file(), plan)
}

pub fn remove_plan(layout: &Layout) {
    if let Err(e) = fs::remove_file(layout.plan_file())
        && e.kind() != io::ErrorKind::NotFound
    {
        tracing::warn!("removing the update plan failed: {e}");
    }
}

/// Keeps a plan that no longer fits the running version aside, for the operator to look at.
pub fn archive_plan(layout: &Layout, now: i64, why: &str) {
    let target = layout.root().join(format!("plan-{now}.{why}.json"));
    if let Err(e) = fs::rename(layout.plan_file(), &target) {
        tracing::warn!("moving the update plan aside failed: {e}");
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DatabaseKind {
    Sqlite,
    Postgres,
}

impl DatabaseKind {
    pub fn name(self) -> &'static str {
        match self {
            DatabaseKind::Sqlite => "sqlite",
            DatabaseKind::Postgres => "postgres",
        }
    }
}

pub fn database_kind(url: &str) -> DatabaseKind {
    if url.starts_with("sqlite:") { DatabaseKind::Sqlite } else { DatabaseKind::Postgres }
}

/// The SQLite database file, `None` for PostgreSQL and in-memory databases.
pub fn sqlite_file(url: &str) -> Option<PathBuf> {
    crate::db::sqlite_file(url)
}

/// The newest migration applied to Kalzit's database. Two versions with the same number can use
/// the same database.
pub async fn schema_version(db: &sqlx::AnyPool) -> ApiResult<i64> {
    let (version,): (i64,) =
        sqlx::query_as("SELECT COALESCE(MAX(version), 0) FROM _sqlx_migrations WHERE success").fetch_one(db).await?;
    Ok(version)
}

/// Why a backup was taken.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BackupKind {
    /// Before a switch away from `version`.
    Switch,
    /// Asked for on the Updates page.
    Manual,
}

/// What `backups/<file>.json` records next to a backup.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupMeta {
    /// The version that wrote the database.
    pub version: String,
    pub at: i64,
    pub kind: BackupKind,
    /// The user who asked for a manual backup.
    pub by: Option<String>,
}

/// A backup as the Updates page lists it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupInfo {
    pub file: String,
    pub size: u64,
    #[serde(flatten)]
    pub meta: BackupMeta,
}

fn meta_path(backup: &Path) -> PathBuf {
    backup.with_file_name(format!("{}.json", backup.file_name().unwrap_or_default().to_string_lossy()))
}

/// The backup file `name` in `backups/`: a plain file name of a regular file, never a link.
pub fn backup_path(layout: &Layout, name: &str) -> Option<PathBuf> {
    let plain = !name.is_empty()
        && name.ends_with(".db")
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
        && !name.starts_with('.');
    if !plain {
        return None;
    }
    let path = layout.backups().join(name);
    let meta = fs::symlink_metadata(&path).ok()?;
    (meta.file_type().is_file()).then_some(path)
}

/// A consistent copy of the SQLite database (`VACUUM INTO`, safe while the server runs), in
/// `backups/` with mode 0600 on Unix, and its `.json` record. Answers the file name; `None` for
/// PostgreSQL, which Kalzit cannot back up itself.
pub async fn backup_database(
    db: &sqlx::AnyPool,
    url: &str,
    layout: &Layout,
    version: &semver::Version,
    now: i64,
    kind: BackupKind,
    by: Option<String>,
) -> Result<Option<String>, UpdateError> {
    if sqlite_file(url).is_none() {
        return Ok(None);
    }
    let failed = |e: io::Error| UpdateError::BackupFailed(e.to_string());
    let dir = layout.backups();
    fs::create_dir_all(&dir).map_err(failed)?;
    let prefix = match kind {
        BackupKind::Switch => "kalzit",
        BackupKind::Manual => "manual",
    };
    let name = format!("{prefix}-{version}-{now}.db");
    let target = dir.join(&name);
    // VACUUM INTO creates the file itself, inside the private data directory; it is narrowed to
    // the owner right after.
    let path =
        target.to_str().ok_or_else(|| UpdateError::BackupFailed("the data directory path is not UTF-8".into()))?;
    sqlx::query("VACUUM INTO $1").bind(path).execute(db).await.map_err(|e| UpdateError::BackupFailed(e.to_string()))?;
    private(&target).map_err(failed)?;
    let meta = BackupMeta { version: version.to_string(), at: now, kind, by };
    write_json(&meta_path(&target), &meta).map_err(failed)?;
    private(&meta_path(&target)).map_err(failed)?;
    Ok(Some(name))
}

/// Every backup with its record, newest first.
pub fn list_backups(layout: &Layout) -> Vec<BackupInfo> {
    let Ok(entries) = fs::read_dir(layout.backups()) else { return Vec::new() };
    let mut out: Vec<BackupInfo> = entries
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let path = backup_path(layout, &name)?;
            let meta = read_json::<BackupMeta>(&meta_path(&path))?;
            let size = e.metadata().ok()?.len();
            Some(BackupInfo { file: name, size, meta })
        })
        .collect();
    out.sort_by_key(|b| std::cmp::Reverse(b.meta.at));
    out
}

fn remove_backup(path: &Path) {
    for file in [path.to_path_buf(), meta_path(path)] {
        if let Err(e) = fs::remove_file(&file)
            && e.kind() != io::ErrorKind::NotFound
        {
            tracing::warn!("removing the backup {} failed: {e}", file.display());
        }
    }
}

/// Puts a backup in place of the SQLite database. Only while no connection is open: at a start
/// before the database opens, or after the server stopped. The WAL and shared memory files go
/// first, so the old WAL is never replayed onto the restored file.
pub fn restore_database(backup: &Path, database: &Path) -> io::Result<()> {
    let name = database.file_name().ok_or_else(|| io::Error::other("the database path has no file name"))?;
    let tmp = database.with_file_name(format!("{}.restore", name.to_string_lossy()));
    {
        let mut source = open_regular(backup)?;
        let mut out = create_fresh(&tmp)?;
        io::copy(&mut source, &mut out)?;
        out.sync_all()?;
    }
    private(&tmp)?;
    for suffix in ["-wal", "-shm"] {
        let side = database.with_file_name(format!("{}{suffix}", name.to_string_lossy()));
        match fs::remove_file(&side) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(e),
        }
    }
    fs::rename(&tmp, database)
}

/// The name of the copy next to the binary: hidden, and with the binary's extension so Windows
/// can start it for the smoke test (`.kalzit.new`, `.kalzit.new.exe`).
fn placed_name(exe: &Path) -> io::Result<PathBuf> {
    let dir = exe.parent().ok_or_else(|| io::Error::other("the binary path has no directory"))?;
    let stem = exe.file_stem().ok_or_else(|| io::Error::other("the binary path has no file name"))?.to_string_lossy();
    let ext = exe.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    Ok(dir.join(format!(".{stem}.new{ext}")))
}

/// A new binary copied into the running binary's folder and checked, not yet in place. Dropped
/// without `commit`, the copy is removed.
#[derive(Debug)]
pub struct PlacedBinary {
    path: PathBuf,
    done: bool,
}

impl PlacedBinary {
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Moves the copy over `exe`. On Windows the running binary cannot be replaced but can be
    /// renamed, so it moves aside first and is deleted at a later start (`clean_leftovers`).
    pub fn commit(mut self, exe: &Path) -> io::Result<()> {
        #[cfg(windows)]
        {
            let dir = exe.parent().ok_or_else(|| io::Error::other("the binary path has no directory"))?;
            let name = exe.file_name().unwrap_or_default().to_string_lossy();
            let stamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or_default();
            let aside = dir.join(format!(".{name}.old-{stamp}"));
            let moved = exe.exists();
            if moved {
                fs::rename(exe, &aside)?;
            }
            if let Err(e) = fs::rename(&self.path, exe) {
                if moved {
                    let _ = fs::rename(&aside, exe);
                }
                return Err(e);
            }
            // Fails while the old binary still runs; a later start removes it.
            let _ = fs::remove_file(&aside);
        }
        #[cfg(not(windows))]
        {
            fs::rename(&self.path, exe)?;
            if let Some(dir) = exe.parent()
                && let Ok(d) = fs::File::open(dir)
            {
                let _ = d.sync_all();
            }
        }
        self.done = true;
        Ok(())
    }
}

impl Drop for PlacedBinary {
    fn drop(&mut self) {
        if !self.done {
            let _ = fs::remove_file(&self.path);
        }
    }
}

/// Copies `source` into the folder of `exe` and checks the copy against `sha256` and `size`.
/// `source` is opened once and read once; what is checked, run and moved into place is the copy,
/// in a folder only whoever may replace the binary can write. The copy gets the old binary's
/// permissions on Unix.
pub fn place_binary(source: &Path, exe: &Path, sha256: &str, size: u64) -> Result<PlacedBinary, UpdateError> {
    let input = open_regular(source).map_err(|e| UpdateError::InstallFailed(e.to_string()))?;
    place_from(input, exe, sha256, size)
}

/// `place_binary` from a file opened by the caller (the command line opens it with the data
/// directory owner's rights and copies it with its own).
pub fn place_from(mut input: fs::File, exe: &Path, sha256: &str, size: u64) -> Result<PlacedBinary, UpdateError> {
    let failed = |e: io::Error| UpdateError::InstallFailed(e.to_string());
    let target = placed_name(exe).map_err(failed)?;
    let mut out = create_fresh(&target).map_err(failed)?;
    let placed = PlacedBinary { path: target, done: false };
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 64 * 1024];
    let mut copied = 0u64;
    loop {
        let n = input.read(&mut buffer).map_err(failed)?;
        if n == 0 {
            break;
        }
        copied += n as u64;
        if copied > size {
            return Err(UpdateError::SizeMismatch);
        }
        hasher.update(&buffer[..n]);
        out.write_all(&buffer[..n]).map_err(failed)?;
    }
    out.sync_all().map_err(failed)?;
    drop(out);
    if copied != size {
        return Err(UpdateError::SizeMismatch);
    }
    if hex::encode(hasher.finalize()) != sha256 {
        return Err(UpdateError::HashMismatch);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(exe).map(|m| m.permissions().mode() & 0o777).unwrap_or(0o755) | 0o100;
        fs::set_permissions(placed.path(), fs::Permissions::from_mode(mode)).map_err(failed)?;
    }
    Ok(placed)
}

/// Removes binaries moved aside by earlier swaps (Windows) and copies left by an interrupted one.
pub fn clean_leftovers(exe: &Path) {
    let (Some(dir), Some(name)) = (exe.parent(), exe.file_name()) else { return };
    let name = name.to_string_lossy();
    let prefix_old = format!(".{name}.old-");
    let placed = placed_name(exe).ok().and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()));
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let file = entry.file_name().to_string_lossy().into_owned();
        if file.starts_with(&prefix_old) || Some(&file) == placed.as_ref() {
            let _ = fs::remove_file(entry.path());
        }
    }
}

/// SHA-256 (hex) and size of what `reader` yields.
fn hash_reader(reader: &mut impl Read) -> io::Result<(String, u64)> {
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 64 * 1024];
    let mut size = 0u64;
    loop {
        let n = reader.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        hasher.update(&buffer[..n]);
        size += n as u64;
    }
    Ok((hex::encode(hasher.finalize()), size))
}

/// A binary kept for a return, as `versions/<version>/info.json` records it. Its path is always
/// `versions/<version>/<binary name>`, never read from here.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeptVersion {
    pub version: String,
    /// `schema_version` while this version ran.
    pub schema: i64,
    /// The file name in `backups/` of the backup taken when this version was left.
    pub backup: Option<String>,
    pub kept_at: i64,
    /// Of the kept binary when it was kept.
    pub sha256: String,
    pub size: u64,
}

fn version_dir(layout: &Layout, version: &str) -> Option<PathBuf> {
    // Only real versions name folders, so a request cannot point outside `versions/`.
    semver::Version::parse(version).ok()?;
    Some(layout.versions().join(version))
}

/// The folder of `version`, created if needed; a link in its place is refused.
fn own_version_dir(layout: &Layout, version: &str) -> io::Result<PathBuf> {
    let dir = version_dir(layout, version).ok_or_else(|| io::Error::other("not a version"))?;
    fs::create_dir_all(&dir)?;
    if !fs::symlink_metadata(&dir)?.file_type().is_dir() {
        return Err(io::Error::other(format!("{} is not a folder", dir.display())));
    }
    Ok(dir)
}

/// Where the kept binary of `version` lives.
pub fn kept_binary(layout: &Layout, version: &str, exe: &Path) -> Option<PathBuf> {
    Some(version_dir(layout, version)?.join(exe.file_name()?))
}

/// Records the signed manifest of a release in the folder of its version, so the binary kept
/// when that version is left can be checked against it.
pub fn record_release(layout: &Layout, version: &str, manifest: &[u8], signature: &[u8]) -> io::Result<()> {
    let dir = own_version_dir(layout, version)?;
    for (name, bytes) in [(MANIFEST_RECORD, manifest), (SIGNATURE_RECORD, signature)] {
        let tmp = dir.join(format!("{name}.tmp"));
        let mut file = create_fresh(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&tmp, dir.join(name))?;
    }
    Ok(())
}

/// Copies the running binary `exe` into the folder of `version` and records its SHA-256, size,
/// schema and backup.
pub fn keep_version(
    layout: &Layout,
    exe: &Path,
    version: &str,
    schema: i64,
    backup: Option<String>,
    now: i64,
) -> io::Result<KeptVersion> {
    keep_version_from(layout, fs::File::open(exe)?, exe, version, schema, backup, now)
}

/// `keep_version` from the binary opened by the caller.
pub fn keep_version_from(
    layout: &Layout,
    mut input: fs::File,
    exe: &Path,
    version: &str,
    schema: i64,
    backup: Option<String>,
    now: i64,
) -> io::Result<KeptVersion> {
    let dir = own_version_dir(layout, version)?;
    let name = exe.file_name().ok_or_else(|| io::Error::other("the binary path has no file name"))?;
    let binary = dir.join(name);
    let tmp = dir.join(format!("{}.tmp", name.to_string_lossy()));
    let mut out = create_fresh(&tmp)?;
    let (sha256, size) = {
        let mut hasher = Sha256::new();
        let mut buffer = vec![0u8; 64 * 1024];
        let mut size = 0u64;
        loop {
            let n = input.read(&mut buffer)?;
            if n == 0 {
                break;
            }
            hasher.update(&buffer[..n]);
            out.write_all(&buffer[..n])?;
            size += n as u64;
        }
        (hex::encode(hasher.finalize()), size)
    };
    out.sync_all()?;
    drop(out);
    fs::rename(&tmp, &binary)?;
    let kept = KeptVersion { version: version.to_string(), schema, backup, kept_at: now, sha256, size };
    write_json(&dir.join("info.json"), &kept)?;
    Ok(kept)
}

pub fn kept_version(layout: &Layout, version: &str) -> Option<KeptVersion> {
    let dir = version_dir(layout, version)?;
    read_json::<KeptVersion>(&dir.join("info.json")).filter(|k| k.version == version)
}

/// A kept binary with the SHA-256 it must have.
#[derive(Debug)]
pub struct KeptBinary {
    pub path: PathBuf,
    pub sha256: String,
    pub size: u64,
    /// The hash comes from the release's signed manifest, not only from `info.json`.
    pub signed: bool,
}

/// The kept binary of `version` and the hash it must have: from the version's signed manifest
/// when one is recorded and verifies, else from `info.json`.
pub fn verify_kept(
    layout: &Layout,
    version: &str,
    exe: &Path,
    keys: &TrustedKeys,
    platform: &Platform,
) -> Result<KeptBinary, UpdateError> {
    let unavailable = || UpdateError::RollbackUnavailable(version.to_string());
    let info = kept_version(layout, version).ok_or_else(unavailable)?;
    let dir = version_dir(layout, version).ok_or_else(unavailable)?;
    let path = kept_binary(layout, version, exe).ok_or_else(unavailable)?;
    if !fs::symlink_metadata(&path).map(|m| m.file_type().is_file()).unwrap_or(false) {
        return Err(unavailable());
    }
    let signed = match (read_regular(&dir.join(MANIFEST_RECORD)), read_regular(&dir.join(SIGNATURE_RECORD))) {
        (Ok(manifest), Ok(signature)) => signing::verify_manifest(keys, &manifest, &signature)
            .ok()
            .filter(|m| m.version == version)
            .and_then(|m| super::staging::select_package(&m, platform).ok().cloned()),
        _ => None,
    };
    Ok(match signed {
        Some(p) => KeptBinary { path, sha256: p.sha256, size: p.size, signed: true },
        None => KeptBinary { path, sha256: info.sha256, size: info.size, signed: false },
    })
}

/// Every kept version, newest first.
pub fn kept_versions(layout: &Layout, exe_name: &std::ffi::OsStr) -> Vec<KeptVersion> {
    let Ok(entries) = fs::read_dir(layout.versions()) else { return Vec::new() };
    let mut kept: Vec<KeptVersion> = entries
        .flatten()
        .filter_map(|e| e.file_name().to_str().map(str::to_string))
        .filter_map(|name| kept_version(layout, &name))
        .filter(|k| version_dir(layout, &k.version).is_some_and(|d| d.join(exe_name).is_file()))
        .collect();
    kept.sort_by(|a, b| b.kept_at.cmp(&a.kept_at).then_with(|| b.version.cmp(&a.version)));
    kept
}

/// Keeps the newest `keep` versions (never `current`) and deletes the others with their backups,
/// then backups no kept version or plan refers to; of the manual backups the newest `keep` stay.
pub fn prune(layout: &Layout, keep: usize, current: &str, exe_name: &std::ffi::OsStr) {
    let kept: Vec<KeptVersion> = kept_versions(layout, exe_name).into_iter().filter(|k| k.version != current).collect();
    for old in kept.iter().skip(keep.max(1)) {
        if let Some(dir) = version_dir(layout, &old.version)
            && let Err(e) = fs::remove_dir_all(&dir)
        {
            tracing::warn!("removing the kept version {} failed: {e}", old.version);
        }
    }
    let mut referenced: Vec<String> = kept.iter().take(keep.max(1)).filter_map(|k| k.backup.clone()).collect();
    if let Some(plan) = read_plan(layout) {
        referenced.extend(plan.backup);
    }
    referenced.extend(
        list_backups(layout)
            .into_iter()
            .filter(|b| b.meta.kind == BackupKind::Manual)
            .take(keep.max(1))
            .map(|b| b.file),
    );
    let Ok(entries) = fs::read_dir(layout.backups()) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if path.extension().is_some_and(|e| e == "json") {
            // A record goes with its backup; one without a backup is left over.
            if !path.with_extension("").exists() {
                let _ = fs::remove_file(&path);
            }
            continue;
        }
        if !referenced.contains(&name) {
            remove_backup(&path);
        }
    }
}

/// What a switch needs.
pub struct Switch {
    pub kind: PlanKind,
    pub from: String,
    pub to: String,
    /// The running binary, replaced.
    pub exe: PathBuf,
    /// The running binary, opened for keeping it.
    pub exe_file: fs::File,
    /// The signed manifest and signature of `to` (an update), recorded with its version.
    pub release: Option<(Vec<u8>, Vec<u8>)>,
    /// The file name of the backup just taken.
    pub backup: Option<String>,
    pub database: Option<PathBuf>,
    /// `schema_version` now (the `from` version's).
    pub schema: i64,
    pub health_timeout_secs: u64,
    pub actor: Option<String>,
    pub now: i64,
    /// `online`, `offline` or `kept`.
    pub source_kind: String,
    pub scheduled: bool,
}

/// Keeps the running binary, records the release, writes the plan, then moves the checked copy
/// `placed` into place. The plan comes first: a start that finds it with the old binary still in
/// place sets it aside, while the new binary always finds its plan.
pub fn prepare_update(layout: &Layout, s: Switch, placed: PlacedBinary) -> Result<Plan, UpdateError> {
    let exe = s.exe.clone();
    let plan = record_switch(layout, s)?;
    if let Err(e) = placed.commit(&exe) {
        remove_plan(layout);
        return Err(UpdateError::InstallFailed(e.to_string()));
    }
    Ok(plan)
}

/// Everything of `prepare_update` but the last step: the kept binary, the release record and the
/// plan are written. The caller keeps the checked copy and commits it (the command line does that
/// with other rights, and drops it with them when this fails); if the commit fails, it removes
/// the plan.
pub fn record_switch(layout: &Layout, s: Switch) -> Result<Plan, UpdateError> {
    let failed = |e: io::Error| UpdateError::InstallFailed(e.to_string());
    let kept =
        keep_version_from(layout, s.exe_file, &s.exe, &s.from, s.schema, s.backup.clone(), s.now).map_err(failed)?;
    if let Some((manifest, signature)) = &s.release {
        record_release(layout, &s.to, manifest, signature).map_err(failed)?;
    }
    let plan = Plan {
        format: PLAN_FORMAT,
        kind: s.kind,
        from: s.from,
        to: s.to,
        exe: s.exe.clone(),
        previous_sha256: kept.sha256,
        previous_size: kept.size,
        backup: s.backup,
        database: s.database,
        schema: s.schema,
        migrated: false,
        state: PlanState::Swapped,
        created_at: s.now,
        health_timeout_secs: s.health_timeout_secs,
        actor: s.actor,
        error: None,
        source: s.source_kind,
        scheduled: s.scheduled,
        recorded: false,
    };
    write_plan(layout, &plan).map_err(failed)?;
    Ok(plan)
}

// Returns from a failed switch: the database backup (SQLite) and the previous binary go back,
/// the binary only after its copy matched the hash recorded when it was kept. Runs at a start,
/// before the database opens.
pub fn roll_back(layout: &Layout, plan: &Plan) -> Result<(), String> {
    let previous = kept_binary(layout, &plan.from, &plan.exe).ok_or("the plan names no kept version")?;
    let placed = place_binary(&previous, &plan.exe, &plan.previous_sha256, plan.previous_size)
        .map_err(|e| format!("the kept binary of {} does not match its recorded hash: {e}", plan.from))?;
    if let (Some(name), Some(database)) = (&plan.backup, &plan.database) {
        let backup = backup_path(layout, name).ok_or_else(|| format!("the backup {name} is gone"))?;
        restore_database(&backup, database).map_err(|e| format!("restoring the database: {e}"))?;
    }
    placed.commit(&plan.exe).map_err(|e| format!("putting the binary back: {e}"))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Outcome {
    Installed,
    RolledBack,
    /// Refused or failed before anything changed (a bad signature, a failed backup).
    Aborted,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub version: String,
    pub from: Option<String>,
    pub at: i64,
    pub kind: PlanKind,
    pub outcome: Outcome,
    /// Why Kalzit returned or stopped (English, from the log).
    pub reason: Option<String>,
    /// For an aborted step: its reason code, which the UI translates.
    #[serde(default)]
    pub reason_code: Option<String>,
    /// `online`, `offline` or `kept`.
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub scheduled: bool,
    /// The user who started it; `None` for Kalzit itself.
    #[serde(default)]
    pub actor: Option<String>,
    /// From the start of the switch to its end.
    #[serde(default)]
    pub duration_ms: Option<i64>,
}

pub fn history(layout: &Layout) -> Vec<HistoryEntry> {
    read_json(&layout.history_file()).unwrap_or_default()
}

pub fn push_history(layout: &Layout, entry: HistoryEntry) {
    let mut entries = history(layout);
    entries.insert(0, entry);
    entries.truncate(MAX_HISTORY);
    if let Err(e) = write_json(&layout.history_file(), &entries) {
        tracing::warn!("saving the update history failed: {e}");
    }
}

/// The history entry of a return the plan describes.
pub fn returned_entry(plan: &Plan, now: i64) -> HistoryEntry {
    HistoryEntry {
        version: plan.to.clone(),
        from: Some(plan.from.clone()),
        at: now,
        kind: plan.kind,
        outcome: Outcome::RolledBack,
        reason: plan.error.clone(),
        reason_code: None,
        source: Some(plan.source.clone()),
        scheduled: plan.scheduled,
        actor: plan.actor.clone(),
        duration_ms: Some((now - plan.created_at).max(0)),
    }
}

/// SHA-256 (hex) and size of a file (tests and status).
pub fn hash_file(path: &Path) -> io::Result<(String, u64)> {
    hash_reader(&mut fs::File::open(path)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fake_binary(path: &Path, content: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }

    fn sha(content: &str) -> String {
        signing::sha256_hex(content.as_bytes())
    }

    fn switch(
        exe: &Path,
        source: &Path,
        content: &str,
        backup: Option<String>,
        database: Option<PathBuf>,
    ) -> (Switch, PlacedBinary) {
        let placed = place_binary(source, exe, &sha(content), content.len() as u64).unwrap();
        let s = Switch {
            kind: PlanKind::Update,
            from: "1.0.0".into(),
            to: "1.1.0".into(),
            exe: exe.to_path_buf(),
            exe_file: fs::File::open(exe).unwrap(),
            release: Some((b"{}".to_vec(), b"{}".to_vec())),
            backup,
            database,
            schema: 9,
            health_timeout_secs: 60,
            actor: Some("u1".into()),
            now: 1000,
            source_kind: "online".into(),
            scheduled: false,
        };
        (s, placed)
    }

    fn update(layout: &Layout, (s, placed): (Switch, PlacedBinary)) -> Plan {
        prepare_update(layout, s, placed).unwrap()
    }

    #[test]
    fn an_update_keeps_the_old_binary_writes_the_plan_and_swaps() {
        let dir = tempfile::tempdir().unwrap();
        let layout = Layout::new(&dir.path().join("data"));
        let exe = dir.path().join("bin").join("kalzit");
        let new = dir.path().join("new-kalzit");
        fake_binary(&exe, "old");
        fake_binary(&new, "new");
        let plan = update(&layout, switch(&exe, &new, "new", None, None));
        assert_eq!(fs::read_to_string(&exe).unwrap(), "new");
        let previous = kept_binary(&layout, "1.0.0", &exe).unwrap();
        assert_eq!(fs::read_to_string(&previous).unwrap(), "old");
        assert_eq!((plan.previous_sha256.as_str(), plan.previous_size), (sha("old").as_str(), 3));
        assert_eq!(read_plan(&layout).unwrap(), plan);
        assert_eq!(plan.state, PlanState::Swapped);
        assert_eq!(kept_version(&layout, "1.0.0").unwrap().schema, 9);
        assert!(layout.versions().join("1.1.0").join(MANIFEST_RECORD).is_file(), "the release is recorded");
        clean_leftovers(&exe);
        let names: Vec<String> = fs::read_dir(exe.parent().unwrap())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into())
            .collect();
        assert_eq!(names, ["kalzit"], "no copies are left next to the binary");
    }

    #[test]
    fn a_copy_that_does_not_match_never_reaches_the_binary() {
        let dir = tempfile::tempdir().unwrap();
        let exe = dir.path().join("bin").join("kalzit");
        let new = dir.path().join("new-kalzit");
        fake_binary(&exe, "old");
        fake_binary(&new, "evil");
        let e = place_binary(&new, &exe, &sha("new"), 4).unwrap_err();
        assert!(matches!(e, UpdateError::HashMismatch), "{e}");
        let e = place_binary(&new, &exe, &sha("evil"), 3).unwrap_err();
        assert!(matches!(e, UpdateError::SizeMismatch), "{e}");
        assert_eq!(fs::read_to_string(&exe).unwrap(), "old");
        let names: Vec<String> = fs::read_dir(exe.parent().unwrap())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into())
            .collect();
        assert_eq!(names, ["kalzit"], "a refused copy is removed");
    }

    #[test]
    fn the_checked_copy_is_what_goes_in_place_even_if_the_source_changes() {
        // Swapping the source after the copy was checked changes nothing: only the copy moves.
        let dir = tempfile::tempdir().unwrap();
        let exe = dir.path().join("bin").join("kalzit");
        let new = dir.path().join("staged");
        fake_binary(&exe, "old");
        fake_binary(&new, "signed");
        let placed = place_binary(&new, &exe, &sha("signed"), 6).unwrap();
        fs::write(&new, "swapped").unwrap();
        placed.commit(&exe).unwrap();
        assert_eq!(fs::read_to_string(&exe).unwrap(), "signed");
    }

    #[test]
    fn a_return_restores_the_database_and_the_previous_binary_after_checking_it() {
        let dir = tempfile::tempdir().unwrap();
        let layout = Layout::new(&dir.path().join("data"));
        let exe = dir.path().join("bin").join("kalzit");
        let new = dir.path().join("new-kalzit");
        let database = dir.path().join("data").join("kalzit.db");
        let backup = layout.backups().join("kalzit-1.0.0-1.db");
        fake_binary(&exe, "old");
        fake_binary(&new, "new");
        fake_binary(&database, "migrated by 1.1.0");
        fake_binary(&database.with_file_name("kalzit.db-wal"), "wal of 1.1.0");
        fake_binary(&backup, "data of 1.0.0");
        let s = switch(&exe, &new, "new", Some("kalzit-1.0.0-1.db".into()), Some(database.clone()));
        let plan = update(&layout, s);
        roll_back(&layout, &plan).unwrap();
        assert_eq!(fs::read_to_string(&exe).unwrap(), "old");
        assert_eq!(fs::read_to_string(&database).unwrap(), "data of 1.0.0");
        assert!(!database.with_file_name("kalzit.db-wal").exists(), "the new version's WAL must not be replayed");
        assert!(backup.is_file(), "the backup stays for a later look");
    }

    #[test]
    fn a_changed_kept_binary_is_not_put_back() {
        let dir = tempfile::tempdir().unwrap();
        let layout = Layout::new(&dir.path().join("data"));
        let exe = dir.path().join("bin").join("kalzit");
        let new = dir.path().join("new-kalzit");
        fake_binary(&exe, "old");
        fake_binary(&new, "new");
        let plan = update(&layout, switch(&exe, &new, "new", None, None));
        fs::write(kept_binary(&layout, "1.0.0", &exe).unwrap(), "planted").unwrap();
        assert!(roll_back(&layout, &plan).is_err());
        assert_eq!(fs::read_to_string(&exe).unwrap(), "new");
    }

    #[test]
    fn backups_are_found_only_by_plain_names_in_their_folder() {
        let dir = tempfile::tempdir().unwrap();
        let layout = Layout::new(dir.path());
        fake_binary(&layout.backups().join("kalzit-1.0.0-1.db"), "b");
        fake_binary(&dir.path().join("kalzit.db"), "live");
        assert!(backup_path(&layout, "kalzit-1.0.0-1.db").is_some());
        for bad in ["../kalzit.db", "/etc/passwd", "..", "kalzit-1.0.0-1.db/x", ".hidden.db", "missing.db"] {
            assert!(backup_path(&layout, bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn plans_of_another_format_or_unreadable_ones_are_errors() {
        let dir = tempfile::tempdir().unwrap();
        let layout = Layout::new(dir.path());
        assert_eq!(read_plan_checked(&layout), Ok(None));
        fs::create_dir_all(layout.root()).unwrap();
        fs::write(layout.plan_file(), "{ broken").unwrap();
        assert!(read_plan_checked(&layout).is_err());
        fs::write(layout.plan_file(), r#"{"format": 1, "kind": "update"}"#).unwrap();
        assert!(read_plan_checked(&layout).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn the_new_binary_keeps_the_old_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let exe = dir.path().join("kalzit");
        let new = dir.path().join("download");
        fake_binary(&exe, "old");
        fake_binary(&new, "new");
        fs::set_permissions(&exe, fs::Permissions::from_mode(0o750)).unwrap();
        fs::set_permissions(&new, fs::Permissions::from_mode(0o600)).unwrap();
        place_binary(&new, &exe, &sha("new"), 3).unwrap().commit(&exe).unwrap();
        assert_eq!(fs::metadata(&exe).unwrap().permissions().mode() & 0o777, 0o750);
    }

    #[test]
    fn pruning_keeps_the_newest_versions_and_their_backups() {
        let dir = tempfile::tempdir().unwrap();
        let layout = Layout::new(&dir.path().join("data"));
        let exe = dir.path().join("kalzit");
        fake_binary(&exe, "bin");
        let backups = layout.backups();
        for (i, v) in ["1.0.0", "1.1.0", "1.2.0", "1.3.0"].iter().enumerate() {
            let name = format!("kalzit-{v}.db");
            fake_binary(&backups.join(&name), v);
            keep_version(&layout, &exe, v, i as i64, Some(name), i as i64).unwrap();
        }
        fake_binary(&backups.join("orphan.db"), "x");
        prune(&layout, 2, "9.9.9", exe.file_name().unwrap());
        let left: Vec<String> =
            kept_versions(&layout, exe.file_name().unwrap()).into_iter().map(|k| k.version).collect();
        assert_eq!(left, ["1.3.0", "1.2.0"]);
        let mut files: Vec<String> =
            fs::read_dir(&backups).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into()).collect();
        files.sort();
        assert_eq!(files, ["kalzit-1.2.0.db", "kalzit-1.3.0.db"]);
    }

    #[test]
    fn version_folders_take_only_versions() {
        let dir = tempfile::tempdir().unwrap();
        let layout = Layout::new(dir.path());
        assert!(version_dir(&layout, "../../etc").is_none());
        assert!(version_dir(&layout, "1.2.3-rc.1").is_some());
        assert!(kept_version(&layout, "..").is_none());
    }

    #[test]
    fn history_is_newest_first_and_bounded() {
        let dir = tempfile::tempdir().unwrap();
        let layout = Layout::new(dir.path());
        for i in 0..60 {
            push_history(
                &layout,
                HistoryEntry {
                    version: format!("1.{i}.0"),
                    from: None,
                    at: i,
                    kind: PlanKind::Update,
                    outcome: Outcome::Installed,
                    reason: None,
                    reason_code: None,
                    source: None,
                    scheduled: false,
                    actor: None,
                    duration_ms: None,
                },
            );
        }
        let entries = history(&layout);
        assert_eq!(entries.len(), MAX_HISTORY);
        assert_eq!(entries[0].version, "1.59.0");
    }

    #[tokio::test]
    async fn the_sqlite_backup_is_a_consistent_private_copy() {
        let dir = tempfile::tempdir().unwrap();
        let url = crate::config::sqlite_url(&dir.path().join("kalzit.db"));
        let pool = crate::db::connect(&url, 2).await.unwrap();
        sqlx::query("INSERT INTO server_settings (key, value, version, updated_at) VALUES ('x', '1', 1, 0)")
            .execute(&pool)
            .await
            .unwrap();
        let layout = Layout::new(dir.path());
        let version = semver::Version::parse("1.0.0").unwrap();
        let name = backup_database(&pool, &url, &layout, &version, 5, BackupKind::Switch, None).await.unwrap().unwrap();
        let backup = backup_path(&layout, &name).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&backup).unwrap().permissions().mode() & 0o777, 0o600);
        }
        assert!(schema_version(&pool).await.unwrap() > 0);
        pool.close().await;
        let copy = crate::db::connect(&crate::config::sqlite_url(&backup), 1).await.unwrap();
        let (n,): (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM server_settings WHERE key = 'x'").fetch_one(&copy).await.unwrap();
        assert_eq!(n, 1);
        copy.close().await;
        let none = backup_database(&pool, "postgres://h/db", &layout, &version, 6, BackupKind::Manual, None).await;
        assert!(none.unwrap().is_none());
    }
}
